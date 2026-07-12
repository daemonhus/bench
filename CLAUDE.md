# Bench - Agent Guide

Bench is a code review workbench. This guide covers how to use it as a tool: connecting via MCP, using the CLI, and working with findings, features, comments, baselines, and reconciliation.

## Starting Bench

Always verify bench is running before any operations:

```bash
bench findings list          # health check - returns [] if up
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
  featureIds?: string[]  // associated Feature IDs (join table - referential integrity)
  refs?: Ref[]           // external references (enriched inline)
  origin?: FindingOrigin // historical context (enriched inline)
  createdAt: string
  resolvedCommit?: string
}
```

### Origin (findings and features)

Historical context of a finding or feature: how it came to be and the git
coordinates of its introduction. 1:1 with its parent entity, no anchor, never
reconciled. For features this records when a route or surface was introduced.

```typescript
{
  explanation?: string        // free text: the change or MR that introduced it
  introducedCommit?: string   // resolvable refs are normalised to the full sha and pinned
  introducedDate?: string     // ISO date
  actor?: string              // author who introduced it
  branch?: string             // flow convention: "feature-x -> main" (source -> merge target)
  updatedAt: string
}
```

Access (same shape for both entities): `PUT /api/findings/{id}/origin` and
`PUT /api/features/{id}/origin` (merge semantics: only provided fields
overwrite), `DELETE .../origin`, `GET .../origin/suggest`. CLI:
`bench findings|features set-origin / clear-origin / suggest-origin`. MCP:
`set_finding_origin` / `clear_finding_origin` / `suggest_finding_origin` /
`set_feature_origin` / `clear_feature_origin` / `suggest_feature_origin`. An unresolvable `introducedCommit` is stored as-is
without a pin, since the introducing commit may have been rewritten out of
history. Writes are gated by the service profile like all review-judgment
writes.

The suggest endpoint derives more than blame: `introducedCommit/date/actor`
from the newest blamed anchor line, `mergeCommit` and `mergeSubject` from the
first-parent merge that brought the change into the mainline (the merge
request message is usually the best explanation source), `branch` pre-composed
as the "source -> target" flow, and `context` listing recent commits touching
the anchor file. Nothing is written; confirm what matters with a set call.

**Record the origin when you create a finding or feature**, not later: the
introducing change is one suggest call away while the anchor is fresh, and
the explanation is sharpest while the surrounding code is still in context.
An annotation without an origin answers "what is here" but not "why does this
exist", and the second question is what makes systemic patterns visible.

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
  linkedFeatures?: { id: string; description?: string }[]  // bidirectional; includes links from either direction
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
  provider: string        // 'github' | 'gitlab' | 'jira' | 'confluence' | 'linear' | 'notion' | 'slack' | 'url' - inferred from URL if omitted
  url: string
  title?: string          // optional display label
  createdAt: string
}
```

Many refs per entity. Refs have no anchor and are not reconciled - they are pure metadata. Deleting an entity cascade-deletes its refs.

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
  findingIds: string[]  // every finding ID at snapshot time - core of delta computation
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

### ServiceProfile

A singleton per-project record of reviewer-configured meta-attributes: deployment
context that application code cannot reveal, used to contextualise findings and
risk scores.

```typescript
{
  description: string
  owner: string
  externallyFacing: '' | 'full' | 'partial' | 'none'   // internet reachability
  compute: '' | 'vps' | 'kubernetes' | 'serverless' | 'bare-metal'
  dataSensitivity: '' | 'public' | 'internal' | 'pii' | 'payment' | 'phi' | 'credentials'
  criticality: '' | 'low' | 'medium' | 'high' | 'critical'
  tenancy: '' | 'single-tenant' | 'multi-tenant'
  lifecycle: '' | 'active' | 'maintenance' | 'deprecated' | 'decommissioning'
  edgeProtections: string[]       // waf | api-gateway | rate-limiting | ddos-protection | none
  complianceScope: string[]       // pci-dss | hipaa | soc2 | gdpr | none
  authenticationModel: string[]   // none | api-key | oauth-oidc | mtls | session | gateway-terminated
  consumerType: string[]          // first-party-frontend | internal-services | third-party-partners | general-public
  updatedAt: string
}
```

Semantics:

- **Unset ≠ none.** Empty string / empty array means "not configured". In the
  multi-selects, `none` is an explicit positive claim (control confirmed absent)
  and cannot be combined with other values. Only an explicit `none` may downgrade
  a finding - never absence of data.
- **Write gate.** All review-judgment writes (findings, comments, features, refs,
  baselines, mark-reviewed) are rejected - HTTP 412 / MCP tool error - until the
  profile has been set at least once. `bench profile set` / `update_service_profile`
  is the bootstrap path and is always allowed. Server flag `-require-profile=false`
  disables the gate.
- **Embedded for free.** `get_summary` and `get_delta` responses include the
  profile, so a session that starts with either has the context without an
  extra call.
- **Factor it into severity.** A missing-rate-limit finding on a service with
  `edgeProtections: [rate-limiting]` is likely moot; any authz finding on
  `tenancy: multi-tenant` is amplified; `authenticationModel: [gateway-terminated]`
  makes missing-auth-in-code findings a question, not a critical.

Access: `GET /api/profile`, `PATCH /api/profile` (partial update; arrays replace
wholesale, `[]` clears); `bench profile get` / `bench profile set`; MCP
`get_service_profile` / `update_service_profile`.

```bash
bench profile set --owner platform-team --externally-facing full \
    --data-sensitivity pii --criticality high --tenancy multi-tenant \
    --edge-protections waf,rate-limiting \
    --authentication-model oauth-oidc,gateway-terminated
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
| `concern` | Something warrants attention but isn't a confirmed vulnerability - a smell, a weak pattern, a missing control. Use a **Finding** for confirmed issues. |
| `question` | You need clarification before making a judgment. |
| `improvement` | A non-critical suggestion - cleaner, safer, or more robust code, not a security issue. |
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
# MCP - replaces the full list
update_finding(id: "f-xyz", feature_ids: ["feat-abc123", "feat-def456"])

# CLI - also replaces the full list
bench findings update --id f-xyz --features feat-abc123,feat-def456
```

Deleting a feature or finding automatically removes the join-table rows - no manual cleanup needed.

## Typical Review Workflow

```
0. get_service_profile      ← ALWAYS do this first - load the service's deployment context
                               before reading any code. The profile tells you which finding
                               classes are moot (e.g. rate limiting at the gateway, auth
                               terminated upstream) and which are amplified (multi-tenant,
                               PII, internet-facing). Empty fields mean "not configured" -
                               never treat absence as evidence a control is missing.
                               If unconfigured: update_service_profile with what you know
                               (or ask the user) - ALL create/update/delete calls are
                               rejected until the profile has been set at least once.
   list_baselines           ← check whether a meaningful baseline already exists. If seq=1
                               is empty, set a baseline before importing anything. An empty
                               predecessor makes every delta useless - all findings appear
                               "new".
1. set_baseline             ← checkpoint before starting (captures current state as reference)
2. search code, read files  ← use bench git tools to explore
3. create_finding (×N)      ← record vulnerabilities as you find them
   └─ then record how each came to be: suggest_finding_origin derives the
      introducing commit/date/actor from blame; confirm with set_finding_origin
      and add the free-text explanation and branch. Origin context is cheapest
      to capture while the code is in front of you.
4. create_feature (×N)      ← record new endpoints, data sources/sinks, or long-lived annotations
   └─ for interface features: add parameters to capture the contract (auth headers, path vars, query params, body fields)
   └─ then suggest_feature_origin → set_feature_origin: when the surface was
      introduced, by whom, and on what branch is review context in itself
5. get_delta                ← check progress: how many new findings since baseline?
6. set_baseline             ← checkpoint at milestones (e.g. "auth module complete")
7. get_delta(baseline_id)   ← what did this round produce?
8. set_baseline             ← final snapshot - this is the deliverable
```

Baselines are cheap - create them liberally. The delta is where the interesting analysis happens.

**Before setting any baseline**, confirm with the user that they are done with the current session and have no further findings or comments to add. Baselines are immutable - setting one prematurely makes delta analysis less useful.

**After code changes under you:**
```
reconcile               ← update annotation positions to current code
get_delta               ← changedFiles shows what moved
set_baseline            ← checkpoint the updated state
```

**After a large refactor or directory restructure:** the reconciler will orphan annotations whose files moved. Run `bench reconcile start --target HEAD`, check the job result's `orphanedCount`, then re-anchor each one - see the "Un-orphaning Annotations" workflow below.

## Workflow: Feature Analysis (Attack Surface Mapping)

Map features in this order - each kind builds on the previous:

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

## Workflow: Un-orphaning Annotations

Annotations become orphaned when reconciliation can no longer locate their original code. The two common causes are (a) the file moved or its contents changed enough that the line-hash fallback misses, and (b) the anchor's commit is no longer in the repo (force push, `git filter-branch`, history GC). The recovery shape is the same either way.

### 1. Run reconciliation

```bash
bench reconcile start --target HEAD
bench reconcile status --job <id>     # check orphanedCount in summary
```

### 2. Identify orphaned annotations

Filter the list calls by confidence at HEAD. Findings and comments expose their orphan state through the `confidence` field (set by `--commit`); features expose it through `status`.

```bash
bench findings list --commit HEAD | jq '.[] | select(.confidence == "orphaned")'
bench comments list --commit HEAD | jq '.[] | select(.confidence == "orphaned")'
bench features list --status orphaned
```

From MCP, the equivalent calls are `list_findings(commit: "HEAD", orphaned_only: true)`, `list_comments(commit: "HEAD", orphaned_only: true)`, and `list_features(status: "orphaned")`.

### 3. Re-anchor

Pass the full new anchor (file, start, end, commit). The update handlers recompute `line_hash`, stamp `anchor_updated_at`, and immediately record an `exact` position - so the change takes effect without waiting for the next reconcile.

```bash
bench findings update --id <id> --file <new-path> --start <n> --end <n> --commit HEAD
bench comments update --id <id> --file <new-path> --start <n> --end <n> --commit HEAD
bench features update --id <id> --file <new-path> --start <n> --end <n> --commit HEAD
```

For features, also clear the orphan status after re-anchoring:

```bash
bench features update --id <id> --status active
```

If the code at the old location was deleted entirely, map the anchor to the nearest representative location and add a comment explaining the remap.

### 4. Verify and baseline

```bash
bench reconcile start --target HEAD                # re-run to confirm zero orphans
bench baselines set --reviewer <name> --summary "Re-anchored"
```

Notes:
- Reconciliation confidence can only decrease (`exact` → `moved` → `orphaned`).
- Check `bench reconcile history --type finding --id <id>` (or `--type comment`) to see the full reconciliation trail.
- If reconciliation completes with a warning like `N of M files failed`, the job's `result` is still populated - the failures are reported in the job's `error` field. Files whose anchor commits no longer exist are auto-orphaned and the job continues; you'll find them via step 2 above.

## Interfaces

Bench exposes MCP tools and a CLI. Tool schemas and CLI `--help` are the source of truth for parameters.

- Both MCP and CLI use the same field names: `file`, `commit`, `start`, `end`
- All `commit` parameters accept a hash, ref, or `HEAD`
- For CLI `batch-create`, provide `--input <file>` (not piped stdin)

**Tool groups:** git, findings, comments, features, refs, baselines, analytics, reconcile, profile.

**Always use `bench git` for code access** - do not reach around the CLI to the filesystem (`cat`, `grep`, `git -C`, etc.). Use:
- `bench git commits` - HEAD commit and recent history
- `bench git search-code` - regex search across the repo
- `bench git read-file` - read a file at a specific commit
- `bench git list-files` - list files in the repo tree
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
| `linked_feature_ids` (MCP/input) | `"feat-1,feat-2"` | `["feat-1", "feat-2"]` (JSON array); CLI uses `--features feat-1,feat-2` on features commands |
| `linkedFeatures` (response) | flat string array | array of `{id, description}` objects; use `linkedFeatures[].id` to get the ID |
| `features` (CLI update) | appends | replaces the full list (same semantic as `tags`) |
| `parameters` on non-interface features | technically allowed | by convention interface-only |
| `commit` | omitted | always set - empty `commitId` breaks reconciliation |
| `id` (updates) | truncated prefix | always use the **full UUID** - short prefixes return "not found" |
| `provider` (refs) | any string | `github`, `gitlab`, `jira`, `confluence`, `linear`, `notion`, `slack`, or `url` - inferred from URL hostname if omitted |
| profile multi-selects (MCP) | `"waf,rate-limiting"` | `["waf", "rate-limiting"]` (JSON array); CLI uses `--edge-protections waf,rate-limiting` |
| profile `none` (multi-selects) | `["none", "waf"]` | `none` is exclusive - it means "control confirmed absent" and cannot be combined |

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

**Baselines snapshot the database, not the commit.** Setting a baseline at commit X records all findings currently in the database - regardless of which commit each finding was anchored to. `commitId` is used for git diffs (`changedFiles`), not for scoping which findings are included.

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
| `invalid JSON` (CLI, not server) | Wrong field type - `score` must be a number, `tags` must be an array |
| `ancestry check: invalid git ref: ""` (reconcile) | Annotations have empty `commitId`. The PATCH handlers now reject empty commit strings, so this state can only persist on existing rows - patch with `bench findings update --id <id> --commit <sha>` and re-run reconcile. |
| `ancestry check: unknown git ref` or `reference not found` (reconcile) | The anchor's commit is no longer in the repo (force push, `git filter-branch`, GC). The reconciler now auto-orphans these annotations and continues - find them via `bench findings list --commit HEAD \| jq '.[] \| select(.confidence == "orphaned")'` and re-anchor with `bench findings update ... --commit HEAD`. |
| `commitId must be a non-empty string` (PATCH) | Don't pass `commit: ""` to update tools. Omit the field to leave the anchor commit unchanged. |
| `service profile not configured` (412 / MCP tool error) | The write gate: no annotations can be recorded until the service profile is set. Run `bench profile get` to see fields, then `bench profile set` (or `update_service_profile`) with what you know - an empty set call also satisfies the gate ("reviewed, nothing known"). |
