package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"

	"bench/internal/db"
	"bench/internal/events"
	"bench/internal/git"
	"bench/internal/model"
	"bench/internal/review"

	"github.com/google/uuid"
)

type baselineHandlers struct {
	db     *db.DB
	repo   *git.Repo
	broker *events.Broker
}

// GET /api/baselines - the review branch's baselines (most recent first)
func (h *baselineHandlers) list(w http.ResponseWriter, r *http.Request) {
	limit := 20
	if s := r.URL.Query().Get("limit"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n > 0 {
			limit = n
		}
	}
	scope, err := branchScope(h.db, h.repo, r)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	// Read them all when filtering, so the limit counts the branch's.
	read := limit
	if scope != nil {
		read = maxBaselines
	}
	baselines, err := h.db.ListBaselines(read)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	baselines = keepOnBranch(w, scope, baselines, func(b model.Baseline) string { return b.CommitID })
	if len(baselines) > limit {
		baselines = baselines[:limit]
	}
	if baselines == nil {
		baselines = []model.Baseline{}
	}
	writeJSON(w, http.StatusOK, baselines)
}

// maxBaselines bounds the baselines read to find a branch's.
const maxBaselines = 1000

// latestOn is the most recent baseline on the scope's branch, nil if none.
func (h *baselineHandlers) latestOn(scope *review.Scope) (*model.Baseline, error) {
	baselines, err := h.db.ListBaselines(maxBaselines)
	if err != nil {
		return nil, err
	}
	for i := range baselines {
		if scope.Has(baselines[i].CommitID) {
			return &baselines[i], nil
		}
	}
	return nil, nil
}

// GET /api/baselines/latest - the review branch's most recent baseline
func (h *baselineHandlers) latest(w http.ResponseWriter, r *http.Request) {
	b, err := reviewBranch(h.db, h.repo, r)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	baseline, err := h.latestOn(review.NewScope(h.repo, b.Tip))
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if baseline == nil {
		writeError(w, http.StatusNotFound, "no baselines")
		return
	}
	writeJSON(w, http.StatusOK, baseline)
}

// GET /api/baselines/{id} - one baseline (the CLI's delete preview reads it)
func (h *baselineHandlers) get(w http.ResponseWriter, r *http.Request) {
	baseline, err := h.db.GetBaselineByID(r.PathValue("id"))
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if baseline == nil {
		writeError(w, http.StatusNotFound, "baseline not found")
		return
	}
	writeJSON(w, http.StatusOK, baseline)
}

// GET /api/baselines/delta - changes on the review branch since its latest baseline
func (h *baselineHandlers) delta(w http.ResponseWriter, r *http.Request) {
	b, err := reviewBranch(h.db, h.repo, r)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	scope := review.NewScope(h.repo, b.Tip)
	baseline, err := h.latestOn(scope)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if baseline == nil {
		writeError(w, http.StatusNotFound, "no baselines")
		return
	}

	delta, err := h.computeDelta(baseline, b.Tip, scope)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, delta)
}

// GET /api/baselines/{id}/delta - delta for a specific baseline vs previous
func (h *baselineHandlers) deltaFor(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "baseline id is required")
		return
	}

	baseline, err := h.db.GetBaselineByID(id)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if baseline == nil {
		writeError(w, http.StatusNotFound, "baseline not found")
		return
	}

	// The previous baseline: the one before it in its own history.
	scope := review.NewScope(h.repo, baseline.CommitID)
	var prev *model.Baseline
	earlier, err := h.db.BaselinesBefore(baseline.ID, maxBaselines)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	for i := range earlier {
		if scope.Has(earlier[i].CommitID) {
			prev = &earlier[i]
			break
		}
	}

	delta, err := h.computeDeltaBetween(baseline, prev, scope)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, delta)
}

// POST /api/baselines - create a new baseline (defaults to the review branch's tip)
func (h *baselineHandlers) create(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Reviewer string `json:"reviewer"`
		Summary  string `json:"summary"`
		CommitID string `json:"commitId"`
	}
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
			} else {
				writeError(w, http.StatusBadRequest, "invalid JSON")
			}
			return
		}
	}

	var head string
	var err error
	if body.CommitID != "" {
		head, err = h.repo.ResolveRef(body.CommitID)
		if err != nil {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("invalid commit: %s", err))
			return
		}
	} else {
		b, err := reviewBranch(h.db, h.repo, r)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		head = b.Tip
	}

	// The snapshot counts what's on the baseline's commit.
	stats, err := h.buildStats(review.NewScope(h.repo, head))
	if err != nil {
		writeInternalError(w, err)
		return
	}

	findingIDs, err := h.db.AllFindingIDs()
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if findingIDs == nil {
		findingIDs = []string{}
	}

	featureIDs, err := h.db.AllFeatureIDs()
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if featureIDs == nil {
		featureIDs = []string{}
	}

	baseline := &model.Baseline{
		ID:             uuid.New().String(),
		CommitID:       head,
		Reviewer:       body.Reviewer,
		Summary:        body.Summary,
		FindingsTotal:  stats.FindingsTotal,
		FindingsOpen:   stats.FindingsOpen,
		BySeverity:     stats.BySeverity,
		ByStatus:       stats.ByStatus,
		ByCategory:     stats.ByCategory,
		CommentsTotal:  stats.CommentsTotal,
		CommentsOpen:   stats.CommentsOpen,
		FindingIDs:     findingIDs,
		FeaturesTotal:  stats.FeaturesTotal,
		FeaturesActive: stats.FeaturesActive,
		ByKind:         stats.ByKind,
		FeatureIDs:     featureIDs,
	}

	if err := h.db.CreateBaseline(baseline); err != nil {
		writeInternalError(w, err)
		return
	}

	// Pin the commit so it survives rebases / GC. Best-effort: a read-only
	// repo or unwritable .git will fail here, but the baseline is already
	// saved and the rest of the app doesn't depend on the pin.
	if err := h.repo.PinCommit(head); err != nil {
		log.Printf("[baselines] pin commit %s failed: %v", head, err)
	}

	if h.broker != nil {
		h.broker.Publish(events.TopicBaselines)
	}

	// Re-read to get server-generated created_at
	created, err := h.db.GetBaselineByID(baseline.ID)
	if err != nil || created == nil {
		writeJSON(w, http.StatusCreated, baseline)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// PATCH /api/baselines/{id} - update mutable fields (reviewer, summary)
func (h *baselineHandlers) update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "baseline id is required")
		return
	}
	var body struct {
		Reviewer *string `json:"reviewer"`
		Summary  *string `json:"summary"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if body.Reviewer == nil && body.Summary == nil {
		writeError(w, http.StatusBadRequest, "nothing to update")
		return
	}
	if err := h.db.UpdateBaseline(id, body.Reviewer, body.Summary); err != nil {
		writeInternalError(w, err)
		return
	}
	if h.broker != nil {
		h.broker.Publish(events.TopicBaselines)
	}
	updated, err := h.db.GetBaselineByID(id)
	if err != nil || updated == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// DELETE /api/baselines/{id}
// Pass ?confirm=true to actually delete. Without it, returns a preview (dry run).
func (h *baselineHandlers) delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "baseline id is required")
		return
	}

	// Always validate the baseline exists first.
	baseline, err := h.db.GetBaselineByID(id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			writeError(w, http.StatusNotFound, "baseline not found")
		} else {
			writeInternalError(w, err)
		}
		return
	}
	if baseline == nil {
		writeError(w, http.StatusNotFound, "baseline not found")
		return
	}

	// Dry-run unless confirm=true.
	if r.URL.Query().Get("confirm") != "true" {
		latest, _ := h.db.GetLatestBaseline()
		isLatest := latest != nil && latest.ID == baseline.ID
		writeJSON(w, http.StatusOK, map[string]any{
			"dryRun":   true,
			"baseline": baseline,
			"isLatest": isLatest,
			"message":  "This baseline would be deleted. Pass ?confirm=true to proceed.",
		})
		return
	}

	if err := h.db.DeleteBaseline(id); err != nil {
		writeInternalError(w, err)
		return
	}
	if h.broker != nil {
		h.broker.Publish(events.TopicBaselines)
	}
	w.WriteHeader(http.StatusNoContent)
}

// computeDelta calculates delta since a baseline against the current state of
// the branch whose head is tip: its findings and features, and its files.
func (h *baselineHandlers) computeDelta(baseline *model.Baseline, tip string, scope *review.Scope) (*model.BaselineDelta, error) {
	// Build set of finding IDs from baseline
	baselineIDs := make(map[string]bool, len(baseline.FindingIDs))
	for _, id := range baseline.FindingIDs {
		baselineIDs[id] = true
	}

	// Get current findings
	currentFindings, _, err := h.db.ListFindings("", 0, 0)
	if err != nil {
		return nil, err
	}

	// A finding on another branch is neither new here nor removed.
	currentIDs := make(map[string]bool)
	var newFindings []model.Finding
	for _, f := range currentFindings {
		currentIDs[f.ID] = true
		if !baselineIDs[f.ID] && scope.Has(f.Anchor.CommitID) {
			newFindings = append(newFindings, f)
		}
	}

	var removedIDs []string
	for _, id := range baseline.FindingIDs {
		if !currentIDs[id] {
			removedIDs = append(removedIDs, id)
		}
	}

	var changedFiles []model.FileStat
	if stats, err := h.repo.DiffStat(baseline.CommitID, tip); err == nil {
		changedFiles = stats
	}

	projStats, err := h.buildStats(scope)
	if err != nil {
		return nil, err
	}

	// Feature delta
	baselineFeatureIDs := make(map[string]bool, len(baseline.FeatureIDs))
	for _, id := range baseline.FeatureIDs {
		baselineFeatureIDs[id] = true
	}
	currentFeatures, _, _ := h.db.ListFeatures("", "", 0, 0)
	currentFeatureIDs := make(map[string]bool)
	var newFeatures []model.Feature
	for _, f := range currentFeatures {
		currentFeatureIDs[f.ID] = true
		if !baselineFeatureIDs[f.ID] && scope.Has(f.Anchor.CommitID) {
			newFeatures = append(newFeatures, f)
		}
	}
	var removedFeatureIDs []string
	for _, id := range baseline.FeatureIDs {
		if !currentFeatureIDs[id] {
			removedFeatureIDs = append(removedFeatureIDs, id)
		}
	}

	if newFindings == nil {
		newFindings = []model.Finding{}
	}
	if removedIDs == nil {
		removedIDs = []string{}
	}
	if changedFiles == nil {
		changedFiles = []model.FileStat{}
	}
	if newFeatures == nil {
		newFeatures = []model.Feature{}
	}
	if removedFeatureIDs == nil {
		removedFeatureIDs = []string{}
	}

	profile, err := serviceProfileIfConfigured(h.db)
	if err != nil {
		return nil, err
	}

	return &model.BaselineDelta{
		ServiceProfile:    profile,
		SinceBaseline:     baseline,
		HeadCommit:        tip,
		NewFindings:       newFindings,
		RemovedFindingIDs: removedIDs,
		ChangedFiles:      changedFiles,
		CurrentStats:      projStats,
		NewFeatures:       newFeatures,
		RemovedFeatureIDs: removedFeatureIDs,
	}, nil
}

// computeDeltaBetween calculates delta between two baselines (current vs
// previous); scope is current's history, which its stats count.
func (h *baselineHandlers) computeDeltaBetween(current, prev *model.Baseline, scope *review.Scope) (*model.BaselineDelta, error) {
	// Build previous finding ID set
	prevIDs := make(map[string]bool)
	if prev != nil {
		for _, fid := range prev.FindingIDs {
			prevIDs[fid] = true
		}
	}

	// Build current finding ID set
	currentIDs := make(map[string]bool)
	for _, fid := range current.FindingIDs {
		currentIDs[fid] = true
	}

	// New findings = in current but not in previous
	var newFindingIDs []string
	for fid := range currentIDs {
		if !prevIDs[fid] {
			newFindingIDs = append(newFindingIDs, fid)
		}
	}

	// Removed findings = in previous but not in current
	var removedIDs []string
	for fid := range prevIDs {
		if !currentIDs[fid] {
			removedIDs = append(removedIDs, fid)
		}
	}

	// Fetch full Finding objects for new findings
	var newFindings []model.Finding
	for _, fid := range newFindingIDs {
		f, err := h.db.GetFinding(fid)
		if err != nil || f == nil {
			continue
		}
		newFindings = append(newFindings, *f)
	}

	// Git diff for changed files between the two baseline commits
	var changedFiles []model.FileStat
	if prev != nil {
		stats, err := h.repo.DiffStat(prev.CommitID, current.CommitID)
		if err == nil {
			changedFiles = stats
		}
	}

	// Feature delta between two baselines
	prevFeatureIDs := make(map[string]bool)
	if prev != nil {
		for _, fid := range prev.FeatureIDs {
			prevFeatureIDs[fid] = true
		}
	}
	currentFeatureIDs := make(map[string]bool)
	for _, fid := range current.FeatureIDs {
		currentFeatureIDs[fid] = true
	}
	var newFeatureIDs []string
	for fid := range currentFeatureIDs {
		if !prevFeatureIDs[fid] {
			newFeatureIDs = append(newFeatureIDs, fid)
		}
	}
	var removedFeatureIDs []string
	for fid := range prevFeatureIDs {
		if !currentFeatureIDs[fid] {
			removedFeatureIDs = append(removedFeatureIDs, fid)
		}
	}
	var newFeatures []model.Feature
	for _, fid := range newFeatureIDs {
		f, err := h.db.GetFeature(fid)
		if err != nil || f == nil {
			continue
		}
		newFeatures = append(newFeatures, *f)
	}

	if newFindings == nil {
		newFindings = []model.Finding{}
	}
	if removedIDs == nil {
		removedIDs = []string{}
	}
	if changedFiles == nil {
		changedFiles = []model.FileStat{}
	}
	if newFeatures == nil {
		newFeatures = []model.Feature{}
	}
	if removedFeatureIDs == nil {
		removedFeatureIDs = []string{}
	}

	stats, err := h.buildStats(scope)
	if err != nil {
		return nil, err
	}

	profile, err := serviceProfileIfConfigured(h.db)
	if err != nil {
		return nil, err
	}

	return &model.BaselineDelta{
		ServiceProfile:    profile,
		SinceBaseline:     current,
		HeadCommit:        current.CommitID,
		NewFindings:       newFindings,
		RemovedFindingIDs: removedIDs,
		ChangedFiles:      changedFiles,
		CurrentStats:      stats,
		NewFeatures:       newFeatures,
		RemovedFeatureIDs: removedFeatureIDs,
	}, nil
}

// buildStats counts the findings, comments and features on the scope's branch.
func (h *baselineHandlers) buildStats(scope *review.Scope) (model.ProjectStats, error) {
	stats := model.ProjectStats{
		BySeverity: make(map[string]int),
		ByStatus:   make(map[string]int),
		ByCategory: make(map[string]int),
		ByKind:     make(map[string]int),
	}

	findings, _, err := h.db.ListFindings("", 0, 0)
	if err != nil {
		return model.ProjectStats{}, err
	}
	for _, f := range findings {
		if !scope.Has(f.Anchor.CommitID) {
			continue
		}
		stats.FindingsTotal++
		stats.BySeverity[f.Severity]++
		stats.ByStatus[f.Status]++
		if f.Category != "" {
			stats.ByCategory[f.Category]++
		}
		if f.Status == "draft" || f.Status == "open" || f.Status == "in-progress" {
			stats.FindingsOpen++
		}
	}

	comments, _, err := h.db.ListComments("", "", 0, 0)
	if err != nil {
		return model.ProjectStats{}, err
	}
	for _, c := range comments {
		if !scope.Has(c.Anchor.CommitID) {
			continue
		}
		stats.CommentsTotal++
		if c.ResolvedCommit == nil {
			stats.CommentsOpen++
		}
	}

	features, _, err := h.db.ListFeatures("", "", 0, 0)
	if err != nil {
		return model.ProjectStats{}, err
	}
	for _, f := range features {
		if !scope.Has(f.Anchor.CommitID) {
			continue
		}
		stats.FeaturesTotal++
		if f.Status == "draft" || f.Status == "active" {
			stats.FeaturesActive++
		}
		stats.ByKind[f.Kind]++
	}

	return stats, nil
}
