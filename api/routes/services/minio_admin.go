package services

import (
	"context"
	"fmt"

	madmin "github.com/minio/madmin-go/v3"
)

// StorageInfo is the distilled view of a MinIO instance used by the
// infrastructure sync: the buckets it hosts and its total disk capacity.
type StorageInfo struct {
	Buckets    []string
	TotalBytes int64
}

// StorageInspector reads buckets and capacity from a MinIO instance via its
// admin API. It is an interface so the sync handler can be tested with a fake.
type StorageInspector interface {
	Inspect(ctx context.Context, endpoint, accessKey, secretKey string, useSSL bool) (StorageInfo, error)
}

// minioStorageInspector is the production StorageInspector backed by the MinIO
// admin client (capacity) and the standard client (bucket listing).
type minioStorageInspector struct{}

// NewStorageInspector returns the production MinIO StorageInspector.
func NewStorageInspector() StorageInspector { return minioStorageInspector{} }

func (minioStorageInspector) Inspect(ctx context.Context, endpoint, accessKey, secretKey string, useSSL bool) (StorageInfo, error) {
	adm, err := madmin.New(endpoint, accessKey, secretKey, useSSL)
	if err != nil {
		return StorageInfo{}, fmt.Errorf("minio admin: connect %s: %w", endpoint, err)
	}
	info, err := adm.ServerInfo(ctx)
	if err != nil {
		return StorageInfo{}, fmt.Errorf("minio admin: server info %s: %w", endpoint, err)
	}

	// Total capacity = sum of every drive's total space across all servers in the
	// deployment. For the single-drive standalone instances used here that is just
	// the underlying disk size.
	var total int64
	for _, srv := range info.Servers {
		for _, disk := range srv.Disks {
			total += int64(disk.TotalSpace)
		}
	}

	// Buckets come from the standard S3 client (the admin API only reports a count).
	core, err := NewMinIOClient(endpoint, accessKey, secretKey, useSSL)
	if err != nil {
		return StorageInfo{}, fmt.Errorf("minio admin: client %s: %w", endpoint, err)
	}
	bkts, err := core.ListBuckets(ctx)
	if err != nil {
		return StorageInfo{}, fmt.Errorf("minio admin: list buckets %s: %w", endpoint, err)
	}
	buckets := make([]string, 0, len(bkts))
	for _, b := range bkts {
		buckets = append(buckets, b.Name)
	}

	return StorageInfo{Buckets: buckets, TotalBytes: total}, nil
}
