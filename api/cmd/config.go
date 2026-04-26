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

	MaddyInternalHost string
	MailFrom          string
	MailDomain        string

	AppBaseURL string // public-facing base URL, e.g. "https://files.example.com"

	KeyEncryptionKey         string
	QuotaWarningThresholdPct int
	DiskStatsPath            string

	// SessionKey is the secret used to sign and encrypt the session cookie.
	// Must be 32 or 64 bytes (AES-128 or AES-256). Set via SESSION_KEY env var.
	SessionKey string
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

		MaddyInternalHost: requireEnv("MADDY_INTERNAL_HOST"),
		MailFrom:          requireEnv("MAIL_FROM"),
		MailDomain:        requireEnv("MAIL_DOMAIN"),

		AppBaseURL: requireEnv("APP_BASE_URL"),

		KeyEncryptionKey:         requireEnv("KEY_ENCRYPTION_KEY"),
		QuotaWarningThresholdPct: quotaPct,
		DiskStatsPath:            getEnv("DISK_STATS_PATH", "/mnt/data"),

		SessionKey: requireEnv("SESSION_KEY"),
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