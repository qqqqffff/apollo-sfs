# Apollo SFS — API

Go + Gin REST API for the Apollo SFS file storage service.

## Prerequisites

- [Go 1.26+](https://go.dev/dl/)
- [golang-migrate CLI](https://github.com/golang-migrate/migrate/tree/master/cmd/migrate) (for running migrations manually)
- A running instance of the Docker Compose stack (PostgreSQL, MinIO, Keycloak, Maddy)
- A populated `.env` file in the project root

## Installation

Install Go dependencies:

```bash
go mod download
```

Verify everything resolves cleanly:

```bash
go mod tidy
```

## Running

### Development (live reload via Air)

Install [Air](https://github.com/air-verse/air) for hot reload:

```bash
go install github.com/air-verse/air@latest
```

Then from the `api/` directory:

```bash
air
```

Air watches for file changes and restarts the server automatically. Configure watched paths in `.air.toml` if needed.

### Without live reload

```bash
go run ./cmd
```

### Production build

```bash
go build -o bin/api ./cmd
./bin/api
```

## Database Migrations

Migrations live in `migrations/` and are managed with [golang-migrate](https://github.com/golang-migrate/migrate).

Install the CLI:

```bash
go install -tags 'postgres' github.com/golang-migrate/migrate/v4/cmd/migrate@latest
```

**Run all pending migrations:**

```bash
migrate -path ./migrations -database "postgres://$POSTGRES_APP_USER:$POSTGRES_APP_PASSWORD@localhost:5432/$POSTGRES_APP_DB?sslmode=disable" up
```

**Roll back the last migration:**

```bash
migrate -path ./migrations -database "postgres://$POSTGRES_APP_USER:$POSTGRES_APP_PASSWORD@localhost:5432/$POSTGRES_APP_DB?sslmode=disable" down 1
```

**Check current migration version:**

```bash
migrate -path ./migrations -database "postgres://$POSTGRES_APP_USER:$POSTGRES_APP_PASSWORD@localhost:5432/$POSTGRES_APP_DB?sslmode=disable" version
```

**Create a new migration file pair:**

```bash
migrate create -ext sql -dir ./migrations -seq <migration_name>
# e.g. migrate create -ext sql -dir ./migrations -seq create_users_table
```

> The API applies pending migrations automatically on startup via `golang-migrate/migrate`. The CLI commands above are for manual inspection and rollback during development.

## Testing

Run all tests:

```bash
go test ./...
```

Run with verbose output:

```bash
go test -v ./...
```

Run tests for a specific package:

```bash
go test -v ./internal/handlers/...
go test -v ./internal/services/...
```

Run a specific test by name:

```bash
go test -v -run TestLoginHandler ./internal/handlers/
```

Run tests with race detector (recommended before committing):

```bash
go test -race ./...
```

Generate a coverage report:

```bash
go test -coverprofile=coverage.out ./...
go tool cover -html=coverage.out -o coverage.html
```

## Docker

Build the API image:

```bash
docker build -t apollo-sfs-api .
```

The full stack (API + all dependencies) is managed from the project root:

```bash
# Start everything
docker compose up -d

# Rebuild and restart the API only
docker compose up -d --build api

# Tail API logs
docker logs -f apollo-sfs-api

# Stop everything
docker compose down
```

## Environment Variables

The API reads its configuration from environment variables. When running locally outside Docker, export them from the project root `.env`:

```bash
set -a && source ../.env && set +a
go run ./cmd
```

See the project root `.env` for the full list of required variables.

## Project Structure

```
api/
  cmd/
    main.go               ← Entry point
  internal/
    config/               ← Env and config loading
    middleware/
      auth.go             ← JWT cookie validation
      token_refresh.go    ← Proactive token refresh
      admin.go            ← Admin role guard
      rate_limit.go       ← Per-IP rate limiting
      logger.go
    handlers/
      auth.go             ← POST /auth/*
      me.go               ← GET /me
      files.go            ← /files/*
      folders.go          ← /folders/*
      invitations.go      ← GET /invitations/{token}
      health.go           ← GET /health
      admin/
        users.go          ← GET|PATCH /admin/users/*
        invitations.go    ← POST|GET|DELETE /admin/invitations/*
        metrics.go        ← GET /admin/system/metrics
    services/
      auth_service.go
      file_service.go
      folder_service.go
      encryption_service.go
      key_rotation_service.go
      minio_service.go
      email_service.go
      invite_service.go
      metrics_service.go
    models/
      user.go
      file.go
      folder.go
    email/
      templates/          ← HTML email templates
    db/
      postgres.go         ← Connection and migration runner
      queries.go
  migrations/             ← SQL migration files (*.up.sql / *.down.sql)
  Dockerfile
  go.mod
  go.sum
```
