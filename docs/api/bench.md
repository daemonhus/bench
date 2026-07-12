# Bench API

REST API served by the bench backend on `:8080`.

All endpoints return JSON. Error responses use standard HTTP status codes.

## Git

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/git/info` | Repository name |
| `GET` | `/api/git/commits` | Commit history |
| `GET` | `/api/git/tree/{commitish}` | File tree at a commit |
| `GET` | `/api/git/show/{commitish}/{path}` | File content |
| `GET` | `/api/git/diff` | Diff between two commits |
| `GET` | `/api/git/diff-files` | Files changed between two commits |
| `GET` | `/api/git/branches` | Branch list |
| `GET` | `/api/git/graph` | Commit graph |
| `GET` | `/api/git/activity` | Commits bucketed over time, with authors |
| `GET` | `/api/git/range-stats` | Commit and merge counts between two refs |
| `GET` | `/api/git/blame` | Git blame for a file |
| `GET` | `/api/git/search` | Regex search across file contents |

### GET /api/git/activity

Query params:
- `scale` - bucket size: `day`, `week`, `month`, or `year` (default `week`)
- `periods` - how many buckets to return (default 52)

Returns `ActivityBucket[]`, each bucket carrying its commit count, insertions and deletions, and the authors who committed in it (by commits descending, then name). Powers the activity timeline on the Overview.

### GET /api/git/range-stats

Query params:
- `from` - base ref, exclusive (omit for the whole history)
- `to` - target ref (default `HEAD`)

```json
{ "commits": 12, "merges": 3 }
```

The same range semantics as a log walk from `to` back to `from`. Stash entries are skipped. Used by the Overview to say how far HEAD has drifted from the last baseline.

### GET /api/git/commits

Query params:
- `limit` - max commits to return (default 50)

Returns `CommitInfo[]`:
```json
[{ "hash": "abc123", "message": "...", "author": "...", "date": "..." }]
```

### GET /api/git/tree/{commitish}

Returns `FileEntry[]`:
```json
[{ "path": "src/main.go", "type": "blob" }]
```

### GET /api/git/show/{commitish}/{path}

Returns:
```json
{ "content": "..." }
```

### GET /api/git/diff

Query params:
- `from` - base commit (required)
- `to` - target commit (required)
- `path` - file path (required)

Returns:
```json
{ "raw": "...", "fullContent": "..." }
```

### GET /api/git/diff-files

Query params:
- `from` - base commit (required)
- `to` - target commit (required)

Returns `string[]` of changed file paths.

### GET /api/git/graph

Query params:
- `limit` - max commits (default 100)

Returns `GraphCommit[]` for rendering a commit graph.

## Findings

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/findings` | List findings |
| `GET` | `/api/findings/{id}` | Get a finding |
| `POST` | `/api/findings` | Create a finding |
| `PATCH` | `/api/findings/{id}` | Update a finding |
| `DELETE` | `/api/findings/{id}` | Delete a finding |

### GET /api/findings

Query params:
- `fileId` - filter by file path

Returns `Finding[]`.

### POST /api/findings

```json
{
  "anchor": {
    "fileId": "src/api/auth.go",
    "commitId": "abc123",
    "lineRange": { "start": 42, "end": 48 }
  },
  "severity": "high",
  "title": "SQL injection in login handler",
  "description": "User input concatenated directly into query",
  "cwe": "CWE-89",
  "status": "open",
  "features": ["feat-abc123"]
}
```

**Severity values:** `critical` | `high` | `medium` | `low` | `info`

**Status values:** `draft` | `open` | `in-progress` | `false-positive` | `accepted` | `closed`

`features` links the finding to one or more feature annotations. The relationship is stored in a join table; deleting a feature or finding automatically removes the link.

Returns the created `Finding`.

### PATCH /api/findings/{id}

Partial update - only supplied fields are changed:
```json
{
  "status": "in-progress",
  "title": "Updated title",
  "features": ["feat-abc123", "feat-def456"]
}
```

`features` **replaces** the full list of linked features (same semantics as `tags` on features).

## Comments

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/comments` | List comments |
| `POST` | `/api/comments` | Create a comment |
| `PATCH` | `/api/comments/{id}` | Update a comment |
| `DELETE` | `/api/comments/{id}` | Delete a comment |

### GET /api/comments

Query params:
- `fileId` - filter by file path

Returns `Comment[]`.

### POST /api/comments

```json
{
  "anchor": {
    "fileId": "src/api/auth.go",
    "commitId": "abc123",
    "lineRange": { "start": 42, "end": 42 }
  },
  "author": "alice",
  "text": "This needs a prepared statement",
  "threadId": "optional-thread-id",
  "parentId": "optional-parent-comment-id",
  "findingId": "optional-related-finding-id",
  "featureId": "optional-related-feature-id"
}
```

## Origin

The historical context of a finding or feature: how it came to be, and the git coordinates of its introduction. One per annotation, no anchor, never reconciled. See [Origin](/concepts/annotations#origin) for the concept.

| Method | Path | Description |
|--------|------|-------------|
| `PUT` | `/api/findings/{id}/origin` | Set a finding's origin (merge semantics) |
| `DELETE` | `/api/findings/{id}/origin` | Remove a finding's origin |
| `GET` | `/api/findings/{id}/origin/suggest` | Derive a candidate origin from git |
| `PUT` | `/api/features/{id}/origin` | Set a feature's origin |
| `DELETE` | `/api/features/{id}/origin` | Remove a feature's origin |
| `GET` | `/api/features/{id}/origin/suggest` | Derive a candidate origin from git |

The origin is enriched inline on the parent annotation, so a `GET /api/findings/{id}` already carries it.

### PUT /api/findings/{id}/origin

Only the fields you send are overwritten:

```json
{
  "explanation": "Landed with the SSO work; the token check was never wired up.",
  "introducedCommit": "4f2a1c9e",
  "introducedDate": "2026-03-11",
  "actor": "erin",
  "branch": "feature-sso -> main"
}
```

A resolvable `introducedCommit` is normalised to its full SHA and pinned. One that no longer exists (rewritten out by a force push) is stored as-is rather than rejected, since the introducing commit may legitimately be gone.

### GET /api/findings/{id}/origin/suggest

Read-only. Blames the anchor's lines, then walks first-parent history for the merge that brought the change into the mainline:

```json
{
  "introducedCommit": "4f2a1c9e…",
  "introducedDate": "2026-03-11",
  "actor": "erin",
  "branch": "feature-sso -> main",
  "mergeCommit": "9b7d2f1a…",
  "mergeSubject": "Merge branch 'feature-sso'",
  "context": [{ "hash": "…", "message": "…", "author": "…", "date": "…" }]
}
```

Nothing is written. Confirm what matters with the `PUT`.

## Profile

The service profile: reviewer-configured meta-attributes of the service under review. A singleton. See [Profile](/panel/profile) for the fields and what they mean.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/profile` | Get the profile |
| `PATCH` | `/api/profile` | Partial update (arrays replace wholesale; `[]` clears) |

Until the profile has been written at least once, every review-judgment write (findings, comments, features, refs, baselines, mark-reviewed) is rejected with **412 Precondition Failed**. `PATCH /api/profile` is always allowed, and an empty patch satisfies the gate. Disable it with the server flag `-require-profile=false`.

Empty string and empty array mean "not configured", never "confirmed absent". In the multi-select fields, `none` is the explicit claim that a control is absent, and is exclusive.

## Baselines

Baselines are immutable snapshots of the review state at a specific git commit. They record every finding ID, aggregate stats, and comment counts. Once created, a baseline never changes - create a new one to checkpoint progress.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/baselines` | List baselines (most recent first, default limit 20) |
| `GET` | `/api/baselines/latest` | Most recent baseline or 404 |
| `GET` | `/api/baselines/delta` | Delta since the latest baseline |
| `GET` | `/api/baselines/{id}/delta` | Delta between this baseline and its predecessor |
| `POST` | `/api/baselines` | Create a new baseline |
| `PATCH` | `/api/baselines/{id}` | Update reviewer or summary |
| `DELETE` | `/api/baselines/{id}` | Delete a baseline (dry-run by default; pass `?confirm=true` to delete) |

### POST /api/baselines

All fields optional:

```json
{
  "reviewer": "alice",
  "summary": "Auth module review complete",
  "commitId": "abc123"
}
```

If `commitId` is omitted, defaults to the tip of the default branch (main/master), falling back to HEAD.

### Baseline

```typescript
{
  id: string
  seq: number           // auto-incrementing (1, 2, 3…)
  commitId: string      // git commit hash
  reviewer: string
  summary?: string
  createdAt: string
  findingsTotal: number
  findingsOpen: number
  bySeverity: { critical: number, high: number, medium: number, low: number, info: number }
  byStatus: { draft: number, open: number, 'in-progress': number, 'false-positive': number, accepted: number, closed: number }
  byCategory: Record<string, number>
  commentsTotal: number
  commentsOpen: number
  featuresTotal: number
  featuresActive: number
  byKind: Record<string, number>
  findings: string[]  // every finding ID at snapshot time
  features: string[]  // every feature ID at snapshot time
}
```

### BaselineDelta

```typescript
{
  sinceBaseline: Baseline       // the reference baseline
  headCommit: string            // current default branch tip
  newFindings: Finding[]        // exist now but not in the baseline
  removedFindingIds: string[]   // in the baseline but not in current state
  changedFiles: string[]        // files modified between baseline commit and HEAD
  currentStats: ProjectStats    // current aggregate stats
}
```

Two delta modes:

- **Since latest** (`GET /api/baselines/delta`) - compares current state against the most recent baseline.
- **Between two** (`GET /api/baselines/{id}/delta`) - compares the given baseline against its predecessor.

## Data model

### Anchor

```typescript
{
  fileId: string      // file path
  commitId: string    // git commit hash
  lineRange?: {
    start: number
    end: number
  }
}
```

### Finding

```typescript
{
  id: string
  anchor: Anchor
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  title: string
  description?: string
  cwe?: string
  cve?: string
  vector?: string
  score?: number
  status: 'draft' | 'open' | 'in-progress' | 'false-positive' | 'accepted' | 'closed'
  source?: string
  category?: string
  features?: string[]  // features this finding is linked to
  createdAt: string
  resolvedCommit?: string
}
```

### Comment

```typescript
{
  id: string
  anchor: Anchor
  author: string
  text: string
  timestamp: string
  threadId?: string
  parentId?: string
  findingId?: string
  featureId?: string
  resolvedCommit?: string
}
```
