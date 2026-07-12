package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"bench/internal/model"
)

// createOriginTestFinding posts a finding anchored to the test repo's
// readme.txt at HEAD and returns its ID.
func createOriginTestFinding(t *testing.T, router http.Handler) string {
	t.Helper()
	body := `{"anchor":{"fileId":"readme.txt","lineRange":{"start":1,"end":1}},"severity":"high","title":"origin test"}`
	req := httptest.NewRequest("POST", "/api/findings", strings.NewReader(body))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 201 && w.Code != 200 {
		t.Fatalf("create finding: status %d: %s", w.Code, w.Body.String())
	}
	var f model.Finding
	if err := json.NewDecoder(w.Body).Decode(&f); err != nil {
		t.Fatalf("decode finding: %v", err)
	}
	return f.ID
}

func putOrigin(t *testing.T, router http.Handler, id, body string) (*httptest.ResponseRecorder, model.Origin) {
	t.Helper()
	req := httptest.NewRequest("PUT", "/api/findings/"+id+"/origin", strings.NewReader(body))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	var o model.Origin
	if w.Code == 200 {
		if err := json.NewDecoder(w.Body).Decode(&o); err != nil {
			t.Fatalf("decode origin: %v", err)
		}
	}
	return w, o
}

func TestOrigin_UpsertMergeAndDelete(t *testing.T) {
	router, _ := setupBaselineEnv(t)
	id := createOriginTestFinding(t, router)

	w, o := putOrigin(t, router, id, `{"explanation":"introduced during the auth refactor","actor":"mallory"}`)
	if w.Code != 200 {
		t.Fatalf("put origin: status %d: %s", w.Code, w.Body.String())
	}
	if o.Explanation != "introduced during the auth refactor" || o.Actor != "mallory" {
		t.Errorf("origin = %+v", o)
	}

	// Second put with only branch: earlier fields survive the merge.
	w, o = putOrigin(t, router, id, `{"branch":"feature/auth-refactor"}`)
	if w.Code != 200 || o.Explanation == "" || o.Actor != "mallory" || o.Branch != "feature/auth-refactor" {
		t.Errorf("merge lost fields: %+v (status %d)", o, w.Code)
	}

	// Embedded on the finding.
	req := httptest.NewRequest("GET", "/api/findings/"+id, nil)
	rw := httptest.NewRecorder()
	router.ServeHTTP(rw, req)
	var f model.Finding
	if err := json.NewDecoder(rw.Body).Decode(&f); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if f.Origin == nil || f.Origin.Branch != "feature/auth-refactor" {
		t.Errorf("finding.origin = %+v", f.Origin)
	}

	// And on the list response.
	req = httptest.NewRequest("GET", "/api/findings", nil)
	rw = httptest.NewRecorder()
	router.ServeHTTP(rw, req)
	var list []model.Finding
	if err := json.NewDecoder(rw.Body).Decode(&list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list) != 1 || list[0].Origin == nil {
		t.Errorf("list origin missing: %+v", list)
	}

	// Delete clears it.
	req = httptest.NewRequest("DELETE", "/api/findings/"+id+"/origin", nil)
	rw = httptest.NewRecorder()
	router.ServeHTTP(rw, req)
	if rw.Code != 204 {
		t.Fatalf("delete origin: status %d", rw.Code)
	}
	req = httptest.NewRequest("GET", "/api/findings/"+id, nil)
	rw = httptest.NewRecorder()
	router.ServeHTTP(rw, req)
	f = model.Finding{}
	_ = json.NewDecoder(rw.Body).Decode(&f)
	if f.Origin != nil {
		t.Errorf("origin survived delete: %+v", f.Origin)
	}
}

func TestOrigin_ResolvableCommitNormalisedAndPinned(t *testing.T) {
	router, _ := setupBaselineEnv(t)
	id := createOriginTestFinding(t, router)

	w, o := putOrigin(t, router, id, `{"introducedCommit":"HEAD"}`)
	if w.Code != 200 {
		t.Fatalf("put origin: status %d: %s", w.Code, w.Body.String())
	}
	if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(o.IntroducedCommit) {
		t.Errorf("commit not normalised to full sha: %q", o.IntroducedCommit)
	}

	// Unresolvable commits are stored as-is.
	w, o = putOrigin(t, router, id, `{"introducedCommit":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"}`)
	if w.Code != 200 || o.IntroducedCommit != "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" {
		t.Errorf("unresolvable commit mangled: %q (status %d)", o.IntroducedCommit, w.Code)
	}
}

func TestOrigin_Suggest(t *testing.T) {
	router, _ := setupBaselineEnv(t)
	id := createOriginTestFinding(t, router)

	req := httptest.NewRequest("GET", "/api/findings/"+id+"/origin/suggest", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("suggest: status %d: %s", w.Code, w.Body.String())
	}
	var o model.Origin
	if err := json.NewDecoder(w.Body).Decode(&o); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if o.Actor != "Test" {
		t.Errorf("actor = %q, want the fixture author", o.Actor)
	}
	if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(o.IntroducedCommit) {
		t.Errorf("commit = %q, want a full sha (blame's short hash resolved)", o.IntroducedCommit)
	}
	if _, err := time.Parse(time.RFC3339, o.IntroducedDate); err != nil {
		t.Errorf("date = %q, want RFC3339 (blame's epoch normalised)", o.IntroducedDate)
	}
	if o.Explanation != "" || o.Branch != "" {
		t.Errorf("suggestion invented fields blame cannot know: %+v", o)
	}
}

func TestOrigin_WriteGateAndNotFound(t *testing.T) {
	repo, database := setupRepoAndDB(t) // profile unconfigured
	router := NewRouter(repo, database, nil)

	// Gated before the profile is configured.
	req := httptest.NewRequest("PUT", "/api/findings/nope/origin", strings.NewReader(`{}`))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusPreconditionFailed {
		t.Errorf("pre-profile put: status %d, want 412", w.Code)
	}

	// Suggest is read-only and passes the gate, then 404s on the unknown id.
	req = httptest.NewRequest("GET", "/api/findings/nope/origin/suggest", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("suggest unknown: status %d, want 404", w.Code)
	}

	// Configured: unknown finding 404s on put too.
	if err := database.PutServiceProfile(model.ServiceProfile{}); err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest("PUT", "/api/findings/nope/origin", strings.NewReader(`{}`))
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("put unknown: status %d, want 404", w.Code)
	}
}

func TestOrigin_DeletedWithFinding(t *testing.T) {
	router, database := setupBaselineEnv(t)
	id := createOriginTestFinding(t, router)
	if w, _ := putOrigin(t, router, id, `{"actor":"mallory"}`); w.Code != 200 {
		t.Fatalf("put origin failed")
	}

	req := httptest.NewRequest("DELETE", "/api/findings/"+id, nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 204 && w.Code != 200 {
		t.Fatalf("delete finding: status %d", w.Code)
	}
	o, err := database.GetOrigin("finding", id)
	if err == nil && o != nil {
		t.Errorf("origin survived finding deletion: %+v", o)
	}
}

func TestOrigin_FeatureRoutes(t *testing.T) {
	router, _ := setupBaselineEnv(t)

	// Create a feature anchored to the fixture file.
	body := `{"anchor":{"fileId":"readme.txt","lineRange":{"start":1,"end":1}},"kind":"interface","title":"/webhook"}`
	req := httptest.NewRequest("POST", "/api/features", strings.NewReader(body))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 201 && w.Code != 200 {
		t.Fatalf("create feature: status %d: %s", w.Code, w.Body.String())
	}
	var feat model.Feature
	if err := json.NewDecoder(w.Body).Decode(&feat); err != nil {
		t.Fatalf("decode feature: %v", err)
	}

	// Upsert an origin and read it back embedded on the feature.
	req = httptest.NewRequest("PUT", "/api/features/"+feat.ID+"/origin",
		strings.NewReader(`{"explanation":"added with the provider abstraction","branch":"feature/webhooks"}`))
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("put feature origin: status %d: %s", w.Code, w.Body.String())
	}
	req = httptest.NewRequest("GET", "/api/features/"+feat.ID, nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	feat = model.Feature{}
	if err := json.NewDecoder(w.Body).Decode(&feat); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if feat.Origin == nil || feat.Origin.Branch != "feature/webhooks" {
		t.Errorf("feature.origin = %+v", feat.Origin)
	}

	// Suggest derives from blame on the anchor.
	req = httptest.NewRequest("GET", "/api/features/"+feat.ID+"/origin/suggest", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("suggest: status %d: %s", w.Code, w.Body.String())
	}
	var s model.OriginSuggestion
	if err := json.NewDecoder(w.Body).Decode(&s); err != nil {
		t.Fatalf("decode suggestion: %v", err)
	}
	if s.Actor != "Test" || len(s.IntroducedCommit) != 40 {
		t.Errorf("suggestion = %+v", s)
	}

	// Deleting the feature removes the origin row.
	req = httptest.NewRequest("DELETE", "/api/features/"+feat.ID, nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 204 && w.Code != 200 {
		t.Fatalf("delete feature: status %d", w.Code)
	}
}
