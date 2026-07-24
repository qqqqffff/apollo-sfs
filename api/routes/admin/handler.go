package admin

import (
	"context"
	"sync"
	"sync/atomic"

	"github.com/oschwald/geoip2-golang"

	"apollo-sfs.com/api/routes"
	"apollo-sfs.com/api/routes/services"
)

// Compile-time check: Handler satisfies SpeedTestProvider used by AlarmService.
var _ services.SpeedTestProvider = (*Handler)(nil)

// Compile-time check: Handler satisfies NetworkSpeedSource used by
// BandwidthManager to size the fair upload cap off real WAN speed tests.
var _ services.NetworkSpeedSource = (*Handler)(nil)

// Handler holds dependencies for all /api/v1/admin/* endpoints.
type Handler struct {
	queries  AdminQuerier
	invites  AdminInviteService
	metrics  MetricsServicer
	auth     *services.AuthService
	files    routes.FileServicer
	registry *services.MinIORegistry
	geo      *geoip2.Reader
	// swarm and storage drive the infrastructure sync: swarm enumerates Docker
	// Swarm nodes (manager/worker, tier label); storage reads each MinIO
	// instance's buckets and capacity. Both are interfaces so the sync is testable.
	swarm   services.SwarmInspector
	storage services.StorageInspector
	// minioStandardEndpoint is the standard-tier MinIO endpoint (MINIO_STANDARD_ENDPOINT).
	// Empty when the deployment has a single MinIO instance (e.g. local dev).
	minioStandardEndpoint string
	// minioEndpoint / minioUseSSL describe the primary (fast) MinIO instance, used
	// by the sync to register/refresh its server row.
	minioEndpoint  string
	minioAccessKey string
	minioSecretKey string
	minioUseSSL    bool
	// minioBucketName is the configured shared bucket each MinIO instance hosts
	// (MINIO_BUCKET_NAME). The sync reconciles one drive per tier against this
	// bucket rather than enumerating every bucket (which surfaces user
	// sub-directories as phantom drives).
	minioBucketName string
	// diskStatsPath is the filesystem path used to auto-detect drive capacity
	// for the sync-capacity endpoint (e.g. "/data" inside the container).
	diskStatsPath string
	// diskStatsLabel is the filesystem label of the volume mounted at
	// diskStatsPath (DISK_STATS_DRIVE_LABEL). The live drive-stats endpoint maps
	// the drive carrying this label to diskStatsPath, which the container can
	// always read, instead of relying on host mount discovery.
	diskStatsLabel string
	// testRunnerURL is the POST endpoint of the unified test-runner sidecar
	// container (e.g. "http://test-runner:9228/run-tests"), which runs the
	// backend/frontend/frontend-E2E/mobile/recognition suites in one place and
	// returns a combined report. Takes precedence over apiDir. Empty disables
	// every suite except the apiDir local-exec fallback (backend only).
	testRunnerURL string
	// apiDir is the absolute path to the api/ source directory used by RunTests
	// as a local-dev fallback for JUST the backend suite when testRunnerURL is
	// unset. Requires the Go toolchain in PATH.
	apiDir string
	// appVersion / appGitBranch label test runs created by RunTests with what
	// this api process was actually built from (APP_VERSION / APP_GIT_BRANCH,
	// baked into the image at build time — see SetDeploymentInfo). Empty
	// outside a deploy.sh build.
	appVersion   string
	appGitBranch string

	// Speed test state — protected by speedTestMu; running flag uses atomic CAS.
	// latestSpeedTest is every probe result, used for display/alarms.
	// latestCleanSpeedTest is only updated when no uploads were active
	// immediately before or after the probe, so it can't have been skewed
	// downward by competing with real upload traffic for the same link — see
	// CleanNetworkSpeedMbps, which feeds services.BandwidthManager's fair
	// upload cap exclusively off this field, never latestSpeedTest.
	speedTestMu          sync.RWMutex
	latestSpeedTest      *SpeedTestResult
	latestCleanSpeedTest *SpeedTestResult
	// cleanSampleFallback tracks progress toward the hard cap on how long
	// latestCleanSpeedTest can go without a genuinely clean update — see
	// recordSpeedTestSample.
	cleanSampleFallback cleanSampleState
	speedTestRunning    atomic.Bool
	// bandwidthMgr lets the speed test check whether uploads are currently
	// active (see activeUploadCount) before trusting a probe as "clean". Nil
	// is tolerated — every probe is then treated as clean, which is only
	// reachable in tests that don't wire the bandwidth cap up at all.
	bandwidthMgr *services.BandwidthManager

	// shutdownCh, when closed, signals main to initiate graceful HTTP shutdown.
	// nil means the kill-switch endpoint is disabled.
	shutdownCh   chan struct{}
	shutdownOnce sync.Once

	// paypal is used to refund the interest-form deposit when a submission is
	// denied. nil is tolerated and causes DenyInterestSubmission to 503.
	paypal *services.PayPalClient

	// discountMailer announces new pricing discounts to users (see
	// SetDiscountMailer). nil skips notifications.
	discountMailer DiscountMailer

	// reconcile drives the MinIO <-> Postgres reconciliation heartbeat (see
	// SetReconciliationService); nil causes the endpoints to 503.
	reconcile *services.ReconciliationService

	// emailSvc sends the mandatory role-change/account-deletion notices (see
	// SetEmailService); nil skips them (local dev without SMTP configured).
	emailSvc *services.EmailService
	// paypalClients resolves the live/sandbox PayPal client for cancelling a
	// user's real subscription when their role changes away from Premium or
	// their account is deleted (see SetPayPalClients).
	paypalClients services.PayPalClients
	// paymentSvc applies the local premium-teardown side effects (KC group,
	// API keys) alongside a role change or deletion (see SetPaymentService).
	paymentSvc PremiumRevoker
}

// PremiumRevoker is the subset of *services.PaymentService used by the role
// editor and delete-user endpoints to tear down premium access. Mirrors
// routes/orders.PremiumRevoker (kept separate so this package doesn't import
// routes/orders just for the interface).
type PremiumRevoker interface {
	RevokeSubscription(ctx context.Context, subscriptionID, status, reason string) error
	RevokePremiumAllocation(ctx context.Context, username string) error
}

// Compile-time check: *services.PaymentService satisfies PremiumRevoker.
var _ PremiumRevoker = (*services.PaymentService)(nil)

// SetEmailService installs the mailer used to send the mandatory
// role-change/account-deletion notices. Wired from main once constructed;
// nil is tolerated and simply skips sending (logged by the caller).
func (h *Handler) SetEmailService(svc *services.EmailService) {
	h.emailSvc = svc
}

// SetPayPalClients installs the live/sandbox PayPal clients used to cancel a
// real subscription on a role change away from Premium or an account
// deletion. Wired from main once constructed.
func (h *Handler) SetPayPalClients(pc services.PayPalClients) {
	h.paypalClients = pc
}

// SetPaymentService installs the premium-teardown side-effect applier used
// by the role editor and delete-user endpoints. Wired from main once
// constructed.
func (h *Handler) SetPaymentService(svc PremiumRevoker) {
	h.paymentSvc = svc
}

// SetDeploymentInfo installs the deployment version/git branch labels
// (cfg.AppVersion / cfg.AppGitBranch) used to tag test runs created by
// RunTests. Wired from main once cfg is loaded; zero values are tolerated
// (runs are simply tagged with an empty version/branch).
func (h *Handler) SetDeploymentInfo(version, branch string) {
	h.appVersion = version
	h.appGitBranch = branch
}

// SetReconciliationService installs the reconciliation service used by
// GetReconciliation/TriggerReconciliation. Wired from main once constructed;
// nil is tolerated and causes those endpoints to return 503.
func (h *Handler) SetReconciliationService(svc *services.ReconciliationService) {
	h.reconcile = svc
}

// SetBandwidthManager installs the fair upload-bandwidth limiter so the speed
// test can check for active uploads before trusting a probe as a "clean"
// sample (see hasActiveUploads, CleanNetworkSpeedMbps). Wired from main once
// constructed; nil is tolerated and every probe is then treated as clean.
func (h *Handler) SetBandwidthManager(mgr *services.BandwidthManager) {
	h.bandwidthMgr = mgr
}

// NewHandler constructs an admin Handler.
// diskStatsPath:  filesystem path to auto-detect drive capacity (DISK_STATS_PATH env var, e.g. "/data").
// diskStatsLabel: filesystem label of the volume at diskStatsPath (DISK_STATS_DRIVE_LABEL env var).
// testRunnerURL:  internal URL of the unified test-runner sidecar (TEST_RUNNER_URL env var). Takes precedence over apiDir.
// apiDir:         absolute path to the api/ source directory (APP_DIR env var). Local-dev fallback for the backend suite only, when testRunnerURL is unset.
// shutdownCh:     channel closed by the Shutdown endpoint to trigger graceful server exit. nil disables the endpoint.
func NewHandler(queries AdminQuerier, inviteSvc AdminInviteService, metricsSvc MetricsServicer, authSvc *services.AuthService, fileSvc routes.FileServicer, registry *services.MinIORegistry, geoReader *geoip2.Reader, diskStatsPath, diskStatsLabel, testRunnerURL, apiDir string, shutdownCh chan struct{}) *Handler {
	return &Handler{queries: queries, invites: inviteSvc, metrics: metricsSvc, auth: authSvc, files: fileSvc, registry: registry, geo: geoReader, diskStatsPath: diskStatsPath, diskStatsLabel: diskStatsLabel, testRunnerURL: testRunnerURL, apiDir: apiDir, shutdownCh: shutdownCh}
}

// InfraSyncConfig configures the on-demand infrastructure sync (POST /system/sync).
type InfraSyncConfig struct {
	Swarm   services.SwarmInspector
	Storage services.StorageInspector
	// Primary (fast-tier) MinIO instance — the API's own MINIO_* credentials.
	MinIOEndpoint  string
	MinIOAccessKey string
	MinIOSecretKey string
	MinIOUseSSL    bool
	// MinIOBucketName is the shared bucket each MinIO instance hosts (MINIO_BUCKET_NAME).
	MinIOBucketName string
	// StandardEndpoint is the standard-tier MinIO endpoint (MINIO_STANDARD_ENDPOINT),
	// reachable with the same root credentials. Empty for single-instance deployments.
	StandardEndpoint string
}

// SetPayPalClient installs the PayPal client used to refund interest-form
// deposits on denial. Wired from main once the client is constructed; nil is
// tolerated and causes DenyInterestSubmission to return 503.
func (h *Handler) SetPayPalClient(client *services.PayPalClient) {
	h.paypal = client
}

// ConfigureInfraSync attaches the swarm/storage inspectors and MinIO connection
// details used by SyncInfrastructure. Call once at startup after NewHandler.
func (h *Handler) ConfigureInfraSync(c InfraSyncConfig) {
	h.swarm = c.Swarm
	h.storage = c.Storage
	h.minioEndpoint = c.MinIOEndpoint
	h.minioAccessKey = c.MinIOAccessKey
	h.minioSecretKey = c.MinIOSecretKey
	h.minioUseSSL = c.MinIOUseSSL
	h.minioBucketName = c.MinIOBucketName
	h.minioStandardEndpoint = c.StandardEndpoint
}
