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
| `GET` | `/api/git/blame` | Git blame for a file |
| `GET` | `/api/git/search` | Regex search across file contents |

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
