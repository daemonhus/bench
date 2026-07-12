package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// buildOriginRepo: main gets a base commit, feature/api adds routes.go, and
// a no-ff merge with a conventional subject brings it back to main.
func buildOriginRepo(t *testing.T) *Repo {
	t.Helper()
	dir := t.TempDir()

	run := func(author, date string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME="+author, "GIT_AUTHOR_EMAIL="+author+"@example.com",
			"GIT_COMMITTER_NAME="+author, "GIT_COMMITTER_EMAIL="+author+"@example.com",
			"GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date,
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(rel, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, rel), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}

	run("alice", "2025-02-03T10:00:00Z", "init", "-b", "main")
	write("main.go", "package main\n")
	run("alice", "2025-02-03T10:00:00Z", "add", ".")
	run("alice", "2025-02-03T10:00:00Z", "commit", "-m", "chore: scaffold")

	run("bob", "2025-02-10T10:00:00Z", "checkout", "-b", "feature/api")
	write("routes.go", "package main\n// POST /webhook\n")
	run("bob", "2025-02-10T10:00:00Z", "add", ".")
	run("bob", "2025-02-10T10:00:00Z", "commit", "-m", "feat: add webhook route")
	run("alice", "2025-02-12T10:00:00Z", "checkout", "main")
	run("alice", "2025-02-12T10:00:00Z", "merge", "--no-ff", "-m", "Merge branch 'feature/api'", "feature/api")

	return NewRepo(dir)
}

func TestOriginSuggestion_FindsMergeAndBranch(t *testing.T) {
	repo := buildOriginRepo(t)

	s, err := repo.OriginSuggestion("routes.go", "HEAD", 2, 2)
	if err != nil {
		t.Fatalf("OriginSuggestion: %v", err)
	}

	if s.Actor != "bob" {
		t.Errorf("actor = %q, want bob (blame of the route line)", s.Actor)
	}
	if s.CommitSubject != "feat: add webhook route" {
		t.Errorf("commitSubject = %q", s.CommitSubject)
	}
	if len(s.IntroducedCommit) != 40 {
		t.Errorf("introducedCommit = %q, want full sha", s.IntroducedCommit)
	}
	if s.MergeSubject != "Merge branch 'feature/api'" {
		t.Errorf("mergeSubject = %q", s.MergeSubject)
	}
	if len(s.MergeCommit) != 40 {
		t.Errorf("mergeCommit = %q, want full sha", s.MergeCommit)
	}
	if s.Branch != "feature/api -> main" {
		t.Errorf("branch = %q, want the source -> target flow", s.Branch)
	}
	if !strings.HasPrefix(s.IntroducedDate, "2025-02-10") {
		t.Errorf("introducedDate = %q, want the feature commit's date", s.IntroducedDate)
	}
	// Context lists recent commits around the file (go-git's path filter is
	// permissive about merges); the introducing commit must be among them.
	found := false
	for _, c := range s.Context {
		if c.Subject == "feat: add webhook route" {
			found = true
		}
	}
	if !found {
		t.Errorf("context = %+v, want it to include the introducing commit", s.Context)
	}
}

func TestOriginSuggestion_MainlineCommitHasNoMerge(t *testing.T) {
	repo := buildOriginRepo(t)

	// main.go line 1 was committed directly on main: no merge to report.
	s, err := repo.OriginSuggestion("main.go", "HEAD", 1, 1)
	if err != nil {
		t.Fatalf("OriginSuggestion: %v", err)
	}
	if s.Actor != "alice" {
		t.Errorf("actor = %q, want alice", s.Actor)
	}
	if s.MergeCommit != "" || s.MergeSubject != "" || s.Branch != "" {
		t.Errorf("mainline commit got merge context: %+v", s)
	}
}

func TestRangeStats(t *testing.T) {
	repo := buildOriginRepo(t)

	// Full history from the root: scaffold + feature commit + merge.
	all, err := repo.RangeStats("", "HEAD")
	if err != nil {
		t.Fatalf("RangeStats: %v", err)
	}
	if all.Commits != 3 || all.Merges != 1 {
		t.Errorf("full range = %+v, want 3 commits 1 merge", all)
	}

	// From the root commit (exclusive): feature commit + merge.
	head, _ := repo.Head()
	log, err := repo.Log(10)
	if err != nil {
		t.Fatal(err)
	}
	root := log[len(log)-1].Hash
	since, err := repo.RangeStats(root, head)
	if err != nil {
		t.Fatalf("RangeStats since root: %v", err)
	}
	if since.Commits != 2 || since.Merges != 1 {
		t.Errorf("since root = %+v, want 2 commits 1 merge", since)
	}

	// Same ref both ends: nothing since.
	none, err := repo.RangeStats(head, head)
	if err != nil {
		t.Fatal(err)
	}
	if none.Commits != 0 || none.Merges != 0 {
		t.Errorf("empty range = %+v", none)
	}
}
