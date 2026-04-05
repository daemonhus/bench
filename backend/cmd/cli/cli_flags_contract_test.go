package main

// cli_flags_contract_test.go verifies that every flag declared in the commands
// table is:
//  1. Accepted by parseFlags (no "unknown flag" error)
//  2. Serialised into the correct HTTP parameter name by buildRequest
//  3. Sent with the correct type (float stays float, int stays int, list becomes array)
//
// Integration tests additionally prove end-to-end: the flag reaches the server
// and the server stores/returns it with the right type.

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// parseAndBuild is a shorthand: parse flagArgs against cmd, then build request.
func parseAndBuild(t *testing.T, cat, name string, flagArgs []string) (method, path string, body map[string]any) {
	t.Helper()
	cmd := findCmd(cat, name)
	if cmd == nil {
		t.Fatalf("command %s %s not found in commands table", cat, name)
	}
	pf, err := parseFlags(cmd.Flags, flagArgs)
	if err != nil {
		t.Fatalf("parseFlags: %v", err)
	}
	m, p, b, _, err := buildRequest(cmd, pf)
	if err != nil {
		t.Fatalf("buildRequest: %v", err)
	}
	return m, p, parseBody(t, b)
}

// requireQuery checks that param=value appears in the query string of path.
func requireQuery(t *testing.T, path, param, value string) {
	t.Helper()
	want := param + "=" + value
	if !strings.Contains(path, want) {
		t.Errorf("path %q missing query %q", path, want)
	}
}

// requireField checks that body[field] == want (using string comparison on JSON values).
func requireField(t *testing.T, body map[string]any, field string, want any) {
	t.Helper()
	got, ok := body[field]
	if !ok {
		t.Errorf("body missing field %q; keys: %v", field, keys(body))
		return
	}
	// Compare via JSON round-trip to normalise numeric types.
	gotJ, _ := json.Marshal(got)
	wantJ, _ := json.Marshal(want)
	if string(gotJ) != string(wantJ) {
		t.Errorf("body[%q] = %s, want %s", field, gotJ, wantJ)
	}
}

// requireNoField checks that field is absent from body.
func requireNoField(t *testing.T, body map[string]any, field string) {
	t.Helper()
	if _, ok := body[field]; ok {
		t.Errorf("body should not contain field %q", field)
	}
}

// requireAnchorField checks anchor.<field> == want.
func requireAnchorField(t *testing.T, body map[string]any, field string, want any) {
	t.Helper()
	anchor, ok := body["anchor"].(map[string]any)
	if !ok {
		t.Fatalf("body missing 'anchor'; keys: %v", keys(body))
	}
	requireField(t, anchor, field, want)
}

// ---------------------------------------------------------------------------
// GET commands: flag → query string
// ---------------------------------------------------------------------------

func TestFlagsContract_GET_GitSearchCode(t *testing.T) {
	_, path, _ := parseAndBuild(t, "git", "search-code", []string{
		"--pattern", "eval(",
		"--commit", "abc123",
		"--path", "src/",
		"--ignore-case",
		"--limit", "50",
	})
	requireQuery(t, path, "pattern", "eval%28")
	requireQuery(t, path, "commit", "abc123")
	requireQuery(t, path, "path", "src%2F")
	requireQuery(t, path, "case_insensitive", "true")
	requireQuery(t, path, "max_results", "50")
}

func TestFlagsContract_GET_GitDiff(t *testing.T) {
	_, path, _ := parseAndBuild(t, "git", "diff", []string{
		"--from", "HEAD~1",
		"--to", "HEAD",
		"--path", "src/auth.go",
	})
	requireQuery(t, path, "from", "HEAD~1")
	requireQuery(t, path, "to", "HEAD")
	requireQuery(t, path, "path", "src%2Fauth.go")
}

func TestFlagsContract_GET_FindingsList(t *testing.T) {
	_, path, _ := parseAndBuild(t, "findings", "list", []string{
		"--file", "src/api.go",
		"--commit", "abc123",
		"--severity", "high",
		"--status", "open",
	})
	requireQuery(t, path, "fileId", "src%2Fapi.go")
	requireQuery(t, path, "commit", "abc123")
	requireQuery(t, path, "severity", "high")
	requireQuery(t, path, "status", "open")
}

func TestFlagsContract_GET_FindingsSearch(t *testing.T) {
	_, path, _ := parseAndBuild(t, "findings", "search", []string{
		"--query", "injection",
		"--status", "open",
		"--severity", "high",
	})
	requireQuery(t, path, "query", "injection")
	requireQuery(t, path, "status", "open")
	requireQuery(t, path, "severity", "high")
}

func TestFlagsContract_GET_CommentsList(t *testing.T) {
	_, path, _ := parseAndBuild(t, "comments", "list", []string{
		"--file", "src/api.go",
		"--finding", "f-123",
		"--feature", "ft-456",
		"--commit", "abc123",
	})
	requireQuery(t, path, "fileId", "src%2Fapi.go")
	requireQuery(t, path, "findingId", "f-123")
	requireQuery(t, path, "featureId", "ft-456")
	requireQuery(t, path, "commit", "abc123")
}

func TestFlagsContract_GET_FeaturesList(t *testing.T) {
	_, path, _ := parseAndBuild(t, "features", "list", []string{
		"--file", "src/api.go",
		"--kind", "interface",
		"--status", "active",
	})
	requireQuery(t, path, "fileId", "src%2Fapi.go")
	requireQuery(t, path, "kind", "interface")
	requireQuery(t, path, "status", "active")
}

func TestFlagsContract_GET_AnalyticsSummary(t *testing.T) {
	_, path, _ := parseAndBuild(t, "analytics", "summary", []string{
		"--commit", "abc123",
	})
	requireQuery(t, path, "commit", "abc123")
}

func TestFlagsContract_GET_AnalyticsCoverage(t *testing.T) {
	_, path, _ := parseAndBuild(t, "analytics", "coverage", []string{
		"--commit", "abc123",
		"--path", "src/",
		"--only-unreviewed",
	})
	requireQuery(t, path, "commit", "abc123")
	requireQuery(t, path, "path", "src%2F")
	requireQuery(t, path, "only_unreviewed", "true")
}

func TestFlagsContract_GET_ReconcileStatus(t *testing.T) {
	_, path, _ := parseAndBuild(t, "reconcile", "status", []string{
		"--job", "job-123",
		"--file", "src/api.go",
		"--commit", "abc123",
	})
	requireQuery(t, path, "jobId", "job-123")
	requireQuery(t, path, "fileId", "src%2Fapi.go")
	requireQuery(t, path, "commit", "abc123")
}

// ---------------------------------------------------------------------------
// POST commands: flag → JSON body
// ---------------------------------------------------------------------------

func TestFlagsContract_POST_FindingsCreate_AllOptionalFlags(t *testing.T) {
	_, _, body := parseAndBuild(t, "findings", "create", []string{
		"--title", "SQLi",
		"--severity", "high",
		"--file", "src/api.go",
		"--commit", "abc123",
		"--start", "10",
		"--end", "20",
		"--description", "Unsanitised input",
		"--cwe", "CWE-89",
		"--cve", "CVE-2024-1234",
		"--vector", "CVSS:3.1/AV:N",
		"--score", "7.5",
		"--status", "draft",
		"--source", "pentest",
		"--category", "injection",
		"--features", "feat-1,feat-2",
	})

	requireField(t, body, "title", "SQLi")
	requireField(t, body, "severity", "high")
	requireField(t, body, "description", "Unsanitised input")
	requireField(t, body, "cwe", "CWE-89")
	requireField(t, body, "cve", "CVE-2024-1234")
	requireField(t, body, "vector", "CVSS:3.1/AV:N")
	// score must be a JSON number (float64), not a string
	requireField(t, body, "score", float64(7.5))
	requireField(t, body, "status", "draft")
	requireField(t, body, "source", "pentest")
	requireField(t, body, "category", "injection")

	// features must be an array
	if fids, ok := body["features"].([]any); !ok || len(fids) != 2 {
		t.Errorf("features = %v, want [feat-1 feat-2]", body["features"])
	}

	// anchor must be nested
	requireAnchorField(t, body, "fileId", "src/api.go")
	requireAnchorField(t, body, "commitId", "abc123")
	anchor := body["anchor"].(map[string]any)
	lr := anchor["lineRange"].(map[string]any)
	requireField(t, lr, "start", float64(10))
	requireField(t, lr, "end", float64(20))

	// top-level fileId/commitId must not leak
	requireNoField(t, body, "fileId")
	requireNoField(t, body, "commitId")
}

func TestFlagsContract_POST_FindingsCreate_FeatureIDs(t *testing.T) {
	_, _, body := parseAndBuild(t, "findings", "create", []string{
		"--title", "SQLi",
		"--severity", "high",
		"--features", "feat-1,feat-2",
	})
	ids, ok := body["features"].([]any)
	if !ok || len(ids) != 2 {
		t.Errorf("features = %v (%T), want [feat-1 feat-2]", body["features"], body["features"])
	}
}

func TestFlagsContract_PATCH_FindingsUpdate_FeatureIDs(t *testing.T) {
	_, _, body := parseAndBuild(t, "findings", "update", []string{
		"--id", "f-123",
		"--features", "feat-a,feat-b",
	})
	ids, ok := body["features"].([]any)
	if !ok || len(ids) != 2 {
		t.Errorf("features = %v (%T), want [feat-a feat-b]", body["features"], body["features"])
	}
}

func TestFlagsContract_POST_FindingsCreate_ScoreIsFloat(t *testing.T) {
	// Specifically verifies score is serialised as a JSON number, not string.
	// This catches the "Type: empty → string" bug.
	_, _, body := parseAndBuild(t, "findings", "create", []string{
		"--title", "x", "--severity", "low",
		"--score", "3.7",
	})
	score, ok := body["score"].(float64)
	if !ok {
		t.Fatalf("score is %T (%v), want float64", body["score"], body["score"])
	}
	if score != 3.7 {
		t.Errorf("score = %v, want 3.7", score)
	}
}

func TestFlagsContract_POST_CommentsCreate_AllOptionalFlags(t *testing.T) {
	_, _, body := parseAndBuild(t, "comments", "create", []string{
		"--author", "alice",
		"--text", "Needs review",
		"--file", "src/api.go",
		"--commit", "abc123",
		"--start", "5",
		"--end", "10",
		"--type", "concern",
		"--thread", "thread-1",
		"--parent", "c-parent",
		"--finding", "f-123",
		"--feature", "ft-456",
	})

	requireField(t, body, "author", "alice")
	requireField(t, body, "text", "Needs review")
	requireField(t, body, "commentType", "concern")
	requireField(t, body, "threadId", "thread-1")
	requireField(t, body, "parentId", "c-parent")
	requireField(t, body, "findingId", "f-123")
	requireField(t, body, "featureId", "ft-456")

	requireAnchorField(t, body, "fileId", "src/api.go")
	requireAnchorField(t, body, "commitId", "abc123")
	anchor := body["anchor"].(map[string]any)
	lr := anchor["lineRange"].(map[string]any)
	requireField(t, lr, "start", float64(5))
	requireField(t, lr, "end", float64(10))
}

func TestFlagsContract_POST_FeaturesCreate_AllOptionalFlags(t *testing.T) {
	_, _, body := parseAndBuild(t, "features", "create", []string{
		"--file", "src/api.go",
		"--commit", "abc123",
		"--kind", "interface",
		"--title", "Login endpoint",
		"--start", "1",
		"--end", "30",
		"--description", "Handles auth",
		"--operation", "POST",
		"--direction", "in",
		"--protocol", "rest",
		"--status", "active",
		"--tags", "auth,session",
		"--source", "scanner",
	})

	requireField(t, body, "kind", "interface")
	requireField(t, body, "title", "Login endpoint")
	requireField(t, body, "description", "Handles auth")
	requireField(t, body, "operation", "POST")
	requireField(t, body, "direction", "in")
	requireField(t, body, "protocol", "rest")
	requireField(t, body, "status", "active")
	requireField(t, body, "source", "scanner")

	tags, ok := body["tags"].([]any)
	if !ok || len(tags) != 2 {
		t.Errorf("tags = %v, want [auth session]", body["tags"])
	}

	requireAnchorField(t, body, "fileId", "src/api.go")
	requireAnchorField(t, body, "commitId", "abc123")
}

func TestFlagsContract_POST_BaselinesSet(t *testing.T) {
	_, _, body := parseAndBuild(t, "baselines", "set", []string{
		"--reviewer", "alice",
		"--summary", "auth review",
		"--commit", "abc123",
	})
	requireField(t, body, "reviewer", "alice")
	requireField(t, body, "summary", "auth review")
	// commitId must be top-level, not wrapped in anchor
	requireField(t, body, "commitId", "abc123")
	requireNoField(t, body, "anchor")
}

func TestFlagsContract_POST_AnalyticsMarkReviewed(t *testing.T) {
	_, _, body := parseAndBuild(t, "analytics", "mark-reviewed", []string{
		"--path", "src/api.go",
		"--commit", "abc123",
		"--reviewer", "alice",
		"--note", "looks good",
	})
	requireField(t, body, "path", "src/api.go")
	requireField(t, body, "commit", "abc123")
	requireField(t, body, "reviewer", "alice")
	requireField(t, body, "note", "looks good")
}

func TestFlagsContract_POST_ReconcileStart(t *testing.T) {
	_, _, body := parseAndBuild(t, "reconcile", "start", []string{
		"--target", "abc123",
		"--file-paths", "src/api.go,src/db.go",
	})
	requireField(t, body, "targetCommit", "abc123")
	paths, ok := body["filePaths"].([]any)
	if !ok || len(paths) != 2 {
		t.Errorf("filePaths = %v, want [src/api.go src/db.go]", body["filePaths"])
	}
}

// ---------------------------------------------------------------------------
// PATCH commands: flag → JSON body (flat, not anchor-wrapped)
// ---------------------------------------------------------------------------

func TestFlagsContract_PATCH_FindingsUpdate_AllFields(t *testing.T) {
	_, path, body := parseAndBuild(t, "findings", "update", []string{
		"--id", "f-123",
		"--title", "Updated title",
		"--severity", "critical",
		"--description", "Updated desc",
		"--status", "in-progress",
		"--cwe", "CWE-89",
		"--cve", "CVE-2024-9999",
		"--vector", "CVSS:3.1/AV:N",
		"--score", "9.8",
		"--source", "tool",
		"--category", "injection",
		"--file", "src/new.go",
		"--commit", "def456",
		"--start", "20",
		"--end", "25",
		"--features", "feat-1,feat-2",
	})

	if !strings.Contains(path, "/f-123") {
		t.Errorf("path %q missing id", path)
	}

	requireNoField(t, body, "anchor") // update sends flat fields
	requireField(t, body, "title", "Updated title")
	requireField(t, body, "severity", "critical")
	requireField(t, body, "description", "Updated desc")
	requireField(t, body, "status", "in-progress")
	requireField(t, body, "cwe", "CWE-89")
	requireField(t, body, "cve", "CVE-2024-9999")
	requireField(t, body, "vector", "CVSS:3.1/AV:N")
	requireField(t, body, "score", float64(9.8))
	requireField(t, body, "source", "tool")
	requireField(t, body, "category", "injection")
	requireField(t, body, "file_id", "src/new.go")
	requireField(t, body, "commit_id", "def456")
	requireField(t, body, "line_start", float64(20))
	requireField(t, body, "line_end", float64(25))

	featureIDs, ok := body["features"].([]any)
	if !ok || len(featureIDs) != 2 {
		t.Errorf("features = %v, want [feat-1 feat-2]", body["features"])
	}
}

func TestFlagsContract_PATCH_CommentsUpdate_AllFields(t *testing.T) {
	_, path, body := parseAndBuild(t, "comments", "update", []string{
		"--id", "c-123",
		"--text", "Updated text",
		"--author", "bob",
		"--type", "improvement",
		"--file", "src/new.go",
		"--commit", "def456",
		"--start", "10",
		"--end", "15",
		"--feature", "ft-789",
	})

	if !strings.Contains(path, "/c-123") {
		t.Errorf("path %q missing id", path)
	}

	requireField(t, body, "text", "Updated text")
	requireField(t, body, "author", "bob")
	requireField(t, body, "commentType", "improvement")
	requireField(t, body, "file_id", "src/new.go")
	requireField(t, body, "commit_id", "def456")
	requireField(t, body, "line_start", float64(10))
	requireField(t, body, "line_end", float64(15))
	requireField(t, body, "featureId", "ft-789")
}

func TestFlagsContract_PATCH_FeaturesUpdate_AllFields(t *testing.T) {
	_, path, body := parseAndBuild(t, "features", "update", []string{
		"--id", "ft-123",
		"--kind", "sink",
		"--title", "Updated endpoint",
		"--description", "Updated desc",
		"--operation", "GET",
		"--direction", "out",
		"--protocol", "grpc",
		"--status", "deprecated",
		"--tags", "legacy,auth",
		"--source", "manual",
		"--file", "src/new.go",
		"--commit", "def456",
		"--start", "5",
		"--end", "10",
	})

	if !strings.Contains(path, "/ft-123") {
		t.Errorf("path %q missing id", path)
	}

	requireField(t, body, "kind", "sink")
	requireField(t, body, "title", "Updated endpoint")
	requireField(t, body, "description", "Updated desc")
	requireField(t, body, "operation", "GET")
	requireField(t, body, "direction", "out")
	requireField(t, body, "protocol", "grpc")
	requireField(t, body, "status", "deprecated")
	requireField(t, body, "source", "manual")
	requireField(t, body, "file_id", "src/new.go")
	requireField(t, body, "commit_id", "def456")
	requireField(t, body, "line_start", float64(5))
	requireField(t, body, "line_end", float64(10))

	tags, ok := body["tags"].([]any)
	if !ok || len(tags) != 2 {
		t.Errorf("tags = %v, want [legacy auth]", body["tags"])
	}
}

func TestFlagsContract_PATCH_FindingsResolve_SendsResolvedCommit(t *testing.T) {
	_, path, body := parseAndBuild(t, "findings", "resolve", []string{
		"--id", "f-abc",
		"--commit", "fix-commit",
	})
	if !strings.Contains(path, "/f-abc") {
		t.Errorf("path %q missing id", path)
	}
	requireField(t, body, "resolvedCommit", "fix-commit")
}

func TestFlagsContract_PATCH_CommentsResolve_SendsResolvedCommit(t *testing.T) {
	_, path, body := parseAndBuild(t, "comments", "resolve", []string{
		"--id", "c-abc",
		"--commit", "fix-commit",
	})
	if !strings.Contains(path, "/c-abc") {
		t.Errorf("path %q missing id", path)
	}
	requireField(t, body, "resolvedCommit", "fix-commit")
}

// ---------------------------------------------------------------------------
// Path routing
// ---------------------------------------------------------------------------

func TestFlagsContract_Path_ReconcileHistory(t *testing.T) {
	cmd := findCmd("reconcile", "history")
	pf, _ := parseFlags(cmd.Flags, []string{"--type", "finding", "--id", "f-123"})
	_, path, _, _, _ := buildRequest(cmd, pf)
	if !strings.Contains(path, "finding") || !strings.Contains(path, "f-123") {
		t.Errorf("path %q should contain type=finding and id=f-123", path)
	}
}

// ---------------------------------------------------------------------------
// refs commands
// ---------------------------------------------------------------------------

func TestFlagsContract_GET_RefsList(t *testing.T) {
	_, path, _ := parseAndBuild(t, "refs", "list", []string{
		"--entity-type", "finding",
		"--entity", "f-123",
		"--provider", "jira",
	})
	requireQuery(t, path, "entityType", "finding")
	requireQuery(t, path, "entityId", "f-123")
	requireQuery(t, path, "provider", "jira")
}

func TestFlagsContract_POST_RefsCreate_AllFields(t *testing.T) {
	_, _, body := parseAndBuild(t, "refs", "create", []string{
		"--entity-type", "finding",
		"--entity", "f-123",
		"--provider", "jira",
		"--url", "https://jira.example.com/PROJ-1",
		"--title", "PROJ-1: SQL injection",
	})
	requireField(t, body, "entityType", "finding")
	requireField(t, body, "entityId", "f-123")
	requireField(t, body, "provider", "jira")
	requireField(t, body, "url", "https://jira.example.com/PROJ-1")
	requireField(t, body, "title", "PROJ-1: SQL injection")
}

func TestFlagsContract_PATCH_RefsUpdate_AllFields(t *testing.T) {
	_, path, body := parseAndBuild(t, "refs", "update", []string{
		"--id", "ref-abc",
		"--provider", "linear",
		"--url", "https://linear.app/team/issue/ENG-42",
		"--title", "ENG-42",
	})
	if !strings.Contains(path, "/ref-abc") {
		t.Errorf("path %q missing id", path)
	}
	requireField(t, body, "provider", "linear")
	requireField(t, body, "url", "https://linear.app/team/issue/ENG-42")
	requireField(t, body, "title", "ENG-42")
}

func TestFlagsContract_RequiredFlag_RefsCreate_MissingURL(t *testing.T) {
	cmd := findCmd("refs", "create")
	if cmd == nil {
		t.Fatal("refs create not found")
	}
	_, err := parseFlags(cmd.Flags, []string{
		"--entity-type", "finding",
		"--entity", "f-1",
		"--provider", "jira",
		// --url omitted
	})
	if err == nil {
		t.Error("want error for missing --url, got nil")
	}
}

// ---------------------------------------------------------------------------
// Required flags: missing flag → parseFlags error
// ---------------------------------------------------------------------------

func TestFlagsContract_RequiredFlag_FindingsCreate_MissingTitle(t *testing.T) {
	cmd := findCmd("findings", "create")
	if cmd == nil {
		t.Fatal("findings create not found")
	}
	_, err := parseFlags(cmd.Flags, []string{"--severity", "high"})
	if err == nil {
		t.Error("want error for missing --title, got nil")
	}
}

func TestFlagsContract_RequiredFlag_FindingsCreate_MissingSeverity(t *testing.T) {
	cmd := findCmd("findings", "create")
	_, err := parseFlags(cmd.Flags, []string{"--title", "SQLi"})
	if err == nil {
		t.Error("want error for missing --severity, got nil")
	}
}

func TestFlagsContract_RequiredFlag_CommentsCreate_MissingAuthor(t *testing.T) {
	cmd := findCmd("comments", "create")
	_, err := parseFlags(cmd.Flags, []string{"--text", "looks risky"})
	if err == nil {
		t.Error("want error for missing --author, got nil")
	}
}

func TestFlagsContract_RequiredFlag_FeaturesCreate_MissingKind(t *testing.T) {
	cmd := findCmd("features", "create")
	_, err := parseFlags(cmd.Flags, []string{"--title", "Login endpoint"})
	if err == nil {
		t.Error("want error for missing --kind, got nil")
	}
}

// ---------------------------------------------------------------------------
// Integration: type safety end-to-end (CLI → server → response type)
// ---------------------------------------------------------------------------

func TestCLIIntegration_Findings_ScoreIsFloat(t *testing.T) {
	srv, _ := setupIntegrationServer(t)

	result, code := cliDo(t, srv, "findings", "create", []string{
		"--title", "CVSS finding",
		"--severity", "high",
		"--score", "7.5",
		"--vector", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
	})
	if code != http.StatusCreated {
		t.Fatalf("create: code=%d body=%v", code, result)
	}
	// Server must echo back score as a JSON number (float64 after decode).
	score, ok := result["score"].(float64)
	if !ok {
		t.Fatalf("score is %T (%v) in response, want float64", result["score"], result["score"])
	}
	if score != 7.5 {
		t.Errorf("score = %v, want 7.5", score)
	}
	if result["vector"] != "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N" {
		t.Errorf("vector = %v", result["vector"])
	}
}

func TestCLIIntegration_Findings_CreateAllTextFields(t *testing.T) {
	srv, _ := setupIntegrationServer(t)

	result, code := cliDo(t, srv, "findings", "create", []string{
		"--title", "Injection",
		"--severity", "critical",
		"--description", "Unvalidated input",
		"--cwe", "CWE-89",
		"--cve", "CVE-2024-1234",
		"--status", "draft",
		"--source", "pentest",
		"--category", "injection",
	})
	if code != http.StatusCreated {
		t.Fatalf("create: code=%d body=%v", code, result)
	}
	for field, want := range map[string]string{
		"description": "Unvalidated input",
		"cwe":         "CWE-89",
		"cve":         "CVE-2024-1234",
		"status":      "draft",
		"source":      "pentest",
		"category":    "injection",
	} {
		if result[field] != want {
			t.Errorf("%s = %v, want %s", field, result[field], want)
		}
	}
}

func TestCLIIntegration_Findings_UpdateScore(t *testing.T) {
	srv, _ := setupIntegrationServer(t)

	created, code := cliDo(t, srv, "findings", "create", []string{
		"--title", "x", "--severity", "low",
	})
	if code != http.StatusCreated {
		t.Fatalf("create: code=%d", code)
	}
	id := created["id"].(string)

	updated, code := cliDo(t, srv, "findings", "update", []string{
		"--id", id,
		"--score", "9.8",
		"--cwe", "CWE-79",
	})
	if code != http.StatusOK {
		t.Fatalf("update: code=%d body=%v", code, updated)
	}
	if score, ok := updated["score"].(float64); !ok || score != 9.8 {
		t.Errorf("score = %v (%T), want 9.8 float64", updated["score"], updated["score"])
	}
	if updated["cwe"] != "CWE-79" {
		t.Errorf("cwe = %v, want CWE-79", updated["cwe"])
	}
}

func TestCLIIntegration_Comments_CreateAllOptionalFields(t *testing.T) {
	srv, head := setupIntegrationServer(t)

	// First create a finding to link to
	finding, code := cliDo(t, srv, "findings", "create", []string{
		"--title", "linked", "--severity", "low",
	})
	if code != http.StatusCreated {
		t.Fatalf("create finding: code=%d", code)
	}
	findingID := finding["id"].(string)

	result, code := cliDo(t, srv, "comments", "create", []string{
		"--author", "bob",
		"--text", "concern here",
		"--file", "main.go",
		"--commit", head,
		"--type", "concern",
		"--finding", findingID,
	})
	if code != http.StatusCreated {
		t.Fatalf("create comment: code=%d body=%v", code, result)
	}
	if result["commentType"] != "concern" {
		t.Errorf("commentType = %v, want concern", result["commentType"])
	}
	if result["findingId"] != findingID {
		t.Errorf("findingId = %v, want %s", result["findingId"], findingID)
	}
}

func TestCLIIntegration_Findings_CreateWithFeatureIDs(t *testing.T) {
	srv, head := setupIntegrationServer(t)

	// Create a feature to link
	feat, code := cliDo(t, srv, "features", "create", []string{
		"--file", "main.go",
		"--commit", head,
		"--kind", "interface",
		"--title", "Login endpoint",
	})
	if code != http.StatusCreated {
		t.Fatalf("create feature: code=%d body=%v", code, feat)
	}
	featID := feat["id"].(string)

	// Create finding with feature IDs
	result, code := cliDo(t, srv, "findings", "create", []string{
		"--title", "Auth bypass",
		"--severity", "high",
		"--features", featID,
	})
	if code != http.StatusCreated {
		t.Fatalf("create finding: code=%d body=%v", code, result)
	}
	ids, ok := result["features"].([]any)
	if !ok || len(ids) != 1 || ids[0] != featID {
		t.Errorf("features = %v, want [%s]", result["features"], featID)
	}
}

func TestCLIIntegration_Findings_UpdateFeatureIDs(t *testing.T) {
	srv, head := setupIntegrationServer(t)

	feat, _ := cliDo(t, srv, "features", "create", []string{
		"--file", "main.go", "--commit", head, "--kind", "sink", "--title", "DB write",
	})
	featID := feat["id"].(string)

	finding, code := cliDo(t, srv, "findings", "create", []string{
		"--title", "SQLi", "--severity", "critical",
	})
	if code != http.StatusCreated {
		t.Fatalf("create finding: code=%d", code)
	}
	id := finding["id"].(string)

	// Associate feature via update
	updated, code := cliDo(t, srv, "findings", "update", []string{
		"--id", id,
		"--features", featID,
	})
	if code != http.StatusOK {
		t.Fatalf("update: code=%d body=%v", code, updated)
	}
	ids, ok := updated["features"].([]any)
	if !ok || len(ids) != 1 || ids[0] != featID {
		t.Errorf("features = %v, want [%s]", updated["features"], featID)
	}
}

func TestCLIIntegration_Features_CreateAllOptionalFields(t *testing.T) {
	srv, head := setupIntegrationServer(t)

	result, code := cliDo(t, srv, "features", "create", []string{
		"--file", "main.go",
		"--commit", head,
		"--kind", "sink",
		"--title", "DB write",
		"--description", "Writes to users table",
		"--operation", "INSERT",
		"--direction", "in",
		"--protocol", "sql",
		"--status", "active",
		"--source", "manual",
		"--tags", "db,write",
	})
	if code != http.StatusCreated {
		t.Fatalf("create: code=%d body=%v", code, result)
	}
	for field, want := range map[string]string{
		"kind":        "sink",
		"description": "Writes to users table",
		"operation":   "INSERT",
		"direction":   "in",
		"protocol":    "sql",
		"status":      "active",
		"source":      "manual",
	} {
		if result[field] != want {
			t.Errorf("%s = %v, want %s", field, result[field], want)
		}
	}
}

func TestCLIIntegration_Features_UpdateAllFields(t *testing.T) {
	srv, head := setupIntegrationServer(t)

	created, code := cliDo(t, srv, "features", "create", []string{
		"--file", "main.go",
		"--commit", head,
		"--kind", "interface",
		"--title", "Original",
	})
	if code != http.StatusCreated {
		t.Fatalf("create: code=%d body=%v", code, created)
	}
	id := created["id"].(string)

	updated, code := cliDo(t, srv, "features", "update", []string{
		"--id", id,
		"--kind", "sink",
		"--title", "Updated",
		"--description", "Updated desc",
		"--operation", "DELETE",
		"--direction", "out",
		"--protocol", "grpc",
		"--status", "deprecated",
	})
	if code != http.StatusOK {
		t.Fatalf("update: code=%d body=%v", code, updated)
	}
	for field, want := range map[string]string{
		"kind":        "sink",
		"title":       "Updated",
		"description": "Updated desc",
		"operation":   "DELETE",
		"direction":   "out",
		"protocol":    "grpc",
		"status":      "deprecated",
	} {
		if updated[field] != want {
			t.Errorf("%s = %v, want %s", field, updated[field], want)
		}
	}
}

func TestCLIIntegration_Comments_UpdateAllFields(t *testing.T) {
	srv, head := setupIntegrationServer(t)

	created, code := cliDo(t, srv, "comments", "create", []string{
		"--author", "alice",
		"--text", "original",
		"--file", "main.go",
		"--commit", head,
	})
	if code != http.StatusCreated {
		t.Fatalf("create: code=%d body=%v", code, created)
	}
	id := created["id"].(string)

	updated, code := cliDo(t, srv, "comments", "update", []string{
		"--id", id,
		"--text", "updated text",
		"--author", "bob",
		"--type", "improvement",
	})
	if code != http.StatusOK {
		t.Fatalf("update: code=%d body=%v", code, updated)
	}
	if updated["text"] != "updated text" {
		t.Errorf("text = %v, want updated text", updated["text"])
	}
	if updated["author"] != "bob" {
		t.Errorf("author = %v, want bob", updated["author"])
	}
	if updated["commentType"] != "improvement" {
		t.Errorf("commentType = %v, want improvement", updated["commentType"])
	}
}
