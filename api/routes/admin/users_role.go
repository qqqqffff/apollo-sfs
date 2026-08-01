package admin

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/sanitize"
)

// effectiveRole reduces a user's is_admin/is_premium flags to exactly one of
// the three roles the admin Users page's role editor assigns. This is the
// "previous role" every transition rule in UpdateUserRole is keyed off.
func effectiveRole(u *models.User) string {
	switch {
	case u.IsAdmin:
		return "admin"
	case u.IsPremium:
		return "premium"
	default:
		return "user"
	}
}

func strPtrRole(s string) *string { return &s }

// updateUserRoleRequest is the body of PATCH /admin/users/:user_id/role.
type updateUserRoleRequest struct {
	Role               string  `json:"role" binding:"required,oneof=admin premium user"`
	Reason             string  `json:"reason" binding:"required"`
	PremiumExpiresAt   *string `json:"premium_expires_at"`
	BlockFuturePremium bool    `json:"block_future_premium"`
}

// UpdateUserRole handles PATCH /api/v1/admin/users/:user_id/role — the admin
// Users page's role editor. Assigns exactly one of admin/premium/user.
//
// Grants/revokes actually take effect via Keycloak (SetAdminRealmRole,
// AddUserToGroupByName/RemoveUserFromGroupByName("premium")) — the auth
// middleware resyncs is_admin/is_premium from the JWT's realm roles on every
// request, so a DB-only change would be silently overwritten on the user's
// next call. DB flags are also set here for immediate read consistency.
//
// When the user's previous role was "premium" and the new role isn't, any
// active PayPal subscription is cancelled (no refund — same shape as the
// self-service cancel), local premium access is revoked, and a mandatory
// email is sent explaining why. Demoting Premium to a regular User may also
// block future Premium purchases via block_future_premium.
func (h *Handler) UpdateUserRole(c *gin.Context) {
	ctx := c.Request.Context()
	target := sanitize.String(c.Param("user_id"))
	if target == "" || len(target) > 150 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id"})
		return
	}

	var req updateUserRoleRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "role (admin|premium|user) and reason are required"})
		return
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "reason is required"})
		return
	}

	var premiumExpiresAt *time.Time
	if req.Role == "premium" && req.PremiumExpiresAt != nil && strings.TrimSpace(*req.PremiumExpiresAt) != "" {
		t, err := time.Parse(time.RFC3339, strings.TrimSpace(*req.PremiumExpiresAt))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "premium_expires_at must be an RFC3339 timestamp"})
			return
		}
		if !t.After(time.Now()) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "premium_expires_at must be in the future"})
			return
		}
		premiumExpiresAt = &t
	}

	admin := c.GetString("username")
	if target == admin {
		c.JSON(http.StatusConflict, gin.H{"error": "cannot change your own role"})
		return
	}

	user, err := h.queries.GetUserByUsername(ctx, target)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not fetch user"})
		return
	}

	previousRole := effectiveRole(user)
	if previousRole == req.Role && req.Role != "premium" {
		c.JSON(http.StatusOK, gin.H{"message": "role unchanged"})
		return
	}

	losingPremium := previousRole == "premium" && req.Role != "premium"
	blockFuturePremium := losingPremium && req.Role == "user" && req.BlockFuturePremium

	// Cancel any real PayPal subscription first — before any KC/DB write —
	// so a PayPal failure aborts the whole request with nothing changed yet
	// and the admin can just retry.
	var hadPaypalSubscription bool
	var cancelledSub *models.PremiumSubscription
	if losingPremium {
		sub, err := h.queries.GetActiveSubscriptionForUser(ctx, target)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not check subscription"})
			return
		}
		if sub != nil {
			client := h.paypalClients.For(sub.Environment)
			if client == nil {
				c.JSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
				return
			}
			// A self-billed subscription (card/Apple Pay/Google Pay) has no
			// PayPal subscription behind it — the recurring charge is our own
			// renewal loop, which the status change below stops. See
			// docs/paypal_setup.md §9.
			if sub.BillingMode != "self" {
				if err := client.CancelSubscription(ctx, sub.PayPalSubscriptionID, reason); err != nil {
					log.Printf("UpdateUserRole: paypal cancel for %q: %v", target, err)
					c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "paypal cancel failed"})
					return
				}
			}
			hadPaypalSubscription = true
			cancelledSub = sub
		}
	}

	// Apply the KC + DB role flags. Order matters: is_admin must land before
	// the premium-teardown call below re-reads the user, since
	// revokePremiumEffects only clears is_premium for non-admins.
	if req.Role == "admin" && previousRole != "admin" {
		if err := h.auth.SetAdminRealmRole(ctx, target, true); err != nil {
			log.Printf("UpdateUserRole: grant admin role for %q: %v", target, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not grant admin role"})
			return
		}
	} else if req.Role != "admin" && previousRole == "admin" {
		if err := h.auth.SetAdminRealmRole(ctx, target, false); err != nil {
			log.Printf("UpdateUserRole: revoke admin role for %q: %v", target, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not revoke admin role"})
			return
		}
	}
	if err := h.queries.SetUserAdmin(ctx, target, req.Role == "admin"); err != nil {
		log.Printf("UpdateUserRole: set is_admin for %q: %v", target, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not update role"})
		return
	}

	if req.Role == "premium" {
		if err := h.auth.AddUserToGroupByName(ctx, target, "premium"); err != nil {
			log.Printf("UpdateUserRole: KC premium group add for %q: %v", target, err)
		}
		if err := h.queries.SetUserPremium(ctx, target, true); err != nil {
			log.Printf("UpdateUserRole: set is_premium for %q: %v", target, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not update role"})
			return
		}
		if err := h.queries.SetPremiumExpiry(ctx, target, premiumExpiresAt); err != nil {
			log.Printf("UpdateUserRole: set premium expiry for %q: %v", target, err)
		}
	} else {
		if err := h.auth.RemoveUserFromGroupByName(ctx, target, "premium"); err != nil {
			log.Printf("UpdateUserRole: KC premium group remove for %q: %v", target, err)
		}
	}

	// Premium teardown (real subscription vs. admin-granted trial only) +
	// the mandatory cancellation email.
	if losingPremium {
		if hadPaypalSubscription {
			if err := h.paymentSvc.RevokeSubscription(ctx, cancelledSub.PayPalSubscriptionID, "cancelled", reason); err != nil {
				log.Printf("UpdateUserRole: revoke subscription for %q: %v", target, err)
			}
		} else if h.paymentSvc != nil {
			if err := h.paymentSvc.RevokePremiumAllocation(ctx, target); err != nil {
				log.Printf("UpdateUserRole: revoke premium allocation for %q: %v", target, err)
			}
		}
		if err := h.queries.SetPremiumExpiry(ctx, target, nil); err != nil {
			log.Printf("UpdateUserRole: clear premium expiry for %q: %v", target, err)
		}
		if blockFuturePremium {
			if err := h.queries.SetPremiumPurchaseBlocked(ctx, target, true); err != nil {
				log.Printf("UpdateUserRole: set purchase blocked for %q: %v", target, err)
			}
		}
		if h.emailSvc != nil {
			if err := h.emailSvc.SendPremiumRoleCancelled(ctx, user.Email, reason, hadPaypalSubscription, blockFuturePremium); err != nil {
				log.Printf("UpdateUserRole: send cancellation email for %q: %v", target, err)
			}
		}
	}

	go func() {
		if err := h.queries.InsertRoleChangeNotification(context.Background(), db.InsertRoleChangeNotificationParams{
			Username: target, ChangedBy: admin, PreviousRole: previousRole, NewRole: req.Role,
			Reason: reason, PremiumExpiresAt: premiumExpiresAt, BlockFuturePremium: blockFuturePremium,
		}); err != nil {
			log.Printf("UpdateUserRole: notification for %q: %v", target, err)
		}
	}()
	go func() {
		if err := h.queries.InsertAuditLog(context.Background(), db.AuditInput{
			TargetUsername: target, ActorUsername: admin, Action: "role_changed",
			ResourceType: strPtrRole("user"),
			ResourceName: strPtrRole(fmt.Sprintf("%s -> %s: %s", previousRole, req.Role, reason)),
		}); err != nil {
			log.Printf("UpdateUserRole: audit log for %q: %v", target, err)
		}
	}()

	c.JSON(http.StatusOK, gin.H{"message": "role updated"})
}
