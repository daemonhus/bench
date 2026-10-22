package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Trust zones: an edge between features in different zones crosses a trust boundary.

// wbCall sends a request to one project's workbench API.
func wbCall(t *testing.T, p *Platform, slug, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	wb, err := p.getWorkbench(slug)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	wb.Handler().ServeHTTP(w, req)
	if w.Code >= 300 {
		t.Fatalf("%s %s on %s: %d %s", method, path, slug, w.Code, w.Body.String())
	}
	return w
}

// zoneFixture: web (zone public-edge) and api (zone core), a login feature on each, and a
// flow web:form -> api:login.
type zoneFixture struct {
	p                    *Platform
	h, rest              http.Handler
	web, api             string
	commitWeb, commitAPI string
	form, login          string
	flow                 string
}

func newZoneFixture(t *testing.T) zoneFixture {
	t.Helper()
	h, p := newTestMCP(t)
	repoA, commitA := newGitRepo(t)
	repoB, commitB := newGitRepo(t)
	fx := zoneFixture{p: p, h: h, rest: p.Handler(), commitWeb: commitA, commitAPI: commitB}
	fx.web = registerProject(t, h, "web", repoA)
	fx.api = registerProject(t, h, "api", repoB)
	fx.form = createFeature(t, p, fx.web, commitA, "Login form")
	fx.login = createFeature(t, p, fx.api, commitB, "POST /login")
	wbCall(t, p, fx.web, "PATCH", "/api/profile", `{"trustZone":"public-edge"}`)
	wbCall(t, p, fx.api, "PATCH", "/api/profile", `{"trustZone":" core "}`)
	w := do(t, fx.rest, "POST", "/api/flows", fmt.Sprintf(`{"name":"Login","status":"active","steps":[
		{"clientId":"1","projectSlug":%q,"featureId":%q},{"clientId":"2","projectSlug":%q,"featureId":%q}],
		"edges":[{"from":"1","to":"2","kind":"call"}]}`, fx.web, fx.form, fx.api, fx.login))
	if w.Code != 201 {
		t.Fatalf("create flow: %d %s", w.Code, w.Body.String())
	}
	fx.flow = mustDecode[Flow](t, w).ID
	return fx
}

func (fx zoneFixture) edge(t *testing.T) (FlowEdge, Flow) {
	t.Helper()
	f := mustDecode[Flow](t, do(t, fx.rest, "GET", "/api/flows/"+fx.flow, ""))
	if len(f.Edges) != 1 {
		t.Fatalf("edges = %+v", f.Edges)
	}
	return f.Edges[0], f
}

func TestZones_EdgeBetweenZonesCrossesABoundary(t *testing.T) {
	fx := newZoneFixture(t)
	e, f := fx.edge(t)
	if !e.ZoneBoundary || e.TrustBoundary {
		t.Errorf("edge public-edge -> core: zoneBoundary %v, trustBoundary %v", e.ZoneBoundary, e.TrustBoundary)
	}
	if f.Steps[1].Feature == nil || f.Steps[1].Feature.Zone != "core" {
		t.Errorf("api step's zone = %+v", f.Steps[1].Feature)
	}
	if prof := wbCall(t, fx.p, fx.api, "GET", "/api/profile", "").Body.String(); !strings.Contains(prof, `"trustZone":"core"`) {
		t.Errorf("profile keeps the zone trimmed: %s", prof)
	}
	// A feature's zone:<name> tag puts it in that zone instead; same zone, no boundary.
	wbCall(t, fx.p, fx.api, "PATCH", "/api/features/"+fx.login, `{"tags":["zone:Public-Edge"]}`)
	if e, _ := fx.edge(t); e.ZoneBoundary {
		t.Errorf("edge inside one zone still crosses: %+v", e)
	}
	m := mustDecode[ServiceMap](t, do(t, fx.rest, "GET", "/api/service-map", ""))
	for _, s := range m.Services {
		want := map[string]string{fx.web: "public-edge", fx.api: "core"}[s.Slug]
		if s.Zone != want {
			t.Errorf("service %s zone = %q, want %q", s.Slug, s.Zone, want)
		}
		for _, ft := range s.Features {
			if ft.ID == fx.login && ft.Zone != "Public-Edge" {
				t.Errorf("login's own zone = %q", ft.Zone)
			}
		}
	}
	if len(m.Connections) != 1 || m.Connections[0].ZoneBoundary {
		t.Errorf("connections = %+v", m.Connections)
	}
	// A zone left unset on one side says nothing.
	wbCall(t, fx.p, fx.api, "PATCH", "/api/features/"+fx.login, `{"tags":[]}`)
	wbCall(t, fx.p, fx.web, "PATCH", "/api/profile", `{"trustZone":""}`)
	if e, _ := fx.edge(t); e.ZoneBoundary {
		t.Errorf("edge with one zone unset: %+v", e)
	}
}
