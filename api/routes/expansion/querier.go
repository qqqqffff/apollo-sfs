package expansion

import (
	"context"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// Querier is the subset of *db.Queries used by the expansion handler.
type Querier interface {
	GetUserByUsername(ctx context.Context, username string) (*models.User, error)
	GetServer(ctx context.Context, id uuid.UUID) (*models.Server, error)
	GetServerCapacity(ctx context.Context, serverID uuid.UUID) (*db.ServerCapacity, error)
	GetUserDrive(ctx context.Context, username string) (*models.UserDriveAllocation, error)
	GetDriveAvailableBytes(ctx context.Context, driveID uuid.UUID) (int64, error)
	AddUserQuota(ctx context.Context, username string, bytesAdded int64) (int64, error)
	ListAdminEmails(ctx context.Context) ([]string, error)

	CreateExpansionRequest(ctx context.Context, p db.CreateExpansionRequestParams) (*models.ServerExpansionRequest, error)
	GetExpansionRequestByID(ctx context.Context, id uuid.UUID) (*models.ServerExpansionRequest, error)
	GetExpansionRequestByPayPalOrderID(ctx context.Context, orderID string) (*models.ServerExpansionRequest, error)
	MarkExpansionRequestCaptured(ctx context.Context, orderID, captureID string) (bool, error)
	ApproveExpansionRequest(ctx context.Context, id uuid.UUID, expansionDueAt time.Time) (bool, error)
	ProvisionExpansionRequest(ctx context.Context, id uuid.UUID, postQuotaBytes int64) (bool, error)
	MarkExpansionRequestPaid(ctx context.Context, id uuid.UUID) (bool, error)
	ListExpansionRequests(ctx context.Context, f db.ExpansionRequestFilter, limit, offset int) ([]models.ServerExpansionRequest, int, error)
	ListUserExpansionRequests(ctx context.Context, username string) ([]models.ServerExpansionRequest, error)
	CancelExpansionRequest(ctx context.Context, id uuid.UUID, refundID, reason string) (bool, error)
	RejectExpansionRequest(ctx context.Context, id uuid.UUID, reason string) (bool, error)
	ExpireExpansionRequest(ctx context.Context, id uuid.UUID, refundID string) error
	ListExpiredOpenRequests(ctx context.Context) ([]models.ServerExpansionRequest, error)
	ListExpiredApprovedRequests(ctx context.Context) ([]models.ServerExpansionRequest, error)
	ListUnpaidExpandedRequests(ctx context.Context) ([]models.ServerExpansionRequest, error)
	MarkExpansionReminderSent(ctx context.Context, id uuid.UUID) error
	RevertExpansionRequest(ctx context.Context, id uuid.UUID) error
	CountFailedExpansionRequests(ctx context.Context, username string) (int, error)

	// Custom-request invoices.
	CreateExpansionInvoice(ctx context.Context, p db.CreateExpansionInvoiceParams) (*models.ExpansionInvoice, error)
	GetExpansionInvoiceByToken(ctx context.Context, token string) (*models.ExpansionInvoice, error)
	GetLatestExpansionInvoice(ctx context.Context, requestID uuid.UUID) (*models.ExpansionInvoice, error)
	AcceptExpansionInvoice(ctx context.Context, id uuid.UUID, paypalOrderID, paypalCaptureID *string) (bool, error)
	SetExpansionInvoiceStatus(ctx context.Context, id uuid.UUID, status string) error
	ListExpiredSentInvoices(ctx context.Context) ([]models.ExpansionInvoice, error)
	MarkExpansionInvoiceSent(ctx context.Context, id uuid.UUID) (bool, error)
	AcceptExpansionRequestInvoice(ctx context.Context, id uuid.UUID, depositCents, fullCents int64, paypalOrderID string, paypalCaptureID *string, approvalDueAt time.Time) (bool, error)
}

// addBusinessDays returns the time n business days (Mon–Fri) after from,
// preserving the time of day. Weekends do not count toward the SLA.
func addBusinessDays(from time.Time, n int) time.Time {
	t := from
	for n > 0 {
		t = t.AddDate(0, 0, 1)
		if wd := t.Weekday(); wd != time.Saturday && wd != time.Sunday {
			n--
		}
	}
	return t
}

// Compile-time check.
var _ Querier = (*db.Queries)(nil)
