package admin

import (
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
)

// maxInboundFormBytes caps the in-memory portion of the multipart parse.
// Attachment payloads beyond this spill to temp files; the total request size
// is bounded by nginx (client_max_body_size).
const maxInboundFormBytes = 25 << 20 // 25 MiB

// messageIDRe extracts the Message-ID value from the raw headers blob SendGrid
// includes in the "headers" form field.
var messageIDRe = regexp.MustCompile(`(?im)^Message-ID:\s*(.+)$`)

// InboundEmailWebhook handles POST /api/v1/webhooks/email-inbound.
//
// It accepts SendGrid's Inbound Parse multipart/form-data payload (the default,
// non-raw format), persists the message, and returns 200 quickly so SendGrid
// does not retry. A non-2xx response causes SendGrid to redeliver, so all
// "expected" conditions (duplicate, unroutable recipient) still return 200.
func (h *InboundEmailHandler) InboundEmailWebhook(c *gin.Context) {
	// Optional shared-secret check: SendGrid Inbound Parse offers no signature,
	// so the configured POST URL should carry ?token=<secret>.
	if h.webhookSecret != "" {
		token := c.Query("token")
		if subtle.ConstantTimeCompare([]byte(token), []byte(h.webhookSecret)) != 1 {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
	}

	if err := c.Request.ParseMultipartForm(maxInboundFormBytes); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid multipart payload"})
		return
	}

	to := firstNonEmpty(c.PostForm("to"), c.PostForm("envelope"))
	from := c.PostForm("from")
	if to == "" || from == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing to/from"})
		return
	}

	headers := c.PostForm("headers")
	msg := models.StoredEmail{
		MessageID:   extractMessageID(headers),
		From:        from,
		To:          to,
		Subject:     c.PostForm("subject"),
		Date:        time.Now().UTC(),
		Text:        c.PostForm("text"),
		HTML:        c.PostForm("html"),
		Headers:     headers,
		Attachments: collectAttachments(c),
	}

	stored, err := h.svc.StoreEmail(c.Request.Context(), to, msg)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrInvalidWorker):
			// Unroutable recipient — accept and drop so SendGrid stops retrying.
			log.Printf("inbound email: dropping message for unroutable recipient %q", to)
			c.JSON(http.StatusOK, gin.H{"status": "ignored"})
		case errors.Is(err, services.ErrDuplicateEmail):
			c.JSON(http.StatusOK, gin.H{"status": "duplicate"})
		default:
			// Genuine server-side failure: let SendGrid retry.
			log.Printf("inbound email: store failed: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not store email"})
		}
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "stored", "id": stored.ID})
}

// collectAttachments reads every uploaded file part into an inline,
// base64-encoded attachment record.
func collectAttachments(c *gin.Context) []models.EmailAttachment {
	if c.Request.MultipartForm == nil {
		return nil
	}
	var out []models.EmailAttachment
	for _, headers := range c.Request.MultipartForm.File {
		for _, fh := range headers {
			f, err := fh.Open()
			if err != nil {
				log.Printf("inbound email: open attachment %q: %v", fh.Filename, err)
				continue
			}
			data, err := io.ReadAll(f)
			_ = f.Close()
			if err != nil {
				log.Printf("inbound email: read attachment %q: %v", fh.Filename, err)
				continue
			}
			out = append(out, models.EmailAttachment{
				Filename:      fh.Filename,
				ContentType:   fh.Header.Get("Content-Type"),
				Size:          len(data),
				ContentBase64: base64.StdEncoding.EncodeToString(data),
			})
		}
	}
	return out
}

// extractMessageID pulls the Message-ID header value out of the raw headers
// blob, trimming surrounding whitespace and angle brackets are kept as-is.
func extractMessageID(headers string) string {
	m := messageIDRe.FindStringSubmatch(headers)
	if len(m) < 2 {
		return ""
	}
	return strings.TrimSpace(m[1])
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
