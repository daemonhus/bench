<h1 align="center">
| ▔▔▔ |
</h1>

<p align="center">
  <a href="https://www.elastic.co/licensing/elastic-license">
    <img alt="Elastic License 2.0" src="https://img.shields.io/badge/license-Elastic%20License%202.0-red.svg">
  </a>
  <a href="https://github.com/daemonhus/bench/actions/workflows/ci.yml">
    <img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/daemonhus/bench/ci.yml?branch=main&label=CI">
  </a>
  <a href="https://github.com/daemonhus/bench/actions/workflows/docs.yml">
    <img alt="Docs status" src="https://img.shields.io/github/actions/workflow/status/daemonhus/bench/docs.yml?branch=main&label=Docs">
  </a>
  <a href="https://github.com/daemonhus/bench/releases">
    <img alt="Latest release" src="https://img.shields.io/github/v/release/daemonhus/bench?include_prereleases&label=Release">
  </a>
</p>

<div align="center">
<strong>A devilishy good workbench for code reviews and long-lived annotations</strong><br/>

The workspace for findings, comments, and features: anchored to their positions and tracked across commits, so they stay accurate as the code evolves.<br/>
Point-in-time baselines snapshot the state of code and measure progress over time, or since you (or your agent) last looked at the codebase.<br/>
Ships with a full-parity CLI and MCP to supercharge reviews.
</div>


## Quick Start

```bash
docker run -p 8080:8080 -v /path/to/repo:/repo:ro -v bench-data:/data ghcr.io/daemonhus/bench:latest
```

Open **http://localhost:8080**.

## CLI
To install the CLI (Mac, see Releases for all platforms):

```bash
curl -L https://github.com/daemonhus/bench/releases/latest/download/bench_<version>_darwin_arm64.tar.gz | tar xz
sudo mv bench /usr/local/bin/
```

## MCP

All tools are available over Streamable HTTP (JSON-RPC 2.0):

```bash
claude mcp add --transport http bench http://localhost:8080/mcp
```

## Docker

```bash
docker build -f Dockerfile -t bench ..   # context is repo root (needs shared/)
docker run -p 8080:8080 -v /path/to/repo:/repo:ro -v bench-data:/data bench
```

The container's entrypoint is `benchd`. The default flags are `-repo /repo -db /data/bench.db`. You can override them by appending flags directly - do **not** repeat the binary name:

```bash
# Default: mounts repo at /repo, project name shows as "repo"
docker run -p 8080:8080 -v /path/to/repo:/repo:ro -v bench-data:/data bench

# Named project: mount at a path whose last component is the project name
docker run -p 8080:8080 \
  -v /path/to/project:/project:ro \
  -v bench-data:/data \
  ghcr.io/daemonhus/bench:latest \
  -repo /project -db /data/bench.db
```

The project name shown in the UI is derived from the last component of the `-repo` path, so `/project` → **project**.

## Development

Install dependencies, and start the server with:

```bash
npm install
./dev.sh /path/to/git/repo    # starts Vite (5173) + Go backend (8080)
```

## License

[Elastic License 2.0](LICENSE) - free to use personally or within your organisation; you may not offer it as a hosted or managed service to third parties.
