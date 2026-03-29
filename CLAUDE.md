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
  featureId?: string  // link to a related feature
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
  createdAt: string
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

| Kind | Use when… |
|------|-----------|
| `interface` | The service **exposes** this entry point — an HTTP handler, gRPC method, WebSocket endpoint, or message consumer. External actors call or send to it. |
| `source` | The service **reads** from this — a DB query, file read, cache lookup, inbound queue. Data enters your processing pipeline at this point. |
| `sink` | The service **writes** to this — a DB write, outbound HTTP call, file write, message publish. Data leaves your processing pipeline here. |
| `dependency` | A third-party library or external service **as a whole** — when the security concern is about the dependency itself (trust, version, supply chain), not a specific data flow. |
| `externality` | A background job, cron task, event handler, or async side-effect that runs **without an inbound request** triggering it. |

**Ambiguous cases:**

- **`interface` vs `source`:** Ask who initiates. If an external actor triggers it → `interface` (even though it produces input data). If the service itself initiates a read → `source`. An HTTP handler is `interface`; a DB query inside that handler is `source`.
- **`sink` vs `dependency`:** Use `sink` for a specific outbound data flow (sending email, writing to S3). Use `dependency` for the library or service itself when the concern is the integration, not a specific call. A codebase can have one `dependency` for the AWS SDK and many `sink` annotations for individual S3 writes.
- **Same system, two roles:** A database often appears as both `source` (reads) and `sink` (writes) — annotate each at its specific code location.
- **`externality` vs `interface`:** If triggered by a scheduler or internal event → `externality`. If triggered by an inbound webhook or message → `interface` with `direction: in`.

### Comment types

| Type | Use when… |
|------|-----------|
| `concern` | Something warrants attention but isn't a confirmed vulnerability — a smell, a weak pattern, a missing control. Use a **Finding** for confirmed issues. |
| `question` | You need clarification before making a judgment. |
| `improvement` | A non-critical suggestion — cleaner, safer, or more robust code, not a security issue. |
| `feature` | The comment is about a feature annotation itself (link via `featureId`). |
| *(empty)* | A general note that doesn't fit the above. |

## Typical Review Workflow

```
0. list_baselines           ← check if a meaningful baseline already exists
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

## Interfaces

Bench exposes MCP tools and a CLI. Tool schemas and CLI `--help` are the source of truth for parameters. Key differences between the two:

- **MCP** uses `file`/`commit` as parameter names; **CLI** uses `--file-id`/`--commit-id`
- All `commit` parameters accept a hash, ref, or `HEAD`
- For CLI `batch-create`, pipe a JSON array to stdin

**Tool groups:** git, findings, comments, features, baselines, analytics, reconcile.

**Feature titles:** Do not include the HTTP method in the title (e.g. `"Login endpoint"`, not `"POST /login"`). Use the `operation` field for that.

## Known Constraints

| Field | Wrong | Correct |
|-------|-------|---------|
| `score` | `"5.3"` (string) | `5.3` (number) |
| `severity` | `"informational"` | `"info"` |
| `source` (findings) | any string | `pentest`, `tool`, `manual`, or `mcp` (SQLite CHECK) |
| `tags` (features) | `"http,rest"` | `["http", "rest"]` (JSON array) |
| `commit` | omitted | always set — empty `commitId` breaks reconciliation |

**Default differences by interface:**

| Field | MCP | CLI / API |
|-------|-----|-----------|
| findings `status` | `draft` | `open` |
| findings `source` | `mcp` | `manual` |
| features `status` | `active` | `active` |
| features `source` | `mcp` | (empty) |

**Valid `comment_type` values:** `feature`, `improvement`, `question`, `concern`, or empty string.

**SQLite concurrency:** Don't create annotations in parallel — SQLite will return `SQLITE_BUSY`. Use batch endpoints or serialize writes.

## Important Notes

**Resolved findings are included in baseline snapshots.** `findingIds` captures all findings including closed/resolved ones. `list_findings` excludes resolved by default, so delta counts may appear higher. Use `include_resolved=true` (MCP) or `--include-resolved` (CLI) when cross-referencing.

**Baselines snapshot the database, not the commit.** Setting a baseline at commit X records all findings currently in the database — regardless of which commit each finding was anchored to. `commitId` is used for git diffs (changedFiles), not for scoping which findings are included.

**`get_delta` has two modes:**
- No `baseline_id` → "what changed since my last checkpoint?" (current state vs. latest baseline)
- With `baseline_id` → "what did a specific round of work produce?" (that baseline vs. its predecessor)

**Reconciliation confidence levels:** `exact` (line-mapped through diff) → `moved` (placed by content match) → `orphaned` (code deleted, no reliable position). Confidence can only decrease.
