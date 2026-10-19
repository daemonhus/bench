#!/usr/bin/env bash
# Build bench binaries into bin/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin"

echo "Building bench CLI..."
go build -o "$BIN/bench" "$ROOT/backend/cmd/cli/"

echo "Building benchd (single-project server)..."
go build -o "$BIN/benchd" "$ROOT/backend/cmd/server/"

echo "Building bench-platform (multi-project server)..."
(cd "$ROOT/platform/backend" && go build -o "$BIN/bench-platform" .)

echo "Done. Binaries in $BIN/"
ls -lh "$BIN/bench" "$BIN/benchd" "$BIN/bench-platform"
