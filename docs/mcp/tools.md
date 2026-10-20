# MCP Tool Reference

Bench tools, then the [multi-project tools](#multi-project-tools). On the aggregate `/mcp`, every bench tool also takes a required `project` parameter (the project slug).

## git

### search_code

Search file contents with a regex pattern.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | yes | Regex pattern |
| `commit` | string | no | Commit to search (default: HEAD) |
| `path` | string | no | Scope to a directory or file |
| `case_insensitive` | bool | no | Case-insensitive match |
| `max_results` | int | no | Max matches to return |

### git_blame

Show line-by-line authorship for a file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | File path |
| `commit` | string | no | Commit (default: HEAD) |

### read_file

Read file contents at a specific commit.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | File path |
| `commit` | string | no | Commit (default: HEAD) |

### list_files

List all files in the repository.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `commit` | string | no | Commit (default: HEAD) |

### get_diff

Get the diff for a file between two commits.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | string | yes | Base commit |
| `to` | string | yes | Target commit |
| `path` | string | yes | File path |

### list_changed_files

List files changed between two commits.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | string | yes | Base commit |
| `to` | string | yes | Target commit |

### list_commits

List recent commits.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | int | no | Max commits (default: 50) |

### list_branches

List branches in the repository. No parameters.

## findings

### list_findings

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_id` | string | no | Filter by file path |
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
| `commit_id` | string | no | Git commit |
| `line_start` | int | no | Start line |
| `line_end` | int | no | End line |
| `description` | string | no | Detailed description |
| `cwe` | string | no | CWE identifier (e.g. `CWE-89`) |
| `cve` | string | no | CVE identifier |
| `vector` | string | no | CVSS vector |
| `score` | float | no | CVSS score |
| `status` | string | no | Initial status (default: `draft`) |
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

### delete_finding

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Finding ID |

### resolve_finding

Mark a finding as resolved at a specific commit.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Finding ID |
| `commit` | string | yes | Commit where it was fixed |

### search_findings

Full-text search across finding titles and descriptions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query |
| `status` | string | no | Filter by status |
| `severity` | string | no | Filter by severity |

### batch_create_findings

Create multiple findings from a JSON array. Accepts the same fields as `create_finding`.

## comments

### list_comments / get_comment / delete_comment

Same pattern as findings. `list_comments` accepts `file_id`, `finding_id`, `commit` filters.

### create_comment

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `author` | string | yes | Author name |
| `text` | string | yes | Comment text |
| `file_id` | string | no | File path |
| `commit_id` | string | no | Git commit |
| `line_start` | int | no | Start line |
| `line_end` | int | no | End line |
| `thread_id` | string | no | Thread grouping ID |
| `parent_id` | string | no | Parent comment ID |
| `finding_id` | string | no | Related finding ID |

### resolve_comment

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Comment ID |
| `commit` | string | yes | Commit where it was resolved |

## baselines

See [Baselines reference](/api/baselines) for full details on data model and workflow.

### set_baseline

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `reviewer` | string | no | Who is setting the baseline (default: `mcp-client`) |
| `summary` | string | no | Optional note |
| `commit_id` | string | no | Git commit (default: default branch tip) |

### list_baselines

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | int | no | Max baselines (default: 20) |

### get_delta

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `baseline_id` | string | no | Specific baseline to compare against its predecessor. Omit to compare current state vs. latest baseline. |

### delete_baseline

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `baseline_id` | string | yes | Baseline ID |

## analytics

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

## reconcile

### reconcile

Start a reconciliation job to update finding and comment positions to HEAD.

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

### get_reconciliation_head

Returns the current reconciliation head state. No parameters.

## Multi-project tools

Only on the aggregate `/mcp`. They take project slugs explicitly where needed, never the injected `project` param. Concepts: [Projects & flows](/concepts/multi-project).

### projects

| Tool | Arguments | Notes |
|---|---|---|
| `list_projects` | – | Slugs, repo paths, stats, activity since the latest baseline. |
| `create_project` | `name`, `repoPath` | Slug derived from the name; takes an initial baseline at HEAD. |
| `update_project` | `project`, `name?`, `repoPath?` | Slug stays the same. |
| `delete_project` | `project` | Registration only; repo and database stay on disk. |
| `list_all_baselines` | – | Recent baselines of every project. |

### features

| Tool | Arguments | Notes |
|---|---|---|
| `search_features` | `query?`, `kind?`, `projects?`, `limit?` | Across projects; results carry `projectSlug` for `flows_add_step`. |
| `get_features` | `refs` (`[{project_slug, feature_id}]`) | Unresolvable refs come back `tombstoned: true`. |

### flows

| Tool | Arguments | Notes |
|---|---|---|
| `flows_list` | `query?`, `status?`, `tag?`, `project?`, `owner?`, `folder?`, `sort?`, `order?`, `limit?`, `offset?` | `sort`: `updated` \| `created` \| `name` \| `stepCount` \| `risk`. Returns `{items, total, offset, limit}`. |
| `flows_list_facets` | same filters as `flows_list` | Values with counts. |
| `flows_get` | `flow_id` | Step tree and `links`; unreachable steps are `tombstoned` with a reason. |
| `flows_create` | `name`, `description?`, `tags?`, `status?`, `owner?`, `folder_id?` | |
| `flows_update` | `flow_id`, plus any of the above | |
| `flows_delete` | `flow_id`, `confirm?` | Dry-run until `confirm: true`. |

### steps and links

| Tool | Arguments | Notes |
|---|---|---|
| `flows_add_step` | `flow_id`, `project_slug`, `feature_id`, `parent_step_id?`, `branch_condition?`, `note?` | |
| `flows_update_step` | `flow_id`, `step_id`, `note?`, `branch_condition?` | |
| `flows_remove_step` | `flow_id`, `step_id` | Cascades to children and their links. |
| `flows_move_step` | `flow_id`, `step_id`, `direction` | `-1` up, `1` down. |
| `flows_set_steps` | `flow_id`, `steps`, `links?` | Replaces the tree atomically; returns `stepIds` keyed by `client_id`. |
| `flows_set_link` | `flow_id`, `from_step_id`, `to_step_id`, `description?`, `comment?`, `tags?` | Steps may be on different projects. Self-links and steps from another flow are rejected. |
| `flows_delete_link` | `flow_id`, `from_step_id`, `to_step_id` | |

### baselines and findings

| Tool | Arguments | Notes |
|---|---|---|
| `flows_set_baseline` | `flow_id`, `reviewer?`, `summary?` | |
| `flows_list_baselines` | `flow_id` | Newest first. |
| `flows_get_baseline` | `flow_id`, `baseline_id` | `latest` works as an id. |
| `flows_get_delta` | `flow_id`, `since_baseline_id?` | Added, removed, changed steps and moved anchors. |
| `flows_delete_baseline` | `flow_id`, `baseline_id`, `confirm?` | Dry-run until `confirm: true`. |
| `flows_list_findings` | `flow_id` | Open findings on the flow's features, by severity. |

### folders

| Tool | Arguments | Notes |
|---|---|---|
| `flows_list_folders` | – | Flat list with `parentId`, `flowCount`, `folderCount`. |
| `flows_create_folder` | `name`, `parent_id?` | Sibling names are unique. |
| `flows_update_folder` | `folder_id`, `name?`, `parent_id?` | `parent_id: ""` = top level; cycles are rejected. |
| `flows_delete_folder` | `folder_id`, `confirm?` | Dry-run until `confirm: true`; deletes subfolders and their flows. |
| `flows_move` | `flow_ids?`, `folder_ids?`, `target_folder_id` | All-or-nothing. |

`flows_list` takes `folder` (an id or `root`), and `flows_create` / `flows_update` take `folder_id`.

### views

| Tool | Arguments | Notes |
|---|---|---|
| `flows_list_views` | – | Most recently updated first. |
| `flows_create_view` | `name`, `query?`, `owner?`, `is_shared?` | `query` uses the Flows filter syntax, e.g. `status:active project:api,web login`. |
| `flows_update_view` | `view_id`, `name?`, `query?`, `is_shared?` | |
| `flows_delete_view` | `view_id` | Flows are not affected. |
