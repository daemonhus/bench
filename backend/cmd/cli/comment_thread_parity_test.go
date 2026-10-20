package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// A reply joins its parent's thread and takes its finding, through every surface, and a
// reply to a parent that doesn't exist is refused. REST used to ignore the parent, MCP
// started a new thread when the parent was missing, and batch keys like parent were dropped.
func TestCommentReplies_ThreadParity(t *testing.T) {
	e := setupParity(t)
	code, data := e.http(t, "POST", "/api/findings", map[string]any{"title": "SQLi", "severity": "high"})
	if code != 201 {
		t.Fatalf("seed finding: %d %s", code, data)
	}
	var finding map[string]any
	json.Unmarshal(data, &finding)
	code, data = e.http(t, "POST", "/api/comments", map[string]any{"author": "a", "text": "root", "findingId": finding["id"]})
	if code != 201 {
		t.Fatalf("seed root comment: %d %s", code, data)
	}
	var root map[string]any
	json.Unmarshal(data, &root)
	rootID := root["id"].(string)
	// A top-level comment without a thread starts its own.
	if root["threadId"] != rootID {
		t.Errorf("root threadId = %v, want its own id %s", root["threadId"], rootID)
	}

	reply := map[string]func(text, parent string) bool{
		"REST": func(text, parent string) bool {
			code, _ := e.http(t, "POST", "/api/comments", map[string]any{"author": "a", "text": text, "parentId": parent})
			return code == 201
		},
		"MCP": func(text, parent string) bool {
			ok, _ := e.mcpCall(t, "create_comment", map[string]any{"author": "a", "text": text, "parent": parent})
			return ok
		},
		"MCP batch": func(text, parent string) bool {
			ok, _ := e.mcpCall(t, "batch_create_comments", map[string]any{"comments": []any{map[string]any{"author": "a", "text": text, "parent": parent}}})
			return ok
		},
		"CLI": func(text, parent string) bool {
			ok, _ := e.cli(t, "comments", "create", "--author", "a", "--text", text, "--parent", parent)
			return ok
		},
		"CLI batch": func(text, parent string) bool {
			b, _ := json.Marshal([]any{map[string]any{"author": "a", "text": text, "parent": parent}})
			in := filepath.Join(t.TempDir(), "batch.json")
			os.WriteFile(in, b, 0644)
			ok, _ := e.cli(t, "comments", "batch-create", "--input", in)
			return ok
		},
	}
	stored := func(text string) map[string]any {
		_, data := e.http(t, "GET", "/api/comments", nil)
		var items []map[string]any
		json.Unmarshal(data, &items)
		for _, it := range items {
			if it["text"] == text {
				return it
			}
		}
		return nil
	}
	for name, create := range reply {
		text := "reply via " + name
		if !create(text, rootID) {
			t.Errorf("%s: reply refused", name)
			continue
		}
		c := stored(text)
		if c == nil {
			t.Errorf("%s: reply not stored", name)
			continue
		}
		if c["threadId"] != rootID || c["parentId"] != rootID || c["findingId"] != finding["id"] {
			t.Errorf("%s: reply thread=%v parent=%v finding=%v, want %s, %s, %v", name, c["threadId"], c["parentId"], c["findingId"], rootID, rootID, finding["id"])
		}
		orphan := "orphan via " + name
		if create(orphan, "no-such-comment") || stored(orphan) != nil {
			t.Errorf("%s: a reply to a missing parent was accepted", name)
		}
	}
}
