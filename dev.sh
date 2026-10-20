#!/usr/bin/env bash
# The dev stack (Vite + benchd) lives in platform/dev.sh; this is a shortcut to it.
exec "$(cd "$(dirname "$0")" && pwd)/platform/dev.sh" "$@"
