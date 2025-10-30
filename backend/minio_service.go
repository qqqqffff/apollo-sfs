package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type MinioService struct {
	client     *minio.Client
	bucketName string
}

type FileMetadata struct {
	Key          string    `json:"key"`
	Name         string    `json:"name"`
	Size         int64     `json:"size"`
	ContentType  string    `json:"contentType"`
	LastModified time.Time `json:"lastModified"`
	ETag         string    `json:"etag"`
}

func GetMinioService() *MinioService {
	endpoint := os.Getenv("MINIO_ENDPOINT")
	accessKey := os.Getenv("MINIO_ACCESS_KEY")
	secretKey := os.Getenv("MINIO_SECRET_KEY")
	bucketName := os.Getenv("MINIO_BUCKET")
	useSSL := os.Getenv("MINIO_USE_SSL") == "true"

	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: useSSL,
	})
	if err != nil {
		panic(fmt.Sprintf("Failed to init Minio client: %v", err))
	}

	ctx := context.Background()
	exists, err := client.BucketExists(ctx, bucketName)
	if err != nil {
		panic(fmt.Sprintf("Failed to check bucket: %v", err))
	}

	if !exists {
		err = client.MakeBucket(ctx, bucketName, minio.MakeBucketOptions{})
		if err != nil {
			panic(fmt.Sprintf("Failed to create bucket: %v", err))
		}
	}

	return &MinioService{
		client:     client,
		bucketName: bucketName,
	}
}

func (s *MinioService) UploadFile(ctx context.Context, userID, fileName string, reader io.Reader, size int64, contentType string) (*FileMetadata, error) {
	objectName := fmt.Sprintf("%s/%s", userID, fileName)
	info, err := s.client.PutObject(ctx, s.bucketName, objectName, reader, size, minio.PutObjectOptions{
		ContentType:          contentType,
		ServerSideEncryption: nil, //TODO: implement sse
		UserMetadata: map[string]string{
			"uploaded-by": userID,
			"upload-time": time.Now().Format(time.RFC3339),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to upload file: %w", err)
	}
	return &FileMetadata{
		Key:         objectName,
		Name:        fileName,
		Size:        info.Size,
		ContentType: contentType,
		ETag:        info.ETag,
	}, nil
}

func (s *MinioService) GetFile(ctx context.Context, userID, fileKey string) (io.ReadCloser, *FileMetadata, error) {
	objectName := fmt.Sprintf("%s/%s", userID, fileKey)

	info, err := s.client.StatObject(ctx, s.bucketName, objectName, minio.StatObjectOptions{})
	if err != nil {
		return nil, nil, fmt.Errorf("file not found: %w", err)
	}

	object, err := s.client.GetObject(ctx, s.bucketName, objectName, minio.GetObjectOptions{})
	if err != nil {
		return nil, nil, fmt.Errorf("failed to get file: %w", err)
	}

	metadata := &FileMetadata{
		Key:          objectName,
		Name:         fileKey,
		Size:         info.Size,
		ContentType:  info.ContentType,
		LastModified: info.LastModified,
		ETag:         info.ETag,
	}

	return object, metadata, nil
}

func (s *MinioService) ListFiles(ctx context.Context, userID string, limit int, offset string) ([]FileMetadata, string, error) {
	prefix := fmt.Sprintf("%s/", userID)

	opts := minio.ListObjectsOptions{
		Prefix:    prefix,
		Recursive: true,
		MaxKeys:   limit,
	}

	if offset != "" {
		opts.StartAfter = offset
	}

	var files []FileMetadata
	var nextCursor string

	objectCh := s.client.ListObjects(ctx, s.bucketName, opts)
	count := 0

	for object := range objectCh {
		if object.Err != nil {
			return nil, "", fmt.Errorf("error listing objects: %w", object.Err)
		}

		displayName := object.Key[len(prefix):]
		files = append(files, FileMetadata{
			Key:          object.Key,
			Name:         displayName,
			Size:         object.Size,
			ContentType:  object.ContentType,
			LastModified: object.LastModified,
			ETag:         object.ETag,
		})

		count++
		if count >= limit {
			nextCursor = object.Key
			break
		}
	}

	return files, nextCursor, nil
}

func (s *MinioService) DeleteFile(ctx context.Context, userID, fileKey string) error {
	objectName := fmt.Sprintf("%s/%s", userID, fileKey)

	err := s.client.RemoveObject(ctx, s.bucketName, objectName, minio.RemoveObjectOptions{})
	if err != nil {
		return fmt.Errorf("failed to delete file: %w", err)
	}

	return nil
}

func (s *MinioService) GetPresignedURL(ctx context.Context, userID, fileKey string, expiry time.Duration) (string, error) {
	objectName := fmt.Sprintf("%s/%s", userID, fileKey)

	url, err := s.client.PresignedGetObject(ctx, s.bucketName, objectName, expiry, nil)
	if err != nil {
		return "", fmt.Errorf("failed to generate presigned URL: %w", err)
	}
	return url.String(), nil
}
