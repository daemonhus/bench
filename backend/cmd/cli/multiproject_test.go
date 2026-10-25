package main

// multiproject_test.go drives the CLI end to end through run() against a
// recording httptest server. It covers --project / BENCH_PROJECT routing of
// per-project commands and the request (method, path, query, body) that each
// multi-project command sends.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type recordedReq struct {
	Method string
	URI    string // path + "?" + raw query
	Body   string
}

// recorder is a fake server that records every request and answers with a
// canned response keyed by "METHOD /path" (query ignored), or 200 {}.
type recorder struct {
	srv       *httptest.Server
	reqs      []recordedReq
	responses map[string]cannedResp
}

type cannedResp struct {
	status int
	body   string
}

func newRecorder(t *testing.T) *recorder {
	t.Helper()
	r := &recorder{responses: map[string]cannedResp{
		// Folder tree used by folder-resolving commands: auth (f1) / login (f2).
		"GET /api/flow-folders": {200, `[{"id":"f1","name":"auth","flowCount":1},{"id":"f2","name":"login","parentId":"f1","flowCount":2}]`},
	}}
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		b, _ := io.ReadAll(req.Body)
		uri := req.URL.EscapedPath()
		if req.URL.RawQuery != "" {
			uri += "?" + req.URL.RawQuery
		}
		r.reqs = append(r.reqs, recordedReq{Method: req.Method, URI: uri, Body: string(b)})
		resp, ok := r.responses[req.Method+" "+req.URL.EscapedPath()]
		if !ok {
			resp = cannedResp{200, `{}`}
		}
		if resp.status == http.StatusNoContent {
			w.WriteHeader(resp.status)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.status)
		io.WriteString(w, resp.body)
	}))
	t.Cleanup(r.srv.Close)
	return r
}

func (r *recorder) last(t *testing.T) recordedReq {
	t.Helper()
	if len(r.reqs) == 0 {
		t.Fatal("no request recorded")
	}
	return r.reqs[len(r.reqs)-1]
}

// runCLI runs the CLI against the recorder with the given env and args.
func runCLI(t *testing.T, r *recorder, env map[string]string, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	getenv := func(k string) string {
		if k == "BENCH_URL" {
			if v, ok := env[k]; ok {
				return v
			}
			return r.srv.URL
		}
		return env[k]
	}
	var out, errb bytes.Buffer
	code = run(args, getenv, &out, &errb)
	return code, out.String(), errb.String()
}

// jsonEqual compares two JSON documents semantically.
func jsonEqual(t *testing.T, got, want string) bool {
	t.Helper()
	var g, w any
	if err := json.Unmarshal([]byte(got), &g); err != nil {
		t.Errorf("body %q is not JSON: %v", got, err)
		return false
	}
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatalf("bad want JSON %q: %v", want, err)
	}
	return reflect.DeepEqual(g, w)
}

// ---------------------------------------------------------------------------
// --project routing
// ---------------------------------------------------------------------------

func TestProject_Required_ListsSlugs(t *testing.T) {
	r := newRecorder(t)
	r.responses["GET /api/projects"] = cannedResp{200, `[{"slug":"alpha","name":"Alpha"},{"slug":"beta","name":"Beta"}]`}
	code, stdout, stderr := runCLI(t, r, nil, "findings", "list", "--severity", "high")
	if code != 1 || stdout != "" {
		t.Fatalf("exit %d, stdout %q, stderr %q", code, stdout, stderr)
	}
	for _, want := range []string{"'bench findings list' needs a project", "--project", "BENCH_PROJECT", "Available projects: alpha, beta"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("stderr %q missing %q", stderr, want)
		}
	}
	// Only the project lookup went out; the command itself was never sent.
	if len(r.reqs) != 1 || r.reqs[0].Method != "GET" || r.reqs[0].URI != "/api/projects" {
		t.Errorf("requests = %+v, want just GET /api/projects", r.reqs)
	}
}

func TestProject_Required_NoProjectsYet(t *testing.T) {
	r := newRecorder(t)
	r.responses["GET /api/projects"] = cannedResp{200, `[]`}
	code, _, stderr := runCLI(t, r, nil, "comments", "list")
	if code != 1 || !strings.Contains(stderr, "No projects yet") || !strings.Contains(stderr, "bench projects create") {
		t.Errorf("exit %d, stderr %q", code, stderr)
	}
}

func TestProject_Required_ServerDown(t *testing.T) {
	r := newRecorder(t)
	r.srv.Close()
	code, _, stderr := runCLI(t, r, map[string]string{"BENCH_URL": r.srv.URL}, "git", "branches")
	if code != 1 || !strings.Contains(stderr, "needs a project") || !strings.Contains(stderr, "Is benchd running?") {
		t.Errorf("exit %d, stderr %q", code, stderr)
	}
}

// Help and flag errors come first: neither needs a project, so they never ask the server.
func TestProject_NotRequiredForHelpOrFlagErrors(t *testing.T) {
	r := newRecorder(t)
	if code, _, _ := runCLI(t, r, nil, "findings", "list", "--help"); code != 0 {
		t.Errorf("command help: exit %d", code)
	}
	if code, _, stderr := runCLI(t, r, nil, "findings", "create", "--severity", "high"); code != 1 || strings.Contains(stderr, "needs a project") {
		t.Errorf("missing required flag: exit %d, stderr %q", code, stderr)
	}
	if len(r.reqs) != 0 {
		t.Errorf("requests = %+v, want none", r.reqs)
	}
}

func TestProject_FlagPrefixesBenchCommands(t *testing.T) {
	for _, args := range [][]string{
		{"--project", "my-api", "findings", "list", "--severity", "high"},
		{"--project=my-api", "findings", "list", "--severity", "high"},
	} {
		r := newRecorder(t)
		if code, _, stderr := runCLI(t, r, nil, args...); code != 0 {
			t.Fatalf("%v: exit %d: %s", args, code, stderr)
		}
		if got := r.last(t).URI; got != "/api/projects/my-api/findings?severity=high" {
			t.Errorf("%v: path = %q", args, got)
		}
	}
}

func TestProject_EnvVar(t *testing.T) {
	r := newRecorder(t)
	env := map[string]string{"BENCH_PROJECT": "from-env"}
	if code, _, stderr := runCLI(t, r, env, "baselines", "delta", "--id", "b1"); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	if got := r.last(t).URI; got != "/api/projects/from-env/baselines/b1/delta" {
		t.Errorf("path = %q", got)
	}

	// The flag wins over the env var.
	if code, _, stderr := runCLI(t, r, env, "--project", "from-flag", "profile", "get"); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	if got := r.last(t).URI; got != "/api/projects/from-flag/profile" {
		t.Errorf("path = %q", got)
	}
}

func TestProject_PrefixKeepsPathParamsAndBody(t *testing.T) {
	r := newRecorder(t)
	if code, _, stderr := runCLI(t, r, nil, "--project", "svc", "git", "read-file", "--commit", "abc123", "--path", "main.go"); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	if got := r.last(t).URI; got != "/api/projects/svc/git/show/abc123/main.go" {
		t.Errorf("path = %q", got)
	}

	if code, _, stderr := runCLI(t, r, nil, "--project", "svc", "findings", "update", "--id", "F1", "--status", "closed"); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	got := r.last(t)
	if got.Method != "PATCH" || got.URI != "/api/projects/svc/findings/F1" || !jsonEqual(t, got.Body, `{"status":"closed"}`) {
		t.Errorf("got %+v", got)
	}
}

func TestProject_PrefixesBatchCreate(t *testing.T) {
	r := newRecorder(t)
	in := filepath.Join(t.TempDir(), "items.json")
	if err := os.WriteFile(in, []byte(`[{"title":"a","severity":"low","file":"x.go","commit":"HEAD"},{"title":"b","severity":"low"}]`), 0o644); err != nil {
		t.Fatal(err)
	}
	code, stdout, stderr := runCLI(t, r, nil, "--project", "svc", "findings", "batch-create", "--input", in)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	if len(r.reqs) != 2 || r.reqs[0].URI != "/api/projects/svc/findings" || r.reqs[1].URI != "/api/projects/svc/findings" {
		t.Errorf("requests = %+v", r.reqs)
	}
	// stdout lists what was created (as JSON); the summary goes to stderr.
	var created []map[string]any
	if err := json.Unmarshal([]byte(stdout), &created); err != nil || len(created) != 2 {
		t.Errorf("stdout = %q, want a JSON list of the 2 created items", stdout)
	}
	if !strings.Contains(stderr, "2/2 succeeded") {
		t.Errorf("stderr = %q", stderr)
	}
}

func TestProject_NotAppliedToMultiProjectCommands(t *testing.T) {
	r := newRecorder(t)
	if code, _, stderr := runCLI(t, r, map[string]string{"BENCH_PROJECT": "svc"}, "flows", "list"); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	if got := r.last(t).URI; got != "/api/flows" {
		t.Errorf("path = %q (flows list must not be project-prefixed or project-filtered)", got)
	}
}

func TestProject_NotFoundHint(t *testing.T) {
	r := newRecorder(t)
	r.responses["GET /api/projects/nope/findings"] = cannedResp{404, "404 page not found\n"}
	// Errors go to stderr (like the multi-project commands), so `> out.json` only ever holds data.
	code, stdout, stderr := runCLI(t, r, nil, "--project", "nope", "findings", "list")
	if code != 1 || stdout != "" || !strings.Contains(stderr, "hint: --project \"nope\" is set") {
		t.Errorf("exit %d, stdout %q, stderr %q", code, stdout, stderr)
	}

	r.responses["GET /api/projects"] = cannedResp{404, "404 page not found\n"}
	code, _, stderr = runCLI(t, r, nil, "projects", "list")
	if code != 1 || !strings.Contains(stderr, "404 page not found") || strings.Contains(stderr, "needs a multi-project server") {
		t.Errorf("exit %d, stderr %q", code, stderr)
	}
}

func TestProject_HTMLFallthroughIsAnError(t *testing.T) {
	r := newRecorder(t)
	r.responses["GET /api/projects/svc/findings"] = cannedResp{200, "<!doctype html>\n<html><body>app</body></html>"}
	code, _, stderr := runCLI(t, r, nil, "--project", "svc", "findings", "list")
	if code != 1 || !strings.Contains(stderr, "HTML page") {
		t.Errorf("exit %d, stderr %q", code, stderr)
	}
}

func TestRootHelp_ListsServerWideSection(t *testing.T) {
	r := newRecorder(t)
	code, _, stderr := runCLI(t, r, nil, "--help")
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	for _, want := range []string{"Project categories (need --project", "Server-wide categories", "projects", "baselines-all", "flows", "catalog", "--project", "BENCH_PROJECT", "profile"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("root help missing %q", want)
		}
	}
}

// ---------------------------------------------------------------------------
// Multi-project commands: one request each
// ---------------------------------------------------------------------------

func TestMultiProjectCommands_Requests(t *testing.T) {
	cases := []struct {
		name     string
		env      map[string]string
		args     []string
		method   string
		uri      string
		body     string // JSON; "" means no body expected
		stdoutHa string // substring expected in stdout (optional)
	}{
		// projects
		{name: "projects list", args: []string{"projects", "list", "--json"}, method: "GET", uri: "/api/projects"},
		{name: "projects create", args: []string{"projects", "create", "--name", "My API", "--repo-path", "/src/api"},
			method: "POST", uri: "/api/projects", body: `{"name":"My API","repoPath":"/src/api"}`},
		{name: "projects update positional", args: []string{"projects", "update", "my-api", "--repo-path", "/new"},
			method: "PATCH", uri: "/api/projects/my-api", body: `{"repoPath":"/new"}`},
		{name: "projects delete flag", args: []string{"projects", "delete", "--slug", "my-api"},
			method: "DELETE", uri: "/api/projects/my-api", stdoutHa: `Deleted project "my-api"`},

		// baselines-all (bare group runs its default command)
		{name: "baselines-all", args: []string{"baselines-all"}, method: "GET", uri: "/api/baselines"},
		{name: "baselines-all list", args: []string{"baselines-all", "list"}, method: "GET", uri: "/api/baselines"},

		// flows CRUD
		{name: "flows list filters", args: []string{"flows", "list", "--status", "active", "--tag", "auth,web", "--project", "svc", "--owner", "pete", "--query", "login", "--sort", "name", "--order", "asc", "--limit", "5", "--offset", "10"},
			method: "GET", uri: "/api/flows?limit=5&offset=10&order=asc&owner=pete&project=svc&q=login&sort=name&status=active&tag=auth&tag=web"},
		{name: "flows list folder path", args: []string{"flows", "list", "--folder", "auth/login"},
			method: "GET", uri: "/api/flows?folder=f2"},
		{name: "flows list folder root", args: []string{"flows", "list", "--folder", "/"},
			method: "GET", uri: "/api/flows?folder=root"},
		{name: "flows get", args: []string{"flows", "get", "fl1"}, method: "GET", uri: "/api/flows/fl1"},
		{name: "flows create", args: []string{"flows", "create", "--name", "Login", "--tags", "auth, web", "--owner", "pete", "--folder", "auth"},
			method: "POST", uri: "/api/flows", body: `{"name":"Login","description":"","status":"draft","owner":"pete","tags":["auth","web"],"folderId":"f1"}`},
		{name: "flows update", args: []string{"flows", "update", "fl1", "--status", "active", "--tags", "", "--folder", "root"},
			method: "PATCH", uri: "/api/flows/fl1", body: `{"status":"active","tags":[],"folderId":""}`},
		{name: "flows update clears description and owner", args: []string{"flows", "update", "fl1", "--description", "", "--owner", ""},
			method: "PATCH", uri: "/api/flows/fl1", body: `{"description":"","owner":""}`},
		{name: "flows delete confirm", args: []string{"flows", "delete", "fl1", "--confirm"},
			method: "DELETE", uri: "/api/flows/fl1", stdoutHa: `Deleted flow "fl1"`},

		// steps
		{name: "flows add-step", args: []string{"flows", "add-step", "fl1", "--project", "svc", "--feature", "feat-1", "--parent", "s0", "--condition", "ok", "--note", "n"},
			method: "POST", uri: "/api/flows/fl1/steps", body: `{"projectSlug":"svc","featureId":"feat-1","from":"s0","edge":{"condition":"ok"},"note":"n"}`},
		{name: "flows add-step global project default", env: map[string]string{"BENCH_PROJECT": "envsvc"}, args: []string{"flows", "add-step", "--flow", "fl1", "--feature", "feat-1"},
			method: "POST", uri: "/api/flows/fl1/steps", body: `{"projectSlug":"envsvc","featureId":"feat-1"}`},
		{name: "flows add-step placed with an edge", args: []string{"flows", "add-step", "fl1", "--project", "svc", "--feature", "f", "--after", "s1",
			"--actor", "admin", "--controls", "authn,authz", "--kind", "call", "--protocol", "grpc", "--auth", "mtls", "--trust-boundary", "true", "--tainted", "false", "--data", "token", "--tags", "pii"},
			method: "POST", uri: "/api/flows/fl1/steps", body: `{"projectSlug":"svc","featureId":"f","after":"s1","actor":"admin","controls":["authn","authz"],
				"edge":{"kind":"call","protocol":"grpc","auth":"mtls","trustBoundary":true,"tainted":false,"data":"token","tags":["pii"]}}`},
		{name: "flows add-step entry", args: []string{"flows", "add-step", "fl1", "--project", "svc", "--feature", "f", "--entry"},
			method: "POST", uri: "/api/flows/fl1/steps", body: `{"projectSlug":"svc","featureId":"f","entry":true}`},
		{name: "flows update-step", args: []string{"flows", "update-step", "fl1", "s1", "--note", "hello"},
			method: "PATCH", uri: "/api/flows/fl1/steps/s1", body: `{"note":"hello"}`},
		{name: "flows update-step repoint", args: []string{"flows", "update-step", "fl1", "s1", "--feature", "f2", "--project", "web", "--actor", "user", "--controls", "", "--condition", "if x"},
			method: "PATCH", uri: "/api/flows/fl1/steps/s1", body: `{"featureId":"f2","projectSlug":"web","actor":"user","controls":[],"branchCondition":"if x"}`},
		{name: "flows remove-step", args: []string{"flows", "remove-step", "fl1", "s1"}, method: "DELETE", uri: "/api/flows/fl1/steps/s1"},
		{name: "flows remove-step subtree", args: []string{"flows", "remove-step", "fl1", "s1", "--mode", "subtree"}, method: "DELETE", uri: "/api/flows/fl1/steps/s1?mode=subtree"},
		{name: "flows move-step", args: []string{"flows", "move-step", "fl1", "s1", "up"}, method: "POST", uri: "/api/flows/fl1/steps/s1/move?dir=-1"},
		{name: "flows move-step flags", args: []string{"flows", "move-step", "--flow", "fl1", "--step", "s1", "--direction", "down"}, method: "POST", uri: "/api/flows/fl1/steps/s1/move?dir=1"},
		{name: "flows move-step to a place", args: []string{"flows", "move-step", "fl1", "s1", "--from", "s0", "--condition", "retry"},
			method: "POST", uri: "/api/flows/fl1/steps/s1/move", body: `{"from":"s0","edge":{"condition":"retry"}}`},
		{name: "flows export", args: []string{"flows", "export", "fl1"}, method: "GET", uri: "/api/flows/fl1/export"},

		// edges
		{name: "flows set-edge", args: []string{"flows", "set-edge", "fl1", "s1", "s2", "--description", "calls", "--tags", "auth", "--kind", "async", "--position", "0"},
			method: "PUT", uri: "/api/flows/fl1/edges/s1/s2", body: `{"description":"calls","tags":["auth"],"kind":"async","position":0}`},
		// Only given flags are sent, so the server keeps the edge's other fields.
		{name: "flows set-edge partial", args: []string{"flows", "set-edge", "fl1", "s1", "s2", "--comment", ""},
			method: "PUT", uri: "/api/flows/fl1/edges/s1/s2", body: `{"comment":""}`},
		{name: "flows delete-edge", args: []string{"flows", "delete-edge", "fl1", "s1", "s2"}, method: "DELETE", uri: "/api/flows/fl1/edges/s1/s2"},
		{name: "map show", args: []string{"map", "show", "--archived"}, method: "GET", uri: "/api/service-map?archived=1"},
		{name: "map", args: []string{"map"}, method: "GET", uri: "/api/service-map"},

		// discovery / review
		{name: "flows facets", args: []string{"flows", "facets", "--status", "active", "--project", "a,b"},
			method: "GET", uri: "/api/flows/facets?project=a&project=b&status=active"},
		{name: "flows delta latest", args: []string{"flows", "delta", "fl1"}, method: "GET", uri: "/api/flows/fl1/delta"},
		{name: "flows delta since", args: []string{"flows", "delta", "fl1", "fb1"}, method: "GET", uri: "/api/flows/fl1/delta?since=fb1"},
		{name: "flows findings", args: []string{"flows", "findings", "fl1"}, method: "GET", uri: "/api/flows/fl1/findings"},

		// flow baselines
		{name: "flows baseline set", args: []string{"flows", "baseline", "set", "fl1", "--reviewer", "pete", "--summary", "s"},
			method: "POST", uri: "/api/flows/fl1/baselines", body: `{"reviewer":"pete","summary":"s"}`},
		{name: "flows baselines alias list", args: []string{"flows", "baselines", "list", "fl1"}, method: "GET", uri: "/api/flows/fl1/baselines"},
		{name: "flows baseline get default latest", args: []string{"flows", "baseline", "get", "fl1"}, method: "GET", uri: "/api/flows/fl1/baselines/latest"},
		{name: "flows baseline get id", args: []string{"flows", "baseline", "get", "fl1", "fb1"}, method: "GET", uri: "/api/flows/fl1/baselines/fb1"},
		{name: "flows baseline delete preview", args: []string{"flows", "baseline", "delete", "fl1", "fb1"}, method: "DELETE", uri: "/api/flows/fl1/baselines/fb1"},
		{name: "flows baseline delete confirm", args: []string{"flows", "baseline", "delete", "fl1", "fb1", "--confirm"}, method: "DELETE", uri: "/api/flows/fl1/baselines/fb1?confirm=true"},

		// folders + move
		{name: "folders list", args: []string{"flows", "folders", "list", "--tree"}, method: "GET", uri: "/api/flow-folders", stdoutHa: "  login/  (2 flows)  f2"},
		{name: "folders create nested", args: []string{"flows", "folders", "create", "auth/login/mfa"},
			method: "POST", uri: "/api/flow-folders", body: `{"name":"mfa","parentId":"f2"}`},
		{name: "folders rename", args: []string{"flows", "folders", "rename", "auth/login", "signin"},
			method: "PATCH", uri: "/api/flow-folders/f2", body: `{"name":"signin"}`},
		{name: "folders move to top", args: []string{"flows", "folders", "move", "auth/login", "/"},
			method: "POST", uri: "/api/flows/move", body: `{"folderIds":["f2"],"targetFolderId":""}`},
		{name: "folders delete preview", args: []string{"flows", "folders", "delete", "auth"},
			method: "DELETE", uri: "/api/flow-folders/f1", stdoutHa: "Pass --confirm"},
		{name: "folders delete confirm", args: []string{"flows", "folders", "delete", "f1", "--confirm"},
			method: "DELETE", uri: "/api/flow-folders/f1?confirm=true"},
		{name: "flows move variadic", args: []string{"flows", "move", "fl1", "fl2", "--folder", "auth/login"},
			method: "POST", uri: "/api/flows/move", body: `{"flowIds":["fl1","fl2"],"targetFolderId":"f2"}`},
		{name: "flows move ids flag", args: []string{"flows", "move", "--ids", "fl1,fl2", "--folder", "/"},
			method: "POST", uri: "/api/flows/move", body: `{"flowIds":["fl1","fl2"],"targetFolderId":""}`},

		// saved views
		{name: "views list", args: []string{"flows", "views", "list"}, method: "GET", uri: "/api/flow-views"},
		{name: "views create", args: []string{"flows", "views", "create", "--name", "Active auth", "--query", "status=active&tag=auth", "--shared"},
			method: "POST", uri: "/api/flow-views", body: `{"name":"Active auth","query":"status=active&tag=auth","owner":"","isShared":true}`},
		{name: "views update", args: []string{"flows", "views", "update", "v1", "--name", "Renamed", "--private"},
			method: "PATCH", uri: "/api/flow-views/v1", body: `{"name":"Renamed","isShared":false}`},
		{name: "views delete", args: []string{"flows", "views", "delete", "v1"}, method: "DELETE", uri: "/api/flow-views/v1"},

		// catalog
		{name: "catalog search", args: []string{"catalog", "search", "login", "--kind", "interface", "--projects", "a,b", "--limit", "10"},
			method: "GET", uri: "/api/features/search?kind=interface&limit=10&project=a&project=b&q=login"},
		{name: "catalog get", args: []string{"catalog", "get", "svc:feat-1", "web:feat-2"},
			method: "GET", uri: "/api/features?refs=svc%3Afeat-1%2Cweb%3Afeat-2"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newRecorder(t)
			code, stdout, stderr := runCLI(t, r, tc.env, tc.args...)
			if code != 0 {
				t.Fatalf("exit %d\nstdout: %s\nstderr: %s", code, stdout, stderr)
			}
			got := r.last(t)
			if got.Method != tc.method || got.URI != tc.uri {
				t.Errorf("request = %s %s, want %s %s", got.Method, got.URI, tc.method, tc.uri)
			}
			if tc.body == "" {
				if got.Body != "" {
					t.Errorf("unexpected body %q", got.Body)
				}
			} else if !jsonEqual(t, got.Body, tc.body) {
				t.Errorf("body = %s, want %s", got.Body, tc.body)
			}
			if tc.stdoutHa != "" && !strings.Contains(stdout, tc.stdoutHa) {
				t.Errorf("stdout %q missing %q", stdout, tc.stdoutHa)
			}
		})
	}
}

func TestFlowsDelete_DryRunOnlyReads(t *testing.T) {
	r := newRecorder(t)
	r.responses["GET /api/flows/fl1"] = cannedResp{200, `{"id":"fl1","name":"Login","steps":[{},{}]}`}
	code, stdout, stderr := runCLI(t, r, nil, "flows", "delete", "fl1")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	for _, req := range r.reqs {
		if req.Method != "GET" {
			t.Errorf("dry run sent %s %s", req.Method, req.URI)
		}
	}
	if !strings.Contains(stdout, `flow "Login" (id: fl1, 2 steps) would be deleted`) {
		t.Errorf("stdout = %q", stdout)
	}
}

func TestFlowsSetSteps_SendsInputVerbatim(t *testing.T) {
	r := newRecorder(t)
	in := filepath.Join(t.TempDir(), "steps.json")
	doc := `{"steps":[{"id":"s1","projectSlug":"svc","featureId":"f"}],"links":[]}`
	if err := os.WriteFile(in, []byte(doc), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, _, stderr := runCLI(t, r, nil, "flows", "set-steps", "fl1", "--input", in); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	got := r.last(t)
	if got.Method != "PUT" || got.URI != "/api/flows/fl1/steps" || got.Body != doc {
		t.Errorf("got %+v", got)
	}
}

func TestProjectsList_Table(t *testing.T) {
	r := newRecorder(t)
	r.responses["GET /api/projects"] = cannedResp{200, `[{"name":"My API","slug":"my-api","repoPath":"/src/api","stats":{"findingsTotal":3,"findingsOpen":1,"commentsTotal":2,"commentsOpen":0}}]`}
	code, stdout, stderr := runCLI(t, r, nil, "projects", "list")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	for _, want := range []string{"SLUG", "my-api", "3 (1 open)", "/src/api"} {
		if !strings.Contains(stdout, want) {
			t.Errorf("stdout missing %q:\n%s", want, stdout)
		}
	}
}

func TestMultiProject_ArgErrors(t *testing.T) {
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"flows", "get"}, "missing required flag(s): --id"},
		{[]string{"flows", "get", "a", "b"}, "unexpected argument: b"},
		{[]string{"flows", "get", "a", "--id", "b"}, "given both as an argument and as --id"},
		{[]string{"flows", "list", "--bogus"}, "unknown flag: --bogus"},
		{[]string{"flows", "move-step", "fl1", "s1", "sideways"}, "direction must be 'up' or 'down'"},
		{[]string{"flows", "list", "--folder", "nope"}, `no folder "nope"`},
		{[]string{"flows", "add-step", "fl1", "--feature", "f"}, "--project is required"},
		{[]string{"flows", "nope"}, `unknown command "nope" in "flows"`},
		{[]string{"catalog", "get", "no-colon"}, "not of the form slug:feature-id"},
		{[]string{"flows", "views", "update", "v1", "--shared", "--private"}, "mutually exclusive"},
	}
	for _, tc := range cases {
		r := newRecorder(t)
		code, _, stderr := runCLI(t, r, nil, tc.args...)
		if code != 1 || !strings.Contains(stderr, tc.want) {
			t.Errorf("%v: exit %d, stderr %q, want %q", tc.args, code, stderr, tc.want)
		}
	}
}

func TestMultiProject_APIErrorExitsNonZero(t *testing.T) {
	r := newRecorder(t)
	r.responses["GET /api/flows/missing"] = cannedResp{404, `{"error":"flow not found"}`}
	code, _, stderr := runCLI(t, r, nil, "flows", "get", "missing")
	if code != 1 || !strings.Contains(stderr, "flow not found") {
		t.Errorf("exit %d, stderr %q", code, stderr)
	}
}

func TestMultiProject_HelpListsEveryCommand(t *testing.T) {
	r := newRecorder(t)
	for _, g := range mpGroups {
		args := strings.Fields(g.path())
		code, _, stderr := runCLI(t, r, nil, append(args, "--help")...)
		if code != 0 {
			t.Errorf("%s --help: exit %d", g.path(), code)
		}
		for _, cmd := range mpCommands {
			if cmd.Group == g.path() && !strings.Contains(stderr, cmd.Name) {
				t.Errorf("%s help missing %q", g.path(), cmd.Name)
			}
		}
	}
	for _, cmd := range mpCommands {
		args := append(strings.Fields(cmd.Group), cmd.Name, "--help")
		code, _, stderr := runCLI(t, r, nil, args...)
		if code != 0 || !strings.Contains(stderr, "bench "+cmd.Group+" "+cmd.Name) {
			t.Errorf("%v: exit %d, help %q", args, code, stderr)
		}
		if cmd.Run == nil {
			t.Errorf("%s %s has no Run", cmd.Group, cmd.Name)
		}
	}
	if len(r.reqs) != 0 {
		t.Errorf("help sent requests: %+v", r.reqs)
	}
}

// A nested file path keeps its slashes; only characters inside a segment are escaped.
func TestReadFile_KeepsPathSlashes(t *testing.T) {
	r := newRecorder(t)
	code, _, stderr := runCLI(t, r, nil, "--project", "alpha", "git", "read-file", "--commit", "HEAD", "--path", "src/a b/c.go")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	if got, want := r.last(t).URI, "/api/projects/alpha/git/show/HEAD/src/a%20b/c.go"; got != want {
		t.Fatalf("URI = %q, want %q", got, want)
	}
}
