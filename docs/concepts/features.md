# Features

Features are architectural annotations that map the security-relevant surface of a codebase: API endpoints, data flows, third-party dependencies, and background processes. Unlike findings (which flag problems), features describe structure: what the system does and where data moves.

## Data model

```typescript
{
  id: string
  anchor: Anchor
  kind: 'interface' | 'source' | 'sink' | 'dependency' | 'externality'
  title: string
  description?: string
  status: 'draft' | 'active'
  direction?: 'in' | 'out'   // data flow relative to the service
  operation?: string          // HTTP method, gRPC method, GraphQL op, etc.
  protocol?: string           // e.g. rest, grpc, graphql, websocket
  source?: string
  tags?: string[]
  refs?: Ref[]                // external links (enriched inline)
  parameters?: FeatureParameter[]  // structured inputs/outputs; meaningful for kind: 'interface'
  createdAt: string
}
```

Do not include the HTTP method or protocol in `title`. Use `operation` for that. Write `"Login endpoint"`, not `"POST /login"`.

## Kinds

| Kind | Use when… |
|------|-----------|
| `interface` | The service **exposes** this entry point: an HTTP handler, gRPC method, WebSocket endpoint, or message consumer. External actors call or send to it. |
| `source` | The service **reads** from this: a DB query, file read, cache lookup, or inbound queue. Data enters your processing pipeline at this point. |
| `sink` | The service **writes** to this: a DB write, outbound HTTP call, file write, or message publish. Data leaves your processing pipeline here. |
| `dependency` | A third-party library or external service **as a whole**, when the concern is about the integration itself (trust, version, supply chain), not a specific call. |
| `externality` | A background job, cron task, event handler, or async side-effect that runs **without an inbound request** triggering it. |

### Ambiguous cases

**`interface` vs `source`:** Ask who initiates. If an external actor triggers it → `interface`, even though it produces input data. If the service itself initiates a read → `source`. An HTTP handler is `interface`; the DB query inside that handler is `source`.

**`sink` vs `dependency`:** Use `sink` for a specific outbound data flow (sending email, writing to S3). Use `dependency` for the library or service itself when the concern is the integration, not a specific call. A codebase can have one `dependency` for the AWS SDK and many `sink` annotations for individual S3 writes.

**Same system, two roles:** A database often appears as both `source` (reads) and `sink` (writes). Annotate each at its specific code location rather than trying to pick one.

**`externality` vs `interface`:** If triggered by a scheduler or internal event → `externality`. If triggered by an inbound webhook or external message → `interface` with `direction: in`.

## Parameters

Parameters document the expected inputs and outputs of an `interface` feature — auth headers, path variables, query params, body fields.

```typescript
{
  id: string
  featureId: string
  name: string          // e.g. "Authorization", "user_id"
  description?: string  // what it carries, security notes
  type?: string         // string | integer | boolean | object | array | file
  pattern?: string      // constraint: regex, enum list, format hint
  required: boolean
  createdAt: string
}
```

Parameters are ordered by `name` alphabetically in list responses.

Via CLI:

```bash
bench features params-create \
  --feature feat-abc123 \
  --name Authorization --type string --required \
  --description "Bearer token"

bench features params-list --feature feat-abc123
bench features params-get --id param-xyz
bench features params-update --id param-xyz --description "JWT bearer token"
bench features params-delete --id param-xyz
```

Via MCP:

```
create_feature_parameter(feature="feat-abc123", name="Authorization", type="string", required=true)
list_feature_parameters(feature="feat-abc123")
get_feature_parameter(id="param-xyz")
update_feature_parameter(id="param-xyz", description="JWT bearer token")
delete_feature_parameter(id="param-xyz")
```

## Linking findings to features

Findings can reference features via `features`. See [Linking findings to features](/concepts/annotations#linking-findings-to-features).

## Creating features

Via CLI:

```bash
bench features create \
  --file src/api/auth.go --commit HEAD \
  --start 12 --end 28 \
  --kind interface --title "Login endpoint" \
  --operation POST --protocol rest
```

Via MCP:

```
create_feature(
  file="src/api/auth.go", commit="HEAD",
  start=12, end=28,
  kind="interface", title="Login endpoint",
  operation="POST", protocol="rest"
)
```
