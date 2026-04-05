package mcp

import (
	"context"
	"encoding/json"
	"fmt"
)

func registerReconcileTools(deps *toolDeps) []Tool {
	return []Tool{
		toolReconcile(deps),
		toolGetReconciliationStatus(deps),
		toolGetAnnotationHistory(deps),
	}
}

func toolReconcile(deps *toolDeps) Tool {
	return Tool{
		Name:        "reconcile",
		Description: "Start a reconciliation job to update annotation positions to a target commit. This traces diffs from the last reconciled point to the target, updating line positions for all findings and comments. Returns a job ID for status polling via get_reconciliation_status.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"target": {"type": "string", "description": "Commit to reconcile to (default: HEAD)"},
				"files": {"type": "array", "items": {"type": "string"}, "description": "Limit to specific file paths (default: all annotated files)"}
			}
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				TargetCommit string   `json:"target"`
				Files        []string `json:"files"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.TargetCommit == "" {
				head, err := deps.repo.Head()
				if err != nil {
					return "", fmt.Errorf("resolve HEAD: %w", err)
				}
				p.TargetCommit = head
			}

			jobID := deps.reconciler.StartJob(p.TargetCommit, p.Files)
			return fmt.Sprintf("Reconciliation job started: %s (target: %s)", jobID, p.TargetCommit), nil
		},
	}
}

func toolGetReconciliationStatus(deps *toolDeps) Tool {
	return Tool{
		Name:        "get_reconciliation_status",
		Description: "Get the reconciliation status. Without arguments, returns whether all annotated files are reconciled to the current HEAD. With a job, returns progress of a specific reconciliation job.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"job": {"type": "string", "description": "Specific job ID to check"},
				"file": {"type": "string", "description": "Check reconciliation status for a specific file"},
				"commit": {"type": "string", "description": "Check against this commit (used with file)"}
			}
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				JobID  string `json:"job"`
				File   string `json:"file"`
				Commit string `json:"commit"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}

			// Job status
			if p.JobID != "" {
				snap := deps.reconciler.GetJob(p.JobID)
				if snap == nil {
					return "", fmt.Errorf("job not found: %s", p.JobID)
				}
				b, err := json.MarshalIndent(snap, "", "  ")
				if err != nil {
					return "", err
				}
				return string(b), nil
			}

			// File-level status
			if p.File != "" {
				commit := p.Commit
				if commit == "" {
					head, err := deps.repo.Head()
					if err != nil {
						return "", fmt.Errorf("resolve HEAD: %w", err)
					}
					commit = head
				}
				status, err := deps.reconciler.GetFileStatus(p.File, commit)
				if err != nil {
					return "", err
				}
				b, err := json.MarshalIndent(status, "", "  ")
				if err != nil {
					return "", err
				}
				return string(b), nil
			}

			// Project-wide status
			head, err := deps.reconciler.GetReconciledHead()
			if err != nil {
				return "", err
			}
			b, err := json.MarshalIndent(head, "", "  ")
			if err != nil {
				return "", err
			}
			return string(b), nil
		},
	}
}

func toolGetAnnotationHistory(deps *toolDeps) Tool {
	return Tool{
		Name:        "get_annotation_history",
		Description: "Get the position history of a finding or comment across commits. Shows how the annotation's line position has changed, including confidence levels (exact, moved, orphaned).",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"id": {"type": "string", "description": "Finding or comment ID"},
				"type": {"type": "string", "enum": ["finding", "comment"], "description": "Annotation type"}
			},
			"required": ["id", "type"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				ID   string `json:"id"`
				Type string `json:"type"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.ID == "" || p.Type == "" {
				return "", fmt.Errorf("id and type are required")
			}
			if p.Type != "finding" && p.Type != "comment" {
				return "", fmt.Errorf("type must be 'finding' or 'comment'")
			}

			positions, err := deps.db.GetPositions(p.ID, p.Type)
			if err != nil {
				return "", err
			}
			if len(positions) == 0 {
				return "No position history found.", nil
			}

			b, err := json.MarshalIndent(positions, "", "  ")
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("Position history (%d entries):\n%s", len(positions), string(b)), nil
		},
	}
}
