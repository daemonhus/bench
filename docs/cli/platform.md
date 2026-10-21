# Projects & flows CLI

Project categories (git, findings, comments, features, refs, baselines, analytics, reconcile, profile) need a project slug; the server-wide categories below (`projects`, `baselines-all`, `flows`, `catalog`) don't.

## Global flags

| Flag | Default | Env var | Description |
|------|---------|---------|-------------|
| `--url` | `http://localhost:8080` | `BENCH_URL` | Server URL |
| `--project` | | `BENCH_PROJECT` | Project slug; required by the project categories |

```bash
bench --project auth-service findings list --severity high

export BENCH_PROJECT=auth-service
bench git search-code --pattern "TODO"
```

Every command from the [CLI reference](/cli/) works this way. Without a project, a project command exits with an error that lists the available slugs.

## projects

```bash
bench projects list
bench projects create --name "Auth Service" --repo-path /path/to/repo   # slug: auth-service
bench projects update auth-service --name "Auth" --repo-path /new/path
bench projects delete auth-service
```

Deleting a project removes only its registration; the repository and its review database stay on disk.

## baselines-all

```bash
bench baselines-all list    # latest baseline of every project
```

## catalog

Search and resolve features across every project.

```bash
bench catalog search login --kind interface --projects api,web
bench catalog get api:feat-123 web:feat-456    # slug:feature-id; missing ones come back tombstoned
```

## flows

A flow is a request journey across features, possibly on different projects: steps joined by typed edges. See [Projects & flows](/concepts/multi-project).

```bash
bench flows list --status active --project api --sort risk
bench flows create --name "Checkout" --folder payments
bench flows get <flow>

# Each step is a feature on some project. Without a place it is appended to the main path.
bench flows add-step <flow> --project web --feature <feature-id> --actor anonymous
bench flows add-step <flow> --project api --feature <feature-id> \
  --kind call --protocol http --auth user --trust-boundary true --data "credentials" --tainted true
bench flows add-step <flow> --project api --feature <feature-id> --after <step>      # insert
bench flows add-step <flow> --project api --feature <feature-id> --from <step> --condition "if admin"   # branch
bench flows add-step <flow> --project api --feature <feature-id> --entry              # another entry point

bench flows update-step <flow> <step> --note "checks session" --controls authn:jwt,authz:rbac
bench flows update-step <flow> <step> --feature <other-feature> --project api   # same place, other feature
bench flows move-step <flow> <step> up                  # along the path, or among sibling branches
bench flows move-step <flow> <step> --from <step>       # re-parent as a branch of another step
bench flows remove-step <flow> <step>                   # the steps around it are joined up
bench flows remove-step <flow> <step> --mode subtree    # and the steps only reachable through it

# Edges: what each hop is. Join steps, loop back, or describe an existing hop.
bench flows set-edge <flow> <from> <to> --kind async --protocol kafka --description "order placed"
bench flows delete-edge <flow> <from> <to>

# The whole graph as one document
bench flows export <flow> > checkout.json
bench flows set-steps <flow> --input checkout.json   # replace the graph (export, edit, set-steps)
bench flows import --input checkout.json --name "Checkout v2"

bench flows findings <flow>      # open findings on the flow's features
bench flows facets               # status/tag/project/owner values with counts
```

An edge from a step to itself, or to a step of another flow, is rejected. Edge kinds are `next` (default), `call`, `async`, `read`, `write` and `response`.

## map

```bash
bench map                # services, their features, and the connections flows record between them
bench map show --archived
```

### baseline and delta

```bash
bench flows baseline set <flow> --reviewer alice --summary "Q1 walkthrough"
bench flows baseline list <flow>
bench flows delta <flow>         # added, removed, changed steps and edges, and moved anchors, since the latest baseline
```

### folders

A `<folder>` is a folder id or a path of names (`auth/login`); `/` or `root` is the top level.

```bash
bench flows folders list --tree
bench flows folders create auth/login       # creates missing parents too
bench flows folders rename auth/login sign-in
bench flows folders move auth/sign-in /
bench flows folders delete auth             # dry run: shows what would go
bench flows folders delete auth --confirm   # deletes subfolders and every flow in them

bench flows list --folder auth              # direct flows only
bench flows move <flow> <flow> --folder auth
```

### views

Saved flow list queries, shown in the Flows sidebar.

```bash
bench flows views create --name "Active auth" --query "status:active tag:auth"
bench flows views list
```

Run `bench flows <command> --help` for every flag.
