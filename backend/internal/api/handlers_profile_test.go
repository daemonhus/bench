package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"bench/internal/events"
	"bench/internal/model"
)

func doJSON(t *testing.T, router http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func decodeProfile(t *testing.T, rec *httptest.ResponseRecorder) model.ServiceProfile {
	t.Helper()
	var p model.ServiceProfile
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatalf("decode profile: %v (body: %s)", err, rec.Body.String())
	}
	return p
}

func TestProfile_GetDefault(t *testing.T) {
	repo, database := setupRepoAndDB(t)
	router := NewRouter(repo, database, nil)

	rec := doJSON(t, router, "GET", "/api/profile", "")
	if rec.Code != 200 {
		t.Fatalf("GET /api/profile = %d, want 200 (reads are never gated)", rec.Code)
	}
	// Arrays must serialise as [] not null.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, f := range []string{"edgeProtections", "complianceScope", "authenticationModel", "consumerType"} {
		if string(raw[f]) != "[]" {
			t.Errorf("%s = %s, want []", f, raw[f])
		}
	}
}

func TestProfile_PatchPartialOverlay(t *testing.T) {
	router, _ := setupEnv(t)

	rec := doJSON(t, router, "PATCH", "/api/profile",
		`{"owner":"platform-team","externallyFacing":"full","edgeProtections":["waf","rate-limiting"]}`)
	if rec.Code != 200 {
		t.Fatalf("PATCH = %d: %s", rec.Code, rec.Body.String())
	}
	p := decodeProfile(t, rec)
	if p.Owner != "platform-team" || p.ExternallyFacing != "full" {
		t.Errorf("fields not set: %+v", p)
	}
	if p.UpdatedAt == "" {
		t.Error("updatedAt not stamped")
	}

	// Second PATCH touching different fields must not disturb the first.
	rec = doJSON(t, router, "PATCH", "/api/profile", `{"criticality":"high"}`)
	p = decodeProfile(t, rec)
	if p.Owner != "platform-team" || p.ExternallyFacing != "full" || p.Criticality != "high" {
		t.Errorf("partial overlay lost fields: %+v", p)
	}
	if len(p.EdgeProtections) != 2 {
		t.Errorf("array lost on unrelated patch: %v", p.EdgeProtections)
	}

	// Arrays replace wholesale; [] clears back to unconfigured.
	rec = doJSON(t, router, "PATCH", "/api/profile", `{"edgeProtections":[]}`)
	p = decodeProfile(t, rec)
	if len(p.EdgeProtections) != 0 {
		t.Errorf("[] did not clear array: %v", p.EdgeProtections)
	}
	if p.Owner != "platform-team" {
		t.Errorf("clearing array disturbed other fields: %+v", p)
	}
}

func TestProfile_PatchValidation(t *testing.T) {
	router, _ := setupEnv(t)

	cases := []struct {
		name, body, wantSubstr string
	}{
		{"bad single enum", `{"externallyFacing":"yes"}`, "externallyFacing"},
		{"bad multi member", `{"edgeProtections":["firewall"]}`, "edgeProtections"},
		{"none mixed", `{"authenticationModel":["none","api-key"]}`, "cannot be combined"},
		{"wrong type", `{"edgeProtections":"waf"}`, "edgeProtections"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := doJSON(t, router, "PATCH", "/api/profile", tc.body)
			if rec.Code != 400 {
				t.Fatalf("code = %d, want 400 (body: %s)", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.wantSubstr) {
				t.Errorf("error %q does not name the problem (%q)", rec.Body.String(), tc.wantSubstr)
			}
		})
	}

	// A rejected PATCH must not partially apply.
	rec := doJSON(t, router, "GET", "/api/profile", "")
	p := decodeProfile(t, rec)
	if p.ExternallyFacing != "" || len(p.EdgeProtections) != 0 {
		t.Errorf("rejected PATCH leaked state: %+v", p)
	}
}

func TestProfile_WriteGate(t *testing.T) {
	repo, database := setupRepoAndDB(t)
	router := NewRouter(repo, database, nil)

	// Every review-judgment write must 412 while unconfigured.
	gated := []struct{ method, path, body string }{
		{"POST", "/api/findings", `{}`},
		{"PATCH", "/api/findings/test-id", `{}`},
		{"DELETE", "/api/findings/test-id", ""},
		{"POST", "/api/comments", `{}`},
		{"PATCH", "/api/comments/test-id", `{}`},
		{"DELETE", "/api/comments/test-id", ""},
		{"POST", "/api/features", `{}`},
		{"PATCH", "/api/features/test-id", `{}`},
		{"DELETE", "/api/features/test-id", ""},
		{"POST", "/api/features/test-id/parameters", `{}`},
		{"POST", "/api/refs", `{}`},
		{"PATCH", "/api/refs/test-id", `{}`},
		{"DELETE", "/api/refs/test-id", ""},
		{"POST", "/api/baselines", `{}`},
		{"DELETE", "/api/baselines/test-id", ""},
		{"POST", "/api/coverage/mark", `{}`},
	}
	for _, r := range gated {
		rec := doJSON(t, router, r.method, r.path, r.body)
		if rec.Code != http.StatusPreconditionFailed {
			t.Errorf("%s %s = %d, want 412 while unconfigured", r.method, r.path, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "service profile not configured") {
			t.Errorf("%s %s error body not instructive: %s", r.method, r.path, rec.Body.String())
		}
	}

	// Exempt surfaces must not 412: reads, profile itself, settings, reconcile.
	exempt := []struct{ method, path, body string }{
		{"GET", "/api/findings", ""},
		{"GET", "/api/summary", ""},
		{"GET", "/api/baselines", ""},
		{"PATCH", "/api/profile", `{}`},
		{"PUT", "/api/settings", `{}`},
		{"POST", "/api/reconcile", `{}`},
	}
	// Note: the PATCH /api/profile above also configures the profile.
	for _, r := range exempt {
		rec := doJSON(t, router, r.method, r.path, r.body)
		if rec.Code == http.StatusPreconditionFailed {
			t.Errorf("%s %s = 412, must be exempt from the gate", r.method, r.path)
		}
	}

	// After configuration, previously-gated writes pass the gate.
	rec := doJSON(t, router, "POST", "/api/findings", `{}`)
	if rec.Code == http.StatusPreconditionFailed {
		t.Errorf("POST /api/findings still 412 after profile configured")
	}
}

func TestProfile_GateDisabled(t *testing.T) {
	repo, database := setupRepoAndDB(t)
	router := NewRouter(repo, database, nil, WithRequireProfile(false))

	rec := doJSON(t, router, "POST", "/api/findings", `{}`)
	if rec.Code == http.StatusPreconditionFailed {
		t.Errorf("gate disabled but POST /api/findings = 412")
	}
}

func TestProfile_EventBroadcast(t *testing.T) {
	repo, database := setupRepoAndDB(t)
	broker := events.NewBroker()
	router := NewRouter(repo, database, broker)

	_, ch := broker.Subscribe()
	rec := doJSON(t, router, "PATCH", "/api/profile", `{"owner":"x"}`)
	if rec.Code != 200 {
		t.Fatalf("PATCH = %d: %s", rec.Code, rec.Body.String())
	}
	select {
	case topic := <-ch:
		if topic != events.TopicProfile {
			t.Errorf("topic = %q, want %q", topic, events.TopicProfile)
		}
	case <-time.After(time.Second):
		t.Error("no profile.updated event published")
	}
}

func TestProfile_EmbeddedInSummaryAndDelta(t *testing.T) {
	repo, database := setupRepoAndDB(t)
	router := NewRouter(repo, database, nil)

	// Unconfigured → serviceProfile is null in summary.
	rec := doJSON(t, router, "GET", "/api/summary", "")
	var summary map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &summary); err != nil {
		t.Fatalf("decode summary: %v", err)
	}
	if string(summary["serviceProfile"]) != "null" {
		t.Errorf("unconfigured summary serviceProfile = %s, want null", summary["serviceProfile"])
	}

	// Configure, create a baseline, then both summary and delta embed it.
	doJSON(t, router, "PATCH", "/api/profile", `{"owner":"platform-team","tenancy":"multi-tenant"}`)
	if rec := doJSON(t, router, "POST", "/api/baselines", `{"reviewer":"test"}`); rec.Code >= 300 {
		t.Fatalf("create baseline: %d %s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, router, "GET", "/api/summary", "")
	if err := json.Unmarshal(rec.Body.Bytes(), &summary); err != nil {
		t.Fatalf("decode summary: %v", err)
	}
	var p model.ServiceProfile
	if err := json.Unmarshal(summary["serviceProfile"], &p); err != nil || p.Owner != "platform-team" {
		t.Errorf("summary serviceProfile = %s, want embedded profile (err=%v)", summary["serviceProfile"], err)
	}

	rec = doJSON(t, router, "GET", "/api/baselines/delta", "")
	if rec.Code != 200 {
		t.Fatalf("GET delta = %d: %s", rec.Code, rec.Body.String())
	}
	var delta model.BaselineDelta
	if err := json.Unmarshal(rec.Body.Bytes(), &delta); err != nil {
		t.Fatalf("decode delta: %v", err)
	}
	if delta.ServiceProfile == nil || delta.ServiceProfile.Tenancy != "multi-tenant" {
		t.Errorf("delta serviceProfile = %+v, want embedded profile", delta.ServiceProfile)
	}
}
