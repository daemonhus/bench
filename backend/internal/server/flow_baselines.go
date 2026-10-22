package server

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
)

// ── Types ──────────────────────────────────────────────────────────────────────

type FlowBaseline struct {
	ID        string           `json:"id"`
	FlowID    string           `json:"flowId"`
	Seq       int              `json:"seq"`
	Reviewer  string           `json:"reviewer"`
	Summary   string           `json:"summary"`
	CreatedAt string           `json:"createdAt"`
	Snapshot  baselineSnapshot `json:"snapshot"`
}

type FlowBaselineMeta struct {
	ID        string `json:"id"`
	Seq       int    `json:"seq"`
	CreatedAt string `json:"createdAt"`
}

// baselineSnapshot is a flow as it was. Version 2 stores the graph (steps + edges); older
// snapshots stored the tree (parentStepId, position, branchCondition) plus links, and are
// converted to the graph form when read (upgrade).
type baselineSnapshot struct {
	Version int                    `json:"version,omitempty"`
	Flow    baselineSnapshotFlow   `json:"flow"`
	Steps   []baselineSnapshotStep `json:"steps"`
	Edges   []FlowEdge             `json:"edges"`
	// Links is the tree-era form, read from old snapshots only.
	Links []baselineSnapshotLink `json:"links,omitempty"`
}

type baselineSnapshotFlow struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Status      string   `json:"status"`
	Owner       string   `json:"owner"`
	Tags        []string `json:"tags"`
}

type baselineSnapshotStep struct {
	ID          string           `json:"id"`
	Position    int              `json:"position"`
	ProjectSlug string           `json:"projectSlug"`
	FeatureID   string           `json:"featureId"`
	SubflowID   string           `json:"subflowId,omitempty"`
	Note        string           `json:"note"`
	Actor       string           `json:"actor"`
	Controls    []string         `json:"controls"`
	Tombstoned  bool             `json:"tombstoned"`
	Feature     *FeatureSnapshot `json:"feature,omitempty"`
	Subflow     *SubflowSnapshot `json:"subflow,omitempty"`
	// Tree-era fields, read from old snapshots only.
	ParentStepID    string `json:"parentStepId,omitempty"`
	BranchCondition string `json:"branchCondition,omitempty"`
}

type baselineSnapshotLink struct {
	FromStepID  string `json:"fromStepId"`
	ToStepID    string `json:"toStepId"`
	Description string `json:"description"`
}

const snapshotVersion = 2

// upgrade converts a tree-era snapshot to the graph form (as the database migration did).
func (s *baselineSnapshot) upgrade() {
	if s.Version >= snapshotVersion {
		if s.Edges == nil {
			s.Edges = []FlowEdge{}
		}
		return
	}
	legacy := make([]legacyStep, len(s.Steps))
	for i, st := range s.Steps {
		legacy[i] = legacyStep{ID: st.ID, ParentStepID: st.ParentStepID, Position: st.Position, BranchCondition: st.BranchCondition}
	}
	links := make([]legacyLink, len(s.Links))
	for i, l := range s.Links {
		links[i] = legacyLink{FromStepID: l.FromStepID, ToStepID: l.ToStepID, Description: l.Description}
	}
	order, edges := legacyToGraph(s.Flow.ID, legacy, links)
	pos := make(map[string]int, len(order))
	for i, id := range order {
		pos[id] = i
	}
	for i := range s.Steps {
		s.Steps[i].Position = pos[s.Steps[i].ID]
		s.Steps[i].ParentStepID, s.Steps[i].BranchCondition = "", ""
		if s.Steps[i].Controls == nil {
			s.Steps[i].Controls = []string{}
		}
	}
	sort.SliceStable(s.Steps, func(i, j int) bool { return s.Steps[i].Position < s.Steps[j].Position })
	if edges == nil {
		edges = []FlowEdge{}
	}
	s.Version, s.Edges, s.Links = snapshotVersion, edges, nil
}

type FlowDeltaStep struct {
	StepID  string   `json:"stepId"`
	Changes []string `json:"changes"`
}

type FlowDeltaEdge struct {
	FromStepID string   `json:"fromStepId"`
	ToStepID   string   `json:"toStepId"`
	Changes    []string `json:"changes"`
}

type FlowDeltaAnchor struct {
	StepID     string          `json:"stepId"`
	From       json.RawMessage `json:"from"`
	To         json.RawMessage `json:"to"`
	Confidence string          `json:"confidence"`
}

type FlowDelta struct {
	Since        FlowBaselineMeta  `json:"since"`
	AddedSteps   []json.RawMessage `json:"addedSteps"`
	RemovedSteps []json.RawMessage `json:"removedSteps"`
	ChangedSteps []FlowDeltaStep   `json:"changedSteps"`
	MovedAnchors []FlowDeltaAnchor `json:"movedAnchors"`
	AddedEdges   []FlowEdge        `json:"addedEdges"`
	RemovedEdges []FlowEdge        `json:"removedEdges"`
	ChangedEdges []FlowDeltaEdge   `json:"changedEdges"`
}

// ── Snapshot builder ──────────────────────────────────────────────────────────

// buildFlowSnapshot assembles the self-contained baseline snapshot for a flow.
func (p *Platform) buildFlowSnapshot(flowID string) (baselineSnapshot, error) {
	f, err := p.loadFullFlow(flowID)
	if err != nil {
		return baselineSnapshot{}, err
	}
	ssSteps := make([]baselineSnapshotStep, len(f.Steps))
	for i, s := range f.Steps {
		ssSteps[i] = baselineSnapshotStep{
			ID: s.ID, Position: s.Position, ProjectSlug: s.ProjectSlug, FeatureID: s.FeatureID, SubflowID: s.SubflowID,
			Note: s.Note, Actor: s.Actor, Controls: s.Controls, Tombstoned: s.Tombstoned, Feature: s.Feature, Subflow: s.Subflow,
		}
	}
	if f.Tags == nil {
		f.Tags = []string{}
	}
	return baselineSnapshot{
		Version: snapshotVersion,
		Flow:    baselineSnapshotFlow{ID: f.ID, Name: f.Name, Description: f.Description, Status: f.Status, Owner: f.Owner, Tags: f.Tags},
		Steps:   ssSteps,
		Edges:   f.Edges,
	}, nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func scanBaseline(row *sql.Row) (FlowBaseline, error) {
	var b FlowBaseline
	var snapshotJSON string
	if err := row.Scan(&b.ID, &b.FlowID, &b.Seq, &b.Reviewer, &b.Summary, &b.CreatedAt, &snapshotJSON); err != nil {
		return FlowBaseline{}, err
	}
	if err := json.Unmarshal([]byte(snapshotJSON), &b.Snapshot); err != nil {
		return FlowBaseline{}, fmt.Errorf("corrupt baseline snapshot %s: %w", b.ID, err)
	}
	b.Snapshot.upgrade()
	return b, nil
}

func scanBaselineRows(rows *sql.Rows) ([]FlowBaseline, error) {
	var out []FlowBaseline
	for rows.Next() {
		var b FlowBaseline
		var snapshotJSON string
		if err := rows.Scan(&b.ID, &b.FlowID, &b.Seq, &b.Reviewer, &b.Summary, &b.CreatedAt, &snapshotJSON); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(snapshotJSON), &b.Snapshot); err != nil {
			return nil, fmt.Errorf("corrupt baseline snapshot %s: %w", b.ID, err)
		}
		b.Snapshot.upgrade()
		out = append(out, b)
	}
	return out, rows.Err()
}

const baselineCols = `id, flow_id, seq, reviewer, summary, created_at, snapshot`

// ── Handlers ──────────────────────────────────────────────────────────────────

func (p *Platform) listFlowBaselines(w http.ResponseWriter, r *http.Request) {
	flowID := r.PathValue("id")
	rows, err := p.db.Query(
		`SELECT `+baselineCols+` FROM flow_baselines WHERE flow_id=? ORDER BY seq DESC`, flowID)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer rows.Close()
	list, err := scanBaselineRows(rows)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if list == nil {
		list = []FlowBaseline{}
	}
	writeJSON(w, list)
}

func (p *Platform) latestFlowBaseline(w http.ResponseWriter, r *http.Request) {
	flowID := r.PathValue("id")
	row := p.db.QueryRow(
		`SELECT `+baselineCols+` FROM flow_baselines WHERE flow_id=? ORDER BY seq DESC LIMIT 1`, flowID)
	b, err := scanBaseline(row)
	if err == sql.ErrNoRows {
		http.Error(w, "no baselines", 404)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, b)
}

func (p *Platform) getFlowBaseline(w http.ResponseWriter, r *http.Request) {
	flowID := r.PathValue("id")
	bID := r.PathValue("bId")
	row := p.db.QueryRow(
		`SELECT `+baselineCols+` FROM flow_baselines WHERE id=? AND flow_id=?`, bID, flowID)
	b, err := scanBaseline(row)
	if err == sql.ErrNoRows {
		http.Error(w, "baseline not found", 404)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, b)
}

func (p *Platform) createFlowBaseline(w http.ResponseWriter, r *http.Request) {
	flowID := r.PathValue("id")

	// Verify flow exists.
	var exists int
	if err := p.db.QueryRow(`SELECT 1 FROM flows WHERE id=?`, flowID).Scan(&exists); err != nil || exists == 0 {
		http.Error(w, "flow not found", 404)
		return
	}

	var req struct {
		Reviewer string `json:"reviewer"`
		Summary  string `json:"summary"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	snap, err := p.buildFlowSnapshot(flowID)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	snapJSON, err := json.Marshal(snap)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	// Auto-increment seq per flow.
	var seq int
	p.db.QueryRow(`SELECT COALESCE(MAX(seq),0)+1 FROM flow_baselines WHERE flow_id=?`, flowID).Scan(&seq)

	id := randomID()
	if _, err := p.db.Exec(
		`INSERT INTO flow_baselines (id, flow_id, seq, reviewer, summary, snapshot) VALUES (?,?,?,?,?,?)`,
		id, flowID, seq, req.Reviewer, req.Summary, string(snapJSON),
	); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	row := p.db.QueryRow(`SELECT `+baselineCols+` FROM flow_baselines WHERE id=?`, id)
	b, err := scanBaseline(row)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.WriteHeader(201)
	writeJSON(w, b)
}

func (p *Platform) deleteFlowBaseline(w http.ResponseWriter, r *http.Request) {
	flowID := r.PathValue("id")
	bID := r.PathValue("bId")
	confirm := r.URL.Query().Get("confirm") == "true"

	row := p.db.QueryRow(
		`SELECT `+baselineCols+` FROM flow_baselines WHERE id=? AND flow_id=?`, bID, flowID)
	b, err := scanBaseline(row)
	if err == sql.ErrNoRows {
		http.Error(w, "baseline not found", 404)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	if !confirm {
		writeJSON(w, map[string]any{
			"dryRun":  true,
			"message": "Pass ?confirm=true to delete this baseline.",
			"baseline": map[string]any{
				"id":        b.ID,
				"seq":       b.Seq,
				"reviewer":  b.Reviewer,
				"summary":   b.Summary,
				"createdAt": b.CreatedAt,
			},
		})
		return
	}

	if _, err := p.db.Exec(`DELETE FROM flow_baselines WHERE id=?`, bID); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.WriteHeader(204)
}

func (p *Platform) getFlowDelta(w http.ResponseWriter, r *http.Request) {
	flowID := r.PathValue("id")
	sinceID := r.URL.Query().Get("since")

	// Resolve baseline: explicit ID or latest.
	var b FlowBaseline
	var err error
	if sinceID != "" {
		row := p.db.QueryRow(
			`SELECT `+baselineCols+` FROM flow_baselines WHERE id=? AND flow_id=?`, sinceID, flowID)
		b, err = scanBaseline(row)
	} else {
		row := p.db.QueryRow(
			`SELECT `+baselineCols+` FROM flow_baselines WHERE flow_id=? ORDER BY seq DESC LIMIT 1`, flowID)
		b, err = scanBaseline(row)
	}
	if err == sql.ErrNoRows {
		http.Error(w, "no baseline found", 404)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	cur, err := p.loadFullFlow(flowID)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	delta := computeFlowDelta(b.Snapshot, cur.Steps, cur.Edges)
	delta.Since = FlowBaselineMeta{ID: b.ID, Seq: b.Seq, CreatedAt: b.CreatedAt}
	writeJSON(w, delta)
}

// computeFlowDelta diffs a snapshot against the flow's current steps and edges.
func computeFlowDelta(snap baselineSnapshot, current []FlowStep, currentEdges []FlowEdge) FlowDelta {
	snap.upgrade()
	snapByID := make(map[string]baselineSnapshotStep, len(snap.Steps))
	for _, s := range snap.Steps {
		snapByID[s.ID] = s
	}
	d := FlowDelta{AddedSteps: []json.RawMessage{}, RemovedSteps: []json.RawMessage{}, ChangedSteps: []FlowDeltaStep{},
		MovedAnchors: []FlowDeltaAnchor{}, AddedEdges: []FlowEdge{}, RemovedEdges: []FlowEdge{}, ChangedEdges: []FlowDeltaEdge{}}
	curIDs := make(map[string]bool, len(current))
	for i := range current {
		cur := &current[i]
		curIDs[cur.ID] = true
		ss, ok := snapByID[cur.ID]
		if !ok {
			b, _ := json.Marshal(cur)
			d.AddedSteps = append(d.AddedSteps, b)
			continue
		}
		var changes []string
		if cur.ProjectSlug != ss.ProjectSlug || cur.FeatureID != ss.FeatureID {
			changes = append(changes, "feature")
		}
		if cur.SubflowID != ss.SubflowID {
			changes = append(changes, "subflow")
		}
		if cur.Note != ss.Note {
			changes = append(changes, "note")
		}
		if cur.Actor != ss.Actor {
			changes = append(changes, "actor")
		}
		if strings.Join(cur.Controls, "\x00") != strings.Join(ss.Controls, "\x00") {
			changes = append(changes, "controls")
		}
		var curAnchor, snapAnchor string
		if cur.Feature != nil {
			curAnchor = string(cur.Feature.EffectiveAnchor)
		}
		if ss.Feature != nil {
			snapAnchor = string(ss.Feature.EffectiveAnchor)
		}
		if curAnchor != snapAnchor {
			changes = append(changes, "effectiveAnchor")
			a := FlowDeltaAnchor{StepID: cur.ID}
			if cur.Feature != nil {
				a.Confidence = cur.Feature.Confidence
			}
			if snapAnchor != "" {
				a.From = json.RawMessage(snapAnchor)
			}
			if curAnchor != "" {
				a.To = json.RawMessage(curAnchor)
			}
			d.MovedAnchors = append(d.MovedAnchors, a)
		}
		if len(changes) > 0 {
			d.ChangedSteps = append(d.ChangedSteps, FlowDeltaStep{StepID: cur.ID, Changes: changes})
		}
	}
	for _, s := range snap.Steps {
		if !curIDs[s.ID] {
			b, _ := json.Marshal(s)
			d.RemovedSteps = append(d.RemovedSteps, b)
		}
	}

	key := func(e FlowEdge) [2]string { return [2]string{e.FromStepID, e.ToStepID} }
	snapEdges := make(map[[2]string]FlowEdge, len(snap.Edges))
	for _, e := range snap.Edges {
		snapEdges[key(e)] = e
	}
	curEdges := make(map[[2]string]bool, len(currentEdges))
	for _, e := range currentEdges {
		curEdges[key(e)] = true
		old, ok := snapEdges[key(e)]
		if !ok {
			d.AddedEdges = append(d.AddedEdges, e)
			continue
		}
		if ch := edgeChanges(old, e); len(ch) > 0 {
			d.ChangedEdges = append(d.ChangedEdges, FlowDeltaEdge{FromStepID: e.FromStepID, ToStepID: e.ToStepID, Changes: ch})
		}
	}
	for _, e := range snap.Edges {
		if !curEdges[key(e)] {
			d.RemovedEdges = append(d.RemovedEdges, e)
		}
	}
	sortDelta(&d)
	return d
}

// edgeChanges names the fields that differ between two versions of an edge.
func edgeChanges(a, b FlowEdge) []string {
	normalizeEdge(&a)
	normalizeEdge(&b)
	var ch []string
	add := func(name string, differ bool) {
		if differ {
			ch = append(ch, name)
		}
	}
	add("position", a.Position != b.Position)
	add("kind", a.Kind != b.Kind)
	add("protocol", a.Protocol != b.Protocol)
	add("condition", a.Condition != b.Condition)
	add("auth", a.Auth != b.Auth)
	add("trustBoundary", a.TrustBoundary != b.TrustBoundary)
	add("data", a.Data != b.Data)
	add("tainted", a.Tainted != b.Tainted)
	add("description", a.Description != b.Description)
	add("comment", a.Comment != b.Comment)
	add("tags", strings.Join(a.Tags, "\x00") != strings.Join(b.Tags, "\x00"))
	return ch
}

// sortDelta orders each list deterministically (map iteration would not).
func sortDelta(d *FlowDelta) {
	sort.Slice(d.ChangedSteps, func(i, j int) bool { return d.ChangedSteps[i].StepID < d.ChangedSteps[j].StepID })
	sort.Slice(d.MovedAnchors, func(i, j int) bool { return d.MovedAnchors[i].StepID < d.MovedAnchors[j].StepID })
	byEnds := func(list []FlowEdge) {
		sort.Slice(list, func(i, j int) bool {
			if list[i].FromStepID != list[j].FromStepID {
				return list[i].FromStepID < list[j].FromStepID
			}
			return list[i].ToStepID < list[j].ToStepID
		})
	}
	byEnds(d.AddedEdges)
	byEnds(d.RemovedEdges)
	sort.Slice(d.ChangedEdges, func(i, j int) bool {
		if d.ChangedEdges[i].FromStepID != d.ChangedEdges[j].FromStepID {
			return d.ChangedEdges[i].FromStepID < d.ChangedEdges[j].FromStepID
		}
		return d.ChangedEdges[i].ToStepID < d.ChangedEdges[j].ToStepID
	})
}
