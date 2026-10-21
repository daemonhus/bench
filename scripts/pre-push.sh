#!/usr/bin/env bash
#
# Pre-push checks: the CI gates that are cheap to run locally, in CI's order.
#
#   npm run verify                  # everything, against this checkout's installed packages
#   scripts/pre-push.sh             # same thing
#   scripts/pre-push.sh --clean     # the same checks in a fresh clone of HEAD, installing from scratch
#
# Mirrors .github/workflows/ci.yml (backend and frontend jobs).
#
# The default run uses the packages already installed here, so it can't tell whether a clean
# install gives the checks what they need (a test importing a package CI hasn't installed yet).
# --clean can: it clones HEAD (committed work only) into a temp directory and runs CI's own
# steps there, read from ci.yml (scripts/ci-local.py): the same installs and checks in the same
# order, so it can't drift from CI. A few minutes slower; run it before a push.
#
# Deliberately NOT run here: the Docker buildx job (multi-arch, minutes long -
# CI covers it) and Playwright e2e (needs browsers and a live backend).
#
# To run on every push:
#   ln -s ../../scripts/pre-push.sh .git/hooks/pre-push
#
set -uo pipefail

cd "$(dirname "$0")/.."

if [ "${1:-}" = "--clean" ]; then
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/bench-verify.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  echo "fresh clone of $(git rev-parse --short HEAD) in $tmp"
  git clone -q --no-hardlinks "$(pwd)" "$tmp/bench" || exit 1
  cd "$tmp/bench" || exit 1
  # CI's own steps (scripts/ci-local.py reads them from ci.yml), installs included, in its order.
  python3 scripts/ci-local.py
  exit $?
fi

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

# The server embeds the UI build from internal/server/dist; the real build is made by the docker job.
go_in_backend() { (cd backend && mkdir -p internal/server/dist && touch internal/server/dist/.gitkeep && "$@"); }

printf '%sbackend%s\n' "$BOLD" "$OFF"
run "go mod tidy -diff"  go_in_backend go mod tidy -diff
run "gofmt"              gofmt_check
run "go vet"             go_in_backend go vet ./...
run "go test"            go_in_backend go test ./...
run "go build"           go_in_backend go build ./...

printf '%sfrontend%s\n' "$BOLD" "$OFF"
run "tsc --noEmit"       npx tsc --noEmit
run "vitest"             npx vitest run
run "platform tsc"       npm --prefix platform/ui run typecheck
run "platform build"     npm --prefix platform/ui run build

if [ ${#FAILED[@]} -gt 0 ]; then
  printf '\n%s%d check(s) failed:%s %s\n' "$RED" "${#FAILED[@]}" "$OFF" "${FAILED[*]}"
  exit 1
fi

printf '\n%sall checks passed%s\n' "$GREEN" "$OFF"
