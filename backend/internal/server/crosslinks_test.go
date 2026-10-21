package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

// Links that span projects come back on the same fields as a project's own links, from both
// ends, through each project's REST API (and MCP, which uses the same database layer).

type crossFixture struct {
	p              *Platform
	mcp            http.Handler
	alpha, beta    string // slugs
	commitA        string
	aLogin, bLogin string // feature ids
}

func newCrossFixture(t *testing.T) crossFixture {
	t.Helper()
	h, p := newTestMCP(t)
	repoA, commitA := newGitRepo(t)
	repoB, commitB := newGitRepo(t)
	fx := crossFixture{p: p, mcp: h, commitA: commitA}
	fx.alpha = registerProject(t, h, "alpha", repoA)
	fx.beta = registerProject(t, h, "beta", repoB)
	fx.aLogin = createFeature(t, p, fx.alpha, commitA, "POST /login")
	fx.bLogin = createFeature(t, p, fx.beta, commitB, "POST /session")
	return fx
}

// call sends a request to one project's workbench API.
func (fx crossFixture) call(t *testing.T, slug, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	wb, err := fx.p.getWorkbench(slug)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	wb.Handler().ServeHTTP(w, req)
	return w
}

type linkedFeature struct {
	ID          string `json:"id"`
	Description string `json:"description"`
}

type featureJSON struct {
	ID                   string          `json:"id"`
	LinkedFeatures       []linkedFeature `json:"linkedFeatures"`
	CrossProjectFindings []string        `json:"crossProjectFindings"`
}

func (fx crossFixture) feature(t *testing.T, slug, id string) featureJSON {
	t.Helper()
	w := fx.call(t, slug, "GET", "/api/features/"+id, "")
	if w.Code != 200 {
		t.Fatalf("get feature %s:%s: %d %s", slug, id, w.Code, w.Body.String())
	}
	var f featureJSON
	if err := json.Unmarshal(w.Body.Bytes(), &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestCrossLinks_FeatureToFeatureReadsFromBothEnds(t *testing.T) {
	fx := newCrossFixture(t)
	body := fmt.Sprintf(`{"linkedFeatures":[{"id":%q,"description":"issues the session"}]}`, fx.beta+":"+fx.bLogin)
	if w := fx.call(t, fx.alpha, "PATCH", "/api/features/"+fx.aLogin, body); w.Code != 200 {
		t.Fatalf("link: %d %s", w.Code, w.Body.String())
	}
	a := fx.feature(t, fx.alpha, fx.aLogin)
	if len(a.LinkedFeatures) != 1 || a.LinkedFeatures[0].ID != fx.beta+":"+fx.bLogin || a.LinkedFeatures[0].Description != "issues the session" {
		t.Fatalf("alpha's links: %+v", a.LinkedFeatures)
	}
	// The other end sees it too, pointing back.
	b := fx.feature(t, fx.beta, fx.bLogin)
	if len(b.LinkedFeatures) != 1 || b.LinkedFeatures[0].ID != fx.alpha+":"+fx.aLogin {
		t.Fatalf("beta's links: %+v", b.LinkedFeatures)
	}
	// The list carries them as well.
	w := fx.call(t, fx.beta, "GET", "/api/features", "")
	if !strings.Contains(w.Body.String(), fx.alpha+":"+fx.aLogin) {
		t.Fatalf("list misses the link: %s", w.Body.String())
	}
	// Replacing from the other end replaces the one link (no duplicate rows), and {project, id} works.
	body = fmt.Sprintf(`{"linkedFeatures":[{"project":%q,"id":%q,"description":"relabelled"}]}`, fx.alpha, fx.aLogin)
	if w := fx.call(t, fx.beta, "PATCH", "/api/features/"+fx.bLogin, body); w.Code != 200 {
		t.Fatalf("relink: %d %s", w.Code, w.Body.String())
	}
	a = fx.feature(t, fx.alpha, fx.aLogin)
	if len(a.LinkedFeatures) != 1 || a.LinkedFeatures[0].Description != "relabelled" {
		t.Fatalf("after relink from beta: %+v", a.LinkedFeatures)
	}
	// Clearing from either end clears it.
	if w := fx.call(t, fx.alpha, "PATCH", "/api/features/"+fx.aLogin, `{"linkedFeatures":[]}`); w.Code != 200 {
		t.Fatalf("clear: %d %s", w.Code, w.Body.String())
	}
	if b := fx.feature(t, fx.beta, fx.bLogin); len(b.LinkedFeatures) != 0 {
		t.Fatalf("beta still linked: %+v", b.LinkedFeatures)
	}
}

func TestCrossLinks_FindingAffectsAnotherProjectsFeature(t *testing.T) {
	fx := newCrossFixture(t)
	ref := fx.beta + ":" + fx.bLogin
	body := fmt.Sprintf(`{"anchor":{"fileId":"a.go","commitId":%q,"lineRange":{"start":3,"end":3}},"severity":"high","title":"token replay","status":"open","source":"manual","features":[%q,%q]}`,
		fx.commitA, fx.aLogin, ref)
	w := fx.call(t, fx.alpha, "POST", "/api/findings", body)
	if w.Code != 201 {
		t.Fatalf("create finding: %d %s", w.Code, w.Body.String())
	}
	var f struct {
		ID       string   `json:"id"`
		Features []string `json:"features"`
	}
	json.Unmarshal(w.Body.Bytes(), &f)
	w = fx.call(t, fx.alpha, "GET", "/api/findings/"+f.ID, "")
	json.Unmarshal(w.Body.Bytes(), &f)
	if !slices.Contains(f.Features, fx.aLogin) || !slices.Contains(f.Features, ref) {
		t.Fatalf("finding features: %v", f.Features)
	}
	// The feature in beta knows the alpha finding affects it.
	if b := fx.feature(t, fx.beta, fx.bLogin); !slices.Equal(b.CrossProjectFindings, []string{fx.alpha + ":" + f.ID}) {
		t.Fatalf("beta feature's cross findings: %v", b.CrossProjectFindings)
	}
	// PATCH replaces the whole list, the other project's part included.
	if w := fx.call(t, fx.alpha, "PATCH", "/api/findings/"+f.ID, fmt.Sprintf(`{"features":[%q]}`, fx.aLogin)); w.Code != 200 {
		t.Fatalf("patch: %d %s", w.Code, w.Body.String())
	}
	if b := fx.feature(t, fx.beta, fx.bLogin); len(b.CrossProjectFindings) != 0 {
		t.Fatalf("still affects beta: %v", b.CrossProjectFindings)
	}
}

func TestCrossLinks_RefusesUnknownTargetsAndKeepsTheOldLinks(t *testing.T) {
	fx := newCrossFixture(t)
	good := fmt.Sprintf(`{"linkedFeatures":[%q]}`, fx.beta+":"+fx.bLogin)
	if w := fx.call(t, fx.alpha, "PATCH", "/api/features/"+fx.aLogin, good); w.Code != 200 {
		t.Fatalf("link: %d %s", w.Code, w.Body.String())
	}
	for _, bad := range []string{fx.beta + ":nope", "nosuchproject:" + fx.bLogin} {
		w := fx.call(t, fx.alpha, "PATCH", "/api/features/"+fx.aLogin, fmt.Sprintf(`{"linkedFeatures":[%q]}`, bad))
		if w.Code != 400 {
			t.Fatalf("%s: want 400, got %d %s", bad, w.Code, w.Body.String())
		}
	}
	if a := fx.feature(t, fx.alpha, fx.aLogin); len(a.LinkedFeatures) != 1 {
		t.Fatalf("a refused write changed the links: %+v", a.LinkedFeatures)
	}
	// "<self>:<id>" is this project's own feature.
	other := createFeature(t, fx.p, fx.alpha, fx.commitA, "GET /me")
	if w := fx.call(t, fx.alpha, "PATCH", "/api/features/"+fx.aLogin, fmt.Sprintf(`{"linkedFeatures":[%q]}`, fx.alpha+":"+other)); w.Code != 200 {
		t.Fatalf("self-qualified link: %d %s", w.Code, w.Body.String())
	}
	a := fx.feature(t, fx.alpha, fx.aLogin)
	if len(a.LinkedFeatures) != 1 || a.LinkedFeatures[0].ID != other {
		t.Fatalf("self-qualified link stored as: %+v", a.LinkedFeatures)
	}
}

func TestCrossLinks_DeletingAFeatureDropsItsLinks(t *testing.T) {
	fx := newCrossFixture(t)
	if w := fx.call(t, fx.alpha, "PATCH", "/api/features/"+fx.aLogin, fmt.Sprintf(`{"linkedFeatures":[%q]}`, fx.beta+":"+fx.bLogin)); w.Code != 200 {
		t.Fatalf("link: %d %s", w.Code, w.Body.String())
	}
	if w := fx.call(t, fx.beta, "DELETE", "/api/features/"+fx.bLogin, ""); w.Code >= 300 {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
	if a := fx.feature(t, fx.alpha, fx.aLogin); len(a.LinkedFeatures) != 0 {
		t.Fatalf("link to a deleted feature remains: %+v", a.LinkedFeatures)
	}
	var n int
	fx.p.db.QueryRow(`SELECT COUNT(*) FROM cross_links`).Scan(&n)
	if n != 0 {
		t.Fatalf("%d cross_links rows left", n)
	}
}

func TestCrossLinks_MCPTakesProjectRefs(t *testing.T) {
	fx := newCrossFixture(t)
	h := fx.mcp
	mcpOK(t, h, "update_feature", map[string]any{
		"project": fx.alpha, "id": fx.aLogin,
		"linked_feature_ids": []any{map[string]any{"project": fx.beta, "id": fx.bLogin, "description": "via mcp"}},
	}, nil)
	var got featureJSON
	mcpOK(t, h, "get_feature", map[string]any{"project": fx.beta, "id": fx.bLogin}, &got)
	if len(got.LinkedFeatures) != 1 || got.LinkedFeatures[0].ID != fx.alpha+":"+fx.aLogin || got.LinkedFeatures[0].Description != "via mcp" {
		t.Fatalf("beta via MCP: %+v", got.LinkedFeatures)
	}
}
