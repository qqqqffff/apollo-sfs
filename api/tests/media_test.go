package tests

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes"
	"apollo-sfs.com/api/routes/services"
)

// newMediaHandler builds a Handler wired with file, folder, and querier stubs —
// covering every dependency the media/collection/preference handlers touch.
func newMediaHandler(fileSvc routes.FileServicer, folderSvc routes.FolderServicer, q routes.Querier) *routes.Handler {
	if q == nil {
		q = &stubQuerier{}
	}
	return routes.NewHandler(q, fileSvc, folderSvc, nil, nil, nil, nil, nil, nil, "test-secret")
}

func mediaFolder() *models.Folder {
	f := sampleFolder()
	f.Kind = models.FolderKindMedia
	return f
}

// ── GetMediaFolder ──────────────────────────────────────────────────────────

func TestGetMediaFolder_InvalidUUID(t *testing.T) {
	h := newMediaHandler(nil, nil, nil)
	r := newEngine()
	r.GET("/folders/:folder_id/media", h.GetMediaFolder)

	req := httptest.NewRequest(http.MethodGet, "/folders/not-a-uuid/media", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestGetMediaFolder_NotFound(t *testing.T) {
	h := newMediaHandler(nil, &stubFolderService{folderErr: services.ErrFolderNotFound}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.GET("/folders/:folder_id/media", h.GetMediaFolder)

	req := httptest.NewRequest(http.MethodGet, "/folders/"+uuid.New().String()+"/media", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestGetMediaFolder_NotMediaCollection(t *testing.T) {
	h := newMediaHandler(nil, &stubFolderService{folderErr: services.ErrNotMediaCollection}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.GET("/folders/:folder_id/media", h.GetMediaFolder)

	req := httptest.NewRequest(http.MethodGet, "/folders/"+uuid.New().String()+"/media", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestGetMediaFolder_Success(t *testing.T) {
	h := newMediaHandler(nil, &stubFolderService{folder: mediaFolder()}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.GET("/folders/:folder_id/media", h.GetMediaFolder)

	// Include sort + hidden params to exercise the query parsing path.
	req := httptest.NewRequest(http.MethodGet, "/folders/"+uuid.New().String()+"/media?sort=taken_at&hidden=show", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

// ── Hide / unhide ─────────────────────────────────────────────────────────────

func TestHideFile_InvalidUUID(t *testing.T) {
	h := newMediaHandler(&stubFileService{}, nil, nil)
	r := newEngine()
	r.PATCH("/files/:file_id/hide", h.HideFile)

	req := httptest.NewRequest(http.MethodPatch, "/files/bad-id/hide", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestHideFile_NotFound(t *testing.T) {
	h := newMediaHandler(&stubFileService{fileErr: services.ErrNotFound}, nil, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PATCH("/files/:file_id/hide", h.HideFile)

	req := httptest.NewRequest(http.MethodPatch, "/files/"+uuid.New().String()+"/hide", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestHideFile_Success(t *testing.T) {
	file := sampleFile()
	file.Hidden = true
	h := newMediaHandler(&stubFileService{file: file}, nil, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PATCH("/files/:file_id/hide", h.HideFile)

	req := httptest.NewRequest(http.MethodPatch, "/files/"+file.ID.String()+"/hide", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestUnhideFile_Success(t *testing.T) {
	file := sampleFile()
	h := newMediaHandler(&stubFileService{file: file}, nil, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PATCH("/files/:file_id/unhide", h.UnhideFile)

	req := httptest.NewRequest(http.MethodPatch, "/files/"+file.ID.String()+"/unhide", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

// ── Collection pointers ─────────────────────────────────────────────────────

func TestCopyToCollection_Success(t *testing.T) {
	h := newMediaHandler(nil, &stubFolderService{}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.POST("/collections/:collection_id/items/:file_id", h.CopyFileToCollection)

	url := "/collections/" + uuid.New().String() + "/items/" + uuid.New().String()
	req := httptest.NewRequest(http.MethodPost, url, nil)
	w := doRequest(r, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestCopyToCollection_NotMediaCollection(t *testing.T) {
	h := newMediaHandler(nil, &stubFolderService{folderErr: services.ErrNotMediaCollection}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.POST("/collections/:collection_id/items/:file_id", h.CopyFileToCollection)

	url := "/collections/" + uuid.New().String() + "/items/" + uuid.New().String()
	req := httptest.NewRequest(http.MethodPost, url, nil)
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestCopyToCollection_FileNotFound(t *testing.T) {
	h := newMediaHandler(nil, &stubFolderService{folderErr: services.ErrNotFound}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.POST("/collections/:collection_id/items/:file_id", h.CopyFileToCollection)

	url := "/collections/" + uuid.New().String() + "/items/" + uuid.New().String()
	req := httptest.NewRequest(http.MethodPost, url, nil)
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestMoveCollectionItem_Success(t *testing.T) {
	h := newMediaHandler(nil, &stubFolderService{}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PATCH("/collections/:collection_id/items/:file_id/move", h.MoveCollectionItem)

	url := "/collections/" + uuid.New().String() + "/items/" + uuid.New().String() + "/move"
	req := httptest.NewRequest(http.MethodPatch, url, jsonBody(map[string]any{"target_collection_id": uuid.New().String()}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestMoveCollectionItem_MissingTarget(t *testing.T) {
	h := newMediaHandler(nil, &stubFolderService{}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PATCH("/collections/:collection_id/items/:file_id/move", h.MoveCollectionItem)

	url := "/collections/" + uuid.New().String() + "/items/" + uuid.New().String() + "/move"
	req := httptest.NewRequest(http.MethodPatch, url, jsonBody(map[string]any{}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestRemoveFromCollection_Success(t *testing.T) {
	h := newMediaHandler(nil, &stubFolderService{}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.DELETE("/collections/:collection_id/items/:file_id", h.RemoveFileFromCollection)

	url := "/collections/" + uuid.New().String() + "/items/" + uuid.New().String()
	req := httptest.NewRequest(http.MethodDelete, url, nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

// ── Preferences ───────────────────────────────────────────────────────────────

func TestGetPreferences_Success(t *testing.T) {
	h := newMediaHandler(nil, nil, &stubQuerier{})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.GET("/me/preferences", h.GetPreferences)

	req := httptest.NewRequest(http.MethodGet, "/me/preferences", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestUpdatePreferences_Disable(t *testing.T) {
	// A null folder id disables auto-upload without folder validation.
	h := newMediaHandler(nil, &stubFolderService{}, &stubQuerier{})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PUT("/me/preferences", h.UpdatePreferences)

	req := httptest.NewRequest(http.MethodPut, "/me/preferences", jsonBody(map[string]any{"media_autoupload_folder_id": nil}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestUpdatePreferences_RejectsNonMediaFolder(t *testing.T) {
	// A regular folder cannot be an auto-upload target.
	h := newMediaHandler(nil, &stubFolderService{folder: sampleFolder()}, &stubQuerier{})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PUT("/me/preferences", h.UpdatePreferences)

	req := httptest.NewRequest(http.MethodPut, "/me/preferences", jsonBody(map[string]any{"media_autoupload_folder_id": uuid.New().String()}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestUpdatePreferences_AcceptsMediaFolder(t *testing.T) {
	h := newMediaHandler(nil, &stubFolderService{folder: mediaFolder()}, &stubQuerier{})
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.PUT("/me/preferences", h.UpdatePreferences)

	req := httptest.NewRequest(http.MethodPut, "/me/preferences", jsonBody(map[string]any{"media_autoupload_folder_id": uuid.New().String()}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}
