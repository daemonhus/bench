#!/usr/bin/env bash
# Build bench binaries into bin/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin"

echo "Building bench CLI..."
go build -C "$ROOT/backend" -o "$BIN/bench" ./cmd/cli/

echo "Building benchd (server)..."
go build -C "$ROOT/backend" -o "$BIN/benchd" ./cmd/benchd/

echo "Done. Binaries in $BIN/"
ls -lh "$BIN/bench" "$BIN/benchd"
