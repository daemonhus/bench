package server

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// commitFile adds a file to repo in a commit of its own.
func commitFile(t *testing.T, repo, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(repo, name), []byte(name+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", name}, {"commit", "-q", "-m", "add " + name}} {
		if out, err := exec.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
}

func listedChanges(t *testing.T, h http.Handler) map[string][2]int {
	t.Helper()
	w := do(t, h, "GET", "/api/projects", "")
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/projects: %d %s", w.Code, w.Body.String())
	}
	out := map[string][2]int{}
	for _, p := range mustDecode[[]Project](t, w) {
		if p.RiskData == nil {
			t.Fatalf("%s: no risk data", p.Slug)
		}
		out[p.Slug] = [2]int{p.RiskData.CommitsSince, p.RiskData.FilesChangedSince}
	}
	return out
}

// Projects are enriched side by side; each keeps its own counts since its baseline, and the
// counts follow HEAD when it moves.
func TestListProjects_ChangesSinceBaselinePerProject(t *testing.T) {
	_, h := newTestPlatform(t)
	repos := map[string]string{}
	for i := 0; i < 5; i++ {
		repo, _ := newGitRepo(t)
		name := fmt.Sprintf("svc-%d", i)
		if w := do(t, h, "POST", "/api/projects", fmt.Sprintf(`{"name":%q,"repoPath":%q}`, name, repo)); w.Code != http.StatusCreated && w.Code != http.StatusOK {
			t.Fatalf("create %s: %d %s", name, w.Code, w.Body.String())
		}
		// The project's first baseline is at its HEAD: i commits come after it.
		for j := 0; j < i; j++ {
			commitFile(t, repo, fmt.Sprintf("f%d.txt", j))
		}
		repos[name] = repo
	}

	got := listedChanges(t, h)
	for i := 0; i < 5; i++ {
		name := fmt.Sprintf("svc-%d", i)
		if got[name] != [2]int{i, i} {
			t.Errorf("%s: commits, files since baseline = %v, want [%d %d]", name, got[name], i, i)
		}
	}

	commitFile(t, repos["svc-2"], "late.txt")
	if got := listedChanges(t, h); got["svc-2"] != [2]int{3, 3} || got["svc-3"] != [2]int{3, 3} {
		t.Errorf("after a commit to svc-2: svc-2 = %v, svc-3 = %v, want [3 3] for both", got["svc-2"], got["svc-3"])
	}
}
