package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"bench/internal/events"
	"bench/internal/model"
	"bench/internal/review"

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
		Description: "Set a baseline - snapshot the current state of all findings and comments. Creates an atomic checkpoint that can be compared against future state to see what changed. Defaults to the head of the review branch if no commit specified. Configure the service profile (update_service_profile) before a project's first baseline.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {` + branchProp + `
				"reviewer": {"type": "string", "description": "Reviewer identifier (default: 'mcp-client')"},
				"summary": {"type": "string", "description": "Optional summary note for this baseline"},
				"commit": {"type": "string", "description": "Commit hash or ref to set baseline at (default: the review branch's head)"}
			}
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				Reviewer string `json:"reviewer"`
				Summary  string `json:"summary"`
				CommitID string `json:"commit"`
				Branch   string `json:"branch"`
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
				head, err = deps.tip(p.Branch)
				if err != nil {
					return "", err
				}
			}

			stats, err := buildBaselineStats(deps, review.NewScope(deps.repo, head))
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

			featureIDs, err := deps.db.AllFeatureIDs()
			if err != nil {
				return "", fmt.Errorf("list feature ids: %w", err)
			}
			if featureIDs == nil {
				featureIDs = []string{}
			}

			baseline := &model.Baseline{
				ID:             uuid.New().String(),
				CommitID:       head,
				Reviewer:       p.Reviewer,
				Summary:        p.Summary,
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

			if err := deps.db.CreateBaseline(baseline); err != nil {
				return "", err
			}

			// Pin the commit so it survives rebases / GC. Best-effort.
			if err := deps.repo.PinCommit(head); err != nil {
				log.Printf("[baselines] pin commit %s failed: %v", head, err)
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
		Description: "Delete a baseline by ID. By default returns a preview of what would be deleted. Set confirm=true to actually delete.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"baseline": {"type": "string", "description": "Baseline ID to delete"},
				"confirm": {"type": "boolean", "description": "Set to true to actually delete. Without this, returns a preview of what would be removed.", "default": false}
			},
			"required": ["baseline"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				BaselineID string `json:"baseline"`
				Confirm    bool   `json:"confirm"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.BaselineID == "" {
				return "", fmt.Errorf("baseline is required")
			}

			// Always fetch the baseline first for validation / preview.
			baseline, err := deps.db.GetBaselineByID(p.BaselineID)
			if err != nil {
				return "", err
			}
			if baseline == nil {
				return "", fmt.Errorf("baseline not found")
			}

			// Dry-run: show what would be deleted.
			if !p.Confirm {
				latest, _ := deps.db.GetLatestBaseline()
				isLatest := latest != nil && latest.ID == baseline.ID

				var sb strings.Builder
				fmt.Fprintf(&sb, "Dry run - baseline BL-%d (at %s by %s, %s) would be deleted.\n",
					baseline.Seq,
					baseline.CommitID[:minInt(7, len(baseline.CommitID))],
					baseline.Reviewer,
					baseline.CreatedAt)
				fmt.Fprintf(&sb, "Snapshot: %d findings (%d open), %d comments.\n",
					baseline.FindingsTotal, baseline.FindingsOpen, baseline.CommentsTotal)
				if baseline.Summary != "" {
					fmt.Fprintf(&sb, "Summary: %s\n", baseline.Summary)
				}
				if isLatest {
					sb.WriteString("⚠ This is the latest baseline. Deleting it changes what get_delta compares against.\n")
				}
				sb.WriteString("\nTo proceed, call delete_baseline with confirm: true.")
				return sb.String(), nil
			}

			if err := deps.db.DeleteBaseline(p.BaselineID); err != nil {
				return "", err
			}
			if deps.broker != nil {
				deps.broker.Publish(events.TopicBaselines)
			}
			return fmt.Sprintf("Baseline BL-%d (%s) deleted.", baseline.Seq, p.BaselineID[:minInt(8, len(p.BaselineID))]), nil
		},
	}
}

func toolGetDelta(deps *toolDeps) Tool {
	return Tool{
		Name:        "get_delta",
		Description: "Get changes on the review branch since its latest baseline: new findings and features, removed findings, and changed files. Without baseline, compares the branch's latest baseline against the branch's current state. With baseline, compares that baseline against its predecessor in its own history (what that baseline introduced). The response embeds the service profile.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {` + branchProp + `
				"baseline": {"type": "string", "description": "Specific baseline ID. Shows what this baseline introduced compared to the previous baseline. If omitted, shows what changed since the latest baseline."}
			}
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				BaselineID string `json:"baseline"`
				Branch     string `json:"branch"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}

			// When a specific baseline is given, compare it against its predecessor.
			// When omitted, compare the latest baseline against current live state.
			if p.BaselineID != "" {
				return deltaForBaseline(deps, p.BaselineID)
			}
			return deltaSinceLatest(deps, p.Branch)
		},
	}
}

// maxBaselines bounds the baselines read to find a branch's.
const maxBaselines = 1000

// latestOn is the most recent baseline on the scope's branch, nil if none.
func latestOn(deps *toolDeps, scope *review.Scope) (*model.Baseline, error) {
	baselines, err := deps.db.ListBaselines(maxBaselines)
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

// deltaSinceLatest compares the review branch's latest baseline against the
// branch's current state.
func deltaSinceLatest(deps *toolDeps, branch string) (string, error) {
	b, err := deps.reviewBranch(branch)
	if err != nil {
		return "", err
	}
	scope := review.NewScope(deps.repo, b.Tip)
	baseline, err := latestOn(deps, scope)
	if err != nil {
		return "", err
	}
	if baseline == nil {
		return fmt.Sprintf("No baselines yet on %s.", b.Name), nil
	}

	baselineIDs := make(map[string]bool, len(baseline.FindingIDs))
	for _, id := range baseline.FindingIDs {
		baselineIDs[id] = true
	}

	currentFindings, _, err := deps.db.ListFindings("", 0, 0)
	if err != nil {
		return "", err
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

	baselineFeatureIDs := make(map[string]bool, len(baseline.FeatureIDs))
	for _, id := range baseline.FeatureIDs {
		baselineFeatureIDs[id] = true
	}
	currentFeatures, _, err := deps.db.ListFeatures("", "", 0, 0)
	if err != nil {
		return "", err
	}
	var newFeatures []model.Feature
	for _, f := range currentFeatures {
		if !baselineFeatureIDs[f.ID] && scope.Has(f.Anchor.CommitID) {
			newFeatures = append(newFeatures, f)
		}
	}

	var removedCount int
	for _, id := range baseline.FindingIDs {
		if !currentIDs[id] {
			removedCount++
		}
	}

	// Diff against the review branch's head
	var changedFiles []model.FileStat
	if stats, err := deps.repo.DiffStat(baseline.CommitID, b.Tip); err == nil {
		changedFiles = stats
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "## Changes since baseline (%s)\n\n", describeBranch(b))
	fmt.Fprintf(&sb, "Baseline: BL-%d %s (at %s by %s)\n", baseline.Seq, baseline.CreatedAt, baseline.CommitID[:minInt(7, len(baseline.CommitID))], baseline.Reviewer)
	if baseline.Summary != "" {
		fmt.Fprintf(&sb, "Summary: %s\n", baseline.Summary)
	}
	fmt.Fprintf(&sb, "\n### New findings: %d\n", len(newFindings))
	for _, f := range newFindings {
		fmt.Fprintf(&sb, "- [%s] %s (%s) in %s\n", f.Severity, f.Title, f.Status, f.Anchor.FileID)
	}
	fmt.Fprintf(&sb, "\n### Removed findings: %d\n", removedCount)
	fmt.Fprintf(&sb, "\n### New features: %d\n", len(newFeatures))
	for _, f := range newFeatures {
		fmt.Fprintf(&sb, "- [%s] %s (%s) in %s\n", f.Kind, f.Title, f.Status, f.Anchor.FileID)
	}
	fmt.Fprintf(&sb, "\n### Changed files: %d\n", len(changedFiles))
	for _, f := range changedFiles {
		fmt.Fprintf(&sb, "- %s (+%d/-%d)\n", f.Path, f.Added, f.Deleted)
	}

	sb.WriteString(profileSection(deps))

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

	// The previous baseline: the one before it in its own history.
	scope := review.NewScope(deps.repo, baseline.CommitID)
	var prev *model.Baseline
	earlier, err := deps.db.BaselinesBefore(baseline.ID, maxBaselines)
	if err != nil {
		return "", err
	}
	for i := range earlier {
		if scope.Has(earlier[i].CommitID) {
			prev = &earlier[i]
			break
		}
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

	sb.WriteString(profileSection(deps))

	return sb.String(), nil
}

func toolListBaselines(deps *toolDeps) Tool {
	return Tool{
		Name:        "list_baselines",
		Description: "List the review branch's baselines, newest first. Shows commit, reviewer, findings/comments counts for each.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {` + branchProp + allBranchesProp + `
				"limit": {"type": "integer", "description": "Maximum number of baselines to return (default: 20)"}
			}
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				Limit       int    `json:"limit"`
				Branch      string `json:"branch"`
				AllBranches bool   `json:"all_branches"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.Limit <= 0 {
				p.Limit = 20
			}

			scope, err := deps.scope(p.Branch, p.AllBranches)
			if err != nil {
				return "", err
			}
			// Read them all when filtering, so the limit counts the branch's.
			read := p.Limit
			if scope != nil {
				read = maxBaselines
			}
			baselines, err := deps.db.ListBaselines(read)
			if err != nil {
				return "", err
			}
			baselines, off := keepOnBranch(scope, baselines, func(b model.Baseline) string { return b.CommitID })
			if len(baselines) > p.Limit {
				baselines = baselines[:p.Limit]
			}
			if len(baselines) == 0 {
				return "No baselines found." + offBranchNote(scope, off), nil
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
			sb.WriteString(offBranchNote(scope, off))
			return sb.String(), nil
		},
	}
}

// buildBaselineStats computes ProjectStats for a baseline snapshot: what is
// anchored on the scope's branch.
func buildBaselineStats(deps *toolDeps, scope *review.Scope) (model.ProjectStats, error) {
	stats := model.ProjectStats{
		BySeverity: make(map[string]int),
		ByStatus:   make(map[string]int),
		ByCategory: make(map[string]int),
		ByKind:     make(map[string]int),
	}

	findings, _, err := deps.db.ListFindings("", 0, 0)
	if err != nil {
		return model.ProjectStats{}, fmt.Errorf("list findings: %w", err)
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

	comments, _, err := deps.db.ListComments("", "", 0, 0)
	if err != nil {
		return model.ProjectStats{}, fmt.Errorf("list comments: %w", err)
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

	features, _, err := deps.db.ListFeatures("", "", 0, 0)
	if err != nil {
		return model.ProjectStats{}, fmt.Errorf("list features: %w", err)
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
