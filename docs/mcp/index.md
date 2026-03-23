# MCP Overview

Bench exposes all bench tools over [Model Context Protocol](https://modelcontextprotocol.io) (Streamable HTTP, JSON-RPC 2.0). Every tool available in the CLI is also available over MCP -the same handler code runs in both paths.

## Connect with Claude

```bash
claude mcp add --transport http bench http://localhost:8080/mcp
```

The endpoint is at `http://localhost:8080/mcp`. All tools are scoped to the single repo - no `project` parameter needed.

## Tool groups

Tools are organized into six groups matching the CLI categories:

| Group | Tools |
|-------|-------|
| `git` | `search_code`, `get_blame`, `read_file`, `read_files`, `list_files`, `get_diff`, `list_changed_files`, `list_commits`, `list_branches` |
| `findings` | `list_findings`, `get_finding`, `create_finding`, `update_finding`, `delete_finding`, `resolve_finding`, `search_findings`, `batch_create_findings` |
| `comments` | `list_comments`, `get_comment`, `create_comment`, `update_comment`, `delete_comment`, `resolve_comment`, `batch_create_comments` |
| `features` | `list_features`, `get_feature`, `create_feature`, `update_feature`, `delete_feature`, `batch_create_features` |
| `baselines` | `set_baseline`, `list_baselines`, `get_delta`, `delete_baseline` |
| `analytics` | `get_summary`, `get_coverage`, `mark_reviewed` |
| `reconcile` | `reconcile`, `get_reconciliation_status`, `get_annotation_history` |

## Tool reference

All tools are scoped to the single repo instance.

### search_code

Search file contents with a regex pattern.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | yes | Regex pattern |
| `commit` | string | no | Commit to search (default: HEAD) |
| `path` | string | no | Scope to a directory or file |
| `case_insensitive` | bool | no | Case-insensitive match |
| `max_results` | int | no | Max matches to return (default: 100, max: 500) |

### get_blame

Get git blame for a file, showing who last modified each line.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | File path |
| `commit` | string | no | Commit (default: HEAD) |
| `line_start` | int | no | Start of line range |
| `line_end` | int | no | End of line range |

### read_file

Read file content at a specific commit. Returns content with line numbers prefixed (`LINE\tCONTENT`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | File path |
| `commit` | string | no | Commit (default: HEAD) |
| `line_start` | int | no | First line to return, 1-indexed |
| `line_end` | int | no | Last line to return, inclusive |

### read_files

Read multiple files in a single call. Returns each file's content with line numbers prefixed, separated by a `=== path ===` header. Prefer this over repeated `read_file` calls when reading 2 or more files. Max 20 files per call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `paths` | string[] | yes | File paths relative to repo root (max 20) |
| `commit` | string | no | Commit (default: HEAD) |

### list_files

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `commit` | string | no | Commit (default: HEAD) |
| `prefix` | string | no | Filter to paths under this directory prefix |

### get_diff

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from_commit` | string | yes | Base commit |
| `to_commit` | string | yes | Target commit |
| `path` | string | no | Scope diff to this file path |

### list_changed_files

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from_commit` | string | yes | Base commit |
| `to_commit` | string | yes | Target commit |

### list_commits

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | int | no | Max commits (default: 20, max: 500) |
| `from_commit` | string | no | Start of range (exclusive) |
| `to_commit` | string | no | End of range (inclusive, default: HEAD) |
| `path` | string | no | Only commits touching this file path |

### list_branches

No parameters.

---

### list_findings

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file` | string | no | Filter by file path |
| `commit` | string | no | Filter by commit |
| `severity` | string | no | Filter by severity |
| `status` | string | no | Filter by status |

### get_finding

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Finding ID |

### create_finding

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | yes | Short title |
| `severity` | string | yes | `critical` \| `high` \| `medium` \| `low` \| `info` |
| `file` | string | no | File path |
| `commit` | string | no | Git commit |
| `line_start` | int | no | Start line |
| `line_end` | int | no | End line |
| `description` | string | no | Detailed description |
| `cwe` | string | no | CWE identifier (e.g. `CWE-89`) |
| `cve` | string | no | CVE identifier |
| `vector` | string | no | CVSS vector |
| `score` | float | no | CVSS score |
| `status` | string | no | Initial status (default: `open`) |
| `source` | string | no | Tool or scanner that found it |
| `category` | string | no | Category label |

### update_finding

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Finding ID |
| `title` | string | no | New title |
| `severity` | string | no | New severity |
| `description` | string | no | New description |
| `status` | string | no | New status |
| `line_start` | int | no | New start line (recomputes line hash) |
| `line_end` | int | no | New end line (recomputes line hash) |
| `cwe` | string | no | New CWE |
| `cve` | string | no | New CVE |
| `category` | string | no | New category |

### delete_finding / resolve_finding

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Finding ID |
| `commit` | string | yes (resolve only) | Commit where it was fixed |

### search_findings

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query |
| `status` | string | no | Filter by status |
| `severity` | string | no | Filter by severity |

### batch_create_findings

Create multiple findings in a single transaction. Accepts the same fields as `create_finding` in a `findings` array. All-or-nothing — rolls back on any error.

---

### list_comments

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file` | string | no | Filter by file path |
| `finding_id` | string | no | Filter by associated finding |
| `commit` | string | no | Filter by commit |
| `full_text` | bool | no | Return full comment bodies (default: false, truncates at 120 chars) |

### get_comment / delete_comment

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Comment ID |

### create_comment

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `author` | string | yes | Author name |
| `text` | string | yes | Comment text |
| `file` | string | yes | File path |
| `commit` | string | yes | Git commit |
| `line_start` | int | no | Start line |
| `line_end` | int | no | End line |
| `thread_id` | string | no | Thread grouping ID |
| `parent_id` | string | no | Parent comment ID |
| `finding_id` | string | no | Related finding ID |

### update_comment

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Comment ID |
| `text` | string | no | New text |

### resolve_comment

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Comment ID |
| `commit` | string | yes | Commit where it was resolved |

### batch_create_comments

Create multiple comments in a single call. Accepts a `comments` array where each item takes the same fields as `create_comment`. `author`, `file`, `commit`, and `text` are required per item.

---

### list_features

List architectural feature annotations, optionally filtered.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file` | string | no | Filter by file path |
| `kind` | string | no | Filter by kind: `interface` \| `source` \| `sink` \| `dependency` \| `externality` |
| `status` | string | no | Filter by status: `draft` \| `active` \| `deprecated` \| `removed` \| `orphaned` |

### get_feature

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Feature ID |

### create_feature

Annotate an architectural feature: an API interface, data source/sink, dependency injection point, or externality (background worker, side-effect).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file` | string | yes | File path |
| `commit` | string | yes | Commit where the feature was identified |
| `kind` | string | yes | `interface` \| `source` \| `sink` \| `dependency` \| `externality` |
| `title` | string | yes | Short title |
| `line_start` | int | no | Start line |
| `line_end` | int | no | End line |
| `description` | string | no | Detailed description |
| `operation` | string | no | HTTP method, gRPC method, GraphQL operation type, etc. |
| `direction` | string | no | Data flow direction: `in` \| `out` |
| `protocol` | string | no | Protocol (e.g. `rest`, `grpc`, `graphql`, `websocket`) |
| `status` | string | no | Initial status (default: `active`) |
| `tags` | string[] | no | Optional tags |
| `source` | string | no | Tool or scanner that identified the feature |

### update_feature

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Feature ID |
| `kind` | string | no | New kind |
| `title` | string | no | New title |
| `description` | string | no | New description |
| `operation` | string | no | New operation |
| `direction` | string | no | New direction |
| `protocol` | string | no | New protocol |
| `status` | string | no | New status |
| `tags` | string[] | no | New tags |
| `line_start` | int | no | New start line |
| `line_end` | int | no | New end line |

### delete_feature

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Feature ID |

### batch_create_features

Create multiple feature annotations in one transaction. All-or-nothing. Accepts a `features` array where each item takes the same fields as `create_feature`. `file`, `commit`, `kind`, and `title` are required per item. Max 100 per call.

---

### set_baseline

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `reviewer` | string | no | Who is setting the baseline |
| `summary` | string | no | Optional note |
| `commit_id` | string | no | Git commit (default: HEAD) |

### list_baselines

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | int | no | Max baselines (default: 20) |

### get_delta

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `baseline_id` | string | no | Omit to compare current state vs. latest baseline. Provide to compare that baseline against its predecessor. |

### delete_baseline

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `baseline_id` | string | yes | Baseline ID |

---

### get_summary

Returns finding and comment counts by severity, status, and category. No parameters (or optional `commit`).

### get_coverage

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `commit` | string | no | Commit to check against |
| `path` | string | no | Scope to a directory |
| `only_unreviewed` | bool | no | Only return unreviewed files |

### mark_reviewed

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | File path |
| `commit` | string | yes | Commit being reviewed |
| `reviewer` | string | no | Reviewer name |
| `note` | string | no | Optional note |

---

### reconcile

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `target_commit` | string | yes | Commit to reconcile to |
| `file_paths` | string[] | no | Scope to specific files |

### get_reconciliation_status

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `job_id` | string | no | Specific job ID |
| `file_id` | string | no | Filter by file |
| `commit` | string | no | Filter by commit |

### get_annotation_history

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | yes | `finding` or `comment` |
| `id` | string | yes | Finding or comment ID |
