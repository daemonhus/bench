package git

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// makeTwoCommitRepo returns a repo with two commits on main, so tests can
// verify pinning survives a destructive history rewrite.
func makeTwoCommitRepo(t *testing.T) (*Repo, string, string) {
	t.Helper()
	dir := t.TempDir()

	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}

	run("init")
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "Test")
	run("config", "commit.gpgsign", "false")

	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "first")
	first := run("rev-parse", "HEAD")

	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("two\n"), 0644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "second")
	second := run("rev-parse", "HEAD")

	return NewRepo(dir), first, second
}

func TestPinCommit_CreatesKeepRef(t *testing.T) {
	repo, first, _ := makeTwoCommitRepo(t)

	if err := repo.PinCommit(first); err != nil {
		t.Fatalf("PinCommit: %v", err)
	}

	resolved, err := repo.ResolveRef(KeepRefPrefix + first)
	if err != nil {
		t.Fatalf("ResolveRef(keep ref): %v", err)
	}
	if resolved != first {
		t.Fatalf("keep ref points to %s, want %s", resolved, first)
	}
}

func TestPinCommit_Idempotent(t *testing.T) {
	repo, first, _ := makeTwoCommitRepo(t)

	if err := repo.PinCommit(first); err != nil {
		t.Fatalf("first PinCommit: %v", err)
	}
	if err := repo.PinCommit(first); err != nil {
		t.Fatalf("second PinCommit: %v", err)
	}
}

func TestPinCommit_RejectsNonSha(t *testing.T) {
	repo, _, _ := makeTwoCommitRepo(t)
	cases := []string{"", "HEAD", "main", "deadbeef", "zzzz5678901234567890123456789012345678ab"}
	for _, c := range cases {
		if err := repo.PinCommit(c); err == nil {
			t.Errorf("PinCommit(%q) expected error, got nil", c)
		}
	}
}

func TestPinCommit_UnknownRefIsClassified(t *testing.T) {
	repo, _, _ := makeTwoCommitRepo(t)
	// Valid 40-hex sha, but not an object in this repo.
	dead := "9c1acab62ae8f102e65900294a923c8baf214815"
	err := repo.PinCommit(dead)
	if err == nil {
		t.Fatal("expected error for unknown sha, got nil")
	}
	if !errors.Is(err, ErrUnknownRef) {
		t.Fatalf("expected ErrUnknownRef, got %v", err)
	}
}

func TestPinCommit_SurvivesHistoryReset(t *testing.T) {
	// This is the core guarantee: once pinned, a commit stays resolvable even
	// after main moves off it and a GC-equivalent prune happens.
	repo, first, second := makeTwoCommitRepo(t)

	if err := repo.PinCommit(first); err != nil {
		t.Fatalf("PinCommit: %v", err)
	}

	// Reset main to the second commit so `first` is no longer reachable from
	// any normal ref.
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = repo.path
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("checkout", "-q", second)
	run("branch", "-f", "main", second)
	run("update-ref", "-d", "refs/heads/master")

	// Blow away reflogs (they'd otherwise keep `first` alive).
	run("reflog", "expire", "--expire=now", "--all")
	run("gc", "--prune=now")

	// Despite all that, the keep ref still resolves.
	resolved, err := repo.ResolveRef(KeepRefPrefix + first)
	if err != nil {
		t.Fatalf("keep ref lost after history rewrite: %v", err)
	}
	if resolved != first {
		t.Fatalf("keep ref points to %s, want %s", resolved, first)
	}

	// And the tree at that commit is still fully readable.
	entries, err := repo.Tree(first)
	if err != nil {
		t.Fatalf("Tree(%s) after rewrite: %v", first, err)
	}
	if len(entries) == 0 {
		t.Fatal("expected at least one tree entry")
	}
}

func TestUnpinCommit_RemovesRef(t *testing.T) {
	repo, first, _ := makeTwoCommitRepo(t)
	if err := repo.PinCommit(first); err != nil {
		t.Fatalf("PinCommit: %v", err)
	}
	if err := repo.UnpinCommit(first); err != nil {
		t.Fatalf("UnpinCommit: %v", err)
	}
	if _, err := repo.ResolveRef(KeepRefPrefix + first); err == nil {
		t.Fatal("expected keep ref to be gone after Unpin")
	}
}

func TestUnpinCommit_MissingIsNoop(t *testing.T) {
	repo, first, _ := makeTwoCommitRepo(t)
	// Never pinned - unpin should not error.
	if err := repo.UnpinCommit(first); err != nil {
		t.Fatalf("UnpinCommit on missing ref: %v", err)
	}
}

func TestListPinnedCommits(t *testing.T) {
	repo, first, second := makeTwoCommitRepo(t)

	got, err := repo.ListPinnedCommits()
	if err != nil {
		t.Fatalf("ListPinnedCommits on empty: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected 0 pinned, got %v", got)
	}

	if err := repo.PinCommit(first); err != nil {
		t.Fatal(err)
	}
	if err := repo.PinCommit(second); err != nil {
		t.Fatal(err)
	}

	got, err = repo.ListPinnedCommits()
	if err != nil {
		t.Fatalf("ListPinnedCommits: %v", err)
	}
	sort.Strings(got)
	want := []string{first, second}
	sort.Strings(want)
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("ListPinnedCommits = %v, want %v", got, want)
	}
}
