# Quickstart

## Docker

The quickest way to run bench:

```bash
docker run -d \
  -p 8080:8080 \
  -v /path/to/repos:/repos:ro \
  -v bench-data:/data \
  ghcr.io/daemonhus/bench:latest
```

Open **http://localhost:8080** and add a project: a git repository, given by its path inside the container. Or from the CLI:

```bash
bench projects create --name api --repo-path /repos/api
```

## CLI

Install the `bench` CLI ([install options](/cli/#install)); it talks to the running server. Project commands take `--project` (or `BENCH_PROJECT`):

```bash
bench projects list
bench --project api findings list --severity high
```

## MCP

Register bench as an MCP server with Claude:

```bash
claude mcp add --transport http bench http://localhost:8080/mcp
```

See [MCP overview](/mcp/) for the full tool list. Several projects share one server, and [flows](/concepts/multi-project) span them.

## Development

**Prerequisites:** Go 1.24+, Node 20+, git

```bash
cd bench
npm install && (cd platform/ui && npm install)
./platform/dev.sh
```

Open **http://localhost:3000** (Vite dev server with HMR, proxying to `benchd` on `:8080`). Project databases go to `platform/backend/`; set `BENCH_DATA` to use another directory.
