package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// ── helpers ───────────────────────────────────────────────────────────────────

// newGitRepo makes a one-commit repo and returns its path and HEAD sha.
func newGitRepo(t *testing.T) (string, string) {
	t.Helper()
	repo := t.TempDir()
	run := func(args ...string) string {
		t.Helper()
		out, err := exec.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("init")
	run("config", "user.email", "t@t.com")
	run("config", "user.name", "T")
	if err := os.WriteFile(filepath.Join(repo, "a.go"), []byte("package a\n\nfunc A() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "init")
	return repo, run("rev-parse", "HEAD")
}

// mcpOK calls a tool, fails on a tool error and decodes the JSON text into v (if non-nil).
func mcpOK(t *testing.T, h http.Handler, name string, args map[string]any, v any) {
	t.Helper()
	resp := mcpCall(t, h, name, args)
	if resp.Error != nil {
		t.Fatalf("%s: rpc error %s", name, resp.Error.Message)
	}
	if mcpIsError(t, resp) {
		t.Fatalf("%s: tool error: %s", name, mcpResultText(t, resp))
	}
	if v != nil {
		if err := json.Unmarshal([]byte(mcpResultText(t, resp)), v); err != nil {
			t.Fatalf("%s: decode %v: %s", name, err, mcpResultText(t, resp))
		}
	}
}

type toolDef struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	InputSchema struct {
		Properties map[string]json.RawMessage `json:"properties"`
		Required   []string                   `json:"required"`
	} `json:"inputSchema"`
}

func listTools(t *testing.T, h http.Handler, path string) []toolDef {
	t.Helper()
	req := httptest.NewRequest("POST", path, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	var resp struct {
		Result struct {
			Tools []toolDef `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode tools/list: %v (%s)", err, w.Body.String())
	}
	return resp.Result.Tools
}

// registerProject creates a project through MCP and returns its slug.
func registerProject(t *testing.T, h http.Handler, name, repo string) string {
	t.Helper()
	var proj Project
	mcpOK(t, h, "create_project", map[string]any{"name": name, "repoPath": repo}, &proj)
	if proj.Slug == "" {
		t.Fatalf("create_project returned no slug: %+v", proj)
	}
	return proj.Slug
}

// createFeature creates a feature in a project through the per-project REST API.
func createFeature(t *testing.T, p *Platform, slug, commit, title string) string {
	t.Helper()
	wb, err := p.getWorkbench(slug)
	if err != nil {
		t.Fatal(err)
	}
	call := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		wb.Handler().ServeHTTP(w, req)
		return w
	}
	if w := call("PATCH", "/api/profile", `{}`); w.Code != 200 {
		t.Fatalf("profile: %d %s", w.Code, w.Body.String())
	}
	w := call("POST", "/api/features", fmt.Sprintf(`{"anchor":{"fileId":"a.go","commitId":%q,"lineRange":{"start":3,"end":3}},"kind":"interface","title":%q}`, commit, title))
	if w.Code != 201 {
		t.Fatalf("create feature: %d %s", w.Code, w.Body.String())
	}
	var f struct {
		ID string `json:"id"`
	}
	json.NewDecoder(w.Body).Decode(&f)
	return f.ID
}

// ── tool surface ──────────────────────────────────────────────────────────────

// Every advertised platform tool must be routed, every route advertised, and
// the whole list valid JSON with unique names.
func TestMCP_PlatformToolDefsMatchRoutes(t *testing.T) {
	defs := map[string]bool{}
	for _, raw := range platformToolDefs() {
		var d toolDef
		if err := json.Unmarshal(raw, &d); err != nil {
			t.Fatalf("invalid tool JSON: %v\n%s", err, raw)
		}
		if defs[d.Name] {
			t.Errorf("duplicate platform tool %q", d.Name)
		}
		defs[d.Name] = true
		if _, routed := platformRoutes[d.Name]; !routed && d.Name != "flows_delete" {
			t.Errorf("tool %q advertised but not routed", d.Name)
		}
		// Every path placeholder must be a declared, required param.
		if route, ok := platformRoutes[d.Name]; ok {
			for _, m := range placeholderRe.FindAllStringSubmatch(route.path, -1) {
				if _, ok := d.InputSchema.Properties[m[1]]; !ok {
					t.Errorf("tool %q: path param %q not in schema", d.Name, m[1])
				}
				found := false
				for _, r := range d.InputSchema.Required {
					found = found || r == m[1]
				}
				if !found {
					t.Errorf("tool %q: path param %q not required", d.Name, m[1])
				}
			}
		}
	}
	for name := range platformRoutes {
		if !defs[name] {
			t.Errorf("route %q has no tool definition", name)
		}
	}
}

// The aggregate endpoint must expose every bench tool, each with a required
// project param, and no name may collide with a platform tool.
func TestMCP_AggregateExposesEveryBenchTool(t *testing.T) {
	h, p := newTestMCP(t)
	repo, _ := newGitRepo(t)
	slug := registerProject(t, h, "Svc", repo)
	wb, err := p.getWorkbench(slug)
	if err != nil {
		t.Fatal(err)
	}

	var benchNames []string
	for _, raw := range toolsFromHandler(wb.MCPHandler()) {
		var d toolDef
		json.Unmarshal(raw, &d)
		benchNames = append(benchNames, d.Name)
	}
	if len(benchNames) < 40 {
		t.Fatalf("bench tool discovery looks broken: %d tools", len(benchNames))
	}

	all := map[string]toolDef{}
	for _, d := range listTools(t, h, "/mcp") {
		if _, dup := all[d.Name]; dup {
			t.Errorf("duplicate tool name %q in aggregate list", d.Name)
		}
		all[d.Name] = d
	}
	for _, want := range []string{"list_features", "get_feature", "get_service_profile", "update_service_profile", "list_findings", "reconcile"} {
		if _, ok := all[want]; !ok {
			t.Errorf("bench tool %q missing from aggregate list", want)
		}
	}
	for _, name := range benchNames {
		d, ok := all[name]
		if !ok {
			t.Errorf("bench tool %q not proxied", name)
			continue
		}
		if _, ok := d.InputSchema.Properties["project"]; !ok || len(d.InputSchema.Required) == 0 || d.InputSchema.Required[0] != "project" {
			t.Errorf("bench tool %q lacks a required project param: %+v", name, d.InputSchema.Required)
		}
	}
}

func TestMCP_PerProjectEndpoint(t *testing.T) {
	_, p := newTestMCP(t)
	repo, _ := newGitRepo(t)
	if _, err := p.db.Exec(`INSERT INTO projects (id, name, slug, repo_path) VALUES ('p1','Svc','svc',?)`, repo); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle("/api/projects/{slug}/", p.workbenchRouter())

	tools := listTools(t, mux, "/api/projects/svc/mcp")
	names := map[string]toolDef{}
	for _, d := range tools {
		names[d.Name] = d
	}
	d, ok := names["list_features"]
	if !ok {
		t.Fatalf("per-project MCP lacks list_features (%d tools)", len(tools))
	}
	if _, has := d.InputSchema.Properties["project"]; has {
		t.Error("per-project tools must not take a project param")
	}
	if _, has := names["flows_list"]; has {
		t.Error("per-project MCP should not expose platform tools")
	}

	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call",
		"params": map[string]any{"name": "list_features", "arguments": map[string]any{}}})
	req := httptest.NewRequest("POST", "/api/projects/svc/mcp", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	var resp mcpResp
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Error != nil || mcpIsError(t, resp) {
		t.Fatalf("per-project list_features failed: %s", w.Body.String())
	}

	req = httptest.NewRequest("POST", "/api/projects/nope/mcp", bytes.NewReader(body))
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != 404 {
		t.Fatalf("unknown project: status %d", w.Code)
	}
}

// ── projects ──────────────────────────────────────────────────────────────────

func TestMCP_ProjectLifecycle(t *testing.T) {
	h, p := newTestMCP(t)
	repo, _ := newGitRepo(t)

	var proj Project
	mcpOK(t, h, "create_project", map[string]any{"name": "Payments API", "repoPath": repo}, &proj)
	if proj.Slug != "payments-api" || proj.ID == "" {
		t.Fatalf("create_project: %+v", proj)
	}
	// Like the REST route, MCP creation takes an initial baseline.
	wb, err := p.getWorkbench(proj.Slug)
	if err != nil {
		t.Fatal(err)
	}
	if bs, _ := wb.ListBaselines(5); len(bs) != 1 {
		t.Errorf("expected an initial baseline, got %d", len(bs))
	}

	if r := mcpCall(t, h, "create_project", map[string]any{"name": "Payments API", "repoPath": repo}); !mcpIsError(t, r) {
		t.Error("duplicate project name should fail")
	}
	if r := mcpCall(t, h, "create_project", map[string]any{"name": "x", "repoPath": t.TempDir()}); !mcpIsError(t, r) {
		t.Error("non-git path should fail")
	}

	var list []Project
	mcpOK(t, h, "list_projects", map[string]any{}, &list)
	if len(list) != 1 || list[0].Slug != proj.Slug || list[0].Stats == nil {
		t.Fatalf("list_projects: %+v", list)
	}

	var all []PlatformBaseline
	mcpOK(t, h, "list_all_baselines", map[string]any{}, &all)
	if len(all) != 1 || all[0].ProjectSlug != proj.Slug {
		t.Fatalf("list_all_baselines: %+v", all)
	}

	// update_project accepts the project id as well as the slug.
	var updated Project
	mcpOK(t, h, "update_project", map[string]any{"project": proj.ID, "name": "Payments"}, &updated)
	if updated.Name != "Payments" || updated.Slug != proj.Slug {
		t.Fatalf("update_project: %+v", updated)
	}

	// Bench tools route through project.
	mcpOK(t, h, "list_features", map[string]any{"project": proj.Slug}, nil)
	mcpOK(t, h, "get_service_profile", map[string]any{"project": proj.Slug}, nil)
	if r := mcpCall(t, h, "list_features", map[string]any{}); !mcpIsError(t, r) {
		t.Error("bench tool without project should fail")
	}

	mcpOK(t, h, "delete_project", map[string]any{"project": proj.Slug}, nil)
	if r := mcpCall(t, h, "list_features", map[string]any{"project": proj.Slug}); !mcpIsError(t, r) {
		t.Error("deleted project should no longer resolve")
	}
	if r := mcpCall(t, h, "delete_project", map[string]any{"project": proj.Slug}); !mcpIsError(t, r) {
		t.Error("second delete should fail")
	}
	if r := mcpCall(t, h, "delete_project", map[string]any{}); !mcpIsError(t, r) || !strings.Contains(mcpResultText(t, r), "project is required") {
		t.Error("delete_project without project should say project is required")
	}
}

// ── cross-project features + links ───────────────────────────────────────────

func TestMCP_CrossProjectFeaturesAndLinks(t *testing.T) {
	h, p := newTestMCP(t)
	repoA, commitA := newGitRepo(t)
	repoB, commitB := newGitRepo(t)
	a := registerProject(t, h, "web", repoA)
	b := registerProject(t, h, "api", repoB)
	fa := createFeature(t, p, a, commitA, "Login form")
	fb := createFeature(t, p, b, commitB, "Login endpoint")
	createFeature(t, p, b, commitB, "Health check")

	var found []CatalogFeature
	mcpOK(t, h, "search_features", map[string]any{"query": "login"}, &found)
	if len(found) != 2 {
		t.Fatalf("search across projects: %+v", found)
	}
	mcpOK(t, h, "search_features", map[string]any{"query": "login", "projects": []string{b}}, &found)
	if len(found) != 1 || found[0].ID != fb || found[0].ProjectSlug != b {
		t.Fatalf("search scoped to %s: %+v", b, found)
	}
	mcpOK(t, h, "search_features", map[string]any{"limit": 1}, &found)
	if len(found) != 1 {
		t.Fatalf("limit ignored: %d results", len(found))
	}

	var resolved []CatalogFeature
	mcpOK(t, h, "get_features", map[string]any{"refs": []map[string]string{
		{"project_slug": a, "feature_id": fa},
		{"project_slug": b, "feature_id": "missing"},
	}}, &resolved)
	if len(resolved) != 2 || resolved[0].Title != "Login form" || !resolved[1].Tombstoned {
		t.Fatalf("get_features: %+v", resolved)
	}

	// A flow spanning both projects, linked across them.
	var flow Flow
	mcpOK(t, h, "flows_create", map[string]any{"name": "Login"}, &flow)
	var s1, s2 FlowStep
	mcpOK(t, h, "flows_add_step", map[string]any{"flow_id": flow.ID, "project_slug": a, "feature_id": fa}, &s1)
	mcpOK(t, h, "flows_add_step", map[string]any{"flow_id": flow.ID, "project_slug": b, "feature_id": fb, "parent_step_id": s1.ID}, &s2)
	if s1.Tombstoned || s2.Tombstoned {
		t.Fatalf("steps should resolve: %+v %+v", s1, s2)
	}
	var link FlowLink
	mcpOK(t, h, "flows_set_link", map[string]any{"flow_id": flow.ID, "from_step_id": s2.ID, "to_step_id": s1.ID, "description": "session cookie"}, &link)
	if link.Description != "session cookie" {
		t.Fatalf("link: %+v", link)
	}
	var got Flow
	mcpOK(t, h, "flows_get", map[string]any{"flow_id": flow.ID}, &got)
	if len(got.Links) != 1 || got.Links[0].FromStepID != s2.ID {
		t.Fatalf("cross-project link not stored: %+v", got.Links)
	}

	// Links never leave their flow, and a step cannot link to itself.
	var other Flow
	mcpOK(t, h, "flows_create", map[string]any{"name": "Other"}, &other)
	var foreign FlowStep
	mcpOK(t, h, "flows_add_step", map[string]any{"flow_id": other.ID, "project_slug": b, "feature_id": fb}, &foreign)
	if r := mcpCall(t, h, "flows_set_link", map[string]any{"flow_id": flow.ID, "from_step_id": s1.ID, "to_step_id": foreign.ID}); !mcpIsError(t, r) {
		t.Error("link to a step of another flow should fail")
	}
	if r := mcpCall(t, h, "flows_set_link", map[string]any{"flow_id": flow.ID, "from_step_id": s1.ID, "to_step_id": s1.ID}); !mcpIsError(t, r) {
		t.Error("self link should fail")
	}

	// Flow findings + facets aggregate across projects.
	var findings struct {
		Total int `json:"total"`
	}
	mcpOK(t, h, "flows_list_findings", map[string]any{"flow_id": flow.ID}, &findings)
	var facets FacetsResponse
	mcpOK(t, h, "flows_list_facets", map[string]any{}, &facets)
	var projects []string
	for _, f := range facets.Project {
		projects = append(projects, f.Value)
	}
	sort.Strings(projects)
	if strings.Join(projects, ",") != "api,web" {
		t.Fatalf("project facets: %v", projects)
	}

	var page FlowsPage
	mcpOK(t, h, "flows_list", map[string]any{"project": a}, &page)
	if page.Total != 1 || page.Items[0].ID != flow.ID {
		t.Fatalf("flows_list project filter: %+v", page)
	}
}

// ── flows_list paging/search, step update, views ─────────────────────────────

func TestMCP_FlowsListPagingAndQuery(t *testing.T) {
	h, _ := newTestMCP(t)
	for _, name := range []string{"Checkout", "Password reset", "Signup"} {
		mcpOK(t, h, "flows_create", map[string]any{"name": name}, nil)
	}
	var page FlowsPage
	mcpOK(t, h, "flows_list", map[string]any{"limit": 2, "offset": 1, "sort": "name", "order": "asc"}, &page)
	if page.Total != 3 || page.Limit != 2 || page.Offset != 1 || len(page.Items) != 2 || page.Items[0].Name != "Password reset" {
		t.Fatalf("paging: %+v", page)
	}
	mcpOK(t, h, "flows_list", map[string]any{"query": "password"}, &page)
	if page.Total != 1 || page.Items[0].Name != "Password reset" {
		t.Fatalf("query: %+v", page)
	}
}

func TestMCP_FlowsUpdateStep_SnakeCase(t *testing.T) {
	h, _ := newTestMCP(t)
	var flow Flow
	mcpOK(t, h, "flows_create", map[string]any{"name": "f"}, &flow)
	var step FlowStep
	mcpOK(t, h, "flows_add_step", map[string]any{"flow_id": flow.ID, "project_slug": "p", "feature_id": "x"}, &step)
	var updated FlowStep
	mcpOK(t, h, "flows_update_step", map[string]any{"flow_id": flow.ID, "step_id": step.ID, "branch_condition": "if admin"}, &updated)
	if updated.BranchCondition != "if admin" {
		t.Fatalf("branch_condition not applied: %+v", updated)
	}
	if r := mcpCall(t, h, "flows_update_step", map[string]any{"flow_id": flow.ID}); !mcpIsError(t, r) || !strings.Contains(mcpResultText(t, r), "step_id is required") {
		t.Fatal("missing step_id should be reported")
	}
}

func TestMCP_FlowViews(t *testing.T) {
	h, _ := newTestMCP(t)
	var view FlowView
	mcpOK(t, h, "flows_create_view", map[string]any{"name": "Active auth", "query": "status:active tag:auth", "is_shared": true}, &view)
	if view.ID == "" || !view.IsShared || view.Query != "status:active tag:auth" {
		t.Fatalf("create view: %+v", view)
	}
	var updated FlowView
	mcpOK(t, h, "flows_update_view", map[string]any{"view_id": view.ID, "name": "Auth", "is_shared": false}, &updated)
	if updated.Name != "Auth" || updated.IsShared || updated.Query != view.Query {
		t.Fatalf("update view: %+v", updated)
	}
	var views []FlowView
	mcpOK(t, h, "flows_list_views", map[string]any{}, &views)
	if len(views) != 1 || views[0].Name != "Auth" {
		t.Fatalf("list views: %+v", views)
	}
	mcpOK(t, h, "flows_delete_view", map[string]any{"view_id": view.ID}, nil)
	if r := mcpCall(t, h, "flows_delete_view", map[string]any{"view_id": view.ID}); !mcpIsError(t, r) {
		t.Fatal("deleting a missing view should fail")
	}
}
