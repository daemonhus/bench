# Docker

The image uses the repo root.

## Build and run

To use the latest published image:

```bash
docker pull ghcr.io/daemonhus/bench:latest
docker run -p 8080:8080 \
  -v /path/to/repo:/repo:ro \
  -v bench-data:/data \
  ghcr.io/daemonhus/bench:latest
```

Otherwise to build and run locally

```bash
docker build -f bench/Dockerfile -t bench .
docker run -p 8080:8080 \
  -v /path/to/repo:/repo:ro \
  -v bench-data:/data \
  bench
```

The server will be at **http://localhost:8080**.

## Data layout

The image writes data to `/data` inside the container. Mount a volume there to persist findings, features, comments, and baselines across restarts.
