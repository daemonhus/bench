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

	workbench "bench"
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
	srv   *httptest.Server
	head  string
	first string // the commit before head; head shifts main.go's lines down by two
	dir   string
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
	// Distinct lines, so a hash of the wrong lines is caught.
	var src strings.Builder
	for i := 1; i <= 10; i++ {
		fmt.Fprintf(&src, "// line %d\n", i)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte(src.String()), 0644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"git", "-C", dir, "add", "."}, {"git", "-C", dir, "commit", "-m", "init"}} {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("git commit: %v: %s", err, out)
		}
	}
	first, err := exec.Command("git", "-C", dir, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	// A second commit that moves every line down two, so a position recorded at the wrong
	// commit shows up.
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("// added\n// added\n"+src.String()), 0644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"git", "-C", dir, "commit", "-qam", "shift"}} {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("git commit: %v: %s", err, out)
		}
	}
	head, err := exec.Command("git", "-C", dir, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	// Wired exactly as the servers wire a project: REST and MCP over one database.
	wb, err := workbench.Open(dir, filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { wb.DB.Close() })
	if err := wb.DB.PutServiceProfile(model.ServiceProfile{}); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(wb.Handler())
	t.Cleanup(srv.Close)
	return &parityEnv{srv: srv, head: strings.TrimSpace(string(head)), first: strings.TrimSpace(string(first)), dir: dir}
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

// effective returns the item's stored anchor, line hash and its effective line range at
// commit, as the lists report them (what the UI shows and the reconciler works from).
func (e *parityEnv) effective(t *testing.T, k kindSpec, id, commit string) (stored model.Anchor, hash string, eff *model.LineRange) {
	t.Helper()
	_, data := e.http(t, "GET", "/api/"+k.plural+"?fileId=main.go&commit="+commit, nil)
	var items []struct {
		ID              string        `json:"id"`
		Anchor          model.Anchor  `json:"anchor"`
		LineHash        string        `json:"lineHash"`
		EffectiveAnchor *model.Anchor `json:"effectiveAnchor"`
	}
	json.Unmarshal(data, &items)
	for _, it := range items {
		if it.ID == id {
			if it.EffectiveAnchor != nil {
				eff = it.EffectiveAnchor.LineRange
			}
			return it.Anchor, it.LineHash, eff
		}
	}
	t.Fatalf("%s %s not listed", k.name, id)
	return
}

// Moving an annotation to new lines, through any surface, must leave it tracked at the new
// lines: the stored range, the effective position the reconciler reports, and the line hash it
// matches on. REST moves used to keep reporting the old lines (no new position for findings)
// and keep the old lines' hash (all kinds).
func TestAnchorParity_Move(t *testing.T) {
	e := setupParity(t)
	to := &model.LineRange{Start: 5, End: 6}
	movers := []struct {
		name string
		move func(t *testing.T, k kindSpec, id string) bool
	}{
		{"REST", func(t *testing.T, k kindSpec, id string) bool {
			code, _ := e.http(t, "PATCH", "/api/"+k.plural+"/"+id, map[string]any{"line_start": 5, "line_end": 6})
			return code == 200 || code == 204
		}},
		{"MCP", func(t *testing.T, k kindSpec, id string) bool {
			args := map[string]any{"id": id, "start": 5, "end": 6}
			if k.name == "comment" {
				args["author"] = "a"
			}
			ok, _ := e.mcpCall(t, "update_"+k.name, args)
			return ok
		}},
		{"CLI", func(t *testing.T, k kindSpec, id string) bool {
			args := []string{k.plural, "update", "--id", id, "--start", "5", "--end", "6"}
			if k.name == "comment" {
				args = append(args, "--author", "a")
			}
			ok, _ := e.cli(t, args...)
			return ok
		}},
	}
	olderMovers := []struct {
		name string
		move func(t *testing.T, k kindSpec, id, commit string) bool
	}{
		{"REST", func(t *testing.T, k kindSpec, id, commit string) bool {
			code, _ := e.http(t, "PATCH", "/api/"+k.plural+"/"+id, map[string]any{"commit": commit, "line_start": 5, "line_end": 6})
			return code == 200 || code == 204
		}},
		{"MCP", func(t *testing.T, k kindSpec, id, commit string) bool {
			args := map[string]any{"id": id, "commit": commit, "start": 5, "end": 6}
			if k.name == "comment" {
				args["author"] = "a"
			}
			ok, _ := e.mcpCall(t, "update_"+k.name, args)
			return ok
		}},
		{"CLI", func(t *testing.T, k kindSpec, id, commit string) bool {
			args := []string{k.plural, "update", "--id", id, "--commit", commit, "--start", "5", "--end", "6"}
			if k.name == "comment" {
				args = append(args, "--author", "a")
			}
			ok, _ := e.cli(t, args...)
			return ok
		}},
	}
	create := func(t *testing.T, k kindSpec, text string, lr *model.LineRange) string {
		code, data := e.http(t, "POST", "/api/"+k.plural, with(k.extra, map[string]any{
			k.textField: text, "anchor": map[string]any{"fileId": "main.go", "commitId": e.head, "lineRange": lr},
		}))
		if code != 201 {
			t.Fatalf("create %s: %d %s", text, code, data)
		}
		var m map[string]any
		json.Unmarshal(data, &m)
		return m["id"].(string)
	}
	for _, k := range parityKinds {
		// What an item created at the new lines is tracked by.
		_, wantHash, _ := e.effective(t, k, create(t, k, k.name+" reference", to), e.head)
		if wantHash == "" {
			t.Fatalf("%s reference has no line hash", k.name)
		}
		for _, m := range movers {
			text := fmt.Sprintf("%s moved via %s", k.name, m.name)
			id := create(t, k, text, &model.LineRange{Start: 2, End: 3})
			if !m.move(t, k, id) {
				t.Errorf("%s: move rejected", text)
				continue
			}
			stored, hash, eff := e.effective(t, k, id, e.head)
			if !sameRange(stored.LineRange, to) {
				t.Errorf("%s: stored %v, want %v", text, stored.LineRange, to)
			}
			if !sameRange(eff, to) {
				t.Errorf("%s: effective position at HEAD %v, want %v", text, eff, to)
			}
			if hash != wantHash {
				t.Errorf("%s: line hash is still the old lines' (got %.8s, want %.8s)", text, hash, wantHash)
			}
		}
		// Moved to lines given at an older commit: those lines are where it is at that
		// commit (MCP used to record them at the reconciler's resume point or HEAD instead).
		for _, m := range olderMovers {
			text := fmt.Sprintf("%s moved via %s at the older commit", k.name, m.name)
			id := create(t, k, text, &model.LineRange{Start: 2, End: 3})
			if !m.move(t, k, id, e.first) {
				t.Errorf("%s: move rejected", text)
				continue
			}
			if _, _, eff := e.effective(t, k, id, e.first); !sameRange(eff, to) {
				t.Errorf("%s: effective position at that commit %v, want %v", text, eff, to)
			}
		}
	}
}

// An anchor commit given as "HEAD" is stored as the commit it names, through every surface, on
// create and on update; it used to be stored as the literal "HEAD", which moves.
func TestAnchorParity_HeadPinned(t *testing.T) {
	e := setupParity(t)
	c := lineCase{start: 2, end: 3}
	creators := map[string]func(k kindSpec, text string) (bool, string){
		"REST": func(k kindSpec, text string) (bool, string) {
			code, data := e.http(t, "POST", "/api/"+k.plural, with(k.extra, map[string]any{k.textField: text,
				"anchor": map[string]any{"fileId": "main.go", "commitId": "HEAD", "lineRange": map[string]any{"start": 2, "end": 3}}}))
			return code == 201, string(data)
		},
		"MCP": func(k kindSpec, text string) (bool, string) {
			return e.mcpCall(t, "create_"+k.name, lines(with(k.extra, map[string]any{k.textField: text, "file": "main.go", "commit": "HEAD"}), "start", "end", c))
		},
		"MCP batch": func(k kindSpec, text string) (bool, string) {
			item := lines(with(k.extra, map[string]any{k.textField: text, "file": "main.go", "commit": "HEAD"}), "start", "end", c)
			return e.mcpCall(t, "batch_create_"+k.plural, map[string]any{k.plural: []any{item}})
		},
		"CLI": func(k kindSpec, text string) (bool, string) {
			return e.cli(t, append([]string{k.plural, "create", "--" + k.textField, text, "--file", "main.go", "--commit", "HEAD", "--start", "2", "--end", "3"}, k.cliExtra...)...)
		},
		"CLI batch": func(k kindSpec, text string) (bool, string) {
			item := lines(with(k.extra, map[string]any{k.textField: text, "file": "main.go", "commit": "HEAD"}), "line_start", "line_end", c)
			b, _ := json.Marshal([]any{item})
			in := filepath.Join(t.TempDir(), "batch.json")
			os.WriteFile(in, b, 0644)
			return e.cli(t, k.plural, "batch-create", "--input", in)
		},
	}
	updaters := map[string]func(k kindSpec, id string) bool{
		"REST": func(k kindSpec, id string) bool {
			code, _ := e.http(t, "PATCH", "/api/"+k.plural+"/"+id, map[string]any{"commit": "HEAD"})
			return code == 200 || code == 204
		},
		"MCP": func(k kindSpec, id string) bool {
			args := map[string]any{"id": id, "commit": "HEAD"}
			if k.name == "comment" {
				args["author"] = "a"
			}
			ok, _ := e.mcpCall(t, "update_"+k.name, args)
			return ok
		},
		"CLI": func(k kindSpec, id string) bool {
			args := []string{k.plural, "update", "--id", id, "--commit", "HEAD"}
			if k.name == "comment" {
				args = append(args, "--author", "a")
			}
			ok, _ := e.cli(t, args...)
			return ok
		},
	}
	commitOf := func(k kindSpec, text string) string {
		_, data := e.http(t, "GET", "/api/"+k.plural, nil)
		var items []map[string]any
		json.Unmarshal(data, &items)
		for _, it := range items {
			if it[k.textField] == text {
				return it["anchor"].(map[string]any)["commitId"].(string)
			}
		}
		return "<not stored>"
	}
	for _, k := range parityKinds {
		for name, create := range creators {
			text := fmt.Sprintf("%s created via %s at HEAD", k.name, name)
			if ok, msg := create(k, text); !ok {
				t.Errorf("%s: rejected: %s", text, msg)
				continue
			}
			if got := commitOf(k, text); got != e.head {
				t.Errorf("%s: stored commit %q, want %s", text, got, e.head)
			}
		}
		for name, update := range updaters {
			text := fmt.Sprintf("%s updated via %s to HEAD", k.name, name)
			code, data := e.http(t, "POST", "/api/"+k.plural, with(k.extra, map[string]any{k.textField: text,
				"anchor": map[string]any{"fileId": "main.go", "commitId": e.head, "lineRange": map[string]any{"start": 2, "end": 3}}}))
			if code != 201 {
				t.Fatalf("seed %s: %d %s", text, code, data)
			}
			var m map[string]any
			json.Unmarshal(data, &m)
			if !update(k, m["id"].(string)) {
				t.Errorf("%s: update rejected", text)
				continue
			}
			if got := commitOf(k, text); got != e.head {
				t.Errorf("%s: stored commit %q, want %s", text, got, e.head)
			}
		}
	}
}

// The minimum a create needs is the same through every surface: a finding's title and
// severity, a feature's title and kind, a comment's author and text. File, commit and
// description are optional (a missing commit is HEAD), and a finding with no status given
// starts as a draft. MCP used to also require file, commit and description, and REST and
// the CLI defaulted findings to open.
func TestCreateContractParity(t *testing.T) {
	e := setupParity(t)
	minimal := map[string]map[string]any{
		"finding": {"severity": "high"},
		"feature": {"kind": "interface"},
		"comment": {"author": "a"},
	}
	cliMinimal := map[string][]string{
		"finding": {"--severity", "high"},
		"feature": {"--kind", "interface"},
		"comment": {"--author", "a"},
	}
	surfaces := map[string]func(k kindSpec, item map[string]any, cliArgs []string) (bool, string){
		"REST": func(k kindSpec, item map[string]any, _ []string) (bool, string) {
			code, data := e.http(t, "POST", "/api/"+k.plural, item)
			return code == 201, string(data)
		},
		"MCP": func(k kindSpec, item map[string]any, _ []string) (bool, string) {
			return e.mcpCall(t, "create_"+k.name, item)
		},
		"MCP batch": func(k kindSpec, item map[string]any, _ []string) (bool, string) {
			return e.mcpCall(t, "batch_create_"+k.plural, map[string]any{k.plural: []any{item}})
		},
		"CLI": func(k kindSpec, _ map[string]any, cliArgs []string) (bool, string) {
			return e.cli(t, append([]string{k.plural, "create"}, cliArgs...)...)
		},
		"CLI batch": func(k kindSpec, item map[string]any, _ []string) (bool, string) {
			b, _ := json.Marshal([]any{item})
			in := filepath.Join(t.TempDir(), "batch.json")
			os.WriteFile(in, b, 0644)
			return e.cli(t, k.plural, "batch-create", "--input", in)
		},
	}
	for _, k := range parityKinds {
		for name, create := range surfaces {
			text := fmt.Sprintf("%s via %s with the minimum", k.name, name)
			item := with(minimal[k.name], map[string]any{k.textField: text})
			if ok, msg := create(k, item, append([]string{"--" + k.textField, text}, cliMinimal[k.name]...)); !ok {
				t.Errorf("%s: rejected: %s", text, msg)
				continue
			}
			_, data := e.http(t, "GET", "/api/"+k.plural, nil)
			var items []map[string]any
			json.Unmarshal(data, &items)
			var got map[string]any
			for _, it := range items {
				if it[k.textField] == text {
					got = it
				}
			}
			if got == nil {
				t.Errorf("%s: not stored", text)
				continue
			}
			if c := got["anchor"].(map[string]any)["commitId"]; c != e.head {
				t.Errorf("%s: commit %v, want HEAD (%s)", text, c, e.head)
			}
			if k.name == "finding" && got["status"] != "draft" {
				t.Errorf("%s: status %v, want draft", text, got["status"])
			}
		}
		// Without the text field, every surface refuses.
		for name, create := range surfaces {
			label := fmt.Sprintf("%s via %s without its %s", k.name, name, k.textField)
			if ok, _ := create(k, minimal[k.name], cliMinimal[k.name]); ok {
				t.Errorf("%s: accepted, want rejected", label)
			}
		}
	}
}
