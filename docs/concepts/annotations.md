# Annotations

Annotations are the things you attach to code: findings (vulnerabilities) and comments (review notes). Both share the same anchor model - a file, a commit, and an optional line range.

## Anchor

Every annotation is pinned to a specific location in the repository:

```typescript
{
  fileId: string         // file path, e.g. "src/api/auth.go"
  commitId: string       // git commit hash
  lineRange?: {
    start: number
    end: number
  }
}
```

The commit is what makes annotations stable. Because the anchor records the exact commit the annotation was made against, it stays accurate even as the file changes. When code moves, [reconciliation](/concepts/reconciling) updates the line numbers to follow it.

## Findings

A finding represents a discovered vulnerability or security issue.

```typescript
{
  id: string
  anchor: Anchor
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  title: string
  description?: string
  cwe?: string           // e.g. "CWE-89"
  cve?: string
  vector?: string        // CVSS vector
  score?: number         // CVSS score
  status: 'draft' | 'open' | 'in-progress' | 'false-positive' | 'accepted' | 'closed'
  source?: string        // tool or scanner that created it
  category?: string
  featureIds?: string[]  // features this finding is linked to
  createdAt: string
  resolvedCommit?: string
}
```

### Lifecycle

Findings move through statuses as a review progresses:

- **draft** - work in progress, not yet confirmed
- **open** - confirmed, needs attention
- **in-progress** - being actively remediated
- **false-positive** - reviewed and dismissed
- **accepted** - acknowledged risk, won't fix
- **closed** - resolved

When a finding is fixed, call `resolve` with the commit where the fix landed. This records `resolvedCommit` and sets the status to `closed`.

## Comments

A comment is a code review note - free-form text attached to a location.

```typescript
{
  id: string
  anchor: Anchor
  author: string
  text: string
  timestamp: string
  threadId?: string      // groups related comments into a thread
  parentId?: string      // reply to a specific comment
  findingId?: string     // link to a related finding
  featureId?: string     // link to a related feature
  resolvedCommit?: string
}
```

Comments can form threads (`threadId`), have replies (`parentId`), and be linked to findings (`findingId`). Like findings, they can be resolved at a specific commit.

### Comment types

The `comment_type` field signals intent. Use it consistently so reviewers can filter and prioritize.

| Type | Use when… |
|------|-----------|
| `concern` | Something warrants attention but isn't a confirmed vulnerability — a weak pattern, a missing control, a smell. Use a **finding** for confirmed issues. |
| `question` | You need clarification before making a judgment. |
| `improvement` | A non-critical suggestion — cleaner, safer, or more robust code, not a security issue. |
| `feature` | The comment is about a [feature](/concepts/features) annotation (link via `featureId`). |
| *(empty)* | A general note that doesn't fit the above. |

## Linking findings to features

A finding can be linked to one or more [feature](/concepts/features) annotations via `featureIds`. This connects a vulnerability to the architectural surface it affects — for example, linking a SQL injection finding to the `source` feature for the database query where it occurs.

Links should be created whenever a finding is directly associated with a known feature. They make findings easier to triage and let you see which parts of the attack surface have confirmed issues.

Via CLI:

```bash
bench findings create \
  --severity high --title "SQL injection" \
  --feature-ids feat-abc123,feat-def456
```

Via MCP:

```
create_finding(severity="high", title="SQL injection", feature_ids=["feat-abc123"])
```

To update links on an existing finding (replaces the full list):

```bash
bench findings update --id f-xyz --feature-ids feat-abc123
```

```
update_finding(id="f-xyz", feature_ids=["feat-abc123"])
```

Deleting a feature or finding automatically removes its links — no manual cleanup needed.

## Creating annotations

Via CLI:

```bash
bench findings create \
  --file-id src/api/auth.go --commit-id HEAD \
  --line-start 42 --line-end 48 \
  --severity high --title "SQL injection"

bench comments create \
  --author alice --text "Needs a prepared statement" \
  --file-id src/api/auth.go --commit-id HEAD --line-start 42
```

Via MCP:

```
create_finding(file="src/api/auth.go", commit="HEAD", line_start=42, severity="high", title="SQL injection")
create_comment(author="alice", text="Needs a prepared statement", file="src/api/auth.go", commit="HEAD", line_start=42)
```

## Batch import

Both findings and comments support batch creation from a JSON array - useful for importing output from scanners or other tools:

```bash
jq '[.[] | {file, commit: "HEAD", severity: "medium", title: .msg}]' \
  scanner-output.json | bench findings batch-create
```
