package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

func registerAnalyticsTools(deps *toolDeps) []Tool {
	return []Tool{
		toolGetSummary(deps),
		toolSearchFindings(deps),
		toolMarkReviewed(deps),
		toolGetCoverage(deps),
	}
}

func toolGetSummary(deps *toolDeps) Tool {
	return Tool{
		Name:        "get_summary",
		Description: "Get a summary of the current state: total findings by severity and status, total comments, unresolved items, reconciliation coverage.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"commit": {"type": "string", "description": "Summarize at this commit (default: HEAD)"}
			}
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				Commit string `json:"commit"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}

			head, err := deps.repo.Head()
			if err != nil {
				return "", fmt.Errorf("resolve HEAD: %w", err)
			}
			if p.Commit == "" {
				p.Commit = head
			}

			summary, err := deps.db.FindingSummary()
			if err != nil {
				return "", err
			}

			unresolvedComments, err := deps.db.UnresolvedCommentCount()
			if err != nil {
				return "", err
			}

			reconHead, err := deps.reconciler.GetReconciledHead()
			if err != nil {
				return "", err
			}

			// Format summary
			var sb strings.Builder
			fmt.Fprintf(&sb, "## Review Summary (at %s)\n\n", p.Commit[:minInt(7, len(p.Commit))])

			// Group by severity
			fmt.Fprintf(&sb, "### Findings\n")
			type sevGroup struct {
				counts map[string]int
				total  int
			}
			sevOrder := []string{"critical", "high", "medium", "low", "info"}
			groups := make(map[string]*sevGroup)
			totalFindings := 0
			for _, row := range summary {
				g, ok := groups[row.Severity]
				if !ok {
					g = &sevGroup{counts: make(map[string]int)}
					groups[row.Severity] = g
				}
				g.counts[row.Status] = row.Count
				g.total += row.Count
				totalFindings += row.Count
			}
			for _, sev := range sevOrder {
				g, ok := groups[sev]
				if !ok {
					continue
				}
				var parts []string
				for _, status := range []string{"draft", "open", "in-progress", "false-positive", "accepted", "closed"} {
					if c, ok := g.counts[status]; ok {
						parts = append(parts, fmt.Sprintf("%d %s", c, status))
					}
				}
				fmt.Fprintf(&sb, "%s: %s\n", sev, strings.Join(parts, ", "))
			}
			fmt.Fprintf(&sb, "\nTotal: %d findings\n", totalFindings)

			fmt.Fprintf(&sb, "\n### Comments\n")
			fmt.Fprintf(&sb, "%d unresolved comments\n", unresolvedComments)

			fmt.Fprintf(&sb, "\n### Reconciliation\n")
			if reconHead.IsFullyReconciled {
				fmt.Fprintf(&sb, "Fully reconciled: yes\n")
			} else {
				fmt.Fprintf(&sb, "Fully reconciled: no\n")
				if len(reconHead.Unreconciled) > 0 {
					var files []string
					for _, u := range reconHead.Unreconciled {
						files = append(files, u.FileID)
					}
					fmt.Fprintf(&sb, "Unreconciled files: %d (%s)\n", len(files), strings.Join(files, ", "))
				}
			}

			return sb.String(), nil
		},
	}
}

func toolSearchFindings(deps *toolDeps) Tool {
	return Tool{
		Name:        "search_findings",
		Description: "Full-text search across finding titles and descriptions. Use this when you know a keyword or concept (e.g. 'injection', 'token', 'eval'). For structured filtering by severity, status, or file, use list_findings instead.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"query": {"type": "string", "description": "Search text (matched against title and description)"},
				"status": {"type": "string", "enum": ["draft", "open", "in-progress", "false-positive", "accepted", "closed"]},
				"severity": {"type": "string", "enum": ["critical", "high", "medium", "low", "info"]}
			},
			"required": ["query"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				Query    string `json:"query"`
				Status   string `json:"status"`
				Severity string `json:"severity"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.Query == "" {
				return "", fmt.Errorf("query is required")
			}

			findings, err := deps.db.SearchFindings(p.Query, p.Status, p.Severity, 50)
			if err != nil {
				return "", err
			}
			if len(findings) == 0 {
				return "No findings match the search.", nil
			}

			b, err := json.MarshalIndent(findings, "", "  ")
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("%d finding(s) matching \"%s\":\n%s", len(findings), p.Query, string(b)), nil
		},
	}
}

func toolMarkReviewed(deps *toolDeps) Tool {
	return Tool{
		Name:        "mark_reviewed",
		Description: "Mark a file or directory as reviewed at a specific commit. Tracks review coverage so multi-session reviews can pick up where they left off.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"path": {"type": "string", "description": "File or directory path"},
				"commit": {"type": "string", "description": "Commit at which the review was performed"},
				"reviewer": {"type": "string", "description": "Reviewer identifier (default: 'mcp-client')"},
				"note": {"type": "string", "description": "Optional note (e.g. 'no issues found', 'needs deeper look at auth logic')"}
			},
			"required": ["path", "commit"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				Path     string `json:"path"`
				Commit   string `json:"commit"`
				Reviewer string `json:"reviewer"`
				Note     string `json:"note"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.Path == "" || p.Commit == "" {
				return "", fmt.Errorf("path and commit are required")
			}
			if p.Reviewer == "" {
				p.Reviewer = "mcp-client"
			}

			if err := deps.db.MarkReviewed(p.Path, p.Commit, p.Reviewer, p.Note); err != nil {
				return "", err
			}
			return fmt.Sprintf("Marked %s as reviewed at %s by %s.", p.Path, p.Commit[:minInt(7, len(p.Commit))], p.Reviewer), nil
		},
	}
}

func toolGetCoverage(deps *toolDeps) Tool {
	return Tool{
		Name:        "get_coverage",
		Description: "Get file-level review coverage: which files have been reviewed, which haven't, and whether reviews are stale (file changed since last review).",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"commit": {"type": "string", "description": "Target commit to check coverage against (default: HEAD)"},
				"path": {"type": "string", "description": "Scope to files under this directory prefix"},
				"only_unreviewed": {"type": "boolean", "description": "Only return unreviewed files (default: false)"}
			}
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				Commit         string `json:"commit"`
				Path           string `json:"path"`
				OnlyUnreviewed bool   `json:"only_unreviewed"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.Commit == "" {
				head, err := deps.repo.Head()
				if err != nil {
					return "", fmt.Errorf("resolve HEAD: %w", err)
				}
				p.Commit = head
			}

			// Get all files at commit
			entries, err := deps.repo.Tree(p.Commit)
			if err != nil {
				return "", err
			}

			// Get review progress
			progress, err := deps.db.GetReviewProgress(p.Path)
			if err != nil {
				return "", err
			}
			progressMap := make(map[string]*struct {
				commitID   string
				reviewer   string
				note       string
				reviewedAt string
			})
			for _, rp := range progress {
				progressMap[rp.FileID] = &struct {
					commitID   string
					reviewer   string
					note       string
					reviewedAt string
				}{rp.CommitID, rp.Reviewer, rp.Note, rp.ReviewedAt}
			}

			// Build coverage
			var files []map[string]string
			reviewed, unreviewed, stale := 0, 0, 0

			for _, e := range entries {
				if p.Path != "" && !strings.HasPrefix(e.Path, p.Path) {
					continue
				}
				rp, ok := progressMap[e.Path]
				if !ok {
					unreviewed++
					if !p.OnlyUnreviewed {
						files = append(files, map[string]string{
							"path":   e.Path,
							"status": "unreviewed",
						})
					} else {
						files = append(files, map[string]string{
							"path":   e.Path,
							"status": "unreviewed",
						})
					}
					continue
				}
				if p.OnlyUnreviewed {
					reviewed++
					continue
				}

				// Check staleness: was file modified since review?
				changed, err := deps.repo.DiffFiles(rp.commitID, p.Commit)
				if err != nil {
					// Can't check staleness — assume reviewed
					reviewed++
					files = append(files, map[string]string{
						"path":        e.Path,
						"status":      "reviewed",
						"reviewed_at": rp.reviewedAt,
						"reviewer":    rp.reviewer,
					})
					continue
				}
				isStale := false
				for _, f := range changed {
					if f == e.Path {
						isStale = true
						break
					}
				}
				if isStale {
					stale++
					files = append(files, map[string]string{
						"path":        e.Path,
						"status":      "stale",
						"reviewed_at": rp.reviewedAt,
						"reviewer":    rp.reviewer,
					})
				} else {
					reviewed++
					files = append(files, map[string]string{
						"path":        e.Path,
						"status":      "reviewed",
						"reviewed_at": rp.reviewedAt,
						"reviewer":    rp.reviewer,
					})
				}
			}

			totalFiles := reviewed + unreviewed + stale
			coveragePct := 0.0
			if totalFiles > 0 {
				coveragePct = float64(reviewed) / float64(totalFiles) * 100
			}

			result := map[string]any{
				"total_files":  totalFiles,
				"reviewed":     reviewed,
				"unreviewed":   unreviewed,
				"stale":        stale,
				"coverage_pct": fmt.Sprintf("%.1f", coveragePct),
				"files":        files,
			}
			b, err := json.MarshalIndent(result, "", "  ")
			if err != nil {
				return "", err
			}
			return string(b), nil
		},
	}
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
