# Features

Features describe the security-relevant surface of a codebase: the endpoints that it exposes, the places where it reads and writes data, the services that it calls, and the work that runs in the background. Findings record problems; features record structure. Each feature is [anchored](/concepts/annotations#anchor) to the code that defines it.

```typescript
{
  id: string
  anchor: Anchor
  kind: 'interface' | 'source' | 'sink' | 'dependency' | 'externality'
  title: string
  status: 'draft' | 'active' | 'deprecated' | 'removed' | 'orphaned'
  description?: string
  direction?: 'in' | 'out'             // direction of data flow relative to the service
  operation?: string                   // HTTP method, RPC method or GraphQL operation
  protocol?: string                    // rest, grpc, graphql, websocket, …
  source?: string
  tags?: string[]
  parameters?: Parameter[]             // the inputs of an interface
  linkedFeatures?: { id: string, description?: string }[]
  crossProjectFindings?: string[]      // findings in other projects that affect it
  refs?: Ref[]
  origin?: Origin
  createdAt: string
}
```

When the code of a feature is deleted, [reconciliation](/concepts/reconciling) sets its status to `orphaned`. After the feature has been re-anchored, its status can be set back to `active`.

## Kinds

| Kind | Meaning | Direction |
|---|---|---|
| `interface` | An endpoint, RPC method, WebSocket handler or message consumer that the service exposes. Each method and path is a separate feature. | `in` |
| `source` | A place where the service reads data, such as a database query, cache read, file read, queue poll or configuration fetch. | `in` |
| `sink` | A place where the service writes data, such as a database write, cache write, queue publish, file write or call to an external third party. | `out` |
| `dependency` | A call to another internal service. Each client class or integration point is a separate feature, anchored to the client code. | `out` |
| `externality` | A background job, periodic task, start-up or shutdown hook, or asynchronous side effect that is not triggered by an inbound request. | none |

The following rules apply:

- Each endpoint is a separate feature. `GET` and `POST` on the same path are two features, and the method is recorded in `operation`.
- A dependency is a service, not a library. A vulnerable package is recorded as a finding.
- The description names the class or function, the target, and the code that uses it.
- The anchor is the definition: the route, the client class, the query or write, or the task function.

Where the kind is unclear, the following distinctions apply. If an external actor initiates the call, the feature is an `interface`; if the service initiates a read, it is a `source`. A handler is therefore an `interface`, and the query inside it is a `source`. A call to one of your own services is a `dependency`, and a call to a third party is a `sink`. A data store that is both read and written has a `source` and a `sink`, each anchored to its own code.

Titles follow these conventions:

| Kind | Title |
|---|---|
| `interface` | The path without the method, for example `/orders/{id}`. |
| `source`, `sink` | A resource URI, for example `postgresql://users_db (read)`, `s3://audit-logs` or `https://api.acmepay.example.com`. |
| `dependency` | `<Caller> to <service host> (<domain>)`, for example `Order API to billing-svc.cluster.local (charges)`. |
| `externality` | A description of the task, for example `Cache prune periodic task`. |

## Parameters

Parameters describe the inputs of an interface, such as authentication headers, path variables, query parameters and body fields:

```typescript
{ id, featureId, name, type?, pattern?, required: boolean, description?, createdAt }
```

`type` is one of `string`, `integer`, `boolean`, `object`, `array` and `file`. `pattern` is any constraint, such as a regular expression, a list of values or a range. Parameters are listed in order of name.

```bash
bench features params-create --feature <id> --name Authorization --type string --required \
  --description "Bearer token"
```

## Links between features

Links between features record which features call or depend on which others, such as an interface and the source behind it, or a dependency and the service that it calls. A link appears on both features and can have a description. Setting the links replaces the existing list. A link from a feature to itself, or to a feature that does not exist, is rejected.

```bash
bench features update --id <id> --features "feat-abc|validates the JWT,feat-def|writes the audit log"
bench features update --id <id> --features ""          # remove all links
bench features list --linked-to feat-abc               # features linked to feat-abc in either direction
```

Over MCP, `linked_feature_ids` takes IDs or `{id, description}` objects.

On a server with several projects, a feature can be linked to a feature in another project, and a finding can affect a feature in another project. The reference is written `<project>:<id>`, for example `api:feat-abc123`, or as `{id, project}` over MCP. The other feature lists the link in return, and a feature lists the findings from other projects that affect it in `crossProjectFindings`. [Flows](/concepts/multi-project#flows) and the service map use these links.

## Creating features

```bash
bench features create --file src/api/auth.go --commit HEAD --start 12 --end 28 \
  --kind interface --title /login --operation POST --protocol rest
```

To map a whole service, write the features of each kind to a JSON file and create them with `bench features batch-create --input <file>`.
