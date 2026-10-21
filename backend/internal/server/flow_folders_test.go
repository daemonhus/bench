package server

import (
	"fmt"
	"net/http"
	"testing"
)

func createTestFolder(t *testing.T, h http.Handler, name, parent string) FlowFolder {
	t.Helper()
	w := do(t, h, "POST", "/api/flow-folders", fmt.Sprintf(`{"name":%q,"parentId":%q}`, name, parent))
	if w.Code != 201 {
		t.Fatalf("create folder %q: status=%d body=%s", name, w.Code, w.Body.String())
	}
	return mustDecode[FlowFolder](t, w)
}

func listFolderFlows(t *testing.T, h http.Handler, folder string) []FlowSummary {
	t.Helper()
	w := do(t, h, "GET", "/api/flows?folder="+folder, "")
	if w.Code != 200 {
		t.Fatalf("list flows: %d %s", w.Code, w.Body.String())
	}
	return mustDecode[FlowsPage](t, w).Items
}

func move(t *testing.T, h http.Handler, body string) int {
	t.Helper()
	return do(t, h, "POST", "/api/flows/move", body).Code
}

func TestFolders_CreateNestAndList(t *testing.T) {
	_, h := newTestPlatform(t)
	auth := createTestFolder(t, h, "Auth", "")
	login := createTestFolder(t, h, "Login", auth.ID)
	if login.ParentID != auth.ID {
		t.Fatalf("parentId = %q, want %q", login.ParentID, auth.ID)
	}

	// Sibling names are unique (case-insensitive); the same name elsewhere is fine.
	if w := do(t, h, "POST", "/api/flow-folders", `{"name":"auth"}`); w.Code != 409 {
		t.Fatalf("duplicate sibling: status=%d, want 409", w.Code)
	}
	createTestFolder(t, h, "Auth", login.ID)

	for _, bad := range []string{`{"name":""}`, `{"name":"a/b"}`, `{"name":"x","parentId":"nope"}`} {
		if w := do(t, h, "POST", "/api/flow-folders", bad); w.Code != 400 {
			t.Errorf("%s: status=%d, want 400", bad, w.Code)
		}
	}

	f := createTestFlow(t, h, "In login", "draft")
	if code := move(t, h, fmt.Sprintf(`{"flowIds":[%q],"targetFolderId":%q}`, f.ID, login.ID)); code != 200 {
		t.Fatalf("move: %d", code)
	}
	folders := mustDecode[[]FlowFolder](t, do(t, h, "GET", "/api/flow-folders", ""))
	byID := map[string]FlowFolder{}
	for _, x := range folders {
		byID[x.ID] = x
	}
	if byID[auth.ID].FolderCount != 1 || byID[auth.ID].FlowCount != 0 {
		t.Errorf("Auth counts = %+v", byID[auth.ID])
	}
	if byID[login.ID].FlowCount != 1 || byID[login.ID].FolderCount != 1 {
		t.Errorf("Login counts = %+v", byID[login.ID])
	}
}

func TestFolders_ListFlowsByFolder(t *testing.T) {
	_, h := newTestPlatform(t)
	dir := createTestFolder(t, h, "Payments", "")
	inside := createTestFlow(t, h, "Checkout", "active")
	createTestFlow(t, h, "Top level", "draft")
	move(t, h, fmt.Sprintf(`{"flowIds":[%q],"targetFolderId":%q}`, inside.ID, dir.ID))

	if got := listFolderFlows(t, h, "root"); len(got) != 1 || got[0].Name != "Top level" {
		t.Errorf("root = %+v", got)
	}
	got := listFolderFlows(t, h, dir.ID)
	if len(got) != 1 || got[0].Name != "Checkout" || got[0].FolderID != dir.ID {
		t.Errorf("folder = %+v", got)
	}
	// Without a folder filter the list (and search) spans every folder.
	all := mustDecode[FlowsPage](t, do(t, h, "GET", "/api/flows", ""))
	if all.Total != 2 {
		t.Errorf("unfiltered total = %d, want 2", all.Total)
	}
	// The flow detail carries its folder too.
	if g := mustDecode[Flow](t, do(t, h, "GET", "/api/flows/"+inside.ID, "")); g.FolderID != dir.ID {
		t.Errorf("getFlow folderId = %q", g.FolderID)
	}
}

func TestFolders_CreateAndUpdateFlowWithFolder(t *testing.T) {
	_, h := newTestPlatform(t)
	dir := createTestFolder(t, h, "A", "")
	w := do(t, h, "POST", "/api/flows", fmt.Sprintf(`{"name":"F","folderId":%q}`, dir.ID))
	if w.Code != 201 {
		t.Fatalf("create in folder: %d %s", w.Code, w.Body.String())
	}
	f := mustDecode[Flow](t, w)
	if f.FolderID != dir.ID {
		t.Fatalf("folderId = %q", f.FolderID)
	}
	if w := do(t, h, "POST", "/api/flows", `{"name":"G","folderId":"missing"}`); w.Code != 400 {
		t.Errorf("create in missing folder: %d, want 400", w.Code)
	}
	// PATCH folderId "" moves it to the top level; other fields are untouched.
	u := mustDecode[Flow](t, do(t, h, "PATCH", "/api/flows/"+f.ID, `{"folderId":""}`))
	if u.FolderID != "" || u.Name != "F" {
		t.Errorf("after move to root: %+v", u)
	}
	if w := do(t, h, "PATCH", "/api/flows/"+f.ID, `{"folderId":"missing"}`); w.Code != 400 {
		t.Errorf("patch into missing folder: %d, want 400", w.Code)
	}
}

func TestFolders_MoveRejectsCycles(t *testing.T) {
	_, h := newTestPlatform(t)
	a := createTestFolder(t, h, "A", "")
	b := createTestFolder(t, h, "B", a.ID)
	c := createTestFolder(t, h, "C", b.ID)

	cases := map[string]string{
		"into itself":       fmt.Sprintf(`{"folderIds":[%q],"targetFolderId":%q}`, a.ID, a.ID),
		"into a grandchild": fmt.Sprintf(`{"folderIds":[%q],"targetFolderId":%q}`, a.ID, c.ID),
		"to a missing one":  fmt.Sprintf(`{"folderIds":[%q],"targetFolderId":"missing"}`, c.ID),
		"nothing":           `{"targetFolderId":""}`,
	}
	for name, body := range cases {
		if code := move(t, h, body); code != 400 {
			t.Errorf("%s: status=%d, want 400", name, code)
		}
	}
	// PATCH parentId goes through the same check.
	if w := do(t, h, "PATCH", "/api/flow-folders/"+a.ID, fmt.Sprintf(`{"parentId":%q}`, b.ID)); w.Code != 400 {
		t.Errorf("patch into child: %d, want 400", w.Code)
	}
	// A legal move: C up to the top level.
	if code := move(t, h, fmt.Sprintf(`{"folderIds":[%q],"targetFolderId":""}`, c.ID)); code != 200 {
		t.Fatalf("move C to root: %d", code)
	}
	got := mustDecode[FlowFolder](t, do(t, h, "PATCH", "/api/flow-folders/"+c.ID, `{"name":"Renamed"}`))
	if got.ParentID != "" || got.Name != "Renamed" {
		t.Errorf("C = %+v", got)
	}
}

func TestFolders_MoveRefusesNameClash(t *testing.T) {
	_, h := newTestPlatform(t)
	a := createTestFolder(t, h, "A", "")
	createTestFolder(t, h, "Shared", "")
	inner := createTestFolder(t, h, "Shared", a.ID)
	if code := move(t, h, fmt.Sprintf(`{"folderIds":[%q],"targetFolderId":""}`, inner.ID)); code != 409 {
		t.Errorf("clash: %d, want 409", code)
	}
}

func TestFolders_DeleteRemovesSubtreeAndFlows(t *testing.T) {
	p, h := newTestPlatform(t)
	a := createTestFolder(t, h, "A", "")
	b := createTestFolder(t, h, "B", a.ID)
	keep := createTestFolder(t, h, "Keep", "")
	f1 := createTestFlow(t, h, "in A", "draft")
	f2 := createTestFlow(t, h, "in B", "draft")
	f3 := createTestFlow(t, h, "elsewhere", "draft")
	addTestStep(t, h, f2.ID, "proj", "feat")
	move(t, h, fmt.Sprintf(`{"flowIds":[%q],"targetFolderId":%q}`, f1.ID, a.ID))
	move(t, h, fmt.Sprintf(`{"flowIds":[%q],"targetFolderId":%q}`, f2.ID, b.ID))
	move(t, h, fmt.Sprintf(`{"flowIds":[%q],"targetFolderId":%q}`, f3.ID, keep.ID))

	// Without confirm: a preview, nothing deleted.
	preview := mustDecode[map[string]any](t, do(t, h, "DELETE", "/api/flow-folders/"+a.ID, ""))
	if preview["folders"] != float64(2) || preview["flows"] != float64(2) || preview["confirmRequired"] != true {
		t.Fatalf("preview = %v", preview)
	}
	if w := do(t, h, "GET", "/api/flows/"+f1.ID, ""); w.Code != 200 {
		t.Fatalf("preview deleted a flow: %d", w.Code)
	}

	res := mustDecode[map[string]any](t, do(t, h, "DELETE", "/api/flow-folders/"+a.ID+"?confirm=true", ""))
	if res["deleted"] != true {
		t.Fatalf("delete = %v", res)
	}
	for _, id := range []string{f1.ID, f2.ID} {
		if w := do(t, h, "GET", "/api/flows/"+id, ""); w.Code != 404 {
			t.Errorf("flow %s still exists: %d", id, w.Code)
		}
	}
	var steps int
	p.db.QueryRow(`SELECT COUNT(*) FROM flow_steps WHERE flow_id = ?`, f2.ID).Scan(&steps)
	if steps != 0 {
		t.Errorf("steps of a deleted flow remain: %d", steps)
	}
	if w := do(t, h, "GET", "/api/flows/"+f3.ID, ""); w.Code != 200 {
		t.Errorf("flow in another folder was deleted: %d", w.Code)
	}
	folders := mustDecode[[]FlowFolder](t, do(t, h, "GET", "/api/flow-folders", ""))
	if len(folders) != 1 || folders[0].ID != keep.ID {
		t.Errorf("folders left = %+v", folders)
	}
	if w := do(t, h, "DELETE", "/api/flow-folders/"+a.ID, ""); w.Code != 404 {
		t.Errorf("delete missing: %d, want 404", w.Code)
	}
	// Deleted flows leave the search index too.
	if page := mustDecode[FlowsPage](t, do(t, h, "GET", "/api/flows?q=in", "")); page.Total != 0 {
		t.Errorf("search still finds %d deleted flows", page.Total)
	}
}

func TestFlowList_IncludesShapeSkeleton(t *testing.T) {
	_, h := newTestPlatform(t)
	f := createTestFlow(t, h, "Shaped", "draft")
	root := addTestStep(t, h, f.ID, "proj", "feat-a")
	w := do(t, h, "POST", "/api/flows/"+f.ID+"/steps", fmt.Sprintf(`{"projectSlug":"proj","featureId":"feat-b","parentStepId":%q}`, root.ID))
	if w.Code != 201 {
		t.Fatalf("child step: %d %s", w.Code, w.Body.String())
	}
	createTestFlow(t, h, "Empty", "draft")
	items := mustDecode[FlowsPage](t, do(t, h, "GET", "/api/flows?sort=name&order=asc", "")).Items
	if len(items) != 2 || items[0].Name != "Empty" || len(items[0].Shape) != 0 {
		t.Fatalf("empty flow shape: %+v", items)
	}
	shape := items[1].Shape
	if len(shape) != 2 || shape[0].ID != root.ID {
		t.Fatalf("shape = %+v", shape)
	}
	if e := items[1].ShapeEdges; len(e) != 1 || e[0] != [2]string{root.ID, shape[1].ID} {
		t.Fatalf("shape edges = %+v", e)
	}
	if shape[0].ProjectSlug != "proj" || shape[0].FeatureID != "feat-a" || shape[1].FeatureID != "feat-b" {
		t.Fatalf("shape should name each step's feature: %+v", shape)
	}
}
