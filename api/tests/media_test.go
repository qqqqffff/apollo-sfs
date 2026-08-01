package tests

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
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

func TestGetMediaFolder_ParsesSortAndFilters(t *testing.T) {
	svc := &stubFolderService{folder: mediaFolder()}
	h := newMediaHandler(nil, svc, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.GET("/folders/:folder_id/media", h.GetMediaFolder)

	groupID := uuid.New()
	url := "/folders/" + uuid.New().String() + "/media" +
		"?sort=source&hidden=only" +
		"&taken_after=2024-01-02&taken_before=2024-06-01T12:00:00Z" +
		"&uploaded_after=2023-05-05" +
		"&source=web,google_photos&source=web" + // duplicate is dropped
		"&media_type=image&media_type=bogus" +
		"&group=" + groupID.String() + "&group=not-a-uuid"
	w := doRequest(r, httptest.NewRequest(http.MethodGet, url, nil))

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	if svc.mediaSort != db.MediaSortSource {
		t.Errorf("sort = %q, want %q", svc.mediaSort, db.MediaSortSource)
	}
	if svc.mediaHidden != db.HiddenOnly {
		t.Errorf("hidden = %v, want HiddenOnly", svc.mediaHidden)
	}
	f := svc.mediaFilter
	if f.TakenAfter == nil || !f.TakenAfter.Equal(time.Date(2024, 1, 2, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("taken_after = %v, want 2024-01-02 UTC", f.TakenAfter)
	}
	if f.TakenBefore == nil || !f.TakenBefore.Equal(time.Date(2024, 6, 1, 12, 0, 0, 0, time.UTC)) {
		t.Errorf("taken_before = %v, want 2024-06-01T12:00:00Z", f.TakenBefore)
	}
	if f.UploadedAfter == nil || f.UploadedBefore != nil {
		t.Errorf("upload range = (%v, %v), want (set, nil)", f.UploadedAfter, f.UploadedBefore)
	}
	if len(f.Sources) != 2 || f.Sources[0] != "web" || f.Sources[1] != "google_photos" {
		t.Errorf("sources = %v, want [web google_photos]", f.Sources)
	}
	if len(f.MediaTypes) != 1 || f.MediaTypes[0] != db.MediaTypeImage {
		t.Errorf("media types = %v, want [image] (unknown values dropped)", f.MediaTypes)
	}
	if len(f.GroupIDs) != 1 || f.GroupIDs[0] != groupID {
		t.Errorf("group ids = %v, want [%s] (unparseable dropped)", f.GroupIDs, groupID)
	}
}

func TestGetMediaFolder_IgnoresUnparseableFilterDates(t *testing.T) {
	svc := &stubFolderService{folder: mediaFolder()}
	h := newMediaHandler(nil, svc, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.GET("/folders/:folder_id/media", h.GetMediaFolder)

	url := "/folders/" + uuid.New().String() + "/media?taken_after=yesterday&uploaded_before="
	w := doRequest(r, httptest.NewRequest(http.MethodGet, url, nil))

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	if !svc.mediaFilter.IsZero() {
		t.Errorf("filter = %+v, want zero value", svc.mediaFilter)
	}
}

// ── GetMediaFolderFileIDs ───────────────────────────────────────────────────

func TestGetMediaFolderFileIDs_InvalidUUID(t *testing.T) {
	h := newMediaHandler(nil, nil, nil)
	r := newEngine()
	r.GET("/folders/:folder_id/media/ids", h.GetMediaFolderFileIDs)

	w := doRequest(r, httptest.NewRequest(http.MethodGet, "/folders/not-a-uuid/media/ids", nil))

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestGetMediaFolderFileIDs_NotMediaCollection(t *testing.T) {
	h := newMediaHandler(nil, &stubFolderService{folderErr: services.ErrNotMediaCollection}, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.GET("/folders/:folder_id/media/ids", h.GetMediaFolderFileIDs)

	w := doRequest(r, httptest.NewRequest(http.MethodGet, "/folders/"+uuid.New().String()+"/media/ids", nil))

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestGetMediaFolderFileIDs_Success(t *testing.T) {
	ids := []uuid.UUID{uuid.New(), uuid.New()}
	svc := &stubFolderService{folder: mediaFolder(), mediaFileIDs: ids}
	h := newMediaHandler(nil, svc, nil)
	r := newEngine()
	ginContext(r, uuid.New().String(), "alice", false)
	r.GET("/folders/:folder_id/media/ids", h.GetMediaFolderFileIDs)

	url := "/folders/" + uuid.New().String() + "/media/ids?media_type=video"
	w := doRequest(r, httptest.NewRequest(http.MethodGet, url, nil))

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	var body struct {
		FileIDs   []string `json:"file_ids"`
		Truncated bool     `json:"truncated"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if len(body.FileIDs) != 2 || body.FileIDs[0] != ids[0].String() {
		t.Errorf("file_ids = %v, want %v", body.FileIDs, ids)
	}
	if body.Truncated {
		t.Error("truncated = true, want false for a short result")
	}
	if len(svc.mediaFilter.MediaTypes) != 1 || svc.mediaFilter.MediaTypes[0] != db.MediaTypeVideo {
		t.Errorf("media types = %v, want [video]", svc.mediaFilter.MediaTypes)
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
