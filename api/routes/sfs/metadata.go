package sfs

import (
	"path"
	"strings"
	"time"

	"apollo-sfs.com/api/models"
)

// ObjectMetadata is the canonical response shape returned by every SFS
// endpoint. Times are always UTC; "parent" is the folder UUID or the
// literal "root" sentinel.
type ObjectMetadata struct {
	Key            string    `json:"key"`
	Parent         string    `json:"parent"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
	RemainingQuota int64     `json:"remaining_quota"`
	Size           int64     `json:"size"`
	ContentType    string    `json:"content_type"`
	Extension      string    `json:"extension"`
}

// BuildMetadata fills an ObjectMetadata for the given file/user.
// fullKey is the slash-joined key the caller used (or that ResolvePath
// reconstructed); it is echoed back verbatim so clients can correlate.
func BuildMetadata(file *models.File, user *models.User, fullKey string) ObjectMetadata {
	parent := "root"
	if file.FolderID != nil {
		parent = file.FolderID.String()
	}
	ext := ""
	if i := strings.LastIndex(file.Name, "."); i > 0 && i < len(file.Name)-1 {
		ext = file.Name[i+1:]
	}
	remaining := user.StorageQuotaBytes - user.StorageUsedBytes
	if remaining < 0 {
		remaining = 0
	}
	return ObjectMetadata{
		Key:            fullKey,
		Parent:         parent,
		CreatedAt:      file.CreatedAt.UTC(),
		UpdatedAt:      file.UpdatedAt.UTC(),
		RemainingQuota: remaining,
		Size:           file.SizeBytes,
		ContentType:    file.MimeType,
		Extension:      ext,
	}
}

// JoinPath rebuilds an SFS-style key from segments and leaf.
// Empty segments yield just the leaf (root-level object).
func JoinPath(segments []string, leaf string) string {
	if len(segments) == 0 {
		return leaf
	}
	return path.Join(strings.Join(segments, "/"), leaf)
}
