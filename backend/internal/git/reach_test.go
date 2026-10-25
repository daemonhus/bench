package git

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// side adds a commit on a new branch off C1, so one commit is on no other branch.
func side(t *testing.T, f *fixture) string {
	t.Helper()
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = f.Dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("checkout", "-q", "-b", "side", f.C1)
	if err := os.WriteFile(filepath.Join(f.Dir, "side.txt"), []byte("side\n"), 0644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-q", "-m", "side")
	sha := run("rev-parse", "HEAD")
	run("checkout", "-q", "main")
	return sha
}

func TestContains(t *testing.T) {
	f := newFixture(t)
	s := side(t, f)

	cases := []struct {
		tip, commit string
		want        bool
	}{
		{"main", f.C3, true}, // the tip itself
		{"main", f.C1, true},
		{"main", f.C1[:8], true}, // abbreviated
		{f.FeatureBranch, f.C2, true},
		{f.FeatureBranch, f.C3, false}, // a later commit
		{"main", s, false},             // another branch's commit
		{"side", s, true},
		{"side", f.C1, true},
		{"side", f.C2, false},
	}
	// Twice: the second round answers from the remembered walks.
	for round := 0; round < 2; round++ {
		for _, c := range cases {
			got, err := f.Repo.Contains(c.tip, c.commit)
			if err != nil {
				t.Fatalf("Contains(%s, %s): %v", c.tip, c.commit, err)
			}
			if got != c.want {
				t.Errorf("round %d: Contains(%s, %.8s) = %v, want %v", round, c.tip, c.commit, got, c.want)
			}
		}
	}
}

func TestContains_UnknownCommit(t *testing.T) {
	f := newFixture(t)
	_, err := f.Repo.Contains("main", strings.Repeat("ab", 20))
	if !errors.Is(err, ErrUnknownRef) {
		t.Fatalf("err = %v, want ErrUnknownRef", err)
	}
}

// More tips than are remembered: the oldest walk is dropped and answers stay right.
func TestContains_ManyTips(t *testing.T) {
	f := newFixture(t)
	s := side(t, f)
	tips := []string{f.C1, f.C2, f.C3, s, "main", f.FeatureBranch, "side"}
	for round := 0; round < 2; round++ {
		for _, tip := range tips {
			got, err := f.Repo.Contains(tip, f.C1)
			if err != nil || !got {
				t.Fatalf("Contains(%.8s, C1) = %v, %v; want true", tip, got, err)
			}
		}
	}
	if n := len(f.Repo.backend.(*GoGitBackend).reach); n > reachTips {
		t.Errorf("%d tips remembered, want at most %d", n, reachTips)
	}
}
