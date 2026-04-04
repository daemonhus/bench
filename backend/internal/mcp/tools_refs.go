package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"bench/internal/events"
	"bench/internal/model"

	"github.com/google/uuid"
)

func registerRefTools(deps *toolDeps) []Tool {
	return []Tool{
		toolListRefs(deps),
		toolGetRef(deps),
		toolCreateRef(deps),
		toolUpdateRef(deps),
		toolDeleteRef(deps),
		toolBatchCreateRefs(deps),
	}
}

func toolListRefs(deps *toolDeps) Tool {
	return Tool{
		Name:        "list_refs",
		Description: "List external references, optionally filtered by entity type, entity ID, or provider.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"entity_type": {"type": "string", "enum": ["finding", "feature", "comment"], "description": "Filter by entity type"},
				"entity_id":   {"type": "string", "description": "Filter by entity ID"},
				"provider":    {"type": "string", "description": "Filter by provider (e.g. jira, slack, github, linear, url)"}
			}
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				EntityType string `json:"entity_type"`
				EntityID   string `json:"entity_id"`
				Provider   string `json:"provider"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			refs, err := deps.db.ListRefs(p.EntityType, p.EntityID, p.Provider)
			if err != nil {
				return "", err
			}
			if len(refs) == 0 {
				return "No refs found.", nil
			}
			b, err := json.MarshalIndent(refs, "", "  ")
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("%d ref(s):\n%s", len(refs), string(b)), nil
		},
	}
}

func toolGetRef(deps *toolDeps) Tool {
	return Tool{
		Name:        "get_ref",
		Description: "Get a single external reference by ID.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"id": {"type": "string", "description": "Ref ID"}
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
			ref, err := deps.db.GetRef(p.ID)
			if err != nil {
				return "", err
			}
			b, err := json.MarshalIndent(ref, "", "  ")
			if err != nil {
				return "", err
			}
			return string(b), nil
		},
	}
}

func toolCreateRef(deps *toolDeps) Tool {
	return Tool{
		Name:        "create_ref",
		Description: "Create an external reference linking an annotation to a Jira ticket, Slack thread, GitHub issue, Linear issue, or any URL. Provider is inferred from the URL if omitted.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"entity_type": {"type": "string", "enum": ["finding", "feature", "comment"], "description": "Type of the entity to link"},
				"entity_id":   {"type": "string", "description": "ID of the finding, feature, or comment"},
				"provider":    {"type": "string", "description": "Provider: github, gitlab, jira, confluence, linear, notion, slack, or url. Inferred from the URL if omitted."},
				"url":         {"type": "string", "description": "Full URL of the external resource"},
				"title":       {"type": "string", "description": "Optional display label (shown as tooltip)"}
			},
			"required": ["entity_type", "entity_id", "url"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				EntityType string `json:"entity_type"`
				EntityID   string `json:"entity_id"`
				Provider   string `json:"provider"`
				URL        string `json:"url"`
				Title      string `json:"title"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.EntityType == "" || p.EntityID == "" || p.URL == "" {
				return "", fmt.Errorf("entity_type, entity_id, and url are required")
			}
			if p.Provider == "" {
				p.Provider = model.InferProvider(p.URL)
			}
			ref := &model.Ref{
				ID:         uuid.New().String(),
				EntityType: p.EntityType,
				EntityID:   p.EntityID,
				Provider:   p.Provider,
				URL:        p.URL,
				Title:      p.Title,
				CreatedAt:  time.Now().UTC().Format(time.RFC3339),
			}
			if err := deps.db.CreateRef(ref); err != nil {
				return "", err
			}
			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			return fmt.Sprintf("Created ref %s linking %s %s → %s", ref.ID, ref.EntityType, ref.EntityID, ref.URL), nil
		},
	}
}

func toolUpdateRef(deps *toolDeps) Tool {
	return Tool{
		Name:        "update_ref",
		Description: "Update an external reference's provider, URL, or title.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"id":       {"type": "string", "description": "Ref ID"},
				"provider": {"type": "string", "description": "New provider"},
				"url":      {"type": "string", "description": "New URL"},
				"title":    {"type": "string", "description": "New display label"}
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
			ref, err := deps.db.UpdateRef(id, raw)
			if err != nil {
				return "", err
			}
			b, err := json.MarshalIndent(ref, "", "  ")
			if err != nil {
				return "", err
			}
			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			return fmt.Sprintf("Updated ref %s:\n%s", id, string(b)), nil
		},
	}
}

func toolDeleteRef(deps *toolDeps) Tool {
	return Tool{
		Name:        "delete_ref",
		Description: "Delete an external reference by ID.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"id": {"type": "string", "description": "Ref ID to delete"}
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
			if err := deps.db.DeleteRef(p.ID); err != nil {
				return "", err
			}
			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			return fmt.Sprintf("Deleted ref %s.", p.ID), nil
		},
	}
}

func toolBatchCreateRefs(deps *toolDeps) Tool {
	return Tool{
		Name:        "batch_create_refs",
		Description: "Create multiple external references in one operation.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"refs": {
					"type": "array",
					"items": {
						"type": "object",
						"properties": {
							"entity_type": {"type": "string", "enum": ["finding", "feature", "comment"]},
							"entity_id":   {"type": "string"},
							"provider":    {"type": "string"},
							"url":         {"type": "string"},
							"title":       {"type": "string"}
						},
						"required": ["entity_type", "entity_id", "url"]
					}
				}
			},
			"required": ["refs"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				Refs []struct {
					EntityType string `json:"entity_type"`
					EntityID   string `json:"entity_id"`
					Provider   string `json:"provider"`
					URL        string `json:"url"`
					Title      string `json:"title"`
				} `json:"refs"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if len(p.Refs) == 0 {
				return "", fmt.Errorf("refs array is required and must not be empty")
			}
			now := time.Now().UTC().Format(time.RFC3339)
			refs := make([]model.Ref, len(p.Refs))
			for i, pr := range p.Refs {
				provider := pr.Provider
				if provider == "" {
					provider = model.InferProvider(pr.URL)
				}
				refs[i] = model.Ref{
					ID:         uuid.New().String(),
					EntityType: pr.EntityType,
					EntityID:   pr.EntityID,
					Provider:   provider,
					URL:        pr.URL,
					Title:      pr.Title,
					CreatedAt:  now,
				}
			}
			ids, err := deps.db.BatchCreateRefs(refs)
			if err != nil {
				return "", err
			}
			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			return fmt.Sprintf("Created %d ref(s).", len(ids)), nil
		},
	}
}
