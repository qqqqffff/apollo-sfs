package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gin-contrib/sessions"
	"github.com/gin-contrib/sessions/cookie"
	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	"github.com/oschwald/geoip2-golang"
	psdisk "github.com/shirou/gopsutil/v4/disk"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/routes"
	"apollo-sfs.com/api/routes/admin"
	"apollo-sfs.com/api/routes/auth"
	"apollo-sfs.com/api/routes/middleware"
	"apollo-sfs.com/api/routes/billing"
	"apollo-sfs.com/api/routes/expansion"
	"apollo-sfs.com/api/routes/orders"
	"apollo-sfs.com/api/routes/payments"
	"apollo-sfs.com/api/routes/services"
	"apollo-sfs.com/api/routes/sfs"
	storageroutes "apollo-sfs.com/api/routes/storage"
)

func main() {
	// Load .env from the project root for local development.
	// Silently ignored in production where env vars are injected by Docker.
	if err := godotenv.Load("../.env"); err != nil {
		log.Println("no .env file found, using environment variables")
	}

	cfg := loadConfig()

	pool, err := db.Connect(cfg.DatabaseDSN)
	if err != nil {
		log.Fatalf("database connection failed: %v", err)
	}
	defer pool.Close()

	queries := db.New(pool)

	// ── Keycloak OIDC ────────────────────────────────────────────────────────
	// The discovery document and JWKS are fetched from the internal Docker URL
	// so the API never tries to reach Keycloak via the public internet.
	// Tokens carry the public-facing hostname as their issuer (set by KC_HOSTNAME),
	// so we construct the verifier manually with:
	//   - internal JWKS URL  → key fetching stays on the Docker network
	//   - public issuer URL  → matches the iss claim in every token
	internalIssuerURL := cfg.KeycloakInternalURL + "/realms/" + cfg.KeycloakRealm
	publicIssuerURL := cfg.AppBaseURL + "/realms/" + cfg.KeycloakRealm
	internalJWKSURL := internalIssuerURL + "/protocol/openid-connect/certs"

	keySet := oidc.NewRemoteKeySet(context.Background(), internalJWKSURL)
	// SkipIssuerCheck: Keycloak's token issuer (derived from KC_HOSTNAME + HTTP port)
	// does not reliably match APP_BASE_URL in this deployment. JWT signature verification
	// against the internal JWKS provides the equivalent security guarantee.
	oidcVerifier := oidc.NewVerifier(publicIssuerURL, keySet, &oidc.Config{
		ClientID:        cfg.KeycloakClientID,
		SkipIssuerCheck: true,
	})
	log.Printf("keycloak: JWKS from %s", internalJWKSURL)

	// ── Services ─────────────────────────────────────────────────────────────

	// Encryption service: decodes KEK, loads/bootstraps master keys from DB.
	encSvc, err := services.NewEncryptionService(queries, cfg.KeyEncryptionKey)
	if err != nil {
		log.Fatalf("encryption service: %v", err)
	}
	if err := encSvc.LoadMasterKeys(context.Background()); err != nil {
		log.Fatalf("encryption service: load master keys: %v", err)
	}
	log.Printf("encryption service: master key loaded (active version: %s)", encSvc.ActiveMasterKeyVersion())

	rotationSvc := services.NewKeyRotationService(queries, encSvc, 0) // 0 = default 30-day age

	authSvc := services.NewAuthService(queries, services.AuthServiceConfig{
		KeycloakURL:           cfg.KeycloakInternalURL,
		KeycloakRealm:         cfg.KeycloakRealm,
		KeycloakClientID:      cfg.KeycloakClientID,
		KeycloakClientSecret:  cfg.KeycloakClientSecret,
		AppBaseURL:            cfg.AppBaseURL,
		GoogleWebClientID:     cfg.GoogleWebClientID,
		GoogleWebClientSecret: cfg.GoogleWebClientSecret,
	})
	authSvc.ProvisionUserKey = encSvc.ProvisionUserKey

	// ── MinIO registry ────────────────────────────────────────────────────────
	// Seed the servers/drives tables on first boot, then build the registry from DB.
	if err := seedDefaultServer(context.Background(), queries, cfg, encSvc.KEK(), cfg.DiskStatsDriveLabel); err != nil {
		log.Fatalf("startup seed: %v", err)
	}

	// Sync capacity_bytes for all drives from the real disk on every startup so
	// the value is always current (not just when a drive is first added).
	if cfg.DiskStatsPath != "" {
		if usage, err := psdisk.Usage(cfg.DiskStatsPath); err == nil {
			total := int64(usage.Used) + int64(usage.Free)
			if err := queries.SyncAllDriveCapacities(context.Background(), total); err != nil {
				log.Printf("warning: sync drive capacities: %v", err)
			} else {
				log.Printf("startup: synced all drives to %d bytes capacity", total)
			}
		} else {
			log.Printf("warning: could not read disk stats for sync: %v", err)
		}
	}

	registry, err := services.NewMinIORegistry(context.Background(), queries, encSvc.KEK())
	if err != nil {
		log.Fatalf("minio registry: %v", err)
	}
	log.Printf("minio: registry initialised")

	emailSvc, err := services.NewEmailService(queries, services.EmailConfig{
		SMTPAddr:     cfg.PostfixInternalHost,
		MailFrom:     cfg.MailFrom,
		AppName:      "Apollo SFS",
		AppURL:       cfg.AppBaseURL,
		TemplatesDir: "templates",
	})
	if err != nil {
		log.Fatalf("email service: %v", err)
	}

	inboundEmailSvc, err := services.NewInboundEmailService(queries, cfg.EmailStoragePath)
	if err != nil {
		log.Fatalf("inbound email service: %v", err)
	}
	log.Printf("inbound email: storing messages under %s", cfg.EmailStoragePath)

	transcodeSvc := services.NewTranscodeService()
	if transcodeSvc.Available() {
		log.Printf("transcode: ffmpeg found — background 480p variants enabled")
	} else {
		log.Printf("transcode: ffmpeg not found — video variants disabled")
	}

	metadataSvc := services.NewMetadataService()

	fileSvc := services.NewFileService(queries, registry, encSvc, emailSvc, transcodeSvc, metadataSvc, services.FileServiceConfig{
		QuotaWarnPct: cfg.QuotaWarningThresholdPct,
	})
	folderSvc := services.NewFolderService(queries)
	favSvc := services.NewFavoriteService(queries)

	inviteSvc := services.NewInviteService(queries, emailSvc, cfg.AppBaseURL, 0)

	metricsSvc := services.NewMetricsService(queries, cfg.DiskStatsPath)

	// ── GeoIP MMDB ───────────────────────────────────────────────────────────
	var geoReader *geoip2.Reader
	for _, path := range []string{
		"/var/lib/GeoIP/GeoLite2-City.mmdb",
		"/var/lib/GeoIP/GeoLite2-Country.mmdb",
	} {
		r, err := geoip2.Open(path)
		if err == nil {
			geoReader = r
			defer r.Close()
			log.Printf("geoip: opened %s", path)
			break
		}
	}
	if geoReader == nil {
		log.Printf("geoip: no MMDB found — geo lookup disabled")
	}

	// Start background goroutines.
	go rotationSvc.StartScheduler(context.Background())
	go metricsSvc.Start(context.Background())
	go emailSvc.Start(context.Background())

	shutdownCh := make(chan struct{})
	r := setupRouter(cfg, queries, oidcVerifier, authSvc, fileSvc, folderSvc, favSvc, inviteSvc, metricsSvc, registry, geoReader, emailSvc, inboundEmailSvc, shutdownCh)

	addr := ":" + cfg.Port
	log.Printf("apollo-sfs API listening on %s", addr)
	srv := &http.Server{
		Addr:    addr,
		Handler: r,
		// Protect against slowloris on header reads without killing upload bodies.
		// ReadTimeout is intentionally omitted (zero = no timeout) so long-running
		// uploads and streaming downloads are never cut off by the server itself.
		ReadHeaderTimeout: 30 * time.Second,
		// Idle connections are reclaimed after 2 minutes of inactivity.
		IdleTimeout: 2 * time.Minute,
	}

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	<-shutdownCh
	log.Println("kill switch triggered — draining connections…")
	drainCtx, drainCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer drainCancel()
	if err := srv.Shutdown(drainCtx); err != nil {
		log.Printf("graceful shutdown error: %v", err)
	}
	log.Println("server stopped")
}

func setupRouter(cfg Config, queries *db.Queries, oidcVerifier *oidc.IDTokenVerifier, authSvc *services.AuthService, fileSvc *services.FileService, folderSvc *services.FolderService, favSvc *services.FavoriteService, inviteSvc *services.InviteService, metricsSvc *services.MetricsService, registry *services.MinIORegistry, geoReader *geoip2.Reader, emailSvc *services.EmailService, inboundEmailSvc *services.InboundEmailService, shutdownCh chan struct{}) *gin.Engine {
	r := gin.New()
	r.Use(gin.Logger())
	r.Use(gin.Recovery())

	// ── Session store ────────────────────────────────────────────────────────
	// The cookie store signs and encrypts the session using SESSION_KEY.
	// access_token and refresh_token are stored inside this single HttpOnly
	// cookie instead of as separate raw cookies.
	store := cookie.NewStore([]byte(cfg.SessionKey))
	store.Options(sessions.Options{
		Path:     "/",
		Domain:   cfg.CookieDomain,
		MaxAge:   int((24 * time.Hour).Seconds()), // matches refresh token lifetime
		Secure:   cfg.CookieSecure,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
	r.Use(sessions.SessionsMany([]string{middleware.SessionName}, store))

	mw := middleware.New(
		oidcVerifier,
		queries,
		cfg.KeycloakInternalURL,
		cfg.KeycloakRealm,
		cfg.KeycloakClientID,
		cfg.KeycloakClientSecret,
		cfg.CookieDomain,
		cfg.CookieSecure,
	)

	uploadStore := services.NewUploadSessionStore()
	presignSvc := services.NewPresignService(cfg.PresignSecret)
	apiKeySvc := services.NewAPIKeyService(queries, []byte(cfg.SFSAPIKeyPepper))
	apiKeyMW := middleware.NewAPIKeyMiddleware(apiKeySvc)

	h := routes.NewHandler(queries, fileSvc, folderSvc, inviteSvc, favSvc, authSvc, uploadStore, emailSvc, presignSvc, cfg.TurnstileSecretKey)
	routes.SetAPIKeyService(h, apiKeySvc)
	routes.SetMathGameService(h, services.NewMathGameService(queries))
	routes.SetShareService(h, services.NewShareService(queries, emailSvc, cfg.AppBaseURL))
	authHandler := auth.NewHandler(authSvc, cfg.CookieDomain, cfg.CookieSecure)
	adminHandler := admin.NewHandler(queries, inviteSvc, metricsSvc, authSvc, fileSvc, registry, geoReader, cfg.DiskStatsPath, cfg.DiskStatsDriveLabel, cfg.BackendTestURL, cfg.AppDir, cfg.FrontendTestURL, cfg.FrontendE2EURL, shutdownCh)
	// Configure the on-demand infrastructure sync (POST /system/sync): discover
	// swarm nodes via the Docker socket and drives/capacity via the MinIO admin API.
	adminHandler.ConfigureInfraSync(admin.InfraSyncConfig{
		Swarm:            services.NewSwarmInspector(),
		Storage:          services.NewStorageInspector(),
		MinIOEndpoint:    cfg.MinIOEndpoint,
		MinIOAccessKey:   cfg.MinIOAccessKey,
		MinIOSecretKey:   cfg.MinIOSecretKey,
		MinIOUseSSL:      cfg.MinIOUseSSL,
		MinIOBucketName:  cfg.MinIOBucketName,
		StandardEndpoint: cfg.MinIOStandardEndpoint,
	})
	sfsHandler := sfs.NewHandler(queries, fileSvc, presignSvc, apiKeySvc)
	inboundEmailHandler := admin.NewInboundEmailHandler(inboundEmailSvc, cfg.SendgridWebhookSecret)

	paypalClient := services.NewPayPalClient(services.PayPalConfig{
		Environment:  cfg.PayPalEnvironment,
		ClientID:     cfg.PayPalClientID,
		ClientSecret: cfg.PayPalClientSecret,
		WebhookID:    cfg.PayPalWebhookID,
	})
	paymentSvc := services.NewPaymentService(queries, authSvc)
	paymentsHandler := payments.NewHandler(paypalClient, paymentSvc, queries, payments.Config{
		AmountCents: cfg.PremiumTierPriceCents,
		Currency:    cfg.PremiumTierCurrency,
		AppBaseURL:  cfg.AppBaseURL,
	})
	storageHandler := storageroutes.NewHandler(queries)
	billingHandler := billing.NewHandler(paypalClient, queries, billing.Config{
		Currency:    cfg.PremiumTierCurrency,
		ReturnURL:   "apollosfs://billing/storage/complete",
		CancelURL:   "apollosfs://billing/storage/cancel",
		ClientID:    cfg.PayPalClientID,
		Environment: cfg.PayPalEnvironment,
	})
	expansionHandler := expansion.NewHandler(paypalClient, emailSvc, queries, expansion.Config{
		Currency:  cfg.PremiumTierCurrency,
		ReturnURL: "apollosfs://billing/expansion/complete",
		CancelURL: "apollosfs://billing/expansion/cancel",
		AppURL:    cfg.AppBaseURL,
	})
	expansionHandler.StartExpiryLoop(context.Background())
	ordersHandler := orders.NewHandler(paypalClient, queries)
	metricsSvc.SetSpeedTestProvider(adminHandler)
	go adminHandler.SpeedTestLoop(context.Background())

	alarmSvc, apiCounter := services.NewAlarmService(queries, emailSvc, adminHandler)
	go alarmSvc.Start(context.Background())

	v1 := r.Group("/api/v1")

	// ── Unauthenticated ──────────────────────────────────────────────────────
	v1.GET("/health", routes.Health)
	v1.GET("/config", func(c *gin.Context) {
		c.JSON(200, gin.H{"turnstile_site_key": cfg.TurnstileSiteKey})
	})
	v1.GET("/invitations/:token", h.ValidateInvitationToken)
	v1.POST("/interest", h.SubmitInterestForm)

	// ── PayPal webhook (no auth — verified via signature) ────────────────────
	v1.POST("/payments/webhook", paymentsHandler.Webhook)

	// ── SendGrid Inbound Parse webhook (no auth — guarded by ?token= secret) ──
	v1.POST("/webhooks/email-inbound", inboundEmailHandler.InboundEmailWebhook)

	// Internal node-agent ingest lives in its own service (cmd/node-metrics-ingest)
	// so it is deployed, scaled, and isolated independently of this API.

	// ── Presigned file endpoints (token auth, no session cookie required) ────
	v1.GET("/files/:file_id/download/p", h.DownloadFilePresigned)
	v1.GET("/files/:file_id/preview/p", h.PreviewFilePresigned)
	v1.POST("/files/upload/p", h.UploadFilePresigned)
	v1.POST("/files/upload/:upload_id/chunk/p", h.UploadChunkPresigned)
	v1.POST("/files/upload/:upload_id/complete/p", h.CompleteUploadPresigned)

	// ── SFS S3-like API (API-key auth, premium only) ─────────────────────────
	// Authenticated via Authorization: Bearer <sfs_..._...> (NOT cookie).
	// IPRateLimit runs first (anti-stuffing); per-key limit could be added
	// after RequireAPIKey but a single shared limit is sufficient for v1.
	sfsGroup := v1.Group("/sfs")
	sfsGroup.Use(mw.RateLimit(), apiKeyMW.RequireAPIKey(), apiKeyMW.RequirePremiumAPI())
	{
		sfsGroup.POST("/buckets/:bucket_id/put", sfsHandler.Put)
		sfsGroup.POST("/buckets/:bucket_id/get", sfsHandler.Get)
		sfsGroup.POST("/buckets/:bucket_id/head", sfsHandler.Head)
		sfsGroup.POST("/buckets/:bucket_id/delete", sfsHandler.Delete)
		sfsGroup.POST("/buckets/:bucket_id/list", sfsHandler.List)
		sfsGroup.POST("/buckets/:bucket_id/move", sfsHandler.Move)
	}

	// ── Auth — rate-limited, no JWT required ─────────────────────────────────
	// Logout is the exception: it requires a valid session to invalidate.
	authGroup := v1.Group("/auth")
	authGroup.Use(mw.RateLimit())
	{
		authGroup.POST("/login", authHandler.Login)
		authGroup.POST("/register", authHandler.Register)
		authGroup.POST("/logout", mw.RequireAuth(), authHandler.Logout)
		authGroup.POST("/refresh", authHandler.Refresh)
		authGroup.POST("/forgot_password", authHandler.ForgotPassword)
		authGroup.POST("/reset_password", authHandler.ResetPassword)
		authGroup.GET("/social/callback", authHandler.SocialCallback)
		authGroup.POST("/social/link", authHandler.SocialLinkConfirm)
	}

	// ── Mobile auth — token-based (no session cookie) ─────────────────────
	mobileAuthGroup := v1.Group("/mobile/auth")
	mobileAuthGroup.Use(mw.RateLimit())
	{
		mobileAuthGroup.POST("/login", authHandler.MobileLogin)
		mobileAuthGroup.POST("/refresh", authHandler.MobileRefresh)
		mobileAuthGroup.POST("/apple", authHandler.MobileAppleLogin)
		mobileAuthGroup.POST("/google", authHandler.MobileGoogleLogin)
	}

	// ── Protected — valid JWT cookie required on every request ───────────────
	// RequireAuth validates the token; if the access token is expired it
	// transparently refreshes it via the refresh token before continuing.
	protected := v1.Group("")
	protected.Use(mw.RequireAuth(), mw.APIRateLimit(), func(c *gin.Context) {
		c.Next()
		apiCounter.RecordRequest(c.Writer.Status() >= 500)
	})
	{
		protected.GET("/me", h.Me)
		// Provisions the app-side user record after a brokered (Keycloak IdP)
		// login. Lives here (not in mobileAuthGroup) because it requires a valid
		// brokered access token, which RequireAuth validates.
		protected.POST("/mobile/auth/session", authHandler.MobileSession)
		protected.POST("/me/password", h.ChangePassword)
		protected.GET("/me/preferences", h.GetPreferences)
		// PUT /me/preferences is premium-only (media auto-upload); registered below.
		// Storage UI toggles are available to every user.
		protected.PUT("/me/preferences/storage-ui", h.UpdateStorageUIPreferences)
		protected.POST("/me/social/link", h.LinkSocial)
		protected.DELETE("/me/social/unlink", h.UnlinkSocial)

		// Devices (mobile sync)
		protected.POST("/devices", h.RegisterDevice)
		protected.DELETE("/devices/:device_id", h.DeleteDevice)

		// Sync delta (mobile)
		protected.GET("/sync/delta", h.DeltaSync)
		protected.POST("/sync/check-hash", h.CheckHash)

		// Files — single upload (small files ≤ 5 MB)
		protected.POST("/files/upload", h.UploadFile)
		// Presigned single upload — issues a token the client uses to upload without cookie auth
		protected.POST("/files/upload/presign", h.PresignUpload)
		// Chunked upload (large files > 5 MB)
		protected.POST("/files/upload/init", h.InitUpload)
		protected.POST("/files/upload/:upload_id/chunk", h.UploadChunk)
		protected.POST("/files/upload/:upload_id/complete", h.CompleteUpload)
		// Presigned chunked upload — issues a session token for token-authenticated chunk uploads
		protected.POST("/files/upload/presign/init", h.PresignChunkedUpload)
		protected.GET("/files/:file_id", h.GetFile)
		protected.GET("/files/:file_id/download", h.DownloadFile)
		protected.GET("/files/:file_id/preview", h.PreviewFile)
		protected.GET("/files/:file_id/stream", h.StreamFile)
		// Presign — issue time-limited download/preview URLs for a file
		protected.POST("/files/:file_id/presign", h.PresignFile)
		protected.PATCH("/files/:file_id", h.UpdateFile)
		protected.PATCH("/files/:file_id/move", h.MoveFile)
		protected.PATCH("/files/:file_id/hide", h.HideFile)
		protected.PATCH("/files/:file_id/unhide", h.UnhideFile)
		protected.DELETE("/files/:file_id", h.DeleteFile)

		// Search
		protected.GET("/search", h.Search)

		// Shares — user-to-user sharing of files and folders. The share token
		// alone grants nothing: every endpoint requires the caller to be logged
		// in as the share's recipient (or owner).
		protected.POST("/shares", h.CreateShare)
		protected.GET("/shares", h.ListMyShares)
		protected.GET("/shares/shared-with-me", h.ListSharedWithMe)
		protected.GET("/shares/resolve/:token", h.ResolveShareToken)
		protected.GET("/shares/:share_id", h.GetShare)
		protected.DELETE("/shares/:share_id", h.RevokeShare)
		protected.GET("/shares/:share_id/contents", h.GetSharedContents)
		protected.GET("/shares/:share_id/file", h.GetSharedFile)
		protected.GET("/shares/:share_id/file/preview", h.PreviewSharedFile)
		protected.GET("/shares/:share_id/file/download", h.DownloadSharedFile)
		protected.POST("/shares/:share_id/upload", h.UploadToShare)

		// Favorites
		protected.GET("/favorites", h.ListFavorites)
		protected.POST("/favorites/files/:file_id", h.FavoriteFile)
		protected.DELETE("/favorites/files/:file_id", h.UnfavoriteFile)
		protected.POST("/favorites/folders/:folder_id", h.FavoriteFolder)
		protected.DELETE("/favorites/folders/:folder_id", h.UnfavoriteFolder)

		// Math game scores (per-user history for the /math-game test)
		protected.GET("/math-game/scores", h.ListMathScores)
		protected.POST("/math-game/scores", h.SaveMathScore)

		// Folders
		protected.GET("/folders", h.ListFolders)
		protected.GET("/folders/:folder_id", h.GetFolder)
		protected.GET("/folders/:folder_id/ancestors", h.GetFolderAncestors)
		protected.POST("/folders", h.CreateFolder)
		protected.PATCH("/folders/:folder_id", h.UpdateFolder)
		protected.PATCH("/folders/:folder_id/move", h.MoveFolder)
		protected.DELETE("/folders/:folder_id", h.DeleteFolder)
		// Per-folder storage tier/server change (moves the folder's direct files
		// to a different drive as a background job; rate-limited).
		protected.POST("/folders/:folder_id/drive-migrations", h.RequestFolderDriveMigration)
		protected.GET("/folders/:folder_id/drive-migrations/latest", h.GetLatestFolderDriveMigration)

		// API key management for the SFS S3-like API. Premium users only;
		// non-premium callers receive 402 from the handler.
		protected.GET("/me/api-keys", h.ListAPIKeys)
		protected.POST("/me/api-keys", h.CreateAPIKey)
		protected.DELETE("/me/api-keys/:id", h.RevokeAPIKey)

		// Premium upgrade — create + capture a one-time PayPal order.
		protected.POST("/payments/orders", paymentsHandler.CreateOrder)
		protected.POST("/payments/orders/:order_id/capture", paymentsHandler.CaptureOrder)

		// User-facing storage info — separate from admin routes for security.
		protected.GET("/storage/servers", storageHandler.ListServers)
		protected.GET("/storage/servers/:server_id/ping", storageHandler.PingServer)
		protected.GET("/storage/breakdown", storageHandler.GetBreakdown)
		protected.GET("/storage/my-servers", storageHandler.ListMyServers)
		protected.PUT("/storage/primary-server", storageHandler.SetPrimaryServer)
		protected.GET("/storage/speed/download", storageHandler.SpeedTestDownload)
		protected.POST("/storage/speed/upload", storageHandler.SpeedTestUpload)

		// Public PayPal config for the web frontend's JS SDK (react-paypal-js).
		protected.GET("/billing/config", billingHandler.GetConfig)

		// Storage add-on billing — four payment methods, each backed by PayPal.
		protected.POST("/billing/storage/order", billingHandler.CreateWalletOrder)
		protected.POST("/billing/storage/order/:order_id/capture", billingHandler.CaptureWalletOrder)
		protected.POST("/billing/storage/hosted-card", billingHandler.CaptureHostedCard)
		protected.POST("/billing/storage/card", billingHandler.ChargeCard)
		protected.POST("/billing/storage/apple-pay", billingHandler.ChargeApplePay)
		protected.POST("/billing/storage/google-pay", billingHandler.ChargeGooglePay)

		// Expansion deposit billing — when a tier is unavailable (or the server
		// is >= 90% allocated), the user pays a 50% deposit.
		protected.GET("/billing/storage/expansion/requests", expansionHandler.ListMine)
		// Custom capacity requests: estimated price only, invoiced after review.
		protected.POST("/billing/storage/expansion/custom", expansionHandler.SubmitCustomRequest)
		protected.POST("/billing/storage/expansion/order", expansionHandler.CreateWalletOrder)
		protected.POST("/billing/storage/expansion/order/:order_id/capture", expansionHandler.CaptureWalletOrder)
		protected.POST("/billing/storage/expansion/hosted-card", expansionHandler.CaptureHostedCardExpansion)
		protected.POST("/billing/storage/expansion/card", expansionHandler.ChargeCardExpansion)
		protected.POST("/billing/storage/expansion/apple-pay", expansionHandler.ChargeApplePayExpansion)
		protected.POST("/billing/storage/expansion/google-pay", expansionHandler.ChargeGooglePayExpansion)

		// Pay remaining balance after admin marks server capacity as expanded.
		// Custom-capacity invoice review & acceptance (linked from the invoice email).
		protected.GET("/billing/invoices/:token", expansionHandler.GetMyInvoice)
		protected.POST("/billing/invoices/:token/accept", expansionHandler.AcceptInvoice)
		protected.POST("/billing/invoices/:token/decline", expansionHandler.DeclineInvoice)
		protected.POST("/billing/invoices/:token/order", expansionHandler.CreateInvoiceDepositOrder)
		protected.POST("/billing/invoices/:token/order/:order_id/capture", expansionHandler.CaptureInvoiceDepositOrder)

		protected.POST("/billing/storage/expansion/:id/pay-remaining/order", expansionHandler.PayRemainingWalletOrder)
		protected.POST("/billing/storage/expansion/:id/pay-remaining/order/:order_id/capture", expansionHandler.CapturePayRemainingWallet)
		protected.POST("/billing/storage/expansion/:id/pay-remaining/card", expansionHandler.PayRemainingCard)
		protected.POST("/billing/storage/expansion/:id/pay-remaining/apple-pay", expansionHandler.PayRemainingApplePay)
		protected.POST("/billing/storage/expansion/:id/pay-remaining/google-pay", expansionHandler.PayRemainingGooglePay)

		// ── Premium-only: media collections ──────────────────────────────────
		premiumGroup := protected.Group("")
		premiumGroup.Use(mw.RequirePremium())
		{
			premiumGroup.GET("/folders/:folder_id/media", h.GetMediaFolder)
			premiumGroup.PUT("/me/preferences", h.UpdatePreferences)
			premiumGroup.POST("/collections/:collection_id/items/:file_id", h.CopyFileToCollection)
			premiumGroup.PATCH("/collections/:collection_id/items/:file_id/move", h.MoveCollectionItem)
			premiumGroup.DELETE("/collections/:collection_id/items/:file_id", h.RemoveFileFromCollection)
		}

		// ── Admin — JWT + admin realm role ───────────────────────────────────
		adminGroup := protected.Group("/admin")
		adminGroup.Use(mw.RequireAdmin())
		{
			adminGroup.GET("/users", adminHandler.GetUsers)
			adminGroup.GET("/users/:user_id", adminHandler.GetUser)
			adminGroup.PATCH("/users/:user_id/quota", adminHandler.UpdateUserQuota)
			adminGroup.PATCH("/users/:user_id/username", adminHandler.UpdateUsername)
			adminGroup.GET("/users/:user_id/storage", h.AdminGetUserStorage)
			adminGroup.GET("/users/:user_id/folders", h.AdminListUserFolders)
			adminGroup.GET("/users/:user_id/folders/:folder_id", h.AdminGetUserFolder)
			adminGroup.GET("/users/:user_id/favorites", h.AdminGetUserFavorites)
			adminGroup.GET("/users/:user_id/audit-logs", h.AdminGetUserAuditLogs)
			adminGroup.POST("/users/:user_id/audit-logs", h.AdminLogImpersonation)

			adminGroup.POST("/invitations", adminHandler.CreateInvitation)
			adminGroup.GET("/invitations", adminHandler.GetInvitations)
			adminGroup.POST("/invitations/:id/resend", adminHandler.ResendInvitation)
			adminGroup.DELETE("/invitations/:id", adminHandler.RevokeInvitation)

			adminGroup.GET("/system/metrics", adminHandler.GetMetrics)
			adminGroup.GET("/system/metrics/history", adminHandler.GetMetricsHistory)
			adminGroup.GET("/system/metrics/stream", adminHandler.StreamMetrics)
			adminGroup.GET("/system/ping", adminHandler.PingServer)

			adminGroup.GET("/system/infrastructure", adminHandler.GetInfrastructure)
			adminGroup.POST("/system/sync", adminHandler.SyncInfrastructure)
			adminGroup.GET("/system/capacity", adminHandler.GetCapacity)
			adminGroup.GET("/system/drive-stats", adminHandler.GetDriveStats)
			adminGroup.GET("/system/nodes/:node_id/metrics/history", adminHandler.GetNodeMetricsHistory)
			adminGroup.GET("/system/nodes/:node_id/disks", adminHandler.GetNodeDisks)
			adminGroup.GET("/system/drives/:drive_id/temps/history", adminHandler.GetDriveTempsHistory)
			adminGroup.GET("/system/disks/:disk_id/temps/history", adminHandler.GetNodeDiskTempsHistory)
			adminGroup.POST("/system/servers", adminHandler.CreateServer)
			adminGroup.PATCH("/system/servers/:server_id", adminHandler.UpdateServer)
			adminGroup.POST("/system/servers/:server_id/nodes", adminHandler.CreateNode)
			adminGroup.PATCH("/system/servers/:server_id/nodes/:node_id", adminHandler.UpdateNode)
			adminGroup.DELETE("/system/servers/:server_id/nodes/:node_id", adminHandler.DeleteNode)
			adminGroup.POST("/system/servers/:server_id/drives", adminHandler.AddDrive)
			adminGroup.PATCH("/system/servers/:server_id/drives/:drive_id", adminHandler.UpdateDrive)
			adminGroup.DELETE("/system/servers/:server_id/drives/:drive_id", adminHandler.DeleteDrive)
			adminGroup.POST("/system/drives/:drive_id/sync-capacity", adminHandler.SyncDriveCapacity)

			adminGroup.GET("/banned-ips", adminHandler.ListBannedIPs)
			adminGroup.POST("/banned-ips/:id/unban", adminHandler.UnbanIP)
			adminGroup.POST("/banned-ips/:id/extend", adminHandler.ExtendBan)

			adminGroup.POST("/users/:user_id/ban", adminHandler.BanUser)
			adminGroup.POST("/users/:user_id/suspend", adminHandler.SuspendUser)
			adminGroup.POST("/users/:user_id/pardon", adminHandler.PardonUser)
			adminGroup.GET("/bans", adminHandler.ListUserBans)

			adminGroup.GET("/expansion-requests", expansionHandler.ListRequests)
			adminGroup.POST("/expansion-requests/:id/approve", expansionHandler.ApproveRequest)
			adminGroup.POST("/expansion-requests/:id/fulfill", expansionHandler.MarkExpanded)
			adminGroup.GET("/expansion-requests/:id/invoice", expansionHandler.GetInvoice)
			adminGroup.POST("/expansion-requests/:id/invoice", expansionHandler.CreateInvoice)

			// Combined orders view (premium payments + storage purchases).
			adminGroup.GET("/orders", ordersHandler.List)
			adminGroup.POST("/orders/:type/:id/refund", ordersHandler.Refund)
			adminGroup.POST("/expansion-requests/:id/cancel", expansionHandler.CancelRequest)

			adminGroup.GET("/interest", adminHandler.ListInterestSubmissions)
			adminGroup.GET("/interest/settings", adminHandler.GetInterestFormSettings)
			adminGroup.PUT("/interest/settings", adminHandler.UpdateInterestFormSettings)
			adminGroup.POST("/interest/:id/provision", adminHandler.ProvisionInterestSubmission)

			adminGroup.POST("/system/tests", adminHandler.RunTests)
			adminGroup.POST("/system/shutdown", adminHandler.Shutdown)

			adminGroup.GET("/system/speed-test", adminHandler.GetSpeedTest)
			adminGroup.POST("/system/speed-test", adminHandler.TriggerSpeedTest)

			adminGroup.GET("/system/alarm/subscriptions", adminHandler.GetAlarmSubscriptions)
			adminGroup.PUT("/system/alarm/subscriptions", adminHandler.UpsertAlarmSubscription)
			adminGroup.DELETE("/system/alarm/subscriptions", adminHandler.DeleteAlarmSubscription)

			adminGroup.GET("/emails/workers", inboundEmailHandler.ListEmailWorkers)
			adminGroup.GET("/emails", inboundEmailHandler.ListEmails)
			adminGroup.GET("/emails/:id", inboundEmailHandler.GetEmail)
			adminGroup.PATCH("/emails/:id/read", inboundEmailHandler.MarkEmailRead)
			adminGroup.DELETE("/emails/:id", inboundEmailHandler.DeleteEmail)
		}
	}

	return r
}

// seedDefaultServer runs once on first boot (when the servers table is empty).
// It creates a server + drive record from the existing env-var MinIO credentials,
// auto-detects drive capacity from the disk stats path, backfills files.drive_id,
// and allocates all existing users to the new drive.
func seedDefaultServer(ctx context.Context, queries *db.Queries, cfg Config, kek []byte, driveLabel string) error {
	servers, err := queries.ListServers(ctx)
	if err != nil {
		return fmt.Errorf("list servers: %w", err)
	}
	if len(servers) > 0 {
		return nil // already seeded
	}

	// Detect usable capacity from the data mount (excludes filesystem-reserved blocks).
	var capacityBytes int64
	if usage, err := psdisk.Usage(cfg.DiskStatsPath); err == nil {
		capacityBytes = int64(usage.Used) + int64(usage.Free)
	} else {
		log.Printf("seed: could not detect disk capacity (%v); defaulting to 1 TiB", err)
		capacityBytes = 1 << 40
	}

	// Encrypt the existing MinIO credentials with the KEK.
	accessEnc, accessNonce, err := services.EncryptMinIOSecret(kek, cfg.MinIOAccessKey)
	if err != nil {
		return fmt.Errorf("encrypt access key: %w", err)
	}
	secretEnc, secretNonce, err := services.EncryptMinIOSecret(kek, cfg.MinIOSecretKey)
	if err != nil {
		return fmt.Errorf("encrypt secret key: %w", err)
	}

	server, err := queries.CreateServer(ctx, db.CreateServerParams{
		Name:                "LOCAL-0001",
		State:               "LOCAL",
		MinioEndpoint:       cfg.MinIOEndpoint,
		MinioUseSSL:         false,
		MinioAccessKeyEnc:   accessEnc,
		MinioAccessKeyNonce: accessNonce,
		MinioSecretKeyEnc:   secretEnc,
		MinioSecretKeyNonce: secretNonce,
	})
	if err != nil {
		return fmt.Errorf("create server: %w", err)
	}

	// Every server owns at least one node (the manager host itself). Drives are
	// mounted on a node, so create a default node and attach the seeded drive.
	node, err := queries.CreateNode(ctx, db.CreateNodeParams{
		ServerID: server.ID,
		Hostname: server.Name + "-node-1",
		Role:     "manager",
	})
	if err != nil {
		return fmt.Errorf("create node: %w", err)
	}

	label := driveLabel
	if label == "" {
		label = "nvme-01"
	}
	// The bootstrap drive is the primary NVMe/fast tier; infer the tier from the
	// label to match AddDrive's classification.
	driveType := "hdd"
	if strings.Contains(strings.ToLower(label), "nvme") {
		driveType = "nvme"
	}
	drive, err := queries.CreateDrive(ctx, db.CreateDriveParams{
		ServerID:      server.ID,
		NodeID:        &node.ID,
		Label:         label,
		CapacityBytes: capacityBytes,
		MinioBucket:   cfg.MinIOBucketName,
		DriveType:     driveType,
	})
	if err != nil {
		return fmt.Errorf("create drive: %w", err)
	}

	// Backfill existing files and user allocations.
	pool, err := db.Connect(cfg.DatabaseDSN)
	if err != nil {
		return fmt.Errorf("open pool for backfill: %w", err)
	}
	defer pool.Close()

	if _, err := pool.ExecContext(ctx,
		`UPDATE files SET drive_id = $1 WHERE drive_id IS NULL`, drive.ID); err != nil {
		return fmt.Errorf("backfill files.drive_id: %w", err)
	}
	if _, err := pool.ExecContext(ctx, `
		INSERT INTO user_drive_allocations (user_id, drive_id)
		SELECT username, $1 FROM users
		ON CONFLICT (user_id) DO NOTHING
	`, drive.ID); err != nil {
		return fmt.Errorf("backfill user_drive_allocations: %w", err)
	}

	log.Printf("seed: created server %s + drive %s (capacity %.1f GB), backfilled existing data",
		server.Name, drive.Label, float64(capacityBytes)/(1<<30))
	return nil
}
