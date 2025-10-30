package main

import (
	"log"
	"os"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
)

func main() {
	if err := godotenv.Load(); err != nil {
		panic(err)
	}

	keycloackService := GetKeycloakService()
	minioService := GetMinioService()
	authService := GetAuthService(keycloackService)
	fileService := GetFileService(minioService)

	authHandler := GetAuthHandler(authService)
	fileHandler := GetFileHandler(fileService)

	router := gin.Default()

	router.Use(cors.New(cors.Config{
		AllowOrigins:     []string{os.Getenv("FRONTEND_URL")},
		AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Authorization"},
		ExposeHeaders:    []string{"Content-Length"},
		AllowCredentials: true,
	}))

	router.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "healthy"})
	})

	v1 := router.Group("/api/v1")
	{
		auth := v1.Group("/auth")
		{
			auth.POST("/login", authHandler.Login)
			auth.POST("/signup", authHandler.Signup)
			auth.POST("/refresh", authHandler.RefreshToken)
			auth.POST("/logout", authHandler.Logout)
		}

		files := v1.Group("/files")
		files.Use(AuthMiddleware(keycloackService))
		{
			files.POST("/upload", fileHandler.Upload)
			files.GET("", fileHandler.ListFiles)
			files.GET("/:fileId", fileHandler.GetFile)
			files.DELETE("/:fileId", fileHandler.DeleteFile)
			files.GET("/:fileId/download", fileHandler.DownloadFile)
		}

		user := v1.Group("/user")
		user.Use(AuthMiddleware(keycloackService))
		{
			user.GET("/profile", authHandler.GetProfile)
		}
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	log.Printf("Starting backend server on port %s", port)
	if err := router.Run(":" + port); err != nil {
		log.Fatal("Failed to start server:", err)
	}
}
