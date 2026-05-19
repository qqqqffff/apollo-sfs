package admin

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"apollo-sfs.com/api/db"
)

var wsUpgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// Origin validation is handled by Nginx; inside Docker all traffic is trusted.
	CheckOrigin: func(r *http.Request) bool { return true },
}

const (
	wsWriteTimeout = 10 * time.Second
	wsPingInterval = 30 * time.Second
	wsSeedLimit    = 60 // last 60 snapshots (~5 minutes) sent on connect to seed the graph
)

// GetMetrics handles GET /api/v1/admin/system/metrics.
// Returns the most recently sampled snapshot.
func (h *Handler) GetMetrics(c *gin.Context) {
	snap, err := h.metrics.GetLatest(c.Request.Context())
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "no metrics collected yet"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve metrics"})
		return
	}
	c.JSON(http.StatusOK, snap)
}

// GetMetricsHistory handles GET /api/v1/admin/system/metrics/history.
// Supports ?cursor (time-based token) and ?limit for pagination.
// Pass ?date=mm-dd-yyyy to scope results to a single calendar day.
func (h *Handler) GetMetricsHistory(c *gin.Context) {
	page := db.PageInput{
		Cursor: strings.TrimSpace(c.Query("cursor")),
	}
	if err := parseLimit(c, &page.Limit); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "limit must be a positive integer"})
		return
	}

	if hoursStr := c.Query("hours"); hoursStr != "" {
		hours, err := strconv.Atoi(hoursStr)
		if err != nil || hours <= 0 || hours > 72 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "hours must be a positive integer ≤ 72"})
			return
		}
		snaps, err := h.metrics.GetHistoryByHours(c.Request.Context(), hours)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve metrics history"})
			return
		}
		c.JSON(http.StatusOK, snaps)
		return
	}

	if date := c.Query("date"); date != "" {
		result, err := h.metrics.GetHistoryByDate(c.Request.Context(), date, page)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, result)
		return
	}

	result, err := h.metrics.GetHistory(c.Request.Context(), page)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve metrics history"})
		return
	}
	c.JSON(http.StatusOK, result)
}

// StreamMetrics handles GET /api/v1/admin/system/metrics/stream.
// Upgrades the connection to WebSocket, sends the last 60 snapshots as seed
// data (oldest first so the frontend can append chronologically), then streams
// live snapshots as JSON text frames until the client disconnects.
func (h *Handler) StreamMetrics(c *gin.Context) {
	conn, err := wsUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("StreamMetrics: upgrade: %v", err)
		return
	}
	defer conn.Close()

	// Seed: send recent history so the graph is populated immediately on connect.
	seed, err := h.metrics.GetHistory(c.Request.Context(), db.PageInput{Limit: wsSeedLimit})
	if err == nil && len(seed.Items) > 0 {
		for i := len(seed.Items) - 1; i >= 0; i-- {
			if err := wsWriteJSON(conn, seed.Items[i]); err != nil {
				return
			}
		}
	}

	// Register with the hub for live broadcasts.
	hub := h.metrics.Hub()
	ch := hub.Subscribe()
	defer hub.Unsubscribe(ch)

	// Read pump: detect client-side close frames without blocking the write pump.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	// Write pump: forward hub messages and send keepalive pings.
	ping := time.NewTicker(wsPingInterval)
	defer ping.Stop()

	for {
		select {
		case <-done:
			return

		case msg, ok := <-ch:
			if !ok {
				return
			}
			conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout)) //nolint:errcheck
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}

		case <-ping.C:
			conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout)) //nolint:errcheck
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// PingServer handles GET /api/v1/admin/system/ping.
// Returns 204 immediately so the client can measure round-trip latency.
func (h *Handler) PingServer(c *gin.Context) {
	c.Status(http.StatusNoContent)
}

// wsWriteJSON serialises v to JSON and sends it as a single WebSocket text frame.
func wsWriteJSON(conn *websocket.Conn, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout)) //nolint:errcheck
	return conn.WriteMessage(websocket.TextMessage, b)
}
