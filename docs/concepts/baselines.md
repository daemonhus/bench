# Baselines & deltas

A baseline records the state of a review at a commit. A delta lists what has changed since a baseline. Taking a baseline at the start of a review, at each milestone and at the end makes it possible to see what each stage of the review produced.

## Baseline

```typescript
{
  id: string
  seq: number                          // 1, 2, 3, … within the project
  commitId: string
  reviewer: string
  summary?: string
  createdAt: string
  findings: string[]                   // the ID of every finding at the time
  features: string[]                   // the ID of every feature at the time
  findingsTotal, findingsOpen: number  // counted on the commit's history
  bySeverity, byStatus, byCategory: Record<string, number>
  commentsTotal, commentsOpen: number
  featuresTotal, featuresActive: number
  byKind: Record<string, number>
}
```

A baseline is never modified; a later state is recorded in a new baseline. If no commit is given, the baseline is taken at the head of the [review branch](/concepts/review-branch). Its counts include only what is anchored on that commit's history.

## Delta

```typescript
{
  sinceBaseline: Baseline
  headCommit: string                   // the head of the review branch
  newFindings: Finding[]               // on the branch now and not in the baseline
  newFeatures: Feature[]
  removedFindingIds: string[]          // in the baseline and deleted since
  removedFeatureIds: string[]
  changedFiles: { path, added, deleted }[]   // from the baseline's commit to the branch head
  currentStats: ProjectStats
  serviceProfile?: ServiceProfile      // present when the profile is configured
}
```

There are two kinds of delta:

- The delta since the latest baseline (`bench baselines delta`, or the MCP tool `get_delta` without arguments) compares the review branch with its latest baseline, which is the most recent baseline whose commit is in the branch's history. Baselines taken on other branches are not used.
- The delta of a given baseline (`bench baselines delta --id <id>`, or `get_delta` with `baseline`) compares that baseline with the previous baseline in its history.

New and removed findings and features are determined by ID, against the IDs recorded in the baseline. A finding created after the baseline is new if it is anchored on the branch, and a finding deleted since the baseline is removed. `changedFiles` is determined differently: it is the diff of the code between the two commits, and it does not depend on the findings.

Resolved findings remain in baselines but are excluded from lists unless `--resolved` is given, so the count in a baseline can be higher than the length of a list.

## Commands

```bash
bench baselines set --reviewer alice --summary "Auth module done"   # --commit selects the commit
bench baselines list                                                # most recent first; 20 by default
bench baselines delta
bench baselines delete --id <id>                                    # a preview, unless --confirm is given
```

The MCP tools are `set_baseline`, `list_baselines`, `get_delta` and `delete_baseline`. Flows have [their own baselines](/concepts/multi-project#flows).

## Baselines during a review

```
set a baseline        before starting
  record findings and features
  check the delta     to see what has been added
set a baseline        at a milestone
  reconcile           if the code has changed
set a baseline        at the end, as the record of the review
```
