# References

References connect annotations to external systems. **Web links** attach a URL (Jira ticket, GitHub issue, Slack thread, etc.) to any annotation. **Feature references** link a finding to the architectural surface it affects.

## Web links

A web link is an external URL attached to a finding, feature, or comment.

```typescript
{
  id: string
  entityType: 'finding' | 'feature' | 'comment'
  entityId: string
  provider: string   // github | gitlab | jira | confluence | linear | notion | slack | url
  url: string
  title?: string     // optional display label
  createdAt: string
}
```

Multiple links can be attached to one annotation, returned inline in the `refs` field.

### Provider

`provider` controls the icon shown in the UI. Inferred from the URL hostname when omitted; set it explicitly only if the inference is wrong.

| Provider | Inferred from |
|----------|--------------|
| `github` | `github.com` |
| `gitlab` | `gitlab.com` |
| `jira` | `*.atlassian.net`, `jira.*` |
| `confluence` | `confluence.*` |
| `linear` | `linear.app` |
| `notion` | `notion.so`, `notion.site` |
| `slack` | `slack.com` |
| `url` | everything else |

### Creating web links

Via CLI:

```bash
# provider inferred from the URL
bench refs create \
  --entity-type finding --entity-id f-abc123 \
  --url https://github.com/org/repo/issues/42

# explicit provider and display label
bench refs create \
  --entity-type finding --entity-id f-abc123 \
  --url https://acme.atlassian.net/browse/SEC-99 \
  --title "SEC-99: SQL injection in auth"
```

Via MCP:

```
create_ref(
  entity_type="finding",
  entity_id="f-abc123",
  url="https://github.com/org/repo/issues/42"
)
```

### Updating and deleting

```bash
bench refs update --id ref-xyz --title "Updated label"
bench refs delete --id ref-xyz
```

```
update_ref(id="ref-xyz", title="Updated label")
delete_ref(id="ref-xyz")
```

Deleting a finding, feature, or comment cascade-deletes its links.

### Batch creation

```bash
echo '[
  {"entityType":"finding","entityId":"f-1","url":"https://linear.app/team/issue/ENG-10"},
  {"entityType":"finding","entityId":"f-2","url":"https://github.com/org/repo/issues/55"}
]' | bench refs batch-create
```

```
batch_create_refs(refs=[
  {"entity_type": "finding", "entity_id": "f-1", "url": "https://linear.app/team/issue/ENG-10"},
  {"entity_type": "finding", "entity_id": "f-2", "url": "https://github.com/org/repo/issues/55"}
])
```

---

## Feature references

A finding can be linked to one or more [features](/concepts/features) via `featureIds`. This connects a vulnerability to the surface it exploits: a SQL injection to the `source` feature for the affected query, a broken auth check to the `interface` feature for the endpoint.

Links make findings easier to triage and help identify which surfaces have confirmed issues.

### When to link

- Finding in an HTTP handler → link to the `interface` feature for that endpoint
- SQL injection in a DB query → link to the `source` or `sink` feature for that query
- Vulnerable dependency → link to the `dependency` feature
- Finding spanning multiple surfaces → link all relevant features

### Creating links

At creation time:

```bash
bench findings create \
  --severity high --title "SQL injection in user lookup" \
  --feature-ids feat-abc123,feat-def456
```

```
create_finding(
  severity="high",
  title="SQL injection in user lookup",
  feature_ids=["feat-abc123"]
)
```

Updating existing links (replaces the full list):

```bash
bench findings update --id f-xyz --feature-ids feat-abc123
```

```
update_finding(id="f-xyz", feature_ids=["feat-abc123", "feat-def456"])
```

### In the UI

Feature links appear in the expanded finding card. Clicking a linked feature navigates to it in the Features view.
