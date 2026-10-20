# bench e2e

Playwright suites for the workbench UI, run against an **isolated stack** (own ports, a throwaway
data dir with one project, `e2e`, on a throwaway git repo, deterministic seed data) so they never touch a dev server or real data.

```bash
cd bench
npx playwright test -c playwright.e2e.config.ts      # platform UI on Vite (5183 -> 8091, profile gate: 5185 -> 8093)
npx playwright test -c playwright.prod.config.ts     # PRODUCTION platform build embedded in benchd (8095 / 8096)
npx vitest run                                       # unit tests (hooks, nav list, helpers)
```

The prod config runs the *same* suites against the platform UI build embedded in `benchd` (minified, no Vite, no
StrictMode double effects) - the way users run bench. Specs open `/p/e2e#/...` and call `/api/projects/e2e/...` through `appUrl()` / `api()` in `helpers/input.ts`. Both configs should stay green.

## Fixture (`e2e/support/`)
- `fixture-repo.mjs` - deterministic repo: folders to expand, `CLAUDE.md` first in the tree (long, so it scrolls),
  later commits that rewrite part of it (-> an orphaned feature after reconcile).
- `fixture-server.mjs` - builds `benchd`, starts it, registers the `e2e` project, seeds findings/features/comments/refs, a baseline,
  activity after the baseline, then reconciles. `E2E_FRESH=1` = no seed, write gate ON (for `profile.spec.ts`).
  `E2E_PROD=1` = build + embed the platform UI first.

## Conventions
- **Trusted input only** (`page.keyboard`, `page.mouse`). `.focus()` is for *arranging* a starting point, never the
  action under test. Helpers + the `lastInput` probe are in `helpers/input.ts`.
- Assert real state (`document.activeElement`, `:focus-visible`, `aria-*`), not just CSS classes.
- A test that can skip because data is missing is a gap: make the fixture provide the data instead.

## What each spec covers (keyboard <-> mouse chain)
| Spec | Chain |
|---|---|
| `keyboard-nav` | area cycling, tree/list/tab navigation, view keys, focus ring |
| `focus-modality`, `focus-modality-extra` | switching between keyboard and mouse: anchors, rings, stale pending focus, resize handles, quick-add |
| `modals` | every dialog: role/label, focus in, Tab trap, Escape, backdrop, focus return, nested edits |
| `card-actions` | `->` into a card's controls, `<- ->` between them, Esc back (Findings, Features, sidebar) |
| `chrome-nav` | `F6` toolbar: tabs, panel headers, filters, banners, shortcuts button |
| `reachability` | fails if any visible control has no keyboard path (per view) |
| `click-only` | controls that were mouse-only now activate identically from the keyboard; panel toggles hand focus over |
| `multi-select` | menu-button dropdown: open/move/toggle/only/Escape/Tab-away, ARIA |
| `interaction-chains` | go-to-file, find-in-files, go-to-line, commit history, New feature, tag input, profile radios |
| `a11y-scan` | axe-core (structure, names, landmarks; colour contrast excluded) over every view and dialog |
| `selection-toolbar`, `comment-drag`, `diff-render`, `css-fixes-verify`, `profile`, `overview` | existing feature suites, brought up to date |

Two tests skip on macOS only: native `<select>` arrow keys open a popup there (they run on Linux/CI).

## Canvas sizes

`responsive.spec.ts` runs the same checks at mobile (390x844), desktop (1440x900) and ultrawide
(3440x1440): no overflow or clipped controls, no sideways scroll, chrome reachable (the tab strip
scrolls and keeps the active tab in view), banner compact on phones, header/banner aligned to the
page frame (`--page-max` column; Browse/Diff are full-bleed via `data-frame="full"`), touch targets
(>= 24px; tab bar >= 32px), dialogs fit, and the phone Browse drawers (inert when closed, focus in,
Escape/backdrop close, one at a time, closing on file choice).

The behaviour specs (`BEHAVIOUR` in `playwright.e2e.config.ts`) also run in the `ultrawide` and
`phone` projects: `npx playwright test -c playwright.e2e.config.ts --project=phone`. Specs that
write to the shared backend (the link-edit modals) run in `chromium` only, since the projects run
in parallel against one fixture. Styles live in `src/styles/responsive.css` (imported last).
