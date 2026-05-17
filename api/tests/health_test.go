package tests

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"apollo-sfs.com/api/routes"
)

func TestHealth(t *testing.T) {
	r := newEngine()
	r.GET("/health", routes.Health)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var body map[string]any
	if err := decodeBody(w, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["status"] != "ok" {
		t.Errorf("expected status=ok, got %v", body["status"])
	}
}
