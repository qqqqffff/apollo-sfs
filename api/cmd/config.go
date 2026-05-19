package main

import (
	"fmt"
	"log"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Port string

	DatabaseDSN string

	KeycloakInternalURL  string
	KeycloakRealm        string
	KeycloakClientID     string
	KeycloakClientSecret string

	MinIOEndpoint   string
	MinIOAccessKey  string
	MinIOSecretKey  string
	MinIOBucketName string

	CookieDomain          string
	CookieSecure          bool
	TokenRefreshThreshold time.Duration

	PostfixInternalHost string
	MailFrom          string
	MailDomain        string

	AppBaseURL string // public-facing base URL, e.g. "https://files.example.com"

	KeyEncryptionKey         string
	QuotaWarningThresholdPct int
	DiskStatsPath            string

	// SessionKey is the secret used to sign and encrypt the session cookie.
	// Must be 32 or 64 bytes (AES-128 or AES-256). Set via SESSION_KEY env var.
	SessionKey string

	// Cloudflare Turnstile — used to protect the interest form from bots.
	// Get keys at https://dash.cloudflare.com/?to=/:account/turnstile
	TurnstileSecretKey string
	TurnstileSiteKey   string

	// BackendTestURL is the internal URL of the api-tests sidecar container.
	// e.g. "http://api-tests:9228/run-tests". Preferred over AppDir in Docker.
	BackendTestURL string

	// AppDir is the absolute path to the api/ source directory on the host.
	// Used for local dev when BackendTestURL is unset (needs Go toolchain + source).
	AppDir string

	// FrontendTestURL is the internal URL of the frontend-tests sidecar container.
	// e.g. "http://frontend-tests:9229/run-tests"
	// Leave empty to disable the Jest unit test runner.
	FrontendTestURL string

	// FrontendE2EURL is the internal URL of the Playwright E2E sidecar endpoint.
	// e.g. "http://frontend-tests:9229/run-e2e"
	// Leave empty to disable the E2E test runner.
	FrontendE2EURL string
}

func loadConfig() Config {
	refreshSecs, _ := strconv.Atoi(getEnv("TOKEN_REFRESH_THRESHOLD", "60"))
	quotaPct, _ := strconv.Atoi(getEnv("QUOTA_WARNING_THRESHOLD_PERCENT", "80"))

	return Config{
		Port: getEnv("PORT", "8080"),
		DatabaseDSN: fmt.Sprintf(
			"host=%s port=%s user=%s password=%s dbname=%s sslmode=disable",
			requireEnv("POSTGRES_APP_HOST"),
			getEnv("POSTGRES_APP_PORT", "5432"),
			requireEnv("POSTGRES_APP_USER"),
			requireEnv("POSTGRES_APP_PASSWORD"),
			requireEnv("POSTGRES_APP_DB"),
		),

		KeycloakInternalURL:  requireEnv("KEYCLOAK_INTERNAL_URL"),
		KeycloakRealm:        requireEnv("KEYCLOAK_REALM"),
		KeycloakClientID:     requireEnv("KEYCLOAK_CLIENT_ID"),
		KeycloakClientSecret: requireEnv("KEYCLOAK_CLIENT_SECRET"),

		MinIOEndpoint:   requireEnv("MINIO_ENDPOINT"),
		MinIOAccessKey:  requireEnv("MINIO_ROOT_USER"),
		MinIOSecretKey:  requireEnv("MINIO_ROOT_PASSWORD"),
		MinIOBucketName: requireEnv("MINIO_BUCKET_NAME"),

		CookieDomain:          requireEnv("COOKIE_DOMAIN"),
		CookieSecure:          os.Getenv("COOKIE_SECURE") == "true",
		TokenRefreshThreshold: time.Duration(refreshSecs) * time.Second,

		PostfixInternalHost: requireEnv("POSTFIX_INTERNAL_HOST"),
		MailFrom:          requireEnv("MAIL_FROM"),
		MailDomain:        requireEnv("MAIL_DOMAIN"),

		AppBaseURL: requireEnv("APP_BASE_URL"),

		KeyEncryptionKey:         requireEnv("KEY_ENCRYPTION_KEY"),
		QuotaWarningThresholdPct: quotaPct,
		DiskStatsPath:            getEnv("DISK_STATS_PATH", "/mnt/data"),

		SessionKey: requireEnv("SESSION_KEY"),

		TurnstileSecretKey: requireEnv("CLOUDFLARE_TURNSTILE_SECRET_KEY"),
		TurnstileSiteKey:   requireEnv("CLOUDFLARE_TURNSTILE_SITE_KEY"),

		BackendTestURL:  getEnv("BACKEND_TEST_URL", ""),
		AppDir:          getEnv("APP_DIR", ""),
		FrontendTestURL: getEnv("FRONTEND_TEST_URL", ""),
		FrontendE2EURL:  getEnv("FRONTEND_E2E_URL", ""),
	}
}

func requireEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("required environment variable %q is not set", key)
	}
	return v
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}