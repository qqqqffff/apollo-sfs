package services

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// ── Encryption hierarchy ──────────────────────────────────────────────────────
//
//   KEK (env: KEY_ENCRYPTION_KEY, AES-256, never in DB, never rotated)
//     └── Master Key (DB: master_keys, encrypted by KEK, rotates every 30 days)
//           └── User AES Key (DB: users, encrypted by master key, re-wrapped on rotation)
//                 └── File data (MinIO, encrypted by user key per upload)
//
// All encryption uses AES-256-GCM with a fresh random 12-byte nonce per operation.

// ── Service ───────────────────────────────────────────────────────────────────

// EncryptionService manages the master key cache and exposes the encrypt/decrypt
// primitives used during user registration and file upload/download.
type EncryptionService struct {
	queries    *db.Queries
	kek        []byte // AES-256 Key Encryption Key, loaded from env at startup

	mu         sync.RWMutex
	masterKeys map[string][]byte // version → plaintext master key bytes
	activeVer  string            // version of the currently active master key
}

// NewEncryptionService decodes the base64 KEK and returns an EncryptionService
// ready for LoadMasterKeys. Returns an error if the KEK is malformed or not
// exactly 32 bytes.
func NewEncryptionService(q *db.Queries, kekBase64 string) (*EncryptionService, error) {
	kek, err := base64.StdEncoding.DecodeString(kekBase64)
	if err != nil {
		return nil, fmt.Errorf("encryption service: decode KEK: %w", err)
	}
	if len(kek) != 32 {
		return nil, fmt.Errorf("encryption service: KEK must be 32 bytes (got %d); generate one with: openssl rand -base64 32", len(kek))
	}
	return &EncryptionService{
		queries:    q,
		kek:        kek,
		masterKeys: make(map[string][]byte),
	}, nil
}

// ── Startup ───────────────────────────────────────────────────────────────────

// LoadMasterKeys fetches all non-deleted master keys from the DB, decrypts them
// with the KEK, and caches the plaintext keys in memory. If no active key exists
// (first boot) it bootstraps one.
//
// Must be called once at startup before any encrypt/decrypt operation.
func (s *EncryptionService) LoadMasterKeys(ctx context.Context) error {
	active, err := s.queries.GetActiveMasterKey(ctx)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return s.bootstrapMasterKey(ctx)
		}
		return fmt.Errorf("load master keys: %w", err)
	}

	if err := s.cacheKey(active.ID, active.EncryptedKeyMaterial, active.KeyNonce); err != nil {
		return fmt.Errorf("load master keys: decrypt active key %q: %w", active.ID, err)
	}

	s.mu.Lock()
	s.activeVer = active.ID
	s.mu.Unlock()

	// Also load retiring keys so users whose keys haven't been re-wrapped yet
	// can still decrypt during the rotation overlap window.
	retiring, err := s.queries.ListMasterKeysByStatus(ctx, models.MasterKeyStatusRetiring)
	if err != nil {
		return fmt.Errorf("load master keys: list retiring: %w", err)
	}
	for _, k := range retiring {
		if err := s.cacheKey(k.ID, k.EncryptedKeyMaterial, k.KeyNonce); err != nil {
			return fmt.Errorf("load master keys: decrypt retiring key %q: %w", k.ID, err)
		}
	}

	return nil
}

// ── Public operations ─────────────────────────────────────────────────────────

// ProvisionUserKey generates a new 256-bit user AES key, wraps it with the
// active master key, and returns the values to be stored in users.encrypted_key,
// users.key_nonce, and users.master_key_version.
//
// Matches the AuthService.ProvisionUserKey function signature so it can be
// assigned directly:
//
//	authSvc.ProvisionUserKey = encSvc.ProvisionUserKey
func (s *EncryptionService) ProvisionUserKey(ctx context.Context) (encryptedKey, nonce []byte, masterKeyVersion string, err error) {
	s.mu.RLock()
	ver := s.activeVer
	masterKey := s.masterKeys[ver]
	s.mu.RUnlock()

	if ver == "" || masterKey == nil {
		return nil, nil, "", fmt.Errorf("provision user key: no active master key loaded")
	}

	// Generate a random 256-bit user AES key.
	userKey := make([]byte, 32)
	if _, err = io.ReadFull(rand.Reader, userKey); err != nil {
		return nil, nil, "", fmt.Errorf("provision user key: generate key: %w", err)
	}

	// Wrap the user key with the active master key.
	encryptedKey, nonce, err = aesGCMEncrypt(masterKey, userKey)
	if err != nil {
		return nil, nil, "", fmt.Errorf("provision user key: wrap: %w", err)
	}

	// Zero the plaintext user key before returning — it must never leave this
	// function; the caller only needs the wrapped form.
	zeroBytes(userKey)

	return encryptedKey, nonce, ver, nil
}

// DecryptUserKey unwraps a user's encrypted key using the master key for the
// given version. Returns the plaintext user AES key.
//
// The caller is responsible for zeroing the returned slice after use.
func (s *EncryptionService) DecryptUserKey(encryptedKey, nonce []byte, masterKeyVersion string) ([]byte, error) {
	s.mu.RLock()
	masterKey, ok := s.masterKeys[masterKeyVersion]
	s.mu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("decrypt user key: master key version %q not in cache (deleted or not loaded)", masterKeyVersion)
	}

	userKey, err := aesGCMDecrypt(masterKey, nonce, encryptedKey)
	if err != nil {
		return nil, fmt.Errorf("decrypt user key: %w", err)
	}
	return userKey, nil
}

// EncryptFile encrypts plaintext using the given user AES key with AES-256-GCM.
// Returns the ciphertext and the nonce used; both should be persisted — the
// nonce in the files table and the ciphertext as the MinIO object body.
func (s *EncryptionService) EncryptFile(userKey, plaintext []byte) (ciphertext, nonce []byte, err error) {
	ciphertext, nonce, err = aesGCMEncrypt(userKey, plaintext)
	if err != nil {
		return nil, nil, fmt.Errorf("encrypt file: %w", err)
	}
	return ciphertext, nonce, nil
}

// DecryptFile decrypts a ciphertext blob retrieved from MinIO using the user's
// AES key and the nonce stored in the files table.
func (s *EncryptionService) DecryptFile(userKey, nonce, ciphertext []byte) ([]byte, error) {
	plaintext, err := aesGCMDecrypt(userKey, nonce, ciphertext)
	if err != nil {
		return nil, fmt.Errorf("decrypt file: %w", err)
	}
	return plaintext, nil
}

// CreateAndActivateMasterKey generates a new 256-bit master key, encrypts it
// with the KEK, stores it in the DB as "active", and caches it in memory.
// Called by the key rotation service to promote a new key before re-wrapping users.
func (s *EncryptionService) CreateAndActivateMasterKey(ctx context.Context, version string) error {
	masterKey := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, masterKey); err != nil {
		return fmt.Errorf("create master key %q: generate: %w", version, err)
	}

	encrypted, nonce, err := aesGCMEncrypt(s.kek, masterKey)
	if err != nil {
		zeroBytes(masterKey)
		return fmt.Errorf("create master key %q: encrypt: %w", version, err)
	}

	if err := s.queries.CreateMasterKey(ctx, &models.MasterKey{
		ID:                   version,
		EncryptedKeyMaterial: encrypted,
		KeyNonce:             nonce,
		Status:               models.MasterKeyStatusActive,
	}); err != nil {
		zeroBytes(masterKey)
		return fmt.Errorf("create master key %q: store: %w", version, err)
	}

	s.AddMasterKey(version, masterKey) // caches and sets activeVer
	return nil
}

// WrapUserKey encrypts an existing plaintext user AES key under the currently
// active master key. Used during rotation re-wrap — the user key itself does
// not change, only its wrapping.
func (s *EncryptionService) WrapUserKey(plaintext []byte) (encKey, nonce []byte, version string, err error) {
	s.mu.RLock()
	ver := s.activeVer
	masterKey := s.masterKeys[ver]
	s.mu.RUnlock()

	if ver == "" || masterKey == nil {
		return nil, nil, "", fmt.Errorf("wrap user key: no active master key loaded")
	}

	encKey, nonce, err = aesGCMEncrypt(masterKey, plaintext)
	if err != nil {
		return nil, nil, "", fmt.Errorf("wrap user key: %w", err)
	}
	return encKey, nonce, ver, nil
}

// ActiveMasterKeyVersion returns the version string of the currently active
// master key. Used by the key rotation service.
func (s *EncryptionService) ActiveMasterKeyVersion() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.activeVer
}

// AddMasterKey caches a plaintext master key under the given version. Called by
// the key rotation service after generating and storing a new master key so that
// ProvisionUserKey immediately uses the new key without reloading from the DB.
func (s *EncryptionService) AddMasterKey(version string, plaintextKey []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.masterKeys[version] = plaintextKey
	s.activeVer = version
}

// RemoveMasterKey evicts a version from the in-memory cache after rotation
// completes and its key material has been purged from the DB.
func (s *EncryptionService) RemoveMasterKey(version string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if key, ok := s.masterKeys[version]; ok {
		zeroBytes(key)
		delete(s.masterKeys, version)
	}
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// bootstrapMasterKey generates the first master key ("v1") and stores it in the
// DB encrypted by the KEK. Called automatically when LoadMasterKeys finds an
// empty master_keys table.
func (s *EncryptionService) bootstrapMasterKey(ctx context.Context) error {
	masterKey := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, masterKey); err != nil {
		return fmt.Errorf("bootstrap master key: generate: %w", err)
	}

	encrypted, nonce, err := aesGCMEncrypt(s.kek, masterKey)
	if err != nil {
		return fmt.Errorf("bootstrap master key: encrypt: %w", err)
	}

	const firstVersion = "v1"
	if err := s.queries.CreateMasterKey(ctx, &models.MasterKey{
		ID:                   firstVersion,
		EncryptedKeyMaterial: encrypted,
		KeyNonce:             nonce,
		Status:               models.MasterKeyStatusActive,
	}); err != nil {
		return fmt.Errorf("bootstrap master key: store: %w", err)
	}

	s.mu.Lock()
	s.masterKeys[firstVersion] = masterKey
	s.activeVer = firstVersion
	s.mu.Unlock()

	return nil
}

// cacheKey decrypts a master key stored in the DB and adds it to the in-memory
// cache. Does not update activeVer — callers set that separately.
func (s *EncryptionService) cacheKey(version string, encryptedKeyMaterial, nonce []byte) error {
	plaintext, err := aesGCMDecrypt(s.kek, nonce, encryptedKeyMaterial)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.masterKeys[version] = plaintext
	s.mu.Unlock()
	return nil
}

// NextKeyVersion returns the successor version string for the given version
// (e.g. "v2" → "v3"). Used by the key rotation service.
func NextKeyVersion(current string) (string, error) {
	if !strings.HasPrefix(current, "v") {
		return "", fmt.Errorf("unexpected version format %q", current)
	}
	n, err := strconv.Atoi(strings.TrimPrefix(current, "v"))
	if err != nil {
		return "", fmt.Errorf("parse version %q: %w", current, err)
	}
	return fmt.Sprintf("v%d", n+1), nil
}

// ── AES-256-GCM primitives ────────────────────────────────────────────────────

// aesGCMEncrypt encrypts plaintext with a 32-byte AES-256-GCM key.
// Returns the ciphertext (with GCM auth tag appended) and the random 12-byte nonce used.
func aesGCMEncrypt(key, plaintext []byte) (ciphertext, nonce []byte, err error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, err
	}
	nonce = make([]byte, gcm.NonceSize()) // 12 bytes
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, nil, err
	}
	ciphertext = gcm.Seal(nil, nonce, plaintext, nil)
	return ciphertext, nonce, nil
}

// aesGCMDecrypt decrypts ciphertext produced by aesGCMEncrypt.
// Returns the plaintext or an error if the auth tag is invalid (tampered data).
func aesGCMDecrypt(key, nonce, ciphertext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("authentication failed — data may be corrupt or tampered: %w", err)
	}
	return plaintext, nil
}

// ── Chunked file encryption ───────────────────────────────────────────────────
//
// Video files are split into fixed-size plaintext chunks, each encrypted
// independently with AES-256-GCM and a fresh random nonce. The stored blob is
// the concatenation of (nonce || ciphertext+tag) for every chunk in order.
//
// Stored chunk layout:
//
//	[nonce 12 B][AES-GCM ciphertext + 16 B tag] ...repeated for each chunk
//
// The file metadata row stores an empty Nonce (len==0) to signal chunked mode;
// the nonce for each chunk is embedded inline in the blob. All existing files
// keep their original 12-byte Nonce and are decrypted via the single-blob path.
//
// Chunked encryption enables efficient range requests: to serve bytes [A,B] the
// backend fetches only the MinIO chunks that overlap the range, decrypts them
// concurrently, and trims the result. This avoids downloading and decrypting the
// entire file for every seek or partial-play request.

const (
	// ChunkSize is the plaintext byte length of each chunk (1 MiB).
	ChunkSize = 1 << 20
	// chunkNonceSize is the 12-byte AES-GCM nonce prepended to each stored chunk.
	chunkNonceSize = 12
	// chunkTagSize is the 16-byte AES-GCM authentication tag appended to each chunk.
	chunkTagSize = 16
	// ChunkOverhead is the total per-chunk storage overhead (nonce + tag).
	ChunkOverhead = chunkNonceSize + chunkTagSize
	// StoredChunkSize is the stored byte length of a full-size chunk.
	// The last chunk of a file may be smaller if the plaintext does not evenly divide.
	StoredChunkSize = ChunkSize + ChunkOverhead
)

// EncryptChunked encrypts plaintext by splitting it into ChunkSize-byte chunks
// and encrypting each with AES-256-GCM using a fresh random nonce.
// Encryption runs concurrently (up to GOMAXPROCS workers).
// Returns the concatenated stored blob; the caller saves an empty Nonce in the
// DB to signal that this file uses chunked mode.
func (s *EncryptionService) EncryptChunked(userKey, plaintext []byte) ([]byte, error) {
	numChunks := (len(plaintext) + ChunkSize - 1) / ChunkSize
	if numChunks == 0 {
		numChunks = 1
	}

	results := make([][]byte, numChunks)

	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error

	// Semaphore limits concurrent goroutines to GOMAXPROCS.
	sem := make(chan struct{}, runtime.GOMAXPROCS(0))

	for i := 0; i < numChunks; i++ {
		start := i * ChunkSize
		end := start + ChunkSize
		if end > len(plaintext) {
			end = len(plaintext)
		}
		chunk := make([]byte, end-start)
		copy(chunk, plaintext[start:end])

		wg.Add(1)
		sem <- struct{}{}
		go func(idx int, data []byte) {
			defer wg.Done()
			defer func() { <-sem }()

			ciphertext, nonce, err := aesGCMEncrypt(userKey, data)
			if err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = fmt.Errorf("encrypt chunk %d: %w", idx, err)
				}
				mu.Unlock()
				return
			}
			// stored = nonce || ciphertext (ciphertext already has the GCM tag appended)
			stored := make([]byte, chunkNonceSize+len(ciphertext))
			copy(stored, nonce)
			copy(stored[chunkNonceSize:], ciphertext)
			results[idx] = stored // each goroutine writes its own index — no mutex needed
		}(i, chunk)
	}

	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}

	var total int
	for _, r := range results {
		total += len(r)
	}
	out := make([]byte, 0, total)
	for _, r := range results {
		out = append(out, r...)
	}
	return out, nil
}

// DecryptChunked decrypts a full blob produced by EncryptChunked.
// Chunks are decrypted concurrently (up to GOMAXPROCS workers).
func (s *EncryptionService) DecryptChunked(userKey, blob []byte) ([]byte, error) {
	if len(blob) == 0 {
		return nil, nil
	}

	// Parse chunk boundaries. All chunks except the last are StoredChunkSize bytes;
	// the last chunk is whatever bytes remain.
	type span struct{ start, end int }
	var spans []span
	for off := 0; off < len(blob); {
		size := StoredChunkSize
		if off+size > len(blob) {
			size = len(blob) - off
		}
		spans = append(spans, span{off, off + size})
		off += size
	}

	results := make([][]byte, len(spans))

	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error

	sem := make(chan struct{}, runtime.GOMAXPROCS(0))

	for i, sp := range spans {
		data := blob[sp.start:sp.end]
		wg.Add(1)
		sem <- struct{}{}
		go func(idx int, d []byte) {
			defer wg.Done()
			defer func() { <-sem }()

			if len(d) <= chunkNonceSize {
				mu.Lock()
				if firstErr == nil {
					firstErr = fmt.Errorf("chunk %d too short (%d bytes)", idx, len(d))
				}
				mu.Unlock()
				return
			}
			plain, err := aesGCMDecrypt(userKey, d[:chunkNonceSize], d[chunkNonceSize:])
			if err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = fmt.Errorf("decrypt chunk %d: %w", idx, err)
				}
				mu.Unlock()
				return
			}
			results[idx] = plain
		}(i, data)
	}

	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}

	var total int
	for _, r := range results {
		total += len(r)
	}
	out := make([]byte, 0, total)
	for _, r := range results {
		out = append(out, r...)
	}
	return out, nil
}

// DecryptChunkedRange decrypts a MinIO blob slice covering chunks
// [firstChunkIdx, rangeEnd/ChunkSize] and returns exactly the plaintext bytes
// [rangeStart, rangeEnd].
//
// blobSlice must be the raw bytes fetched from MinIO starting at the stored
// offset of firstChunkIdx. numTotalChunks and totalPlaintextSize are required
// to determine the stored size of the last chunk in the file.
// Decryption runs concurrently (up to GOMAXPROCS workers).
func (s *EncryptionService) DecryptChunkedRange(
	userKey, blobSlice []byte,
	firstChunkIdx, numTotalChunks, totalPlaintextSize, rangeStart, rangeEnd int64,
) ([]byte, error) {
	lastChunkIdx := rangeEnd / int64(ChunkSize)
	count := int(lastChunkIdx - firstChunkIdx + 1)

	results := make([][]byte, count)

	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error

	sem := make(chan struct{}, runtime.GOMAXPROCS(0))

	// Walk the blob slice, extracting each stored chunk.
	blobOff := int64(0)
	for j := 0; j < count; j++ {
		absIdx := firstChunkIdx + int64(j)

		var storedSize int64
		if absIdx == numTotalChunks-1 {
			// Last chunk of the file may have less than ChunkSize plaintext bytes.
			lastPlain := totalPlaintextSize - absIdx*int64(ChunkSize)
			storedSize = lastPlain + int64(ChunkOverhead)
		} else {
			storedSize = int64(StoredChunkSize)
		}

		data := blobSlice[blobOff : blobOff+storedSize]
		blobOff += storedSize

		relIdx := j
		wg.Add(1)
		sem <- struct{}{}
		go func(idx int, d []byte, abs int64) {
			defer wg.Done()
			defer func() { <-sem }()

			if int64(len(d)) <= int64(chunkNonceSize) {
				mu.Lock()
				if firstErr == nil {
					firstErr = fmt.Errorf("chunk %d too short (%d bytes)", abs, len(d))
				}
				mu.Unlock()
				return
			}
			plain, err := aesGCMDecrypt(userKey, d[:chunkNonceSize], d[chunkNonceSize:])
			if err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = fmt.Errorf("decrypt chunk %d: %w", abs, err)
				}
				mu.Unlock()
				return
			}
			results[idx] = plain
		}(relIdx, data, absIdx)
	}

	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}

	// Assemble exactly [rangeStart, rangeEnd] from the decrypted chunks.
	out := make([]byte, 0, rangeEnd-rangeStart+1)
	for j, plain := range results {
		absIdx := firstChunkIdx + int64(j)
		chunkPlainStart := absIdx * int64(ChunkSize)
		chunkPlainEnd := chunkPlainStart + int64(len(plain)) - 1

		copyFrom := clampedSub(rangeStart, chunkPlainStart, chunkPlainEnd)
		copyTo := clampedSub(rangeEnd, chunkPlainStart, chunkPlainEnd) + 1
		out = append(out, plain[copyFrom:copyTo]...)
	}
	return out, nil
}

// clampedSub returns max(pos, lo) - lo, clamped so the result stays within [0, hi-lo].
func clampedSub(pos, lo, hi int64) int64 {
	if pos < lo {
		return 0
	}
	if pos > hi {
		return hi - lo
	}
	return pos - lo
}

// zeroBytes overwrites a byte slice with zeros to prevent key material from
// lingering in memory longer than necessary.
func zeroBytes(b []byte) {
	for i := range b {
		b[i] = 0
	}
}
