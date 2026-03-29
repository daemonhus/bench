# Bench — Agent Guide

Bench is a code review workbench. This guide covers how to use it as a tool: connecting via MCP, using the CLI, and working with findings, features, comments, baselines, and reconciliation.

## Data Model

### Anchor

Every annotation (finding or comment) is pinned to a specific location:

```typescript
{
  fileId: string      // file path, e.g. "src/api/auth.go"
  commitId: string    // git commit hash
  lineRange?: { start: number, end: number }
}
```

The commit makes annotations stable. When code moves, reconciliation updates the line numbers.

### Finding

A discovered vulnerability or security issue.

```typescript
{
  id: string
  anchor: Anchor
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  status: 'draft' | 'open' | 'in-progress' | 'false-positive' | 'accepted' | 'closed'
  title: string
  description?: string
  cwe?: string        // e.g. "CWE-89"
  cve?: string
  vector?: string     // CVSS vector
  score?: number      // CVSS score
  source?: string     // tool or scanner that found it
  category?: string
  createdAt: string
  resolvedCommit?: string
}
```

### Comment

A code review note.

```typescript
{
  id: string
  anchor: Anchor
  author: string
  text: string
  timestamp: string
  threadId?: string   // groups comments into a thread
  parentId?: string   // reply to a specific comment
  findingId?: string  // link to a related finding
  resolvedCommit?: string
}
```

### Baseline

An immutable snapshot of review state at a point in time. Records every finding ID and aggregate stats. Never changes once created.

```typescript
{
  id: string
  seq: number         // auto-incrementing (1, 2, 3…)
  commitId: string
  reviewer: string
  summary?: string
  createdAt: string
  findingsTotal: number
  findingsOpen: number
  bySeverity: { critical, high, medium, low, info }
  byStatus: { draft, open, 'in-progress', 'false-positive', accepted, closed }
  byCategory: Record<string, number>
  commentsTotal: number
  commentsOpen: number
  findingIds: string[]  // every finding ID at snapshot time — core of delta computation
}
```

### BaselineDelta

What changed since a baseline.

```typescript
{
  sinceBaseline: Baseline
  headCommit: string
  newFindings: Finding[]        // exist now but not in the baseline
  removedFindingIds: string[]   // in the baseline but no longer exist
  changedFiles: string[]        // files modified between baseline commit and HEAD
  currentStats: ProjectStats
}
```

## Typical Review Workflow

```
1. set_baseline             ← checkpoint before starting (captures empty state as reference)
2. search code, read files  ← use git tools to explore
3. create_finding (×N)      ← record vulnerabilities as you find them
4. create_feature (×N)      ← record new endpoints, data sources/sinks, or long-lived annotations
5. get_delta                ← check progress: how many new findings since baseline?
6. set_baseline             ← checkpoint at milestones (e.g. "auth module complete")
7. get_delta(baseline_id)   ← what did this round produce?
8. set_baseline             ← final snapshot — this is the deliverable
```

Baselines are cheap — create them liberally. The delta is where the interesting analysis happens.

**After code changes under you:**
```
reconcile               ← update annotation positions to current code
get_delta               ← changedFiles shows what moved
set_baseline            ← checkpoint the updated state
```

## MCP Tools

> **When to use MCP vs CLI:** If you are connected via MCP, use MCP tools — they are the primary interface. The CLI is for human operators and shell scripting. Do not mix them: MCP uses `file`/`commit` as parameter names; the CLI uses `--file-id`/`--commit-id`. All `commit` parameters accept a hash, ref, or `HEAD`.

### git

| Tool | Description |
|------|-------------|
| `search_code` | Regex search across the repo. Params: `pattern` (req), `commit`, `path`, `case_insensitive`, `max_results` (default 100, max 500) |
| `read_file` | File content with line numbers. Params: `path` (req), `commit`, `line_start`, `line_end` |
| `read_files` | Read up to 20 files in one call. Params: `paths[]` (req), `commit`. Prefer over repeated `read_file`. |
| `list_files` | Params: `commit`, `prefix` |
| `get_diff` | Params: `from_commit` (req), `to_commit` (req), `path` |
| `list_changed_files` | Params: `from_commit` (req), `to_commit` (req) |
| `list_commits` | Params: `limit` (default 20, max 500), `from_commit`, `to_commit`, `path` |
| `list_branches` | No parameters |
| `get_blame` | Params: `path` (req), `commit`, `line_start`, `line_end` |

### findings

| Tool | Description |
|------|-------------|
| `create_finding` | Params: `title` (req), `severity` (req), `file`, `commit`, `line_start`, `line_end`, `description`, `cwe`, `cve`, `vector`, `score`, `status` (default `open`), `source`, `category` |
| `list_findings` | Params: `file`, `commit`, `severity`, `status` |
| `get_finding` | Params: `id` (req) |
| `update_finding` | Params: `id` (req), then any of: `title`, `severity`, `description`, `status`, `line_start`, `line_end`, `cwe`, `cve`, `category` |
| `resolve_finding` | Params: `id` (req), `commit` (req) — marks closed, records fix commit |
| `delete_finding` | Params: `id` (req) |
| `search_findings` | Full-text search. Params: `query` (req), `status`, `severity` |
| `batch_create_findings` | Create many findings in one transaction. Params: `findings[]` (same fields as `create_finding`). All-or-nothing. |

### comments

| Tool | Description |
|------|-------------|
| `create_comment` | Params: `author` (req), `text` (req), `file` (req), `commit` (req), `line_start`, `line_end`, `thread_id`, `parent_id`, `finding_id` |
| `list_comments` | Params: `file`, `finding_id`, `commit`, `full_text` (default false, truncates at 120 chars) |
| `get_comment` | Params: `id` (req) |
| `update_comment` | Params: `id` (req), `text` |
| `resolve_comment` | Params: `id` (req), `commit` (req) |
| `delete_comment` | Params: `id` (req) |
| `batch_create_comments` | Params: `comments[]`. Each needs `author`, `text`, `file`, `commit`. |

### features

| Tool | Description |
|------|-------------|
| `create_feature` | Params: `file` (req), `commit` (req), `kind` (req: `interface`\|`source`\|`sink`\|`dependency`\|`externality`), `title` (req, e.g. `"Login endpoint"` — do **not** include the HTTP method in the title; use `operation` for that), `line_start`, `line_end`, `description`, `operation` (HTTP method, gRPC method, GraphQL operation type, etc.), `direction` (`in`\|`out`), `protocol`, `status` (default `active`), `tags`, `source` |
| `list_features` | Params: `file`, `kind`, `status` |
| `get_feature` | Params: `id` (req) |
| `update_feature` | Params: `id` (req), then any of: `kind`, `title`, `description`, `operation`, `direction`, `protocol`, `status`, `tags`, `line_start`, `line_end` |
| `delete_feature` | Params: `id` (req) |
| `batch_create_features` | Create many features in one transaction. Params: `features[]` (same fields as `create_feature`). All-or-nothing. |

### baselines

| Tool | Description |
|------|-------------|
| `set_baseline` | Params: `reviewer`, `summary`, `commit_id` (default: HEAD). Returns seq number, stats, ID. |
| `list_baselines` | Params: `limit` (default 20) |
| `get_delta` | No `baseline_id` → current state vs. latest baseline. With `baseline_id` → that baseline vs. its predecessor. |
| `delete_baseline` | Params: `baseline_id` (req) |

### analytics

| Tool | Description |
|------|-------------|
| `get_summary` | Finding and comment counts by severity, status, category. Optional: `commit`. |
| `get_coverage` | Files reviewed vs. not. Params: `commit`, `path`, `only_unreviewed` |
| `mark_reviewed` | Params: `path` (req), `commit` (req), `reviewer`, `note` |

### reconcile

| Tool | Description |
|------|-------------|
| `reconcile` | Update annotation positions after code changes. Params: `target_commit` (req), `file_paths[]` |
| `get_reconciliation_status` | Params: `job_id`, `file_id`, `commit` |
| `get_annotation_history` | See how a position moved over time. Params: `type` (req: `finding`\|`comment`), `id` (req) |

## CLI Quick Reference

> **Note:** CLI flag names differ from MCP parameter names. MCP uses `file`/`commit`; CLI uses `--file-id`/`--commit-id`. All `--commit-id` flags accept a hash, ref, or `HEAD`. For `batch-create`, pipe a JSON array of objects matching the create fields (same shape as MCP batch schemas) to stdin.

```bash
# Git exploration
bench git search-code --pattern "eval(" --case-insensitive
bench git read-file --path src/auth/login.go --commit abc123
bench git diff --from HEAD~1 --to HEAD --path src/auth/login.go
bench git changed-files --from HEAD~5 --to HEAD
bench git commits --limit 20

# Findings
bench findings create --file-id src/api/auth.go --commit-id HEAD \
  --line-start 42 --line-end 48 --severity high --title "SQL injection" --cwe CWE-89
bench findings list --status open
bench findings list --severity critical
bench findings update --id <id> --status in-progress
bench findings resolve --id <id> --commit <fix-commit>
bench findings search --query "injection"
cat findings.json | bench findings batch-create

# Features
bench features create --file-id src/api/auth.go --commit-id HEAD --kind interface --title "Login endpoint" --operation POST
bench features list --kind sink
bench features update --id <id> --status deprecated

# Baselines
bench baselines set --reviewer alice --summary "Auth module review"
bench baselines delta                    # vs. latest baseline
bench baselines delta --id <id>         # vs. predecessor
bench baselines list

# Analytics
bench analytics summary
bench analytics coverage --only-unreviewed
bench analytics mark-reviewed --path src/api/auth.go --commit HEAD --reviewer alice

# Reconcile
bench reconcile start
bench reconcile status --job-id <id>
bench reconcile history --type finding --id <id>
```

## Important Notes

**Resolved findings are included in baseline snapshots.** `findingIds` captures all findings including closed/resolved ones. `list_findings` excludes resolved by default, so delta counts may appear higher. Use `include_resolved=true` (MCP) or `--status closed` (CLI) when cross-referencing.

**Baselines snapshot the database, not the commit.** Setting a baseline at commit X records all findings currently in the database — regardless of which commit each finding was anchored to. `commitId` is used for git diffs (changedFiles), not for scoping which findings are included.

**`get_delta` has two modes:**
- No `baseline_id` → "what changed since my last checkpoint?" (current state vs. latest baseline)
- With `baseline_id` → "what did a specific round of work produce?" (that baseline vs. its predecessor)

**Reconciliation confidence levels:** `exact` (line-mapped through diff) → `moved` (placed by content match) → `orphaned` (code deleted, no reliable position). Confidence can only decrease.
