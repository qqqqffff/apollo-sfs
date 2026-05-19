// Package tests contains HTTP-level and unit tests for the apollo-sfs API.
// Handlers are exercised via httptest without a real database; stub
// implementations of the Querier and service interfaces are defined here
// and shared across all test files in this package.
package tests

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes"
	"apollo-sfs.com/api/routes/admin"
	"apollo-sfs.com/api/routes/services"
)

func init() {
	gin.SetMode(gin.TestMode)
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

func newEngine() *gin.Engine {
	r := gin.New()
	return r
}

func doRequest(r http.Handler, req *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func jsonBody(v any) io.Reader {
	b, _ := json.Marshal(v)
	return bytes.NewBuffer(b)
}

func decodeBody(w *httptest.ResponseRecorder, dst any) error {
	return json.NewDecoder(w.Body).Decode(dst)
}

func ginContext(r *gin.Engine, userID, username string, isAdmin bool) {
	r.Use(func(c *gin.Context) {
		c.Set("userID", userID)
		c.Set("username", username)
		roles := []string{}
		if isAdmin {
			roles = append(roles, "admin")
		}
		c.Set("roles", roles)
		c.Next()
	})
}

// ── Stub Querier (routes package) ─────────────────────────────────────────────

// stubQuerier implements routes.Querier. Fields hold the values or errors to
// return; zero values mean "return nil/zero error".
type stubQuerier struct {
	user                *models.User
	userErr             error
	activeBan           *models.UserBan
	activeBanErr        error
	interestSettings    *models.InterestFormSettings
	interestSettingsErr error
	todayCount          int
	todayCountErr       error
	ipCount             int
	ipCountErr          error
	emailExists         bool
	emailExistsErr      error
	createSubErr        error
	adminEmails         []string
	adminEmailsErr      error
}

func (s *stubQuerier) GetUserByUsername(_ context.Context, _ string) (*models.User, error) {
	return s.user, s.userErr
}
func (s *stubQuerier) GetActiveBan(_ context.Context, _ string) (*models.UserBan, error) {
	return s.activeBan, s.activeBanErr
}
func (s *stubQuerier) AutoPardonExpiredSuspension(_ context.Context, _ string) error { return nil }
func (s *stubQuerier) AddBannedIP(_ context.Context, _, _ string) error              { return nil }
func (s *stubQuerier) GetInterestFormSettings(_ context.Context) (*models.InterestFormSettings, error) {
	if s.interestSettings == nil && s.interestSettingsErr == nil {
		return &models.InterestFormSettings{DailyCap: 100, UpdatedAt: time.Now()}, nil
	}
	return s.interestSettings, s.interestSettingsErr
}
func (s *stubQuerier) CountInterestSubmissionsToday(_ context.Context) (int, error) {
	return s.todayCount, s.todayCountErr
}
func (s *stubQuerier) CountInterestSubmissionsFromIP(_ context.Context, _ string) (int, error) {
	return s.ipCount, s.ipCountErr
}
func (s *stubQuerier) ExistsInterestSubmissionByEmail(_ context.Context, _ string) (bool, error) {
	return s.emailExists, s.emailExistsErr
}
func (s *stubQuerier) CreateInterestSubmission(_ context.Context, _ *models.InterestSubmission) error {
	return s.createSubErr
}
func (s *stubQuerier) ListAdminEmails(_ context.Context) ([]string, error) {
	return s.adminEmails, s.adminEmailsErr
}
func (s *stubQuerier) SearchFoldersByUser(_ context.Context, _ uuid.UUID, _ string, _ db.PageInput) (*db.PageResult[models.Folder], error) {
	return &db.PageResult[models.Folder]{}, nil
}
func (s *stubQuerier) SearchFilesByUser(_ context.Context, _ uuid.UUID, _ string, _ db.PageInput) (*db.PageResult[models.File], error) {
	return &db.PageResult[models.File]{}, nil
}
func (s *stubQuerier) InsertAuditLog(_ context.Context, _ db.AuditInput) error { return nil }
func (s *stubQuerier) ListAuditLogsForUser(_ context.Context, _ string, _ db.PageInput) (*db.PageResult[models.AuditLog], error) {
	return &db.PageResult[models.AuditLog]{Items: []models.AuditLog{}}, nil
}

// ── Stub InviteService (routes package) ───────────────────────────────────────

type stubInviteValidator struct {
	result *services.InviteValidation
	err    error
}

func (s *stubInviteValidator) Validate(_ context.Context, _ string) (*services.InviteValidation, error) {
	return s.result, s.err
}

// ── Stub AdminQuerier ─────────────────────────────────────────────────────────

type stubAdminQuerier struct {
	users            []models.User
	user             *models.User
	userErr          error
	submissions      []models.InterestSubmission
	submissionsErr   error
	singleSub        *models.InterestSubmission
	singleSubErr     error
	settings         *models.InterestFormSettings
	settingsErr      error
	updatedSettings  *models.InterestFormSettings
	updatedSettingsErr error
	provisionErr     error
	// drive / quota fields
	userDrive        *models.UserDriveAllocation
	userDriveErr     error
	driveAvail       int64
	driveAvailErr    error
	updateQuotaErr   error
	// alarm settings fields
	alarmSettings           *models.AlarmSettings
	alarmSettingsErr        error
	subscriptionErr         error
}

func (s *stubAdminQuerier) ListUsers(_ context.Context, _ db.PageInput) (*db.PageResult[models.User], error) {
	items := s.users
	if items == nil {
		items = []models.User{}
	}
	return &db.PageResult[models.User]{Items: items}, nil
}
func (s *stubAdminQuerier) GetUserByUsername(_ context.Context, _ string) (*models.User, error) {
	return s.user, s.userErr
}
func (s *stubAdminQuerier) UpdateUserQuota(_ context.Context, _ string, _ int64) error {
	return s.updateQuotaErr
}
func (s *stubAdminQuerier) GetUserDrive(_ context.Context, _ string) (*models.UserDriveAllocation, error) {
	return s.userDrive, s.userDriveErr
}
func (s *stubAdminQuerier) GetDriveAvailableBytes(_ context.Context, _ uuid.UUID) (int64, error) {
	return s.driveAvail, s.driveAvailErr
}
func (s *stubAdminQuerier) ListBannedIPs(_ context.Context, _ bool, _ db.PageInput) (*db.PageResult[models.BannedIP], error) {
	return &db.PageResult[models.BannedIP]{Items: []models.BannedIP{}}, nil
}
func (s *stubAdminQuerier) UnbanIP(_ context.Context, _ int64) error        { return nil }
func (s *stubAdminQuerier) ExtendBan(_ context.Context, _ int64) error      { return nil }
func (s *stubAdminQuerier) AddBannedIP(_ context.Context, _, _ string) error { return nil }
func (s *stubAdminQuerier) CreateBan(_ context.Context, _ db.CreateBanParams) (*models.UserBan, error) {
	return &models.UserBan{}, nil
}
func (s *stubAdminQuerier) GetActiveBan(_ context.Context, _ string) (*models.UserBan, error) {
	return nil, nil
}
func (s *stubAdminQuerier) PardonAllActiveBans(_ context.Context, _, _ string) error { return nil }
func (s *stubAdminQuerier) ListUserBans(_ context.Context, _ bool, _ db.PageInput) (*db.PageResult[models.UserBan], error) {
	return &db.PageResult[models.UserBan]{Items: []models.UserBan{}}, nil
}
func (s *stubAdminQuerier) GetDriveSummaries(_ context.Context) ([]models.DriveSummary, error) {
	return []models.DriveSummary{}, nil
}
func (s *stubAdminQuerier) GetMaxAvailableQuota(_ context.Context) (int64, error) { return 0, nil }
func (s *stubAdminQuerier) CountServersByState(_ context.Context, _ string) (int, error) {
	return 0, nil
}
func (s *stubAdminQuerier) CreateServer(_ context.Context, _ db.CreateServerParams) (*models.Server, error) {
	return nil, nil
}
func (s *stubAdminQuerier) SetServerActive(_ context.Context, _ uuid.UUID, _ bool) error { return nil }
func (s *stubAdminQuerier) GetServer(_ context.Context, _ uuid.UUID) (*models.Server, error) {
	return nil, nil
}
func (s *stubAdminQuerier) GetDrive(_ context.Context, _ uuid.UUID) (*models.Drive, error) {
	return nil, nil
}
func (s *stubAdminQuerier) CreateDrive(_ context.Context, _ db.CreateDriveParams) (*models.Drive, error) {
	return nil, nil
}
func (s *stubAdminQuerier) UpdateDrive(_ context.Context, _ uuid.UUID, _ db.UpdateDriveParams) (*models.Drive, error) {
	return nil, nil
}
// Alarm settings
func (s *stubAdminQuerier) GetAlarmSettings(_ context.Context) (*models.AlarmSettings, error) {
	if s.alarmSettings == nil && s.alarmSettingsErr == nil {
		return &models.AlarmSettings{
			CPUUsageEmails:       []string{},
			CPUTempEmails:        []string{},
			DriveTempEmails:      []string{},
			DriveLoadEmails:      []string{},
			NetworkTrafficEmails: []string{},
			APIErrorRateEmails:   []string{},
		}, nil
	}
	return s.alarmSettings, s.alarmSettingsErr
}
func (s *stubAdminQuerier) SetAlarmSubscription(_ context.Context, _, _ string, _ bool) (*models.AlarmSettings, error) {
	if s.subscriptionErr != nil {
		return nil, s.subscriptionErr
	}
	if s.alarmSettings != nil {
		return s.alarmSettings, nil
	}
	return &models.AlarmSettings{
		CPUUsageEmails:       []string{},
		CPUTempEmails:        []string{},
		DriveTempEmails:      []string{},
		DriveLoadEmails:      []string{},
		NetworkTrafficEmails: []string{},
		APIErrorRateEmails:   []string{},
	}, nil
}
func (s *stubAdminQuerier) ListSnapshotsWindow(_ context.Context, _ time.Duration) ([]models.ServerMetricSnapshot, error) {
	return []models.ServerMetricSnapshot{}, nil
}

func (s *stubAdminQuerier) ListInterestSubmissions(_ context.Context, _ db.PageInput) (*db.PageResult[models.InterestSubmission], error) {
	if s.submissionsErr != nil {
		return nil, s.submissionsErr
	}
	items := s.submissions
	if items == nil {
		items = []models.InterestSubmission{}
	}
	return &db.PageResult[models.InterestSubmission]{Items: items}, nil
}
func (s *stubAdminQuerier) GetInterestFormSettings(_ context.Context) (*models.InterestFormSettings, error) {
	if s.settings == nil && s.settingsErr == nil {
		return &models.InterestFormSettings{DailyCap: 100, UpdatedAt: time.Now()}, nil
	}
	return s.settings, s.settingsErr
}
func (s *stubAdminQuerier) UpdateInterestFormSettings(_ context.Context, dailyCap int) (*models.InterestFormSettings, error) {
	if s.updatedSettingsErr != nil {
		return nil, s.updatedSettingsErr
	}
	if s.updatedSettings != nil {
		return s.updatedSettings, nil
	}
	return &models.InterestFormSettings{DailyCap: dailyCap, UpdatedAt: time.Now()}, nil
}
func (s *stubAdminQuerier) GetInterestSubmissionByID(_ context.Context, _ uuid.UUID) (*models.InterestSubmission, error) {
	return s.singleSub, s.singleSubErr
}
func (s *stubAdminQuerier) MarkInterestSubmissionProvisioned(_ context.Context, _ uuid.UUID, _ uuid.UUID) error {
	return s.provisionErr
}

// ── Stub AdminInviteService ───────────────────────────────────────────────────

type stubAdminInviteService struct {
	inv    *models.Invitation
	invErr error
	invs   []models.Invitation
	resendErr error
	revokeErr error
}

func (s *stubAdminInviteService) Create(_ context.Context, _ uuid.UUID, _, _ string, _ int64, _ bool) (*models.Invitation, error) {
	return s.inv, s.invErr
}
func (s *stubAdminInviteService) List(_ context.Context, _ db.PageInput) (*db.PageResult[models.Invitation], error) {
	items := s.invs
	if items == nil {
		items = []models.Invitation{}
	}
	return &db.PageResult[models.Invitation]{Items: items}, nil
}
func (s *stubAdminInviteService) InvitationURL(token string) string {
	return "https://example.com/register?token=" + token
}
func (s *stubAdminInviteService) Resend(_ context.Context, _ uuid.UUID, _ string) error {
	return s.resendErr
}
func (s *stubAdminInviteService) Revoke(_ context.Context, _ uuid.UUID) error {
	return s.revokeErr
}

// ── Stub FileServicer ─────────────────────────────────────────────────────────

type stubFileService struct {
	file    *models.File
	fileErr error
	deleted bool
}

func (s *stubFileService) Upload(_ context.Context, _ services.UploadInput) (*models.File, error) {
	return s.file, s.fileErr
}
func (s *stubFileService) CheckQuota(_ context.Context, _ string, _ int64) error {
	return s.fileErr
}
func (s *stubFileService) GetMetadata(_ context.Context, _ uuid.UUID, _ uuid.UUID) (*models.File, error) {
	return s.file, s.fileErr
}
func (s *stubFileService) HasReadyVariant(_ context.Context, _ uuid.UUID) bool { return false }
func (s *stubFileService) Download(_ context.Context, _ uuid.UUID, _ uuid.UUID, _ string) (*models.File, []byte, error) {
	if s.fileErr != nil {
		return nil, nil, s.fileErr
	}
	return s.file, []byte("data"), nil
}
func (s *stubFileService) GetVariant(_ context.Context, _ uuid.UUID, _ string) (*models.VideoVariant, error) {
	return nil, services.ErrNotFound
}
func (s *stubFileService) DownloadRange(_ context.Context, _ *models.File, _ string, _, _ int64) ([]byte, error) {
	return []byte("range"), s.fileErr
}
func (s *stubFileService) DownloadChunked(_ context.Context, _ *models.File, _ string) ([]byte, error) {
	return []byte("chunked"), s.fileErr
}
func (s *stubFileService) Move(_ context.Context, _ uuid.UUID, _ uuid.UUID, _ uuid.UUID) (*models.File, error) {
	return s.file, s.fileErr
}
func (s *stubFileService) Rename(_ context.Context, _ uuid.UUID, _ uuid.UUID, _ string) (*models.File, error) {
	return s.file, s.fileErr
}
func (s *stubFileService) Delete(_ context.Context, _ uuid.UUID, _ uuid.UUID, _ string) error {
	s.deleted = true
	return s.fileErr
}
func (s *stubFileService) BeginChunkedUpload(_ context.Context, _ *services.UploadSession) error {
	return s.fileErr
}
func (s *stubFileService) EncryptAndUploadPart(_ context.Context, _ *services.UploadSession, _ int, _ []byte) {
}
func (s *stubFileService) FinalizeChunkedUpload(_ context.Context, _ *services.UploadSession) (*models.File, error) {
	return s.file, s.fileErr
}
func (s *stubFileService) AdminDeleteAllFiles(_ context.Context, _ string) error { return s.fileErr }

// ── Stub FolderServicer ───────────────────────────────────────────────────────

type stubFolderService struct {
	folder    *models.Folder
	folderErr error
	contents  *services.FolderContents
}

func (s *stubFolderService) ListRoot(_ context.Context, _ uuid.UUID, _, _ db.PageInput) (*services.FolderContents, error) {
	if s.contents != nil {
		return s.contents, nil
	}
	return &services.FolderContents{
		Subfolders: &db.PageResult[models.Folder]{Items: []models.Folder{}},
		Files:      &db.PageResult[models.File]{Items: []models.File{}},
	}, s.folderErr
}
func (s *stubFolderService) GetContents(_ context.Context, _, _ uuid.UUID, _, _ db.PageInput) (*services.FolderContents, error) {
	if s.folderErr != nil {
		return nil, s.folderErr
	}
	if s.contents != nil {
		return s.contents, nil
	}
	return &services.FolderContents{
		Folder:     s.folder,
		Subfolders: &db.PageResult[models.Folder]{Items: []models.Folder{}},
		Files:      &db.PageResult[models.File]{Items: []models.File{}},
	}, nil
}
func (s *stubFolderService) Create(_ context.Context, _ uuid.UUID, _ *uuid.UUID, _ string) (*models.Folder, error) {
	return s.folder, s.folderErr
}
func (s *stubFolderService) Rename(_ context.Context, _, _ uuid.UUID, _ string) (*models.Folder, error) {
	return s.folder, s.folderErr
}
func (s *stubFolderService) Move(_ context.Context, _, _, _ uuid.UUID) (*models.Folder, error) {
	return s.folder, s.folderErr
}
func (s *stubFolderService) Delete(_ context.Context, _, _ uuid.UUID) error {
	return s.folderErr
}

// ── Builder helpers ───────────────────────────────────────────────────────────

// newRoutesHandler builds a routes.Handler with nil services for the ones not
// under test. The captcha verifier always passes.
func newRoutesHandler(q routes.Querier, inv routes.InviteService) *routes.Handler {
	h := routes.NewHandler(q, nil, nil, nil, nil, nil, nil, nil, "test-secret")
	routes.SetInviteService(h, inv)
	routes.SetVerifyCaptcha(h, func(_, _, _ string) (bool, error) { return true, nil })
	return h
}

// newFileHandler builds a routes.Handler wired with the given file service stub.
func newFileHandler(fileSvc routes.FileServicer) *routes.Handler {
	return routes.NewHandler(&stubQuerier{}, fileSvc, nil, nil, nil, nil, nil, nil, "test-secret")
}

// newFolderHandler builds a routes.Handler wired with the given folder service stub.
func newFolderHandler(folderSvc routes.FolderServicer) *routes.Handler {
	return routes.NewHandler(&stubQuerier{}, nil, folderSvc, nil, nil, nil, nil, nil, "test-secret")
}

// newAdminHandler builds an admin.Handler with only querier and invite service set.
func newAdminHandler(q admin.AdminQuerier, inv admin.AdminInviteService) *admin.Handler {
	return admin.NewHandler(q, inv, nil, nil, nil, nil, nil, "", "", "", "", nil)
}

// newMetricsAdminHandler builds an admin.Handler wired with the given metrics stub.
func newMetricsAdminHandler(q admin.AdminQuerier, m admin.MetricsServicer) *admin.Handler {
	return admin.NewHandler(q, &stubAdminInviteService{}, m, nil, nil, nil, nil, "", "", "", "", nil)
}

// newAdminHandlerWithFiles builds an admin.Handler wired with the given file service stub.
func newAdminHandlerWithFiles(q admin.AdminQuerier, fileSvc routes.FileServicer) *admin.Handler {
	return admin.NewHandler(q, &stubAdminInviteService{}, nil, nil, fileSvc, nil, nil, "", "", "", "", nil)
}

// ── Stub MetricsService ───────────────────────────────────────────────────────

type stubMetricsService struct {
	latest     *models.ServerMetricSnapshot
	latestErr  error
	history    []models.ServerMetricSnapshot
	historyErr error
}

func (s *stubMetricsService) GetLatest(_ context.Context) (*models.ServerMetricSnapshot, error) {
	return s.latest, s.latestErr
}
func (s *stubMetricsService) GetHistory(_ context.Context, _ db.PageInput) (*db.PageResult[models.ServerMetricSnapshot], error) {
	items := s.history
	if items == nil {
		items = []models.ServerMetricSnapshot{}
	}
	return &db.PageResult[models.ServerMetricSnapshot]{Items: items}, s.historyErr
}
func (s *stubMetricsService) GetHistoryByHours(_ context.Context, _ int) ([]models.ServerMetricSnapshot, error) {
	return s.history, s.historyErr
}
func (s *stubMetricsService) GetHistoryByDate(_ context.Context, _ string, _ db.PageInput) (*db.PageResult[models.ServerMetricSnapshot], error) {
	items := s.history
	if items == nil {
		items = []models.ServerMetricSnapshot{}
	}
	return &db.PageResult[models.ServerMetricSnapshot]{Items: items}, s.historyErr
}
func (s *stubMetricsService) Hub() *services.Hub { return nil }

// ── Stub FavServicer ──────────────────────────────────────────────────────────

type stubFavService struct {
	list    *services.FavoriteList
	listErr error
}

func (s *stubFavService) List(_ context.Context, _ uuid.UUID) (*services.FavoriteList, error) {
	if s.list != nil {
		return s.list, s.listErr
	}
	return &services.FavoriteList{
		Files:   []models.File{},
		Folders: []models.Folder{},
	}, s.listErr
}
func (s *stubFavService) AddFile(_ context.Context, _, _ uuid.UUID) error    { return nil }
func (s *stubFavService) RemoveFile(_ context.Context, _, _ uuid.UUID) error { return nil }
func (s *stubFavService) AddFolder(_ context.Context, _, _ uuid.UUID) error  { return nil }
func (s *stubFavService) RemoveFolder(_ context.Context, _, _ uuid.UUID) error { return nil }

// newAdminBrowseHandler builds a routes.Handler wired for admin browse tests.
// kcResolver is injected in place of a real Keycloak lookup.
func newAdminBrowseHandler(
	q routes.Querier,
	folderSvc routes.FolderServicer,
	favSvc routes.FavServicer,
	kcResolver func(ctx context.Context, username string) (uuid.UUID, error),
) *routes.Handler {
	h := routes.NewHandler(q, nil, folderSvc, nil, favSvc, nil, nil, nil, "")
	routes.SetKcIDResolver(h, kcResolver)
	return h
}

// sampleUser returns a minimal populated User for tests.
func sampleUser() *models.User {
	return &models.User{
		Username:          "alice",
		Email:             "alice@example.com",
		StorageUsedBytes:  100,
		StorageQuotaBytes: 10 * 1024 * 1024 * 1024,
		CreatedAt:         time.Now(),
		IsAdmin:           false,
	}
}

// sampleBan returns a minimal UserBan of the given type ("banned" or "suspended").
func sampleBan(banType string) *models.UserBan {
	return &models.UserBan{
		ID:            1,
		Username:      "alice",
		BanType:       banType,
		ViolationCode: "spam",
		Comments:      "test ban",
		BannedBy:      "admin",
		BannedAt:      time.Now(),
	}
}

// sampleInvitation returns a minimal populated Invitation for tests.
func sampleInvitation() *models.Invitation {
	return &models.Invitation{
		ID:                uuid.New(),
		InvitedByUserID:   uuid.New(),
		Email:             "bob@example.com",
		Token:             "testtoken123",
		TokenExpiresAt:    time.Now().Add(48 * time.Hour),
		InitialQuotaBytes: 10 * 1024 * 1024 * 1024,
		CreatedAt:         time.Now(),
	}
}
