package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// makeTestRepo creates a minimal git repo with one committed file for grep tests.
func makeTestRepo(t *testing.T) *Repo {
	t.Helper()
	dir := t.TempDir()

	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	run("init")
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "Test")

	content := `package main

func login(user, pass string) bool { return true }
func execQuery(sql string) {}
func handleAuth(token string) {}
`
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "init")

	return NewRepo(dir)
}

func TestGrep_PlainSubstring(t *testing.T) {
	repo := makeTestRepo(t)
	matches, err := repo.Grep("login", "HEAD", "", false, false, 100)
	if err != nil {
		t.Fatalf("Grep: %v", err)
	}
	if len(matches) == 0 {
		t.Fatal("expected matches for 'login', got none")
	}
}

func TestGrep_ExtendedRegex_Alternation(t *testing.T) {
	// | requires -E (ERE); without it, git grep -G would treat | literally.
	repo := makeTestRepo(t)
	matches, err := repo.Grep("login|execQuery", "HEAD", "", false, false, 100)
	if err != nil {
		t.Fatalf("Grep with alternation: %v", err)
	}
	if len(matches) < 2 {
		t.Fatalf("expected ≥2 matches for 'login|execQuery', got %d — regex alternation may not be using -E", len(matches))
	}
}

func TestGrep_ExtendedRegex_PlusQuantifier(t *testing.T) {
	// auth.+token requires -E; without -E, + is treated as a literal character.
	// Case-insensitive so "handleAuth(token" matches: Auth(.+)token.
	repo := makeTestRepo(t)
	matches, err := repo.Grep("auth.+token", "HEAD", "", true, false, 100)
	if err != nil {
		t.Fatalf("Grep with + quantifier: %v", err)
	}
	if len(matches) == 0 {
		t.Fatal("expected match for 'auth.+token' — + quantifier may not be using -E")
	}
}

func TestGrep_CaseInsensitive(t *testing.T) {
	repo := makeTestRepo(t)
	matches, err := repo.Grep("LOGIN", "HEAD", "", true, false, 100)
	if err != nil {
		t.Fatalf("Grep case-insensitive: %v", err)
	}
	if len(matches) == 0 {
		t.Fatal("expected case-insensitive match for 'LOGIN'")
	}
}

func TestGrep_NoMatches(t *testing.T) {
	repo := makeTestRepo(t)
	matches, err := repo.Grep("zzznomatch", "HEAD", "", false, false, 100)
	if err != nil {
		t.Fatalf("Grep no-match: %v", err)
	}
	if len(matches) != 0 {
		t.Fatalf("expected 0 matches, got %d", len(matches))
	}
}

func TestGrep_Fixed_DoesNotInterpretRegex(t *testing.T) {
	repo := makeTestRepo(t)
	// In fixed mode, "exec." is literal — no match because file has "execQuery" not "exec."
	matches, err := repo.Grep("exec.", "HEAD", "", false, true, 100)
	if err != nil {
		t.Fatalf("Grep fixed: %v", err)
	}
	// "exec." literal does not appear; "execQuery" does not contain a literal dot after exec
	if len(matches) != 0 {
		t.Fatalf("fixed mode should not match regex patterns: got %d match(es)", len(matches))
	}
}
