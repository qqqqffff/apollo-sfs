package services

import (
	"context"
	"encoding/json"
	"testing"

	"apollo-sfs.com/api/models"
)

type recordingKC struct{ groupRemoved, roleRevoked []string }

func (r *recordingKC) AddUserToGroupByName(context.Context, string, string) error { return nil }
func (r *recordingKC) RemoveUserFromGroupByName(_ context.Context, u, _ string) error {
	r.groupRemoved = append(r.groupRemoved, u)
	return nil
}
func (r *recordingKC) RevokeRealmRoleByName(_ context.Context, u, _ string) error {
	r.roleRevoked = append(r.roleRevoked, u)
	return nil
}

// An invited user's trial: the premium role is mapped onto them directly, so
// removing the group alone left it in their tokens and the trial never ended.
func TestTrialExpiryRevokesDirectRoleAndAudits(t *testing.T) {
	q, pool := identityTestDB(t)
	insertIdentityUser(t, pool, "zoe", "zoe@x.com")
	dbExec(t, pool, `UPDATE users SET is_premium = true, premium_expires_at = NOW() - interval '1 minute' WHERE username = 'zoe'`)
	kc := &recordingKC{}
	svc := NewPaymentService(q, kc)

	if err := svc.ExpireAdminGrantedPremium(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(kc.groupRemoved) != 1 || len(kc.roleRevoked) != 1 {
		t.Fatalf("group removed %v, role revoked %v — both must go", kc.groupRemoved, kc.roleRevoked)
	}
	var action, actor string
	var raw []byte
	if err := pool.QueryRow(`SELECT action, actor_username, details FROM audit_logs WHERE target_username = 'zoe'`).Scan(&action, &actor, &raw); err != nil {
		t.Fatalf("no audit entry: %v", err)
	}
	var d models.PremiumAuditDetails
	_ = json.Unmarshal(raw, &d)
	if action != "premium.expired" || actor != "system" || d.Source != "admin_trial" || d.PeriodEnd == nil {
		t.Fatalf("audit = %s by %s %+v", action, actor, d)
	}
}

// PayPal re-delivers webhooks; the expiry is audited once.
func TestSubscriptionExpiryAuditedOnce(t *testing.T) {
	q, pool := identityTestDB(t)
	insertIdentityUser(t, pool, "zoe", "zoe@x.com")
	dbExec(t, pool, `UPDATE users SET is_premium = true WHERE username = 'zoe'`)
	dbExec(t, pool, `INSERT INTO premium_subscriptions (username, paypal_subscription_id, plan, status, current_period_end)
		VALUES ('zoe', 'I-1', 'annual', 'active', NOW())`)
	svc := NewPaymentService(q, &recordingKC{})

	for range 2 {
		if err := svc.RevokeSubscription(t.Context(), "I-1", "expired", "BILLING.SUBSCRIPTION.EXPIRED"); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	var raw []byte
	_ = pool.QueryRow(`SELECT COUNT(*), MAX(details::text)::bytea FROM audit_logs WHERE action = 'premium.expired' AND target_username = 'zoe'`).Scan(&n, &raw)
	if n != 1 {
		t.Fatalf("premium.expired entries = %d, want 1", n)
	}
	var d models.PremiumAuditDetails
	_ = json.Unmarshal(raw, &d)
	if d.Source != "subscription" || d.Plan != "annual" || d.Status != "expired" || d.PeriodEnd == nil {
		t.Errorf("details = %+v", d)
	}
	var premium bool
	_ = pool.QueryRow(`SELECT is_premium FROM users WHERE username = 'zoe'`).Scan(&premium)
	if premium {
		t.Error("user still premium after expiry")
	}
}
