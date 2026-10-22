package server

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
)

// ── step input ────────────────────────────────────────────────────────────────

// addStepRequest is the body of POST /api/flows/{id}/steps.
type addStepRequest struct {
	ProjectSlug string `json:"projectSlug"`
	FeatureID   string `json:"featureId"`
	// SubflowID adds another flow as one step (a subflow), in place of a feature.
	SubflowID string   `json:"subflowId"`
	Note      string   `json:"note"`
	Actor     string   `json:"actor"`
	Controls  []string `json:"controls"`
	placement
	// ParentStepID is the tree-era name for From (branch off that step).
	ParentStepID string `json:"parentStepId"`
	// Edge holds the properties of the edge that leads into the new step.
	Edge edgeProps `json:"edge"`
	// BranchCondition / Condition are shorthands for edge.condition.
	BranchCondition *string `json:"branchCondition"`
	Condition       *string `json:"condition"`
}

func (r *addStepRequest) normalize() {
	if r.From == "" && r.ParentStepID != "" {
		r.From = r.ParentStepID
	}
	if r.Edge.Condition == nil {
		if r.Condition != nil {
			r.Edge.Condition = r.Condition
		} else if r.BranchCondition != nil && *r.BranchCondition != "" {
			r.Edge.Condition = r.BranchCondition
		}
	}
}

func (p *Platform) addFlowStep(w http.ResponseWriter, r *http.Request) {
	flowID := r.PathValue("id")
	var req addStepRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	req.normalize()
	target := stepTarget{req.ProjectSlug, req.FeatureID, req.SubflowID}
	if err := target.validate(); err != nil {
		writeEditError(w, err)
		return
	}
	if err := req.Edge.validate(); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	id := randomID()
	controls, _ := json.Marshal(trimmedControls(req.Controls))
	err := p.inFlowTx(flowID, func(tx *sql.Tx, g *graph) error {
		if req.SubflowID != "" {
			if err := checkSubflow(tx, flowID, req.SubflowID); err != nil {
				return err
			}
		}
		var pos int
		tx.QueryRow(`SELECT COALESCE(MAX(position)+1,0) FROM flow_steps WHERE flow_id=?`, flowID).Scan(&pos)
		if _, err := tx.Exec(`INSERT INTO flow_steps (id, flow_id, position, project_slug, feature_id, subflow_id, note, actor, controls) VALUES (?,?,?,?,?,?,?,?,?)`,
			id, flowID, pos, req.ProjectSlug, req.FeatureID, req.SubflowID, req.Note, req.Actor, string(controls)); err != nil {
			return err
		}
		return attach(tx, g, flowID, id, req.placement, req.Edge)
	})
	if err != nil {
		writeEditError(w, err)
		return
	}
	s, err := p.loadFlowStep(flowID, id)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	p.enrichStep(s)
	w.WriteHeader(201)
	writeJSON(w, s)
}

func (p *Platform) updateFlowStep(w http.ResponseWriter, r *http.Request) {
	flowID, stepID := r.PathValue("id"), r.PathValue("stepId")
	var req struct {
		Note        *string   `json:"note"`
		Actor       *string   `json:"actor"`
		Controls    *[]string `json:"controls"`
		ProjectSlug *string   `json:"projectSlug"`
		FeatureID   *string   `json:"featureId"`
		SubflowID   *string   `json:"subflowId"`
		// BranchCondition is the tree-era step field: it labels the edge into this step
		// (when exactly one leads in).
		BranchCondition *string `json:"branchCondition"`
		ParentStepID    *string `json:"parentStepId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	if req.ParentStepID != nil {
		http.Error(w, "parentStepId cannot be patched: move the step (POST .../move with from) instead", 400)
		return
	}
	cur, err := p.loadFlowStep(flowID, stepID)
	if err == sql.ErrNoRows {
		http.Error(w, "not found", 404)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if req.Note != nil {
		cur.Note = *req.Note
	}
	if req.Actor != nil {
		cur.Actor = *req.Actor
	}
	if req.Controls != nil {
		cur.Controls = trimmedControls(*req.Controls)
	}
	// Pointing the step at a feature makes it a feature step, and at a flow a subflow step.
	repoint := false
	if req.ProjectSlug != nil && *req.ProjectSlug != cur.ProjectSlug {
		cur.ProjectSlug, repoint = *req.ProjectSlug, true
	}
	if req.FeatureID != nil && *req.FeatureID != cur.FeatureID {
		cur.FeatureID, repoint = *req.FeatureID, true
	}
	if repoint && req.SubflowID == nil {
		cur.SubflowID = ""
	}
	if req.SubflowID != nil && *req.SubflowID != cur.SubflowID {
		cur.SubflowID, repoint = *req.SubflowID, true
		if cur.SubflowID != "" && req.ProjectSlug == nil && req.FeatureID == nil {
			cur.ProjectSlug, cur.FeatureID = "", ""
		}
	}
	if err := (stepTarget{cur.ProjectSlug, cur.FeatureID, cur.SubflowID}).validate(); err != nil {
		writeEditError(w, err)
		return
	}
	controls, _ := json.Marshal(cur.Controls)
	err = p.inFlowTx(flowID, func(tx *sql.Tx, g *graph) error {
		if repoint && cur.SubflowID != "" {
			if err := checkSubflow(tx, flowID, cur.SubflowID); err != nil {
				return err
			}
		}
		if req.BranchCondition != nil {
			ins := g.in(stepID)
			if len(ins) != 1 {
				return badRequest("branchCondition labels the edge into a step, and %d edges lead into this one: set condition on the edge instead", len(ins))
			}
			if _, err := tx.Exec(`UPDATE flow_edges SET condition=? WHERE from_step_id=? AND to_step_id=?`, *req.BranchCondition, ins[0].FromStepID, stepID); err != nil {
				return err
			}
		}
		_, err := tx.Exec(`UPDATE flow_steps SET note=?, actor=?, controls=?, project_slug=?, feature_id=?, subflow_id=? WHERE id=?`,
			cur.Note, cur.Actor, string(controls), cur.ProjectSlug, cur.FeatureID, cur.SubflowID, stepID)
		if err == nil && repoint {
			_, err = tx.Exec(`UPDATE flow_steps SET tombstoned=0, tombstoned_reason='' WHERE id=?`, stepID)
		}
		return err
	})
	if err != nil {
		writeEditError(w, err)
		return
	}
	s, _ := p.loadFlowStep(flowID, stepID)
	p.enrichStep(s)
	writeJSON(w, s)
}

// removeFlowStep deletes a step. ?mode=splice (the default) joins the steps before it to the
// steps after it; subtree also removes the steps only reachable through it; isolate removes
// just the step and its edges.
func (p *Platform) removeFlowStep(w http.ResponseWriter, r *http.Request) {
	flowID, stepID := r.PathValue("id"), r.PathValue("stepId")
	mode := r.URL.Query().Get("mode")
	if mode == "" {
		mode = "splice"
	}
	if mode != "splice" && mode != "subtree" && mode != "isolate" {
		http.Error(w, "mode must be one of: splice, subtree, isolate", 400)
		return
	}
	removed := 0
	err := p.inFlowTx(flowID, func(tx *sql.Tx, g *graph) error {
		if !g.has(stepID) {
			return &editError{404, "not found"}
		}
		gone := []string{stepID}
		switch mode {
		case "splice":
			if err := detach(tx, g, stepID); err != nil {
				return err
			}
		case "subtree":
			var others []string
			for _, e := range g.entries() {
				if e != stepID {
					others = append(others, e)
				}
			}
			kept := g.reachable(others, map[string]bool{stepID: true})
			for id := range g.reachable([]string{stepID}, nil) {
				if id != stepID && !kept[id] {
					gone = append(gone, id)
				}
			}
		}
		for _, id := range gone {
			if _, err := tx.Exec(`DELETE FROM flow_steps WHERE id=? AND flow_id=?`, id, flowID); err != nil {
				return err
			}
		}
		removed = len(gone)
		return nil
	})
	if err != nil {
		writeEditError(w, err)
		return
	}
	w.Header().Set("X-Removed-Steps", fmt.Sprint(removed))
	w.WriteHeader(204)
}

// moveFlowStep moves a step. With ?dir=-1|1 (or {"dir": n}) it steps once: among its branch
// siblings when its parent branches, otherwise along the path, swapping places with the step
// before or after it. With after / before / from / entry in the body it is taken out (the gap
// closed, as a splice) and put back at that place.
func (p *Platform) moveFlowStep(w http.ResponseWriter, r *http.Request) {
	flowID, stepID := r.PathValue("id"), r.PathValue("stepId")
	var req struct {
		Dir *int `json:"dir"`
		placement
		ParentStepID string    `json:"parentStepId"`
		Edge         edgeProps `json:"edge"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err != io.EOF {
		http.Error(w, "invalid JSON", 400)
		return
	}
	if req.From == "" {
		req.From = req.ParentStepID
	}
	if q := r.URL.Query().Get("dir"); q != "" {
		var d int
		if _, err := fmt.Sscan(q, &d); err != nil {
			http.Error(w, "dir must be -1 or 1", 400)
			return
		}
		req.Dir = &d
	}
	if req.Dir != nil && req.count() > 0 {
		http.Error(w, "give either dir or a place (after, before, from, entry), not both", 400)
		return
	}
	if req.Dir == nil && req.count() == 0 {
		http.Error(w, "dir must be -1 or 1, or give a place: after, before, from or entry", 400)
		return
	}
	if req.Dir != nil && *req.Dir != -1 && *req.Dir != 1 {
		http.Error(w, "dir must be -1 or 1", 400)
		return
	}
	err := p.inFlowTx(flowID, func(tx *sql.Tx, g *graph) error {
		if !g.has(stepID) {
			return &editError{404, "not found"}
		}
		if req.Dir != nil {
			return stepOnce(tx, g, flowID, stepID, *req.Dir)
		}
		if t := req.target(); t != "" && t != stepID {
			// Placing a step after one of its own descendants would loop; that is fine for a
			// graph, but placing it relative to itself is not.
			if !g.has(t) {
				return badRequest("step %q is not in this flow", t)
			}
		}
		if err := detach(tx, g, stepID); err != nil {
			return err
		}
		g2, err := loadGraph(tx, flowID)
		if err != nil {
			return err
		}
		return attach(tx, g2, flowID, stepID, req.placement, req.Edge)
	})
	if err != nil {
		writeEditError(w, err)
		return
	}
	s, _ := p.loadFlowStep(flowID, stepID)
	writeJSON(w, s)
}

// stepOnce moves stepID one place in direction dir (see moveFlowStep).
func stepOnce(tx *sql.Tx, g *graph, flowID, stepID string, dir int) error {
	ins := g.in(stepID)
	// A branch: reorder among the edges out of its parent.
	if len(ins) == 1 {
		siblings := g.out(ins[0].FromStepID)
		if len(siblings) > 1 {
			i := 0
			for k, e := range siblings {
				if e.ToStepID == stepID {
					i = k
				}
			}
			j := i + dir
			if j < 0 || j >= len(siblings) {
				return nil
			}
			siblings[i], siblings[j] = siblings[j], siblings[i]
			for k, e := range siblings {
				if _, err := tx.Exec(`UPDATE flow_edges SET position=? WHERE from_step_id=? AND to_step_id=?`, k, e.FromStepID, e.ToStepID); err != nil {
					return err
				}
			}
			return nil
		}
	}
	// An entry point: reorder among the entries (the step order).
	if len(ins) == 0 && dir != 0 {
		entries := g.entries()
		if len(entries) > 1 {
			i := 0
			for k, e := range entries {
				if e == stepID {
					i = k
				}
			}
			if j := i + dir; j >= 0 && j < len(entries) {
				return swapStepOrder(tx, stepID, entries[j])
			}
			return nil
		}
	}
	// Along a path: swap with the step before (dir -1) or after (dir 1).
	a, b := "", ""
	if dir < 0 {
		if len(ins) != 1 || len(g.out(ins[0].FromStepID)) != 1 {
			return nil
		}
		a, b = ins[0].FromStepID, stepID
	} else {
		outs := g.out(stepID)
		if len(outs) != 1 || len(g.in(outs[0].ToStepID)) != 1 {
			return nil
		}
		a, b = stepID, outs[0].ToStepID
	}
	return swapAdjacent(tx, g, a, b)
}

func swapStepOrder(tx *sql.Tx, a, b string) error {
	var pa, pb int
	tx.QueryRow(`SELECT position FROM flow_steps WHERE id=?`, a).Scan(&pa)
	tx.QueryRow(`SELECT position FROM flow_steps WHERE id=?`, b).Scan(&pb)
	if _, err := tx.Exec(`UPDATE flow_steps SET position=? WHERE id=?`, pb, a); err != nil {
		return err
	}
	_, err := tx.Exec(`UPDATE flow_steps SET position=? WHERE id=?`, pa, b)
	return err
}

// swapAdjacent swaps a and b where a -> b is a's only way on and b's only way in: what led
// into a now leads into b, b leads to a, and a leads where b led. Each edge keeps its
// properties, so the hops stay where they were and the two steps trade places.
func swapAdjacent(tx *sql.Tx, g *graph, a, b string) error {
	if _, loop := g.edge(b, a); loop {
		return badRequest("these steps form a loop; move one with after/before/from instead")
	}
	mid, _ := g.edge(a, b)
	intoA, outOfB := g.in(a), g.out(b)
	if _, err := tx.Exec(`DELETE FROM flow_edges WHERE to_step_id=? OR from_step_id=? OR (from_step_id=? AND to_step_id=?)`, a, b, a, b); err != nil {
		return err
	}
	for _, e := range intoA {
		e.ToStepID = b
		if e.FromStepID == b {
			continue
		}
		if err := insertEdge(tx, e); err != nil {
			return err
		}
	}
	mid.FromStepID, mid.ToStepID = b, a
	if err := insertEdge(tx, mid); err != nil {
		return err
	}
	for _, e := range outOfB {
		e.FromStepID = a
		if e.ToStepID == a {
			continue
		}
		if err := insertEdge(tx, e); err != nil {
			return err
		}
	}
	return swapStepOrder(tx, a, b)
}

// ── edges ─────────────────────────────────────────────────────────────────────

func (p *Platform) setFlowEdge(w http.ResponseWriter, r *http.Request) {
	flowID, fromID, toID := r.PathValue("id"), r.PathValue("fromId"), r.PathValue("toId")
	var props edgeProps
	if err := json.NewDecoder(r.Body).Decode(&props); err != nil && err != io.EOF {
		http.Error(w, "invalid JSON", 400)
		return
	}
	if err := props.validate(); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if fromID == toID {
		http.Error(w, "a step cannot lead to itself", 400)
		return
	}
	var out FlowEdge
	err := p.inFlowTx(flowID, func(tx *sql.Tx, g *graph) error {
		if !g.has(fromID) || !g.has(toID) {
			return badRequest("both steps must belong to this flow")
		}
		e, exists := g.edge(fromID, toID)
		if !exists {
			e = FlowEdge{FlowID: flowID, FromStepID: fromID, ToStepID: toID, Position: len(g.out(fromID))}
		}
		props.apply(&e)
		if exists {
			if _, err := tx.Exec(`DELETE FROM flow_edges WHERE from_step_id=? AND to_step_id=?`, fromID, toID); err != nil {
				return err
			}
		}
		if props.Position != nil {
			// Make room: the other branches keep their order around the new slot.
			sibs := g.out(fromID)
			var others []FlowEdge
			for _, s := range sibs {
				if s.ToStepID != toID {
					others = append(others, s)
				}
			}
			at := e.Position
			if at < 0 {
				at = 0
			}
			if at > len(others) {
				at = len(others)
			}
			e.Position = at
			k := 0
			for _, s := range others {
				if k == at {
					k++
				}
				if _, err := tx.Exec(`UPDATE flow_edges SET position=? WHERE from_step_id=? AND to_step_id=?`, k, s.FromStepID, s.ToStepID); err != nil {
					return err
				}
				k++
			}
		}
		out = e
		return insertEdge(tx, e)
	})
	if err != nil {
		writeEditError(w, err)
		return
	}
	writeJSON(w, out)
}

func (p *Platform) deleteFlowEdge(w http.ResponseWriter, r *http.Request) {
	flowID, fromID, toID := r.PathValue("id"), r.PathValue("fromId"), r.PathValue("toId")
	err := p.inFlowTx(flowID, func(tx *sql.Tx, g *graph) error {
		if _, ok := g.edge(fromID, toID); !ok {
			return &editError{404, "not found"}
		}
		_, err := tx.Exec(`DELETE FROM flow_edges WHERE from_step_id=? AND to_step_id=?`, fromID, toID)
		return err
	})
	if err != nil {
		writeEditError(w, err)
		return
	}
	w.WriteHeader(204)
}

// ── whole graph ───────────────────────────────────────────────────────────────

// graphStepInput is one step of a whole-graph payload (PUT .../steps, POST /api/flows, export).
type graphStepInput struct {
	ClientID    string   `json:"clientId"`
	ProjectSlug string   `json:"projectSlug,omitempty"`
	FeatureID   string   `json:"featureId,omitempty"`
	SubflowID   string   `json:"subflowId,omitempty"`
	Note        string   `json:"note"`
	Actor       string   `json:"actor"`
	Controls    []string `json:"controls"`
	// Tree-era fields, still accepted: an edge from the parent carrying the condition.
	ParentClientID  string `json:"parentClientId,omitempty"`
	BranchCondition string `json:"branchCondition,omitempty"`
}

// graphEdgeInput is one edge of a whole-graph payload; from / to are clientIds.
type graphEdgeInput struct {
	From string `json:"from"`
	To   string `json:"to"`
	edgeProps
	// Tree-era link field names, still accepted.
	FromClientID string `json:"fromClientId,omitempty"`
	ToClientID   string `json:"toClientId,omitempty"`
}

type graphInput struct {
	Steps []graphStepInput `json:"steps"`
	Edges []graphEdgeInput `json:"edges"`
	Links []graphEdgeInput `json:"links"`
}

// normalize folds the tree-era spellings into steps + edges and checks the graph.
func (in *graphInput) normalize() error {
	seen := make(map[string]bool, len(in.Steps))
	for _, s := range in.Steps {
		if s.ClientID == "" {
			return fmt.Errorf("each step must have a non-empty clientId")
		}
		if seen[s.ClientID] {
			return fmt.Errorf("duplicate clientId: %q", s.ClientID)
		}
		if err := (stepTarget{s.ProjectSlug, s.FeatureID, s.SubflowID}).validate(); err != nil {
			return fmt.Errorf("step %q: %v", s.ClientID, err)
		}
		seen[s.ClientID] = true
	}
	edges := append([]graphEdgeInput{}, in.Edges...)
	edges = append(edges, in.Links...)
	have := map[[2]string]int{}
	for i := range edges {
		if edges[i].From == "" {
			edges[i].From = edges[i].FromClientID
		}
		if edges[i].To == "" {
			edges[i].To = edges[i].ToClientID
		}
	}
	// Tree-era parents become edges ahead of the explicit ones (a link duplicating a
	// parent edge labels it, as before).
	var parentEdges []graphEdgeInput
	for _, s := range in.Steps {
		if s.ParentClientID == "" {
			continue
		}
		if !seen[s.ParentClientID] {
			return fmt.Errorf("step %q references unknown parentClientId %q", s.ClientID, s.ParentClientID)
		}
		e := graphEdgeInput{From: s.ParentClientID, To: s.ClientID}
		if s.BranchCondition != "" {
			c := s.BranchCondition
			e.Condition = &c
		}
		parentEdges = append(parentEdges, e)
	}
	var out []graphEdgeInput
	merged := map[int]bool{}
	for _, e := range append(parentEdges, edges...) {
		if !seen[e.From] || !seen[e.To] {
			return fmt.Errorf("edge references unknown clientId: %s → %s", e.From, e.To)
		}
		if e.From == e.To {
			return fmt.Errorf("edge %s → %s: a step cannot lead to itself", e.From, e.To)
		}
		if err := e.validate(); err != nil {
			return fmt.Errorf("edge %s → %s: %v", e.From, e.To, err)
		}
		key := [2]string{e.From, e.To}
		if i, ok := have[key]; ok {
			if i < len(parentEdges) && !merged[i] {
				// A link over a parent edge (once): its fields label that edge.
				m := out[i]
				cond := m.Condition
				m.edgeProps = e.edgeProps
				if m.Condition == nil {
					m.Condition = cond
				}
				out[i], merged[i] = m, true
				continue
			}
			return fmt.Errorf("duplicate edge %s → %s", e.From, e.To)
		}
		have[key] = len(out)
		out = append(out, e)
	}
	in.Edges, in.Links = out, nil
	return nil
}

// writeGraph inserts in's steps and edges into flowID (which has none), returning clientId -> id.
func writeGraph(tx *sql.Tx, flowID string, in graphInput) (map[string]string, error) {
	ids := make(map[string]string, len(in.Steps))
	for i, s := range in.Steps {
		ids[s.ClientID] = randomID()
		if s.SubflowID != "" {
			if err := checkSubflow(tx, flowID, s.SubflowID); err != nil {
				return nil, err
			}
		}
		controls, _ := json.Marshal(trimmedControls(s.Controls))
		if _, err := tx.Exec(`INSERT INTO flow_steps (id, flow_id, position, project_slug, feature_id, subflow_id, note, actor, controls) VALUES (?,?,?,?,?,?,?,?,?)`,
			ids[s.ClientID], flowID, i, s.ProjectSlug, s.FeatureID, s.SubflowID, s.Note, s.Actor, string(controls)); err != nil {
			return nil, err
		}
	}
	next := map[string]int{}
	for _, ei := range in.Edges {
		e := FlowEdge{FlowID: flowID, FromStepID: ids[ei.From], ToStepID: ids[ei.To], Position: next[ei.From]}
		ei.edgeProps.apply(&e)
		next[ei.From] = e.Position + 1
		if err := insertEdge(tx, e); err != nil {
			return nil, err
		}
	}
	return ids, nil
}

// setFlowSteps replaces a flow's whole graph (PUT /api/flows/{id}/steps).
func (p *Platform) setFlowSteps(w http.ResponseWriter, r *http.Request) {
	flowID := r.PathValue("id")
	var in graphInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	if err := in.normalize(); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	var ids map[string]string
	err := p.inFlowTx(flowID, func(tx *sql.Tx, _ *graph) error {
		if _, err := tx.Exec(`DELETE FROM flow_steps WHERE flow_id=?`, flowID); err != nil {
			return err
		}
		var err error
		ids, err = writeGraph(tx, flowID, in)
		return err
	})
	if err != nil {
		writeEditError(w, err)
		return
	}
	f, err := p.loadFullFlow(flowID)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, struct {
		Flow    *Flow             `json:"flow"`
		StepIds map[string]string `json:"stepIds"`
	}{f, ids})
}

// flowExport is a flow in the shape that POST /api/flows and PUT .../steps take back.
type flowExport struct {
	Name        string           `json:"name"`
	Description string           `json:"description"`
	Status      string           `json:"status"`
	Owner       string           `json:"owner"`
	Tags        []string         `json:"tags"`
	Steps       []graphStepInput `json:"steps"`
	Edges       []FlowEdgeExport `json:"edges"`
}

// FlowEdgeExport is an edge with clientId ends (the step ids, in an export).
type FlowEdgeExport struct {
	From          string   `json:"from"`
	To            string   `json:"to"`
	Kind          string   `json:"kind"`
	Protocol      string   `json:"protocol,omitempty"`
	Condition     string   `json:"condition,omitempty"`
	Auth          string   `json:"auth,omitempty"`
	TrustBoundary bool     `json:"trustBoundary,omitempty"`
	Data          string   `json:"data,omitempty"`
	Tainted       bool     `json:"tainted,omitempty"`
	Description   string   `json:"description,omitempty"`
	Comment       string   `json:"comment,omitempty"`
	Tags          []string `json:"tags,omitempty"`
}

func (p *Platform) exportFlow(w http.ResponseWriter, r *http.Request) {
	f, err := p.loadFullFlow(r.PathValue("id"))
	if err == sql.ErrNoRows {
		http.Error(w, "not found", 404)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	out := flowExport{Name: f.Name, Description: f.Description, Status: f.Status, Owner: f.Owner, Tags: f.Tags,
		Steps: []graphStepInput{}, Edges: []FlowEdgeExport{}}
	for _, s := range f.Steps {
		out.Steps = append(out.Steps, graphStepInput{ClientID: s.ID, ProjectSlug: s.ProjectSlug, FeatureID: s.FeatureID, SubflowID: s.SubflowID, Note: s.Note, Actor: s.Actor, Controls: s.Controls})
	}
	edges := append([]FlowEdge{}, f.Edges...)
	sort.SliceStable(edges, func(i, j int) bool {
		if edges[i].FromStepID != edges[j].FromStepID {
			return stepIndex(f.Steps, edges[i].FromStepID) < stepIndex(f.Steps, edges[j].FromStepID)
		}
		return edges[i].Position < edges[j].Position
	})
	for _, e := range edges {
		out.Edges = append(out.Edges, FlowEdgeExport{From: e.FromStepID, To: e.ToStepID, Kind: e.Kind, Protocol: e.Protocol, Condition: e.Condition,
			Auth: e.Auth, TrustBoundary: e.TrustBoundary, Data: e.Data, Tainted: e.Tainted, Description: e.Description, Comment: e.Comment, Tags: e.Tags})
	}
	writeJSON(w, out)
}

func stepIndex(steps []FlowStep, id string) int {
	for i, s := range steps {
		if s.ID == id {
			return i
		}
	}
	return len(steps)
}

// ── suggestions ───────────────────────────────────────────────────────────────

// FlowSuggestion is a feature linked to a step's feature: a likely next step.
type FlowSuggestion struct {
	ProjectSlug string `json:"projectSlug"`
	ProjectName string `json:"projectName"`
	FeatureID   string `json:"featureId"`
	Title       string `json:"title"`
	Kind        string `json:"kind"`
	Operation   string `json:"operation,omitempty"`
	Protocol    string `json:"protocol,omitempty"`
	// Description is the link's description.
	Description string `json:"description,omitempty"`
	// StepID is set when the feature is already a step of this flow (connect to it rather
	// than adding it again); Connected when this step already leads to it.
	StepID    string `json:"stepId,omitempty"`
	Connected bool   `json:"connected,omitempty"`
}

// suggestFlowSteps serves GET /api/flows/{id}/steps/{stepId}/suggestions: the features linked
// to the step's feature, in this project or another, as candidates for the step after it.
// Ones the flow doesn't have yet come first.
func (p *Platform) suggestFlowSteps(w http.ResponseWriter, r *http.Request) {
	flowID, stepID := r.PathValue("id"), r.PathValue("stepId")
	step, err := p.loadFlowStep(flowID, stepID)
	if err == sql.ErrNoRows {
		http.Error(w, "not found", 404)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	out, err := p.flowSuggestions(flowID, step)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, out)
}

func (p *Platform) flowSuggestions(flowID string, step *FlowStep) ([]FlowSuggestion, error) {
	out := []FlowSuggestion{}
	if step.SubflowID != "" {
		return out, nil
	}
	wb, err := p.getWorkbench(step.ProjectSlug)
	if err != nil {
		return out, nil
	}
	feat, err := wb.DB.GetFeature(step.FeatureID)
	if err != nil || feat == nil {
		return out, nil
	}
	steps, err := p.loadFlowSteps(flowID)
	if err != nil {
		return nil, err
	}
	edges, err := loadFlowEdges(p.db, flowID)
	if err != nil {
		return nil, err
	}
	stepOf := map[string]string{}
	for _, s := range steps {
		if s.SubflowID == "" {
			stepOf[qualifiedRef(s.ProjectSlug, s.FeatureID)] = s.ID
		}
	}
	names := map[string]string{}
	for _, l := range feat.LinkedFeatures {
		slug, id, _ := strings.Cut(qualifiedRef(step.ProjectSlug, l.ID), ":")
		owner, err := p.getWorkbench(slug)
		if err != nil {
			continue
		}
		f, err := owner.DB.GetFeature(id)
		if err != nil || f == nil {
			continue
		}
		if _, ok := names[slug]; !ok {
			var name string
			p.db.QueryRow(`SELECT name FROM projects WHERE slug = ?`, slug).Scan(&name)
			names[slug] = name
		}
		sg := FlowSuggestion{ProjectSlug: slug, ProjectName: names[slug], FeatureID: f.ID, Title: f.Title, Kind: f.Kind,
			Operation: f.Operation, Protocol: f.Protocol, Description: l.Description, StepID: stepOf[slug+":"+f.ID]}
		for _, e := range edges {
			if sg.StepID != "" && e.FromStepID == step.ID && e.ToStepID == sg.StepID {
				sg.Connected = true
			}
		}
		out = append(out, sg)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if (out[i].StepID == "") != (out[j].StepID == "") {
			return out[i].StepID == ""
		}
		return out[i].Title < out[j].Title
	})
	return out, nil
}
