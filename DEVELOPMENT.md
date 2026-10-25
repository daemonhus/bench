# Development

This repository contains the workbench library (`backend/` and `src/`) and the server and UI that host it (`backend/internal/server` and `platform/ui`).

```
backend/            Go module: package workbench (the library), internal/server and cmd/benchd (the server), cmd/cli
src/                React workbench library: viewer, sidebar and stores, hosted by platform/ui
e2e/                Playwright suites for the workbench (development and production configurations)
docs/               VitePress documentation
platform/
  ui/               React application: shell, projects, activity, flows and service map
  dev.sh            development stack: Vite on port 3000 and benchd on port 8080
Dockerfile          the image: platform UI and benchd, built from the repository root
```

## Quick start

```bash
npm install && (cd platform/ui && npm install)
./platform/dev.sh        # Vite on 3000 and benchd on 8080; databases in platform/backend/ (BENCH_DATA overrides this)
```

The prerequisites are Go 1.24 or later, Node 20 or later, and git. `bin/build.sh` builds `bench` (the CLI) and `benchd` into `bin/`.

## How the server hosts the workbench

The UI does not copy workbench code. It imports the workbench source through the Vite alias `@bench`, which resolves to `src/` and is defined in `platform/ui/vite.config.ts` and `tsconfig.json`. The styles also come from the workbench: `platform/ui/src/tokens.css` imports `src/styles/tokens.css` and adds only the tokens that the platform needs. The server, in `backend/internal/server`, imports `package workbench` from the same Go module.

| Layer | Workbench library | Server and UI |
|---|---|---|
| Go | `package workbench`, with `Open()`, `Handler()` and `MCPHandler()`. | Project management, and routing of `/api/projects/{slug}/*` to the project's workbench handler. |
| UI | `WorkbenchView`, with an `apiBase` property. | `PlatformShell` renders `WorkbenchView` with `apiBase=/api/projects/{slug}`. |
| CLI | Project categories, which call the REST API. | `--project <slug>` is required, and prefixes requests with `/api/projects/{slug}`. `projects`, `baselines-all`, `flows` and `catalog` are server-wide. |
| MCP | The workbench tools. | `/mcp` serves all projects, with a `project` argument on the workbench tools and the flow tools in addition. `/api/projects/{slug}/mcp` serves one project. |

### Routes

```
benchd (:8080)
├── /api/projects, /api/baselines, /api/settings          server handlers
├── /api/flows*, flow-folders, flow-views, features       flows and the feature catalogue
├── /api/service-map                                      the service map
├── /api/projects/{slug}/*   rewritten to /api/* and passed to the project's workbench Handler()
├── /api/projects/{slug}/mcp MCP for one project, without the project argument
├── /mcp                     MCP for all projects
└── /                        the embedded UI
```

## Where new code goes

- **A workbench REST endpoint** is a handler in `backend/internal/api/`, registered in `router.go`. The server passes it through without changes.
- **A server REST endpoint** is a handler in `backend/internal/server/`, registered in `registerPlatformRoutes` in `server.go`; folder routes are registered in `registerFolderRoutes` in `flow_folders.go`. Routes that span projects are directly under `/api/`, and routes for one project are under `/api/projects/{slug}/`.
- **A server MCP tool** is defined in `platformToolDefs()` in `backend/internal/server/mcp.go`.
- **A project CLI command** is an entry in the command table in `backend/cmd/cli/main.go`.
- **A server-wide CLI command** is an `mpCmd` in `mpCommands`, in `backend/cmd/cli/projects.go`, `flows.go`, `folders.go` or `catalog.go`. The shared code is in `multiproject.go`, and the tests are in `multiproject_test.go`. These commands call the server-wide `/api/*` routes.

The CLI is only an HTTP client. It does not import `workbench` or `internal/*`, and it does not open a database. It reads `BENCH_URL` and `BENCH_PROJECT`, and flags take precedence over them.

## State in the address

Every page that filters, sorts or searches, or that has display options, stores that state in the URL, so that a view can be linked to, bookmarked, reloaded and revisited with Back. The state is declared once with `useQueryState` from `src/core/query-state.ts`, in place of `useState`:

```ts
const MAP_QUERY: QuerySchema<MapQuery> = {
  q: qp.string('q'),
  hiddenServices: qp.list('hide').remembered(),
  scope: qp.oneOf('show', ['connected', 'flows', 'all'], 'flows').remembered(),
};
const [state, setState] = useQueryState(MAP_QUERY, pathQuery('/map'), { key: 'service-map-query' });
```

- Platform pages place the query after the path (`pathQuery('/map')` gives `/map?hide=beta`), and workbench views place it after the hash route (`hashQuery('/findings')` gives `#/findings?severity=high`).
- Values equal to their default are omitted. Lists are comma-separated, and an empty list that is present means that nothing is selected.
- A change replaces the current history entry, and Back and Forward are followed.
- `.remembered()` or `.remembered('session')` also stores a field in browser storage. The stored value is used when the address contains none of the page's parameters; an address that contains any of them is taken as the complete state.
- Schemas and locations are module constants. Parameters that a page does not own, such as the shell's `?folder=`, are left unchanged.

The pages that use it are Activity, Map, Flows, Projects, and the workbench's Browse, Findings, Features and Changes (`#/delta`). The shell routes Search (`/search?q=&kind=&project=`) with the same parameter names.

## Tests

| Suite | Command |
|---|---|
| Workbench unit tests | `npx vitest run` |
| Workbench end-to-end tests, development build, three window sizes | `npx playwright test -c playwright.e2e.config.ts` |
| Workbench end-to-end tests, production build served by benchd | `npx playwright test -c playwright.prod.config.ts` |
| Platform end-to-end tests, on ports 5184 and 8092 | `cd platform/ui && npx playwright test` |
| Go | `(cd backend && go test ./...)` |
| Documentation build, which fails on a broken link | `cd docs && npm install && npm run build` |
| The CI steps in a clean clone of HEAD, run before a push | `npm run verify:clean` |

The server embeds `backend/internal/server/dist` at compile time. `platform/dev.sh` and the end-to-end fixture create it.

## Rules

- Do not change `useLayoutEffect` to `useEffect` in `WorkbenchView.tsx`; the API base URL must be set before the first request.
- Do not symlink `dist/`; copy it, because `go:embed` does not follow symbolic links.
- Put new workbench entry points in `backend/cmd/`. The root Go package is `package workbench`, not `main`.
- Re-export types through `workbench.go`, because code outside `backend/` cannot import `internal/`.
- Take colours and sizes from `src/styles/tokens.css`, and do not copy styles into `platform/`.
- Keep the single CLI in `backend/cmd/cli/`, and do not add a second binary.
- New workbench endpoints need no server change, because the server passes `/api/projects/{slug}/*` to the workbench handlers.
