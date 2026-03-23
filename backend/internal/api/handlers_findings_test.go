package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"bench/internal/model"
)

// setupEnv reuses the git+DB environment from setupBaselineEnv.
// Alias so findings/comments tests don't have to repeat the setup logic.
var setupEnv = setupBaselineEnv

func TestFindingsAPI_ListEmpty(t *testing.T) {
	router, _ := setupEnv(t)

	req := httptest.NewRequest("GET", "/api/findings", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var list []model.Finding
	if err := json.NewDecoder(w.Body).Decode(&list); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(list) != 0 {
		t.Errorf("expected empty list, got %d", len(list))
	}
}

func TestFindingsAPI_CreateAndList(t *testing.T) {
	router, _ := setupEnv(t)

	body := `{"id":"f1","title":"SQL injection","severity":"high","status":"open","source":"mcp","anchor":{"fileId":"src/a.go","commitId":"abc"}}`
	req := httptest.NewRequest("POST", "/api/findings", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 201 {
		t.Fatalf("create status = %d, want 201; body: %s", w.Code, w.Body.String())
	}
	var created model.Finding
	if err := json.NewDecoder(w.Body).Decode(&created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.ID != "f1" {
		t.Errorf("id = %q, want f1", created.ID)
	}
	if created.CreatedAt == "" {
		t.Error("createdAt should be set")
	}

	// List should return it
	req = httptest.NewRequest("GET", "/api/findings", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	var list []model.Finding
	json.NewDecoder(w.Body).Decode(&list)
	if len(list) != 1 {
		t.Fatalf("list len = %d, want 1", len(list))
	}
	if list[0].ID != "f1" {
		t.Errorf("list[0].id = %q, want f1", list[0].ID)
	}
}

func TestFindingsAPI_CreateMissingFields(t *testing.T) {
	router, _ := setupEnv(t)

	// Missing severity
	body := `{"id":"f1","title":"SQLi","anchor":{"fileId":"a.go","commitId":"abc"}}`
	req := httptest.NewRequest("POST", "/api/findings", strings.NewReader(body))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 400 {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestFindingsAPI_Update(t *testing.T) {
	router, _ := setupEnv(t)

	// Create
	body := `{"id":"f1","title":"SQLi","severity":"high","status":"open","source":"mcp","anchor":{"fileId":"a.go","commitId":"abc"}}`
	req := httptest.NewRequest("POST", "/api/findings", strings.NewReader(body))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 201 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}

	// Update severity and status
	req = httptest.NewRequest("PATCH", "/api/findings/f1", strings.NewReader(`{"severity":"critical","status":"closed"}`))
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("update status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var updated model.Finding
	json.NewDecoder(w.Body).Decode(&updated)
	if updated.Severity != "critical" {
		t.Errorf("severity = %q, want critical", updated.Severity)
	}
	if updated.Status != "closed" {
		t.Errorf("status = %q, want closed", updated.Status)
	}
}

func TestFindingsAPI_Delete(t *testing.T) {
	router, _ := setupEnv(t)

	// Create
	body := `{"id":"f1","title":"SQLi","severity":"high","status":"open","source":"mcp","anchor":{"fileId":"a.go","commitId":"abc"}}`
	req := httptest.NewRequest("POST", "/api/findings", strings.NewReader(body))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	// Delete
	req = httptest.NewRequest("DELETE", "/api/findings/f1", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 204 {
		t.Fatalf("delete status = %d, want 204", w.Code)
	}

	// List should be empty
	req = httptest.NewRequest("GET", "/api/findings", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	var list []model.Finding
	json.NewDecoder(w.Body).Decode(&list)
	if len(list) != 0 {
		t.Errorf("expected empty list after delete, got %d", len(list))
	}
}

func TestFindingsAPI_DeleteNotFound(t *testing.T) {
	router, _ := setupEnv(t)

	req := httptest.NewRequest("DELETE", "/api/findings/nonexistent", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 404 {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

func TestFindingsAPI_InvalidJSON(t *testing.T) {
	router, _ := setupEnv(t)

	req := httptest.NewRequest("POST", "/api/findings", strings.NewReader(`{not valid json`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 400 {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestFindingsAPI_BodyTooLarge(t *testing.T) {
	router, _ := setupEnv(t)

	// Build a body larger than 1MB
	large := `{"id":"f1","title":"` + strings.Repeat("x", 1<<20+1) + `","severity":"high","status":"open","source":"mcp","anchor":{"fileId":"a.go","commitId":"abc"}}`
	req := httptest.NewRequest("POST", "/api/findings", strings.NewReader(large))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", w.Code)
	}
}
