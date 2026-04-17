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
	// NewProvider fetches the discovery document from
	// {issuerURL}/.well-known/openid-configuration and caches the JWKS.
	// InsecureIssuerURLContext allows the internal Docker hostname to be used
	// for discovery while tokens carry the public-facing hostname as issuer.
	issuerURL := cfg.KeycloakInternalURL + "/realms/" + cfg.KeycloakRealm
	oidcCtx := oidc.InsecureIssuerURLContext(context.Background(), issuerURL)
	oidcProvider, err := oidc.NewProvider(oidcCtx, issuerURL)
	if err != nil {
		log.Fatalf("keycloak: connect to %s: %v", issuerURL, err)
	}
	oidcVerifier := oidcProvider.Verifier(&oidc.Config{
		ClientID: cfg.KeycloakClientID,
	})
	log.Printf("keycloak: connected to %s", issuerURL)

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

	minioSvc := services.NewMinIOService(minioClient, cfg.MinIOBucketName)
	fileSvc := services.NewFileService(queries, minioSvc, encSvc, services.FileServiceConfig{
		QuotaWarnPct: cfg.QuotaWarningThresholdPct,
	})
	folderSvc := services.NewFolderService(queries)
	inviteSvc := services.NewInviteService(queries, nil, cfg.AppBaseURL, 0)
	// TODO: replace nil with emailSvc once EmailService is wired:
	//   inviteSvc = services.NewInviteService(queries, emailSvc, cfg.AppBaseURL, 0)

	// TODO: remaining services
	//   emailSvc := services.NewEmailService(queries, services.EmailConfig{...})
	//   inviteSvc  := services.NewInviteService(pool, emailSvc)
	//   metricsSvc := services.NewMetricsService(pool)

	metricsSvc := services.NewMetricsService(queries)

	// Start background goroutines.
	go rotationSvc.StartScheduler(context.Background())
	go metricsSvc.Start(context.Background())

	r := setupRouter(cfg, queries, oidcVerifier, authSvc, fileSvc, folderSvc, inviteSvc, metricsSvc)

	addr := ":" + cfg.Port
	log.Printf("apollo-sfs API listening on %s", addr)
	if err := r.Run(addr); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func setupRouter(cfg Config, queries *db.Queries, oidcVerifier *oidc.IDTokenVerifier, authSvc *services.AuthService, fileSvc *services.FileService, folderSvc *services.FolderService, inviteSvc *services.InviteService, metricsSvc *services.MetricsService) *gin.Engine {
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
		MaxAge:   int((7 * 24 * time.Hour).Seconds()), // matches refresh token lifetime
		Secure:   cfg.CookieSecure,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
	r.Use(sessions.Sessions(middleware.SessionName, store))

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

	h := routes.NewHandler(queries, fileSvc, folderSvc, inviteSvc)
	authHandler := auth.NewHandler(authSvc)
	adminHandler := admin.NewHandler(queries, inviteSvc, metricsSvc)

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
	protected.Use(mw.RequireAuth(), mw.ProactiveRefresh())
	{
		protected.GET("/me", h.Me)

		// Files
		protected.POST("/files/upload", h.UploadFile)
		protected.GET("/files/:file_id", h.GetFile)
		protected.GET("/files/:file_id/download", h.DownloadFile)
		protected.GET("/files/:file_id/preview", h.PreviewFile)
		protected.PATCH("/files/:file_id", h.UpdateFile)
		protected.DELETE("/files/:file_id", h.DeleteFile)

		// Folders
		protected.GET("/folders", h.ListFolders)
		protected.GET("/folders/:folder_id", h.GetFolder)
		protected.POST("/folders", h.CreateFolder)
		protected.PATCH("/folders/:folder_id", h.UpdateFolder)
		protected.DELETE("/folders/:folder_id", h.DeleteFolder)

		// ── Admin — JWT + admin realm role ───────────────────────────────────
		adminGroup := protected.Group("/admin")
		adminGroup.Use(mw.RequireAdmin())
		{
			adminGroup.GET("/users", adminHandler.GetUsers)
			adminGroup.GET("/users/:user_id", adminHandler.GetUser)
			adminGroup.PATCH("/users/:user_id/quota", adminHandler.UpdateUserQuota)

			adminGroup.POST("/invitations", adminHandler.CreateInvitation)
			adminGroup.GET("/invitations", adminHandler.GetInvitations)
			adminGroup.DELETE("/invitations/:id", adminHandler.RevokeInvitation)

			adminGroup.GET("/system/metrics", adminHandler.GetMetrics)
			adminGroup.GET("/system/metrics/history", adminHandler.GetMetricsHistory)
			adminGroup.GET("/system/metrics/stream", adminHandler.StreamMetrics)
		}
	}

	return r
}
