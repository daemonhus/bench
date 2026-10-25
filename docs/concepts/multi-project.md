# Projects & flows

The server, `benchd`, hosts several repositories at once. Flows describe a request as it passes through several of them.

## Projects

A project is a registered git repository with its own review database. Each project has the complete bench API, UI and set of tools, identified by its slug. The slug is derived from the name; for example, `Auth Service` becomes `auth-service`.

Removing a project removes only its registration. The repository and its database remain on disk, so registering the same repository under the same name restores its review.

## Activity

**Activity**, in the side rail, lists what has happened in every project, most recent first and grouped by day. It lists each finding and feature when it is recorded, and each open finding when it passes its deadline (7 days for critical, 30 for high, 90 for medium and 180 for low). Each item shows the severity and status, the start of the description, the features that a finding affects or the flows that include a feature, and the most recent comment. The feed can be filtered by kind, project, severity and period, and searched. The filters are stored in the address, for example `/activity?kinds=finding,sla&severity=critical,high&since=7d`, so that a filtered feed can be linked to.

## Flows

A flow follows a request through [features](/concepts/features) in any number of projects, for example a request that enters one service, calls another, and is written to a data store. A flow is a graph of steps and edges.

- A **step** refers to one feature in one project. It has a note, the **actor** at that point (such as `anonymous`, `user` or `service:billing`) and the **controls** applied there (such as `authn:jwt`, `authz:rbac` or `validation`). A step can instead be a **subflow**, which includes another flow as a single step, so that a path shared by several flows is defined once.
- An **edge** joins two steps and describes one hop. It has a **kind** (`next`, `call`, `async`, `read`, `write` or `response`), a protocol, the **condition** under which it is taken, the identity that it carries (**auth**), whether it crosses a **trust boundary**, the **data** that it carries and whether that data is attacker-controlled (**tainted**), and a label, comment and tags.
- A step with no incoming edge is an **entry point**. Several edges leaving one step are **branches**, in order. Several edges arriving at one step form a **join**, and an edge back to an earlier step forms a **loop**.

The flow page shows the graph as an outline and as a map. In the outline, a path continues down the page, branches are indented under the step that they leave, and joins and loops are listed under their step. A step can be inserted between two others, removed from the middle of a path (in which case the steps on either side are joined), moved along its path or to another branch, or pointed at a different feature, and any two steps can be connected. When a step is added after another, the features [linked](/concepts/features) to that step's feature are offered first, because the links record what the feature calls.

### Subflows

Selecting **Flows** in the step picker adds a whole flow as one step. The step shows the flow's name and number of steps, and opens that flow, and the flow lists the flows that use it. The steps of a subflow remain in their own flow, with their own edges and baselines, so a change to the shared path applies everywhere the subflow is used. A flow cannot contain itself, directly or through its subflows, and such a step is rejected. If the flow that a step refers to is deleted, the step is marked as tombstoned (`flow_not_found`).

### Trust zones

Each project's service profile can name a trust zone, such as `public-edge`, `core`, `pci` or `third-party`. A hop between two features in different zones crosses a trust boundary without being marked by hand; this is shown as `zoneBoundary` on the edge, on the flow page, in the connection panel and on the service map. A feature tagged `zone:<name>` belongs to that zone instead of its project's zone, which is useful for a gateway or for a handler that runs elsewhere. The `trustBoundary` field remains available for boundaries that the zones do not show.

### Feature links on flows

Flow edges and [feature links](/concepts/features) describe the same calls, so each is checked against the other. An edge between two features that are not linked in either direction has `linked: false`. On the flow page, such a hop between projects is marked **unlinked**, and its connection panel can link the two features. The service map draws feature links that no flow covers as dashed lines, so that dependencies not yet described by a flow are visible.

Flows can also be organised and tracked:

- **Folders** organise flows in a tree. A flow is in at most one folder.
- **Views** are saved queries over the list of flows, such as `status:active tag:auth login`, and can be shared.
- **Baselines** record the state of a flow. The delta since a baseline lists the steps and edges added, removed and changed, and the anchors that have moved.

A flow lists the open findings on the features of its steps. A step whose project or feature cannot be found is marked as tombstoned (`project_not_registered`, `feature_not_found` or `fetch_error`) and is not removed.

## Service map

The **service map**, in the side rail, draws each project as a service with its features and trust zone. It shows the connections between services that flows record (each edge whose two steps are in different projects) and the feature links that no flow covers. Connected services are placed together, ordered from left to right in the direction of their connections, and the remaining services are placed in a grid around them. Each service lists up to twelve features, with connected features, search matches and features with open findings first, and the remainder are summarised as **+N more**. The map can be filtered by service, connection kind and feature kind, and the features and fields shown for each service can be chosen. Selecting a feature, service or connection shows a preview with its details, place in the code, open findings, connections and flows, each of which links to its page.
