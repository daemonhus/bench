package server

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
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

type baselineSnapshot struct {
	Flow  baselineSnapshotFlow   `json:"flow"`
	Steps []baselineSnapshotStep `json:"steps"`
	Links []baselineSnapshotLink `json:"links"`
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
	ID              string           `json:"id"`
	ParentStepID    string           `json:"parentStepId,omitempty"`
	Position        int              `json:"position"`
	BranchCondition string           `json:"branchCondition"`
	ProjectSlug     string           `json:"projectSlug"`
	FeatureID       string           `json:"featureId"`
	Note            string           `json:"note"`
	Tombstoned      bool             `json:"tombstoned"`
	Feature         *FeatureSnapshot `json:"feature,omitempty"`
}

type baselineSnapshotLink struct {
	FromStepID  string `json:"fromStepId"`
	ToStepID    string `json:"toStepId"`
	Description string `json:"description"`
}

type FlowDeltaStep struct {
	StepID  string   `json:"stepId"`
	Changes []string `json:"changes"`
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
}

// ── Snapshot builder ──────────────────────────────────────────────────────────

// buildFlowSnapshot assembles the self-contained baseline snapshot for a flow.
func (p *Platform) buildFlowSnapshot(flowID string) (baselineSnapshot, error) {
	row := p.db.QueryRow(
		`SELECT id, name, description, status, owner, tags, COALESCE(folder_id,''), created_at, updated_at FROM flows WHERE id = ?`, flowID)
	f, err := scanFlow(row)
	if err != nil {
		return baselineSnapshot{}, err
	}

	steps, err := p.loadFlowSteps(flowID)
	if err != nil {
		return baselineSnapshot{}, err
	}

	// Enrich steps with feature snapshots in parallel (same as getFlow).
	type result struct {
		idx  int
		snap *FeatureSnapshot
		err  error
	}
	ch := make(chan result, len(steps))
	for i, s := range steps {
		go func(idx int, slug, featureID string) {
			snap, err := p.fetchFeatureSnapshot(slug, featureID)
			ch <- result{idx, snap, err}
		}(i, s.ProjectSlug, s.FeatureID)
	}
	for range steps {
		res := <-ch
		if res.err == nil {
			steps[res.idx].Feature = res.snap
			if res.snap.Confidence == "orphaned" {
				steps[res.idx].Tombstoned = true
			}
		} else {
			steps[res.idx].Tombstoned = true
		}
	}

	ssSteps := make([]baselineSnapshotStep, len(steps))
	for i, s := range steps {
		ssSteps[i] = baselineSnapshotStep{
			ID:              s.ID,
			ParentStepID:    s.ParentStepID,
			Position:        s.Position,
			BranchCondition: s.BranchCondition,
			ProjectSlug:     s.ProjectSlug,
			FeatureID:       s.FeatureID,
			Note:            s.Note,
			Tombstoned:      s.Tombstoned,
			Feature:         s.Feature,
		}
	}

	links, err := p.loadFlowLinks(flowID)
	if err != nil {
		return baselineSnapshot{}, err
	}
	ssLinks := make([]baselineSnapshotLink, len(links))
	for i, l := range links {
		ssLinks[i] = baselineSnapshotLink{
			FromStepID:  l.FromStepID,
			ToStepID:    l.ToStepID,
			Description: l.Description,
		}
	}

	if f.Tags == nil {
		f.Tags = []string{}
	}
	return baselineSnapshot{
		Flow: baselineSnapshotFlow{
			ID:          f.ID,
			Name:        f.Name,
			Description: f.Description,
			Status:      f.Status,
			Owner:       f.Owner,
			Tags:        f.Tags,
		},
		Steps: ssSteps,
		Links: ssLinks,
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

	// Get current flow steps (live).
	currentSteps, err := p.loadFlowSteps(flowID)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	// Enrich current steps with feature snapshots.
	type enrichResult struct {
		idx  int
		snap *FeatureSnapshot
		err  error
	}
	ch := make(chan enrichResult, len(currentSteps))
	for i, s := range currentSteps {
		go func(idx int, slug, featureID string) {
			snap, err := p.fetchFeatureSnapshot(slug, featureID)
			ch <- enrichResult{idx, snap, err}
		}(i, s.ProjectSlug, s.FeatureID)
	}
	for range currentSteps {
		res := <-ch
		if res.err == nil {
			currentSteps[res.idx].Feature = res.snap
		}
	}

	delta := computeFlowDelta(b.Snapshot, currentSteps)
	delta.Since = FlowBaselineMeta{ID: b.ID, Seq: b.Seq, CreatedAt: b.CreatedAt}
	writeJSON(w, delta)
}

// computeFlowDelta diffs snapshot steps vs current steps.
func computeFlowDelta(snap baselineSnapshot, current []FlowStep) FlowDelta {
	snapByID := make(map[string]baselineSnapshotStep, len(snap.Steps))
	for _, s := range snap.Steps {
		snapByID[s.ID] = s
	}
	curByID := make(map[string]*FlowStep, len(current))
	for i := range current {
		curByID[current[i].ID] = &current[i]
	}

	var added, removed []json.RawMessage
	var changed []FlowDeltaStep
	var moved []FlowDeltaAnchor

	for id, cur := range curByID {
		if _, ok := snapByID[id]; !ok {
			b, _ := json.Marshal(cur)
			added = append(added, b)
		}
	}
	for id, s := range snapByID {
		if _, ok := curByID[id]; !ok {
			b, _ := json.Marshal(s)
			removed = append(removed, b)
		}
	}
	for id, cur := range curByID {
		ss, ok := snapByID[id]
		if !ok {
			continue
		}
		var changes []string
		if cur.Note != ss.Note {
			changes = append(changes, "note")
		}
		if cur.BranchCondition != ss.BranchCondition {
			changes = append(changes, "branchCondition")
		}
		var curAnchorStr, snapAnchorStr string
		if cur.Feature != nil {
			curAnchorStr = string(cur.Feature.EffectiveAnchor)
		}
		if ss.Feature != nil {
			snapAnchorStr = string(ss.Feature.EffectiveAnchor)
		}
		if curAnchorStr != snapAnchorStr {
			changes = append(changes, "effectiveAnchor")
			conf := ""
			if cur.Feature != nil {
				conf = cur.Feature.Confidence
			}
			var fromRaw, toRaw json.RawMessage
			if snapAnchorStr != "" {
				fromRaw = json.RawMessage(snapAnchorStr)
			}
			if curAnchorStr != "" {
				toRaw = json.RawMessage(curAnchorStr)
			}
			moved = append(moved, FlowDeltaAnchor{
				StepID:     id,
				From:       fromRaw,
				To:         toRaw,
				Confidence: conf,
			})
		}
		if len(changes) > 0 {
			changed = append(changed, FlowDeltaStep{StepID: id, Changes: changes})
		}
	}

	if added == nil {
		added = []json.RawMessage{}
	}
	if removed == nil {
		removed = []json.RawMessage{}
	}
	if changed == nil {
		changed = []FlowDeltaStep{}
	}
	if moved == nil {
		moved = []FlowDeltaAnchor{}
	}
	return FlowDelta{
		AddedSteps:   added,
		RemovedSteps: removed,
		ChangedSteps: changed,
		MovedAnchors: moved,
	}
}
