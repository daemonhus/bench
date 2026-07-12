package main

// Flag-contract and integration tests for `bench profile get` / `bench profile set`.

import (
	"testing"
)

func TestFlagsContract_GET_ProfileGet(t *testing.T) {
	method, path, _ := parseAndBuild(t, "profile", "get", nil)
	if method != "GET" || path != "/api/profile" {
		t.Errorf("got %s %s, want GET /api/profile", method, path)
	}
}

func TestFlagsContract_PATCH_ProfileSet_AllFields(t *testing.T) {
	method, path, body := parseAndBuild(t, "profile", "set", []string{
		"--description", "Order API",
		"--owner", "platform-team",
		"--externally-facing", "full",
		"--compute", "kubernetes",
		"--data-sensitivity", "pii",
		"--criticality", "high",
		"--tenancy", "multi-tenant",
		"--lifecycle", "active",
		"--edge-protections", "waf,rate-limiting",
		"--compliance-scope", "pci-dss,gdpr",
		"--authentication-model", "oauth-oidc,gateway-terminated",
		"--consumer-type", "first-party-frontend",
	})
	if method != "PATCH" || path != "/api/profile" {
		t.Fatalf("got %s %s, want PATCH /api/profile", method, path)
	}
	requireField(t, body, "description", "Order API")
	requireField(t, body, "owner", "platform-team")
	requireField(t, body, "externallyFacing", "full")
	requireField(t, body, "compute", "kubernetes")
	requireField(t, body, "dataSensitivity", "pii")
	requireField(t, body, "criticality", "high")
	requireField(t, body, "tenancy", "multi-tenant")
	requireField(t, body, "lifecycle", "active")
	// list-type flags serialise as JSON arrays, not comma strings
	requireField(t, body, "edgeProtections", []string{"waf", "rate-limiting"})
	requireField(t, body, "complianceScope", []string{"pci-dss", "gdpr"})
	requireField(t, body, "authenticationModel", []string{"oauth-oidc", "gateway-terminated"})
	requireField(t, body, "consumerType", []string{"first-party-frontend"})
}

func TestFlagsContract_PATCH_ProfileSet_OmittedFlagsAbsent(t *testing.T) {
	// Partial-update guarantee: unsent flags must be absent from the body,
	// not sent as empty values (which would clear stored fields).
	_, _, body := parseAndBuild(t, "profile", "set", []string{"--owner", "security-team"})
	requireField(t, body, "owner", "security-team")
	for _, f := range []string{
		"description", "externallyFacing", "compute", "dataSensitivity",
		"criticality", "tenancy", "lifecycle",
		"edgeProtections", "complianceScope", "authenticationModel", "consumerType",
	} {
		requireNoField(t, body, f)
	}
}

func TestCLIIntegration_Profile_SetAndGet(t *testing.T) {
	srv, _ := setupIntegrationServer(t)

	result, code := cliDo(t, srv, "profile", "set", []string{
		"--owner", "platform-team",
		"--tenancy", "multi-tenant",
		"--edge-protections", "waf,rate-limiting",
	})
	if code != 200 {
		t.Fatalf("profile set = %d: %v", code, result)
	}

	result, code = cliDo(t, srv, "profile", "get", nil)
	if code != 200 {
		t.Fatalf("profile get = %d: %v", code, result)
	}
	if result["owner"] != "platform-team" || result["tenancy"] != "multi-tenant" {
		t.Errorf("profile fields not persisted: %v", result)
	}
	edge, ok := result["edgeProtections"].([]any)
	if !ok || len(edge) != 2 {
		t.Errorf("edgeProtections = %v, want 2-element array", result["edgeProtections"])
	}
	if result["updatedAt"] == "" || result["updatedAt"] == nil {
		t.Errorf("updatedAt not stamped: %v", result)
	}
}

func TestCLIIntegration_Profile_WriteGate(t *testing.T) {
	srv, head := setupIntegrationServerWithProfile(t, false)

	// Unconfigured: creating a finding is rejected with 412.
	result, code := cliDo(t, srv, "findings", "create", []string{
		"--file", "main.go", "--commit", head,
		"--severity", "high", "--title", "t",
	})
	if code != 412 {
		t.Fatalf("findings create on unconfigured profile = %d, want 412 (%v)", code, result)
	}

	// profile set is the bootstrap path - exempt from the gate.
	if _, code := cliDo(t, srv, "profile", "set", []string{"--owner", "x"}); code != 200 {
		t.Fatalf("profile set gated: %d", code)
	}

	// Now the write passes.
	result, code = cliDo(t, srv, "findings", "create", []string{
		"--file", "main.go", "--commit", head,
		"--severity", "high", "--title", "t",
	})
	if code != 201 && code != 200 {
		t.Fatalf("findings create after configure = %d (%v)", code, result)
	}
}
