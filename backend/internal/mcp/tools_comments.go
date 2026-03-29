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

func registerCommentTools(deps *toolDeps) []Tool {
	return []Tool{
		toolListComments(deps),
		toolGetComment(deps),
		toolCreateComment(deps),
		toolUpdateComment(deps),
		toolDeleteComment(deps),
		toolResolveComment(deps),
		toolBatchCreateComments(deps),
	}
}

func toolListComments(deps *toolDeps) Tool {
	return Tool{
		Name:        "list_comments",
		Description: "List review comments. Filter by file, finding_id, or feature_id to scope results. Set full_text=true to return complete comment bodies in one call — use this instead of repeated get_comment calls when you need to read a thread.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"file": {"type": "string", "description": "Filter by file path"},
				"finding_id": {"type": "string", "description": "Filter to comments linked to this finding"},
				"feature_id": {"type": "string", "description": "Filter to comments linked to this feature"},
				"include_resolved": {"type": "boolean", "description": "Include resolved comments (default: false)"},
				"full_text": {"type": "boolean", "description": "Return complete comment body instead of truncated preview (default: false)"}
			}
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				File            string `json:"file"`
				FindingID       string `json:"finding_id"`
				FeatureID       string `json:"feature_id"`
				IncludeResolved bool   `json:"include_resolved"`
				FullText        bool   `json:"full_text"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}

			comments, _, err := deps.db.ListComments(p.File, p.FindingID, 0, 0, p.FeatureID)
			if err != nil {
				return "", err
			}

			// Post-filter resolved
			if !p.IncludeResolved {
				filtered := comments[:0]
				for _, c := range comments {
					if c.ResolvedCommit == nil {
						filtered = append(filtered, c)
					}
				}
				comments = filtered
			}

			if len(comments) == 0 {
				return "No comments found.", nil
			}

			type commentSummary struct {
				ID          string  `json:"id"`
				Author      string  `json:"author"`
				File        string  `json:"file"`
				Lines       string  `json:"lines,omitempty"`
				Timestamp   string  `json:"timestamp"`
				Preview     string  `json:"preview"`
				CommentType string  `json:"commentType,omitempty"`
				FindingID   *string `json:"findingId,omitempty"`
				FeatureID   *string `json:"featureId,omitempty"`
				ThreadID    string  `json:"threadId"`
				ParentID    *string `json:"parentId,omitempty"`
				Resolved    bool    `json:"resolved,omitempty"`
			}
			summaries := make([]commentSummary, len(comments))
			for i, c := range comments {
				preview := c.Text
				if !p.FullText && len(preview) > 120 {
					preview = preview[:120] + "..."
				}
				s := commentSummary{
					ID:          c.ID,
					Author:      c.Author,
					File:        c.Anchor.FileID,
					Timestamp:   c.Timestamp,
					Preview:     preview,
					CommentType: c.CommentType,
					FindingID:   c.FindingID,
					FeatureID:   c.FeatureID,
					ThreadID:    c.ThreadID,
					ParentID:    c.ParentID,
					Resolved:    c.ResolvedCommit != nil,
				}
				if c.Anchor.LineRange != nil {
					s.Lines = fmt.Sprintf("%d-%d", c.Anchor.LineRange.Start, c.Anchor.LineRange.End)
				}
				summaries[i] = s
			}

			b, err := json.MarshalIndent(summaries, "", "  ")
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("%d comment(s):\n%s", len(summaries), string(b)), nil
		},
	}
}

func toolGetComment(deps *toolDeps) Tool {
	return Tool{
		Name:        "get_comment",
		Description: "Get full details of a comment by ID, including full text and anchor.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"id": {"type": "string", "description": "Comment ID"}
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

			c, err := deps.db.GetComment(p.ID)
			if err != nil {
				return "", fmt.Errorf("comment not found: %w", err)
			}

			b, err := json.MarshalIndent(c, "", "  ")
			if err != nil {
				return "", err
			}
			return string(b), nil
		},
	}
}

func toolCreateComment(deps *toolDeps) Tool {
	return Tool{
		Name:        "create_comment",
		Description: "Create a review comment anchored to a file location. To attach a comment to a finding (so it appears in the finding's discussion thread), set finding_id to the finding's ID. Comments linked to a finding should add new information — verification evidence, reproduction steps, related code paths, or remediation notes — not repeat the finding description.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"file": {"type": "string", "description": "File path"},
				"commit": {"type": "string", "description": "Commit hash or ref (e.g. HEAD, branch name, or full SHA)"},
				"line_start": {"type": "integer", "description": "Start line number"},
				"line_end": {"type": "integer", "description": "End line number"},
				"text": {"type": "string", "description": "Comment text (markdown supported)"},
				"author": {"type": "string", "description": "Author name (e.g. 'claude', 'reviewer-alice')"},
				"comment_type": {"type": "string", "enum": ["feature", "improvement", "question", "concern", ""], "description": "Comment category (code review sense): 'feature'=feature request/suggestion, 'improvement'=non-critical enhancement, 'question'=needs clarification, 'concern'=potential issue. Not related to the Feature annotation entity."},
				"finding_id": {"type": "string", "description": "Link to a finding ID (for finding-related discussion)"},
				"feature_id": {"type": "string", "description": "Link to a feature ID (for feature-related discussion)"},
				"parent_id": {"type": "string", "description": "Parent comment ID (for threading)"}
			},
			"required": ["file", "commit", "text", "author"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				File        string `json:"file"`
				Commit      string `json:"commit"`
				LineStart   int    `json:"line_start"`
				LineEnd     int    `json:"line_end"`
				Text        string `json:"text"`
				Author      string `json:"author"`
				CommentType string `json:"comment_type"`
				FindingID   string `json:"finding_id"`
				FeatureID   string `json:"feature_id"`
				ParentID    string `json:"parent_id"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.File == "" || p.Commit == "" || p.Text == "" || p.Author == "" {
				return "", fmt.Errorf("file, commit, text, and author are required")
			}

			c := &model.Comment{
				ID:          uuid.New().String(),
				Anchor:      model.Anchor{FileID: p.File, CommitID: p.Commit},
				Author:      p.Author,
				Text:        p.Text,
				CommentType: p.CommentType,
				Timestamp:   time.Now().UTC().Format(time.RFC3339),
				ThreadID:    uuid.New().String(),
			}

			if p.ParentID != "" {
				c.ParentID = &p.ParentID
				// Inherit threadID from parent for proper thread grouping
				if parent, err := deps.db.GetComment(p.ParentID); err == nil {
					c.ThreadID = parent.ThreadID
				}
			}
			if p.FindingID != "" {
				c.FindingID = &p.FindingID
			}
			if p.FeatureID != "" {
				c.FeatureID = &p.FeatureID
			}

			if p.LineStart > 0 && p.LineEnd > 0 {
				c.Anchor.LineRange = &model.LineRange{Start: p.LineStart, End: p.LineEnd}
				content, err := deps.repo.Show(p.Commit, p.File)
				if err == nil {
					lines := strings.Split(content, "\n")
					start := p.LineStart - 1
					end := p.LineEnd
					if start >= 0 && end <= len(lines) {
						c.LineHash = reconcile.LineHash(lines[start:end])
					}
				}
			}

			if err := deps.db.CreateComment(c); err != nil {
				return "", err
			}

			// Create initial position entry
			if c.Anchor.LineRange != nil {
				fileID := c.Anchor.FileID
				_ = deps.db.InsertPosition(&model.AnnotationPosition{
					AnnotationID:   c.ID,
					AnnotationType: "comment",
					CommitID:       c.Anchor.CommitID,
					FileID:         &fileID,
					LineStart:      &c.Anchor.LineRange.Start,
					LineEnd:        &c.Anchor.LineRange.End,
					Confidence:     "exact",
				})
			}

			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			return fmt.Sprintf("Created comment %s on %s:%d-%d by %s",
				c.ID, p.File, p.LineStart, p.LineEnd, p.Author), nil
		},
	}
}

func toolUpdateComment(deps *toolDeps) Tool {
	return Tool{
		Name:        "update_comment",
		Description: "Update a comment. Only specified fields are changed.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"id": {"type": "string", "description": "Comment ID"},
				"text": {"type": "string", "description": "New comment text"},
				"comment_type": {"type": "string", "enum": ["feature", "improvement", "question", "concern", ""], "description": "Comment category (code review sense): 'feature'=feature request/suggestion, 'improvement'=non-critical enhancement, 'question'=needs clarification, 'concern'=potential issue. Not related to the Feature annotation entity."},
				"file_id": {"type": "string", "description": "New anchor file path"},
				"commit_id": {"type": "string", "description": "New anchor commit"},
				"line_start": {"type": "integer", "description": "New anchor start line"},
				"line_end": {"type": "integer", "description": "New anchor end line"}
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

			if err := deps.db.UpdateComment(id, raw); err != nil {
				return "", err
			}
			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			return fmt.Sprintf("Comment %s updated.", id), nil
		},
	}
}

func toolDeleteComment(deps *toolDeps) Tool {
	return Tool{
		Name:        "delete_comment",
		Description: "Delete a comment by ID.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"id": {"type": "string", "description": "Comment ID to delete"}
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

			if err := deps.db.DeleteComment(p.ID); err != nil {
				return "", err
			}
			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			return fmt.Sprintf("Deleted comment %s.", p.ID), nil
		},
	}
}

func toolResolveComment(deps *toolDeps) Tool {
	return Tool{
		Name:        "resolve_comment",
		Description: "Mark a comment (discussion thread) as resolved at a specific commit. Use this when a review discussion is addressed, not to close a vulnerability — use resolve_finding for that.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"id": {"type": "string", "description": "Comment ID"},
				"commit": {"type": "string", "description": "Commit where the comment was resolved"}
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

			err := deps.db.UpdateComment(p.ID, map[string]any{"resolvedCommit": p.Commit})
			if err != nil {
				return "", err
			}
			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			return fmt.Sprintf("Comment %s resolved at commit %s.", p.ID, p.Commit), nil
		},
	}
}

func toolBatchCreateComments(deps *toolDeps) Tool {
	return Tool{
		Name:        "batch_create_comments",
		Description: "Create multiple review comments in one operation. All comments are inserted in a single transaction. Returns the list of created comment IDs. Use this instead of repeated create_comment calls. To attach comments to findings (so they appear in the finding's discussion thread), set finding_id on each comment. Comments linked to a finding should add new information — verification evidence, reproduction steps, related code paths, or remediation notes — not repeat the finding description.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"comments": {
					"type": "array",
					"items": {
						"type": "object",
						"properties": {
							"file": {"type": "string"},
							"commit": {"type": "string"},
							"line_start": {"type": "integer"},
							"line_end": {"type": "integer"},
							"text": {"type": "string"},
							"author": {"type": "string"},
							"comment_type": {"type": "string", "enum": ["feature", "improvement", "question", "concern", ""]},
							"finding_id": {"type": "string"},
							"feature_id": {"type": "string"},
							"parent_id": {"type": "string"}
						},
						"required": ["file", "commit", "text", "author"]
					},
					"description": "Array of comments to create (max 100)"
				}
			},
			"required": ["comments"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				Comments []struct {
					File        string `json:"file"`
					Commit      string `json:"commit"`
					LineStart   int    `json:"line_start"`
					LineEnd     int    `json:"line_end"`
					Text        string `json:"text"`
					Author      string `json:"author"`
					CommentType string `json:"comment_type"`
					FindingID   string `json:"finding_id"`
					FeatureID   string `json:"feature_id"`
					ParentID    string `json:"parent_id"`
				} `json:"comments"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if len(p.Comments) == 0 {
				return "", fmt.Errorf("comments array is required and must not be empty")
			}
			if len(p.Comments) > 100 {
				return "", fmt.Errorf("maximum 100 comments per batch")
			}

			now := time.Now().UTC().Format(time.RFC3339)
			models := make([]model.Comment, len(p.Comments))
			for i, pc := range p.Comments {
				if pc.File == "" || pc.Commit == "" || pc.Text == "" || pc.Author == "" {
					return "", fmt.Errorf("comment %d: file, commit, text, and author are required", i)
				}
				author := pc.Author

				c := model.Comment{
					ID:          uuid.New().String(),
					Anchor:      model.Anchor{FileID: pc.File, CommitID: pc.Commit},
					Author:      author,
					Text:        pc.Text,
					CommentType: pc.CommentType,
					Timestamp:   now,
					ThreadID:    uuid.New().String(),
				}

				if pc.ParentID != "" {
					c.ParentID = &pc.ParentID
					if parent, err := deps.db.GetComment(pc.ParentID); err == nil {
						c.ThreadID = parent.ThreadID
					}
				}
				if pc.FindingID != "" {
					c.FindingID = &pc.FindingID
				}
				if pc.FeatureID != "" {
					c.FeatureID = &pc.FeatureID
				}

				if pc.LineStart > 0 && pc.LineEnd > 0 {
					c.Anchor.LineRange = &model.LineRange{Start: pc.LineStart, End: pc.LineEnd}
					content, err := deps.repo.Show(pc.Commit, pc.File)
					if err == nil {
						lines := strings.Split(content, "\n")
						start := pc.LineStart - 1
						end := pc.LineEnd
						if start >= 0 && end <= len(lines) {
							c.LineHash = reconcile.LineHash(lines[start:end])
						}
					}
				}
				models[i] = c
			}

			ids, err := deps.db.BatchCreateComments(models)
			if err != nil {
				return "", err
			}

			// Create initial position entries
			for i := range models {
				c := &models[i]
				if c.Anchor.LineRange != nil {
					fileID := c.Anchor.FileID
					_ = deps.db.InsertPosition(&model.AnnotationPosition{
						AnnotationID:   c.ID,
						AnnotationType: "comment",
						CommitID:       c.Anchor.CommitID,
						FileID:         &fileID,
						LineStart:      &c.Anchor.LineRange.Start,
						LineEnd:        &c.Anchor.LineRange.End,
						Confidence:     "exact",
					})
				}
			}

			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			return fmt.Sprintf("Created %d comments: %s", len(ids), strings.Join(ids, ", ")), nil
		},
	}
}
