package admin

import (
	"database/sql"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/db"
)

// ListBannedIPs handles GET /api/v1/admin/banned-ips
//
// Query params:
//
//	status=active (default) | all
//	cursor=<opaque>
//	limit=<int>
func (h *Handler) ListBannedIPs(c *gin.Context) {
	activeOnly := strings.ToLower(c.DefaultQuery("status", "active")) == "active"

	page := db.PageInput{Cursor: strings.TrimSpace(c.Query("cursor"))}
	if err := parseLimit(c, &page.Limit); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "limit must be a positive integer"})
		return
	}

	result, err := h.queries.ListBannedIPs(c.Request.Context(), activeOnly, page)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list banned IPs"})
		return
	}

	// Enrich with geo data from local MMDB (best-effort, never fails the request).
	if len(result.Items) > 0 && h.geo != nil {
		for i := range result.Items {
			country, city := mmdbGeoLookup(h, result.Items[i].IP)
			result.Items[i].Country = country
			result.Items[i].City = city
		}
	}

	c.JSON(http.StatusOK, result)
}

// UnbanIP handles POST /api/v1/admin/banned-ips/:id/unban
func (h *Handler) UnbanIP(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id < 1 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}

	if err := h.queries.UnbanIP(c.Request.Context(), id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "ban record not found or already unbanned"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not unban IP"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "IP marked as unbanned"})
}

// ExtendBan handles POST /api/v1/admin/banned-ips/:id/extend
func (h *Handler) ExtendBan(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id < 1 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}

	if err := h.queries.ExtendBan(c.Request.Context(), id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "ban record not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not extend ban"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "ban extended"})
}

// ── Geo lookup ────────────────────────────────────────────────────────────────

// mmdbGeoLookup resolves a single IP against the local MaxMind GeoLite2 MMDB.
// Returns empty strings for private/unresolvable addresses.
func mmdbGeoLookup(h *Handler, ipStr string) (country, city string) {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return "", ""
	}
	record, err := h.geo.City(ip)
	if err != nil {
		return "", ""
	}
	if name, ok := record.Country.Names["en"]; ok {
		country = name
	}
	if name, ok := record.City.Names["en"]; ok {
		city = name
	}
	return country, city
}
