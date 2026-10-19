package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"bench/internal/model"
)

// The finding detail page asks for a finding with ?commit=HEAD and shows where it sits now:
// the effective anchor and its confidence, as the feature detail page does for features.
func TestFindingsAPI_GetWithCommitAddsPosition(t *testing.T) {
	router, _ := setupBaselineEnv(t)
	head := gitHead(t, router)

	body := `{"anchor":{"fileId":"readme.txt","commitId":"` + head + `","lineRange":{"start":1,"end":1}},"severity":"high","title":"T","description":"d","status":"open","source":"manual"}`
	req := httptest.NewRequest("POST", "/api/findings", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 201 && w.Code != 200 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	var created model.Finding
	json.NewDecoder(w.Body).Decode(&created)

	req = httptest.NewRequest("GET", "/api/findings/"+created.ID+"?commit=HEAD", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("get: %d %s", w.Code, w.Body.String())
	}
	var got model.FindingWithPosition
	json.NewDecoder(w.Body).Decode(&got)
	if got.ID != created.ID || got.Title != "T" {
		t.Fatalf("got %+v, want the created finding", got)
	}
	if got.Confidence != "exact" || got.EffectiveAnchor == nil || got.EffectiveAnchor.FileID != "readme.txt" || got.EffectiveAnchor.LineRange.Start != 1 {
		t.Errorf("position = %q %+v, want exact at readme.txt:1", got.Confidence, got.EffectiveAnchor)
	}

	// Without ?commit= the plain finding comes back, unchanged.
	req = httptest.NewRequest("GET", "/api/findings/"+created.ID, nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if strings.Contains(w.Body.String(), "effectiveAnchor") {
		t.Errorf("plain get carries a position: %s", w.Body.String())
	}
}

// gitHead is the test repo's HEAD commit, read through the API.
func gitHead(t *testing.T, router http.Handler) string {
	t.Helper()
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/api/git/commits?limit=1", nil))
	var commits []struct {
		Hash string `json:"hash"`
	}
	if err := json.NewDecoder(w.Body).Decode(&commits); err != nil || len(commits) == 0 {
		t.Fatalf("commits: %v %s", err, w.Body.String())
	}
	return commits[0].Hash
}
