package middleware

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// ── Failed-request audit trail ───────────────────────────────────────────────
//
// AuditFailures records every request a known user made that ended in a 4xx or
// 5xx in that user's audit log, so an admin looking at "uploads keep failing"
// sees which ones, with what status and message, instead of only the
// successes. Rows go through the same audit_logs table as everything else.

// AuditRecorder persists one audit row (*db.Queries).
type AuditRecorder interface {
	InsertAuditLog(ctx context.Context, in db.AuditInput) error
}

const (
	ctxAuditUser     = "auditUser"
	ctxAuditResource = "auditResource"
)

type auditResource struct {
	kind string
	id   *uuid.UUID
	name string
}

// SetAuditUser attributes the request to username for AuditFailures. Only
// needed where no session sets "username": presigned and WebDAV requests.
func SetAuditUser(c *gin.Context, username string) { c.Set(ctxAuditUser, username) }

// SetAuditResource names what the request was acting on, so a failure entry
// says "photo.jpg" rather than just the route.
func SetAuditResource(c *gin.Context, kind string, id *uuid.UUID, name string) {
	c.Set(ctxAuditResource, auditResource{kind: kind, id: id, name: name})
}

// failureActions names the audit action for failures on routes worth telling
// apart; anything else is "request_failed". Keyed by METHOD + c.FullPath().
var failureActions = map[string]string{
	"POST /api/v1/files/upload":                        "file_upload_failed",
	"POST /api/v1/files/upload/p":                      "file_upload_failed",
	"POST /api/v1/files/upload/presign":                "file_upload_failed",
	"POST /api/v1/files/upload/init":                   "file_upload_failed",
	"POST /api/v1/files/upload/presign/init":           "file_upload_failed",
	"POST /api/v1/files/upload/:upload_id/chunk":       "file_upload_failed",
	"POST /api/v1/files/upload/:upload_id/chunk/p":     "file_upload_failed",
	"POST /api/v1/files/upload/:upload_id/complete":    "file_upload_failed",
	"POST /api/v1/files/upload/:upload_id/complete/p":  "file_upload_failed",
	"POST /api/v1/shares/:share_id/upload":             "file_upload_failed",
	"PATCH /api/v1/files/:file_id":                     "file_rename_failed",
	"PATCH /api/v1/files/:file_id/move":                "file_move_failed",
	"DELETE /api/v1/files/:file_id":                    "file_delete_failed",
	"GET /api/v1/files/:file_id/download":              "file_download_failed",
	"GET /api/v1/files/:file_id/download/p":            "file_download_failed",
	"GET /api/v1/files/:file_id/preview":               "file_download_failed",
	"GET /api/v1/files/:file_id/preview/p":             "file_download_failed",
	"GET /api/v1/files/:file_id/stream":                "file_download_failed",
	"POST /api/v1/folders":                             "folder_create_failed",
	"PATCH /api/v1/folders/:folder_id":                 "folder_rename_failed",
	"PATCH /api/v1/folders/:folder_id/move":            "folder_move_failed",
	"DELETE /api/v1/folders/:folder_id":                "folder_delete_failed",
	"POST /api/v1/folders/:folder_id/drive-migrations": "folder_drive_migration_failed",
}

// resourceParams are path parameters that identify the thing acted on. Other
// parameters are deliberately ignored: several (share/invite/DAV tokens) are
// credentials and must not end up in the log.
var resourceParams = []struct{ param, kind string }{
	{"file_id", "file"}, {"folder_id", "folder"}, {"upload_id", "upload"},
	{"share_id", "share"}, {"collection_id", "folder"},
}

// Repeated identical failures (same user, route, status, resource) inside this
// window are folded into one entry with a repeat count, so a client retrying
// in a loop or a backup hitting the rate limit doesn't write thousands of rows.
const failureCoalesceWindow = time.Minute

const maxErrorBody = 2048

// FailureAuditor is the middleware's state: the recorder and the coalescing
// window. One per process; see NewFailureAuditor.
type FailureAuditor struct {
	rec AuditRecorder
	now func() time.Time

	mu      sync.Mutex
	pending map[string]*coalesced
}

type coalesced struct {
	first   db.AuditInput // the entry that was written
	details models.RequestFailureDetails
	written time.Time
	repeats int // folded since `written`
}

// NewFailureAuditor builds the auditor and starts its flush loop, which writes
// the repeat count of a coalesced burst once the burst is over.
func NewFailureAuditor(ctx context.Context, rec AuditRecorder) *FailureAuditor {
	a := &FailureAuditor{rec: rec, now: time.Now, pending: map[string]*coalesced{}}
	go func() {
		t := time.NewTicker(failureCoalesceWindow / 2)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				a.flush()
			}
		}
	}()
	return a
}

// Middleware records failed requests. Place it after authentication (so the
// user is known) and before rate limiting (so 429s are seen).
func (a *FailureAuditor) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := a.now()
		bw := &bodyCaptureWriter{ResponseWriter: c.Writer}
		c.Writer = bw
		defer func() {
			if p := recover(); p != nil {
				// gin.Recovery (outermost) turns this into the 500 response.
				a.record(c, http.StatusInternalServerError, nil, fmt.Sprintf("panic: %v", p), start)
				panic(p)
			}
			if status := bw.Status(); status >= 400 {
				a.record(c, status, bw.body, "", start)
			}
		}()
		c.Next()
	}
}

func (a *FailureAuditor) record(c *gin.Context, status int, body []byte, cause string, start time.Time) {
	user := c.GetString(ctxAuditUser)
	if user == "" {
		user = c.GetString("username")
	}
	if user == "" {
		if u, ok := c.Get(CtxAPIKeyUser); ok {
			if m, ok := u.(*models.User); ok && m != nil {
				user = m.Username
			}
		}
	}
	if user == "" {
		return // unauthenticated: nobody's audit log to put it in
	}

	route := c.FullPath()
	if route == "" {
		route = "(unmatched)"
	}
	action := failureActions[c.Request.Method+" "+route]
	switch {
	case action != "":
	case strings.HasPrefix(route, "/api/v1/sfs/"):
		action = "sfs_request_failed"
	case strings.HasPrefix(route, "/dav/"):
		action = "dav_request_failed"
	default:
		action = "request_failed"
	}

	d := models.RequestFailureDetails{
		Status:     status,
		Method:     c.Request.Method,
		Route:      route,
		Error:      errorMessage(body),
		DurationMS: models.Millis(a.now().Sub(start)),
	}
	if status >= 500 {
		if cause != "" {
			d.Cause = cause
		} else if last := c.Errors.Last(); last != nil {
			d.Cause = truncate(last.Error(), 500)
		}
	}

	in := db.AuditInput{TargetUsername: user, ActorUsername: user, Action: action}
	if r, ok := c.Get(ctxAuditResource); ok {
		res := r.(auditResource)
		in.ResourceType, in.ResourceID = &res.kind, res.id
		if res.name != "" {
			in.ResourceName = &res.name
		}
	}
	if in.ResourceID == nil {
		for _, p := range resourceParams {
			if id, err := uuid.Parse(c.Param(p.param)); err == nil {
				kind := p.kind
				in.ResourceType, in.ResourceID = &kind, &id
				break
			}
		}
	}

	key := fmt.Sprintf("%s|%s %s|%d|%v|%s", user, d.Method, route, status, in.ResourceID, ptrStr(in.ResourceName))
	now := a.now()
	a.mu.Lock()
	if p, ok := a.pending[key]; ok && now.Sub(p.written) < failureCoalesceWindow {
		p.repeats++
		a.mu.Unlock()
		return
	}
	a.pending[key] = &coalesced{first: in, details: d, written: now}
	a.mu.Unlock()
	a.write(in, d)
}

// flush writes one summary entry for each burst whose window has closed, then
// forgets it, so the next failure starts a fresh entry.
func (a *FailureAuditor) flush() {
	now := a.now()
	var out []*coalesced
	a.mu.Lock()
	for k, p := range a.pending {
		if now.Sub(p.written) >= failureCoalesceWindow {
			if p.repeats > 0 {
				out = append(out, p)
			}
			delete(a.pending, k)
		}
	}
	a.mu.Unlock()
	for _, p := range out {
		d := p.details
		d.Repeats = p.repeats
		a.write(p.first, d)
	}
}

func (a *FailureAuditor) write(in db.AuditInput, d models.RequestFailureDetails) {
	in.Details, _ = json.Marshal(d)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := a.rec.InsertAuditLog(ctx, in); err != nil {
			log.Printf("audit failure entry: %v", err)
		}
	}()
}

// errorMessage pulls a human-readable message out of an error response: the
// {"error": "..."} JSON every handler here uses, or a plain-text body (WebDAV).
func errorMessage(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	var j struct {
		Error  string `json:"error"`
		Detail string `json:"detail"`
	}
	if json.Unmarshal(body, &j) == nil {
		if j.Detail != "" && j.Error != "" {
			return truncate(j.Error+": "+j.Detail, 300)
		}
		return truncate(j.Error, 300)
	}
	if strings.HasPrefix(strings.TrimSpace(string(body)), "<") {
		return "" // HTML/XML, not a message
	}
	return truncate(strings.TrimSpace(string(body)), 300)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func ptrStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// bodyCaptureWriter keeps the first bytes of an error response body. Success
// bodies (downloads, streams) pass straight through untouched.
type bodyCaptureWriter struct {
	gin.ResponseWriter
	body []byte
}

func (w *bodyCaptureWriter) capture(b []byte) {
	if w.Status() >= 400 && len(w.body) < maxErrorBody {
		w.body = append(w.body, b[:min(len(b), maxErrorBody-len(w.body))]...)
	}
}

func (w *bodyCaptureWriter) Write(b []byte) (int, error) {
	w.capture(b)
	return w.ResponseWriter.Write(b)
}

func (w *bodyCaptureWriter) WriteString(s string) (int, error) {
	w.capture([]byte(s))
	return w.ResponseWriter.WriteString(s)
}
