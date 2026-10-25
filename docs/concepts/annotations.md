# Annotations

Findings and comments are annotations: records attached to a place in the code. [Features](/concepts/features) are annotations of the same kind.

## Anchor

Every annotation has an anchor:

```typescript
{
  fileId: string                       // path, e.g. "src/api/auth.go"
  commitId: string                     // the commit at which it was made
  lineRange?: { start: number, end: number }
}
```

The commit makes the anchor stable. When the code changes, [reconciliation](/concepts/reconciling) determines where the anchored lines have moved. An annotation belongs to a [branch](/concepts/review-branch) when its commit is in that branch's history.

## Findings

A finding records a vulnerability or another security issue.

```typescript
{
  id: string
  anchor: Anchor
  title: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  status: 'draft' | 'open' | 'in-progress' | 'false-positive' | 'accepted' | 'closed'
  source: 'pentest' | 'tool' | 'manual' | 'mcp'
  description?: string
  cwe?: string                         // "CWE-89"
  cve?: string
  vector?: string                      // CVSS vector
  score?: number                       // CVSS score
  category?: string
  features?: string[]                  // linked features
  refs?: Ref[]                         // web links
  origin?: Origin
  createdAt: string
  resolvedCommit?: string
}
```

The statuses are `draft` (not yet confirmed), `open`, `in-progress` (a fix is under way), `false-positive`, `accepted` (a known and accepted risk) and `closed`. Resolving a finding at the commit that fixed it records `resolvedCommit` and sets the status to `closed`:

```bash
bench findings resolve --id <id> --commit <sha>
```

Reconciliation also closes a finding when its code is deleted on the review branch.

Each open finding has a deadline that depends on its severity: 7 days for critical, 30 for high, 90 for medium and 180 for low. A finding past its deadline appears in the Activity feed and under **Past SLA** on the Findings page.

```bash
bench findings create --file src/api/auth.go --commit HEAD --start 42 --end 48 \
  --severity high --title "SQL injection" --features feat-abc123
```

## Comments

A comment is a review note. Comments can form threads, and a comment can be linked to a finding or a feature.

```typescript
{
  id: string
  anchor: Anchor
  author: string
  text: string
  type: 'concern' | 'question' | 'improvement' | 'feature' | ''
  threadId: string
  parentId?: string                    // the comment it replies to
  findingId?: string
  featureId?: string
  refs?: Ref[]
  timestamp: string
  resolvedCommit?: string
}
```

| Type | Use |
|---|---|
| `concern` | Something that needs attention but is not a confirmed vulnerability, such as a weak pattern or a missing control. A confirmed issue is recorded as a finding. |
| `question` | A question that must be answered before a judgement can be made. |
| `improvement` | A suggestion that is not a security issue. |
| `feature` | A feature request or suggestion. |
| *(empty)* | Any other note. |

```bash
bench comments create --author alice --text "Use a prepared statement" \
  --file src/api/auth.go --commit HEAD --start 42 --type concern
```

## Origin

The anchor records where an annotation is. The origin records how the code came to be there, as the change that introduced it and that change's position in git. Findings and features can each have an origin:

```json
{
  "explanation": "Added with the SSO work; the token check was not connected.",
  "introducedCommit": "4f2a1c9e…",
  "introducedDate": "2026-03-11",
  "actor": "erin",
  "branch": "feature-sso -> main"
}
```

An origin describes history and is never reconciled. `branch` has the form `source -> merge target`. A commit that git can resolve is stored as its full SHA and kept reachable in the repository. A commit that cannot be resolved, for example because history has been rewritten, is stored as given.

Bench can suggest an origin. It runs blame over the anchored lines and follows the mainline history to the merge that brought them in. The suggestion contains the commit, date and author of the most recent of those lines, the commit and subject of the merge, the branch, and the recent commits to the file. Nothing is saved until the origin is set:

```bash
bench findings suggest-origin --id <id>
bench findings set-origin --id <id> --commit 4f2a1c9e --date 2026-03-11 --actor erin \
  --branch "feature-sso -> main" --explanation "Added with the SSO work."
```

`set-origin` changes only the fields that are given, and `clear-origin` removes the origin. Features have the same commands. The origin is best recorded when the annotation is created, while the relevant code and change are still at hand. Origins make it possible to see where and why issues are introduced.

## Links to features

A finding should be linked to each [feature](/concepts/features) that it affects: the `interface` of an affected handler, the `source` or `sink` of an affected query, or an affected `dependency`. Links are shown on both the finding and the feature. Setting the links replaces the existing list, and deleting the finding or the feature removes the link.

```bash
bench findings update --id <id> --features feat-abc123,feat-def456
```

Over MCP, the equivalent is `update_finding(id, features: ["feat-abc123"])`. A finding can also affect a feature in another project, written as `api:feat-abc123`.

## Web links

A web link connects a finding, feature or comment to a ticket, discussion or page in another system:

```typescript
{ id, entityType: 'finding' | 'feature' | 'comment', entityId, url, title?, provider, createdAt }
```

`provider` determines the icon and is derived from the URL: `github`, `gitlab`, `jira` (`*.atlassian.net`, `jira.*`), `confluence`, `linear`, `notion`, `slack`, and otherwise `url`. Web links are returned with their annotation as `refs`, and are deleted with it.

```bash
bench refs create --entity-type finding --entity <id> \
  --url https://acme.atlassian.net/browse/SEC-99 --title "SEC-99"
```

## Batches

Findings, comments, features and web links can be created in a batch from a JSON array, read from a file with `--input` or from standard input. This is useful for importing the output of a scanner:

```bash
jq '[.[] | {file, commit: "HEAD", severity: "medium", title: .msg}]' scanner.json \
  | bench findings batch-create
```
