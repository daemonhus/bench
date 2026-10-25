# API

`benchd` serves the REST API, the UI and [MCP](/reference/mcp) on one port, `:8080` by default. Requests and responses are JSON. An error response is `{error}` with the corresponding HTTP status.

- **Projects.** A project's routes are under `/api/projects/{slug}`; for example, `GET /api/projects/api/findings` returns the findings of the `api` project. The table below gives each route after the slug.
- **Review branch.** A project's routes use its [review branch](/concepts/review-branch). A request that names no commit uses the head of the branch, the commit history ends at that head, lists of findings, comments, features and baselines include only what is on the branch, and the `X-Bench-Off-Branch` header of a list response gives the number of items left out. `?branch=<name>` or the `X-Bench-Branch` header selects another branch, and `?all_branches=true` includes every branch.
- **IDs.** An ID can be given as a prefix that matches exactly one item.
- **Service profile.** Until the project's [service profile](/ui#profile) has been set, writes to findings, comments, features, refs, baselines and coverage return `412`.
- **Events.** `GET /api/projects/{slug}/events` is a stream of server-sent events, each naming what has changed: `annotations`, `baselines`, `git` or `profile`.

The data structures are described on the concept pages for [findings and comments](/concepts/annotations), [features](/concepts/features), and [baselines and deltas](/concepts/baselines).

## Project routes

| Route | Description |
|---|---|
| `GET /git/info` | The repository name, default branch and remote URL. |
| `GET /git/commits` | Commits, ending at the head of the review branch unless `to_commit` is given. Parameters: `limit` (default 50), `from_commit`, `to_commit`, `path`. |
| `GET /git/tree/{commitish}` | The files at a commit, optionally limited by `prefix`. |
| `GET /git/show/{commitish}/{path}` | The content of a file, optionally limited by `line_start` and `line_end`. |
| `GET /git/diff`, `GET /git/diff-files` | The diff between `from` and `to` for one `path`, and the list of files changed between them. |
| `GET /git/branches` | The branches. |
| `GET /git/graph` | The commit graph, limited by `limit`. |
| `GET /git/activity` | Commits per `scale` (`day`, `week`, `month` or `year`). |
| `GET /git/range-stats` | The number of commits and merges between `from` and `to`. |
| `GET /git/blame` | Blame for `path` at `commit`, which defaults to the head of the review branch. |
| `GET /git/search` | A search for `pattern` (RE2), with optional `commit` (by default the head of the review branch), `path`, `case_insensitive` and `fixed`. |
| `GET /review-branch`, `PUT /review-branch` | The review branch in use, as `{name, tip, defaultBranch, saved, override, missing?}`. `PUT {branch}` saves it; `""` selects the default branch. |
| `GET /findings`, `POST /findings` | Lists or creates findings. A finding created without `anchor.commitId` is anchored at the head of the review branch, as are comments and features. The list takes `fileId`, `severity`, `status`, `category`, `include_resolved` and `commit`; with `commit`, each finding includes its `effectiveAnchor` and `confidence` at that commit. |
| `GET /findings/{id}`, `PATCH /findings/{id}`, `DELETE /findings/{id}` | Reads, updates or deletes a finding. `PATCH` changes only the fields given, and `features` replaces the existing links. |
| `GET /findings/search` | A text search over findings, with `query`, `status` and `severity`. |
| `GET`, `PUT`, `DELETE /findings/{id}/origin`; `GET /findings/{id}/origin/suggest` | The [origin](/concepts/annotations#origin) of a finding. `PUT` changes only the fields given. |
| `GET`, `POST /comments`; `GET`, `PATCH`, `DELETE /comments/{id}` | Comments, as for findings. `findingId` or `featureId` returns the thread of a finding or a feature. |
| `GET`, `POST /features`; `GET`, `PATCH`, `DELETE /features/{id}` | Features. The list takes `kind`, `status` and `linkedTo`. `GET /features/{id}?commit=` includes the feature's position at that commit. |
| `GET`, `PUT`, `DELETE /features/{id}/origin`; `GET /features/{id}/origin/suggest` | The origin of a feature, as for findings. |
| `GET`, `POST /features/{id}/parameters`; `GET`, `PATCH`, `DELETE /features/{id}/parameters/{pid}` | The parameters of an interface. |
| `GET`, `POST /refs`; `GET`, `PATCH`, `DELETE /refs/{id}` | Web links. The list takes `entityType`, `entityId` and `provider`. |
| `GET /baselines` | The baselines of the review branch, most recent first. `limit` defaults to 20. |
| `GET /baselines/latest`, `GET /baselines/delta` | The latest baseline of the review branch, and the delta since it. |
| `GET`, `PATCH`, `DELETE /baselines/{id}`; `GET /baselines/{id}/delta` | A baseline. `PATCH {reviewer?, summary?}` updates it, and `DELETE` returns a preview unless `confirm=true` is given. The delta is against the previous baseline. |
| `POST /baselines` | Creates a baseline from `{reviewer?, summary?, commitId?}`. The commit defaults to the head of the review branch. |
| `POST /reconcile` | Starts a reconciliation job from `{targetCommit?, filePaths?}`. The target defaults to the head of the review branch. |
| `GET /reconcile/status` | The status of a job (`jobId`), or of a file at a commit (`fileId` and `commit`). |
| `GET /reconcile/head` | How far the annotations are reconciled towards the head of the review branch. |
| `GET /annotations/{type}/{id}/history` | The positions of an annotation over time. |
| `GET /summary` | Counts of findings by severity and status and of unresolved comments, on the history of `commit` (by default the head of the review branch), and the reconciliation status. `all_branches=true` counts every branch. |
| `GET /coverage`, `POST /coverage/mark` | The files reviewed, with `commit`, `path` and `only_unreviewed`; and marking a file as reviewed with `{path, commit, reviewer?, note?}`. |
| `GET /profile`, `PATCH /profile` | The service profile. A `PATCH` replaces each array that it gives, and `[]` clears an array. |
| `GET /settings`, `PUT /settings` | The project's settings, as string values. |
| `GET /events` | The stream of server-sent events. |
| `GET /health` | A health check. |
| `POST /mcp` | The project's MCP endpoint. |

The following request creates a finding:

```json
POST /api/projects/api/findings
{
  "anchor": { "fileId": "src/api/auth.go", "commitId": "abc123", "lineRange": { "start": 42, "end": 48 } },
  "severity": "high",
  "title": "SQL injection in login handler",
  "status": "open",
  "features": ["feat-abc123"]
}
```

## Server routes

| Route | Description |
|---|---|
| `GET /api/projects`, `POST /api/projects` | Lists the projects, each with `stats`, `riskData` (activity since its latest baseline) and `activity`; or registers a project from `{name, repoPath}`. The slug is derived from the name. |
| `GET`, `PATCH`, `DELETE /api/projects/{slug}` | A project. `PATCH {name?, repoPath?}` keeps the slug. `DELETE` removes the registration, and leaves the repository and database in place. |
| `GET /api/baselines` | The baselines of every project, most recent first. |
| `GET /api/features/search` | A search over the features of all projects, with `q`, `kind`, `project` (repeatable) and `limit` (default 50, maximum 200). |
| `GET /api/features` | Features given by `refs`, for example `refs=api:feat-1,web:feat-2`. Features that cannot be found are returned as `tombstoned`. |
| `GET /api/service-map` | The services with their features and trust zones, the connections recorded by flows (with `zoneBoundary` and `linked`), and the feature links (with `inFlows`). `archived=1` includes archived flows. |
| `GET /api/settings`, `PUT /api/settings` | The server settings, as string values. |
| `POST /mcp` | The MCP endpoint for all projects. |

## Flows

| Route | Description |
|---|---|
| `GET /api/flows` | Lists flows as `{items, total, offset, limit}`. Filters: `q`, `status`, `tag`, `project`, `owner` and `folder` (`root` for the top level). Sorting: `sort` (`updated`, `created`, `name`, `stepCount` or `risk`) and `order`. Paging: `limit` (default 50, maximum 200) and `offset`. |
| `GET /api/flows/facets` | The values of each filter, with counts. |
| `POST /api/flows` | Creates a flow from `{name, description?, tags?, status?, owner?, folderId?, steps?, edges?}`. With `steps` and `edges`, in the exported form, the whole graph is created at once. |
| `GET`, `PATCH`, `DELETE /api/flows/{id}` | A flow. `GET` includes its `steps`, its `edges`, and `usedIn`, the flows that use it as a subflow. |
| `GET /api/flows/{id}/export` | The flow as a single document, with each step's ID as its `clientId`, in the form taken by `POST /api/flows` and `PUT /api/flows/{id}/steps`. |
| `POST /api/flows/{id}/steps` | Adds a step from `{projectSlug, featureId, note?, actor?, controls?, edge?}`, with `subflowId` in place of `projectSlug` and `featureId` for a subflow, and at most one position (see below). |
| `PATCH`, `DELETE /api/flows/{id}/steps/{stepId}` | A step. `PATCH` keeps the step's position and edges; `branchCondition` sets the label of its incoming edge. `DELETE` takes `mode`: `splice` (the default) joins the neighbouring steps, `subtree` also removes the steps reachable only through it, and `isolate` removes only the step. |
| `POST /api/flows/{id}/steps/{stepId}/move` | Moves a step one place with `dir=-1` or `dir=1`, or to a new position. |
| `PUT /api/flows/{id}/steps` | Replaces the graph with `{steps: [{clientId, …}], edges: [{from, to, …}]}`, and returns `{flow, stepIds}`. |
| `GET /api/flows/{id}/steps/{stepId}/suggestions` | The features linked to the step's feature, as suggested next steps. |
| `PUT`, `DELETE /api/flows/{id}/edges/{fromId}/{toId}` | Creates or partially updates an edge, or deletes it. |
| `GET /api/flows/{id}/findings` | The open findings on the features of the flow. |
| `GET`, `POST /api/flows/{id}/baselines`; `GET /api/flows/{id}/baselines/latest`; `GET`, `DELETE /api/flows/{id}/baselines/{bId}` | The baselines of a flow. `POST` takes `{reviewer?, summary?}`. |
| `GET /api/flows/{id}/delta` | The changes to steps, edges and anchors since the latest baseline, or since `since={bId}`. |
| `GET`, `POST /api/flow-folders`; `PATCH`, `DELETE /api/flow-folders/{id}` | Folders, which can be nested, created from `{name, parentId?}`. `DELETE` returns a preview unless `confirm=true` is given, and then removes the folder, its subfolders and the flows in them. |
| `POST /api/flows/move` | Moves flows and folders with `{flowIds?, folderIds?, targetFolderId}`; `""` is the top level. |
| `GET`, `POST /api/flow-views`; `PATCH`, `DELETE /api/flow-views/{id}` | Saved queries over the list of flows, created from `{name, query?, owner?, isShared?}`. |

**Positioning a step.** A new or moved step takes at most one of the following: `after: <step>`, which places it after that step and gives it that step's outgoing edges; `before: <step>`, which places it before that step and gives it that step's incoming edges; `from: <step>`, which starts a new branch from that step; and `entry: true`, which makes it a new entry point. A step with none of these is appended to the main path. `edge` describes the edge leading into the step. A subflow that is the flow itself, or that contains it, is rejected with `400`.

**Edge fields.** An edge has a `kind` (`next` by default, or `call`, `async`, `read`, `write` or `response`), a `protocol`, a `condition` (the branch label), `auth` (the identity it carries), `trustBoundary`, `data` and `tainted` (whether the data is attacker-controlled), a `description`, a `comment`, `tags`, and a `position` among the edges leaving its step. Two fields are read-only: `zoneBoundary`, which is true when the two steps are in different trust zones, and `linked`, which is true when a feature link corresponds to the edge.
