package sanitize

import (
	"strings"
	"unicode/utf8"
)

// String trims leading/trailing whitespace and strips null bytes from s.
func String(s string) string {
	s = strings.TrimSpace(s)
	s = strings.ReplaceAll(s, "\x00", "")
	return s
}

// Name sanitizes a user-provided file or folder display name: trims whitespace,
// strips null bytes, CRLF, and path-separator characters, then truncates to
// maxLen Unicode code points. Returns an empty string for degenerate inputs.
func Name(s string, maxLen int) string {
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '\x00', '\r', '\n', '/', '\\':
			// strip characters that are unsafe in filenames or HTTP headers
		default:
			b.WriteRune(r)
		}
	}
	s = strings.TrimSpace(b.String())
	if utf8.RuneCountInString(s) > maxLen {
		runes := []rune(s)
		s = string(runes[:maxLen])
	}
	return s
}

// ContentDispositionFilename escapes a filename for use inside a quoted-string
// in a Content-Disposition header value, preventing quote injection and header
// injection via CRLF.
func ContentDispositionFilename(s string) string {
	s = strings.ReplaceAll(s, "\r", "")
	s = strings.ReplaceAll(s, "\n", "")
	s = strings.ReplaceAll(s, "\x00", "")
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `'`)
	return s
}
