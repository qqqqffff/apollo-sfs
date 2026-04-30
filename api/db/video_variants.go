package db

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

func scanVideoVariant(row interface {
	Scan(...any) error
}) (*models.VideoVariant, error) {
	var v models.VideoVariant
	err := row.Scan(&v.ID, &v.FileID, &v.Quality, &v.MinIOObjectKey, &v.SizeBytes, &v.Status, &v.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &v, nil
}

const videoVariantColumns = `id, file_id, quality, minio_object_key, size_bytes, status, created_at`

// CreateVideoVariant inserts a pending variant record and returns it.
func (q *Queries) CreateVideoVariant(ctx context.Context, fileID uuid.UUID, quality, objectKey string) (*models.VideoVariant, error) {
	row := q.db.QueryRowContext(ctx, `
		INSERT INTO video_variants (file_id, quality, minio_object_key, size_bytes, status)
		VALUES ($1, $2, $3, 0, $4)
		RETURNING `+videoVariantColumns,
		fileID, quality, objectKey, models.VideoVariantStatusPending,
	)
	v, err := scanVideoVariant(row)
	if err != nil {
		return nil, fmt.Errorf("CreateVideoVariant: %w", err)
	}
	return v, nil
}

// GetVideoVariant fetches a variant by file ID and quality label.
// Returns sql.ErrNoRows if not found.
func (q *Queries) GetVideoVariant(ctx context.Context, fileID uuid.UUID, quality string) (*models.VideoVariant, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT `+videoVariantColumns+`
		FROM video_variants WHERE file_id = $1 AND quality = $2
	`, fileID, quality)
	v, err := scanVideoVariant(row)
	if err != nil {
		return nil, fmt.Errorf("GetVideoVariant: %w", err)
	}
	return v, nil
}

// ListVideoVariants returns all variants for a file (any status).
func (q *Queries) ListVideoVariants(ctx context.Context, fileID uuid.UUID) ([]models.VideoVariant, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT `+videoVariantColumns+`
		FROM video_variants WHERE file_id = $1
	`, fileID)
	if err != nil {
		return nil, fmt.Errorf("ListVideoVariants: %w", err)
	}
	defer rows.Close()

	var out []models.VideoVariant
	for rows.Next() {
		v, err := scanVideoVariant(rows)
		if err != nil {
			return nil, fmt.Errorf("ListVideoVariants scan: %w", err)
		}
		out = append(out, *v)
	}
	return out, rows.Err()
}

// MarkVideoVariantReady updates status to 'ready' and records the plaintext size.
func (q *Queries) MarkVideoVariantReady(ctx context.Context, fileID uuid.UUID, quality string, sizeBytes int64) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE video_variants SET status = $3, size_bytes = $4
		WHERE file_id = $1 AND quality = $2
	`, fileID, quality, models.VideoVariantStatusReady, sizeBytes)
	if err != nil {
		return fmt.Errorf("MarkVideoVariantReady: %w", err)
	}
	return nil
}

// MarkVideoVariantFailed updates status to 'failed'.
func (q *Queries) MarkVideoVariantFailed(ctx context.Context, fileID uuid.UUID, quality string) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE video_variants SET status = $3
		WHERE file_id = $1 AND quality = $2
	`, fileID, quality, models.VideoVariantStatusFailed)
	if err != nil {
		return fmt.Errorf("MarkVideoVariantFailed: %w", err)
	}
	return nil
}
