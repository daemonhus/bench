package reconcile

import (
	"crypto/sha256"
	"fmt"
	"regexp"
	"strings"
)

var collapseWS = regexp.MustCompile(`\s+`)

// NormalizeWhitespace trims leading/trailing whitespace and collapses
// all internal whitespace sequences to a single space.
func NormalizeWhitespace(line string) string {
	line = strings.TrimSpace(line)
	return collapseWS.ReplaceAllString(line, " ")
}

// LineHash computes a content fingerprint for a set of source lines.
// Each line is whitespace-normalized (trimmed + collapsed), then all
// lines are joined with newline and hashed with SHA-256.
// Returns the hex-encoded digest.
func LineHash(lines []string) string {
	normalized := make([]string, len(lines))
	for i, line := range lines {
		normalized[i] = NormalizeWhitespace(line)
	}
	joined := strings.Join(normalized, "\n")
	hash := sha256.Sum256([]byte(joined))
	return fmt.Sprintf("%x", hash)
}
