# Reconciling

An annotation is anchored to a file, a commit and a line range. When the code changes, the anchored lines can move: lines are inserted above them, functions are moved, and files are renamed. Reconciliation determines where the anchored lines are at a later commit.

For example, a finding is created at line 42 of `src/api/auth.go` at commit `abc123`. The file is later refactored, and the vulnerable function moves to line 67. Reconciliation uses the diffs between the commits to find that line 42 has become line 67, and records the new position.

## Algorithm

Reconciliation applies the diff of each commit in turn, from the annotation's commit to the target commit.

### 1. Parsing the diff

Each diff is parsed into hunks. Every line in a hunk is classified as unchanged (context), deleted or inserted, together with its old and new line numbers. Context lines appear in both versions and give an exact mapping from the old line number to the new one.

### 2. Mapping lines

Each annotated line is mapped through the hunks as follows:

- A line before a hunk is unaffected, apart from the offset accumulated from earlier hunks.
- A line inside a hunk is looked up in the hunk. If it is a context line, its new line number is used. If it is a deleted line, or if it is not found, the mapping fails.
- A line after all the hunks is moved by the total offset, the sum of `newCount - oldCount` over all hunks.

The line range is mapped as a whole. If any line in the range has been deleted, the mapping fails and reconciliation falls back to matching the content.

### 3. Matching content

When line mapping fails, reconciliation searches for the annotated code by its content:

1. Each line is normalised by trimming whitespace and replacing runs of internal whitespace with a single space.
2. The normalised lines are hashed with SHA-256.
3. A window of the same number of lines is moved through the file at the target commit, and the hash of each window is compared.
4. If a window matches, the annotation is placed there with confidence `moved`.
5. If no window matches, the annotation is `orphaned`.

Normalising whitespace means that formatting changes do not prevent a match, while the hash remains specific enough to avoid matching unrelated code.

### 4. Confidence

Each recorded position has a confidence:

| Confidence | Meaning |
|---|---|
| `exact` | The lines were mapped through the diffs. |
| `moved` | The lines were found by content, or the file was renamed. |
| `orphaned` | The code was not found, and there is no reliable position. |

Reconciliation can only lower the confidence. An `exact` annotation in a renamed file becomes `moved`, and an annotation whose code is deleted becomes `orphaned`.

An orphaned annotation is restored by re-anchoring it, that is, by updating it with a new file, line range and commit, for example with `bench findings update --id <id> --file … --start … --end … --commit HEAD` or with the MCP tools `update_finding`, `update_comment` and `update_feature`. The new position has confidence `exact` immediately, and later reconciliation continues from it.

### 5. Special cases

**Renamed files.** The diff of a renamed file can be empty for the old path. Reconciliation detects the rename, continues with the new path, and repeats the content match there. Annotations that were `exact` become `moved`.

**Another branch, or rewritten history.** If the commit that the annotations were last reconciled to is not an ancestor of the target, either because the [review branch](/concepts/review-branch) has changed or because history has been rewritten, reconciliation finds the merge base of the two commits and continues from there along the target's history. Each annotation starts from its most recent position in that history. Positions recorded on the other branch are kept, so that they can be used if that branch is reviewed again.

**Annotations on other branches.** An annotation whose commit is not in the target's history is not reconciled to the target. It has no position there, and it is not orphaned or closed because of a branch that does not contain it. An annotation created later on the target's history is moved only by the commits that follow its own commit.

**Deleted files.** After applying the diffs, reconciliation checks that the file exists at the target commit. If it does not, any annotation in it that is still `exact` or `moved` becomes `orphaned`.

**Whitespace changes.** A line whose whitespace has changed remains a context line in the diff, so the mapping succeeds and the position remains `exact`.

## What reconciliation records

Reconciliation does not change an annotation's anchor. It records a position for each annotation at the commit that it reconciled to, consisting of the file, the line range and the confidence. When the findings, comments or features of a file are requested at a commit, each one includes its `effectiveAnchor` and `confidence` at that commit, taken from its most recent position in that commit's history.

When the code of a finding is deleted, reconciliation closes the finding and adds a comment that gives the reason. When the code of a feature is deleted, reconciliation sets its status to `orphaned`. Either can be re-anchored afterwards, as described above.

## Running reconciliation

The UI reconciles the annotations to the head of the [review branch](/concepts/review-branch) automatically whenever they are behind it. The CLI and MCP start reconciliation explicitly:

```bash
bench reconcile start                              # to the review branch's head; --target <commit>, --file-paths a.go,b.go
bench reconcile status --job <id>
bench reconcile head                               # how far the annotations are reconciled
bench reconcile history --type finding --id <id>   # an annotation's positions over time
```

The MCP tools are `reconcile`, `get_reconciliation_status` and `get_annotation_history`. A reconciliation job runs in the background. If a file fails, the failure is reported in the job's `error`, and the other files are still reconciled.
