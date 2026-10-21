package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// flows: cross-project request journeys: steps (features on any project) joined by typed edges.

func flowPath(id string, rest ...string) string {
	p := "/api/flows/" + url.PathEscape(id)
	for _, r := range rest {
		p += "/" + url.PathEscape(r)
	}
	return p
}

// addRepeated sets key to each comma-separated value of a flag (the server
// accepts repeated tag/owner/project params, and comma-separated status).
func addRepeated(q url.Values, key string, vals []string) {
	for _, v := range vals {
		q.Add(key, v)
	}
}

// flowFilterFlags are shared by flows list and flows facets.
var flowFilterFlags = []flagDef{
	{Name: "status", Desc: "Filter by status [draft|active|archived] (comma-separated for several)"},
	{Name: "tag", Desc: "Filter by tag (comma-separated for several)", Type: "list"},
	{Name: "project", Desc: "Only flows with steps on this project slug (comma-separated for several)", Type: "list"},
	{Name: "owner", Desc: "Filter by owner (comma-separated for several)", Type: "list"},
	{Name: "query", Desc: "Full-text search over flow name, description and step notes"},
}

func flowFilterQuery(in *mpInput) url.Values {
	q := url.Values{}
	if v := in.str("status"); v != "" {
		q.Set("status", v)
	}
	addRepeated(q, "tag", in.list("tag"))
	addRepeated(q, "project", in.list("project"))
	addRepeated(q, "owner", in.list("owner"))
	if v := in.str("query"); v != "" {
		q.Set("q", v)
	}
	return q
}

func init() {
	listFlags := append(append([]flagDef{}, flowFilterFlags...),
		flagDef{Name: "folder", Desc: "Only flows directly in this folder (id, path, or / for the top level)"},
		flagDef{Name: "sort", Desc: "Sort by [updated|created|name|stepCount|risk] (default: updated)"},
		flagDef{Name: "order", Desc: "Sort order [asc|desc] (default: desc)"},
		flagDef{Name: "limit", Desc: "Maximum flows to return (default: 50, max: 200)", Type: "int"},
		flagDef{Name: "offset", Desc: "Skip this many flows (pagination)", Type: "int"},
	)
	mpCommands = append(mpCommands,
		mpCmd{Group: "flows", Name: "list", Desc: "List flows, optionally filtered.", Flags: listFlags, Run: flowList},
		mpCmd{Group: "flows", Name: "get", Desc: "Get a flow with its steps and edges.",
			Args:  []string{"id"},
			Flags: []flagDef{{Name: "id", Desc: "Flow ID", Required: true}},
			Run:   func(c *cli, in *mpInput) error { return c.emit("GET", flowPath(in.str("id")), nil) }},
		mpCmd{Group: "flows", Name: "create", Desc: "Create a flow.",
			Flags: []flagDef{
				{Name: "name", Desc: "Flow name", Required: true},
				{Name: "description", Desc: "Flow description"},
				{Name: "tags", Desc: "Comma-separated tags", Type: "list"},
				{Name: "status", Desc: "Status [draft|active|archived] (default: draft)"},
				{Name: "owner", Desc: "Owner"},
				{Name: "folder", Desc: "Folder to create it in (id or path)"},
			},
			Run: flowCreate},
		mpCmd{Group: "flows", Name: "update", Desc: "Update a flow's metadata (partial update).",
			Args: []string{"id"},
			Flags: []flagDef{
				{Name: "id", Desc: "Flow ID", Required: true},
				{Name: "name", Desc: "New name"},
				{Name: "description", Desc: "New description (pass \"\" to clear)"},
				{Name: "status", Desc: "New status [draft|active|archived]"},
				{Name: "tags", Desc: "New tags, comma-separated (replaces the full list; pass \"\" to clear)", Type: "list"},
				{Name: "owner", Desc: "New owner (pass \"\" to clear)"},
				{Name: "folder", Desc: "Move into this folder (id, path, or / for the top level)"},
			},
			Run: flowUpdate},
		mpCmd{Group: "flows", Name: "delete", Desc: "Delete a flow. Shows a preview by default; pass --confirm to actually delete.",
			Args: []string{"id"},
			Flags: []flagDef{
				{Name: "id", Desc: "Flow ID", Required: true},
				{Name: "confirm", Desc: "Actually delete (default: preview only)", Type: "bool"},
			},
			Run: flowDelete},

		// ── steps (a flow is a graph: steps joined by typed edges) ──
		mpCmd{Group: "flows", Name: "add-step", Desc: "Add a step (a feature on some project) to a flow and connect it. Without --after/--before/--from/--entry it is appended to the end of the main path. The edge flags describe the edge that leads into the new step.",
			Args: []string{"flow"},
			Flags: []flagDef{
				{Name: "flow", Desc: "Flow ID", Required: true},
				{Name: "feature", Desc: "Feature ID", Required: true},
				{Name: "project", Desc: "Project slug the feature lives on (default: global --project / BENCH_PROJECT)"},
				{Name: "note", Desc: "Step note"},
				{Name: "actor", Desc: "Who is acting at this step (anonymous, user, admin, service:billing, ...)"},
				{Name: "controls", Desc: "Comma-separated checks applied at this step (authn:jwt, authz:rbac, ...)", Type: "list"},
				{Name: "after", Desc: "Insert after this step (it takes over that step's outgoing edges)"},
				{Name: "before", Desc: "Insert before this step (it takes over that step's incoming edges)"},
				{Name: "from", Desc: "Branch out of this step"},
				{Name: "parent", Desc: "Same as --from"},
				{Name: "entry", Desc: "Add as a new, unconnected entry point", Type: "bool"},
				{Name: "kind", Desc: "Edge kind [next|call|async|read|write|response]"},
				{Name: "protocol", Desc: "Protocol of the hop (http, grpc, sql, kafka, ...)"},
				{Name: "condition", Desc: "When this path is taken (branch label, e.g. \"if user is admin\")"},
				{Name: "auth", Desc: "Identity the hop carries (none, user, service, mtls, api-key, ...)"},
				{Name: "trust-boundary", Desc: "The hop crosses a trust boundary [true|false]"},
				{Name: "data", Desc: "What travels on the hop"},
				{Name: "tainted", Desc: "The data is attacker-controlled [true|false]"},
				{Name: "description", Desc: "Short label shown on the edge"},
				{Name: "comment", Desc: "Longer review note for the edge"},
				{Name: "tags", Desc: "Comma-separated edge tags (e.g. auth,high-risk)", Type: "list"},
			},
			Run: flowAddStep},
		mpCmd{Group: "flows", Name: "update-step", Desc: "Update a step: note, actor, controls, or point it at another feature (keeping its place and edges). --condition sets the condition on the one edge into the step.",
			Args: []string{"flow", "step"},
			Flags: []flagDef{
				{Name: "flow", Desc: "Flow ID", Required: true},
				{Name: "step", Desc: "Step ID", Required: true},
				{Name: "note", Desc: "New note"},
				{Name: "actor", Desc: "New actor"},
				{Name: "controls", Desc: "New comma-separated controls (replaces the list; \"\" clears)", Type: "list"},
				{Name: "feature", Desc: "Point the step at this feature"},
				{Name: "project", Desc: "Point the step at a feature on this project"},
				{Name: "condition", Desc: "Condition on the edge into this step"},
			},
			Run: flowUpdateStep},
		mpCmd{Group: "flows", Name: "remove-step", Desc: "Remove a step. By default the gap is closed (what led into it leads on to what it led to); --mode subtree also removes the steps only reachable through it; --mode isolate removes just the step and its edges.",
			Args: []string{"flow", "step"},
			Flags: []flagDef{
				{Name: "flow", Desc: "Flow ID", Required: true},
				{Name: "step", Desc: "Step ID", Required: true},
				{Name: "mode", Desc: "How to remove it [splice|subtree|isolate] (default: splice)"},
			},
			Run: func(c *cli, in *mpInput) error {
				if err := checkEnum(in, "mode", false, "splice", "subtree", "isolate"); err != nil {
					return err
				}
				q := url.Values{}
				if m := in.str("mode"); m != "" {
					q.Set("mode", m)
				}
				return c.emit("DELETE", withQuery(flowPath(in.str("flow"), "steps", in.str("step")), q), nil)
			}},
		mpCmd{Group: "flows", Name: "move-step", Desc: "Move a step one place (up/down: among its sibling branches, else along the path), or to a place: --after, --before, --from (re-parent as a branch of that step) or --entry. The edge flags describe the edge into it at its new place.",
			Args: []string{"flow", "step", "direction"},
			Flags: []flagDef{
				{Name: "flow", Desc: "Flow ID", Required: true},
				{Name: "step", Desc: "Step ID", Required: true},
				{Name: "direction", Desc: "Direction [up|down] (or give a place instead)"},
				{Name: "after", Desc: "Put it after this step"},
				{Name: "before", Desc: "Put it before this step"},
				{Name: "from", Desc: "Make it a branch of this step"},
				{Name: "parent", Desc: "Same as --from"},
				{Name: "entry", Desc: "Make it an unconnected entry point", Type: "bool"},
				{Name: "kind", Desc: "Edge kind [next|call|async|read|write|response]"},
				{Name: "protocol", Desc: "Protocol of the hop (http, grpc, sql, kafka, ...)"},
				{Name: "condition", Desc: "When this path is taken (branch label, e.g. \"if user is admin\")"},
				{Name: "auth", Desc: "Identity the hop carries (none, user, service, mtls, api-key, ...)"},
				{Name: "trust-boundary", Desc: "The hop crosses a trust boundary [true|false]"},
				{Name: "data", Desc: "What travels on the hop"},
				{Name: "tainted", Desc: "The data is attacker-controlled [true|false]"},
				{Name: "description", Desc: "Short label shown on the edge"},
				{Name: "comment", Desc: "Longer review note for the edge"},
				{Name: "tags", Desc: "Comma-separated edge tags (e.g. auth,high-risk)", Type: "list"},
			},
			Run: flowMoveStep},
		mpCmd{Group: "flows", Name: "set-steps", Desc: "Replace a flow's whole graph from JSON: {\"steps\": [{clientId, projectSlug, featureId, note?, actor?, controls?}], \"edges\": [{from, to, kind?, protocol?, condition?, auth?, trustBoundary?, data?, tainted?, description?, comment?, tags?, position?}]} (from/to are clientIds). Loops and joins are fine. The output of 'flows export' is accepted, so export, edit, set-steps round-trips. Step IDs are reassigned; the response maps clientId to new ID.",
			Args: []string{"flow"},
			Flags: []flagDef{
				{Name: "flow", Desc: "Flow ID", Required: true},
				{Name: "input", Desc: "JSON file with {steps, edges} (default: stdin)", Type: "file"},
			},
			Run: flowSetSteps},
		mpCmd{Group: "flows", Name: "export", Desc: "Print a flow as one JSON document {name, description, status, owner, tags, steps, edges}: what 'flows import' and 'flows set-steps' take.",
			Args:  []string{"flow"},
			Flags: []flagDef{{Name: "flow", Desc: "Flow ID", Required: true}},
			Run: func(c *cli, in *mpInput) error {
				return c.emit("GET", flowPath(in.str("flow"), "export"), nil)
			}},
		mpCmd{Group: "flows", Name: "import", Desc: "Create a flow, with its whole graph, from a JSON document (the 'flows export' shape).",
			Flags: []flagDef{
				{Name: "input", Desc: "JSON file (default: stdin)", Type: "file"},
				{Name: "name", Desc: "Name for the new flow (default: the document's name)"},
				{Name: "folder", Desc: "Folder to create it in (id or path)"},
			},
			Run: flowImport},

		// ── edges ──
		mpCmd{Group: "flows", Name: "set-edge", Desc: "Create or update the edge from one step to another (they may be on different projects: one service calling another). On an existing edge, flags left out keep their current value; pass \"\" to clear one.",
			Args: []string{"flow", "from", "to"},
			Flags: []flagDef{
				{Name: "flow", Desc: "Flow ID", Required: true},
				{Name: "from", Desc: "Step the edge leaves", Required: true},
				{Name: "to", Desc: "Step it leads to", Required: true},
				{Name: "position", Desc: "Order among the edges leaving --from", Type: "int"},
				{Name: "kind", Desc: "Edge kind [next|call|async|read|write|response]"},
				{Name: "protocol", Desc: "Protocol of the hop (http, grpc, sql, kafka, ...)"},
				{Name: "condition", Desc: "When this path is taken (branch label, e.g. \"if user is admin\")"},
				{Name: "auth", Desc: "Identity the hop carries (none, user, service, mtls, api-key, ...)"},
				{Name: "trust-boundary", Desc: "The hop crosses a trust boundary [true|false]"},
				{Name: "data", Desc: "What travels on the hop"},
				{Name: "tainted", Desc: "The data is attacker-controlled [true|false]"},
				{Name: "description", Desc: "Short label shown on the edge"},
				{Name: "comment", Desc: "Longer review note for the edge"},
				{Name: "tags", Desc: "Comma-separated edge tags (e.g. auth,high-risk)", Type: "list"},
			},
			Run: flowSetEdge},
		mpCmd{Group: "flows", Name: "delete-edge", Desc: "Delete the edge between two steps (the steps stay).",
			Args: []string{"flow", "from", "to"},
			Flags: []flagDef{
				{Name: "flow", Desc: "Flow ID", Required: true},
				{Name: "from", Desc: "Step the edge leaves", Required: true},
				{Name: "to", Desc: "Step it leads to", Required: true},
			},
			Run: func(c *cli, in *mpInput) error {
				return c.emit("DELETE", flowPath(in.str("flow"), "edges", in.str("from"), in.str("to")), nil)
			}},

		// ── service map ──
		mpCmd{Group: "map", Name: "show", Desc: "Print the service map: services (projects) with their features, and the connections between them from flows' cross-project edges.",
			Flags: []flagDef{{Name: "archived", Desc: "Include archived flows' edges", Type: "bool"}},
			Run: func(c *cli, in *mpInput) error {
				q := url.Values{}
				if in.flag("archived") {
					q.Set("archived", "1")
				}
				return c.emit("GET", withQuery("/api/service-map", q), nil)
			}},

		// ── discovery / review ──
		mpCmd{Group: "flows", Name: "facets", Desc: "List available filter values (status, tag, project, owner) with counts.",
			Flags: flowFilterFlags,
			Run: func(c *cli, in *mpInput) error {
				return c.emit("GET", withQuery("/api/flows/facets", flowFilterQuery(in)), nil)
			}},
		mpCmd{Group: "flows", Name: "delta", Desc: "Show what changed since the latest (or a specific) flow baseline.",
			Args: []string{"flow", "baseline"},
			Flags: []flagDef{
				{Name: "flow", Desc: "Flow ID", Required: true},
				{Name: "baseline", Desc: "Baseline ID to compare against (default: latest)"},
			},
			Run: func(c *cli, in *mpInput) error {
				q := url.Values{}
				if v := in.str("baseline"); v != "" {
					q.Set("since", v)
				}
				return c.emit("GET", withQuery(flowPath(in.str("flow"), "delta"), q), nil)
			}},
		mpCmd{Group: "flows", Name: "findings", Desc: "List open findings on the features this flow's steps point at.",
			Args:  []string{"flow"},
			Flags: []flagDef{{Name: "flow", Desc: "Flow ID", Required: true}},
			Run: func(c *cli, in *mpInput) error {
				return c.emit("GET", flowPath(in.str("flow"), "findings"), nil)
			}},

		// ── baselines ──
		mpCmd{Group: "flows baseline", Name: "set", Desc: "Capture a new baseline snapshot of a flow.",
			Args: []string{"flow"},
			Flags: []flagDef{
				{Name: "flow", Desc: "Flow ID", Required: true},
				{Name: "reviewer", Desc: "Reviewer name"},
				{Name: "summary", Desc: "Summary note"},
			},
			Run: func(c *cli, in *mpInput) error {
				obj := map[string]string{}
				for _, k := range []string{"reviewer", "summary"} {
					if v := in.str(k); v != "" {
						obj[k] = v
					}
				}
				return c.emit("POST", flowPath(in.str("flow"), "baselines"), obj)
			}},
		mpCmd{Group: "flows baseline", Name: "list", Desc: "List a flow's baselines, newest first.",
			Args:  []string{"flow"},
			Flags: []flagDef{{Name: "flow", Desc: "Flow ID", Required: true}},
			Run: func(c *cli, in *mpInput) error {
				return c.emit("GET", flowPath(in.str("flow"), "baselines"), nil)
			}},
		mpCmd{Group: "flows baseline", Name: "get", Desc: "Get one flow baseline (or the latest).",
			Args: []string{"flow", "id"},
			Flags: []flagDef{
				{Name: "flow", Desc: "Flow ID", Required: true},
				{Name: "id", Desc: "Baseline ID, or 'latest' (default: latest)"},
			},
			Run: func(c *cli, in *mpInput) error {
				id := in.str("id")
				if id == "" {
					id = "latest"
				}
				return c.emit("GET", flowPath(in.str("flow"), "baselines", id), nil)
			}},
		mpCmd{Group: "flows baseline", Name: "delete", Desc: "Delete a flow baseline. Shows a preview by default; pass --confirm to actually delete.",
			Args: []string{"flow", "id"},
			Flags: []flagDef{
				{Name: "flow", Desc: "Flow ID", Required: true},
				{Name: "id", Desc: "Baseline ID", Required: true},
				{Name: "confirm", Desc: "Actually delete (default: preview only)", Type: "bool"},
			},
			Run: flowBaselineDelete},

		// ── saved views ──
		mpCmd{Group: "flows views", Name: "list", Desc: "List saved flow views, most recently updated first.",
			Run: func(c *cli, _ *mpInput) error { return c.emit("GET", "/api/flow-views", nil) }},
		mpCmd{Group: "flows views", Name: "create", Desc: "Save a flow view: a named flow list query string (e.g. 'status=active&tag=auth').",
			Flags: []flagDef{
				{Name: "name", Desc: "View name", Required: true},
				{Name: "query", Desc: "Flow list query string, as used by the flows list URL"},
				{Name: "owner", Desc: "Owner"},
				{Name: "shared", Desc: "Share the view with everyone", Type: "bool"},
			},
			Run: func(c *cli, in *mpInput) error {
				return c.emit("POST", "/api/flow-views", map[string]any{
					"name": in.str("name"), "query": in.str("query"), "owner": in.str("owner"), "isShared": in.flag("shared"),
				})
			}},
		mpCmd{Group: "flows views", Name: "update", Desc: "Update a saved flow view (partial update).",
			Args: []string{"id"},
			Flags: []flagDef{
				{Name: "id", Desc: "View ID", Required: true},
				{Name: "name", Desc: "New name"},
				{Name: "query", Desc: "New query string (pass \"\" to clear)"},
				{Name: "shared", Desc: "Share the view", Type: "bool"},
				{Name: "private", Desc: "Stop sharing the view", Type: "bool"},
			},
			Run: flowViewUpdate},
		mpCmd{Group: "flows views", Name: "delete", Desc: "Delete a saved flow view.",
			Args:  []string{"id"},
			Flags: []flagDef{{Name: "id", Desc: "View ID", Required: true}},
			Run: func(c *cli, in *mpInput) error {
				return c.emit("DELETE", "/api/flow-views/"+url.PathEscape(in.str("id")), nil)
			}},
	)
}

// checkEnum rejects a flag value outside allowed (comma-separated values are
// each checked when multi is set). The server ignores unknown sort/order
// values, so without this a typo silently gives the default ordering.
func checkEnum(in *mpInput, flag string, multi bool, allowed ...string) error {
	v := in.str(flag)
	if v == "" {
		return nil
	}
	vals := []string{v}
	if multi {
		vals = strings.Split(v, ",")
	}
	for _, x := range vals {
		ok := false
		for _, a := range allowed {
			if strings.TrimSpace(x) == a {
				ok = true
			}
		}
		if !ok {
			return fmt.Errorf("--%s must be one of %s, got %q", flag, strings.Join(allowed, "|"), strings.TrimSpace(x))
		}
	}
	return nil
}

func flowList(c *cli, in *mpInput) error {
	for _, err := range []error{
		checkEnum(in, "status", true, "draft", "active", "archived"),
		checkEnum(in, "sort", false, "updated", "created", "name", "stepCount", "risk"),
		checkEnum(in, "order", false, "asc", "desc"),
	} {
		if err != nil {
			return err
		}
	}
	q := flowFilterQuery(in)
	for _, k := range []string{"sort", "order", "limit", "offset"} {
		if v := in.str(k); v != "" {
			q.Set(k, v)
		}
	}
	if in.has("folder") {
		folders, err := c.fetchFolders()
		if err != nil {
			return err
		}
		id, err := resolveFolder(folders, in.str("folder"))
		if err != nil {
			return err
		}
		if id == "" {
			id = "root"
		}
		q.Set("folder", id)
	}
	return c.emit("GET", withQuery("/api/flows", q), nil)
}

func flowCreate(c *cli, in *mpInput) error {
	tags := in.list("tags")
	if tags == nil {
		tags = []string{}
	}
	status := in.str("status")
	if status == "" {
		status = "draft"
	}
	obj := map[string]any{
		"name":        in.str("name"),
		"description": in.str("description"),
		"status":      status,
		"owner":       in.str("owner"),
		"tags":        tags,
	}
	if v := in.str("folder"); v != "" {
		id, err := c.resolveFolderRef(v)
		if err != nil {
			return err
		}
		obj["folderId"] = id
	}
	return c.emit("POST", "/api/flows", obj)
}

func flowUpdate(c *cli, in *mpInput) error {
	obj := map[string]any{}
	// A flag given as "" is sent too: that clears --description/--owner (and
	// the server rejects an empty --name or --status).
	for _, k := range []string{"name", "description", "status", "owner"} {
		if in.has(k) {
			obj[k] = in.str(k)
		}
	}
	if tags := in.list("tags"); tags != nil {
		obj["tags"] = tags
	}
	if in.has("folder") {
		id, err := c.resolveFolderRef(in.str("folder"))
		if err != nil {
			return err
		}
		obj["folderId"] = id
	}
	if len(obj) == 0 {
		return errors.New("nothing to update: pass at least one of --name, --description, --status, --tags, --owner, --folder")
	}
	return c.emit("PATCH", flowPath(in.str("id")), obj)
}

func flowDelete(c *cli, in *mpInput) error {
	id := in.str("id")
	if !in.flag("confirm") {
		data, _, err := c.req("GET", flowPath(id), nil)
		if err != nil {
			return err
		}
		var flow struct {
			Name  string `json:"name"`
			Steps []any  `json:"steps"`
		}
		_ = json.Unmarshal(data, &flow)
		fmt.Fprintf(c.stdout, "Dry run - flow %q (id: %s, %d steps) would be deleted.\n\nPass --confirm to delete.\n", flow.Name, id, len(flow.Steps))
		return nil
	}
	if _, _, err := c.req("DELETE", flowPath(id), nil); err != nil {
		return err
	}
	fmt.Fprintf(c.stdout, "Deleted flow %q\n", id)
	return nil
}

// edgeFlags collects the edge flags given into a REST edge body (only those passed are sent).
func edgeFlags(in *mpInput) (map[string]any, error) {
	if err := checkEnum(in, "kind", false, "next", "call", "async", "read", "write", "response"); err != nil {
		return nil, err
	}
	edge := map[string]any{}
	for flag, key := range map[string]string{"kind": "kind", "protocol": "protocol", "condition": "condition", "auth": "auth",
		"data": "data", "description": "description", "comment": "comment"} {
		if in.has(flag) {
			edge[key] = in.str(flag)
		}
	}
	for flag, key := range map[string]string{"trust-boundary": "trustBoundary", "tainted": "tainted"} {
		if in.has(flag) {
			switch strings.ToLower(in.str(flag)) {
			case "true", "yes", "1", "":
				edge[key] = true
			case "false", "no", "0":
				edge[key] = false
			default:
				return nil, fmt.Errorf("--%s must be true or false, got %q", flag, in.str(flag))
			}
		}
	}
	if in.has("tags") {
		tags := in.list("tags")
		if tags == nil {
			tags = []string{}
		}
		edge["tags"] = tags
	}
	return edge, nil
}

// placeFlags adds the placement flags given to body.
func placeFlags(in *mpInput, body map[string]any) {
	for _, k := range []string{"after", "before", "from"} {
		if v := in.str(k); v != "" {
			body[k] = v
		}
	}
	if v := in.str("parent"); v != "" && body["from"] == nil {
		body["from"] = v
	}
	if in.flag("entry") {
		body["entry"] = true
	}
}

func flowAddStep(c *cli, in *mpInput) error {
	project := in.str("project")
	if project == "" {
		project = c.project
	}
	if project == "" {
		return errors.New("--project is required (or set the global --project / BENCH_PROJECT)")
	}
	body := map[string]any{
		"projectSlug": project,
		"featureId":   in.str("feature"),
	}
	for _, k := range []string{"note", "actor"} {
		if in.has(k) {
			body[k] = in.str(k)
		}
	}
	if in.has("controls") {
		body["controls"] = in.list("controls")
	}
	placeFlags(in, body)
	edge, err := edgeFlags(in)
	if err != nil {
		return err
	}
	if len(edge) > 0 {
		body["edge"] = edge
	}
	data, status, err := c.req("POST", flowPath(in.str("flow"), "steps"), body)
	if err != nil {
		return err
	}
	fmt.Fprintln(c.stdout, formatOutput(data, status))
	// The server keeps a step whose feature can't be resolved (it may come
	// back, e.g. a project re-registered) but marks it tombstoned. Say so: a
	// mistyped feature ID or project slug otherwise looks like success.
	var step struct {
		Tombstoned bool   `json:"tombstoned"`
		Reason     string `json:"tombstonedReason"`
	}
	if json.Unmarshal(data, &step) == nil && step.Tombstoned {
		switch step.Reason {
		case "project_not_registered":
			fmt.Fprintf(c.stderr, "Warning: step added, but project %q is not registered (see 'bench projects list'); the step is tombstoned.\n", project)
		default:
			fmt.Fprintf(c.stderr, "Warning: step added, but feature %q was not found on project %q (see 'bench catalog search'); the step is tombstoned.\n", in.str("feature"), project)
		}
	}
	return nil
}

func flowUpdateStep(c *cli, in *mpInput) error {
	obj := map[string]any{}
	for flag, key := range map[string]string{"note": "note", "actor": "actor", "feature": "featureId", "project": "projectSlug", "condition": "branchCondition"} {
		if in.has(flag) {
			obj[key] = in.str(flag)
		}
	}
	if in.has("controls") {
		controls := in.list("controls")
		if controls == nil {
			controls = []string{}
		}
		obj["controls"] = controls
	}
	if len(obj) == 0 {
		return errors.New("nothing to update: pass --note, --actor, --controls, --feature, --project and/or --condition")
	}
	return c.emit("PATCH", flowPath(in.str("flow"), "steps", in.str("step")), obj)
}

func flowMoveStep(c *cli, in *mpInput) error {
	body := map[string]any{}
	placeFlags(in, body)
	edge, err := edgeFlags(in)
	if err != nil {
		return err
	}
	q := url.Values{}
	switch d := strings.ToLower(in.str("direction")); {
	case d == "up":
		q.Set("dir", "-1")
	case d == "down":
		q.Set("dir", "1")
	case d != "":
		return fmt.Errorf("direction must be 'up' or 'down', got %q", in.str("direction"))
	}
	if len(q) > 0 && len(body) > 0 {
		return errors.New("give a direction or a place (--after, --before, --from, --entry), not both")
	}
	if len(q) == 0 && len(body) == 0 {
		return errors.New("give a direction (up|down) or a place: --after, --before, --from or --entry")
	}
	if len(edge) > 0 {
		body["edge"] = edge
	}
	var payload any
	if len(body) > 0 {
		payload = body
	}
	return c.emit("POST", withQuery(flowPath(in.str("flow"), "steps", in.str("step"), "move"), q), payload)
}

func flowSetSteps(c *cli, in *mpInput) error {
	raw, err := c.readInput(in.str("input"))
	if err != nil {
		return err
	}
	if !json.Valid(raw) {
		return errors.New("input is not valid JSON (expected {\"steps\": [...], \"edges\": [...]})")
	}
	return c.emit("PUT", flowPath(in.str("flow"), "steps"), raw)
}

func flowImport(c *cli, in *mpInput) error {
	raw, err := c.readInput(in.str("input"))
	if err != nil {
		return err
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return errors.New("input is not a JSON object (expected the 'flows export' shape)")
	}
	if v := in.str("name"); v != "" {
		doc["name"] = v
	}
	if f := in.str("folder"); f != "" {
		id, err := c.resolveFolderRef(f)
		if err != nil {
			return err
		}
		doc["folderId"] = id
	}
	return c.emit("POST", "/api/flows", doc)
}

func flowSetEdge(c *cli, in *mpInput) error {
	// Only the flags given are sent: on an existing edge the server keeps the
	// fields left out (pass "" to clear one).
	edge, err := edgeFlags(in)
	if err != nil {
		return err
	}
	if in.has("position") {
		n, err := strconv.Atoi(in.str("position"))
		if err != nil {
			return fmt.Errorf("--position must be a number, got %q", in.str("position"))
		}
		edge["position"] = n
	}
	return c.emit("PUT", flowPath(in.str("flow"), "edges", in.str("from"), in.str("to")), edge)
}

func flowViewUpdate(c *cli, in *mpInput) error {
	if in.flag("shared") && in.flag("private") {
		return errors.New("--shared and --private are mutually exclusive")
	}
	obj := map[string]any{}
	if v := in.str("name"); v != "" {
		obj["name"] = v
	}
	if in.has("query") {
		obj["query"] = in.str("query")
	}
	if in.flag("shared") {
		obj["isShared"] = true
	}
	if in.flag("private") {
		obj["isShared"] = false
	}
	if len(obj) == 0 {
		return errors.New("nothing to update: pass at least one of --name, --query, --shared, --private")
	}
	return c.emit("PATCH", "/api/flow-views/"+url.PathEscape(in.str("id")), obj)
}

func flowBaselineDelete(c *cli, in *mpInput) error {
	path := flowPath(in.str("flow"), "baselines", in.str("id"))
	if in.flag("confirm") {
		return c.emit("DELETE", path+"?confirm=true", nil)
	}
	// Without confirm the server only previews; render that in CLI terms (its
	// own message points at the ?confirm=true query parameter).
	data, status, err := c.req("DELETE", path, nil)
	if err != nil {
		return err
	}
	var preview struct {
		DryRun   bool `json:"dryRun"`
		Baseline struct {
			ID        string `json:"id"`
			Seq       int    `json:"seq"`
			Reviewer  string `json:"reviewer"`
			Summary   string `json:"summary"`
			CreatedAt string `json:"createdAt"`
		} `json:"baseline"`
	}
	if json.Unmarshal(data, &preview) != nil || !preview.DryRun {
		fmt.Fprintln(c.stdout, formatOutput(data, status))
		return nil
	}
	b := preview.Baseline
	fmt.Fprintf(c.stdout, "Dry run - flow baseline #%d (id: %s, %s", b.Seq, b.ID, b.CreatedAt)
	if b.Reviewer != "" {
		fmt.Fprintf(c.stdout, " by %s", b.Reviewer)
	}
	fmt.Fprintln(c.stdout, ") would be deleted.")
	if b.Summary != "" {
		fmt.Fprintf(c.stdout, "Summary: %s\n", b.Summary)
	}
	fmt.Fprintln(c.stdout, "\nPass --confirm to delete.")
	return nil
}
