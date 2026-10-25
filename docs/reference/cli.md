# CLI

`bench` is a client for the server's REST API. Builds for Linux, macOS and Windows, on amd64 and arm64, are available from [Releases](https://github.com/daemonhus/bench/releases). To build it from source, run `go build -o bench ./cmd/cli` in `backend/`.

```
bench [global flags] <category> <command> [flags]
```

| Global flag | Env | |
|---|---|---|
| `--url` | `BENCH_URL` | The server address. The default is `http://localhost:8080`. |
| `--project` | `BENCH_PROJECT` | The project slug, required by the project categories. `bench projects list` shows the slugs. |
| `--version` | | Prints the version. |

Global flags are given before the category. `bench --help`, `bench <category> --help` and `bench <category> <command> --help` list every command and flag, with each flag's type, its allowed values, and whether it is required.

## Categories

| Project | |
|---|---|
| `git` | `search-code`, `read-file`, `list-files`, `blame`, `diff`, `changed-files`, `commits`, `branches`, `review-branch`, `set-review-branch` |
| `findings` | `list`, `get`, `create`, `update`, `delete`, `resolve`, `search`, `batch-create`, `suggest-origin`, `set-origin`, `clear-origin` |
| `comments` | `list`, `get`, `create`, `update`, `delete`, `resolve`, `batch-create` |
| `features` | `list`, `get`, `create`, `update`, `delete`, `batch-create`, origins as for findings, `params-list`, `params-get`, `params-create`, `params-update`, `params-delete` |
| `refs` | `list`, `get`, `create`, `update`, `delete`, `batch-create` |
| `baselines` | `set`, `list`, `delta`, `delete` |
| `analytics` | `summary`, `coverage`, `mark-reviewed` |
| `reconcile` | `start`, `status`, `head`, `history` |
| `profile` | `get`, `set` |

| Server-wide | |
|---|---|
| `projects` | `list`, `create`, `update`, `delete` |
| `baselines-all` | `list`, which shows the latest baseline of each project |
| `catalog` | `search` and `get`, for features in all projects |
| `flows` | flows, with their steps, edges, baselines, folders and views |
| `map` | `show`, which prints the service map |

A command that takes a commit and is given none uses the head of the project's [review branch](/concepts/review-branch). Batch commands read a JSON array from `--input <file>` or from standard input, and their `--help` lists the fields. Commands that take an ID also accept a prefix that matches exactly one item. Setting a list, such as `--features` or `--tags`, replaces the existing list.

## Examples

```bash
# Code
bench git search-code --pattern "exec\(|eval\(" --path src/     # RE2; --ignore-case, --fixed
bench git read-file --path src/auth/login.go --commit abc123
bench git diff --from HEAD~1 --to HEAD --path src/auth/login.go

# Findings and comments
bench findings create --file src/api/auth.go --commit HEAD --start 42 --end 48 \
  --severity high --title "SQL injection" --cwe CWE-89 --features feat-abc
bench findings list --severity critical --status open              # --resolved to include resolved
bench findings resolve --id <id> --commit <fix>
bench comments create --author alice --text "Needs a prepared statement" --file src/api/auth.go --commit HEAD --start 42

# Features
bench features create --file src/api/auth.go --commit HEAD --start 12 --end 28 \
  --kind interface --title /login --operation POST --protocol rest --direction in
bench features params-create --feature <id> --name user_id --type string --required
jq '[.[] | {file, commit: "HEAD", kind: "sink", title: .uri}]' sinks.json | bench features batch-create

# Review state
bench profile set --externally-facing full --data-sensitivity pii --tenancy multi-tenant
bench baselines set --reviewer alice --summary "Auth module done"
bench baselines delta
bench analytics coverage --only-unreviewed
bench reconcile start
```

## Projects

```bash
bench projects create --name "Auth Service" --repo-path /repos/auth    # slug: auth-service
bench projects update auth-service --name Auth --repo-path /repos/auth2
bench projects delete auth-service     # removes the registration; the repository and database remain
bench catalog search login --kind interface --projects api,web
bench catalog get api:feat-123 web:feat-456
```

## Flows

A flow follows a request through features in any number of projects, as steps joined by typed edges. [Projects & flows](/concepts/multi-project) describes the model.

```bash
bench flows create --name Checkout --folder payments
bench flows list --status active --project api --sort risk

# Steps: each refers to a feature in a project; without a position, a step is appended to the main path
bench flows add-step <flow> --project web --feature <id> --actor anonymous
bench flows add-step <flow> --project api --feature <id> \
  --kind call --protocol http --auth user --trust-boundary true --data credentials --tainted true
bench flows add-step <flow> --project api --feature <id> --after <step>          # insert
bench flows add-step <flow> --project api --feature <id> --from <step> --condition "if admin"   # branch
bench flows add-step <flow> --project api --feature <id> --entry                  # another entry point
bench flows add-step <flow> --subflow <other-flow> --after <step>                  # a flow as one step
bench flows suggest <flow> <step>         # suggested next steps: the features linked to this step's feature
bench flows update-step <flow> <step> --note "checks session" --controls authn:jwt,authz:rbac
bench flows move-step <flow> <step> up
bench flows remove-step <flow> <step>     # joins the neighbouring steps; --mode subtree also removes its branch

# Edges: the kinds are next (the default), call, async, read, write and response
bench flows set-edge <flow> <from> <to> --kind async --protocol kafka --description "order placed"
bench flows delete-edge <flow> <from> <to>

# The graph as a single document
bench flows export <flow> > checkout.json
bench flows set-steps <flow> --input checkout.json
bench flows import --input checkout.json --name "Checkout v2"

bench flows findings <flow>               # open findings on the flow's features
bench flows baseline set <flow> --reviewer alice
bench flows delta <flow>                  # steps, edges and anchors changed since the baseline

# Folders: given by ID or by path (auth/login); / is the top level
bench flows folders create auth/login
bench flows move <flow> --folder auth
bench flows folders delete auth --confirm  # without --confirm, shows what would be deleted

bench flows views create --name "Active auth" --query "status:active tag:auth"
bench map show
```
