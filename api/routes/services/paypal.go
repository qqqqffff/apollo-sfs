package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
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
	Environment  string // "sandbox" or "live"
	ClientID     string
	ClientSecret string
	WebhookID    string
	HTTPTimeout  time.Duration
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

	// Browser-safe client token cache (JS SDK v6 init) — separate from the
	// bearer token above; see BrowserSafeClientToken.
	clientTokenMu      sync.Mutex
	clientToken        string
	clientTokenExpires time.Time
	clientTokenDomains string
}

// PayPalClients bundles the live and (optional) sandbox PayPalClient
// instances. Handlers select between them per request via For, based on
// whether the acting admin's session-scoped "sandbox payments" toggle is on.
type PayPalClients struct {
	Live    *PayPalClient
	Sandbox *PayPalClient
}

// For returns the client for the given environment ("sandbox" | "live").
// Deliberately does NOT fall back to Live when Sandbox is nil — callers keep
// their existing nil-check ("payments not configured") so a toggled-on admin
// without sandbox credentials configured gets a clear error instead of being
// silently charged on the live account.
func (p PayPalClients) For(env string) *PayPalClient {
	if env == PayPalEnvSandbox {
		return p.Sandbox
	}
	return p.Live
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

// BrowserSafeClientToken mints (and caches) a browser-safe client token used
// to initialise the PayPal JS SDK v6 on the web frontend
// (paypal.createInstance({ clientToken }) — the Apple Pay integration
// standard, https://developer.paypal.com/apple-pay/integrate). Unlike
// bearer()'s access token, this token is domain-bound and safe to hand to the
// browser: PayPal issues it for response_type=client_token and it can only
// initialise the SDK, not call the REST API. Returns the token plus the
// seconds it remains valid.
func (p *PayPalClient) BrowserSafeClientToken(ctx context.Context, domains []string) (string, int, error) {
	key := strings.Join(domains, ",")
	p.clientTokenMu.Lock()
	defer p.clientTokenMu.Unlock()
	if p.clientToken != "" && p.clientTokenDomains == key && time.Now().Add(60*time.Second).Before(p.clientTokenExpires) {
		return p.clientToken, int(time.Until(p.clientTokenExpires).Seconds()), nil
	}

	// Per the v6 SDK docs the domains[] value is a single comma-separated
	// list, not a repeated form field.
	form := "grant_type=client_credentials&response_type=client_token&intent=sdk_init"
	if key != "" {
		form += "&domains[]=" + url.QueryEscape(key)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/v1/oauth2/token", strings.NewReader(form))
	if err != nil {
		return "", 0, err
	}
	req.SetBasicAuth(p.cfg.ClientID, p.cfg.ClientSecret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := p.http.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("paypal client token: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return "", 0, fmt.Errorf("paypal client token: %s: %s", resp.Status, string(b))
	}
	var tr struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		return "", 0, err
	}
	if tr.AccessToken == "" {
		return "", 0, errors.New("paypal client token: empty access_token in response")
	}
	p.clientToken = tr.AccessToken
	p.clientTokenExpires = time.Now().Add(time.Duration(tr.ExpiresIn) * time.Second)
	p.clientTokenDomains = key
	return p.clientToken, tr.ExpiresIn, nil
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
			"return_url":  in.ReturnURL,
			"cancel_url":  in.CancelURL,
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

// ── Wallet orders (no payment_source restriction) ────────────────────────────

// isWebURL reports whether u is an http(s) URL — the only schemes PayPal's
// REST Orders API accepts for application_context return/cancel URLs.
func isWebURL(u string) bool {
	return strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://")
}

// CreateWalletOrder creates a PayPal order with no payment_source set, and
// returns the order ID + approval URL. Leaving payment_source unset lets the
// buyer complete via the PayPal wallet button, Google Pay, or hosted card
// fields against the SAME order — unlike CreateOrder, which locks the order
// to a single funding source chosen up front. Used for storage add-ons and
// the premium checkout modal. The mobile app opens the approval URL, waits
// for the user to approve in the browser, then calls CaptureOrder.
func (p *PayPalClient) CreateWalletOrder(ctx context.Context, amountCents int, currency, returnURL, cancelURL string) (*CreateOrderResult, error) {
	if amountCents <= 0 {
		return nil, errors.New("paypal: amount must be > 0")
	}
	if currency == "" {
		currency = "USD"
	}
	value := fmt.Sprintf("%d.%02d", amountCents/100, amountCents%100)
	// PayPal's REST Orders API rejects application_context return/cancel URLs
	// that use a non-web scheme (e.g. the mobile app's apollosfs:// deep links),
	// failing order creation for the web JS-SDK button flow — where these URLs
	// are never used anyway (the SDK approves in-context, no browser redirect).
	// Include them only when they are http(s); otherwise omit them.
	appCtx := map[string]any{"user_action": "PAY_NOW"}
	if isWebURL(returnURL) {
		appCtx["return_url"] = returnURL
	}
	if isWebURL(cancelURL) {
		appCtx["cancel_url"] = cancelURL
	}
	payload := map[string]any{
		"intent": "CAPTURE",
		"purchase_units": []any{
			map[string]any{
				"amount": map[string]any{
					"currency_code": currency,
					"value":         value,
				},
			},
		},
		"application_context": appCtx,
	}
	body, _ := json.Marshal(payload)
	resp, err := p.doAuthed(ctx, http.MethodPost, "/v2/checkout/orders", bytes.NewReader(body), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("paypal create wallet order: %s: %s", resp.Status, string(b))
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

// CardOrderInput holds card details for DirectChargeCard.
type CardOrderInput struct {
	AmountCents int
	Currency    string
	Number      string
	ExpiryMonth string // "MM" — two digits
	ExpiryYear  string // "YYYY" — four digits
	CVV         string
	Name        string
}

// DirectChargeCard creates and immediately captures a PayPal order using raw
// card details (Advanced Credit and Debit Card Payments). Returns an error
// if PayPal requires 3DS (status PAYER_ACTION_REQUIRED).
func (p *PayPalClient) DirectChargeCard(ctx context.Context, in CardOrderInput) (*CaptureOrderResult, error) {
	if in.Currency == "" {
		in.Currency = "USD"
	}
	ps := map[string]any{
		"card": map[string]any{
			"number":        in.Number,
			"expiry":        in.ExpiryYear + "-" + in.ExpiryMonth,
			"security_code": in.CVV,
			"name":          in.Name,
		},
	}
	return p.directOrder(ctx, in.AmountCents, in.Currency, ps)
}

// ApplePayTokenInput holds fields decoded from a PKPaymentToken for
// DirectChargeApplePay.
type ApplePayTokenInput struct {
	AmountCents int
	Currency    string
	// payment_data fields from PKPaymentToken.paymentData
	Version   string
	Data      string
	Signature string
	Header    map[string]any
	// payment_method fields returned by our Swift module
	Network     string // e.g. "visa", "masterCard"
	DisplayName string // e.g. "Visa 1234"
}

// DirectChargeApplePay creates and immediately captures a PayPal order using
// a decrypted Apple Pay token from PKPaymentAuthorizationController.
func (p *PayPalClient) DirectChargeApplePay(ctx context.Context, in ApplePayTokenInput) (*CaptureOrderResult, error) {
	if in.Currency == "" {
		in.Currency = "USD"
	}
	ps := map[string]any{
		"apple_pay": map[string]any{
			"token": map[string]any{
				"payment_data": map[string]any{
					"version":   in.Version,
					"data":      in.Data,
					"signature": in.Signature,
					"header":    in.Header,
				},
				"payment_method": map[string]any{
					"display_name": in.DisplayName,
					"network":      strings.ToLower(in.Network),
					"type":         "credit",
				},
			},
		},
	}
	return p.directOrder(ctx, in.AmountCents, in.Currency, ps)
}

// DirectChargeGooglePay creates and immediately captures a PayPal order using
// a Google Pay token string (paymentMethodData.tokenizationData.token from
// the Google Pay sheet, gateway-tokenized by PayPal).
func (p *PayPalClient) DirectChargeGooglePay(ctx context.Context, amountCents int, currency, googlePayToken string) (*CaptureOrderResult, error) {
	if currency == "" {
		currency = "USD"
	}
	ps := map[string]any{
		"google_pay": map[string]any{
			"payment_data": map[string]any{
				"payment_method_data": map[string]any{
					"type": "CARD",
					"tokenization_data": map[string]any{
						"type":  "PAYMENT_GATEWAY",
						"token": googlePayToken,
					},
				},
			},
		},
	}
	return p.directOrder(ctx, amountCents, currency, ps)
}

// directOrder is the shared POST-to-v2/checkout/orders implementation for all
// direct-capture payment sources (card, Apple Pay, Google Pay). PayPal creates
// and captures the order in a single call, returning status COMPLETED on
// success. Returns an error if 3DS is required (PAYER_ACTION_REQUIRED) —
// callers should surface an alternative payment option to the user.
func (p *PayPalClient) directOrder(ctx context.Context, amountCents int, currency string, paymentSource map[string]any) (*CaptureOrderResult, error) {
	if amountCents <= 0 {
		return nil, errors.New("paypal: amount must be > 0")
	}
	value := fmt.Sprintf("%d.%02d", amountCents/100, amountCents%100)
	payload := map[string]any{
		"intent": "CAPTURE",
		"purchase_units": []any{
			map[string]any{
				"amount": map[string]any{
					"currency_code": currency,
					"value":         value,
				},
			},
		},
		"payment_source": paymentSource,
	}
	body, _ := json.Marshal(payload)
	resp, err := p.doAuthed(ctx, http.MethodPost, "/v2/checkout/orders", bytes.NewReader(body), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		var ppErr struct {
			Message string `json:"message"`
			Details []struct {
				Description string `json:"description"`
			} `json:"details"`
		}
		if jerr := json.Unmarshal(raw, &ppErr); jerr == nil && ppErr.Message != "" {
			if len(ppErr.Details) > 0 {
				return nil, fmt.Errorf("paypal: %s: %s", ppErr.Message, ppErr.Details[0].Description)
			}
			return nil, fmt.Errorf("paypal: %s", ppErr.Message)
		}
		return nil, fmt.Errorf("paypal direct charge: %s: %s", resp.Status, string(raw))
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
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("paypal direct charge decode: %w", err)
	}
	if parsed.Status == "PAYER_ACTION_REQUIRED" {
		return nil, errors.New("3DS authentication required; please use PayPal wallet checkout instead")
	}
	if len(parsed.PurchaseUnits) == 0 || len(parsed.PurchaseUnits[0].Payments.Captures) == 0 {
		return nil, fmt.Errorf("paypal direct charge: unexpected status %q (no captures in response)", parsed.Status)
	}
	cap := parsed.PurchaseUnits[0].Payments.Captures[0]
	cents, err := parseAmountCents(cap.Amount.Value)
	if err != nil {
		return nil, fmt.Errorf("paypal direct charge amount: %w", err)
	}
	return &CaptureOrderResult{
		OrderID:     parsed.ID,
		CaptureID:   cap.ID,
		AmountCents: cents,
		Currency:    cap.Amount.CurrencyCode,
		Status:      parsed.Status,
		Raw:         raw,
	}, nil
}

// RefundResult holds the outcome of a successful refund call.
type RefundResult struct {
	RefundID string
	Status   string
}

// RefundCapture issues a partial or full refund against a previously captured
// payment. captureID is the PayPal capture ID; amountCents and currency must
// match the original charge.
func (p *PayPalClient) RefundCapture(ctx context.Context, captureID string, amountCents int, currency string) (*RefundResult, error) {
	if currency == "" {
		currency = "USD"
	}
	value := fmt.Sprintf("%d.%02d", amountCents/100, amountCents%100)
	payload := map[string]any{
		"amount": map[string]any{
			"value":         value,
			"currency_code": currency,
		},
	}
	body, _ := json.Marshal(payload)
	resp, err := p.doAuthed(ctx, http.MethodPost,
		fmt.Sprintf("/v2/payments/captures/%s/refund", captureID),
		bytes.NewReader(body), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		var ppErr struct {
			Message string `json:"message"`
		}
		if jerr := json.Unmarshal(raw, &ppErr); jerr == nil && ppErr.Message != "" {
			return nil, fmt.Errorf("paypal refund: %s", ppErr.Message)
		}
		return nil, fmt.Errorf("paypal refund: %s: %s", resp.Status, string(raw))
	}
	var parsed struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("paypal refund decode: %w", err)
	}
	return &RefundResult{RefundID: parsed.ID, Status: parsed.Status}, nil
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

// CreateSubscriptionInput is the parameter set for CreateSubscription.
type CreateSubscriptionInput struct {
	PlanID    string
	ReturnURL string
	CancelURL string
}

// CreateSubscriptionResult is the relevant subset of PayPal's create
// subscription response. ApproveURL is what the frontend redirects the
// shopper to in order to approve the subscription on PayPal's hosted page.
type CreateSubscriptionResult struct {
	SubscriptionID string
	ApproveURL     string
}

// CreateSubscription issues a v1 Billing Subscriptions create call. Approving
// the subscription does not by itself grant premium — that happens when the
// BILLING.SUBSCRIPTION.ACTIVATED webhook (or the post-redirect confirm
// endpoint, as a latency shortcut) reports status ACTIVE.
func (p *PayPalClient) CreateSubscription(ctx context.Context, in CreateSubscriptionInput) (*CreateSubscriptionResult, error) {
	if in.PlanID == "" {
		return nil, errors.New("paypal: plan_id required")
	}
	payload := map[string]any{
		"plan_id": in.PlanID,
		"application_context": map[string]any{
			"return_url":  in.ReturnURL,
			"cancel_url":  in.CancelURL,
			"user_action": "SUBSCRIBE_NOW",
		},
	}
	body, _ := json.Marshal(payload)
	resp, err := p.doAuthed(ctx, http.MethodPost, "/v1/billing/subscriptions", bytes.NewReader(body), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("paypal create subscription: %s: %s", resp.Status, string(raw))
	}
	var out struct {
		ID    string `json:"id"`
		Links []struct {
			Href string `json:"href"`
			Rel  string `json:"rel"`
		} `json:"links"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	approve := ""
	for _, l := range out.Links {
		if l.Rel == "approve" {
			approve = l.Href
			break
		}
	}
	return &CreateSubscriptionResult{SubscriptionID: out.ID, ApproveURL: approve}, nil
}

// SubscriptionDetails is the relevant subset of PayPal's get-subscription
// response, used both by the post-redirect confirm endpoint and the
// reconciliation loop's missed-webhook safety net.
type SubscriptionDetails struct {
	ID              string
	Status          string // APPROVAL_PENDING|APPROVED|ACTIVE|SUSPENDED|CANCELLED|EXPIRED
	PlanID          string
	NextBillingTime *time.Time
}

// GetSubscription fetches a subscription's current status and billing info.
func (p *PayPalClient) GetSubscription(ctx context.Context, subscriptionID string) (*SubscriptionDetails, error) {
	resp, err := p.doAuthed(ctx, http.MethodGet, "/v1/billing/subscriptions/"+subscriptionID, nil, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("paypal get subscription: %s: %s", resp.Status, string(raw))
	}
	var out struct {
		ID          string `json:"id"`
		Status      string `json:"status"`
		PlanID      string `json:"plan_id"`
		BillingInfo struct {
			NextBillingTime *time.Time `json:"next_billing_time"`
		} `json:"billing_info"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("paypal get subscription decode: %w", err)
	}
	return &SubscriptionDetails{
		ID:              out.ID,
		Status:          out.Status,
		PlanID:          out.PlanID,
		NextBillingTime: out.BillingInfo.NextBillingTime,
	}, nil
}

// CancelSubscription cancels an active or suspended subscription on PayPal's
// side. Idempotent from the caller's perspective: PayPal returns 422 for an
// already-cancelled subscription, which is treated as success here since the
// desired end state (not billing again) already holds.
func (p *PayPalClient) CancelSubscription(ctx context.Context, subscriptionID, reason string) error {
	payload := map[string]any{"reason": reason}
	body, _ := json.Marshal(payload)
	resp, err := p.doAuthed(ctx, http.MethodPost, "/v1/billing/subscriptions/"+subscriptionID+"/cancel", bytes.NewReader(body), nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusUnprocessableEntity {
		return nil
	}
	raw, _ := io.ReadAll(resp.Body)
	return fmt.Errorf("paypal cancel subscription: %s: %s", resp.Status, string(raw))
}

// SubscriptionTransaction is one billing-cycle payment record for a
// subscription, as returned by ListSubscriptionTransactions.
type SubscriptionTransaction struct {
	ID          string // sale/transaction id — refundable via RefundSale
	Status      string // e.g. "COMPLETED", "PENDING", "DECLINED"
	AmountCents int
	Currency    string
	Time        time.Time
}

// ListSubscriptionTransactions lists a subscription's billing transactions in
// [start, end] (PayPal requires both bounds). Used to locate the sale behind
// the subscription's current billing period when an admin cancellation needs
// to issue a prorated refund — PayPal Subscriptions v1 has no "give me the
// last charge" endpoint, only this range query.
func (p *PayPalClient) ListSubscriptionTransactions(ctx context.Context, subscriptionID string, start, end time.Time) ([]SubscriptionTransaction, error) {
	path := fmt.Sprintf("/v1/billing/subscriptions/%s/transactions?start_time=%s&end_time=%s",
		subscriptionID,
		strings.ReplaceAll(start.UTC().Format(time.RFC3339), "+", "%2B"),
		strings.ReplaceAll(end.UTC().Format(time.RFC3339), "+", "%2B"))
	resp, err := p.doAuthed(ctx, http.MethodGet, path, nil, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("paypal list subscription transactions: %s: %s", resp.Status, string(raw))
	}
	var out struct {
		Transactions []struct {
			ID                  string `json:"id"`
			Status              string `json:"status"`
			AmountWithBreakdown struct {
				GrossAmount struct {
					CurrencyCode string `json:"currency_code"`
					Value        string `json:"value"`
				} `json:"gross_amount"`
			} `json:"amount_with_breakdown"`
			Time time.Time `json:"time"`
		} `json:"transactions"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("paypal list subscription transactions decode: %w", err)
	}
	txs := make([]SubscriptionTransaction, 0, len(out.Transactions))
	for _, t := range out.Transactions {
		cents, err := parseAmountCents(t.AmountWithBreakdown.GrossAmount.Value)
		if err != nil {
			continue
		}
		txs = append(txs, SubscriptionTransaction{
			ID:          t.ID,
			Status:      t.Status,
			AmountCents: cents,
			Currency:    t.AmountWithBreakdown.GrossAmount.CurrencyCode,
			Time:        t.Time,
		})
	}
	return txs, nil
}

// RefundSale issues a partial or full refund against a subscription billing
// charge. Subscription payments are "sale" transactions, not Orders v2
// captures, so they're refunded through the legacy Payments v1 API
// (/v1/payments/sale/{id}/refund) rather than RefundCapture's v2 endpoint.
// amountCents <= 0 refunds the sale in full.
func (p *PayPalClient) RefundSale(ctx context.Context, saleID string, amountCents int, currency string) (*RefundResult, error) {
	if currency == "" {
		currency = "USD"
	}
	payload := map[string]any{}
	if amountCents > 0 {
		payload["amount"] = map[string]any{
			"total":    fmt.Sprintf("%d.%02d", amountCents/100, amountCents%100),
			"currency": currency,
		}
	}
	body, _ := json.Marshal(payload)
	resp, err := p.doAuthed(ctx, http.MethodPost,
		fmt.Sprintf("/v1/payments/sale/%s/refund", saleID),
		bytes.NewReader(body), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		var ppErr struct {
			Message string `json:"message"`
		}
		if jerr := json.Unmarshal(raw, &ppErr); jerr == nil && ppErr.Message != "" {
			return nil, fmt.Errorf("paypal refund sale: %s", ppErr.Message)
		}
		return nil, fmt.Errorf("paypal refund sale: %s: %s", resp.Status, string(raw))
	}
	var parsed struct {
		ID    string `json:"id"`
		State string `json:"state"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("paypal refund sale decode: %w", err)
	}
	return &RefundResult{RefundID: parsed.ID, Status: parsed.State}, nil
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
