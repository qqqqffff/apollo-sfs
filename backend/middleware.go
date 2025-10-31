package main

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

type TokenClaims struct {
	jwt.RegisteredClaims
	Username      string `json:"username"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
}

func AuthMiddleware(keycloak *KeycloakService) gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Authorization header required"})
			c.Abort()
			return
		}

		parts := strings.Split(authHeader, " ")
		if len(parts) != 2 || parts[0] != "Bearer" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid authorization header format"})
			c.Abort()
			return
		}

		accessToken := parts[1]
		refreshToken := c.GetHeader("X-Refresh-Token")

		expired, expiresIn := isTokenExpired(accessToken)

		if (expired || expiresIn < 2*time.Minute) && refreshToken != "" {
			newTokens, refreshErr := keycloak.RefreshToken(refreshToken)
			if refreshErr == nil {
				userInfo, verifyErr := keycloak.GetUserInfo(newTokens.AccessToken)
				if verifyErr == nil {
					c.Set("userInfo", userInfo)
					c.Set("accessToken", newTokens.AccessToken)
					c.Set("refreshToken", newTokens.RefreshToken)

					c.Header("X-New-Access-Token", newTokens.AccessToken)
					c.Header("X-New-Refresh-Token", newTokens.RefreshToken)
					c.Header("X-Token-Refreshed", "true")
					c.Header("X-Token-Expires-In", string(rune(newTokens.ExpiresIn)))

					c.Next()
					return
				}
			}

			if expired {
				c.JSON(http.StatusUnauthorized, gin.H{
					"error":            "Token expired",
					"refreshRequired":  true,
					"errorDescription": "Please login again",
				})

				c.Abort()
				return
			}
		}

		userInfo, err := keycloak.GetUserInfo(accessToken)
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error":            "Invalid token",
				"errorDescription": err.Error(),
			})
			c.Abort()
			return
		}

		c.Set("userInfo", userInfo)
		c.Set("accessToken", accessToken)

		c.Next()
	}
}

func isTokenExpired(tokenString string) (bool, time.Duration) {
	parser := jwt.NewParser(jwt.WithoutClaimsValidation())
	token, _, err := parser.ParseUnverified(tokenString, &TokenClaims{})

	if err != nil {
		return true, 0
	}

	claims, ok := token.Claims.(*TokenClaims)
	if !ok {
		return true, 0
	}

	if claims.ExpiresAt == nil {
		return true, 0
	}

	expiryTime := claims.ExpiresAt.Time
	now := time.Now()

	if expiryTime.Before(now) {
		return true, 0
	}

	timeUntilExpiry := expiryTime.Sub(now)
	return false, timeUntilExpiry
}

func validateTokenClaims(claims *TokenClaims) error {
	now := time.Now()

	if claims.ExpiresAt != nil && claims.ExpiresAt.Time.Before(now) {
		return jwt.ErrTokenExpired
	}

	if claims.NotBefore != nil && claims.NotBefore.Time.After(now) {
		return jwt.ErrTokenNotValidYet
	}

	if claims.IssuedAt != nil && claims.IssuedAt.Time.After(now.Add(1*time.Minute)) {
		return jwt.ErrTokenUsedBeforeIssued
	}

	return nil
}

func ProactiveTokenRefreshMiddleware(keycloak *KeycloakService, thresholdMinutes int) gin.HandlerFunc {
	return func(c *gin.Context) {
		accessToken := c.GetString("accessToken")
		refreshToken := c.GetHeader("X-Refresh-Token")

		if accessToken != "" && refreshToken != "" {
			expired, expiresIn := isTokenExpired(accessToken)
			threshold := time.Duration(thresholdMinutes) * time.Minute

			if !expired && expiresIn < threshold && expiresIn > 0 {
				newTokens, err := keycloak.RefreshToken(refreshToken)

				if err == nil {
					c.Header("X-New-Access-Token", newTokens.AccessToken)
					c.Header("X-New-Refresh-Token", newTokens.RefreshToken)
					c.Header("X-Token-Refreshed", "true")
					c.Header("X-Token-Expires-In", string(rune(newTokens.ExpiresIn)))
				}
			}
		}

		c.Next()
	}
}
