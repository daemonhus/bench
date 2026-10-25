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
  <strong>A workbench for code review and long-lived annotations</strong><br/><br/>
</div>

Bench records findings, comments and features against the code they describe and tracks them across commits, so that they remain accurate as the code changes. Baselines record the state of a review at a commit and show what has changed since. One server hosts many repositories, and flows describe a request as it passes through several of them. The CLI and the MCP server provide the same operations as the UI.

## Quick start

Run the server:

```bash
docker run -p 8080:8080 -v /path/to/repos:/repos:ro -v bench-data:/data ghcr.io/daemonhus/bench:latest
```

Open http://localhost:8080 and add a project by giving the path of a git repository inside the container, for example `/repos/api`.

The CLI is available for each platform from [Releases](https://github.com/daemonhus/bench/releases):

```bash
bench projects create --name api --repo-path /repos/api
bench --project api findings list --severity high
```

To connect an MCP client:

```bash
claude mcp add --transport http bench http://localhost:8080/mcp
```

The documentation is at https://daemonhus.github.io/bench/. [DEVELOPMENT.md](DEVELOPMENT.md) describes how to work on bench itself.

## Licence

Bench is licensed under the [Elastic License 2.0](LICENSE). It may be used personally or within an organisation, but it may not be offered to third parties as a hosted or managed service.
