package api

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"bench/internal/model"
)

func TestFeatureParamsAPI_CRUD(t *testing.T) {
	router, _ := setupEnv(t)

	// Create a feature first.
	req := httptest.NewRequest("POST", "/api/features", strings.NewReader(minFeature))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 201 {
		t.Fatalf("create feature: %d — %s", w.Code, w.Body.String())
	}
	var feat model.Feature
	json.NewDecoder(w.Body).Decode(&feat)

	paramPath := "/api/features/" + feat.ID + "/parameters"

	// --- List (empty) ---
	req = httptest.NewRequest("GET", paramPath, nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("list params: %d", w.Code)
	}
	var list []model.FeatureParameter
	json.NewDecoder(w.Body).Decode(&list)
	if len(list) != 0 {
		t.Errorf("expected empty list, got %d", len(list))
	}

	// --- Feature GET includes empty parameters ---
	req = httptest.NewRequest("GET", "/api/features/"+feat.ID, nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	var gotFeat model.Feature
	json.NewDecoder(w.Body).Decode(&gotFeat)
	if gotFeat.Parameters == nil {
		t.Error("feature.parameters should be [] not null")
	}

	// --- Create a parameter ---
	body := `{"name":"user_id","type":"string","required":true,"description":"The user","pattern":"UUID"}`
	req = httptest.NewRequest("POST", paramPath, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 201 {
		t.Fatalf("create param: %d — %s", w.Code, w.Body.String())
	}
	var p model.FeatureParameter
	json.NewDecoder(w.Body).Decode(&p)
	if p.ID == "" {
		t.Error("id should be set")
	}
	if p.Name != "user_id" {
		t.Errorf("name = %q, want user_id", p.Name)
	}
	if !p.Required {
		t.Error("required should be true")
	}
	if p.FeatureID != feat.ID {
		t.Errorf("featureId = %q, want %q", p.FeatureID, feat.ID)
	}

	// --- List (one item) ---
	req = httptest.NewRequest("GET", paramPath, nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	json.NewDecoder(w.Body).Decode(&list)
	if len(list) != 1 {
		t.Fatalf("list len = %d, want 1", len(list))
	}

	// --- Feature GET includes parameter ---
	req = httptest.NewRequest("GET", "/api/features/"+feat.ID, nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	json.NewDecoder(w.Body).Decode(&gotFeat)
	if len(gotFeat.Parameters) != 1 {
		t.Errorf("feature.parameters len = %d, want 1", len(gotFeat.Parameters))
	}

	// --- Update parameter ---
	pidPath := fmt.Sprintf("%s/%s", paramPath, p.ID)
	req = httptest.NewRequest("PATCH", pidPath, strings.NewReader(`{"name":"uid","required":false}`))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("update param: %d — %s", w.Code, w.Body.String())
	}
	var updated model.FeatureParameter
	json.NewDecoder(w.Body).Decode(&updated)
	if updated.Name != "uid" {
		t.Errorf("name = %q, want uid", updated.Name)
	}
	if updated.Required {
		t.Error("required should be false after update")
	}

	// --- Delete parameter ---
	req = httptest.NewRequest("DELETE", pidPath, nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 204 {
		t.Fatalf("delete param: %d", w.Code)
	}

	// --- List (empty again) ---
	req = httptest.NewRequest("GET", paramPath, nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	json.NewDecoder(w.Body).Decode(&list)
	if len(list) != 0 {
		t.Errorf("expected empty list after delete, got %d", len(list))
	}
}

func TestFeatureParamsAPI_CreateWithParameters(t *testing.T) {
	router, _ := setupEnv(t)

	body := `{
		"anchor":{"fileId":"src/api.go","commitId":"abc"},
		"kind":"interface","title":"Login",
		"parameters":[
			{"name":"Authorization","type":"string","required":true,"description":"Bearer token"},
			{"name":"limit","type":"integer","required":false}
		]
	}`
	req := httptest.NewRequest("POST", "/api/features", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 201 {
		t.Fatalf("create: %d — %s", w.Code, w.Body.String())
	}
	var feat model.Feature
	json.NewDecoder(w.Body).Decode(&feat)
	if len(feat.Parameters) != 2 {
		t.Fatalf("parameters len = %d, want 2", len(feat.Parameters))
	}
	// Parameters are sorted by name: Authorization < limit
	if feat.Parameters[0].Name != "Authorization" {
		t.Errorf("params[0].name = %q, want Authorization", feat.Parameters[0].Name)
	}
	if !feat.Parameters[0].Required {
		t.Error("Authorization should be required")
	}
}

func TestFeatureParamsAPI_PatchReplaces(t *testing.T) {
	router, _ := setupEnv(t)

	// Create feature with one parameter.
	body := `{"anchor":{"fileId":"f.go","commitId":"abc"},"kind":"interface","title":"EP","parameters":[{"name":"x","type":"string","required":true}]}`
	req := httptest.NewRequest("POST", "/api/features", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	var feat model.Feature
	json.NewDecoder(w.Body).Decode(&feat)
	if len(feat.Parameters) != 1 {
		t.Fatalf("expected 1 parameter after create, got %d", len(feat.Parameters))
	}

	// PATCH with new parameters list.
	patch := `{"parameters":[{"name":"y","required":false},{"name":"z","required":true}]}`
	req = httptest.NewRequest("PATCH", "/api/features/"+feat.ID, strings.NewReader(patch))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("patch: %d — %s", w.Code, w.Body.String())
	}
	var patched model.Feature
	json.NewDecoder(w.Body).Decode(&patched)
	if len(patched.Parameters) != 2 {
		t.Fatalf("parameters len = %d, want 2 after replace", len(patched.Parameters))
	}
}

func TestFeatureParamsAPI_DeleteFeatureCleansParams(t *testing.T) {
	router, database := setupEnv(t)

	// Create feature with a parameter.
	body := `{"anchor":{"fileId":"f.go","commitId":"abc"},"kind":"interface","title":"EP","parameters":[{"name":"x","required":true}]}`
	req := httptest.NewRequest("POST", "/api/features", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	var feat model.Feature
	json.NewDecoder(w.Body).Decode(&feat)

	// Delete feature.
	req = httptest.NewRequest("DELETE", "/api/features/"+feat.ID, nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 204 {
		t.Fatalf("delete: %d", w.Code)
	}

	// Parameters should be gone.
	params, err := database.ListParameters(feat.ID)
	if err != nil {
		t.Fatalf("list params: %v", err)
	}
	if len(params) != 0 {
		t.Errorf("expected 0 params after feature delete, got %d", len(params))
	}
}
