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

Install the `bench` CLI to run commands without a server:

```bash
go install github.com/daemonhus/bench/backend/cmd/bench@latest
```

```bash
bench --repo /path/to/project findings list --severity high
```

## MCP

Register bench as an MCP server with Claude:

```bash
claude mcp add --transport http bench http://localhost:8080/mcp
```

See [MCP overview](/mcp/) for the full tool list.

## Development

**Prerequisites:** Go 1.23+, Node 20+, git

```bash
cd bench
npm install
./dev.sh /path/to/git/repo
```

Open **http://localhost:5173** (Vite dev server with HMR).

The backend listens on `:8080` and serves the REST API, MCP endpoint, and embedded SPA.
