# Server API

REST API served by `benchd` (default `:8080`). It manages projects and flows at `/api/projects`, `/api/flows` and friends, and serves each project's [bench API](/api/bench) under `/api/projects/{slug}/*`.

## Projects

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/projects` | List all projects |
| `GET` | `/api/projects/{slug}` | One project, with stats |
| `POST` | `/api/projects` | Register a project |
| `PATCH` | `/api/projects/{slug}` | `{name?, repoPath?}`; the slug stays the same |
| `DELETE` | `/api/projects/{slug}` | Remove a project |

### GET /api/projects

Returns `Project[]` with per-project stats:

```json
[
  {
    "id": "abc123",
    "name": "My Application",
    "slug": "my-application",
    "repoPath": "/path/to/repo",
    "createdAt": "2024-01-15T10:00:00Z",
    "stats": {
      "findingsTotal": 12,
      "findingsOpen": 4,
      "commentsTotal": 8
    }
  }
]
```

### POST /api/projects

```json
{
  "name": "My Application",
  "repoPath": "/path/to/git/repo"
}
```

Returns the created `Project`. The slug is derived from the name (lowercased, hyphenated).

### DELETE /api/projects/{slug}

Returns `204 No Content`. Removes the project registration and its bench instance - does not delete the underlying repository or database file.

## Baselines across projects

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/baselines` | Baselines across all projects |

Returns `PlatformBaseline[]` - all baselines from every project, sorted by date descending.

## Settings

`GET` / `PUT` `/api/settings`: server settings as a JSON object of string values.

## Per-project API

All bench API routes are available per-project at:

```
/api/projects/{slug}/*
```

The server strips the prefix and forwards to that project's bench handler. For example:

```
GET /api/projects/my-application/findings
→ bench GET /findings (for my-application)
```

This means the full [Bench API](/api/bench) is available for each project. The project's MCP endpoint is `/api/projects/{slug}/mcp`.

## Feature catalog

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/features/search` | `?q=&kind=&project=&limit=` (repeat `project` for several; default all, limit 50, max 200). Each result carries `projectSlug` and `projectName`. |
| `GET` | `/api/features` | `?refs=slug:id,slug:id` resolves features from any projects; unresolvable refs come back with `tombstoned: true`. |

## Flows

See [Projects & flows](/concepts/multi-project).

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/flows` | Summaries, paginated `{items, total, offset, limit}`. Filters: `q`, `status`, `tag`, `project`, `owner`, `folder`; `sort` (`updated`, `created`, `name`, `stepCount`, `risk`), `order`, `limit` (default 50, max 200), `offset`. |
| `GET` | `/api/flows/facets` | Filter values with counts; takes the same filters. |
| `POST` | `/api/flows` | `{name, description?, tags?, status?, owner?, folderId?, steps?, edges?}`. With `steps` and `edges` (the export shape) the whole graph is created in the same call. |
| `GET` / `PATCH` / `DELETE` | `/api/flows/{id}` | `GET` returns `steps` and `edges` (always arrays), and `usedIn`: the flows that use this one as a subflow. A subflow step carries `subflowId` and `subflow {id, name, status, stepCount}` instead of a feature. |
| `GET` | `/api/flows/{id}/export` | `{name, description, status, owner, tags, steps, edges}` with each step's id as its `clientId`: what `POST /api/flows` and `PUT …/steps` take back. |
| `POST` | `/api/flows/{id}/steps` | `{projectSlug, featureId, note?, actor?, controls?, after? \| before? \| from? \| entry?, edge?}`, or `subflowId` in place of `projectSlug` + `featureId` for a subflow step (another flow as one block; a 400 if that flow is this one or contains it). See [placing a step](#placing-a-step). |
| `PUT` | `/api/flows/{id}/steps` | Replace the whole graph atomically: `{steps: [{clientId, projectSlug, featureId, note?, actor?, controls?}], edges: [{from, to, …edge fields}]}` (`from`/`to` are clientIds; a step may give `subflowId` instead of a feature). Returns `{flow, stepIds}`. |
| `PATCH` | `/api/flows/{id}/steps/{stepId}` | `{note?, actor?, controls?, projectSlug?, featureId?, subflowId?, branchCondition?}`. Changing the feature (or pointing the step at a flow with `subflowId`) keeps the step's place and edges; `branchCondition` labels the one edge into the step. |
| `DELETE` | `/api/flows/{id}/steps/{stepId}` | `?mode=splice` (default: the steps before it now lead to the steps after it), `subtree` (also the steps only reachable through it) or `isolate`. |
| `POST` | `/api/flows/{id}/steps/{stepId}/move` | `?dir=-1` or `1` (one place along the path, or among sibling branches), or a body with `after`, `before`, `from` or `entry` (and `edge?`) to take the step out and put it there. |
| `PUT` / `DELETE` | `/api/flows/{id}/edges/{fromId}/{toId}` | Create or partially update an edge (omitted fields keep their value), or delete it. Both steps must be in this flow; a self edge is a 400. |
| `GET` / `POST` | `/api/flows/{id}/baselines` | List / snapshot `{reviewer?, summary?}`. |
| `GET` | `/api/flows/{id}/baselines/latest` | |
| `GET` / `DELETE` | `/api/flows/{id}/baselines/{bId}` | |
| `GET` | `/api/flows/{id}/delta` | Changes since the latest baseline, or `?since={bId}`: added / removed / changed steps (`feature`, `subflow`, `note`, `actor`, `controls`, `effectiveAnchor`), moved anchors, and added / removed / changed edges (which fields). Baselines taken before flows were graphs are read in the graph form. |
| `GET` | `/api/service-map` | Services (projects) with their features (kind, operation, protocol, open findings, flows) and the connections flows record between them, merged by feature pair, kind and protocol (`?archived=1` includes archived flows). `internal` lists same-project edges. |
| `GET` | `/api/flows/{id}/findings` | Open findings on the flow's features, by severity. |

### Placing a step

`POST …/steps` and `POST …/steps/{id}/move` take at most one place:

| Field | Where the step goes |
|---|---|
| `after: <step>` | Right after that step: it takes over the step's outgoing edges. |
| `before: <step>` | Right before it: it takes over the step's incoming edges. |
| `from: <step>` | A new branch out of that step (`parentStepId` is the same). |
| `entry: true` | A new entry point, unconnected. |
| none | Appended to the end of the main path (the first edge out of the first entry point, followed to its end). |

`edge` describes the edge that leads into the step at its new place.

### Edge fields

| Field | Meaning |
|---|---|
| `kind` | `next` (default), `call`, `async`, `read`, `write` or `response`. |
| `protocol` | `http`, `grpc`, `sql`, `kafka`, … |
| `condition` | When this path is taken: the branch label. |
| `auth` | The identity the hop carries: `none`, `user`, `service`, `mtls`, `api-key`, … |
| `trustBoundary` | The hop crosses a trust boundary. |
| `data` / `tainted` | What travels on the hop, and whether it is attacker-controlled. |
| `description` / `comment` / `tags` | Edge label, longer review note, tags. |
| `position` | Order among the edges leaving the same step. |

## Flow views

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/flow-views` | Saved flow list queries, newest first. |
| `POST` | `/api/flow-views` | `{name, query?, owner?, isShared?}` |
| `PATCH` / `DELETE` | `/api/flow-views/{id}` | |

## Flow folders

Flows can be organised into nested folders. A flow is in at most one folder; flows with no folder are at the top level. Sibling folder names are unique (case-insensitive) and cannot contain `/`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/flow-folders` | Every folder, flat: `{id, name, parentId?, flowCount, folderCount, createdAt, updatedAt}`. Counts are direct children. |
| `POST` | `/api/flow-folders` | `{name, parentId?}` → 201 folder. 409 if a sibling has that name. |
| `PATCH` | `/api/flow-folders/{id}` | `{name?, parentId?}`; `parentId: ""` moves it to the top level. Moving a folder into itself or a descendant is a 400. |
| `DELETE` | `/api/flow-folders/{id}` | Without `?confirm=true` returns a preview `{folders, flows, confirmRequired}` and deletes nothing. With it, deletes the folder, every subfolder **and every flow inside them**. |
| `POST` | `/api/flows/move` | `{flowIds?, folderIds?, targetFolderId}` (`""` = top level). All-or-nothing. |

Flows gain `folderId` (omitted at the top level). `POST /api/flows` and `PATCH /api/flows/{id}` accept `folderId`; `GET /api/flows?folder=<id>` lists one folder's direct flows (`folder=root` for the top level). Without `folder`, listing and search span every folder.
