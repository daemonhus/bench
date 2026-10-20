package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// batch-create prints the created IDs as JSON on stdout (index into the input, ID), so a
// script can link what it just made; progress and the summary go to stderr. Bodies used
// to be thrown away.
func TestBatchCreate_PrintsCreatedIDs(t *testing.T) {
	e := setupParity(t)
	b, _ := json.Marshal([]any{
		map[string]any{"title": "first", "severity": "low"},
		map[string]any{"title": "", "severity": "low"}, // refused: no title
		map[string]any{"title": "third", "severity": "high"},
	})
	in := filepath.Join(t.TempDir(), "batch.json")
	os.WriteFile(in, b, 0644)
	var stdout, stderr bytes.Buffer
	getenv := func(k string) string {
		if k == "BENCH_URL" {
			return e.srv.URL
		}
		return ""
	}
	if code := run([]string{"findings", "batch-create", "--input", in}, getenv, &stdout, &stderr); code == 0 {
		t.Error("exit 0 with a refused item, want non-zero")
	}
	var created []struct {
		Index int    `json:"index"`
		ID    string `json:"id"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &created); err != nil {
		t.Fatalf("stdout is not the JSON list of IDs: %v\n%s", err, stdout.String())
	}
	if len(created) != 2 || created[0].Index != 0 || created[1].Index != 2 {
		t.Fatalf("created = %+v, want items 0 and 2", created)
	}
	for i, title := range map[int]string{0: "first", 1: "third"} {
		code, data := e.http(t, "GET", "/api/findings/"+created[i].ID, nil)
		if code != 200 || !strings.Contains(string(data), fmt.Sprintf("%q", title)) {
			t.Errorf("GET %s = %d, want the %q finding", created[i].ID, code, title)
		}
	}
	if !strings.Contains(stderr.String(), "2/3 succeeded") || !strings.Contains(stderr.String(), "created "+created[0].ID) {
		t.Errorf("stderr = %q, want per-item progress and the summary", stderr.String())
	}
}
