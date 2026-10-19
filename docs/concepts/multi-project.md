# Projects & flows

A multi-project server (`bench-platform`) hosts several repositories at once and adds flows on top.

## Projects

A project is a registered git repository with its own review database. Every project gets the full bench API, UI and tool set, scoped by its slug (derived from the name: `Auth Service` → `auth-service`).

Removing a project drops the registration only. The repository and its database stay on disk, so registering it again under the same name brings its findings back.

## Flows

A flow walks through [features](/concepts/features) in order, across any number of projects: a request entering one service, calling another, landing in a datastore.

- **Steps** form a tree. Each step points at one feature on one project. A child step can carry a branch condition (`if user is admin`) to model conditional paths.
- **Links** join two steps of the same flow outside the tree: skipped levels, loops, shared dependencies, or a call from one project's feature into another's. A link has an edge label, an optional comment and tags.
- **Folders** organise flows into a nested tree. A flow lives in at most one folder.
- **Views** are saved, optionally shared, flow list queries (`status:active tag:auth login`).
- **Baselines** snapshot a flow. The delta since a baseline lists added, removed and changed steps and moved anchors.

A flow also aggregates the open findings on its steps' features. A step whose project or feature can no longer be resolved is shown as tombstoned (`project_not_registered`, `feature_not_found` or `fetch_error`) rather than dropped.
