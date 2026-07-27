package admin

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/sanitize"
)

type deleteUserRequest struct {
	Reason string `json:"reason" binding:"required"`
}

// DeleteUser handles DELETE /api/v1/admin/users/:user_id — the admin Users
// page's delete action. Permanently removes the account: cancels any real
// PayPal subscription, sends the mandatory deletion email (before the row is
// gone — email_queue keeps its own copy of the address), purges files and
// folders, deletes the Keycloak identity, then deletes the users row.
// Steps 2-5 are best-effort/logged, mirroring BanUser's tolerance for a
// partial failure — only the final DB row deletion is a hard failure, since
// it's the one step that must succeed for the account to be considered gone.
func (h *Handler) DeleteUser(c *gin.Context) {
	ctx := c.Request.Context()
	target := sanitize.String(c.Param("user_id"))
	if target == "" || len(target) > 150 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id"})
		return
	}

	var req deleteUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "reason is required"})
		return
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "reason is required"})
		return
	}

	admin := c.GetString("username")
	if target == admin {
		c.JSON(http.StatusConflict, gin.H{"error": "cannot delete your own account"})
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

	// Cancel any real PayPal subscription (no refund) so the customer isn't
	// billed forever after their account is gone. Best-effort — the account
	// is being erased regardless of a PayPal hiccup.
	if sub, err := h.queries.GetActiveSubscriptionForUser(ctx, target); err != nil {
		log.Printf("DeleteUser: check subscription for %q: %v", target, err)
	} else if sub != nil && sub.BillingMode != "self" {
		// Self-billed subscriptions have nothing to cancel at PayPal; deleting
		// the user cascades the premium_subscriptions row away, which is what
		// stops our renewal loop. See docs/paypal_setup.md §9.
		if client := h.paypalClients.For(sub.Environment); client != nil {
			if err := client.CancelSubscription(ctx, sub.PayPalSubscriptionID, "account deleted: "+reason); err != nil {
				log.Printf("DeleteUser: paypal cancel for %q: %v", target, err)
			}
		}
	}

	if h.emailSvc != nil {
		if err := h.emailSvc.SendAccountDeleted(ctx, user.Email, reason); err != nil {
			log.Printf("DeleteUser: send deletion email for %q: %v", target, err)
		}
	}

	if h.files != nil {
		if err := h.files.AdminDeleteAllFiles(ctx, target); err != nil {
			log.Printf("DeleteUser: delete files for %q: %v", target, err)
		}
	}
	if err := h.queries.DeleteAllUserFolders(ctx, target); err != nil {
		log.Printf("DeleteUser: delete folders for %q: %v", target, err)
	}

	if err := h.auth.DeleteUser(ctx, target); err != nil {
		log.Printf("DeleteUser: keycloak delete for %q: %v", target, err)
	}

	if err := h.queries.DeleteUserRecord(ctx, target); err != nil {
		log.Printf("DeleteUser: delete row for %q: %v", target, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not delete user"})
		return
	}

	go func() {
		if err := h.queries.InsertAuditLog(context.Background(), db.AuditInput{
			TargetUsername: target, ActorUsername: admin, Action: "user_deleted",
			ResourceType: strPtrRole("user"), ResourceName: strPtrRole(reason),
		}); err != nil {
			log.Printf("DeleteUser: audit log for %q: %v", target, err)
		}
	}()

	c.JSON(http.StatusOK, gin.H{"message": "user deleted"})
}
