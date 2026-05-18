package tests

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"apollo-sfs.com/api/models"
)

// ── GET alarm settings ────────────────────────────────────────────────────────

func TestAdminGetAlarmSettings_Defaults(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.GET("/admin/system/alarm/settings", h.GetAlarmSettings)

	req := httptest.NewRequest(http.MethodGet, "/admin/system/alarm/settings", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	// Default row: all toggles false
	for _, key := range []string{
		"cpu_usage_enabled", "cpu_temp_enabled", "drive_temp_enabled",
		"drive_load_enabled", "network_traffic_enabled", "api_error_rate_enabled",
	} {
		if body[key] != false {
			t.Errorf("expected %s=false, got %v", key, body[key])
		}
	}
}

func TestAdminGetAlarmSettings_WithData(t *testing.T) {
	q := &stubAdminQuerier{
		alarmSettings: &models.AlarmSettings{
			NotifyEmails:    []string{"ops@example.com", "sre@example.com"},
			CPUUsageEnabled: true,
			CPUTempEnabled:  false,
		},
	}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	r.GET("/admin/system/alarm/settings", h.GetAlarmSettings)

	req := httptest.NewRequest(http.MethodGet, "/admin/system/alarm/settings", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	if body["cpu_usage_enabled"] != true {
		t.Errorf("expected cpu_usage_enabled=true, got %v", body["cpu_usage_enabled"])
	}
	emails, _ := body["notify_emails"].([]any)
	if len(emails) != 2 {
		t.Errorf("expected 2 notify_emails, got %d", len(emails))
	}
}

func TestAdminGetAlarmSettings_DBError(t *testing.T) {
	q := &stubAdminQuerier{alarmSettingsErr: errors.New("db down")}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	r.GET("/admin/system/alarm/settings", h.GetAlarmSettings)

	req := httptest.NewRequest(http.MethodGet, "/admin/system/alarm/settings", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", w.Code)
	}
}

// ── PUT alarm settings ────────────────────────────────────────────────────────

func TestAdminUpdateAlarmSettings_AllToggles(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.PUT("/admin/system/alarm/settings", h.UpdateAlarmSettings)

	payload := map[string]any{
		"notify_emails":           []string{"admin@example.com"},
		"cpu_usage_enabled":       true,
		"cpu_temp_enabled":        true,
		"drive_temp_enabled":      true,
		"drive_load_enabled":      true,
		"network_traffic_enabled": true,
		"api_error_rate_enabled":  true,
	}
	req := httptest.NewRequest(http.MethodPut, "/admin/system/alarm/settings", jsonBody(payload))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	for _, key := range []string{
		"cpu_usage_enabled", "cpu_temp_enabled", "drive_temp_enabled",
		"drive_load_enabled", "network_traffic_enabled", "api_error_rate_enabled",
	} {
		if body[key] != true {
			t.Errorf("expected %s=true in response, got %v", key, body[key])
		}
	}
	emails, _ := body["notify_emails"].([]any)
	if len(emails) != 1 {
		t.Errorf("expected 1 notify_email in response, got %d", len(emails))
	}
}

func TestAdminUpdateAlarmSettings_AllDisabled(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.PUT("/admin/system/alarm/settings", h.UpdateAlarmSettings)

	payload := map[string]any{
		"notify_emails":           []string{},
		"cpu_usage_enabled":       false,
		"cpu_temp_enabled":        false,
		"drive_temp_enabled":      false,
		"drive_load_enabled":      false,
		"network_traffic_enabled": false,
		"api_error_rate_enabled":  false,
	}
	req := httptest.NewRequest(http.MethodPut, "/admin/system/alarm/settings", jsonBody(payload))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestAdminUpdateAlarmSettings_NilEmailsDefaultsToEmpty(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.PUT("/admin/system/alarm/settings", h.UpdateAlarmSettings)

	// Omit notify_emails entirely; handler should default it to [].
	payload := map[string]any{"cpu_usage_enabled": true}
	req := httptest.NewRequest(http.MethodPut, "/admin/system/alarm/settings", jsonBody(payload))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestAdminUpdateAlarmSettings_InvalidBody(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.PUT("/admin/system/alarm/settings", h.UpdateAlarmSettings)

	req := httptest.NewRequest(http.MethodPut, "/admin/system/alarm/settings", jsonBody("not-an-object"))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestAdminUpdateAlarmSettings_DBError(t *testing.T) {
	q := &stubAdminQuerier{updatedAlarmSettingsErr: errors.New("db down")}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	r.PUT("/admin/system/alarm/settings", h.UpdateAlarmSettings)

	payload := map[string]any{"cpu_usage_enabled": false}
	req := httptest.NewRequest(http.MethodPut, "/admin/system/alarm/settings", jsonBody(payload))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", w.Code)
	}
}

func TestAdminUpdateAlarmSettings_MultipleEmails(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.PUT("/admin/system/alarm/settings", h.UpdateAlarmSettings)

	emails := []string{"a@example.com", "b@example.com", "c@example.com"}
	payload := map[string]any{"notify_emails": emails}
	req := httptest.NewRequest(http.MethodPut, "/admin/system/alarm/settings", jsonBody(payload))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	got, _ := body["notify_emails"].([]any)
	if len(got) != 3 {
		t.Errorf("expected 3 notify_emails in response, got %d", len(got))
	}
}
