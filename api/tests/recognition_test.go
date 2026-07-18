package tests

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes"
	"apollo-sfs.com/api/routes/services"
)

// stubRecognitionService implements routes.RecognitionServicer.
type stubRecognitionService struct {
	available bool

	status    *services.RecognitionStatus
	statusErr error

	setEnabledErr error
	enqueued      int
	freed         int64
	gotEnabled    bool
	gotPurge      bool

	groups    []models.RecognitionGroup
	groupsErr error
	gotKind   string
	gotLabeled bool

	files    *db.PageResult[models.File]
	filesErr error

	labeled  *models.RecognitionGroup
	labelErr error
	gotLabel string

	merged     *models.RecognitionGroup
	mergeErr   error
	gotSources []uuid.UUID

	deleteErr error

	thumb    []byte
	thumbErr error
}

func (s *stubRecognitionService) Available() bool { return s.available }

func (s *stubRecognitionService) SetEnabled(_ context.Context, _ uuid.UUID, _ string, _ uuid.UUID, enabled, purge bool) (int, int64, error) {
	s.gotEnabled, s.gotPurge = enabled, purge
	return s.enqueued, s.freed, s.setEnabledErr
}

func (s *stubRecognitionService) Status(_ context.Context, _ uuid.UUID, _ uuid.UUID) (*services.RecognitionStatus, error) {
	return s.status, s.statusErr
}

func (s *stubRecognitionService) ListGroups(_ context.Context, _ uuid.UUID, _ uuid.UUID, kind string, labeled bool) ([]models.RecognitionGroup, error) {
	s.gotKind, s.gotLabeled = kind, labeled
	return s.groups, s.groupsErr
}

func (s *stubRecognitionService) GroupFiles(_ context.Context, _ uuid.UUID, _ uuid.UUID, _ db.PageInput) (*db.PageResult[models.File], error) {
	return s.files, s.filesErr
}

func (s *stubRecognitionService) LabelGroup(_ context.Context, _ uuid.UUID, _ string, _ uuid.UUID, label string) (*models.RecognitionGroup, error) {
	s.gotLabel = label
	return s.labeled, s.labelErr
}

func (s *stubRecognitionService) MergeGroups(_ context.Context, _ uuid.UUID, _ string, _ uuid.UUID, sources []uuid.UUID) (*models.RecognitionGroup, error) {
	s.gotSources = sources
	return s.merged, s.mergeErr
}

func (s *stubRecognitionService) DeleteGroup(_ context.Context, _ uuid.UUID, _ string, _ uuid.UUID) error {
	return s.deleteErr
}

func (s *stubRecognitionService) DetectionThumb(_ context.Context, _ uuid.UUID, _ string, _ uuid.UUID) ([]byte, error) {
	return s.thumb, s.thumbErr
}

func (s *stubRecognitionService) EnqueueFileIfEnabled(_ context.Context, _ *models.File, _, _ string) {
}

func newRecognitionHandler(svc routes.RecognitionServicer, q routes.Querier) *routes.Handler {
	if q == nil {
		q = &stubQuerier{}
	}
	h := routes.NewHandler(q, nil, nil, nil, nil, nil, nil, nil, nil, "test-secret")
	if svc != nil {
		routes.SetRecognitionService(h, svc)
	}
	return h
}

// ── Availability gate ───────────────────────────────────────────────────────

func TestRecognition_Unconfigured503(t *testing.T) {
	// No service installed at all → every endpoint degrades to 503.
	h := newRecognitionHandler(nil, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.GET("/collections/:collection_id/recognition", h.GetCollectionRecognition)

	req := httptest.NewRequest(http.MethodGet, "/collections/"+uuid.New().String()+"/recognition", nil)
	w := doRequest(r, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", w.Code)
	}
}

func TestRecognition_SidecarDown503(t *testing.T) {
	h := newRecognitionHandler(&stubRecognitionService{available: false}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PUT("/collections/:collection_id/recognition", h.SetCollectionRecognition)

	req := httptest.NewRequest(http.MethodPut, "/collections/"+uuid.New().String()+"/recognition",
		bytes.NewBufferString(`{"enabled":true}`))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", w.Code)
	}
}

// ── Status ──────────────────────────────────────────────────────────────────

func TestGetCollectionRecognition_InvalidUUID(t *testing.T) {
	h := newRecognitionHandler(&stubRecognitionService{available: true}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.GET("/collections/:collection_id/recognition", h.GetCollectionRecognition)

	req := httptest.NewRequest(http.MethodGet, "/collections/not-a-uuid/recognition", nil)
	if w := doRequest(r, req); w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestGetCollectionRecognition_NotFound(t *testing.T) {
	h := newRecognitionHandler(&stubRecognitionService{available: true, statusErr: services.ErrFolderNotFound}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.GET("/collections/:collection_id/recognition", h.GetCollectionRecognition)

	req := httptest.NewRequest(http.MethodGet, "/collections/"+uuid.New().String()+"/recognition", nil)
	if w := doRequest(r, req); w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestGetCollectionRecognition_Success(t *testing.T) {
	svc := &stubRecognitionService{
		available: true,
		status: &services.RecognitionStatus{
			Enabled:          true,
			ServiceAvailable: true,
			Counts:           db.RecognitionJobCounts{Pending: 3, Done: 7},
			Groups:           db.RecognitionGroupCounts{Face: 2, Pet: 1, Object: 4},
			StorageBytes:     12345,
		},
	}
	h := newRecognitionHandler(svc, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.GET("/collections/:collection_id/recognition", h.GetCollectionRecognition)

	req := httptest.NewRequest(http.MethodGet, "/collections/"+uuid.New().String()+"/recognition", nil)
	w := doRequest(r, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var body services.RecognitionStatus
	if err := decodeBody(w, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if !body.Enabled || body.StorageBytes != 12345 || body.Counts.Pending != 3 || body.Groups.Object != 4 {
		t.Fatalf("unexpected status payload: %+v", body)
	}
}

// ── Toggle ──────────────────────────────────────────────────────────────────

func TestSetCollectionRecognition_BadBody(t *testing.T) {
	h := newRecognitionHandler(&stubRecognitionService{available: true}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PUT("/collections/:collection_id/recognition", h.SetCollectionRecognition)

	req := httptest.NewRequest(http.MethodPut, "/collections/"+uuid.New().String()+"/recognition",
		bytes.NewBufferString(`{not json`))
	req.Header.Set("Content-Type", "application/json")
	if w := doRequest(r, req); w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestSetCollectionRecognition_NotMediaCollection(t *testing.T) {
	h := newRecognitionHandler(&stubRecognitionService{available: true, setEnabledErr: services.ErrNotMediaCollection}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PUT("/collections/:collection_id/recognition", h.SetCollectionRecognition)

	req := httptest.NewRequest(http.MethodPut, "/collections/"+uuid.New().String()+"/recognition",
		bytes.NewBufferString(`{"enabled":true}`))
	req.Header.Set("Content-Type", "application/json")
	if w := doRequest(r, req); w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestSetCollectionRecognition_EnableSuccess(t *testing.T) {
	svc := &stubRecognitionService{available: true, enqueued: 42}
	h := newRecognitionHandler(svc, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PUT("/collections/:collection_id/recognition", h.SetCollectionRecognition)

	req := httptest.NewRequest(http.MethodPut, "/collections/"+uuid.New().String()+"/recognition",
		bytes.NewBufferString(`{"enabled":true}`))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var body map[string]any
	if err := decodeBody(w, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["files_enqueued"].(float64) != 42 || body["enabled"] != true {
		t.Fatalf("unexpected payload: %v", body)
	}
	if !svc.gotEnabled || svc.gotPurge {
		t.Fatalf("service saw enabled=%v purge=%v", svc.gotEnabled, svc.gotPurge)
	}
}

func TestSetCollectionRecognition_DisableWithPurge(t *testing.T) {
	svc := &stubRecognitionService{available: true, freed: 2048}
	h := newRecognitionHandler(svc, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PUT("/collections/:collection_id/recognition", h.SetCollectionRecognition)

	req := httptest.NewRequest(http.MethodPut, "/collections/"+uuid.New().String()+"/recognition",
		bytes.NewBufferString(`{"enabled":false,"purge":true}`))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var body map[string]any
	if err := decodeBody(w, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["freed_bytes"].(float64) != 2048 {
		t.Fatalf("unexpected payload: %v", body)
	}
	if svc.gotEnabled || !svc.gotPurge {
		t.Fatalf("service saw enabled=%v purge=%v", svc.gotEnabled, svc.gotPurge)
	}
}

// ── Groups ──────────────────────────────────────────────────────────────────

func TestListRecognitionGroups_InvalidKind(t *testing.T) {
	h := newRecognitionHandler(&stubRecognitionService{available: true}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.GET("/collections/:collection_id/recognition/groups", h.ListRecognitionGroups)

	req := httptest.NewRequest(http.MethodGet, "/collections/"+uuid.New().String()+"/recognition/groups?kind=car", nil)
	if w := doRequest(r, req); w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestListRecognitionGroups_Success(t *testing.T) {
	label := "Whiskers"
	svc := &stubRecognitionService{
		available: true,
		groups: []models.RecognitionGroup{
			{ID: uuid.New(), Kind: models.RecognitionKindPet, AutoLabel: "Pet 1 (cat)", UserLabel: &label, FileCount: 5},
		},
	}
	h := newRecognitionHandler(svc, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.GET("/collections/:collection_id/recognition/groups", h.ListRecognitionGroups)

	req := httptest.NewRequest(http.MethodGet, "/collections/"+uuid.New().String()+"/recognition/groups?kind=pet&labeled=true", nil)
	w := doRequest(r, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if svc.gotKind != "pet" || !svc.gotLabeled {
		t.Fatalf("filters not forwarded: kind=%q labeled=%v", svc.gotKind, svc.gotLabeled)
	}
	var body struct {
		Groups []models.RecognitionGroup `json:"groups"`
	}
	if err := decodeBody(w, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if len(body.Groups) != 1 || *body.Groups[0].UserLabel != "Whiskers" {
		t.Fatalf("unexpected groups payload: %+v", body)
	}
}

// ── Label / merge / delete ──────────────────────────────────────────────────

func TestUpdateRecognitionGroup_LabelTooLong(t *testing.T) {
	h := newRecognitionHandler(&stubRecognitionService{available: true}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PATCH("/recognition/groups/:group_id", h.UpdateRecognitionGroup)

	// Labels moderately over the cap are truncated (Name() convention); only
	// absurdly long input is rejected outright.
	long := make([]byte, 500)
	for i := range long {
		long[i] = 'x'
	}
	payload, _ := json.Marshal(map[string]string{"label": string(long)})
	req := httptest.NewRequest(http.MethodPatch, "/recognition/groups/"+uuid.New().String(), bytes.NewBuffer(payload))
	req.Header.Set("Content-Type", "application/json")
	if w := doRequest(r, req); w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestUpdateRecognitionGroup_TruncatesModeratelyLongLabel(t *testing.T) {
	group := &models.RecognitionGroup{ID: uuid.New(), Kind: models.RecognitionKindFace, AutoLabel: "Person 1"}
	svc := &stubRecognitionService{available: true, labeled: group}
	h := newRecognitionHandler(svc, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PATCH("/recognition/groups/:group_id", h.UpdateRecognitionGroup)

	long := make([]byte, 120)
	for i := range long {
		long[i] = 'x'
	}
	payload, _ := json.Marshal(map[string]string{"label": string(long)})
	req := httptest.NewRequest(http.MethodPatch, "/recognition/groups/"+group.ID.String(), bytes.NewBuffer(payload))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if len(svc.gotLabel) != 80 {
		t.Fatalf("expected label truncated to 80 runes, got %d", len(svc.gotLabel))
	}
}

func TestUpdateRecognitionGroup_SanitizesLabel(t *testing.T) {
	group := &models.RecognitionGroup{ID: uuid.New(), Kind: models.RecognitionKindFace, AutoLabel: "Person 1"}
	svc := &stubRecognitionService{available: true, labeled: group}
	h := newRecognitionHandler(svc, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PATCH("/recognition/groups/:group_id", h.UpdateRecognitionGroup)

	// Same rules as file/folder names: trimmed, CRLF/path separators stripped,
	// length capped at 80 runes.
	req := httptest.NewRequest(http.MethodPatch, "/recognition/groups/"+group.ID.String(),
		bytes.NewBufferString(`{"label":"  Grand\r\nma/Nan\\a  "}`))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if svc.gotLabel != "GrandmaNana" {
		t.Fatalf("label not sanitized as a display name: %q", svc.gotLabel)
	}
}

func TestMergeRecognitionGroups_RequiresSources(t *testing.T) {
	h := newRecognitionHandler(&stubRecognitionService{available: true}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.POST("/recognition/groups/:group_id/merge", h.MergeRecognitionGroups)

	req := httptest.NewRequest(http.MethodPost, "/recognition/groups/"+uuid.New().String()+"/merge",
		bytes.NewBufferString(`{"source_group_ids":[]}`))
	req.Header.Set("Content-Type", "application/json")
	if w := doRequest(r, req); w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestMergeRecognitionGroups_SelfMergeRejected(t *testing.T) {
	h := newRecognitionHandler(&stubRecognitionService{available: true}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.POST("/recognition/groups/:group_id/merge", h.MergeRecognitionGroups)

	id := uuid.New()
	req := httptest.NewRequest(http.MethodPost, "/recognition/groups/"+id.String()+"/merge",
		bytes.NewBufferString(`{"source_group_ids":["`+id.String()+`"]}`))
	req.Header.Set("Content-Type", "application/json")
	if w := doRequest(r, req); w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestMergeRecognitionGroups_KindMismatch(t *testing.T) {
	h := newRecognitionHandler(&stubRecognitionService{available: true, mergeErr: services.ErrGroupKindMismatch}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.POST("/recognition/groups/:group_id/merge", h.MergeRecognitionGroups)

	req := httptest.NewRequest(http.MethodPost, "/recognition/groups/"+uuid.New().String()+"/merge",
		bytes.NewBufferString(`{"source_group_ids":["`+uuid.New().String()+`"]}`))
	req.Header.Set("Content-Type", "application/json")
	if w := doRequest(r, req); w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestDeleteRecognitionGroup_NotFound(t *testing.T) {
	h := newRecognitionHandler(&stubRecognitionService{available: true, deleteErr: services.ErrNotFound}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.DELETE("/recognition/groups/:group_id", h.DeleteRecognitionGroup)

	req := httptest.NewRequest(http.MethodDelete, "/recognition/groups/"+uuid.New().String(), nil)
	if w := doRequest(r, req); w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestGetRecognitionThumb_Success(t *testing.T) {
	h := newRecognitionHandler(&stubRecognitionService{available: true, thumb: []byte{0xFF, 0xD8, 0xFF}}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.GET("/recognition/detections/:detection_id/thumb", h.GetRecognitionThumb)

	req := httptest.NewRequest(http.MethodGet, "/recognition/detections/"+uuid.New().String()+"/thumb", nil)
	w := doRequest(r, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Fatalf("expected image/jpeg, got %q", ct)
	}
	if w.Body.Len() != 3 {
		t.Fatalf("expected 3 thumb bytes, got %d", w.Body.Len())
	}
}

// ── Search integration ──────────────────────────────────────────────────────

// searchGroupQuerier returns a labeled-group hit for premium search tests.
type searchGroupQuerier struct {
	stubQuerier
	hits []db.RecognitionGroupSearchHit
}

func (q *searchGroupQuerier) SearchRecognitionGroupsByUser(_ context.Context, _ uuid.UUID, _ string, _ db.PageInput) (*db.PageResult[db.RecognitionGroupSearchHit], error) {
	return &db.PageResult[db.RecognitionGroupSearchHit]{Items: q.hits}, nil
}

func searchRecognitionBody(t *testing.T, q routes.Querier, svc routes.RecognitionServicer) map[string]json.RawMessage {
	t.Helper()
	h := newRecognitionHandler(svc, q)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.GET("/search", h.Search)

	req := httptest.NewRequest(http.MethodGet, "/search?q=whiskers", nil)
	w := doRequest(r, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var body map[string]json.RawMessage
	if err := decodeBody(w, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	return body
}

func TestSearch_IncludesGroupsForPremium(t *testing.T) {
	q := &searchGroupQuerier{
		stubQuerier: stubQuerier{user: &models.User{Username: "alice", IsPremium: true}},
		hits: []db.RecognitionGroupSearchHit{
			{ID: uuid.New(), CollectionName: "Family", Kind: "pet", Label: "Whiskers", FileCount: 5},
		},
	}
	body := searchRecognitionBody(t, q, &stubRecognitionService{available: true})
	raw, ok := body["recognition_groups"]
	if !ok {
		t.Fatalf("expected recognition_groups key for premium user, got keys %v", keysOf(body))
	}
	var page db.PageResult[db.RecognitionGroupSearchHit]
	if err := json.Unmarshal(raw, &page); err != nil {
		t.Fatalf("decode recognition_groups: %v", err)
	}
	if len(page.Items) != 1 || page.Items[0].Label != "Whiskers" {
		t.Fatalf("unexpected hits: %+v", page.Items)
	}
}

func TestSearch_OmitsGroupsForFreeUsers(t *testing.T) {
	q := &searchGroupQuerier{
		stubQuerier: stubQuerier{user: &models.User{Username: "bob", IsPremium: false}},
		hits:        []db.RecognitionGroupSearchHit{{ID: uuid.New(), Label: "Whiskers"}},
	}
	body := searchRecognitionBody(t, q, &stubRecognitionService{available: true})
	if _, ok := body["recognition_groups"]; ok {
		t.Fatalf("recognition_groups must be omitted for non-premium users")
	}
}

func TestSearch_OmitsGroupsWhenSidecarUnavailable(t *testing.T) {
	q := &searchGroupQuerier{
		stubQuerier: stubQuerier{user: &models.User{Username: "alice", IsPremium: true}},
		hits:        []db.RecognitionGroupSearchHit{{ID: uuid.New(), Label: "Whiskers"}},
	}
	body := searchRecognitionBody(t, q, &stubRecognitionService{available: false})
	if _, ok := body["recognition_groups"]; ok {
		t.Fatalf("recognition_groups must be omitted when recognition is unavailable")
	}
}

func keysOf(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
