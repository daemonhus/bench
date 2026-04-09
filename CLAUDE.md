# Bench — Agent Guide

Bench is a code review workbench. This guide covers how to use it as a tool: connecting via MCP, using the CLI, and working with findings, features, comments, baselines, and reconciliation.

## Starting Bench

Always verify bench is running before any operations:

```bash
bench findings list          # health check — returns [] if up
```

Start if not running (mounts the current git repo read-only):

```bash
docker run -d -p 8080:8081 \
  -v $(pwd):/repo:ro \
  -v bench:/data \
  <bench-image> \
  -repo /repo -db /data/bench.db
```

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
  featureIds?: string[]  // associated Feature IDs (join table — referential integrity)
  refs?: Ref[]           // external references (enriched inline)
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
  featureId?: string  // link to a related feature
  refs?: Ref[]        // external references (enriched inline)
  resolvedCommit?: string
}
```

### Feature

An architectural annotation marking a security-relevant surface: API endpoint, data flow, dependency, or background externality.

```typescript
{
  id: string
  anchor: Anchor
  kind: 'interface' | 'source' | 'sink' | 'dependency' | 'externality'
  title: string
  description?: string
  status: 'draft' | 'active'
  direction?: 'in' | 'out'   // data flow relative to the service
  operation?: string          // HTTP method, gRPC method, GraphQL op, etc.
  protocol?: string           // e.g. rest, grpc, graphql, websocket
  source?: string
  tags?: string[]
  refs?: Ref[]                // external references (enriched inline)
  parameters?: FeatureParameter[]  // only meaningful for kind: 'interface'
  createdAt: string
}
```

### FeatureParameter

A structured input/output descriptor attached to an `interface` feature.

```typescript
{
  id: string
  featureId: string
  name: string              // e.g. "user_id", "Authorization"
  description?: string      // what it carries / security notes
  type?: string             // string | integer | boolean | object | array | file
  pattern?: string          // freeform constraint: regex, enum list, min/max, format hint
  required: boolean
  createdAt: string
}
```

Parameters are ordered by `name` ascending in list responses. By convention, parameters are used on `interface` features to document the expected inputs (auth headers, path vars, query params, body fields).

### Ref

An external reference linking an annotation to a ticket, thread, or URL in an external system.

```typescript
{
  id: string
  entityType: 'finding' | 'feature' | 'comment'
  entityId: string        // ID of the parent annotation
  provider: string        // 'github' | 'gitlab' | 'jira' | 'confluence' | 'linear' | 'notion' | 'slack' | 'url' — inferred from URL if omitted
  url: string
  title?: string          // optional display label
  createdAt: string
}
```

Many refs per entity. Refs have no anchor and are not reconciled — they are pure metadata. Deleting an entity cascade-deletes its refs.

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
  featuresTotal: number
  featuresActive: number
  byKind: Record<string, number>   // e.g. { interface: 3, sink: 2 }
  findingIds: string[]  // every finding ID at snapshot time — core of delta computation
  featureIds: string[]  // every feature ID at snapshot time
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

## Classification Guide

### Feature kinds

| Kind | What it represents | Direction |
|------|--------------------|-----------|
| `interface` | An HTTP endpoint, gRPC method, WebSocket handler, or message consumer the service **exposes**. One feature per verb+path combination. | `in` |
| `source` | A place the service **reads data from**: DB query, cache lookup, file read, queue poll, config fetch. | `in` |
| `sink` | A place the service **writes data to**: DB write, cache set, queue publish, file write, outbound HTTP to **external** third parties. | `out` |
| `dependency` | A synchronous call between **internal platform services**. One feature per client class or distinct integration point. Anchored to the client code. | `out` |
| `externality` | A background job, periodic task, startup/shutdown hook, or async side-effect that runs **without an inbound request** triggering it. | n/a |

### Hard rules

1. **One endpoint per feature.** Never combine `GET` and `POST` on the same path into one feature. Each verb+path gets its own entry with the method in `operation`.
2. **Dependencies are inter-service, not libraries.** Do not create dependency features for third-party packages (fastapi, cryptography, boto3). Library version concerns belong in **findings**, not features. A `dependency` feature tracks where Service A calls Service B over the network.
3. **Rich descriptions.** Always name the concrete class or function making the call, the target service/endpoints, and what flows use it. Bad: "Calls billing service". Good: "BillingServiceClient. Order API calls billing-svc /internal/* endpoints for charge, refund, and invoice operations. Used by all checkout handlers."
4. **Tags encode service context.** For dependencies, tag both source and target service plus the domain. For interfaces, tag the owning service and the functional domain.
5. **Anchor to the code.** Features are pinned to the file and line where the behaviour is defined: the router decorator for interfaces, the client class for dependencies, the query/write call for sources/sinks, the task function for externalities.

### Resolving ambiguous cases

- **`interface` vs `source`:** Who initiates? External actor sends a request → `interface`. The service itself initiates a read → `source`. An HTTP handler is `interface`; a DB query inside that handler is `source`.
- **`sink` vs `dependency`:** `sink` is for writes to data stores or calls to **external** third-party APIs (payment processors, SaaS). `dependency` is for calls to **internal** platform services. If ServiceA calls ServiceB (both yours) → `dependency`. If ServiceA calls Stripe → `sink`.
- **Same system, two roles:** A database is both `source` (reads) and `sink` (writes). Annotate each at its specific code location.
- **`externality` vs `interface`:** Triggered by a scheduler, timer, or startup event → `externality`. Triggered by an inbound request or webhook → `interface`.

### Title conventions

**`interface`:** Bare URL path, no method prefix. Use `operation` for the HTTP method.
```
/orders/{id}
/internal/verify
/livez
```

**`source` and `sink`:** Resource URI using a scheme prefix.
```
dynamodb://orders-table
postgresql://users_db (read)
redis://session-cache (write)
s3://audit-logs (read)
sqs://app-events (consumer)
kafka://app-events
https://api.acmepay.example.com   # external processor (sink)
postmark://email                  # email send (sink)
```

**`dependency`:** `<CallerService> to <k8s-hostname> (<domain>)`. Use the Kubernetes DNS hostname of the target service.
```
Order API to billing-svc.cluster.local (charges)
Billing API to order-svc.cluster.local (order status)
```

**`externality`:** Descriptive name of the task or hook.
```
Cache prune periodic task
App startup hook
DB migrations (Alembic)
```

### Comment types

| Type | Use when… |
|------|-----------|
| `concern` | Something warrants attention but isn't a confirmed vulnerability — a smell, a weak pattern, a missing control. Use a **Finding** for confirmed issues. |
| `question` | You need clarification before making a judgment. |
| `improvement` | A non-critical suggestion — cleaner, safer, or more robust code, not a security issue. |
| `feature` | The comment is about a feature annotation itself (link via `featureId`). |
| *(empty)* | A general note that doesn't fit the above. |

## Linking Findings to Features

Every finding that exploits or directly relates to a feature annotation **should** link to it via `featureIds`. This connects the vulnerability to the architectural surface where it lives and makes the relationship queryable.

**When to link:**
- A finding in an HTTP handler → link to the `interface` feature for that endpoint
- A SQL injection in a DB query → link to the `source` or `sink` feature for that query
- A vulnerable dependency → link to the `dependency` feature
- A finding spanning multiple surfaces → link all relevant features

**How to link at creation (MCP):**
```
create_finding(
  title: "SQL injection in user lookup",
  feature_ids: ["feat-abc123"]   // must be an array, not a comma-separated string
)
```

**How to link at creation (CLI):**
```
bench findings create --title "SQL injection" --severity high --features feat-abc123,feat-def456
```

**How to update existing links:**
```
# MCP — replaces the full list
update_finding(id: "f-xyz", feature_ids: ["feat-abc123", "feat-def456"])

# CLI — also replaces the full list
bench findings update --id f-xyz --features feat-abc123,feat-def456
```

Deleting a feature or finding automatically removes the join-table rows — no manual cleanup needed.

## Typical Review Workflow

```
0. list_baselines           ← ALWAYS do this first — check whether a meaningful baseline
                               already exists. If seq=1 is empty, set a baseline before
                               importing anything. An empty predecessor makes every delta
                               useless — all findings appear "new".
1. set_baseline             ← checkpoint before starting (captures current state as reference)
2. search code, read files  ← use bench git tools to explore
3. create_finding (×N)      ← record vulnerabilities as you find them
4. create_feature (×N)      ← record new endpoints, data sources/sinks, or long-lived annotations
   └─ for interface features: add parameters to capture the contract (auth headers, path vars, query params, body fields)
5. get_delta                ← check progress: how many new findings since baseline?
6. set_baseline             ← checkpoint at milestones (e.g. "auth module complete")
7. get_delta(baseline_id)   ← what did this round produce?
8. set_baseline             ← final snapshot — this is the deliverable
```

Baselines are cheap — create them liberally. The delta is where the interesting analysis happens.

**Before setting any baseline**, confirm with the user that they are done with the current session and have no further findings or comments to add. Baselines are immutable — setting one prematurely makes delta analysis less useful.

**After code changes under you:**
```
reconcile               ← update annotation positions to current code
get_delta               ← changedFiles shows what moved
set_baseline            ← checkpoint the updated state
```

**After a large refactor or directory restructure:** the reconciler will orphan annotations whose files moved. Check `reconcile status` results for orphaned counts, then manually update each anchor with `findings update --file <new-path>` before setting a baseline.

## Workflow: Feature Analysis (Attack Surface Mapping)

Map features in this order — each kind builds on the previous:

1. **Interfaces first.** Enumerate every HTTP endpoint, one per verb+path. Use router/route files as the source of truth.
2. **Sources.** Find every data read point: DB clients, cache reads, queue consumers, config fetches.
3. **Sinks.** Find every data write point: DB writes, cache sets, queue publishes, external API calls (processors, SaaS).
4. **Dependencies.** Find every inter-service client class. One feature per client, anchored to the class definition. Do NOT create features for third-party libraries.
5. **Externalities.** Find background tasks, periodic jobs, startup/shutdown hooks.

**Batch-create, never loop.** Write JSON to `/tmp/` split by kind and use `bench features batch-create --input <file>`. Never create features one at a time in a loop.

```bash
bench features batch-create --input /tmp/features-interfaces.json
bench features batch-create --input /tmp/features-sources.json
bench features batch-create --input /tmp/features-sinks.json
bench features batch-create --input /tmp/features-deps.json
bench features batch-create --input /tmp/features-externalities.json
```

## Workflow: Un-orphaning Annotations After a Path Restructure

Reconcile can update line numbers but cannot fix moved file paths — those require manual intervention.

### 1. Identify orphaned annotations

```bash
bench reconcile start --target-commit HEAD
bench reconcile status --job-id <id>   # check orphanedCount
bench findings list --status orphaned
```

### 2. Update anchors

```bash
bench findings update --id <id> --file <new-path> --start <n> --end <n> --commit HEAD
bench features update --id <id> --file <new-path> --start <n> --commit HEAD
```

### 3. Force status back to active if reconcile doesn't clear it

```bash
bench findings update --id <id> --status open
bench features update --id <id> --status active
```

### 4. Verify and baseline

```bash
bench reconcile start --target-commit HEAD         # re-run to confirm zero orphans
bench baselines set --reviewer <name> --summary "Re-anchored after restructure"
```

Notes:
- If the code at the old location was deleted entirely, map the anchor to the nearest representative location and add a comment explaining the remap.
- Reconciliation confidence can only decrease (`exact` → `moved` → `orphaned`).
- Check `reconcile history --type finding --id <id>` to see the full reconciliation trail.

## Interfaces

Bench exposes MCP tools and a CLI. Tool schemas and CLI `--help` are the source of truth for parameters.

- Both MCP and CLI use the same field names: `file`, `commit`, `start`, `end`
- All `commit` parameters accept a hash, ref, or `HEAD`
- For CLI `batch-create`, provide `--input <file>` (not piped stdin)

**Tool groups:** git, findings, comments, features, refs, baselines, analytics, reconcile.

**Always use `bench git` for code access** — do not reach around the CLI to the filesystem (`cat`, `grep`, `git -C`, etc.). Use:
- `bench git commits` — HEAD commit and recent history
- `bench git search-code` — regex search across the repo
- `bench git read-file` — read a file at a specific commit
- `bench git list-files` — list files in the repo tree
- `bench git blame` / `diff` / `changed-files` as needed

**Feature titles:** Use bare URL paths (`/v1/login`, not `"Login endpoint"`). Use the `operation` field for the HTTP method.

## Known Constraints

| Field | Wrong | Correct |
|-------|-------|---------|
| `score` | `"5.3"` (string) | `5.3` (number) |
| `severity` | `"informational"` | `"info"` |
| `source` (findings) | any string | `pentest`, `tool`, `manual`, or `mcp` (SQLite CHECK) |
| `tags` (features) | `"http,rest"` | `["http", "rest"]` (JSON array) |
| `feature_ids` (MCP) | `"feat-1,feat-2"` | `["feat-1", "feat-2"]` (JSON array); CLI uses `--features feat-1,feat-2` |
| `features` (CLI update) | appends | replaces the full list (same semantic as `tags`) |
| `parameters` on non-interface features | technically allowed | by convention interface-only |
| `commit` | omitted | always set — empty `commitId` breaks reconciliation |
| `id` (updates) | truncated prefix | always use the **full UUID** — short prefixes return "not found" |
| `provider` (refs) | any string | `github`, `gitlab`, `jira`, `confluence`, `linear`, `notion`, `slack`, or `url` — inferred from URL hostname if omitted |

**Default differences by interface:**

| Field | MCP | CLI / API |
|-------|-----|-----------|
| findings `status` | `draft` | `open` |
| findings `source` | `mcp` | `manual` |
| features `status` | `active` | `active` |
| features `source` | `mcp` | (empty) |

**Valid `comment_type` values:** `feature`, `improvement`, `question`, `concern`, or empty string.

**Write queueing:** DB writes are internally queued, so parallel CLI/MCP calls no longer cause `SQLITE_BUSY` errors. Batch endpoints are still preferred for bulk imports (fewer round trips).

**Baseline deletion is dry-run by default.** `delete_baseline` previews what would be removed. Pass `confirm: true` (MCP) or `--confirm` (CLI) to actually delete.

## Important Notes

**Resolved findings are included in baseline snapshots.** `findingIds` captures all findings including closed/resolved ones. `list_findings` excludes resolved by default, so delta counts may appear higher. Use `include_resolved=true` (MCP) or `--include-resolved` (CLI) when cross-referencing.

**Baselines snapshot the database, not the commit.** Setting a baseline at commit X records all findings currently in the database — regardless of which commit each finding was anchored to. `commitId` is used for git diffs (`changedFiles`), not for scoping which findings are included.

**`get_delta` has two modes:**
- No `baseline_id` → current state vs. latest baseline
- With `baseline_id` → that baseline vs. its predecessor

**Reconciliation confidence levels:** `exact` (line-mapped through diff) → `moved` (placed by content match) → `orphaned` (code deleted). Confidence can only decrease.

## Diagnosing Errors

When batch operations return `Error: invalid JSON` or `Error: internal error`, check Docker logs:

```bash
docker logs $(docker ps -q --filter ancestor=bench) 2>&1 | tail -20
```

| Log message | Fix |
|---|---|
| `CHECK constraint failed: status IN (...)` | Add `"status": "open"` to payload |
| `CHECK constraint failed: severity IN (...)` | Use `info` not `informational` |
| `CHECK constraint failed: source IN (...)` | Use `manual`, `pentest`, `tool`, or `mcp` |
| `invalid JSON` (CLI, not server) | Wrong field type — `score` must be a number, `tags` must be an array |
| `ancestry check: invalid git ref: ""` (reconcile) | Annotations have empty `commitId` — patch with `bench findings update --id <id> --commit <sha>`, then re-run reconcile |
