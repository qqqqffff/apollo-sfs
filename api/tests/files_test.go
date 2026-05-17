package tests

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
)

// sampleFile returns a minimal populated File for tests.
func sampleFile() *models.File {
	return &models.File{
		ID:        uuid.New(),
		UserID:    uuid.New(),
		Name:      "test.txt",
		MimeType:  "text/plain",
		SizeBytes: 1024,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
}

// ── GetFile ───────────────────────────────────────────────────────────────────

func TestGetFile_InvalidUUID(t *testing.T) {
	h := newFileHandler(nil)
	r := newEngine()
	r.GET("/files/:file_id", h.GetFile)

	req := httptest.NewRequest(http.MethodGet, "/files/not-a-uuid", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestGetFile_NotFound(t *testing.T) {
	h := newFileHandler(&stubFileService{fileErr: services.ErrNotFound})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.GET("/files/:file_id", h.GetFile)

	req := httptest.NewRequest(http.MethodGet, "/files/"+uuid.New().String(), nil)
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestGetFile_Success(t *testing.T) {
	file := sampleFile()
	h := newFileHandler(&stubFileService{file: file})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.GET("/files/:file_id", h.GetFile)

	req := httptest.NewRequest(http.MethodGet, "/files/"+file.ID.String(), nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	if body["name"] != file.Name {
		t.Errorf("expected name=%q, got %v", file.Name, body["name"])
	}
}

// ── DeleteFile ────────────────────────────────────────────────────────────────

func TestDeleteFile_InvalidUUID(t *testing.T) {
	h := newFileHandler(nil)
	r := newEngine()
	r.DELETE("/files/:file_id", h.DeleteFile)

	req := httptest.NewRequest(http.MethodDelete, "/files/bad-id", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestDeleteFile_NotFound(t *testing.T) {
	h := newFileHandler(&stubFileService{fileErr: services.ErrNotFound})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.DELETE("/files/:file_id", h.DeleteFile)

	req := httptest.NewRequest(http.MethodDelete, "/files/"+uuid.New().String(), nil)
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestDeleteFile_Success(t *testing.T) {
	stub := &stubFileService{}
	h := newFileHandler(stub)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.DELETE("/files/:file_id", h.DeleteFile)

	req := httptest.NewRequest(http.MethodDelete, "/files/"+uuid.New().String(), nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	if !stub.deleted {
		t.Error("expected Delete to have been called")
	}
}

// ── UpdateFile ────────────────────────────────────────────────────────────────

func TestUpdateFile_InvalidUUID(t *testing.T) {
	h := newFileHandler(nil)
	r := newEngine()
	r.PATCH("/files/:file_id", h.UpdateFile)

	req := httptest.NewRequest(http.MethodPatch, "/files/bad-id", jsonBody(map[string]any{"name": "x"}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestUpdateFile_MissingName(t *testing.T) {
	h := newFileHandler(nil)
	r := newEngine()
	r.PATCH("/files/:file_id", h.UpdateFile)

	req := httptest.NewRequest(http.MethodPatch, "/files/"+uuid.New().String(), jsonBody(map[string]any{}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestUpdateFile_NotFound(t *testing.T) {
	h := newFileHandler(&stubFileService{fileErr: services.ErrNotFound})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PATCH("/files/:file_id", h.UpdateFile)

	req := httptest.NewRequest(http.MethodPatch, "/files/"+uuid.New().String(), jsonBody(map[string]any{"name": "new.txt"}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestUpdateFile_Success(t *testing.T) {
	file := sampleFile()
	file.Name = "renamed.txt"
	h := newFileHandler(&stubFileService{file: file})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PATCH("/files/:file_id", h.UpdateFile)

	req := httptest.NewRequest(http.MethodPatch, "/files/"+file.ID.String(), jsonBody(map[string]any{"name": "renamed.txt"}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

// ── MoveFile ──────────────────────────────────────────────────────────────────

func TestMoveFile_InvalidFileUUID(t *testing.T) {
	h := newFileHandler(nil)
	r := newEngine()
	r.PATCH("/files/:file_id/move", h.MoveFile)

	req := httptest.NewRequest(http.MethodPatch, "/files/bad-id/move", jsonBody(map[string]any{"folder_id": uuid.New().String()}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestMoveFile_MissingFolderID(t *testing.T) {
	h := newFileHandler(nil)
	r := newEngine()
	r.PATCH("/files/:file_id/move", h.MoveFile)

	req := httptest.NewRequest(http.MethodPatch, "/files/"+uuid.New().String()+"/move", jsonBody(map[string]any{}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestMoveFile_InvalidFolderUUID(t *testing.T) {
	h := newFileHandler(nil)
	r := newEngine()
	r.PATCH("/files/:file_id/move", h.MoveFile)

	req := httptest.NewRequest(http.MethodPatch, "/files/"+uuid.New().String()+"/move", jsonBody(map[string]any{"folder_id": "not-a-uuid"}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestMoveFile_FileNotFound(t *testing.T) {
	h := newFileHandler(&stubFileService{fileErr: services.ErrNotFound})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PATCH("/files/:file_id/move", h.MoveFile)

	req := httptest.NewRequest(http.MethodPatch, "/files/"+uuid.New().String()+"/move", jsonBody(map[string]any{"folder_id": uuid.New().String()}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestMoveFile_TargetFolderNotFound(t *testing.T) {
	h := newFileHandler(&stubFileService{fileErr: services.ErrFolderNotFound})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PATCH("/files/:file_id/move", h.MoveFile)

	req := httptest.NewRequest(http.MethodPatch, "/files/"+uuid.New().String()+"/move", jsonBody(map[string]any{"folder_id": uuid.New().String()}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestMoveFile_Success(t *testing.T) {
	file := sampleFile()
	h := newFileHandler(&stubFileService{file: file})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PATCH("/files/:file_id/move", h.MoveFile)

	req := httptest.NewRequest(http.MethodPatch, "/files/"+file.ID.String()+"/move", jsonBody(map[string]any{"folder_id": uuid.New().String()}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}
