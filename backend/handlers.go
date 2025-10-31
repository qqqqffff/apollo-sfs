package main

import (
	"net/http"
	"strconv"
	"time"

	// "time"

	"github.com/gin-gonic/gin"
)

type AuthService struct {
	keycloak *KeycloakService
}

func GetAuthService(keycloak *KeycloakService) *AuthService {
	return &AuthService{keycloak: keycloak}
}

type AuthHandler struct {
	service *AuthService
}

func GetAuthHandler(service *AuthService) *AuthHandler {
	return &AuthHandler{service: service}
}

type LoginRequest struct {
	Username string `json:"username" binding:"required"`
	Password string `json:"password" binding:"required"`
}

type RefreshRequest struct {
	RefreshToken string `json:"refreshToken" binding:"required"`
}

func (h *AuthHandler) Login(c *gin.Context) {
	var req LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	tokens, err := h.service.keycloak.Login(req.Username, req.Password)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid login attempt"})
		return
	}

	c.JSON(http.StatusOK, tokens)
}

func (h *AuthHandler) Signup(c *gin.Context) {
	var req SignupRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if err := h.service.keycloak.Signup(req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"message": "User created successfully"})
}

func (h *AuthHandler) RefreshToken(c *gin.Context) {
	var req RefreshRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	tokens, err := h.service.keycloak.RefreshToken(req.RefreshToken)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid refresh token"})
		return
	}

	c.JSON(http.StatusOK, tokens)
}

func (h *AuthHandler) Logout(c *gin.Context) {
	var req RefreshRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if err := h.service.keycloak.Logout(req.RefreshToken); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Logout failed"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Logged out successfully"})
}

func (h *AuthHandler) GetProfile(c *gin.Context) {
	userInfo, exists := c.Get("userInfo")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "User not authenticated"})
		return
	}

	c.JSON(http.StatusOK, userInfo)
}

func (h *AuthHandler) VerifyToken(c *gin.Context) {
	authHeader := c.GetHeader("Authorization")

	if authHeader == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "No token provided"})
		return
	}

	token := ""
	if len(authHeader) > 7 && authHeader[:7] == "Bearer " {
		token = authHeader[7:]
	} else {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid authorization format"})
		return
	}

	if err := h.service.keycloak.VerifyToken(token); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{
			"valid": false,
			"error": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"valid": true,
	})
}

type FileService struct {
	minio *MinioService
}

func GetFileService(minio *MinioService) *FileService {
	return &FileService{minio: minio}
}

type FileHandler struct {
	service *FileService
}

func GetFileHandler(service *FileService) *FileHandler {
	return &FileHandler{service: service}
}

func (h *FileHandler) Upload(c *gin.Context) {
	userInfo, _ := c.Get("userInfo")
	user := userInfo.(*UserInfo)

	file, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No file uploaded"})
		return
	}
	src, err := file.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to open file"})
		return
	}
	defer src.Close()

	metadata, err := h.service.minio.UploadFile(
		c.Request.Context(),
		user.Sub,
		file.Filename,
		src,
		file.Size,
		file.Header.Get("Content-Type"),
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, metadata)
}

func (h *FileHandler) ListFiles(c *gin.Context) {
	userInfo, _ := c.Get("userInfo")
	user := userInfo.(*UserInfo)

	limitStr := c.DefaultQuery("limit", "20")
	cursor := c.Query("cursor")

	limit, err := strconv.Atoi(limitStr)
	if err != nil || limit <= 0 || limit > 100 {
		limit = 20
	}

	files, nextCursor, err := h.service.minio.ListFiles(
		c.Request.Context(),
		user.Sub,
		limit,
		cursor,
	)

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	response := gin.H{
		"files": files,
	}

	if nextCursor != "" {
		response["nextCursor"] = nextCursor
		response["hasMore"] = true
	} else {
		response["hasMore"] = false
	}

	c.JSON(http.StatusOK, response)
}

func (h *FileHandler) GetFile(c *gin.Context) {
	userInfo, _ := c.Get("userInfo")
	user := userInfo.(*UserInfo)

	fileID := c.Param("fileId")

	url, err := h.service.minio.GetPresignedURL(
		c.Request.Context(),
		user.Sub,
		fileID,
		time.Hour,
	)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"url":       url,
		"expiresIn": 3600,
		"fileId":    fileID,
	})
}

func (h *FileHandler) DownloadFile(c *gin.Context) {
	userInfo, _ := c.Get("userInfo")
	user := userInfo.(*UserInfo)

	fileID := c.Param("fileId")

	reader, metadata, err := h.service.minio.GetFile(
		c.Request.Context(),
		user.Sub,
		fileID,
	)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}
	defer reader.Close()

	c.Header("Content-Description", "File Transfer")
	c.Header("Content-Transfer-Encoding", "binary")
	c.Header("Content-Disposition", "attachment; filename="+metadata.Name)
	c.Header("Content-Type", metadata.ContentType)
	c.Header("Content-Length", strconv.FormatInt(metadata.Size, 10))

	c.DataFromReader(http.StatusOK, metadata.Size, metadata.ContentType, reader, nil)
}

func (h *FileHandler) DeleteFile(c *gin.Context) {
	userInfo, _ := c.Get("userInfo")
	user := userInfo.(*UserInfo)

	fileID := c.Param("fileId")
	if err := h.service.minio.DeleteFile(c.Request.Context(), user.Sub, fileID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "File deleted successfully"})
}
