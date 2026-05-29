package tests

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes"
	"apollo-sfs.com/api/routes/services"
)

// ── Helpers ───────────────────────────────────────────────────────────────────

var fixedUserID = uuid.MustParse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")

func okKcResolver(_ context.Context, _ string) (uuid.UUID, error) {
	return fixedUserID, nil
}

func errKcResolver(_ context.Context, _ string) (uuid.UUID, error) {
	return uuid.UUID{}, errors.New("keycloak unavailable")
}

func browsHandler(q routes.Querier, folderSvc routes.FolderServicer, favSvc routes.FavServicer, kc func(context.Context, string) (uuid.UUID, error)) *routes.Handler {
	return newAdminBrowseHandler(q, folderSvc, favSvc, kc)
}

// ── AdminListUserFolders ──────────────────────────────────────────────────────

func TestAdminListUserFolders_Success(t *testing.T) {
	q := &stubQuerier{user: sampleUser()}
	h := browsHandler(q, &stubFolderService{}, nil, okKcResolver)

	r := newEngine()
	ginContext(r, uuid.New().String(), "admin", true)
	r.GET("/admin/users/:user_id/folders", h.AdminListUserFolders)

	w := doRequest(r, httptest.NewRequest(http.MethodGet,"/admin/users/alice/folders", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAdminListUserFolders_UserNotFound(t *testing.T) {
	q := &stubQuerier{userErr: sql.ErrNoRows}
	h := browsHandler(q, &stubFolderService{}, nil, okKcResolver)

	r := newEngine()
	r.GET("/admin/users/:user_id/folders", h.AdminListUserFolders)

	w := doRequest(r, httptest.NewRequest(http.MethodGet,"/admin/users/nobody/folders", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestAdminListUserFolders_IDTooLong(t *testing.T) {
	q := &stubQuerier{}
	h := browsHandler(q, &stubFolderService{}, nil, okKcResolver)

	r := newEngine()
	r.GET("/admin/users/:user_id/folders", h.AdminListUserFolders)

	longID := strings.Repeat("a", 151)
	w := doRequest(r, httptest.NewRequest(http.MethodGet,"/admin/users/"+longID+"/folders", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestAdminListUserFolders_KcError(t *testing.T) {
	q := &stubQuerier{user: sampleUser()}
	h := browsHandler(q, &stubFolderService{}, nil, errKcResolver)

	r := newEngine()
	r.GET("/admin/users/:user_id/folders", h.AdminListUserFolders)

	w := doRequest(r, httptest.NewRequest(http.MethodGet,"/admin/users/alice/folders", nil))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", w.Code)
	}
}

// ── AdminGetUserFolder ────────────────────────────────────────────────────────

func TestAdminGetUserFolder_Success(t *testing.T) {
	q := &stubQuerier{user: sampleUser()}
	folderID := uuid.New()
	folder := &models.Folder{ID: folderID, Name: "docs"}
	h := browsHandler(q, &stubFolderService{folder: folder}, nil, okKcResolver)

	r := newEngine()
	r.GET("/admin/users/:user_id/folders/:folder_id", h.AdminGetUserFolder)

	w := doRequest(r, httptest.NewRequest(http.MethodGet,"/admin/users/alice/folders/"+folderID.String(), nil))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAdminGetUserFolder_InvalidFolderID(t *testing.T) {
	q := &stubQuerier{user: sampleUser()}
	h := browsHandler(q, &stubFolderService{}, nil, okKcResolver)

	r := newEngine()
	r.GET("/admin/users/:user_id/folders/:folder_id", h.AdminGetUserFolder)

	w := doRequest(r, httptest.NewRequest(http.MethodGet,"/admin/users/alice/folders/not-a-uuid", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestAdminGetUserFolder_UserNotFound(t *testing.T) {
	q := &stubQuerier{userErr: sql.ErrNoRows}
	h := browsHandler(q, &stubFolderService{}, nil, okKcResolver)

	r := newEngine()
	r.GET("/admin/users/:user_id/folders/:folder_id", h.AdminGetUserFolder)

	w := doRequest(r, httptest.NewRequest(http.MethodGet,"/admin/users/nobody/folders/"+uuid.New().String(), nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestAdminGetUserFolder_FolderNotFound(t *testing.T) {
	q := &stubQuerier{user: sampleUser()}
	h := browsHandler(q, &stubFolderService{folderErr: services.ErrFolderNotFound}, nil, okKcResolver)

	r := newEngine()
	r.GET("/admin/users/:user_id/folders/:folder_id", h.AdminGetUserFolder)

	w := doRequest(r, httptest.NewRequest(http.MethodGet,"/admin/users/alice/folders/"+uuid.New().String(), nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

// ── AdminGetUserFavorites ─────────────────────────────────────────────────────

func TestAdminGetUserFavorites_Success(t *testing.T) {
	q := &stubQuerier{user: sampleUser()}
	favs := &services.FavoriteList{
		Files:   []models.File{},
		Folders: []models.Folder{},
	}
	h := browsHandler(q, nil, &stubFavService{list: favs}, okKcResolver)

	r := newEngine()
	r.GET("/admin/users/:user_id/favorites", h.AdminGetUserFavorites)

	w := doRequest(r, httptest.NewRequest(http.MethodGet,"/admin/users/alice/favorites", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAdminGetUserFavorites_UserNotFound(t *testing.T) {
	q := &stubQuerier{userErr: sql.ErrNoRows}
	h := browsHandler(q, nil, &stubFavService{}, okKcResolver)

	r := newEngine()
	r.GET("/admin/users/:user_id/favorites", h.AdminGetUserFavorites)

	w := doRequest(r, httptest.NewRequest(http.MethodGet,"/admin/users/nobody/favorites", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestAdminGetUserFavorites_IDTooLong(t *testing.T) {
	q := &stubQuerier{}
	h := browsHandler(q, nil, &stubFavService{}, okKcResolver)

	r := newEngine()
	r.GET("/admin/users/:user_id/favorites", h.AdminGetUserFavorites)

	longID := strings.Repeat("a", 151)
	w := doRequest(r, httptest.NewRequest(http.MethodGet,"/admin/users/"+longID+"/favorites", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestAdminGetUserFavorites_KcError(t *testing.T) {
	q := &stubQuerier{user: sampleUser()}
	h := browsHandler(q, nil, &stubFavService{}, errKcResolver)

	r := newEngine()
	r.GET("/admin/users/:user_id/favorites", h.AdminGetUserFavorites)

	w := doRequest(r, httptest.NewRequest(http.MethodGet,"/admin/users/alice/favorites", nil))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", w.Code)
	}
}
