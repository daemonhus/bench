package api

import (
	"encoding/json"
	"net/http"
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

func createFeatureREST(t *testing.T, router http.Handler, body string) model.Feature {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/features", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 201 {
		t.Fatalf("create feature: status=%d body=%s", w.Code, w.Body.String())
	}
	var f model.Feature
	json.NewDecoder(w.Body).Decode(&f)
	return f
}

func TestFeaturesAPI_LinkedFeatureIds_CreateAndGet(t *testing.T) {
	router, _ := setupEnv(t)

	a := createFeatureREST(t, router, `{"anchor":{"fileId":"a.go","commitId":"abc"},"kind":"interface","title":"A"}`)
	b := createFeatureREST(t, router, `{"anchor":{"fileId":"b.go","commitId":"abc"},"kind":"sink","title":"B"}`)

	// Create c linked to a and b
	body := `{"anchor":{"fileId":"c.go","commitId":"abc"},"kind":"source","title":"C","linkedFeatureIds":["` + a.ID + `","` + b.ID + `"]}`
	c := createFeatureREST(t, router, body)

	if len(c.LinkedFeatures) != 2 {
		t.Fatalf("create response: linkedFeatures len = %d, want 2", len(c.LinkedFeatures))
	}

	// GET should also return the links
	req := httptest.NewRequest("GET", "/api/features/"+c.ID, nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	var got model.Feature
	json.NewDecoder(w.Body).Decode(&got)
	if len(got.LinkedFeatures) != 2 {
		t.Errorf("get response: linkedFeatures len = %d, want 2", len(got.LinkedFeatures))
	}
}

func TestFeaturesAPI_LinkedFeatureIds_Update(t *testing.T) {
	router, _ := setupEnv(t)

	a := createFeatureREST(t, router, `{"anchor":{"fileId":"a.go","commitId":"abc"},"kind":"interface","title":"A"}`)
	b := createFeatureREST(t, router, `{"anchor":{"fileId":"b.go","commitId":"abc"},"kind":"sink","title":"B"}`)
	c := createFeatureREST(t, router, `{"anchor":{"fileId":"c.go","commitId":"abc"},"kind":"source","title":"C"}`)

	// Link c to a
	patch := `{"linkedFeatureIds":["` + a.ID + `"]}`
	req := httptest.NewRequest("PATCH", "/api/features/"+c.ID, strings.NewReader(patch))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("patch status = %d; body: %s", w.Code, w.Body.String())
	}
	var updated model.Feature
	json.NewDecoder(w.Body).Decode(&updated)
	if len(updated.LinkedFeatures) != 1 {
		t.Fatalf("after link: linkedFeatures = %v, want 1 item", updated.LinkedFeatures)
	}

	// Replace with b, clear a
	patch2 := `{"linkedFeatureIds":["` + b.ID + `"]}`
	req = httptest.NewRequest("PATCH", "/api/features/"+c.ID, strings.NewReader(patch2))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	var replaced model.Feature
	json.NewDecoder(w.Body).Decode(&replaced)
	if len(replaced.LinkedFeatures) != 1 || replaced.LinkedFeatures[0].ID != b.ID {
		t.Errorf("after replace: linkedFeatures = %v, want [%s]", replaced.LinkedFeatures, b.ID)
	}

	// Clear
	req = httptest.NewRequest("PATCH", "/api/features/"+c.ID, strings.NewReader(`{"linkedFeatureIds":[]}`))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	var cleared model.Feature
	json.NewDecoder(w.Body).Decode(&cleared)
	if len(cleared.LinkedFeatures) != 0 {
		t.Errorf("after clear: linkedFeatures = %v, want []", cleared.LinkedFeatures)
	}
}

func TestFeaturesAPI_LinkedTo_Filter(t *testing.T) {
	router, _ := setupEnv(t)

	a := createFeatureREST(t, router, `{"anchor":{"fileId":"a.go","commitId":"abc"},"kind":"interface","title":"A"}`)
	b := createFeatureREST(t, router, `{"anchor":{"fileId":"b.go","commitId":"abc"},"kind":"sink","title":"B"}`)
	createFeatureREST(t, router, `{"anchor":{"fileId":"c.go","commitId":"abc"},"kind":"source","title":"C"}`)

	patch := `{"linkedFeatureIds":["` + b.ID + `"]}`
	req := httptest.NewRequest("PATCH", "/api/features/"+a.ID, strings.NewReader(patch))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	// List linked to a → should return b only
	req = httptest.NewRequest("GET", "/api/features?linkedTo="+a.ID, nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	var list []model.Feature
	json.NewDecoder(w.Body).Decode(&list)
	if len(list) != 1 || list[0].ID != b.ID {
		t.Errorf("linkedTo=%s: got %v, want [%s]", a.ID, featureIDsREST(list), b.ID)
	}

	// From the other direction: linked to b → should return a
	req = httptest.NewRequest("GET", "/api/features?linkedTo="+b.ID, nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	json.NewDecoder(w.Body).Decode(&list)
	if len(list) != 1 || list[0].ID != a.ID {
		t.Errorf("linkedTo=%s: got %v, want [%s]", b.ID, featureIDsREST(list), a.ID)
	}
}

func TestFeaturesAPI_LinkedFeatureIds_NotFound(t *testing.T) {
	router, _ := setupEnv(t)

	body := `{"anchor":{"fileId":"a.go","commitId":"abc"},"kind":"interface","title":"A","linkedFeatureIds":["nonexistent-id"]}`
	req := httptest.NewRequest("POST", "/api/features", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != 404 {
		t.Fatalf("status = %d, want 404; body: %s", w.Code, w.Body.String())
	}
}

func TestFeaturesAPI_LinkedFeatureIds_SelfLink(t *testing.T) {
	router, _ := setupEnv(t)

	a := createFeatureREST(t, router, `{"anchor":{"fileId":"a.go","commitId":"abc"},"kind":"interface","title":"A"}`)

	// Attempt to link a feature to itself at create time
	body := `{"anchor":{"fileId":"b.go","commitId":"abc"},"kind":"sink","title":"B","linkedFeatureIds":["` + a.ID + `","` + a.ID + `"]}`
	req := httptest.NewRequest("POST", "/api/features", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	// Duplicate IDs in the same batch do not self-link, only the first unique link is stored.
	// But linking a feature to itself should be rejected.

	// Self-link via PATCH: try to link a to itself
	patch := `{"linkedFeatureIds":["` + a.ID + `"]}`
	req = httptest.NewRequest("PATCH", "/api/features/"+a.ID, strings.NewReader(patch))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 400 {
		t.Fatalf("self-link via PATCH: status = %d, want 400; body: %s", w.Code, w.Body.String())
	}
}

func featureIDsREST(features []model.Feature) []string {
	ids := make([]string, len(features))
	for i, f := range features {
		ids[i] = f.ID
	}
	return ids
}
