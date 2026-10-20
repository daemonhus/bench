package server

import (
	"testing"
)

// The server's real route table: project CRUD, the per-project mount that maps
// /api/projects/{slug}/X onto the workbench's /api/X, and the cross-project routes
// that live beside them.
func TestRoutes_ProjectMountAndCrossProject(t *testing.T) {
	p, _ := newTestPlatform(t)
	h := p.Routes()
	repo, _ := newGitRepo(t)

	if w := do(t, h, "POST", "/api/projects", `{"name":"Svc","repoPath":"`+repo+`"}`); w.Code != 201 {
		t.Fatalf("create project: %d %s", w.Code, w.Body.String())
	}

	// One project, by slug.
	got := mustDecode[Project](t, do(t, h, "GET", "/api/projects/svc", ""))
	if got.Slug != "svc" || got.Name != "Svc" || got.RepoPath != repo || got.Stats == nil {
		t.Errorf("GET /api/projects/svc = %+v", got)
	}
	if w := do(t, h, "GET", "/api/projects/nope", ""); w.Code != 404 {
		t.Errorf("unknown project: status %d", w.Code)
	}

	// The workbench behind the mount: open the write gate, store a finding, read it back.
	if w := do(t, h, "PATCH", "/api/projects/svc/profile", `{}`); w.Code >= 300 {
		t.Fatalf("open profile gate: %d %s", w.Code, w.Body.String())
	}
	created := do(t, h, "POST", "/api/projects/svc/findings",
		`{"anchor":{"fileId":"README.md","commitId":"HEAD"},"severity":"high","title":"mounted","description":"d","status":"open","source":"manual"}`)
	if created.Code != 201 {
		t.Fatalf("create finding via mount: %d %s", created.Code, created.Body.String())
	}
	f := mustDecode[struct{ ID, Title string }](t, created)
	list := mustDecode[[]struct{ ID, Title string }](t, do(t, h, "GET", "/api/projects/svc/findings", ""))
	if len(list) != 1 || list[0].ID != f.ID || list[0].Title != "mounted" {
		t.Errorf("findings via mount = %+v, want the one created (%s)", list, f.ID)
	}
	if w := do(t, h, "GET", "/api/projects/svc/health", ""); w.Code != 200 {
		t.Errorf("health via mount: %d", w.Code)
	}
	if w := do(t, h, "GET", "/api/projects/nope/findings", ""); w.Code != 404 {
		t.Errorf("findings of unknown project: status %d", w.Code)
	}

	// The cross-project routes are not shadowed by the mount, and the old prefixes are gone.
	if w := do(t, h, "GET", "/api/baselines", ""); w.Code != 200 {
		t.Errorf("GET /api/baselines: %d", w.Code)
	}
	if w := do(t, h, "GET", "/api/flows", ""); w.Code != 200 {
		t.Errorf("GET /api/flows: %d", w.Code)
	}
	if w := do(t, h, "GET", "/api/features?refs=svc:nope", ""); w.Code != 200 {
		t.Errorf("GET /api/features: %d %s", w.Code, w.Body.String())
	}
	if w := do(t, h, "GET", "/api/settings", ""); w.Code != 200 {
		t.Errorf("GET /api/settings: %d", w.Code)
	}
	for _, old := range []string{"/api/platform/projects", "/api/p/svc/api/findings"} {
		if w := do(t, h, "GET", old, ""); w.Code == 200 && w.Header().Get("Content-Type") == "application/json" {
			t.Errorf("%s still answers as JSON", old)
		}
	}

	// Removing the project takes its routes with it.
	if w := do(t, h, "DELETE", "/api/projects/svc", ""); w.Code != 204 {
		t.Fatalf("delete project: %d", w.Code)
	}
	if w := do(t, h, "GET", "/api/projects/svc/findings", ""); w.Code != 404 {
		t.Errorf("findings of deleted project: status %d", w.Code)
	}
}
