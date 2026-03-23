package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"bench/internal/model"
)

func registerGitTools(deps *toolDeps) []Tool {
	return []Tool{
		toolSearchCode(deps),
		toolGetBlame(deps),
		toolReadFile(deps),
		toolReadFiles(deps),
		toolListFiles(deps),
		toolGetDiff(deps),
		toolListChangedFiles(deps),
		toolListCommits(deps),
		toolListBranches(deps),
	}
}

func toolSearchCode(deps *toolDeps) Tool {
	return Tool{
		Name:        "search_code",
		Description: "Search for a pattern across all files in the repository at a given commit. Returns matching lines with file paths and line numbers. Supports regular expressions. Essential for finding vulnerability patterns (eval, innerHTML, exec, SQL concatenation, hardcoded secrets, etc.).",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"pattern": {"type": "string", "description": "Search pattern (regular expression)"},
				"commit": {"type": "string", "description": "Commit hash or ref (default: HEAD)"},
				"path": {"type": "string", "description": "Limit search to files under this directory prefix"},
				"max_results": {"type": "integer", "description": "Maximum matches to return (default: 100, max: 500)"},
				"case_insensitive": {"type": "boolean", "description": "Case-insensitive matching (default: false)"}
			},
			"required": ["pattern"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				Pattern         string `json:"pattern"`
				Commit          string `json:"commit"`
				Path            string `json:"path"`
				MaxResults      int    `json:"max_results"`
				CaseInsensitive bool   `json:"case_insensitive"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.Pattern == "" {
				return "", fmt.Errorf("pattern is required")
			}
			if p.Commit == "" {
				head, err := deps.repo.Head()
				if err != nil {
					return "", fmt.Errorf("resolve HEAD: %w", err)
				}
				p.Commit = head
			}
			if p.MaxResults <= 0 {
				p.MaxResults = 100
			}
			if p.MaxResults > 500 {
				p.MaxResults = 500
			}

			matches, err := deps.repo.Grep(p.Pattern, p.Commit, p.Path, p.CaseInsensitive, p.MaxResults)
			if err != nil {
				return "", err
			}
			if len(matches) == 0 {
				return "No matches found.", nil
			}

			var sb strings.Builder
			for _, m := range matches {
				fmt.Fprintf(&sb, "%s:%d: %s\n", m.File, m.Line, m.Text)
			}
			fmt.Fprintf(&sb, "\n%d match(es) found.", len(matches))
			return sb.String(), nil
		},
	}
}

func toolGetBlame(deps *toolDeps) Tool {
	return Tool{
		Name:        "get_blame",
		Description: "Get git blame for a file, showing who last modified each line and when. Optionally scope to a line range. Useful for understanding code history, identifying recent changes, and assessing risk (old stable code vs. freshly rewritten).",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"path": {"type": "string", "description": "File path relative to repo root"},
				"commit": {"type": "string", "description": "Commit hash or ref (default: HEAD)"},
				"line_start": {"type": "integer", "description": "Start of line range (optional)"},
				"line_end": {"type": "integer", "description": "End of line range (optional)"}
			},
			"required": ["path"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				Path      string `json:"path"`
				Commit    string `json:"commit"`
				LineStart int    `json:"line_start"`
				LineEnd   int    `json:"line_end"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.Path == "" {
				return "", fmt.Errorf("path is required")
			}

			lines, err := deps.repo.Blame(p.Commit, p.Path, p.LineStart, p.LineEnd)
			if err != nil {
				return "", err
			}
			if len(lines) == 0 {
				return "No blame data.", nil
			}

			var sb strings.Builder
			fmt.Fprintf(&sb, "%-8s %-20s %-12s %5s  %s\n", "commit", "author", "date", "line", "text")
			for _, l := range lines {
				fmt.Fprintf(&sb, "%-8s %-20s %-12s %5d  %s\n", l.CommitHash, l.Author, l.AuthorDate, l.Line, l.Text)
			}
			return sb.String(), nil
		},
	}
}

func toolReadFile(deps *toolDeps) Tool {
	return Tool{
		Name:        "read_file",
		Description: "Read file content at a specific git commit. Returns the file text with line numbers prefixed (format: `LINE\tCONTENT`). Optionally scope to a line range with line_start and line_end. Always set line_start and line_end when creating findings to ensure accurate line anchoring.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"path": {"type": "string", "description": "File path relative to repo root"},
				"commit": {"type": "string", "description": "Commit hash or ref (default: HEAD)"},
				"line_start": {"type": "integer", "description": "First line to return, 1-indexed (optional)"},
				"line_end": {"type": "integer", "description": "Last line to return, inclusive (optional)"}
			},
			"required": ["path"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				Path      string `json:"path"`
				Commit    string `json:"commit"`
				LineStart int    `json:"line_start"`
				LineEnd   int    `json:"line_end"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.Path == "" {
				return "", fmt.Errorf("path is required")
			}
			if p.Commit == "" {
				head, err := deps.repo.Head()
				if err != nil {
					return "", fmt.Errorf("resolve HEAD: %w", err)
				}
				p.Commit = head
			}
			content, err := deps.repo.Show(p.Commit, p.Path)
			if err != nil {
				return "", err
			}
			lines := strings.Split(content, "\n")
			start := 1
			end := len(lines)
			if p.LineStart > 0 {
				start = p.LineStart
			}
			if p.LineEnd > 0 && p.LineEnd < end {
				end = p.LineEnd
			}
			if start > len(lines) {
				return "", fmt.Errorf("line_start %d exceeds file length %d", start, len(lines))
			}
			var sb strings.Builder
			for i := start; i <= end; i++ {
				fmt.Fprintf(&sb, "%d\t%s\n", i, lines[i-1])
			}
			return sb.String(), nil
		},
	}
}

func toolReadFiles(deps *toolDeps) Tool {
	return Tool{
		Name:        "read_files",
		Description: "Read multiple files in a single call. Returns each file's content with line numbers prefixed (format: `LINE\\tCONTENT`), separated by a header. Prefer this over repeated read_file calls when reading 2 or more files at once. Max 20 files per call.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"paths": {
					"type": "array",
					"items": {"type": "string"},
					"description": "File paths relative to repo root (max 20)"
				},
				"commit": {"type": "string", "description": "Commit hash or ref (default: HEAD)"}
			},
			"required": ["paths"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				Paths  []string `json:"paths"`
				Commit string   `json:"commit"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if len(p.Paths) == 0 {
				return "", fmt.Errorf("paths is required and must not be empty")
			}
			if len(p.Paths) > 20 {
				return "", fmt.Errorf("maximum 20 files per call")
			}
			if p.Commit == "" {
				head, err := deps.repo.Head()
				if err != nil {
					return "", fmt.Errorf("resolve HEAD: %w", err)
				}
				p.Commit = head
			}

			var sb strings.Builder
			for _, path := range p.Paths {
				fmt.Fprintf(&sb, "=== %s ===\n", path)
				content, err := deps.repo.Show(p.Commit, path)
				if err != nil {
					fmt.Fprintf(&sb, "ERROR: %s\n\n", err)
					continue
				}
				lines := strings.Split(content, "\n")
				for i, line := range lines {
					fmt.Fprintf(&sb, "%d\t%s\n", i+1, line)
				}
				sb.WriteByte('\n')
			}
			return sb.String(), nil
		},
	}
}

func toolListFiles(deps *toolDeps) Tool {
	return Tool{
		Name:        "list_files",
		Description: "List all files in the repository tree at a given commit. Returns file paths, one per line.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"commit": {"type": "string", "description": "Commit hash or ref (default: HEAD)"},
				"prefix": {"type": "string", "description": "Filter to paths under this directory prefix"}
			}
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				Commit string `json:"commit"`
				Prefix string `json:"prefix"`
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
			entries, err := deps.repo.Tree(p.Commit)
			if err != nil {
				return "", err
			}
			var sb strings.Builder
			count := 0
			for _, e := range entries {
				if p.Prefix != "" && !strings.HasPrefix(e.Path, p.Prefix) {
					continue
				}
				sb.WriteString(e.Path)
				sb.WriteByte('\n')
				count++
			}
			fmt.Fprintf(&sb, "\n%d file(s).", count)
			return sb.String(), nil
		},
	}
}

func toolGetDiff(deps *toolDeps) Tool {
	return Tool{
		Name:        "get_diff",
		Description: "Get the unified diff between two commits, optionally scoped to a single file. Returns standard unified diff format.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"from_commit": {"type": "string", "description": "Base commit hash or ref"},
				"to_commit": {"type": "string", "description": "Target commit hash or ref"},
				"path": {"type": "string", "description": "Scope diff to this file path (optional)"}
			},
			"required": ["from_commit", "to_commit"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				FromCommit string `json:"from_commit"`
				ToCommit   string `json:"to_commit"`
				Path       string `json:"path"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.FromCommit == "" || p.ToCommit == "" {
				return "", fmt.Errorf("from_commit and to_commit are required")
			}
			raw, err := deps.repo.DiffRaw(p.FromCommit, p.ToCommit, p.Path)
			if err != nil {
				return "", err
			}
			if raw == "" {
				return "No differences.", nil
			}
			return raw, nil
		},
	}
}

func toolListChangedFiles(deps *toolDeps) Tool {
	return Tool{
		Name:        "list_changed_files",
		Description: "List file paths that changed between two commits.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"from_commit": {"type": "string", "description": "Base commit hash or ref"},
				"to_commit": {"type": "string", "description": "Target commit hash or ref"}
			},
			"required": ["from_commit", "to_commit"]
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				FromCommit string `json:"from_commit"`
				ToCommit   string `json:"to_commit"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.FromCommit == "" || p.ToCommit == "" {
				return "", fmt.Errorf("from_commit and to_commit are required")
			}
			files, err := deps.repo.DiffFiles(p.FromCommit, p.ToCommit)
			if err != nil {
				return "", err
			}
			if len(files) == 0 {
				return "No files changed.", nil
			}
			return strings.Join(files, "\n") + fmt.Sprintf("\n\n%d file(s) changed.", len(files)), nil
		},
	}
}

func toolListCommits(deps *toolDeps) Tool {
	return Tool{
		Name:        "list_commits",
		Description: "List commits with hash, author, date, and subject line. Without from_commit/to_commit returns recent repo-wide commits. With a commit range and/or path, returns commits that match — ideal for answering 'which commits changed this file between A and B?'.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"limit": {"type": "integer", "description": "Max commits to return (default: 20, max: 500)"},
				"from_commit": {"type": "string", "description": "Start of range (exclusive). Commits after this one."},
				"to_commit": {"type": "string", "description": "End of range (inclusive, default: HEAD)"},
				"path": {"type": "string", "description": "Only commits touching this file path"}
			}
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			var p struct {
				Limit      int    `json:"limit"`
				FromCommit string `json:"from_commit"`
				ToCommit   string `json:"to_commit"`
				Path       string `json:"path"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return "", fmt.Errorf("invalid params: %w", err)
			}
			if p.Limit <= 0 {
				p.Limit = 20
			}
			if p.Limit > 500 {
				p.Limit = 500
			}

			var commits []model.CommitInfo
			var err error

			if p.FromCommit != "" || p.ToCommit != "" || p.Path != "" {
				commits, err = deps.repo.LogRange(p.FromCommit, p.ToCommit, p.Path, p.Limit)
			} else {
				commits, err = deps.repo.Log(p.Limit)
			}
			if err != nil {
				return "", err
			}
			if len(commits) == 0 {
				return "No commits.", nil
			}
			var sb strings.Builder
			for _, c := range commits {
				fmt.Fprintf(&sb, "%s %s (%s, %s)\n", c.ShortHash, c.Subject, c.Author, c.Date)
			}
			fmt.Fprintf(&sb, "\n%d commit(s).", len(commits))
			return sb.String(), nil
		},
	}
}

func toolListBranches(deps *toolDeps) Tool {
	return Tool{
		Name:        "list_branches",
		Description: "List all branches in the repository with their HEAD commit hashes. Indicates which branch is currently checked out.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {}
		}`),
		Handler: func(ctx context.Context, params json.RawMessage) (string, error) {
			branches, err := deps.repo.Branches()
			if err != nil {
				return "", err
			}
			if len(branches) == 0 {
				return "No branches.", nil
			}
			var sb strings.Builder
			for _, b := range branches {
				marker := "  "
				if b.IsCurrent {
					marker = "* "
				}
				fmt.Fprintf(&sb, "%s%s (%s)\n", marker, b.Name, b.Head)
			}
			return sb.String(), nil
		},
	}
}
