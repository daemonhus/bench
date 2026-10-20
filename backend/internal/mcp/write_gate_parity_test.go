package mcp

import (
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"bench/internal/api"
)

// The service-profile write gate is decided twice: by URL prefix in the REST
// middleware and by tool-name prefix here (requiresProfile). This test maps every
// MCP write tool to the REST route that does the same thing and checks both gate
// it the same way, and fails when a tool or a REST write route has no mapping, so
// the two lists can't drift apart silently.

// gateRoute is the REST route a write tool corresponds to.
type gateRoute struct{ method, pattern string }

var toolRoutes = map[string]gateRoute{
	"create_finding":           {"POST", "/api/findings"},
	"batch_create_findings":    {"POST", "/api/findings"},
	"update_finding":           {"PATCH", "/api/findings/{id}"},
	"resolve_finding":          {"PATCH", "/api/findings/{id}"},
	"delete_finding":           {"DELETE", "/api/findings/{id}"},
	"set_finding_origin":       {"PUT", "/api/findings/{id}/origin"},
	"clear_finding_origin":     {"DELETE", "/api/findings/{id}/origin"},
	"create_feature":           {"POST", "/api/features"},
	"batch_create_features":    {"POST", "/api/features"},
	"update_feature":           {"PATCH", "/api/features/{id}"},
	"delete_feature":           {"DELETE", "/api/features/{id}"},
	"set_feature_origin":       {"PUT", "/api/features/{id}/origin"},
	"clear_feature_origin":     {"DELETE", "/api/features/{id}/origin"},
	"create_feature_parameter": {"POST", "/api/features/{id}/parameters"},
	"update_feature_parameter": {"PATCH", "/api/features/{id}/parameters/{pid}"},
	"delete_feature_parameter": {"DELETE", "/api/features/{id}/parameters/{pid}"},
	"create_comment":           {"POST", "/api/comments"},
	"batch_create_comments":    {"POST", "/api/comments"},
	"update_comment":           {"PATCH", "/api/comments/{id}"},
	"resolve_comment":          {"PATCH", "/api/comments/{id}"},
	"delete_comment":           {"DELETE", "/api/comments/{id}"},
	"create_ref":               {"POST", "/api/refs"},
	"batch_create_refs":        {"POST", "/api/refs"},
	"update_ref":               {"PATCH", "/api/refs/{id}"},
	"delete_ref":               {"DELETE", "/api/refs/{id}"},
	"set_baseline":             {"POST", "/api/baselines"},
	"delete_baseline":          {"DELETE", "/api/baselines/{id}"},
	"mark_reviewed":            {"POST", "/api/coverage/mark"},
	"reconcile":                {"POST", "/api/reconcile"},
	"update_service_profile":   {"PATCH", "/api/profile"},
}

// REST write routes with no MCP tool, and whether they are gated.
var restOnlyRoutes = map[gateRoute]bool{
	{"PATCH", "/api/baselines/{id}"}: true,
	{"PUT", "/api/settings"}:         false,
}

// readTool reports tools that only read, which neither surface gates.
func readTool(name string) bool {
	for _, p := range []string{"get_", "list_", "read_", "search_", "suggest_"} {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// restWriteRoutes reads the non-GET routes registered in the REST router.
func restWriteRoutes(t *testing.T) []gateRoute {
	t.Helper()
	src, err := os.ReadFile("../api/router.go")
	if err != nil {
		t.Fatalf("read router: %v", err)
	}
	var out []gateRoute
	for _, m := range regexp.MustCompile(`HandleFunc\("(POST|PUT|PATCH|DELETE) ([^"]+)"`).FindAllStringSubmatch(string(src), -1) {
		out = append(out, gateRoute{m[1], m[2]})
	}
	if len(out) == 0 {
		t.Fatal("no write routes found in router.go")
	}
	return out
}

// restGated sends a write to the route with no profile configured and reports
// whether the REST gate turned it away (412).
func restGated(t *testing.T, router http.Handler, r gateRoute) bool {
	t.Helper()
	path := strings.NewReplacer("{id}", "x", "{pid}", "y").Replace(r.pattern)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(r.method, path, strings.NewReader(`{}`)))
	return w.Code == http.StatusPreconditionFailed
}

func boolWord(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

func TestWriteGateParity(t *testing.T) {
	deps := setupMCPDeps(t) // profile left unconfigured
	router := api.NewRouter(deps.repo, deps.db, nil)
	tools := registerAllTools(deps)

	// Every tool is either a read or mapped to its REST route.
	var unmapped []string
	for name := range tools {
		if _, ok := toolRoutes[name]; !ok && !readTool(name) {
			unmapped = append(unmapped, name)
		}
	}
	sort.Strings(unmapped)
	for _, name := range unmapped {
		t.Errorf("MCP tool %s writes but has no REST route in toolRoutes: map it so its gate is checked", name)
	}
	for name := range toolRoutes {
		if _, ok := tools[name]; !ok {
			t.Errorf("toolRoutes names %s, which is not a registered MCP tool", name)
		}
	}

	// Every REST write route is covered by a tool or listed as REST-only.
	covered := map[gateRoute]bool{}
	for _, r := range toolRoutes {
		covered[r] = true
	}
	for _, r := range restWriteRoutes(t) {
		_, restOnly := restOnlyRoutes[r]
		if !covered[r] && !restOnly {
			t.Errorf("REST route %s %s has no MCP tool in toolRoutes and isn't in restOnlyRoutes", r.method, r.pattern)
		}
	}

	// Both surfaces gate each pair the same way. Writing the profile configures it
	// and opens the gate, so that route is checked last.
	type check struct {
		label string
		route gateRoute
		want  bool
	}
	var checks []check
	for name, r := range toolRoutes {
		if tool, ok := tools[name]; ok {
			checks = append(checks, check{name + " (MCP gated=" + boolWord(tool.RequiresProfile) + ")", r, tool.RequiresProfile})
		}
	}
	for r, want := range restOnlyRoutes {
		checks = append(checks, check{"REST-only", r, want})
	}
	sort.SliceStable(checks, func(i, j int) bool {
		return checks[i].route.pattern != "/api/profile" && checks[j].route.pattern == "/api/profile"
	})
	for _, c := range checks {
		if got := restGated(t, router, c.route); got != c.want {
			t.Errorf("%s: %s %s gated=%v over REST, want %v", c.label, c.route.method, c.route.pattern, got, c.want)
		}
	}
	// Reads are never gated.
	for name, tool := range tools {
		if readTool(name) && tool.RequiresProfile {
			t.Errorf("read tool %s is gated", name)
		}
	}
}
