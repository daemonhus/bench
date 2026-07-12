package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"bench/internal/model"
)

func callTool(t *testing.T, deps *toolDeps, name string, args map[string]any) (string, error) {
	t.Helper()
	tools := registerAllTools(deps)
	tool, ok := tools[name]
	if !ok {
		t.Fatalf("tool %s not registered", name)
	}
	b, _ := json.Marshal(args)
	return tool.Handler(context.Background(), b)
}

func TestMCPServiceProfile_GetDefault(t *testing.T) {
	deps := setupMCPDeps(t)

	out, err := callTool(t, deps, "get_service_profile", map[string]any{})
	if err != nil {
		t.Fatalf("get_service_profile: %v", err)
	}
	if !strings.Contains(out, "not configured") {
		t.Errorf("unconfigured get should say so, got: %s", out)
	}
	if !strings.Contains(out, `"edgeProtections": []`) {
		t.Errorf("expected empty array fields in schema dump, got: %s", out)
	}
}

func TestMCPServiceProfile_UpdatePartial(t *testing.T) {
	deps := setupMCPDeps(t)

	out, err := callTool(t, deps, "update_service_profile", map[string]any{
		"owner":             "platform-team",
		"externally_facing": "full",
		"edge_protections":  []any{"waf", "rate-limiting"},
	})
	if err != nil {
		t.Fatalf("update_service_profile: %v", err)
	}
	if !strings.Contains(out, "externally_facing") {
		t.Errorf("summary should name changed fields, got: %s", out)
	}

	// Second update touching a different field must not disturb the first.
	if _, err := callTool(t, deps, "update_service_profile", map[string]any{"criticality": "high"}); err != nil {
		t.Fatalf("second update: %v", err)
	}
	p, err := deps.db.GetServiceProfile()
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if p.Owner != "platform-team" || p.ExternallyFacing != "full" || p.Criticality != "high" {
		t.Errorf("partial overlay lost fields: %+v", p)
	}
	if len(p.EdgeProtections) != 2 {
		t.Errorf("array lost on unrelated update: %v", p.EdgeProtections)
	}

	// [] clears an array field.
	if _, err := callTool(t, deps, "update_service_profile", map[string]any{"edge_protections": []any{}}); err != nil {
		t.Fatalf("clear array: %v", err)
	}
	p, _ = deps.db.GetServiceProfile()
	if len(p.EdgeProtections) != 0 {
		t.Errorf("[] did not clear array: %v", p.EdgeProtections)
	}
}

func TestMCPServiceProfile_RejectsInvalid(t *testing.T) {
	deps := setupMCPDeps(t)

	if _, err := callTool(t, deps, "update_service_profile", map[string]any{"compute": "cloud"}); err == nil {
		t.Error("bad enum value accepted")
	} else if !strings.Contains(err.Error(), "compute") {
		t.Errorf("error does not name the field: %v", err)
	}

	if _, err := callTool(t, deps, "update_service_profile", map[string]any{
		"authentication_model": []any{"none", "api-key"},
	}); err == nil {
		t.Error("none-mixing accepted")
	} else if !strings.Contains(err.Error(), "cannot be combined") {
		t.Errorf("none-mixing error not instructive: %v", err)
	}

	// Rejected updates must not mark the profile configured.
	configured, err := deps.db.ProfileConfigured()
	if err != nil {
		t.Fatalf("ProfileConfigured: %v", err)
	}
	if configured {
		t.Error("rejected update marked profile configured")
	}
}

// TestMCPServiceProfile_RequiresProfileCoverage asserts the central gate
// assignment: every write-verb tool is gated, everything else is not.
func TestMCPServiceProfile_RequiresProfileCoverage(t *testing.T) {
	deps := setupMCPDeps(t)
	tools := registerAllTools(deps)

	writePrefixes := []string{"create_", "update_", "delete_", "batch_", "resolve_", "set_", "mark_"}
	isWriteName := func(name string) bool {
		for _, p := range writePrefixes {
			if strings.HasPrefix(name, p) {
				return true
			}
		}
		return false
	}
	for name, tool := range tools {
		isProfileTool := name == "get_service_profile" || name == "update_service_profile"
		wantGated := isWriteName(name) && !isProfileTool
		if tool.RequiresProfile != wantGated {
			t.Errorf("%s: RequiresProfile = %v, want %v", name, tool.RequiresProfile, wantGated)
		}
	}
}

func TestMCPServiceProfile_DispatcherGate(t *testing.T) {
	deps := setupMCPDeps(t)
	handler := &Handler{tools: registerAllTools(deps), db: deps.db, requireProfile: true}

	head, err := deps.repo.Head()
	if err != nil {
		t.Fatalf("head: %v", err)
	}
	createArgs := map[string]any{
		"name": "create_finding",
		"arguments": map[string]any{
			"file": "main.go", "commit": head,
			"severity": "high", "title": "t", "description": "d",
		},
	}

	// Gated tool errors with the instructive message while unconfigured.
	resp := rpcCall(t, handler, "tools/call", createArgs)
	body, _ := json.Marshal(resp.Result)
	if !strings.Contains(string(body), "isError") || !strings.Contains(string(body), "service profile not configured") {
		t.Errorf("expected gate error, got: %s", body)
	}

	// Reads and the profile tools pass through.
	resp = rpcCall(t, handler, "tools/call", map[string]any{
		"name": "update_service_profile", "arguments": map[string]any{"owner": "x"},
	})
	body, _ = json.Marshal(resp.Result)
	if strings.Contains(string(body), "isError") {
		t.Errorf("update_service_profile must be exempt, got: %s", body)
	}

	// After configuration the gated tool works.
	resp = rpcCall(t, handler, "tools/call", createArgs)
	body, _ = json.Marshal(resp.Result)
	if strings.Contains(string(body), "service profile not configured") {
		t.Errorf("still gated after configuration: %s", body)
	}

	// Gate disabled: fresh DB, requireProfile false.
	deps2 := setupMCPDeps(t)
	handler2 := &Handler{tools: registerAllTools(deps2), db: deps2.db, requireProfile: false}
	head2, _ := deps2.repo.Head()
	resp = rpcCall(t, handler2, "tools/call", map[string]any{
		"name": "create_finding",
		"arguments": map[string]any{
			"file": "main.go", "commit": head2,
			"severity": "high", "title": "t", "description": "d",
		},
	})
	body, _ = json.Marshal(resp.Result)
	if strings.Contains(string(body), "service profile not configured") {
		t.Errorf("gate disabled but still rejected: %s", body)
	}
}

func TestMCPServiceProfile_EmbeddedInSummaryAndDelta(t *testing.T) {
	deps := setupMCPDeps(t)

	// Unconfigured: summary carries the nudge.
	out, err := callTool(t, deps, "get_summary", map[string]any{})
	if err != nil {
		t.Fatalf("get_summary: %v", err)
	}
	if !strings.Contains(out, "### Service Profile") || !strings.Contains(out, "Not configured") {
		t.Errorf("unconfigured summary missing profile nudge:\n%s", out)
	}

	if err := deps.db.PutServiceProfile(model.ServiceProfile{
		Owner:   "platform-team",
		Tenancy: "multi-tenant",
	}); err != nil {
		t.Fatalf("put profile: %v", err)
	}
	if _, err := callTool(t, deps, "set_baseline", map[string]any{"reviewer": "test"}); err != nil {
		t.Fatalf("set_baseline: %v", err)
	}

	out, err = callTool(t, deps, "get_summary", map[string]any{})
	if err != nil {
		t.Fatalf("get_summary: %v", err)
	}
	if !strings.Contains(out, "tenancy: multi-tenant") {
		t.Errorf("configured summary missing profile fields:\n%s", out)
	}

	out, err = callTool(t, deps, "get_delta", map[string]any{})
	if err != nil {
		t.Fatalf("get_delta: %v", err)
	}
	if !strings.Contains(out, "owner: platform-team") {
		t.Errorf("delta missing profile fields:\n%s", out)
	}
}
