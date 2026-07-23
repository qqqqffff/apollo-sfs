package auth

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// turnstileVerifyURL is Cloudflare's server-side verification endpoint.
const turnstileVerifyURL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

// verifyTurnstile calls Cloudflare's siteverify endpoint and returns true when
// the token is valid. remoteIP is forwarded for Cloudflare's analytics.
func verifyTurnstile(secret, token, remoteIP string) (bool, error) {
	resp, err := http.PostForm(turnstileVerifyURL, url.Values{
		"secret":   {secret},
		"response": {token},
		"remoteip": {remoteIP},
	})
	if err != nil {
		return false, fmt.Errorf("turnstile: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, fmt.Errorf("turnstile read body: %w", err)
	}

	var result struct {
		Success bool `json:"success"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return false, fmt.Errorf("turnstile parse: %w", err)
	}
	return result.Success, nil
}
