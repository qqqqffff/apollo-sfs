package tests

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes"
)

func buildFeedbackHandler(q routes.Querier) *routes.Handler {
	return routes.NewHandler(q, nil, nil, nil, nil, nil, nil, nil, nil, "secret")
}

func feedbackRouter(q routes.Querier) *gin.Engine {
	h := buildFeedbackHandler(q)
	r := newEngine()
	ginContext(r, testUserID, "alice", false)
	r.POST("/feedback", h.SubmitFeedback)
	return r
}

// feedbackAccessGranted returns a user with feedback form access enabled —
// the precondition every non-access-check test below needs, since access is
// disabled by default (see SubmitFeedback).
func feedbackAccessGranted() *models.User {
	return &models.User{Username: "alice", FeedbackAccessEnabled: true}
}

func TestSubmitFeedback_AccessDisabled(t *testing.T) {
	r := feedbackRouter(&stubQuerier{user: &models.User{Username: "alice", FeedbackAccessEnabled: false}})

	req := httptest.NewRequest(http.MethodPost, "/feedback", jsonBody(map[string]any{
		"category": "bug",
		"message":  "hello",
	}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestSubmitFeedback_AccessCheckError(t *testing.T) {
	r := feedbackRouter(&stubQuerier{userErr: errBoom})

	req := httptest.NewRequest(http.MethodPost, "/feedback", jsonBody(map[string]any{
		"category": "bug",
		"message":  "hello",
	}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", w.Code)
	}
}

func TestSubmitFeedback_Success(t *testing.T) {
	r := feedbackRouter(&stubQuerier{user: feedbackAccessGranted()})

	req := httptest.NewRequest(http.MethodPost, "/feedback", jsonBody(map[string]any{
		"category": "bug",
		"message":  "The upload progress bar freezes at 90%.",
	}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d (body: %s)", w.Code, w.Body.String())
	}
	var body models.Feedback
	if err := decodeBody(w, &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Category != "bug" || body.Status != "new" || body.Username != "alice" {
		t.Errorf("unexpected feedback: %+v", body)
	}
}

func TestSubmitFeedback_InvalidCategory(t *testing.T) {
	r := feedbackRouter(&stubQuerier{user: feedbackAccessGranted()})

	req := httptest.NewRequest(http.MethodPost, "/feedback", jsonBody(map[string]any{
		"category": "not_a_category",
		"message":  "hello",
	}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestSubmitFeedback_EmptyMessage(t *testing.T) {
	r := feedbackRouter(&stubQuerier{user: feedbackAccessGranted()})

	req := httptest.NewRequest(http.MethodPost, "/feedback", jsonBody(map[string]any{
		"category": "general",
		"message":  "   ",
	}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestSubmitFeedback_MessageTooLong(t *testing.T) {
	r := feedbackRouter(&stubQuerier{user: feedbackAccessGranted()})

	req := httptest.NewRequest(http.MethodPost, "/feedback", jsonBody(map[string]any{
		"category": "general",
		"message":  strings.Repeat("a", 5001),
	}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestSubmitFeedback_MissingBody(t *testing.T) {
	r := feedbackRouter(&stubQuerier{user: feedbackAccessGranted()})

	req := httptest.NewRequest(http.MethodPost, "/feedback", nil)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestSubmitFeedback_QueryError(t *testing.T) {
	r := feedbackRouter(&stubQuerier{user: feedbackAccessGranted(), createFeedbackErr: errBoom})

	req := httptest.NewRequest(http.MethodPost, "/feedback", jsonBody(map[string]any{
		"category": "feature",
		"message":  "Please add dark mode.",
	}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", w.Code)
	}
}
