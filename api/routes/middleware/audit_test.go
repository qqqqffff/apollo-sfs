package middleware

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

type memRecorder struct {
	mu   sync.Mutex
	rows []db.AuditInput
}

func (m *memRecorder) InsertAuditLog(_ context.Context, in db.AuditInput) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rows = append(m.rows, in)
	return nil
}

func (m *memRecorder) wait(t *testing.T, n int) []db.AuditInput {
	t.Helper()
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		m.mu.Lock()
		got := len(m.rows)
		m.mu.Unlock()
		if got >= n {
			break
		}
	}
	time.Sleep(20 * time.Millisecond) // and no more than n
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.rows) != n {
		t.Fatalf("audit rows = %d, want %d: %+v", len(m.rows), n, m.rows)
	}
	return append([]db.AuditInput(nil), m.rows...)
}

func details(t *testing.T, in db.AuditInput) models.RequestFailureDetails {
	var d models.RequestFailureDetails
	if err := json.Unmarshal(in.Details, &d); err != nil {
		t.Fatal(err)
	}
	return d
}

func auditRouter(a *FailureAuditor, user string) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(gin.Recovery(), func(c *gin.Context) {
		if user != "" {
			c.Set("username", user)
		}
		c.Next()
	}, a.Middleware())
	r.POST("/api/v1/files/upload", func(c *gin.Context) {
		SetAuditResource(c, "file", nil, "photo.jpg")
		_ = c.Error(context.DeadlineExceeded)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "upload failed"})
	})
	r.DELETE("/api/v1/files/:file_id", func(c *gin.Context) {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
	})
	r.GET("/api/v1/shares/resolve/:token", func(c *gin.Context) {
		c.JSON(http.StatusForbidden, gin.H{"error": "not yours"})
	})
	r.GET("/ok", func(c *gin.Context) { c.String(http.StatusOK, "fine") })
	r.GET("/boom", func(c *gin.Context) { panic("kaboom") })
	return r
}

func serve(r http.Handler, method, path string) int {
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(method, path, nil))
	return w.Code
}

func TestAuditFailuresRecordsStatusMessageAndCause(t *testing.T) {
	rec := &memRecorder{}
	r := auditRouter(NewFailureAuditor(t.Context(), rec), "zoe")

	if serve(r, "POST", "/api/v1/files/upload") != 500 {
		t.Fatal("handler status not preserved")
	}
	row := rec.wait(t, 1)[0]
	d := details(t, row)
	if row.Action != "file_upload_failed" || row.TargetUsername != "zoe" || *row.ResourceName != "photo.jpg" {
		t.Errorf("row = %+v", row)
	}
	if d.Status != 500 || d.Error != "upload failed" || d.Cause != context.DeadlineExceeded.Error() || d.Route != "/api/v1/files/upload" {
		t.Errorf("details = %+v", d)
	}
}

func TestAuditFailuresUsesResourceParamButNeverTokens(t *testing.T) {
	rec := &memRecorder{}
	r := auditRouter(NewFailureAuditor(t.Context(), rec), "zoe")
	id := uuid.New()
	serve(r, "DELETE", "/api/v1/files/"+id.String())
	serve(r, "GET", "/api/v1/shares/resolve/"+uuid.NewString())
	rows := rec.wait(t, 2)
	byAction := map[string]db.AuditInput{}
	for _, row := range rows {
		byAction[row.Action] = row
	}
	del := byAction["file_delete_failed"]
	if del.ResourceID == nil || *del.ResourceID != id || details(t, del).Status != 404 {
		t.Errorf("delete row = %+v", del)
	}
	tok := byAction["request_failed"]
	if tok.ResourceID != nil || details(t, tok).Route != "/api/v1/shares/resolve/:token" {
		t.Errorf("share token leaked into the audit row: %+v %s", tok, tok.Details)
	}
}

func TestAuditFailuresIgnoresSuccessAndAnonymous(t *testing.T) {
	rec := &memRecorder{}
	serve(auditRouter(NewFailureAuditor(t.Context(), rec), "zoe"), "GET", "/ok")
	serve(auditRouter(NewFailureAuditor(t.Context(), rec), ""), "POST", "/api/v1/files/upload")
	rec.wait(t, 0)
}

func TestAuditFailuresRecordsPanics(t *testing.T) {
	rec := &memRecorder{}
	r := auditRouter(NewFailureAuditor(t.Context(), rec), "zoe")
	if serve(r, "GET", "/boom") != 500 {
		t.Fatal("recovery should still answer 500")
	}
	d := details(t, rec.wait(t, 1)[0])
	if d.Status != 500 || d.Cause != "panic: kaboom" {
		t.Errorf("details = %+v", d)
	}
}

// A client hammering the same failing request produces one entry, then one
// summary carrying the count once the burst is over.
func TestAuditFailuresCoalescesRepeats(t *testing.T) {
	rec := &memRecorder{}
	a := NewFailureAuditor(t.Context(), rec)
	now := time.Unix(1_700_000_000, 0)
	a.now = func() time.Time { return now }
	r := auditRouter(a, "zoe")

	for range 5 {
		serve(r, "POST", "/api/v1/files/upload")
	}
	rec.wait(t, 1)

	now = now.Add(failureCoalesceWindow)
	a.flush()
	rows := rec.wait(t, 2)
	if d := details(t, rows[1]); d.Repeats != 4 {
		t.Errorf("summary repeats = %d, want 4", d.Repeats)
	}

	serve(r, "POST", "/api/v1/files/upload") // a new burst starts a new entry
	rec.wait(t, 3)
}
