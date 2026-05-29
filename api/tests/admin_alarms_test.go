package tests

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"apollo-sfs.com/api/models"
)

const testAdminUsername = "admin"

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
	// Default row: all email lists are empty arrays
	for _, key := range []string{
		"cpu_usage_emails", "cpu_temp_emails", "drive_temp_emails",
		"drive_load_emails", "network_traffic_emails", "api_error_rate_emails",
	} {
		arr, _ := body[key].([]any)
		if len(arr) != 0 {
			t.Errorf("expected %s to be empty, got %v", key, arr)
		}
	}
}

func TestAdminGetAlarmSettings_WithSubscribers(t *testing.T) {
	q := &stubAdminQuerier{
		alarmSettings: &models.AlarmSettings{
			CPUUsageEmails:       []string{"ops@example.com", "sre@example.com"},
			CPUTempEmails:        []string{},
			DriveTempEmails:      []string{},
			DriveLoadEmails:      []string{},
			NetworkTrafficEmails: []string{},
			APIErrorRateEmails:   []string{},
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
	emails, _ := body["cpu_usage_emails"].([]any)
	if len(emails) != 2 {
		t.Errorf("expected 2 cpu_usage_emails, got %d", len(emails))
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

// ── POST alarm subscribe ──────────────────────────────────────────────────────

func TestAdminToggleAlarmSubscription_Subscribe(t *testing.T) {
	q := &stubAdminQuerier{
		user: &models.User{Username: "admin", Email: "admin@example.com"},
	}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	ginContext(r, "uid-admin", testAdminUsername, true)
	r.POST("/admin/system/alarm/subscribe", h.ToggleAlarmSubscription)

	payload := map[string]any{"alarm_type": "cpu_usage", "subscribed": true}
	req := httptest.NewRequest(http.MethodPost, "/admin/system/alarm/subscribe", jsonBody(payload))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestAdminToggleAlarmSubscription_Unsubscribe(t *testing.T) {
	q := &stubAdminQuerier{
		user: &models.User{Username: "admin", Email: "admin@example.com"},
	}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	ginContext(r, "uid-admin", testAdminUsername, true)
	r.POST("/admin/system/alarm/subscribe", h.ToggleAlarmSubscription)

	payload := map[string]any{"alarm_type": "cpu_usage", "subscribed": false}
	req := httptest.NewRequest(http.MethodPost, "/admin/system/alarm/subscribe", jsonBody(payload))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestAdminToggleAlarmSubscription_MissingAlarmType(t *testing.T) {
	q := &stubAdminQuerier{
		user: &models.User{Username: "admin", Email: "admin@example.com"},
	}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	ginContext(r, "uid-admin", testAdminUsername, true)
	r.POST("/admin/system/alarm/subscribe", h.ToggleAlarmSubscription)

	// alarm_type is required — omitting it should return 400
	payload := map[string]any{"subscribed": true}
	req := httptest.NewRequest(http.MethodPost, "/admin/system/alarm/subscribe", jsonBody(payload))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestAdminToggleAlarmSubscription_UserLookupError(t *testing.T) {
	q := &stubAdminQuerier{
		userErr: errors.New("not found"),
	}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	ginContext(r, "uid-admin", testAdminUsername, true)
	r.POST("/admin/system/alarm/subscribe", h.ToggleAlarmSubscription)

	payload := map[string]any{"alarm_type": "cpu_usage", "subscribed": true}
	req := httptest.NewRequest(http.MethodPost, "/admin/system/alarm/subscribe", jsonBody(payload))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", w.Code)
	}
}

func TestAdminToggleAlarmSubscription_DBError(t *testing.T) {
	q := &stubAdminQuerier{
		user:            &models.User{Username: "admin", Email: "admin@example.com"},
		subscriptionErr: errors.New("db down"),
	}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	ginContext(r, "uid-admin", testAdminUsername, true)
	r.POST("/admin/system/alarm/subscribe", h.ToggleAlarmSubscription)

	payload := map[string]any{"alarm_type": "cpu_usage", "subscribed": true}
	req := httptest.NewRequest(http.MethodPost, "/admin/system/alarm/subscribe", jsonBody(payload))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestAdminToggleAlarmSubscription_AllAlarmTypes(t *testing.T) {
	alarmTypes := []string{
		"cpu_usage", "cpu_temp", "drive_temp",
		"drive_load", "network_traffic", "api_error_rate",
	}
	for _, at := range alarmTypes {
		t.Run(at, func(t *testing.T) {
			q := &stubAdminQuerier{
				user: &models.User{Username: "admin", Email: "admin@example.com"},
			}
			h := newAdminHandler(q, &stubAdminInviteService{})

			r := newEngine()
			ginContext(r, "uid-admin", testAdminUsername, true)
			r.POST("/admin/system/alarm/subscribe", h.ToggleAlarmSubscription)

			payload := map[string]any{"alarm_type": at, "subscribed": true}
			req := httptest.NewRequest(http.MethodPost, "/admin/system/alarm/subscribe", jsonBody(payload))
			req.Header.Set("Content-Type", "application/json")
			w := doRequest(r, req)

			if w.Code != http.StatusOK {
				t.Errorf("alarm type %q: expected 200, got %d (body: %s)", at, w.Code, w.Body.String())
			}
		})
	}
}
