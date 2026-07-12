package mcp

import (
	"context"
	"encoding/json"
	"fmt"

	"bench/internal/events"
	"bench/internal/model"
)

// originEntityAnchor returns the anchor of a finding or feature, erroring
// when the entity does not exist. It doubles as the writes' existence check.
func originEntityAnchor(deps *toolDeps, entityType, id string) (model.Anchor, error) {
	switch entityType {
	case "finding":
		f, err := deps.db.GetFinding(id)
		if err != nil {
			return model.Anchor{}, fmt.Errorf("finding not found: %w", err)
		}
		return f.Anchor, nil
	case "feature":
		f, err := deps.db.GetFeature(id)
		if err != nil {
			return model.Anchor{}, fmt.Errorf("feature not found: %w", err)
		}
		return f.Anchor, nil
	}
	return model.Anchor{}, fmt.Errorf("unknown entity type %q", entityType)
}

func toolSetOrigin(deps *toolDeps, entityType string) Tool {
	what := "the vulnerability"
	if entityType == "feature" {
		what = "the surface (endpoint, data flow, dependency)"
	}
	return Tool{
		Name:        "set_" + entityType + "_origin",
		Description: fmt.Sprintf("Record the historical context of a %s: a free-text explanation of how %s came to be, plus the git coordinates of its introduction (commit, date, actor, branch). Upsert with merge semantics: only the fields you pass are overwritten. Use suggest_%s_origin first: it derives commit, date, and actor from blame, finds the merge request that brought the change in (its subject is usually the best explanation source), and pre-parses the branch name.", entityType, what, entityType),
		InputSchema: json.RawMessage(fmt.Sprintf(`{
			"type": "object",
			"properties": {
				"id": {"type": "string", "description": "%s ID"},
				"explanation": {"type": "string", "description": "How it came to be: the change, refactor, or decision that introduced it"},
				"introduced_commit": {"type": "string", "description": "Commit where it landed (full sha preferred; resolvable refs are normalised and pinned)"},
				"introduced_date": {"type": "string", "description": "When it was introduced (ISO date)"},
				"actor": {"type": "string", "description": "Author who introduced it"},
				"branch": {"type": "string", "description": "Branch or merge request it arrived on"}
			},
			"required": ["id"]
		}`, entityType)),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				ID               string  `json:"id"`
				Explanation      *string `json:"explanation"`
				IntroducedCommit *string `json:"introduced_commit"`
				IntroducedDate   *string `json:"introduced_date"`
				Actor            *string `json:"actor"`
				Branch           *string `json:"branch"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.ID == "" {
				return "", fmt.Errorf("id is required")
			}
			if _, err := originEntityAnchor(deps, entityType, p.ID); err != nil {
				return "", err
			}

			current, err := deps.db.GetOrigin(entityType, p.ID)
			if err != nil {
				return "", err
			}
			merged := model.Origin{}
			if current != nil {
				merged = *current
			}
			if p.Explanation != nil {
				merged.Explanation = *p.Explanation
			}
			if p.IntroducedCommit != nil {
				merged.IntroducedCommit = *p.IntroducedCommit
			}
			if p.IntroducedDate != nil {
				merged.IntroducedDate = *p.IntroducedDate
			}
			if p.Actor != nil {
				merged.Actor = *p.Actor
			}
			if p.Branch != nil {
				merged.Branch = *p.Branch
			}

			// Normalise and pin a resolvable introduced commit; unresolvable
			// values are stored as-is (the commit may be rewritten history).
			if p.IntroducedCommit != nil && merged.IntroducedCommit != "" {
				if sha, err := deps.repo.ResolveRef(merged.IntroducedCommit); err == nil {
					merged.IntroducedCommit = sha
					_ = deps.repo.PinCommit(sha)
				}
			}

			if err := deps.db.PutOrigin(entityType, p.ID, merged); err != nil {
				return "", err
			}
			if deps.broker != nil {
				deps.broker.Publish(events.TopicAnnotations)
			}
			b, err := json.MarshalIndent(merged, "", "  ")
			if err != nil {
				return "", err
			}
			return "Origin recorded:\n" + string(b), nil
		},
	}
}

func toolSuggestOrigin(deps *toolDeps, entityType string) Tool {
	return Tool{
		Name:        "suggest_" + entityType + "_origin",
		Description: fmt.Sprintf("Derive origin context for a %s from git: blame on the anchor lines picks the introducing commit (with author and date), a first-parent walk finds the merge request that brought it into the mainline (merge_subject is usually the best source for the explanation), the branch name is parsed from the merge subject, and context lists recent commits touching the anchor file. Read-only; confirm what matters with set_%s_origin.", entityType, entityType),
		InputSchema: json.RawMessage(fmt.Sprintf(`{
			"type": "object",
			"properties": {
				"id": {"type": "string", "description": "%s ID"}
			},
			"required": ["id"]
		}`, entityType)),
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
			anchor, err := originEntityAnchor(deps, entityType, p.ID)
			if err != nil {
				return "", err
			}
			start, end := 0, 0
			if anchor.LineRange != nil {
				start, end = anchor.LineRange.Start, anchor.LineRange.End
			}
			suggestion, err := deps.repo.OriginSuggestion(anchor.FileID, anchor.CommitID, start, end)
			if err != nil {
				return "", fmt.Errorf("suggest origin: %w", err)
			}
			b, err := json.MarshalIndent(suggestion, "", "  ")
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("Suggested origin (confirm with set_%s_origin):\n%s", entityType, b), nil
		},
	}
}
