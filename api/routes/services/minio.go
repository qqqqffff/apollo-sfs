package services

import (
	"bytes"
	"context"
	"fmt"
	"io"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// ── Client constructor ─────────────────────────────────────────────────────────

// NewMinIOClient creates a MinIO Core client (superset of the standard client
// that also exposes low-level multipart upload APIs).
// endpoint should be "host:port" (e.g. "minio:9000").
// useSSL should be false on the internal Docker network (TLS terminated by Nginx).
func NewMinIOClient(endpoint, accessKey, secretKey string, useSSL bool) (*minio.Core, error) {
	core, err := minio.NewCore(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: useSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("minio: create client: %w", err)
	}
	return core, nil
}

// EnsureBucket creates the named bucket if it does not already exist.
// Call once at startup before constructing MinIOService.
func EnsureBucket(ctx context.Context, client *minio.Core, bucket string) error {
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

// MinIOService wraps a MinIO Core client and binds all operations to a single
// bucket. It handles the raw object I/O layer; encryption is the caller's
// responsibility.
type MinIOService struct {
	core   *minio.Core
	bucket string
}

// NewMinIOService constructs a MinIOService for the given bucket.
func NewMinIOService(client *minio.Core, bucket string) *MinIOService {
	return &MinIOService{core: client, bucket: bucket}
}

// PutObject streams r into MinIO as a new object at key.
func (s *MinIOService) PutObject(ctx context.Context, key string, r io.Reader, size int64, contentType string) error {
	_, err := s.core.Client.PutObject(ctx, s.bucket, key, r, size,
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
	obj, err := s.core.Client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("minio: get %q: %w", key, err)
	}
	return obj, nil
}

// GetObjectRange returns a streaming reader for [start, end] (inclusive).
// The caller must close the returned ReadCloser after reading.
func (s *MinIOService) GetObjectRange(ctx context.Context, key string, start, end int64) (io.ReadCloser, error) {
	opts := minio.GetObjectOptions{}
	if err := opts.SetRange(start, end); err != nil {
		return nil, fmt.Errorf("minio: set range [%d-%d] on %q: %w", start, end, key, err)
	}
	obj, err := s.core.Client.GetObject(ctx, s.bucket, key, opts)
	if err != nil {
		return nil, fmt.Errorf("minio: get range [%d-%d] on %q: %w", start, end, key, err)
	}
	return obj, nil
}

// RemoveObject deletes the object at key (idempotent).
func (s *MinIOService) RemoveObject(ctx context.Context, key string) error {
	err := s.core.Client.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{})
	if err != nil {
		return fmt.Errorf("minio: remove %q: %w", key, err)
	}
	return nil
}

// StatObject returns metadata for the object at key without fetching its body.
func (s *MinIOService) StatObject(ctx context.Context, key string) (minio.ObjectInfo, error) {
	info, err := s.core.Client.StatObject(ctx, s.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return minio.ObjectInfo{}, fmt.Errorf("minio: stat %q: %w", key, err)
	}
	return info, nil
}

// ── Multipart upload ──────────────────────────────────────────────────────────

// CreateMultipartUpload initiates a server-side multipart upload and returns
// the upload ID used to reference it in subsequent calls.
func (s *MinIOService) CreateMultipartUpload(ctx context.Context, key string) (string, error) {
	uploadID, err := s.core.NewMultipartUpload(ctx, s.bucket, key, minio.PutObjectOptions{
		ContentType: "application/octet-stream",
	})
	if err != nil {
		return "", fmt.Errorf("minio: create multipart upload for %q: %w", key, err)
	}
	return uploadID, nil
}

// UploadPart uploads data as part partNumber (1-based) of the multipart upload
// identified by uploadID. Returns the CompletePart needed to finalise the upload.
func (s *MinIOService) UploadPart(ctx context.Context, key, uploadID string, partNumber int, data []byte) (minio.CompletePart, error) {
	part, err := s.core.PutObjectPart(
		ctx, s.bucket, key, uploadID,
		partNumber,
		bytes.NewReader(data), int64(len(data)),
		minio.PutObjectPartOptions{},
	)
	if err != nil {
		return minio.CompletePart{}, fmt.Errorf("minio: upload part %d of %q: %w", partNumber, key, err)
	}
	return minio.CompletePart{PartNumber: part.PartNumber, ETag: part.ETag}, nil
}

// CompleteMultipartUpload finalises a multipart upload. parts must be sorted
// in ascending PartNumber order.
func (s *MinIOService) CompleteMultipartUpload(ctx context.Context, key, uploadID string, parts []minio.CompletePart) error {
	_, err := s.core.CompleteMultipartUpload(ctx, s.bucket, key, uploadID, parts, minio.PutObjectOptions{})
	if err != nil {
		return fmt.Errorf("minio: complete multipart upload for %q: %w", key, err)
	}
	return nil
}

// AbortMultipartUpload cancels an in-progress multipart upload and removes any
// uploaded parts. Call this whenever a chunked upload is abandoned or fails.
func (s *MinIOService) AbortMultipartUpload(ctx context.Context, key, uploadID string) error {
	err := s.core.AbortMultipartUpload(ctx, s.bucket, key, uploadID)
	if err != nil {
		return fmt.Errorf("minio: abort multipart upload for %q: %w", key, err)
	}
	return nil
}
