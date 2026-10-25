package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"bench/internal/db"
	"bench/internal/git"
	"bench/internal/model"
	"bench/internal/review"
)

// branchEnv is a repo with two branches off a shared first commit:
//
//	base ── mainTip   (main, checked out)
//	   └── featTip    (feature)
type branchEnv struct {
	router                 http.Handler
	db                     *db.DB
	dir, main              string
	base, mainTip, featTip string
}

func setupBranchEnv(t *testing.T) *branchEnv {
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
	commit := func(file, msg string) string {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, file), []byte(msg+"\n"), 0644); err != nil {
			t.Fatal(err)
		}
		run("add", ".")
		run("commit", "-q", "-m", msg)
		return run("rev-parse", "HEAD")
	}
	run("init", "-q", "-b", "main")
	run("config", "user.email", "test@test.com")
	run("config", "user.name", "Test")
	run("config", "commit.gpgsign", "false")
	e := &branchEnv{dir: dir, main: "main"}
	e.base = commit("a.txt", "base")
	e.mainTip = commit("a.txt", "main work")
	run("checkout", "-q", "-b", "feature", e.base)
	e.featTip = commit("b.txt", "feature work")
	run("checkout", "-q", "main")

	database, err := db.Open(filepath.Join(t.TempDir(), "test.db"), "test")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { database.Close() })
	if err := database.PutServiceProfile(model.ServiceProfile{}); err != nil {
		t.Fatal(err)
	}
	e.db = database
	e.router = NewRouter(git.NewRepo(dir), database, nil)
	return e
}

func (e *branchEnv) do(t *testing.T, method, path, body string, header ...string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	w := httptest.NewRecorder()
	e.router.ServeHTTP(w, req)
	return w
}

func (e *branchEnv) finding(t *testing.T, id, commit string) {
	t.Helper()
	body := `{"id":"` + id + `","title":"t","severity":"high","status":"open","source":"manual","anchor":{"fileId":"a.txt","commitId":"` + commit + `"}}`
	if w := e.do(t, "POST", "/api/findings", body); w.Code != 201 {
		t.Fatalf("create %s: %d %s", id, w.Code, w.Body.String())
	}
}

// findingIDs lists the findings a request sees, and how many it was told are elsewhere.
func (e *branchEnv) findingIDs(t *testing.T, path string, header ...string) ([]string, string) {
	t.Helper()
	w := e.do(t, "GET", path, "", header...)
	if w.Code != 200 {
		t.Fatalf("GET %s: %d %s", path, w.Code, w.Body.String())
	}
	var list []model.Finding
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, f := range list {
		ids = append(ids, f.ID)
	}
	return ids, w.Header().Get(offBranchHeader)
}

func (e *branchEnv) branch(t *testing.T, path string) review.Branch {
	t.Helper()
	w := e.do(t, "GET", path, "")
	if w.Code != 200 {
		t.Fatalf("GET %s: %d %s", path, w.Code, w.Body.String())
	}
	var b review.Branch
	if err := json.Unmarshal(w.Body.Bytes(), &b); err != nil {
		t.Fatal(err)
	}
	return b
}

func TestReviewBranch_DefaultsSavesAndOverrides(t *testing.T) {
	e := setupBranchEnv(t)

	b := e.branch(t, "/api/review-branch")
	if b.Name != "main" || b.Tip != e.mainTip || b.Saved != "" || b.Override {
		t.Fatalf("default = %+v, want main at its tip", b)
	}

	if w := e.do(t, "PUT", "/api/review-branch", `{"branch":"nope"}`); w.Code != 400 {
		t.Fatalf("unknown branch: %d, want 400", w.Code)
	}
	if w := e.do(t, "PUT", "/api/review-branch", `{"branch":"feature"}`); w.Code != 200 {
		t.Fatalf("save: %d %s", w.Code, w.Body.String())
	}
	b = e.branch(t, "/api/review-branch")
	if b.Name != "feature" || b.Tip != e.featTip || b.Saved != "feature" {
		t.Fatalf("saved = %+v, want feature", b)
	}

	// The address override wins for that request, as a query or a header.
	if b = e.branch(t, "/api/review-branch?branch=main"); b.Name != "main" || !b.Override {
		t.Fatalf("override = %+v, want main", b)
	}

	// A saved branch that's gone falls back to the default, and says so.
	cmd := exec.Command("git", "branch", "-D", "feature")
	cmd.Dir = e.dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	b = e.branch(t, "/api/review-branch")
	if b.Name != "main" || b.Missing != "feature" {
		t.Fatalf("after delete = %+v, want main standing in for feature", b)
	}

	if w := e.do(t, "PUT", "/api/review-branch", `{"branch":""}`); w.Code != 200 {
		t.Fatalf("reset: %d", w.Code)
	}
	if b = e.branch(t, "/api/review-branch"); b.Saved != "" || b.Missing != "" {
		t.Fatalf("after reset = %+v", b)
	}
}

func TestReviewBranch_ScopesFindings(t *testing.T) {
	e := setupBranchEnv(t)
	e.finding(t, "shared", e.base)
	e.finding(t, "on-main", e.mainTip)
	e.finding(t, "on-feature", e.featTip)
	e.finding(t, "unplaced", "0123456789abcdef0123456789abcdef01234567")

	check := func(name string, got []string, off string, want []string, wantOff string) {
		t.Helper()
		if strings.Join(got, ",") != strings.Join(want, ",") || off != wantOff {
			t.Errorf("%s: %v (off %q), want %v (off %q)", name, got, off, want, wantOff)
		}
	}
	ids, off := e.findingIDs(t, "/api/findings")
	check("main", ids, off, []string{"shared", "on-main", "unplaced"}, "1")
	ids, off = e.findingIDs(t, "/api/findings?branch=feature")
	check("?branch=feature", ids, off, []string{"shared", "on-feature", "unplaced"}, "1")
	ids, off = e.findingIDs(t, "/api/findings", branchHeader, "feature")
	check("header feature", ids, off, []string{"shared", "on-feature", "unplaced"}, "1")
	ids, off = e.findingIDs(t, "/api/findings?all_branches=true")
	check("all branches", ids, off, []string{"shared", "on-main", "on-feature", "unplaced"}, "")

	if w := e.do(t, "PUT", "/api/review-branch", `{"branch":"feature"}`); w.Code != 200 {
		t.Fatal(w.Code)
	}
	ids, off = e.findingIDs(t, "/api/findings")
	check("saved feature", ids, off, []string{"shared", "on-feature", "unplaced"}, "1")

	// A finding's own page and thread don't depend on the branch.
	if w := e.do(t, "GET", "/api/findings/on-main", ""); w.Code != 200 {
		t.Errorf("get off-branch finding: %d", w.Code)
	}
}

func TestReviewBranch_HistoryAndChanges(t *testing.T) {
	e := setupBranchEnv(t)

	commits := func(path string) []string {
		t.Helper()
		w := e.do(t, "GET", path, "")
		var list []model.CommitInfo
		if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
			t.Fatalf("%s: %s", path, w.Body.String())
		}
		var hashes []string
		for _, c := range list {
			hashes = append(hashes, c.Hash)
		}
		return hashes
	}
	if got := commits("/api/git/commits"); strings.Join(got, ",") != e.mainTip+","+e.base {
		t.Errorf("main history = %v", got)
	}
	if got := commits("/api/git/commits?branch=feature"); strings.Join(got, ",") != e.featTip+","+e.base {
		t.Errorf("feature history = %v", got)
	}

	// A baseline at the shared commit, then one on main.
	for _, c := range []string{e.base, e.mainTip} {
		if w := e.do(t, "POST", "/api/baselines", `{"commitId":"`+c+`"}`); w.Code != 201 {
			t.Fatalf("baseline: %d %s", w.Code, w.Body.String())
		}
	}
	e.finding(t, "on-feature", e.featTip)
	e.finding(t, "on-main", e.mainTip)

	delta := func(path string) model.BaselineDelta {
		t.Helper()
		w := e.do(t, "GET", path, "")
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
		var d model.BaselineDelta
		if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil {
			t.Fatal(err)
		}
		return d
	}
	// On main: since main's own baseline, up to main's tip.
	d := delta("/api/baselines/delta")
	if d.SinceBaseline.CommitID != e.mainTip || d.HeadCommit != e.mainTip {
		t.Errorf("main delta since %.7s to %.7s", d.SinceBaseline.CommitID, d.HeadCommit)
	}
	if len(d.NewFindings) != 1 || d.NewFindings[0].ID != "on-main" {
		t.Errorf("main new findings = %v", d.NewFindings)
	}
	// On feature: main's baseline isn't in its history; the shared one is.
	d = delta("/api/baselines/delta?branch=feature")
	if d.SinceBaseline.CommitID != e.base || d.HeadCommit != e.featTip {
		t.Errorf("feature delta since %.7s to %.7s", d.SinceBaseline.CommitID, d.HeadCommit)
	}
	if len(d.NewFindings) != 1 || d.NewFindings[0].ID != "on-feature" {
		t.Errorf("feature new findings = %v", d.NewFindings)
	}
	if len(d.ChangedFiles) != 1 || d.ChangedFiles[0].Path != "b.txt" {
		t.Errorf("feature changed files = %v", d.ChangedFiles)
	}
	if d.CurrentStats.FindingsTotal != 1 {
		t.Errorf("feature stats count %d findings, want 1", d.CurrentStats.FindingsTotal)
	}

	// The baselines list is the branch's too.
	w := e.do(t, "GET", "/api/baselines?branch=feature", "")
	var list []model.Baseline
	json.Unmarshal(w.Body.Bytes(), &list) //nolint:errcheck
	if len(list) != 1 || list[0].CommitID != e.base {
		t.Errorf("feature baselines = %v", list)
	}

	// A new baseline defaults to the review branch's tip.
	w = e.do(t, "POST", "/api/baselines?branch=feature", `{}`)
	var created model.Baseline
	json.Unmarshal(w.Body.Bytes(), &created) //nolint:errcheck
	if created.CommitID != e.featTip {
		t.Errorf("new baseline at %.7s, want feature's tip", created.CommitID)
	}
}
