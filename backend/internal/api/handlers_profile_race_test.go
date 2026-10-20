package api

import (
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"bench/internal/model"
)

// Overlapping partial PATCHes, each setting a different field, all survive. The UI saves
// each edit as it's made, and the handler used to read the profile outside the write queue,
// overlay the body and write the whole profile back, so a concurrent PATCH's field was lost.
func TestProfilePatch_ConcurrentFieldsAllSurvive(t *testing.T) {
	router, database := setupEnv(t)
	for round := 0; round < 25; round++ {
		pick := func(vals []string) string { return vals[round%len(vals)] }
		fields := map[string]string{
			"description":      fmt.Sprintf("round %d", round),
			"owner":            fmt.Sprintf("team-%d", round),
			"externallyFacing": pick(model.ProfileExternallyFacingValues),
			"compute":          pick(model.ProfileComputeValues),
			"criticality":      pick(model.ProfileCriticalityValues),
			"tenancy":          pick(model.ProfileTenancyValues),
			"lifecycle":        pick(model.ProfileLifecycleValues),
		}
		var wg sync.WaitGroup
		for k, v := range fields {
			wg.Add(1)
			go func(k, v string) {
				defer wg.Done()
				w := httptest.NewRecorder()
				router.ServeHTTP(w, httptest.NewRequest("PATCH", "/api/profile", strings.NewReader(fmt.Sprintf(`{%q:%q}`, k, v))))
				if w.Code != 200 {
					t.Errorf("PATCH %s: %d %s", k, w.Code, w.Body.String())
				}
			}(k, v)
		}
		wg.Wait()
		p, err := database.GetServiceProfile()
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]string{
			"description": p.Description, "owner": p.Owner, "externallyFacing": p.ExternallyFacing,
			"compute": p.Compute, "criticality": p.Criticality, "tenancy": p.Tenancy, "lifecycle": p.Lifecycle,
		}
		for k, want := range fields {
			if got[k] != want {
				t.Fatalf("round %d: %s = %q, want %q (lost to a concurrent PATCH)", round, k, got[k], want)
			}
		}
	}
}
