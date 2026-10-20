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
| `POST` | `/api/flows` | `{name, description?, tags?, status?, owner?, folderId?}` |
| `GET` / `PATCH` / `DELETE` | `/api/flows/{id}` | `GET` includes the step tree and `links`. |
| `POST` | `/api/flows/{id}/steps` | Add a step (a feature on some project). |
| `PUT` | `/api/flows/{id}/steps` | Replace the whole tree and links atomically. |
| `PATCH` / `DELETE` | `/api/flows/{id}/steps/{stepId}` | Update note or branch condition / remove with children. |
| `POST` | `/api/flows/{id}/steps/{stepId}/move` | `?dir=-1` or `1`. |
| `PUT` / `DELETE` | `/api/flows/{id}/links/{fromId}/{toId}` | `{description?, comment?, tags?}`. Both steps must belong to this flow (they may be on different projects); a self-link is a 400. |
| `GET` / `POST` | `/api/flows/{id}/baselines` | List / snapshot `{reviewer?, summary?}`. |
| `GET` | `/api/flows/{id}/baselines/latest` | |
| `GET` / `DELETE` | `/api/flows/{id}/baselines/{bId}` | |
| `GET` | `/api/flows/{id}/delta` | Changes since the latest baseline, or `?since={bId}`. |
| `GET` | `/api/flows/{id}/findings` | Open findings on the flow's features, by severity. |

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
