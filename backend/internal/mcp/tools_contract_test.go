package mcp

// TestMCPToolRequiredFields verifies that:
//  1. Each MCP tool's JSON schema "required" field declarations are actually enforced by the handler.
//  2. Providing all required fields does not produce a "required" error.
//
// This test is the canonical check for required/optional drift between schema and handler.
// When you add a new required field to a tool's InputSchema, add it to the validArgs
// entry for that tool in the cases table below.
//
// The coverage check at the top of the test ensures every tool with required fields
// appears in the table — adding a tool without a test case will fail this test.

import (
	"context"
	"encoding/json"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"bench/internal/db"
	"bench/internal/git"
	"bench/internal/model"
	"bench/internal/reconcile"
)

// setupMCPDeps creates a real git repo + database and returns a toolDeps.
func setupMCPDeps(t *testing.T) *toolDeps {
	t.Helper()
	dir := t.TempDir()

	for _, args := range [][]string{
		{"git", "init", dir},
		{"git", "-C", dir, "config", "user.email", "test@test.com"},
		{"git", "-C", dir, "config", "user.name", "Test"},
	} {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("git setup %v: %s", err, out)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\nfunc main() {}\n"), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	for _, args := range [][]string{
		{"git", "-C", dir, "add", "."},
		{"git", "-C", dir, "commit", "-m", "initial"},
	} {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("git commit %v: %s", err, out)
		}
	}

	database, err := db.Open(filepath.Join(dir, "test.db"), "test")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { database.Close() })

	repo := git.NewRepo(dir)
	rec := reconcile.NewReconciler(repo, database, database, database, reconcile.WithResolver(database))
	return &toolDeps{db: database, repo: repo, reconciler: rec}
}

func TestMCPToolRequiredFields(t *testing.T) {
	deps := setupMCPDeps(t)
	head, err := deps.repo.Head()
	if err != nil {
		t.Fatalf("resolve HEAD: %v", err)
	}
	ctx := context.Background()
	tools := registerAllTools(deps)

	// Each entry: the tool name and a valid minimal set of arguments
	// (all required fields present, with real or plausible values).
	// Non-existent IDs are fine — the test only cares that the handler
	// doesn't return a "required" error, not that the operation succeeds.
	cases := []struct {
		tool      string
		validArgs map[string]any
	}{
		// git
		{"search_code", map[string]any{"pattern": "main"}},
		{"get_blame", map[string]any{"path": "main.go"}},
		{"read_file", map[string]any{"path": "main.go"}},
		{"read_files", map[string]any{"paths": []any{"main.go"}}},
		{"get_diff", map[string]any{"from_commit": head, "to_commit": head}},
		{"list_changed_files", map[string]any{"from_commit": head, "to_commit": head}},
		// findings
		{"get_finding", map[string]any{"id": "nonexistent"}},
		{"create_finding", map[string]any{
			"file": "main.go", "commit": head,
			"severity": "high", "title": "test finding", "description": "test description",
		}},
		{"update_finding", map[string]any{"id": "nonexistent", "title": "updated"}},
		{"delete_finding", map[string]any{"id": "nonexistent"}},
		{"resolve_finding", map[string]any{"id": "nonexistent", "commit": head}},
		{"batch_create_findings", map[string]any{"findings": []any{map[string]any{
			"file": "main.go", "commit": head,
			"severity": "high", "title": "t", "description": "d",
		}}}},
		{"search_findings", map[string]any{"query": "test"}},
		// comments
		{"get_comment", map[string]any{"id": "nonexistent"}},
		{"create_comment", map[string]any{
			"file": "main.go", "commit": head, "text": "hello", "author": "alice",
		}},
		{"update_comment", map[string]any{"id": "nonexistent", "text": "updated", "author": "bob"}},
		{"delete_comment", map[string]any{"id": "nonexistent"}},
		{"resolve_comment", map[string]any{"id": "nonexistent", "commit": head}},
		{"batch_create_comments", map[string]any{"comments": []any{map[string]any{
			"file": "main.go", "commit": head, "text": "t", "author": "a",
		}}}},
		// features
		{"get_feature", map[string]any{"id": "nonexistent"}},
		{"create_feature", map[string]any{
			"file": "main.go", "commit": head, "kind": "interface", "title": "Login endpoint",
		}},
		{"update_feature", map[string]any{"id": "nonexistent", "title": "updated"}},
		{"delete_feature", map[string]any{"id": "nonexistent"}},
		{"batch_create_features", map[string]any{"features": []any{map[string]any{
			"file": "main.go", "commit": head, "kind": "interface", "title": "t",
		}}}},
		// baselines
		{"delete_baseline", map[string]any{"baseline_id": "nonexistent"}},
		// reconcile
		{"get_annotation_history", map[string]any{"id": "nonexistent", "type": "finding"}},
		// analytics
		{"mark_reviewed", map[string]any{"path": "main.go", "commit": head}},
		// feature parameters
		{"list_feature_parameters", map[string]any{"feature_id": "nonexistent"}},
		{"create_feature_parameter", map[string]any{"feature_id": "nonexistent", "name": "user_id"}},
		{"update_feature_parameter", map[string]any{"id": "nonexistent", "name": "updated"}},
		{"delete_feature_parameter", map[string]any{"id": "nonexistent"}},
		// refs
		{"get_ref", map[string]any{"id": "nonexistent"}},
		{"create_ref", map[string]any{
			"entity_type": "finding", "entity_id": "f-1", "provider": "jira", "url": "https://jira.example.com/PROJ-1",
		}},
		{"update_ref", map[string]any{"id": "nonexistent", "url": "https://updated.example.com"}},
		{"delete_ref", map[string]any{"id": "nonexistent"}},
		{"batch_create_refs", map[string]any{"refs": []any{map[string]any{
			"entity_type": "finding", "entity_id": "f-1", "provider": "url", "url": "https://example.com",
		}}}},
	}

	// Coverage check: every registered tool with declared required fields must have a case.
	covered := make(map[string]bool, len(cases))
	for _, tc := range cases {
		covered[tc.tool] = true
	}
	for name, tool := range tools {
		var schema struct {
			Required []string `json:"required"`
		}
		json.Unmarshal(tool.InputSchema, &schema) //nolint:errcheck
		if len(schema.Required) > 0 && !covered[name] {
			t.Errorf("tool %q has required fields in schema but no entry in cases table — add it", name)
		}
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.tool, func(t *testing.T) {
			tool, ok := tools[tc.tool]
			if !ok {
				t.Fatalf("tool %q not registered", tc.tool)
			}

			var schema struct {
				Required []string `json:"required"`
			}
			if err := json.Unmarshal(tool.InputSchema, &schema); err != nil || len(schema.Required) == 0 {
				t.Skip("no required fields declared in schema")
			}

			// Providing all required fields must not produce a required-field error.
			// (Other errors like "not found" are acceptable.)
			t.Run("valid_args_no_required_error", func(t *testing.T) {
				params, _ := json.Marshal(tc.validArgs)
				_, err := tool.Handler(ctx, params)
				if err != nil && isRequiredFieldError(err) {
					t.Errorf("got required-field error despite providing all required fields: %v", err)
				}
			})

			// Omitting each required field must produce an error.
			for _, req := range schema.Required {
				req := req
				t.Run("missing_"+req, func(t *testing.T) {
					args := maps.Clone(tc.validArgs)
					delete(args, req)
					params, _ := json.Marshal(args)
					_, err := tool.Handler(ctx, params)
					if err == nil {
						t.Errorf("handler accepted request with required field %q missing", req)
					}
				})
			}
		})
	}
}

// TestMCPCreateDefaults verifies the default values applied by MCP create tools.
// These differ intentionally from the API layer (which targets human/CLI use).
func TestMCPCreateDefaults(t *testing.T) {
	deps := setupMCPDeps(t)
	head, _ := deps.repo.Head()
	ctx := context.Background()
	tools := registerAllTools(deps)

	t.Run("create_finding_status_defaults_to_draft", func(t *testing.T) {
		params, _ := json.Marshal(map[string]any{
			"file": "main.go", "commit": head,
			"severity": "high", "title": "test", "description": "d",
		})
		if _, err := tools["create_finding"].Handler(ctx, params); err != nil {
			t.Fatalf("create_finding: %v", err)
		}
		findings, _, err := deps.db.ListFindings("", 0, 0)
		if err != nil || len(findings) == 0 {
			t.Fatalf("list findings: %v (len=%d)", err, len(findings))
		}
		if got := findings[len(findings)-1].Status; got != "draft" {
			t.Errorf("default status = %q, want draft", got)
		}
	})

	t.Run("create_finding_source_defaults_to_mcp", func(t *testing.T) {
		findings, _, _ := deps.db.ListFindings("", 0, 0)
		if len(findings) == 0 {
			t.Skip("no findings (depends on previous subtest)")
		}
		if got := findings[len(findings)-1].Source; got != "mcp" {
			t.Errorf("default source = %q, want mcp", got)
		}
	})

	t.Run("create_feature_status_defaults_to_active", func(t *testing.T) {
		params, _ := json.Marshal(map[string]any{
			"file": "main.go", "commit": head, "kind": "interface", "title": "test",
		})
		if _, err := tools["create_feature"].Handler(ctx, params); err != nil {
			t.Fatalf("create_feature: %v", err)
		}
		features, _, err := deps.db.ListFeatures("", 0, 0)
		if err != nil || len(features) == 0 {
			t.Fatalf("list features: %v (len=%d)", err, len(features))
		}
		if got := features[len(features)-1].Status; got != "active" {
			t.Errorf("default status = %q, want active", got)
		}
	})
}

// TestMCPUpdateFinding_ScoreIsFloat verifies that score survives the MCP update
// path as a JSON number. update_finding passes fields through a map[string]any,
// which makes it possible for numeric types to be silently coerced to strings.
func TestMCPUpdateFinding_ScoreIsFloat(t *testing.T) {
	deps := setupMCPDeps(t)
	head, _ := deps.repo.Head()
	ctx := context.Background()
	tools := registerAllTools(deps)

	if err := deps.db.CreateFinding(&model.Finding{
		ID:        "score-test",
		Anchor:    model.Anchor{FileID: "main.go", CommitID: head},
		Severity:  "high",
		Title:     "score test",
		Status:    "draft",
		Source:    "mcp",
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		t.Fatalf("create finding: %v", err)
	}

	params, _ := json.Marshal(map[string]any{"id": "score-test", "score": 7.5})
	result, err := tools["update_finding"].Handler(ctx, params)
	if err != nil {
		t.Fatalf("update_finding: %v", err)
	}

	// update_finding returns "Updated finding <id>:\n<json>" — strip the prefix line.
	jsonPart := result
	if i := strings.Index(result, "\n"); i >= 0 {
		jsonPart = result[i+1:]
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(jsonPart), &m); err != nil {
		t.Fatalf("parse result: %v\nraw: %s", err, result)
	}
	score, ok := m["score"].(float64)
	if !ok {
		t.Fatalf("score is %T (%v), want float64", m["score"], m["score"])
	}
	if score != 7.5 {
		t.Errorf("score = %v, want 7.5", score)
	}
}

// isRequiredFieldError returns true if the error message indicates a missing required field.
func isRequiredFieldError(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "required")
}
