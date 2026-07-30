package db

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Column lists are shared through constants and pasted into query strings with
// plain concatenation, e.g.
//
//	`SELECT` + fileColumns + `
//	FROM files WHERE …`
//
// If the constant has no trailing newline and the next literal starts straight
// at FROM, the two identifiers fuse ("… source" + "FROM files" = "sourceFROM
// files") and every call of that query fails at the database with a column that
// doesn't exist. That shipped twice — FindFileByHash (which made
// /sync/check-hash a guaranteed 500) and GetInvitationByID — because the broken
// query looks completely ordinary in review.
//
// This walks the package's own source and fails on any concatenation whose
// seam has no whitespace on either side.
func TestColumnConstantsAreNotGluedToNeighbouringSQL(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("glob: %v", err)
	}

	constDecl := regexp.MustCompile("(?s)(\\w+) = `(.*?)`")
	// name + `X  — the character a constant is pasted in front of.
	afterUse := regexp.MustCompile("(\\w+)\\s*\\+\\s*`(.)")
	// X` + name — the character a constant is pasted behind.
	beforeUse := regexp.MustCompile("(?s)(.)`\\s*\\+\\s*(\\w+)")

	sources := map[string]string{}
	columns := map[string]string{}
	for _, name := range files {
		body, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		src := string(body)
		sources[name] = src
		for _, m := range constDecl.FindAllStringSubmatch(src, -1) {
			if strings.HasSuffix(m[1], "Columns") {
				columns[m[1]] = m[2]
			}
		}
	}
	if len(columns) == 0 {
		t.Fatal("found no column-list constants — has the naming convention changed?")
	}

	isSpace := func(s string) bool { return strings.TrimSpace(s) == "" }
	isWord := func(r byte) bool {
		return r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
	}

	for name, src := range sources {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		for _, m := range afterUse.FindAllStringSubmatch(src, -1) {
			value, ok := columns[m[1]]
			if !ok || len(value) == 0 {
				continue
			}
			if !isSpace(value[len(value)-1:]) && isWord(m[2][0]) {
				t.Errorf("%s: %s ends with %q and is concatenated directly onto %q — "+
					"the two fuse into one identifier; add a newline after the backtick",
					name, m[1], value[len(value)-1:], m[2])
			}
		}
		for _, m := range beforeUse.FindAllStringSubmatch(src, -1) {
			value, ok := columns[m[2]]
			if !ok || len(value) == 0 {
				continue
			}
			if !isSpace(value[:1]) && isWord(m[1][0]) {
				t.Errorf("%s: %s starts with %q and is concatenated directly after %q — "+
					"the two fuse into one identifier; add a space before the backtick",
					name, m[2], value[:1], m[1])
			}
		}
	}
}
