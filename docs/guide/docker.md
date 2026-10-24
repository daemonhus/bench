# Docker

The image uses the repo root.

## Build and run

To use the latest published image:

```bash
docker pull ghcr.io/daemonhus/bench:latest
docker run -p 8080:8080 \
  -v /path/to/repos:/repos:ro \
  -v bench-data:/data \
  ghcr.io/daemonhus/bench:latest
```

Otherwise to build and run locally

```bash
docker build -t bench .
docker run -p 8080:8080 \
  -v /path/to/repos:/repos:ro \
  -v bench-data:/data \
  bench
```

The server will be at **http://localhost:8080**. Mount the repositories anywhere, then register each one by its path inside the container:

```bash
bench projects create --name api --repo-path /repos/api
```

The container's entrypoint is `benchd`; the default flags are `-data /data -addr :8080`.

## Data layout

The image writes data to `/data` inside the container. Mount a volume there to persist findings, features, comments and baselines across restarts: `default.db` (projects, flows, settings) plus one `<slug>-<hash>.db` per project, the hash taken from its repository path. Older `platform.db` and `<slug>.db` files are renamed on start.
