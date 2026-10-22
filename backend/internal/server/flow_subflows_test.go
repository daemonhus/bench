package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

// Subflow steps: a whole flow slotted into another as one step.

func addSubflow(h http.Handler, flowID, subflowID, extra string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/api/flows/"+flowID+"/steps", strings.NewReader(fmt.Sprintf(`{"subflowId":%q%s}`, subflowID, extra)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

func TestSubflow_SlotsAFlowInAsOneStep(t *testing.T) {
	_, h := newTestPlatform(t)
	outer, ids := chain(t, h, "pay", "confirm")
	shared, _ := chain(t, h, "authenticate", "forward")

	w := addSubflow(h, outer, shared, fmt.Sprintf(`,"after":%q,"edge":{"kind":"call"}`, ids["pay"]))
	if w.Code != 201 {
		t.Fatalf("add subflow: %d %s", w.Code, w.Body.String())
	}
	sub := mustDecode[FlowStep](t, w)
	if sub.SubflowID != shared || sub.Subflow == nil || sub.Subflow.Name != "chain" || sub.Subflow.StepCount != 2 || sub.Tombstoned {
		t.Fatalf("subflow step = %+v (subflow %+v)", sub, sub.Subflow)
	}

	f := mustDecode[Flow](t, do(t, h, "GET", "/api/flows/"+outer, ""))
	if len(f.Steps) != 3 || len(f.Edges) != 2 {
		t.Fatalf("outer flow: %d steps, %d edges", len(f.Steps), len(f.Edges))
	}
	var into FlowEdge
	for _, e := range f.Edges {
		if e.ToStepID == sub.ID {
			into = e
		}
	}
	if into.FromStepID != ids["pay"] || into.Kind != "call" || into.Linked != nil {
		t.Errorf("edge into the subflow = %+v", into)
	}
	used := mustDecode[Flow](t, do(t, h, "GET", "/api/flows/"+shared, ""))
	if len(used.UsedIn) != 1 || used.UsedIn[0].ID != outer {
		t.Errorf("shared usedIn = %+v", used.UsedIn)
	}

	// Export carries it, and an import of that document recreates it.
	exp := do(t, h, "GET", "/api/flows/"+outer+"/export", "").Body.String()
	if !strings.Contains(exp, `"subflowId":"`+shared+`"`) {
		t.Fatalf("export lacks the subflow: %s", exp)
	}
	w = do(t, h, "POST", "/api/flows", exp)
	if w.Code != 201 {
		t.Fatalf("import: %d %s", w.Code, w.Body.String())
	}
	if copy := mustDecode[Flow](t, w); !slices.ContainsFunc(copy.Steps, func(s FlowStep) bool { return s.SubflowID == shared }) {
		t.Errorf("imported copy lost the subflow: %+v", copy.Steps)
	}

	// The list leaves a subflow step out of a flow's projects.
	page := mustDecode[FlowsPage](t, do(t, h, "GET", "/api/flows?q=chain", ""))
	for _, it := range page.Items {
		if slices.Contains(it.ProjectSlugs, "") {
			t.Errorf("%s lists an empty project: %v", it.ID, it.ProjectSlugs)
		}
	}
}

func TestSubflow_RefusesLoopsAndBadTargets(t *testing.T) {
	_, h := newTestPlatform(t)
	a, _ := chain(t, h, "a1")
	b, _ := chain(t, h, "b1")
	c, _ := chain(t, h, "c1")
	for _, tc := range []struct{ flow, sub, extra, why string }{
		{a, a, "", "itself"},
		{a, "nope", "", "unknown flow"},
		{a, b, `,"projectSlug":"p","featureId":"x"`, "feature and subflow"},
	} {
		if w := addSubflow(h, tc.flow, tc.sub, tc.extra); w.Code != 400 {
			t.Errorf("%s: want 400, got %d %s", tc.why, w.Code, w.Body.String())
		}
	}
	// a ⊃ b ⊃ c, so c can't take a (nor b), at any depth.
	for _, pair := range [][2]string{{a, b}, {b, c}} {
		if w := addSubflow(h, pair[0], pair[1], ""); w.Code != 201 {
			t.Fatalf("add: %d %s", w.Code, w.Body.String())
		}
	}
	for _, sub := range []string{a, b} {
		if w := addSubflow(h, c, sub, ""); w.Code != 400 || !strings.Contains(w.Body.String(), "loop") {
			t.Errorf("c ⊃ %s: want a 400 about a loop, got %d %s", sub, w.Code, w.Body.String())
		}
	}
	// set-steps checks the same way.
	w := do(t, h, "PUT", "/api/flows/"+c+"/steps", fmt.Sprintf(`{"steps":[{"clientId":"x","subflowId":%q}]}`, a))
	if w.Code != 400 {
		t.Errorf("set-steps with a looping subflow: %d %s", w.Code, w.Body.String())
	}
	// Repointing a step at a flow checks too.
	step := mustDecode[Flow](t, do(t, h, "GET", "/api/flows/"+c, "")).Steps[0].ID
	if w := do(t, h, "PATCH", "/api/flows/"+c+"/steps/"+step, fmt.Sprintf(`{"subflowId":%q}`, a)); w.Code != 400 {
		t.Errorf("repoint into a loop: %d %s", w.Code, w.Body.String())
	}
}

func TestSubflow_DeletedFlowTombstonesAndDeltaSeesRepoints(t *testing.T) {
	_, h := newTestPlatform(t)
	outer, _ := chain(t, h, "x")
	first, _ := chain(t, h, "f1")
	second, _ := chain(t, h, "s1")
	sub := mustDecode[FlowStep](t, addSubflow(h, outer, first, ""))
	if w := do(t, h, "POST", "/api/flows/"+outer+"/baselines", `{}`); w.Code != 201 {
		t.Fatalf("baseline: %d %s", w.Code, w.Body.String())
	}
	if w := do(t, h, "PATCH", "/api/flows/"+outer+"/steps/"+sub.ID, fmt.Sprintf(`{"subflowId":%q}`, second)); w.Code != 200 {
		t.Fatalf("repoint: %d %s", w.Code, w.Body.String())
	}
	d := mustDecode[FlowDelta](t, do(t, h, "GET", "/api/flows/"+outer+"/delta", ""))
	if len(d.ChangedSteps) != 1 || !slices.Contains(d.ChangedSteps[0].Changes, "subflow") {
		t.Errorf("delta = %+v", d.ChangedSteps)
	}
	// A subflow step can become a feature step again.
	if w := do(t, h, "PATCH", "/api/flows/"+outer+"/steps/"+sub.ID, `{"projectSlug":"p","featureId":"back"}`); w.Code != 200 {
		t.Fatalf("repoint to a feature: %d %s", w.Code, w.Body.String())
	} else if s := mustDecode[FlowStep](t, w); s.SubflowID != "" || s.FeatureID != "back" {
		t.Errorf("after repoint to a feature: %+v", s)
	}
	if w := do(t, h, "PATCH", "/api/flows/"+outer+"/steps/"+sub.ID, fmt.Sprintf(`{"subflowId":%q}`, second)); w.Code != 200 {
		t.Fatalf("repoint back: %d %s", w.Code, w.Body.String())
	}
	if w := do(t, h, "DELETE", "/api/flows/"+second, ""); w.Code != 204 {
		t.Fatalf("delete: %d", w.Code)
	}
	for _, s := range mustDecode[Flow](t, do(t, h, "GET", "/api/flows/"+outer, "")).Steps {
		if s.ID == sub.ID && (!s.Tombstoned || s.TombstonedReason != "flow_not_found") {
			t.Errorf("step for a deleted flow: %+v", s)
		}
	}
}
