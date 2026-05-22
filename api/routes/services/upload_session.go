package services

import (
	"log"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
)

const uploadSessionTTL = 24 * time.Hour

// UploadSession tracks an in-progress chunked upload using an async pipeline.
// Each chunk is dispatched to a goroutine that encrypts it and uploads it to
// MinIO as a multipart part immediately — overlapping with the next chunk's
// network transfer instead of buffering all chunks in RAM first.
type UploadSession struct {
	ID          uuid.UUID
	UserID      uuid.UUID
	Username    string
	Name        string
	FolderID    *uuid.UUID
	TotalChunks int
	TotalSize   int64

	// Set by FileService.BeginChunkedUpload before any chunks are dispatched.
	FileID        uuid.UUID
	ObjectKey     string
	MinioUploadID string
	UserKey       []byte // zeroed by Zero() when the session is finalised or deleted
	MimeType      string // detected from the first chunk; set by EncryptAndUploadPart
	SHA256Hash    string // hex SHA-256 of plaintext, supplied by mobile clients for dedup
	DriveID       uuid.UUID
	MinIOStorage  *MinIOService

	createdAt time.Time
	wg        sync.WaitGroup

	mu         sync.Mutex
	dispatched map[int]struct{}    // chunk indices for which a goroutine was launched
	parts      []minio.CompletePart // indexed by chunk index; filled as goroutines complete
	partErr    error               // first error reported by any goroutine
}

// UploadSessionStore holds active sessions and cleans up expired ones hourly.
type UploadSessionStore struct {
	sessions sync.Map
}

func NewUploadSessionStore() *UploadSessionStore {
	s := &UploadSessionStore{}
	go s.cleanupLoop()
	return s
}

// Create initialises a new session and returns it.
// BeginChunkedUpload must be called on the session before dispatching any chunks.
func (s *UploadSessionStore) Create(
	userID uuid.UUID, username, name string,
	folderID *uuid.UUID,
	totalChunks int, totalSize int64,
) (*UploadSession, error) {
	sess := &UploadSession{
		ID:          uuid.New(),
		UserID:      userID,
		Username:    username,
		Name:        name,
		FolderID:    folderID,
		TotalChunks: totalChunks,
		TotalSize:   totalSize,
		createdAt:   time.Now(),
		dispatched:  make(map[int]struct{}),
		parts:       make([]minio.CompletePart, totalChunks),
	}
	s.sessions.Store(sess.ID, sess)
	return sess, nil
}

// Get returns the session for the given ID, if it exists.
func (s *UploadSessionStore) Get(id uuid.UUID) (*UploadSession, bool) {
	v, ok := s.sessions.Load(id)
	if !ok {
		return nil, false
	}
	return v.(*UploadSession), true
}

// Delete removes the session and zeroes its key material.
func (s *UploadSessionStore) Delete(id uuid.UUID) {
	v, ok := s.sessions.LoadAndDelete(id)
	if !ok {
		log.Printf("upload session %s: delete called but session not found", id)
		return
	}
	v.(*UploadSession).Zero()
}

// DispatchChunk records index as dispatched and increments the WaitGroup.
// Must be called before launching the goroutine for this chunk.
func (sess *UploadSession) DispatchChunk(index int) {
	sess.mu.Lock()
	sess.dispatched[index] = struct{}{}
	sess.mu.Unlock()
	sess.wg.Add(1)
}

// RecordPart stores the result of a completed goroutine and decrements the WaitGroup.
// On error the first failure is retained; subsequent errors are discarded.
func (sess *UploadSession) RecordPart(index int, part minio.CompletePart, err error) {
	defer sess.wg.Done()
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if err != nil {
		if sess.partErr == nil {
			sess.partErr = err
		}
		return
	}
	sess.parts[index] = part
}

// DispatchedCount returns how many chunks have been dispatched so far.
func (sess *UploadSession) DispatchedCount() int {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	return len(sess.dispatched)
}

// AllDispatched returns true when every chunk has been dispatched to a goroutine.
func (sess *UploadSession) AllDispatched() bool {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	return len(sess.dispatched) == sess.TotalChunks
}

// Wait blocks until all dispatched goroutines complete and returns the ordered
// parts slice and the first error (if any). Parts are indexed by chunk index,
// so parts[i].PartNumber == i+1 — already in the order MinIO requires.
func (sess *UploadSession) Wait() ([]minio.CompletePart, error) {
	sess.wg.Wait()
	sess.mu.Lock()
	defer sess.mu.Unlock()
	return sess.parts, sess.partErr
}

// Zero overwrites the user key with zeros to clear key material from memory.
// Safe to call multiple times.
func (sess *UploadSession) Zero() {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	zeroBytes(sess.UserKey)
}

func (s *UploadSessionStore) cleanupLoop() {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now()
		s.sessions.Range(func(k, v any) bool {
			sess := v.(*UploadSession)
			if now.Sub(sess.createdAt) > uploadSessionTTL {
				s.sessions.Delete(k)
				sess.Zero()
			}
			return true
		})
	}
}
