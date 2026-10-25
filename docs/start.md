# Getting started

## Running the server

```bash
docker run -d -p 8080:8080 \
  -v /path/to/repos:/repos:ro \
  -v bench-data:/data \
  ghcr.io/daemonhus/bench:latest
```

Open http://localhost:8080 and add a project by giving the path of a git repository inside the container, for example `/repos/api`. Repositories can be mounted at any path, and bench only reads them.

To build the image from source, run `docker build -t bench .` in the root of the repository.

Bench stores its data in `/data`, which should be a persistent volume. `default.db` holds the projects, flows and settings, and each project has its own `<slug>-<hash>.db`, where the hash is derived from the repository path.

## CLI

Download `bench` for your platform from [Releases](https://github.com/daemonhus/bench/releases) and place it on your `PATH`. The CLI connects to the server given by `--url` or `BENCH_URL`, which defaults to `http://localhost:8080`.

```bash
bench projects create --name api --repo-path /repos/api
bench --project api findings list --severity high     # or set BENCH_PROJECT=api
```

The [CLI reference](/reference/cli) lists every command.

## MCP

```bash
claude mcp add --transport http bench http://localhost:8080/mcp
```

The [MCP reference](/reference/mcp) lists every tool.

## The service profile

Set each project's [service profile](/ui#profile) before recording anything, in the UI under Profile, with `bench profile set`, or with the MCP tool `update_service_profile`. Bench rejects findings, comments, features and baselines until the profile has been saved once. Saving an empty profile is sufficient.
