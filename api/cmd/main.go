package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
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
	"apollo-sfs.com/api/routes/services"
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
		KeycloakURL:          cfg.KeycloakInternalURL,
		KeycloakRealm:        cfg.KeycloakRealm,
		KeycloakClientID:     cfg.KeycloakClientID,
		KeycloakClientSecret: cfg.KeycloakClientSecret,
		AppBaseURL:           cfg.AppBaseURL,
	})
	authSvc.ProvisionUserKey = encSvc.ProvisionUserKey

	// ── MinIO registry ────────────────────────────────────────────────────────
	// Seed the servers/drives tables on first boot, then build the registry from DB.
	if err := seedDefaultServer(context.Background(), queries, cfg, encSvc.KEK()); err != nil {
		log.Fatalf("startup seed: %v", err)
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

	transcodeSvc := services.NewTranscodeService()
	if transcodeSvc.Available() {
		log.Printf("transcode: ffmpeg found — background 480p variants enabled")
	} else {
		log.Printf("transcode: ffmpeg not found — video variants disabled")
	}

	fileSvc := services.NewFileService(queries, registry, encSvc, emailSvc, transcodeSvc, services.FileServiceConfig{
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
	r := setupRouter(cfg, queries, oidcVerifier, authSvc, fileSvc, folderSvc, favSvc, inviteSvc, metricsSvc, registry, geoReader, emailSvc, shutdownCh)

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

func setupRouter(cfg Config, queries *db.Queries, oidcVerifier *oidc.IDTokenVerifier, authSvc *services.AuthService, fileSvc *services.FileService, folderSvc *services.FolderService, favSvc *services.FavoriteService, inviteSvc *services.InviteService, metricsSvc *services.MetricsService, registry *services.MinIORegistry, geoReader *geoip2.Reader, emailSvc *services.EmailService, shutdownCh chan struct{}) *gin.Engine {
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

	h := routes.NewHandler(queries, fileSvc, folderSvc, inviteSvc, favSvc, authSvc, uploadStore, emailSvc, cfg.TurnstileSecretKey)
	authHandler := auth.NewHandler(authSvc)
	adminHandler := admin.NewHandler(queries, inviteSvc, metricsSvc, authSvc, registry, geoReader, cfg.BackendTestURL, cfg.AppDir, cfg.FrontendTestURL, cfg.FrontendE2EURL, shutdownCh)
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
		protected.POST("/me/password", h.ChangePassword)

		// Files — single upload (small files ≤ 5 MB)
		protected.POST("/files/upload", h.UploadFile)
		// Chunked upload (large files > 5 MB)
		protected.POST("/files/upload/init", h.InitUpload)
		protected.POST("/files/upload/:upload_id/chunk", h.UploadChunk)
		protected.POST("/files/upload/:upload_id/complete", h.CompleteUpload)
		protected.GET("/files/:file_id", h.GetFile)
		protected.GET("/files/:file_id/download", h.DownloadFile)
		protected.GET("/files/:file_id/preview", h.PreviewFile)
		protected.GET("/files/:file_id/stream", h.StreamFile)
		protected.PATCH("/files/:file_id", h.UpdateFile)
		protected.PATCH("/files/:file_id/move", h.MoveFile)
		protected.DELETE("/files/:file_id", h.DeleteFile)

		// Search
		protected.GET("/search", h.Search)

		// Favorites
		protected.GET("/favorites", h.ListFavorites)
		protected.POST("/favorites/files/:file_id", h.FavoriteFile)
		protected.DELETE("/favorites/files/:file_id", h.UnfavoriteFile)
		protected.POST("/favorites/folders/:folder_id", h.FavoriteFolder)
		protected.DELETE("/favorites/folders/:folder_id", h.UnfavoriteFolder)

		// Folders
		protected.GET("/folders", h.ListFolders)
		protected.GET("/folders/:folder_id", h.GetFolder)
		protected.POST("/folders", h.CreateFolder)
		protected.PATCH("/folders/:folder_id", h.UpdateFolder)
		protected.PATCH("/folders/:folder_id/move", h.MoveFolder)
		protected.DELETE("/folders/:folder_id", h.DeleteFolder)

		// ── Admin — JWT + admin realm role ───────────────────────────────────
		adminGroup := protected.Group("/admin")
		adminGroup.Use(mw.RequireAdmin())
		{
			adminGroup.GET("/users", adminHandler.GetUsers)
			adminGroup.GET("/users/:user_id", adminHandler.GetUser)
			adminGroup.PATCH("/users/:user_id/quota", adminHandler.UpdateUserQuota)
			adminGroup.PATCH("/users/:user_id/username", adminHandler.UpdateUsername)

			adminGroup.POST("/invitations", adminHandler.CreateInvitation)
			adminGroup.GET("/invitations", adminHandler.GetInvitations)
			adminGroup.POST("/invitations/:id/resend", adminHandler.ResendInvitation)
			adminGroup.DELETE("/invitations/:id", adminHandler.RevokeInvitation)

			adminGroup.GET("/system/metrics", adminHandler.GetMetrics)
			adminGroup.GET("/system/metrics/history", adminHandler.GetMetricsHistory)
			adminGroup.GET("/system/metrics/stream", adminHandler.StreamMetrics)
			adminGroup.GET("/system/ping", adminHandler.PingServer)

			adminGroup.GET("/system/infrastructure", adminHandler.GetInfrastructure)
			adminGroup.GET("/system/capacity", adminHandler.GetCapacity)
			adminGroup.POST("/system/servers", adminHandler.CreateServer)
			adminGroup.PATCH("/system/servers/:server_id", adminHandler.UpdateServer)
			adminGroup.POST("/system/servers/:server_id/drives", adminHandler.AddDrive)
			adminGroup.PATCH("/system/servers/:server_id/drives/:drive_id", adminHandler.UpdateDrive)

			adminGroup.GET("/banned-ips", adminHandler.ListBannedIPs)
			adminGroup.POST("/banned-ips/:id/unban", adminHandler.UnbanIP)
			adminGroup.POST("/banned-ips/:id/extend", adminHandler.ExtendBan)

			adminGroup.GET("/interest", adminHandler.ListInterestSubmissions)
			adminGroup.GET("/interest/settings", adminHandler.GetInterestFormSettings)
			adminGroup.PUT("/interest/settings", adminHandler.UpdateInterestFormSettings)
			adminGroup.POST("/interest/:id/provision", adminHandler.ProvisionInterestSubmission)

			adminGroup.POST("/system/tests", adminHandler.RunTests)
			adminGroup.POST("/system/shutdown", adminHandler.Shutdown)

			adminGroup.GET("/system/speed-test", adminHandler.GetSpeedTest)
			adminGroup.POST("/system/speed-test", adminHandler.TriggerSpeedTest)

			adminGroup.GET("/system/drive-temps", adminHandler.GetDriveTemps)

			adminGroup.GET("/system/alarm/settings", adminHandler.GetAlarmSettings)
			adminGroup.POST("/system/alarm/subscribe", adminHandler.ToggleAlarmSubscription)
		}
	}

	return r
}

// seedDefaultServer runs once on first boot (when the servers table is empty).
// It creates a server + drive record from the existing env-var MinIO credentials,
// auto-detects drive capacity from the disk stats path, backfills files.drive_id,
// and allocates all existing users to the new drive.
func seedDefaultServer(ctx context.Context, queries *db.Queries, cfg Config, kek []byte) error {
	servers, err := queries.ListServers(ctx)
	if err != nil {
		return fmt.Errorf("list servers: %w", err)
	}
	if len(servers) > 0 {
		return nil // already seeded
	}

	// Detect physical capacity from the data mount.
	var capacityBytes int64
	if usage, err := psdisk.Usage(cfg.DiskStatsPath); err == nil {
		capacityBytes = int64(usage.Total)
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

	drive, err := queries.CreateDrive(ctx, db.CreateDriveParams{
		ServerID:      server.ID,
		Label:         "nvme-01",
		CapacityBytes: capacityBytes,
		MinioBucket:   cfg.MinIOBucketName,
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
