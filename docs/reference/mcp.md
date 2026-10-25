# MCP

Bench serves its tools over the [Model Context Protocol](https://modelcontextprotocol.io) (Streamable HTTP, JSON-RPC 2.0).

```bash
claude mcp add --transport http bench http://localhost:8080/mcp
```

| Endpoint | Scope |
|---|---|
| `/mcp` | All projects. The project tools take a `project` argument (the project's slug), and the server-wide tools are also available. |
| `/api/projects/{slug}/mcp` | One project. The project tools are available without the `project` argument. |

Each tool describes its parameters in its schema, returned by `tools/list`. The schemas are the reference for parameter names, types and allowed values.

## Conventions

- An agent should call `get_service_profile` first, because the profile determines which classes of finding are irrelevant and which are more serious. Until the profile has been set, every write to findings, comments, features, refs and baselines, and every call to `mark_reviewed`, is rejected. `update_service_profile` is always allowed, and an empty update is sufficient. `get_summary` and `get_delta` include the profile.
- `get_review_branch` and `set_review_branch` read and set the project's [review branch](/concepts/review-branch), and the other tools use it. Commits default to the head of the review branch. Lists, baselines, deltas and the counts of `get_summary` include only what is on the branch, and a list that leaves items out states how many. Tools that depend on the branch take an optional `branch` argument to use another branch, and the list tools take `all_branches: true` to include every branch.
- Lists are JSON arrays, such as `features: ["feat-1"]` or `edge_protections: ["waf"]`, and not comma-separated strings.
- An ID can be given as a prefix that matches exactly one item.
- Deleting a baseline, a flow or a folder returns a preview unless `confirm: true` is given.

## Project tools

| Group | Tools |
|---|---|
| git | `search_code`, `read_file`, `read_files`, `list_files`, `get_blame`, `get_diff`, `list_changed_files`, `list_commits`, `list_branches`, `get_review_branch`, `set_review_branch` |
| findings | `list_findings`, `get_finding`, `create_finding`, `update_finding`, `delete_finding`, `resolve_finding`, `search_findings`, `batch_create_findings`, `suggest_finding_origin`, `set_finding_origin`, `clear_finding_origin` |
| comments | `list_comments`, `get_comment`, `create_comment`, `update_comment`, `delete_comment`, `resolve_comment`, `batch_create_comments` |
| features | `list_features`, `get_feature`, `create_feature`, `update_feature`, `delete_feature`, `batch_create_features`, `suggest_feature_origin`, `set_feature_origin`, `clear_feature_origin`, `list_feature_parameters`, `get_feature_parameter`, `create_feature_parameter`, `update_feature_parameter`, `delete_feature_parameter` |
| refs | `list_refs`, `get_ref`, `create_ref`, `update_ref`, `delete_ref`, `batch_create_refs` |
| baselines | `set_baseline`, `list_baselines`, `get_delta`, `delete_baseline` |
| analytics | `get_summary`, `get_coverage`, `mark_reviewed` |
| reconcile | `reconcile`, `get_reconciliation_status`, `get_annotation_history` |
| profile | `get_service_profile`, `update_service_profile` |

Annotations take the anchor as separate arguments: `file`, `commit`, `start` and `end`. When `list_findings` or `list_comments` is given a `commit`, each item includes its position and `confidence` at that commit, and `orphaned_only: true` returns only the orphaned items. A finding is linked to features with `features`, and a feature is linked to other features with `linked_feature_ids`, which takes IDs or `{id, project?, description?}` objects. A feature in another project is written `<project>:<id>`.

## Server-wide tools

These tools are available on `/mcp` only. [Projects & flows](/concepts/multi-project) describes the model.

| Tools | Notes |
|---|---|
| `list_projects`, `create_project`, `update_project`, `delete_project` | `create_project {name, repoPath}` also takes a first baseline. `delete_project` removes only the registration. |
| `list_all_baselines` | The recent baselines of every project. |
| `search_features`, `get_features` | Features in all projects. `get_features` takes `refs` as `{project_slug, feature_id}` objects or `"slug:id"` strings, and returns features that cannot be found as `tombstoned`. |
| `get_service_map` | The services, their features and trust zones, the connections recorded by flows, and the feature links. |
| `flows_list`, `flows_list_facets`, `flows_get`, `flows_create`, `flows_update`, `flows_delete` | `flows_create` accepts a complete graph as `steps` and `edges`, in the form returned by `flows_export`. |
| `flows_add_step`, `flows_update_step`, `flows_move_step`, `flows_remove_step`, `flows_suggest_next` | A step refers to a feature (`project_slug` and `feature_id`) or to a flow (`subflow_id`). Its position is given by one of `after`, `before`, `from` and `entry`; by default it is appended to the main path. |
| `flows_set_edge`, `flows_delete_edge` | An edge has a `kind` (`next`, `call`, `async`, `read`, `write` or `response`), `protocol`, `condition`, `auth`, `trust_boundary`, `data`, `tainted`, `description`, `comment`, `tags` and `position`. |
| `flows_export`, `flows_set_steps` | Export the graph as a single document, and replace the graph. |
| `flows_set_baseline`, `flows_list_baselines`, `flows_get_baseline`, `flows_get_delta`, `flows_delete_baseline` | Baselines of a flow. The delta lists the steps and edges that have changed and the anchors that have moved. |
| `flows_list_findings` | The open findings on the features of the flow. |
| `flows_list_folders`, `flows_create_folder`, `flows_update_folder`, `flows_delete_folder`, `flows_move` | Folders, which can be nested. |
| `flows_list_views`, `flows_create_view`, `flows_update_view`, `flows_delete_view` | Saved queries over the list of flows, such as `status:active project:api login`. |
