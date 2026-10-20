package server

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMCP_FolderLifecycle(t *testing.T) {
	h, _ := newTestMCP(t)
	decode := func(resp mcpResp, v any) {
		t.Helper()
		if mcpIsError(t, resp) {
			t.Fatalf("tool error: %s", mcpResultText(t, resp))
		}
		if err := json.Unmarshal([]byte(mcpResultText(t, resp)), v); err != nil {
			t.Fatalf("decode: %v", err)
		}
	}

	var top, child FlowFolder
	decode(mcpCall(t, h, "flows_create_folder", map[string]any{"name": "Auth"}), &top)
	decode(mcpCall(t, h, "flows_create_folder", map[string]any{"name": "Login", "parent_id": top.ID}), &child)
	if child.ParentID != top.ID {
		t.Fatalf("parent_id not forwarded: %+v", child)
	}

	var flow Flow
	decode(mcpCall(t, h, "flows_create", map[string]any{"name": "In child", "folder_id": child.ID}), &flow)
	if flow.FolderID != child.ID {
		t.Fatalf("folder_id not forwarded on create: %+v", flow)
	}
	var other Flow
	decode(mcpCall(t, h, "flows_create", map[string]any{"name": "Top"}), &other)

	var page FlowsPage
	decode(mcpCall(t, h, "flows_list", map[string]any{"folder": child.ID}), &page)
	if page.Total != 1 || page.Items[0].ID != flow.ID {
		t.Fatalf("flows_list folder filter: %+v", page)
	}

	var moved map[string]any
	decode(mcpCall(t, h, "flows_move", map[string]any{"flow_ids": []string{other.ID}, "target_folder_id": top.ID}), &moved)
	decode(mcpCall(t, h, "flows_list", map[string]any{"folder": top.ID}), &page)
	if page.Total != 1 || page.Items[0].ID != other.ID {
		t.Fatalf("after flows_move: %+v", page)
	}

	// Cycles are reported as tool errors.
	if r := mcpCall(t, h, "flows_update_folder", map[string]any{"folder_id": top.ID, "parent_id": child.ID}); !mcpIsError(t, r) {
		t.Fatal("moving a folder into its child should fail")
	}
	var renamed FlowFolder
	decode(mcpCall(t, h, "flows_update_folder", map[string]any{"folder_id": child.ID, "name": "Sign in"}), &renamed)
	if renamed.Name != "Sign in" || renamed.ParentID != top.ID {
		t.Fatalf("rename: %+v", renamed)
	}

	var folders []FlowFolder
	decode(mcpCall(t, h, "flows_list_folders", map[string]any{}), &folders)
	if len(folders) != 2 {
		t.Fatalf("folders = %+v", folders)
	}

	// Delete is a dry run until confirm: true.
	var preview map[string]any
	decode(mcpCall(t, h, "flows_delete_folder", map[string]any{"folder_id": top.ID}), &preview)
	if preview["confirmRequired"] != true || preview["flows"] != float64(2) || preview["folders"] != float64(2) {
		t.Fatalf("preview = %v", preview)
	}
	decode(mcpCall(t, h, "flows_list", map[string]any{}), &page)
	if page.Total != 2 {
		t.Fatalf("dry run deleted flows: %d left", page.Total)
	}
	var done map[string]any
	decode(mcpCall(t, h, "flows_delete_folder", map[string]any{"folder_id": top.ID, "confirm": true}), &done)
	decode(mcpCall(t, h, "flows_list", map[string]any{}), &page)
	if page.Total != 0 {
		t.Fatalf("flows left after delete: %d", page.Total)
	}
}

func TestMCP_FolderToolsAreListed(t *testing.T) {
	h, _ := newTestMCP(t)
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`
	w := do(t, h, "POST", "/mcp", body)
	for _, name := range []string{"flows_list_folders", "flows_create_folder", "flows_update_folder", "flows_delete_folder", "flows_move"} {
		if !strings.Contains(w.Body.String(), `"`+name+`"`) {
			t.Errorf("tools/list is missing %s", name)
		}
	}
}
