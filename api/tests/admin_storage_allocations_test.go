package tests

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

func TestAdminUpdateUserStorageAllocations_Success(t *testing.T) {
	driveID := uuid.New()
	q := &stubQuerier{
		user: sampleUser(),
		storageAllocations: []db.UserStorageAllocation{
			{DriveID: driveID, ServerName: "Manager", DriveType: "hdd", DriveLabel: "hdd-01", CapacityBytes: 1000, QuotaBytes: 100, UserUsedBytes: 10, IsPrimary: true},
		},
		driveAvailBytes:      150, // headroom for growing 100 -> 200
		saveAllocationsTotal: 200,
	}
	h := browsHandler(q, nil, nil, okKcResolver)

	r := newEngine()
	r.PUT("/admin/users/:user_id/storage/allocations", h.AdminUpdateUserStorageAllocations)

	body := jsonBody(map[string]any{
		"allocations": []map[string]any{{"drive_id": driveID.String(), "quota_bytes": 200}},
		"reason":      "growing them a bit",
	})
	req := httptest.NewRequest(http.MethodPut, "/admin/users/alice/storage/allocations", body)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAdminUpdateUserStorageAllocations_RemovalBlockedWhenUsedNonZero(t *testing.T) {
	kept := uuid.New()
	removed := uuid.New()
	q := &stubQuerier{
		user: sampleUser(),
		storageAllocations: []db.UserStorageAllocation{
			{DriveID: kept, ServerName: "Manager", DriveType: "hdd", CapacityBytes: 1000, QuotaBytes: 100, UserUsedBytes: 10, IsPrimary: true},
			{DriveID: removed, ServerName: "Pi5", DriveType: "nvme", CapacityBytes: 500, QuotaBytes: 50, UserUsedBytes: 5, IsPrimary: false},
		},
	}
	h := browsHandler(q, nil, nil, okKcResolver)

	r := newEngine()
	r.PUT("/admin/users/:user_id/storage/allocations", h.AdminUpdateUserStorageAllocations)

	// Omits `removed`, which still has 5 bytes used — must be blocked.
	body := jsonBody(map[string]any{
		"allocations": []map[string]any{{"drive_id": kept.String(), "quota_bytes": 100}},
	})
	req := httptest.NewRequest(http.MethodPut, "/admin/users/alice/storage/allocations", body)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	decodeBody(w, &resp) //nolint
	violations, _ := resp["violations"].([]any)
	if len(violations) != 1 {
		t.Fatalf("expected 1 violation, got %d", len(violations))
	}
	v, _ := violations[0].(map[string]any)
	if v["code"] != "removal_blocked" {
		t.Errorf("expected code=removal_blocked, got %v", v["code"])
	}
}

func TestAdminUpdateUserStorageAllocations_RemovalAllowedWhenUsedZero(t *testing.T) {
	kept := uuid.New()
	removed := uuid.New()
	q := &stubQuerier{
		user: sampleUser(),
		storageAllocations: []db.UserStorageAllocation{
			{DriveID: kept, ServerName: "Manager", DriveType: "hdd", CapacityBytes: 1000, QuotaBytes: 100, UserUsedBytes: 10, IsPrimary: true},
			{DriveID: removed, ServerName: "Pi5", DriveType: "nvme", CapacityBytes: 500, QuotaBytes: 50, UserUsedBytes: 0, IsPrimary: false},
		},
		saveAllocationsTotal: 100,
	}
	h := browsHandler(q, nil, nil, okKcResolver)

	r := newEngine()
	r.PUT("/admin/users/:user_id/storage/allocations", h.AdminUpdateUserStorageAllocations)

	body := jsonBody(map[string]any{
		"allocations": []map[string]any{{"drive_id": kept.String(), "quota_bytes": 100}},
	})
	req := httptest.NewRequest(http.MethodPut, "/admin/users/alice/storage/allocations", body)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAdminUpdateUserStorageAllocations_QuotaBelowUsed(t *testing.T) {
	driveID := uuid.New()
	q := &stubQuerier{
		user: sampleUser(),
		storageAllocations: []db.UserStorageAllocation{
			{DriveID: driveID, ServerName: "Manager", DriveType: "hdd", CapacityBytes: 1000, QuotaBytes: 100, UserUsedBytes: 50, IsPrimary: true},
		},
	}
	h := browsHandler(q, nil, nil, okKcResolver)

	r := newEngine()
	r.PUT("/admin/users/:user_id/storage/allocations", h.AdminUpdateUserStorageAllocations)

	body := jsonBody(map[string]any{
		"allocations": []map[string]any{{"drive_id": driveID.String(), "quota_bytes": 40}},
	})
	req := httptest.NewRequest(http.MethodPut, "/admin/users/alice/storage/allocations", body)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	decodeBody(w, &resp) //nolint
	violations, _ := resp["violations"].([]any)
	if len(violations) != 1 {
		t.Fatalf("expected 1 violation, got %d", len(violations))
	}
	v, _ := violations[0].(map[string]any)
	if v["code"] != "used_exceeds_quota" {
		t.Errorf("expected code=used_exceeds_quota, got %v", v["code"])
	}
}

func TestAdminUpdateUserStorageAllocations_QuotaExactlyAtUsed(t *testing.T) {
	driveID := uuid.New()
	q := &stubQuerier{
		user: sampleUser(),
		storageAllocations: []db.UserStorageAllocation{
			{DriveID: driveID, ServerName: "Manager", DriveType: "hdd", CapacityBytes: 1000, QuotaBytes: 100, UserUsedBytes: 50, IsPrimary: true},
		},
		saveAllocationsTotal: 50,
	}
	h := browsHandler(q, nil, nil, okKcResolver)

	r := newEngine()
	r.PUT("/admin/users/:user_id/storage/allocations", h.AdminUpdateUserStorageAllocations)

	body := jsonBody(map[string]any{
		"allocations": []map[string]any{{"drive_id": driveID.String(), "quota_bytes": 50}},
	})
	req := httptest.NewRequest(http.MethodPut, "/admin/users/alice/storage/allocations", body)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 (quota == used is the allowed boundary), got %d: %s", w.Code, w.Body.String())
	}
}

func TestAdminUpdateUserStorageAllocations_InsufficientCapacityOnAdd(t *testing.T) {
	newDriveID := uuid.New()
	q := &stubQuerier{
		user:               sampleUser(),
		storageAllocations: nil, // no existing allocations for simplicity — the added one is the only one
		drive:              &models.Drive{ID: newDriveID, ServerID: uuid.New(), Label: "nvme-01", DriveType: "nvme", IsActive: true, CapacityBytes: 1000},
		server:             &models.Server{ID: uuid.New(), Name: "Pi5"},
		driveAvailBytes:    30, // less than the 50 requested
	}
	h := browsHandler(q, nil, nil, okKcResolver)

	r := newEngine()
	r.PUT("/admin/users/:user_id/storage/allocations", h.AdminUpdateUserStorageAllocations)

	body := jsonBody(map[string]any{
		"allocations": []map[string]any{{"drive_id": newDriveID.String(), "quota_bytes": 50}},
	})
	req := httptest.NewRequest(http.MethodPut, "/admin/users/alice/storage/allocations", body)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	decodeBody(w, &resp) //nolint
	violations, _ := resp["violations"].([]any)
	if len(violations) != 1 {
		t.Fatalf("expected 1 violation, got %d", len(violations))
	}
	v, _ := violations[0].(map[string]any)
	if v["code"] != "insufficient_capacity" {
		t.Errorf("expected code=insufficient_capacity, got %v", v["code"])
	}
}

func TestAdminUpdateUserStorageAllocations_AddSecondTierSameServer(t *testing.T) {
	existingDrive := uuid.New()
	newDrive := uuid.New()
	serverID := uuid.New()
	q := &stubQuerier{
		user: sampleUser(),
		storageAllocations: []db.UserStorageAllocation{
			{DriveID: existingDrive, ServerID: serverID, ServerName: "Manager", DriveType: "hdd", CapacityBytes: 1000, QuotaBytes: 100, UserUsedBytes: 10, IsPrimary: true},
		},
		drive:                &models.Drive{ID: newDrive, ServerID: serverID, Label: "nvme-01", DriveType: "nvme", IsActive: true, CapacityBytes: 500},
		server:               &models.Server{ID: serverID, Name: "Manager"},
		driveAvailBytes:      200,
		saveAllocationsTotal: 150,
	}
	h := browsHandler(q, nil, nil, okKcResolver)

	r := newEngine()
	r.PUT("/admin/users/:user_id/storage/allocations", h.AdminUpdateUserStorageAllocations)

	body := jsonBody(map[string]any{
		"allocations": []map[string]any{
			{"drive_id": existingDrive.String(), "quota_bytes": 100},
			{"drive_id": newDrive.String(), "quota_bytes": 50},
		},
	})
	req := httptest.NewRequest(http.MethodPut, "/admin/users/alice/storage/allocations", body)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAdminUpdateUserStorageAllocations_EmptyAllocationsRejected(t *testing.T) {
	q := &stubQuerier{user: sampleUser()}
	h := browsHandler(q, nil, nil, okKcResolver)

	r := newEngine()
	r.PUT("/admin/users/:user_id/storage/allocations", h.AdminUpdateUserStorageAllocations)

	body := jsonBody(map[string]any{"allocations": []map[string]any{}})
	req := httptest.NewRequest(http.MethodPut, "/admin/users/alice/storage/allocations", body)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAdminUpdateUserStorageAllocations_UserNotFound(t *testing.T) {
	q := &stubQuerier{userErr: sql.ErrNoRows}
	h := browsHandler(q, nil, nil, okKcResolver)

	r := newEngine()
	r.PUT("/admin/users/:user_id/storage/allocations", h.AdminUpdateUserStorageAllocations)

	body := jsonBody(map[string]any{
		"allocations": []map[string]any{{"drive_id": uuid.New().String(), "quota_bytes": 10}},
	})
	req := httptest.NewRequest(http.MethodPut, "/admin/users/nobody/storage/allocations", body)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
}
