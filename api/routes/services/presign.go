package services

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Action constants for presigned tokens.
const (
	PresignActionDownload       = "download"
	PresignActionPreview        = "preview"
	PresignActionUpload         = "upload"
	PresignActionUploadChunked  = "upload_chunked"
)

var (
	ErrPresignExpired = errors.New("presigned URL has expired")
	ErrPresignInvalid = errors.New("invalid presigned token")
)

// PresignService issues and validates HMAC-SHA256 signed, time-limited tokens.
// Tokens are base64url(json).base64url(hmac) strings passed as ?token= query
// parameters on presigned routes that do not require a session cookie.
type PresignService struct {
	secret []byte
}

// NewPresignService creates a PresignService keyed with secret.
func NewPresignService(secret string) *PresignService {
	return &PresignService{secret: []byte(secret)}
}

// ── File download / preview ───────────────────────────────────────────────────

type fileClaim struct {
	FileID    string `json:"fid"`
	UserID    string `json:"uid"`
	Username  string `json:"usr"`
	Action    string `json:"act"`
	ExpiresAt int64  `json:"exp"`
}

// IssueForFile returns a signed token that authorises action (download or
// preview) on fileID for userID/username for the duration of expiry.
func (s *PresignService) IssueForFile(fileID, userID, username, action string, expiry time.Duration) (token string, expiresAt time.Time, err error) {
	exp := time.Now().Add(expiry)
	token, err = s.sign(fileClaim{
		FileID:    fileID,
		UserID:    userID,
		Username:  username,
		Action:    action,
		ExpiresAt: exp.Unix(),
	})
	return token, exp, err
}

// FilePresignClaim is the decoded and validated result of ValidateForFile.
type FilePresignClaim struct {
	FileID   string
	UserID   string
	Username string
}

// ValidateForFile parses and verifies a file presign token, returning the
// embedded claims. Returns ErrPresignExpired or ErrPresignInvalid on failure.
func (s *PresignService) ValidateForFile(token, expectedAction string) (*FilePresignClaim, error) {
	var c fileClaim
	if err := s.verify(token, &c); err != nil {
		return nil, err
	}
	if c.Action != expectedAction {
		return nil, ErrPresignInvalid
	}
	return &FilePresignClaim{FileID: c.FileID, UserID: c.UserID, Username: c.Username}, nil
}

// ── Single-file upload ────────────────────────────────────────────────────────

type uploadClaim struct {
	UserID    string  `json:"uid"`
	Username  string  `json:"usr"`
	FolderID  *string `json:"fid,omitempty"`
	MaxBytes  int64   `json:"max"`
	Action    string  `json:"act"`
	ExpiresAt int64   `json:"exp"`
}

// IssueForUpload returns a signed token that authorises a single-file upload
// for userID/username into folderID (nil = root) up to maxBytes.
func (s *PresignService) IssueForUpload(userID, username string, folderID *string, maxBytes int64, expiry time.Duration) (token string, expiresAt time.Time, err error) {
	exp := time.Now().Add(expiry)
	token, err = s.sign(uploadClaim{
		UserID:    userID,
		Username:  username,
		FolderID:  folderID,
		MaxBytes:  maxBytes,
		Action:    PresignActionUpload,
		ExpiresAt: exp.Unix(),
	})
	return token, exp, err
}

// UploadPresignClaim is the decoded result of ValidateForUpload.
type UploadPresignClaim struct {
	UserID   string
	Username string
	FolderID *string
	MaxBytes int64
}

// ValidateForUpload parses and verifies a single-file upload presign token.
func (s *PresignService) ValidateForUpload(token string) (*UploadPresignClaim, error) {
	var c uploadClaim
	if err := s.verify(token, &c); err != nil {
		return nil, err
	}
	if c.Action != PresignActionUpload {
		return nil, ErrPresignInvalid
	}
	return &UploadPresignClaim{
		UserID:   c.UserID,
		Username: c.Username,
		FolderID: c.FolderID,
		MaxBytes: c.MaxBytes,
	}, nil
}

// ── Chunked upload session ────────────────────────────────────────────────────

type chunkedUploadClaim struct {
	SessionID string `json:"sid"`
	UserID    string `json:"uid"`
	Action    string `json:"act"`
	ExpiresAt int64  `json:"exp"`
}

// IssueForChunkedUpload returns a signed token that authorises chunk uploads
// and completion for an existing upload session.
func (s *PresignService) IssueForChunkedUpload(sessionID, userID string, expiry time.Duration) (token string, expiresAt time.Time, err error) {
	exp := time.Now().Add(expiry)
	token, err = s.sign(chunkedUploadClaim{
		SessionID: sessionID,
		UserID:    userID,
		Action:    PresignActionUploadChunked,
		ExpiresAt: exp.Unix(),
	})
	return token, exp, err
}

// ChunkedUploadPresignClaim is the decoded result of ValidateForChunkedUpload.
type ChunkedUploadPresignClaim struct {
	SessionID string
	UserID    string
}

// ValidateForChunkedUpload parses and verifies a chunked-upload session token.
func (s *PresignService) ValidateForChunkedUpload(token string) (*ChunkedUploadPresignClaim, error) {
	var c chunkedUploadClaim
	if err := s.verify(token, &c); err != nil {
		return nil, err
	}
	if c.Action != PresignActionUploadChunked {
		return nil, ErrPresignInvalid
	}
	return &ChunkedUploadPresignClaim{SessionID: c.SessionID, UserID: c.UserID}, nil
}

// ── Internal helpers ──────────────────────────────────────────────────────────

func (s *PresignService) sign(v any) (string, error) {
	payload, err := json.Marshal(v)
	if err != nil {
		return "", fmt.Errorf("presign: marshal: %w", err)
	}
	p64 := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(p64))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return p64 + "." + sig, nil
}

func (s *PresignService) verify(token string, dst any) error {
	dot := strings.LastIndexByte(token, '.')
	if dot < 0 {
		return ErrPresignInvalid
	}
	p64, sig := token[:dot], token[dot+1:]

	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(p64))
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(sig), []byte(expected)) {
		return ErrPresignInvalid
	}

	payload, err := base64.RawURLEncoding.DecodeString(p64)
	if err != nil {
		return ErrPresignInvalid
	}

	var exp struct {
		ExpiresAt int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &exp); err != nil {
		return ErrPresignInvalid
	}
	if time.Now().Unix() > exp.ExpiresAt {
		return ErrPresignExpired
	}

	if err := json.Unmarshal(payload, dst); err != nil {
		return ErrPresignInvalid
	}
	return nil
}
