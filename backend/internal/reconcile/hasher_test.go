package reconcile

import (
	"testing"
)

// ---------------------------------------------------------------------------
// NormalizeWhitespace tests
// ---------------------------------------------------------------------------

func TestNormalizeWhitespace(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"empty", "", ""},
		{"no whitespace", "hello", "hello"},
		{"leading spaces", "   hello", "hello"},
		{"trailing spaces", "hello   ", "hello"},
		{"leading and trailing", "  hello  ", "hello"},
		{"tabs", "\thello\t", "hello"},
		{"internal spaces", "hello  world", "hello world"},
		{"internal tabs", "hello\t\tworld", "hello world"},
		{"mixed internal", "hello \t world", "hello world"},
		{"complex", "  if (x  ==   y)\t{  ", "if (x == y) {"},
		{"newlines internal", "hello\nworld", "hello world"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := NormalizeWhitespace(tt.input)
			if got != tt.want {
				t.Errorf("NormalizeWhitespace(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// LineHash tests
// ---------------------------------------------------------------------------

func TestLineHash_Deterministic(t *testing.T) {
	lines := []string{"func main() {", "    fmt.Println(\"hello\")", "}"}
	h1 := LineHash(lines)
	h2 := LineHash(lines)
	if h1 != h2 {
		t.Fatalf("LineHash not deterministic: %s != %s", h1, h2)
	}
	// SHA-256 produces 64 hex chars
	if len(h1) != 64 {
		t.Fatalf("expected 64 hex chars, got %d", len(h1))
	}
}

func TestLineHash_WhitespaceInsensitive(t *testing.T) {
	lines1 := []string{"  if (x == y) {", "    return true;", "  }"}
	lines2 := []string{"if (x == y) {", "\treturn true;", "}"}
	lines3 := []string{"if   (x  ==  y)   {", "   return   true;", "   }  "}

	h1 := LineHash(lines1)
	h2 := LineHash(lines2)
	h3 := LineHash(lines3)

	if h1 != h2 {
		t.Fatalf("different indentation should produce same hash: %s != %s", h1, h2)
	}
	if h1 != h3 {
		t.Fatalf("different internal whitespace should produce same hash: %s != %s", h1, h3)
	}
}

func TestLineHash_ContentSensitive(t *testing.T) {
	h1 := LineHash([]string{"return true;"})
	h2 := LineHash([]string{"return false;"})
	if h1 == h2 {
		t.Fatal("different content should produce different hashes")
	}
}

func TestLineHash_OrderSensitive(t *testing.T) {
	h1 := LineHash([]string{"line A", "line B"})
	h2 := LineHash([]string{"line B", "line A"})
	if h1 == h2 {
		t.Fatal("different line order should produce different hashes")
	}
}

func TestLineHash_SingleLine(t *testing.T) {
	h := LineHash([]string{"SELECT * FROM users WHERE id = ?"})
	if len(h) != 64 {
		t.Fatalf("expected 64 hex chars, got %d", len(h))
	}
}

func TestLineHash_EmptyLines(t *testing.T) {
	// Empty lines normalize to empty strings
	h1 := LineHash([]string{""})
	h2 := LineHash([]string{"   "})
	if h1 != h2 {
		t.Fatalf("blank and whitespace-only lines should hash the same: %s != %s", h1, h2)
	}
}

func TestLineHash_EmptySlice(t *testing.T) {
	// Edge case: no lines at all
	h := LineHash([]string{})
	if len(h) != 64 {
		t.Fatalf("expected 64 hex chars for empty input, got %d", len(h))
	}
}
