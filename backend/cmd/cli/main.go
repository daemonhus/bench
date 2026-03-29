// Command bench provides a CLI interface to the bench workbench.
// It talks to a running workbench server over its REST API, requiring no
// direct database access.
//
//	bench git search-code --pattern "eval("
//	bench findings list --severity high
//	bench baselines set --reviewer user
//
// Run 'bench --help' for the full list, or 'bench <category> <cmd> --help'
// for details on a specific command including all available flags.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"text/tabwriter"
	"time"
)

var cliVersion = "dev"

const defaultBaseURL = "http://localhost:8080"

// ---------------------------------------------------------------------------
// Category + command registry
// ---------------------------------------------------------------------------

type category struct {
	Name string
	Desc string
}

var categories = []category{
	{"git", "Repository: search code, read files, view diffs and history"},
	{"findings", "Security findings: create, query, resolve vulnerability reports"},
	{"comments", "Review comments: create, query, resolve code review notes"},
	{"features", "Architectural features: interfaces, sources, sinks, dependencies, externalities"},
	{"baselines", "State snapshots: set baselines and view deltas between sessions"},
	{"analytics", "Analytics: summaries, coverage tracking, finding search"},
	{"reconcile", "Line tracking: reconcile annotation positions across commits"},
}

// endpoint describes how a CLI command maps to a REST API call.
type endpoint struct {
	Method string // GET, POST, PATCH, DELETE
	Path   string // e.g. "/api/findings" — may contain {id} placeholders
}

// cmdDef maps a CLI sub-command to a REST endpoint.
type cmdDef struct {
	Cat  string
	Name string
	Desc string
	EP   endpoint
	// Flags defines the accepted flags. Each flag maps to either a query
	// parameter (for GET/DELETE) or a JSON body field (for POST/PATCH).
	Flags []flagDef
}

type flagDef struct {
	Name     string // CLI flag name (kebab-case)
	Param    string // API parameter name (camelCase or snake_case as the API expects)
	Desc     string
	Required bool
	Type     string // "string" (default), "int", "bool", "list", "json"
}

// commands is the full CLI command table.
var commands = []cmdDef{
	// ── git ──────────────────────────────────────────────────────────────
	{Cat: "git", Name: "search-code", Desc: "Search code in the repository by regex pattern.",
		EP: endpoint{"GET", "/api/git/search"},
		Flags: []flagDef{
			{Name: "pattern", Param: "pattern", Desc: "Regex search pattern", Required: true},
			{Name: "commit", Param: "commit", Desc: "Search at this commit (default: HEAD)"},
			{Name: "path", Param: "path", Desc: "Limit search to files under this path"},
			{Name: "case-insensitive", Param: "case_insensitive", Desc: "Case-insensitive search", Type: "bool"},
			{Name: "max-results", Param: "max_results", Desc: "Maximum results to return", Type: "int"},
		}},
	{Cat: "git", Name: "blame", Desc: "Show git blame for a file.",
		EP: endpoint{"GET", "/api/git/show/{commitish}/{path}"},
		Flags: []flagDef{
			{Name: "commit", Param: "commitish", Desc: "Commit (default: HEAD)"},
			{Name: "path", Param: "path", Desc: "File path", Required: true},
		}},
	{Cat: "git", Name: "read-file", Desc: "Read file contents at a specific commit.",
		EP: endpoint{"GET", "/api/git/show/{commitish}/{path}"},
		Flags: []flagDef{
			{Name: "commit", Param: "commitish", Desc: "Commit (default: HEAD)"},
			{Name: "path", Param: "path", Desc: "File path", Required: true},
		}},
	{Cat: "git", Name: "list-files", Desc: "List files in the repository tree.",
		EP: endpoint{"GET", "/api/git/tree/{commitish}"},
		Flags: []flagDef{
			{Name: "commit", Param: "commitish", Desc: "Commit (default: HEAD)"},
		}},
	{Cat: "git", Name: "diff", Desc: "Show diff between two commits for a file.",
		EP: endpoint{"GET", "/api/git/diff"},
		Flags: []flagDef{
			{Name: "from", Param: "from", Desc: "From commit", Required: true},
			{Name: "to", Param: "to", Desc: "To commit", Required: true},
			{Name: "path", Param: "path", Desc: "File path", Required: true},
		}},
	{Cat: "git", Name: "changed-files", Desc: "List files changed between two commits.",
		EP: endpoint{"GET", "/api/git/diff-files"},
		Flags: []flagDef{
			{Name: "from", Param: "from", Desc: "From commit", Required: true},
			{Name: "to", Param: "to", Desc: "To commit", Required: true},
		}},
	{Cat: "git", Name: "commits", Desc: "List recent commits.",
		EP: endpoint{"GET", "/api/git/commits"},
		Flags: []flagDef{
			{Name: "limit", Param: "limit", Desc: "Max commits to return", Type: "int"},
		}},
	{Cat: "git", Name: "branches", Desc: "List branches.",
		EP: endpoint{"GET", "/api/git/branches"}},

	// ── findings ────────────────────────────────────────────────────────
	{Cat: "findings", Name: "list", Desc: "List findings, optionally filtered by file.",
		EP: endpoint{"GET", "/api/findings"},
		Flags: []flagDef{
			{Name: "file-id", Param: "fileId", Desc: "Filter by file path"},
			{Name: "commit", Param: "commit", Desc: "Enrich with positions at this commit"},
			{Name: "severity", Param: "severity", Desc: "Filter by severity [critical|high|medium|low|info]"},
			{Name: "status", Param: "status", Desc: "Filter by status [draft|open|in-progress|false-positive|accepted|closed]"},
		}},
	{Cat: "findings", Name: "get", Desc: "Get a single finding by ID.",
		EP: endpoint{"GET", "/api/findings/{id}"},
		Flags: []flagDef{
			{Name: "id", Param: "id", Desc: "Finding ID", Required: true},
		}},
	{Cat: "findings", Name: "create", Desc: "Create a new finding.",
		EP: endpoint{"POST", "/api/findings"},
		Flags: []flagDef{
			{Name: "id", Param: "id", Desc: "Finding ID", Required: true},
			{Name: "title", Param: "title", Desc: "Finding title", Required: true},
			{Name: "severity", Param: "severity", Desc: "Severity [critical|high|medium|low|info]", Required: true},
			{Name: "file-id", Param: "fileId", Desc: "Anchor file path"},
			{Name: "commit-id", Param: "commitId", Desc: "Anchor commit"},
			{Name: "line-start", Param: "lineStart", Desc: "Anchor line range start", Type: "int"},
			{Name: "line-end", Param: "lineEnd", Desc: "Anchor line range end", Type: "int"},
			{Name: "description", Param: "description", Desc: "Detailed description"},
			{Name: "cwe", Param: "cwe", Desc: "CWE identifier"},
			{Name: "cve", Param: "cve", Desc: "CVE identifier"},
			{Name: "vector", Param: "vector", Desc: "CVSS vector string"},
			{Name: "score", Param: "score", Desc: "CVSS score"},
			{Name: "status", Param: "status", Desc: "Status [draft|open|in-progress|false-positive|accepted|closed]"},
			{Name: "source", Param: "source", Desc: "Source (e.g. manual, tool name)"},
			{Name: "category", Param: "category", Desc: "Finding category"},
		}},
	{Cat: "findings", Name: "update", Desc: "Update a finding (partial update).",
		EP: endpoint{"PATCH", "/api/findings/{id}"},
		Flags: []flagDef{
			{Name: "id", Param: "id", Desc: "Finding ID", Required: true},
			{Name: "title", Param: "title", Desc: "New title"},
			{Name: "severity", Param: "severity", Desc: "New severity"},
			{Name: "description", Param: "description", Desc: "New description"},
			{Name: "status", Param: "status", Desc: "New status"},
			{Name: "cwe", Param: "cwe", Desc: "CWE identifier"},
			{Name: "cve", Param: "cve", Desc: "CVE identifier"},
			{Name: "vector", Param: "vector", Desc: "CVSS vector string"},
			{Name: "score", Param: "score", Desc: "CVSS score", Type: "int"},
			{Name: "source", Param: "source", Desc: "Source tool or scanner"},
			{Name: "category", Param: "category", Desc: "Finding category"},
			{Name: "file-id", Param: "file_id", Desc: "New anchor file path"},
			{Name: "commit-id", Param: "commit_id", Desc: "New anchor commit"},
			{Name: "line-start", Param: "line_start", Desc: "New anchor start line", Type: "int"},
			{Name: "line-end", Param: "line_end", Desc: "New anchor end line", Type: "int"},
		}},
	{Cat: "findings", Name: "delete", Desc: "Delete a finding.",
		EP: endpoint{"DELETE", "/api/findings/{id}"},
		Flags: []flagDef{
			{Name: "id", Param: "id", Desc: "Finding ID", Required: true},
		}},
	{Cat: "findings", Name: "resolve", Desc: "Resolve a finding at a specific commit.",
		EP: endpoint{"PATCH", "/api/findings/{id}"},
		Flags: []flagDef{
			{Name: "id", Param: "id", Desc: "Finding ID", Required: true},
			{Name: "commit", Param: "resolvedCommit", Desc: "Commit at which the finding was resolved", Required: true},
		}},
	{Cat: "findings", Name: "search", Desc: "Search findings by title or description text.",
		EP: endpoint{"GET", "/api/findings/search"},
		Flags: []flagDef{
			{Name: "query", Param: "query", Desc: "Search text", Required: true},
			{Name: "status", Param: "status", Desc: "Filter by status"},
			{Name: "severity", Param: "severity", Desc: "Filter by severity"},
		}},
	{Cat: "findings", Name: "batch-create", Desc: "Create multiple findings from JSON input.",
		EP:    endpoint{"POST", "/api/findings"},
		Flags: []flagDef{{Name: "input", Param: "_input", Desc: "JSON file (default: stdin)", Type: "batch"}}},

	// ── comments ────────────────────────────────────────────────────────
	{Cat: "comments", Name: "list", Desc: "List comments, optionally filtered by file or finding.",
		EP: endpoint{"GET", "/api/comments"},
		Flags: []flagDef{
			{Name: "file-id", Param: "fileId", Desc: "Filter by file path"},
			{Name: "finding-id", Param: "findingId", Desc: "Filter by finding ID"},
			{Name: "commit", Param: "commit", Desc: "Enrich with positions at this commit"},
		}},
	{Cat: "comments", Name: "get", Desc: "Get a single comment by ID.",
		EP: endpoint{"GET", "/api/comments/{id}"},
		Flags: []flagDef{
			{Name: "id", Param: "id", Desc: "Comment ID", Required: true},
		}},
	{Cat: "comments", Name: "create", Desc: "Create a new comment.",
		EP: endpoint{"POST", "/api/comments"},
		Flags: []flagDef{
			{Name: "id", Param: "id", Desc: "Comment ID", Required: true},
			{Name: "author", Param: "author", Desc: "Author name", Required: true},
			{Name: "text", Param: "text", Desc: "Comment text", Required: true},
			{Name: "file-id", Param: "fileId", Desc: "Anchor file path"},
			{Name: "commit-id", Param: "commitId", Desc: "Anchor commit"},
			{Name: "line-start", Param: "lineStart", Desc: "Anchor line range start", Type: "int"},
			{Name: "line-end", Param: "lineEnd", Desc: "Anchor line range end", Type: "int"},
			{Name: "comment-type", Param: "commentType", Desc: "Comment type [feature|improvement|question|concern]"},
			{Name: "thread-id", Param: "threadId", Desc: "Thread ID"},
			{Name: "parent-id", Param: "parentId", Desc: "Parent comment ID"},
			{Name: "finding-id", Param: "findingId", Desc: "Associated finding ID"},
		}},
	{Cat: "comments", Name: "update", Desc: "Update a comment (partial update).",
		EP: endpoint{"PATCH", "/api/comments/{id}"},
		Flags: []flagDef{
			{Name: "id", Param: "id", Desc: "Comment ID", Required: true},
			{Name: "text", Param: "text", Desc: "New text"},
			{Name: "comment-type", Param: "commentType", Desc: "Comment type [feature|improvement|question|concern]"},
			{Name: "file-id", Param: "file_id", Desc: "New anchor file path"},
			{Name: "commit-id", Param: "commit_id", Desc: "New anchor commit"},
			{Name: "line-start", Param: "line_start", Desc: "New anchor start line", Type: "int"},
			{Name: "line-end", Param: "line_end", Desc: "New anchor end line", Type: "int"},
		}},
	{Cat: "comments", Name: "delete", Desc: "Delete a comment.",
		EP: endpoint{"DELETE", "/api/comments/{id}"},
		Flags: []flagDef{
			{Name: "id", Param: "id", Desc: "Comment ID", Required: true},
		}},
	{Cat: "comments", Name: "resolve", Desc: "Resolve a comment at a specific commit.",
		EP: endpoint{"PATCH", "/api/comments/{id}"},
		Flags: []flagDef{
			{Name: "id", Param: "id", Desc: "Comment ID", Required: true},
			{Name: "commit", Param: "resolvedCommit", Desc: "Commit at which the comment was resolved", Required: true},
		}},
	{Cat: "comments", Name: "batch-create", Desc: "Create multiple comments from JSON input.",
		EP:    endpoint{"POST", "/api/comments"},
		Flags: []flagDef{{Name: "input", Param: "_input", Desc: "JSON file (default: stdin)", Type: "batch"}}},

	// ── baselines ───────────────────────────────────────────────────────
	{Cat: "baselines", Name: "set", Desc: "Create a new baseline snapshot.",
		EP: endpoint{"POST", "/api/baselines"},
		Flags: []flagDef{
			{Name: "reviewer", Param: "reviewer", Desc: "Reviewer name"},
			{Name: "summary", Param: "summary", Desc: "Baseline summary"},
			{Name: "commit", Param: "commitId", Desc: "Commit ID (default: HEAD)"},
		}},
	{Cat: "baselines", Name: "list", Desc: "List baselines.",
		EP: endpoint{"GET", "/api/baselines"}},
	{Cat: "baselines", Name: "delta", Desc: "Show changes since the latest baseline.",
		EP: endpoint{"GET", "/api/baselines/delta"},
		Flags: []flagDef{
			{Name: "id", Param: "id", Desc: "Baseline ID (default: latest)"},
		}},
	{Cat: "baselines", Name: "delete", Desc: "Delete a baseline.",
		EP: endpoint{"DELETE", "/api/baselines/{id}"},
		Flags: []flagDef{
			{Name: "id", Param: "id", Desc: "Baseline ID", Required: true},
		}},

	// ── analytics ───────────────────────────────────────────────────────
	{Cat: "analytics", Name: "summary", Desc: "Get a summary of findings, comments, and reconciliation state.",
		EP: endpoint{"GET", "/api/summary"},
		Flags: []flagDef{
			{Name: "commit", Param: "commit", Desc: "Summarize at this commit (default: HEAD)"},
		}},
	{Cat: "analytics", Name: "coverage", Desc: "Get file-level review coverage.",
		EP: endpoint{"GET", "/api/coverage"},
		Flags: []flagDef{
			{Name: "commit", Param: "commit", Desc: "Target commit (default: HEAD)"},
			{Name: "path", Param: "path", Desc: "Scope to files under this directory"},
			{Name: "only-unreviewed", Param: "only_unreviewed", Desc: "Only show unreviewed files", Type: "bool"},
		}},
	{Cat: "analytics", Name: "mark-reviewed", Desc: "Mark a file or directory as reviewed at a commit.",
		EP: endpoint{"POST", "/api/coverage/mark"},
		Flags: []flagDef{
			{Name: "path", Param: "path", Desc: "File or directory path", Required: true},
			{Name: "commit", Param: "commit", Desc: "Commit at which the review was performed", Required: true},
			{Name: "reviewer", Param: "reviewer", Desc: "Reviewer identifier"},
			{Name: "note", Param: "note", Desc: "Optional note"},
		}},

	// ── features ────────────────────────────────────────────────────────
	{Cat: "features", Name: "list", Desc: "List feature annotations, optionally filtered.",
		EP: endpoint{"GET", "/api/features"},
		Flags: []flagDef{
			{Name: "file-id", Param: "fileId", Desc: "Filter by file path"},
			{Name: "kind", Param: "kind", Desc: "Filter by kind [interface|source|sink|dependency|externality]"},
			{Name: "status", Param: "status", Desc: "Filter by status [draft|active|deprecated|removed|orphaned]"},
		}},
	{Cat: "features", Name: "get", Desc: "Get a single feature annotation by ID.",
		EP: endpoint{"GET", "/api/features/{id}"},
		Flags: []flagDef{
			{Name: "id", Param: "id", Desc: "Feature ID", Required: true},
		}},
	{Cat: "features", Name: "create", Desc: "Create a new feature annotation.",
		EP: endpoint{"POST", "/api/features"},
		Flags: []flagDef{
			{Name: "file-id", Param: "fileId", Desc: "Anchor file path", Required: true},
			{Name: "commit-id", Param: "commitId", Desc: "Anchor commit", Required: true},
			{Name: "kind", Param: "kind", Desc: "Feature kind [interface|source|sink|dependency|externality]", Required: true},
			{Name: "title", Param: "title", Desc: "Feature title — do not prefix with HTTP method (e.g. 'Login endpoint', not 'POST /login'); use --operation for that", Required: true},
			{Name: "line-start", Param: "lineStart", Desc: "Anchor line range start", Type: "int"},
			{Name: "line-end", Param: "lineEnd", Desc: "Anchor line range end", Type: "int"},
			{Name: "description", Param: "description", Desc: "Detailed description"},
			{Name: "operation", Param: "operation", Desc: "HTTP method, gRPC method, GraphQL operation, etc."},
			{Name: "direction", Param: "direction", Desc: "Data flow direction [in|out]"},
			{Name: "protocol", Param: "protocol", Desc: "Protocol (e.g. rest, grpc, graphql, websocket)"},
			{Name: "status", Param: "status", Desc: "Initial status (default: active)"},
			{Name: "tags", Param: "tags", Desc: "Comma-separated tags", Type: "list"},
			{Name: "source", Param: "source", Desc: "Tool or scanner that identified the feature"},
		}},
	{Cat: "features", Name: "update", Desc: "Update a feature annotation (partial update).",
		EP: endpoint{"PATCH", "/api/features/{id}"},
		Flags: []flagDef{
			{Name: "id", Param: "id", Desc: "Feature ID", Required: true},
			{Name: "kind", Param: "kind", Desc: "New kind"},
			{Name: "title", Param: "title", Desc: "New title"},
			{Name: "description", Param: "description", Desc: "New description"},
			{Name: "operation", Param: "operation", Desc: "New operation"},
			{Name: "direction", Param: "direction", Desc: "New direction"},
			{Name: "protocol", Param: "protocol", Desc: "New protocol"},
			{Name: "status", Param: "status", Desc: "New status"},
			{Name: "tags", Param: "tags", Desc: "Comma-separated tags", Type: "list"},
			{Name: "source", Param: "source", Desc: "Source tool or scanner"},
			{Name: "file-id", Param: "file_id", Desc: "New anchor file path"},
			{Name: "commit-id", Param: "commit_id", Desc: "New anchor commit"},
			{Name: "line-start", Param: "line_start", Desc: "Anchor line range start", Type: "int"},
			{Name: "line-end", Param: "line_end", Desc: "Anchor line range end", Type: "int"},
		}},
	{Cat: "features", Name: "delete", Desc: "Delete a feature annotation.",
		EP: endpoint{"DELETE", "/api/features/{id}"},
		Flags: []flagDef{
			{Name: "id", Param: "id", Desc: "Feature ID", Required: true},
		}},
	{Cat: "features", Name: "batch-create", Desc: "Create multiple features from JSON input.",
		EP:    endpoint{"POST", "/api/features"},
		Flags: []flagDef{{Name: "input", Param: "_input", Desc: "JSON file (default: stdin)", Type: "batch"}}},

	// ── reconcile ───────────────────────────────────────────────────────
	{Cat: "reconcile", Name: "start", Desc: "Start reconciling annotations to a target commit.",
		EP: endpoint{"POST", "/api/reconcile"},
		Flags: []flagDef{
			{Name: "target-commit", Param: "targetCommit", Desc: "Target commit", Required: true},
			{Name: "file-paths", Param: "filePaths", Desc: "Comma-separated file paths (default: all)", Type: "list"},
		}},
	{Cat: "reconcile", Name: "head", Desc: "Show reconciled HEAD status.",
		EP: endpoint{"GET", "/api/reconcile/head"}},
	{Cat: "reconcile", Name: "status", Desc: "Get reconciliation job or file status.",
		EP: endpoint{"GET", "/api/reconcile/status"},
		Flags: []flagDef{
			{Name: "job-id", Param: "jobId", Desc: "Job ID"},
			{Name: "file-id", Param: "fileId", Desc: "File ID (use with --commit)"},
			{Name: "commit", Param: "commit", Desc: "Commit (use with --file-id)"},
		}},
	{Cat: "reconcile", Name: "history", Desc: "Get position history for an annotation.",
		EP: endpoint{"GET", "/api/annotations/{type}/{id}/history"},
		Flags: []flagDef{
			{Name: "type", Param: "type", Desc: "Annotation type [finding|comment]", Required: true},
			{Name: "id", Param: "id", Desc: "Annotation ID", Required: true},
		}},
}

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

type apiClient struct {
	baseURL string
	http    *http.Client
}

func newAPIClient(baseURL string) *apiClient {
	return &apiClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    &http.Client{Timeout: 60 * time.Second},
	}
}

// do executes an API request and returns the response body.
func (c *apiClient) do(method, path string, body io.Reader) ([]byte, int, error) {
	req, err := http.NewRequest(method, c.baseURL+path, body)
	if err != nil {
		return nil, 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("cannot reach server at %s: %w", c.baseURL, err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return data, resp.StatusCode, nil
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

// parsedFlags holds the result of parsing CLI flags against a command definition.
type parsedFlags struct {
	values map[string]string // flagName → raw string value
	bools  map[string]bool   // flagName → set
}

func parseFlags(defs []flagDef, args []string) (*parsedFlags, error) {
	pf := &parsedFlags{
		values: make(map[string]string),
		bools:  make(map[string]bool),
	}

	// Build lookup by --name.
	byName := make(map[string]*flagDef)
	for i := range defs {
		byName[defs[i].Name] = &defs[i]
	}

	for i := 0; i < len(args); i++ {
		a := args[i]
		if !strings.HasPrefix(a, "--") {
			return nil, fmt.Errorf("unexpected argument: %s", a)
		}
		name := strings.TrimPrefix(a, "--")

		// Handle --name=value
		if idx := strings.IndexByte(name, '='); idx >= 0 {
			pf.values[name[:idx]] = name[idx+1:]
			continue
		}

		def, ok := byName[name]
		if !ok {
			return nil, fmt.Errorf("unknown flag: --%s", name)
		}

		if def.Type == "bool" {
			pf.bools[name] = true
			continue
		}

		if i+1 >= len(args) {
			return nil, fmt.Errorf("flag --%s requires a value", name)
		}
		i++
		pf.values[name] = args[i]
	}

	// Check required flags.
	var missing []string
	for _, d := range defs {
		if d.Required {
			if _, ok := pf.values[d.Name]; !ok {
				if _, ok2 := pf.bools[d.Name]; !ok2 {
					missing = append(missing, "--"+d.Name)
				}
			}
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return nil, fmt.Errorf("missing required flag(s): %s", strings.Join(missing, ", "))
	}

	return pf, nil
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

// buildRequest constructs the URL path, query string, and body from parsed
// flags according to the command definition. For batch commands, batchItems
// contains the individual JSON objects to POST one-by-one.
func buildRequest(cmd *cmdDef, pf *parsedFlags) (method, path string, body io.Reader, batchItems []json.RawMessage, err error) {
	method = cmd.EP.Method
	path = cmd.EP.Path

	// Handle special case: delta with ID → use /{id}/delta endpoint.
	if cmd.Cat == "baselines" && cmd.Name == "delta" {
		if id, ok := pf.values["id"]; ok {
			path = "/api/baselines/" + url.PathEscape(id) + "/delta"
			return method, path, nil, nil, nil
		}
		return method, path, nil, nil, nil
	}

	// Substitute path parameters like {id}, {commitish}, {path}, {type}.
	pathParams := make(map[string]bool) // track which flags were consumed by the path
	for _, fd := range cmd.Flags {
		placeholder := "{" + fd.Param + "}"
		if strings.Contains(path, placeholder) {
			val, ok := pf.values[fd.Name]
			if !ok || val == "" {
				// Use default for optional path params.
				if fd.Param == "commitish" {
					val = "HEAD"
				} else {
					continue
				}
			}
			path = strings.ReplaceAll(path, placeholder, url.PathEscape(val))
			pathParams[fd.Name] = true
		}
	}
	// Handle {path...} (catch-all) — Git show endpoint uses path after commitish.
	if strings.Contains(path, "{path}") {
		if val, ok := pf.values["path"]; ok {
			// Don't URL-encode slashes in file paths.
			path = strings.ReplaceAll(path, "{path}", val)
			pathParams["path"] = true
		}
	}

	// For GET/DELETE: remaining flags go to query string.
	// For POST/PATCH: remaining flags go to JSON body.
	switch method {
	case "GET", "DELETE":
		q := url.Values{}
		for _, fd := range cmd.Flags {
			if pathParams[fd.Name] {
				continue
			}
			if fd.Type == "bool" {
				if pf.bools[fd.Name] {
					q.Set(fd.Param, "true")
				}
				continue
			}
			if val, ok := pf.values[fd.Name]; ok && val != "" {
				q.Set(fd.Param, val)
			}
		}
		if len(q) > 0 {
			path += "?" + q.Encode()
		}

	case "POST", "PATCH":
		// Check for batch input.
		for _, fd := range cmd.Flags {
			if fd.Type == "batch" {
				var raw []byte
				if val, ok := pf.values["input"]; ok && val != "" {
					raw, err = os.ReadFile(val)
					if err != nil {
						return "", "", nil, nil, fmt.Errorf("reading input file: %w", err)
					}
				} else {
					stat, _ := os.Stdin.Stat()
					if stat.Mode()&os.ModeCharDevice != 0 {
						return "", "", nil, nil, fmt.Errorf("batch command requires JSON input via --input <file> or stdin pipe")
					}
					raw, err = io.ReadAll(os.Stdin)
					if err != nil {
						return "", "", nil, nil, fmt.Errorf("reading stdin: %w", err)
					}
				}
				raw = []byte(strings.TrimSpace(string(raw)))
				if len(raw) == 0 || raw[0] != '[' {
					return "", "", nil, nil, fmt.Errorf("input must be a JSON array")
				}
				var items []json.RawMessage
				if err := json.Unmarshal(raw, &items); err != nil {
					return "", "", nil, nil, fmt.Errorf("invalid JSON array: %w", err)
				}
				return method, path, nil, items, nil
			}
		}

		// Build JSON body from flags.
		obj := make(map[string]any)
		// Handle anchor fields specially for findings/comments create.
		var anchor map[string]any
		for _, fd := range cmd.Flags {
			if pathParams[fd.Name] {
				continue
			}
			val, ok := pf.values[fd.Name]
			if !ok || val == "" {
				continue
			}
			// Group anchor fields.
			switch fd.Param {
			case "fileId", "commitId":
				if anchor == nil {
					anchor = make(map[string]any)
				}
				anchor[fd.Param] = val
				continue
			case "lineStart", "lineEnd":
				if anchor == nil {
					anchor = make(map[string]any)
				}
				// Will be set below after we check both.
			}

			switch fd.Type {
			case "int":
				var n int
				fmt.Sscanf(val, "%d", &n)
				if fd.Param == "lineStart" || fd.Param == "lineEnd" {
					if anchor["lineRange"] == nil {
						anchor["lineRange"] = make(map[string]any)
					}
					lr := anchor["lineRange"].(map[string]any)
					if fd.Param == "lineStart" {
						lr["start"] = n
					} else {
						lr["end"] = n
					}
					continue
				}
				obj[fd.Param] = n
			case "list":
				parts := strings.Split(val, ",")
				trimmed := make([]string, 0, len(parts))
				for _, p := range parts {
					if s := strings.TrimSpace(p); s != "" {
						trimmed = append(trimmed, s)
					}
				}
				obj[fd.Param] = trimmed
			case "bool":
				obj[fd.Param] = pf.bools[fd.Name]
			default:
				obj[fd.Param] = val
			}
		}
		if anchor != nil {
			obj["anchor"] = anchor
		}

		b, err := json.Marshal(obj)
		if err != nil {
			return "", "", nil, nil, err
		}
		body = bytes.NewReader(b)
	}

	return method, path, body, nil, nil
}

// ---------------------------------------------------------------------------
// Help printers
// ---------------------------------------------------------------------------

func printRootHelp() {
	fmt.Fprintf(os.Stderr, "bench v%s — security review workbench CLI\n\n", cliVersion)
	fmt.Fprintln(os.Stderr, "Usage:")
	fmt.Fprintln(os.Stderr, "  bench [flags] <category> <command> [command-flags]")
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "Categories:")
	tw := tabwriter.NewWriter(os.Stderr, 2, 4, 3, ' ', 0)
	for _, c := range categories {
		fmt.Fprintf(tw, "  %s\t%s\n", c.Name, c.Desc)
	}
	tw.Flush()
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "Global Flags:")
	fmt.Fprintf(os.Stderr, "  --url string    Server base URL (default %q)\n", defaultBaseURL)
	fmt.Fprintln(os.Stderr, "  --version       Print version and exit")
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "Run 'bench <category> --help' for commands in a category.")
}

func printCategoryHelp(catName string) {
	var desc string
	for _, c := range categories {
		if c.Name == catName {
			desc = c.Desc
			break
		}
	}
	fmt.Fprintf(os.Stderr, "bench %s — %s\n\n", catName, strings.ToLower(desc))
	fmt.Fprintln(os.Stderr, "Commands:")

	tw := tabwriter.NewWriter(os.Stderr, 2, 4, 3, ' ', 0)
	for _, cmd := range commands {
		if cmd.Cat != catName {
			continue
		}
		fmt.Fprintf(tw, "  %s\t%s\n", cmd.Name, firstSentence(cmd.Desc))
	}
	tw.Flush()
	fmt.Fprintln(os.Stderr)
	fmt.Fprintf(os.Stderr, "Run 'bench %s <command> --help' for details on a command.\n", catName)
}

func printCommandHelp(cmd *cmdDef) {
	fmt.Fprintf(os.Stderr, "bench %s %s — %s\n\n", cmd.Cat, cmd.Name, cmd.Desc)
	fmt.Fprintf(os.Stderr, "Usage:\n  bench %s %s [flags]\n", cmd.Cat, cmd.Name)

	if len(cmd.Flags) > 0 {
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "Flags:")
		tw := tabwriter.NewWriter(os.Stderr, 2, 4, 3, ' ', 0)

		// Sort: required first, then alphabetical.
		sorted := make([]flagDef, len(cmd.Flags))
		copy(sorted, cmd.Flags)
		sort.Slice(sorted, func(i, j int) bool {
			if sorted[i].Required != sorted[j].Required {
				return sorted[i].Required
			}
			return sorted[i].Name < sorted[j].Name
		})

		for _, f := range sorted {
			typeHint := "string"
			switch f.Type {
			case "int":
				typeHint = "int"
			case "bool":
				typeHint = ""
			case "list":
				typeHint = "list"
			case "batch":
				typeHint = "file"
			}

			desc := f.Desc
			if f.Required {
				desc += " (required)"
			}

			if typeHint == "" {
				fmt.Fprintf(tw, "      --%s\t%s\n", f.Name, desc)
			} else {
				fmt.Fprintf(tw, "      --%s %s\t%s\n", f.Name, typeHint, desc)
			}
		}
		tw.Flush()
	}

	// For batch commands, show the JSON item schema derived from the
	// corresponding create command's flags.
	for _, f := range cmd.Flags {
		if f.Type != "batch" {
			continue
		}
		var createCmd *cmdDef
		for i := range commands {
			if commands[i].Cat == cmd.Cat && commands[i].Name == "create" {
				createCmd = &commands[i]
				break
			}
		}
		if createCmd == nil {
			break
		}
		fmt.Fprintln(os.Stderr)
		fmt.Fprintf(os.Stderr, "Input format (%s):\n", cmd.Cat)
		fmt.Fprintln(os.Stderr, "  JSON array of objects. Flat anchor fields (file, commit, line_start, line_end)")
		fmt.Fprintln(os.Stderr, "  are promoted to the nested anchor automatically. IDs are generated if omitted.")
		var req, opt []string
		for _, fl := range createCmd.Flags {
			if fl.Name == "id" {
				continue // auto-generated for batch
			}
			name := strings.ReplaceAll(fl.Name, "-", "_")
			switch fl.Name {
			case "file-id":
				name = "file"
			case "commit-id":
				name = "commit"
			}
			if fl.Required {
				req = append(req, name)
			} else {
				opt = append(opt, name)
			}
		}
		sort.Strings(req)
		sort.Strings(opt)
		if len(req) > 0 {
			fmt.Fprintf(os.Stderr, "    required: %s\n", strings.Join(req, ", "))
		}
		if len(opt) > 0 {
			fmt.Fprintf(os.Stderr, "    optional: %s\n", strings.Join(opt, ", "))
		}
		break
	}
}

// normalizeBatchItem transforms a batch JSON item into the REST API format.
// It promotes flat anchor fields (file/commit/line_start/line_end) into the
// nested anchor object the API expects, and auto-generates an id if absent.
func normalizeBatchItem(raw json.RawMessage) (json.RawMessage, error) {
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, err
	}

	// Auto-generate id if missing.
	if _, ok := obj["id"]; !ok {
		obj["id"] = newID()
	}

	// Collect or create the anchor sub-object.
	anchor, _ := obj["anchor"].(map[string]any)
	if anchor == nil {
		anchor = make(map[string]any)
	}

	// file / file_id / fileId → anchor.fileId
	for _, k := range []string{"file", "file_id", "fileId"} {
		if v, ok := obj[k]; ok {
			anchor["fileId"] = v
			delete(obj, k)
		}
	}
	// commit / commit_id / commitId → anchor.commitId
	for _, k := range []string{"commit", "commit_id", "commitId"} {
		if v, ok := obj[k]; ok {
			anchor["commitId"] = v
			delete(obj, k)
		}
	}
	// line_start / lineStart and line_end / lineEnd → anchor.lineRange
	var lineStart, lineEnd *int
	for _, k := range []string{"line_start", "lineStart"} {
		if v, ok := obj[k]; ok {
			if n, ok := anyToInt(v); ok {
				lineStart = &n
			}
			delete(obj, k)
		}
	}
	for _, k := range []string{"line_end", "lineEnd"} {
		if v, ok := obj[k]; ok {
			if n, ok := anyToInt(v); ok {
				lineEnd = &n
			}
			delete(obj, k)
		}
	}
	if lineStart != nil && lineEnd != nil {
		lr, _ := anchor["lineRange"].(map[string]any)
		if lr == nil {
			lr = make(map[string]any)
		}
		lr["start"] = *lineStart
		lr["end"] = *lineEnd
		anchor["lineRange"] = lr
	}

	if len(anchor) > 0 {
		obj["anchor"] = anchor
	}

	return json.Marshal(obj)
}

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func anyToInt(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	case int64:
		return int(n), true
	}
	return 0, false
}

func firstSentence(s string) string {
	if i := strings.Index(s, ". "); i > 0 {
		s = s[:i+1]
	}
	if len(s) > 0 {
		s = strings.ToLower(s[:1]) + s[1:]
	}
	return s
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

// formatOutput pretty-prints JSON or returns raw text.
func formatOutput(data []byte, statusCode int) string {
	// Check for error responses.
	if statusCode >= 400 {
		var errResp struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &errResp) == nil && errResp.Error != "" {
			return "Error: " + errResp.Error
		}
		return fmt.Sprintf("Error (HTTP %d): %s", statusCode, strings.TrimSpace(string(data)))
	}

	// 204 No Content.
	if statusCode == 204 || len(data) == 0 {
		return "OK"
	}

	// Try to pretty-print JSON.
	var raw any
	if err := json.Unmarshal(data, &raw); err == nil {
		pretty, err := json.MarshalIndent(raw, "", "  ")
		if err == nil {
			return string(pretty)
		}
	}

	return strings.TrimSpace(string(data))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

func main() {
	var (
		serverURL = defaultBaseURL
		showVer   bool
	)

	// Check BENCH_URL env var.
	if env := os.Getenv("BENCH_URL"); env != "" {
		serverURL = env
	}

	args := os.Args[1:]
	var positional []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--version":
			showVer = true
		case a == "--url" && i+1 < len(args):
			serverURL = args[i+1]
			i++
		case strings.HasPrefix(a, "--url="):
			serverURL = strings.TrimPrefix(a, "--url=")
		case a == "--":
			positional = append(positional, args[i+1:]...)
			i = len(args)
		default:
			positional = append(positional, args[i:]...)
			i = len(args)
		}
	}

	if showVer {
		fmt.Printf("bench v%s\n", cliVersion)
		os.Exit(0)
	}

	if len(positional) == 0 {
		printRootHelp()
		os.Exit(0)
	}

	catName := positional[0]
	if catName == "help" || catName == "-h" || catName == "--help" {
		printRootHelp()
		os.Exit(0)
	}

	// Validate category.
	validCat := false
	for _, c := range categories {
		if c.Name == catName {
			validCat = true
			break
		}
	}
	if !validCat {
		fmt.Fprintf(os.Stderr, "Error: unknown category %q\n\n", catName)
		fmt.Fprintln(os.Stderr, "Available categories:")
		for _, c := range categories {
			fmt.Fprintf(os.Stderr, "  %s\n", c.Name)
		}
		os.Exit(1)
	}

	// Category-level help.
	if len(positional) < 2 || positional[1] == "help" || positional[1] == "--help" || positional[1] == "-h" {
		printCategoryHelp(catName)
		os.Exit(0)
	}

	cmdName := positional[1]

	// Resolve the command.
	var matched *cmdDef
	for i := range commands {
		if commands[i].Cat == catName && commands[i].Name == cmdName {
			matched = &commands[i]
			break
		}
	}
	if matched == nil {
		fmt.Fprintf(os.Stderr, "Error: unknown command %q in category %q\n\n", cmdName, catName)
		printCategoryHelp(catName)
		os.Exit(1)
	}

	// Command-level help.
	cmdArgs := positional[2:]
	for _, a := range cmdArgs {
		if a == "--help" || a == "-h" || a == "help" {
			printCommandHelp(matched)
			os.Exit(0)
		}
	}

	// Parse flags.
	pf, err := parseFlags(matched.Flags, cmdArgs)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n\n", err)
		printCommandHelp(matched)
		os.Exit(1)
	}

	// Build request.
	method, path, body, batchItems, err := buildRequest(matched, pf)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	client := newAPIClient(serverURL)

	// Batch mode: POST each item individually.
	if len(batchItems) > 0 {
		var errors int
		for i, item := range batchItems {
			normalized, err := normalizeBatchItem(item)
			if err != nil {
				fmt.Fprintf(os.Stderr, "[%d/%d] Error normalizing item: %v\n", i+1, len(batchItems), err)
				errors++
				continue
			}
			data, status, err := client.do(method, path, bytes.NewReader(normalized))
			if err != nil {
				fmt.Fprintf(os.Stderr, "[%d/%d] Error: %v\n", i+1, len(batchItems), err)
				errors++
				continue
			}
			if status >= 400 {
				fmt.Fprintf(os.Stderr, "[%d/%d] %s\n", i+1, len(batchItems), formatOutput(data, status))
				errors++
				continue
			}
			fmt.Fprintf(os.Stderr, "[%d/%d] created\n", i+1, len(batchItems))
		}
		fmt.Printf("%d/%d succeeded\n", len(batchItems)-errors, len(batchItems))
		if errors > 0 {
			os.Exit(1)
		}
		return
	}

	// Single request.
	data, status, err := client.do(method, path, body)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		fmt.Fprintf(os.Stderr, "\nIs the workbench server running? Start it with:\n")
		fmt.Fprintf(os.Stderr, "  cd bench && ./dev.sh /path/to/repo\n")
		fmt.Fprintf(os.Stderr, "\nOr specify a different URL with --url.\n")
		os.Exit(1)
	}

	output := formatOutput(data, status)
	fmt.Println(output)

	if status >= 400 {
		os.Exit(1)
	}
}
