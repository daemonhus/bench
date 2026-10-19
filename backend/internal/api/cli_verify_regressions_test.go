package api

// Regressions found driving the bench CLI against a live multi-project server:
// each test pins a wrong status code or a wrong effect the CLI surfaced.

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"bench/internal/db"
	"bench/internal/git"
	"bench/internal/model"
)

// createTestFinding creates a finding on readme.txt at HEAD and returns its ID.
func createTestFinding(t *testing.T, router http.Handler) string {
	t.Helper()
	rec := doJSON(t, router, "GET", "/api/git/commits?limit=1", "")
	var commits []model.CommitInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &commits); err != nil || len(commits) == 0 {
		t.Fatalf("commits: %v %s", err, rec.Body.String())
	}
	body := `{"severity":"high","title":"t","anchor":{"fileId":"readme.txt","commitId":"` + commits[0].Hash + `"}}`
	rec = doJSON(t, router, "POST", "/api/findings", body)
	if rec.Code != 201 {
		t.Fatalf("create finding: %d %s", rec.Code, rec.Body.String())
	}
	var f model.Finding
	json.Unmarshal(rec.Body.Bytes(), &f)
	return f.ID
}

// PATCH/DELETE of an ID that doesn't exist (e.g. it lives in another project)
// was a 500 "internal error" for features and comments; findings already 404.
func TestUpdateMissingAnnotation_Returns404(t *testing.T) {
	router, _ := setupEnv(t)
	for _, c := range []struct{ method, path, body string }{
		{"PATCH", "/api/features/nope", `{"title":"x"}`},
		{"PATCH", "/api/comments/nope", `{"text":"x"}`},
		{"DELETE", "/api/comments/nope", ""},
		{"PATCH", "/api/findings/nope", `{"title":"x"}`},
	} {
		rec := doJSON(t, router, c.method, c.path, c.body)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s %s = %d, want 404 (body %s)", c.method, c.path, rec.Code, rec.Body.String())
		}
	}
}

// A ref could be created for an entity that doesn't exist in the project
// (a dangling link, or one pointing at another project's finding).
func TestRefCreate_RequiresExistingEntity(t *testing.T) {
	router, database := setupEnv(t)
	rec := doJSON(t, router, "POST", "/api/refs", `{"entityType":"finding","entityId":"nope","url":"https://x.example"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("ref to missing finding = %d, want 404 (body %s)", rec.Code, rec.Body.String())
	}
	rec = doJSON(t, router, "POST", "/api/refs", `[{"entityType":"finding","entityId":"nope","url":"https://x.example"}]`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("batch ref to missing finding = %d, want 404 (body %s)", rec.Code, rec.Body.String())
	}
	if refs, _ := database.ListRefs("", "", ""); len(refs) != 0 {
		t.Fatalf("refs written despite rejection: %+v", refs)
	}

	// A unique ID prefix resolves to the full ID.
	id := createTestFinding(t, router)
	rec = doJSON(t, router, "POST", "/api/refs", `{"entityType":"finding","entityId":"`+id[:8]+`","url":"https://x.example"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("ref by prefix = %d (body %s)", rec.Code, rec.Body.String())
	}
	var ref model.Ref
	json.Unmarshal(rec.Body.Bytes(), &ref)
	if ref.EntityID != id {
		t.Errorf("entityId = %q, want full id %q", ref.EntityID, id)
	}
}

// `bench baselines delete --id X` (no --confirm) previews via GET
// /api/baselines/{id}, which wasn't routed (405).
func TestGetBaselineByID(t *testing.T) {
	router, _ := setupEnv(t)
	rec := doJSON(t, router, "POST", "/api/baselines", `{"reviewer":"r"}`)
	if rec.Code != 201 {
		t.Fatalf("create baseline: %d %s", rec.Code, rec.Body.String())
	}
	var b model.Baseline
	json.Unmarshal(rec.Body.Bytes(), &b)

	rec = doJSON(t, router, "GET", "/api/baselines/"+b.ID, "")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), b.ID) {
		t.Fatalf("GET baseline = %d %s", rec.Code, rec.Body.String())
	}
	if rec = doJSON(t, router, "GET", "/api/baselines/nope", ""); rec.Code != 404 {
		t.Errorf("GET missing baseline = %d, want 404", rec.Code)
	}
	// The fixed sub-routes still win over {id}.
	if rec = doJSON(t, router, "GET", "/api/baselines/latest", ""); rec.Code != 200 || !strings.Contains(rec.Body.String(), b.ID) {
		t.Errorf("GET latest = %d %s", rec.Code, rec.Body.String())
	}
}

// A missing file at a valid commit was reported as "unknown git ref"; a path
// rejected by validation (leading "-") was a 500.
func TestGitShow_MissingFileAndInvalidPath(t *testing.T) {
	router, _ := setupEnv(t)
	rec := doJSON(t, router, "GET", "/api/git/show/HEAD/nope.txt", "")
	if rec.Code != 404 || !strings.Contains(rec.Body.String(), "file not found") || strings.Contains(rec.Body.String(), "unknown git ref") {
		t.Errorf("missing file = %d %s, want 404 file not found", rec.Code, rec.Body.String())
	}
	rec = doJSON(t, router, "GET", "/api/git/show/HEAD/-x", "")
	if rec.Code != 400 {
		t.Errorf("invalid path = %d %s, want 400", rec.Code, rec.Body.String())
	}
}

// mark-reviewed accepts a directory, but coverage only matched exact file
// paths, so files under a reviewed directory stayed "unreviewed".
func TestCoverage_DirectoryMarkCoversFiles(t *testing.T) {
	dir := t.TempDir()
	for _, args := range [][]string{
		{"git", "init", "-q", dir},
		{"bash", "-c", "mkdir -p " + filepath.Join(dir, "src/auth") + " && echo x > " + filepath.Join(dir, "src/auth/login.go") + " && echo y > " + filepath.Join(dir, "readme.txt")},
		{"git", "-C", dir, "add", "."},
		{"git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"},
	} {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
	}
	database, err := db.Open(filepath.Join(t.TempDir(), "t.db"), "test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	repo := git.NewRepo(dir)
	if err := database.PutServiceProfile(model.ServiceProfile{}); err != nil {
		t.Fatal(err)
	}
	router := NewRouter(repo, database, nil)
	rec := doJSON(t, router, "POST", "/api/coverage/mark", `{"path":"src/","commit":"HEAD","reviewer":"r"}`)
	if rec.Code != 204 {
		t.Fatalf("mark: %d %s", rec.Code, rec.Body.String())
	}
	for _, path := range []string{"", "src/auth"} {
		rec = doJSON(t, router, "GET", "/api/coverage?path="+path, "")
		var cov struct {
			Files []struct{ Path, Status string } `json:"files"`
		}
		json.Unmarshal(rec.Body.Bytes(), &cov)
		found := false
		for _, f := range cov.Files {
			switch f.Path {
			case "src/auth/login.go":
				found = true
				if f.Status != "reviewed" {
					t.Errorf("path=%q: %s status %q, want reviewed", path, f.Path, f.Status)
				}
			case "readme.txt":
				if f.Status != "unreviewed" {
					t.Errorf("readme.txt status %q, want unreviewed", f.Status)
				}
			}
		}
		if !found {
			t.Errorf("path=%q: login.go missing from coverage: %s", path, rec.Body.String())
		}
	}
}

func TestReviewLookup_MostRecentCoveringMarkWins(t *testing.T) {
	l := db.NewReviewLookup([]model.ReviewProgress{
		{FileID: "src", CommitID: "old", ReviewedAt: "2026-01-01 00:00:00"},
		{FileID: "src/a.go", CommitID: "file", ReviewedAt: "2026-01-02 00:00:00"},
		{FileID: "src/sub/", CommitID: "new", ReviewedAt: "2026-01-03 00:00:00"},
	})
	for path, want := range map[string]string{"src/a.go": "file", "src/b.go": "old", "src/sub/c.go": "new"} {
		if rp, ok := l.For(path); !ok || rp.CommitID != want {
			t.Errorf("For(%q) = %q,%v want %q", path, rp.CommitID, ok, want)
		}
	}
	if _, ok := l.For("srcx/a.go"); ok {
		t.Error("srcx/a.go must not match the src mark")
	}
}

// History of an annotation that doesn't exist was a 200 with no positions.
func TestAnnotationHistory_UnknownIs404(t *testing.T) {
	router, _ := setupEnv(t)
	if rec := doJSON(t, router, "GET", "/api/annotations/finding/nope/history", ""); rec.Code != 404 {
		t.Errorf("unknown finding history = %d %s, want 404", rec.Code, rec.Body.String())
	}
	id := createTestFinding(t, router)
	if rec := doJSON(t, router, "GET", "/api/annotations/finding/"+id+"/history", ""); rec.Code != 200 {
		t.Errorf("existing finding history = %d %s", rec.Code, rec.Body.String())
	}
}
