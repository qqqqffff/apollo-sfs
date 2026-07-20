package tests

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/models"
)

func feedbackAdminRouter(q *stubAdminQuerier) *gin.Engine {
	h := newAdminHandlerWithFiles(q, &stubFileService{})
	r := newEngine()
	ginContext(r, "00000000-0000-0000-0000-000000000001", "adminuser", true)
	r.GET("/feedback", h.ListFeedback)
	r.PATCH("/feedback/:id/status", h.UpdateFeedbackStatus)
	return r
}

func TestListFeedback_Empty(t *testing.T) {
	r := feedbackAdminRouter(&stubAdminQuerier{})

	req := httptest.NewRequest(http.MethodGet, "/feedback", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	var body map[string]any
	decodeBody(w, &body) //nolint
	items, _ := body["items"].([]any)
	if len(items) != 0 {
		t.Errorf("expected 0 items, got %d", len(items))
	}
}

func TestListFeedback_ReturnsItems(t *testing.T) {
	fb := models.Feedback{Username: "alice", Category: "bug", Message: "broken", Status: "new"}
	q := &stubAdminQuerier{feedback: []models.Feedback{fb}}
	r := feedbackAdminRouter(q)

	req := httptest.NewRequest(http.MethodGet, "/feedback", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	var body map[string]any
	decodeBody(w, &body) //nolint
	items, _ := body["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(items))
	}
	item, _ := items[0].(map[string]any)
	if item["username"] != "alice" {
		t.Errorf("expected username 'alice', got %v", item["username"])
	}
}

func TestListFeedback_InvalidStatus(t *testing.T) {
	r := feedbackAdminRouter(&stubAdminQuerier{})

	req := httptest.NewRequest(http.MethodGet, "/feedback?status=bogus", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestListFeedback_InvalidLimit(t *testing.T) {
	r := feedbackAdminRouter(&stubAdminQuerier{})

	req := httptest.NewRequest(http.MethodGet, "/feedback?limit=bad", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestUpdateFeedbackStatus_Success(t *testing.T) {
	r := feedbackAdminRouter(&stubAdminQuerier{})

	id := "11111111-1111-1111-1111-111111111111"
	req := httptest.NewRequest(http.MethodPatch, "/feedback/"+id+"/status", jsonBody(map[string]any{
		"status": "reviewed",
	}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	var body models.Feedback
	decodeBody(w, &body) //nolint
	if body.Status != "reviewed" {
		t.Errorf("expected status 'reviewed', got %q", body.Status)
	}
}

func TestUpdateFeedbackStatus_InvalidID(t *testing.T) {
	r := feedbackAdminRouter(&stubAdminQuerier{})

	req := httptest.NewRequest(http.MethodPatch, "/feedback/not-a-uuid/status", jsonBody(map[string]any{
		"status": "reviewed",
	}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestUpdateFeedbackStatus_InvalidStatus(t *testing.T) {
	r := feedbackAdminRouter(&stubAdminQuerier{})

	id := "11111111-1111-1111-1111-111111111111"
	req := httptest.NewRequest(http.MethodPatch, "/feedback/"+id+"/status", jsonBody(map[string]any{
		"status": "bogus",
	}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestUpdateFeedbackStatus_NotFound(t *testing.T) {
	r := feedbackAdminRouter(&stubAdminQuerier{updateFeedbackErr: sql.ErrNoRows})

	id := "11111111-1111-1111-1111-111111111111"
	req := httptest.NewRequest(http.MethodPatch, "/feedback/"+id+"/status", jsonBody(map[string]any{
		"status": "archived",
	}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d (body: %s)", w.Code, w.Body.String())
	}
}
