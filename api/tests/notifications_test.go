package tests

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

var errBoom = errors.New("boom")

func sampleExpansionRequest(status string) models.ServerExpansionRequest {
	return models.ServerExpansionRequest{
		ID:             uuid.New(),
		Username:       "alice",
		ServerID:       uuid.New(),
		StorageType:    "hdd",
		BytesRequested: 1 << 30,
		FullPriceCents: 1000,
		// Deposit covers the full price so "expanded" status yields exactly one
		// notification item (capacity_provisioned), not a second
		// payment_required item for a nonexistent remaining balance.
		DepositAmountCents: 1000,
		Status:             status,
		CreatedAt:          time.Now(),
		ServerName:         "server-1",
	}
}

func TestNotifications_FiltersDismissedItems(t *testing.T) {
	req := sampleExpansionRequest("expanded")
	q := &stubQuerier{expansionRequests: []models.ServerExpansionRequest{req}}
	h := newRoutesHandler(q, nil)

	r := newEngine()
	ginContext(r, "user-uuid-123", "alice", false)
	r.GET("/me/notifications", h.Notifications)

	// First: undismissed, the provisioned-capacity item should be present.
	w := doRequest(r, httptest.NewRequest(http.MethodGet, "/me/notifications", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	var body struct {
		Items []map[string]any `json:"items"`
	}
	if err := decodeBody(w, &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Items) != 1 {
		t.Fatalf("expected 1 item before dismissal, got %d", len(body.Items))
	}
	id := body.Items[0]["id"].(string)

	// Now mark it dismissed and confirm it's filtered out.
	q.dismissedIDs = map[string]bool{id: true}
	w = doRequest(r, httptest.NewRequest(http.MethodGet, "/me/notifications", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	body.Items = nil
	if err := decodeBody(w, &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Items) != 0 {
		t.Fatalf("expected dismissed item to be filtered out, got %d items", len(body.Items))
	}
}

func TestNotifications_DismissedLookupError_Returns500(t *testing.T) {
	req := sampleExpansionRequest("expanded")
	q := &stubQuerier{expansionRequests: []models.ServerExpansionRequest{req}, dismissedIDsErr: errBoom}
	h := newRoutesHandler(q, nil)

	r := newEngine()
	ginContext(r, "user-uuid-123", "alice", false)
	r.GET("/me/notifications", h.Notifications)

	w := doRequest(r, httptest.NewRequest(http.MethodGet, "/me/notifications", nil))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", w.Code)
	}
}

func TestDismissNotifications_PersistsIDs(t *testing.T) {
	q := &stubQuerier{}
	h := newRoutesHandler(q, nil)

	r := newEngine()
	ginContext(r, "user-uuid-123", "alice", false)
	r.POST("/me/notifications/dismiss", h.DismissNotifications)

	payload, _ := json.Marshal(map[string]any{"ids": []string{"abc:share", "def:email-received"}})
	w := doRequest(r, httptest.NewRequest(http.MethodPost, "/me/notifications/dismiss", bytes.NewReader(payload)))

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	if len(q.dismissedCalls) != 1 || len(q.dismissedCalls[0]) != 2 {
		t.Fatalf("expected DismissNotifications called with 2 ids, got %v", q.dismissedCalls)
	}
}

func TestDismissNotifications_EmptyIDs_Returns400(t *testing.T) {
	q := &stubQuerier{}
	h := newRoutesHandler(q, nil)

	r := newEngine()
	ginContext(r, "user-uuid-123", "alice", false)
	r.POST("/me/notifications/dismiss", h.DismissNotifications)

	payload, _ := json.Marshal(map[string]any{"ids": []string{}})
	w := doRequest(r, httptest.NewRequest(http.MethodPost, "/me/notifications/dismiss", bytes.NewReader(payload)))

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty ids, got %d", w.Code)
	}
	if len(q.dismissedCalls) != 0 {
		t.Fatalf("expected no DismissNotifications call, got %v", q.dismissedCalls)
	}
}
