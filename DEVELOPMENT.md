# Development

One repository: the workbench library (`backend/`, `src/`) and the server and UI that host it (`backend/internal/server`, `platform/ui`).

```
backend/            Go module: package workbench (library), internal/server + cmd/benchd (the server), cmd/cli
src/                React workbench library: viewer, sidebar, stores (hosted by platform/ui)
e2e/                Playwright suites for the workbench (dev + production-embedded configs)
docs/               VitePress docs
platform/
  ui/               React app: shell, project list, flows, settings
  dev.sh            dev stack: Vite (3000) + benchd (8080)
bin/build.sh        builds bench (CLI) and benchd into bin/
Dockerfile          the image: platform UI + benchd (build context: repo root)
```

## Quick start

```bash
npm install && (cd platform/ui && npm install)
./platform/dev.sh        # Vite 3000 + benchd 8080; databases in platform/backend/ (BENCH_DATA overrides)
```

## How the server wraps the workbench

The UI never forks bench code. It imports workbench source through the Vite alias `@bench` (`platform/ui/vite.config.ts`, `tsconfig.json`; it resolves to `src/`). Styling comes from bench too: `platform/ui/src/tokens.css` imports `src/styles/tokens.css` and adds only platform-only tokens. The server (`backend/internal/server`) imports `package workbench` from the same Go module.

| Layer | Workbench library | Server / UI |
|---|---|---|
| Go | `package workbench`: `Open()`, `Handler()`, `MCPHandler()` | project CRUD; `/api/projects/{slug}/*` routed to that project's workbench handler |
| UI | `WorkbenchView` with an `apiBase` prop | `PlatformShell` renders `WorkbenchView` with `apiBase=/api/projects/{slug}` |
| CLI | project categories against the REST API | `--project <slug>` (required) prefixes `/api/projects/{slug}`; `projects`, `baselines-all`, `flows`, `catalog` are server-wide |
| MCP | bench tools | aggregate `/mcp` (bench tools take a `project` param, plus flow tools); per-project `/api/projects/{slug}/mcp` |

### Routes

```
benchd (:8080)
├── /api/projects, /api/baselines, /api/settings          server handlers
├── /api/flows*, flow-folders, flow-views, features       flows and the feature catalog
├── /api/projects/{slug}/*   stripped to /api/* and forwarded to the project's workbench Handler()
├── /api/projects/{slug}/mcp per-project MCP (no project param)
├── /mcp                     aggregate MCP
└── /                        the embedded UI
```

## Where new code goes

- **Workbench REST endpoint:** a handler in `backend/internal/api/`, registered in `router.go`. The platform forwards it with no change.
- **Platform REST endpoint:** a handler in `backend/internal/server/`, registered in `registerPlatformRoutes` (`server.go`; folders in `registerFolderRoutes`, `flow_folders.go`). Cross-project routes sit directly under `/api/`; per-project ones under `/api/projects/{slug}/`.
- **Platform MCP tool:** `platformToolDefs()` in `backend/internal/server/mcp.go`.
- **Per-project CLI command:** the declarative command table in `backend/cmd/cli/main.go`.
- **Multi-project CLI command:** an `mpCmd` in `mpCommands` in `backend/cmd/cli/{projects,flows,folders,catalog}.go`; shared machinery in `multiproject.go`, tests in `multiproject_test.go`. These hit the cross-project `/api/*` routes.

The CLI is an HTTP client only: it never imports `workbench` or `internal/*` or opens a database. Env vars `BENCH_URL` and `BENCH_PROJECT`; flags take precedence.

## Filters, options and searches live in the address

Any page that filters, sorts, searches or offers display options keeps that state in the URL, so a view can be linked, bookmarked, reloaded and stepped through with Back. Declare it once with `useQueryState` from `src/core/query-state.ts` instead of `useState`:

```ts
const MAP_QUERY: QuerySchema<MapQuery> = {
  q: qp.string('q'),
  hiddenServices: qp.list('hide').remembered(),
  scope: qp.oneOf('show', ['connected', 'flows', 'all'], 'flows').remembered(),
};
const [state, setState] = useQueryState(MAP_QUERY, pathQuery('/map'), { key: 'service-map-query' });
```

- Platform pages put the query after the path (`pathQuery('/map')` → `/map?hide=beta`); workbench views after the hash route (`hashQuery('/findings')` → `#/findings?severity=high`).
- Values at their default are left out; lists are comma-separated, and a present but empty list means none.
- Changes replace the history entry; Back and Forward are followed.
- `.remembered()` (or `.remembered('session')`) also keeps a field in browser storage, used when the address names none of the page's parameters. An address that names any is taken as the whole state.
- Keep schemas and locations as module constants. Parameters a page doesn't own (the shell's `?folder=`) are left alone.

Pages using it: Activity, Map, Flows, Projects, and the workbench's Findings, Features and Changes (`#/delta`). Search (`/search?q=&kind=&project=`) is routed by the shell with the same names.

## Tests

| What | Command |
|---|---|
| Workbench unit | `npx vitest run` |
| Workbench e2e (dev, 3 canvas sizes; platform UI on Vite) | `npx playwright test -c playwright.e2e.config.ts` |
| Workbench e2e (production-embedded, served by benchd) | `npx playwright test -c playwright.prod.config.ts` |
| Platform e2e | `cd platform/ui && npx playwright test` (isolated ports 5184/8092) |
| Go | `(cd backend && go test ./...)` |
| CI's steps in a fresh clone of HEAD (run before a push) | `npm run verify:clean` |

The server embeds `backend/internal/server/dist` at compile time; `platform/dev.sh` and the e2e fixture create it.

## Rules

- Don't change `useLayoutEffect` to `useEffect` in `WorkbenchView.tsx` (API base URL injection).
- Don't symlink `dist/`; copy it (`go:embed` can't follow symlinks).
- New bench entry points go in `backend/cmd/`; the root Go package is `package workbench`, not `main`.
- Re-export types through `workbench.go`; code outside `backend/` can't import `internal/`.
- Colours and sizes come from `src/styles/tokens.css`; don't copy styles into `platform/`.
- There is one CLI, `backend/cmd/cli/`; don't add a second binary.
- The server's `/api/projects/{slug}/*` forwards to workbench handlers, so new bench endpoints need no server change.
