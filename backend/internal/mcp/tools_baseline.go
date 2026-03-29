package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"bench/internal/events"
	"bench/internal/model"

	"github.com/google/uuid"
)

func registerBaselineTools(deps *toolDeps) []Tool {
	return []Tool{
		toolSetBaseline(deps),
		toolDeleteBaseline(deps),
		toolGetDelta(deps),
		toolListBaselines(deps),
	}
}

func toolSetBaseline(deps *toolDeps) Tool {
	return Tool{
		Name:        "set_baseline",
		Description: "Set a baseline — snapshot the current state of all findings and comments. Creates an atomic checkpoint that can be compared against future state to see what changed. Defaults to the tip of the default branch (e.g. main) if no commit specified.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"reviewer": {"type": "string", "description": "Reviewer identifier (default: 'mcp-client')"},
				"summary": {"type": "string", "description": "Optional summary note for this baseline"},
				"commit": {"type": "string", "description": "Commit hash or ref to set baseline at (default: tip of default branch)"}
			}
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				Reviewer string `json:"reviewer"`
				Summary  string `json:"summary"`
				CommitID string `json:"commit"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.Reviewer == "" {
				p.Reviewer = "mcp-client"
			}

			var head string
			var err error
			if p.CommitID != "" {
				head, err = deps.repo.ResolveRef(p.CommitID)
				if err != nil {
					return "", fmt.Errorf("invalid commit: %w", err)
				}
			} else {
				// Default to the tip of the default branch, not HEAD
				defaultBranch := deps.repo.DefaultBranch()
				head, err = deps.repo.BranchTip(defaultBranch)
				if err != nil {
					// Fallback to HEAD
					head, err = deps.repo.Head()
					if err != nil {
						return "", fmt.Errorf("resolve HEAD: %w", err)
					}
				}
			}

			stats, err := buildBaselineStats(deps)
			if err != nil {
				return "", err
			}

			findingIDs, err := deps.db.AllFindingIDs()
			if err != nil {
				return "", fmt.Errorf("list finding ids: %w", err)
			}
			if findingIDs == nil {
				findingIDs = []string{}
			}

			baseline := &model.Baseline{
				ID:            uuid.New().String(),
				CommitID:      head,
				Reviewer:      p.Reviewer,
				Summary:       p.Summary,
				FindingsTotal: stats.FindingsTotal,
				FindingsOpen:  stats.FindingsOpen,
				BySeverity:    stats.BySeverity,
				ByStatus:      stats.ByStatus,
				ByCategory:    stats.ByCategory,
				CommentsTotal: stats.CommentsTotal,
				CommentsOpen:  stats.CommentsOpen,
				FindingIDs:    findingIDs,
			}

			if err := deps.db.CreateBaseline(baseline); err != nil {
				return "", err
			}

			// Re-read to get server-assigned seq
			created, err := deps.db.GetBaselineByID(baseline.ID)
			if err == nil && created != nil {
				baseline = created
			}

			if deps.broker != nil {
				deps.broker.Publish(events.TopicBaselines)
			}
			return fmt.Sprintf("Baseline BL-%d set at %s by %s. %d findings (%d open), %d comments. ID: %s",
				baseline.Seq, head[:minInt(7, len(head))], p.Reviewer,
				stats.FindingsTotal, stats.FindingsOpen, stats.CommentsTotal,
				baseline.ID), nil
		},
	}
}

func toolDeleteBaseline(deps *toolDeps) Tool {
	return Tool{
		Name:        "delete_baseline",
		Description: "Delete a baseline by ID. The baseline and its snapshot data are permanently removed.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"baseline_id": {"type": "string", "description": "Baseline ID to delete"}
			},
			"required": ["baseline_id"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				BaselineID string `json:"baseline_id"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.BaselineID == "" {
				return "", fmt.Errorf("baseline_id is required")
			}

			if err := deps.db.DeleteBaseline(p.BaselineID); err != nil {
				return "", err
			}
			if deps.broker != nil {
				deps.broker.Publish(events.TopicBaselines)
			}
			return fmt.Sprintf("Baseline %s deleted.", p.BaselineID[:minInt(8, len(p.BaselineID))]), nil
		},
	}
}

func toolGetDelta(deps *toolDeps) Tool {
	return Tool{
		Name:        "get_delta",
		Description: "Get changes since the last baseline: new findings, removed findings, and changed files. Without baseline_id, compares the latest baseline against the current state. With baseline_id, compares that baseline against its predecessor (what that baseline introduced).",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"baseline_id": {"type": "string", "description": "Specific baseline ID. Shows what this baseline introduced compared to the previous baseline. If omitted, shows what changed since the latest baseline."}
			}
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				BaselineID string `json:"baseline_id"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}

			// When a specific baseline is given, compare it against its predecessor.
			// When omitted, compare the latest baseline against current live state.
			if p.BaselineID != "" {
				return deltaForBaseline(deps, p.BaselineID)
			}
			return deltaSinceLatest(deps)
		},
	}
}

// deltaSinceLatest compares the latest baseline against the current live state.
func deltaSinceLatest(deps *toolDeps) (string, error) {
	baseline, err := deps.db.GetLatestBaseline()
	if err != nil {
		return "", err
	}
	if baseline == nil {
		return "No baselines yet.", nil
	}

	baselineIDs := make(map[string]bool, len(baseline.FindingIDs))
	for _, id := range baseline.FindingIDs {
		baselineIDs[id] = true
	}

	currentFindings, _, err := deps.db.ListFindings("", 0, 0)
	if err != nil {
		return "", err
	}

	currentIDs := make(map[string]bool)
	var newFindings []model.Finding
	for _, f := range currentFindings {
		currentIDs[f.ID] = true
		if !baselineIDs[f.ID] {
			newFindings = append(newFindings, f)
		}
	}

	var removedCount int
	for _, id := range baseline.FindingIDs {
		if !currentIDs[id] {
			removedCount++
		}
	}

	// Diff against the default branch tip
	var changedFiles []model.FileStat
	defaultBranch := deps.repo.DefaultBranch()
	tip, err := deps.repo.BranchTip(defaultBranch)
	if err == nil {
		stats, err := deps.repo.DiffStat(baseline.CommitID, tip)
		if err == nil {
			changedFiles = stats
		}
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "## Changes since baseline\n\n")
	fmt.Fprintf(&sb, "Baseline: BL-%d %s (at %s by %s)\n", baseline.Seq, baseline.CreatedAt, baseline.CommitID[:minInt(7, len(baseline.CommitID))], baseline.Reviewer)
	if baseline.Summary != "" {
		fmt.Fprintf(&sb, "Summary: %s\n", baseline.Summary)
	}
	fmt.Fprintf(&sb, "\n### New findings: %d\n", len(newFindings))
	for _, f := range newFindings {
		fmt.Fprintf(&sb, "- [%s] %s (%s) in %s\n", f.Severity, f.Title, f.Status, f.Anchor.FileID)
	}
	fmt.Fprintf(&sb, "\n### Removed findings: %d\n", removedCount)
	fmt.Fprintf(&sb, "\n### Changed files: %d\n", len(changedFiles))
	for _, f := range changedFiles {
		fmt.Fprintf(&sb, "- %s (+%d/-%d)\n", f.Path, f.Added, f.Deleted)
	}

	return sb.String(), nil
}

// deltaForBaseline compares a specific baseline against its predecessor.
func deltaForBaseline(deps *toolDeps, baselineID string) (string, error) {
	baseline, err := deps.db.GetBaselineByID(baselineID)
	if err != nil {
		return "", err
	}
	if baseline == nil {
		return "", fmt.Errorf("baseline not found")
	}

	prev, err := deps.db.GetPreviousBaseline(baseline.ID)
	if err != nil {
		return "", err
	}

	// Build previous finding ID set
	prevIDs := make(map[string]bool)
	if prev != nil {
		for _, fid := range prev.FindingIDs {
			prevIDs[fid] = true
		}
	}

	// New = in this baseline but not in previous
	var newFindingIDs []string
	for _, fid := range baseline.FindingIDs {
		if !prevIDs[fid] {
			newFindingIDs = append(newFindingIDs, fid)
		}
	}

	// Removed = in previous but not in this baseline
	var removedCount int
	if prev != nil {
		for _, fid := range prev.FindingIDs {
			found := false
			for _, cid := range baseline.FindingIDs {
				if cid == fid {
					found = true
					break
				}
			}
			if !found {
				removedCount++
			}
		}
	}

	// Fetch full finding objects for new findings
	var newFindings []model.Finding
	var deletedNewCount int
	for _, fid := range newFindingIDs {
		f, err := deps.db.GetFinding(fid)
		if err != nil || f == nil {
			deletedNewCount++
			continue
		}
		newFindings = append(newFindings, *f)
	}

	// Git diff between the two baseline commits
	var changedFiles []model.FileStat
	if prev != nil {
		stats, err := deps.repo.DiffStat(prev.CommitID, baseline.CommitID)
		if err == nil {
			changedFiles = stats
		}
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "## Baseline BL-%d\n\n", baseline.Seq)
	fmt.Fprintf(&sb, "Baseline: BL-%d %s (at %s by %s)\n", baseline.Seq, baseline.CreatedAt, baseline.CommitID[:minInt(7, len(baseline.CommitID))], baseline.Reviewer)
	if baseline.Summary != "" {
		fmt.Fprintf(&sb, "Summary: %s\n", baseline.Summary)
	}
	if prev != nil {
		fmt.Fprintf(&sb, "Previous: BL-%d (at %s)\n", prev.Seq, prev.CommitID[:minInt(7, len(prev.CommitID))])
	} else {
		fmt.Fprintf(&sb, "Previous: none (first baseline)\n")
	}
	fmt.Fprintf(&sb, "Snapshot: %d findings (%d open), %d comments\n",
		baseline.FindingsTotal, baseline.FindingsOpen, baseline.CommentsTotal)
	fmt.Fprintf(&sb, "\n### New findings: %d\n", len(newFindings)+deletedNewCount)
	for _, f := range newFindings {
		fmt.Fprintf(&sb, "- [%s] %s (%s) in %s\n", f.Severity, f.Title, f.Status, f.Anchor.FileID)
	}
	if deletedNewCount > 0 {
		fmt.Fprintf(&sb, "- (%d finding(s) no longer in database)\n", deletedNewCount)
	}
	fmt.Fprintf(&sb, "\n### Removed findings: %d\n", removedCount)
	fmt.Fprintf(&sb, "\n### Changed files: %d\n", len(changedFiles))
	for _, f := range changedFiles {
		fmt.Fprintf(&sb, "- %s (+%d/-%d)\n", f.Path, f.Added, f.Deleted)
	}

	return sb.String(), nil
}

func toolListBaselines(deps *toolDeps) Tool {
	return Tool{
		Name:        "list_baselines",
		Description: "List all baselines for this project, newest first. Shows commit, reviewer, findings/comments counts for each.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"limit": {"type": "integer", "description": "Maximum number of baselines to return (default: 20)"}
			}
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				Limit int `json:"limit"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.Limit <= 0 {
				p.Limit = 20
			}

			baselines, err := deps.db.ListBaselines(p.Limit)
			if err != nil {
				return "", err
			}
			if len(baselines) == 0 {
				return "No baselines found.", nil
			}

			var sb strings.Builder
			fmt.Fprintf(&sb, "## Baselines (%d)\n\n", len(baselines))
			for _, b := range baselines {
				fmt.Fprintf(&sb, "- BL-%d %s by %s at %s",
					b.Seq, b.CreatedAt, b.Reviewer, b.CommitID[:minInt(7, len(b.CommitID))])
				fmt.Fprintf(&sb, " | %d findings (%d open), %d comments (%d open)",
					b.FindingsTotal, b.FindingsOpen, b.CommentsTotal, b.CommentsOpen)
				if b.Summary != "" {
					fmt.Fprintf(&sb, "\n  %s", b.Summary)
				}
				fmt.Fprintf(&sb, "\n  ID: %s\n\n", b.ID)
			}
			return sb.String(), nil
		},
	}
}

// buildBaselineStats computes current ProjectStats for a baseline snapshot.
func buildBaselineStats(deps *toolDeps) (model.ProjectStats, error) {
	summaryRows, err := deps.db.FindingSummary()
	if err != nil {
		return model.ProjectStats{}, fmt.Errorf("finding summary: %w", err)
	}
	openComments, err := deps.db.UnresolvedCommentCount()
	if err != nil {
		return model.ProjectStats{}, fmt.Errorf("comment count: %w", err)
	}

	stats := model.ProjectStats{
		BySeverity: make(map[string]int),
		ByStatus:   make(map[string]int),
		ByCategory: make(map[string]int),
	}
	for _, row := range summaryRows {
		stats.FindingsTotal += row.Count
		stats.BySeverity[row.Severity] += row.Count
		stats.ByStatus[row.Status] += row.Count
		if row.Status == "draft" || row.Status == "open" || row.Status == "in-progress" {
			stats.FindingsOpen += row.Count
		}
	}

	cats, err := deps.db.FindingCategorySummary()
	if err != nil {
		return model.ProjectStats{}, fmt.Errorf("category summary: %w", err)
	}
	stats.ByCategory = cats

	comments, _, err := deps.db.ListComments("", "", 0, 0)
	if err != nil {
		return model.ProjectStats{}, fmt.Errorf("list comments: %w", err)
	}
	stats.CommentsTotal = len(comments)
	stats.CommentsOpen = openComments

	return stats, nil
}
