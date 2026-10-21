package server

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// Flows are graphs: these tests drive every edit through the REST routes and read the result
// back as "a>b" edges named by feature id (in branch order per step), so each expectation
// reads like the flow it describes.

func edgesOf(t *testing.T, h http.Handler, flowID string) string {
	t.Helper()
	f := mustDecode[Flow](t, do(t, h, "GET", "/api/flows/"+flowID, ""))
	return describeEdges(f)
}

func describeEdges(f Flow) string {
	name := map[string]string{}
	for _, s := range f.Steps {
		name[s.ID] = s.FeatureID
	}
	edges := append([]FlowEdge{}, f.Edges...)
	sort.SliceStable(edges, func(i, j int) bool {
		a, b := name[edges[i].FromStepID], name[edges[j].FromStepID]
		if a != b {
			return a < b
		}
		return edges[i].Position < edges[j].Position
	})
	var out []string
	for _, e := range edges {
		s := name[e.FromStepID] + ">" + name[e.ToStepID]
		if e.Condition != "" {
			s += "[" + e.Condition + "]"
		}
		out = append(out, s)
	}
	return strings.Join(out, " ")
}

func stepsOf(t *testing.T, h http.Handler, flowID string) string {
	t.Helper()
	f := mustDecode[Flow](t, do(t, h, "GET", "/api/flows/"+flowID, ""))
	var names []string
	for _, s := range f.Steps {
		names = append(names, s.FeatureID)
	}
	return strings.Join(names, ",")
}

// addStep posts a step with extra JSON fields (placement, edge) and returns its id.
func addStep(t *testing.T, h http.Handler, flowID, feature, extra string) string {
	t.Helper()
	body := fmt.Sprintf(`{"projectSlug":"p","featureId":%q%s}`, feature, extra)
	w := do(t, h, "POST", "/api/flows/"+flowID+"/steps", body)
	if w.Code != 201 {
		t.Fatalf("add %s %s: %d %s", feature, extra, w.Code, w.Body.String())
	}
	return mustDecode[FlowStep](t, w).ID
}

// chain makes a flow of steps appended in order (a path) and returns it with the ids by name.
func chain(t *testing.T, h http.Handler, names ...string) (string, map[string]string) {
	t.Helper()
	f := createTestFlow(t, h, "chain", "draft")
	ids := map[string]string{}
	for _, n := range names {
		ids[n] = addStep(t, h, f.ID, n, "")
	}
	return f.ID, ids
}

func expectEdges(t *testing.T, h http.Handler, flowID, want string) {
	t.Helper()
	if got := edgesOf(t, h, flowID); got != want {
		t.Errorf("edges:\n got  %s\n want %s", got, want)
	}
}

// ── adding ────────────────────────────────────────────────────────────────────

func TestFlowGraph_AddAppendsToTheMainPath(t *testing.T) {
	_, h := newTestPlatform(t)
	f, _ := chain(t, h, "a", "b", "c")
	expectEdges(t, h, f, "a>b b>c")
}

func TestFlowGraph_AddPlacements(t *testing.T) {
	_, h := newTestPlatform(t)
	f, id := chain(t, h, "a", "b", "c")
	addStep(t, h, f, "x", fmt.Sprintf(`,"after":%q`, id["a"]))
	expectEdges(t, h, f, "a>x b>c x>b")
	addStep(t, h, f, "y", fmt.Sprintf(`,"before":%q`, id["c"]))
	expectEdges(t, h, f, "a>x b>y x>b y>c")
	addStep(t, h, f, "z", fmt.Sprintf(`,"from":%q,"condition":"if admin"`, id["a"]))
	expectEdges(t, h, f, "a>x a>z[if admin] b>y x>b y>c")
	// parentStepId + branchCondition are the tree-era spelling of from + condition.
	addStep(t, h, f, "w", fmt.Sprintf(`,"parentStepId":%q,"branchCondition":"else"`, id["a"]))
	expectEdges(t, h, f, "a>x a>z[if admin] a>w[else] b>y x>b y>c")
	addStep(t, h, f, "e", `,"entry":true`)
	expectEdges(t, h, f, "a>x a>z[if admin] a>w[else] b>y x>b y>c")
	if got := stepsOf(t, h, f); got != "a,b,c,x,y,z,w,e" {
		t.Errorf("step order = %s", got)
	}
}

func TestFlowGraph_AddCarriesEdgeProperties(t *testing.T) {
	_, h := newTestPlatform(t)
	f, id := chain(t, h, "a")
	addStep(t, h, f, "b", `,"actor":"service:billing","controls":["authn:mtls"],"edge":{"kind":"call","protocol":"grpc","auth":"mtls","trustBoundary":true,"data":"card token","tainted":true}`)
	got := mustDecode[Flow](t, do(t, h, "GET", "/api/flows/"+f, ""))
	if len(got.Edges) != 1 {
		t.Fatalf("edges = %+v", got.Edges)
	}
	e := got.Edges[0]
	if e.FromStepID != id["a"] || e.Kind != "call" || e.Protocol != "grpc" || e.Auth != "mtls" || !e.TrustBoundary || e.Data != "card token" || !e.Tainted {
		t.Errorf("edge = %+v", e)
	}
	if s := got.Steps[1]; s.Actor != "service:billing" || len(s.Controls) != 1 {
		t.Errorf("step = %+v", s)
	}
}

func TestFlowGraph_AddRejectsBadPlacement(t *testing.T) {
	_, h := newTestPlatform(t)
	f, id := chain(t, h, "a")
	for name, extra := range map[string]string{
		"two places":   fmt.Sprintf(`,"after":%q,"from":%q`, id["a"], id["a"]),
		"unknown step": `,"after":"nope"`,
		"bad kind":     `,"edge":{"kind":"teleport"}`,
	} {
		w := do(t, h, "POST", "/api/flows/"+f+"/steps", `{"projectSlug":"p","featureId":"x"`+extra+`}`)
		if w.Code != 400 {
			t.Errorf("%s: %d %s, want 400", name, w.Code, w.Body.String())
		}
	}
	if got := stepsOf(t, h, f); got != "a" {
		t.Errorf("a rejected add left steps behind: %s", got)
	}
}

// ── removing ──────────────────────────────────────────────────────────────────

func TestFlowGraph_RemoveMiddleKeepsTheRestOfThePath(t *testing.T) {
	_, h := newTestPlatform(t)
	f, id := chain(t, h, "a", "b", "c", "d")
	if w := do(t, h, "DELETE", "/api/flows/"+f+"/steps/"+id["b"], ""); w.Code != 204 {
		t.Fatalf("remove: %d", w.Code)
	}
	expectEdges(t, h, f, "a>c c>d")
	if got := stepsOf(t, h, f); got != "a,c,d" {
		t.Errorf("steps = %s", got)
	}
}

func TestFlowGraph_RemoveBranchHeadBridgesInItsSlot(t *testing.T) {
	_, h := newTestPlatform(t)
	f, id := chain(t, h, "a")
	b := addStep(t, h, f, "b", fmt.Sprintf(`,"from":%q,"condition":"if admin"`, id["a"]))
	addStep(t, h, f, "c", fmt.Sprintf(`,"from":%q,"condition":"else"`, id["a"]))
	addStep(t, h, f, "d", fmt.Sprintf(`,"after":%q`, b))
	expectEdges(t, h, f, "a>b[if admin] a>c[else] b>d")
	do(t, h, "DELETE", "/api/flows/"+f+"/steps/"+b, "")
	// d takes b's place among a's branches, with b's condition.
	expectEdges(t, h, f, "a>d[if admin] a>c[else]")
}

func TestFlowGraph_RemoveSubtreeKeepsStepsReachableAnotherWay(t *testing.T) {
	_, h := newTestPlatform(t)
	f, id := chain(t, h, "a", "b", "d")
	c := addStep(t, h, f, "c", fmt.Sprintf(`,"from":%q`, id["a"]))
	addStep(t, h, f, "e", fmt.Sprintf(`,"after":%q`, id["d"]))
	w := do(t, h, "DELETE", "/api/flows/"+f+"/steps/"+id["b"]+"?mode=subtree", "")
	if w.Code != 204 || w.Header().Get("X-Removed-Steps") != "3" {
		t.Fatalf("subtree remove: %d removed=%s", w.Code, w.Header().Get("X-Removed-Steps"))
	}
	expectEdges(t, h, f, "a>c")
	if got := stepsOf(t, h, f); got != "a,c" {
		t.Errorf("steps = %s", got)
	}

	// With a join from c into d, d (and what follows it) stays.
	f2, id2 := chain(t, h, "a", "b", "d", "e")
	c2 := addStep(t, h, f2, "c", fmt.Sprintf(`,"from":%q`, id2["a"]))
	if w := do(t, h, "PUT", "/api/flows/"+f2+"/edges/"+c2+"/"+id2["d"], `{}`); w.Code != 200 {
		t.Fatalf("join: %d", w.Code)
	}
	do(t, h, "DELETE", "/api/flows/"+f2+"/steps/"+id2["b"]+"?mode=subtree", "")
	expectEdges(t, h, f2, "a>c c>d d>e")
	_ = c
}

func TestFlowGraph_RemoveIsolateLeavesTheGap(t *testing.T) {
	_, h := newTestPlatform(t)
	f, id := chain(t, h, "a", "b", "c")
	do(t, h, "DELETE", "/api/flows/"+f+"/steps/"+id["b"]+"?mode=isolate", "")
	expectEdges(t, h, f, "")
	if w := do(t, h, "DELETE", "/api/flows/"+f+"/steps/"+id["a"]+"?mode=everything", ""); w.Code != 400 {
		t.Errorf("unknown mode: %d", w.Code)
	}
}

// ── moving ────────────────────────────────────────────────────────────────────

func moveStep(t *testing.T, h http.Handler, flowID, stepID, query, body string) {
	t.Helper()
	w := do(t, h, "POST", "/api/flows/"+flowID+"/steps/"+stepID+"/move"+query, body)
	if w.Code != 200 {
		t.Fatalf("move %s %s: %d %s", query, body, w.Code, w.Body.String())
	}
}

func TestFlowGraph_MoveAlongAPath(t *testing.T) {
	_, h := newTestPlatform(t)
	f, id := chain(t, h, "a", "b", "c")
	do(t, h, "PUT", "/api/flows/"+f+"/edges/"+id["a"]+"/"+id["b"], `{"kind":"call"}`)
	moveStep(t, h, f, id["c"], "?dir=-1", "")
	expectEdges(t, h, f, "a>c c>b")
	// The hop out of a keeps its properties: it now leads to c.
	got := mustDecode[Flow](t, do(t, h, "GET", "/api/flows/"+f, ""))
	for _, e := range got.Edges {
		if e.FromStepID == id["a"] && e.Kind != "call" {
			t.Errorf("first hop kind = %q, want call", e.Kind)
		}
	}
	moveStep(t, h, f, id["a"], "?dir=1", "")
	expectEdges(t, h, f, "a>b c>a")
	// At the ends of the path a step stays put.
	moveStep(t, h, f, id["c"], "?dir=-1", "")
	expectEdges(t, h, f, "a>b c>a")
	moveStep(t, h, f, id["b"], "", `{"dir":1}`)
	expectEdges(t, h, f, "a>b c>a")
}

func TestFlowGraph_MoveAmongBranchesAndEntries(t *testing.T) {
	_, h := newTestPlatform(t)
	f, id := chain(t, h, "a")
	addStep(t, h, f, "b", fmt.Sprintf(`,"from":%q,"condition":"one"`, id["a"]))
	c := addStep(t, h, f, "c", fmt.Sprintf(`,"from":%q,"condition":"two"`, id["a"]))
	moveStep(t, h, f, c, "?dir=-1", "")
	expectEdges(t, h, f, "a>c[two] a>b[one]")

	g := createTestFlow(t, h, "entries", "draft")
	addStep(t, h, g.ID, "x", `,"entry":true`)
	y := addStep(t, h, g.ID, "y", `,"entry":true`)
	moveStep(t, h, g.ID, y, "?dir=-1", "")
	if got := stepsOf(t, h, g.ID); got != "y,x" {
		t.Errorf("entries after move = %s", got)
	}
}

func TestFlowGraph_MoveToAPlaceReparents(t *testing.T) {
	_, h := newTestPlatform(t)
	f, id := chain(t, h, "a", "b", "c")
	d := addStep(t, h, f, "d", fmt.Sprintf(`,"from":%q`, id["a"]))
	moveStep(t, h, f, id["c"], "", fmt.Sprintf(`{"from":%q,"edge":{"condition":"retry"}}`, d))
	expectEdges(t, h, f, "a>b a>d d>c[retry]")
	// Taking d out bridges a -> c; with no condition of its own that edge keeps "retry".
	moveStep(t, h, f, d, "", fmt.Sprintf(`{"after":%q}`, id["b"]))
	expectEdges(t, h, f, "a>b a>c[retry] b>d")
	for name, body := range map[string]string{
		"self":    fmt.Sprintf(`{"after":%q}`, id["b"]),
		"unknown": `{"after":"nope"}`,
		"both":    fmt.Sprintf(`{"dir":1,"after":%q}`, id["a"]),
		"nothing": `{}`,
	} {
		w := do(t, h, "POST", "/api/flows/"+f+"/steps/"+id["b"]+"/move", body)
		if w.Code != 400 {
			t.Errorf("%s: %d %s, want 400", name, w.Code, w.Body.String())
		}
	}
	if w := do(t, h, "POST", "/api/flows/"+f+"/steps/"+id["b"]+"/move?dir=2", ""); w.Code != 400 {
		t.Errorf("dir=2: %d", w.Code)
	}
}

// ── updating ──────────────────────────────────────────────────────────────────

func TestFlowGraph_RepointKeepsThePlace(t *testing.T) {
	_, h := newTestPlatform(t)
	f, id := chain(t, h, "a", "b", "c")
	w := do(t, h, "PATCH", "/api/flows/"+f+"/steps/"+id["b"], `{"featureId":"b2","projectSlug":"q"}`)
	if w.Code != 200 {
		t.Fatalf("repoint: %d %s", w.Code, w.Body.String())
	}
	if s := mustDecode[FlowStep](t, w); s.FeatureID != "b2" || s.ProjectSlug != "q" {
		t.Errorf("repointed step = %+v", s)
	}
	expectEdges(t, h, f, "a>b2 b2>c")
	if w := do(t, h, "PATCH", "/api/flows/"+f+"/steps/"+id["b"], `{"parentStepId":"x"}`); w.Code != 400 {
		t.Errorf("patching parentStepId: %d, want 400 (it used to be ignored silently)", w.Code)
	}
	if w := do(t, h, "PATCH", "/api/flows/"+f+"/steps/"+id["b"], `{"featureId":""}`); w.Code != 400 {
		t.Errorf("empty feature: %d, want 400", w.Code)
	}
}

func TestFlowGraph_EdgePositionReordersBranches(t *testing.T) {
	_, h := newTestPlatform(t)
	f, id := chain(t, h, "a")
	addStep(t, h, f, "b", fmt.Sprintf(`,"from":%q`, id["a"]))
	addStep(t, h, f, "c", fmt.Sprintf(`,"from":%q`, id["a"]))
	d := addStep(t, h, f, "d", fmt.Sprintf(`,"from":%q`, id["a"]))
	do(t, h, "PUT", "/api/flows/"+f+"/edges/"+id["a"]+"/"+d, `{"position":0}`)
	expectEdges(t, h, f, "a>d a>b a>c")
	do(t, h, "PUT", "/api/flows/"+f+"/edges/"+id["a"]+"/"+d, `{"position":9}`)
	expectEdges(t, h, f, "a>b a>c a>d")
}

// ── whole graph ───────────────────────────────────────────────────────────────

func TestFlowGraph_SetStepsTakesLoopsAndJoins(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "F", "draft")
	body := `{"steps":[
		{"clientId":"1","projectSlug":"p","featureId":"login","actor":"anonymous"},
		{"clientId":"2","projectSlug":"p","featureId":"mfa","controls":["authn:totp"]},
		{"clientId":"3","projectSlug":"p","featureId":"session"}],
		"edges":[
		{"from":"1","to":"2","kind":"call","condition":"if mfa enrolled"},
		{"from":"1","to":"3","condition":"else"},
		{"from":"2","to":"3"},
		{"from":"2","to":"1","condition":"on failure","kind":"response"}]}`
	w := do(t, h, "PUT", "/api/flows/"+f.ID+"/steps", body)
	if w.Code != 200 {
		t.Fatalf("set steps: %d %s", w.Code, w.Body.String())
	}
	out := mustDecode[struct {
		Flow    Flow              `json:"flow"`
		StepIds map[string]string `json:"stepIds"`
	}](t, w)
	if len(out.StepIds) != 3 || describeEdges(out.Flow) != "login>mfa[if mfa enrolled] login>session[else] mfa>session mfa>login[on failure]" {
		t.Fatalf("set steps result: %v %s", out.StepIds, describeEdges(out.Flow))
	}
}

func TestFlowGraph_SetStepsValidates(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "F", "draft")
	step := `{"clientId":"%s","projectSlug":"p","featureId":"x"}`
	two := fmt.Sprintf(step, "a") + "," + fmt.Sprintf(step, "b")
	for name, body := range map[string]string{
		"self":      `{"steps":[` + two + `],"edges":[{"from":"a","to":"a"}]}`,
		"duplicate": `{"steps":[` + two + `],"edges":[{"from":"a","to":"b"},{"from":"a","to":"b"}]}`,
		"unknown":   `{"steps":[` + two + `],"edges":[{"from":"a","to":"zz"}]}`,
		"bad kind":  `{"steps":[` + two + `],"edges":[{"from":"a","to":"b","kind":"teleport"}]}`,
		"no id":     `{"steps":[{"projectSlug":"p","featureId":"x"}]}`,
		"dup id":    `{"steps":[` + fmt.Sprintf(step, "a") + "," + fmt.Sprintf(step, "a") + `]}`,
	} {
		if w := do(t, h, "PUT", "/api/flows/"+f.ID+"/steps", body); w.Code != 400 {
			t.Errorf("%s: %d %s, want 400", name, w.Code, w.Body.String())
		}
	}
}

// A parent cycle cut off from the root used to pass validation and then recurse without end
// while inserting (crashing the server). As a graph it is just a loop.
func TestFlowGraph_SetStepsDetachedParentCycleIsALoop(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "F", "draft")
	body := `{"steps":[
		{"clientId":"r","projectSlug":"p","featureId":"r"},
		{"clientId":"a","parentClientId":"b","projectSlug":"p","featureId":"a"},
		{"clientId":"b","parentClientId":"a","projectSlug":"p","featureId":"b"}]}`
	if w := do(t, h, "PUT", "/api/flows/"+f.ID+"/steps", body); w.Code != 200 {
		t.Fatalf("set steps: %d %s", w.Code, w.Body.String())
	}
	expectEdges(t, h, f.ID, "a>b b>a")
}

func TestFlowGraph_ExportRoundTrips(t *testing.T) {
	_, h := newTestPlatform(t)
	f, id := chain(t, h, "a", "b", "c")
	addStep(t, h, f, "d", fmt.Sprintf(`,"from":%q,"condition":"if admin","edge":{"kind":"call","auth":"user","tainted":true}`, id["a"]))
	do(t, h, "PATCH", "/api/flows/"+f+"/steps/"+id["b"], `{"actor":"user","controls":["csrf"],"note":"n"}`)
	w := do(t, h, "GET", "/api/flows/"+f+"/export", "")
	if w.Code != 200 {
		t.Fatalf("export: %d", w.Code)
	}
	export := w.Body.String()

	// Into a new flow (POST /api/flows with the graph) ...
	var doc map[string]any
	json.Unmarshal([]byte(export), &doc)
	doc["name"] = "copy"
	body, _ := json.Marshal(doc)
	cw := do(t, h, "POST", "/api/flows", string(body))
	if cw.Code != 201 {
		t.Fatalf("create from export: %d %s", cw.Code, cw.Body.String())
	}
	copied := mustDecode[Flow](t, cw)
	if describeEdges(copied) != edgesOf(t, h, f) {
		t.Errorf("copy edges %s, want %s", describeEdges(copied), edgesOf(t, h, f))
	}
	// ... and back over the original: the same document again.
	if w := do(t, h, "PUT", "/api/flows/"+f+"/steps", export); w.Code != 200 {
		t.Fatalf("set steps from export: %d %s", w.Code, w.Body.String())
	}
	again := mustDecode[flowExport](t, do(t, h, "GET", "/api/flows/"+copied.ID+"/export", ""))
	first := mustDecode[flowExport](t, do(t, h, "GET", "/api/flows/"+f+"/export", ""))
	strip := func(x flowExport) string {
		ids := map[string]string{}
		for _, s := range x.Steps {
			ids[s.ClientID] = s.FeatureID
		}
		for i := range x.Steps {
			x.Steps[i].ClientID = ""
		}
		for i := range x.Edges {
			x.Edges[i].From, x.Edges[i].To = ids[x.Edges[i].From], ids[x.Edges[i].To]
		}
		x.Name = ""
		b, _ := json.Marshal(x)
		return string(b)
	}
	if strip(again) != strip(first) {
		t.Errorf("round trip changed the flow:\n%s\n%s", strip(first), strip(again))
	}
}

// ── baselines ─────────────────────────────────────────────────────────────────

func TestFlowGraph_DeltaListsEdgeChanges(t *testing.T) {
	_, h := newTestPlatform(t)
	f, id := chain(t, h, "a", "b", "c")
	if w := do(t, h, "POST", "/api/flows/"+f+"/baselines", `{}`); w.Code != 201 {
		t.Fatalf("baseline: %d", w.Code)
	}
	do(t, h, "PUT", "/api/flows/"+f+"/edges/"+id["a"]+"/"+id["b"], `{"condition":"if admin","auth":"user"}`)
	do(t, h, "PATCH", "/api/flows/"+f+"/steps/"+id["b"], `{"actor":"admin"}`)
	do(t, h, "DELETE", "/api/flows/"+f+"/steps/"+id["c"], "")
	addStep(t, h, f, "d", fmt.Sprintf(`,"from":%q`, id["a"]))
	d := mustDecode[FlowDelta](t, do(t, h, "GET", "/api/flows/"+f+"/delta", ""))
	if len(d.AddedSteps) != 1 || len(d.RemovedSteps) != 1 || len(d.AddedEdges) != 1 || len(d.RemovedEdges) != 1 {
		t.Fatalf("delta = %+v", d)
	}
	if len(d.ChangedEdges) != 1 || strings.Join(d.ChangedEdges[0].Changes, ",") != "condition,auth" {
		t.Errorf("changed edges = %+v", d.ChangedEdges)
	}
	if len(d.ChangedSteps) != 1 || strings.Join(d.ChangedSteps[0].Changes, ",") != "actor" {
		t.Errorf("changed steps = %+v", d.ChangedSteps)
	}
}

// A baseline taken before flows were graphs stored the tree; it still diffs cleanly.
func TestFlowGraph_TreeEraBaselineStillDiffs(t *testing.T) {
	p, h := newTestPlatform(t)
	f, id := chain(t, h, "a", "b")
	c := addStep(t, h, f, "c", fmt.Sprintf(`,"from":%q,"condition":"if admin"`, id["a"]))
	old := fmt.Sprintf(`{"flow":{"id":%q,"name":"chain"},"steps":[
		{"id":%q,"position":0,"projectSlug":"p","featureId":"a"},
		{"id":%q,"parentStepId":%q,"position":0,"projectSlug":"p","featureId":"b"},
		{"id":%q,"parentStepId":%q,"position":1,"branchCondition":"if admin","projectSlug":"p","featureId":"c"}],
		"links":[{"fromStepId":%q,"toStepId":%q,"description":"also"}]}`,
		f, id["a"], id["b"], id["a"], c, id["a"], id["b"], c)
	if _, err := p.db.Exec(`INSERT INTO flow_baselines (id, flow_id, seq, snapshot) VALUES ('old', ?, 1, ?)`, f, old); err != nil {
		t.Fatal(err)
	}
	d := mustDecode[FlowDelta](t, do(t, h, "GET", "/api/flows/"+f+"/delta", ""))
	// The link b -> c is gone now; nothing else changed.
	if len(d.AddedEdges) != 0 || len(d.ChangedEdges) != 0 || len(d.RemovedEdges) != 1 || len(d.AddedSteps) != 0 || len(d.RemovedSteps) != 0 {
		t.Errorf("delta against a tree-era baseline = %+v", d)
	}
	b := mustDecode[FlowBaseline](t, do(t, h, "GET", "/api/flows/"+f+"/baselines/old", ""))
	if b.Snapshot.Version != snapshotVersion || len(b.Snapshot.Edges) != 3 {
		t.Errorf("old snapshot read as %+v", b.Snapshot)
	}
}

// ── migration ─────────────────────────────────────────────────────────────────

// treeEraDB writes a platform.db as it was before flows were graphs.
func treeEraDB(t *testing.T, dir string) {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(dir, "platform.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, stmt := range []string{
		`CREATE TABLE flows (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', owner TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
		`CREATE TABLE flow_steps (id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE, parent_step_id TEXT REFERENCES flow_steps(id) ON DELETE CASCADE, position INTEGER NOT NULL DEFAULT 0, branch_condition TEXT NOT NULL DEFAULT '', project_slug TEXT NOT NULL, feature_id TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', tombstoned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
		`CREATE VIRTUAL TABLE flows_fts USING fts5(flow_id UNINDEXED, name, description, owner, tags, step_text, tokenize = 'porter unicode61')`,
		`INSERT INTO flows_fts (flow_id, name, step_text) VALUES ('tree', 'Tree', 'entry'), ('flat', 'Flat', ''), ('mixed', 'Mixed', '')`,
		`CREATE TABLE flow_step_links (flow_id TEXT NOT NULL, from_step_id TEXT NOT NULL, to_step_id TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (from_step_id, to_step_id))`,
		// tree: a -> b -> (c "if admin", d "else"); links c -> d (a join) and a -> b (labels the tree edge)
		`INSERT INTO flows (id, name) VALUES ('tree', 'Tree'), ('flat', 'Flat'), ('mixed', 'Mixed')`,
		`INSERT INTO flow_steps (id, flow_id, parent_step_id, position, branch_condition, project_slug, feature_id, note) VALUES
			('a', 'tree', NULL, 0, '', 'web', 'fa', 'entry'),
			('b', 'tree', 'a', 0, '', 'api', 'fb', ''),
			('c', 'tree', 'b', 0, 'if admin', 'api', 'fc', ''),
			('d', 'tree', 'b', 1, 'else', 'db', 'fd', '')`,
		`INSERT INTO flow_step_links (flow_id, from_step_id, to_step_id, description, comment, tags) VALUES
			('tree', 'c', 'd', 'joins', 'c note', '["x"]'),
			('tree', 'a', 'b', 'calls', '', '[]')`,
		// flat: built by appending without a parent, out of order by position
		`INSERT INTO flow_steps (id, flow_id, parent_step_id, position, project_slug, feature_id) VALUES
			('f3', 'flat', NULL, 2, 'p', 'f3'), ('f1', 'flat', NULL, 0, 'p', 'f1'), ('f2', 'flat', NULL, 1, 'p', 'f2')`,
		// mixed: two roots, one with a child -> two entry points
		`INSERT INTO flow_steps (id, flow_id, parent_step_id, position, project_slug, feature_id) VALUES
			('m1', 'mixed', NULL, 0, 'p', 'm1'), ('m2', 'mixed', 'm1', 0, 'p', 'm2'), ('m3', 'mixed', NULL, 1, 'p', 'm3')`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
}

func TestFlowGraph_MigratesTreeEraDatabase(t *testing.T) {
	dir := t.TempDir()
	treeEraDB(t, dir)
	p, err := NewPlatform(dir)
	if err != nil {
		t.Fatalf("NewPlatform: %v", err)
	}
	defer p.Close()
	h := p.Handler()

	expectEdges(t, h, "tree", "fa>fb fb>fc[if admin] fb>fd[else] fc>fd")
	tree := mustDecode[Flow](t, do(t, h, "GET", "/api/flows/tree", ""))
	for _, e := range tree.Edges {
		switch {
		case e.FromStepID == "a" && e.Description != "calls":
			t.Errorf("the link over a -> b should label that edge: %+v", e)
		case e.FromStepID == "c" && (e.Description != "joins" || e.Comment != "c note" || len(e.Tags) != 1):
			t.Errorf("the join keeps the link's fields: %+v", e)
		}
	}
	if tree.Steps[0].Note != "entry" || tree.Steps[0].ProjectSlug != "web" {
		t.Errorf("steps keep their fields: %+v", tree.Steps[0])
	}
	expectEdges(t, h, "flat", "f1>f2 f2>f3")
	expectEdges(t, h, "mixed", "m1>m2")
	if got := stepsOf(t, h, "mixed"); got != "m1,m2,m3" {
		t.Errorf("mixed step order = %s", got)
	}

	// The tree columns and the links table are gone, so removing a step no longer cascades.
	if _, err := p.db.Exec(`SELECT parent_step_id FROM flow_steps LIMIT 0`); err == nil {
		t.Error("parent_step_id should be gone")
	}
	if _, err := p.db.Exec(`SELECT 1 FROM flow_step_links LIMIT 0`); err == nil {
		t.Error("flow_step_links should be gone")
	}
	do(t, h, "DELETE", "/api/flows/tree/steps/b", "")
	expectEdges(t, h, "tree", "fa>fc[if admin] fa>fd[else] fc>fd")

	// A backup of the database as it was, and the search index still works.
	if _, err := os.Stat(filepath.Join(dir, "platform.db.pre-flow-graph.bak")); err != nil {
		t.Errorf("backup: %v", err)
	}
	if page := mustDecode[FlowsPage](t, do(t, h, "GET", "/api/flows?q=entry", "")); page.Total != 1 {
		t.Errorf("search by step note after migration: %d results", page.Total)
	}
	// The step triggers that keep the index current survived rebuilding the table.
	do(t, h, "PATCH", "/api/flows/flat/steps/f2", `{"note":"afterwards"}`)
	if page := mustDecode[FlowsPage](t, do(t, h, "GET", "/api/flows?q=afterwards", "")); page.Total != 1 {
		t.Errorf("search by a note written after migration: %d results", page.Total)
	}

	// Opening it again is a no-op.
	p.Close()
	p2, err := NewPlatform(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer p2.Close()
	expectEdges(t, p2.Handler(), "flat", "f1>f2 f2>f3")
}

// ── service map ───────────────────────────────────────────────────────────────

func TestServiceMap_ConnectsServicesThroughFlows(t *testing.T) {
	h, p := newTestMCP(t)
	repoA, commitA := newGitRepo(t)
	repoB, commitB := newGitRepo(t)
	web := registerProject(t, h, "web", repoA)
	api := registerProject(t, h, "api", repoB)
	form := createFeature(t, p, web, commitA, "Login form")
	endpoint := createFeature(t, p, api, commitB, "POST /login")
	createFeature(t, p, api, commitB, "Health check")
	rest := p.Handler()

	mk := func(name, status string) string {
		w := do(t, rest, "POST", "/api/flows", fmt.Sprintf(`{"name":%q,"status":%q,"steps":[
			{"clientId":"1","projectSlug":%q,"featureId":%q},{"clientId":"2","projectSlug":%q,"featureId":%q},{"clientId":"3","projectSlug":%q,"featureId":%q}],
			"edges":[{"from":"1","to":"2","kind":"call","protocol":"HTTP","auth":"user","trustBoundary":true},{"from":"2","to":"3","kind":"next"}]}`,
			name, status, web, form, api, endpoint, api, endpoint+"x"))
		if w.Code != 201 {
			t.Fatalf("create flow: %d %s", w.Code, w.Body.String())
		}
		return mustDecode[Flow](t, w).ID
	}
	mk("Login", "active")
	mk("Login again", "draft")
	mk("Old login", "archived")

	m := mustDecode[ServiceMap](t, do(t, rest, "GET", "/api/service-map", ""))
	if len(m.Services) != 2 {
		t.Fatalf("services = %+v", m.Services)
	}
	if len(m.Connections) != 1 {
		t.Fatalf("connections = %+v", m.Connections)
	}
	c := m.Connections[0]
	if c.FromProject != web || c.ToProject != api || c.Kind != "call" || c.Count != 2 || len(c.Flows) != 2 || !c.TrustBoundary || strings.Join(c.Auth, ",") != "user" {
		t.Errorf("connection = %+v", c)
	}
	if len(m.Internal) != 1 || m.Internal[0].FromProject != api {
		t.Errorf("internal = %+v", m.Internal)
	}
	var apiSvc MapService
	for _, s := range m.Services {
		if s.Slug == api {
			apiSvc = s
		}
	}
	var counts []string
	for _, f := range apiSvc.Features {
		counts = append(counts, fmt.Sprintf("%s:%d:%v", f.Title, f.FlowCount, f.Missing))
	}
	sort.Strings(counts)
	want := []string{"Health check:0:false", "POST /login:2:false", endpoint + "x:2:true"}
	sort.Strings(want)
	if strings.Join(counts, " ") != strings.Join(want, " ") {
		t.Errorf("api features = %v", counts)
	}

	for _, f := range apiSvc.Features {
		if f.Title == "POST /login" && (len(f.Flows) != 2 || f.Flows[0].Name != "Login" || f.Flows[1].Name != "Login again") {
			t.Errorf("flows through POST /login = %+v", f.Flows)
		}
	}

	all := mustDecode[ServiceMap](t, do(t, rest, "GET", "/api/service-map?archived=1", ""))
	if all.Connections[0].Count != 3 {
		t.Errorf("with archived flows, count = %d", all.Connections[0].Count)
	}
}
