package services

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestSlugifyGroupName(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"Robotics Club", "robotics-club"},
		{"  My  Group  ", "my-group"},
		{"UPPER", "upper"},
		{"already-slugged", "already-slugged"},
		{"weird!!chars###here", "weird-chars-here"},
		{"---", ""},
		{"", ""},
		{"числа 123", "123"},
		{"a_b.c", "a-b-c"},
	}
	for _, tc := range cases {
		if got := slugifyGroupName(tc.in); got != tc.want {
			t.Errorf("slugifyGroupName(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestRandomAlphanumeric(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		s, err := randomAlphanumeric(4)
		if err != nil {
			t.Fatalf("randomAlphanumeric: %v", err)
		}
		if len(s) != 4 {
			t.Fatalf("randomAlphanumeric length = %d, want 4", len(s))
		}
		for _, r := range s {
			if !strings.ContainsRune(alphanumerics, r) {
				t.Fatalf("randomAlphanumeric produced non-alphanumeric %q", r)
			}
		}
		seen[s] = true
	}
	if len(seen) < 2 {
		t.Errorf("randomAlphanumeric produced no variety across 50 draws")
	}
}

func TestNormalizeEmails(t *testing.T) {
	got := normalizeEmails([]string{" a@x.com ", "", "A@X.com", "b@y.com"})
	if len(got) != 2 || got[0] != "a@x.com" || got[1] != "b@y.com" {
		t.Errorf("normalizeEmails = %v, want [a@x.com b@y.com]", got)
	}
}

// Create's input validation runs before any DB access, so invalid inputs can
// be exercised with a zero-value service.
func TestCreateRegistrationGroupValidation(t *testing.T) {
	svc := NewRegistrationGroupService(nil, nil, "https://apollo-sfs.com")
	admin := uuid.New()
	future := time.Now().Add(24 * time.Hour)
	past := time.Now().Add(-time.Hour)

	validSlot := RegistrationSlotSpecInput{
		ServerID:      uuid.New(),
		DriveType:     "nvme",
		QuotaBytes:    10 << 30,
		AccountStatus: "base",
		Count:         1,
	}

	cases := []struct {
		name    string
		in      CreateRegistrationGroupInput
		wantErr error
	}{
		{
			name:    "missing name",
			in:      CreateRegistrationGroupInput{Name: "  ", Slots: []RegistrationSlotSpecInput{validSlot}},
			wantErr: ErrGroupNameRequired,
		},
		{
			name:    "name with no slug-able characters",
			in:      CreateRegistrationGroupInput{Name: "!!!", Slots: []RegistrationSlotSpecInput{validSlot}},
			wantErr: ErrGroupNameRequired,
		},
		{
			name:    "expiry in the past",
			in:      CreateRegistrationGroupInput{Name: "g", ExpiresAt: &past, Slots: []RegistrationSlotSpecInput{validSlot}},
			wantErr: ErrGroupExpiryInPast,
		},
		{
			name:    "no slots",
			in:      CreateRegistrationGroupInput{Name: "g"},
			wantErr: ErrGroupNeedsSlots,
		},
		{
			name: "zero count",
			in: CreateRegistrationGroupInput{Name: "g", Slots: []RegistrationSlotSpecInput{
				{ServerID: uuid.New(), DriveType: "nvme", QuotaBytes: 1, AccountStatus: "base", Count: 0},
			}},
			wantErr: ErrInvalidSlotSpec,
		},
		{
			name: "non-positive quota",
			in: CreateRegistrationGroupInput{Name: "g", Slots: []RegistrationSlotSpecInput{
				{ServerID: uuid.New(), DriveType: "hdd", QuotaBytes: 0, AccountStatus: "base", Count: 1},
			}},
			wantErr: ErrInvalidSlotSpec,
		},
		{
			name: "unknown tier",
			in: CreateRegistrationGroupInput{Name: "g", Slots: []RegistrationSlotSpecInput{
				{ServerID: uuid.New(), DriveType: "ssd", QuotaBytes: 1, AccountStatus: "base", Count: 1},
			}},
			wantErr: ErrInvalidSlotSpec,
		},
		{
			name: "admin accounts cannot be provisioned",
			in: CreateRegistrationGroupInput{Name: "g", Slots: []RegistrationSlotSpecInput{
				{ServerID: uuid.New(), DriveType: "nvme", QuotaBytes: 1, AccountStatus: "admin", Count: 1},
			}},
			wantErr: ErrInvalidSlotSpec,
		},
		{
			name: "premium expiry on a base slot",
			in: CreateRegistrationGroupInput{Name: "g", Slots: []RegistrationSlotSpecInput{
				{ServerID: uuid.New(), DriveType: "nvme", QuotaBytes: 1, AccountStatus: "base", PremiumExpiresAt: &future, Count: 1},
			}},
			wantErr: ErrInvalidSlotSpec,
		},
		{
			name: "premium expiry in the past",
			in: CreateRegistrationGroupInput{Name: "g", Slots: []RegistrationSlotSpecInput{
				{ServerID: uuid.New(), DriveType: "nvme", QuotaBytes: 1, AccountStatus: "premium", PremiumExpiresAt: &past, Count: 1},
			}},
			wantErr: ErrInvalidSlotSpec,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.Create(context.Background(), admin, tc.in)
			if !errors.Is(err, tc.wantErr) {
				t.Errorf("Create() error = %v, want %v", err, tc.wantErr)
			}
		})
	}
}

func TestGroupInviteURL(t *testing.T) {
	svc := NewRegistrationGroupService(nil, nil, "https://apollo-sfs.com/")
	got := svc.GroupInviteURL("robotics-club-a1b2")
	want := "https://apollo-sfs.com/group-invite?id=robotics-club-a1b2"
	if got != want {
		t.Errorf("GroupInviteURL = %q, want %q", got, want)
	}
}
