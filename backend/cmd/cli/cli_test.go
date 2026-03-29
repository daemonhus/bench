package main

// CLI tests operate at two levels:
//
//  1. Unit tests for parseFlags and buildRequest — pure functions that build
//     HTTP requests from CLI arguments. No server needed.
//
//  2. Integration tests that spin up a real API server and verify that each
//     CLI command's flag→param mapping actually reaches the server correctly.
//     These catch the class of bug where a flag is named "fileId" in the table
//     but the API expects "file_id", or a required field is silently dropped.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"bench/internal/api"
	"bench/internal/db"
	"bench/internal/git"
)

// ---------------------------------------------------------------------------
// parseFlags unit tests
// ---------------------------------------------------------------------------

func TestParseFlags_Required(t *testing.T) {
	defs := []flagDef{
		{Name: "title", Param: "title", Required: true},
		{Name: "severity", Param: "severity", Required: true},
		{Name: "desc", Param: "description"},
	}

	t.Run("both present", func(t *testing.T) {
		_, err := parseFlags(defs, []string{"--title", "SQLi", "--severity", "high"})
		if err != nil {
			t.Errorf("unexpected error: %v", err)
		}
	})
	t.Run("one missing", func(t *testing.T) {
		_, err := parseFlags(defs, []string{"--title", "SQLi"})
		if err == nil || !strings.Contains(err.Error(), "--severity") {
			t.Errorf("expected missing --severity error, got: %v", err)
		}
	})
	t.Run("both missing", func(t *testing.T) {
		_, err := parseFlags(defs, []string{})
		if err == nil {
			t.Error("expected error for missing required flags")
		}
	})
}

func TestParseFlags_UnknownFlag(t *testing.T) {
	defs := []flagDef{{Name: "title", Param: "title"}}
	_, err := parseFlags(defs, []string{"--title", "x", "--bogus", "y"})
	if err == nil || !strings.Contains(err.Error(), "bogus") {
		t.Errorf("expected unknown flag error, got: %v", err)
	}
}

func TestParseFlags_BoolFlag(t *testing.T) {
	defs := []flagDef{
		{Name: "case-insensitive", Param: "case_insensitive", Type: "bool"},
	}
	pf, err := parseFlags(defs, []string{"--case-insensitive"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !pf.bools["case-insensitive"] {
		t.Error("expected bool flag to be set")
	}
}

func TestParseFlags_EqualSyntax(t *testing.T) {
	defs := []flagDef{{Name: "title", Param: "title"}}
	pf, err := parseFlags(defs, []string{"--title=SQL injection"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pf.values["title"] != "SQL injection" {
		t.Errorf("value = %q, want %q", pf.values["title"], "SQL injection")
	}
}

func TestParseFlags_FlagMissingValue(t *testing.T) {
	defs := []flagDef{{Name: "title", Param: "title"}}
	_, err := parseFlags(defs, []string{"--title"})
	if err == nil || !strings.Contains(err.Error(), "requires a value") {
		t.Errorf("expected requires-a-value error, got: %v", err)
	}
}

// ---------------------------------------------------------------------------
// buildRequest unit tests
// ---------------------------------------------------------------------------

func findCmd(cat, name string) *cmdDef {
	for i := range commands {
		if commands[i].Cat == cat && commands[i].Name == name {
			return &commands[i]
		}
	}
	return nil
}

func parseBody(t *testing.T, body io.Reader) map[string]any {
	t.Helper()
	if body == nil {
		return nil
	}
	var m map[string]any
	if err := json.NewDecoder(body).Decode(&m); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	return m
}

func TestBuildRequest_GET_QueryString(t *testing.T) {
	cmd := findCmd("findings", "list")
	pf, _ := parseFlags(cmd.Flags, []string{"--severity", "high", "--status", "open"})
	_, path, body, _, err := buildRequest(cmd, pf)
	if err != nil {
		t.Fatalf("buildRequest: %v", err)
	}
	if body != nil {
		t.Error("GET should have no body")
	}
	if !strings.Contains(path, "severity=high") {
		t.Errorf("path %q missing severity=high", path)
	}
	if !strings.Contains(path, "status=open") {
		t.Errorf("path %q missing status=open", path)
	}
}

func TestBuildRequest_GET_BoolParam(t *testing.T) {
	cmd := findCmd("git", "search-code")
	pf, _ := parseFlags(cmd.Flags, []string{"--pattern", "eval", "--case-insensitive"})
	_, path, _, _, err := buildRequest(cmd, pf)
	if err != nil {
		t.Fatalf("buildRequest: %v", err)
	}
	if !strings.Contains(path, "case_insensitive=true") {
		t.Errorf("path %q missing case_insensitive=true", path)
	}
}

// TestBuildRequest_POST_AnchorStructure verifies that findings create wraps
// file-id and commit-id into anchor.fileId / anchor.commitId, and that
// line-start / line-end go into anchor.lineRange.start / .end.
func TestBuildRequest_POST_AnchorStructure(t *testing.T) {
	cmd := findCmd("findings", "create")
	pf, _ := parseFlags(cmd.Flags, []string{
		"--title", "SQLi",
		"--severity", "high",
		"--file-id", "src/api.go",
		"--commit-id", "abc123",
		"--line-start", "10",
		"--line-end", "15",
	})
	_, _, body, _, err := buildRequest(cmd, pf)
	if err != nil {
		t.Fatalf("buildRequest: %v", err)
	}
	m := parseBody(t, body)

	anchor, ok := m["anchor"].(map[string]any)
	if !ok {
		t.Fatalf("anchor missing from body; got keys: %v", keys(m))
	}
	if anchor["fileId"] != "src/api.go" {
		t.Errorf("anchor.fileId = %v, want src/api.go", anchor["fileId"])
	}
	if anchor["commitId"] != "abc123" {
		t.Errorf("anchor.commitId = %v, want abc123", anchor["commitId"])
	}
	lr, ok := anchor["lineRange"].(map[string]any)
	if !ok {
		t.Fatalf("anchor.lineRange missing; anchor keys: %v", keys(anchor))
	}
	if int(lr["start"].(float64)) != 10 {
		t.Errorf("lineRange.start = %v, want 10", lr["start"])
	}
	if int(lr["end"].(float64)) != 15 {
		t.Errorf("lineRange.end = %v, want 15", lr["end"])
	}
	// fileId / commitId should NOT also appear at top-level
	if _, ok := m["fileId"]; ok {
		t.Error("fileId leaked to top-level body (should be inside anchor)")
	}
}

// TestBuildRequest_PATCH_FlatBody verifies that findings update sends line
// position fields as flat top-level fields (not nested in anchor), which is
// what the UpdateFinding API expects.
func TestBuildRequest_PATCH_FlatBody(t *testing.T) {
	cmd := findCmd("findings", "update")
	pf, _ := parseFlags(cmd.Flags, []string{
		"--id", "f1",
		"--file-id", "src/new.go",
		"--commit-id", "def456",
		"--line-start", "20",
		"--line-end", "25",
		"--status", "open",
	})
	_, path, body, _, err := buildRequest(cmd, pf)
	if err != nil {
		t.Fatalf("buildRequest: %v", err)
	}
	if !strings.Contains(path, "/f1") {
		t.Errorf("path %q missing id", path)
	}
	m := parseBody(t, body)
	// Update sends flat fields, not anchor-wrapped
	if _, hasAnchor := m["anchor"]; hasAnchor {
		t.Error("update should not have anchor wrapper")
	}
	if m["file_id"] != "src/new.go" {
		t.Errorf("file_id = %v, want src/new.go", m["file_id"])
	}
	if m["commit_id"] != "def456" {
		t.Errorf("commit_id = %v, want def456", m["commit_id"])
	}
	if int(m["line_start"].(float64)) != 20 {
		t.Errorf("line_start = %v, want 20", m["line_start"])
	}
	if m["status"] != "open" {
		t.Errorf("status = %v, want open", m["status"])
	}
}

func TestBuildRequest_PathSubstitution_ID(t *testing.T) {
	cmd := findCmd("findings", "delete")
	pf, _ := parseFlags(cmd.Flags, []string{"--id", "abc-123"})
	_, path, _, _, err := buildRequest(cmd, pf)
	if err != nil {
		t.Fatalf("buildRequest: %v", err)
	}
	if !strings.HasSuffix(path, "/abc-123") {
		t.Errorf("path = %q, want suffix /abc-123", path)
	}
}

func TestBuildRequest_PathSubstitution_Commitish_Default(t *testing.T) {
	cmd := findCmd("git", "list-files")
	pf, _ := parseFlags(cmd.Flags, []string{}) // no --commit
	_, path, _, _, err := buildRequest(cmd, pf)
	if err != nil {
		t.Fatalf("buildRequest: %v", err)
	}
	if !strings.Contains(path, "HEAD") {
		t.Errorf("path = %q, want HEAD default for commitish", path)
	}
}

func TestBuildRequest_ListType_Tags(t *testing.T) {
	cmd := findCmd("features", "create")
	pf, _ := parseFlags(cmd.Flags, []string{
		"--file-id", "a.go",
		"--commit-id", "abc",
		"--kind", "interface",
		"--title", "Login",
		"--tags", "auth,session,critical",
	})
	_, _, body, _, err := buildRequest(cmd, pf)
	if err != nil {
		t.Fatalf("buildRequest: %v", err)
	}
	m := parseBody(t, body)
	tags, ok := m["tags"].([]any)
	if !ok {
		t.Fatalf("tags not a list; got %T: %v", m["tags"], m["tags"])
	}
	if len(tags) != 3 || tags[0] != "auth" || tags[1] != "session" || tags[2] != "critical" {
		t.Errorf("tags = %v, want [auth session critical]", tags)
	}
}

func TestBuildRequest_BaselineDelta_WithID(t *testing.T) {
	cmd := findCmd("baselines", "delta")
	pf, _ := parseFlags(cmd.Flags, []string{"--id", "bl-abc"})
	_, path, _, _, err := buildRequest(cmd, pf)
	if err != nil {
		t.Fatalf("buildRequest: %v", err)
	}
	if !strings.Contains(path, "bl-abc") || !strings.HasSuffix(path, "/delta") {
		t.Errorf("path = %q, want /api/baselines/bl-abc/delta", path)
	}
}

func TestBuildRequest_BaselineDelta_NoID(t *testing.T) {
	cmd := findCmd("baselines", "delta")
	pf, _ := parseFlags(cmd.Flags, []string{})
	_, path, _, _, err := buildRequest(cmd, pf)
	if err != nil {
		t.Fatalf("buildRequest: %v", err)
	}
	if path != "/api/baselines/delta" {
		t.Errorf("path = %q, want /api/baselines/delta", path)
	}
}

// ---------------------------------------------------------------------------
// normalizeBatchItem unit tests
// ---------------------------------------------------------------------------

func TestNormalizeBatchItem_FlatToAnchor(t *testing.T) {
	raw := json.RawMessage(`{
		"file": "src/api.go",
		"commit": "abc123",
		"line_start": 10,
		"line_end": 15,
		"title": "SQLi",
		"severity": "high"
	}`)
	out, err := normalizeBatchItem(raw)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	var m map[string]any
	json.Unmarshal(out, &m)

	anchor, ok := m["anchor"].(map[string]any)
	if !ok {
		t.Fatalf("anchor missing; keys: %v", keys(m))
	}
	if anchor["fileId"] != "src/api.go" {
		t.Errorf("anchor.fileId = %v, want src/api.go", anchor["fileId"])
	}
	if anchor["commitId"] != "abc123" {
		t.Errorf("anchor.commitId = %v, want abc123", anchor["commitId"])
	}
	lr := anchor["lineRange"].(map[string]any)
	if int(lr["start"].(float64)) != 10 || int(lr["end"].(float64)) != 15 {
		t.Errorf("lineRange = %v, want start=10 end=15", lr)
	}
	// Flat fields should be removed
	for _, k := range []string{"file", "commit", "line_start", "line_end"} {
		if _, ok := m[k]; ok {
			t.Errorf("flat field %q not removed from batch item", k)
		}
	}
	if m["title"] != "SQLi" || m["severity"] != "high" {
		t.Error("non-anchor fields should be preserved")
	}
}

func TestNormalizeBatchItem_AutoGeneratesID(t *testing.T) {
	raw := json.RawMessage(`{"title":"x","severity":"low"}`)
	out, _ := normalizeBatchItem(raw)
	var m map[string]any
	json.Unmarshal(out, &m)
	if id, ok := m["id"].(string); !ok || id == "" {
		t.Error("expected auto-generated id")
	}
}

func TestNormalizeBatchItem_PreservesExistingID(t *testing.T) {
	raw := json.RawMessage(`{"id":"my-id","title":"x"}`)
	out, _ := normalizeBatchItem(raw)
	var m map[string]any
	json.Unmarshal(out, &m)
	if m["id"] != "my-id" {
		t.Errorf("id = %v, want my-id", m["id"])
	}
}

func TestNormalizeBatchItem_CamelCaseAliases(t *testing.T) {
	// Some tools may send camelCase field names
	raw := json.RawMessage(`{"fileId":"a.go","commitId":"abc","lineStart":5,"lineEnd":6}`)
	out, _ := normalizeBatchItem(raw)
	var m map[string]any
	json.Unmarshal(out, &m)
	anchor := m["anchor"].(map[string]any)
	if anchor["fileId"] != "a.go" {
		t.Errorf("anchor.fileId = %v, want a.go", anchor["fileId"])
	}
	if _, ok := m["fileId"]; ok {
		t.Error("camelCase alias not removed from top-level")
	}
}

// ---------------------------------------------------------------------------
// Integration tests: CLI flag table → API
// ---------------------------------------------------------------------------
// These tests start a real API server and verify that the flag→param mapping
// in the commands table actually produces requests the server accepts.

func setupIntegrationServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()

	for _, args := range [][]string{
		{"git", "init", dir},
		{"git", "-C", dir, "config", "user.email", "test@test.com"},
		{"git", "-C", dir, "config", "user.name", "Test"},
	} {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("git setup: %v: %s", err, out)
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
			t.Fatalf("git commit: %v: %s", err, out)
		}
	}

	database, err := db.Open(filepath.Join(dir, "test.db"), "test")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { database.Close() })

	repo := git.NewRepo(dir)
	router := api.NewRouter(repo, database, nil)
	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)

	// Get HEAD commit hash
	out, err := exec.Command("git", "-C", dir, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatalf("rev-parse HEAD: %v", err)
	}
	head := strings.TrimSpace(string(out))
	return srv, head
}

func cliDo(t *testing.T, srv *httptest.Server, cat, name string, flagArgs []string) (map[string]any, int) {
	t.Helper()
	cmd := findCmd(cat, name)
	if cmd == nil {
		t.Fatalf("command %s %s not found", cat, name)
	}
	pf, err := parseFlags(cmd.Flags, flagArgs)
	if err != nil {
		t.Fatalf("parseFlags: %v", err)
	}
	method, path, body, _, err := buildRequest(cmd, pf)
	if err != nil {
		t.Fatalf("buildRequest: %v", err)
	}

	client := newAPIClient(srv.URL)
	data, code, err := client.do(method, path, body)
	if err != nil {
		t.Fatalf("do %s %s: %v", method, path, err)
	}

	var result map[string]any
	json.Unmarshal(data, &result) // best-effort; caller checks code
	return result, code
}

func TestCLIIntegration_Findings_CreateAndList(t *testing.T) {
	srv, head := setupIntegrationServer(t)

	// Create a finding via CLI flags
	result, code := cliDo(t, srv, "findings", "create", []string{
		"--title", "SQL injection",
		"--severity", "high",
		"--file-id", "main.go",
		"--commit-id", head,
		"--line-start", "1",
		"--line-end", "2",
		"--description", "Unsanitised input",
		"--category", "injection",
	})
	if code != http.StatusCreated {
		t.Fatalf("create: code=%d body=%v", code, result)
	}
	if result["title"] != "SQL injection" {
		t.Errorf("title = %v, want SQL injection", result["title"])
	}
	// Anchor should be present in API response
	anchor, ok := result["anchor"].(map[string]any)
	if !ok {
		t.Fatalf("anchor missing from response; keys: %v", keys(result))
	}
	if anchor["fileId"] != "main.go" {
		t.Errorf("anchor.fileId = %v, want main.go", anchor["fileId"])
	}

	// List should return it
	_, code = cliDo(t, srv, "findings", "list", []string{})
	if code != http.StatusOK {
		t.Errorf("list: code=%d", code)
	}
}

func TestCLIIntegration_Findings_UpdateFlat(t *testing.T) {
	srv, head := setupIntegrationServer(t)

	// Create
	created, code := cliDo(t, srv, "findings", "create", []string{
		"--title", "XSS", "--severity", "medium",
		"--file-id", "main.go", "--commit-id", head,
	})
	if code != http.StatusCreated {
		t.Fatalf("create: code=%d body=%v", code, created)
	}
	id := created["id"].(string)

	// Update status — verifies flat PATCH body field names reach the server
	updated, code := cliDo(t, srv, "findings", "update", []string{
		"--id", id,
		"--status", "in-progress",
		"--severity", "high",
	})
	if code != http.StatusOK {
		t.Fatalf("update: code=%d body=%v", code, updated)
	}
	if updated["status"] != "in-progress" {
		t.Errorf("status = %v, want in-progress", updated["status"])
	}
	if updated["severity"] != "high" {
		t.Errorf("severity = %v, want high", updated["severity"])
	}
}

func TestCLIIntegration_Comments_Create(t *testing.T) {
	srv, head := setupIntegrationServer(t)

	result, code := cliDo(t, srv, "comments", "create", []string{
		"--author", "alice",
		"--text", "Needs review",
		"--file-id", "main.go",
		"--commit-id", head,
	})
	if code != http.StatusCreated {
		t.Fatalf("create: code=%d body=%v", code, result)
	}
	if result["author"] != "alice" {
		t.Errorf("author = %v, want alice", result["author"])
	}
}

func TestCLIIntegration_Features_Create(t *testing.T) {
	srv, head := setupIntegrationServer(t)

	result, code := cliDo(t, srv, "features", "create", []string{
		"--file-id", "main.go",
		"--commit-id", head,
		"--kind", "interface",
		"--title", "Login endpoint",
		"--operation", "POST",
		"--tags", "auth,session",
	})
	if code != http.StatusCreated {
		t.Fatalf("create: code=%d body=%v", code, result)
	}
	if result["kind"] != "interface" {
		t.Errorf("kind = %v, want interface", result["kind"])
	}
	tags, _ := result["tags"].([]any)
	if len(tags) != 2 {
		t.Errorf("tags = %v, want [auth session]", tags)
	}
}

func TestCLIIntegration_Baselines_SetAndDelta(t *testing.T) {
	srv, _ := setupIntegrationServer(t)

	result, code := cliDo(t, srv, "baselines", "set", []string{
		"--reviewer", "alice",
		"--summary", "initial review",
	})
	if code != http.StatusCreated {
		t.Fatalf("set baseline: code=%d body=%v", code, result)
	}
	if result["reviewer"] != "alice" {
		t.Errorf("reviewer = %v, want alice", result["reviewer"])
	}

	// Delta against latest
	_, code = cliDo(t, srv, "baselines", "delta", []string{})
	if code != http.StatusOK {
		t.Errorf("delta: code=%d", code)
	}
}

func TestCLIIntegration_Git_SearchCode(t *testing.T) {
	srv, _ := setupIntegrationServer(t)

	// /api/git/search with pattern param
	_, code := cliDo(t, srv, "git", "search-code", []string{"--pattern", "main"})
	if code != http.StatusOK {
		t.Errorf("search-code: code=%d", code)
	}
}

func TestCLIIntegration_Analytics_MarkReviewed(t *testing.T) {
	srv, head := setupIntegrationServer(t)

	result, code := cliDo(t, srv, "analytics", "mark-reviewed", []string{
		"--path", "main.go",
		"--commit", head,
		"--reviewer", "alice",
	})
	if code != http.StatusOK && code != http.StatusCreated && code != http.StatusNoContent {
		t.Errorf("mark-reviewed: code=%d body=%v", code, result)
	}
}

// ---------------------------------------------------------------------------
// formatOutput unit tests
// ---------------------------------------------------------------------------

func TestFormatOutput_JSON(t *testing.T) {
	data := []byte(`{"id":"f1","title":"SQLi"}`)
	out := formatOutput(data, 200)
	if !strings.Contains(out, "SQLi") || !strings.Contains(out, "\n") {
		t.Errorf("expected pretty JSON, got: %s", out)
	}
}

func TestFormatOutput_ErrorResponse(t *testing.T) {
	data := []byte(`{"error":"title and severity are required"}`)
	out := formatOutput(data, 400)
	if !strings.Contains(out, "title and severity are required") {
		t.Errorf("unexpected output: %s", out)
	}
	if !strings.HasPrefix(out, "Error:") {
		t.Errorf("expected Error: prefix, got: %s", out)
	}
}

func TestFormatOutput_NoContent(t *testing.T) {
	out := formatOutput([]byte{}, 204)
	if out != "OK" {
		t.Errorf("expected OK, got: %s", out)
	}
}

func TestFormatOutput_PlainText(t *testing.T) {
	out := formatOutput([]byte("not json"), 200)
	if out != "not json" {
		t.Errorf("expected raw text, got: %s", out)
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func keys(m map[string]any) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	return ks
}

// Suppress "declared and not used" for fmt in files that don't use it directly.
var _ = fmt.Sprintf
