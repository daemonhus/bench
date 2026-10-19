# Quickstart

## Docker

The quickest way to run bench against a local repo:

```bash
docker run -d \
  -p 8080:8080 \
  -v /path/to/git/repo:/repo \
  -v bench-data:/data \
  ghcr.io/daemonhus/bench:latest
```

Open **http://localhost:8080**.

## CLI

Install the `bench` CLI ([install options](/cli/#install)); it talks to the running server:

```bash
bench findings list --severity high
```

## MCP

Register bench as an MCP server with Claude:

```bash
claude mcp add --transport http bench http://localhost:8080/mcp
```

See [MCP overview](/mcp/) for the full tool list.

## Multiple projects

`bench-platform` hosts several repositories behind one UI, and adds [flows](/concepts/multi-project) across them:

```bash
docker build -f platform/Dockerfile -t bench-platform .
docker run -d -p 8080:8080 -v /path/to/repos:/repos:ro -v bench-platform-data:/data bench-platform

bench projects create --name api --repo-path /repos/api
bench --project api findings list
```

See [multi-project CLI](/cli/platform) and [MCP](/mcp/#multi-project-server).

## Development

**Prerequisites:** Go 1.24+, Node 20+, git

```bash
cd bench
npm install
./dev.sh /path/to/git/repo
```

Open **http://localhost:5173** (Vite dev server with HMR).

The backend listens on `:8081` and serves the REST API, MCP endpoint, and embedded SPA.

For the multi-project server: `(cd platform/ui && npm install) && ./platform/dev.sh` (Vite on `:3000`, backend on `:8080`).
