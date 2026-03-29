package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"bench/internal/db"
	"bench/internal/events"
	"bench/internal/git"
	"bench/internal/model"

	"github.com/google/uuid"
)

type baselineHandlers struct {
	db     *db.DB
	repo   *git.Repo
	broker *events.Broker
}

// GET /api/baselines — list all baselines (most recent first)
func (h *baselineHandlers) list(w http.ResponseWriter, r *http.Request) {
	limit := 20
	if s := r.URL.Query().Get("limit"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n > 0 {
			limit = n
		}
	}
	baselines, err := h.db.ListBaselines(limit)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if baselines == nil {
		baselines = []model.Baseline{}
	}
	writeJSON(w, http.StatusOK, baselines)
}

// GET /api/baselines/latest — most recent baseline
func (h *baselineHandlers) latest(w http.ResponseWriter, r *http.Request) {
	baseline, err := h.db.GetLatestBaseline()
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

// GET /api/baselines/delta — changes since latest baseline
func (h *baselineHandlers) delta(w http.ResponseWriter, r *http.Request) {
	baseline, err := h.db.GetLatestBaseline()
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if baseline == nil {
		writeError(w, http.StatusNotFound, "no baselines")
		return
	}

	delta, err := h.computeDelta(baseline)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, delta)
}

// GET /api/baselines/{id}/delta — delta for a specific baseline vs previous
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

	// Find the previous baseline
	prev, err := h.db.GetPreviousBaseline(baseline.ID)
	if err != nil {
		writeInternalError(w, err)
		return
	}

	delta, err := h.computeDeltaBetween(baseline, prev)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, delta)
}

// POST /api/baselines — create a new baseline (defaults to default branch tip)
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
		// Default to the tip of the default branch, not HEAD
		defaultBranch := h.repo.DefaultBranch()
		head, err = h.repo.BranchTip(defaultBranch)
		if err != nil {
			// Fallback to HEAD if default branch can't be resolved
			head, err = h.repo.Head()
			if err != nil {
				writeInternalError(w, fmt.Errorf("resolve HEAD: %w", err))
				return
			}
		}
	}

	stats, err := h.buildStats()
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

// PATCH /api/baselines/{id} — update mutable fields (reviewer, summary)
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
func (h *baselineHandlers) delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "baseline id is required")
		return
	}
	if err := h.db.DeleteBaseline(id); err != nil {
		if strings.Contains(err.Error(), "not found") {
			writeError(w, http.StatusNotFound, "baseline not found")
		} else {
			writeInternalError(w, err)
		}
		return
	}
	if h.broker != nil {
		h.broker.Publish(events.TopicBaselines)
	}
	w.WriteHeader(http.StatusNoContent)
}

// computeDelta calculates delta since a baseline against the current state.
// Git diff is computed against the tip of the default branch (not HEAD).
func (h *baselineHandlers) computeDelta(baseline *model.Baseline) (*model.BaselineDelta, error) {
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

	currentIDs := make(map[string]bool)
	var newFindings []model.Finding
	for _, f := range currentFindings {
		currentIDs[f.ID] = true
		if !baselineIDs[f.ID] {
			newFindings = append(newFindings, f)
		}
	}

	var removedIDs []string
	for _, id := range baseline.FindingIDs {
		if !currentIDs[id] {
			removedIDs = append(removedIDs, id)
		}
	}

	// Resolve the default branch tip (not HEAD) for git diff
	defaultBranch := h.repo.DefaultBranch()
	var headCommit string
	var changedFiles []model.FileStat
	tip, err := h.repo.BranchTip(defaultBranch)
	if err == nil {
		headCommit = tip
		stats, err := h.repo.DiffStat(baseline.CommitID, tip)
		if err == nil {
			changedFiles = stats
		}
	}

	projStats, err := h.buildStats()
	if err != nil {
		return nil, err
	}

	// Feature delta
	baselineFeatureIDs := make(map[string]bool, len(baseline.FeatureIDs))
	for _, id := range baseline.FeatureIDs {
		baselineFeatureIDs[id] = true
	}
	currentFeatures, _, _ := h.db.ListFeatures("", 0, 0)
	currentFeatureIDs := make(map[string]bool)
	var newFeatures []model.Feature
	for _, f := range currentFeatures {
		currentFeatureIDs[f.ID] = true
		if !baselineFeatureIDs[f.ID] {
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

	return &model.BaselineDelta{
		SinceBaseline:     baseline,
		HeadCommit:        headCommit,
		NewFindings:       newFindings,
		RemovedFindingIDs: removedIDs,
		ChangedFiles:      changedFiles,
		CurrentStats:      projStats,
		NewFeatures:       newFeatures,
		RemovedFeatureIDs: removedFeatureIDs,
	}, nil
}

// computeDeltaBetween calculates delta between two baselines (current vs previous).
func (h *baselineHandlers) computeDeltaBetween(current, prev *model.Baseline) (*model.BaselineDelta, error) {
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

	stats, err := h.buildStats()
	if err != nil {
		return nil, err
	}

	return &model.BaselineDelta{
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

// buildStats computes current ProjectStats.
func (h *baselineHandlers) buildStats() (model.ProjectStats, error) {
	summary, err := h.db.FindingSummary()
	if err != nil {
		return model.ProjectStats{}, err
	}
	openComments, err := h.db.UnresolvedCommentCount()
	if err != nil {
		return model.ProjectStats{}, err
	}

	stats := model.ProjectStats{
		BySeverity: make(map[string]int),
		ByStatus:   make(map[string]int),
		ByCategory: make(map[string]int),
	}
	for _, row := range summary {
		stats.FindingsTotal += row.Count
		stats.BySeverity[row.Severity] += row.Count
		stats.ByStatus[row.Status] += row.Count
		if row.Status == "draft" || row.Status == "open" || row.Status == "in-progress" {
			stats.FindingsOpen += row.Count
		}
	}

	cats, err := h.db.FindingCategorySummary()
	if err != nil {
		return model.ProjectStats{}, err
	}
	stats.ByCategory = cats

	comments, _, err := h.db.ListComments("", "", 0, 0)
	if err != nil {
		return model.ProjectStats{}, err
	}
	stats.CommentsTotal = len(comments)
	stats.CommentsOpen = openComments

	// Add features stats
	allFeatures, _, _ := h.db.ListFeatures("", 0, 0)
	byKind := make(map[string]int)
	for _, f := range allFeatures {
		stats.FeaturesTotal++
		if f.Status == "draft" || f.Status == "active" {
			stats.FeaturesActive++
		}
		byKind[f.Kind]++
	}
	stats.ByKind = byKind

	return stats, nil
}
