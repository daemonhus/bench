# Development

One repository: the workbench at the root, and the multi-project platform in `platform/`.

```
backend/            Go: package workbench (library), internal/server + cmd/benchd (the server), cmd/cli
src/                React workbench: viewer, sidebar, stores
e2e/                Playwright suites (dev + production-embedded configs)
docs/               VitePress docs (single- and multi-project reference)
platform/
  ui/               React: shell, project list, flows, settings
  dev.sh            platform: Vite (3000) + Go (8080)
  Dockerfile        platform image (build context: repo root)
bin/build.sh        builds bench (CLI) and benchd into bin/
```

## Quick start

```bash
npm install && ./dev.sh /path/to/repo        # standalone workbench: Vite 5173 + Go 8081
(cd platform/ui && npm install) && ./platform/dev.sh   # platform: Vite 3000 + Go 8080
```

## How platform wraps the workbench

The platform never forks bench code. The UI imports workbench source through the Vite alias `@bench` (`platform/ui/vite.config.ts`, `tsconfig.json`; it resolves to `src/`). Styling comes from bench too: `platform/ui/src/tokens.css` imports `src/styles/tokens.css` and adds only platform-only tokens. The server (`backend/internal/server`) imports `package workbench` from the same Go module.

| Layer | Workbench | Platform |
|---|---|---|
| Go | `package workbench`: `Open()`, `Handler()`, `MCPHandler()` | project CRUD; `/api/projects/{slug}/*` routed to that project's workbench handler |
| UI | `WorkbenchView` with an `apiBase` prop | `PlatformShell` renders `WorkbenchView` with `apiBase=/api/projects/{slug}` |
| CLI | per-project categories against the REST API | same binary: `--project <slug>` prefixes `/api/projects/{slug}`; adds `projects`, `baselines-all`, `flows`, `catalog` |
| MCP | bench tools on `/mcp` | aggregate `/mcp` (bench tools take a `project` param, plus platform tools); per-project `/api/projects/{slug}/mcp` |

### Routes

```
bench-platform (:8080)
├── /api/projects, /api/baselines, /api/settings          server handlers
├── /api/flows*, flow-folders, flow-views, features       flows and the feature catalog
├── /api/projects/{slug}/*   stripped to /api/* and forwarded to the project's workbench Handler()
├── /api/projects/{slug}/mcp per-project MCP (no project param)
└── /mcp                     aggregate MCP

benchd (:8081)
├── /api/*                   workbench REST (git, findings, comments, features, baselines, …)
└── /mcp                     MCP (no project param)
```

## Where new code goes

- **Workbench REST endpoint:** a handler in `backend/internal/api/`, registered in `router.go`. The platform forwards it with no change.
- **Platform REST endpoint:** a handler in `backend/internal/server/`, registered in `registerPlatformRoutes` (`server.go`; folders in `registerFolderRoutes`, `flow_folders.go`). Cross-project routes sit directly under `/api/`; per-project ones under `/api/projects/{slug}/`.
- **Platform MCP tool:** `platformToolDefs()` in `backend/internal/server/mcp.go`.
- **Per-project CLI command:** the declarative command table in `backend/cmd/cli/main.go`; it works against both servers.
- **Multi-project CLI command:** an `mpCmd` in `mpCommands` in `backend/cmd/cli/{projects,flows,folders,catalog}.go`; shared machinery in `multiproject.go`, tests in `multiproject_test.go`. These hit the cross-project `/api/*` routes.

The CLI is an HTTP client only: it never imports `workbench` or `internal/*` or opens a database. Env vars `BENCH_URL` and `BENCH_PROJECT`; flags take precedence.

## Tests

| What | Command |
|---|---|
| Workbench unit | `npx vitest run` |
| Workbench e2e (dev, 3 canvas sizes) | `npx playwright test -c playwright.e2e.config.ts` |
| Workbench e2e (production-embedded) | `npx playwright test -c playwright.prod.config.ts` |
| Platform e2e | `cd platform/ui && npx playwright test` (isolated ports 5184/8092) |
| Go | `(cd backend && go test ./...)` |

The server embeds `backend/internal/server/dist` at compile time; `platform/dev.sh` and the e2e fixture create it.

## Rules

- Don't change `useLayoutEffect` to `useEffect` in `WorkbenchView.tsx` (API base URL injection).
- Don't symlink `dist/`; copy it (`go:embed` can't follow symlinks).
- New bench entry points go in `backend/cmd/`; the root Go package is `package workbench`, not `main`.
- Re-export types through `workbench.go`; the platform can't import `internal/`.
- Colours and sizes come from `src/styles/tokens.css`; don't copy styles into `platform/`.
- There is one CLI, `backend/cmd/cli/`; don't add a second binary.
- The server's `/api/projects/{slug}/*` forwards to workbench handlers, so new bench endpoints need no platform change.
