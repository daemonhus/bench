package api

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"bench/internal/model"
)

const minFeature = `{"anchor":{"fileId":"src/api.go","commitId":"abc"},"kind":"interface","title":"POST /login"}`

func TestFeaturesAPI_ListEmpty(t *testing.T) {
	router, _ := setupEnv(t)

	req := httptest.NewRequest("GET", "/api/features", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var list []model.Feature
	if err := json.NewDecoder(w.Body).Decode(&list); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(list) != 0 {
		t.Errorf("expected empty list, got %d", len(list))
	}
}

func TestFeaturesAPI_CreateAndList(t *testing.T) {
	router, _ := setupEnv(t)

	req := httptest.NewRequest("POST", "/api/features", strings.NewReader(minFeature))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 201 {
		t.Fatalf("create status = %d, want 201; body: %s", w.Code, w.Body.String())
	}
	var created model.Feature
	if err := json.NewDecoder(w.Body).Decode(&created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.ID == "" {
		t.Error("id should be set")
	}
	if created.Status != "active" {
		t.Errorf("status = %q, want active", created.Status)
	}

	req = httptest.NewRequest("GET", "/api/features", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	var list []model.Feature
	json.NewDecoder(w.Body).Decode(&list)
	if len(list) != 1 {
		t.Fatalf("list len = %d, want 1", len(list))
	}
	if list[0].Title != "POST /login" {
		t.Errorf("title = %q, want POST /login", list[0].Title)
	}
}

func TestFeaturesAPI_Get(t *testing.T) {
	router, _ := setupEnv(t)

	req := httptest.NewRequest("POST", "/api/features", strings.NewReader(minFeature))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	var created model.Feature
	json.NewDecoder(w.Body).Decode(&created)

	req = httptest.NewRequest("GET", "/api/features/"+created.ID, nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("get status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var got model.Feature
	json.NewDecoder(w.Body).Decode(&got)
	if got.ID != created.ID {
		t.Errorf("id = %q, want %q", got.ID, created.ID)
	}
}

func TestFeaturesAPI_GetNotFound(t *testing.T) {
	router, _ := setupEnv(t)

	req := httptest.NewRequest("GET", "/api/features/nonexistent", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 404 {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

func TestFeaturesAPI_Update(t *testing.T) {
	router, _ := setupEnv(t)

	req := httptest.NewRequest("POST", "/api/features", strings.NewReader(minFeature))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	var created model.Feature
	json.NewDecoder(w.Body).Decode(&created)

	req = httptest.NewRequest("PATCH", "/api/features/"+created.ID, strings.NewReader(`{"status":"deprecated","title":"POST /login (old)"}`))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("update status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var updated model.Feature
	json.NewDecoder(w.Body).Decode(&updated)
	if updated.Status != "deprecated" {
		t.Errorf("status = %q, want deprecated", updated.Status)
	}
	if updated.Title != "POST /login (old)" {
		t.Errorf("title = %q, want POST /login (old)", updated.Title)
	}
}

func TestFeaturesAPI_Delete(t *testing.T) {
	router, _ := setupEnv(t)

	req := httptest.NewRequest("POST", "/api/features", strings.NewReader(minFeature))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	var created model.Feature
	json.NewDecoder(w.Body).Decode(&created)

	req = httptest.NewRequest("DELETE", "/api/features/"+created.ID, nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 204 {
		t.Fatalf("delete status = %d, want 204", w.Code)
	}

	req = httptest.NewRequest("GET", "/api/features/"+created.ID, nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 404 {
		t.Fatalf("after delete, get status = %d, want 404", w.Code)
	}
}

func TestFeaturesAPI_DeleteNotFound(t *testing.T) {
	router, _ := setupEnv(t)

	req := httptest.NewRequest("DELETE", "/api/features/nonexistent", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 404 {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

func TestFeaturesAPI_CreateMissingFields(t *testing.T) {
	router, _ := setupEnv(t)

	// Missing kind
	body := `{"anchor":{"fileId":"src/a.go","commitId":"abc"},"title":"foo"}`
	req := httptest.NewRequest("POST", "/api/features", strings.NewReader(body))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 400 {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestFeaturesAPI_ListFilterByKind(t *testing.T) {
	router, _ := setupEnv(t)

	for _, body := range []string{
		`{"anchor":{"fileId":"a.go","commitId":"abc"},"kind":"interface","title":"iface"}`,
		`{"anchor":{"fileId":"a.go","commitId":"abc"},"kind":"sink","title":"sink"}`,
	} {
		req := httptest.NewRequest("POST", "/api/features", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != 201 {
			t.Fatalf("create: %d %s", w.Code, w.Body.String())
		}
	}

	req := httptest.NewRequest("GET", "/api/features?kind=sink", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	var list []model.Feature
	json.NewDecoder(w.Body).Decode(&list)
	if len(list) != 1 {
		t.Fatalf("filtered list len = %d, want 1", len(list))
	}
	if list[0].Kind != "sink" {
		t.Errorf("kind = %q, want sink", list[0].Kind)
	}
}

// TestFeaturesAPI_LineRangeEndOmitted verifies that lineRange.end absent
// (deserializes as 0) does not panic the server.
func TestFeaturesAPI_LineRangeEndOmitted(t *testing.T) {
	router, _ := setupEnv(t)

	body := `{"id":"feat1","anchor":{"fileId":"readme.txt","commitId":"HEAD","lineRange":{"start":1}},"kind":"interface","title":"Login"}`
	req := httptest.NewRequest("POST", "/api/features", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 201 {
		t.Fatalf("status = %d, want 201; body: %s", w.Code, w.Body.String())
	}
}

// TestFeaturesAPI_LineRangeInverted verifies that start > end does not panic.
func TestFeaturesAPI_LineRangeInverted(t *testing.T) {
	router, _ := setupEnv(t)

	body := `{"id":"feat1","anchor":{"fileId":"readme.txt","commitId":"HEAD","lineRange":{"start":5,"end":2}},"kind":"interface","title":"Login"}`
	req := httptest.NewRequest("POST", "/api/features", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 201 {
		t.Fatalf("status = %d, want 201; body: %s", w.Code, w.Body.String())
	}
}
