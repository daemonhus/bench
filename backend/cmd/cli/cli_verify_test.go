package main

// Regressions found driving the CLI against a live multi-project server.

import (
	"strings"
	"testing"
)

// JSON output was HTML-escaped: `a && b` printed as `a && b`.
func TestFormatOutput_NoHTMLEscaping(t *testing.T) {
	got := formatOutput([]byte(`{"text":"a && b <c>"}`), 200)
	if !strings.Contains(got, `"a && b <c>"`) {
		t.Errorf("formatOutput = %s", got)
	}
}

func TestParseFlags_Validation(t *testing.T) {
	r := newRecorder(t)
	cases := []struct {
		args []string
		want string
	}{
		// --name=value skipped the unknown-flag check entirely.
		{[]string{"--project", "a", "findings", "list", "--bogus=1"}, "unknown flag: --bogus"},
		// Numeric flags were scanned leniently: "abc" became 0.
		{[]string{"--project", "a", "git", "read-file", "--path", "x", "--start", "abc"}, "--start expects an integer"},
		{[]string{"--project", "a", "findings", "create", "--severity", "low", "--title", "t", "--score", "high"}, "--score expects a number"},
		{[]string{"flows", "list", "--limit", "abc"}, "--limit expects an integer"},
		{[]string{"--project", "a", "baselines", "delete", "--id", "b", "--confirm=maybe"}, "expects true or false"},
	}
	for _, tc := range cases {
		code, _, stderr := runCLI(t, r, nil, tc.args...)
		if code != 1 || !strings.Contains(stderr, tc.want) {
			t.Errorf("%v: exit %d, stderr %q, want %q", tc.args, code, stderr, tc.want)
		}
	}
	if len(r.reqs) != 0 {
		t.Errorf("invalid flags still sent requests: %+v", r.reqs)
	}
}

// --confirm=true was stored as a value, not a bool, so the delete stayed a preview.
func TestParseFlags_BoolEqualsForm(t *testing.T) {
	r := newRecorder(t)
	r.responses["DELETE /api/p/a/api/baselines/b1"] = cannedResp{204, ""}
	if code, _, stderr := runCLI(t, r, nil, "--project", "a", "baselines", "delete", "--id", "b1", "--confirm=true"); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	if got := r.last(t); got.Method != "DELETE" {
		t.Errorf("--confirm=true sent %s %s, want DELETE", got.Method, got.URI)
	}
}

// Enum flags the server silently ignores (or treats as no-match) are rejected
// client-side so a typo doesn't look like a valid empty/default result.
func TestMultiProject_EnumFlagsValidated(t *testing.T) {
	r := newRecorder(t)
	for _, args := range [][]string{
		{"flows", "list", "--sort", "bogus"},
		{"flows", "list", "--order", "up"},
		{"flows", "list", "--status", "active,nope"},
		{"catalog", "search", "--kind", "bogus"},
	} {
		code, _, stderr := runCLI(t, r, nil, args...)
		if code != 1 || !strings.Contains(stderr, "must be one of") {
			t.Errorf("%v: exit %d, stderr %q", args, code, stderr)
		}
	}
	if len(r.reqs) != 0 {
		t.Errorf("sent requests: %+v", r.reqs)
	}
}

// API errors printed as "Error: Error (HTTP 400): ...".
func TestMultiProject_APIErrorNotDoublePrefixed(t *testing.T) {
	r := newRecorder(t)
	r.responses["POST /api/platform/projects"] = cannedResp{400, "path is not a git repository\n"}
	code, _, stderr := runCLI(t, r, nil, "projects", "create", "--name", "x", "--repo-path", "/nope")
	if code != 1 || strings.Contains(stderr, "Error: Error") || !strings.Contains(stderr, "Error (HTTP 400): path is not a git repository") {
		t.Errorf("exit %d, stderr %q", code, stderr)
	}
}

func TestMultiProject_UsageHasNoDoubleSpace(t *testing.T) {
	r := newRecorder(t)
	_, _, stderr := runCLI(t, r, nil, "projects", "create", "--help")
	if !strings.Contains(stderr, "bench projects create [flags]") {
		t.Errorf("usage line: %q", stderr)
	}
}

// A step whose feature or project can't be resolved is kept (tombstoned) by
// the server; the CLI exited 0 silently, hiding typos.
func TestFlowsAddStep_WarnsWhenTombstoned(t *testing.T) {
	r := newRecorder(t)
	r.responses["POST /api/platform/flows/fl1/steps"] = cannedResp{201, `{"id":"s1","tombstoned":true,"tombstonedReason":"feature_not_found"}`}
	code, stdout, stderr := runCLI(t, r, nil, "flows", "add-step", "fl1", "--project", "svc", "--feature", "typo")
	if code != 0 || !strings.Contains(stdout, `"id": "s1"`) || !strings.Contains(stderr, `feature "typo" was not found on project "svc"`) {
		t.Errorf("exit %d, stdout %q, stderr %q", code, stdout, stderr)
	}
	r.responses["POST /api/platform/flows/fl1/steps"] = cannedResp{201, `{"id":"s2","tombstoned":true,"tombstonedReason":"project_not_registered"}`}
	_, _, stderr = runCLI(t, r, nil, "flows", "add-step", "fl1", "--project", "nosuch", "--feature", "f")
	if !strings.Contains(stderr, `project "nosuch" is not registered`) {
		t.Errorf("stderr %q", stderr)
	}
	r.responses["POST /api/platform/flows/fl1/steps"] = cannedResp{201, `{"id":"s3","tombstoned":false}`}
	if _, _, stderr = runCLI(t, r, nil, "flows", "add-step", "fl1", "--project", "svc", "--feature", "f"); stderr != "" {
		t.Errorf("healthy step warned: %q", stderr)
	}
}

// `folders create q/r//s` created q and r before noticing the empty segment.
func TestFoldersCreate_ValidatesWholePathFirst(t *testing.T) {
	r := newRecorder(t)
	code, _, stderr := runCLI(t, r, nil, "flows", "folders", "create", "new/also-new//x")
	if code != 1 || !strings.Contains(stderr, "empty folder name") {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	for _, req := range r.reqs {
		if req.Method != "GET" {
			t.Errorf("partial write: %s %s", req.Method, req.URI)
		}
	}
}

// The flow baseline delete preview echoed the server's "Pass ?confirm=true".
func TestFlowBaselineDelete_PreviewInCLITerms(t *testing.T) {
	r := newRecorder(t)
	r.responses["DELETE /api/platform/flows/fl1/baselines/fb1"] = cannedResp{200,
		`{"dryRun":true,"baseline":{"id":"fb1","seq":3,"reviewer":"pete","summary":"s","createdAt":"2026-01-01"},"message":"Pass ?confirm=true to delete this baseline."}`}
	code, stdout, _ := runCLI(t, r, nil, "flows", "baseline", "delete", "fl1", "fb1")
	if code != 0 || !strings.Contains(stdout, "Dry run - flow baseline #3") || !strings.Contains(stdout, "Pass --confirm") || strings.Contains(stdout, "?confirm") {
		t.Errorf("exit %d, stdout %q", code, stdout)
	}
}
