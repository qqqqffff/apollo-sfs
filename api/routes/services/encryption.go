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

// zeroBytes overwrites a byte slice with zeros to prevent key material from
// lingering in memory longer than necessary.
func zeroBytes(b []byte) {
	for i := range b {
		b[i] = 0
	}
}
