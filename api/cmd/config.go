package main

import (
	"fmt"
	"log"
	"os"
	"strconv"
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
	MinIOUseSSL     bool
	// MinIOStandardEndpoint is the standard-tier MinIO endpoint, reachable with the
	// same root credentials. Empty for single-instance deployments (e.g. local dev).
	// Used only by the on-demand infrastructure sync.
	MinIOStandardEndpoint string

	CookieDomain string
	CookieSecure bool

	PostfixInternalHost string
	MailFrom            string
	MailDomain          string

	AppBaseURL string // public-facing base URL, e.g. "https://files.example.com"

	KeyEncryptionKey         string
	QuotaWarningThresholdPct int

	// AI recognition sidecar (premium face/pet/object indexing). Empty
	// RecognitionURL disables the feature: endpoints return 503 and the
	// background worker never starts.
	RecognitionURL           string
	RecognitionToken         string
	RecognitionConcurrency   int
	RecognitionMaxKeyframes  int
	RecognitionFaceThreshold float64
	RecognitionPetThreshold  float64
	DiskStatsPath            string
	DiskStatsDriveLabel      string

	// SessionKey is the secret used to sign and encrypt the session cookie.
	// Must be 32 or 64 bytes (AES-128 or AES-256). Set via SESSION_KEY env var.
	SessionKey string

	// Cloudflare Turnstile — used to protect the interest form from bots.
	// Get keys at https://dash.cloudflare.com/?to=/:account/turnstile
	TurnstileSecretKey string
	TurnstileSiteKey   string

	// PresignSecret is the HMAC key used to sign presigned download/upload tokens.
	// Falls back to SESSION_KEY when not explicitly set so existing deployments
	// work without a new env var.
	PresignSecret string

	// TestRunnerURL is the internal URL of the unified test-runner sidecar
	// container (e.g. "http://test-runner:9228/run-tests"). One container runs
	// the backend, frontend (Jest + Playwright), mobile, and recognition test
	// suites and returns a combined report — replacing what used to be separate
	// api-tests/frontend-tests/mobile-tests sidecars. Preferred over AppDir.
	TestRunnerURL string

	// AppDir is the absolute path to the api/ source directory on the host.
	// Local-dev fallback for JUST the backend suite when TestRunnerURL is unset
	// (needs Go toolchain + source) — the other suites need the sidecar's
	// toolchains and report disabled without it.
	AppDir string

	// ── Premium tier + SFS API key + PayPal ─────────────────────────────────
	// SFSAPIKeyPepper is mixed into the argon2id hash of API key secrets so
	// a database leak alone cannot brute-force keys offline. Minimum 32 bytes.
	SFSAPIKeyPepper string

	// PayPalClientID / Secret / WebhookID are the credentials of the PayPal
	// application that processes one-time premium purchases. Configured via
	// docs/paypal_setup.md. Always used at PayPal's live base URL — the
	// primary/live client has no sandbox mode; use PayPalSandbox* below
	// (via the admin-only session toggle) for testing.
	PayPalClientID     string
	PayPalClientSecret string
	PayPalWebhookID    string

	// PayPalSandboxClientID / Secret / WebhookID configure a second, always-
	// sandbox PayPal client used only when an admin's session-scoped "sandbox
	// payments" toggle (profile page) is on. Empty disables sandbox testing
	// regardless of the toggle.
	PayPalSandboxClientID     string
	PayPalSandboxClientSecret string
	PayPalSandboxWebhookID    string

	// PremiumMonthlyPriceCents / PremiumAnnualPriceCents are the recurring
	// premium plan prices, for display only — the actual charge amount is
	// whatever each PayPal Plan (below) was configured with in the dashboard;
	// keep these in sync with that when changing pricing.
	PremiumMonthlyPriceCents int
	PremiumAnnualPriceCents  int
	PremiumTierCurrency      string // ISO 4217, e.g. "USD"

	// PayPalPlanIDMonthly / PayPalPlanIDAnnual are the live PayPal Billing Plan
	// ids created per docs/paypal_setup.md. PayPalSandboxPlanID* are their
	// sandbox-app counterparts, used when the admin sandbox-payments toggle is
	// on (mirrors the PayPalSandboxClientID pattern above).
	PayPalPlanIDMonthly        string
	PayPalPlanIDAnnual         string
	PayPalSandboxPlanIDMonthly string
	PayPalSandboxPlanIDAnnual  string

	// ── Inbound email (SendGrid Inbound Parse) ──────────────────────────────
	// EmailStoragePath is the absolute directory inbound emails are written to,
	// laid out as <path>/<worker_name>/<YYYY-MM>/<id>.json.
	EmailStoragePath string

	// SendgridWebhookSecret, when set, must be supplied as the ?token= query
	// param on the inbound webhook URL. SendGrid Inbound Parse provides no
	// signature, so this shared secret guards the public endpoint. Empty
	// disables the check (only safe behind a trusted network).
	SendgridWebhookSecret string

	// GoogleWebClientID / GoogleWebClientSecret are the web OAuth 2.0 credentials
	// used to exchange a mobile serverAuthCode for a Google id_token on the backend.
	// The resulting id_token has aud = web client ID, which Keycloak's Google IdP
	// accepts during token exchange. Set via GOOGLE_WEB_CLIENT_ID / GOOGLE_WEB_CLIENT_SECRET.
	GoogleWebClientID     string
	GoogleWebClientSecret string

	// AppVersion / AppGitBranch identify what's actually running — baked into
	// the api image at build time from deploy.sh's image tag and the git
	// branch it was built from (see api/Dockerfile). Used only to label test
	// runs stored by the admin metrics page's test-runner card so a run can be
	// matched back to the deployment/branch it ran against. Empty outside a
	// deploy.sh build (e.g. local `go run`/`docker build` with no --build-arg).
	AppVersion   string
	AppGitBranch string
}

func loadConfig() Config {
	quotaPct, _ := strconv.Atoi(getEnv("QUOTA_WARNING_THRESHOLD_PERCENT", "80"))
	recognitionConcurrency, _ := strconv.Atoi(getEnv("RECOGNITION_CONCURRENCY", "2"))
	recognitionMaxKeyframes, _ := strconv.Atoi(getEnv("RECOGNITION_MAX_KEYFRAMES", "20"))
	recognitionFaceThreshold, _ := strconv.ParseFloat(getEnv("RECOGNITION_FACE_THRESHOLD", "0.50"), 64)
	recognitionPetThreshold, _ := strconv.ParseFloat(getEnv("RECOGNITION_PET_THRESHOLD", "0.88"), 64)
	premiumMonthlyPrice, _ := strconv.Atoi(getEnv("PREMIUM_MONTHLY_PRICE_CENTS", "100"))
	premiumAnnualPrice, _ := strconv.Atoi(getEnv("PREMIUM_ANNUAL_PRICE_CENTS", "1000"))

	paypalClientID := getEnv("PAYPAL_CLIENT_ID", "")
	paypalClientSecret := getEnv("PAYPAL_CLIENT_SECRET", "")
	paypalWebhookID := getEnv("PAYPAL_WEBHOOK_ID", "")

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

		MinIOEndpoint:         requireEnv("MINIO_ENDPOINT"),
		MinIOAccessKey:        requireEnv("MINIO_ROOT_USER"),
		MinIOSecretKey:        requireEnv("MINIO_ROOT_PASSWORD"),
		MinIOBucketName:       requireEnv("MINIO_BUCKET_NAME"),
		MinIOUseSSL:           os.Getenv("MINIO_USE_SSL") == "true",
		MinIOStandardEndpoint: getEnv("MINIO_STANDARD_ENDPOINT", ""),

		CookieDomain: requireEnv("COOKIE_DOMAIN"),
		CookieSecure: os.Getenv("COOKIE_SECURE") == "true",

		PostfixInternalHost: requireEnv("POSTFIX_INTERNAL_HOST"),
		MailFrom:            requireEnv("MAIL_FROM"),
		MailDomain:          requireEnv("MAIL_DOMAIN"),

		AppBaseURL: requireEnv("APP_BASE_URL"),

		KeyEncryptionKey:         requireEnv("KEY_ENCRYPTION_KEY"),
		QuotaWarningThresholdPct: quotaPct,

		RecognitionURL:           getEnv("RECOGNITION_URL", ""),
		RecognitionToken:         getEnv("RECOGNITION_TOKEN", ""),
		RecognitionConcurrency:   recognitionConcurrency,
		RecognitionMaxKeyframes:  recognitionMaxKeyframes,
		RecognitionFaceThreshold: recognitionFaceThreshold,
		RecognitionPetThreshold:  recognitionPetThreshold,
		DiskStatsPath:            getEnv("DISK_STATS_PATH", "/mnt/data"),
		DiskStatsDriveLabel:      getEnv("DISK_STATS_DRIVE_LABEL", ""),

		SessionKey: requireEnv("SESSION_KEY"),

		TurnstileSecretKey: requireEnv("CLOUDFLARE_TURNSTILE_SECRET_KEY"),
		TurnstileSiteKey:   requireEnv("CLOUDFLARE_TURNSTILE_SITE_KEY"),

		PresignSecret: getEnvOrKey("PRESIGN_SECRET", "SESSION_KEY"),

		TestRunnerURL: getEnv("TEST_RUNNER_URL", ""),
		AppDir:        getEnv("APP_DIR", ""),

		SFSAPIKeyPepper:           requireEnv("SFS_API_KEY_PEPPER"),
		PayPalClientID:            paypalClientID,
		PayPalClientSecret:        paypalClientSecret,
		PayPalWebhookID:           paypalWebhookID,
		PayPalSandboxClientID:     getEnv("PAYPAL_SANDBOX_CLIENT_ID", ""),
		PayPalSandboxClientSecret: getEnv("PAYPAL_SANDBOX_CLIENT_SECRET", ""),
		PayPalSandboxWebhookID:    getEnv("PAYPAL_SANDBOX_WEBHOOK_ID", ""),

		PremiumMonthlyPriceCents: premiumMonthlyPrice,
		PremiumAnnualPriceCents:  premiumAnnualPrice,
		PremiumTierCurrency:      getEnv("PREMIUM_TIER_CURRENCY", "USD"),

		PayPalPlanIDMonthly:        getEnv("PAYPAL_PLAN_ID_MONTHLY", ""),
		PayPalPlanIDAnnual:         getEnv("PAYPAL_PLAN_ID_ANNUAL", ""),
		PayPalSandboxPlanIDMonthly: getEnv("PAYPAL_SANDBOX_PLAN_ID_MONTHLY", ""),
		PayPalSandboxPlanIDAnnual:  getEnv("PAYPAL_SANDBOX_PLAN_ID_ANNUAL", ""),

		EmailStoragePath:      getEnv("EMAIL_STORAGE_PATH", "/home/app/service-worker-email"),
		SendgridWebhookSecret: getEnv("SENDGRID_WEBHOOK_SECRET", ""),

		GoogleWebClientID:     getEnv("GOOGLE_WEB_CLIENT_ID", ""),
		GoogleWebClientSecret: getEnv("GOOGLE_WEB_CLIENT_SECRET", ""),

		AppVersion:   getEnv("APP_VERSION", ""),
		AppGitBranch: getEnv("APP_GIT_BRANCH", ""),
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

// getEnvOrKey returns the value of primary, falling back to the value of
// fallbackKey (not a literal string). Both must be non-empty env var names.
func getEnvOrKey(primary, fallbackKey string) string {
	if v := os.Getenv(primary); v != "" {
		return v
	}
	return requireEnv(fallbackKey)
}
