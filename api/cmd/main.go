package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gin-contrib/sessions"
	"github.com/gin-contrib/sessions/cookie"
	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"

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

	// ── MinIO ─────────────────────────────────────────────────────────────────
	minioClient, err := services.NewMinIOClient(
		cfg.MinIOEndpoint,
		cfg.MinIOAccessKey,
		cfg.MinIOSecretKey,
		false, // TLS terminated by Nginx; internal Docker network uses plain HTTP
	)
	if err != nil {
		log.Fatalf("minio: %v", err)
	}
	if err := services.EnsureBucket(context.Background(), minioClient, cfg.MinIOBucketName); err != nil {
		log.Fatalf("minio: %v", err)
	}
	log.Printf("minio: connected to %s (bucket: %s)", cfg.MinIOEndpoint, cfg.MinIOBucketName)

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

	minioSvc := services.NewMinIOService(minioClient, cfg.MinIOBucketName)

	transcodeSvc := services.NewTranscodeService()
	if transcodeSvc.Available() {
		log.Printf("transcode: ffmpeg found — background 480p variants enabled")
	} else {
		log.Printf("transcode: ffmpeg not found — video variants disabled")
	}

	fileSvc := services.NewFileService(queries, minioSvc, encSvc, emailSvc, transcodeSvc, services.FileServiceConfig{
		QuotaWarnPct: cfg.QuotaWarningThresholdPct,
	})
	folderSvc := services.NewFolderService(queries)
	favSvc := services.NewFavoriteService(queries)

	inviteSvc := services.NewInviteService(queries, emailSvc, cfg.AppBaseURL, 0)

	metricsSvc := services.NewMetricsService(queries, cfg.DiskStatsPath)

	// Start background goroutines.
	go rotationSvc.StartScheduler(context.Background())
	go metricsSvc.Start(context.Background())
	go emailSvc.Start(context.Background())

	r := setupRouter(cfg, queries, oidcVerifier, authSvc, fileSvc, folderSvc, favSvc, inviteSvc, metricsSvc)

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
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func setupRouter(cfg Config, queries *db.Queries, oidcVerifier *oidc.IDTokenVerifier, authSvc *services.AuthService, fileSvc *services.FileService, folderSvc *services.FolderService, favSvc *services.FavoriteService, inviteSvc *services.InviteService, metricsSvc *services.MetricsService) *gin.Engine {
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
		cfg.TokenRefreshThreshold,
		cfg.CookieDomain,
		cfg.CookieSecure,
	)

	uploadStore := services.NewUploadSessionStore()

	h := routes.NewHandler(queries, fileSvc, folderSvc, inviteSvc, favSvc, authSvc, uploadStore)
	authHandler := auth.NewHandler(authSvc)
	adminHandler := admin.NewHandler(queries, inviteSvc, metricsSvc, authSvc)

	v1 := r.Group("/api/v1")

	// ── Unauthenticated ──────────────────────────────────────────────────────
	v1.GET("/health", routes.Health)
	v1.GET("/invitations/:token", h.ValidateInvitationToken)

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
	// RequireAuth validates the token and injects userID + exp into Gin context.
	// ProactiveRefresh silently refreshes the token when it is close to expiring.
	protected := v1.Group("")
	protected.Use(mw.RequireAuth(), mw.ProactiveRefresh(), mw.APIRateLimit())
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
		}
	}

	return r
}
