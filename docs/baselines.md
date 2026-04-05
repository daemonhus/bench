# Baselines

Baselines are immutable snapshots of a project's review state at a specific git commit. They record every finding ID, aggregate stats (by severity, status, category), and comment counts. Once created, a baseline never changes - you create a new one to checkpoint progress.

## Data model

```
Baseline {
  id            string              UUID
  seq           int                 Auto-incrementing per project (1, 2, 3…)
  commitId      string              Git commit hash
  reviewer      string              Who created it
  summary       string              Optional annotation
  createdAt     string              Timestamp
  findingsTotal int                 Total findings at snapshot time
  findingsOpen  int                 Open findings at snapshot time
  bySeverity    {critical,high,medium,low,info → count}
  byStatus      {draft,open,in-progress,false-positive,accepted,closed → count}
  byCategory    {category → count}
  commentsTotal int
  commentsOpen  int
  featuresTotal int
  featuresActive int
  byKind        {kind → count}
  findings      string[]            Every finding ID that existed at snapshot time
  features      string[]            Every feature ID that existed at snapshot time
}
```

The `findings` array is the core of delta computation - it's the authoritative record of what existed when the baseline was set.

## Deltas

A delta answers "what changed since baseline X?"

```
BaselineDelta {
  sinceBaseline     Baseline        The reference baseline
  headCommit        string          Current default branch tip
  newFindings       Finding[]       Findings that exist now but not in the baseline
  removedFindingIDs string[]        Finding IDs in the baseline but not in current state
  changedFiles      string[]        Files modified between baseline commit and HEAD
  currentStats      ProjectStats    Current aggregate stats
}
```

Delta computation:
1. Load the baseline's `findings` set
2. Load current findings from the database
3. **New** = current findings whose IDs are not in the baseline set
4. **Removed** = baseline IDs that no longer exist
5. **Changed files** = `git diff baselineCommit..defaultBranchTip`

### What the delta is actually measuring

**Finding delta is database-state based, not commit- or time-based.**

`newFindings` and `removedFindingIds` are computed by comparing the baseline's `findings` snapshot against what currently exists in the database. A finding is "new" if its ID wasn't in the baseline - regardless of when it was created or which commit it's anchored to. There is no query like "findings created after this timestamp" or "findings anchored to commits after X".

**Changed files are commit-based.**

`changedFiles` is the one exception: it uses `git diff` between the baseline's `commitId` and the current default branch tip. This tells you which files the codebase touched between those two points, which is useful context but independent of the findings delta.

**Practical implication:** if you create a finding, then set a baseline, then delete the finding, then call `get_delta` - the finding appears as "removed" even though it was never in the codebase after the baseline. The delta reflects what changed in the *database*, not what changed in the *code*.

There are two delta modes:
- **Since latest** (`GET /api/baselines/delta`) - compares current state against the most recent baseline
- **Between two** (`GET /api/baselines/{id}/delta`) - compares the given baseline against its predecessor (the baseline before it by sequence)

## API

```
GET    /api/baselines              → Baseline[]       most recent first, limit 50
GET    /api/baselines/latest       → Baseline | 404
GET    /api/baselines/delta        → BaselineDelta    since latest baseline
GET    /api/baselines/{id}/delta   → BaselineDelta    between this baseline and its predecessor
POST   /api/baselines              → Baseline         create new baseline
DELETE /api/baselines/{id}         → 204
```

POST body (all fields optional):
```json
{
  "reviewer": "string",
  "summary": "string",
  "commitId": "string"
}
```

If `commitId` is omitted, defaults to the tip of the default branch (main/master), falling back to HEAD.

## MCP tools

Four tools: `set_baseline`, `list_baselines`, `get_delta`, `delete_baseline`.

### set_baseline

Create a new baseline snapshot.

| Parameter   | Type   | Default        | Description                    |
|-------------|--------|----------------|--------------------------------|
| `reviewer`  | string | `"mcp-client"` | Who is setting the baseline    |
| `summary`   | string | -              | Optional note                  |
| `commit_id` | string | default branch | Git commit to snapshot at      |

Returns a human-readable summary with the baseline seq number, commit, stats, and ID.

### list_baselines

| Parameter | Type | Default | Description              |
|-----------|------|---------|--------------------------|
| `limit`   | int  | 20      | Max baselines to return  |

Returns a markdown table of baselines with seq, date, reviewer, finding/comment counts, and summary.

### get_delta

| Parameter     | Type   | Default | Description                              |
|---------------|--------|---------|------------------------------------------|
| `baseline` | string | -       | Specific baseline to inspect              |

Two modes depending on whether `baseline` is provided:

- **Omitted** - compares the latest baseline against the current live state (what changed since you last checkpointed)
- **Provided** - compares that baseline against its predecessor (what that baseline introduced)

Returns a markdown summary: baseline info, new findings (with severity/title/file), removed finding count, and changed files.

### delete_baseline

By default, returns a preview of what would be deleted (dry run). Set `confirm` to actually delete.

| Parameter     | Type    | Required | Description                                              |
|---------------|---------|----------|----------------------------------------------------------|
| `baseline` | string  | yes      | Baseline to delete                                       |
| `confirm`     | boolean | no       | Set to true to actually delete. Default: false (preview). |

## Reconciliation (related but separate)

Baselines track *what* findings exist. Reconciliation tracks *where* findings are - updating line numbers as code changes between commits. See `reconcile`, `get_reconciliation_status`, and `get_annotation_history` MCP tools.

## Expected MCP workflow

### Starting a review

```
1. set_baseline
   reviewer: "alice"
   summary: "Starting review of auth module"
```

This captures the current state as baseline #1. If there are no findings yet, that's fine - the baseline records an empty snapshot, which is useful as a reference point.

### During the review

Add findings with `create_finding`. The delta grows as you work:

```
2. get_delta
   → 4 new findings since baseline #1
   → 0 removed
   → 12 changed files
```

Use `get_delta` at any point to see what's been added since the last baseline.

### Checkpointing progress

```
3. set_baseline
   reviewer: "alice"
   summary: "Auth module complete, moving to payment flow"
```

Now baseline #2 exists. Future `get_delta` calls compare against this new baseline, so only findings from the payment flow review show up as "new".

### Comparing between baselines

```
4. get_delta
   baseline: "<baseline-2-id>"
   → Shows what changed between baseline #1 and #2
```

This is useful for reviewing what a specific round of work produced.

### After code changes

If the codebase has new commits since your last baseline:

```
5. reconcile
   → Updates finding line numbers to match current code

6. get_delta
   → changedFiles shows what files were modified
   → newFindings / removedFindingIDs show if findings were added or cleaned up
```

### Wrapping up

```
7. set_baseline
   reviewer: "alice"
   summary: "Review complete - 12 findings, 3 critical"
```

The final baseline is the deliverable snapshot that records the review outcome.

### Summary: the pattern

```
set_baseline           ← checkpoint before starting
  create findings…
  get_delta            ← monitor progress
set_baseline           ← checkpoint at milestones
  get_delta            ← see what changed between checkpoints
  reconcile            ← if code moved underneath you
set_baseline           ← final snapshot
```

Baselines are cheap - create them liberally. They're just a snapshot row with a list of finding IDs. The delta computation does the heavy lifting when you need to compare.

## Notes

**Resolved findings are included in snapshots.** Baseline `findings` captures all findings in the database, including resolved/closed ones. The `list_findings` MCP tool excludes resolved findings by default, so delta counts may appear higher than `list_findings` output. Use `resolved=true` when cross-referencing.

**Snapshots capture the database, not the commit.** When you set a baseline at commit X, it records all findings currently in the database - regardless of which commit each finding was created at. The `commitId` is used for git diffs (changed files), not for scoping which findings are included.
