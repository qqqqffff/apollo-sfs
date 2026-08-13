package services

import (
	"strings"
	"testing"
)

// The password-reset email is the one leg of the forgot-password flow with no
// other coverage: SendPasswordReset and templates/password_reset.html shipped
// unused for as long as Keycloak's execute-actions-email owned the flow, so a
// missing field would only have shown up as a broken link in a real inbox.
func TestPasswordResetEmailRenders(t *testing.T) {
	svc, err := NewEmailService(nil, EmailConfig{
		SMTPAddr:     "postfix:587",
		MailFrom:     "noreply@example.com",
		AppName:      "Apollo SFS",
		AppURL:       "https://app.example.com",
		TemplatesDir: "../../templates",
	})
	if err != nil {
		t.Fatalf("new email service: %v", err)
	}

	const resetURL = "https://app.example.com/reset-password?token=abc123"
	html, err := svc.render("password_reset", map[string]any{
		"AppName":   "Apollo SFS",
		"AppURL":    "https://app.example.com",
		"Email":     "user@example.com",
		"Username":  "alice",
		"ResetURL":  resetURL,
		"ExpiresIn": "30 minutes",
	})
	if err != nil {
		t.Fatalf("render password_reset: %v", err)
	}

	// The link must survive intact — it is the only thing that identifies the
	// reset, and the token is the whole credential.
	if !strings.Contains(html, resetURL) {
		t.Errorf("rendered email is missing the reset URL:\n%s", html)
	}
	if !strings.Contains(html, "30 minutes") {
		t.Error("rendered email does not tell the user when the link expires")
	}
	if !strings.Contains(html, "alice") {
		t.Error("rendered email does not address the user")
	}
	// A template referencing an undefined field renders the literal Go zero
	// value rather than failing, so check for that too.
	if strings.Contains(html, "<no value>") {
		t.Errorf("rendered email has an unfilled field:\n%s", html)
	}
}
