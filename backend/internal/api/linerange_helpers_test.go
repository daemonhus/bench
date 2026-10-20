package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"bench/internal/model"
)

// assertStoredRange fetches path and checks the stored anchor's line range.
func assertStoredRange(t *testing.T, router http.Handler, path string, want *model.LineRange) {
	t.Helper()
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
	if w.Code != 200 {
		t.Fatalf("GET %s = %d; body: %s", path, w.Code, w.Body.String())
	}
	var got struct {
		Anchor model.Anchor `json:"anchor"`
	}
	if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	lr := got.Anchor.LineRange
	if (lr == nil) != (want == nil) || (lr != nil && *lr != *want) {
		t.Errorf("GET %s: lineRange = %v, want %v", path, lr, want)
	}
}

// assertNotStored checks that nothing was stored at path.
func assertNotStored(t *testing.T, router http.Handler, path string) {
	t.Helper()
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
	if w.Code != http.StatusNotFound {
		t.Errorf("GET %s = %d, want 404 (nothing stored); body: %s", path, w.Code, w.Body.String())
	}
}
