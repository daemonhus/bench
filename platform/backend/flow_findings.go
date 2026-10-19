package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
)

// ── Types ──────────────────────────────────────────────────────────────────────

// FindingSeverityCounts is a map of severity → count for open findings.
type FindingSeverityCounts struct {
	Critical int `json:"critical"`
	High     int `json:"high"`
	Medium   int `json:"medium"`
	Low      int `json:"low"`
	Info     int `json:"info"`
}

func (c FindingSeverityCounts) total() int {
	return c.Critical + c.High + c.Medium + c.Low + c.Info
}

// FlowFinding is a single open finding associated with a flow step.
type FlowFinding struct {
	ID          string `json:"id"`
	StepID      string `json:"stepId"`
	ProjectSlug string `json:"projectSlug"`
	Title       string `json:"title"`
	Severity    string `json:"severity"`
	Status      string `json:"status"`
	FeatureID   string `json:"featureId"`
}

// FlowFindings is the response for GET /api/platform/flows/{id}/findings.
type FlowFindings struct {
	FlowID   string                `json:"flowId"`
	Total    int                   `json:"total"`
	BySev    FindingSeverityCounts `json:"bySeverity"`
	Findings []FlowFinding         `json:"findings"`
}

// rawBenchFinding is the subset of fields we decode from GET /api/findings.
type rawBenchFinding struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Severity string   `json:"severity"`
	Status   string   `json:"status"`
	Features []string `json:"features"` // bench serialises as "features" not "featureIds"
}

// isOpenStatus returns true for statuses that count as "open" for risk purposes.
func isOpenStatus(status string) bool {
	return status == "draft" || status == "open" || status == "in-progress"
}

// ── Handler ────────────────────────────────────────────────────────────────────

func (p *Platform) listFlowFindings(w http.ResponseWriter, r *http.Request) {
	flowID := r.PathValue("id")
	f, err := p.loadFlowWithSteps(flowID)
	if err != nil {
		http.Error(w, "flow not found", 404)
		return
	}

	result := FlowFindings{FlowID: flowID, Findings: []FlowFinding{}}

	if len(f.Steps) == 0 {
		writeJSON(w, result)
		return
	}

	// Group step featureIds by projectSlug — one bench call per project.
	type stepKey struct{ slug, featureID string }
	stepByFeature := make(map[stepKey]string) // (slug,featureId) → stepId
	featuresBySlug := make(map[string]map[string]struct{})
	for _, s := range f.Steps {
		if s.FeatureID == "" || s.ProjectSlug == "" {
			continue
		}
		k := stepKey{s.ProjectSlug, s.FeatureID}
		stepByFeature[k] = s.ID
		if featuresBySlug[s.ProjectSlug] == nil {
			featuresBySlug[s.ProjectSlug] = make(map[string]struct{})
		}
		featuresBySlug[s.ProjectSlug][s.FeatureID] = struct{}{}
	}

	type res struct {
		slug     string
		findings []rawBenchFinding
		err      error
	}
	ch := make(chan res, len(featuresBySlug))
	for slug := range featuresBySlug {
		go func(slug string) {
			findings, err := p.fetchProjectFindings(slug)
			ch <- res{slug, findings, err}
		}(slug)
	}

	for range featuresBySlug {
		r := <-ch
		if r.err != nil {
			continue
		}
		feats := featuresBySlug[r.slug]
		for _, bf := range r.findings {
			if !isOpenStatus(bf.Status) {
				continue
			}
			// Match findings linked to at least one feature in this flow's step set.
			for _, fid := range bf.Features {
				if _, ok := feats[fid]; ok {
					k := stepKey{r.slug, fid}
					stepID := stepByFeature[k]
					result.Findings = append(result.Findings, FlowFinding{
						ID:          bf.ID,
						StepID:      stepID,
						ProjectSlug: r.slug,
						Title:       bf.Title,
						Severity:    bf.Severity,
						Status:      bf.Status,
						FeatureID:   fid,
					})
					// Count each finding once even if it links multiple step features.
					break
				}
			}
		}
	}

	// Aggregate severity counts.
	for _, ff := range result.Findings {
		switch ff.Severity {
		case "critical":
			result.BySev.Critical++
		case "high":
			result.BySev.High++
		case "medium":
			result.BySev.Medium++
		case "low":
			result.BySev.Low++
		case "info":
			result.BySev.Info++
		}
	}
	result.Total = len(result.Findings)
	writeJSON(w, result)
}

// fetchProjectFindings fetches all findings for a project from its workbench.
func (p *Platform) fetchProjectFindings(slug string) ([]rawBenchFinding, error) {
	wb, err := p.getWorkbench(slug)
	if err != nil {
		return nil, err
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/findings", nil)
	wb.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		return nil, nil
	}
	var findings []rawBenchFinding
	if err := json.Unmarshal(rec.Body.Bytes(), &findings); err != nil {
		return nil, err
	}
	return findings, nil
}

// enrichFlowSummariesWithFindings populates OpenFindings/OpenFindingsTotal on each summary.
// It batches per-project bench calls and applies findings only to flows that reference the project.
func (p *Platform) enrichFlowSummariesWithFindings(items []FlowSummary) []FlowSummary {
	// Collect unique slugs across all flows in this page.
	slugs := map[string]struct{}{}
	for _, item := range items {
		for _, s := range item.ProjectSlugs {
			slugs[s] = struct{}{}
		}
	}
	if len(slugs) == 0 {
		return items
	}

	type res struct {
		slug     string
		findings []rawBenchFinding
	}
	ch := make(chan res, len(slugs))
	for slug := range slugs {
		go func(slug string) {
			findings, _ := p.fetchProjectFindings(slug)
			ch <- res{slug, findings}
		}(slug)
	}
	// projectFindings: slug → open findings keyed by featureId set
	type projFindings struct {
		counts FindingSeverityCounts
		// featureId → count of open findings linked to that feature
		byFeature map[string]int
	}
	pf := make(map[string]*projFindings)
	for range slugs {
		r := <-ch
		pf[r.slug] = &projFindings{byFeature: make(map[string]int)}
		for _, f := range r.findings {
			if !isOpenStatus(f.Status) {
				continue
			}
			for _, fid := range f.Features {
				pf[r.slug].byFeature[fid]++
				switch f.Severity {
				case "critical":
					pf[r.slug].counts.Critical++
				case "high":
					pf[r.slug].counts.High++
				case "medium":
					pf[r.slug].counts.Medium++
				case "low":
					pf[r.slug].counts.Low++
				case "info":
					pf[r.slug].counts.Info++
				}
				break // count each finding once
			}
		}
	}

	// For each flow, sum open findings across its projects.
	// We only have projectSlugs here (not featureIds), so we count all open findings
	// for projects in the flow rather than feature-exact matching.
	for i := range items {
		var total FindingSeverityCounts
		for _, slug := range items[i].ProjectSlugs {
			if proj, ok := pf[slug]; ok {
				total.Critical += proj.counts.Critical
				total.High += proj.counts.High
				total.Medium += proj.counts.Medium
				total.Low += proj.counts.Low
				total.Info += proj.counts.Info
			}
		}
		t := total.total()
		if t > 0 {
			items[i].OpenFindings = &total
			items[i].OpenFindingsTotal = t
		}
	}
	return items
}

// loadFlowWithSteps loads a flow and its steps from the DB (no feature enrichment).
func (p *Platform) loadFlowWithSteps(flowID string) (*Flow, error) {
	row := p.db.QueryRow(
		`SELECT id, name, description, status, owner, tags, created_at, updated_at FROM flows WHERE id=?`,
		flowID,
	)
	var f Flow
	var tagsJSON string
	if err := row.Scan(&f.ID, &f.Name, &f.Description, &f.Status, &f.Owner, &tagsJSON, &f.CreatedAt, &f.UpdatedAt); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(tagsJSON), &f.Tags); err != nil {
		f.Tags = []string{}
	}

	rows, err := p.db.Query(
		`SELECT id, parent_step_id, position, branch_condition, project_slug, feature_id, note
		 FROM flow_steps WHERE flow_id=? ORDER BY position`,
		flowID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var s FlowStep
		var parentID *string
		if err := rows.Scan(&s.ID, &parentID, &s.Position, &s.BranchCondition,
			&s.ProjectSlug, &s.FeatureID, &s.Note); err != nil {
			return nil, err
		}
		if parentID != nil {
			s.ParentStepID = *parentID
		}
		f.Steps = append(f.Steps, s)
	}
	return &f, nil
}
