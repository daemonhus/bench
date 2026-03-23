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

func registerFeatureTools(deps *toolDeps) []Tool {
	return []Tool{
		toolListFeatures(deps),
		toolGetFeature(deps),
		toolCreateFeature(deps),
		toolUpdateFeature(deps),
		toolDeleteFeature(deps),
		toolBatchCreateFeatures(deps),
	}
}

func toolListFeatures(deps *toolDeps) Tool {
	return Tool{
		Name:        "list_features",
		Description: "List architectural features (API interfaces, data sources/sinks, dependencies, externalities) annotated on the codebase.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"file": {"type": "string", "description": "Filter by file path"},
				"kind": {"type": "string", "enum": ["interface","source","sink","dependency","externality"], "description": "Filter by feature kind"},
				"status": {"type": "string", "enum": ["draft","active","deprecated","removed","orphaned"], "description": "Filter by status"}
			}
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				File   string `json:"file"`
				Kind   string `json:"kind"`
				Status string `json:"status"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}

			features, _, err := deps.db.ListFeatures(p.File, 0, 0)
			if err != nil {
				return "", err
			}

			// Post-filter
			filtered := features[:0]
			for _, f := range features {
				if p.Kind != "" && f.Kind != p.Kind {
					continue
				}
				if p.Status != "" && f.Status != p.Status {
					continue
				}
				filtered = append(filtered, f)
			}

			if len(filtered) == 0 {
				return "No features found.", nil
			}

			type featureSummary struct {
				ID        string   `json:"id"`
				Kind      string   `json:"kind"`
				Status    string   `json:"status"`
				Title     string   `json:"title"`
				File      string   `json:"file"`
				Lines     string   `json:"lines,omitempty"`
				Operation string   `json:"operation,omitempty"`
				Protocol  string   `json:"protocol,omitempty"`
				Tags      []string `json:"tags,omitempty"`
			}
			summaries := make([]featureSummary, len(filtered))
			for i, f := range filtered {
				s := featureSummary{
					ID:        f.ID,
					Kind:      f.Kind,
					Status:    f.Status,
					Title:     f.Title,
					File:      f.Anchor.FileID,
					Operation: f.Operation,
					Protocol:  f.Protocol,
					Tags:      f.Tags,
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
			return fmt.Sprintf("%d feature(s):\n%s", len(summaries), string(b)), nil
		},
	}
}

func toolGetFeature(deps *toolDeps) Tool {
	return Tool{
		Name:        "get_feature",
		Description: "Get full details of a feature annotation by ID.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"id": {"type": "string", "description": "Feature ID"}
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

			f, err := deps.db.GetFeature(p.ID)
			if err != nil {
				return "", fmt.Errorf("feature not found: %w", err)
			}

			b, err := json.MarshalIndent(f, "", "  ")
			if err != nil {
				return "", err
			}
			return string(b), nil
		},
	}
}

func toolCreateFeature(deps *toolDeps) Tool {
	return Tool{
		Name:        "create_feature",
		Description: "Annotate an architectural feature: an API interface, data source/sink, dependency injection point, or externality (background worker, side-effect). Use this to map the security-relevant architecture of the codebase.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"file": {"type": "string", "description": "File path"},
				"commit": {"type": "string", "description": "Commit where the feature was identified"},
				"line_start": {"type": "integer", "description": "Start line number"},
				"line_end": {"type": "integer", "description": "End line number"},
				"kind": {"type": "string", "enum": ["interface","source","sink","dependency","externality"], "description": "Feature kind"},
				"title": {"type": "string", "description": "Short title for the feature"},
				"description": {"type": "string", "description": "Detailed description"},
				"operation": {"type": "string", "description": "HTTP method (GET/POST/…), gRPC method name, GraphQL operation type (query/mutation/subscription), or other protocol operation"},
				"direction": {"type": "string", "enum": ["in","out"], "description": "Data flow direction (for interfaces/sources/sinks)"},
				"protocol": {"type": "string", "description": "Protocol (e.g. rest, grpc, graphql, websocket)"},
				"status": {"type": "string", "enum": ["draft","active"], "description": "Initial status (default: active)"},
				"tags": {"type": "array", "items": {"type": "string"}, "description": "Optional tags"},
				"source": {"type": "string", "description": "Tool or scanner that identified the feature"}
			},
			"required": ["file", "commit", "kind", "title"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				File        string   `json:"file"`
				Commit      string   `json:"commit"`
				LineStart   int      `json:"line_start"`
				LineEnd     int      `json:"line_end"`
				Kind        string   `json:"kind"`
				Title       string   `json:"title"`
				Description string   `json:"description"`
				Operation   string   `json:"operation"`
				Direction   string   `json:"direction"`
				Protocol    string   `json:"protocol"`
				Status      string   `json:"status"`
				Tags        []string `json:"tags"`
				Source      string   `json:"source"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.File == "" || p.Commit == "" || p.Kind == "" || p.Title == "" {
				return "", fmt.Errorf("file, commit, kind, and title are required")
			}
			if p.Status == "" {
				p.Status = "active"
			}
			if p.Tags == nil {
				p.Tags = []string{}
			}
			if p.Source == "" {
				p.Source = "mcp"
			}

			f := &model.Feature{
				ID:          uuid.New().String(),
				Anchor:      model.Anchor{FileID: p.File, CommitID: p.Commit},
				Kind:        p.Kind,
				Title:       p.Title,
				Description: p.Description,
				Operation:   p.Operation,
				Direction:   p.Direction,
				Protocol:    p.Protocol,
				Status:      p.Status,
				Tags:        p.Tags,
				Source:      p.Source,
				CreatedAt:   time.Now().UTC().Format(time.RFC3339),
			}
			if p.LineStart > 0 && p.LineEnd > 0 {
				f.Anchor.LineRange = &model.LineRange{Start: p.LineStart, End: p.LineEnd}
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

			if err := deps.db.CreateFeature(f); err != nil {
				return "", err
			}

			// Create initial position entry
			if f.Anchor.LineRange != nil {
				fileID := f.Anchor.FileID
				_ = deps.db.InsertPosition(&model.AnnotationPosition{
					AnnotationID:   f.ID,
					AnnotationType: "feature",
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
			return fmt.Sprintf("Created feature %s: %s (%s)", f.ID, f.Title, f.Kind), nil
		},
	}
}

func toolUpdateFeature(deps *toolDeps) Tool {
	return Tool{
		Name:        "update_feature",
		Description: "Update a feature annotation. Only specified fields are changed.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"id": {"type": "string", "description": "Feature ID"},
				"kind": {"type": "string", "enum": ["interface","source","sink","dependency","externality"]},
				"title": {"type": "string"},
				"description": {"type": "string"},
				"operation": {"type": "string"},
				"direction": {"type": "string", "enum": ["in","out",""]},
				"protocol": {"type": "string"},
				"status": {"type": "string", "enum": ["draft","active","deprecated","removed","orphaned"]},
				"tags": {"type": "array", "items": {"type": "string"}},
				"line_start": {"type": "integer"},
				"line_end": {"type": "integer"}
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

			f, err := deps.db.UpdateFeature(id, raw)
			if err != nil {
				return "", err
			}

			b, err := json.MarshalIndent(f, "", "  ")
			if err != nil {
				return "", err
			}
			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			return fmt.Sprintf("Updated feature %s:\n%s", id, string(b)), nil
		},
	}
}

func toolDeleteFeature(deps *toolDeps) Tool {
	return Tool{
		Name:        "delete_feature",
		Description: "Delete a feature annotation by ID.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"id": {"type": "string", "description": "Feature ID to delete"}
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

			if err := deps.db.DeleteFeature(p.ID); err != nil {
				return "", err
			}

			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			return fmt.Sprintf("Deleted feature %s.", p.ID), nil
		},
	}
}

func toolBatchCreateFeatures(deps *toolDeps) Tool {
	return Tool{
		Name:        "batch_create_features",
		Description: "Create multiple feature annotations in one transaction. All-or-nothing.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"features": {
					"type": "array",
					"items": {
						"type": "object",
						"properties": {
							"file": {"type": "string"},
							"commit": {"type": "string"},
							"line_start": {"type": "integer"},
							"line_end": {"type": "integer"},
							"kind": {"type": "string", "enum": ["interface","source","sink","dependency","externality"]},
							"title": {"type": "string"},
							"description": {"type": "string"},
							"operation": {"type": "string"},
							"direction": {"type": "string"},
							"protocol": {"type": "string"},
							"status": {"type": "string", "enum": ["draft","active"]},
							"tags": {"type": "array", "items": {"type": "string"}},
							"source": {"type": "string"}
						},
						"required": ["file", "commit", "kind", "title"]
					},
					"description": "Array of features to create (max 100)"
				}
			},
			"required": ["features"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				Features []struct {
					File        string   `json:"file"`
					Commit      string   `json:"commit"`
					LineStart   int      `json:"line_start"`
					LineEnd     int      `json:"line_end"`
					Kind        string   `json:"kind"`
					Title       string   `json:"title"`
					Description string   `json:"description"`
					Operation   string   `json:"operation"`
					Direction   string   `json:"direction"`
					Protocol    string   `json:"protocol"`
					Status      string   `json:"status"`
					Tags        []string `json:"tags"`
					Source      string   `json:"source"`
				} `json:"features"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if len(p.Features) == 0 {
				return "", fmt.Errorf("features array is required and must not be empty")
			}
			if len(p.Features) > 100 {
				return "", fmt.Errorf("maximum 100 features per batch")
			}

			now := time.Now().UTC().Format(time.RFC3339)
			models := make([]model.Feature, len(p.Features))
			for i, pf := range p.Features {
				status := pf.Status
				if status == "" {
					status = "active"
				}
				source := pf.Source
				if source == "" {
					source = "mcp"
				}
				tags := pf.Tags
				if tags == nil {
					tags = []string{}
				}
				f := model.Feature{
					ID:          uuid.New().String(),
					Anchor:      model.Anchor{FileID: pf.File, CommitID: pf.Commit},
					Kind:        pf.Kind,
					Title:       pf.Title,
					Description: pf.Description,
					Operation:   pf.Operation,
					Direction:   pf.Direction,
					Protocol:    pf.Protocol,
					Status:      status,
					Tags:        tags,
					Source:      source,
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

			ids, err := deps.db.BatchCreateFeatures(models)
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
						AnnotationType: "feature",
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
			return fmt.Sprintf("Created %d features: %s", len(ids), strings.Join(ids, ", ")), nil
		},
	}
}
