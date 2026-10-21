# Projects & flows

The server (`benchd`) hosts several repositories at once and adds flows on top.

## Projects

A project is a registered git repository with its own review database. Every project gets the full bench API, UI and tool set, scoped by its slug (derived from the name: `Auth Service` → `auth-service`).

Removing a project drops the registration only. The repository and its database stay on disk, so registering it again under the same name brings its findings back.

## Flows

A flow follows a request through [features](/concepts/features) across any number of projects: a request entering one service, calling another, landing in a datastore. It is a graph:

- **Steps** each point at one feature on one project, with a note, the **actor** at that point (`anonymous`, `user`, `service:billing`) and the **controls** applied there (`authn:jwt`, `authz:rbac`, `validation`).
- **Edges** join steps. Each is one hop: its **kind** (`next`, `call`, `async`, `read`, `write`, `response`), protocol, the **condition** under which it is taken, the identity it carries (**auth**), whether it crosses a **trust boundary**, the **data** it carries and whether that is attacker-controlled (**tainted**), plus a label, comment and tags.
- A step with no edge into it is an **entry point**; several edges out of a step are **branches**, in order; several into one are a **join**; edges back are **loops**.

The flow page shows the graph as an outline (a path continues down the page, branches indent under the step they leave, joins and loops are listed under their step) and as a map. You can insert a step between two others, remove one from the middle (the steps around it are joined up), move a step along its path or to another branch, point a step at a different feature, and connect any two steps.

The **service map** (rail → Map) draws every project as a service with its features, and the connections between them that flows record: each edge whose two steps are on different projects. Filter it by service, connection kind and feature kind; choose which features and fields each service shows.
- **Folders** organise flows into a nested tree. A flow lives in at most one folder.
- **Views** are saved, optionally shared, flow list queries (`status:active tag:auth login`).
- **Baselines** snapshot a flow. The delta since a baseline lists added, removed and changed steps and edges, and moved anchors.

A flow also aggregates the open findings on its steps' features. A step whose project or feature can no longer be resolved is shown as tombstoned (`project_not_registered`, `feature_not_found` or `fetch_error`) rather than dropped.
