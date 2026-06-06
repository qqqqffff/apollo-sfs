package tests

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes"
	"apollo-sfs.com/api/routes/services"
)

// ── Stub MathGameServicer ─────────────────────────────────────────────────────

type stubMathGameService struct {
	list    []models.MathGameScore
	listErr error
	added   *services.AddInput
	addErr  error
}

func (s *stubMathGameService) Add(_ context.Context, _ uuid.UUID, in services.AddInput) (*models.MathGameScore, error) {
	if s.addErr != nil {
		return nil, s.addErr
	}
	s.added = &in
	return &models.MathGameScore{
		ID:         uuid.New(),
		Score:      in.Score,
		Total:      in.Total,
		DurationMs: in.DurationMs,
		CreatedAt:  time.Now(),
	}, nil
}

func (s *stubMathGameService) List(_ context.Context, _ uuid.UUID) ([]models.MathGameScore, error) {
	if s.list == nil {
		return []models.MathGameScore{}, s.listErr
	}
	return s.list, s.listErr
}

const testUserID = "11111111-1111-1111-1111-111111111111"

func buildMathGameHandler(svc routes.MathGameServicer) *routes.Handler {
	h := routes.NewHandler(&stubQuerier{}, nil, nil, nil, nil, nil, nil, nil, nil, "secret")
	routes.SetMathGameService(h, svc)
	return h
}

func TestSaveMathScore_HappyPath(t *testing.T) {
	svc := &stubMathGameService{}
	h := buildMathGameHandler(svc)

	r := newEngine()
	ginContext(r, testUserID, testUserID, false)
	r.POST("/math-game/scores", h.SaveMathScore)

	body := jsonBody(map[string]any{"score": 7, "total": 10, "duration_ms": 23400})
	req := httptest.NewRequest(http.MethodPost, "/math-game/scores", body)
	req.Header.Set("Content-Type", "application/json")

	w := doRequest(r, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d (body: %s)", w.Code, w.Body.String())
	}
	if svc.added == nil || svc.added.Score != 7 || svc.added.Total != 10 || svc.added.DurationMs != 23400 {
		t.Errorf("service received unexpected input: %+v", svc.added)
	}
}

func TestSaveMathScore_InvalidScore(t *testing.T) {
	svc := &stubMathGameService{addErr: services.ErrInvalidScore}
	h := buildMathGameHandler(svc)

	r := newEngine()
	ginContext(r, testUserID, testUserID, false)
	r.POST("/math-game/scores", h.SaveMathScore)

	body := jsonBody(map[string]any{"score": 99, "total": 10})
	req := httptest.NewRequest(http.MethodPost, "/math-game/scores", body)
	req.Header.Set("Content-Type", "application/json")

	w := doRequest(r, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestSaveMathScore_MissingTotal(t *testing.T) {
	h := buildMathGameHandler(&stubMathGameService{})

	r := newEngine()
	ginContext(r, testUserID, testUserID, false)
	r.POST("/math-game/scores", h.SaveMathScore)

	body := jsonBody(map[string]any{"score": 3})
	req := httptest.NewRequest(http.MethodPost, "/math-game/scores", body)
	req.Header.Set("Content-Type", "application/json")

	w := doRequest(r, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing total, got %d", w.Code)
	}
}

func TestSaveMathScore_NotConfigured(t *testing.T) {
	// No service set → 503.
	h := routes.NewHandler(&stubQuerier{}, nil, nil, nil, nil, nil, nil, nil, nil, "secret")

	r := newEngine()
	ginContext(r, testUserID, testUserID, false)
	r.POST("/math-game/scores", h.SaveMathScore)

	body := jsonBody(map[string]any{"score": 3, "total": 10})
	req := httptest.NewRequest(http.MethodPost, "/math-game/scores", body)
	req.Header.Set("Content-Type", "application/json")

	w := doRequest(r, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when unconfigured, got %d", w.Code)
	}
}

func TestListMathScores_HappyPath(t *testing.T) {
	svc := &stubMathGameService{list: []models.MathGameScore{
		{ID: uuid.New(), Score: 8, Total: 10, DurationMs: 21000, CreatedAt: time.Now()},
		{ID: uuid.New(), Score: 5, Total: 10, DurationMs: 30000, CreatedAt: time.Now()},
	}}
	h := buildMathGameHandler(svc)

	r := newEngine()
	ginContext(r, testUserID, testUserID, false)
	r.GET("/math-game/scores", h.ListMathScores)

	req := httptest.NewRequest(http.MethodGet, "/math-game/scores", nil)
	w := doRequest(r, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body struct {
		Scores []models.MathGameScore `json:"scores"`
	}
	if err := decodeBody(w, &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Scores) != 2 {
		t.Errorf("expected 2 scores, got %d", len(body.Scores))
	}
}
