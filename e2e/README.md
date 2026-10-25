# bench end-to-end tests

These Playwright suites test the workbench UI against an isolated stack, which has its own ports, a temporary data directory and fixed seed data, so that the tests never use a development server or real data.

Spec files run in parallel, with one worker per two processor cores and at most six workers; `E2E_WORKERS=1` runs them one at a time. The fixture creates one identical project per worker (`e2e-0`, `e2e-1`, and so on), each with its own temporary git repository, so that one worker never sees another worker's changes.

```bash
cd bench
npx playwright test -c playwright.e2e.config.ts      # platform UI on Vite (5183 to 8091; the profile check uses 5185 to 8093)
npx playwright test -c playwright.prod.config.ts     # production platform build embedded in benchd (8095 and 8096)
npx vitest run                                       # unit tests (hooks, list navigation, helpers)
```

The production configuration runs the same suites against the platform UI build embedded in `benchd`, which is minified, has no Vite, and does not run React's StrictMode double effects; this is how users run bench. Specs open `/p/e2e-N#/...` and call `/api/projects/e2e-N/...`, where N is the worker, through `appUrl()` and `api()` in `helpers/input.ts`, and they never name the project directly. Both configurations must pass.

## Fixture

The fixture is in `e2e/support/`.

- `fixture-repo.mjs` creates a repository with fixed content. It has folders to expand, a long `CLAUDE.md` first in the file tree (so that the code view scrolls), and later commits that rewrite part of that file, which leaves an orphaned feature after reconciliation.
- `fixture-server.mjs` builds and starts `benchd`, registers one project per worker, and creates findings, features, comments, refs, a baseline and activity after the baseline, before reconciling. `E2E_FRESH=1` creates no data and leaves the service profile check enabled, for `profile.spec.ts`. `E2E_PROD=1` builds and embeds the platform UI first.

## Conventions

- Tests use trusted input only (`page.keyboard` and `page.mouse`). `.focus()` is used to set up a starting point, never as the action under test. The helpers and the `lastInput` probe are in `helpers/input.ts`.
- Assertions check the real state (`document.activeElement`, `:focus-visible` and `aria-*` attributes), not only CSS classes.
- A test that can be skipped because data is missing indicates a gap in the fixture, which should provide the data instead.

## Coverage

| Spec | Coverage |
|---|---|
| `keyboard-nav` | Moving between areas; navigation in the tree, lists and tabs; view keys; the focus ring. |
| `focus-modality`, `focus-modality-extra` | Switching between keyboard and mouse: anchors, focus rings, stale pending focus, resize handles and the quick-add buttons. |
| `modals` | Every dialog: role and label, initial focus, the Tab trap, Escape, the backdrop, the return of focus, and nested edits. |
| `card-actions` | Moving into a card's controls with →, between them with ← and →, and back with Escape, on Findings, Features and the sidebar. |
| `chrome-nav` | The toolbar reached with F6: tabs, panel headers, filters, banners and the shortcuts button. |
| `reachability` | Fails if any visible control in a view cannot be reached with the keyboard. |
| `click-only` | Controls behave the same when activated from the keyboard as with the mouse, and panel toggles move the focus. |
| `multi-select` | The menu-button dropdown: opening, moving, toggling, "only", Escape, leaving with Tab, and ARIA attributes. |
| `interaction-chains` | Go to file, find in files, go to line, the commit history, New feature, tag input and the profile options. |
| `a11y-scan` | axe-core checks of structure, names and landmarks (but not colour contrast) on every view and dialog. |
| `review-branch` | The branch selector beside the project name (choosing with the keyboard, saving for the project, the return of focus), Findings, Changes and Browse on the chosen branch, and `?branch=` links. |
| `selection-toolbar`, `comment-drag`, `diff-render`, `css-fixes-verify`, `profile`, `overview` | The corresponding features. |

Two tests are skipped on macOS, because the arrow keys open the native `<select>` popup there. They run on Linux and in CI.

## Window sizes

`responsive.spec.ts` runs the same checks at phone (390×844), desktop (1440×900) and ultrawide (3440×1440) sizes. It checks that no control overflows or is clipped, that the page does not scroll sideways, that the toolbar can be reached (the tab strip scrolls and keeps the active tab in view), that the banner is compact on phones, that the header and banner align with the page column (`--page-max`; Browse and Diff use the full width through `data-frame="full"`), that touch targets are at least 24 pixels (32 pixels in the tab bar), that dialogs fit, and that the phone file drawers in Browse behave correctly (inert when closed, focus moved in, closed by Escape or the backdrop, one open at a time, and closed when a file is chosen).

The behaviour specs (`BEHAVIOUR` in `playwright.e2e.config.ts`) also run in the `ultrawide` and `phone` projects, for example with `npx playwright test -c playwright.e2e.config.ts --project=phone`. Specs that write a lot of data, such as the link-edit dialogs, run in `chromium` only. Under parallel load, tests should wait for the condition that they depend on, such as a card's code snippet that loads late or the view that a key opened, rather than for a fixed time. The responsive styles are in `src/styles/responsive.css`, which is imported last.
