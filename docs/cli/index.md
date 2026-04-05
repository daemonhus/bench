# Bench CLI

Command-line interface to bench. Requires a running `benchd` server; the CLI talks to it over REST.

## Install

**Download a pre-built binary** from [GitHub Releases](https://github.com/daemonhus/bench/releases/latest). Builds are available for Linux, macOS, and Windows (amd64 and arm64).

```bash
# macOS arm64 example - adjust for your platform
curl -L https://github.com/daemonhus/bench/releases/latest/download/bench_<version>_darwin_arm64.tar.gz | tar xz
sudo mv bench /usr/local/bin/
```

**Build from source** (requires Go 1.22+):

```bash
git clone https://github.com/daemonhus/bench
cd bench/backend
go build -o bench ./cmd/cli
sudo mv bench /usr/local/bin/
```

## Quick start

```bash
# Start the server first
benchd --repo /path/to/project --db /path/to/review.db &

# Then use the CLI (defaults to http://localhost:8080)
bench findings list --severity high

# Set a baseline after a review session
bench baselines set --reviewer user --summary "Sprint 12 review"

# See what changed since last baseline
bench baselines delta
```

## Global flags

| Flag | Default | Description |
|------|---------|-------------|
| `--url` | `http://localhost:8080` | Base URL of the bench server |
| `--version` | | Print version and exit |

Global flags go **before** the category and command:

```bash
bench --url http://my-bench-server:8080 findings list
```

You can also set the server URL via the `BENCH_URL` environment variable:

```bash
# Environment variable (persists across commands)
export BENCH_URL=http://docker-host:8080
bench findings list

# Per-command flag
bench --url http://docker-host:8080 findings list
```

The `--url` flag takes precedence over `BENCH_URL`.

## Command structure

```
bench [global-flags] <category> <command> [command-flags]
```

Six categories, mirroring the MCP tool groups:

| Category | Description |
|----------|-------------|
| `git` | Search code, read files, view diffs and history |
| `findings` | Create, query, and resolve vulnerability reports |
| `comments` | Create, query, and resolve code review notes |
| `features` | Annotate architectural features (interfaces, sources, sinks, dependencies, externalities) |
| `baselines` | Set state snapshots and view deltas between sessions |
| `analytics` | Summaries, coverage tracking, finding search |
| `reconcile` | Reconcile annotation positions across commits |

### Discovering commands

```bash
# List all categories
bench --help

# List commands in a category
bench findings --help

# Full help for a command (flags, types, enums, required fields)
bench findings create --help
```

## git

```bash
# Regex search across the repo (uses ERE — alternation, +, ? and grouping work without escaping)
bench git search-code --pattern "password.*=.*['\"]" --ignore-case

# Alternation and grouping
bench git search-code --pattern "exec\(|eval\(" --path "src/"

# Scope to a directory
bench git search-code --pattern "exec\(" --path "src/api/"

# Blame a file
bench git blame --path src/auth/login.go

# Read a file at a specific commit
bench git read-file --path src/auth/login.go --commit abc123

# List files at HEAD
bench git list-files

# Diff two commits
bench git diff --from HEAD~1 --to HEAD --path src/auth/login.go

# Files changed between two commits
bench git changed-files --from HEAD~5 --to HEAD

# Recent commits
bench git commits --limit 20

# Branches
bench git branches
```

## findings

```bash
# Create a finding
bench findings create \
  --file src/api/auth.go \
  --commit HEAD \
  --start 42 \
  --end 48 \
  --severity high \
  --title "SQL injection in login handler" \
  --description "User input concatenated into query at line 45" \
  --cwe CWE-89 \
  --category injection

# List open findings
bench findings list --status open

# Filter by severity
bench findings list --severity critical

# Get full details
bench findings get --id <finding-id>

# Update status
bench findings update --id <finding-id> --status in-progress

# Link to features (replaces full list)
bench findings update --id <finding-id> --features feat-abc123,feat-def456

# Re-anchor to a new location
bench findings update --id <finding-id> --file src/api/newpath.go --commit HEAD --start 10 --end 20

# Resolve a finding (marks it closed at a specific commit)
bench findings resolve --id <finding-id> --commit <fix-commit>

# Full-text search
bench findings search --query "injection" --severity high

# Delete a finding
bench findings delete --id <finding-id>
```

### Batch operations

Batch commands accept JSON from a file or stdin:

```bash
# From a file
bench findings batch-create --input findings.json

# From stdin
cat findings.json | bench findings batch-create

# Generate + pipe in one go
jq '[.[] | {file, commit: "HEAD", severity: "medium", title: .msg, description: .detail}]' \
  scanner-output.json | bench findings batch-create
```

The `--help` for any batch command shows the expected JSON structure:

```bash
bench findings batch-create --help
# Input format (findings):
#   JSON array of objects. Flat anchor fields (file, commit, start, end)
#   are promoted to the nested anchor automatically. IDs are generated if omitted.
#     required: severity, title
#     optional: category, commit, cve, cwe, description, end, file, score, source, start, status, vector
```

## comments

```bash
# Create a comment
bench comments create \
  --author alice \
  --text "This needs a prepared statement" \
  --file src/api/auth.go \
  --commit HEAD \
  --start 42

# List comments for a file
bench comments list --file src/api/auth.go

# Get full details
bench comments get --id <comment-id>

# Update text or author
bench comments update --id <comment-id> --text "Updated note"
bench comments update --id <comment-id> --author bob

# Re-anchor to a new location
bench comments update --id <comment-id> --file src/api/newpath.go --commit HEAD --start 55

# Resolve a comment
bench comments resolve --id <comment-id> --commit <commit>

# Delete a comment
bench comments delete --id <comment-id>

# Batch-create
bench comments batch-create --input comments.json
```

## features

```bash
# List all features
bench features list

# Filter by kind
bench features list --kind interface

# Filter by status
bench features list --kind sink --status active

# Get full details
bench features get --id <feature-id>

# Annotate an interface (title is the endpoint name, not the method; use --operation for that)
bench features create \
  --file src/api/auth.go \
  --commit HEAD \
  --start 12 \
  --end 28 \
  --kind interface \
  --title "Login endpoint" \
  --operation POST \
  --protocol rest \
  --direction in

# Annotate a data sink
bench features create \
  --file src/db/users.go \
  --commit HEAD \
  --start 44 \
  --end 52 \
  --kind sink \
  --title "User record write" \
  --direction out

# Update status or metadata
bench features update --id <feature-id> --status deprecated
bench features update --id <feature-id> --tags auth,session

# Re-anchor to a new location
bench features update --id <feature-id> --file src/api/newpath.go --commit HEAD --start 12 --end 28

# Delete a feature
bench features delete --id <feature-id>

# Batch-create from JSON
cat features.json | bench features batch-create

# List parameters on an interface feature
bench features params-list --feature <feature-id>

# Get a single parameter
bench features params-get --feature <feature-id> --id <param-id>

# Add a parameter
bench features params-create \
  --feature <feature-id> \
  --name user_id \
  --type string \
  --description "Authenticated user ID" \
  --required

# Update a parameter
bench features params-update \
  --feature <feature-id> \
  --id <param-id> \
  --description "Updated note"

# Delete a parameter
bench features params-delete --feature <feature-id> --id <param-id>
```

## baselines

```bash
# Snapshot current state
bench baselines set --reviewer user --summary "Initial review complete"

# After more work, check what changed
bench baselines delta

# Compare a specific baseline against its predecessor
bench baselines delta --id <baseline-id>

# List all baselines
bench baselines list

# Preview deleting a baseline (dry run, default)
bench baselines delete --id <baseline-id>

# Actually delete
bench baselines delete --id <baseline-id> --confirm
```

## analytics

```bash
# Project summary (finding and comment counts)
bench analytics summary

# Mark files as reviewed
bench analytics mark-reviewed --path src/api/auth.go --commit HEAD --reviewer user

# Check coverage - files not yet reviewed
bench analytics coverage --only-unreviewed

# Full text search across findings
bench findings search --query "eval" --severity high
```

## reconcile

When code changes move lines around, reconcile updates finding and comment positions:

```bash
# Reconcile all annotations to HEAD
bench reconcile start

# Check progress
bench reconcile status --job <job-id>

# See how a finding's position has moved
bench reconcile history --id <finding-id> --type finding

# Get the current reconciliation state
bench reconcile head
```

## Relationship to the server

The CLI talks to a running `benchd` server over its REST API. It has no direct database access. Start the server first, then use the CLI against it:

```bash
# Start the server
benchd --repo /code/myapp --db /data/myapp.db &

# CLI talks to the server (default: http://localhost:8080)
bench findings list

# Or point at a remote/Docker instance
bench --url http://docker-host:8080 findings list
```

## Relationship to MCP

Every CLI command maps 1:1 to an MCP tool. The same handler code runs in both paths.

| CLI | MCP tool |
|-----|----------|
| `bench git search-code` | `search_code` |
| `bench findings create` | `create_finding` |
| `bench features create` | `create_feature` |
| `bench baselines delta` | `get_delta` |
| `bench reconcile start` | `reconcile` |
