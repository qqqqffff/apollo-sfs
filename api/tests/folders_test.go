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

// sampleFolder returns a minimal populated Folder for tests.
func sampleFolder() *models.Folder {
	return &models.Folder{
		ID:        uuid.New(),
		UserID:    uuid.New(),
		Name:      "Documents",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
}

// ── ListFolders ───────────────────────────────────────────────────────────────

func TestListFolders_Success(t *testing.T) {
	h := newFolderHandler(&stubFolderService{})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.GET("/folders", h.ListFolders)

	req := httptest.NewRequest(http.MethodGet, "/folders", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

// ── GetFolder ─────────────────────────────────────────────────────────────────

func TestGetFolder_InvalidUUID(t *testing.T) {
	h := newFolderHandler(nil)
	r := newEngine()
	r.GET("/folders/:folder_id", h.GetFolder)

	req := httptest.NewRequest(http.MethodGet, "/folders/not-a-uuid", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestGetFolder_NotFound(t *testing.T) {
	h := newFolderHandler(&stubFolderService{folderErr: services.ErrFolderNotFound})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.GET("/folders/:folder_id", h.GetFolder)

	req := httptest.NewRequest(http.MethodGet, "/folders/"+uuid.New().String(), nil)
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestGetFolder_Success(t *testing.T) {
	folder := sampleFolder()
	h := newFolderHandler(&stubFolderService{folder: folder})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.GET("/folders/:folder_id", h.GetFolder)

	req := httptest.NewRequest(http.MethodGet, "/folders/"+folder.ID.String(), nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

// ── CreateFolder ──────────────────────────────────────────────────────────────

func TestCreateFolder_MissingName(t *testing.T) {
	h := newFolderHandler(nil)
	r := newEngine()
	r.POST("/folders", h.CreateFolder)

	req := httptest.NewRequest(http.MethodPost, "/folders", jsonBody(map[string]any{}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestCreateFolder_InvalidParentID(t *testing.T) {
	h := newFolderHandler(nil)
	r := newEngine()
	r.POST("/folders", h.CreateFolder)

	body := jsonBody(map[string]any{"name": "NewFolder", "parent_id": "not-a-uuid"})
	req := httptest.NewRequest(http.MethodPost, "/folders", body)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestCreateFolder_ParentNotFound(t *testing.T) {
	h := newFolderHandler(&stubFolderService{folderErr: services.ErrFolderNotFound})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.POST("/folders", h.CreateFolder)

	parentID := uuid.New().String()
	body := jsonBody(map[string]any{"name": "Child", "parent_id": parentID})
	req := httptest.NewRequest(http.MethodPost, "/folders", body)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestCreateFolder_DuplicateName(t *testing.T) {
	h := newFolderHandler(&stubFolderService{folderErr: services.ErrDuplicateFolderName})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.POST("/folders", h.CreateFolder)

	req := httptest.NewRequest(http.MethodPost, "/folders", jsonBody(map[string]any{"name": "Existing"}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", w.Code)
	}
}

func TestCreateFolder_Success(t *testing.T) {
	folder := sampleFolder()
	h := newFolderHandler(&stubFolderService{folder: folder})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.POST("/folders", h.CreateFolder)

	req := httptest.NewRequest(http.MethodPost, "/folders", jsonBody(map[string]any{"name": "Documents"}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d (body: %s)", w.Code, w.Body.String())
	}
}

// ── UpdateFolder ──────────────────────────────────────────────────────────────

func TestUpdateFolder_InvalidUUID(t *testing.T) {
	h := newFolderHandler(nil)
	r := newEngine()
	r.PATCH("/folders/:folder_id", h.UpdateFolder)

	req := httptest.NewRequest(http.MethodPatch, "/folders/bad-id", jsonBody(map[string]any{"name": "x"}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestUpdateFolder_MissingName(t *testing.T) {
	h := newFolderHandler(nil)
	r := newEngine()
	r.PATCH("/folders/:folder_id", h.UpdateFolder)

	req := httptest.NewRequest(http.MethodPatch, "/folders/"+uuid.New().String(), jsonBody(map[string]any{}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestUpdateFolder_NotFound(t *testing.T) {
	h := newFolderHandler(&stubFolderService{folderErr: services.ErrFolderNotFound})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PATCH("/folders/:folder_id", h.UpdateFolder)

	req := httptest.NewRequest(http.MethodPatch, "/folders/"+uuid.New().String(), jsonBody(map[string]any{"name": "New Name"}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestUpdateFolder_DuplicateName(t *testing.T) {
	h := newFolderHandler(&stubFolderService{folderErr: services.ErrDuplicateFolderName})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PATCH("/folders/:folder_id", h.UpdateFolder)

	req := httptest.NewRequest(http.MethodPatch, "/folders/"+uuid.New().String(), jsonBody(map[string]any{"name": "Taken"}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", w.Code)
	}
}

func TestUpdateFolder_Success(t *testing.T) {
	folder := sampleFolder()
	folder.Name = "Renamed"
	h := newFolderHandler(&stubFolderService{folder: folder})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PATCH("/folders/:folder_id", h.UpdateFolder)

	req := httptest.NewRequest(http.MethodPatch, "/folders/"+folder.ID.String(), jsonBody(map[string]any{"name": "Renamed"}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

// ── MoveFolder ────────────────────────────────────────────────────────────────

func TestMoveFolder_InvalidUUID(t *testing.T) {
	h := newFolderHandler(nil)
	r := newEngine()
	r.PATCH("/folders/:folder_id/move", h.MoveFolder)

	req := httptest.NewRequest(http.MethodPatch, "/folders/bad-id/move", jsonBody(map[string]any{"target_folder_id": uuid.New().String()}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestMoveFolder_MissingTargetID(t *testing.T) {
	h := newFolderHandler(nil)
	r := newEngine()
	r.PATCH("/folders/:folder_id/move", h.MoveFolder)

	req := httptest.NewRequest(http.MethodPatch, "/folders/"+uuid.New().String()+"/move", jsonBody(map[string]any{}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestMoveFolder_InvalidTargetUUID(t *testing.T) {
	h := newFolderHandler(nil)
	r := newEngine()
	r.PATCH("/folders/:folder_id/move", h.MoveFolder)

	req := httptest.NewRequest(http.MethodPatch, "/folders/"+uuid.New().String()+"/move", jsonBody(map[string]any{"target_folder_id": "not-a-uuid"}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestMoveFolder_NotFound(t *testing.T) {
	h := newFolderHandler(&stubFolderService{folderErr: services.ErrFolderNotFound})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PATCH("/folders/:folder_id/move", h.MoveFolder)

	req := httptest.NewRequest(http.MethodPatch, "/folders/"+uuid.New().String()+"/move", jsonBody(map[string]any{"target_folder_id": uuid.New().String()}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestMoveFolder_Cycle(t *testing.T) {
	h := newFolderHandler(&stubFolderService{folderErr: services.ErrFolderCycle})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PATCH("/folders/:folder_id/move", h.MoveFolder)

	req := httptest.NewRequest(http.MethodPatch, "/folders/"+uuid.New().String()+"/move", jsonBody(map[string]any{"target_folder_id": uuid.New().String()}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", w.Code)
	}
}

func TestMoveFolder_Success(t *testing.T) {
	folder := sampleFolder()
	h := newFolderHandler(&stubFolderService{folder: folder})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PATCH("/folders/:folder_id/move", h.MoveFolder)

	req := httptest.NewRequest(http.MethodPatch, "/folders/"+folder.ID.String()+"/move", jsonBody(map[string]any{"target_folder_id": uuid.New().String()}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

// ── DeleteFolder ──────────────────────────────────────────────────────────────

func TestDeleteFolder_InvalidUUID(t *testing.T) {
	h := newFolderHandler(nil)
	r := newEngine()
	r.DELETE("/folders/:folder_id", h.DeleteFolder)

	req := httptest.NewRequest(http.MethodDelete, "/folders/bad-id", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestDeleteFolder_NotFound(t *testing.T) {
	h := newFolderHandler(&stubFolderService{folderErr: services.ErrFolderNotFound})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.DELETE("/folders/:folder_id", h.DeleteFolder)

	req := httptest.NewRequest(http.MethodDelete, "/folders/"+uuid.New().String(), nil)
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestDeleteFolder_NotEmpty(t *testing.T) {
	h := newFolderHandler(&stubFolderService{folderErr: services.ErrFolderNotEmpty})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.DELETE("/folders/:folder_id", h.DeleteFolder)

	req := httptest.NewRequest(http.MethodDelete, "/folders/"+uuid.New().String(), nil)
	w := doRequest(r, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", w.Code)
	}
}

func TestDeleteFolder_Success(t *testing.T) {
	h := newFolderHandler(&stubFolderService{})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.DELETE("/folders/:folder_id", h.DeleteFolder)

	req := httptest.NewRequest(http.MethodDelete, "/folders/"+uuid.New().String(), nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}
