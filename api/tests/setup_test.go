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

const testPresignSecret = "test-presign-secret"

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
	depositOrder        *models.InterestDepositOrder
	depositOrderErr     error
	consumeOrderFail    bool
	consumeOrderErr     error
	dismissedIDs        map[string]bool
	dismissedIDsErr     error
	dismissErr          error
	dismissedCalls      [][]string
	expansionRequests   []models.ServerExpansionRequest
	activeSub           *models.PremiumSubscription
	activeSubErr        error
	// Admin storage allocation editor
	drive                 *models.Drive
	driveErr              error
	server                *models.Server
	serverErr             error
	driveAvailBytes       int64
	driveAvailErr         error
	storageAllocations    []db.UserStorageAllocation
	storageAllocationsErr error
	saveAllocationsTotal  int64
	saveAllocationsErr    error
	quotaChangeNotifErr   error
	recentQuotaChanges    []db.QuotaChangeNotification
	recentQuotaChangesErr error
	createFeedbackErr     error
}

func (s *stubQuerier) GetUserByUsername(_ context.Context, _ string) (*models.User, error) {
	return s.user, s.userErr
}
func (s *stubQuerier) GetActiveSubscriptionForUser(_ context.Context, _ string) (*models.PremiumSubscription, error) {
	return s.activeSub, s.activeSubErr
}
func (s *stubQuerier) GetActiveBan(_ context.Context, _ string) (*models.UserBan, error) {
	return s.activeBan, s.activeBanErr
}
func (s *stubQuerier) GetUserPreferences(_ context.Context, userID string) (*models.UserPreferences, error) {
	return &models.UserPreferences{UserID: userID}, nil
}
func (s *stubQuerier) SetMediaAutouploadFolder(_ context.Context, userID string, folderID *uuid.UUID) (*models.UserPreferences, error) {
	return &models.UserPreferences{UserID: userID, MediaAutouploadFolderID: folderID}, nil
}
func (s *stubQuerier) SetStorageUIPreferences(_ context.Context, userID string, showButtons, promptEnabled, hideBenchmarkPromo *bool) (*models.UserPreferences, error) {
	p := &models.UserPreferences{UserID: userID, ShowStorageButtons: true, StoragePromptEnabled: true}
	if showButtons != nil {
		p.ShowStorageButtons = *showButtons
	}
	if promptEnabled != nil {
		p.StoragePromptEnabled = *promptEnabled
	}
	if hideBenchmarkPromo != nil {
		p.HideBenchmarkPromo = *hideBenchmarkPromo
	}
	return p, nil
}
func (s *stubQuerier) ListNodeDiskBenchmarks(_ context.Context) ([]db.NodeDiskBenchmarkRow, error) {
	return nil, nil
}
func (s *stubQuerier) SetDefaultDrive(_ context.Context, userID string, driveID *uuid.UUID) (*models.UserPreferences, error) {
	return &models.UserPreferences{UserID: userID, DefaultDriveID: driveID}, nil
}
func (s *stubQuerier) GetUserDrives(_ context.Context, _, _ string) ([]db.UserDriveInfo, error) {
	return nil, nil
}
func (s *stubQuerier) CountActiveExpansionRequests(_ context.Context, _ string) (int, error) {
	return 0, nil
}
func (s *stubQuerier) ListUserExpansionRequests(_ context.Context, _ string) ([]models.ServerExpansionRequest, error) {
	return s.expansionRequests, nil
}
func (s *stubQuerier) GetLatestExpansionInvoice(_ context.Context, _ uuid.UUID) (*models.ExpansionInvoice, error) {
	return nil, nil
}
func (s *stubQuerier) ListSharesForRecipient(_ context.Context, _ string) ([]models.Share, error) {
	return nil, nil
}
func (s *stubQuerier) ListRecentAdminCancelledSubscriptionsForUser(_ context.Context, _ string, _ time.Time) ([]models.PremiumSubscription, error) {
	return nil, nil
}
func (s *stubQuerier) ListRecentlyAcceptedInvitations(_ context.Context, _ time.Time) ([]models.Invitation, error) {
	return nil, nil
}
func (s *stubQuerier) ListRecentCapturedOrders(_ context.Context, _ time.Time, _ int) ([]db.AdminOrder, error) {
	return nil, nil
}
func (s *stubQuerier) ListRecentUnreadInboundEmails(_ context.Context, _ time.Time, _ int) ([]models.InboundEmail, error) {
	return nil, nil
}
func (s *stubQuerier) ListRecentlyFiredAlarmSubscriptions(_ context.Context, _ time.Time) ([]models.AlarmSubscription, error) {
	return nil, nil
}
func (s *stubQuerier) ListDismissedNotificationIDs(_ context.Context, _ string) (map[string]bool, error) {
	if s.dismissedIDsErr != nil {
		return nil, s.dismissedIDsErr
	}
	if s.dismissedIDs == nil {
		return map[string]bool{}, nil
	}
	return s.dismissedIDs, nil
}
func (s *stubQuerier) DismissNotifications(_ context.Context, _ string, ids []string) error {
	if s.dismissErr != nil {
		return s.dismissErr
	}
	s.dismissedCalls = append(s.dismissedCalls, ids)
	return nil
}
func (s *stubQuerier) CreatePasswordChangeCode(_ context.Context, _, _ string, _ time.Time) error {
	return nil
}
func (s *stubQuerier) ConsumePasswordChangeCode(_ context.Context, _, _ string) (bool, error) {
	return true, nil
}
func (s *stubQuerier) GetUserStorageBreakdown(_ context.Context, _ string) (db.UserStorageBreakdown, error) {
	return db.UserStorageBreakdown{}, nil
}
func (s *stubQuerier) GetUserStorageAllocations(_ context.Context, _, _ string) ([]db.UserStorageAllocation, error) {
	return s.storageAllocations, s.storageAllocationsErr
}
func (s *stubQuerier) GetDrive(_ context.Context, _ uuid.UUID) (*models.Drive, error) {
	return s.drive, s.driveErr
}
func (s *stubQuerier) GetServer(_ context.Context, _ uuid.UUID) (*models.Server, error) {
	return s.server, s.serverErr
}
func (s *stubQuerier) GetDriveAvailableBytes(_ context.Context, _ uuid.UUID) (int64, error) {
	return s.driveAvailBytes, s.driveAvailErr
}
func (s *stubQuerier) SaveUserDriveAllocations(_ context.Context, _ string, _ []db.SaveAllocationsParams) (int64, error) {
	return s.saveAllocationsTotal, s.saveAllocationsErr
}
func (s *stubQuerier) InsertQuotaChangeNotification(_ context.Context, _ db.InsertQuotaChangeNotificationParams) error {
	return s.quotaChangeNotifErr
}
func (s *stubQuerier) ListRecentQuotaChangeNotificationsForUser(_ context.Context, _ string, _ time.Time) ([]db.QuotaChangeNotification, error) {
	return s.recentQuotaChanges, s.recentQuotaChangesErr
}
func (s *stubQuerier) ListRecentEmailBackupRunsForUser(_ context.Context, _ string, _ time.Time) ([]models.EmailBackupRun, error) {
	return nil, nil
}
func (s *stubQuerier) GetLastGoogleBackupSync(_ context.Context, _ uuid.UUID) (*time.Time, error) {
	return nil, nil
}
func (s *stubQuerier) GetLastEmailBackupSync(_ context.Context, _ string) (*time.Time, error) {
	return nil, nil
}
func (s *stubQuerier) SetBackupStaleNotify(_ context.Context, _ string, enabled bool) (*models.UserPreferences, error) {
	return &models.UserPreferences{BackupStaleNotify: enabled, ShowStorageButtons: true, StoragePromptEnabled: true}, nil
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
func (s *stubQuerier) CreateInterestDepositOrder(_ context.Context, _ *models.InterestDepositOrder) error {
	return nil
}
func (s *stubQuerier) MarkInterestDepositOrderCaptured(_ context.Context, _, _ string) error {
	return nil
}
func (s *stubQuerier) GetInterestDepositOrder(_ context.Context, orderID string) (*models.InterestDepositOrder, error) {
	if s.depositOrderErr != nil {
		return nil, s.depositOrderErr
	}
	if s.depositOrder != nil {
		return s.depositOrder, nil
	}
	// Default: a captured deposit matching the 64gb/nvme plan used by the
	// test helpers, so tests that don't care about the deposit flow pass.
	capturedAt := time.Now()
	captureID := "CAP-TEST"
	return &models.InterestDepositOrder{
		OrderID: orderID, PlanID: "64gb", StorageType: "nvme",
		FullPriceCents: 3000, DepositAmountCents: 1500,
		Currency: "USD", PaymentMethod: "paypal",
		PayPalCaptureID: &captureID, CapturedAt: &capturedAt,
	}, nil
}
func (s *stubQuerier) ConsumeInterestDepositOrder(_ context.Context, _ string) (bool, error) {
	if s.consumeOrderErr != nil {
		return false, s.consumeOrderErr
	}
	if s.consumeOrderFail {
		return false, nil
	}
	return true, nil
}
func (s *stubQuerier) SearchFoldersByUser(_ context.Context, _ uuid.UUID, _ string, _ db.PageInput) (*db.PageResult[models.Folder], error) {
	return &db.PageResult[models.Folder]{}, nil
}
func (s *stubQuerier) SearchFilesByUser(_ context.Context, _ uuid.UUID, _ string, _ db.PageInput) (*db.PageResult[models.File], error) {
	return &db.PageResult[models.File]{}, nil
}
func (s *stubQuerier) SearchRecognitionGroupsByUser(_ context.Context, _ uuid.UUID, _ string, _ db.PageInput) (*db.PageResult[db.RecognitionGroupSearchHit], error) {
	return &db.PageResult[db.RecognitionGroupSearchHit]{Items: []db.RecognitionGroupSearchHit{}}, nil
}
func (s *stubQuerier) InsertAuditLog(_ context.Context, _ db.AuditInput) error { return nil }
func (s *stubQuerier) ListAuditLogsForUser(_ context.Context, _ string, _ db.PageInput) (*db.PageResult[models.AuditLog], error) {
	return &db.PageResult[models.AuditLog]{Items: []models.AuditLog{}}, nil
}

// Device / sync stubs (mobile)
func (s *stubQuerier) CreateDevice(_ context.Context, userID uuid.UUID, name, platform string, pushToken *string) (*db.Device, error) {
	return &db.Device{ID: uuid.New(), UserID: userID, Name: name, Platform: platform}, nil
}
func (s *stubQuerier) GetDevice(_ context.Context, id uuid.UUID) (*db.Device, error) {
	return &db.Device{ID: id}, nil
}
func (s *stubQuerier) UpdateDeviceLastSeen(_ context.Context, _ uuid.UUID, _ *string) error {
	return nil
}
func (s *stubQuerier) DeleteDevice(_ context.Context, _ uuid.UUID) error { return nil }
func (s *stubQuerier) ListDevicesByUser(_ context.Context, _ uuid.UUID) ([]db.Device, error) {
	return []db.Device{}, nil
}
func (s *stubQuerier) DeltaSyncFiles(_ context.Context, _ uuid.UUID, _ time.Time) ([]models.File, error) {
	return []models.File{}, nil
}
func (s *stubQuerier) DeltaSyncDeleted(_ context.Context, _ uuid.UUID, _ time.Time) ([]uuid.UUID, error) {
	return []uuid.UUID{}, nil
}
func (s *stubQuerier) FindFileByHash(_ context.Context, _ uuid.UUID, _ string) (*models.File, error) {
	return nil, nil
}
func (s *stubQuerier) CreateFeedback(_ context.Context, userID uuid.UUID, username, category, message string) (*models.Feedback, error) {
	if s.createFeedbackErr != nil {
		return nil, s.createFeedbackErr
	}
	return &models.Feedback{
		ID:        uuid.New(),
		UserID:    userID,
		Username:  username,
		Category:  category,
		Message:   message,
		Status:    "new",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}, nil
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
	users              []models.User
	user               *models.User
	userErr            error
	submissions        []models.InterestSubmission
	submissionsErr     error
	singleSub          *models.InterestSubmission
	singleSubErr       error
	settings           *models.InterestFormSettings
	settingsErr        error
	updatedSettings    *models.InterestFormSettings
	updatedSettingsErr error
	provisionErr       error
	denyErr            error
	// drive / quota fields
	userDrive      *models.UserDriveAllocation
	userDriveErr   error
	driveAvail     int64
	driveAvailErr  error
	updateQuotaErr error
	// alarm subscription fields
	alarmSubs       []models.AlarmSubscription
	alarmSubsErr    error
	subscriptionErr error
	// feedback review fields
	feedback             []models.Feedback
	feedbackErr          error
	updateFeedbackErr    error
	setFeedbackAccessErr error
	// test-runner run history fields
	createdTestRuns           []models.TestRun
	createTestRunErr          error
	latestTestRunForBranch    map[string]*models.TestRun
	latestTestRunForBranchErr error
	latestTestRunOverall      *models.TestRun
	latestTestRunOverallErr   error
}

func (s *stubAdminQuerier) ListUsers(_ context.Context, _ db.PageInput) (*db.PageResult[models.User], error) {
	items := s.users
	if items == nil {
		items = []models.User{}
	}
	return &db.PageResult[models.User]{Items: items}, nil
}
func (s *stubAdminQuerier) ListAdminUsers(_ context.Context, _ db.ListUsersFilter, _, _ int) ([]models.User, int, error) {
	if s.userErr != nil {
		return nil, 0, s.userErr
	}
	items := s.users
	if items == nil {
		items = []models.User{}
	}
	return items, len(items), nil
}
func (s *stubAdminQuerier) GetUserByUsername(_ context.Context, _ string) (*models.User, error) {
	return s.user, s.userErr
}
func (s *stubAdminQuerier) UpdateUserQuota(_ context.Context, _ string, _ int64) error {
	return s.updateQuotaErr
}
func (s *stubAdminQuerier) SetUserFeedbackAccess(_ context.Context, _ string, _ bool) error {
	return s.setFeedbackAccessErr
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
func (s *stubAdminQuerier) UnbanIP(_ context.Context, _ int64) error         { return nil }
func (s *stubAdminQuerier) ExtendBan(_ context.Context, _ int64) error       { return nil }
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
func (s *stubAdminQuerier) ListPricingServers(_ context.Context) ([]db.PricingServer, error) {
	return []db.PricingServer{}, nil
}
func (s *stubAdminQuerier) ListPricingItems(_ context.Context, _ uuid.UUID) ([]models.PricingItem, error) {
	return []models.PricingItem{}, nil
}
func (s *stubAdminQuerier) GetPricingItem(_ context.Context, _ uuid.UUID) (*models.PricingItem, error) {
	return nil, nil
}
func (s *stubAdminQuerier) CreatePricingItem(_ context.Context, _ db.CreatePricingItemParams) (*models.PricingItem, error) {
	return &models.PricingItem{ID: uuid.New()}, nil
}
func (s *stubAdminQuerier) UpdatePricingItem(_ context.Context, _ uuid.UUID, _ int64, _, _ int) (*models.PricingItem, error) {
	return nil, nil
}
func (s *stubAdminQuerier) DeletePricingItem(_ context.Context, _ uuid.UUID) error { return nil }
func (s *stubAdminQuerier) ListActivePricingDiscounts(_ context.Context, _ uuid.UUID) ([]models.PricingDiscount, error) {
	return []models.PricingDiscount{}, nil
}
func (s *stubAdminQuerier) CreatePricingDiscount(_ context.Context, _ *models.PricingDiscount) error {
	return nil
}
func (s *stubAdminQuerier) DeletePricingDiscount(_ context.Context, _ uuid.UUID) error { return nil }
func (s *stubAdminQuerier) ListDiscountRecipients(_ context.Context, _ string, _ uuid.UUID, _ string, _ bool) ([]string, error) {
	return nil, nil
}
func (s *stubAdminQuerier) GetMaxAvailableQuota(_ context.Context) (int64, error) { return 0, nil }
func (s *stubAdminQuerier) CountServersByState(_ context.Context, _ string) (int, error) {
	return 0, nil
}
func (s *stubAdminQuerier) CreateServer(_ context.Context, _ db.CreateServerParams) (*models.Server, error) {
	return nil, nil
}
func (s *stubAdminQuerier) SetServerActive(_ context.Context, _ uuid.UUID, _ bool) error { return nil }
func (s *stubAdminQuerier) RenameServer(_ context.Context, _ uuid.UUID, _ string) error  { return nil }
func (s *stubAdminQuerier) GetServer(_ context.Context, _ uuid.UUID) (*models.Server, error) {
	return nil, nil
}
func (s *stubAdminQuerier) GetServerByEndpoint(_ context.Context, _ string) (*models.Server, error) {
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
func (s *stubAdminQuerier) UpsertDrive(_ context.Context, _ db.UpsertDriveParams) (*models.Drive, error) {
	return &models.Drive{ID: uuid.New()}, nil
}
func (s *stubAdminQuerier) DeleteDrive(_ context.Context, _ uuid.UUID) error { return nil }
func (s *stubAdminQuerier) DeactivateMissingDrives(_ context.Context, _ uuid.UUID, _ []uuid.UUID) error {
	return nil
}
func (s *stubAdminQuerier) UpdateDriveCapacity(_ context.Context, _ uuid.UUID, _ int64) (*models.Drive, error) {
	return nil, nil
}
func (s *stubAdminQuerier) AutoSyncDriveCapacities(_ context.Context, _ int64) error { return nil }
func (s *stubAdminQuerier) ListServers(_ context.Context) ([]models.Server, error) {
	return nil, nil
}
func (s *stubAdminQuerier) DeleteServer(_ context.Context, _ uuid.UUID) error { return nil }
func (s *stubAdminQuerier) ListDrives(_ context.Context, _ uuid.UUID) ([]models.Drive, error) {
	return nil, nil
}
func (s *stubAdminQuerier) AdoptNodeDrive(_ context.Context, _, _ uuid.UUID, _ db.UpsertDriveParams) (*models.Drive, error) {
	return nil, nil
}
func (s *stubAdminQuerier) ReassignDriveToServer(_ context.Context, _, _ uuid.UUID, _ *uuid.UUID) error {
	return nil
}
func (s *stubAdminQuerier) ListAllNodeDisks(_ context.Context) ([]models.NodeDisk, error) {
	return nil, nil
}

// Drive benchmark
func (s *stubAdminQuerier) RequestBenchmarkOnAllNodes(_ context.Context) error { return nil }
func (s *stubAdminQuerier) CountPendingBenchmarkRequests(_ context.Context) (int, error) {
	return 0, nil
}
func (s *stubAdminQuerier) CountActiveNodes(_ context.Context) (int, error) {
	return 0, nil
}
func (s *stubAdminQuerier) ListNodeDiskBenchmarks(_ context.Context) ([]db.NodeDiskBenchmarkRow, error) {
	return nil, nil
}

// Nodes
func (s *stubAdminQuerier) GetNodeSummaries(_ context.Context) ([]models.NodeSummary, error) {
	return []models.NodeSummary{}, nil
}
func (s *stubAdminQuerier) GetNode(_ context.Context, _ uuid.UUID) (*models.Node, error) {
	return nil, nil
}
func (s *stubAdminQuerier) CreateNode(_ context.Context, _ db.CreateNodeParams) (*models.Node, error) {
	return nil, nil
}
func (s *stubAdminQuerier) UpdateNode(_ context.Context, _ uuid.UUID, _ db.UpdateNodeParams) (*models.Node, error) {
	return nil, nil
}
func (s *stubAdminQuerier) UpsertNode(_ context.Context, p db.CreateNodeParams, isActive bool) (*models.Node, error) {
	return &models.Node{ID: uuid.New(), ServerID: p.ServerID, Hostname: p.Hostname, Role: p.Role, Address: p.Address, IsActive: isActive}, nil
}
func (s *stubAdminQuerier) DeleteNode(_ context.Context, _ uuid.UUID) error { return nil }
func (s *stubAdminQuerier) DeactivateMissingNodes(_ context.Context, _ uuid.UUID, _ []uuid.UUID) error {
	return nil
}
func (s *stubAdminQuerier) AssignDriveToNode(_ context.Context, _ uuid.UUID, _ *uuid.UUID) error {
	return nil
}

// Alarm subscriptions
func (s *stubAdminQuerier) ListAlarmSubscriptions(_ context.Context) ([]models.AlarmSubscription, error) {
	return s.alarmSubs, s.alarmSubsErr
}
func (s *stubAdminQuerier) ListAlarmSubscriptionsByEmail(_ context.Context, _ string) ([]models.AlarmSubscription, error) {
	return s.alarmSubs, s.alarmSubsErr
}
func (s *stubAdminQuerier) UpsertAlarmSubscription(_ context.Context, email, alarmType string, nodeID, driveID *uuid.UUID, threshold float64) (*models.AlarmSubscription, error) {
	if s.subscriptionErr != nil {
		return nil, s.subscriptionErr
	}
	return &models.AlarmSubscription{
		ID:        uuid.New(),
		Email:     email,
		AlarmType: alarmType,
		NodeID:    nodeID,
		DriveID:   driveID,
		Threshold: threshold,
	}, nil
}
func (s *stubAdminQuerier) DeleteAlarmSubscription(_ context.Context, _, _ string, _, _ *uuid.UUID) error {
	return s.subscriptionErr
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
func (s *stubAdminQuerier) DenyInterestSubmission(_ context.Context, _ uuid.UUID, _ string) error {
	return s.denyErr
}
func (s *stubAdminQuerier) ListFeedback(_ context.Context, _ string, _ db.PageInput) (*db.PageResult[models.Feedback], error) {
	items := s.feedback
	if items == nil {
		items = []models.Feedback{}
	}
	return &db.PageResult[models.Feedback]{Items: items}, s.feedbackErr
}
func (s *stubAdminQuerier) UpdateFeedbackStatus(_ context.Context, id uuid.UUID, status string) (*models.Feedback, error) {
	if s.updateFeedbackErr != nil {
		return nil, s.updateFeedbackErr
	}
	return &models.Feedback{ID: id, Status: status}, nil
}

func (s *stubAdminQuerier) GetLatestReconciliationRun(_ context.Context) (*models.ReconciliationRun, error) {
	return nil, nil
}
func (s *stubAdminQuerier) ListReconciliationFindings(_ context.Context, _ *uuid.UUID, _ int) ([]models.ReconciliationFinding, error) {
	return nil, nil
}

func (s *stubAdminQuerier) CreateTestRun(_ context.Context, version, branch string, report models.TestRunReport, passed bool) (*models.TestRun, error) {
	if s.createTestRunErr != nil {
		return nil, s.createTestRunErr
	}
	run := models.TestRun{
		ID:                uuid.New(),
		DeploymentVersion: version,
		GitBranch:         branch,
		Report:            report,
		Passed:            passed,
		CreatedAt:         time.Now(),
	}
	s.createdTestRuns = append(s.createdTestRuns, run)
	return &run, nil
}
func (s *stubAdminQuerier) GetLatestTestRunForBranch(_ context.Context, branch string) (*models.TestRun, error) {
	if s.latestTestRunForBranchErr != nil {
		return nil, s.latestTestRunForBranchErr
	}
	return s.latestTestRunForBranch[branch], nil
}
func (s *stubAdminQuerier) GetLatestTestRun(_ context.Context) (*models.TestRun, error) {
	return s.latestTestRunOverall, s.latestTestRunOverallErr
}

// ── Stub AdminInviteService ───────────────────────────────────────────────────

type stubAdminInviteService struct {
	inv       *models.Invitation
	invErr    error
	invs      []models.Invitation
	resendErr error
	revokeErr error
}

func (s *stubAdminInviteService) Create(_ context.Context, _ uuid.UUID, _, _ string, _ int64, _ bool, _ bool, _ *uuid.UUID) (*models.Invitation, error) {
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
	file      *models.File
	fileErr   error
	deleted   bool
	migration *models.FolderDriveMigration
	migStatus *services.DriveMigrationStatus
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
func (s *stubFileService) SetHidden(_ context.Context, _ uuid.UUID, _ uuid.UUID, _ bool) (*models.File, error) {
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
func (s *stubFileService) RequestDriveMigration(_ context.Context, _ uuid.UUID, _ string, _, _ uuid.UUID, _ *uuid.UUID) (*models.FolderDriveMigration, error) {
	return s.migration, s.fileErr
}
func (s *stubFileService) GetLatestDriveMigration(_ context.Context, _, _ uuid.UUID) (*services.DriveMigrationStatus, error) {
	return s.migStatus, s.fileErr
}

// ── Stub FolderServicer ───────────────────────────────────────────────────────

type stubFolderService struct {
	folder    *models.Folder
	folderErr error
	contents  *services.FolderContents
}

func (s *stubFolderService) ListRoot(_ context.Context, _ uuid.UUID, _, _ db.PageInput, _ *services.DriveFilter) (*services.FolderContents, error) {
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
func (s *stubFolderService) GetMediaContents(_ context.Context, _, _ uuid.UUID, _ db.MediaSort, _ db.HiddenFilter, _, _ db.PageInput) (*services.FolderContents, error) {
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
func (s *stubFolderService) Create(_ context.Context, _ uuid.UUID, _ *uuid.UUID, _, _, _ string, _ *uuid.UUID) (*models.Folder, error) {
	return s.folder, s.folderErr
}
func (s *stubFolderService) Rename(_ context.Context, _, _ uuid.UUID, _ string) (*models.Folder, error) {
	return s.folder, s.folderErr
}
func (s *stubFolderService) Move(_ context.Context, _, _, _ uuid.UUID, _ string) (*models.Folder, error) {
	return s.folder, s.folderErr
}
func (s *stubFolderService) Delete(_ context.Context, _, _ uuid.UUID) error {
	return s.folderErr
}
func (s *stubFolderService) CopyToSubcollection(_ context.Context, _, _, _ uuid.UUID) error {
	return s.folderErr
}
func (s *stubFolderService) MoveSubcollectionItem(_ context.Context, _, _, _, _ uuid.UUID) error {
	return s.folderErr
}
func (s *stubFolderService) RemoveFromSubcollection(_ context.Context, _, _, _ uuid.UUID) error {
	return s.folderErr
}
func (s *stubFolderService) GetAncestors(_ context.Context, _, _ uuid.UUID) ([]models.Folder, error) {
	return nil, s.folderErr
}

// ── Builder helpers ───────────────────────────────────────────────────────────

// newRoutesHandler builds a routes.Handler with nil services for the ones not
// under test. The captcha verifier always passes.
func newRoutesHandler(q routes.Querier, inv routes.InviteService) *routes.Handler {
	h := routes.NewHandler(q, nil, nil, nil, nil, nil, nil, nil, nil, "test-secret")
	routes.SetInviteService(h, inv)
	routes.SetVerifyCaptcha(h, func(_, _, _ string) (bool, error) { return true, nil })
	return h
}

// newFileHandler builds a routes.Handler wired with the given file service stub.
func newFileHandler(fileSvc routes.FileServicer) *routes.Handler {
	return routes.NewHandler(&stubQuerier{}, fileSvc, nil, nil, nil, nil, nil, nil, nil, "test-secret")
}

// newFileHandlerWithPresign builds a routes.Handler wired with the given file
// service stub and a real PresignService keyed with testPresignSecret.
func newFileHandlerWithPresign(fileSvc routes.FileServicer) *routes.Handler {
	return routes.NewHandler(&stubQuerier{}, fileSvc, nil, nil, nil, nil, nil, nil, services.NewPresignService(testPresignSecret), "test-secret")
}

// newFolderHandler builds a routes.Handler wired with the given folder service stub.
func newFolderHandler(folderSvc routes.FolderServicer) *routes.Handler {
	return routes.NewHandler(&stubQuerier{}, nil, folderSvc, nil, nil, nil, nil, nil, nil, "test-secret")
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
	latest           *models.ServerMetricSnapshot
	latestErr        error
	history          []models.ServerMetricSnapshot
	historyErr       error
	nodeHistory      []models.NodeMetricSnapshot
	nodeHistoryErr   error
	driveTemps       []models.DriveTempSnapshot
	driveTempsErr    error
	nodeDisks        []models.NodeDisk
	nodeDisksErr     error
	nodeDiskTemps    []models.NodeDiskTempSnapshot
	nodeDiskTempsErr error
	driveIO          []models.DriveIOSnapshot
	driveIOErr       error
	nodeDiskIO       []models.NodeDiskIOSnapshot
	nodeDiskIOErr    error
	nodeStates       []models.NodeFrame
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
func (s *stubMetricsService) GetNodeHistoryByHours(_ context.Context, _ uuid.UUID, _ int) ([]models.NodeMetricSnapshot, error) {
	return s.nodeHistory, s.nodeHistoryErr
}
func (s *stubMetricsService) GetDriveTempHistoryByHours(_ context.Context, _ uuid.UUID, _ int) ([]models.DriveTempSnapshot, error) {
	return s.driveTemps, s.driveTempsErr
}
func (s *stubMetricsService) GetNodeDisks(_ context.Context, _ uuid.UUID) ([]models.NodeDisk, error) {
	return s.nodeDisks, s.nodeDisksErr
}
func (s *stubMetricsService) GetNodeDiskTempHistoryByHours(_ context.Context, _ uuid.UUID, _ int) ([]models.NodeDiskTempSnapshot, error) {
	return s.nodeDiskTemps, s.nodeDiskTempsErr
}
func (s *stubMetricsService) GetDriveIOHistoryByHours(_ context.Context, _ uuid.UUID, _ int) ([]models.DriveIOSnapshot, error) {
	return s.driveIO, s.driveIOErr
}
func (s *stubMetricsService) GetNodeDiskIOHistoryByHours(_ context.Context, _ uuid.UUID, _ int) ([]models.NodeDiskIOSnapshot, error) {
	return s.nodeDiskIO, s.nodeDiskIOErr
}
func (s *stubMetricsService) NodeStates(_ context.Context) ([]models.NodeFrame, error) {
	return s.nodeStates, nil
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
func (s *stubFavService) AddFile(_ context.Context, _, _ uuid.UUID) error      { return nil }
func (s *stubFavService) RemoveFile(_ context.Context, _, _ uuid.UUID) error   { return nil }
func (s *stubFavService) AddFolder(_ context.Context, _, _ uuid.UUID) error    { return nil }
func (s *stubFavService) RemoveFolder(_ context.Context, _, _ uuid.UUID) error { return nil }

// newAdminBrowseHandler builds a routes.Handler wired for admin browse tests.
// kcResolver is injected in place of a real Keycloak lookup.
func newAdminBrowseHandler(
	q routes.Querier,
	folderSvc routes.FolderServicer,
	favSvc routes.FavServicer,
	kcResolver func(ctx context.Context, username string) (uuid.UUID, error),
) *routes.Handler {
	h := routes.NewHandler(q, nil, folderSvc, nil, favSvc, nil, nil, nil, nil, "")
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
