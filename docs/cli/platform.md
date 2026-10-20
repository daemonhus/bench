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

A flow is a walkthrough across features, possibly on different projects. See [Projects & flows](/concepts/multi-project).

```bash
bench flows list --status active --project api --sort risk
bench flows create --name "Checkout" --folder payments
bench flows get <flow>

# Steps are features on some project; --parent and --condition model branches
bench flows add-step <flow> --project api --feature <feature-id>
bench flows add-step <flow> --project web --feature <feature-id> --parent <step> --condition "if admin"
bench flows update-step <flow> <step> --note "checks session" --condition "if admin"
bench flows move-step <flow> <step> down
bench flows remove-step <flow> <step>
bench flows set-steps <flow> --input steps.json    # replace the whole tree ({steps, links})

# Links join two steps of the same flow, across projects if needed
bench flows set-link <flow> <from> <to> --description "calls" --tags auth
bench flows delete-link <flow> <from> <to>

bench flows findings <flow>      # open findings on the flow's features
bench flows facets               # status/tag/project/owner values with counts
```

A link to the same step, or to a step from another flow, is rejected.

### baseline and delta

```bash
bench flows baseline set <flow> --reviewer alice --summary "Q1 walkthrough"
bench flows baseline list <flow>
bench flows delta <flow>         # added, removed, changed steps and moved anchors since the latest baseline
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
