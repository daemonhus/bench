package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// A finding can only link to features that exist in the project, through every surface;
// unknown IDs used to be stored (the join table has no foreign key), leaving dangling links.
func TestFindingFeatureLinks_UnknownRefused(t *testing.T) {
	e := setupParity(t)
	code, data := e.http(t, "POST", "/api/features", map[string]any{"title": "Login", "kind": "interface"})
	if code != 201 {
		t.Fatalf("seed feature: %d %s", code, data)
	}
	var feat map[string]any
	json.Unmarshal(data, &feat)
	real := feat["id"].(string)

	create := map[string]func(title string, features []string) bool{
		"REST": func(title string, features []string) bool {
			code, _ := e.http(t, "POST", "/api/findings", map[string]any{"title": title, "severity": "low", "features": features})
			return code == 201
		},
		"MCP": func(title string, features []string) bool {
			ok, _ := e.mcpCall(t, "create_finding", map[string]any{"title": title, "severity": "low", "features": features})
			return ok
		},
		"MCP batch": func(title string, features []string) bool {
			ok, _ := e.mcpCall(t, "batch_create_findings", map[string]any{"findings": []any{map[string]any{"title": title, "severity": "low", "features": features}}})
			return ok
		},
		"CLI": func(title string, features []string) bool {
			ok, _ := e.cli(t, "findings", "create", "--title", title, "--severity", "low", "--features", features[0])
			return ok
		},
		"CLI batch": func(title string, features []string) bool {
			b, _ := json.Marshal([]any{map[string]any{"title": title, "severity": "low", "features": features}})
			in := filepath.Join(t.TempDir(), "batch.json")
			os.WriteFile(in, b, 0644)
			ok, _ := e.cli(t, "findings", "batch-create", "--input", in)
			return ok
		},
	}
	stored := func(title string) map[string]any {
		_, data := e.http(t, "GET", "/api/findings", nil)
		var items []map[string]any
		json.Unmarshal(data, &items)
		for _, it := range items {
			if it["title"] == title {
				return it
			}
		}
		return nil
	}
	for name, c := range create {
		bad := "linked to nothing via " + name
		if c(bad, []string{"no-such-feature"}) {
			t.Errorf("%s: a finding linked to an unknown feature was accepted", name)
		}
		if stored(bad) != nil {
			t.Errorf("%s: a finding linked to an unknown feature was stored", name)
		}
		good := "linked to Login via " + name
		if !c(good, []string{real}) {
			t.Errorf("%s: a finding linked to a real feature was refused", name)
			continue
		}
		if f := stored(good); f == nil || len(f["features"].([]any)) != 1 || f["features"].([]any)[0] != real {
			t.Errorf("%s: stored %v, want linked to %s", name, f, real)
		}
	}

	// Updating a finding's links to an unknown feature is refused and leaves them as they were.
	f := stored("linked to Login via REST")
	id := f["id"].(string)
	if code, _ := e.http(t, "PATCH", "/api/findings/"+id, map[string]any{"features": []string{real, "no-such-feature"}}); code != 400 {
		t.Errorf("PATCH with an unknown feature: %d, want 400", code)
	}
	if ok, _ := e.mcpCall(t, "update_finding", map[string]any{"id": id, "features": []string{"no-such-feature"}}); ok {
		t.Error("MCP update_finding with an unknown feature was accepted")
	}
	if got := stored("linked to Login via REST")["features"].([]any); len(got) != 1 || got[0] != real {
		t.Errorf("links after the refused updates = %v, want [%s]", got, real)
	}
}
