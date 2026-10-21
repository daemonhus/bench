package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"

	workbench "bench"
)

// platformMCP is a JSON-RPC 2.0 MCP handler that wraps all bench tools
// with a required "project" parameter and routes calls to the right workbench.
type platformMCP struct {
	p        *Platform
	mu       sync.Mutex
	tools    json.RawMessage // cached tools array (bench tools + project param + platform tools)
	restOnce sync.Once
	rest     http.Handler // platform REST mux for in-process tool calls
}

func newPlatformMCP(p *Platform) *platformMCP {
	return &platformMCP{p: p}
}

func (m *platformMCP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "method not allowed", 405)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 4*1024*1024))
	if err != nil {
		mcpError(w, nil, -32600, "failed to read request")
		return
	}

	var req struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      any             `json:"id"`
		Method  string          `json:"method"`
		Params  json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		mcpError(w, nil, -32600, "invalid JSON")
		return
	}

	switch req.Method {
	case "initialize":
		mcpResult(w, req.ID, map[string]any{
			"protocolVersion": "2025-03-26",
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "benchd", "version": "0.1.0"},
		})
	case "notifications/initialized":
		w.WriteHeader(204)
	case "tools/list":
		m.handleToolsList(w, req.ID)
	case "tools/call":
		m.handleToolsCall(w, req.ID, req.Params)
	case "ping":
		mcpResult(w, req.ID, map[string]any{})
	default:
		mcpError(w, req.ID, -32601, "method not found")
	}
}

// ── tools/list ──────────────────────────────────────────────────────────

func (m *platformMCP) handleToolsList(w http.ResponseWriter, id any) {
	mcpResult(w, id, map[string]any{"tools": m.toolList()})
}

// toolList returns the aggregate tool list: every bench tool (discovered at runtime,
// with a required "project" param) followed by the platform tools. The list is cached
// once bench discovery succeeds; a failed discovery is retried on the next call.
func (m *platformMCP) toolList() json.RawMessage {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.tools != nil {
		return m.tools
	}
	benchTools := m.discoverBenchTools()

	tools := make([]json.RawMessage, 0, len(benchTools)+40)
	for _, raw := range benchTools {
		tools = append(tools, injectProjectParam(raw))
	}
	tools = append(tools, platformToolDefs()...)

	out, _ := json.Marshal(tools)
	if len(benchTools) > 0 {
		m.tools = out
	}
	return out
}

// discoverBenchTools gets the tool definitions from a workbench's MCP handler.
func (m *platformMCP) discoverBenchTools() []json.RawMessage {
	// Try an existing workbench first.
	m.p.mu.RLock()
	for _, wb := range m.p.workbenches {
		m.p.mu.RUnlock()
		return toolsFromHandler(wb.MCPHandler())
	}
	m.p.mu.RUnlock()

	// No workbenches yet — create a throwaway one for discovery.
	dir, err := os.MkdirTemp("", "bench-discover-*")
	if err != nil {
		return nil
	}
	defer os.RemoveAll(dir)
	exec.Command("git", "init", dir).Run() //nolint: no need to check

	wb, err := workbench.Open(dir, filepath.Join(dir, "discover.db"))
	if err != nil {
		return nil
	}
	defer wb.Close()
	return toolsFromHandler(wb.MCPHandler())
}

func toolsFromHandler(h http.Handler) []json.RawMessage {
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/mcp", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)

	var resp struct {
		Result struct {
			Tools []json.RawMessage `json:"tools"`
		} `json:"result"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	return resp.Result.Tools
}

// injectProjectParam adds a required "project" string parameter to a tool's inputSchema.
func injectProjectParam(toolJSON json.RawMessage) json.RawMessage {
	var tool map[string]json.RawMessage
	json.Unmarshal(toolJSON, &tool)

	var schema map[string]json.RawMessage
	json.Unmarshal(tool["inputSchema"], &schema)

	// Add to properties.
	var props map[string]json.RawMessage
	if schema["properties"] != nil {
		json.Unmarshal(schema["properties"], &props)
	}
	if props == nil {
		props = make(map[string]json.RawMessage)
	}
	props["project"] = json.RawMessage(`{"type":"string","description":"Project slug (from list_projects)"}`)
	schema["properties"], _ = json.Marshal(props)

	// Add to required (prepend so it's the first param).
	var required []string
	if schema["required"] != nil {
		json.Unmarshal(schema["required"], &required)
	}
	required = append([]string{"project"}, required...)
	schema["required"], _ = json.Marshal(required)

	tool["inputSchema"], _ = json.Marshal(schema)
	result, _ := json.Marshal(tool)
	return result
}

// ── tools/call ──────────────────────────────────────────────────────────

// restRoute describes how a platform MCP tool maps onto a REST route.
//   - path holds {placeholder}s filled from same-named tool arguments (required, and
//     never forwarded in the body);
//   - query, if set, builds the query string from the arguments;
//   - body, if set, rewrites the remaining arguments into the REST body
//     (snake_case → camelCase). Only POST/PATCH/PUT send a body.
type restRoute struct {
	method string
	path   string
	query  func(map[string]json.RawMessage) string
	body   func(map[string]json.RawMessage) map[string]json.RawMessage
}

// platformRoutes maps every REST-backed platform tool to its route.
var platformRoutes = map[string]restRoute{
	// projects
	"list_projects":      {method: "GET", path: "/api/projects"},
	"create_project":     {method: "POST", path: "/api/projects", body: renameKeys(map[string]string{"repo_path": "repoPath"})},
	"update_project":     {method: "PATCH", path: "/api/projects/{project}", body: renameKeys(map[string]string{"repo_path": "repoPath"})},
	"delete_project":     {method: "DELETE", path: "/api/projects/{project}"},
	"list_all_baselines": {method: "GET", path: "/api/baselines"},

	// cross-project features
	"search_features": {method: "GET", path: "/api/features/search", query: featureSearchQuery},
	"get_features":    {method: "GET", path: "/api/features", query: featureRefsQuery},

	// flows
	"flows_list":        {method: "GET", path: "/api/flows", query: flowsListQuery},
	"flows_list_facets": {method: "GET", path: "/api/flows/facets", query: flowsListQuery},
	"flows_get":         {method: "GET", path: "/api/flows/{flow_id}"},
	"flows_create": {method: "POST", path: "/api/flows", body: func(b map[string]json.RawMessage) map[string]json.RawMessage {
		return translateFolderArgs(translateSetStepsArgs(b))
	}},
	"flows_update": {method: "PATCH", path: "/api/flows/{flow_id}", body: translateFolderArgs},

	// folders
	"flows_list_folders":  {method: "GET", path: "/api/flow-folders"},
	"flows_create_folder": {method: "POST", path: "/api/flow-folders", body: translateFolderArgs},
	"flows_update_folder": {method: "PATCH", path: "/api/flow-folders/{folder_id}", body: translateFolderArgs},
	"flows_delete_folder": {method: "DELETE", path: "/api/flow-folders/{folder_id}", query: confirmQuery},
	"flows_move":          {method: "POST", path: "/api/flows/move", body: translateFolderArgs},

	// steps
	"flows_add_step":    {method: "POST", path: "/api/flows/{flow_id}/steps", body: translateAddStepArgs},
	"flows_update_step": {method: "PATCH", path: "/api/flows/{flow_id}/steps/{step_id}", body: translateStepArgs},
	"flows_remove_step": {method: "DELETE", path: "/api/flows/{flow_id}/steps/{step_id}", query: removeStepQuery},
	"flows_move_step":   {method: "POST", path: "/api/flows/{flow_id}/steps/{step_id}/move", query: flowsMoveQuery, body: translateMoveStepArgs},
	"flows_set_steps":   {method: "PUT", path: "/api/flows/{flow_id}/steps", body: translateSetStepsArgs},
	"flows_export":      {method: "GET", path: "/api/flows/{flow_id}/export"},

	// links
	"flows_set_edge":    {method: "PUT", path: "/api/flows/{flow_id}/edges/{from_step_id}/{to_step_id}", body: translateEdgeArgs},
	"flows_delete_edge": {method: "DELETE", path: "/api/flows/{flow_id}/edges/{from_step_id}/{to_step_id}"},
	"get_service_map":   {method: "GET", path: "/api/service-map", query: archivedQuery},

	// baselines, delta, findings
	"flows_set_baseline":    {method: "POST", path: "/api/flows/{flow_id}/baselines"},
	"flows_list_baselines":  {method: "GET", path: "/api/flows/{flow_id}/baselines"},
	"flows_get_baseline":    {method: "GET", path: "/api/flows/{flow_id}/baselines/{baseline_id}"},
	"flows_get_delta":       {method: "GET", path: "/api/flows/{flow_id}/delta", query: flowsDeltaQuery},
	"flows_delete_baseline": {method: "DELETE", path: "/api/flows/{flow_id}/baselines/{baseline_id}", query: confirmQuery},
	"flows_list_findings":   {method: "GET", path: "/api/flows/{flow_id}/findings"},

	// saved flow views
	"flows_list_views":  {method: "GET", path: "/api/flow-views"},
	"flows_create_view": {method: "POST", path: "/api/flow-views", body: renameKeys(map[string]string{"is_shared": "isShared"})},
	"flows_update_view": {method: "PATCH", path: "/api/flow-views/{view_id}", body: renameKeys(map[string]string{"is_shared": "isShared"})},
	"flows_delete_view": {method: "DELETE", path: "/api/flow-views/{view_id}"},
}

func (m *platformMCP) handleToolsCall(w http.ResponseWriter, id any, params json.RawMessage) {
	var call struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(params, &call); err != nil {
		mcpError(w, id, -32602, "invalid params")
		return
	}
	if len(call.Arguments) == 0 || string(call.Arguments) == "null" {
		call.Arguments = json.RawMessage("{}")
	}

	// Platform-level tools.
	if call.Name == "flows_delete" {
		m.handleFlowsDelete(w, id, call.Arguments)
		return
	}
	if route, ok := platformRoutes[call.Name]; ok {
		m.handleRESTTool(w, id, route, call.Arguments)
		return
	}

	// Everything else is a bench tool: extract and validate project.
	var args map[string]json.RawMessage
	if err := json.Unmarshal(call.Arguments, &args); err != nil {
		mcpToolError(w, id, "invalid arguments")
		return
	}

	projectRaw, ok := args["project"]
	if !ok {
		mcpToolError(w, id, `missing required parameter: "project"`)
		return
	}
	var project string
	if err := json.Unmarshal(projectRaw, &project); err != nil || project == "" {
		mcpToolError(w, id, `"project" must be a non-empty string`)
		return
	}

	wb, err := m.p.getWorkbench(project)
	if err != nil {
		mcpToolError(w, id, "project not found: "+project)
		return
	}

	// Strip project from arguments before forwarding.
	delete(args, "project")
	cleanArgs, _ := json.Marshal(args)

	fwd, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      call.Name,
			"arguments": json.RawMessage(cleanArgs),
		},
	})

	rec := httptest.NewRecorder()
	fwdReq := httptest.NewRequest("POST", "/mcp", bytes.NewReader(fwd))
	fwdReq.Header.Set("Content-Type", "application/json")
	wb.MCPHandler().ServeHTTP(rec, fwdReq)

	// Copy workbench response through.
	for k, v := range rec.Header() {
		w.Header()[k] = v
	}
	w.WriteHeader(rec.Code)
	w.Write(rec.Body.Bytes())
}

// restHandler returns the platform REST mux used for in-process tool calls (built once).
func (m *platformMCP) restHandler() http.Handler {
	m.restOnce.Do(func() { m.rest = m.p.Handler() })
	return m.rest
}

// callREST runs one in-process REST request against the platform mux.
func (m *platformMCP) callREST(method, path string, body any) *httptest.ResponseRecorder {
	var bodyReader io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		bodyReader = bytes.NewReader(b)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, bodyReader)
	if bodyReader != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	m.restHandler().ServeHTTP(rec, req)
	return rec
}

var placeholderRe = regexp.MustCompile(`\{([a-z_]+)\}`)

// handleRESTTool runs a platform tool through its REST route and wraps the
// response as an MCP tool result (HTTP errors become isError results).
func (m *platformMCP) handleRESTTool(w http.ResponseWriter, id any, route restRoute, rawArgs json.RawMessage) {
	var args map[string]json.RawMessage
	if err := json.Unmarshal(rawArgs, &args); err != nil {
		mcpToolError(w, id, "invalid arguments")
		return
	}

	// Fill path placeholders; each is required and consumed (not sent in the body).
	var missing string
	path := placeholderRe.ReplaceAllStringFunc(route.path, func(ph string) string {
		key := ph[1 : len(ph)-1]
		v := pathParam(args, key)
		delete(args, key)
		if v == "" && missing == "" {
			missing = key
		}
		return url.PathEscape(v)
	})
	if missing != "" {
		mcpToolError(w, id, missing+" is required")
		return
	}
	if route.query != nil {
		path += route.query(args)
	}

	var body any
	if route.method == "POST" || route.method == "PATCH" || route.method == "PUT" {
		delete(args, "confirm")
		if route.body != nil {
			args = route.body(args)
		}
		if args != nil {
			body = args
		}
	}

	rec := m.callREST(route.method, path, body)
	if rec.Code >= 400 {
		mcpToolError(w, id, strings.TrimSpace(rec.Body.String()))
		return
	}

	var result any
	if rec.Code == 204 || rec.Body.Len() == 0 {
		result = map[string]any{"ok": true}
	} else {
		json.Unmarshal(rec.Body.Bytes(), &result)
	}
	mcpText(w, id, result)
}

// mcpText writes v as pretty JSON text content.
func mcpText(w http.ResponseWriter, id any, v any) {
	text, _ := json.MarshalIndent(v, "", "  ")
	mcpResult(w, id, map[string]any{
		"content": []map[string]any{
			{"type": "text", "text": string(text)},
		},
	})
}

// ── argument helpers ─────────────────────────────────────────────────────────

// pathParam extracts a string value from args map.
func pathParam(args map[string]json.RawMessage, key string) string {
	raw, ok := args[key]
	if !ok {
		return ""
	}
	var s string
	json.Unmarshal(raw, &s)
	return s
}

// stringsParam reads a string or an array of strings.
func stringsParam(args map[string]json.RawMessage, key string) []string {
	raw, ok := args[key]
	if !ok {
		return nil
	}
	var list []string
	if json.Unmarshal(raw, &list) == nil {
		return list
	}
	var s string
	if json.Unmarshal(raw, &s) == nil && s != "" {
		return []string{s}
	}
	return nil
}

// intParam reads an integer (accepting a numeric string too).
func intParam(args map[string]json.RawMessage, key string) (int, bool) {
	raw, ok := args[key]
	if !ok {
		return 0, false
	}
	var n int
	if json.Unmarshal(raw, &n) == nil {
		return n, true
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		if v, err := strconv.Atoi(s); err == nil {
			return v, true
		}
	}
	return 0, false
}

func encodeQuery(q url.Values) string {
	if len(q) == 0 {
		return ""
	}
	return "?" + q.Encode()
}

// flowsListQuery builds query params for flows_list and flows_list_facets.
func flowsListQuery(args map[string]json.RawMessage) string {
	q := url.Values{}
	for _, key := range []string{"status", "tag", "project", "owner"} {
		for _, v := range stringsParam(args, key) {
			if v != "" {
				q.Add(key, v)
			}
		}
	}
	for _, key := range []string{"folder", "sort", "order"} {
		if s := pathParam(args, key); s != "" {
			q.Set(key, s)
		}
	}
	if s := pathParam(args, "query"); s != "" {
		q.Set("q", s)
	}
	for _, key := range []string{"limit", "offset"} {
		if n, ok := intParam(args, key); ok {
			q.Set(key, strconv.Itoa(n))
		}
	}
	return encodeQuery(q)
}

// featureSearchQuery builds query params for search_features.
func featureSearchQuery(args map[string]json.RawMessage) string {
	q := url.Values{}
	if s := pathParam(args, "query"); s != "" {
		q.Set("q", s)
	}
	if s := pathParam(args, "kind"); s != "" {
		q.Set("kind", s)
	}
	for _, slug := range stringsParam(args, "projects") {
		q.Add("project", slug)
	}
	if n, ok := intParam(args, "limit"); ok {
		q.Set("limit", strconv.Itoa(n))
	}
	return encodeQuery(q)
}

// featureRefsQuery builds the refs=slug:id,... param for get_features.
// Each ref is {project_slug, feature_id}, or the "slug:feature-id" string
// form the CLI and the REST API use (otherwise a string ref was silently
// dropped and the call returned an empty list).
func featureRefsQuery(args map[string]json.RawMessage) string {
	var refs []json.RawMessage
	json.Unmarshal(args["refs"], &refs)
	var parts []string
	for _, raw := range refs {
		var str string
		if json.Unmarshal(raw, &str) == nil {
			if slug, id, ok := strings.Cut(str, ":"); ok && slug != "" && id != "" {
				parts = append(parts, str)
			}
			continue
		}
		var r struct {
			ProjectSlug string `json:"project_slug"`
			FeatureID   string `json:"feature_id"`
		}
		if json.Unmarshal(raw, &r) == nil && r.ProjectSlug != "" && r.FeatureID != "" {
			parts = append(parts, r.ProjectSlug+":"+r.FeatureID)
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return "?refs=" + url.QueryEscape(strings.Join(parts, ","))
}

// flowsMoveQuery builds query params for flows_move_step.
func flowsMoveQuery(args map[string]json.RawMessage) string {
	// "up"/"down" (the CLI's spelling) are accepted alongside -1/1.
	switch strings.ToLower(pathParam(args, "direction")) {
	case "up":
		return "?dir=-1"
	case "down":
		return "?dir=1"
	}
	if dir, ok := intParam(args, "direction"); ok {
		return fmt.Sprintf("?dir=%d", dir)
	}
	return ""
}

// flowsDeltaQuery builds query params for flows_get_delta.
func flowsDeltaQuery(args map[string]json.RawMessage) string {
	if s := pathParam(args, "since_baseline_id"); s != "" {
		return "?since=" + url.QueryEscape(s)
	}
	return ""
}

// confirmQuery forwards confirm: true as ?confirm=true (dry-run otherwise).
func confirmQuery(args map[string]json.RawMessage) string {
	if raw, ok := args["confirm"]; ok {
		var b bool
		if json.Unmarshal(raw, &b) == nil && b {
			return "?confirm=true"
		}
	}
	return ""
}

// renameKeys returns a body transform that renames top-level keys.
func renameKeys(renames map[string]string) func(map[string]json.RawMessage) map[string]json.RawMessage {
	return func(body map[string]json.RawMessage) map[string]json.RawMessage {
		out := make(map[string]json.RawMessage, len(body))
		for k, v := range body {
			if newKey, ok := renames[k]; ok {
				out[newKey] = v
			} else {
				out[k] = v
			}
		}
		return out
	}
}

// translateStepArgs translates snake_case step params → camelCase REST body (flows_update_step).
var translateStepArgs = renameKeys(map[string]string{
	"project_slug":     "projectSlug",
	"feature_id":       "featureId",
	"parent_step_id":   "parentStepId",
	"branch_condition": "branchCondition",
})

// edgeArgKeys are the edge properties a tool takes flat, with their REST names.
var edgeArgKeys = map[string]string{
	"kind": "kind", "protocol": "protocol", "condition": "condition", "auth": "auth",
	"trust_boundary": "trustBoundary", "data": "data", "tainted": "tainted",
	"description": "description", "comment": "comment", "tags": "tags", "position": "position",
}

// translateEdgeArgs renames flows_set_edge's properties to the REST body.
var translateEdgeArgs = renameKeys(map[string]string{"trust_boundary": "trustBoundary"})

// nestEdgeArgs moves the flat edge properties of a step tool into the body's "edge" object
// (the edge that leads into the step) and renames the rest.
func nestEdgeArgs(rest map[string]string) func(map[string]json.RawMessage) map[string]json.RawMessage {
	return func(body map[string]json.RawMessage) map[string]json.RawMessage {
		out := map[string]json.RawMessage{}
		edge := map[string]json.RawMessage{}
		for k, v := range body {
			if name, ok := edgeArgKeys[k]; ok {
				edge[name] = v
			} else if name, ok := rest[k]; ok {
				out[name] = v
			} else {
				out[k] = v
			}
		}
		if len(edge) > 0 {
			out["edge"], _ = json.Marshal(edge)
		}
		return out
	}
}

// translateAddStepArgs builds flows_add_step's REST body.
var translateAddStepArgs = nestEdgeArgs(map[string]string{
	"project_slug": "projectSlug", "feature_id": "featureId",
	"parent_step_id": "parentStepId", "branch_condition": "branchCondition",
})

// translateMoveStepArgs builds flows_move_step's body (direction goes in the query).
func translateMoveStepArgs(body map[string]json.RawMessage) map[string]json.RawMessage {
	delete(body, "direction")
	return nestEdgeArgs(map[string]string{"parent_step_id": "parentStepId"})(body)
}

// removeStepQuery forwards flows_remove_step's mode.
func removeStepQuery(args map[string]json.RawMessage) string {
	if m := pathParam(args, "mode"); m != "" {
		return "?mode=" + url.QueryEscape(m)
	}
	return ""
}

// archivedQuery forwards archived: true as ?archived=1.
func archivedQuery(args map[string]json.RawMessage) string {
	if raw, ok := args["archived"]; ok {
		var b bool
		if json.Unmarshal(raw, &b) == nil && b {
			return "?archived=1"
		}
	}
	return ""
}

// translateFolderArgs translates snake_case folder params → camelCase REST body.
var translateFolderArgs = renameKeys(map[string]string{
	"folder_id":        "folderId",
	"parent_id":        "parentId",
	"flow_ids":         "flowIds",
	"folder_ids":       "folderIds",
	"target_folder_id": "targetFolderId",
})

// translateSetStepsArgs translates snake_case MCP params → camelCase REST body for flows_set_steps.
func translateSetStepsArgs(body map[string]json.RawMessage) map[string]json.RawMessage {
	stepRename := renameKeys(map[string]string{
		"client_id":        "clientId",
		"parent_client_id": "parentClientId",
		"project_slug":     "projectSlug",
		"feature_id":       "featureId",
		"branch_condition": "branchCondition",
	})
	edgeRename := renameKeys(map[string]string{
		"from_client_id": "fromClientId",
		"to_client_id":   "toClientId",
		"trust_boundary": "trustBoundary",
	})
	renameEach := func(raw json.RawMessage, fn func(map[string]json.RawMessage) map[string]json.RawMessage) json.RawMessage {
		var items []map[string]json.RawMessage
		if json.Unmarshal(raw, &items) != nil {
			return raw
		}
		for i := range items {
			items[i] = fn(items[i])
		}
		b, _ := json.Marshal(items)
		return b
	}
	out := make(map[string]json.RawMessage, len(body))
	for k, v := range body {
		switch k {
		case "steps":
			out[k] = renameEach(v, stepRename)
		case "edges", "links":
			out[k] = renameEach(v, edgeRename)
		default:
			out[k] = v
		}
	}
	return out
}

func (m *platformMCP) handleFlowsDelete(w http.ResponseWriter, id any, rawArgs json.RawMessage) {
	var args struct {
		FlowID  string `json:"flow_id"`
		Confirm bool   `json:"confirm"`
	}
	if err := json.Unmarshal(rawArgs, &args); err != nil {
		mcpToolError(w, id, "invalid arguments")
		return
	}
	if args.FlowID == "" {
		mcpToolError(w, id, "flow_id is required")
		return
	}
	flowPath := "/api/flows/" + url.PathEscape(args.FlowID)

	if !args.Confirm {
		// Dry-run: fetch the flow and describe what would be deleted.
		rec := m.callREST("GET", flowPath, nil)
		if rec.Code == 404 {
			mcpToolError(w, id, "flow not found: "+args.FlowID)
			return
		}
		if rec.Code >= 400 {
			mcpToolError(w, id, strings.TrimSpace(rec.Body.String()))
			return
		}
		var flow struct {
			Name  string `json:"name"`
			Steps []any  `json:"steps"`
		}
		json.Unmarshal(rec.Body.Bytes(), &flow)
		mcpText(w, id, map[string]any{
			"would_delete":     map[string]any{"id": args.FlowID, "name": flow.Name, "stepCount": len(flow.Steps)},
			"confirm_required": true,
		})
		return
	}

	rec := m.callREST("DELETE", flowPath, nil)
	if rec.Code == 404 {
		mcpToolError(w, id, "flow not found: "+args.FlowID)
		return
	}
	if rec.Code >= 400 {
		mcpToolError(w, id, strings.TrimSpace(rec.Body.String()))
		return
	}
	mcpResult(w, id, map[string]any{
		"content": []map[string]any{
			{"type": "text", "text": "Flow deleted: " + args.FlowID},
		},
	})
}

// platformToolDefs are the platform-level tools (no project param injection: they
// either span projects or take project slugs explicitly).
func platformToolDefs() []json.RawMessage {
	return []json.RawMessage{
		// ── projects ──
		json.RawMessage(`{
			"name": "list_projects",
			"description": "List all projects with id, name, slug, repoPath, remoteUrl, stats (finding/comment counts) and riskData (activity since the latest baseline). Use the slug as the project param of every per-project tool.",
			"inputSchema": {"type": "object", "properties": {}, "required": []}
		}`),
		json.RawMessage(`{
			"name": "create_project",
			"description": "Register a git repository as a project. The slug is derived from the name, and an initial baseline is taken at HEAD. Returns the created project (id, name, slug, repoPath).",
			"inputSchema": {
				"type": "object",
				"properties": {
					"name":     {"type": "string", "description": "Project display name"},
					"repoPath": {"type": "string", "description": "Absolute path to the git repository on the server"}
				},
				"required": ["name", "repoPath"]
			}
		}`),
		json.RawMessage(`{
			"name": "update_project",
			"description": "Rename a project or point it at a different repository path. The slug stays the same.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"project":  {"type": "string", "description": "Project slug or id (from list_projects)"},
					"name":     {"type": "string", "description": "New display name (optional)"},
					"repoPath": {"type": "string", "description": "New absolute path to the git repository (optional)"}
				},
				"required": ["project"]
			}
		}`),
		json.RawMessage(`{
			"name": "delete_project",
			"description": "Remove a project from the platform. Only the project record goes: the git repository and the project's review database on disk are kept, so registering it again under the same name brings its findings back. Flow steps in this project show as tombstoned (project_not_registered) until then.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"project": {"type": "string", "description": "Project slug or id (from list_projects)"}
				},
				"required": ["project"]
			}
		}`),
		json.RawMessage(`{
			"name": "list_all_baselines",
			"description": "List recent baselines across all projects (up to 50 per project), each tagged with projectSlug and projectName, with commit, reviewer, summary and finding/comment counts. For a single project use list_baselines / get_delta with project.",
			"inputSchema": {"type": "object", "properties": {}, "required": []}
		}`),

		// ── cross-project features ──
		json.RawMessage(`{
			"name": "search_features",
			"description": "Search feature annotations across all projects (or the given ones) by title, operation or tag. Returns [{projectSlug, projectName, id, title, kind, operation, protocol, tags, anchor}], best title matches first. Use projectSlug + id as project_slug + feature_id in flows_add_step / flows_set_steps.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"query":    {"type": "string", "description": "Case-insensitive text to match in title, operation or tags; omit to list everything"},
					"kind":     {"type": "string", "enum": ["interface","source","sink","dependency","externality"], "description": "Only features of this kind"},
					"projects": {"type": "array", "items": {"type": "string"}, "description": "Project slugs to search; omit for all projects"},
					"limit":    {"type": "integer", "description": "Max results (default 50, max 200)"}
				},
				"required": []
			}
		}`),
		json.RawMessage(`{
			"name": "get_features",
			"description": "Resolve several features from any projects in one call. Returns one entry per ref with title, kind, operation, protocol and projectName; refs that cannot be resolved come back with tombstoned: true.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"refs": {
						"type": "array",
						"description": "Features to resolve: {project_slug, feature_id} objects (\"slug:feature-id\" strings are also accepted)",
						"items": {
							"type": "object",
							"properties": {
								"project_slug": {"type": "string", "description": "Project slug"},
								"feature_id":   {"type": "string", "description": "Feature ID in that project"}
							},
							"required": ["project_slug", "feature_id"]
						}
					}
				},
				"required": ["refs"]
			}
		}`),

		// ── flows ──
		json.RawMessage(`{
			"name": "flows_list",
			"description": "List flows (summaries without steps), optionally filtered by full-text query, status, tag, project slug, owner or folder. Ordered by most recently updated unless sort is given. Paginated with limit (default 50, max 200) and offset. Returns {items, total, offset, limit}; each item has stepCount, projectSlugs, baseline info, open-finding counts and a step outline (shape).",
			"inputSchema": {
				"type": "object",
				"properties": {
					"query":   {"type": "string", "description": "Full-text search over flow name, description, owner, tags and step notes"},
					"status":  {"type": "string", "description": "Filter by status [draft|active|archived]; comma-separate for several"},
					"tag":     {"type": "string", "description": "Filter by tag"},
					"project": {"type": "string", "description": "Only flows with at least one step in this project slug"},
					"owner":   {"type": "string", "description": "Filter by owner"},
					"folder":  {"type": "string", "description": "Only flows directly in this folder: a folder id (from flows_list_folders) or \"root\" for the top level. Omit to list across all folders."},
					"sort":    {"type": "string", "description": "Sort key [updated|created|name|stepCount|risk] (default updated)"},
					"order":   {"type": "string", "description": "Sort order [asc|desc] (default desc)"},
					"limit":   {"type": "integer", "description": "Page size (default 50, max 200)"},
					"offset":  {"type": "integer", "description": "Page offset (default 0)"}
				},
				"required": []
			}
		}`),
		json.RawMessage(`{
			"name": "flows_get",
			"description": "Get a flow by ID with its steps and edges (always arrays, never null). A flow is a graph: each edge {fromStepId, toStepId, position, kind, protocol, condition, auth, trustBoundary, data, tainted, description, comment, tags} is one hop; steps with no edge into them are entry points, several edges out of a step are branches (ordered by position). Steps carry note, actor and controls. Steps may have tombstoned: true if their backing feature is unreachable — check tombstonedReason for diagnosis: project_not_registered (project not in list_projects), feature_not_found (feature deleted or ID wrong), or fetch_error (other error). Each step includes featureId and projectSlug — to inspect the underlying feature annotation call get_feature with {project: step.projectSlug, id: step.featureId}.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"flow_id": {"type": "string", "description": "Flow ID"}
				},
				"required": ["flow_id"]
			}
		}`),
		json.RawMessage(`{
			"name": "flows_create",
			"description": "Create a new flow. Status defaults to draft. Valid statuses: draft, active, archived. Tags are free-form strings used for filtering via flows_list and flows_list_facets. Optionally pass steps and edges (as for flows_set_steps, or a flows_export document) to create the whole graph at once. Returns the created flow with id — save this for all subsequent step/baseline operations.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"steps":       {"type": "array", "description": "Steps of the new flow (as flows_set_steps)", "items": {
								"type": "object",
								"properties": {
									"client_id":    {"type": "string", "description": "Caller-assigned id, used by edges' from/to"},
									"project_slug": {"type": "string", "description": "Project slug"},
									"feature_id":   {"type": "string", "description": "Feature annotation ID"},
									"note":         {"type": "string", "description": "Step note"},
									"actor":        {"type": "string", "description": "Who is acting at this step"},
									"controls":     {"type": "array", "items": {"type": "string"}, "description": "Checks applied at this step"}
								},
								"required": ["client_id", "project_slug", "feature_id"]
							}},
					"edges":       {"type": "array", "description": "Edges of the new flow (as flows_set_steps)", "items": {
								"type": "object",
								"properties": {
									"from": {"type": "string", "description": "client_id of the step the edge leaves"},
									"to":   {"type": "string", "description": "client_id of the step it leads to"},
									"kind":           {"type": "string", "description": "What the hop is [next|call|async|read|write|response] (default next)"},
									"protocol":       {"type": "string", "description": "Protocol of the hop (http, grpc, sql, kafka, ...)"},
									"condition":      {"type": "string", "description": "When this path is taken (a branch label, e.g. 'if user is admin')"},
									"auth":           {"type": "string", "description": "Identity the hop carries (none, user, service, mtls, api-key, ...)"},
									"trust_boundary": {"type": "boolean", "description": "The hop crosses a trust boundary"},
									"data":           {"type": "string", "description": "What travels on the hop"},
									"tainted":        {"type": "boolean", "description": "The data is attacker-controlled"},
									"description":    {"type": "string", "description": "Short label shown on the edge"},
									"comment":        {"type": "string", "description": "Longer review note (not shown on the edge)"},
									"tags":           {"type": "array", "items": {"type": "string"}, "description": "Tags for this edge"},
									"position": {"type": "integer", "description": "Order among the edges leaving 'from' (default: order given)"}
								},
								"required": ["from", "to"]
							}},
					"name":        {"type": "string", "description": "Flow name"},
					"description": {"type": "string", "description": "Flow description"},
					"tags":        {"type": "array", "items": {"type": "string"}, "description": "Tags for filtering"},
					"status":      {"type": "string", "description": "Status [draft|active|archived] (default: draft)"},
					"owner":       {"type": "string", "description": "Owner identifier"},
					"folder_id":   {"type": "string", "description": "Folder to create the flow in (from flows_list_folders); omit for the top level"}
				},
				"required": ["name"]
			}
		}`),
		json.RawMessage(`{
			"name": "flows_update",
			"description": "Update a flow's metadata (name, description, status, tags, owner) or move it to another folder. Only the fields you pass change.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"flow_id":     {"type": "string", "description": "Flow ID"},
					"name":        {"type": "string", "description": "New name"},
					"description": {"type": "string", "description": "New description"},
					"status":      {"type": "string", "description": "New status [draft|active|archived]"},
					"tags":        {"type": "array", "items": {"type": "string"}, "description": "New tags (replaces existing)"},
					"owner":       {"type": "string", "description": "New owner"},
					"folder_id":   {"type": "string", "description": "Move the flow into this folder; \"\" for the top level"}
				},
				"required": ["flow_id"]
			}
		}`),
		json.RawMessage(`{
			"name": "flows_delete",
			"description": "Delete a flow. Call once without confirm to see what would be deleted (dry-run preview). Call again with confirm: true to actually delete. Deletion is permanent and not reversible.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"flow_id": {"type": "string", "description": "Flow ID"},
					"confirm": {"type": "boolean", "description": "Set true to confirm deletion (default: false = dry-run preview)"}
				},
				"required": ["flow_id"]
			}
		}`),
		json.RawMessage(`{
			"name": "flows_list_facets",
			"description": "Return available filter values (statuses, tags, projects, owners) for flows. Useful for discovering what tag or project values are in use before calling flows_list. Each facet item includes {value, count}. Accepts the same filter params as flows_list to show within-filter facet counts — e.g., passing status=active shows tag/project/owner facets for active flows only (cross-filter / drill-down pattern).",
			"inputSchema": {
				"type": "object",
				"properties": {
					"query":   {"type": "string", "description": "Restrict to flows matching this full-text query"},
					"status":  {"type": "string", "description": "Restrict to flows with this status"},
					"tag":     {"type": "string", "description": "Restrict to flows with this tag"},
					"project": {"type": "string", "description": "Restrict to flows containing steps from this project"},
					"owner":   {"type": "string", "description": "Restrict to flows owned by this person"},
					"folder":  {"type": "string", "description": "Restrict to flows directly in this folder id, or \"root\" for the top level"}
				},
				"required": []
			}
		}`),

		// ── folders ──
		json.RawMessage(`{
			"name": "flows_list_folders",
			"description": "List every flow folder (flat). Each has id, name, parentId (absent at the top level), flowCount and folderCount (direct children). Build paths by following parentId. Use folder ids with flows_list(folder), flows_create/flows_update(folder_id) and flows_move.",
			"inputSchema": {"type": "object", "properties": {}, "required": []}
		}`),
		json.RawMessage(`{
			"name": "flows_create_folder",
			"description": "Create a flow folder. Folders nest: pass parent_id to create inside another folder. Names cannot contain '/' and must be unique among siblings (case-insensitive).",
			"inputSchema": {
				"type": "object",
				"properties": {
					"name":      {"type": "string", "description": "Folder name"},
					"parent_id": {"type": "string", "description": "Parent folder id; omit for the top level"}
				},
				"required": ["name"]
			}
		}`),
		json.RawMessage(`{
			"name": "flows_update_folder",
			"description": "Rename a folder and/or move it under another parent (parent_id \"\" for the top level). Moving a folder into itself or one of its subfolders is rejected.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"folder_id": {"type": "string", "description": "Folder id"},
					"name":      {"type": "string", "description": "New name"},
					"parent_id": {"type": "string", "description": "New parent folder id; \"\" for the top level"}
				},
				"required": ["folder_id"]
			}
		}`),
		json.RawMessage(`{
			"name": "flows_delete_folder",
			"description": "Delete a folder together with all its subfolders and every flow inside them. Call once without confirm to see how many folders and flows would be deleted (dry-run). Call again with confirm: true to delete. Permanent.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"folder_id": {"type": "string", "description": "Folder id"},
					"confirm":   {"type": "boolean", "description": "Set true to delete (default: false = dry-run preview)"}
				},
				"required": ["folder_id"]
			}
		}`),
		json.RawMessage(`{
			"name": "flows_move",
			"description": "Move flows and/or folders into a folder in one call. target_folder_id \"\" is the top level. All-or-nothing: an unknown id, a cycle, or a sibling name clash rejects the whole move.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"flow_ids":         {"type": "array", "items": {"type": "string"}, "description": "Flow ids to move"},
					"folder_ids":       {"type": "array", "items": {"type": "string"}, "description": "Folder ids to move"},
					"target_folder_id": {"type": "string", "description": "Destination folder id; \"\" for the top level"}
				},
				"required": ["target_folder_id"]
			}
		}`),

		// ── steps (a flow is a graph: steps joined by typed edges) ──
		json.RawMessage(`{
			"name": "flows_add_step",
			"description": "Add a step to a flow and connect it. A step is one feature on one project (steps in a flow can come from different projects: that is how a flow follows a request across services). project_slug must be a registered project (list_projects); feature_id a feature in it (search_features across projects, or list_features with {project}). An unknown project or feature still creates the step, marked tombstoned with tombstonedReason (project_not_registered | feature_not_found). Where it goes — give at most one: after (insert after that step: it takes over that step's outgoing edges), before (insert before it: it takes over the incoming edges), from (a new branch out of that step; parent_step_id is the same), entry: true (a new entry point, unconnected). With none, the step is appended to the end of the main path (follow the first edge out of the first entry point), or becomes the first step of an empty flow. The kind/protocol/condition/auth/... fields describe the edge that leads into the new step. Returns the created step with its id.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"flow_id":          {"type": "string", "description": "Flow ID"},
					"project_slug":     {"type": "string", "description": "Project slug (from list_projects)"},
					"feature_id":       {"type": "string", "description": "Feature annotation ID (from search_features or list_features)"},
					"note":             {"type": "string", "description": "Step note / reviewer annotation"},
					"actor":            {"type": "string", "description": "Who is acting at this step (anonymous, user, admin, service:billing, ...)"},
					"controls":         {"type": "array", "items": {"type": "string"}, "description": "Checks applied at this step (authn:jwt, authz:rbac, validation:schema, rate-limit, ...)"},
					"after":            {"type": "string", "description": "Insert after this step ID"},
					"before":           {"type": "string", "description": "Insert before this step ID"},
					"from":             {"type": "string", "description": "Branch out of this step ID"},
					"parent_step_id":   {"type": "string", "description": "Same as from"},
					"entry":            {"type": "boolean", "description": "Add as a new, unconnected entry point"},
					"branch_condition": {"type": "string", "description": "Same as condition"},
					"kind":           {"type": "string", "description": "What the hop is [next|call|async|read|write|response] (default next)"},
					"protocol":       {"type": "string", "description": "Protocol of the hop (http, grpc, sql, kafka, ...)"},
					"condition":      {"type": "string", "description": "When this path is taken (a branch label, e.g. 'if user is admin')"},
					"auth":           {"type": "string", "description": "Identity the hop carries (none, user, service, mtls, api-key, ...)"},
					"trust_boundary": {"type": "boolean", "description": "The hop crosses a trust boundary"},
					"data":           {"type": "string", "description": "What travels on the hop"},
					"tainted":        {"type": "boolean", "description": "The data is attacker-controlled"},
					"description":    {"type": "string", "description": "Short label shown on the edge"},
					"comment":        {"type": "string", "description": "Longer review note (not shown on the edge)"},
					"tags":           {"type": "array", "items": {"type": "string"}, "description": "Tags for this edge"}
				},
				"required": ["flow_id", "project_slug", "feature_id"]
			}
		}`),
		json.RawMessage(`{
			"name": "flows_update_step",
			"description": "Update a step: its note, actor, controls, or point it at another feature (project_slug and/or feature_id) keeping its place and edges. branch_condition sets the condition on the one edge that leads into the step (an error if several do: use flows_set_edge). Only the fields you pass change. To move a step use flows_move_step.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"flow_id":          {"type": "string", "description": "Flow ID"},
					"step_id":          {"type": "string", "description": "Step ID"},
					"note":             {"type": "string", "description": "New note"},
					"actor":            {"type": "string", "description": "New actor"},
					"controls":         {"type": "array", "items": {"type": "string"}, "description": "New controls (replaces the list)"},
					"project_slug":     {"type": "string", "description": "Point the step at a feature on this project"},
					"feature_id":       {"type": "string", "description": "Point the step at this feature"},
					"branch_condition": {"type": "string", "description": "Condition on the edge into this step"}
				},
				"required": ["flow_id", "step_id"]
			}
		}`),
		json.RawMessage(`{
			"name": "flows_remove_step",
			"description": "Remove a step. mode splice (default) closes the gap: every step that led into it now leads on to every step it led to, so removing the middle of a path keeps the rest. mode subtree also removes the steps that were only reachable through it (a whole branch). mode isolate removes just the step and its edges.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"flow_id": {"type": "string", "description": "Flow ID"},
					"step_id": {"type": "string", "description": "Step ID"},
					"mode":    {"type": "string", "description": "splice (default) | subtree | isolate"}
				},
				"required": ["flow_id", "step_id"]
			}
		}`),
		json.RawMessage(`{
			"name": "flows_move_step",
			"description": "Move a step. direction -1/1 (or up/down) moves it one place: among its sibling branches when the step before it branches, otherwise along the path, swapping with the step before or after it (an entry point moves among the entry points). Or give a place — after, before, from (a branch of that step: this is how to re-parent) or entry — and the step is taken out (the gap closed) and put back there; edge fields describe the edge into it at its new place.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"flow_id":   {"type": "string", "description": "Flow ID"},
					"step_id":   {"type": "string", "description": "Step ID"},
					"direction": {"type": "integer", "description": "-1 (up) or 1 (down); \"up\"/\"down\" are also accepted"},
					"after":     {"type": "string", "description": "Put it after this step ID"},
					"before":    {"type": "string", "description": "Put it before this step ID"},
					"from":      {"type": "string", "description": "Make it a branch of this step ID"},
					"entry":     {"type": "boolean", "description": "Make it an unconnected entry point"},
					"kind":           {"type": "string", "description": "What the hop is [next|call|async|read|write|response] (default next)"},
					"protocol":       {"type": "string", "description": "Protocol of the hop (http, grpc, sql, kafka, ...)"},
					"condition":      {"type": "string", "description": "When this path is taken (a branch label, e.g. 'if user is admin')"},
					"auth":           {"type": "string", "description": "Identity the hop carries (none, user, service, mtls, api-key, ...)"},
					"trust_boundary": {"type": "boolean", "description": "The hop crosses a trust boundary"},
					"data":           {"type": "string", "description": "What travels on the hop"},
					"tainted":        {"type": "boolean", "description": "The data is attacker-controlled"},
					"description":    {"type": "string", "description": "Short label shown on the edge"},
					"comment":        {"type": "string", "description": "Longer review note (not shown on the edge)"},
					"tags":           {"type": "array", "items": {"type": "string"}, "description": "Tags for this edge"}
				},
				"required": ["flow_id", "step_id"]
			}
		}`),
		json.RawMessage(`{
			"name": "flows_set_steps",
			"description": "Replace a flow's whole graph in one atomic call: every existing step and edge is deleted first. Give steps with caller-chosen client_ids and edges between them (from/to are client_ids); the edges leaving one step keep the order given unless position is set. Loops and joins (several edges into one step) are fine; a step leading to itself, duplicate edges and unknown client_ids are rejected. The shape is what flows_export returns, so export, edit, set_steps round-trips. Returns {flow, stepIds} (client_id -> new step ID). The tree form (parent_client_id + branch_condition per step, links) is still accepted.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"flow_id": {"type": "string", "description": "Flow ID"},
					"steps": {"type": "array", "description": "The steps", "items": {
								"type": "object",
								"properties": {
									"client_id":    {"type": "string", "description": "Caller-assigned id, used by edges' from/to"},
									"project_slug": {"type": "string", "description": "Project slug"},
									"feature_id":   {"type": "string", "description": "Feature annotation ID"},
									"note":         {"type": "string", "description": "Step note"},
									"actor":        {"type": "string", "description": "Who is acting at this step"},
									"controls":     {"type": "array", "items": {"type": "string"}, "description": "Checks applied at this step"}
								},
								"required": ["client_id", "project_slug", "feature_id"]
							}},
					"edges": {"type": "array", "description": "The edges", "items": {
								"type": "object",
								"properties": {
									"from": {"type": "string", "description": "client_id of the step the edge leaves"},
									"to":   {"type": "string", "description": "client_id of the step it leads to"},
									"kind":           {"type": "string", "description": "What the hop is [next|call|async|read|write|response] (default next)"},
									"protocol":       {"type": "string", "description": "Protocol of the hop (http, grpc, sql, kafka, ...)"},
									"condition":      {"type": "string", "description": "When this path is taken (a branch label, e.g. 'if user is admin')"},
									"auth":           {"type": "string", "description": "Identity the hop carries (none, user, service, mtls, api-key, ...)"},
									"trust_boundary": {"type": "boolean", "description": "The hop crosses a trust boundary"},
									"data":           {"type": "string", "description": "What travels on the hop"},
									"tainted":        {"type": "boolean", "description": "The data is attacker-controlled"},
									"description":    {"type": "string", "description": "Short label shown on the edge"},
									"comment":        {"type": "string", "description": "Longer review note (not shown on the edge)"},
									"tags":           {"type": "array", "items": {"type": "string"}, "description": "Tags for this edge"},
									"position": {"type": "integer", "description": "Order among the edges leaving 'from' (default: order given)"}
								},
								"required": ["from", "to"]
							}}
				},
				"required": ["flow_id", "steps"]
			}
		}`),
		json.RawMessage(`{
			"name": "flows_export",
			"description": "Export a flow as {name, description, status, owner, tags, steps, edges} with each step's id as its client_id: the shape flows_create and flows_set_steps take, for copying, editing or reviewing a flow as one document.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"flow_id": {"type": "string", "description": "Flow ID"}
				},
				"required": ["flow_id"]
			}
		}`),

		// ── edges ──
		json.RawMessage(`{
			"name": "flows_set_edge",
			"description": "Create or update the edge from one step to another (the steps may be on different projects: a cross-project edge is one service calling another). Describe the hop: kind [next|call|async|read|write|response], protocol, condition (when this path is taken), auth (identity carried), trust_boundary, data (what travels), tainted (attacker-controlled), description (edge label), comment, tags, position (order among the edges leaving from_step_id). On an existing edge omitted fields keep their value (pass \"\" or [] to clear). Remove with flows_delete_edge.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"flow_id":      {"type": "string", "description": "Flow ID"},
					"from_step_id": {"type": "string", "description": "Step the edge leaves"},
					"to_step_id":   {"type": "string", "description": "Step it leads to"},
					"kind":           {"type": "string", "description": "What the hop is [next|call|async|read|write|response] (default next)"},
					"protocol":       {"type": "string", "description": "Protocol of the hop (http, grpc, sql, kafka, ...)"},
					"condition":      {"type": "string", "description": "When this path is taken (a branch label, e.g. 'if user is admin')"},
					"auth":           {"type": "string", "description": "Identity the hop carries (none, user, service, mtls, api-key, ...)"},
					"trust_boundary": {"type": "boolean", "description": "The hop crosses a trust boundary"},
					"data":           {"type": "string", "description": "What travels on the hop"},
					"tainted":        {"type": "boolean", "description": "The data is attacker-controlled"},
					"description":    {"type": "string", "description": "Short label shown on the edge"},
					"comment":        {"type": "string", "description": "Longer review note (not shown on the edge)"},
					"tags":           {"type": "array", "items": {"type": "string"}, "description": "Tags for this edge"},
					"position":     {"type": "integer", "description": "Order among the edges leaving from_step_id"}
				},
				"required": ["flow_id", "from_step_id", "to_step_id"]
			}
		}`),
		json.RawMessage(`{
			"name": "flows_delete_edge",
			"description": "Delete the edge between two steps of a flow (the steps stay).",
			"inputSchema": {
				"type": "object",
				"properties": {
					"flow_id":      {"type": "string", "description": "Flow ID"},
					"from_step_id": {"type": "string", "description": "Step the edge leaves"},
					"to_step_id":   {"type": "string", "description": "Step it leads to"}
				},
				"required": ["flow_id", "from_step_id", "to_step_id"]
			}
		}`),
		json.RawMessage(`{
			"name": "get_service_map",
			"description": "The service map: every project as a service with its features (kind, operation, protocol, open findings, how many flows use it) and the connections between services that flows record — each edge whose steps are on different projects, merged by (from feature, to feature, kind, protocol), with the auth values seen, whether any crosses a trust boundary or carries tainted data, and the flows it comes from. internal lists the same-project edges. Archived flows are left out unless archived: true.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"archived": {"type": "boolean", "description": "Include archived flows' edges"}
				},
				"required": []
			}
		}`),

		// ── baselines, delta, findings ──
		json.RawMessage(`{
			"name": "flows_set_baseline",
			"description": "Capture a baseline snapshot of a flow at its current state for future comparison via flows_get_delta.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"flow_id":  {"type": "string", "description": "Flow ID"},
					"reviewer": {"type": "string", "description": "Reviewer name"},
					"summary":  {"type": "string", "description": "Summary note for this baseline"}
				},
				"required": ["flow_id"]
			}
		}`),
		json.RawMessage(`{
			"name": "flows_list_baselines",
			"description": "List all baselines for a flow, newest first.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"flow_id": {"type": "string", "description": "Flow ID"}
				},
				"required": ["flow_id"]
			}
		}`),
		json.RawMessage(`{
			"name": "flows_get_baseline",
			"description": "Get a specific baseline snapshot including its full steps and edges at the time the baseline was taken. Pass baseline_id: 'latest' as a shortcut for the most recent baseline (equivalent to taking the first item from flows_list_baselines).",
			"inputSchema": {
				"type": "object",
				"properties": {
					"flow_id":     {"type": "string", "description": "Flow ID"},
					"baseline_id": {"type": "string", "description": "Baseline ID or the literal string 'latest' for the most recent baseline"}
				},
				"required": ["flow_id", "baseline_id"]
			}
		}`),
		json.RawMessage(`{
			"name": "flows_get_delta",
			"description": "Compute what changed in a flow since a baseline. Returns since (the baseline used), addedSteps, removedSteps, changedSteps (feature, note, actor, controls, effectiveAnchor), movedAnchors, and addedEdges, removedEdges, changedEdges (which edge fields changed, e.g. condition, kind, auth). Errors if the flow has no baseline yet. Pass since_baseline_id to diff against a specific baseline; omit to use the latest. Use flows_list_findings after reviewing delta to see if any new security issues correspond to changed files.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"flow_id":           {"type": "string", "description": "Flow ID"},
					"since_baseline_id": {"type": "string", "description": "Baseline ID to diff against (defaults to latest baseline)"}
				},
				"required": ["flow_id"]
			}
		}`),
		json.RawMessage(`{
			"name": "flows_delete_baseline",
			"description": "Delete a flow baseline. Call once without confirm to preview what will be deleted (dry-run). Call again with confirm: true to actually delete. Deletion is permanent and not reversible.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"flow_id":     {"type": "string", "description": "Flow ID"},
					"baseline_id": {"type": "string", "description": "Baseline ID"},
					"confirm":     {"type": "boolean", "description": "Set true to actually delete (default: false = dry-run preview)"}
				},
				"required": ["flow_id", "baseline_id"]
			}
		}`),
		json.RawMessage(`{
			"name": "flows_list_findings",
			"description": "List open findings associated with features in a flow's steps, grouped by severity. Aggregates across all projects referenced by the flow's steps. Returns {total, bySeverity, findings[]}. Empty if no projects are registered, no feature annotations exist, or no open findings are attached to those features. Tombstoned steps are included but their projects may return zero findings if the workbench is unreachable.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"flow_id": {"type": "string", "description": "Flow ID"}
				},
				"required": ["flow_id"]
			}
		}`),

		// ── saved views ──
		json.RawMessage(`{
			"name": "flows_list_views",
			"description": "List saved flow views (named flows_list filters shown in the Flows sidebar), most recently updated first. Each has id, name, query (filter string such as \"status:active tag:auth login\"), owner and isShared.",
			"inputSchema": {"type": "object", "properties": {}, "required": []}
		}`),
		json.RawMessage(`{
			"name": "flows_create_view",
			"description": "Save a named flow view. query uses the Flows filter syntax: space-separated key:value tokens (status, tag, project, owner; comma-separate several values) plus free text, e.g. \"status:active project:api,web login\".",
			"inputSchema": {
				"type": "object",
				"properties": {
					"name":      {"type": "string", "description": "View name"},
					"query":     {"type": "string", "description": "Filter string"},
					"owner":     {"type": "string", "description": "Owner identifier"},
					"is_shared": {"type": "boolean", "description": "Visible to everyone (default false)"}
				},
				"required": ["name"]
			}
		}`),
		json.RawMessage(`{
			"name": "flows_update_view",
			"description": "Rename a saved flow view, change its filter query, or change whether it is shared. Only the fields you pass change.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"view_id":   {"type": "string", "description": "View id (from flows_list_views)"},
					"name":      {"type": "string", "description": "New name"},
					"query":     {"type": "string", "description": "New filter string"},
					"is_shared": {"type": "boolean", "description": "Shared with everyone"}
				},
				"required": ["view_id"]
			}
		}`),
		json.RawMessage(`{
			"name": "flows_delete_view",
			"description": "Delete a saved flow view. Flows themselves are not affected.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"view_id": {"type": "string", "description": "View id (from flows_list_views)"}
				},
				"required": ["view_id"]
			}
		}`),
	}
}

// ── JSON-RPC helpers ────────────────────────────────────────────────────

func mcpResult(w http.ResponseWriter, id any, result any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"result":  result,
	})
}

func mcpError(w http.ResponseWriter, id any, code int, message string) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error":   map[string]any{"code": code, "message": message},
	})
}

func mcpToolError(w http.ResponseWriter, id any, message string) {
	mcpResult(w, id, map[string]any{
		"isError": true,
		"content": []map[string]any{
			{"type": "text", "text": message},
		},
	})
}
