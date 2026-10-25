# Bench: agent guide

Bench is a code review workbench. It records findings, comments and features against the code they describe, tracks them across commits, and uses baselines to measure the progress of a review. This guide describes how to use bench through the `bench` CLI and the MCP endpoint.

## Setup

Check that bench is running. The following command lists the registered projects:

```bash
bench projects list
```

If bench is not running, start the server with the repository mounted read-only, and register the repository as a project:

```bash
docker run -d -p 8080:8080 -v $(pwd):/repo:ro -v bench:/data ghcr.io/daemonhus/bench:latest
bench projects create --name my-repo --repo-path /repo
```

- **CLI.** Project commands require `--project <slug>` or the `BENCH_PROJECT` variable. `--url` or `BENCH_URL` gives the server address, which defaults to `http://localhost:8080`. `bench <category> --help` describes every command and flag.
- **MCP.** `http://localhost:8080/mcp` serves every project, and its project tools take a `project` argument. `http://localhost:8080/api/projects/<slug>/mcp` serves one project, and its tools do not take that argument. Each tool's schema describes its parameters.
- **Code access.** Read the repository through bench (`bench git read-file`, `search-code`, `list-files`, `blame`, `diff`, `changed-files` and `commits`), not through the file system.

## Review branch

Each project is reviewed on one branch, its review branch, which is the repository's default branch unless another branch has been set. Through the CLI and MCP, the commit history ends at the head of the review branch, and commits default to that head. Lists of findings, comments, features and baselines include only the items anchored on a commit in the branch's history, together with a count of the items left out. Baselines, deltas and summary counts are computed against the branch, and an annotation created without a commit is anchored at its head. MCP tools that depend on the branch take an optional `branch` argument to use another branch, and the list tools take `all_branches: true` to include every branch.

```bash
bench git review-branch                          # show the review branch
bench git set-review-branch --branch fix/login   # change it for everyone; "" selects the default branch
```

The MCP tools are `get_review_branch` and `set_review_branch`.

## Data model

**Anchor.** An anchor records where an annotation is: `{fileId, commitId, lineRange?: {start, end}}`. Always give the commit, because reconciliation follows the code from that commit.

**Finding.** A finding records a vulnerability or another security issue.

| Field | Values |
|---|---|
| `severity` | `critical`, `high`, `medium`, `low`, `info` |
| `status` | `draft`, `open`, `in-progress`, `false-positive`, `accepted`, `closed` |
| `source` | `pentest`, `tool`, `manual`, `mcp` |
| Other fields | `title`, `description`, `cwe` (for example `CWE-89`), `cve`, `vector` (CVSS), `score` (a number), `category`, `features` (linked feature IDs), `refs`, `origin`, `resolvedCommit` |

**Comment.** A comment is a review note with an `author`, `text` and `type`. It can be linked to a finding or a feature, and replies form a thread through `parent`. The types are `concern` (an issue that needs attention but is not a confirmed vulnerability, which would be a finding), `question`, `improvement`, `feature` (a feature request) and the empty type.

**Feature.** A feature records part of the security-relevant surface. It has a `kind` (described below), `title`, `description`, `status` (`draft`, `active`, `deprecated`, `removed` or `orphaned`), `direction` (`in` or `out`), `operation` (an HTTP or RPC method), `protocol`, `tags`, `linkedFeatures` (links in both directions, each `{id, description?}`) and `parameters` (the inputs of an `interface`, each with `name`, `type`, `pattern`, `required` and `description`).

**Origin.** Findings and features can record how they came about: `explanation`, `introducedCommit`, `introducedDate`, `actor` and `branch` (for example `"feature-x -> main"`). An origin is never reconciled.

**Ref.** A ref is a link from a finding, feature or comment to another system. It has a `url`, an optional `title`, and a `provider` (`github`, `gitlab`, `jira`, `confluence`, `linear`, `notion`, `slack` or `url`), which is derived from the URL.

**Baseline.** A baseline records the state of a review at a commit. It holds the IDs of every finding and feature, and counts by severity, status, category and kind on the review branch. A baseline cannot be changed.

**Delta.** A delta lists what has changed since a baseline: `newFindings` and `newFeatures` on the review branch, `removedFindingIds`, and `changedFiles` (each `{path, added, deleted}`) between the baseline's commit and the head of the branch.

**References between projects.** On a server with several projects, a feature in another project is referred to as `<project>:<id>`, for example `api:feat-abc123`.

## Service profile

The service profile records information that the code does not show: exposure, compute, data sensitivity, criticality, tenancy, lifecycle, edge protections, compliance scope, the authentication model, the consumers and the trust zone.

- Read the profile before reviewing. It determines which classes of finding are irrelevant (for example, rate limiting enforced at the gateway, or authentication terminated upstream) and which are more serious (for example, multi-tenancy, personal data, or exposure to the internet). `get_summary` and `get_delta` include the profile.
- An empty field means that the attribute is not configured. It is never evidence that a control is missing. In the multiple-choice fields, `none` states that the control is known to be absent, and it cannot be combined with other values.
- Until the profile has been set once, every create, update and delete of findings, comments, features, refs, baselines and coverage is rejected, with HTTP 412 or an MCP error. Set the attributes that are known; an empty update is sufficient.

```bash
bench profile set --owner platform-team --externally-facing full --data-sensitivity pii \
  --criticality high --tenancy multi-tenant --edge-protections waf,rate-limiting \
  --authentication-model oauth-oidc,gateway-terminated
```

## Classifying features

| Kind | Meaning | Direction |
|---|---|---|
| `interface` | An endpoint, RPC method, WebSocket handler or message consumer that the service exposes. Each method and path is a separate feature. | `in` |
| `source` | A place where the service reads data, such as a database query, cache read, file read, queue poll or configuration fetch. | `in` |
| `sink` | A place where the service writes data, such as a database write, cache write, queue publish, file write or call to an external third party. | `out` |
| `dependency` | A call to another internal service. Each client class or integration point is a separate feature, anchored to the client code. | `out` |
| `externality` | A background job, periodic task, start-up or shutdown hook, or asynchronous side effect that is not triggered by an inbound request. | none |

Apply the following rules:

1. Record each endpoint as a separate feature. `GET` and `POST` on the same path are two features, and the method is recorded in `operation`.
2. Record services, not libraries, as dependencies. Do not create features for packages such as boto3 or fastapi; a concern about a library is a finding.
3. Write specific descriptions that name the class or function, the target, and the code that uses it, for example: "BillingServiceClient. The Order API calls billing-svc /internal/* for charges, refunds and invoices; every checkout handler uses it."
4. Tag interfaces with the owning service and the domain, and tag dependencies with both services and the domain. The tag `zone:<name>` places a feature in a different trust zone from its project.
5. Anchor each feature at its definition: the route decorator, the client class, the query or write call, or the task function.

When the kind is unclear, apply the following distinctions. If an external actor initiates the call, the feature is an `interface`; if the service initiates a read, it is a `source`. A handler is therefore an `interface`, and the database query inside it is a `source`. A call to one of your own services is a `dependency`, and a call to a third party, such as Stripe or another hosted service, is a `sink`. A data store that is both read and written has a `source` and a `sink`, each anchored to its own code. Work triggered by a scheduler or at start-up is an `externality`, and work triggered by an inbound request or webhook is an `interface`.

Use the following titles:

- `interface`: the path without the method, such as `/orders/{id}` or `/livez`.
- `source` and `sink`: a resource URI, such as `postgresql://users_db (read)`, `redis://session-cache (write)`, `s3://audit-logs`, `kafka://app-events` or `https://api.acmepay.example.com`.
- `dependency`: `<Caller> to <service hostname> (<domain>)`, such as `Order API to billing-svc.cluster.local (charges)`.
- `externality`: a description of the task, such as `Cache prune periodic task` or `DB migrations (Alembic)`.

## Linking

Link every finding to the features that it affects, such as the `interface` of an endpoint, the `source` or `sink` of a query, or a `dependency`. An update replaces the existing list of links, and deleting either the finding or the feature removes the link.

```bash
bench findings create --title "SQL injection in user lookup" --severity high --features feat-abc,feat-def
bench findings update --id <id> --features feat-abc
bench features update --id <id> --features "feat-abc|validates the JWT,feat-def"   # links between features, with descriptions
```

Over MCP, `create_finding` and `update_finding` take `features: ["feat-abc"]`, and `create_feature` and `update_feature` take `linked_feature_ids`, which accepts IDs or `{id, description}` objects.

## Workflows

**A review** follows these steps:

```
get_service_profile        read the deployment context; if it is not set, call update_service_profile with what is known
list_baselines             check for a meaningful baseline; if there is none, set one before recording anything
search_code, read_file     read the code through bench
create_finding             record each finding, then call suggest_finding_origin and set_finding_origin
create_feature             record new surfaces, with parameters for interfaces, and their origins
get_delta                  check the progress since the baseline
set_baseline               at each milestone and at the end; ask the user first, because a baseline cannot be changed
```

Record the origin while the code is still being read. The suggestion derives the commit, date, author and merge that introduced the code from blame, and the explanation is most accurate at that point.

**Mapping the attack surface.** Record the interfaces first, from the router, then the sources, the sinks, the dependencies (client classes, not libraries) and the externalities. Write the features of each kind to a JSON file and create them in one batch, rather than creating them one at a time in a loop:

```bash
bench features batch-create --input /tmp/features-interfaces.json
```

**After the code changes.** Run `bench reconcile start`, or the MCP tool `reconcile`, to move the annotations to their new lines. `get_delta` then shows the changed files, after which a baseline can be set.

**Re-anchoring orphaned annotations.** An annotation is orphaned when its code cannot be found, because the code was deleted, changed beyond recognition, or its commit was removed by rewriting history.

```bash
bench findings list --commit HEAD | jq '.[] | select(.confidence == "orphaned")'   # the same for comments
bench features list --status orphaned
bench findings update --id <id> --file <path> --start <n> --end <n> --commit HEAD  # the same for comments and features
bench features update --id <id> --status active                                   # required for features
```

Over MCP, use `list_findings` or `list_comments` with `commit` and `orphaned_only: true`, and `list_features(status: "orphaned")`. A re-anchored annotation has its new position immediately. If the code no longer exists, anchor the annotation to the closest representative code and add a comment that explains the change. `bench reconcile history --type finding --id <id>` shows the positions of an annotation over time.

## Conventions

| Field | Usage |
|---|---|
| `id` | The full ID, or a prefix that matches exactly one item. |
| `commit` | A hash, a ref or `HEAD`. Never send an empty string; omit the field to keep the anchor's commit. |
| `score` | A number, such as `5.3`, not a string. |
| `severity` | `info`, not `informational`. |
| Lists over MCP | JSON arrays, such as `["waf", "rate-limiting"]`. The CLI takes comma-separated values. |
| `linkedFeatures` in responses | Objects; the ID is `linkedFeatures[].id`. |
| `--features` and `--tags` in CLI updates | The given list replaces the existing list. |
| `parameters` | Used on interface features only. |
| Batch input to the CLI | A JSON array, given with `--input <file>` or on standard input. |

Findings created over MCP have `source: mcp` by default, and findings created with the CLI have `source: manual`. Features are created as `active`. Resolved findings are excluded from lists unless requested, with `--resolved` or the MCP argument `resolved: true`, but they are counted in baselines. `get_delta` without a baseline compares the current state with the latest baseline; with a baseline, it compares that baseline with the previous one. Deleting a baseline returns a preview unless `--confirm` or `confirm: true` is given.

## Errors

| Error | Resolution |
|---|---|
| `service profile not configured` | Set the service profile. An empty update is sufficient. |
| `CHECK constraint failed: severity/status/source IN (...)` | Use one of the listed values. |
| `invalid JSON` from the CLI | A field has the wrong type, for example `score` given as a string or `tags` not given as an array. |
| `commitId must be a non-empty string` | Omit `commit` rather than sending `""`. |
| `ancestry check: invalid git ref: ""` during reconciliation | An annotation has no commit. Update it with `--commit <sha>` and reconcile again. |
| `unknown git ref` during reconciliation | The anchor's commit has been removed by rewriting history, and the annotation is orphaned. Re-anchor it. |
| A reconciliation job reports `N of M files failed` | The job's result is valid for the other files, and the failures are listed in its `error`. |
