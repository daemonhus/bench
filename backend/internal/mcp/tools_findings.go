package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"bench/internal/events"
	"bench/internal/model"
	"bench/internal/reconcile"

	"github.com/google/uuid"
)

func registerFindingTools(deps *toolDeps) []Tool {
	return []Tool{
		toolListFindings(deps),
		toolGetFinding(deps),
		toolCreateFinding(deps),
		toolUpdateFinding(deps),
		toolDeleteFinding(deps),
		toolResolveFinding(deps),
		toolBatchCreateFindings(deps),
		toolBatchResolveFindings(deps),
	}
}

func toolListFindings(deps *toolDeps) Tool {
	return Tool{
		Name:        "list_findings",
		Description: "List security findings (summary view). Returns id, severity, status, title, file, lines, category, and comment count for each finding. Use get_finding for full details including description. Note: include_resolved defaults to false — set it to true when checking for duplicates before creating new findings. Baseline snapshots include all findings (including resolved), so delta counts may differ from this tool's output unless include_resolved is true.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"file": {"type": "string", "description": "Filter by file path"},
				"status": {"type": "string", "enum": ["draft", "open", "in-progress", "false-positive", "accepted", "closed"], "description": "Filter by status"},
				"severity": {"type": "string", "enum": ["critical", "high", "medium", "low", "info"], "description": "Filter by severity"},
				"include_resolved": {"type": "boolean", "description": "Include resolved findings (default: false)"},
				"category": {"type": "string", "description": "Filter by category"}
			}
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				File            string `json:"file"`
				Status          string `json:"status"`
				Severity        string `json:"severity"`
				IncludeResolved bool   `json:"include_resolved"`
				Category        string `json:"category"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}

			findings, _, err := deps.db.ListFindings(p.File, 0, 0)
			if err != nil {
				return "", err
			}

			// Post-filter
			filtered := findings[:0]
			for _, f := range findings {
				if p.Status != "" && f.Status != p.Status {
					continue
				}
				if p.Severity != "" && f.Severity != p.Severity {
					continue
				}
				if p.Category != "" && f.Category != p.Category {
					continue
				}
				if !p.IncludeResolved && f.ResolvedCommit != nil {
					continue
				}
				filtered = append(filtered, f)
			}

			if len(filtered) == 0 {
				return "No findings found.", nil
			}

			// Enrich with comment counts
			ids := make([]string, len(filtered))
			for i := range filtered {
				ids[i] = filtered[i].ID
			}
			counts := make(map[string]int)
			if c, err := deps.db.CommentCountsByFinding(ids); err == nil {
				counts = c
			}

			// Return compact summary — use get_finding for full details
			type findingSummary struct {
				ID           string `json:"id"`
				Severity     string `json:"severity"`
				Status       string `json:"status"`
				Title        string `json:"title"`
				File         string `json:"file"`
				Lines        string `json:"lines,omitempty"`
				Category     string `json:"category,omitempty"`
				CWE          string `json:"cwe,omitempty"`
				CommentCount int    `json:"commentCount,omitempty"`
				Resolved     bool   `json:"resolved,omitempty"`
			}
			summaries := make([]findingSummary, len(filtered))
			for i, f := range filtered {
				s := findingSummary{
					ID:           f.ID,
					Severity:     f.Severity,
					Status:       f.Status,
					Title:        f.Title,
					File:         f.Anchor.FileID,
					Category:     f.Category,
					CWE:          f.CWE,
					CommentCount: counts[f.ID],
					Resolved:     f.ResolvedCommit != nil,
				}
				if f.Anchor.LineRange != nil {
					s.Lines = fmt.Sprintf("%d-%d", f.Anchor.LineRange.Start, f.Anchor.LineRange.End)
				}
				summaries[i] = s
			}

			b, err := json.MarshalIndent(summaries, "", "  ")
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("%d finding(s):\n%s", len(summaries), string(b)), nil
		},
	}
}

func toolGetFinding(deps *toolDeps) Tool {
	return Tool{
		Name:        "get_finding",
		Description: "Get full details of a finding by ID, including position history if available.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"id": {"type": "string", "description": "Finding ID"}
			},
			"required": ["id"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.ID == "" {
				return "", fmt.Errorf("id is required")
			}

			f, err := deps.db.GetFinding(p.ID)
			if err != nil {
				return "", fmt.Errorf("finding not found: %w", err)
			}

			// Enrich with comment count
			if counts, err := deps.db.CommentCountsByFinding([]string{f.ID}); err == nil {
				f.CommentCount = counts[f.ID]
			}

			b, err := json.MarshalIndent(f, "", "  ")
			if err != nil {
				return "", err
			}
			return string(b), nil
		},
	}
}

func toolCreateFinding(deps *toolDeps) Tool {
	return Tool{
		Name:        "create_finding",
		Description: "Create a new security finding anchored to a file location. The finding is tagged with source 'mcp' automatically. Always set line_start and line_end to anchor the finding to specific code. Descriptions should reference concrete code: function names, line numbers, variable names. Before creating a finding, call list_findings (with include_resolved=true) and check for existing findings on the same file. If a finding already exists that covers the same conceptual vulnerability (even with different line ranges, CWEs, or wording), update it instead of creating a duplicate.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"file": {"type": "string", "description": "File path"},
				"commit": {"type": "string", "description": "Commit where finding was identified"},
				"line_start": {"type": "integer", "description": "Start line number"},
				"line_end": {"type": "integer", "description": "End line number"},
				"severity": {"type": "string", "enum": ["critical", "high", "medium", "low", "info"]},
				"title": {"type": "string", "description": "Short title for the finding"},
				"description": {"type": "string", "description": "Detailed description of the vulnerability"},
				"cwe": {"type": "string", "description": "CWE identifier (e.g. CWE-79)"},
				"cve": {"type": "string", "description": "CVE identifier if applicable"},
				"external_id": {"type": "string", "description": "External identifier from source system (e.g. F001, VULN-42)"},
				"status": {"type": "string", "enum": ["draft", "open"], "description": "Initial status (default: draft)"},
				"category": {"type": "string", "description": "Finding category (e.g. auth, authz, session, injection, ssrf, crypto, data-exposure, input-validation, path-traversal, deserialization, race-condition, config, error-handling, logging, business-logic, dependencies)"}
			},
			"required": ["file", "commit", "severity", "title", "description"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				File        string `json:"file"`
				Commit      string `json:"commit"`
				LineStart   int    `json:"line_start"`
				LineEnd     int    `json:"line_end"`
				Severity    string `json:"severity"`
				Title       string `json:"title"`
				Description string `json:"description"`
				CWE         string `json:"cwe"`
				CVE         string `json:"cve"`
				ExternalID  string `json:"external_id"`
				Status      string `json:"status"`
				Category    string `json:"category"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.File == "" || p.Commit == "" || p.Severity == "" || p.Title == "" || p.Description == "" {
				return "", fmt.Errorf("file, commit, severity, title, and description are required")
			}
			if p.Status == "" {
				p.Status = "draft"
			}

			f := &model.Finding{
				ID:          uuid.New().String(),
				ExternalID:  p.ExternalID,
				Anchor:      model.Anchor{FileID: p.File, CommitID: p.Commit},
				Severity:    p.Severity,
				Title:       p.Title,
				Description: p.Description,
				CWE:         p.CWE,
				CVE:         p.CVE,
				Status:      p.Status,
				Source:      "mcp",
				Category:    p.Category,
				CreatedAt:   time.Now().UTC().Format(time.RFC3339),
			}
			if p.LineStart > 0 && p.LineEnd > 0 {
				f.Anchor.LineRange = &model.LineRange{Start: p.LineStart, End: p.LineEnd}
				// Compute lineHash
				content, err := deps.repo.Show(p.Commit, p.File)
				if err == nil {
					lines := strings.Split(content, "\n")
					start := p.LineStart - 1
					end := p.LineEnd
					if start >= 0 && end <= len(lines) {
						f.LineHash = reconcile.LineHash(lines[start:end])
					}
				}
			}

			if err := deps.db.CreateFinding(f); err != nil {
				return "", err
			}

			// Create initial position entry
			if f.Anchor.LineRange != nil {
				fileID := f.Anchor.FileID
				_ = deps.db.InsertPosition(&model.AnnotationPosition{
					AnnotationID:   f.ID,
					AnnotationType: "finding",
					CommitID:       f.Anchor.CommitID,
					FileID:         &fileID,
					LineStart:      &f.Anchor.LineRange.Start,
					LineEnd:        &f.Anchor.LineRange.End,
					Confidence:     "exact",
				})
			}

			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			return fmt.Sprintf("Created finding %s: %s (%s)", f.ID, f.Title, f.Severity), nil
		},
	}
}

func toolUpdateFinding(deps *toolDeps) Tool {
	return Tool{
		Name:        "update_finding",
		Description: "Update a finding's metadata. Only specified fields are changed. Supports updating line_start and line_end to correct anchor positions — line_hash is recomputed automatically when the line range changes.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"id": {"type": "string", "description": "Finding ID"},
				"severity": {"type": "string", "enum": ["critical", "high", "medium", "low", "info"]},
				"title": {"type": "string"},
				"description": {"type": "string"},
				"cwe": {"type": "string"},
				"cve": {"type": "string"},
				"external_id": {"type": "string", "description": "External identifier from source system"},
				"status": {"type": "string", "enum": ["draft", "open", "in-progress", "false-positive", "accepted", "closed"]},
				"category": {"type": "string", "description": "Finding category (e.g. auth, authz, session, injection, ssrf, crypto, data-exposure, input-validation, path-traversal, deserialization, race-condition, config, error-handling, logging, business-logic, dependencies)"},
				"line_start": {"type": "integer", "description": "Updated start line number"},
				"line_end": {"type": "integer", "description": "Updated end line number"}
			},
			"required": ["id"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var raw map[string]any
			if err := json.Unmarshal(params, &raw); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			id, _ := raw["id"].(string)
			if id == "" {
				return "", fmt.Errorf("id is required")
			}
			delete(raw, "id")

			// If line range is being updated, coerce JSON numbers to int and recompute line hash
			lineStartVal, hasStart := raw["line_start"]
			lineEndVal, hasEnd := raw["line_end"]
			if hasStart && hasEnd {
				lineStart := int(lineStartVal.(float64))
				lineEnd := int(lineEndVal.(float64))
				raw["line_start"] = lineStart
				raw["line_end"] = lineEnd
				existing, err := deps.db.GetFinding(id)
				if err == nil && existing.Anchor.CommitID != "" {
					content, err := deps.repo.Show(existing.Anchor.CommitID, existing.Anchor.FileID)
					if err == nil {
						lines := strings.Split(content, "\n")
						start := lineStart - 1
						end := lineEnd
						if start >= 0 && end <= len(lines) {
							raw["line_hash"] = reconcile.LineHash(lines[start:end])
						}
					}
				}
			}

			f, err := deps.db.UpdateFinding(id, raw)
			if err != nil {
				return "", err
			}

			// Record updated position entry when line range changed
			if hasStart && hasEnd && f != nil && f.Anchor.LineRange != nil {
				fileID := f.Anchor.FileID
				_ = deps.db.InsertPosition(&model.AnnotationPosition{
					AnnotationID:   f.ID,
					AnnotationType: "finding",
					CommitID:       f.Anchor.CommitID,
					FileID:         &fileID,
					LineStart:      &f.Anchor.LineRange.Start,
					LineEnd:        &f.Anchor.LineRange.End,
					Confidence:     "exact",
				})
			}

			b, err := json.MarshalIndent(f, "", "  ")
			if err != nil {
				return "", err
			}
			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			return fmt.Sprintf("Updated finding %s:\n%s", id, string(b)), nil
		},
	}
}

func toolDeleteFinding(deps *toolDeps) Tool {
	return Tool{
		Name:        "delete_finding",
		Description: "Delete a finding by ID. Any comments linked to the finding are preserved but their finding link is removed.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"id": {"type": "string", "description": "Finding ID to delete"}
			},
			"required": ["id"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.ID == "" {
				return "", fmt.Errorf("id is required")
			}

			// Report linked comment count before deletion
			counts, _ := deps.db.CommentCountsByFinding([]string{p.ID})
			commentCount := counts[p.ID]

			if err := deps.db.DeleteFinding(p.ID); err != nil {
				return "", err
			}

			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			if commentCount > 0 {
				return fmt.Sprintf("Deleted finding %s. %d linked comment(s) preserved (finding link removed).", p.ID, commentCount), nil
			}
			return fmt.Sprintf("Deleted finding %s.", p.ID), nil
		},
	}
}

func toolResolveFinding(deps *toolDeps) Tool {
	return Tool{
		Name:        "resolve_finding",
		Description: "Mark a finding as resolved at a specific commit. Sets resolvedCommit and transitions status to 'closed'. Before resolving, add a comment (with finding_id set) explaining why the finding is resolved.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"id": {"type": "string", "description": "Finding ID"},
				"commit": {"type": "string", "description": "Commit where the finding was resolved"}
			},
			"required": ["id", "commit"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				ID     string `json:"id"`
				Commit string `json:"commit"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.ID == "" || p.Commit == "" {
				return "", fmt.Errorf("id and commit are required")
			}

			_, err := deps.db.UpdateFinding(p.ID, map[string]any{
				"resolvedCommit": p.Commit,
				"status":         "closed",
			})
			if err != nil {
				return "", err
			}
			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			return fmt.Sprintf("Finding %s resolved at commit %s.", p.ID, p.Commit), nil
		},
	}
}

func toolBatchCreateFindings(deps *toolDeps) Tool {
	return Tool{
		Name:        "batch_create_findings",
		Description: "Create multiple security findings in one operation. All findings are inserted in a single transaction. Each finding is tagged with source 'mcp'. Returns the list of created finding IDs. Use this instead of repeated create_finding calls. Always set line_start and line_end to anchor findings to specific code. Descriptions should reference concrete code: function names, line numbers, variable names. Before creating findings, call list_findings (with include_resolved=true) and check for existing findings on the same files. If a finding already exists that covers the same conceptual vulnerability (even with different line ranges, CWEs, or wording), update it instead of creating a duplicate.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"findings": {
					"type": "array",
					"items": {
						"type": "object",
						"properties": {
							"file": {"type": "string"},
							"commit": {"type": "string"},
							"line_start": {"type": "integer"},
							"line_end": {"type": "integer"},
							"severity": {"type": "string", "enum": ["critical", "high", "medium", "low", "info"]},
							"title": {"type": "string"},
							"description": {"type": "string"},
							"cwe": {"type": "string"},
							"cve": {"type": "string"},
							"external_id": {"type": "string", "description": "External identifier from source system (e.g. F001, VULN-42)"},
							"status": {"type": "string", "enum": ["draft", "open"]},
							"category": {"type": "string", "description": "Finding category (e.g. auth, authz, session, injection, ssrf, crypto, data-exposure, input-validation, path-traversal, deserialization, race-condition, config, error-handling, logging, business-logic, dependencies)"}
						},
						"required": ["file", "commit", "severity", "title", "description"]
					},
					"description": "Array of findings to create (max 100)"
				}
			},
			"required": ["findings"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				Findings []struct {
					File        string `json:"file"`
					Commit      string `json:"commit"`
					LineStart   int    `json:"line_start"`
					LineEnd     int    `json:"line_end"`
					Severity    string `json:"severity"`
					Title       string `json:"title"`
					Description string `json:"description"`
					CWE         string `json:"cwe"`
					CVE         string `json:"cve"`
					ExternalID  string `json:"external_id"`
					Status      string `json:"status"`
					Category    string `json:"category"`
				} `json:"findings"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if len(p.Findings) == 0 {
				return "", fmt.Errorf("findings array is required and must not be empty")
			}
			if len(p.Findings) > 100 {
				return "", fmt.Errorf("maximum 100 findings per batch")
			}

			now := time.Now().UTC().Format(time.RFC3339)
			models := make([]model.Finding, len(p.Findings))
			for i, pf := range p.Findings {
				status := pf.Status
				if status == "" {
					status = "draft"
				}
				f := model.Finding{
					ID:          uuid.New().String(),
					ExternalID:  pf.ExternalID,
					Anchor:      model.Anchor{FileID: pf.File, CommitID: pf.Commit},
					Severity:    pf.Severity,
					Title:       pf.Title,
					Description: pf.Description,
					CWE:         pf.CWE,
					CVE:         pf.CVE,
					Status:      status,
					Source:      "mcp",
					Category:    pf.Category,
					CreatedAt:   now,
				}
				if pf.LineStart > 0 && pf.LineEnd > 0 {
					f.Anchor.LineRange = &model.LineRange{Start: pf.LineStart, End: pf.LineEnd}
					content, err := deps.repo.Show(pf.Commit, pf.File)
					if err == nil {
						lines := strings.Split(content, "\n")
						start := pf.LineStart - 1
						end := pf.LineEnd
						if start >= 0 && end <= len(lines) {
							f.LineHash = reconcile.LineHash(lines[start:end])
						}
					}
				}
				models[i] = f
			}

			ids, err := deps.db.BatchCreateFindings(models)
			if err != nil {
				return "", err
			}

			// Create initial position entries
			for i := range models {
				f := &models[i]
				if f.Anchor.LineRange != nil {
					fileID := f.Anchor.FileID
					_ = deps.db.InsertPosition(&model.AnnotationPosition{
						AnnotationID:   f.ID,
						AnnotationType: "finding",
						CommitID:       f.Anchor.CommitID,
						FileID:         &fileID,
						LineStart:      &f.Anchor.LineRange.Start,
						LineEnd:        &f.Anchor.LineRange.End,
						Confidence:     "exact",
					})
				}
			}

			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			return fmt.Sprintf("Created %d findings: %s", len(ids), strings.Join(ids, ", ")), nil
		},
	}
}

func toolBatchResolveFindings(deps *toolDeps) Tool {
	return Tool{
		Name:        "batch_resolve_findings",
		Description: "Mark multiple findings as resolved in one operation. Each finding gets its resolved commit set and status transitioned to 'closed'. All updates in a single transaction. Use this instead of repeated resolve_finding calls. Before resolving, add a comment to each finding (with finding_id set) explaining why it is resolved.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"findings": {
					"type": "array",
					"items": {
						"type": "object",
						"properties": {
							"id": {"type": "string", "description": "Finding ID"},
							"commit": {"type": "string", "description": "Commit where the finding was resolved"}
						},
						"required": ["id", "commit"]
					},
					"description": "Array of {id, commit} pairs (max 100)"
				}
			},
			"required": ["findings"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				Findings []struct {
					ID     string `json:"id"`
					Commit string `json:"commit"`
				} `json:"findings"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if len(p.Findings) == 0 {
				return "", fmt.Errorf("findings array is required and must not be empty")
			}
			if len(p.Findings) > 100 {
				return "", fmt.Errorf("maximum 100 findings per batch")
			}
			for i, f := range p.Findings {
				if f.ID == "" || f.Commit == "" {
					return "", fmt.Errorf("finding %d: id and commit are required", i)
				}
			}

			items := make([]struct{ ID, Commit string }, len(p.Findings))
			for i, f := range p.Findings {
				items[i] = struct{ ID, Commit string }{f.ID, f.Commit}
			}

			count, err := deps.db.BatchResolveFindings(items)
			if err != nil {
				return "", err
			}
			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			return fmt.Sprintf("Resolved %d of %d findings.", count, len(p.Findings)), nil
		},
	}
}
