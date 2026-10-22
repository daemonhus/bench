package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// A flow is a directed graph: steps (each a feature on some project) joined by typed edges.
// A step with no incoming edge is an entry point. Branches are several edges out of one step;
// joins and loops are just more edges, so there is no separate "link" concept.

// FlowEdge is one hop of a flow: from one step to the next.
type FlowEdge struct {
	FlowID     string `json:"flowId"`
	FromStepID string `json:"fromStepId"`
	ToStepID   string `json:"toStepId"`
	// Position orders the edges leaving one step (its branches), lowest first.
	Position int `json:"position"`
	// Kind is what the hop is: next (plain sequence), call (synchronous request), async
	// (message or event), read / write (a datastore), response (a reply back).
	Kind     string `json:"kind"`
	Protocol string `json:"protocol"`
	// Condition says when this path is taken (a branch label: "if user is admin").
	Condition string `json:"condition"`
	// Auth is the identity the hop carries: none, user, service, mtls, api-key, ...
	Auth          string `json:"auth"`
	TrustBoundary bool   `json:"trustBoundary"`
	// Data is what travels on the hop; Tainted marks it as attacker-controlled.
	Data        string   `json:"data"`
	Tainted     bool     `json:"tainted"`
	Description string   `json:"description"`
	Comment     string   `json:"comment"`
	Tags        []string `json:"tags"`
}

var validEdgeKinds = map[string]bool{"next": true, "call": true, "async": true, "read": true, "write": true, "response": true}

const edgeKindList = "next, call, async, read, write, response"

// edgeProps is a partial set of edge properties from a request: nil fields are left alone.
type edgeProps struct {
	Kind          *string   `json:"kind"`
	Protocol      *string   `json:"protocol"`
	Condition     *string   `json:"condition"`
	Auth          *string   `json:"auth"`
	TrustBoundary *bool     `json:"trustBoundary"`
	Data          *string   `json:"data"`
	Tainted       *bool     `json:"tainted"`
	Description   *string   `json:"description"`
	Comment       *string   `json:"comment"`
	Tags          *[]string `json:"tags"`
	Position      *int      `json:"position"`
}

func (p edgeProps) validate() error {
	if p.Kind != nil && *p.Kind != "" && !validEdgeKinds[*p.Kind] {
		return fmt.Errorf("edge kind must be one of: %s", edgeKindList)
	}
	return nil
}

// apply overlays the set fields onto e.
func (p edgeProps) apply(e *FlowEdge) {
	if p.Kind != nil {
		e.Kind = *p.Kind
	}
	if p.Protocol != nil {
		e.Protocol = *p.Protocol
	}
	if p.Condition != nil {
		e.Condition = *p.Condition
	}
	if p.Auth != nil {
		e.Auth = *p.Auth
	}
	if p.TrustBoundary != nil {
		e.TrustBoundary = *p.TrustBoundary
	}
	if p.Data != nil {
		e.Data = *p.Data
	}
	if p.Tainted != nil {
		e.Tainted = *p.Tainted
	}
	if p.Description != nil {
		e.Description = *p.Description
	}
	if p.Comment != nil {
		e.Comment = *p.Comment
	}
	if p.Tags != nil {
		e.Tags = *p.Tags
	}
	if p.Position != nil {
		e.Position = *p.Position
	}
	normalizeEdge(e)
}

func normalizeEdge(e *FlowEdge) {
	if e.Kind == "" {
		e.Kind = "next"
	}
	if e.Tags == nil {
		e.Tags = []string{}
	}
}

// ── schema + migration ───────────────────────────────────────────────────────

const flowStepsSchema = `CREATE TABLE IF NOT EXISTS %s (
	id                TEXT PRIMARY KEY,
	flow_id           TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
	position          INTEGER NOT NULL DEFAULT 0,
	project_slug      TEXT NOT NULL,
	feature_id        TEXT NOT NULL,
	note              TEXT NOT NULL DEFAULT '',
	actor             TEXT NOT NULL DEFAULT '',
	controls          TEXT NOT NULL DEFAULT '[]',
	subflow_id        TEXT NOT NULL DEFAULT '',
	tombstoned        INTEGER NOT NULL DEFAULT 0,
	tombstoned_reason TEXT NOT NULL DEFAULT '',
	created_at        TEXT NOT NULL DEFAULT (datetime('now'))
)`

const flowEdgesSchema = `CREATE TABLE IF NOT EXISTS flow_edges (
	flow_id        TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
	from_step_id   TEXT NOT NULL REFERENCES flow_steps(id) ON DELETE CASCADE,
	to_step_id     TEXT NOT NULL REFERENCES flow_steps(id) ON DELETE CASCADE,
	position       INTEGER NOT NULL DEFAULT 0,
	kind           TEXT NOT NULL DEFAULT 'next',
	protocol       TEXT NOT NULL DEFAULT '',
	condition      TEXT NOT NULL DEFAULT '',
	auth           TEXT NOT NULL DEFAULT '',
	trust_boundary INTEGER NOT NULL DEFAULT 0,
	data           TEXT NOT NULL DEFAULT '',
	tainted        INTEGER NOT NULL DEFAULT 0,
	description    TEXT NOT NULL DEFAULT '',
	comment        TEXT NOT NULL DEFAULT '',
	tags           TEXT NOT NULL DEFAULT '[]',
	PRIMARY KEY (from_step_id, to_step_id),
	CHECK (from_step_id <> to_step_id)
)`

// setUpFlowGraph creates flow_steps and flow_edges, first converting a database that still
// stores the tree form (parent_step_id + flow_step_links) into the graph form.
func setUpFlowGraph(conn *sql.DB, dataDir string) error {
	if _, err := conn.Exec(fmt.Sprintf(flowStepsSchema, "flow_steps")); err != nil {
		return err
	}
	if _, err := conn.Exec(`SELECT parent_step_id FROM flow_steps LIMIT 0`); err == nil {
		if err := migrateTreeToGraph(conn, dataDir); err != nil {
			return fmt.Errorf("migrate flows to graph: %w", err)
		}
	}
	// A step is a feature, or another flow slotted in whole (a subflow: subflow_id set, the
	// feature columns empty).
	if _, err := conn.Exec(`SELECT subflow_id FROM flow_steps LIMIT 0`); err != nil {
		if _, err := conn.Exec(`ALTER TABLE flow_steps ADD COLUMN subflow_id TEXT NOT NULL DEFAULT ''`); err != nil {
			return fmt.Errorf("add flow_steps.subflow_id: %w", err)
		}
	}
	for _, stmt := range []string{
		flowEdgesSchema,
		`CREATE INDEX IF NOT EXISTS flow_steps_flow_idx ON flow_steps(flow_id)`,
		`CREATE INDEX IF NOT EXISTS flow_steps_subflow_idx ON flow_steps(subflow_id) WHERE subflow_id <> ''`,
		`CREATE INDEX IF NOT EXISTS flow_edges_flow_idx ON flow_edges(flow_id)`,
		`CREATE INDEX IF NOT EXISTS flow_edges_to_idx ON flow_edges(to_step_id)`,
	} {
		if _, err := conn.Exec(stmt); err != nil {
			return err
		}
	}
	return nil
}

// legacyStep and legacyLink are the tree form's rows (also the shape of old baseline snapshots).
type legacyStep struct {
	ID              string
	ParentStepID    string
	Position        int
	BranchCondition string
}

type legacyLink struct {
	FromStepID, ToStepID, Description, Comment string
	Tags                                       []string
}

// legacyToGraph turns a tree (parent + position + branch condition) plus links into the step
// order and edges of the graph form:
//   - parent -> child becomes an edge carrying the child's branch condition, in child order;
//   - a link becomes an edge, or labels the tree edge it duplicates;
//   - a flow whose steps are all roots (built by appending) becomes one path in root order,
//     which is how the map drew it.
//
// The returned order is depth-first from the roots, which is how the flow read.
func legacyToGraph(flowID string, steps []legacyStep, links []legacyLink) (order []string, edges []FlowEdge) {
	known := make(map[string]bool, len(steps))
	for _, s := range steps {
		known[s.ID] = true
	}
	children := map[string][]legacyStep{}
	var roots []legacyStep
	for _, s := range steps {
		if s.ParentStepID != "" && known[s.ParentStepID] {
			children[s.ParentStepID] = append(children[s.ParentStepID], s)
		} else {
			roots = append(roots, s)
		}
	}
	byPos := func(list []legacyStep) {
		sort.SliceStable(list, func(i, j int) bool { return list[i].Position < list[j].Position })
	}
	byPos(roots)
	for k := range children {
		byPos(children[k])
	}

	seen := map[string]bool{}
	var walk func(id string)
	walk = func(id string) {
		if seen[id] {
			return
		}
		seen[id] = true
		order = append(order, id)
		for i, c := range children[id] {
			edges = append(edges, FlowEdge{FlowID: flowID, FromStepID: id, ToStepID: c.ID, Position: i, Kind: "next", Condition: c.BranchCondition, Tags: []string{}})
			walk(c.ID)
		}
	}
	for _, r := range roots {
		walk(r.ID)
	}
	// Steps in a parent cycle (unreachable from any root) still keep their place.
	for _, s := range steps {
		walk(s.ID)
	}
	if len(roots) == len(steps) {
		for i := 1; i < len(roots); i++ {
			edges = append(edges, FlowEdge{FlowID: flowID, FromStepID: roots[i-1].ID, ToStepID: roots[i].ID, Kind: "next", Tags: []string{}})
		}
	}

	at := map[[2]string]int{}
	for i, e := range edges {
		at[[2]string{e.FromStepID, e.ToStepID}] = i
	}
	next := map[string]int{}
	for _, e := range edges {
		if e.Position >= next[e.FromStepID] {
			next[e.FromStepID] = e.Position + 1
		}
	}
	for _, l := range links {
		if !known[l.FromStepID] || !known[l.ToStepID] || l.FromStepID == l.ToStepID {
			continue
		}
		tags := l.Tags
		if tags == nil {
			tags = []string{}
		}
		key := [2]string{l.FromStepID, l.ToStepID}
		if i, ok := at[key]; ok {
			edges[i].Description, edges[i].Comment, edges[i].Tags = l.Description, l.Comment, tags
			continue
		}
		at[key] = len(edges)
		edges = append(edges, FlowEdge{FlowID: flowID, FromStepID: l.FromStepID, ToStepID: l.ToStepID, Position: next[l.FromStepID],
			Kind: "next", Description: l.Description, Comment: l.Comment, Tags: tags})
		next[l.FromStepID]++
	}
	return order, edges
}

func migrateTreeToGraph(conn *sql.DB, dataDir string) error {
	// A copy of the database as it was, in case anything about the conversion needs undoing.
	backup := filepath.Join(dataDir, "platform.db.pre-flow-graph.bak")
	if dataDir != "" {
		if _, err := os.Stat(backup); os.IsNotExist(err) {
			if _, err := conn.Exec(`VACUUM INTO ?`, backup); err != nil {
				return fmt.Errorf("backup: %w", err)
			}
		}
	}

	type oldStep struct {
		legacyStep
		flowID, slug, feature, note, reason, created string
		tomb                                         int
	}
	hasReason := true
	if _, err := conn.Exec(`SELECT tombstoned_reason FROM flow_steps LIMIT 0`); err != nil {
		hasReason = false
	}
	reasonCol := "''"
	if hasReason {
		reasonCol = "COALESCE(tombstoned_reason,'')"
	}
	rows, err := conn.Query(`SELECT id, flow_id, COALESCE(parent_step_id,''), position, branch_condition, project_slug, feature_id, note, tombstoned, ` + reasonCol + `, created_at FROM flow_steps ORDER BY flow_id, position, rowid`)
	if err != nil {
		return err
	}
	byFlow := map[string][]oldStep{}
	var flowOrder []string
	for rows.Next() {
		var s oldStep
		if err := rows.Scan(&s.ID, &s.flowID, &s.ParentStepID, &s.Position, &s.BranchCondition, &s.slug, &s.feature, &s.note, &s.tomb, &s.reason, &s.created); err != nil {
			rows.Close()
			return err
		}
		if _, ok := byFlow[s.flowID]; !ok {
			flowOrder = append(flowOrder, s.flowID)
		}
		byFlow[s.flowID] = append(byFlow[s.flowID], s)
	}
	rows.Close()

	linksByFlow := map[string][]legacyLink{}
	if _, err := conn.Exec(`SELECT 1 FROM flow_step_links LIMIT 0`); err == nil {
		commentCol, tagsCol := "''", "'[]'"
		if _, err := conn.Exec(`SELECT comment FROM flow_step_links LIMIT 0`); err == nil {
			commentCol = "comment"
		}
		if _, err := conn.Exec(`SELECT tags FROM flow_step_links LIMIT 0`); err == nil {
			tagsCol = "tags"
		}
		lrows, err := conn.Query(`SELECT flow_id, from_step_id, to_step_id, description, ` + commentCol + `, ` + tagsCol + ` FROM flow_step_links ORDER BY rowid`)
		if err != nil {
			return err
		}
		for lrows.Next() {
			var fid, tagsJSON string
			var l legacyLink
			if err := lrows.Scan(&fid, &l.FromStepID, &l.ToStepID, &l.Description, &l.Comment, &tagsJSON); err != nil {
				lrows.Close()
				return err
			}
			json.Unmarshal([]byte(tagsJSON), &l.Tags)
			linksByFlow[fid] = append(linksByFlow[fid], l)
		}
		lrows.Close()
	}

	// Rebuilding flow_steps needs foreign keys off (dropping the old table would otherwise
	// cascade), and that pragma only takes effect outside a transaction, on one connection.
	ctx := context.Background()
	c, err := conn.Conn(ctx)
	if err != nil {
		return err
	}
	defer c.Close()
	if _, err := c.ExecContext(ctx, `PRAGMA foreign_keys=OFF`); err != nil {
		return err
	}
	defer c.ExecContext(ctx, `PRAGMA foreign_keys=ON`)

	tx, err := c.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(fmt.Sprintf(flowStepsSchema, "flow_steps_graph")); err != nil {
		return err
	}
	var allEdges []FlowEdge
	steps, edgesN := 0, 0
	for _, fid := range flowOrder {
		list := byFlow[fid]
		legacy := make([]legacyStep, len(list))
		info := make(map[string]oldStep, len(list))
		for i, s := range list {
			legacy[i] = s.legacyStep
			info[s.ID] = s
		}
		order, edges := legacyToGraph(fid, legacy, linksByFlow[fid])
		for pos, id := range order {
			s := info[id]
			if _, err := tx.Exec(`INSERT INTO flow_steps_graph (id, flow_id, position, project_slug, feature_id, note, tombstoned, tombstoned_reason, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
				s.ID, fid, pos, s.slug, s.feature, s.note, s.tomb, s.reason, s.created); err != nil {
				return err
			}
			steps++
		}
		allEdges = append(allEdges, edges...)
		edgesN += len(edges)
	}
	for _, stmt := range []string{
		`DROP TABLE IF EXISTS flow_step_links`,
		`DROP TABLE flow_steps`,
		`ALTER TABLE flow_steps_graph RENAME TO flow_steps`,
		flowEdgesSchema,
	} {
		if _, err := tx.Exec(stmt); err != nil {
			return err
		}
	}
	for _, e := range allEdges {
		if err := insertEdge(tx, e); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	log.Printf("flows: converted %d flows (%d steps, %d edges) to the graph form; backup at %s", len(flowOrder), steps, edgesN, backup)
	return nil
}

// ── loading ───────────────────────────────────────────────────────────────────

type querier interface {
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
	Exec(query string, args ...any) (sql.Result, error)
}

const edgeCols = `flow_id, from_step_id, to_step_id, position, kind, protocol, condition, auth, trust_boundary, data, tainted, description, comment, tags`

func scanEdge(sc interface{ Scan(...any) error }) (FlowEdge, error) {
	var e FlowEdge
	var tb, tainted int
	var tags string
	if err := sc.Scan(&e.FlowID, &e.FromStepID, &e.ToStepID, &e.Position, &e.Kind, &e.Protocol, &e.Condition, &e.Auth, &tb, &e.Data, &tainted, &e.Description, &e.Comment, &tags); err != nil {
		return e, err
	}
	e.TrustBoundary, e.Tainted = tb != 0, tainted != 0
	json.Unmarshal([]byte(tags), &e.Tags)
	normalizeEdge(&e)
	return e, nil
}

func loadFlowEdges(q querier, flowID string) ([]FlowEdge, error) {
	rows, err := q.Query(`SELECT `+edgeCols+` FROM flow_edges WHERE flow_id = ? ORDER BY from_step_id, position, rowid`, flowID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	edges := []FlowEdge{}
	for rows.Next() {
		e, err := scanEdge(rows)
		if err != nil {
			return nil, err
		}
		edges = append(edges, e)
	}
	return edges, rows.Err()
}

func insertEdge(q querier, e FlowEdge) error {
	normalizeEdge(&e)
	tags, _ := json.Marshal(e.Tags)
	_, err := q.Exec(`INSERT INTO flow_edges (`+edgeCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		e.FlowID, e.FromStepID, e.ToStepID, e.Position, e.Kind, e.Protocol, e.Condition, e.Auth, b2i(e.TrustBoundary), e.Data, b2i(e.Tainted), e.Description, e.Comment, string(tags))
	return err
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// graph is a flow's structure, loaded for an edit.
type graph struct {
	steps []string // in step order (position)
	edges []FlowEdge
}

func loadGraph(q querier, flowID string) (*graph, error) {
	rows, err := q.Query(`SELECT id FROM flow_steps WHERE flow_id = ? ORDER BY position, rowid`, flowID)
	if err != nil {
		return nil, err
	}
	g := &graph{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		g.steps = append(g.steps, id)
	}
	rows.Close()
	if g.edges, err = loadFlowEdges(q, flowID); err != nil {
		return nil, err
	}
	return g, nil
}

func (g *graph) has(id string) bool {
	for _, s := range g.steps {
		if s == id {
			return true
		}
	}
	return false
}

// out lists the edges leaving id, in branch order.
func (g *graph) out(id string) []FlowEdge {
	var list []FlowEdge
	for _, e := range g.edges {
		if e.FromStepID == id {
			list = append(list, e)
		}
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].Position < list[j].Position })
	return list
}

func (g *graph) in(id string) []FlowEdge {
	var list []FlowEdge
	for _, e := range g.edges {
		if e.ToStepID == id {
			list = append(list, e)
		}
	}
	return list
}

func (g *graph) edge(from, to string) (FlowEdge, bool) {
	for _, e := range g.edges {
		if e.FromStepID == from && e.ToStepID == to {
			return e, true
		}
	}
	return FlowEdge{}, false
}

// entries are the steps nothing leads into, in step order.
func (g *graph) entries() []string {
	var list []string
	for _, s := range g.steps {
		if len(g.in(s)) == 0 {
			list = append(list, s)
		}
	}
	return list
}

// pathEnd is where an appended step goes: follow the first edge out of the first entry
// until a step with no way on (or a step already visited, on a loop). exclude (the step
// being placed) is never the answer.
func (g *graph) pathEnd(exclude string) string {
	cur := ""
	for _, e := range append(g.entries(), g.steps...) {
		if e != exclude {
			cur = e
			break
		}
	}
	if cur == "" {
		return ""
	}
	seen := map[string]bool{cur: true}
	for {
		out := g.out(cur)
		if len(out) == 0 || seen[out[0].ToStepID] || out[0].ToStepID == exclude {
			return cur
		}
		cur = out[0].ToStepID
		seen[cur] = true
	}
}

// reachable lists the steps reachable from starts, not passing through any of skip.
func (g *graph) reachable(starts []string, skip map[string]bool) map[string]bool {
	seen := map[string]bool{}
	stack := append([]string{}, starts...)
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[id] || skip[id] {
			continue
		}
		seen[id] = true
		for _, e := range g.out(id) {
			stack = append(stack, e.ToStepID)
		}
	}
	return seen
}

// ── edits (all run inside a transaction under flowMu) ─────────────────────────

// placement is where a new or moved step goes. At most one is set; none means
// "append to the end of the main path".
type placement struct {
	After  string `json:"after"`
	Before string `json:"before"`
	From   string `json:"from"`
	Entry  bool   `json:"entry"`
}

func (pl placement) count() int {
	n := 0
	for _, s := range []string{pl.After, pl.Before, pl.From} {
		if s != "" {
			n++
		}
	}
	if pl.Entry {
		n++
	}
	return n
}

func (pl placement) target() string {
	switch {
	case pl.After != "":
		return pl.After
	case pl.Before != "":
		return pl.Before
	}
	return pl.From
}

type editError struct {
	status int
	msg    string
}

func (e *editError) Error() string { return e.msg }

func badRequest(format string, args ...any) error {
	return &editError{400, fmt.Sprintf(format, args...)}
}

// attach wires step id into g per pl, with props on the edge that leads into it.
func attach(tx querier, g *graph, flowID, id string, pl placement, props edgeProps) error {
	if pl.count() > 1 {
		return badRequest("give at most one of after, before, from (parentStepId) and entry")
	}
	if t := pl.target(); t != "" {
		if t == id {
			return badRequest("a step cannot be placed relative to itself")
		}
		if !g.has(t) {
			return badRequest("step %q is not in this flow", t)
		}
	}
	newEdge := func(from, to string, pos int) FlowEdge {
		e := FlowEdge{FlowID: flowID, FromStepID: from, ToStepID: to, Position: pos}
		props.apply(&e)
		if props.Position == nil {
			e.Position = pos
		}
		return e
	}
	switch {
	case pl.Entry:
		return nil
	case pl.After != "":
		// The new step takes over everything that left `after`.
		for _, e := range g.out(pl.After) {
			if err := rewire(tx, e, id, e.ToStepID); err != nil {
				return err
			}
		}
		return insertEdge(tx, newEdge(pl.After, id, 0))
	case pl.Before != "":
		// Everything that led into `before` now leads into the new step.
		for _, e := range g.in(pl.Before) {
			if err := rewire(tx, e, e.FromStepID, id); err != nil {
				return err
			}
		}
		e := FlowEdge{FlowID: flowID, FromStepID: id, ToStepID: pl.Before}
		props.apply(&e)
		return insertEdge(tx, e)
	case pl.From != "":
		pos := 0
		for _, e := range g.out(pl.From) {
			if e.Position >= pos {
				pos = e.Position + 1
			}
		}
		return insertEdge(tx, newEdge(pl.From, id, pos))
	default:
		end := g.pathEnd(id)
		if end == "" {
			return nil
		}
		return insertEdge(tx, newEdge(end, id, 0))
	}
}

// rewire moves edge e to run from -> to, keeping its properties.
func rewire(tx querier, e FlowEdge, from, to string) error {
	if _, err := tx.Exec(`DELETE FROM flow_edges WHERE from_step_id=? AND to_step_id=?`, e.FromStepID, e.ToStepID); err != nil {
		return err
	}
	if from == to {
		return nil
	}
	var dup int
	tx.QueryRow(`SELECT 1 FROM flow_edges WHERE from_step_id=? AND to_step_id=?`, from, to).Scan(&dup)
	if dup == 1 {
		return nil
	}
	e.FromStepID, e.ToStepID = from, to
	return insertEdge(tx, e)
}

// detach removes step id's edges and bridges the gap: every step that led into it now leads
// on to every step it led to. The bridging edge keeps the hop's properties into the next step,
// and the incoming branch's condition (falling back to the outgoing one), in the incoming
// edge's branch slot.
func detach(tx querier, g *graph, id string) error {
	ins, outs := g.in(id), g.out(id)
	if _, err := tx.Exec(`DELETE FROM flow_edges WHERE from_step_id=? OR to_step_id=?`, id, id); err != nil {
		return err
	}
	for _, in := range ins {
		if in.FromStepID == id {
			continue
		}
		// Rebuild in.From's branch order with the bridged edges in place of in.
		siblings := g.out(in.FromStepID)
		var bridged []FlowEdge
		for _, out := range outs {
			if out.ToStepID == id || out.ToStepID == in.FromStepID {
				continue
			}
			if _, exists := g.edge(in.FromStepID, out.ToStepID); exists {
				continue
			}
			e := out
			e.FromStepID = in.FromStepID
			if in.Condition != "" {
				e.Condition = in.Condition
			}
			bridged = append(bridged, e)
		}
		pos := 0
		for _, s := range siblings {
			if s.ToStepID == id {
				for _, b := range bridged {
					b.Position = pos
					if err := insertEdge(tx, b); err != nil {
						return err
					}
					pos++
				}
				continue
			}
			if _, err := tx.Exec(`UPDATE flow_edges SET position=? WHERE from_step_id=? AND to_step_id=?`, pos, s.FromStepID, s.ToStepID); err != nil {
				return err
			}
			pos++
		}
	}
	return nil
}

func touchFlow(q querier, flowID string) {
	q.Exec(`UPDATE flows SET updated_at=datetime('now') WHERE id=?`, flowID)
}

// inFlowTx runs fn in a transaction, one flow edit at a time.
func (p *Platform) inFlowTx(flowID string, fn func(tx *sql.Tx, g *graph) error) error {
	p.flowMu.Lock()
	defer p.flowMu.Unlock()
	var exists int
	p.db.QueryRow(`SELECT 1 FROM flows WHERE id = ?`, flowID).Scan(&exists)
	if exists == 0 {
		return &editError{404, "flow not found"}
	}
	tx, err := p.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	g, err := loadGraph(tx, flowID)
	if err != nil {
		return err
	}
	if err := fn(tx, g); err != nil {
		return err
	}
	touchFlow(tx, flowID)
	return tx.Commit()
}

func writeEditError(w http.ResponseWriter, err error) {
	var ee *editError
	if errors.As(err, &ee) {
		http.Error(w, ee.msg, ee.status)
		return
	}
	http.Error(w, err.Error(), 500)
}

// checkSubflow says whether flow subflowID can be slotted into flowID as a step: it must exist,
// and must not be flowID or contain it (through its own subflows, at any depth), which would
// make the flow contain itself.
func checkSubflow(q querier, flowID, subflowID string) error {
	var name string
	if err := q.QueryRow(`SELECT name FROM flows WHERE id = ?`, subflowID).Scan(&name); err != nil {
		return badRequest("subflow %q: no such flow", subflowID)
	}
	seen := map[string]bool{}
	stack := []string{subflowID}
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if id == flowID {
			if id == subflowID {
				return badRequest("a flow cannot be a subflow of itself")
			}
			return badRequest("%q already contains this flow (through its own subflows), so using it here would loop", name)
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		rows, err := q.Query(`SELECT DISTINCT subflow_id FROM flow_steps WHERE flow_id = ? AND subflow_id <> ''`, id)
		if err != nil {
			return err
		}
		for rows.Next() {
			var s string
			rows.Scan(&s)
			stack = append(stack, s)
		}
		rows.Close()
	}
	return nil
}

// stepTarget is what a step stands for: a feature (project + id), or a whole other flow.
type stepTarget struct {
	ProjectSlug string
	FeatureID   string
	SubflowID   string
}

func (t stepTarget) validate() error {
	feature := t.ProjectSlug != "" || t.FeatureID != ""
	switch {
	case feature && t.SubflowID != "":
		return badRequest("a step is a feature (projectSlug + featureId) or a subflow (subflowId), not both")
	case t.SubflowID != "":
		return nil
	case t.ProjectSlug == "" || t.FeatureID == "":
		return badRequest("projectSlug and featureId are required (or subflowId, for a subflow step)")
	}
	return nil
}

func trimmedControls(list []string) []string {
	out := []string{}
	for _, c := range list {
		if c = strings.TrimSpace(c); c != "" {
			out = append(out, c)
		}
	}
	return out
}
