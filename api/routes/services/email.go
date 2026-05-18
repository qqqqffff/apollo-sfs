package services

import (
	"bytes"
	"context"
	"crypto/tls"
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

// SendInterestFormNotification enqueues an admin notification email for every
// address in adminEmails when a new interest form submission arrives.
func (s *EmailService) SendInterestFormNotification(
	ctx context.Context,
	adminEmails []string,
	name, email string,
	desiredStorageGB int,
	useCase string,
) error {
	adminURL := s.appURL + "/admin/interest"
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

	// Attempt SMTP delivery.
	if err := s.send(e.ToAddress, e.Subject, body); err != nil {
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

// enqueue marshals data to JSON and inserts a pending row into email_queue.
func (s *EmailService) enqueue(ctx context.Context, to, subject, templateName string, data map[string]any) error {
	raw, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("enqueue %q: marshal data: %w", templateName, err)
	}
	return s.q.EnqueueEmail(ctx, &models.EmailQueue{
		ToAddress:    to,
		Subject:      subject,
		TemplateName: templateName,
		TemplateData: raw,
	})
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
// and delivers one HTML message.
func (s *EmailService) send(to, subject, htmlBody string) error {
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

	msg := buildMessage(s.appName, s.from, to, subject, htmlBody, s.css)
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
func buildMessage(fromName, fromAddr, to, subject, htmlBody, css string) []byte {
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
	fmt.Fprintf(&b, "Content-Type: text/html; charset=UTF-8\r\n")
	fmt.Fprintf(&b, "\r\n")
	b.WriteString(htmlBody)
	return b.Bytes()
}

// failEmail marks a queued email as permanently failed with a reason string.
func (s *EmailService) failEmail(ctx context.Context, id uuid.UUID, reason string) {
	if err := s.q.MarkEmailFailed(ctx, id, reason); err != nil {
		log.Printf("email: mark failed: %v", err)
	}
}
