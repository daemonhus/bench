package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode"

	"bench/internal/db"
	"bench/internal/events"
	"bench/internal/git"
	"bench/internal/reconcile"
)

// Tool defines a single MCP tool with its schema and handler.
type Tool struct {
	Name        string
	Description string
	InputSchema json.RawMessage
	Handler     func(ctx context.Context, params json.RawMessage) (string, error)
}

type toolDeps struct {
	db         *db.DB
	repo       *git.Repo
	reconciler *reconcile.Reconciler
	broker     *events.Broker
}

// validateParams checks that all keys in params are defined in the tool's
// InputSchema. Returns an error listing unrecognized keys with suggestions
// (e.g. "findingId" → did you mean "finding_id"?).
func validateParams(schema json.RawMessage, params json.RawMessage) error {
	var s struct {
		Properties map[string]json.RawMessage `json:"properties"`
	}
	if err := json.Unmarshal(schema, &s); err != nil || s.Properties == nil {
		return nil // can't validate, let handler deal with it
	}

	var m map[string]json.RawMessage
	if err := json.Unmarshal(params, &m); err != nil {
		return nil // not an object, let handler deal with it
	}

	validKeys := make(map[string]bool, len(s.Properties))
	for k := range s.Properties {
		validKeys[k] = true
	}

	var problems []string
	for k := range m {
		if validKeys[k] {
			continue
		}
		snake := camelToSnake(k)
		if validKeys[snake] {
			problems = append(problems, fmt.Sprintf("%q (use %q instead)", k, snake))
		} else {
			problems = append(problems, fmt.Sprintf("%q", k))
		}
	}

	if len(problems) > 0 {
		sort.Strings(problems)
		valid := make([]string, 0, len(validKeys))
		for k := range validKeys {
			valid = append(valid, k)
		}
		sort.Strings(valid)
		return fmt.Errorf("unrecognized parameter(s): %s. Valid parameters are: %s",
			strings.Join(problems, ", "),
			strings.Join(valid, ", "))
	}
	return nil
}

// coerceParams fixes type mismatches between MCP bridge output (all strings)
// and the schema's declared types. For each property, if the schema says
// "integer"/"number"/"boolean" but the value is a JSON string, it coerces
// the value to the correct JSON type. This is applied before the handler
// unmarshals into a Go struct.
func coerceParams(schema json.RawMessage, params json.RawMessage) json.RawMessage {
	var s struct {
		Properties map[string]struct {
			Type string `json:"type"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(schema, &s); err != nil || s.Properties == nil {
		return params
	}

	var m map[string]json.RawMessage
	if err := json.Unmarshal(params, &m); err != nil {
		return params
	}

	changed := false
	for k, raw := range m {
		prop, ok := s.Properties[k]
		if !ok || len(raw) < 2 {
			continue
		}
		// Only coerce if the JSON value is a string (starts with '"')
		if raw[0] != '"' {
			continue
		}
		// Extract the string content
		var strVal string
		if err := json.Unmarshal(raw, &strVal); err != nil {
			continue
		}

		switch prop.Type {
		case "integer":
			// Try to parse as integer — reject floats like "3.5"
			var n int64
			if _, err := fmt.Sscanf(strVal, "%d", &n); err == nil {
				m[k] = json.RawMessage(fmt.Sprintf("%d", n))
				changed = true
			}
		case "number":
			var f float64
			if _, err := fmt.Sscanf(strVal, "%g", &f); err == nil {
				m[k] = json.RawMessage(fmt.Sprintf("%g", f))
				changed = true
			}
		case "boolean":
			lower := strings.ToLower(strVal)
			if lower == "true" || lower == "false" {
				m[k] = json.RawMessage(lower)
				changed = true
			}
		}
	}

	if !changed {
		return params
	}
	b, err := json.Marshal(m)
	if err != nil {
		return params
	}
	return b
}

// camelToSnake converts "findingId" → "finding_id", "lineStart" → "line_start", etc.
func camelToSnake(s string) string {
	var result []rune
	for i, r := range s {
		if unicode.IsUpper(r) {
			if i > 0 {
				result = append(result, '_')
			}
			result = append(result, unicode.ToLower(r))
		} else {
			result = append(result, r)
		}
	}
	return string(result)
}

func registerAllTools(deps *toolDeps) map[string]Tool {
	tools := make(map[string]Tool)
	for _, list := range [][]Tool{
		registerGitTools(deps),
		registerFindingTools(deps),
		registerCommentTools(deps),
		registerReconcileTools(deps),
		registerAnalyticsTools(deps),
		registerBaselineTools(deps),
		registerFeatureTools(deps),
	} {
		for _, t := range list {
			tools[t.Name] = t
		}
	}
	return tools
}
