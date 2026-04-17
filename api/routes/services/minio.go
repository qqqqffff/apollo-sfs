package services

import (
	"context"
	"fmt"
	"io"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// ── Client constructor (kept as a standalone function) ────────────────────────

// NewMinIOClient creates a MinIO client using static V4 credentials.
// endpoint should be "host:port" (e.g. "minio:9000").
// useSSL should be false on the internal Docker network (TLS is terminated by Nginx).
func NewMinIOClient(endpoint, accessKey, secretKey string, useSSL bool) (*minio.Client, error) {
	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: useSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("minio: create client: %w", err)
	}
	return client, nil
}

// EnsureBucket creates the named bucket if it does not already exist.
// Call once at startup before constructing MinIOService.
func EnsureBucket(ctx context.Context, client *minio.Client, bucket string) error {
	exists, err := client.BucketExists(ctx, bucket)
	if err != nil {
		return fmt.Errorf("minio: check bucket %q: %w", bucket, err)
	}
	if exists {
		return nil
	}
	if err := client.MakeBucket(ctx, bucket, minio.MakeBucketOptions{}); err != nil {
		return fmt.Errorf("minio: create bucket %q: %w", bucket, err)
	}
	return nil
}

// ── MinIOService ──────────────────────────────────────────────────────────────

// MinIOService wraps a MinIO client and binds all operations to a single bucket.
// It handles the raw object I/O layer; encryption is the caller's responsibility.
type MinIOService struct {
	client *minio.Client
	bucket string
}

// NewMinIOService constructs a MinIOService for the given bucket.
func NewMinIOService(client *minio.Client, bucket string) *MinIOService {
	return &MinIOService{client: client, bucket: bucket}
}

// PutObject streams r into MinIO as a new object at key.
// size must be the exact byte length of r; pass -1 only when unknown (less
// efficient — MinIO cannot use multipart hints without an exact size).
// contentType is stored as object metadata and used on direct presigned access.
func (s *MinIOService) PutObject(ctx context.Context, key string, r io.Reader, size int64, contentType string) error {
	_, err := s.client.PutObject(ctx, s.bucket, key, r, size,
		minio.PutObjectOptions{ContentType: contentType},
	)
	if err != nil {
		return fmt.Errorf("minio: put %q: %w", key, err)
	}
	return nil
}

// GetObject returns a streaming reader for the object at key.
// The caller must close the returned ReadCloser after reading.
func (s *MinIOService) GetObject(ctx context.Context, key string) (io.ReadCloser, error) {
	obj, err := s.client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("minio: get %q: %w", key, err)
	}
	return obj, nil
}

// RemoveObject deletes the object at key. Silently succeeds if the object does
// not exist (idempotent).
func (s *MinIOService) RemoveObject(ctx context.Context, key string) error {
	err := s.client.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{})
	if err != nil {
		return fmt.Errorf("minio: remove %q: %w", key, err)
	}
	return nil
}

// StatObject returns metadata for the object at key without fetching its body.
// Useful for verifying an object exists after upload.
func (s *MinIOService) StatObject(ctx context.Context, key string) (minio.ObjectInfo, error) {
	info, err := s.client.StatObject(ctx, s.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return minio.ObjectInfo{}, fmt.Errorf("minio: stat %q: %w", key, err)
	}
	return info, nil
}
