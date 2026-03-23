package api

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"bench/internal/model"
)

const minComment = `{"id":"c1","author":"alice","text":"looks bad","threadId":"t1","timestamp":"2024-01-01T00:00:00Z","anchor":{"fileId":"src/a.go","commitId":"abc"}}`

func TestCommentsAPI_CreateAndList(t *testing.T) {
	router, _ := setupEnv(t)

	req := httptest.NewRequest("POST", "/api/comments", strings.NewReader(minComment))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 201 {
		t.Fatalf("create status = %d, want 201; body: %s", w.Code, w.Body.String())
	}
	var created model.Comment
	if err := json.NewDecoder(w.Body).Decode(&created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.ID != "c1" {
		t.Errorf("id = %q, want c1", created.ID)
	}

	// List should return it
	req = httptest.NewRequest("GET", "/api/comments", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("list status = %d, want 200", w.Code)
	}
	var list []model.Comment
	json.NewDecoder(w.Body).Decode(&list)
	if len(list) != 1 {
		t.Fatalf("list len = %d, want 1", len(list))
	}
}

func TestCommentsAPI_CreateMissingFields(t *testing.T) {
	router, _ := setupEnv(t)

	// Missing author
	body := `{"id":"c1","text":"note","threadId":"t1","timestamp":"2024-01-01T00:00:00Z","anchor":{"fileId":"a.go","commitId":"abc"}}`
	req := httptest.NewRequest("POST", "/api/comments", strings.NewReader(body))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 400 {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestCommentsAPI_Update(t *testing.T) {
	router, _ := setupEnv(t)

	// Create
	req := httptest.NewRequest("POST", "/api/comments", strings.NewReader(minComment))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 201 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}

	// Update text
	req = httptest.NewRequest("PATCH", "/api/comments/c1", strings.NewReader(`{"text":"updated note"}`))
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("update status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var updated model.Comment
	if err := json.NewDecoder(w.Body).Decode(&updated); err != nil {
		t.Fatalf("decode updated comment: %v", err)
	}
	if updated.Text != "updated note" {
		t.Errorf("updated text = %q, want 'updated note'", updated.Text)
	}
}

func TestCommentsAPI_Delete(t *testing.T) {
	router, _ := setupEnv(t)

	// Create
	req := httptest.NewRequest("POST", "/api/comments", strings.NewReader(minComment))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	// Delete
	req = httptest.NewRequest("DELETE", "/api/comments/c1", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 204 {
		t.Fatalf("delete status = %d, want 204", w.Code)
	}

	// List should be empty
	req = httptest.NewRequest("GET", "/api/comments", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	var list []model.Comment
	json.NewDecoder(w.Body).Decode(&list)
	if len(list) != 0 {
		t.Errorf("expected empty list after delete, got %d", len(list))
	}
}

func TestCommentsAPI_FilterByFinding(t *testing.T) {
	router, database := setupEnv(t)

	// Create a finding directly in DB
	database.CreateFinding(&model.Finding{
		ID: "f1", Severity: "high", Title: "SQLi", Status: "open", Source: "mcp",
		Anchor: model.Anchor{FileID: "a.go", CommitID: "abc"},
	})

	// Comment linked to the finding
	linked := `{"id":"c1","author":"alice","text":"on finding","threadId":"t1","timestamp":"2024-01-01T00:00:00Z","findingId":"f1","anchor":{"fileId":"a.go","commitId":"abc"}}`
	req := httptest.NewRequest("POST", "/api/comments", strings.NewReader(linked))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 201 {
		t.Fatalf("create linked comment: %d %s", w.Code, w.Body.String())
	}

	// Standalone comment
	standalone := `{"id":"c2","author":"bob","text":"standalone","threadId":"t2","timestamp":"2024-01-02T00:00:00Z","anchor":{"fileId":"b.go","commitId":"abc"}}`
	req = httptest.NewRequest("POST", "/api/comments", strings.NewReader(standalone))
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	// Filter by findingId
	req = httptest.NewRequest("GET", "/api/comments?findingId=f1", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var list []model.Comment
	json.NewDecoder(w.Body).Decode(&list)
	if len(list) != 1 {
		t.Fatalf("filtered list len = %d, want 1", len(list))
	}
	if list[0].ID != "c1" {
		t.Errorf("got comment %q, want c1", list[0].ID)
	}
}
