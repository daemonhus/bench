#!/usr/bin/env bash
set -e

PLATFORM_DIR="$(cd "$(dirname "$0")" && pwd)"

# Kill anything already on our ports
lsof -ti :3000 -ti :8080 2>/dev/null | xargs kill 2>/dev/null || true

cleanup() {
    echo ""
    echo "Shutting down..."
    [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null
    wait "$VITE_PID" 2>/dev/null
    exit 0
}
trap cleanup EXIT INT TERM

# Build frontend so backend can embed real dist
(cd "$PLATFORM_DIR/ui" && npm run build)

# Copy built frontend into the server's embed dir (go:embed can't follow symlinks)
EMBED_DIR="$PLATFORM_DIR/../backend/internal/server/dist"
rm -rf "$EMBED_DIR"
cp -r "$PLATFORM_DIR/ui/dist" "$EMBED_DIR"
touch "$EMBED_DIR/.gitkeep"

# Databases (default.db plus one <slug>-<hash>.db per project)
DATA_DIR="${BENCH_DATA:-$PLATFORM_DIR/backend}"
mkdir -p "$DATA_DIR"

# Start Vite dev server in background
(cd "$PLATFORM_DIR/ui" && npm run dev) &
VITE_PID=$!

# Wait for Vite to be ready
echo "Waiting for Vite on :3000..."
for i in $(seq 1 30); do
    curl -s -o /dev/null http://localhost:3000 && break
    sleep 0.5
done

echo "Starting platform backend..."
echo "  Frontend: http://localhost:3000 (Vite, proxies /api -> :8080)"
echo "  Backend:  http://localhost:8080"
echo ""

# Start Go backend — blocks until killed
cd "$PLATFORM_DIR/../backend" && go run ./cmd/benchd -data "$DATA_DIR" -addr :8080
