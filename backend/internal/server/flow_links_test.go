package server

import (
	"fmt"
	"strings"
	"testing"
)

// Feature links and flows: whether a link backs each hop, the links on the service map, and
// the links as next-step suggestions.

func TestLinks_BackFlowEdgesAndShowOnTheMap(t *testing.T) {
	fx := newZoneFixture(t)
	if e, _ := fx.edge(t); e.Linked == nil || *e.Linked {
		t.Fatalf("unlinked hop: linked = %v", e.Linked)
	}
	m := mustDecode[ServiceMap](t, do(t, fx.rest, "GET", "/api/service-map", ""))
	if len(m.Links) != 0 || m.Connections[0].Linked {
		t.Fatalf("before linking: links %+v, connection %+v", m.Links, m.Connections[0])
	}

	// Link the two features (from the api end), plus one pair no flow covers.
	audit := createFeature(t, fx.p, fx.api, fx.commitAPI, "Audit log")
	wbCall(t, fx.p, fx.api, "PATCH", "/api/features/"+fx.login,
		fmt.Sprintf(`{"linkedFeatures":[{"id":%q,"description":"posts credentials"},{"id":%q}]}`, fx.web+":"+fx.form, audit))
	if e, _ := fx.edge(t); e.Linked == nil || !*e.Linked {
		t.Errorf("linked hop: linked = %v", e.Linked)
	}
	m = mustDecode[ServiceMap](t, do(t, fx.rest, "GET", "/api/service-map", ""))
	if !m.Connections[0].Linked {
		t.Errorf("connection = %+v", m.Connections[0])
	}
	if len(m.Links) != 2 {
		t.Fatalf("links = %+v", m.Links)
	}
	var cross, local MapLink
	for _, l := range m.Links {
		if l.FromProject != l.ToProject {
			cross = l
		} else {
			local = l
		}
	}
	if !cross.InFlows || cross.Description != "posts credentials" {
		t.Errorf("cross-project link = %+v", cross)
	}
	if local.InFlows || local.FromProject != fx.api || (local.FromFeature != audit && local.ToFeature != audit) {
		t.Errorf("local link = %+v", local)
	}
}

func TestSuggestions_ListLinkedFeaturesNewOnesFirst(t *testing.T) {
	fx := newZoneFixture(t)
	audit := createFeature(t, fx.p, fx.api, fx.commitAPI, "Audit log")
	session := createFeature(t, fx.p, fx.api, fx.commitAPI, "Issue session")
	wbCall(t, fx.p, fx.api, "PATCH", "/api/features/"+fx.login,
		fmt.Sprintf(`{"linkedFeatures":[{"id":%q},{"id":%q,"description":"on success"},{"id":%q}]}`, fx.web+":"+fx.form, session, audit))
	_, f := fx.edge(t)
	loginStep := f.Steps[1].ID

	got := mustDecode[[]FlowSuggestion](t, do(t, fx.rest, "GET", "/api/flows/"+fx.flow+"/steps/"+loginStep+"/suggestions", ""))
	var titles []string
	for _, s := range got {
		titles = append(titles, s.Title)
	}
	if strings.Join(titles, ",") != "Audit log,Issue session,Login form" {
		t.Fatalf("suggestions = %v", titles)
	}
	if got[1].Description != "on success" || got[1].ProjectSlug != fx.api || got[1].StepID != "" {
		t.Errorf("session suggestion = %+v", got[1])
	}
	// The form is already in the flow (step 1) but the login step doesn't lead to it.
	if form := got[2]; form.ProjectSlug != fx.web || form.StepID != f.Steps[0].ID || form.Connected {
		t.Errorf("form suggestion = %+v", form)
	}
	formStep := f.Steps[0].ID
	back := mustDecode[[]FlowSuggestion](t, do(t, fx.rest, "GET", "/api/flows/"+fx.flow+"/steps/"+formStep+"/suggestions", ""))
	if len(back) != 1 || back[0].StepID != loginStep || !back[0].Connected {
		t.Errorf("from the form = %+v", back)
	}

	// MCP: the same through flows_suggest_next, and a subflow through flows_add_step.
	var viaMCP []FlowSuggestion
	mcpOK(t, fx.h, "flows_suggest_next", map[string]any{"flow_id": fx.flow, "step_id": loginStep}, &viaMCP)
	if len(viaMCP) != 3 {
		t.Errorf("flows_suggest_next = %+v", viaMCP)
	}
	other := createTestFlow(t, fx.rest, "Shared", "draft")
	var step FlowStep
	mcpOK(t, fx.h, "flows_add_step", map[string]any{"flow_id": fx.flow, "subflow_id": other.ID, "after": loginStep}, &step)
	if step.SubflowID != other.ID || step.Subflow == nil || step.Subflow.Name != "Shared" {
		t.Errorf("flows_add_step with subflow_id = %+v", step)
	}
}
