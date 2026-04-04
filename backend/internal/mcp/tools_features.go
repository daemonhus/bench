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
		toolListFeatureParameters(deps),
		toolCreateFeatureParameter(deps),
		toolUpdateFeatureParameter(deps),
		toolDeleteFeatureParameter(deps),
	}
}

// paramSchema is the JSON schema object for a single parameter item (reused in several tools).
const paramItemSchema = `{
	"type": "object",
	"properties": {
		"name":        {"type": "string", "description": "Parameter name, e.g. user_id, Authorization"},
		"description": {"type": "string", "description": "What this parameter carries or its security notes"},
		"type":        {"type": "string", "description": "string | integer | boolean | object | array | file (or any freeform string)"},
		"pattern":     {"type": "string", "description": "Freeform constraint: regex, enum list, min/max, format hint, etc."},
		"required":    {"type": "boolean", "description": "True if the parameter is required"}
	},
	"required": ["name"]
}`

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
				"commit": {"type": "string", "description": "Commit hash or ref where the feature was identified (e.g. HEAD, branch name, or full SHA)"},
				"line_start": {"type": "integer", "description": "Start line number"},
				"line_end": {"type": "integer", "description": "End line number"},
				"kind": {"type": "string", "enum": ["interface","source","sink","dependency","externality"], "description": "Feature kind: 'interface'=API endpoint or protocol handler (HTTP, gRPC, WebSocket), 'source'=data input (DB read, file read, inbound queue), 'sink'=data output (DB write, outbound API call, file write), 'dependency'=third-party library or external service, 'externality'=background job, scheduler, event handler, or side-effect"},
				"title": {"type": "string", "description": "Short label for the feature — do NOT include the HTTP method or protocol prefix here (e.g. 'Login endpoint', not 'POST /login'). Use operation for the HTTP method."},
				"description": {"type": "string", "description": "Detailed description"},
				"operation": {"type": "string", "description": "HTTP method (GET/POST/…), gRPC method name, GraphQL operation type (query/mutation/subscription), or other protocol operation"},
				"direction": {"type": "string", "enum": ["in","out"], "description": "Data flow direction relative to the service: 'in'=data entering the service (inbound request, consumed message), 'out'=data leaving the service (outbound call, produced message, write to store)"},
				"protocol": {"type": "string", "description": "Protocol (e.g. rest, grpc, graphql, websocket)"},
				"status": {"type": "string", "enum": ["draft","active"], "description": "Initial status (default: active)"},
				"tags": {"type": "array", "items": {"type": "string"}, "description": "Optional tags"},
				"source": {"type": "string", "description": "Tool or scanner that identified the feature"},
				"parameters": {"type": "array", "items": ` + paramItemSchema + `, "description": "Optional parameters documenting the interface contract (auth headers, path vars, query params, body fields)"}
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
				Parameters  []struct {
					Name        string `json:"name"`
					Description string `json:"description"`
					Type        string `json:"type"`
					Pattern     string `json:"pattern"`
					Required    bool   `json:"required"`
				} `json:"parameters"`
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

			// Persist parameters if provided.
			if len(p.Parameters) > 0 {
				mparams := make([]model.FeatureParameter, len(p.Parameters))
				for i, pp := range p.Parameters {
					mparams[i] = model.FeatureParameter{
						FeatureID:   f.ID,
						Name:        pp.Name,
						Description: pp.Description,
						Type:        pp.Type,
						Pattern:     pp.Pattern,
						Required:    pp.Required,
					}
				}
				if err := deps.db.ReplaceParameters(f.ID, mparams); err == nil {
					f.Parameters, _ = deps.db.ListParameters(f.ID)
				}
			}

			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			b, err := json.MarshalIndent(f, "", "  ")
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("Created feature %s:\n%s", f.ID, string(b)), nil
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
				"file": {"type": "string", "description": "New anchor file path"},
				"commit": {"type": "string", "description": "New anchor commit"},
				"kind": {"type": "string", "enum": ["interface","source","sink","dependency","externality"]},
				"title": {"type": "string"},
				"description": {"type": "string"},
				"operation": {"type": "string"},
				"direction": {"type": "string", "enum": ["in","out",""]},
				"protocol": {"type": "string"},
				"status": {"type": "string", "enum": ["draft","active","deprecated","removed","orphaned"]},
				"tags": {"type": "array", "items": {"type": "string"}},
				"source": {"type": "string", "description": "Source tool or scanner"},
				"line_start": {"type": "integer"},
				"line_end": {"type": "integer"},
				"parameters": {"type": "array", "items": ` + paramItemSchema + `, "description": "Replace all parameters. Omitting this field leaves parameters unchanged."}
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

			// Detect if any anchor field is changing
			_, hasFile := raw["file"]
			_, hasFileID := raw["file_id"]
			_, hasCommit := raw["commit"]
			_, hasCommitID := raw["commit_id"]
			lineStartVal, hasStart := raw["line_start"]
			lineEndVal, hasEnd := raw["line_end"]
			anchorChanging := hasFile || hasFileID || hasCommit || hasCommitID || hasStart || hasEnd

			// Coerce JSON numbers to int
			if hasStart {
				raw["line_start"] = int(lineStartVal.(float64))
			}
			if hasEnd {
				raw["line_end"] = int(lineEndVal.(float64))
			}

			if anchorChanging {
				existing, err := deps.db.GetFeature(id)
				if err == nil {
					// Determine effective new values
					newFileID := existing.Anchor.FileID
					if v, ok := raw["file"]; ok {
						newFileID = v.(string)
					} else if v, ok := raw["file_id"]; ok {
						newFileID = v.(string)
					}
					newCommit := existing.Anchor.CommitID
					if v, ok := raw["commit"]; ok {
						newCommit = v.(string)
					} else if v, ok := raw["commit_id"]; ok {
						newCommit = v.(string)
					}
					newStart := 0
					newEnd := 0
					if existing.Anchor.LineRange != nil {
						newStart = existing.Anchor.LineRange.Start
						newEnd = existing.Anchor.LineRange.End
					}
					if v, ok := raw["line_start"]; ok {
						newStart = v.(int)
					}
					if v, ok := raw["line_end"]; ok {
						newEnd = v.(int)
					}

					// Recompute lineHash
					if newStart > 0 && newEnd > 0 {
						content, err := deps.repo.Show(newCommit, newFileID)
						if err == nil {
							lines := strings.Split(content, "\n")
							s := newStart - 1
							e := newEnd
							if s >= 0 && e <= len(lines) {
								raw["line_hash"] = reconcile.LineHash(lines[s:e])
							}
						}
					}

					raw["anchor_updated_at"] = time.Now().UTC().Format(time.RFC3339)

					// Insert position at reconciliation resume point after the DB update
					defer func() {
						if newStart > 0 && newEnd > 0 {
							posCommit := newCommit
							if lastCommit, err := deps.db.GetReconciliationState(newFileID); err == nil && lastCommit != "" {
								posCommit = lastCommit
							} else if head, err := deps.repo.Head(); err == nil {
								posCommit = head
							}
							_ = deps.db.InsertPosition(&model.AnnotationPosition{
								AnnotationID:   id,
								AnnotationType: "feature",
								CommitID:       posCommit,
								FileID:         &newFileID,
								LineStart:      &newStart,
								LineEnd:        &newEnd,
								Confidence:     "exact",
							})
						}
					}()
				}
			}

			// Extract parameters before UpdateFeature (it doesn't handle them).
			var replaceParams bool
			var newParams []model.FeatureParameter
			if rawParams, ok := raw["parameters"]; ok {
				replaceParams = true
				delete(raw, "parameters")
				if arr, ok := rawParams.([]any); ok {
					for _, item := range arr {
						if m, ok := item.(map[string]any); ok {
							p := model.FeatureParameter{FeatureID: id}
							if v, ok := m["name"].(string); ok {
								p.Name = v
							}
							if v, ok := m["description"].(string); ok {
								p.Description = v
							}
							if v, ok := m["type"].(string); ok {
								p.Type = v
							}
							if v, ok := m["pattern"].(string); ok {
								p.Pattern = v
							}
							if v, ok := m["required"].(bool); ok {
								p.Required = v
							}
							if p.Name != "" {
								newParams = append(newParams, p)
							}
						}
					}
				}
			}

			var f *model.Feature
			var err error
			if len(raw) > 0 {
				f, err = deps.db.UpdateFeature(id, raw)
				if err != nil {
					return "", err
				}
			} else {
				f, err = deps.db.GetFeature(id)
				if err != nil {
					return "", fmt.Errorf("feature not found: %w", err)
				}
			}

			if replaceParams {
				if err := deps.db.ReplaceParameters(id, newParams); err == nil {
					f.Parameters, _ = deps.db.ListParameters(id)
				}
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
							"file": {"type": "string", "description": "File path"},
							"commit": {"type": "string", "description": "Commit hash or ref where the feature was identified (e.g. HEAD, branch name, or full SHA)"},
							"line_start": {"type": "integer", "description": "Start line number"},
							"line_end": {"type": "integer", "description": "End line number"},
							"kind": {"type": "string", "enum": ["interface","source","sink","dependency","externality"], "description": "Feature kind: 'interface'=API endpoint or protocol handler (HTTP, gRPC, WebSocket), 'source'=data input (DB read, file read, inbound queue), 'sink'=data output (DB write, outbound API call, file write), 'dependency'=third-party library or external service, 'externality'=background job, scheduler, event handler, or side-effect"},
							"title": {"type": "string", "description": "Short label for the feature — do NOT include the HTTP method or protocol prefix here (e.g. 'Login endpoint', not 'POST /login'). Use operation for the HTTP method."},
							"description": {"type": "string", "description": "Detailed description"},
							"operation": {"type": "string", "description": "HTTP method (GET/POST/…), gRPC method name, GraphQL operation type (query/mutation/subscription), or other protocol operation"},
							"direction": {"type": "string", "description": "Data flow direction relative to the service: 'in'=data entering the service (inbound request, consumed message), 'out'=data leaving the service (outbound call, produced message, write to store)"},
							"protocol": {"type": "string", "description": "Protocol (e.g. rest, grpc, graphql, websocket)"},
							"status": {"type": "string", "enum": ["draft","active"], "description": "Initial status (default: active)"},
							"tags": {"type": "array", "items": {"type": "string"}, "description": "Optional tags"},
							"source": {"type": "string", "description": "Tool or scanner that identified the feature"},
							"parameters": {"type": "array", "items": ` + paramItemSchema + `, "description": "Optional parameters documenting the interface contract"}
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
					Parameters  []struct {
						Name        string `json:"name"`
						Description string `json:"description"`
						Type        string `json:"type"`
						Pattern     string `json:"pattern"`
						Required    bool   `json:"required"`
					} `json:"parameters"`
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

			// Create initial position entries and persist parameters.
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
				if len(p.Features[i].Parameters) > 0 {
					mparams := make([]model.FeatureParameter, len(p.Features[i].Parameters))
					for j, pp := range p.Features[i].Parameters {
						mparams[j] = model.FeatureParameter{
							FeatureID:   f.ID,
							Name:        pp.Name,
							Description: pp.Description,
							Type:        pp.Type,
							Pattern:     pp.Pattern,
							Required:    pp.Required,
						}
					}
					_ = deps.db.ReplaceParameters(f.ID, mparams)
				}
			}

			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			return fmt.Sprintf("Created %d features: %s", len(ids), strings.Join(ids, ", ")), nil
		},
	}
}

func toolListFeatureParameters(deps *toolDeps) Tool {
	return Tool{
		Name:        "list_feature_parameters",
		Description: "List all parameters for a feature annotation.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"feature_id": {"type": "string", "description": "Feature ID"}
			},
			"required": ["feature_id"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				FeatureID string `json:"feature_id"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.FeatureID == "" {
				return "", fmt.Errorf("feature_id is required")
			}
			ps, err := deps.db.ListParameters(p.FeatureID)
			if err != nil {
				return "", err
			}
			if len(ps) == 0 {
				return "No parameters found.", nil
			}
			b, err := json.MarshalIndent(ps, "", "  ")
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("%d parameter(s):\n%s", len(ps), string(b)), nil
		},
	}
}

func toolCreateFeatureParameter(deps *toolDeps) Tool {
	return Tool{
		Name:        "create_feature_parameter",
		Description: "Add a parameter to a feature annotation.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"feature_id":  {"type": "string", "description": "Feature ID"},
				"name":        {"type": "string", "description": "Parameter name"},
				"description": {"type": "string", "description": "What this parameter carries or its security notes"},
				"type":        {"type": "string", "description": "string | integer | boolean | object | array | file"},
				"pattern":     {"type": "string", "description": "Constraint: regex, enum, min/max, format hint, etc."},
				"required":    {"type": "boolean", "description": "True if the parameter is required"}
			},
			"required": ["feature_id", "name"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				FeatureID   string `json:"feature_id"`
				Name        string `json:"name"`
				Description string `json:"description"`
				Type        string `json:"type"`
				Pattern     string `json:"pattern"`
				Required    bool   `json:"required"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.FeatureID == "" {
				return "", fmt.Errorf("feature_id is required")
			}
			if p.Name == "" {
				return "", fmt.Errorf("name is required")
			}

			fp := &model.FeatureParameter{
				FeatureID:   p.FeatureID,
				Name:        p.Name,
				Description: p.Description,
				Type:        p.Type,
				Pattern:     p.Pattern,
				Required:    p.Required,
			}
			if err := deps.db.CreateParameter(fp); err != nil {
				return "", err
			}
			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			b, err := json.MarshalIndent(fp, "", "  ")
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("Created parameter %s:\n%s", fp.ID, string(b)), nil
		},
	}
}

func toolUpdateFeatureParameter(deps *toolDeps) Tool {
	return Tool{
		Name:        "update_feature_parameter",
		Description: "Update a feature parameter. Only specified fields are changed.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"id":          {"type": "string", "description": "Parameter ID"},
				"name":        {"type": "string"},
				"description": {"type": "string"},
				"type":        {"type": "string"},
				"pattern":     {"type": "string"},
				"required":    {"type": "boolean"}
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

			fp, err := deps.db.UpdateParameter(id, raw)
			if err != nil {
				return "", err
			}
			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			b, err := json.MarshalIndent(fp, "", "  ")
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("Updated parameter %s:\n%s", id, string(b)), nil
		},
	}
}

func toolDeleteFeatureParameter(deps *toolDeps) Tool {
	return Tool{
		Name:        "delete_feature_parameter",
		Description: "Delete a feature parameter by ID.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"id": {"type": "string", "description": "Parameter ID"}
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
			if err := deps.db.DeleteParameter(p.ID); err != nil {
				return "", err
			}
			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			return fmt.Sprintf("Deleted parameter %s.", p.ID), nil
		},
	}
}
