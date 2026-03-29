package api

// TestAPICreateDefaults verifies the default values applied when creating
// annotations via the REST API (CLI path). These intentionally differ from
// the MCP layer — see tools_contract_test.go in the mcp package.

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"bench/internal/model"
)

func TestFindingsAPI_CreateDefaultsStatusAndSource(t *testing.T) {
	router, _ := setupEnv(t)

	body := `{"title":"test finding","severity":"high"}`
	req := httptest.NewRequest("POST", "/api/findings", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 201 {
		t.Fatalf("status = %d, want 201; body: %s", w.Code, w.Body.String())
	}
	var f model.Finding
	if err := json.NewDecoder(w.Body).Decode(&f); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if f.Status != "open" {
		t.Errorf("default status = %q, want open", f.Status)
	}
	if f.Source != "manual" {
		t.Errorf("default source = %q, want manual", f.Source)
	}
	if f.CreatedAt == "" {
		t.Error("createdAt should be set automatically")
	}
}

func TestFindingsAPI_CreateRequiredFields(t *testing.T) {
	router, _ := setupEnv(t)

	cases := []struct {
		name string
		body string
	}{
		{"missing title", `{"severity":"high"}`},
		{"missing severity", `{"title":"test"}`},
		{"both missing", `{}`},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/findings", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			if w.Code != 400 {
				t.Errorf("status = %d, want 400", w.Code)
			}
		})
	}
}

func TestCommentsAPI_CreateRequiredFields(t *testing.T) {
	router, _ := setupEnv(t)

	cases := []struct {
		name string
		body string
	}{
		{"missing author", `{"text":"hello"}`},
		{"missing text", `{"author":"alice"}`},
		{"both missing", `{}`},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/comments", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			if w.Code != 400 {
				t.Errorf("status = %d, want 400", w.Code)
			}
		})
	}
}

func TestFeaturesAPI_CreateRequiredFields(t *testing.T) {
	router, _ := setupEnv(t)

	// Features handler — check what fields it requires
	cases := []struct {
		name     string
		body     string
		wantCode int
	}{
		// Valid minimal create (API layer is permissive — no required fields enforced at handler)
		{"minimal valid", `{"title":"Login","kind":"interface"}`, 201},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/features", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			if w.Code != tc.wantCode {
				t.Errorf("status = %d, want %d; body: %s", w.Code, tc.wantCode, w.Body.String())
			}
		})
	}
}

// TestFindingsAPI_ScoreRoundTrip verifies that score survives the HTTP create
// and update paths as a JSON number (float64), not silently coerced to a string.
func TestFindingsAPI_CreateScoreIsFloat(t *testing.T) {
	router, _ := setupEnv(t)

	body := `{"title":"CVSS finding","severity":"high","score":7.5}`
	req := httptest.NewRequest("POST", "/api/findings", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 201 {
		t.Fatalf("status = %d, want 201; body: %s", w.Code, w.Body.String())
	}
	var result map[string]any
	json.NewDecoder(w.Body).Decode(&result)
	score, ok := result["score"].(float64)
	if !ok {
		t.Fatalf("score is %T (%v), want float64", result["score"], result["score"])
	}
	if score != 7.5 {
		t.Errorf("score = %v, want 7.5", score)
	}
}

func TestFindingsAPI_UpdateScoreIsFloat(t *testing.T) {
	router, _ := setupEnv(t)

	req := httptest.NewRequest("POST", "/api/findings", strings.NewReader(`{"id":"f-score","title":"x","severity":"low"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 201 {
		t.Fatalf("create: %d", w.Code)
	}

	req = httptest.NewRequest("PATCH", "/api/findings/f-score", strings.NewReader(`{"score":9.1}`))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("update: %d %s", w.Code, w.Body.String())
	}
	var result map[string]any
	json.NewDecoder(w.Body).Decode(&result)
	score, ok := result["score"].(float64)
	if !ok {
		t.Fatalf("score is %T (%v), want float64", result["score"], result["score"])
	}
	if score != 9.1 {
		t.Errorf("score = %v, want 9.1", score)
	}
}
