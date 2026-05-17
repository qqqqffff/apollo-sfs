package tests

import (
	"errors"
	"testing"
	"time"

	"apollo-sfs.com/api/routes/services"
)

func TestInviteSentinels_Distinct(t *testing.T) {
	errs := []error{
		services.ErrInviteNotFound,
		services.ErrInviteExpired,
		services.ErrInviteAlreadyPending,
	}
	for i := 0; i < len(errs); i++ {
		for j := i + 1; j < len(errs); j++ {
			if errors.Is(errs[i], errs[j]) {
				t.Errorf("sentinel errors %v and %v should be distinct", errs[i], errs[j])
			}
		}
	}
}

func TestInviteSentinels_NotNil(t *testing.T) {
	if services.ErrInviteNotFound == nil {
		t.Error("ErrInviteNotFound should not be nil")
	}
	if services.ErrInviteExpired == nil {
		t.Error("ErrInviteExpired should not be nil")
	}
	if services.ErrInviteAlreadyPending == nil {
		t.Error("ErrInviteAlreadyPending should not be nil")
	}
}

func TestInvitationURL_BuildsCorrectURL(t *testing.T) {
	svc := services.NewInviteService(nil, nil, "https://example.com", time.Hour)
	got := svc.InvitationURL("abc123")
	want := "https://example.com/register?token=abc123"
	if got != want {
		t.Errorf("expected %q, got %q", want, got)
	}
}

func TestInvitationURL_TrailingSlashStripped(t *testing.T) {
	svc := services.NewInviteService(nil, nil, "https://example.com/", time.Hour)
	got := svc.InvitationURL("tok")
	want := "https://example.com/register?token=tok"
	if got != want {
		t.Errorf("expected %q, got %q", want, got)
	}
}
