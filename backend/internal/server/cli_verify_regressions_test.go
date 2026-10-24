package server

// Regressions found driving the bench CLI and the MCP tools against a live
// multi-project server.

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A name with no letters or digits produced a project with an empty slug
// (unreachable by slug, data stored in ".db"); a rename could take another
// project's name.
func TestProjects_RejectEmptySlugAndDuplicateNames(t *testing.T) {
	h, p := newTestMCP(t)
	repo, _ := newGitRepo(t)
	if r := mcpCall(t, h, "create_project", map[string]any{"name": "!!!", "repoPath": repo}); !mcpIsError(t, r) || !strings.Contains(mcpResultText(t, r), "letter or digit") {
		t.Errorf("empty-slug create: %s", mcpResultText(t, r))
	}
	var n int
	p.db.QueryRow(`SELECT COUNT(*) FROM projects`).Scan(&n)
	if n != 0 {
		t.Fatalf("empty-slug project was stored (%d rows)", n)
	}

	a := registerProject(t, h, "Alpha", repo)
	b := registerProject(t, h, "Beta", repo)
	if r := mcpCall(t, h, "update_project", map[string]any{"project": a, "name": "beta"}); !mcpIsError(t, r) {
		t.Error("renaming alpha to another project's name (case-insensitively) should fail")
	}
	var name string
	p.db.QueryRow(`SELECT name FROM projects WHERE slug=?`, a).Scan(&name)
	if name != "Alpha" {
		t.Errorf("rejected rename still changed the name to %q", name)
	}
	// Renaming a project to its own name (or a new one) is fine.
	mcpOK(t, h, "update_project", map[string]any{"project": b, "name": "Beta"}, nil)
	mcpOK(t, h, "update_project", map[string]any{"project": b, "name": "Gamma"}, nil)
}

// A project named "Platform" stored its data in platform.db, the server's own database; and
// names that slugify alike ("Foo Bar", "foo-bar") were refused as duplicates.
func TestProjects_DBFilesNeverClash(t *testing.T) {
	dir := t.TempDir()
	h, p := testMCPAt(t, dir)
	repo, _ := newGitRepo(t)
	if slug := registerProject(t, h, "Platform", repo); slug != "platform" {
		t.Errorf(`"Platform" got slug %q`, slug)
	}
	if _, err := os.Stat(filepath.Join(dir, projectDBName("platform", repo))); err != nil {
		t.Errorf("project database: %v", err)
	}
	var n int
	if err := p.db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE name = 'findings'`).Scan(&n); err != nil || n != 0 {
		t.Errorf("the server's database holds project tables (findings: %d, %v)", n, err)
	}

	a := registerProject(t, h, "Foo Bar", repo)
	b := registerProject(t, h, "foo-bar", repo)
	if a != "foo-bar" || b != "foo-bar-2" {
		t.Errorf("slugs %q, %q; want foo-bar, foo-bar-2", a, b)
	}
}

// Data folders from before: platform.db and <slug>.db are renamed on start, with their data.
func TestDataFiles_OldNamesAreMoved(t *testing.T) {
	dir := t.TempDir()
	p, err := NewPlatform(dir)
	if err != nil {
		t.Fatal(err)
	}
	h := http.NewServeMux()
	h.Handle("POST /mcp", &platformMCP{p: p})
	repo, _ := newGitRepo(t)
	slug := registerProject(t, h, "Svc", repo)
	p.Close()
	for _, mv := range [][2]string{{serverDBName, legacyServerDBName}, {projectDBName(slug, repo), slug + ".db"}} {
		for _, suffix := range []string{"", "-wal", "-shm"} {
			if err := os.Rename(filepath.Join(dir, mv[0]+suffix), filepath.Join(dir, mv[1]+suffix)); err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
		}
	}

	_, p = testMCPAt(t, dir)
	for _, gone := range []string{legacyServerDBName, slug + ".db"} {
		if _, err := os.Stat(filepath.Join(dir, gone)); !os.IsNotExist(err) {
			t.Errorf("%s is still there (%v)", gone, err)
		}
	}
	assertBaselines(t, p, slug, 1)
}

// A checkout moved elsewhere, and the project pointed at it: its database is renamed to match,
// keeping its data.
func TestDataFiles_NewRepoPathMovesTheDatabase(t *testing.T) {
	dir := t.TempDir()
	h, p := testMCPAt(t, dir)
	repo, _ := newGitRepo(t)
	slug := registerProject(t, h, "Svc", repo)
	other := filepath.Join(t.TempDir(), filepath.Base(repo))
	if err := os.Rename(repo, other); err != nil {
		t.Fatal(err)
	}
	mcpOK(t, h, "update_project", map[string]any{"project": slug, "repoPath": other}, nil)
	if _, err := os.Stat(filepath.Join(dir, projectDBName(slug, repo))); !os.IsNotExist(err) {
		t.Errorf("the old database is still there (%v)", err)
	}
	assertBaselines(t, p, slug, 1)
}

// testMCPAt is newTestMCP with its data in dir.
func testMCPAt(t *testing.T, dir string) (http.Handler, *Platform) {
	t.Helper()
	p, err := NewPlatform(dir)
	if err != nil {
		t.Fatalf("NewPlatform: %v", err)
	}
	t.Cleanup(p.Close)
	mux := http.NewServeMux()
	mux.Handle("POST /mcp", &platformMCP{p: p})
	return mux, p
}

func assertBaselines(t *testing.T, p *Platform, slug string, want int) {
	t.Helper()
	wb, err := p.getWorkbench(slug)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := wb.ListBaselines(10); err != nil || len(got) != want {
		t.Errorf("%s has %d baselines (%v), want %d", slug, len(got), err, want)
	}
}

// Re-registering a removed project must not add a second "Initial baseline".
func TestProjects_ReAddKeepsBaselines(t *testing.T) {
	h, p := newTestMCP(t)
	repo, _ := newGitRepo(t)
	slug := registerProject(t, h, "Svc", repo)
	mcpOK(t, h, "delete_project", map[string]any{"project": slug}, nil)
	registerProject(t, h, "Svc", repo)
	wb, err := p.getWorkbench(slug)
	if err != nil {
		t.Fatal(err)
	}
	if bs, _ := wb.ListBaselines(10); len(bs) != 1 {
		t.Errorf("baselines after re-add = %d, want 1", len(bs))
	}
}

// Create responses carried empty createdAt/updatedAt; update responses had
// empty steps/links and the stale updatedAt; an empty name was accepted.
func TestFlows_CreateUpdateResponsesReflectStoredRow(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "F", "draft")
	if f.CreatedAt == "" || f.UpdatedAt == "" {
		t.Errorf("create response timestamps empty: %+v", f)
	}
	s := addTestStep(t, h, f.ID, "svc", "feat")
	if s.CreatedAt == "" {
		t.Errorf("add-step response createdAt empty: %+v", s)
	}
	w := do(t, h, "PATCH", "/api/flows/"+f.ID, `{"description":"d"}`)
	if w.Code != 200 {
		t.Fatalf("update: %d %s", w.Code, w.Body.String())
	}
	u := mustDecode[Flow](t, w)
	if len(u.Steps) != 1 || u.Steps[0].ID != s.ID {
		t.Errorf("update response steps = %+v, want the flow's step", u.Steps)
	}
	if w := do(t, h, "PATCH", "/api/flows/"+f.ID, `{"name":" "}`); w.Code != 400 {
		t.Errorf("empty name update = %d, want 400", w.Code)
	}
}

// set-edge (then set-link) replaced every field, so editing the edge label (UI) or passing
// one flag (CLI) wiped the edge's comment and tags.
func TestFlows_SetEdgeKeepsOmittedFields(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "F", "draft")
	a := addTestStep(t, h, f.ID, "svc", "a")
	b := addTestStep(t, h, f.ID, "web", "b") // appended: a -> b
	path := fmt.Sprintf("/api/flows/%s/edges/%s/%s", f.ID, a.ID, b.ID)
	if w := do(t, h, "PUT", path, `{"description":"calls","comment":"note","tags":["auth"],"kind":"call","auth":"service"}`); w.Code != 200 {
		t.Fatalf("set edge: %d %s", w.Code, w.Body.String())
	}
	w := do(t, h, "PUT", path, `{"description":"calls v2"}`)
	l := mustDecode[FlowEdge](t, w)
	if l.Description != "calls v2" || l.Comment != "note" || len(l.Tags) != 1 || l.Kind != "call" || l.Auth != "service" {
		t.Errorf("partial update response: %+v", l)
	}
	got := mustDecode[Flow](t, do(t, h, "GET", "/api/flows/"+f.ID, ""))
	if len(got.Edges) != 1 || got.Edges[0].Comment != "note" || got.Edges[0].Tags[0] != "auth" {
		t.Errorf("stored edge after partial update: %+v", got.Edges)
	}
	// Explicit empty values still clear.
	do(t, h, "PUT", path, `{"comment":"","tags":[]}`)
	got = mustDecode[Flow](t, do(t, h, "GET", "/api/flows/"+f.ID, ""))
	if got.Edges[0].Comment != "" || len(got.Edges[0].Tags) != 0 || got.Edges[0].Description != "calls v2" {
		t.Errorf("clearing fields: %+v", got.Edges[0])
	}
	// An empty body creates a bare edge (here the way back: a loop).
	if w := do(t, h, "PUT", fmt.Sprintf("/api/flows/%s/edges/%s/%s", f.ID, b.ID, a.ID), ""); w.Code != 200 {
		t.Errorf("empty-body edge: %d %s", w.Code, w.Body.String())
	}
}

// set-steps accepted what add-step/set-edge reject: steps without a feature,
// self-edges, and duplicate edges (which surfaced as a 500).
func TestFlows_SetStepsValidatesStepsAndLinks(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "F", "draft")
	keep := addTestStep(t, h, f.ID, "svc", "keep")
	for name, body := range map[string]string{
		"no feature": `{"steps":[{"clientId":"a"}]}`,
		"self link":  `{"steps":[{"clientId":"a","projectSlug":"s","featureId":"x"}],"links":[{"fromClientId":"a","toClientId":"a"}]}`,
		"duplicate": `{"steps":[{"clientId":"a","projectSlug":"s","featureId":"x"},{"clientId":"b","parentClientId":"a","projectSlug":"s","featureId":"y"}],
			"links":[{"fromClientId":"a","toClientId":"b"},{"fromClientId":"a","toClientId":"b"}]}`,
		"unknown client": `{"steps":[{"clientId":"a","projectSlug":"s","featureId":"x"}],"links":[{"fromClientId":"a","toClientId":"zz"}]}`,
	} {
		if w := do(t, h, "PUT", "/api/flows/"+f.ID+"/steps", body); w.Code != 400 {
			t.Errorf("%s: status %d (%s), want 400", name, w.Code, w.Body.String())
		}
	}
	got := mustDecode[Flow](t, do(t, h, "GET", "/api/flows/"+f.ID, ""))
	if len(got.Steps) != 1 || got.Steps[0].ID != keep.ID {
		t.Errorf("rejected set-steps changed the flow: %+v", got.Steps)
	}
}

// Saved views: create had empty timestamps, update accepted an empty name.
func TestFlowViews_TimestampsAndEmptyName(t *testing.T) {
	_, h := newTestPlatform(t)
	v := mustDecode[FlowView](t, do(t, h, "POST", "/api/flow-views", `{"name":"v"}`))
	if v.CreatedAt == "" || v.UpdatedAt == "" {
		t.Errorf("create view timestamps: %+v", v)
	}
	if w := do(t, h, "PATCH", "/api/flow-views/"+v.ID, `{"name":""}`); w.Code != 400 {
		t.Errorf("empty view name = %d, want 400", w.Code)
	}
}

// Catalog search: an unknown project filter returned [] (indistinguishable
// from "no match"); limit > 200 fell back to 50 instead of the max.
func TestCatalogSearch_UnknownProjectAndLimitClamp(t *testing.T) {
	h, p := newTestMCP(t)
	repo, commit := newGitRepo(t)
	slug := registerProject(t, h, "Svc", repo)
	for i := 0; i < 60; i++ {
		createFeature(t, p, slug, commit, fmt.Sprintf("feature %d", i))
	}
	if r := mcpCall(t, h, "search_features", map[string]any{"projects": []string{slug, "nosuch"}}); !mcpIsError(t, r) || !strings.Contains(mcpResultText(t, r), "nosuch") {
		t.Errorf("unknown project filter: %s", mcpResultText(t, r))
	}
	var got []CatalogFeature
	mcpOK(t, h, "search_features", map[string]any{"limit": 500}, &got)
	if len(got) != 60 {
		t.Errorf("limit 500 returned %d features, want all 60 (clamped to 200)", len(got))
	}
}

// get_features silently dropped "slug:id" string refs (the CLI/REST form);
// flows_move_step rejected the CLI's "up"/"down".
func TestMCP_LenientRefsAndDirection(t *testing.T) {
	h, p := newTestMCP(t)
	repo, commit := newGitRepo(t)
	slug := registerProject(t, h, "Svc", repo)
	feat := createFeature(t, p, slug, commit, "Login")
	var got []CatalogFeature
	mcpOK(t, h, "get_features", map[string]any{"refs": []any{slug + ":" + feat, map[string]any{"project_slug": slug, "feature_id": "nope"}}}, &got)
	if len(got) != 2 || got[0].Title != "Login" || !got[1].Tombstoned {
		t.Errorf("get_features mixed refs: %+v", got)
	}

	var f Flow
	mcpOK(t, h, "flows_create", map[string]any{"name": "F"}, &f)
	var s1, s2 FlowStep
	mcpOK(t, h, "flows_add_step", map[string]any{"flow_id": f.ID, "project_slug": slug, "feature_id": feat}, &s1)
	mcpOK(t, h, "flows_add_step", map[string]any{"flow_id": f.ID, "project_slug": slug, "feature_id": feat}, &s2)
	mcpOK(t, h, "flows_move_step", map[string]any{"flow_id": f.ID, "step_id": s2.ID, "direction": "up"}, nil)
	var pos int
	p.db.QueryRow(`SELECT position FROM flow_steps WHERE id=?`, s2.ID).Scan(&pos)
	if pos != 0 {
		t.Errorf("after move up, position = %d, want 0", pos)
	}
}
