package mcp

import (
	"context"
	"encoding/json"
	"fmt"

	"bench/internal/events"
	"bench/internal/review"
)

func registerReviewBranchTools(deps *toolDeps) []Tool {
	return []Tool{
		toolGetReviewBranch(deps),
		toolSetReviewBranch(deps),
	}
}

func describeBranch(b review.Branch) string {
	s := fmt.Sprintf("Review branch: %s at %.12s", b.Name, b.Tip)
	if b.Saved == "" {
		s += " (the default branch)"
	}
	if b.Missing != "" {
		s += fmt.Sprintf(". Branch %q no longer exists, so %s stands in for it", b.Missing, b.Name)
	}
	return s
}

func toolGetReviewBranch(deps *toolDeps) Tool {
	return Tool{
		Name: "get_review_branch",
		Description: "Get the project's review branch: the branch findings, comments, features, baselines and history " +
			"are looked at on. Lists show only what's anchored on it; the default when unset is the repo's default branch.",
		InputSchema: json.RawMessage(`{"type": "object", "properties": {}}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			b, err := review.Resolve(deps.db, deps.repo, "")
			if err != nil {
				return "", err
			}
			return describeBranch(b), nil
		},
	}
}

func toolSetReviewBranch(deps *toolDeps) Tool {
	return Tool{
		Name: "set_review_branch",
		Description: "Set the project's review branch, for everyone (the UI follows it). It must be a local branch; " +
			"pass \"\" to go back to the repo's default branch.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"branch": {"type": "string", "description": "A local branch name, or \"\" for the default branch"}
			},
			"required": ["branch"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				Branch *string `json:"branch"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.Branch == nil {
				return "", fmt.Errorf("branch is required (\"\" for the default branch)")
			}
			if err := review.Save(deps.db, deps.repo, *p.Branch); err != nil {
				return "", err
			}
			if deps.broker != nil {
				deps.broker.Publish(events.TopicGit)
			}
			b, err := review.Resolve(deps.db, deps.repo, "")
			if err != nil {
				return "", err
			}
			return describeBranch(b), nil
		},
	}
}
