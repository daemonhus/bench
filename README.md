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
  <strong>A devilishy good workbench for code reviews and long-lived annotations</strong><br/></br>
</div>

The workspace for findings, comments, and features: anchored to their positions and tracked across commits, so they stay accurate as code evolves.

Point-in-time baselines snapshot the state of code and measure progress over time, or since you (or your agent) last looked at the codebase.

Ships with a full-parity CLI and MCP to supercharge reviews.


## Quick Start

```bash
docker run -p 8080:8080 -v /path/to/repos:/repos:ro -v bench-data:/data ghcr.io/daemonhus/bench:latest
```

Open **http://localhost:8080** and add a project (a git repository on the server, e.g. `/repos/api`), or with the CLI below:

```bash
bench projects create --name api --repo-path /repos/api
```

## CLI
To install the CLI (Mac, see Releases for all platforms):

```bash
curl -L https://github.com/daemonhus/bench/releases/latest/download/bench_<version>_darwin_arm64.tar.gz | tar xz
sudo mv bench /usr/local/bin/
```

Project commands take `--project <slug>` (or `BENCH_PROJECT`); `bench projects list` shows the slugs.

```bash
bench --project api findings list --severity high
```

## MCP

All tools are available over Streamable HTTP (JSON-RPC 2.0). `/mcp` covers every project (bench tools take a `project` argument); `/api/projects/<slug>/mcp` serves one project without it:

```bash
claude mcp add --transport http bench http://localhost:8080/mcp
```

## Docker

```bash
docker build -t bench .
docker run -p 8080:8080 -v /path/to/repos:/repos:ro -v bench-data:/data bench
```

The container's entrypoint is `benchd`; the default flags are `-data /data -addr :8080`. Project databases (`platform.db` plus one `<slug>.db` per project) live in `/data`. Repositories are mounted wherever you like and registered by their path inside the container.

## Flows

Flows are feature walkthroughs that span projects: ordered steps that each point at a feature in some project. They live next to the projects in the same UI, and the CLI drives them with `bench flows ...`.

## Development

Install dependencies, and start the server and UI with:

```bash
npm install && (cd platform/ui && npm install)
./platform/dev.sh              # Vite (3000) + benchd (8080)
```

`bin/build.sh` builds `bench` and `benchd`.

## License

[Elastic License 2.0](LICENSE) - free to use personally or within your organisation; you may not offer it as a hosted or managed service to third parties.
