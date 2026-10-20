package api

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"bench/internal/model"
)

// PUT origin refuses keys it doesn't know (they used to be dropped silently), still takes
// the stored origin back as the UI sends it (updatedAt included), and GET returns it.
func TestOrigin_UnknownKeysAndGet(t *testing.T) {
	router, _ := setupEnv(t)
	body := `{"title":"t","severity":"low","anchor":{"fileId":"readme.txt","commitId":"HEAD","lineRange":{"start":1}}}`
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("POST", "/api/findings", strings.NewReader(body)))
	var f model.Finding
	json.NewDecoder(w.Body).Decode(&f)
	path := "/api/findings/" + f.ID + "/origin"

	call := func(method, body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(body)))
		return w
	}
	if w := call("GET", ""); w.Code != 200 || strings.TrimSpace(w.Body.String()) != "{}" {
		t.Errorf("GET with no origin = %d %s, want 200 {}", w.Code, w.Body.String())
	}
	if w := call("PUT", `{"explanation":"x","commit":"abc"}`); w.Code != 400 || !strings.Contains(w.Body.String(), "commit") {
		t.Errorf("PUT with an unknown key = %d %s, want 400 naming it", w.Code, w.Body.String())
	}
	if w := call("PUT", `{"explanation":"first","actor":"dev"}`); w.Code != 200 {
		t.Fatalf("PUT = %d %s", w.Code, w.Body.String())
	}
	// The UI sends back the whole stored origin, updatedAt included.
	var stored model.Origin
	json.NewDecoder(call("GET", "").Body).Decode(&stored)
	if stored.Explanation != "first" || stored.UpdatedAt == "" {
		t.Fatalf("GET after PUT = %+v", stored)
	}
	stored.Explanation = "second"
	b, _ := json.Marshal(stored)
	if w := call("PUT", string(b)); w.Code != 200 {
		t.Errorf("PUT of the stored origin (with updatedAt) = %d %s, want 200", w.Code, w.Body.String())
	}
	json.NewDecoder(call("GET", "").Body).Decode(&stored)
	if stored.Explanation != "second" || stored.Actor != "dev" {
		t.Errorf("GET after the round trip = %+v", stored)
	}
}
