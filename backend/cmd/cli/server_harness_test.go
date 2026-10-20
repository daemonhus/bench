package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"bench/internal/server"
)

// testProject is the slug of the one project the end-to-end tests register on the server.
const testProject = "svc"

// startServer runs the real server (internal/server) on a temp data dir, with repo registered
// as the project testProject. The project's write gate is opened (an empty service profile)
// unless gated; the gate tests leave it closed.
func startServer(t *testing.T, repo string, gated bool) *httptest.Server {
	t.Helper()
	p, err := server.NewPlatform(t.TempDir())
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	t.Cleanup(p.Close)
	srv := httptest.NewServer(p.Routes())
	t.Cleanup(srv.Close)

	body, _ := json.Marshal(map[string]string{"name": testProject, "repoPath": repo})
	if code, out := serverCall(t, srv, "POST", "/api/projects", body); code != http.StatusCreated {
		t.Fatalf("create project: %d %s", code, out)
	}
	if !gated {
		if code, out := serverCall(t, srv, "PATCH", "/api/projects/"+testProject+"/profile", []byte("{}")); code != http.StatusOK {
			t.Fatalf("open the write gate: %d %s", code, out)
		}
	}
	return srv
}

func serverCall(t *testing.T, srv *httptest.Server, method, path string, body []byte) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, srv.URL+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data
}

// projectREST maps a workbench endpoint (/api/findings) to the project's route on the server.
func projectREST(path string) string {
	return projectPath(testProject, path)
}
