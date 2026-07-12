package mcp

import (
	"strings"
	"testing"
)

// newFindingForOrigin creates a finding and returns its ID.
func newFindingForOrigin(t *testing.T, deps *toolDeps) string {
	t.Helper()
	out, err := callTool(t, deps, "create_finding", map[string]any{
		"title":       "Origin subject",
		"description": "A finding that exists so its origin can be set and cleared.",
		"severity":    "high",
		"file":        "main.go",
		"commit":      "HEAD",
		"start":       1,
		"end":         2,
	})
	if err != nil {
		t.Fatalf("create_finding: %v", err)
	}
	id := findingIDFrom(t, out)
	return id
}

// findingIDFrom pulls the generated ID out of the create response, which reads
// "Created finding <id>: <title> (<severity>)".
func findingIDFrom(t *testing.T, out string) string {
	t.Helper()
	const key = "Created finding "
	i := strings.Index(out, key)
	if i < 0 {
		t.Fatalf("no id in create response: %s", out)
	}
	rest := out[i+len(key):]
	j := strings.Index(rest, ":")
	if j < 0 {
		t.Fatalf("unterminated id in create response: %s", out)
	}
	return strings.TrimSpace(rest[:j])
}

func TestMCPClearOrigin_RemovesTheRecord(t *testing.T) {
	deps := setupMCPDeps(t)
	id := newFindingForOrigin(t, deps)

	if _, err := callTool(t, deps, "set_finding_origin", map[string]any{
		"id":          id,
		"explanation": "Landed with the SSO work",
		"actor":       "erin",
	}); err != nil {
		t.Fatalf("set_finding_origin: %v", err)
	}
	if o, err := deps.db.GetOrigin("finding", id); err != nil || o == nil {
		t.Fatalf("origin should exist before clearing (err=%v, origin=%v)", err, o)
	}

	out, err := callTool(t, deps, "clear_finding_origin", map[string]any{"id": id})
	if err != nil {
		t.Fatalf("clear_finding_origin: %v", err)
	}
	if !strings.Contains(out, "cleared") {
		t.Errorf("expected a cleared confirmation, got: %s", out)
	}

	o, err := deps.db.GetOrigin("finding", id)
	if err != nil {
		t.Fatalf("GetOrigin after clear: %v", err)
	}
	if o != nil {
		t.Errorf("origin still present after clear: %+v", o)
	}

	// The finding itself must survive: only its origin is removed.
	if _, err := deps.db.GetFinding(id); err != nil {
		t.Errorf("clearing an origin deleted the finding: %v", err)
	}
}

// Clearing an origin that was never set is a no-op, not an error: the caller's
// intent (no origin on this finding) is satisfied either way.
func TestMCPClearOrigin_UnsetIsNotAnError(t *testing.T) {
	deps := setupMCPDeps(t)
	id := newFindingForOrigin(t, deps)

	if _, err := callTool(t, deps, "clear_finding_origin", map[string]any{"id": id}); err != nil {
		t.Errorf("clearing an unset origin should not error: %v", err)
	}
}

func TestMCPClearOrigin_UnknownEntity(t *testing.T) {
	deps := setupMCPDeps(t)

	if _, err := callTool(t, deps, "clear_finding_origin", map[string]any{"id": "nope"}); err == nil {
		t.Error("clearing the origin of a non-existent finding should error")
	}
}

// clear_* records review judgment, so it sits behind the profile write gate
// like every other write. The gate keys off the name prefix.
func TestMCPClearOrigin_RequiresProfile(t *testing.T) {
	for _, name := range []string{"clear_finding_origin", "clear_feature_origin"} {
		if !requiresProfile(name) {
			t.Errorf("%s should be gated behind the service profile", name)
		}
	}
}

func TestMCPClearOrigin_RegisteredForBothEntities(t *testing.T) {
	deps := setupMCPDeps(t)
	tools := registerAllTools(deps)
	for _, name := range []string{"clear_finding_origin", "clear_feature_origin"} {
		if _, ok := tools[name]; !ok {
			t.Errorf("tool %s is not registered", name)
		}
	}
}
