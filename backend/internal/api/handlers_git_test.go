package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// An unknown 40-hex sha must yield a 404, not a 500. This is the regression
// guard for the "baseline references a rebased-away commit → 500" bug.
func TestGitHandlers_UnknownCommitReturns404(t *testing.T) {
	router, _ := setupBaselineEnv(t)

	const dead = "9c1acab62ae8f102e65900294a923c8baf214815"

	cases := []struct {
		name string
		url  string
	}{
		{"tree", "/api/git/tree/" + dead},
		{"show", "/api/git/show/" + dead + "/readme.txt"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", c.url, nil)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != http.StatusNotFound {
				t.Fatalf("%s: status = %d, want 404\nbody: %s", c.url, w.Code, w.Body.String())
			}
		})
	}
}

// An existing commit should still work (sanity check that 404-classification
// didn't catch valid refs in the dragnet).
func TestGitHandlers_ValidHeadReturns200(t *testing.T) {
	router, _ := setupBaselineEnv(t)

	req := httptest.NewRequest("GET", "/api/git/tree/HEAD", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200\nbody: %s", w.Code, w.Body.String())
	}
}
