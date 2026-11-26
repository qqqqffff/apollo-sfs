package models

import (
	"encoding/json"
	"math"
	"time"

	"github.com/google/uuid"
)

type AuditLog struct {
	ID             uuid.UUID  `json:"id"`
	TargetUsername string     `json:"target_username"`
	ActorUsername  string     `json:"actor_username"`
	Action         string     `json:"action"`
	ResourceType   *string    `json:"resource_type,omitempty"`
	ResourceID     *uuid.UUID `json:"resource_id,omitempty"`
	ResourceName   *string    `json:"resource_name,omitempty"`
	// Details is a generic, action-specific structured payload (e.g. the
	// storage allocation editor's before/after breakdown + reason — see
	// StorageAllocationChangeDetails). Raw passthrough since audit_logs
	// covers many action types; nil for every action that predates it.
	Details   json.RawMessage `json:"details,omitempty"`
	CreatedAt time.Time       `json:"created_at"`
}

// PremiumAuditDetails is the Details payload of the premium.granted /
// premium.revoked / premium.expired audit entries: why access changed and what
// it was attached to.
type PremiumAuditDetails struct {
	// Source is what lapsed or changed: "subscription" (PayPal-managed),
	// "self_billed" (card/wallet renewals we charge ourselves), or
	// "admin_trial" (an invitation/slot/admin-granted trial with an expiry).
	Source string `json:"source"`
	// Status is the subscription's new status, for subscription sources.
	Status string `json:"status,omitempty"`
	// Reason is a human-readable cause: the webhook event, an admin's reason,
	// "renewal payment failed", "trial period ended", …
	Reason string `json:"reason,omitempty"`
	Plan   string `json:"plan,omitempty"`
	// PeriodEnd is the end of the last paid period (subscriptions) or the
	// trial's expiry (admin trials).
	PeriodEnd *time.Time `json:"period_end,omitempty"`
}

// OperationAuditDetails is the Details payload attached to file and folder
// operations (uploads, renames, moves, deletes): how long the server took and,
// for uploads, how fast the bytes arrived.
type OperationAuditDetails struct {
	// DurationMS is wall-clock time from the request reaching the handler to
	// the operation being durably recorded, in milliseconds. For a chunked
	// upload it spans the whole session, from init to complete.
	DurationMS float64 `json:"duration_ms"`
	// SizeBytes is the plaintext size of an uploaded file.
	SizeBytes int64 `json:"size_bytes,omitempty"`
	// TransferMS is the time spent actually receiving the file's bytes —
	// excluding encryption/storage, and for a chunked upload excluding any
	// time it sat paused between chunks.
	TransferMS float64 `json:"transfer_ms,omitempty"`
	// AvgSpeedBps is SizeBytes / TransferMS, in bytes per second.
	AvgSpeedBps float64 `json:"avg_speed_bps,omitempty"`
	// Chunks is the number of parts a chunked upload arrived in.
	Chunks int `json:"chunks,omitempty"`
	// PreviousName is the old name of a renamed file or folder.
	PreviousName string `json:"previous_name,omitempty"`
	// Destination is the target folder of a move ("root" for the top level).
	Destination string `json:"destination,omitempty"`
}

// RequestFailureDetails is the Details payload of a failed-request audit entry
// (status >= 400), recorded by middleware.AuditFailures.
type RequestFailureDetails struct {
	Status     int     `json:"status"`
	Method     string  `json:"method"`
	Route      string  `json:"route"`
	Error      string  `json:"error,omitempty"`
	Cause      string  `json:"cause,omitempty"` // internal error, for 5xx responses
	DurationMS float64 `json:"duration_ms"`
	// Repeats counts identical failures folded into this entry instead of each
	// getting their own row (see middleware.AuditFailures).
	Repeats int `json:"repeats,omitempty"`
}

// Millis converts a duration to fractional milliseconds rounded to 0.1 ms —
// renames and moves often finish in well under one.
func Millis(d time.Duration) float64 {
	return math.Round(float64(d)/float64(time.Millisecond)*10) / 10
}

// NewOperationDetails times an operation that started at start.
func NewOperationDetails(start time.Time) OperationAuditDetails {
	return OperationAuditDetails{DurationMS: Millis(time.Since(start))}
}

// NewUploadDetails describes an upload of size bytes that started at start and
// spent transfer of that time receiving bytes.
func NewUploadDetails(start time.Time, transfer time.Duration, size int64) OperationAuditDetails {
	d := NewOperationDetails(start)
	d.SizeBytes = size
	if transfer > 0 {
		d.TransferMS = Millis(transfer)
		d.AvgSpeedBps = math.Round(float64(size) / transfer.Seconds())
	}
	return d
}

// JSON renders the details for db.AuditInput.Details.
func (d OperationAuditDetails) JSON() json.RawMessage {
	raw, _ := json.Marshal(d)
	return raw
}
