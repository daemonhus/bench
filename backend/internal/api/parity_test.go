package api

// TestCLIAPIRouteParity verifies that every CLI command's HTTP endpoint is
// actually registered in the router. This catches the class of bug where a
// CLI command is added (or points to the wrong path) without a matching route.
//
// The table below is the source of truth. It must be kept in sync with the
// commands slice in cmd/cli/main.go. If you add a CLI command, add a row
// here. If this test fails, either the route is missing or the CLI points
// to the wrong path.

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCLIAPIRouteParity(t *testing.T) {
	router, _ := setupEnv(t)

	// Each entry mirrors a CLI command: {method, path}.
	// Paths with {id} use a placeholder — we expect 404 (not found) not 405
	// (method not allowed) or a Go mux "not found" which means no route exists.
	// For write methods we send a minimal JSON body so the router can decode it.
	routes := []struct {
		method string
		path   string
		body   string
	}{
		// git
		{"GET", "/api/git/search", ""},
		{"GET", "/api/git/show/HEAD/README.md", ""},
		{"GET", "/api/git/diff", ""},
		{"GET", "/api/git/diff-files", ""},
		{"GET", "/api/git/branches", ""},
		{"GET", "/api/git/commits", ""},
		{"GET", "/api/git/tree/HEAD", ""},

		// findings
		{"GET", "/api/findings", ""},
		{"GET", "/api/findings/test-id", ""},
		{"POST", "/api/findings", `{}`},
		{"PATCH", "/api/findings/test-id", `{}`},
		{"DELETE", "/api/findings/test-id", ""},
		{"GET", "/api/findings/search", ""},

		// comments
		{"GET", "/api/comments", ""},
		{"GET", "/api/comments/test-id", ""},
		{"POST", "/api/comments", `{}`},
		{"PATCH", "/api/comments/test-id", `{}`},
		{"DELETE", "/api/comments/test-id", ""},

		// features
		{"GET", "/api/features", ""},
		{"GET", "/api/features/test-id", ""},
		{"POST", "/api/features", `{}`},
		{"PATCH", "/api/features/test-id", `{}`},
		{"DELETE", "/api/features/test-id", ""},

		// baselines
		{"GET", "/api/baselines", ""},
		{"GET", "/api/baselines/delta", ""},
		{"GET", "/api/baselines/test-id/delta", ""},
		{"POST", "/api/baselines", `{}`},
		{"DELETE", "/api/baselines/test-id", ""},

		// analytics
		{"GET", "/api/summary", ""},
		{"GET", "/api/coverage", ""},
		{"POST", "/api/coverage/mark", `{}`},

		// refs
		{"GET", "/api/refs", ""},
		{"GET", "/api/refs/test-id", ""},
		{"POST", "/api/refs", `{"entityType":"finding","entityId":"f-1","provider":"url","url":"https://example.com"}`},
		{"PATCH", "/api/refs/test-id", `{}`},
		{"DELETE", "/api/refs/test-id", ""},

		// reconcile
		{"POST", "/api/reconcile", `{}`},
		{"GET", "/api/reconcile/head", ""},
		{"GET", "/api/reconcile/status", ""},
		{"GET", "/api/annotations/finding/test-id/history", ""},
	}

	for _, r := range routes {
		t.Run(r.method+" "+r.path, func(t *testing.T) {
			var req *httptest.ResponseRecorder
			var hreq = httptest.NewRequest(r.method, r.path, strings.NewReader(r.body))
			if r.body != "" {
				hreq.Header.Set("Content-Type", "application/json")
			}
			req = httptest.NewRecorder()
			router.ServeHTTP(req, hreq)

			// 404 from Go's default mux means no route matched at all.
			// Any other status (200, 201, 204, 400, 405, 500…) means the route exists.
			if req.Code == 404 && req.Body.String() == "404 page not found\n" {
				t.Errorf("route not registered: %s %s", r.method, r.path)
			}
		})
	}
}
