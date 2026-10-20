package main

import (
	"bytes"
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
	"bench/internal/mcp"
	"bench/internal/model"
)

// Line-range parity: the same lines given through REST, MCP (single and batch) and the CLI
// (flags and batch JSON) must store the same range, or be rejected by all of them, for
// findings, features and comments alike, on create and on update. Each surface used to build
// ranges its own way, and a start without an end was dropped by some and stored as N-0 by
// others; model.ParseLineRange is now the one rule, enforced in the store.

type lineCase struct {
	name       string
	start, end int // 0 = not given
	want       *model.LineRange
	reject     bool
}

type kindSpec struct {
	name, plural, textField string
	extra                   map[string]any // required fields besides the anchor and the text
	cliExtra                []string
}

var parityKinds = []kindSpec{
	{"finding", "findings", "title", map[string]any{"severity": "high", "description": "d"}, []string{"--severity", "high"}},
	{"feature", "features", "title", map[string]any{"kind": "interface"}, []string{"--kind", "interface"}},
	{"comment", "comments", "text", map[string]any{"author": "a"}, []string{"--author", "a"}},
}

type parityEnv struct {
	srv  *httptest.Server
	head string
	dir  string
}

func setupParity(t *testing.T) *parityEnv {
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
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte(strings.Repeat("// line\n", 10)), 0644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"git", "-C", dir, "add", "."}, {"git", "-C", dir, "commit", "-m", "init"}} {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("git commit: %v: %s", err, out)
		}
	}
	head, err := exec.Command("git", "-C", dir, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	database, err := db.Open(filepath.Join(t.TempDir(), "test.db"), "test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	if err := database.PutServiceProfile(model.ServiceProfile{}); err != nil {
		t.Fatal(err)
	}
	repo := git.NewRepo(dir)
	mux := http.NewServeMux()
	mux.Handle("/mcp", mcp.NewHandler(database, repo, nil, nil))
	mux.Handle("/", api.NewRouter(repo, database, nil))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &parityEnv{srv: srv, head: strings.TrimSpace(string(head)), dir: dir}
}

func (e *parityEnv) http(t *testing.T, method, path string, body any) (int, []byte) {
	t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, r)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data
}

// mcpCall runs an MCP tool and reports whether it succeeded, with its message.
func (e *parityEnv) mcpCall(t *testing.T, tool string, args map[string]any) (bool, string) {
	t.Helper()
	code, data := e.http(t, "POST", "/mcp", map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "tools/call",
		"params": map[string]any{"name": tool, "arguments": args},
	})
	if code != 200 {
		t.Fatalf("mcp %s: HTTP %d: %s", tool, code, data)
	}
	var out struct {
		Result struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
		Error *struct{ Message string } `json:"error"`
	}
	json.Unmarshal(data, &out)
	if out.Error != nil {
		t.Fatalf("mcp %s: %s", tool, out.Error.Message)
	}
	msg := ""
	if len(out.Result.Content) > 0 {
		msg = out.Result.Content[0].Text
	}
	return !out.Result.IsError, msg
}

func (e *parityEnv) cli(t *testing.T, args ...string) (bool, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	getenv := func(k string) string {
		if k == "BENCH_URL" {
			return e.srv.URL
		}
		return ""
	}
	code := run(args, getenv, &stdout, &stderr)
	return code == 0, stdout.String() + stderr.String()
}

// stored finds the item with this text and returns its stored range (or found=false).
func (e *parityEnv) stored(t *testing.T, k kindSpec, text string) (id string, lr *model.LineRange, found bool) {
	t.Helper()
	code, data := e.http(t, "GET", "/api/"+k.plural, nil)
	if code != 200 {
		t.Fatalf("list %s: %d %s", k.plural, code, data)
	}
	var items []map[string]any
	json.Unmarshal(data, &items)
	for _, it := range items {
		if it[k.textField] != text {
			continue
		}
		b, _ := json.Marshal(it["anchor"])
		var a model.Anchor
		json.Unmarshal(b, &a)
		return it["id"].(string), a.LineRange, true
	}
	return "", nil, false
}

// lines adds the case's start/end under the given keys, leaving out what wasn't given.
func lines(m map[string]any, startKey, endKey string, c lineCase) map[string]any {
	if c.start != 0 {
		m[startKey] = c.start
	}
	if c.end != 0 {
		m[endKey] = c.end
	}
	return m
}

func with(base map[string]any, more map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range more {
		out[k] = v
	}
	return out
}

func sameRange(a, b *model.LineRange) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

func TestLineRangeParity_Create(t *testing.T) {
	e := setupParity(t)
	cases := []lineCase{
		{name: "start and end", start: 3, end: 5, want: &model.LineRange{Start: 3, End: 5}},
		{name: "start only", start: 4, want: &model.LineRange{Start: 4, End: 4}},
		{name: "no lines", want: nil},
		{name: "end only", end: 4, reject: true},
		{name: "inverted", start: 5, end: 3, reject: true},
	}
	surfaces := []struct {
		name   string
		create func(t *testing.T, k kindSpec, text string, c lineCase) (bool, string)
	}{
		{"REST", func(t *testing.T, k kindSpec, text string, c lineCase) (bool, string) {
			anchor := map[string]any{"fileId": "main.go", "commitId": e.head}
			if c.start != 0 || c.end != 0 {
				anchor["lineRange"] = lines(map[string]any{}, "start", "end", c)
			}
			code, data := e.http(t, "POST", "/api/"+k.plural, with(k.extra, map[string]any{k.textField: text, "anchor": anchor}))
			if code != 201 && code != 400 {
				t.Fatalf("REST create %s: unexpected %d %s", k.name, code, data)
			}
			return code == 201, string(data)
		}},
		{"MCP", func(t *testing.T, k kindSpec, text string, c lineCase) (bool, string) {
			return e.mcpCall(t, "create_"+k.name, lines(with(k.extra, map[string]any{k.textField: text, "file": "main.go", "commit": e.head}), "start", "end", c))
		}},
		{"MCP batch", func(t *testing.T, k kindSpec, text string, c lineCase) (bool, string) {
			item := lines(with(k.extra, map[string]any{k.textField: text, "file": "main.go", "commit": e.head}), "start", "end", c)
			return e.mcpCall(t, "batch_create_"+k.plural, map[string]any{k.plural: []any{item}})
		}},
		{"CLI", func(t *testing.T, k kindSpec, text string, c lineCase) (bool, string) {
			args := append([]string{k.plural, "create", "--" + k.textField, text, "--file", "main.go", "--commit", e.head}, k.cliExtra...)
			if c.start != 0 {
				args = append(args, "--start", fmt.Sprint(c.start))
			}
			if c.end != 0 {
				args = append(args, "--end", fmt.Sprint(c.end))
			}
			return e.cli(t, args...)
		}},
		{"CLI batch", func(t *testing.T, k kindSpec, text string, c lineCase) (bool, string) {
			item := lines(with(k.extra, map[string]any{k.textField: text, "file": "main.go", "commit": e.head}), "line_start", "line_end", c)
			b, _ := json.Marshal([]any{item})
			in := filepath.Join(t.TempDir(), "batch.json")
			os.WriteFile(in, b, 0644)
			return e.cli(t, k.plural, "batch-create", "--input", in)
		}},
	}
	for _, k := range parityKinds {
		for _, c := range cases {
			for _, s := range surfaces {
				text := fmt.Sprintf("%s via %s: %s", k.name, s.name, c.name)
				ok, msg := s.create(t, k, text, c)
				_, got, found := e.stored(t, k, text)
				switch {
				case c.reject && (ok || found):
					t.Errorf("%s: accepted (stored %v), want rejected; said: %s", text, got, msg)
				case !c.reject && !ok:
					t.Errorf("%s: rejected, want stored %v; said: %s", text, c.want, msg)
				case !c.reject && !found:
					t.Errorf("%s: reported success but nothing stored; said: %s", text, msg)
				case !c.reject && !sameRange(got, c.want):
					t.Errorf("%s: stored %v, want %v", text, got, c.want)
				}
			}
		}
	}
}

func TestLineRangeParity_Update(t *testing.T) {
	e := setupParity(t)
	start := &model.LineRange{Start: 2, End: 3} // each item starts at lines 2-3
	cases := []lineCase{
		{name: "start earlier", start: 1, want: &model.LineRange{Start: 1, End: 3}},
		{name: "start moved past the end", start: 6, want: &model.LineRange{Start: 6, End: 6}},
		{name: "end later", end: 7, want: &model.LineRange{Start: 2, End: 7}},
		{name: "end before the start", end: 1, reject: true},
		{name: "inverted", start: 5, end: 4, reject: true},
	}
	surfaces := []struct {
		name   string
		update func(t *testing.T, k kindSpec, id string, c lineCase) (bool, string)
	}{
		{"REST", func(t *testing.T, k kindSpec, id string, c lineCase) (bool, string) {
			code, data := e.http(t, "PATCH", "/api/"+k.plural+"/"+id, lines(map[string]any{}, "line_start", "line_end", c))
			if code != 200 && code != 204 && code != 400 {
				t.Fatalf("REST update %s: unexpected %d %s", k.name, code, data)
			}
			return code != 400, string(data)
		}},
		{"MCP", func(t *testing.T, k kindSpec, id string, c lineCase) (bool, string) {
			args := lines(map[string]any{"id": id}, "start", "end", c)
			if k.name == "comment" {
				args["author"] = "a"
			}
			return e.mcpCall(t, "update_"+k.name, args)
		}},
		{"CLI", func(t *testing.T, k kindSpec, id string, c lineCase) (bool, string) {
			args := []string{k.plural, "update", "--id", id}
			if k.name == "comment" {
				args = append(args, "--author", "a")
			}
			if c.start != 0 {
				args = append(args, "--start", fmt.Sprint(c.start))
			}
			if c.end != 0 {
				args = append(args, "--end", fmt.Sprint(c.end))
			}
			return e.cli(t, args...)
		}},
	}
	for _, k := range parityKinds {
		for _, c := range cases {
			for _, s := range surfaces {
				text := fmt.Sprintf("%s via %s: %s", k.name, s.name, c.name)
				code, data := e.http(t, "POST", "/api/"+k.plural, with(k.extra, map[string]any{
					k.textField: text,
					"anchor":    map[string]any{"fileId": "main.go", "commitId": e.head, "lineRange": start},
				}))
				if code != 201 {
					t.Fatalf("seed %s: %d %s", text, code, data)
				}
				id, _, _ := e.stored(t, k, text)
				ok, msg := s.update(t, k, id, c)
				_, got, _ := e.stored(t, k, text)
				switch {
				case c.reject && ok:
					t.Errorf("%s: accepted (stored %v), want rejected", text, got)
				case c.reject && !sameRange(got, start):
					t.Errorf("%s: rejected but the range changed to %v", text, got)
				case !c.reject && !ok:
					t.Errorf("%s: rejected, want %v; said: %s", text, c.want, msg)
				case !c.reject && !sameRange(got, c.want):
					t.Errorf("%s: stored %v, want %v", text, got, c.want)
				}
			}
		}
	}
}
