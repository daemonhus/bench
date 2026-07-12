#!/usr/bin/env bash
#
# Pre-push checks: the CI gates that are cheap to run locally, in CI's order.
#
#   npm run verify          # everything
#   scripts/pre-push.sh     # same thing
#
# Mirrors .github/workflows/ci.yml (backend + frontend jobs), plus a frontend
# typecheck: CI runs only `npm test`, so `tsc` is currently unguarded there and
# a type error would first surface in the release build.
#
# Deliberately NOT run here: the Docker buildx job (multi-arch, minutes long -
# CI covers it) and Playwright e2e (needs browsers and a live backend).
#
# To run on every push:
#   ln -s ../../scripts/pre-push.sh .git/hooks/pre-push
#
set -uo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
FAILED=()

run() {
  local name="$1"; shift
  local start out status
  start=$(date +%s)
  out="$("$@" 2>&1)"; status=$?
  local elapsed=$(( $(date +%s) - start ))

  if [ $status -eq 0 ]; then
    printf '%s✓%s %-28s %s%ss%s\n' "$GREEN" "$OFF" "$name" "$DIM" "$elapsed" "$OFF"
  else
    printf '%s✗%s %-28s %s%ss%s\n' "$RED" "$OFF" "$name" "$DIM" "$elapsed" "$OFF"
    [ -n "$out" ] && printf '%s\n' "$out" | sed 's/^/    /'
    FAILED+=("$name")
  fi
}

# gofmt exits 0 whether or not it finds anything; the file list is the verdict.
gofmt_check() {
  local unformatted
  unformatted="$(gofmt -l ./backend)"
  if [ -n "$unformatted" ]; then
    echo "These files need gofmt:"
    echo "$unformatted"
    return 1
  fi
}

go_in_backend() { (cd backend && "$@"); }

printf '%sbackend%s\n' "$BOLD" "$OFF"
run "go mod tidy -diff"  go_in_backend go mod tidy -diff
run "gofmt"              gofmt_check
run "go vet"             go_in_backend go vet ./...
run "go test"            go_in_backend go test ./...
run "go build"           go_in_backend go build ./...

printf '%sfrontend%s\n' "$BOLD" "$OFF"
run "tsc --noEmit"       npx tsc --noEmit
run "vitest"             npx vitest run

if [ ${#FAILED[@]} -gt 0 ]; then
  printf '\n%s%d check(s) failed:%s %s\n' "$RED" "${#FAILED[@]}" "$OFF" "${FAILED[*]}"
  exit 1
fi

printf '\n%sall checks passed%s\n' "$GREEN" "$OFF"
