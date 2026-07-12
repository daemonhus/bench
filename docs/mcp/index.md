# MCP Overview

Bench exposes its tools over [Model Context Protocol](https://modelcontextprotocol.io) (Streamable HTTP, JSON-RPC 2.0). Every CLI tool is available over MCP; the same handler code runs in both paths.

## Connect with Claude

```bash
claude mcp add --transport http bench http://localhost:8080/mcp
```

The endpoint is at `http://localhost:8080/mcp`. All tools are scoped to the single repo - no `project` parameter needed.

## Tool groups

Tools are organized into nine groups matching the CLI categories:

| Group | Tools |
|-------|-------|
| `git` | `search_code`, `get_blame`, `read_file`, `read_files`, `list_files`, `get_diff`, `list_changed_files`, `list_commits`, `list_branches` |
| `findings` | `list_findings`, `get_finding`, `create_finding`, `update_finding`, `delete_finding`, `resolve_finding`, `search_findings`, `batch_create_findings`, `set_finding_origin`, `clear_finding_origin`, `suggest_finding_origin` |
| `comments` | `list_comments`, `get_comment`, `create_comment`, `update_comment`, `delete_comment`, `resolve_comment`, `batch_create_comments` |
| `features` | `list_features`, `get_feature`, `create_feature`, `update_feature`, `delete_feature`, `batch_create_features`, `list_feature_parameters`, `get_feature_parameter`, `create_feature_parameter`, `update_feature_parameter`, `delete_feature_parameter`, `set_feature_origin`, `clear_feature_origin`, `suggest_feature_origin` |
| `baselines` | `set_baseline`, `list_baselines`, `get_delta`, `delete_baseline` |
| `analytics` | `get_summary`, `get_coverage`, `mark_reviewed` |
| `reconcile` | `reconcile`, `get_reconciliation_status`, `get_annotation_history` |
| `refs` | `list_refs`, `get_ref`, `create_ref`, `update_ref`, `delete_ref`, `batch_create_refs` |
| `profile` | `get_service_profile`, `update_service_profile` |

## The write gate

Every review-judgment write (findings, comments, features, refs, baselines, `mark_reviewed`) is rejected with a tool error until the [service profile](/panel/profile) has been set at least once. `update_service_profile` is the bootstrap path and is always allowed, and an empty update satisfies the gate.

Start a session with `get_service_profile`: it tells you which finding classes are moot (rate limiting at the gateway, auth terminated upstream) and which are amplified (multi-tenant, PII, internet-facing). The profile is embedded in `get_summary` and `get_delta` responses, so a session that opens with either already has it.

Empty fields mean "not configured", never "confirmed absent". Only an explicit `none` in a multi-select may downgrade a finding.

## Tool reference

All tools are scoped to the single repo instance.

### search_code

Search file contents with a regex pattern. Uses Go's RE2 syntax, so alternation (`foo|bar`), grouping (`(foo)+`), and `+`/`?` quantifiers work without escaping. Backreferences and lookaheads are not supported.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | yes | Extended regex (ERE) pattern |
| `commit` | string | no | Commit to search (default: HEAD) |
| `path` | string | no | Scope to a directory or file |
| `ignore_case` | bool | no | Case-insensitive match |
| `fixed` | bool | no | Treat pattern as a literal string (disables regex) |
| `limit` | int | no | Max matches to return (default: 100, max: 500) |

### get_blame

Get git blame for a file, showing who last modified each line.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | File path |
| `commit` | string | no | Commit (default: HEAD) |
| `start` | int | no | Start of line range |
| `end` | int | no | End of line range |

### read_file

Read file content at a specific commit. Returns content with line numbers prefixed (`LINE\tCONTENT`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | File path |
| `commit` | string | no | Commit (default: HEAD) |
| `start` | int | no | First line to return, 1-indexed |
| `end` | int | no | Last line to return, inclusive |

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
| `from` | string | yes | Base commit |
| `to` | string | yes | Target commit |
| `path` | string | no | Scope diff to this file path |

### list_changed_files

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | string | yes | Base commit |
| `to` | string | yes | Target commit |

### list_commits

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | int | no | Max commits (default: 20, max: 500) |
| `from` | string | no | Start of range (exclusive) |
| `to` | string | no | End of range (inclusive, default: HEAD) |
| `path` | string | no | Only commits touching this file path |

### list_branches

No parameters.

---

### list_findings

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file` | string | no | Filter by file path |
| `severity` | string | no | Filter by severity |
| `status` | string | no | Filter by status |
| `category` | string | no | Filter by category |
| `resolved` | bool | no | Include resolved findings (default: false) |

### get_finding

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Finding ID |

### create_finding

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | yes | Short title |
| `severity` | string | yes | `critical` \| `high` \| `medium` \| `low` \| `info` |
| `file` | string | yes | File path |
| `commit` | string | yes | Commit hash or ref (e.g. `HEAD`, branch name, or full SHA) |
| `description` | string | yes | Detailed description |
| `start` | int | no | Start line |
| `end` | int | no | End line |
| `cwe` | string | no | CWE identifier (e.g. `CWE-89`) |
| `cve` | string | no | CVE identifier |
| `vector` | string | no | CVSS vector |
| `score` | float | no | CVSS score |
| `status` | string | no | Initial status: `draft` (tentative) or `open` (confirmed). Default: `draft`. |
| `source` | string | no | Tool or scanner that found it. One of `pentest`, `tool`, `manual`, `mcp`. Default: `mcp`. |
| `category` | string | no | Category label |
| `external_id` | string | no | External identifier from source system (e.g. `F001`, `VULN-42`) |
| `features` | string[] | no | Feature IDs to link to this finding |

### update_finding

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Finding ID |
| `title` | string | no | New title |
| `severity` | string | no | New severity |
| `description` | string | no | New description |
| `status` | string | no | New status |
| `file` | string | no | New file path (re-anchors; recomputes line hash) |
| `commit` | string | no | New commit (re-anchors; recomputes line hash) |
| `start` | int | no | New start line (re-anchors; recomputes line hash) |
| `end` | int | no | New end line (re-anchors; recomputes line hash) |
| `cwe` | string | no | New CWE |
| `cve` | string | no | New CVE |
| `category` | string | no | New category |
| `external_id` | string | no | External identifier from source system |
| `features` | string[] | no | Linked feature IDs (replaces full list) |

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

Create multiple findings in a single transaction. Accepts the same fields as `create_finding` in a `findings` array. `title`, `severity`, `file`, `commit`, and `description` are required per item. Optional fields: `start`, `end`, `cwe`, `cve`, `vector`, `score`, `status`, `source`, `category`, `external_id`, `features`. All-or-nothing - rolls back on any error.

---

### list_comments

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file` | string | no | Filter by file path |
| `finding` | string | no | Filter to comments linked to this finding |
| `feature` | string | no | Filter to comments linked to this feature |
| `resolved` | bool | no | Include resolved comments (default: false) |
| `full` | bool | no | Return full comment bodies (default: false, truncates at 120 chars) |

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
| `start` | int | no | Start line |
| `end` | int | no | End line |
| `parent` | string | no | Parent comment ID (inherits the parent's thread) |
| `finding` | string | no | Related finding ID |
| `feature` | string | no | Related feature ID |
| `type` | string | no | `feature` \| `improvement` \| `question` \| `concern` |

### update_comment

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Comment ID |
| `text` | string | no | New text |
| `author` | string | no | New author name |
| `file` | string | no | New file path (re-anchors; recomputes line hash) |
| `commit` | string | no | New commit (re-anchors; recomputes line hash) |
| `start` | int | no | New start line (re-anchors; recomputes line hash) |
| `end` | int | no | New end line (re-anchors; recomputes line hash) |

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
| `linked_to` | string | no | Return only features linked to this feature ID (either direction) |

### get_feature

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Feature ID |

### create_feature

Annotate an architectural feature: an API interface, data source/sink, dependency injection point, or externality (background worker, side-effect).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file` | string | yes | File path |
| `commit` | string | yes | Commit hash or ref (e.g. `HEAD`, branch name, or full SHA) |
| `kind` | string | yes | `interface` (API endpoint/handler) \| `source` (data input: DB read, file read) \| `sink` (data output: DB write, outbound call) \| `dependency` (third-party lib/service) \| `externality` (background job, scheduler, side-effect) |
| `title` | string | yes | Short label. Do **not** include the HTTP method (e.g. `"Login endpoint"`, not `"POST /login"`). Use `operation` for it. |
| `start` | int | no | Start line |
| `end` | int | no | End line |
| `description` | string | no | Detailed description |
| `operation` | string | no | HTTP method (GET/POST/…), gRPC method name, GraphQL operation type (query/mutation/subscription), etc. |
| `direction` | string | no | Data flow relative to the service: `in` (entering) \| `out` (leaving) |
| `protocol` | string | no | Protocol (e.g. `rest`, `grpc`, `graphql`, `websocket`) |
| `status` | string | no | Initial status (default: `active`) |
| `tags` | string[] | no | Optional tags |
| `source` | string | no | Tool or scanner that identified the feature |
| `linked_feature_ids` | array | no | Features to link - each item is an ID string or `{id, description}` object. Self-links return 400; unknown IDs return 404. |

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
| `file` | string | no | New file path (re-anchors; recomputes line hash) |
| `commit` | string | no | New commit (re-anchors; recomputes line hash) |
| `start` | int | no | New start line (re-anchors; recomputes line hash) |
| `end` | int | no | New end line (re-anchors; recomputes line hash) |
| `linked_feature_ids` | array | no | Replace all links - ID strings or `{id, description}` objects; pass `[]` to clear; omit to leave unchanged. Self-links return 400. |

### delete_feature

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Feature ID |

### batch_create_features

Create multiple feature annotations in one transaction. All-or-nothing. Accepts a `features` array where each item takes the same fields as `create_feature`. `file`, `commit`, `kind`, and `title` are required per item. Optional fields include `linked_feature_ids` - features within the same batch can reference each other by ID. Max 100 per call.

### list_feature_parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `feature` | string | yes | Feature ID |

### get_feature_parameter

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Parameter ID |

### create_feature_parameter

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `feature` | string | yes | Feature ID |
| `name` | string | yes | Parameter name |
| `description` | string | no | What it carries or security notes |
| `type` | string | no | `string` \| `integer` \| `boolean` \| `object` \| `array` \| `file` |
| `pattern` | string | no | Constraint: regex, enum, min/max, format hint, etc. |
| `required` | boolean | no | Whether the parameter is required |

### update_feature_parameter

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Parameter ID |
| `name` | string | no | New name |
| `description` | string | no | New description |
| `type` | string | no | New type |
| `pattern` | string | no | New constraint |
| `required` | boolean | no | New required flag |

### delete_feature_parameter

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Parameter ID |

---

### set_baseline

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `reviewer` | string | no | Who is setting the baseline |
| `summary` | string | no | Optional note |
| `commit` | string | no | Git commit (default: HEAD) |

### list_baselines

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | int | no | Max baselines (default: 20) |

### get_delta

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `baseline` | string | no | Omit to compare current state vs. latest baseline. Provide to compare that baseline against its predecessor. |

### delete_baseline

By default, returns a preview of what would be deleted (dry run). Set `confirm` to actually delete.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `baseline` | string | yes | Baseline ID |
| `confirm` | boolean | no | Set to true to actually delete. Default: false (preview). |

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
| `target` | string | no | Commit to reconcile to (default: HEAD) |
| `files` | string[] | no | Scope to specific files |

### get_reconciliation_status

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `job` | string | no | Specific job ID |
| `file` | string | no | Filter by file |
| `commit` | string | no | Filter by commit (use with `file`) |

### get_annotation_history

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | yes | `finding` or `comment` |
| `id` | string | yes | Finding or comment ID |

---

### list_refs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity_type` | string | no | Filter by entity type: `finding` \| `feature` \| `comment` |
| `entity` | string | no | Filter by entity ID |
| `provider` | string | no | Filter by provider (e.g. `jira`, `github`, `linear`, `url`) |

### get_ref

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Ref ID |

### create_ref

Create an external reference linking an annotation to a Jira ticket, Slack thread, GitHub issue, Linear issue, or any URL. Provider is inferred from the URL if omitted.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity_type` | string | yes | `finding` \| `feature` \| `comment` |
| `entity` | string | yes | ID of the finding, feature, or comment |
| `url` | string | yes | Full URL of the external resource |
| `provider` | string | no | `github` \| `gitlab` \| `jira` \| `confluence` \| `linear` \| `notion` \| `slack` \| `url` - inferred from URL if omitted |
| `title` | string | no | Optional display label |

### update_ref

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Ref ID |
| `provider` | string | no | New provider |
| `url` | string | no | New URL |
| `title` | string | no | New display label |

### delete_ref

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Ref ID |

### batch_create_refs

Create multiple external references in one operation. Accepts a `refs` array where each item takes the same fields as `create_ref`. `entity_type`, `entity`, and `url` are required per item. `provider` is inferred from the URL if omitted.

### suggest_finding_origin

Derive a candidate [origin](/concepts/annotations#origin) for a finding from git: blame over the anchor's lines, plus the first-parent merge that brought the change into the mainline. Read-only.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Finding ID |

Returns `introducedCommit`, `introducedDate` and `actor` from the newest blamed line; `mergeCommit` and `mergeSubject` for the merge that landed it (the merge message is usually the best explanation source); `branch` pre-composed as the `source -> target` flow; and `context`, the recent commits touching the anchor's file. Nothing is written.

### set_finding_origin

Record how a finding came to be. Merge semantics: only the fields provided overwrite.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Finding ID |
| `explanation` | string | no | The change or MR that introduced it |
| `introduced_commit` | string | no | Commit where the flaw landed (resolvable refs are pinned to the full SHA) |
| `introduced_date` | string | no | ISO date |
| `actor` | string | no | Author who introduced it |
| `branch` | string | no | Flow convention: `feature-x -> main` |

`clear_finding_origin` removes the record (the finding itself is untouched; clearing an origin that was never set is not an error).

`suggest_feature_origin`, `set_feature_origin` and `clear_feature_origin` take the same shape for features, where the origin records when a route or surface was introduced.

Record the origin when you create the annotation, not later: the introducing change is one suggest call away while the anchor is fresh.

### get_service_profile

Read the [service profile](/panel/profile). Do this first: it is the deployment context the code cannot reveal, and it decides which findings matter.

No parameters.

### update_service_profile

Partial update. Arrays replace wholesale; `[]` clears. Always allowed, and the only way to open the write gate.

| Parameter | Type | Description |
|-----------|------|-------------|
| `description` | string | What the service does |
| `owner` | string | Owning team or person |
| `externally_facing` | string | `full`, `partial`, `none` |
| `compute` | string | `vps`, `kubernetes`, `serverless`, `bare-metal` |
| `data_sensitivity` | string | `public`, `internal`, `pii`, `payment`, `phi`, `credentials` |
| `criticality` | string | `low`, `medium`, `high`, `critical` |
| `tenancy` | string | `single-tenant`, `multi-tenant` |
| `lifecycle` | string | `active`, `maintenance`, `deprecated`, `decommissioning` |
| `edge_protections` | string[] | `waf`, `api-gateway`, `rate-limiting`, `ddos-protection`, `none` |
| `compliance_scope` | string[] | `pci-dss`, `hipaa`, `soc2`, `gdpr`, `none` |
| `authentication_model` | string[] | `none`, `api-key`, `oauth-oidc`, `mtls`, `session`, `gateway-terminated` |
| `consumer_type` | string[] | `first-party-frontend`, `internal-services`, `third-party-partners`, `general-public` |

Multi-selects take JSON arrays, not comma-separated strings. `none` is exclusive: it claims a control is confirmed absent and cannot be combined with other values.
