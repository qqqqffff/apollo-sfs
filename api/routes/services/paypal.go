package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// PayPalEnvironment values. The base API URL is selected from these by
// NewPayPalClient — sandbox is mandatory for development; live is the
// production endpoint.
const (
	PayPalEnvSandbox = "sandbox"
	PayPalEnvLive    = "live"
)

const (
	payPalSandboxBase = "https://api-m.sandbox.paypal.com"
	payPalLiveBase    = "https://api-m.paypal.com"
)

// PayPalConfig is the dependency-injection bag for NewPayPalClient.
type PayPalConfig struct {
	Environment   string // "sandbox" or "live"
	ClientID      string
	ClientSecret  string
	WebhookID     string
	HTTPTimeout   time.Duration
}

// PayPalClient is a tiny wrapper around the PayPal Orders v2 + Webhooks
// REST API. It caches an OAuth bearer token in memory and refreshes
// proactively (60 s before expiry) and reactively (on 401).
type PayPalClient struct {
	cfg     PayPalConfig
	baseURL string
	http    *http.Client

	tokenMu sync.Mutex
	token   string
	expires time.Time
}

// NewPayPalClient constructs a PayPalClient. Returns nil when ClientID or
// ClientSecret is empty so the caller can treat the payments feature as
// "not configured" and degrade gracefully (the routes return 503).
func NewPayPalClient(cfg PayPalConfig) *PayPalClient {
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		return nil
	}
	base := payPalSandboxBase
	if cfg.Environment == PayPalEnvLive {
		base = payPalLiveBase
	}
	timeout := cfg.HTTPTimeout
	if timeout == 0 {
		timeout = 15 * time.Second
	}
	return &PayPalClient{
		cfg:     cfg,
		baseURL: base,
		http:    &http.Client{Timeout: timeout},
	}
}

// ── Tokens ────────────────────────────────────────────────────────────────────

func (p *PayPalClient) bearer(ctx context.Context) (string, error) {
	p.tokenMu.Lock()
	defer p.tokenMu.Unlock()
	if p.token != "" && time.Now().Add(60*time.Second).Before(p.expires) {
		return p.token, nil
	}
	body := strings.NewReader("grant_type=client_credentials")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/v1/oauth2/token", body)
	if err != nil {
		return "", err
	}
	req.SetBasicAuth(p.cfg.ClientID, p.cfg.ClientSecret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := p.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("paypal token: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("paypal token: %s: %s", resp.Status, string(b))
	}
	var tr struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		return "", err
	}
	p.token = tr.AccessToken
	p.expires = time.Now().Add(time.Duration(tr.ExpiresIn) * time.Second)
	return p.token, nil
}

// ── Orders ────────────────────────────────────────────────────────────────────

// CreateOrderInput is the parameter set for CreateOrder.
type CreateOrderInput struct {
	AmountCents   int
	Currency      string
	PaymentMethod string // "apple_pay" or "card"
	ReturnURL     string // browser redirect target on approval
	CancelURL     string // browser redirect target on cancel
}

// CreateOrderResult is the relevant subset of the PayPal CreateOrder
// response. ApproveURL is what the frontend redirects (or pops up) the
// shopper to.
type CreateOrderResult struct {
	OrderID    string
	ApproveURL string
}

// CreateOrder issues a v2 Orders create call with intent=CAPTURE and the
// requested payment_source.
func (p *PayPalClient) CreateOrder(ctx context.Context, in CreateOrderInput) (*CreateOrderResult, error) {
	if in.AmountCents <= 0 {
		return nil, errors.New("paypal: amount must be > 0")
	}
	if in.Currency == "" {
		in.Currency = "USD"
	}
	value := fmt.Sprintf("%d.%02d", in.AmountCents/100, in.AmountCents%100)

	ps := map[string]any{}
	switch in.PaymentMethod {
	case "apple_pay":
		ps["apple_pay"] = map[string]any{}
	case "card":
		ps["card"] = map[string]any{}
	default:
		return nil, fmt.Errorf("paypal: unknown payment_method %q", in.PaymentMethod)
	}

	payload := map[string]any{
		"intent": "CAPTURE",
		"purchase_units": []any{
			map[string]any{
				"amount": map[string]any{
					"currency_code": in.Currency,
					"value":         value,
				},
			},
		},
		"payment_source": ps,
		"application_context": map[string]any{
			"return_url": in.ReturnURL,
			"cancel_url": in.CancelURL,
			"user_action": "PAY_NOW",
		},
	}
	body, _ := json.Marshal(payload)
	resp, err := p.doAuthed(ctx, http.MethodPost, "/v2/checkout/orders", bytes.NewReader(body), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("paypal create order: %s: %s", resp.Status, string(b))
	}
	var out struct {
		ID    string `json:"id"`
		Links []struct {
			Href string `json:"href"`
			Rel  string `json:"rel"`
		} `json:"links"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	approve := ""
	for _, l := range out.Links {
		if l.Rel == "approve" || l.Rel == "payer-action" {
			approve = l.Href
			break
		}
	}
	return &CreateOrderResult{OrderID: out.ID, ApproveURL: approve}, nil
}

// CaptureOrderResult is the relevant subset of the PayPal CaptureOrder
// response. AmountCents is parsed from the (currency, value) pair.
type CaptureOrderResult struct {
	OrderID     string
	CaptureID   string
	AmountCents int
	Currency    string
	Status      string
	Raw         json.RawMessage
}

// CaptureOrder finalises payment on a previously approved order. The
// returned CaptureID is the idempotency key shared with the webhook.
func (p *PayPalClient) CaptureOrder(ctx context.Context, orderID string) (*CaptureOrderResult, error) {
	resp, err := p.doAuthed(ctx, http.MethodPost, "/v2/checkout/orders/"+orderID+"/capture", strings.NewReader("{}"), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("paypal capture: %s: %s", resp.Status, string(body))
	}
	var parsed struct {
		ID            string `json:"id"`
		Status        string `json:"status"`
		PurchaseUnits []struct {
			Payments struct {
				Captures []struct {
					ID     string `json:"id"`
					Amount struct {
						CurrencyCode string `json:"currency_code"`
						Value        string `json:"value"`
					} `json:"amount"`
				} `json:"captures"`
			} `json:"payments"`
		} `json:"purchase_units"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("paypal capture decode: %w", err)
	}
	if len(parsed.PurchaseUnits) == 0 || len(parsed.PurchaseUnits[0].Payments.Captures) == 0 {
		return nil, errors.New("paypal capture: empty captures array")
	}
	cap := parsed.PurchaseUnits[0].Payments.Captures[0]
	cents, err := parseAmountCents(cap.Amount.Value)
	if err != nil {
		return nil, fmt.Errorf("paypal capture amount: %w", err)
	}
	return &CaptureOrderResult{
		OrderID:     parsed.ID,
		CaptureID:   cap.ID,
		AmountCents: cents,
		Currency:    cap.Amount.CurrencyCode,
		Status:      parsed.Status,
		Raw:         body,
	}, nil
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

// VerifyWebhook calls PayPal's signature-verification endpoint with the
// inbound headers and raw body. Returns true only on a "SUCCESS"
// verification_status response — any other outcome is logged.
func (p *PayPalClient) VerifyWebhook(ctx context.Context, headers http.Header, body []byte) (bool, error) {
	payload := map[string]any{
		"auth_algo":         headers.Get("paypal-auth-algo"),
		"cert_url":          headers.Get("paypal-cert-url"),
		"transmission_id":   headers.Get("paypal-transmission-id"),
		"transmission_sig":  headers.Get("paypal-transmission-sig"),
		"transmission_time": headers.Get("paypal-transmission-time"),
		"webhook_id":        p.cfg.WebhookID,
		"webhook_event":     json.RawMessage(body),
	}
	js, _ := json.Marshal(payload)
	resp, err := p.doAuthed(ctx, http.MethodPost, "/v1/notifications/verify-webhook-signature", bytes.NewReader(js), nil)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return false, fmt.Errorf("paypal verify webhook: %s: %s", resp.Status, string(b))
	}
	var out struct {
		VerificationStatus string `json:"verification_status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return false, err
	}
	return out.VerificationStatus == "SUCCESS", nil
}

// ── Plumbing ──────────────────────────────────────────────────────────────────

func (p *PayPalClient) doAuthed(ctx context.Context, method, path string, body io.Reader, extra http.Header) (*http.Response, error) {
	token, err := p.bearer(ctx)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, p.baseURL+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	for k, v := range extra {
		for _, vv := range v {
			req.Header.Add(k, vv)
		}
	}
	resp, err := p.http.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusUnauthorized {
		// Refresh and retry once.
		_ = resp.Body.Close()
		p.tokenMu.Lock()
		p.token = ""
		p.tokenMu.Unlock()
		token, err = p.bearer(ctx)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		return p.http.Do(req)
	}
	return resp, nil
}

// parseAmountCents parses a PayPal "12.34"-style decimal amount to cents.
// Rejects negative values or more than 2 decimal places.
func parseAmountCents(v string) (int, error) {
	v = strings.TrimSpace(v)
	parts := strings.Split(v, ".")
	switch len(parts) {
	case 1:
		whole, err := strconv.Atoi(parts[0])
		if err != nil || whole < 0 {
			return 0, fmt.Errorf("invalid amount %q", v)
		}
		return whole * 100, nil
	case 2:
		if len(parts[1]) != 2 {
			return 0, fmt.Errorf("invalid amount %q (need 2 decimal places)", v)
		}
		whole, err1 := strconv.Atoi(parts[0])
		frac, err2 := strconv.Atoi(parts[1])
		if err1 != nil || err2 != nil || whole < 0 || frac < 0 {
			return 0, fmt.Errorf("invalid amount %q", v)
		}
		return whole*100 + frac, nil
	}
	return 0, fmt.Errorf("invalid amount %q", v)
}
