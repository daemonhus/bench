package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

// newTestPlatform creates a Platform backed by a temp-dir SQLite DB and
// returns the Platform and a test mux wired to all flows + flow-views routes.
func newTestPlatform(t *testing.T) (*Platform, http.Handler) {
	t.Helper()
	p, err := NewPlatform(t.TempDir())
	if err != nil {
		t.Fatalf("NewPlatform: %v", err)
	}
	t.Cleanup(p.Close)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/flows/facets", p.listFlowFacets)
	mux.HandleFunc("GET /api/flows", p.listFlows)
	mux.HandleFunc("POST /api/flows", p.createFlow)
	mux.HandleFunc("GET /api/flows/{id}", p.getFlow)
	mux.HandleFunc("PATCH /api/flows/{id}", p.updateFlow)
	mux.HandleFunc("DELETE /api/flows/{id}", p.deleteFlow)
	mux.HandleFunc("POST /api/flows/{id}/steps", p.addFlowStep)
	mux.HandleFunc("PATCH /api/flows/{id}/steps/{stepId}", p.updateFlowStep)
	mux.HandleFunc("DELETE /api/flows/{id}/steps/{stepId}", p.removeFlowStep)
	mux.HandleFunc("PUT /api/flows/{id}/steps", p.setFlowSteps)
	mux.HandleFunc("POST /api/flows/{id}/steps/{stepId}/move", p.moveFlowStep)
	mux.HandleFunc("PUT /api/flows/{id}/links/{fromId}/{toId}", p.setFlowLink)
	mux.HandleFunc("DELETE /api/flows/{id}/links/{fromId}/{toId}", p.deleteFlowLink)
	mux.HandleFunc("GET /api/flow-views", p.listFlowViews)
	mux.HandleFunc("POST /api/flow-views", p.createFlowView)
	mux.HandleFunc("PATCH /api/flow-views/{id}", p.updateFlowView)
	mux.HandleFunc("DELETE /api/flow-views/{id}", p.deleteFlowView)
	p.registerFolderRoutes(mux)
	// Findings route
	mux.HandleFunc("GET /api/flows/{id}/findings", p.listFlowFindings)
	// Baseline routes
	mux.HandleFunc("GET /api/flows/{id}/baselines", p.listFlowBaselines)
	mux.HandleFunc("POST /api/flows/{id}/baselines", p.createFlowBaseline)
	mux.HandleFunc("GET /api/flows/{id}/baselines/latest", p.latestFlowBaseline)
	mux.HandleFunc("GET /api/flows/{id}/baselines/{bId}", p.getFlowBaseline)
	mux.HandleFunc("DELETE /api/flows/{id}/baselines/{bId}", p.deleteFlowBaseline)
	mux.HandleFunc("GET /api/flows/{id}/delta", p.getFlowDelta)
	return p, mux
}

func do(t *testing.T, h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if body != "" {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	} else {
		req = httptest.NewRequest(method, path, nil)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

func mustDecode[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.NewDecoder(w.Body).Decode(&v); err != nil {
		t.Fatalf("decode response: %v (body: %s)", err, w.Body.String())
	}
	return v
}

// createTestFlow is a test helper that POSTs a flow and returns the decoded Flow.
func createTestFlow(t *testing.T, h http.Handler, name, status string) Flow {
	t.Helper()
	body := fmt.Sprintf(`{"name":%q,"status":%q}`, name, status)
	w := do(t, h, "POST", "/api/flows", body)
	if w.Code != 201 {
		t.Fatalf("create flow %q: status=%d body=%s", name, w.Code, w.Body.String())
	}
	return mustDecode[Flow](t, w)
}

// addTestStep adds a step to a flow and returns the decoded FlowStep.
func addTestStep(t *testing.T, h http.Handler, flowID, slug, featureID string) FlowStep {
	t.Helper()
	body := fmt.Sprintf(`{"projectSlug":%q,"featureId":%q}`, slug, featureID)
	w := do(t, h, "POST", "/api/flows/"+flowID+"/steps", body)
	if w.Code != 201 {
		t.Fatalf("add step: status=%d body=%s", w.Code, w.Body.String())
	}
	return mustDecode[FlowStep](t, w)
}

// ── Flow CRUD ─────────────────────────────────────────────────────────────────

func TestFlows_ListEmpty(t *testing.T) {
	_, h := newTestPlatform(t)
	w := do(t, h, "GET", "/api/flows", "")
	if w.Code != 200 {
		t.Fatalf("status=%d", w.Code)
	}
	page := mustDecode[FlowsPage](t, w)
	if page.Total != 0 || len(page.Items) != 0 {
		t.Errorf("want empty page, got total=%d items=%d", page.Total, len(page.Items))
	}
}

func TestFlows_Create(t *testing.T) {
	_, h := newTestPlatform(t)

	w := do(t, h, "POST", "/api/flows", `{"name":"Auth flow","owner":"alice","tags":["auth"]}`)
	if w.Code != 201 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	f := mustDecode[Flow](t, w)
	if f.ID == "" {
		t.Error("id not set")
	}
	if f.Name != "Auth flow" {
		t.Errorf("name=%q want Auth flow", f.Name)
	}
	if f.Status != "draft" {
		t.Errorf("default status=%q want draft", f.Status)
	}
	if f.Owner != "alice" {
		t.Errorf("owner=%q want alice", f.Owner)
	}
	if len(f.Tags) != 1 || f.Tags[0] != "auth" {
		t.Errorf("tags=%v want [auth]", f.Tags)
	}
}

func TestFlows_CreateMissingName(t *testing.T) {
	_, h := newTestPlatform(t)
	w := do(t, h, "POST", "/api/flows", `{"description":"no name"}`)
	if w.Code != 400 {
		t.Fatalf("status=%d want 400", w.Code)
	}
}

func TestFlows_GetNotFound(t *testing.T) {
	_, h := newTestPlatform(t)
	w := do(t, h, "GET", "/api/flows/nonexistent", "")
	if w.Code != 404 {
		t.Fatalf("status=%d want 404", w.Code)
	}
}

func TestFlows_Update(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "Original", "draft")

	w := do(t, h, "PATCH", "/api/flows/"+f.ID, `{"name":"Renamed","status":"active","tags":["billing"]}`)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	updated := mustDecode[Flow](t, w)
	if updated.Name != "Renamed" {
		t.Errorf("name=%q want Renamed", updated.Name)
	}
	if updated.Status != "active" {
		t.Errorf("status=%q want active", updated.Status)
	}
	if len(updated.Tags) != 1 || updated.Tags[0] != "billing" {
		t.Errorf("tags=%v want [billing]", updated.Tags)
	}
}

func TestFlows_UpdateNotFound(t *testing.T) {
	_, h := newTestPlatform(t)
	w := do(t, h, "PATCH", "/api/flows/ghost", `{"name":"x"}`)
	if w.Code != 404 {
		t.Fatalf("status=%d want 404", w.Code)
	}
}

func TestFlows_Delete(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "ToDelete", "draft")

	w := do(t, h, "DELETE", "/api/flows/"+f.ID, "")
	if w.Code != 204 {
		t.Fatalf("status=%d want 204", w.Code)
	}
	w2 := do(t, h, "GET", "/api/flows/"+f.ID, "")
	if w2.Code != 404 {
		t.Fatalf("after delete get status=%d want 404", w2.Code)
	}
}

func TestFlows_DeleteNotFound(t *testing.T) {
	_, h := newTestPlatform(t)
	w := do(t, h, "DELETE", "/api/flows/ghost", "")
	if w.Code != 404 {
		t.Fatalf("status=%d want 404", w.Code)
	}
}

// ── List filtering and pagination ─────────────────────────────────────────────

func TestFlows_ListFilterByStatus(t *testing.T) {
	_, h := newTestPlatform(t)
	createTestFlow(t, h, "Draft flow", "draft")
	createTestFlow(t, h, "Active flow", "active")

	w := do(t, h, "GET", "/api/flows?status=active", "")
	page := mustDecode[FlowsPage](t, w)
	if page.Total != 1 {
		t.Fatalf("total=%d want 1", page.Total)
	}
	if page.Items[0].Name != "Active flow" {
		t.Errorf("item=%q want Active flow", page.Items[0].Name)
	}
}

func TestFlows_ListFilterByTag(t *testing.T) {
	_, h := newTestPlatform(t)
	do(t, h, "POST", "/api/flows", `{"name":"Auth","tags":["auth"]}`)
	do(t, h, "POST", "/api/flows", `{"name":"Billing","tags":["billing"]}`)

	w := do(t, h, "GET", "/api/flows?tag=billing", "")
	page := mustDecode[FlowsPage](t, w)
	if page.Total != 1 || page.Items[0].Name != "Billing" {
		t.Errorf("unexpected page: %+v", page)
	}
}

func TestFlows_Pagination(t *testing.T) {
	_, h := newTestPlatform(t)
	for i := range 5 {
		createTestFlow(t, h, fmt.Sprintf("Flow %d", i), "draft")
	}

	w := do(t, h, "GET", "/api/flows?limit=2&offset=0", "")
	page := mustDecode[FlowsPage](t, w)
	if page.Total != 5 {
		t.Errorf("total=%d want 5", page.Total)
	}
	if len(page.Items) != 2 {
		t.Errorf("items=%d want 2", len(page.Items))
	}
	if page.Limit != 2 || page.Offset != 0 {
		t.Errorf("limit=%d offset=%d", page.Limit, page.Offset)
	}

	w2 := do(t, h, "GET", "/api/flows?limit=2&offset=4", "")
	page2 := mustDecode[FlowsPage](t, w2)
	if len(page2.Items) != 1 {
		t.Errorf("last page items=%d want 1", len(page2.Items))
	}
}

func TestFlows_FTSSearch(t *testing.T) {
	_, h := newTestPlatform(t)
	do(t, h, "POST", "/api/flows", `{"name":"JWT refresh","description":"handles token refresh"}`)
	do(t, h, "POST", "/api/flows", `{"name":"Password reset","description":"email OTP"}`)

	w := do(t, h, "GET", "/api/flows?q=token", "")
	page := mustDecode[FlowsPage](t, w)
	if page.Total != 1 {
		t.Fatalf("FTS q=token: total=%d want 1", page.Total)
	}
	if page.Items[0].Name != "JWT refresh" {
		t.Errorf("FTS result=%q want JWT refresh", page.Items[0].Name)
	}
}

// ── Facets ────────────────────────────────────────────────────────────────────

func TestFlows_Facets(t *testing.T) {
	_, h := newTestPlatform(t)
	do(t, h, "POST", "/api/flows", `{"name":"A","status":"active","owner":"alice","tags":["auth"]}`)
	do(t, h, "POST", "/api/flows", `{"name":"B","status":"active","owner":"bob","tags":["auth","billing"]}`)
	do(t, h, "POST", "/api/flows", `{"name":"C","status":"archived","owner":"alice","tags":[]}`)

	w := do(t, h, "GET", "/api/flows/facets", "")
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var resp FacetsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Status) == 0 {
		t.Error("status facets empty")
	}
	if len(resp.Owner) == 0 {
		t.Error("owner facets empty")
	}
	if len(resp.Tag) == 0 {
		t.Error("tag facets empty")
	}
}

// ── Steps ─────────────────────────────────────────────────────────────────────

func TestFlows_StepAdd(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "Flow", "draft")

	s := addTestStep(t, h, f.ID, "proj-a", "feat-1")
	if s.ID == "" {
		t.Error("step id not set")
	}
	if s.ProjectSlug != "proj-a" || s.FeatureID != "feat-1" {
		t.Errorf("step=%+v", s)
	}
	if s.Position != 0 {
		t.Errorf("first step position=%d want 0", s.Position)
	}
}

func TestFlows_StepAddMissingFields(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "Flow", "draft")
	w := do(t, h, "POST", "/api/flows/"+f.ID+"/steps", `{"projectSlug":"x"}`)
	if w.Code != 400 {
		t.Fatalf("status=%d want 400", w.Code)
	}
}

func TestFlows_StepAddToUnknownFlow(t *testing.T) {
	_, h := newTestPlatform(t)
	w := do(t, h, "POST", "/api/flows/ghost/steps", `{"projectSlug":"x","featureId":"y"}`)
	if w.Code != 404 {
		t.Fatalf("status=%d want 404", w.Code)
	}
}

func TestFlows_StepPositionIncrement(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "Flow", "draft")
	s0 := addTestStep(t, h, f.ID, "p", "f1")
	s1 := addTestStep(t, h, f.ID, "p", "f2")
	if s0.Position != 0 || s1.Position != 1 {
		t.Errorf("positions: s0=%d s1=%d", s0.Position, s1.Position)
	}
}

func TestFlows_StepUpdate(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "Flow", "draft")
	s := addTestStep(t, h, f.ID, "p", "feat-1")

	w := do(t, h, "PATCH", "/api/flows/"+f.ID+"/steps/"+s.ID, `{"note":"important","branchCondition":"if error"}`)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	updated := mustDecode[FlowStep](t, w)
	if updated.Note != "important" {
		t.Errorf("note=%q want important", updated.Note)
	}
	if updated.BranchCondition != "if error" {
		t.Errorf("branchCondition=%q want if error", updated.BranchCondition)
	}
}

func TestFlows_StepRemove(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "Flow", "draft")
	s := addTestStep(t, h, f.ID, "p", "f1")

	w := do(t, h, "DELETE", "/api/flows/"+f.ID+"/steps/"+s.ID, "")
	if w.Code != 204 {
		t.Fatalf("status=%d want 204", w.Code)
	}
}

func TestFlows_StepMove(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "Flow", "draft")
	addTestStep(t, h, f.ID, "p", "f1")
	s1 := addTestStep(t, h, f.ID, "p", "f2")

	// Move s1 up (dir=-1) → should swap positions with the first step
	w := do(t, h, "POST", "/api/flows/"+f.ID+"/steps/"+s1.ID+"/move?dir=-1", "")
	if w.Code != 200 {
		t.Fatalf("move status=%d body=%s", w.Code, w.Body.String())
	}
	moved := mustDecode[FlowStep](t, w)
	if moved.Position != 0 {
		t.Errorf("after move up, position=%d want 0", moved.Position)
	}
}

func TestFlows_StepMoveInvalidDir(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "Flow", "draft")
	s := addTestStep(t, h, f.ID, "p", "f1")
	w := do(t, h, "POST", "/api/flows/"+f.ID+"/steps/"+s.ID+"/move?dir=0", "")
	if w.Code != 400 {
		t.Fatalf("status=%d want 400", w.Code)
	}
}

func TestFlows_SetSteps(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "Flow", "draft")

	// setFlowSteps requires exactly one root (no parentClientId).
	body := `{
		"steps": [
			{"clientId":"c1","projectSlug":"p","featureId":"f1"},
			{"clientId":"c2","parentClientId":"c1","projectSlug":"p","featureId":"f2"},
			{"clientId":"c3","parentClientId":"c1","projectSlug":"p","featureId":"f3"}
		],
		"links": [
			{"fromClientId":"c2","toClientId":"c3"}
		]
	}`
	w := do(t, h, "PUT", "/api/flows/"+f.ID+"/steps", body)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	// Verify via GET (steps will be tombstoned because no workbench in tests, but count should be right)
	wg := do(t, h, "GET", "/api/flows/"+f.ID, "")
	got := mustDecode[Flow](t, wg)
	if len(got.Steps) != 3 {
		t.Errorf("steps=%d want 3", len(got.Steps))
	}
	if len(got.Links) != 1 {
		t.Errorf("links=%d want 1", len(got.Links))
	}
}

// ── Links ─────────────────────────────────────────────────────────────────────

func TestFlows_LinkSetAndDelete(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "Flow", "draft")
	s1 := addTestStep(t, h, f.ID, "p", "f1")
	s2 := addTestStep(t, h, f.ID, "p", "f2")

	// Set link with all fields
	linkPath := "/api/flows/" + f.ID + "/links/" + s1.ID + "/" + s2.ID
	w := do(t, h, "PUT", linkPath, `{"description":"on error","comment":"check auth first","tags":["auth","high-risk"]}`)
	if w.Code != 200 {
		t.Fatalf("set link status=%d body=%s", w.Code, w.Body.String())
	}
	lnk := mustDecode[FlowLink](t, w)
	if lnk.Description != "on error" {
		t.Errorf("description=%q want on error", lnk.Description)
	}
	if lnk.Comment != "check auth first" {
		t.Errorf("comment=%q want 'check auth first'", lnk.Comment)
	}
	if len(lnk.Tags) != 2 || lnk.Tags[0] != "auth" || lnk.Tags[1] != "high-risk" {
		t.Errorf("tags=%v want [auth high-risk]", lnk.Tags)
	}

	// Verify link fields are returned via getFlow
	wg := do(t, h, "GET", "/api/flows/"+f.ID, "")
	if wg.Code != 200 {
		t.Fatalf("get flow status=%d", wg.Code)
	}
	got := mustDecode[Flow](t, wg)
	if len(got.Links) != 1 {
		t.Fatalf("expected 1 link, got %d", len(got.Links))
	}
	if got.Links[0].Comment != "check auth first" {
		t.Errorf("round-trip comment=%q", got.Links[0].Comment)
	}
	if len(got.Links[0].Tags) != 2 {
		t.Errorf("round-trip tags=%v", got.Links[0].Tags)
	}

	// Delete link
	w2 := do(t, h, "DELETE", linkPath, "")
	if w2.Code != 204 {
		t.Fatalf("delete link status=%d want 204", w2.Code)
	}

	// Delete again → 404
	w3 := do(t, h, "DELETE", linkPath, "")
	if w3.Code != 404 {
		t.Fatalf("second delete status=%d want 404", w3.Code)
	}
}

func TestFlows_LinkOnUnknownFlow(t *testing.T) {
	_, h := newTestPlatform(t)
	w := do(t, h, "PUT", "/api/flows/ghost/links/a/b", `{}`)
	if w.Code != 404 {
		t.Fatalf("status=%d want 404", w.Code)
	}
}

// ── Flow views ────────────────────────────────────────────────────────────────

func TestFlowViews_CRUD(t *testing.T) {
	_, h := newTestPlatform(t)

	// Create
	w := do(t, h, "POST", "/api/flow-views", `{"name":"My view","owner":"alice","query":"status=active"}`)
	if w.Code != 201 {
		t.Fatalf("create status=%d body=%s", w.Code, w.Body.String())
	}
	var created map[string]any
	json.NewDecoder(w.Body).Decode(&created)
	id, _ := created["id"].(string)
	if id == "" {
		t.Fatal("view id not set")
	}

	// List
	wl := do(t, h, "GET", "/api/flow-views", "")
	var list []map[string]any
	json.NewDecoder(wl.Body).Decode(&list)
	if len(list) != 1 {
		t.Fatalf("list len=%d want 1", len(list))
	}

	// Update
	wu := do(t, h, "PATCH", "/api/flow-views/"+id, `{"name":"Renamed"}`)
	if wu.Code != 200 {
		t.Fatalf("update status=%d body=%s", wu.Code, wu.Body.String())
	}
	var updMap map[string]any
	json.NewDecoder(wu.Body).Decode(&updMap)
	if updMap["name"] != "Renamed" {
		t.Errorf("name=%v want Renamed", updMap["name"])
	}

	// Delete
	wd := do(t, h, "DELETE", "/api/flow-views/"+id, "")
	if wd.Code != 204 {
		t.Fatalf("delete status=%d want 204", wd.Code)
	}
	wl2 := do(t, h, "GET", "/api/flow-views", "")
	var list2 []map[string]any
	json.NewDecoder(wl2.Body).Decode(&list2)
	if len(list2) != 0 {
		t.Errorf("after delete list len=%d want 0", len(list2))
	}
}

// ── Route parity ─────────────────────────────────────────────────────────────

// TestFlowsRouteParity verifies that every flows CLI command has a registered
// route. Analogous to bench's parity_test.go.
func TestFlowsRouteParity(t *testing.T) {
	_, h := newTestPlatform(t)

	routes := []struct {
		method string
		path   string
		body   string
	}{
		{"GET", "/api/flows", ""},
		{"POST", "/api/flows", `{"name":"x"}`},
		{"GET", "/api/flows/test-id", ""},
		{"PATCH", "/api/flows/test-id", `{}`},
		{"DELETE", "/api/flows/test-id", ""},
		{"GET", "/api/flows/facets", ""},
		{"POST", "/api/flows/test-id/steps", `{"projectSlug":"p","featureId":"f"}`},
		{"PATCH", "/api/flows/test-id/steps/step-id", `{}`},
		{"DELETE", "/api/flows/test-id/steps/step-id", ""},
		{"PUT", "/api/flows/test-id/steps", `{"steps":[]}`},
		{"POST", "/api/flows/test-id/steps/step-id/move", ""},
		{"PUT", "/api/flows/test-id/links/from-id/to-id", `{}`},
		{"DELETE", "/api/flows/test-id/links/from-id/to-id", ""},
		{"GET", "/api/flow-views", ""},
		{"POST", "/api/flow-views", `{"name":"v"}`},
		{"PATCH", "/api/flow-views/view-id", `{}`},
		{"DELETE", "/api/flow-views/view-id", ""},
		{"GET", "/api/flows/test-id/findings", ""},
		{"GET", "/api/flows/test-id/baselines", ""},
		{"POST", "/api/flows/test-id/baselines", `{}`},
		{"GET", "/api/flows/test-id/baselines/latest", ""},
		{"GET", "/api/flows/test-id/baselines/b-id", ""},
		{"DELETE", "/api/flows/test-id/baselines/b-id", ""},
		{"GET", "/api/flows/test-id/delta", ""},
	}

	for _, r := range routes {
		t.Run(r.method+" "+r.path, func(t *testing.T) {
			w := do(t, h, r.method, r.path, r.body)
			// Go's default mux returns "404 page not found\n" when no route matches.
			if w.Code == 404 && w.Body.String() == "404 page not found\n" {
				t.Errorf("route not registered: %s %s", r.method, r.path)
			}
		})
	}
}

// ── Flow Baselines ────────────────────────────────────────────────────────────

func TestFlowBaselines_EmptyList(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "auth flow", "active")

	w := do(t, h, "GET", "/api/flows/"+f.ID+"/baselines", "")
	if w.Code != 200 {
		t.Fatalf("list baselines: %d %s", w.Code, w.Body.String())
	}
	var list []FlowBaseline
	mustDecode[[]FlowBaseline](t, w)
	if list != nil && len(list) != 0 {
		t.Fatalf("expected empty list, got %d items", len(list))
	}
}

func TestFlowBaselines_CreateAndList(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "auth flow", "active")

	// Create baseline with reviewer + summary.
	w := do(t, h, "POST", "/api/flows/"+f.ID+"/baselines",
		`{"reviewer":"alice","summary":"Q2 review"}`)
	if w.Code != 201 {
		t.Fatalf("create baseline: %d %s", w.Code, w.Body.String())
	}
	b := mustDecode[FlowBaseline](t, w)
	if b.ID == "" {
		t.Fatal("baseline id empty")
	}
	if b.Seq != 1 {
		t.Fatalf("expected seq=1, got %d", b.Seq)
	}
	if b.Reviewer != "alice" {
		t.Fatalf("expected reviewer=alice, got %q", b.Reviewer)
	}
	if b.Summary != "Q2 review" {
		t.Fatalf("expected summary, got %q", b.Summary)
	}
	if b.Snapshot.Flow.ID == "" {
		t.Fatal("snapshot should be populated")
	}

	// List should have one entry.
	w2 := do(t, h, "GET", "/api/flows/"+f.ID+"/baselines", "")
	list := mustDecode[[]FlowBaseline](t, w2)
	if len(list) != 1 {
		t.Fatalf("expected 1 baseline, got %d", len(list))
	}
}

func TestFlowBaselines_SeqIncrement(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "auth flow", "active")

	for i := 1; i <= 3; i++ {
		w := do(t, h, "POST", "/api/flows/"+f.ID+"/baselines", `{}`)
		b := mustDecode[FlowBaseline](t, w)
		if b.Seq != i {
			t.Fatalf("iteration %d: expected seq=%d, got %d", i, i, b.Seq)
		}
	}
}

func TestFlowBaselines_GetLatest(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "auth flow", "active")

	do(t, h, "POST", "/api/flows/"+f.ID+"/baselines", `{"summary":"first"}`)
	w := do(t, h, "POST", "/api/flows/"+f.ID+"/baselines", `{"summary":"second"}`)
	b2 := mustDecode[FlowBaseline](t, w)

	wl := do(t, h, "GET", "/api/flows/"+f.ID+"/baselines/latest", "")
	if wl.Code != 200 {
		t.Fatalf("get latest: %d %s", wl.Code, wl.Body.String())
	}
	latest := mustDecode[FlowBaseline](t, wl)
	if latest.ID != b2.ID {
		t.Fatalf("latest should be seq=2, got seq=%d id=%s", latest.Seq, latest.ID)
	}
}

func TestFlowBaselines_GetLatest404(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "auth flow", "active")

	w := do(t, h, "GET", "/api/flows/"+f.ID+"/baselines/latest", "")
	if w.Code != 404 {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestFlowBaselines_GetByID(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "auth flow", "active")

	w := do(t, h, "POST", "/api/flows/"+f.ID+"/baselines", `{"reviewer":"alice"}`)
	b := mustDecode[FlowBaseline](t, w)

	wg := do(t, h, "GET", "/api/flows/"+f.ID+"/baselines/"+b.ID, "")
	if wg.Code != 200 {
		t.Fatalf("get by id: %d %s", wg.Code, wg.Body.String())
	}
	got := mustDecode[FlowBaseline](t, wg)
	if got.Reviewer != "alice" {
		t.Fatalf("expected reviewer=alice, got %q", got.Reviewer)
	}
}

func TestFlowBaselines_DeleteDryRun(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "auth flow", "active")

	w := do(t, h, "POST", "/api/flows/"+f.ID+"/baselines", `{}`)
	b := mustDecode[FlowBaseline](t, w)

	// Dry-run (no ?confirm=true) — should not be 204.
	wd := do(t, h, "DELETE", "/api/flows/"+f.ID+"/baselines/"+b.ID, "")
	if wd.Code == 204 {
		t.Fatal("dry-run delete should not return 204")
	}
	if wd.Code != 200 {
		t.Fatalf("dry-run delete: expected 200 preview, got %d", wd.Code)
	}

	// Baseline should still exist.
	wl := do(t, h, "GET", "/api/flows/"+f.ID+"/baselines", "")
	list := mustDecode[[]FlowBaseline](t, wl)
	if len(list) != 1 {
		t.Fatalf("dry-run should not delete; expected 1 baseline, got %d", len(list))
	}
}

func TestFlowBaselines_DeleteConfirm(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "auth flow", "active")

	w := do(t, h, "POST", "/api/flows/"+f.ID+"/baselines", `{}`)
	b := mustDecode[FlowBaseline](t, w)

	wd := do(t, h, "DELETE", "/api/flows/"+f.ID+"/baselines/"+b.ID+"?confirm=true", "")
	if wd.Code != 204 {
		t.Fatalf("confirmed delete: expected 204, got %d %s", wd.Code, wd.Body.String())
	}

	wl := do(t, h, "GET", "/api/flows/"+f.ID+"/baselines", "")
	list := mustDecode[[]FlowBaseline](t, wl)
	if len(list) != 0 {
		t.Fatalf("expected 0 baselines after delete, got %d", len(list))
	}
}

func TestFlowBaselines_SnapshotPopulated(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "auth flow", "active")
	addTestStep(t, h, f.ID, "api-service", "feat-1")
	addTestStep(t, h, f.ID, "api-service", "feat-2")

	w := do(t, h, "POST", "/api/flows/"+f.ID+"/baselines", `{}`)
	b := mustDecode[FlowBaseline](t, w)

	snap := b.Snapshot
	if snap.Flow.ID == "" {
		t.Fatal("snapshot nil after create")
	}
	if snap.Flow.ID != f.ID {
		t.Fatalf("snapshot flow id mismatch: %s", snap.Flow.ID)
	}
	if len(snap.Steps) != 2 {
		t.Fatalf("snapshot should have 2 steps, got %d", len(snap.Steps))
	}
}

func TestFlowBaselines_Delta_NoBaseline(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "auth flow", "active")

	w := do(t, h, "GET", "/api/flows/"+f.ID+"/delta", "")
	if w.Code != 404 {
		t.Fatalf("delta with no baseline: expected 404, got %d", w.Code)
	}
}

func TestFlowBaselines_Delta_AddStep(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "auth flow", "active")

	// Baseline with one step.
	addTestStep(t, h, f.ID, "api-service", "feat-1")
	wb := do(t, h, "POST", "/api/flows/"+f.ID+"/baselines", `{}`)
	b := mustDecode[FlowBaseline](t, wb)

	// Add another step after baseline.
	addTestStep(t, h, f.ID, "api-service", "feat-2")

	wd := do(t, h, "GET", "/api/flows/"+f.ID+"/delta?since="+b.ID, "")
	if wd.Code != 200 {
		t.Fatalf("delta: %d %s", wd.Code, wd.Body.String())
	}
	delta := mustDecode[FlowDelta](t, wd)
	if len(delta.AddedSteps) != 1 {
		t.Fatalf("expected 1 added step, got %d", len(delta.AddedSteps))
	}
	if len(delta.RemovedSteps) != 0 {
		t.Fatalf("expected 0 removed steps, got %d", len(delta.RemovedSteps))
	}
}

func TestFlowBaselines_Delta_RemoveStep(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "auth flow", "active")

	s1 := addTestStep(t, h, f.ID, "api-service", "feat-1")
	addTestStep(t, h, f.ID, "api-service", "feat-2")

	wb := do(t, h, "POST", "/api/flows/"+f.ID+"/baselines", `{}`)
	b := mustDecode[FlowBaseline](t, wb)

	// Remove first step.
	do(t, h, "DELETE", "/api/flows/"+f.ID+"/steps/"+s1.ID, "")

	wd := do(t, h, "GET", "/api/flows/"+f.ID+"/delta?since="+b.ID, "")
	delta := mustDecode[FlowDelta](t, wd)
	if len(delta.RemovedSteps) != 1 {
		t.Fatalf("expected 1 removed step, got %d", len(delta.RemovedSteps))
	}
}

func TestFlowBaselines_ListFlows_BaselineFields(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "auth flow", "active")

	// Before any baseline: count should be 0, lastBaselinedAt empty.
	w := do(t, h, "GET", "/api/flows", "")
	page := mustDecode[FlowsPage](t, w)
	if len(page.Items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(page.Items))
	}
	item := page.Items[0]
	if item.BaselineCount != 0 {
		t.Fatalf("expected baselineCount=0 before baseline, got %d", item.BaselineCount)
	}

	// Create a baseline.
	do(t, h, "POST", "/api/flows/"+f.ID+"/baselines", `{}`)
	do(t, h, "POST", "/api/flows/"+f.ID+"/baselines", `{}`)

	w2 := do(t, h, "GET", "/api/flows", "")
	page2 := mustDecode[FlowsPage](t, w2)
	item2 := page2.Items[0]
	if item2.BaselineCount != 2 {
		t.Fatalf("expected baselineCount=2, got %d", item2.BaselineCount)
	}
	if item2.LastBaselinedAt == "" {
		t.Fatal("expected lastBaselinedAt to be set")
	}
}

// ── Flow Findings ─────────────────────────────────────────────────────────────

func TestFlowFindings_NoSteps(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "auth flow", "active")

	w := do(t, h, "GET", "/api/flows/"+f.ID+"/findings", "")
	if w.Code != 200 {
		t.Fatalf("findings: %d %s", w.Code, w.Body.String())
	}
	ff := mustDecode[FlowFindings](t, w)
	if ff.FlowID != f.ID {
		t.Fatalf("flowId mismatch: %s", ff.FlowID)
	}
	if ff.Total != 0 {
		t.Fatalf("expected 0 findings for flow with no steps, got %d", ff.Total)
	}
	if ff.BySev.Critical+ff.BySev.High+ff.BySev.Medium+ff.BySev.Low+ff.BySev.Info != 0 {
		t.Fatal("expected zero severity counts")
	}
}

func TestFlowFindings_StepsNoFeatures(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "auth flow", "active")
	// Add steps pointing to a project that doesn't exist in the test env.
	// fetchProjectFindings will return nil (no workbench), so findings should be empty.
	addTestStep(t, h, f.ID, "nonexistent-project", "feat-1")

	w := do(t, h, "GET", "/api/flows/"+f.ID+"/findings", "")
	if w.Code != 200 {
		t.Fatalf("findings: %d %s", w.Code, w.Body.String())
	}
	ff := mustDecode[FlowFindings](t, w)
	if ff.Total != 0 {
		t.Fatalf("expected 0 findings when project not registered, got %d", ff.Total)
	}
}

func TestFlowFindings_NotFound(t *testing.T) {
	_, h := newTestPlatform(t)
	w := do(t, h, "GET", "/api/flows/does-not-exist/findings", "")
	if w.Code != 404 {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestFlowFindings_FindingsFieldPresent(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "auth flow", "active")

	w := do(t, h, "GET", "/api/flows/"+f.ID+"/findings", "")
	ff := mustDecode[FlowFindings](t, w)
	// findings array must always be present (never null).
	if ff.Findings == nil {
		t.Fatal("findings array should be non-nil")
	}
}

// ── Validation edge cases ──────────────────────────────────────────────────────

func TestFlows_CreateInvalidStatus(t *testing.T) {
	_, h := newTestPlatform(t)
	w := do(t, h, "POST", "/api/flows", `{"name":"bad","status":"unknown"}`)
	if w.Code != 400 {
		t.Fatalf("expected 400 for invalid status, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestFlows_UpdateInvalidStatus(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "flow", "draft")
	w := do(t, h, "PATCH", "/api/flows/"+f.ID, `{"status":"deleted"}`)
	if w.Code != 400 {
		t.Fatalf("expected 400 for invalid status, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestFlows_AddStep_InvalidParent(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "flow", "draft")
	w := do(t, h, "POST", "/api/flows/"+f.ID+"/steps",
		`{"projectSlug":"p","featureId":"f1","parentStepId":"does-not-exist"}`)
	if w.Code != 400 {
		t.Fatalf("expected 400 for unknown parentStepId, got %d body=%s", w.Code, w.Body.String())
	}
}

// ── Fix #1: links always present ──────────────────────────────────────────────

func TestFlows_Get_LinksAlwaysPresent(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "flow", "draft")

	// GET on a flow with no explicit links must include "links" key as an array.
	w := do(t, h, "GET", "/api/flows/"+f.ID, "")
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	// Decode as raw map to verify the key is present.
	var raw map[string]json.RawMessage
	if err := json.NewDecoder(w.Body).Decode(&raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
	linksRaw, ok := raw["links"]
	if !ok {
		t.Fatal("links key must always be present in flows_get response")
	}
	var links []any
	if err := json.Unmarshal(linksRaw, &links); err != nil {
		t.Fatalf("links must be an array, got: %s", linksRaw)
	}
	if len(links) != 0 {
		t.Errorf("expected empty links array, got %d", len(links))
	}
}

// ── Fix #3: setFlowSteps returns stepIds ─────────────────────────────────────

func TestFlows_SetSteps_ReturnsStepIds(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "flow", "draft")

	body := `{
		"steps": [
			{"clientId":"root","projectSlug":"p","featureId":"f1"},
			{"clientId":"child","parentClientId":"root","projectSlug":"p","featureId":"f2"}
		]
	}`
	w := do(t, h, "PUT", "/api/flows/"+f.ID+"/steps", body)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}

	var resp struct {
		Flow    Flow              `json:"flow"`
		StepIds map[string]string `json:"stepIds"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Flow.Steps) != 2 {
		t.Errorf("flow.steps=%d want 2", len(resp.Flow.Steps))
	}
	if resp.StepIds == nil {
		t.Fatal("stepIds must be present in response")
	}
	if _, ok := resp.StepIds["root"]; !ok {
		t.Error("stepIds must contain 'root'")
	}
	if _, ok := resp.StepIds["child"]; !ok {
		t.Error("stepIds must contain 'child'")
	}
	// Server IDs must be non-empty hex strings.
	for cid, sid := range resp.StepIds {
		if sid == "" {
			t.Errorf("stepIds[%q] is empty", cid)
		}
		if sid == cid {
			t.Errorf("stepIds[%q]=%q should be a server-assigned ID, not the clientId", cid, sid)
		}
	}
}

// ── Fix #4: tombstonedReason on addFlowStep ───────────────────────────────────

func TestFlows_AddStep_TombstoneReason_ProjectNotRegistered(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "flow", "draft")

	// Project "missing-project" is not registered; step should be tombstoned with reason.
	w := do(t, h, "POST", "/api/flows/"+f.ID+"/steps",
		`{"projectSlug":"missing-project","featureId":"feat-1"}`)
	if w.Code != 201 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	s := mustDecode[FlowStep](t, w)
	if !s.Tombstoned {
		t.Error("step should be tombstoned when project is not registered")
	}
	if s.TombstonedReason != "project_not_registered" {
		t.Errorf("tombstonedReason=%q want project_not_registered", s.TombstonedReason)
	}
}

// ── Fix #5: sinceBaseline always populated in delta ───────────────────────────

func TestFlowBaselines_Delta_HasBaseline_NoChanges(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "flow", "draft")

	// Capture baseline before any changes.
	wb := do(t, h, "POST", "/api/flows/"+f.ID+"/baselines", `{}`)
	b := mustDecode[FlowBaseline](t, wb)

	// Delta with no changes — since must be populated with the baseline ID.
	wd := do(t, h, "GET", "/api/flows/"+f.ID+"/delta", "")
	if wd.Code != 200 {
		t.Fatalf("delta: %d %s", wd.Code, wd.Body.String())
	}
	delta := mustDecode[FlowDelta](t, wd)
	if delta.Since.ID == "" {
		t.Error("since.id must be populated when a baseline exists")
	}
	if delta.Since.ID != b.ID {
		t.Errorf("since.id=%q want %q", delta.Since.ID, b.ID)
	}
	if len(delta.AddedSteps) != 0 {
		t.Errorf("expected 0 added steps, got %d", len(delta.AddedSteps))
	}
}

// ── Tombstones clear when the feature resolves again ──────────────────────────

func TestFlows_Get_ClearsStaleTombstone(t *testing.T) {
	p, h := newTestPlatform(t)

	// A real repo + registered project so feature snapshots resolve.
	repo := t.TempDir()
	for _, args := range [][]string{
		{"git", "init", repo},
		{"git", "-C", repo, "config", "user.email", "t@t.com"},
		{"git", "-C", repo, "config", "user.name", "T"},
	} {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("%v: %v\n%s", args, err, out)
		}
	}
	if err := os.WriteFile(filepath.Join(repo, "a.go"), []byte("package a\n\nfunc A() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"git", "-C", repo, "add", "."}, {"git", "-C", repo, "commit", "-m", "init"}} {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("%v: %v\n%s", args, err, out)
		}
	}
	head, err := exec.Command("git", "-C", repo, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	commit := strings.TrimSpace(string(head))
	if _, err := p.db.Exec(`INSERT INTO projects (id, name, slug, repo_path) VALUES ('p1','proj','proj',?)`, repo); err != nil {
		t.Fatal(err)
	}
	wb, err := p.getWorkbench("proj")
	if err != nil {
		t.Fatalf("getWorkbench: %v", err)
	}
	wbDo := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		wb.Handler().ServeHTTP(w, req)
		return w
	}
	if w := wbDo("PATCH", "/api/profile", `{}`); w.Code != 200 {
		t.Fatalf("profile: %d %s", w.Code, w.Body.String())
	}
	feat := fmt.Sprintf(`{"anchor":{"fileId":"a.go","commitId":%q,"lineRange":{"start":3,"end":3}},"kind":"interface","title":"/a"}`, commit)
	w := wbDo("POST", "/api/features", feat)
	if w.Code != 201 {
		t.Fatalf("create feature: %d %s", w.Code, w.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	json.NewDecoder(w.Body).Decode(&created)

	flow := createTestFlow(t, h, "recover", "draft")
	good := addTestStep(t, h, flow.ID, "proj", created.ID)
	gone := addTestStep(t, h, flow.ID, "proj", "00000000-0000-0000-0000-000000000000")

	// Simulate stale state: the healthy step was tombstoned by an earlier orphaning.
	if _, err := p.db.Exec(`UPDATE flow_steps SET tombstoned=1, tombstoned_reason='feature_not_found' WHERE id=?`, good.ID); err != nil {
		t.Fatal(err)
	}

	got := mustDecode[Flow](t, do(t, h, "GET", "/api/flows/"+flow.ID, ""))
	for _, s := range got.Steps {
		switch s.ID {
		case good.ID:
			if s.Tombstoned || s.TombstonedReason != "" {
				t.Errorf("recovered step still tombstoned: %+v", s)
			}
		case gone.ID:
			if !s.Tombstoned {
				t.Errorf("step with missing feature must stay tombstoned")
			}
		}
	}
	var n int
	p.db.QueryRow(`SELECT tombstoned FROM flow_steps WHERE id=?`, good.ID).Scan(&n)
	if n != 0 {
		t.Errorf("tombstone not cleared in DB")
	}
}

// A flow with no steps still returns them as an empty array, like links.
func TestFlows_GetEmptyFlowHasStepsArray(t *testing.T) {
	_, h := newTestPlatform(t)
	f := mustDecode[Flow](t, do(t, h, "POST", "/api/flows", `{"name":"Empty"}`))
	body := do(t, h, "GET", "/api/flows/"+f.ID, "").Body.String()
	if !strings.Contains(body, `"steps":[]`) || !strings.Contains(body, `"links":[]`) {
		t.Errorf("body = %s", body)
	}
}
