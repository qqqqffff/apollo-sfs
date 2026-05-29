package sfs

import (
	"errors"
	"strings"

	"apollo-sfs.com/api/sanitize"
)

// Limits on object key shape. These exist to keep folder fan-out and DB
// rows bounded, and to make ParseObjectKey output predictable for the
// presigned URL flow downstream.
const (
	maxKeyDepth      = 32
	maxSegmentLength = 255
)

// ParsedKey is the structured representation of an SFS object key like
// "photos/2024/cat.jpg". Segments excludes the leaf; FullPath is the
// (normalised) key as it should appear in audit logs and metadata
// responses.
type ParsedKey struct {
	Segments  []string
	Leaf      string
	Extension string
	FullPath  string
}

// ParseObjectKey validates and structures a user-supplied SFS key.
// Reject reasons: leading slash, empty segments (double slashes), "."/".."
// path traversal, control characters, > maxKeyDepth nesting, > 255 chars
// per segment. Each segment is run through sanitize.Name to strip the
// platform-illegal characters the rest of the codebase already prohibits.
func ParseObjectKey(raw string) (*ParsedKey, error) {
	if raw == "" {
		return nil, errors.New("object key: empty")
	}
	if strings.HasPrefix(raw, "/") {
		return nil, errors.New("object key: must not start with /")
	}
	if strings.Contains(raw, "//") {
		return nil, errors.New("object key: must not contain //")
	}
	parts := strings.Split(raw, "/")
	if len(parts) > maxKeyDepth {
		return nil, errors.New("object key: too deep")
	}

	cleaned := make([]string, 0, len(parts))
	for _, p := range parts {
		if p == "" || p == "." || p == ".." {
			return nil, errors.New("object key: invalid segment")
		}
		for _, r := range p {
			if r < 0x20 || r == 0x7f {
				return nil, errors.New("object key: control character in segment")
			}
		}
		san := sanitize.Name(p, maxSegmentLength)
		if san == "" {
			return nil, errors.New("object key: segment becomes empty after sanitisation")
		}
		cleaned = append(cleaned, san)
	}
	leaf := cleaned[len(cleaned)-1]
	segs := cleaned[:len(cleaned)-1]
	ext := ""
	if i := strings.LastIndex(leaf, "."); i > 0 && i < len(leaf)-1 {
		ext = leaf[i+1:]
	}
	return &ParsedKey{
		Segments:  segs,
		Leaf:      leaf,
		Extension: ext,
		FullPath:  strings.Join(cleaned, "/"),
	}, nil
}

// ParsedPrefix mirrors ParsedKey but for prefix-style inputs (no required
// leaf). Used by /list. An empty input is valid and means "root".
type ParsedPrefix struct {
	Segments []string
	FullPath string
}

// ParsePrefix validates a directory-style prefix. Same rules as
// ParseObjectKey except the trailing segment is optional and the empty
// string is allowed (= root listing).
func ParsePrefix(raw string) (*ParsedPrefix, error) {
	raw = strings.TrimSuffix(raw, "/")
	if raw == "" {
		return &ParsedPrefix{}, nil
	}
	if strings.HasPrefix(raw, "/") {
		return nil, errors.New("prefix: must not start with /")
	}
	if strings.Contains(raw, "//") {
		return nil, errors.New("prefix: must not contain //")
	}
	parts := strings.Split(raw, "/")
	if len(parts) > maxKeyDepth {
		return nil, errors.New("prefix: too deep")
	}
	cleaned := make([]string, 0, len(parts))
	for _, p := range parts {
		if p == "" || p == "." || p == ".." {
			return nil, errors.New("prefix: invalid segment")
		}
		san := sanitize.Name(p, maxSegmentLength)
		if san == "" {
			return nil, errors.New("prefix: segment becomes empty after sanitisation")
		}
		cleaned = append(cleaned, san)
	}
	return &ParsedPrefix{Segments: cleaned, FullPath: strings.Join(cleaned, "/")}, nil
}
