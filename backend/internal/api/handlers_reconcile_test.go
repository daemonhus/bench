package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A reconcile against a commit that isn't in the project's repo must be
// rejected with 400, not silently started (which orphans every annotation).
func TestReconcileAPI_RejectsUnknownTargetCommit(t *testing.T) {
	router, _ := setupBaselineEnv(t)

	body := `{"targetCommit":"0123456789abcdef0123456789abcdef01234567"}`
	req := httptest.NewRequest("POST", "/api/reconcile", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body: %s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "not found in this project") {
		t.Errorf("expected a not-found message, got: %s", w.Body.String())
	}
}

// A reconcile against a real commit (HEAD) is accepted with 202.
func TestReconcileAPI_AcceptsValidTargetCommit(t *testing.T) {
	router, _ := setupBaselineEnv(t)

	body := `{"targetCommit":"HEAD"}`
	req := httptest.NewRequest("POST", "/api/reconcile", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (body: %s)", w.Code, w.Body.String())
	}
}

// An empty targetCommit is still rejected with 400.
func TestReconcileAPI_RejectsEmptyTargetCommit(t *testing.T) {
	router, _ := setupBaselineEnv(t)

	req := httptest.NewRequest("POST", "/api/reconcile", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body: %s)", w.Code, w.Body.String())
	}
}
