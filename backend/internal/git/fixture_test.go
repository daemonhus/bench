package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// fixture is a small, predictable git repo used by the characterization
// tests. It's intentionally tiny (three commits, one rename, one branch) so
// every exercised behavior is easy to reason about, and so the same fixture
// drives CLI and — eventually — go-git backends through the parity harness.
type fixture struct {
	Repo *Repo
	Dir  string

	// Commit hashes, in chronological order.
	C1 string // adds a.txt ("alpha\nbeta\n") and dir/b.txt ("bbb\n")
	C2 string // modifies a.txt to "alpha\nBETA\n", adds c.txt ("ccc\n")
	C3 string // renames a.txt -> renamed.txt (no content change)

	// Named refs.
	FeatureBranch string // "feature", points at C2
}

// newFixture builds the fixture in a t.TempDir() via the real git binary.
func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir := t.TempDir()

	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		// Keep authorship deterministic enough that tests don't care about times.
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.com",
			"GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.com",
			"GIT_AUTHOR_DATE=2025-01-01T00:00:00Z", "GIT_COMMITTER_DATE=2025-01-01T00:00:00Z",
		)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	write := func(rel, content string) {
		t.Helper()
		full := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}

	run("init", "-b", "main")
	run("config", "user.email", "fixture@example.com")
	run("config", "user.name", "Fixture")
	run("config", "commit.gpgsign", "false")

	write("a.txt", "alpha\nbeta\n")
	write("dir/b.txt", "bbb\n")
	run("add", ".")
	run("commit", "-m", "c1: seed")
	c1 := run("rev-parse", "HEAD")

	write("a.txt", "alpha\nBETA\n")
	write("c.txt", "ccc\n")
	run("add", ".")
	run("commit", "-m", "c2: tweak a, add c")
	c2 := run("rev-parse", "HEAD")

	run("branch", "feature", c2)

	run("mv", "a.txt", "renamed.txt")
	run("commit", "-m", "c3: rename a -> renamed")
	c3 := run("rev-parse", "HEAD")

	return &fixture{
		Repo:          NewRepo(dir),
		Dir:           dir,
		C1:            c1,
		C2:            c2,
		C3:            c3,
		FeatureBranch: "feature",
	}
}
