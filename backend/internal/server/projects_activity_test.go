package server

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// The projects list carries each project's default-branch activity: its last push (newest
// commit) and commits over the last year, for the Activity tile on the project cards.
func TestListProjects_Activity(t *testing.T) {
	p, _ := newTestPlatform(t)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/platform/projects", p.listProjects)
	mux.HandleFunc("POST /api/platform/projects", p.createProject)

	repo := t.TempDir()
	for _, args := range [][]string{
		{"git", "init", "-b", "main", repo},
		{"git", "-C", repo, "config", "user.email", "t@example.com"},
		{"git", "-C", repo, "config", "user.name", "T"},
	} {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
	}
	for i, name := range []string{"a.go", "b.go"} {
		if err := os.WriteFile(filepath.Join(repo, name), []byte("package a\n"), 0644); err != nil {
			t.Fatal(err)
		}
		for _, args := range [][]string{{"git", "-C", repo, "add", "."}, {"git", "-C", repo, "commit", "-qm", name}} {
			if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
				t.Fatalf("commit %d: %v: %s", i, err, out)
			}
		}
	}
	if w := do(t, mux, "POST", "/api/platform/projects", `{"name":"svc","repoPath":"`+repo+`"}`); w.Code >= 300 {
		t.Fatalf("create project: %d %s", w.Code, w.Body.String())
	}

	projects := mustDecode[[]Project](t, do(t, mux, "GET", "/api/platform/projects", ""))
	if len(projects) != 1 || projects[0].Activity == nil {
		t.Fatalf("want one project with activity, got %+v", projects)
	}
	a := projects[0].Activity
	if a.Branch != "main" || a.Commits != 2 || a.Months != 1 {
		t.Errorf("activity = %+v, want branch main, 2 commits over 1 month", *a)
	}
	if last, err := time.Parse(time.RFC3339, a.LastCommitAt); err != nil || time.Since(last) > time.Hour {
		t.Errorf("lastCommitAt = %q, want the commit just made", a.LastCommitAt)
	}
}
