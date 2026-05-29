package db

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

const serverColumns = `
	id, name, state, minio_endpoint, minio_use_ssl,
	minio_access_key_enc, minio_access_key_nonce,
	minio_secret_key_enc, minio_secret_key_nonce,
	is_active, created_at`

func scanServer(row *sql.Row) (*models.Server, error) {
	var s models.Server
	err := row.Scan(
		&s.ID, &s.Name, &s.State, &s.MinioEndpoint, &s.MinioUseSSL,
		&s.MinioAccessKeyEnc, &s.MinioAccessKeyNonce,
		&s.MinioSecretKeyEnc, &s.MinioSecretKeyNonce,
		&s.IsActive, &s.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func scanServerRow(rows *sql.Rows) (*models.Server, error) {
	var s models.Server
	err := rows.Scan(
		&s.ID, &s.Name, &s.State, &s.MinioEndpoint, &s.MinioUseSSL,
		&s.MinioAccessKeyEnc, &s.MinioAccessKeyNonce,
		&s.MinioSecretKeyEnc, &s.MinioSecretKeyNonce,
		&s.IsActive, &s.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// ListServers returns all server rows ordered by created_at ASC.
func (q *Queries) ListServers(ctx context.Context) ([]models.Server, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT`+serverColumns+`
		FROM servers
		ORDER BY created_at ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("ListServers: %w", err)
	}
	defer rows.Close()

	var out []models.Server
	for rows.Next() {
		s, err := scanServerRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListServers scan: %w", err)
		}
		out = append(out, *s)
	}
	return out, rows.Err()
}

// GetServer fetches a single server by ID.
func (q *Queries) GetServer(ctx context.Context, id uuid.UUID) (*models.Server, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT`+serverColumns+`
		FROM servers WHERE id = $1
	`, id)
	s, err := scanServer(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetServer: %w", err)
	}
	return s, nil
}

// CountServersByState returns how many servers share the given state code.
// Used to generate the next sequential name (e.g. "NH-0002").
func (q *Queries) CountServersByState(ctx context.Context, state string) (int, error) {
	var n int
	err := q.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM servers WHERE state = $1`, state,
	).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("CountServersByState: %w", err)
	}
	return n, nil
}

// CreateServerParams carries all fields needed to insert a new server row.
type CreateServerParams struct {
	Name                string
	State               string
	MinioEndpoint       string
	MinioUseSSL         bool
	MinioAccessKeyEnc   []byte
	MinioAccessKeyNonce []byte
	MinioSecretKeyEnc   []byte
	MinioSecretKeyNonce []byte
}

// CreateServer inserts a new server and returns the created row.
func (q *Queries) CreateServer(ctx context.Context, p CreateServerParams) (*models.Server, error) {
	row := q.db.QueryRowContext(ctx, `
		INSERT INTO servers
			(name, state, minio_endpoint, minio_use_ssl,
			 minio_access_key_enc, minio_access_key_nonce,
			 minio_secret_key_enc, minio_secret_key_nonce)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING`+serverColumns,
		p.Name, p.State, p.MinioEndpoint, p.MinioUseSSL,
		p.MinioAccessKeyEnc, p.MinioAccessKeyNonce,
		p.MinioSecretKeyEnc, p.MinioSecretKeyNonce,
	)
	s, err := scanServer(row)
	if err != nil {
		return nil, fmt.Errorf("CreateServer: %w", err)
	}
	return s, nil
}

// SetServerActive toggles a server's is_active flag.
func (q *Queries) SetServerActive(ctx context.Context, id uuid.UUID, active bool) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE servers SET is_active = $2 WHERE id = $1`, id, active)
	if err != nil {
		return fmt.Errorf("SetServerActive: %w", err)
	}
	return nil
}
