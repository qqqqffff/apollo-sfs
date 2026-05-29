package tests

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newDriveTempsHandler() interface{ ServeHTTP(http.ResponseWriter, *http.Request) } {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})
	r := newEngine()
	r.GET("/admin/system/drive-temps", h.GetDriveTemps)
	return r
}

// ── Status and shape ──────────────────────────────────────────────────────────

func TestGetDriveTemps_AlwaysReturns200(t *testing.T) {
	r := newDriveTempsHandler()
	req := httptest.NewRequest(http.MethodGet, "/admin/system/drive-temps", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestGetDriveTemps_ResponseIsArray(t *testing.T) {
	r := newDriveTempsHandler()
	req := httptest.NewRequest(http.MethodGet, "/admin/system/drive-temps", nil)
	w := doRequest(r, req)

	var body []json.RawMessage
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("response is not a JSON array: %v (raw: %s)", err, w.Body.String())
	}
	// body may be empty on a headless test machine with no drive sensors — that is fine
}

func TestGetDriveTemps_NeverReturnsNull(t *testing.T) {
	r := newDriveTempsHandler()
	req := httptest.NewRequest(http.MethodGet, "/admin/system/drive-temps", nil)
	w := doRequest(r, req)

	raw := w.Body.String()
	if raw == "null\n" || raw == "null" {
		t.Fatal("response must be a JSON array, not null")
	}
}

func TestGetDriveTemps_ItemsHaveRequiredFields(t *testing.T) {
	r := newDriveTempsHandler()
	req := httptest.NewRequest(http.MethodGet, "/admin/system/drive-temps", nil)
	w := doRequest(r, req)

	var items []map[string]any
	if err := json.NewDecoder(w.Body).Decode(&items); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	for i, item := range items {
		name, hasName := item["name"]
		if !hasName {
			t.Errorf("item %d missing 'name' field", i)
		}
		if _, ok := name.(string); !ok {
			t.Errorf("item %d 'name' is not a string, got %T", i, name)
		}

		temp, hasTemp := item["temp_celsius"]
		if !hasTemp {
			t.Errorf("item %d missing 'temp_celsius' field", i)
		}
		if _, ok := temp.(float64); !ok {
			t.Errorf("item %d 'temp_celsius' is not a number, got %T", i, temp)
		}
	}
}

func TestGetDriveTemps_PositiveTempsOnly(t *testing.T) {
	r := newDriveTempsHandler()
	req := httptest.NewRequest(http.MethodGet, "/admin/system/drive-temps", nil)
	w := doRequest(r, req)

	var items []map[string]any
	if err := json.NewDecoder(w.Body).Decode(&items); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	for i, item := range items {
		temp, _ := item["temp_celsius"].(float64)
		if temp <= 0 {
			t.Errorf("item %d has non-positive temp_celsius=%v (handler should filter these out)", i, temp)
		}
	}
}

func TestGetDriveTemps_ContentTypeJSON(t *testing.T) {
	r := newDriveTempsHandler()
	req := httptest.NewRequest(http.MethodGet, "/admin/system/drive-temps", nil)
	w := doRequest(r, req)

	ct := w.Header().Get("Content-Type")
	if ct == "" {
		t.Fatal("expected Content-Type header to be set")
	}
	// Gin sets "application/json; charset=utf-8"
	if len(ct) < len("application/json") || ct[:len("application/json")] != "application/json" {
		t.Errorf("expected Content-Type to start with application/json, got %s", ct)
	}
}
