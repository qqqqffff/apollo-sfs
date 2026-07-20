package services

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html/template"
	"log"
	"net"
	"net/smtp"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

const (
	emailPollInterval = 30 * time.Second
	emailMaxAttempts  = 3
)

// ── Config ────────────────────────────────────────────────────────────────────

// EmailConfig holds the parameters needed to construct an EmailService.
type EmailConfig struct {
	// SMTPAddr is the host:port of the internal Postfix submission endpoint.
	// e.g. "postfix:587"
	SMTPAddr string
	// MailFrom is the envelope From address. e.g. "noreply@example.com"
	MailFrom string
	// AppName is the human-readable app name used in email copy. e.g. "apollo-sfs"
	AppName string
	// AppURL is the public base URL. e.g. "https://files.example.com"
	AppURL string
	// TemplatesDir is the path to the directory containing *.html and email.css
	// template files. e.g. "templates"
	TemplatesDir string
}

// ── Service ───────────────────────────────────────────────────────────────────

// EmailService renders HTML email templates, enqueues outgoing mail to the
// email_queue table, and dispatches them to Postfix via SMTP in the background.
type EmailService struct {
	q       *db.Queries
	host    string
	port    string
	from    string
	appName string
	appURL  string
	tmpl    *template.Template
	css     string // contents of email.css, injected into every outgoing message
}

// NewEmailService parses all *.html files under cfg.TemplatesDir and reads
// email.css for stylesheet injection. Returns an error if either step fails.
func NewEmailService(q *db.Queries, cfg EmailConfig) (*EmailService, error) {
	pattern := filepath.Join(cfg.TemplatesDir, "*.html")
	tmpl, err := template.ParseGlob(pattern)
	if err != nil {
		return nil, fmt.Errorf("email service: parse templates %q: %w", pattern, err)
	}

	cssPath := filepath.Join(cfg.TemplatesDir, "email.css")
	cssBytes, err := os.ReadFile(cssPath)
	if err != nil {
		return nil, fmt.Errorf("email service: read stylesheet %q: %w", cssPath, err)
	}

	host, port, err := net.SplitHostPort(cfg.SMTPAddr)
	if err != nil {
		return nil, fmt.Errorf("email service: invalid smtp addr %q: %w", cfg.SMTPAddr, err)
	}

	return &EmailService{
		q:       q,
		host:    host,
		port:    port,
		from:    cfg.MailFrom,
		appName: cfg.AppName,
		appURL:  cfg.AppURL,
		tmpl:    tmpl,
		css:     string(cssBytes),
	}, nil
}

// ── Public enqueue methods ────────────────────────────────────────────────────

// SendWelcome enqueues a welcome email for a newly registered user.
func (s *EmailService) SendWelcome(ctx context.Context, user *models.User) error {
	return s.enqueue(ctx, user.Email,
		fmt.Sprintf("Welcome to %s", s.appName),
		"welcome",
		map[string]any{
			"AppName":  s.appName,
			"AppURL":   s.appURL,
			"Email":    user.Email,
			"Username": user.Username,
		},
	)
}

// SendInvitation enqueues an invitation email to the given address.
// invitationURL must be the full URL including the one-time token.
// expiresIn is a human-readable duration shown in the email, e.g. "72 hours".
func (s *EmailService) SendInvitation(
	ctx context.Context,
	toEmail string,
	invitedByUsername string,
	invitationURL string,
	expiresIn string,
) error {
	return s.enqueue(ctx, toEmail,
		fmt.Sprintf("You've been invited to %s", s.appName),
		"invite",
		map[string]any{
			"AppName":           s.appName,
			"AppURL":            s.appURL,
			"Email":             toEmail,
			"InvitedByUsername": invitedByUsername,
			"InvitationURL":     invitationURL,
			"ExpiresIn":         expiresIn,
		},
	)
}

// SendShareNotification enqueues an email telling a recipient that ownerEmail
// shared a file or folder with them. itemType is "file" or "folder";
// permissionLabel is a human-readable summary e.g. "view and download";
// shareURL must be the full URL including the share token.
func (s *EmailService) SendShareNotification(
	ctx context.Context,
	toEmail string,
	ownerEmail string,
	itemName string,
	itemType string,
	permissionLabel string,
	shareURL string,
) error {
	return s.enqueue(ctx, toEmail,
		fmt.Sprintf("%s shared a %s with you on %s", ownerEmail, itemType, s.appName),
		"share_notification",
		map[string]any{
			"AppName":         s.appName,
			"AppURL":          s.appURL,
			"Email":           toEmail,
			"OwnerEmail":      ownerEmail,
			"ItemName":        itemName,
			"ItemType":        itemType,
			"PermissionLabel": permissionLabel,
			"ShareURL":        shareURL,
		},
	)
}

// SendQuotaWarning enqueues a storage warning email when a user crosses the
// warning threshold (default 80%). usedPercent is the integer percentage (e.g. 83).
// usedFormatted and quotaFormatted are pre-formatted strings e.g. "8.3 GB", "10 GB".
func (s *EmailService) SendQuotaWarning(
	ctx context.Context,
	user *models.User,
	usedPercent int,
	usedFormatted string,
	quotaFormatted string,
) error {
	return s.enqueue(ctx, user.Email,
		fmt.Sprintf("Storage warning — you're at %d%% of your quota", usedPercent),
		"quota_warning",
		map[string]any{
			"AppName":        s.appName,
			"AppURL":         s.appURL,
			"Email":          user.Email,
			"Username":       user.Username,
			"UsedFormatted":  usedFormatted,
			"QuotaFormatted": quotaFormatted,
			"UsedPercent":    usedPercent,
		},
	)
}

// SendQuotaLimit enqueues a quota-full email when a user reaches 100% of their
// storage. New uploads are blocked at this point.
func (s *EmailService) SendQuotaLimit(
	ctx context.Context,
	user *models.User,
	usedFormatted string,
	quotaFormatted string,
) error {
	return s.enqueue(ctx, user.Email,
		fmt.Sprintf("Your %s storage is full — uploads are blocked", s.appName),
		"quota_limit",
		map[string]any{
			"AppName":        s.appName,
			"AppURL":         s.appURL,
			"Email":          user.Email,
			"Username":       user.Username,
			"UsedFormatted":  usedFormatted,
			"QuotaFormatted": quotaFormatted,
		},
	)
}

// DiscountDeal is one line of a discount announcement: a storage plan with
// its old and new price and the badge percentage.
type DiscountDeal struct {
	Label    string // e.g. "256 GB Fast (NVMe)"
	OldPrice string // pre-formatted, e.g. "$80.00"
	NewPrice string // pre-formatted, e.g. "$60.00"
	Percent  int    // e.g. 25
}

// DiscountEmailData is the display payload of a discount announcement.
type DiscountEmailData struct {
	ServerName  string
	ScopeLabel  string // e.g. "all Fast (NVMe) storage plans on Atlas"
	Deals       []DiscountDeal
	ExpiresAt   string // pre-formatted expiry, "" = no expiry
	PremiumOnly bool
}

// SendDiscountNotification enqueues a storage-discount announcement created
// from the admin pricing page.
func (s *EmailService) SendDiscountNotification(ctx context.Context, toEmail string, data DiscountEmailData) error {
	deals := make([]map[string]any, len(data.Deals))
	for i, d := range data.Deals {
		deals[i] = map[string]any{
			"Label":    d.Label,
			"OldPrice": d.OldPrice,
			"NewPrice": d.NewPrice,
			"Percent":  d.Percent,
		}
	}
	return s.enqueue(ctx, toEmail,
		fmt.Sprintf("Storage sale — save on %s", data.ScopeLabel),
		"discount_notification",
		map[string]any{
			"AppName":     s.appName,
			"AppURL":      s.appURL,
			"Email":       toEmail,
			"ServerName":  data.ServerName,
			"ScopeLabel":  data.ScopeLabel,
			"Deals":       deals,
			"ExpiresAt":   data.ExpiresAt,
			"PremiumOnly": data.PremiumOnly,
		},
	)
}

// SendInterestFormNotification enqueues an admin notification email for every
// address in adminEmails when a new interest form submission arrives.
func (s *EmailService) SendInterestFormNotification(
	ctx context.Context,
	adminEmails []string,
	name, email string,
	desiredStorageGB int,
	useCase string,
) error {
	adminURL := s.appURL + "/admin/requests"
	for _, to := range adminEmails {
		if err := s.enqueue(ctx, to,
			fmt.Sprintf("New interest form submission — %s", s.appName),
			"interest_notification",
			map[string]any{
				"AppName":          s.appName,
				"AppURL":           s.appURL,
				"Name":             name,
				"Email":            email,
				"DesiredStorageGB": desiredStorageGB,
				"UseCase":          useCase,
				"AdminURL":         adminURL,
			},
		); err != nil {
			return err
		}
	}
	return nil
}

// SendAlarmNotification enqueues an alarm notification email to every address
// in recipients. title is a short label (e.g. "High CPU Usage") and detail
// is a human-readable explanation of the current metric value.
func (s *EmailService) SendAlarmNotification(
	ctx context.Context,
	recipients []string,
	title string,
	detail string,
) error {
	adminURL := s.appURL + "/admin/alarm"
	for _, to := range recipients {
		if err := s.enqueue(ctx, to,
			fmt.Sprintf("Server alarm: %s — %s", title, s.appName),
			"alarm_notification",
			map[string]any{
				"AppName":  s.appName,
				"AppURL":   s.appURL,
				"Title":    title,
				"Detail":   detail,
				"AdminURL": adminURL,
			},
		); err != nil {
			return err
		}
	}
	return nil
}

// SendExpansionRequestNotification notifies all admins that a user has
// submitted a new server capacity expansion request.
func (s *EmailService) SendExpansionRequestNotification(
	ctx context.Context,
	adminEmails []string,
	username, userEmail, serverName, planLabel, depositFormatted, expiresAt string,
) error {
	adminURL := s.appURL + "/admin/orders?tab=expansion"
	for _, to := range adminEmails {
		if err := s.enqueue(ctx, to,
			fmt.Sprintf("New expansion request — %s", s.appName),
			"expansion_request_admin",
			map[string]any{
				"AppName":          s.appName,
				"AppURL":           s.appURL,
				"Username":         username,
				"UserEmail":        userEmail,
				"ServerName":       serverName,
				"PlanLabel":        planLabel,
				"DepositFormatted": depositFormatted,
				"ExpiresAt":        expiresAt,
				"AdminURL":         adminURL,
			},
		); err != nil {
			return err
		}
	}
	return nil
}

// SendExpansionPaymentDue notifies the user that server capacity is ready and
// the remaining balance must be paid within the given deadline.
func (s *EmailService) SendExpansionPaymentDue(
	ctx context.Context,
	toEmail, serverName, planLabel, remainingFmt, paymentDueAt, paymentURL string,
) error {
	return s.enqueue(ctx, toEmail,
		fmt.Sprintf("Your storage expansion is ready — pay now — %s", s.appName),
		"expansion_payment_due",
		map[string]any{
			"AppName":      s.appName,
			"AppURL":       s.appURL,
			"ServerName":   serverName,
			"PlanLabel":    planLabel,
			"RemainingFmt": remainingFmt,
			"PaymentDueAt": paymentDueAt,
			"PaymentURL":   paymentURL,
		},
	)
}

// SendExpansionCancellation notifies the user that their expansion request was
// cancelled and a deposit refund has been issued.
func (s *EmailService) SendExpansionCancellation(
	ctx context.Context,
	toEmail, serverName, planLabel, refundFormatted, reason string,
) error {
	return s.enqueue(ctx, toEmail,
		fmt.Sprintf("Your expansion request was cancelled — %s", s.appName),
		"expansion_cancellation",
		map[string]any{
			"AppName":         s.appName,
			"AppURL":          s.appURL,
			"ServerName":      serverName,
			"PlanLabel":       planLabel,
			"RefundFormatted": refundFormatted,
			"Reason":          reason,
		},
	)
}

// SendExpansionInvoice emails a custom-capacity invoice to the user, attaching
// the invoice PDF when provided. reviewURL is empty when the admin chose not
// to include the website review link.
func (s *EmailService) SendExpansionInvoice(
	ctx context.Context,
	toEmail, serverName, planLabel, invoiceNumber, totalFmt, depositFmt, acceptDueAt, reviewURL string,
	invoicePDF []byte,
) error {
	var attachments []EmailAttachment
	if len(invoicePDF) > 0 {
		attachments = append(attachments, EmailAttachment{
			Filename:   fmt.Sprintf("%s.pdf", invoiceNumber),
			MimeType:   "application/pdf",
			ContentB64: base64.StdEncoding.EncodeToString(invoicePDF),
		})
	}
	return s.enqueueWithAttachments(ctx, toEmail,
		fmt.Sprintf("Invoice %s for your custom storage request — %s", invoiceNumber, s.appName),
		"expansion_invoice",
		map[string]any{
			"AppName":       s.appName,
			"AppURL":        s.appURL,
			"ServerName":    serverName,
			"PlanLabel":     planLabel,
			"InvoiceNumber": invoiceNumber,
			"TotalFmt":      totalFmt,
			"DepositFmt":    depositFmt,
			"AcceptDueAt":   acceptDueAt,
			"ReviewURL":     reviewURL,
		},
		attachments,
	)
}

// SendExpansionBalanceReminder nudges the user about an outstanding remaining
// balance on a provisioned expansion (sent once, 7 business days after the
// balance came due). revertAt is when the allocation will be reverted.
func (s *EmailService) SendExpansionBalanceReminder(
	ctx context.Context,
	toEmail, serverName, planLabel, remainingFmt, revertAt, paymentURL string,
) error {
	return s.enqueue(ctx, toEmail,
		fmt.Sprintf("Reminder: balance due for your storage expansion — %s", s.appName),
		"expansion_balance_reminder",
		map[string]any{
			"AppName":      s.appName,
			"AppURL":       s.appURL,
			"ServerName":   serverName,
			"PlanLabel":    planLabel,
			"RemainingFmt": remainingFmt,
			"RevertAt":     revertAt,
			"PaymentURL":   paymentURL,
		},
	)
}

// SendPasswordReset enqueues a password-reset email.
// resetURL must be the full one-time reset URL.
// expiresIn is shown in the email copy, e.g. "30 minutes".
func (s *EmailService) SendPasswordReset(
	ctx context.Context,
	user *models.User,
	resetURL string,
	expiresIn string,
) error {
	return s.enqueue(ctx, user.Email,
		fmt.Sprintf("Reset your %s password", s.appName),
		"password_reset",
		map[string]any{
			"AppName":   s.appName,
			"AppURL":    s.appURL,
			"Email":     user.Email,
			"Username":  user.Username,
			"ResetURL":  resetURL,
			"ExpiresIn": expiresIn,
		},
	)
}

// SendPasswordChangeCode enqueues the two-factor code emailed when a signed-in
// user starts the change-password flow. The code must be entered alongside the
// current and new password to complete the change.
func (s *EmailService) SendPasswordChangeCode(
	ctx context.Context,
	user *models.User,
	code string,
	expiresIn string,
) error {
	return s.enqueue(ctx, user.Email,
		fmt.Sprintf("Your %s password change code", s.appName),
		"password_change_code",
		map[string]any{
			"AppName":   s.appName,
			"AppURL":    s.appURL,
			"Email":     user.Email,
			"Username":  user.Username,
			"Code":      code,
			"ExpiresIn": expiresIn,
		},
	)
}

// SendFileServerLocationVerification enqueues the enhanced-security 2FA email
// sent when a file-server mount is used from a new (or expired) location.
// verifyURL is the full in-app URL carrying the one-time verification token;
// opening it requires being signed in, which is the second factor.
func (s *EmailService) SendFileServerLocationVerification(
	ctx context.Context,
	toEmail string,
	serverName string,
	sourceIP string,
	verifyURL string,
) error {
	return s.enqueue(ctx, toEmail,
		fmt.Sprintf("Verify a new location for your %s file server", s.appName),
		"file_server_verify_location",
		map[string]any{
			"AppName":    s.appName,
			"AppURL":     s.appURL,
			"Email":      toEmail,
			"ServerName": serverName,
			"SourceIP":   sourceIP,
			"VerifyURL":  verifyURL,
		},
	)
}

// ── Background worker ─────────────────────────────────────────────────────────

// Start launches the background email worker. It polls the email_queue table
// every 30 seconds and dispatches pending messages to Postfix via SMTP.
// It returns when ctx is cancelled.
func (s *EmailService) Start(ctx context.Context) {
	ticker := time.NewTicker(emailPollInterval)
	defer ticker.Stop()

	log.Printf("email worker: started (poll interval %s)", emailPollInterval)
	for {
		select {
		case <-ctx.Done():
			log.Printf("email worker: stopped")
			return
		case <-ticker.C:
			if err := s.processQueue(ctx); err != nil {
				log.Printf("email worker: process queue: %v", err)
			}
		}
	}
}

func (s *EmailService) processQueue(ctx context.Context) error {
	result, err := s.q.GetPendingEmails(ctx, db.PageInput{Limit: db.DefaultPageLimit})
	if err != nil {
		return fmt.Errorf("fetch pending emails: %w", err)
	}
	for _, e := range result.Items {
		s.dispatchOne(ctx, e)
	}
	return nil
}

func (s *EmailService) dispatchOne(ctx context.Context, e models.EmailQueue) {
	// Increment the attempt counter before trying so a crash mid-send still
	// counts as an attempt.
	if err := s.q.IncrementEmailAttempts(ctx, e.ID); err != nil {
		log.Printf("email %s: increment attempts: %v", e.ID, err)
		return
	}
	attempt := e.Attempts + 1

	// Decode template data stored as JSONB.
	var data map[string]any
	if err := json.Unmarshal(e.TemplateData, &data); err != nil {
		s.failEmail(ctx, e.ID, fmt.Sprintf("unmarshal template data: %v", err))
		return
	}

	// Render the HTML body.
	body, err := s.render(string(e.TemplateName), data)
	if err != nil {
		s.failEmail(ctx, e.ID, fmt.Sprintf("render %q: %v", e.TemplateName, err))
		return
	}

	// Decode attachments stored on the queue row (invoice PDFs, etc.).
	var attachments []EmailAttachment
	if len(e.Attachments) > 0 {
		if err := json.Unmarshal(e.Attachments, &attachments); err != nil {
			s.failEmail(ctx, e.ID, fmt.Sprintf("unmarshal attachments: %v", err))
			return
		}
	}

	// Attempt SMTP delivery.
	if err := s.send(e.ToAddress, e.Subject, body, attachments); err != nil {
		log.Printf("email %s: attempt %d/%d failed: %v", e.ID, attempt, emailMaxAttempts, err)
		if attempt >= emailMaxAttempts {
			s.failEmail(ctx, e.ID, err.Error())
		}
		// else: leave as pending — the next poll will retry.
		return
	}

	if err := s.q.MarkEmailSent(ctx, e.ID, time.Now().UTC()); err != nil {
		log.Printf("email %s: mark sent: %v", e.ID, err)
	}
}

// ── Private helpers ───────────────────────────────────────────────────────────

// EmailAttachment is a MIME attachment stored on the queue row and added to
// the message at send time.
type EmailAttachment struct {
	Filename   string `json:"filename"`
	MimeType   string `json:"mime_type"`
	ContentB64 string `json:"content_b64"`
}

// enqueue marshals data to JSON and inserts a pending row into email_queue.
func (s *EmailService) enqueue(ctx context.Context, to, subject, templateName string, data map[string]any) error {
	return s.enqueueWithAttachments(ctx, to, subject, templateName, data, nil)
}

// enqueueWithAttachments is enqueue plus optional MIME attachments.
func (s *EmailService) enqueueWithAttachments(ctx context.Context, to, subject, templateName string, data map[string]any, attachments []EmailAttachment) error {
	raw, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("enqueue %q: marshal data: %w", templateName, err)
	}
	e := &models.EmailQueue{
		ToAddress:    to,
		Subject:      subject,
		TemplateName: templateName,
		TemplateData: raw,
	}
	if len(attachments) > 0 {
		rawAtt, err := json.Marshal(attachments)
		if err != nil {
			return fmt.Errorf("enqueue %q: marshal attachments: %w", templateName, err)
		}
		e.Attachments = rawAtt
	}
	return s.q.EnqueueEmail(ctx, e)
}

// render executes the named template against data and returns the HTML string.
func (s *EmailService) render(name string, data any) (string, error) {
	var buf bytes.Buffer
	if err := s.tmpl.ExecuteTemplate(&buf, name, data); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// send opens an SMTP connection to Postfix, upgrades to STARTTLS if available,
// and delivers one HTML message (multipart/mixed when attachments are present).
func (s *EmailService) send(to, subject, htmlBody string, attachments []EmailAttachment) error {
	addr := net.JoinHostPort(s.host, s.port)

	c, err := smtp.Dial(addr)
	if err != nil {
		return fmt.Errorf("dial %s: %w", addr, err)
	}
	defer c.Close()

	// Upgrade to STARTTLS when the server advertises it. InsecureSkipVerify is
	// intentional — this is an internal Docker-network connection to Postfix and
	// the certificate is self-signed.
	if ok, _ := c.Extension("STARTTLS"); ok {
		tlsCfg := &tls.Config{
			ServerName:         s.host,
			InsecureSkipVerify: true, //nolint:gosec // internal network only
		}
		if err := c.StartTLS(tlsCfg); err != nil {
			return fmt.Errorf("starttls: %w", err)
		}
	}

	if err := c.Mail(s.from); err != nil {
		return fmt.Errorf("MAIL FROM: %w", err)
	}
	if err := c.Rcpt(to); err != nil {
		return fmt.Errorf("RCPT TO: %w", err)
	}

	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("DATA: %w", err)
	}

	msg := buildMessage(s.appName, s.from, to, subject, htmlBody, s.css, attachments)
	if _, err := w.Write(msg); err != nil {
		return fmt.Errorf("write message: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("close data writer: %w", err)
	}

	return c.Quit()
}

// buildMessage assembles a minimal RFC 5322 / MIME message for HTML email.
// css is injected as a <style> block immediately before </head> so the
// stylesheet is embedded in the message regardless of how the template renders.
func buildMessage(fromName, fromAddr, to, subject, htmlBody, css string, attachments []EmailAttachment) []byte {
	if css != "" {
		htmlBody = strings.Replace(
			htmlBody,
			"</head>",
			"<style>\n"+css+"\n</style>\n</head>",
			1,
		)
	}

	var b bytes.Buffer
	fmt.Fprintf(&b, "From: %s <%s>\r\n", fromName, fromAddr)
	fmt.Fprintf(&b, "To: %s\r\n", to)
	fmt.Fprintf(&b, "Subject: %s\r\n", subject)
	fmt.Fprintf(&b, "MIME-Version: 1.0\r\n")

	if len(attachments) == 0 {
		fmt.Fprintf(&b, "Content-Type: text/html; charset=UTF-8\r\n")
		fmt.Fprintf(&b, "\r\n")
		b.WriteString(htmlBody)
		return b.Bytes()
	}

	// multipart/mixed: HTML body part followed by base64 attachment parts.
	const boundary = "apollo-sfs-mime-boundary-7f3a9c"
	fmt.Fprintf(&b, "Content-Type: multipart/mixed; boundary=%q\r\n", boundary)
	fmt.Fprintf(&b, "\r\n")

	fmt.Fprintf(&b, "--%s\r\n", boundary)
	fmt.Fprintf(&b, "Content-Type: text/html; charset=UTF-8\r\n")
	fmt.Fprintf(&b, "\r\n")
	b.WriteString(htmlBody)
	fmt.Fprintf(&b, "\r\n")

	for _, att := range attachments {
		fmt.Fprintf(&b, "--%s\r\n", boundary)
		fmt.Fprintf(&b, "Content-Type: %s; name=%q\r\n", att.MimeType, att.Filename)
		fmt.Fprintf(&b, "Content-Transfer-Encoding: base64\r\n")
		fmt.Fprintf(&b, "Content-Disposition: attachment; filename=%q\r\n", att.Filename)
		fmt.Fprintf(&b, "\r\n")
		// Wrap base64 at 76 chars per RFC 2045.
		for i := 0; i < len(att.ContentB64); i += 76 {
			end := i + 76
			if end > len(att.ContentB64) {
				end = len(att.ContentB64)
			}
			b.WriteString(att.ContentB64[i:end])
			b.WriteString("\r\n")
		}
	}
	fmt.Fprintf(&b, "--%s--\r\n", boundary)
	return b.Bytes()
}

// failEmail marks a queued email as permanently failed with a reason string.
func (s *EmailService) failEmail(ctx context.Context, id uuid.UUID, reason string) {
	if err := s.q.MarkEmailFailed(ctx, id, reason); err != nil {
		log.Printf("email: mark failed: %v", err)
	}
}
