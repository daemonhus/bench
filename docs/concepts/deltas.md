# Deltas

A delta answers the question: **what changed since the last time I looked?**

Deltas are computed against [baselines](/api/baselines) -immutable snapshots of the review state at a point in time. By comparing the current state to a baseline, you get a precise account of what findings were added, which were removed, and which files in the codebase changed underneath them.

## What a delta contains

```typescript
{
  sinceBaseline: Baseline     // the reference snapshot
  headCommit: string          // current tip of the default branch
  newFindings: Finding[]      // findings that exist now but weren't in the baseline
  removedFindingIds: string[] // findings that were in the baseline but no longer exist
  changedFiles: string[]      // files modified between baseline commit and HEAD
  currentStats: ProjectStats  // current aggregate counts
}
```

## Two delta modes

**Since latest** -compares the current live state against the most recent baseline. This is the day-to-day check: what has changed since I last checkpointed?

```bash
bench baselines delta
# MCP: get_delta()
```

**Between two baselines** -compares a specific baseline against its predecessor. This answers: what did a particular round of work produce?

```bash
bench baselines delta --id <baseline-id>
# MCP: get_delta(baseline_id="...")
```

## Typical workflow

```
set baseline          ← mark the start of a review session
  add findings…
  check delta         ← see what you've added so far
set baseline          ← checkpoint at a milestone
  check delta         ← what did this round produce?
set baseline          ← final snapshot
```

Baselines are cheap -create them liberally. The delta computation is where the interesting analysis happens.

## Computed fields

**newFindings** is determined by comparing IDs: findings whose IDs are not present in the baseline's `findingIds` list are new.

**removedFindingIds** is the inverse: IDs that were in the baseline but no longer exist in the database.

**changedFiles** comes from `git diff <baselineCommit>..<HEAD>` -the files that the codebase itself has changed between the baseline commit and the current default branch tip. This is distinct from which files have new findings; it tells you where the code moved.

## Notes

Resolved and closed findings are included in baseline snapshots. Delta counts may therefore be higher than `findings list` output (which excludes resolved findings by default). Pass `--status closed` or use `include_resolved=true` in MCP when cross-referencing.
