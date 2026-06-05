package tests

import (
	"bytes"
	"context"
	"database/sql"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/admin"
	"apollo-sfs.com/api/routes/services"
)

// ── Stubs ───────────────────────────────────────────────────────────────────

// stubInboundQuerier implements services.InboundEmailQuerier with an in-memory
// map so the real InboundEmailService can be exercised against a temp dir.
type stubInboundQuerier struct {
	rows      map[uuid.UUID]*models.InboundEmail
	insertOK  bool // value returned as "inserted"
	insertErr error
	workers   []models.WorkerSummary
}

func newStubInboundQuerier() *stubInboundQuerier {
	return &stubInboundQuerier{rows: map[uuid.UUID]*models.InboundEmail{}, insertOK: true}
}

func (s *stubInboundQuerier) InsertInboundEmail(_ context.Context, e *models.InboundEmail) (bool, error) {
	if s.insertErr != nil {
		return false, s.insertErr
	}
	if s.insertOK {
		cp := *e
		s.rows[e.ID] = &cp
	}
	return s.insertOK, nil
}

func (s *stubInboundQuerier) ListInboundEmails(_ context.Context, worker string, _ db.PageInput) (*db.PageResult[models.InboundEmail], error) {
	var items []models.InboundEmail
	for _, r := range s.rows {
		if worker == "" || r.WorkerName == worker {
			items = append(items, *r)
		}
	}
	return &db.PageResult[models.InboundEmail]{Items: items}, nil
}

func (s *stubInboundQuerier) GetInboundEmail(_ context.Context, id uuid.UUID) (*models.InboundEmail, error) {
	r, ok := s.rows[id]
	if !ok {
		return nil, sql.ErrNoRows
	}
	return r, nil
}

func (s *stubInboundQuerier) MarkInboundEmailRead(_ context.Context, id uuid.UUID) error {
	if r, ok := s.rows[id]; ok {
		r.Read = true
	}
	return nil
}

func (s *stubInboundQuerier) DeleteInboundEmail(_ context.Context, id uuid.UUID) error {
	delete(s.rows, id)
	return nil
}

func (s *stubInboundQuerier) ListEmailWorkers(_ context.Context) ([]models.WorkerSummary, error) {
	return s.workers, nil
}

var _ services.InboundEmailQuerier = (*stubInboundQuerier)(nil)

// stubInboundService implements admin.InboundEmailServicer for handler tests.
type stubInboundService struct {
	stored      *models.InboundEmail
	storeErr    error
	workers     []models.WorkerSummary
	list        *db.PageResult[models.InboundEmail]
	detail      *models.EmailDetail
	getErr      error
	markErr     error
	deleteErr   error
	lastStoreTo string
}

func (s *stubInboundService) StoreEmail(_ context.Context, toAddr string, _ models.StoredEmail) (*models.InboundEmail, error) {
	s.lastStoreTo = toAddr
	if s.storeErr != nil {
		return nil, s.storeErr
	}
	if s.stored != nil {
		return s.stored, nil
	}
	return &models.InboundEmail{ID: uuid.New(), ToAddr: toAddr}, nil
}
func (s *stubInboundService) ListWorkers(_ context.Context) ([]models.WorkerSummary, error) {
	return s.workers, nil
}
func (s *stubInboundService) ListEmails(_ context.Context, _ string, _ db.PageInput) (*db.PageResult[models.InboundEmail], error) {
	if s.list != nil {
		return s.list, nil
	}
	return &db.PageResult[models.InboundEmail]{}, nil
}
func (s *stubInboundService) GetEmail(_ context.Context, _ uuid.UUID) (*models.EmailDetail, error) {
	if s.getErr != nil {
		return nil, s.getErr
	}
	return s.detail, nil
}
func (s *stubInboundService) MarkRead(_ context.Context, _ uuid.UUID) error  { return s.markErr }
func (s *stubInboundService) DeleteEmail(_ context.Context, _ uuid.UUID) error { return s.deleteErr }

var _ admin.InboundEmailServicer = (*stubInboundService)(nil)

// ── Service: worker name derivation ───────────────────────────────────────────

func TestWorkerNameFromAddress(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"support@example.com", "support", false},
		{"Support <support@example.com>", "support", false},
		{"BILLING@example.com", "billing", false},        // lower-cased
		{"support+ticket42@example.com", "support", false}, // sub-address stripped
		{"a.b-c_d@example.com", "a.b-c_d", false},
		{"../../etc/passwd@example.com", "", true}, // traversal chars rejected
		{"foo/bar@example.com", "", true},
		{"", "", true},
		{"@example.com", "", true},
	}
	for _, tc := range cases {
		got, err := services.WorkerNameFromAddress(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("%q: expected error, got %q", tc.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("%q: unexpected error: %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("%q: want %q, got %q", tc.in, tc.want, got)
		}
	}
}

// ── Service: store / get / delete against a temp dir ──────────────────────────

func newTestInboundService(t *testing.T) (*services.InboundEmailService, *stubInboundQuerier, string) {
	t.Helper()
	root := t.TempDir()
	q := newStubInboundQuerier()
	svc, err := services.NewInboundEmailService(q, root)
	if err != nil {
		t.Fatalf("NewInboundEmailService: %v", err)
	}
	return svc, q, root
}

func sampleStored() models.StoredEmail {
	return models.StoredEmail{
		MessageID: "<abc123@sendgrid.net>",
		From:      "alice@example.com",
		To:        "support@example.com",
		Subject:   "Help",
		Text:      "hello there",
		HTML:      "<p>hello there</p>",
	}
}

func TestInboundService_StoreEmail_WritesFileAndRow(t *testing.T) {
	svc, q, root := newTestInboundService(t)

	row, err := svc.StoreEmail(context.Background(), "support@example.com", sampleStored())
	if err != nil {
		t.Fatalf("StoreEmail: %v", err)
	}
	if row.WorkerName != "support" {
		t.Errorf("worker = %q, want support", row.WorkerName)
	}
	if _, err := os.Stat(row.FilePath); err != nil {
		t.Errorf("expected file on disk at %s: %v", row.FilePath, err)
	}
	// File must live under <root>/support/
	rel, _ := filepath.Rel(root, row.FilePath)
	if filepath.IsAbs(rel) || !strings.HasPrefix(rel, "support"+string(filepath.Separator)) {
		t.Errorf("file not under support worker dir: %s", rel)
	}
	if _, ok := q.rows[row.ID]; !ok {
		t.Errorf("index row not inserted")
	}
}

func TestInboundService_StoreEmail_RejectsTraversalWorker(t *testing.T) {
	svc, q, _ := newTestInboundService(t)

	_, err := svc.StoreEmail(context.Background(), "../../../etc/passwd@example.com", sampleStored())
	if err == nil {
		t.Fatal("expected error for traversal recipient")
	}
	if len(q.rows) != 0 {
		t.Errorf("no row should be inserted, got %d", len(q.rows))
	}
}

func TestInboundService_StoreEmail_DuplicateRemovesFile(t *testing.T) {
	svc, q, root := newTestInboundService(t)
	q.insertOK = false // simulate ON CONFLICT DO NOTHING

	_, err := svc.StoreEmail(context.Background(), "support@example.com", sampleStored())
	if err != services.ErrDuplicateEmail {
		t.Fatalf("want ErrDuplicateEmail, got %v", err)
	}
	// The just-written file must be cleaned up on a duplicate — no .json left.
	count := 0
	_ = filepath.Walk(root, func(_ string, info os.FileInfo, _ error) error {
		if info != nil && !info.IsDir() {
			count++
		}
		return nil
	})
	if count != 0 {
		t.Errorf("expected no files left after duplicate, got %d", count)
	}
}

func TestInboundService_GetEmail_ReadsFromDisk(t *testing.T) {
	svc, _, _ := newTestInboundService(t)

	row, err := svc.StoreEmail(context.Background(), "support@example.com", sampleStored())
	if err != nil {
		t.Fatalf("StoreEmail: %v", err)
	}
	detail, err := svc.GetEmail(context.Background(), row.ID)
	if err != nil {
		t.Fatalf("GetEmail: %v", err)
	}
	if detail.Message.Text != "hello there" {
		t.Errorf("body not read from disk: %q", detail.Message.Text)
	}
	if detail.Message.HTML != "<p>hello there</p>" {
		t.Errorf("html not read from disk: %q", detail.Message.HTML)
	}
}

func TestInboundService_DeleteEmail_RemovesFile(t *testing.T) {
	svc, q, _ := newTestInboundService(t)

	row, err := svc.StoreEmail(context.Background(), "support@example.com", sampleStored())
	if err != nil {
		t.Fatalf("StoreEmail: %v", err)
	}
	if err := svc.DeleteEmail(context.Background(), row.ID); err != nil {
		t.Fatalf("DeleteEmail: %v", err)
	}
	if _, err := os.Stat(row.FilePath); !os.IsNotExist(err) {
		t.Errorf("file should be removed, stat err = %v", err)
	}
	if _, ok := q.rows[row.ID]; ok {
		t.Errorf("index row should be deleted")
	}
}

// ── Webhook ───────────────────────────────────────────────────────────────────

func buildInboundForm(t *testing.T, fields map[string]string, attachName string) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			t.Fatalf("write field %q: %v", k, err)
		}
	}
	if attachName != "" {
		fw, err := mw.CreateFormFile("attachment1", attachName)
		if err != nil {
			t.Fatalf("create form file: %v", err)
		}
		_, _ = fw.Write([]byte("file-bytes"))
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	return &buf, mw.FormDataContentType()
}

func TestInboundWebhook_StoresEmail(t *testing.T) {
	svc := &stubInboundService{stored: &models.InboundEmail{ID: uuid.New(), WorkerName: "support"}}
	h := admin.NewInboundEmailHandler(svc, "")

	r := newEngine()
	r.POST("/webhooks/email-inbound", h.InboundEmailWebhook)

	body, ct := buildInboundForm(t, map[string]string{
		"to":      "support@example.com",
		"from":    "alice@example.com",
		"subject": "Help",
		"text":    "hi",
		"headers": "Message-ID: <abc@x>\r\nSubject: Help",
	}, "doc.pdf")
	req := httptest.NewRequest(http.MethodPost, "/webhooks/email-inbound", body)
	req.Header.Set("Content-Type", ct)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	if svc.lastStoreTo != "support@example.com" {
		t.Errorf("StoreEmail called with to=%q", svc.lastStoreTo)
	}
}

func TestInboundWebhook_Duplicate(t *testing.T) {
	svc := &stubInboundService{storeErr: services.ErrDuplicateEmail}
	h := admin.NewInboundEmailHandler(svc, "")

	r := newEngine()
	r.POST("/webhooks/email-inbound", h.InboundEmailWebhook)

	body, ct := buildInboundForm(t, map[string]string{"to": "support@example.com", "from": "a@b.com"}, "")
	req := httptest.NewRequest(http.MethodPost, "/webhooks/email-inbound", body)
	req.Header.Set("Content-Type", ct)
	w := doRequest(r, req)

	// Duplicates must still be 200 so SendGrid stops retrying.
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for duplicate, got %d", w.Code)
	}
}

func TestInboundWebhook_UnroutableRecipient(t *testing.T) {
	svc := &stubInboundService{storeErr: services.ErrInvalidWorker}
	h := admin.NewInboundEmailHandler(svc, "")

	r := newEngine()
	r.POST("/webhooks/email-inbound", h.InboundEmailWebhook)

	body, ct := buildInboundForm(t, map[string]string{"to": "weird@example.com", "from": "a@b.com"}, "")
	req := httptest.NewRequest(http.MethodPost, "/webhooks/email-inbound", body)
	req.Header.Set("Content-Type", ct)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for unroutable, got %d", w.Code)
	}
}

func TestInboundWebhook_MissingToFrom(t *testing.T) {
	h := admin.NewInboundEmailHandler(&stubInboundService{}, "")

	r := newEngine()
	r.POST("/webhooks/email-inbound", h.InboundEmailWebhook)

	body, ct := buildInboundForm(t, map[string]string{"subject": "no addrs"}, "")
	req := httptest.NewRequest(http.MethodPost, "/webhooks/email-inbound", body)
	req.Header.Set("Content-Type", ct)
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestInboundWebhook_SecretEnforced(t *testing.T) {
	svc := &stubInboundService{stored: &models.InboundEmail{ID: uuid.New()}}
	h := admin.NewInboundEmailHandler(svc, "s3cr3t")

	r := newEngine()
	r.POST("/webhooks/email-inbound", h.InboundEmailWebhook)

	makeReq := func(token string) *httptest.ResponseRecorder {
		body, ct := buildInboundForm(t, map[string]string{"to": "support@example.com", "from": "a@b.com"}, "")
		path := "/webhooks/email-inbound"
		if token != "" {
			path += "?token=" + token
		}
		req := httptest.NewRequest(http.MethodPost, path, body)
		req.Header.Set("Content-Type", ct)
		return doRequest(r, req)
	}

	if w := makeReq(""); w.Code != http.StatusUnauthorized {
		t.Errorf("missing token: expected 401, got %d", w.Code)
	}
	if w := makeReq("wrong"); w.Code != http.StatusUnauthorized {
		t.Errorf("wrong token: expected 401, got %d", w.Code)
	}
	if w := makeReq("s3cr3t"); w.Code != http.StatusOK {
		t.Errorf("correct token: expected 200, got %d", w.Code)
	}
}

// ── Admin endpoints ───────────────────────────────────────────────────────────

func TestAdminListEmailWorkers(t *testing.T) {
	svc := &stubInboundService{workers: []models.WorkerSummary{
		{WorkerName: "support", TotalCount: 3, UnreadCount: 1},
		{WorkerName: "billing", TotalCount: 2, UnreadCount: 0},
	}}
	h := admin.NewInboundEmailHandler(svc, "")

	r := newEngine()
	r.GET("/admin/emails/workers", h.ListEmailWorkers)

	req := httptest.NewRequest(http.MethodGet, "/admin/emails/workers", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	var body map[string]any
	decodeBody(w, &body) //nolint
	workers, _ := body["workers"].([]any)
	if len(workers) != 2 {
		t.Errorf("expected 2 workers, got %d", len(workers))
	}
}

func TestAdminListEmails(t *testing.T) {
	svc := &stubInboundService{list: &db.PageResult[models.InboundEmail]{
		Items: []models.InboundEmail{{ID: uuid.New(), WorkerName: "support", Subject: "Hi"}},
	}}
	h := admin.NewInboundEmailHandler(svc, "")

	r := newEngine()
	r.GET("/admin/emails", h.ListEmails)

	req := httptest.NewRequest(http.MethodGet, "/admin/emails?worker=support", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var body map[string]any
	decodeBody(w, &body) //nolint
	items, _ := body["items"].([]any)
	if len(items) != 1 {
		t.Errorf("expected 1 item, got %d", len(items))
	}
}

func TestAdminGetEmail_OK(t *testing.T) {
	id := uuid.New()
	svc := &stubInboundService{detail: &models.EmailDetail{
		InboundEmail: models.InboundEmail{ID: id, WorkerName: "support"},
		Message:      models.StoredEmail{Text: "body"},
	}}
	h := admin.NewInboundEmailHandler(svc, "")

	r := newEngine()
	r.GET("/admin/emails/:id", h.GetEmail)

	req := httptest.NewRequest(http.MethodGet, "/admin/emails/"+id.String(), nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestAdminGetEmail_NotFound(t *testing.T) {
	svc := &stubInboundService{getErr: sql.ErrNoRows}
	h := admin.NewInboundEmailHandler(svc, "")

	r := newEngine()
	r.GET("/admin/emails/:id", h.GetEmail)

	req := httptest.NewRequest(http.MethodGet, "/admin/emails/"+uuid.New().String(), nil)
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestAdminGetEmail_InvalidUUID(t *testing.T) {
	h := admin.NewInboundEmailHandler(&stubInboundService{}, "")

	r := newEngine()
	r.GET("/admin/emails/:id", h.GetEmail)

	req := httptest.NewRequest(http.MethodGet, "/admin/emails/not-a-uuid", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestAdminMarkEmailRead(t *testing.T) {
	h := admin.NewInboundEmailHandler(&stubInboundService{}, "")

	r := newEngine()
	r.PATCH("/admin/emails/:id/read", h.MarkEmailRead)

	req := httptest.NewRequest(http.MethodPatch, "/admin/emails/"+uuid.New().String()+"/read", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
}

func TestAdminDeleteEmail(t *testing.T) {
	h := admin.NewInboundEmailHandler(&stubInboundService{}, "")

	r := newEngine()
	r.DELETE("/admin/emails/:id", h.DeleteEmail)

	req := httptest.NewRequest(http.MethodDelete, "/admin/emails/"+uuid.New().String(), nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
}

func TestAdminDeleteEmail_NotFound(t *testing.T) {
	h := admin.NewInboundEmailHandler(&stubInboundService{deleteErr: sql.ErrNoRows}, "")

	r := newEngine()
	r.DELETE("/admin/emails/:id", h.DeleteEmail)

	req := httptest.NewRequest(http.MethodDelete, "/admin/emails/"+uuid.New().String(), nil)
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}
