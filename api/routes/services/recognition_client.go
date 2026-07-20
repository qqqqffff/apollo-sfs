package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// RecognitionClient talks to the internal recognition sidecar over the
// overlay network, authenticated by the X-Internal-Token shared secret
// (same pattern as the node-agent → node-metrics-ingest client). The sidecar
// is stateless: plaintext image bytes in, detections + embeddings out.
type RecognitionClient struct {
	baseURL string
	token   string
	http    *http.Client
}

// AnalyzedFace is one detected face. BBox is [x, y, w, h] normalized to the
// source image; Embedding is a unit-normalized 512-d vector.
type AnalyzedFace struct {
	BBox       []float32 `json:"bbox"`
	Confidence float32   `json:"confidence"`
	Embedding  []float32 `json:"embedding"`
}

// AnalyzedPet is one detected cat/dog with a re-ID embedding.
type AnalyzedPet struct {
	Class      string    `json:"class"`
	BBox       []float32 `json:"bbox"`
	Confidence float32   `json:"confidence"`
	Embedding  []float32 `json:"embedding"`
}

// AnalyzedObject is one generic COCO-class detection (person/cat/dog are
// already filtered out by the sidecar).
type AnalyzedObject struct {
	Class      string    `json:"class"`
	BBox       []float32 `json:"bbox"`
	Confidence float32   `json:"confidence"`
}

// AnalyzeResult is the sidecar's full response for one image.
type AnalyzeResult struct {
	Faces         []AnalyzedFace    `json:"faces"`
	Pets          []AnalyzedPet     `json:"pets"`
	Objects       []AnalyzedObject  `json:"objects"`
	ModelVersions map[string]string `json:"model_versions"`
}

// NewRecognitionClient returns a client for the sidecar at baseURL, or nil
// when baseURL is empty (feature disabled).
func NewRecognitionClient(baseURL, token string) *RecognitionClient {
	if baseURL == "" {
		return nil
	}
	return &RecognitionClient{
		baseURL: baseURL,
		token:   token,
		// CPU inference on large photos can take tens of seconds.
		http: &http.Client{Timeout: 60 * time.Second},
	}
}

// Analyze sends one plaintext image to the sidecar and returns its detections.
func (c *RecognitionClient) Analyze(ctx context.Context, image []byte, contentType string) (*AnalyzeResult, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/v1/analyze", bytes.NewReader(image))
	if err != nil {
		return nil, fmt.Errorf("recognition analyze: %w", err)
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("X-Internal-Token", c.token)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("recognition analyze: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("recognition analyze: status %d: %s", resp.StatusCode, bytes.TrimSpace(body))
	}

	var out AnalyzeResult
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("recognition analyze: decode: %w", err)
	}
	return &out, nil
}

// Healthy reports whether the sidecar responds on /healthz.
func (c *RecognitionClient) Healthy(ctx context.Context) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/healthz", nil)
	if err != nil {
		return false
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}
