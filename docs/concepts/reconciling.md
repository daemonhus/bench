# Reconciling

Annotations are anchored to a file path, a commit, and a line range. When code changes - functions move, lines are inserted, files are renamed - the anchors become stale. Reconciliation updates them to reflect the current state of the codebase.

## The problem

You create a finding at `src/api/auth.go` line 42, commit `abc123`. A week later, someone refactors the file: the vulnerable function is now at line 67. The finding still points to line 42, which is now a different line entirely.

Reconciliation uses `git diff` to trace how each annotated line moved between commits, then updates the stored anchor to the new position.

## Algorithm

Reconciliation walks the commit sequence from the annotation's anchor commit to the target commit, applying each diff in turn.

### 1. Diff parsing

Each diff is parsed into hunks. Every line in a hunk is classified as context (unchanged), deleted, or inserted, with its old and new line numbers recorded. Context lines are the anchor points - they appear in both versions and carry a precise old→new mapping.

### 2. Line mapping

For each annotated line number, the algorithm scans through the hunks:

- **Before a hunk** - the line is unaffected; apply the cumulative offset from all prior hunks and return.
- **Inside a hunk** - search for an exact match in the hunk's parsed lines:
  - Found as a context line → return its new line number.
  - Found as a deleted line → mapping fails for this line.
  - Not found → treat as deleted (malformed diff edge case).
- **After all hunks** - apply the total offset (sum of `newCount - oldCount` across all hunks).

The range is mapped all-or-nothing: if any single line in the annotated range was deleted, the entire mapping fails and falls through to content matching.

### 3. Content hash fallback

When line mapping fails, reconciliation attempts to find the annotated code by content:

1. Normalise each line (trim whitespace, collapse internal whitespace to single spaces).
2. SHA-256 hash the normalised block.
3. Slide a window of the same size across the file at the target commit.
4. If a matching window is found, update the position with confidence `moved`.
5. If no match, the annotation is `orphaned`.

Whitespace normalisation makes the hash resilient to formatting changes while remaining specific enough to avoid false matches on real code.

### 4. Confidence levels

Every position record carries a confidence level that reflects how it was determined:

| Confidence | Meaning |
|------------|---------|
| `exact` | Line mapping succeeded through the diff |
| `moved` | Placed by content match or file rename |
| `orphaned` | Code not found; no reliable position |

Confidence can only decrease over time. An `exact` annotation that survives a rename becomes `moved`. An annotation whose code is deleted becomes `orphaned` and stays there.

### 5. Edge cases

**File renamed** - `git diff` may produce an empty diff for the old path. The algorithm detects renames, updates the working path, and re-attempts content matching at the new path. Previously `exact` annotations become `moved`.

**Rebase / non-ancestor branch** - if the last reconciled commit is not an ancestor of the target, the algorithm finds the merge base, discards positions recorded after it, and re-walks from the merge base along the new branch.

**File deleted** - after walking all commits, the algorithm checks whether the file exists at the target. If not, any remaining `exact` or `moved` annotations are orphaned.

**Whitespace-only changes** - line mapping succeeds because the diff still records the line as context; positions stay `exact`.

## Running reconciliation

```bash
# Reconcile all annotations to HEAD
bench reconcile start

# Scope to specific files
bench reconcile start --file-paths src/api/auth.go,src/api/session.go
```

Via MCP:

```
reconcile(target_commit="HEAD")
```

Reconciliation runs as a background job. Check progress with:

```bash
bench reconcile status --job-id <job-id>
```

## What gets updated

- **Finding line ranges** - `anchor.lineRange.start` and `end` are updated to their new positions
- **Comment line ranges** - same
- The `anchor.commitId` is updated to the target commit

If a line was deleted and cannot be mapped forward, the annotation retains its last known position and is flagged as unresolvable.

## History

You can see exactly how an annotation's position has moved over time:

```bash
bench reconcile history --type finding --id <finding-id>
bench reconcile history --type comment --id <comment-id>
```

This returns the full position history - useful for understanding whether a finding survived a refactor or was introduced after one.

## Reconcile head

```bash
bench reconcile head
```

Returns the current reconciliation state: which commit all annotations are currently reconciled to, and whether any are pending.

## Relationship to baselines

Reconciliation and baselines are complementary. Baselines track *what* findings exist. Reconciliation tracks *where* they are.

After a large code change, the recommended sequence is:

```
reconcile              ← update positions to current code
get_delta              ← changedFiles shows what moved
                          newFindings / removedFindingIds show review changes
set_baseline           ← checkpoint the updated state
```
