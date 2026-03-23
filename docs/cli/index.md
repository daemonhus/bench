# Bench CLI

Command-line interface to the bench bench. Every MCP tool is available as a CLI command - same behaviour, same data, no running server required.

## Install

**Download a pre-built binary** from [GitHub Releases](https://github.com/daemonhus/bench/releases/latest). Builds are available for Linux, macOS, and Windows (amd64 and arm64).

```bash
# macOS arm64 example — adjust for your platform
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
# Point at any git repository
bench --repo /path/to/project git search-code --pattern "eval("

# List findings (uses current directory by default)
bench findings list --severity high

# Set a baseline after a review session
bench baselines set --reviewer user --summary "Sprint 12 review"

# See what changed since last baseline
bench baselines delta
```

## Global flags

| Flag | Default | Description |
|------|---------|-------------|
| `--repo` | `.` | Path to the git repository |
| `--db` | `bench.db` | Path to the SQLite database file |
| `--version` | | Print version and exit |

Global flags go **before** the category and command:

```bash
bench --repo /path/to/repo --db /path/to/review.db findings list
```

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
# Regex search across the repo
bench git search-code --pattern "password.*=.*['\"]" --case-insensitive

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
  --file-id src/api/auth.go \
  --commit-id HEAD \
  --line-start 42 \
  --line-end 48 \
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
#   JSON array of objects. Each object supports:
#     required: commit, description, file, severity, title
#     optional: category, cve, cwe, external_id, line_end, line_start, status
```

## comments

```bash
# Create a comment
bench comments create \
  --author alice \
  --text "This needs a prepared statement" \
  --file-id src/api/auth.go \
  --commit-id HEAD \
  --line-start 42

# List comments for a file
bench comments list --file-id src/api/auth.go

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

# Annotate an interface
bench features create \
  --file-id src/api/auth.go \
  --commit-id HEAD \
  --line-start 12 \
  --line-end 28 \
  --kind interface \
  --title "POST /login" \
  --operation POST \
  --protocol rest \
  --direction in

# Annotate a data sink
bench features create \
  --file-id src/db/users.go \
  --commit-id HEAD \
  --line-start 44 \
  --line-end 52 \
  --kind sink \
  --title "User record write" \
  --direction out

# Update status
bench features update --id <feature-id> --status deprecated

# Delete a feature
bench features delete --id <feature-id>

# Batch-create from JSON
cat features.json | bench features batch-create
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

# Delete a baseline
bench baselines delete --id <baseline-id>
```

## analytics

```bash
# Project summary (finding and comment counts)
bench analytics summary

# Mark files as reviewed
bench analytics mark-reviewed --path src/api/auth.go --commit HEAD --reviewer user

# Check coverage -files not yet reviewed
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
bench reconcile status --job-id <job-id>

# See how a finding's position has moved
bench reconcile history --id <finding-id> --type finding

# Get the current reconciliation state
bench reconcile head
```

## Shared database

The CLI and server (and MCP) all use the same SQLite database:

```bash
# Server running on port 8080, reviewing project at /code/myapp
bench-srv --repo /code/myapp --db /data/myapp.db --addr :8080 &

# CLI reads and writes to the same db
bench --repo /code/myapp --db /data/myapp.db findings list
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
