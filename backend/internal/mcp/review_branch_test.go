package mcp

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"bench/internal/db"
	"bench/internal/git"
	"bench/internal/model"
	"bench/internal/reconcile"
)

// branchDeps is a repo with two branches off a shared first commit, with
// feature checked out so that HEAD is not the review branch's head:
//
//	base ── mainTip   (main, the review branch)
//	   └── featTip    (feature, checked out)
type branchDeps struct {
	*toolDeps
	base, mainTip, featTip string
}

func setupBranchDeps(t *testing.T) *branchDeps {
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
	b := &branchDeps{}
	b.base = commit("a.txt", "base")
	b.mainTip = commit("a.txt", "main work")
	run("checkout", "-q", "-b", "feature", b.base)
	b.featTip = commit("b.txt", "feature work")

	database, err := db.Open(filepath.Join(t.TempDir(), "test.db"), "test")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { database.Close() })
	if err := database.PutServiceProfile(model.ServiceProfile{}); err != nil {
		t.Fatal(err)
	}
	repo := git.NewRepo(dir)
	rec := reconcile.NewReconciler(repo, database, database, database, reconcile.WithResolver(database))
	b.toolDeps = &toolDeps{db: database, repo: repo, reconciler: rec}
	return b
}

func (b *branchDeps) finding(t *testing.T, id, commit string) {
	t.Helper()
	f := model.Finding{ID: id, Title: "t", Severity: "high", Status: "open", Source: "manual",
		Anchor: model.Anchor{FileID: "a.txt", CommitID: commit}}
	if err := b.db.CreateFinding(&f); err != nil {
		t.Fatalf("create %s: %v", id, err)
	}
}

func (b *branchDeps) call(t *testing.T, name string, args map[string]any) string {
	t.Helper()
	out, err := callTool(t, b.toolDeps, name, args)
	if err != nil {
		t.Fatalf("%s %v: %v", name, args, err)
	}
	return out
}

// listedFindings is the ids a list_findings call returned, and its closing note.
func (b *branchDeps) listedFindings(t *testing.T, args map[string]any) ([]string, string) {
	t.Helper()
	out := b.call(t, "list_findings", args)
	note := ""
	if i := strings.LastIndex(out, "\n("); i >= 0 {
		note = out[i+1:]
		out = out[:i]
	}
	i := strings.Index(out, "[")
	if i < 0 {
		return nil, note
	}
	var rows []struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(out[i:]), &rows); err != nil {
		t.Fatalf("list_findings: %v\n%s", err, out)
	}
	var ids []string
	for _, r := range rows {
		ids = append(ids, r.ID)
	}
	return ids, note
}

func TestMCPReviewBranch_ScopesFindings(t *testing.T) {
	b := setupBranchDeps(t)
	b.finding(t, "shared", b.base)
	b.finding(t, "on-main", b.mainTip)
	b.finding(t, "on-feature", b.featTip)
	b.finding(t, "unplaced", "0123456789abcdef0123456789abcdef01234567")

	check := func(name string, args map[string]any, want string, wantOff string) {
		t.Helper()
		ids, note := b.listedFindings(t, args)
		if strings.Join(ids, ",") != want || !strings.Contains(note, wantOff) {
			t.Errorf("%s: %v (%q), want %v (%q)", name, ids, note, want, wantOff)
		}
	}
	// The review branch is main although feature is checked out.
	check("review branch", map[string]any{}, "shared,on-main,unplaced", "1 on other branches")
	check("branch=feature", map[string]any{"branch": "feature"}, "shared,on-feature,unplaced", "1 on other branches")
	check("all branches", map[string]any{"all_branches": true}, "shared,on-main,on-feature,unplaced", "")

	if _, err := callTool(t, b.toolDeps, "set_review_branch", map[string]any{"branch": "feature"}); err != nil {
		t.Fatal(err)
	}
	check("saved feature", map[string]any{}, "shared,on-feature,unplaced", "1 on other branches")

	// A finding's own page doesn't depend on the branch.
	if _, err := callTool(t, b.toolDeps, "get_finding", map[string]any{"id": "on-main"}); err != nil {
		t.Errorf("get off-branch finding: %v", err)
	}
}

func TestMCPReviewBranch_ScopesFeaturesAndComments(t *testing.T) {
	b := setupBranchDeps(t)
	for id, commit := range map[string]string{"f-main": b.mainTip, "f-feat": b.featTip} {
		f := model.Feature{ID: id, Kind: "interface", Title: "/" + id, Status: "active",
			Anchor: model.Anchor{FileID: "a.txt", CommitID: commit}}
		if err := b.db.CreateFeature(&f); err != nil {
			t.Fatal(err)
		}
		c := model.Comment{ID: "c-" + id, Author: "a", Text: "t", ThreadID: "c-" + id,
			Anchor: model.Anchor{FileID: "a.txt", CommitID: commit}}
		if err := b.db.CreateComment(&c); err != nil {
			t.Fatal(err)
		}
	}
	out := b.call(t, "list_features", map[string]any{})
	if !strings.Contains(out, "f-main") || strings.Contains(out, "f-feat") || !strings.Contains(out, "1 on other branches") {
		t.Errorf("features on main:\n%s", out)
	}
	out = b.call(t, "list_features", map[string]any{"branch": "feature"})
	if strings.Contains(out, "f-main") || !strings.Contains(out, "f-feat") {
		t.Errorf("features on feature:\n%s", out)
	}
	out = b.call(t, "list_comments", map[string]any{})
	if !strings.Contains(out, "c-f-main") || strings.Contains(out, "c-f-feat") || !strings.Contains(out, "1 on other branches") {
		t.Errorf("comments on main:\n%s", out)
	}
	out = b.call(t, "list_comments", map[string]any{"all_branches": true})
	if !strings.Contains(out, "c-f-main") || !strings.Contains(out, "c-f-feat") {
		t.Errorf("comments on all branches:\n%s", out)
	}
}

func TestMCPReviewBranch_DefaultsCommitToBranchHead(t *testing.T) {
	b := setupBranchDeps(t)

	// Files exist only on feature (the checked-out HEAD), so reads that
	// default to the review branch's head must not see them.
	if out := b.call(t, "list_files", map[string]any{}); strings.Contains(out, "b.txt") {
		t.Errorf("list_files followed HEAD:\n%s", out)
	}
	if out := b.call(t, "list_files", map[string]any{"branch": "feature"}); !strings.Contains(out, "b.txt") {
		t.Errorf("list_files branch=feature:\n%s", out)
	}
	if out := b.call(t, "search_code", map[string]any{"pattern": "feature work"}); strings.Contains(out, "b.txt") {
		t.Errorf("search_code followed HEAD:\n%s", out)
	}

	// History ends at the branch's head.
	if out := b.call(t, "list_commits", map[string]any{}); strings.Contains(out, "feature work") || !strings.Contains(out, "main work") {
		t.Errorf("list_commits on main:\n%s", out)
	}
	if out := b.call(t, "list_commits", map[string]any{"branch": "feature"}); !strings.Contains(out, "feature work") || strings.Contains(out, "main work") {
		t.Errorf("list_commits on feature:\n%s", out)
	}

	// New annotations are anchored on the branch, not the checked-out HEAD.
	b.call(t, "create_finding", map[string]any{"file": "a.txt", "title": "t", "severity": "low", "start": 1, "end": 1})
	ids, _ := b.listedFindings(t, map[string]any{})
	if len(ids) != 1 {
		t.Fatalf("created finding is not on the review branch: %v", ids)
	}
	f, err := b.db.GetFinding(ids[0])
	if err != nil {
		t.Fatal(err)
	}
	if f.Anchor.CommitID != b.mainTip {
		t.Errorf("anchored at %.7s, want main's tip %.7s", f.Anchor.CommitID, b.mainTip)
	}

	// Reconcile targets the branch head.
	if out := b.call(t, "reconcile", map[string]any{}); !strings.Contains(out, b.mainTip) {
		t.Errorf("reconcile target:\n%s", out)
	}
	if out := b.call(t, "get_coverage", map[string]any{}); strings.Contains(out, "b.txt") {
		t.Errorf("get_coverage followed HEAD:\n%s", out)
	}
}

func TestMCPReviewBranch_BaselinesAndDelta(t *testing.T) {
	b := setupBranchDeps(t)

	// A baseline at the shared commit, then one on main.
	for _, c := range []string{b.base, b.mainTip} {
		b.call(t, "set_baseline", map[string]any{"commit": c})
	}
	b.finding(t, "on-feature", b.featTip)
	b.finding(t, "on-main", b.mainTip)

	// On main: since main's own baseline.
	out := b.call(t, "get_delta", map[string]any{})
	if !strings.Contains(out, "at "+b.mainTip[:7]) {
		t.Errorf("main delta:\n%s", out)
	}
	if strings.Count(out, "- [high]") != 1 {
		t.Errorf("main delta should list one new finding:\n%s", out)
	}
	// On feature: main's baseline isn't in its history; the shared one is.
	out = b.call(t, "get_delta", map[string]any{"branch": "feature"})
	if !strings.Contains(out, "at "+b.base[:7]) || strings.Contains(out, "at "+b.mainTip[:7]) {
		t.Errorf("feature delta:\n%s", out)
	}
	if !strings.Contains(out, "b.txt") {
		t.Errorf("feature delta should list its changed files:\n%s", out)
	}

	out = b.call(t, "list_baselines", map[string]any{})
	if strings.Count(out, "BL-") != 2 {
		t.Errorf("main baselines:\n%s", out)
	}
	out = b.call(t, "list_baselines", map[string]any{"branch": "feature"})
	if strings.Count(out, "BL-") != 1 || !strings.Contains(out, "1 on other branches") {
		t.Errorf("feature baselines:\n%s", out)
	}

	// A baseline's own delta compares it with its predecessor in its history.
	ids := map[string]string{}
	bl, _ := b.db.ListBaselines(10)
	for _, x := range bl {
		ids[x.CommitID] = x.ID
	}
	out = b.call(t, "get_delta", map[string]any{"baseline": ids[b.mainTip]})
	if !strings.Contains(out, "Previous: BL-1") {
		t.Errorf("predecessor:\n%s", out)
	}

	// New baselines default to the review branch's head, not HEAD.
	b.call(t, "set_baseline", map[string]any{})
	bl, _ = b.db.ListBaselines(1)
	if bl[0].CommitID != b.mainTip {
		t.Errorf("baseline at %.7s, want main's tip %.7s", bl[0].CommitID, b.mainTip)
	}
}

func TestMCPReviewBranch_SummaryReconcilesAgainstBranchHead(t *testing.T) {
	b := setupBranchDeps(t)
	b.finding(t, "on-main", b.mainTip)
	if _, err := b.reconciler.GetReconciledHeadAt(b.mainTip); err != nil {
		t.Fatal(err)
	}
	out := b.call(t, "get_summary", map[string]any{})
	if !strings.Contains(out, "at "+b.mainTip[:7]) {
		t.Errorf("summary not at the branch head:\n%s", out)
	}
	out = b.call(t, "get_summary", map[string]any{"branch": "feature"})
	if !strings.Contains(out, "at "+b.featTip[:7]) {
		t.Errorf("summary branch=feature:\n%s", out)
	}
	// The count is the branch's: main's finding isn't on feature.
	if !strings.Contains(out, "Total: 0 findings") {
		t.Errorf("summary on feature counts main's finding:\n%s", out)
	}
	out = b.call(t, "get_summary", map[string]any{"branch": "feature", "all_branches": true})
	if !strings.Contains(out, "Total: 1 findings") {
		t.Errorf("summary over all branches:\n%s", out)
	}
}

// A scoped list that left nothing out says nothing about other branches.
func TestMCPReviewBranch_NoNoteWhenNothingLeftOut(t *testing.T) {
	b := setupBranchDeps(t)
	b.finding(t, "on-main", b.mainTip)
	if out := b.call(t, "list_findings", map[string]any{}); strings.Contains(out, "other branches") {
		t.Errorf("note with nothing left out:\n%s", out)
	}
	if out := b.call(t, "list_findings", map[string]any{"branch": "feature"}); !strings.Contains(out, "1 on other branches") {
		t.Errorf("no note with one left out:\n%s", out)
	}
}
