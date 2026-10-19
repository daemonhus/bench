package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

// ── MCP test helpers ──────────────────────────────────────────────────────────

func newTestMCP(t *testing.T) (http.Handler, *Platform) {
	t.Helper()
	p, err := NewPlatform(t.TempDir())
	if err != nil {
		t.Fatalf("NewPlatform: %v", err)
	}
	t.Cleanup(p.Close)
	mcp := &platformMCP{p: p}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /mcp", mcp.ServeHTTP)
	return mux, p
}

type mcpResp struct {
	ID     any             `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func mcpCall(t *testing.T, h http.Handler, name string, args map[string]any) mcpResp {
	t.Helper()
	argsJSON, _ := json.Marshal(args)
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params":  map[string]any{"name": name, "arguments": json.RawMessage(argsJSON)},
	})
	req := httptest.NewRequest("POST", "/mcp", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	var resp mcpResp
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode mcp response: %v (body: %s)", err, w.Body.String())
	}
	return resp
}

// mcpResultText decodes the text content from a tools/call result.
func mcpResultText(t *testing.T, resp mcpResp) string {
	t.Helper()
	var result struct {
		IsError bool `json:"isError"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("decode result: %v (raw: %s)", err, resp.Result)
	}
	if len(result.Content) == 0 {
		t.Fatal("result has no content")
	}
	return result.Content[0].Text
}

func mcpIsError(t *testing.T, resp mcpResp) bool {
	t.Helper()
	var result struct {
		IsError bool `json:"isError"`
	}
	json.Unmarshal(resp.Result, &result)
	return result.IsError
}

// ── tools/list ────────────────────────────────────────────────────────────────

func TestMCP_FlowsToolsAdvertised(t *testing.T) {
	h, _ := newTestMCP(t)

	body := `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`
	req := httptest.NewRequest("POST", "/mcp", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	var resp struct {
		Result struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	names := make(map[string]bool)
	for _, tool := range resp.Result.Tools {
		names[tool.Name] = true
	}
	want := []string{
		"flows_list", "flows_get", "flows_create", "flows_update", "flows_delete",
		"flows_add_step", "flows_update_step", "flows_remove_step", "flows_move_step",
		"flows_set_steps", "flows_set_link", "flows_delete_link",
		"flows_list_facets",
		"flows_set_baseline", "flows_list_baselines", "flows_get_baseline",
		"flows_get_delta", "flows_delete_baseline",
		"flows_list_findings",
	}
	for _, name := range want {
		if !names[name] {
			t.Errorf("tool %q not advertised", name)
		}
	}
}

// ── Required field validation ─────────────────────────────────────────────────

func TestMCP_FlowsCreate_MissingName(t *testing.T) {
	h, _ := newTestMCP(t)
	resp := mcpCall(t, h, "flows_create", map[string]any{})
	if !mcpIsError(t, resp) {
		t.Fatal("expected isError=true when name is missing")
	}
}

func TestMCP_FlowsGet_MissingFlowID(t *testing.T) {
	h, _ := newTestMCP(t)
	resp := mcpCall(t, h, "flows_get", map[string]any{})
	// Blank flow_id → 404 from handler, surfaced as isError.
	if !mcpIsError(t, resp) {
		t.Fatal("expected isError=true for missing flow_id")
	}
}

func TestMCP_FlowsAddStep_MissingFields(t *testing.T) {
	h, _ := newTestMCP(t)
	// Missing both flow_id and projectSlug/featureId.
	resp := mcpCall(t, h, "flows_add_step", map[string]any{"flow_id": "nope"})
	if !mcpIsError(t, resp) {
		t.Fatal("expected isError=true for add_step with missing required fields")
	}
}

func TestMCP_FlowsSetBaseline_UnknownFlow(t *testing.T) {
	h, _ := newTestMCP(t)
	resp := mcpCall(t, h, "flows_set_baseline", map[string]any{"flow_id": "does-not-exist"})
	// Flow not found → 404 → isError.
	if !mcpIsError(t, resp) {
		t.Fatal("expected isError=true for set_baseline on non-existent flow")
	}
}

// ── Dry-run default ───────────────────────────────────────────────────────────

func TestMCP_FlowsDelete_DryRunDefault(t *testing.T) {
	h, p := newTestMCP(t)

	// Create a flow directly in the MCP platform's DB.
	p.db.Exec(
		`INSERT INTO flows (id, name, description, status, owner, tags, created_at, updated_at)
		 VALUES ('dry-run-flow', 'test flow', '', 'active', '', '[]', datetime('now'), datetime('now'))`,
	)
	f := struct{ ID, Name string }{"dry-run-flow", "test flow"}

	// Delete without confirm → should return a preview, not actually delete.
	resp := mcpCall(t, h, "flows_delete", map[string]any{"flow_id": f.ID})
	if mcpIsError(t, resp) {
		t.Fatalf("dry-run delete returned error: %s", mcpResultText(t, resp))
	}
	text := mcpResultText(t, resp)
	if !strings.Contains(text, f.ID) {
		t.Fatalf("dry-run response should mention flow id, got: %s", text)
	}

	// Flow should still exist.
	var count int
	p.db.QueryRow("SELECT COUNT(*) FROM flows WHERE id=?", f.ID).Scan(&count)
	if count != 1 {
		t.Fatal("dry-run delete should not remove the flow")
	}
}

func TestMCP_FlowsDeleteBaseline_DryRunDefault(t *testing.T) {
	h, p := newTestMCP(t)

	// Insert a flow and baseline directly.
	p.db.Exec(`INSERT INTO flows (id, name, description, status, owner, tags, created_at, updated_at)
		VALUES ('f1', 'flow', '', 'active', '', '[]', datetime('now'), datetime('now'))`)
	p.db.Exec(`INSERT INTO flow_baselines (id, flow_id, seq, reviewer, summary, created_at, snapshot)
		VALUES ('b1', 'f1', 1, '', '', datetime('now'), '{"flow":{"id":"f1"},"steps":[],"links":[]}')`)

	resp := mcpCall(t, h, "flows_delete_baseline", map[string]any{
		"flow_id": "f1", "baseline_id": "b1",
	})
	if mcpIsError(t, resp) {
		t.Fatalf("dry-run baseline delete error: %s", mcpResultText(t, resp))
	}

	var count int
	p.db.QueryRow("SELECT COUNT(*) FROM flow_baselines WHERE id='b1'").Scan(&count)
	if count != 1 {
		t.Fatal("dry-run should not delete baseline")
	}
}

// ── Round-trip: create → add step → get ──────────────────────────────────────

func TestMCP_FlowsRoundTrip_CreateAddStepGet(t *testing.T) {
	h, _ := newTestMCP(t)

	// 1. Create flow.
	createResp := mcpCall(t, h, "flows_create", map[string]any{"name": "e2e flow"})
	if mcpIsError(t, createResp) {
		t.Fatalf("create flow: %s", mcpResultText(t, createResp))
	}
	var createdFlow Flow
	if err := json.Unmarshal([]byte(mcpResultText(t, createResp)), &createdFlow); err != nil {
		t.Fatalf("decode created flow: %v", err)
	}
	if createdFlow.ID == "" {
		t.Fatal("created flow has no id")
	}

	// 2. Add a step (project_slug and feature_id are required by DB but workbench won't
	//    be found in test env, so we verify the handler attempts the insert and fails
	//    gracefully with a non-panic error — or succeeds with tombstoned).
	stepResp := mcpCall(t, h, "flows_add_step", map[string]any{
		"flow_id":      createdFlow.ID,
		"project_slug": "test-project",
		"feature_id":   "feat-1",
	})
	// The handler will either succeed (step inserted, tombstoned because workbench absent)
	// or return an error — either is acceptable; the key check is no panic and flow exists.
	_ = stepResp

	// 3. Get the flow — must return 200 with correct id.
	getResp := mcpCall(t, h, "flows_get", map[string]any{"flow_id": createdFlow.ID})
	if mcpIsError(t, getResp) {
		t.Fatalf("get flow: %s", mcpResultText(t, getResp))
	}
	var gotFlow Flow
	if err := json.Unmarshal([]byte(mcpResultText(t, getResp)), &gotFlow); err != nil {
		t.Fatalf("decode got flow: %v", err)
	}
	if gotFlow.ID != createdFlow.ID {
		t.Fatalf("round-trip id mismatch: got %q want %q", gotFlow.ID, createdFlow.ID)
	}
	if gotFlow.Name != "e2e flow" {
		t.Fatalf("round-trip name mismatch: got %q", gotFlow.Name)
	}
}

// ── flows_set_baseline round-trip ─────────────────────────────────────────────

func TestMCP_FlowsBaselineRoundTrip(t *testing.T) {
	h, _ := newTestMCP(t)

	// Create flow.
	cr := mcpCall(t, h, "flows_create", map[string]any{"name": "baseline flow"})
	var f Flow
	json.Unmarshal([]byte(mcpResultText(t, cr)), &f)

	// Set baseline.
	br := mcpCall(t, h, "flows_set_baseline", map[string]any{
		"flow_id": f.ID, "reviewer": "tester", "summary": "initial",
	})
	if mcpIsError(t, br) {
		t.Fatalf("set baseline: %s", mcpResultText(t, br))
	}
	var b FlowBaseline
	json.Unmarshal([]byte(mcpResultText(t, br)), &b)
	if b.Seq != 1 {
		t.Fatalf("expected seq=1, got %d", b.Seq)
	}
	if b.Reviewer != "tester" {
		t.Fatalf("expected reviewer=tester, got %q", b.Reviewer)
	}

	// List baselines.
	lr := mcpCall(t, h, "flows_list_baselines", map[string]any{"flow_id": f.ID})
	if mcpIsError(t, lr) {
		t.Fatalf("list baselines: %s", mcpResultText(t, lr))
	}
	var list []FlowBaseline
	json.Unmarshal([]byte(mcpResultText(t, lr)), &list)
	if len(list) != 1 {
		t.Fatalf("expected 1 baseline, got %d", len(list))
	}

	// Get baseline.
	gr := mcpCall(t, h, "flows_get_baseline", map[string]any{"flow_id": f.ID, "baseline_id": b.ID})
	if mcpIsError(t, gr) {
		t.Fatalf("get baseline: %s", mcpResultText(t, gr))
	}
	var got FlowBaseline
	json.Unmarshal([]byte(mcpResultText(t, gr)), &got)
	if got.ID != b.ID {
		t.Fatalf("baseline id mismatch")
	}

	// Get delta (should have empty diff since no steps changed).
	dr := mcpCall(t, h, "flows_get_delta", map[string]any{"flow_id": f.ID})
	if mcpIsError(t, dr) {
		t.Fatalf("get delta: %s", mcpResultText(t, dr))
	}

	// Delete baseline dry-run.
	ddr := mcpCall(t, h, "flows_delete_baseline", map[string]any{"flow_id": f.ID, "baseline_id": b.ID})
	if mcpIsError(t, ddr) {
		t.Fatalf("dry-run delete: %s", mcpResultText(t, ddr))
	}
	// Confirm delete.
	cdr := mcpCall(t, h, "flows_delete_baseline", map[string]any{"flow_id": f.ID, "baseline_id": b.ID, "confirm": true})
	if mcpIsError(t, cdr) {
		t.Fatalf("confirm delete: %s", mcpResultText(t, cdr))
	}
}

// ── flows_delete_link ─────────────────────────────────────────────────────────

func TestMCP_FlowsDeleteLink(t *testing.T) {
	h, p := newTestMCP(t)

	// Seed a flow and two steps with a link directly in the DB.
	p.db.Exec(`INSERT INTO flows (id, name, description, status, owner, tags, created_at, updated_at)
		VALUES ('fl1', 'link flow', '', 'active', '', '[]', datetime('now'), datetime('now'))`)
	p.db.Exec(`INSERT INTO flow_steps (id, flow_id, project_slug, feature_id, position)
		VALUES ('s1', 'fl1', 'proj', 'f1', 1),
		       ('s2', 'fl1', 'proj', 'f2', 2)`)
	p.db.Exec(`INSERT INTO flow_step_links (flow_id, from_step_id, to_step_id, description)
		VALUES ('fl1', 's1', 's2', 'hop')`)

	// Verify link is present before deletion.
	var count int
	p.db.QueryRow(`SELECT COUNT(*) FROM flow_step_links WHERE flow_id='fl1'`).Scan(&count)
	if count != 1 {
		t.Fatal("precondition: link should exist")
	}

	// Delete the link via MCP.
	resp := mcpCall(t, h, "flows_delete_link", map[string]any{
		"flow_id": "fl1", "from_step_id": "s1", "to_step_id": "s2",
	})
	if mcpIsError(t, resp) {
		t.Fatalf("delete_link error: %s", mcpResultText(t, resp))
	}

	// Link must be gone.
	p.db.QueryRow(`SELECT COUNT(*) FROM flow_step_links WHERE flow_id='fl1'`).Scan(&count)
	if count != 0 {
		t.Fatal("link should have been deleted")
	}
}

func TestMCP_FlowsSetLink_WithCommentAndTags(t *testing.T) {
	h, p := newTestMCP(t)

	p.db.Exec(`INSERT INTO flows (id, name, description, status, owner, tags, created_at, updated_at)
		VALUES ('fl3', 'link flow', '', 'active', '', '[]', datetime('now'), datetime('now'))`)
	p.db.Exec(`INSERT INTO flow_steps (id, flow_id, project_slug, feature_id, position)
		VALUES ('a1', 'fl3', 'proj', 'f1', 1),
		       ('b1', 'fl3', 'proj', 'f2', 2)`)

	resp := mcpCall(t, h, "flows_set_link", map[string]any{
		"flow_id":      "fl3",
		"from_step_id": "a1",
		"to_step_id":   "b1",
		"description":  "on error",
		"comment":      "needs review",
		"tags":         []string{"auth", "external"},
	})
	if mcpIsError(t, resp) {
		t.Fatalf("set_link error: %s", mcpResultText(t, resp))
	}
	var lnk FlowLink
	if err := json.Unmarshal([]byte(mcpResultText(t, resp)), &lnk); err != nil {
		t.Fatalf("decode link: %v", err)
	}
	if lnk.Description != "on error" {
		t.Errorf("description=%q", lnk.Description)
	}
	if lnk.Comment != "needs review" {
		t.Errorf("comment=%q", lnk.Comment)
	}
	if len(lnk.Tags) != 2 || lnk.Tags[0] != "auth" {
		t.Errorf("tags=%v", lnk.Tags)
	}
}

func TestMCP_FlowsDeleteLink_NotFound(t *testing.T) {
	h, p := newTestMCP(t)
	p.db.Exec(`INSERT INTO flows (id, name, description, status, owner, tags, created_at, updated_at)
		VALUES ('fl2', 'f', '', 'active', '', '[]', datetime('now'), datetime('now'))`)

	resp := mcpCall(t, h, "flows_delete_link", map[string]any{
		"flow_id": "fl2", "from_step_id": "no-such", "to_step_id": "also-no",
	})
	if !mcpIsError(t, resp) {
		t.Fatal("expected isError=true when link does not exist")
	}
}

// ── flows_list_facets ─────────────────────────────────────────────────────────

func TestMCP_FlowsListFacets_Empty(t *testing.T) {
	h, _ := newTestMCP(t)

	resp := mcpCall(t, h, "flows_list_facets", map[string]any{})
	if mcpIsError(t, resp) {
		t.Fatalf("list_facets error: %s", mcpResultText(t, resp))
	}
	text := mcpResultText(t, resp)
	// Response must be valid JSON with the four facet keys.
	var facets FacetsResponse
	if err := json.Unmarshal([]byte(text), &facets); err != nil {
		t.Fatalf("decode facets: %v (raw: %s)", err, text)
	}
	// Empty DB → all facet slices should be non-nil (may be empty).
	if facets.Status == nil || facets.Tag == nil || facets.Project == nil || facets.Owner == nil {
		t.Fatal("facets response should have non-nil slices for all keys")
	}
}

func TestMCP_FlowsListFacets_WithData(t *testing.T) {
	h, p := newTestMCP(t)

	// Seed two flows with different owners and tags.
	p.db.Exec(`INSERT INTO flows (id, name, description, status, owner, tags, created_at, updated_at)
		VALUES ('fa1', 'flow a', '', 'active', 'alice', '["security","api"]', datetime('now'), datetime('now')),
		       ('fa2', 'flow b', '', 'draft',  'bob',   '["api"]',            datetime('now'), datetime('now'))`)

	resp := mcpCall(t, h, "flows_list_facets", map[string]any{})
	if mcpIsError(t, resp) {
		t.Fatalf("list_facets error: %s", mcpResultText(t, resp))
	}
	var facets FacetsResponse
	json.Unmarshal([]byte(mcpResultText(t, resp)), &facets)

	// Status facet should contain both 'active' and 'draft'.
	statusValues := make(map[string]bool)
	for _, fi := range facets.Status {
		statusValues[fi.Value] = true
	}
	if !statusValues["active"] || !statusValues["draft"] {
		t.Errorf("expected status facets to include active and draft, got %+v", facets.Status)
	}

	// Owner facet should contain alice and bob.
	ownerValues := make(map[string]bool)
	for _, fi := range facets.Owner {
		ownerValues[fi.Value] = true
	}
	if !ownerValues["alice"] || !ownerValues["bob"] {
		t.Errorf("expected owner facets to include alice and bob, got %+v", facets.Owner)
	}
}

// ── flows_update_step ─────────────────────────────────────────────────────────

func TestMCP_FlowsUpdateStep(t *testing.T) {
	h, p := newTestMCP(t)

	p.db.Exec(`INSERT INTO flows (id, name, description, status, owner, tags, created_at, updated_at)
		VALUES ('fupd', 'update-step flow', '', 'active', '', '[]', datetime('now'), datetime('now'))`)
	p.db.Exec(`INSERT INTO flow_steps (id, flow_id, project_slug, feature_id, position)
		VALUES ('upd-step-1', 'fupd', 'proj', 'feat1', 1)`)

	resp := mcpCall(t, h, "flows_update_step", map[string]any{
		"flow_id": "fupd", "step_id": "upd-step-1", "note": "reviewed",
	})
	if mcpIsError(t, resp) {
		t.Fatalf("update_step error: %s", mcpResultText(t, resp))
	}
	var step FlowStep
	if err := json.Unmarshal([]byte(mcpResultText(t, resp)), &step); err != nil {
		t.Fatalf("decode step: %v", err)
	}
	if step.Note != "reviewed" {
		t.Errorf("note=%q want 'reviewed'", step.Note)
	}
}

// ── flows_move_step ───────────────────────────────────────────────────────────

func TestMCP_FlowsMoveStep(t *testing.T) {
	h, p := newTestMCP(t)

	p.db.Exec(`INSERT INTO flows (id, name, description, status, owner, tags, created_at, updated_at)
		VALUES ('fmov', 'move flow', '', 'active', '', '[]', datetime('now'), datetime('now'))`)
	p.db.Exec(`INSERT INTO flow_steps (id, flow_id, project_slug, feature_id, position)
		VALUES ('m1', 'fmov', 'proj', 'f1', 0),
		       ('m2', 'fmov', 'proj', 'f2', 1)`)

	// Move m2 up (should swap positions with m1).
	resp := mcpCall(t, h, "flows_move_step", map[string]any{
		"flow_id": "fmov", "step_id": "m2", "direction": -1,
	})
	if mcpIsError(t, resp) {
		t.Fatalf("move_step error: %s", mcpResultText(t, resp))
	}

	// m2 should now be at position 0.
	var pos int
	p.db.QueryRow(`SELECT position FROM flow_steps WHERE id='m2'`).Scan(&pos)
	if pos != 0 {
		t.Errorf("expected m2 at position 0 after move-up, got %d", pos)
	}
}

// ── flows_set_steps round-trip ────────────────────────────────────────────────

func TestMCP_FlowsSetSteps(t *testing.T) {
	h, _ := newTestMCP(t)

	cr := mcpCall(t, h, "flows_create", map[string]any{"name": "set-steps flow"})
	var f Flow
	json.Unmarshal([]byte(mcpResultText(t, cr)), &f)

	// Use snake_case params (Fix #2).
	steps := []map[string]any{
		{"client_id": "c1", "project_slug": "proj", "feature_id": "feat1"},
		{"client_id": "c2", "project_slug": "proj", "feature_id": "feat2", "parent_client_id": "c1", "branch_condition": "if admin"},
	}
	resp := mcpCall(t, h, "flows_set_steps", map[string]any{
		"flow_id": f.ID,
		"steps":   steps,
	})
	if mcpIsError(t, resp) {
		t.Fatalf("set_steps error: %s", mcpResultText(t, resp))
	}

	// Verify the flow now has two steps.
	getResp := mcpCall(t, h, "flows_get", map[string]any{"flow_id": f.ID})
	if mcpIsError(t, getResp) {
		t.Fatalf("get after set_steps: %s", mcpResultText(t, getResp))
	}
	var got Flow
	json.Unmarshal([]byte(mcpResultText(t, getResp)), &got)
	if len(got.Steps) != 2 {
		t.Errorf("expected 2 steps after set_steps, got %d", len(got.Steps))
	}
	// Find the child step and verify branch condition.
	var child *FlowStep
	for i := range got.Steps {
		if got.Steps[i].BranchCondition == "if admin" {
			child = &got.Steps[i]
		}
	}
	if child == nil {
		t.Error("child step with branchCondition not found")
	}
}

// ── Fix #2: snake_case params accepted by flows_add_step ─────────────────────

func TestMCP_FlowsSnakeCase_AddStep(t *testing.T) {
	h, _ := newTestMCP(t)

	cr := mcpCall(t, h, "flows_create", map[string]any{"name": "snake-case test"})
	var f Flow
	json.Unmarshal([]byte(mcpResultText(t, cr)), &f)

	// Use snake_case params — should succeed (step tombstoned since project not registered).
	resp := mcpCall(t, h, "flows_add_step", map[string]any{
		"flow_id":      f.ID,
		"project_slug": "some-project",
		"feature_id":   "feat-abc",
	})
	// The handler processes it (step inserted); isError=false even if tombstoned.
	if mcpIsError(t, resp) {
		t.Fatalf("add_step with snake_case params returned error: %s", mcpResultText(t, resp))
	}
	var s FlowStep
	if err := json.Unmarshal([]byte(mcpResultText(t, resp)), &s); err != nil {
		t.Fatalf("decode step: %v", err)
	}
	if s.ID == "" {
		t.Fatal("step id must be set")
	}
	// Step should be tombstoned with reason (project not registered in test env).
	if !s.Tombstoned {
		t.Error("step should be tombstoned when project not registered")
	}
	if s.TombstonedReason != "project_not_registered" {
		t.Errorf("tombstonedReason=%q want project_not_registered", s.TombstonedReason)
	}
}

// ── Fix #3: flows_set_steps returns stepIds map ───────────────────────────────

func TestMCP_FlowsSetSteps_ReturnsStepIds(t *testing.T) {
	h, _ := newTestMCP(t)

	cr := mcpCall(t, h, "flows_create", map[string]any{"name": "stepids flow"})
	var f Flow
	json.Unmarshal([]byte(mcpResultText(t, cr)), &f)

	steps := []map[string]any{
		{"client_id": "root", "project_slug": "proj", "feature_id": "f1"},
		{"client_id": "leaf", "project_slug": "proj", "feature_id": "f2", "parent_client_id": "root"},
	}
	resp := mcpCall(t, h, "flows_set_steps", map[string]any{
		"flow_id": f.ID,
		"steps":   steps,
	})
	if mcpIsError(t, resp) {
		t.Fatalf("set_steps error: %s", mcpResultText(t, resp))
	}

	var result struct {
		Flow    Flow              `json:"flow"`
		StepIds map[string]string `json:"stepIds"`
	}
	if err := json.Unmarshal([]byte(mcpResultText(t, resp)), &result); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if len(result.Flow.Steps) != 2 {
		t.Errorf("flow.steps=%d want 2", len(result.Flow.Steps))
	}
	if result.StepIds == nil {
		t.Fatal("stepIds must be present")
	}
	if _, ok := result.StepIds["root"]; !ok {
		t.Error("stepIds must contain 'root'")
	}
	if _, ok := result.StepIds["leaf"]; !ok {
		t.Error("stepIds must contain 'leaf'")
	}
}

// ── Fix #8: baseline_id='latest' shortcut ────────────────────────────────────

func TestMCP_FlowsGet_Baseline_Latest_Shortcut(t *testing.T) {
	h, p := newTestMCP(t)

	p.db.Exec(`INSERT INTO flows (id, name, description, status, owner, tags, created_at, updated_at)
		VALUES ('fbl', 'baseline flow', '', 'active', '', '[]', datetime('now'), datetime('now'))`)
	p.db.Exec(`INSERT INTO flow_baselines (id, flow_id, seq, reviewer, summary, created_at, snapshot)
		VALUES ('bfirst', 'fbl', 1, '', 'first', datetime('now'), '{"flow":{"id":"fbl","tags":[]},"steps":[],"links":[]}'),
		       ('blatest', 'fbl', 2, '', 'latest', datetime('now'), '{"flow":{"id":"fbl","tags":[]},"steps":[],"links":[]}')`)

	resp := mcpCall(t, h, "flows_get_baseline", map[string]any{
		"flow_id":     "fbl",
		"baseline_id": "latest",
	})
	if mcpIsError(t, resp) {
		t.Fatalf("get_baseline latest error: %s", mcpResultText(t, resp))
	}
	var b FlowBaseline
	if err := json.Unmarshal([]byte(mcpResultText(t, resp)), &b); err != nil {
		t.Fatalf("decode baseline: %v", err)
	}
	// Should return the highest seq (blatest).
	if b.ID != "blatest" {
		t.Errorf("expected latest baseline (blatest), got %s", b.ID)
	}
}
