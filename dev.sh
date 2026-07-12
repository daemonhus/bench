#!/usr/bin/env bash
set -e

REPO="${1:-.}"
cd "$(dirname "$0")"

VITE_PORT=5173

cleanup() {
    echo ""
    echo "Shutting down..."
    [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null
    wait "$VITE_PID" 2>/dev/null
    exit 0
}
trap cleanup EXIT INT TERM

# Kill any stale Vite instances left over from previous runs
lsof -ti ":$VITE_PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true

# Build frontend so backend can embed real dist
npm run build

# Copy built frontend into backend/dist (go:embed can't follow symlinks)
rm -rf backend/dist
cp -r dist backend/dist

# Start Vite dev server in background
npm run dev &
VITE_PID=$!

# Wait for Vite to be ready
echo "Waiting for Vite on :$VITE_PORT..."
for i in $(seq 1 30); do
    curl -s -o /dev/null "http://localhost:$VITE_PORT" && break
    sleep 0.5
done

echo "Starting Go backend (repo=$REPO)..."
echo "  Open http://localhost:$VITE_PORT for hot reload"
echo "  (http://localhost:8081 serves embedded static files - no HMR)"
echo ""

# Resolve repo path to absolute before cd-ing into backend
REPO="$(realpath "$REPO")"

# Start Go backend - blocks until killed
cd backend && go run ./cmd/server -repo "$REPO" --db atomish.db
