package tests

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes"
)

// makeInterestRequest returns a POST /interest request with all valid fields.
// plan_id/storage_type match the default captured deposit order the stub
// querier's GetInterestDepositOrder returns (64gb/nvme, $15.00 deposit).
func makeInterestRequest() *http.Request {
	body := jsonBody(map[string]any{
		"name":             "Jane Smith",
		"email":            "jane@example.com",
		"plan_id":          "64gb",
		"storage_type":     "nvme",
		"use_case":         "Personal encrypted backups",
		"captcha_token":    "test-token",
		"deposit_order_id": "order-test-1",
	})
	req := httptest.NewRequest(http.MethodPost, "/interest", body)
	req.Header.Set("Content-Type", "application/json")
	return req
}

// buildInterestHandler creates a handler wired with a captcha stub that always passes.
func buildInterestHandler(q routes.Querier) *routes.Handler {
	h := routes.NewHandler(q, nil, nil, nil, nil, nil, nil, nil, nil, "secret")
	routes.SetVerifyCaptcha(h, func(_, _, _ string) (bool, error) { return true, nil })
	return h
}

func registerInterest(r interface{ POST(string, ...any) }, h *routes.Handler) {
	type poster interface {
		POST(relativePath string, handlers ...any)
	}
}

func TestInterestForm_HappyPath(t *testing.T) {
	q := &stubQuerier{}
	h := buildInterestHandler(q)

	r := newEngine()
	r.POST("/interest", h.SubmitInterestForm)

	w := doRequest(r, makeInterestRequest())
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	if body["message"] == nil {
		t.Errorf("expected message field in response")
	}
}

func TestInterestForm_CaptchaFails(t *testing.T) {
	q := &stubQuerier{}
	h := routes.NewHandler(q, nil, nil, nil, nil, nil, nil, nil, nil, "secret")
	routes.SetVerifyCaptcha(h, func(_, _, _ string) (bool, error) { return false, nil })

	r := newEngine()
	r.POST("/interest", h.SubmitInterestForm)

	w := doRequest(r, makeInterestRequest())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on captcha failure, got %d", w.Code)
	}
}

func TestInterestForm_MissingRequiredFields(t *testing.T) {
	q := &stubQuerier{}
	h := buildInterestHandler(q)

	r := newEngine()
	r.POST("/interest", h.SubmitInterestForm)

	base := map[string]any{
		"name": "Alice", "email": "a@b.com", "plan_id": "64gb", "storage_type": "nvme",
		"use_case": "x", "captcha_token": "t", "deposit_order_id": "order-1",
	}
	withoutKey := func(key string) map[string]any {
		m := map[string]any{}
		for k, v := range base {
			if k != key {
				m[k] = v
			}
		}
		return m
	}
	cases := []map[string]any{
		withoutKey("name"),
		withoutKey("email"),
		withoutKey("plan_id"),
		withoutKey("storage_type"),
		withoutKey("use_case"),
		withoutKey("captcha_token"),
		withoutKey("deposit_order_id"),
	}

	for _, payload := range cases {
		body := jsonBody(payload)
		req := httptest.NewRequest(http.MethodPost, "/interest", body)
		req.Header.Set("Content-Type", "application/json")
		w := doRequest(r, req)
		if w.Code != http.StatusBadRequest {
			t.Errorf("payload %v: expected 400, got %d", payload, w.Code)
		}
	}
}

func TestInterestForm_InvalidEmail(t *testing.T) {
	q := &stubQuerier{}
	h := buildInterestHandler(q)

	r := newEngine()
	r.POST("/interest", h.SubmitInterestForm)

	body := jsonBody(map[string]any{
		"name":             "Jane",
		"email":            "not-an-email",
		"plan_id":          "64gb",
		"storage_type":     "nvme",
		"use_case":         "Testing",
		"captcha_token":    "tok",
		"deposit_order_id": "order-1",
	})
	req := httptest.NewRequest(http.MethodPost, "/interest", body)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid email, got %d", w.Code)
	}
}

func TestInterestForm_DailyCap_SilentSuccess(t *testing.T) {
	q := &stubQuerier{
		interestSettings: &models.InterestFormSettings{DailyCap: 5},
		todayCount:       5, // at cap
	}
	h := buildInterestHandler(q)

	r := newEngine()
	r.POST("/interest", h.SubmitInterestForm)

	w := doRequest(r, makeInterestRequest())
	// Should silently succeed (200) even though cap is reached
	if w.Code != http.StatusOK {
		t.Fatalf("expected silent 200 at daily cap, got %d", w.Code)
	}
}

func TestInterestForm_IPLimit_SilentSuccess(t *testing.T) {
	q := &stubQuerier{
		ipCount: 5, // at limit
	}
	h := buildInterestHandler(q)

	r := newEngine()
	r.POST("/interest", h.SubmitInterestForm)

	w := doRequest(r, makeInterestRequest())
	if w.Code != http.StatusOK {
		t.Fatalf("expected silent 200 at IP limit, got %d", w.Code)
	}
}

func TestInterestForm_DuplicateEmail_SilentSuccess(t *testing.T) {
	q := &stubQuerier{
		emailExists: true, // already submitted
	}
	h := buildInterestHandler(q)

	r := newEngine()
	r.POST("/interest", h.SubmitInterestForm)

	w := doRequest(r, makeInterestRequest())
	if w.Code != http.StatusOK {
		t.Fatalf("expected silent 200 for duplicate email, got %d", w.Code)
	}
}

func TestInterestForm_EmailNormalized(t *testing.T) {
	var savedSub *models.InterestSubmission
	q := &stubQuerier{}
	// Override CreateInterestSubmission to capture what was saved.
	capturingQ := &capturingQuerier{
		stubQuerier: q,
		onCreateSub: func(s *models.InterestSubmission) error {
			savedSub = s
			return nil
		},
	}
	h := buildInterestHandler(capturingQ)

	r := newEngine()
	r.POST("/interest", h.SubmitInterestForm)

	body := jsonBody(map[string]any{
		"name":             "Jane",
		"email":            "JANE@EXAMPLE.COM",
		"plan_id":          "64gb",
		"storage_type":     "nvme",
		"use_case":         "Testing",
		"captcha_token":    "tok",
		"deposit_order_id": "order-1",
	})
	req := httptest.NewRequest(http.MethodPost, "/interest", body)
	req.Header.Set("Content-Type", "application/json")
	doRequest(r, req)

	if savedSub == nil {
		t.Fatal("submission was not saved")
	}
	if savedSub.Email != "jane@example.com" {
		t.Errorf("expected lowercase email, got %q", savedSub.Email)
	}
}

// capturingQuerier wraps stubQuerier and intercepts CreateInterestSubmission.
type capturingQuerier struct {
	*stubQuerier
	onCreateSub func(*models.InterestSubmission) error
}

func (c *capturingQuerier) CreateInterestSubmission(_ context.Context, s *models.InterestSubmission) error {
	if c.onCreateSub != nil {
		return c.onCreateSub(s)
	}
	return nil
}
