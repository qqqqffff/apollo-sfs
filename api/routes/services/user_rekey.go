package services

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"

	"apollo-sfs.com/api/db"
)

// ── Re-keying a merged account's objects ─────────────────────────────────────
//
// Every users row carries its own AES key. When two rows turn out to be the
// same person (see UserReconcileService) only the survivor's key is kept, but
// blobs uploaded while the other row was the one in use — before a rename that
// left Keycloak and the app DB out of step, say — are sealed with the other
// key. Those are re-encrypted under the survivor's key before the rows merge;
// skipping this would make them permanently unreadable.

// RekeyResult summarizes one RekeyUserObjects pass.
type RekeyResult struct {
	Checked    int   `json:"checked"`     // objects examined
	Current    int   `json:"current"`     // already under the survivor's key
	Rekeyed    int   `json:"rekeyed"`     // re-encrypted under the survivor's key
	RekeyBytes int64 `json:"rekey_bytes"` // stored bytes rewritten
	Missing    int   `json:"missing"`     // row whose object is gone (left for storage reconciliation)
	// Unreadable lists objects no candidate key opens. They were unreadable
	// before the merge too; they are left untouched.
	Unreadable []string `json:"unreadable,omitempty"`
}

// rekeyStore is the slice of MinIOService the re-key pass needs.
type rekeyStore interface {
	GetObject(ctx context.Context, key string) (io.ReadCloser, error)
	GetObjectRange(ctx context.Context, key string, start, end int64) (io.ReadCloser, error)
	PutObject(ctx context.Context, key string, r io.Reader, size int64, contentType string) error
	RemoveObject(ctx context.Context, key string) error
	StatObject(ctx context.Context, key string) (minio.ObjectInfo, error)
}

var errObjectMissing = errors.New("object missing")

// RekeyUserObjects re-encrypts every blob belonging to userID that opens with
// one of previous but not with current. usernames are the accounts involved,
// used to find the drive of legacy rows that never recorded one.
func (s *FileService) RekeyUserObjects(ctx context.Context, userID uuid.UUID, usernames []string, current []byte, previous [][]byte) (*RekeyResult, error) {
	objects, err := s.queries.ListUserEncryptedObjects(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("rekey: list objects: %w", err)
	}
	res := &RekeyResult{}
	for _, o := range objects {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		res.Checked++
		store, err := s.storageForObject(ctx, usernames, o)
		if err != nil {
			return res, fmt.Errorf("rekey %s %s: %w", o.Kind, o.ID, err)
		}
		if err := s.rekeyObject(ctx, store, userID, o, current, previous, res); err != nil {
			return res, fmt.Errorf("rekey %s %s: %w", o.Kind, o.ID, err)
		}
	}
	return res, nil
}

func (s *FileService) rekeyObject(ctx context.Context, store rekeyStore, userID uuid.UUID, o db.EncryptedObject, current []byte, previous [][]byte, res *RekeyResult) error {
	keys := append([][]byte{current}, previous...)
	which, err := identifyKey(ctx, store, o, keys)
	switch {
	case errors.Is(err, errObjectMissing):
		res.Missing++
		return nil
	case err != nil:
		return err
	case which == 0:
		res.Current++
		return nil
	case which < 0:
		res.Unreadable = append(res.Unreadable, o.Kind+":"+o.ID.String())
		log.Printf("rekey: %s %s (%s) opens with none of the account's keys — left as is", o.Kind, o.ID, o.ObjectKey)
		return nil
	}

	newKey := objectKeyFor(userID, uuid.New())
	newNonce, written, err := s.reencryptObject(ctx, store, o, newKey, keys[which], current)
	if err != nil {
		_ = store.RemoveObject(ctx, newKey)
		return err
	}
	replaced, err := s.queries.ReplaceEncryptedObject(ctx, userID, o, newKey, newNonce)
	if err != nil {
		_ = store.RemoveObject(ctx, newKey)
		return err
	}
	if !replaced {
		// The row was deleted or rewritten while we worked; ours is surplus.
		_ = store.RemoveObject(ctx, newKey)
		return nil
	}
	if err := store.RemoveObject(ctx, o.ObjectKey); err != nil {
		// Only an orphan now; the daily storage reconciliation removes it.
		log.Printf("rekey: remove superseded object %s: %v", o.ObjectKey, err)
	}
	res.Rekeyed++
	res.RekeyBytes += written
	return nil
}

// identifyKey returns the index of the first key in keys that opens o, or -1.
// Only the first chunk of a chunked object is read.
func identifyKey(ctx context.Context, store rekeyStore, o db.EncryptedObject, keys [][]byte) (int, error) {
	var rc io.ReadCloser
	var err error
	if len(o.Nonce) == 0 {
		rc, err = store.GetObjectRange(ctx, o.ObjectKey, 0, StoredChunkSize-1)
	} else {
		rc, err = store.GetObject(ctx, o.ObjectKey)
	}
	if err != nil {
		return 0, classifyObjectErr(err)
	}
	data, err := io.ReadAll(rc)
	_ = rc.Close()
	if err != nil {
		return 0, classifyObjectErr(err)
	}
	for i, k := range keys {
		if opens(k, o.Nonce, data) {
			return i, nil
		}
	}
	return -1, nil
}

// opens reports whether key authenticates data: a whole single-nonce blob, or
// the first stored chunk of a chunked one (nonce empty).
func opens(key, nonce, data []byte) bool {
	if len(nonce) > 0 {
		_, err := aesGCMDecrypt(key, nonce, data)
		return err == nil
	}
	if len(data) <= chunkNonceSize {
		return false
	}
	_, err := aesGCMDecrypt(key, data[:chunkNonceSize], data[chunkNonceSize:])
	return err == nil
}

func classifyObjectErr(err error) error {
	if minio.ToErrorResponse(err).Code == "NoSuchKey" {
		return errObjectMissing
	}
	return err
}

// reencryptObject writes a copy of o at newKey sealed with to instead of from.
// Chunked objects are streamed chunk by chunk, so a large video never has to
// fit in memory. Returns the new nonce (nil for chunked) and bytes written.
func (s *FileService) reencryptObject(ctx context.Context, store rekeyStore, o db.EncryptedObject, newKey string, from, to []byte) ([]byte, int64, error) {
	rc, err := store.GetObject(ctx, o.ObjectKey)
	if err != nil {
		return nil, 0, classifyObjectErr(err)
	}
	defer rc.Close()

	if len(o.Nonce) > 0 {
		blob, err := io.ReadAll(rc)
		if err != nil {
			return nil, 0, err
		}
		plain, err := aesGCMDecrypt(from, o.Nonce, blob)
		if err != nil {
			return nil, 0, fmt.Errorf("decrypt: %w", err)
		}
		sealed, nonce, err := aesGCMEncrypt(to, plain)
		zeroBytes(plain)
		if err != nil {
			return nil, 0, err
		}
		if err := store.PutObject(ctx, newKey, bytes.NewReader(sealed), int64(len(sealed)), "application/octet-stream"); err != nil {
			return nil, 0, err
		}
		return nonce, int64(len(sealed)), nil
	}

	// Re-sealing keeps every chunk's size (same nonce + tag overhead), so the
	// copy is exactly as long as the original. Passing that size lets MinIO
	// stream it in modest parts; an unknown size makes minio-go buffer parts
	// of hundreds of MiB.
	info, err := store.StatObject(ctx, o.ObjectKey)
	if err != nil {
		return nil, 0, classifyObjectErr(err)
	}
	pr, pw := io.Pipe()
	counter := &countingWriter{w: pw}
	go func() {
		pw.CloseWithError(reencryptChunkedStream(counter, rc, from, to))
	}()
	if err := store.PutObject(ctx, newKey, pr, info.Size, "application/octet-stream"); err != nil {
		_ = pr.CloseWithError(err)
		return nil, 0, err
	}
	if counter.n != info.Size {
		return nil, 0, fmt.Errorf("re-encrypted size %d != original %d", counter.n, info.Size)
	}
	return []byte{}, counter.n, nil
}

// reencryptChunkedStream re-seals a chunked blob (see EncryptChunked: each
// stored chunk is nonce || ciphertext+tag) one chunk at a time, with a fresh
// nonce per chunk. Chunk boundaries are unchanged, so range reads still line up.
func reencryptChunkedStream(dst io.Writer, src io.Reader, from, to []byte) error {
	buf := make([]byte, StoredChunkSize)
	for idx := 0; ; idx++ {
		n, err := io.ReadFull(src, buf)
		if n == 0 && (err == io.EOF || err == io.ErrUnexpectedEOF) {
			if idx == 0 {
				return errors.New("empty chunked object")
			}
			return nil
		}
		if err != nil && err != io.ErrUnexpectedEOF {
			return err
		}
		chunk := buf[:n]
		if len(chunk) <= chunkNonceSize {
			return fmt.Errorf("chunk %d too short (%d bytes)", idx, len(chunk))
		}
		plain, derr := aesGCMDecrypt(from, chunk[:chunkNonceSize], chunk[chunkNonceSize:])
		if derr != nil {
			return fmt.Errorf("decrypt chunk %d: %w", idx, derr)
		}
		sealed, nonce, eerr := aesGCMEncrypt(to, plain)
		zeroBytes(plain)
		if eerr != nil {
			return eerr
		}
		if _, werr := dst.Write(append(nonce, sealed...)); werr != nil {
			return werr
		}
		if err == io.ErrUnexpectedEOF {
			return nil // short final chunk
		}
	}
}

type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

// storageForObject resolves the bucket o lives in. Variants and crops are
// stored beside their file, in the file's drive at the time they were made.
func (s *FileService) storageForObject(ctx context.Context, usernames []string, o db.EncryptedObject) (rekeyStore, error) {
	if o.DriveID != nil {
		if svc, err := s.storageForDrive(ctx, *o.DriveID); err == nil {
			return svc, nil
		}
	}
	var lastErr error
	for _, u := range usernames {
		svc, _, err := s.storageFor(ctx, u)
		if err == nil {
			return svc, nil
		}
		lastErr = err
	}
	return nil, fmt.Errorf("no storage for object: %w", lastErr)
}

// UnwrapUserKey returns a user's plaintext AES key. The caller must zero it.
func (s *FileService) UnwrapUserKey(encryptedKey, nonce []byte, masterKeyVersion string) ([]byte, error) {
	return s.enc.DecryptUserKey(encryptedKey, nonce, masterKeyVersion)
}

// ForgetUsers drops cached user rows and drive lookups for usernames, so the
// next request after a merge or rename reads the database afresh.
func (s *FileService) ForgetUsers(usernames ...string) {
	s.userCacheMu.Lock()
	for _, u := range usernames {
		delete(s.userCache, u)
	}
	s.userCacheMu.Unlock()
	s.allocCacheMu.Lock()
	for _, u := range usernames {
		delete(s.allocCache, u)
	}
	s.allocCacheMu.Unlock()
}
