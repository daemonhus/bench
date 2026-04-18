# Keyboard Navigation

Bench is fully keyboard-navigable. Navigation is structured as two independent
layers: **area focus** (which panel is active) and **list navigation** (which
item within the active panel is highlighted).

## Key Bindings Reference

### View switching

| Key | View |
|-----|------|
| `1` | Browse |
| `2` | Changes |
| `3` | Findings |
| `4` | Features |

Pressing a view key switches the view **and** auto-focuses the primary nav area
for that view, so you can immediately use arrow keys without any extra Tab press.
Clicking a tab bar button does the same.

### Area cycling

| Key | Action |
|-----|--------|
| `Tab` | Focus next nav area |
| `Shift+Tab` | Focus previous nav area |

Each view defines a fixed Tab cycle order (see per-view sections below).
Tab works regardless of which child element has focus (buttons, links, etc.)
because it is intercepted globally in capture phase. In single-area views
(Changes), Tab is suppressed.

Tab is **not** intercepted when focus is in an `INPUT`, `TEXTAREA`, or
`contenteditable` element — native Tab behaviour applies there.

### List navigation (within a focused area)

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move focus between items (smooth scroll into view) |
| `Space` | Expand / collapse the focused item |
| `Enter` | Navigate to the item's file location (switches to Browse, focuses codeview) |
| `Escape` | Clear item focus (area focus is retained) |

### File tree (Browse tab)

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move focus between visible nodes (smooth scroll) |
| `→` | Expand focused folder |
| `←` | Collapse focused folder |
| `Space` | Toggle folder expand / collapse |
| `Enter` | Open file (focuses codeview) / open folder (shows in code browser) |
| `Escape` | Clear tree focus |

### Code viewer (Browse tab)

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move line-by-line through the file (highlights focused line) |
| `Enter` | Create a finding at the focused line |
| `Escape` | Clear line focus |

### Sidebar (Browse tab)

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move between annotation cards (scrolls code to annotation) |
| `Space` | Expand / collapse finding card |
| `Enter` | Expand card and focus the reply textarea |
| `Shift+Enter` | Focus codeview at the annotation's line |
| `Escape` | Clear card focus (or blur reply textarea back to sidebar) |

### In-file search

| Key | Action |
|-----|--------|
| `↵` | Next match |
| `Shift+↵` | Previous match |
| `Escape` | Close search bar |

### Global

| Key | Action |
|-----|--------|
| `/` | Focus the search box (Findings / Features tabs) |
| `⌘F` / `Ctrl+F` | Find in file |
| `⌘⇧F` / `Ctrl+Shift+F` | Find in all files |
| `⌘G` / `Ctrl+G` | Go to file |
| `⌥←` / `Alt+←` | Go back |
| `⌥→` / `Alt+→` | Go forward |
| `⌘[` / `Ctrl+[` | Go back |
| `⌘]` / `Ctrl+]` | Go forward |

---

## Architecture

### Data attributes

Navigation is driven by HTML attributes, with no React prop drilling or context:

| Attribute | Purpose |
|-----------|---------|
| `data-nav-area="<name>"` | Marks a focusable container (panel). Must have `tabIndex={0}`. |
| `data-nav-id="<id>"` | Marks a list item within a nav area. Used for scroll-into-view. |
| `data-nav-focused="true"` | Applied to the arrow-key-focused item. Drives the focus ring CSS. |

### `useNavList<T>` hook (`src/core/use-nav-list.ts`)

Encapsulates arrow-key list navigation. Used by FindingsView, FeaturesView,
DeltaView, and Sidebar.

```ts
const { focusedId, containerRef, handleKeyDown } = useNavList({
  items,          // T[]
  getId,          // (item: T) => string
  onSelect,       // Space — toggle expand/collapse
  onActivate,     // Enter — navigate / primary action
  onShiftActivate,// Shift+Enter — secondary action (optional)
  onFocusChange,  // fires whenever arrow-key focus changes
});
```

The hook:
- Maintains `focusedId` (the ID of the arrow-key-highlighted item)
- Clears `focusedId` automatically when the focused item disappears from the
  list (e.g. after a filter change)
- Calls `scrollIntoView({ behavior: 'smooth', block: 'nearest' })` via
  `requestAnimationFrame` whenever focus moves

| Key | Condition | Action |
|-----|-----------|--------|
| `ArrowDown` | — | `moveFocus(index + 1)` |
| `ArrowUp` | — | `moveFocus(index - 1)` |
| `Shift+Enter` | item focused, `onShiftActivate` set | `onShiftActivate(item)` |
| `Shift+Enter` | item focused, no `onShiftActivate` | falls through to `onActivate` |
| `Enter` | item focused | `onActivate(item)` if set, else `onSelect(item)` |
| `Space` | item focused | `onSelect(item)` |
| `Escape` | — | clear `focusedId` |

Keys are ignored when the event target is an `INPUT`, `TEXTAREA`, or
`contenteditable` element. The hook does **not** handle Tab — area cycling is
handled by the global Tab interceptor.

### Global Tab area cycling (`src/App.tsx`)

A single `document`-level `keydown` listener registered in **capture phase**
handles all Tab/Shift+Tab area cycling. Capture phase fires before any
component handler or browser default, ensuring Tab works regardless of which
child element (button, link, span) currently has focus.

```ts
const TAB_CYCLES: Partial<Record<ViewMode, string[]>> = {
  browse:   ['filetree', 'codeview', 'sidebar'],
  delta:    ['delta-header', 'delta-filters', 'delta'],
  findings: ['findings-filter', 'findings-list'],
  features: ['features-tabs', 'features-list', 'features-filter'],
};
```

Handler logic:
1. If `activeElement` is `INPUT` / `TEXTAREA` / `contenteditable` → return
   (native Tab).
2. Find which `[data-nav-area]` contains `activeElement` via `.closest()`.
3. Look up the current view's cycle from `TAB_CYCLES`.
4. Filter to areas currently in the DOM (sidebar may be closed).
5. Single-area views: suppress Tab (prevent default, don't move focus).
6. Multi-area views: compute next/previous index (wrapping), focus the target
   area with `focus({ preventScroll: true })` + smooth `scrollIntoView`.
7. If `activeElement` is not inside any nav area, focus the first area.

No individual component handles Tab — all Tab routing lives in this one place.

### Auto-focus on navigation (`src/App.tsx`, `src/stores/ui-store.ts`)

`pendingNavFocus` is a field in the UI Zustand store. It is set by:
- **View switching** (keys `1`–`4` or tab bar click) — focuses the primary area
  for the target view.
- **`navigateToFile`** (Enter on a finding/feature/delta item) — sets
  `pendingNavFocus` to `'codeview'` so the code viewer is focused after
  switching to Browse.
- **File tree Enter** — sets `pendingNavFocus` to `'codeview'` when opening a
  file or folder from the tree.

A `useEffect` in `App.tsx` consumes `pendingNavFocus`:
- Tries to focus the element synchronously (works when the DOM is already
  rendered, e.g. Browse tab).
- Falls back to a `MutationObserver` that watches for the element to appear
  (handles views that load data asynchronously, e.g. Findings, Changes).

### Codeview line navigation (`src/App.tsx`, `src/stores/ui-store.ts`)

`codeviewFocusedLine` is a field in the UI Zustand store that tracks which line
has keyboard focus (1-indexed, null = none). When the codeview panel is focused:

- **ArrowDown / ArrowUp** — increments/decrements the focused line number, scrolls
  the line into view, and highlights it with the `.codeview-focused-line` class.
- **Enter** — opens the quick-add finding popover anchored to the focused line.
- **Escape** — clears line focus.

The focused line is automatically cleared when the selected file or view changes.

`codeviewSelectAnchor` is set when the user presses Enter on a focused line (Phase 1
of range selection). While set, arrow keys move `codeviewFocusedLine` (the non-anchor
end), and lines in `[anchor, focusedLine]` receive the `.codeview-select-range` class.
A second Enter confirms the range and sets `codeviewTypePick`, which shows the type-
picker pill bar. Escape at either stage cancels back to the previous mode.

`pendingCodeviewLine` is a companion field that survives view transitions. When
`navigateToFile` is called (from Findings/Features/Changes Enter, or content
search), it sets `pendingCodeviewLine` instead of `codeviewFocusedLine` directly.
This avoids a race condition: the clear effect fires on `[selectedFilePath,
viewMode]` and would wipe a directly-set line. `pendingCodeviewLine` is consumed
by the `pendingNavFocus` effect after the clear has run, applying the focused
line once the codeview is rendered.

### Codeview click-to-focus (`src/App.tsx`)

The `<main>` codeview container has an `onClick` handler that calls
`e.currentTarget.focus()` when the click target is a non-interactive element
(not a `BUTTON`, `A`, `INPUT`, or `SELECT`). This ensures clicking on code
lines focuses the codeview container, making Tab cycling work immediately after
a mouse click.

---

## Per-view flows

### Browse tab

```
Tab cycle:  [filetree] → [codeview] → [sidebar]
                 ↑___________________________|
```

- `[filetree]` — `FileTree` component. Arrow keys traverse visible tree nodes.
  `→` / `←` expand and collapse folders. `Space` toggles folder expand/collapse.
  `Enter` on a file opens it and moves focus to codeview. `Enter` on a folder
  opens the folder view in the code browser and moves focus to codeview.
  `Escape` clears the tree focus highlight. The component maintains its own
  `focusedPath` state separate from the selected file, so arrow-key browsing
  does not navigate the code view until `Enter` is pressed.

- `[codeview]` — the code viewer. Receives focus on click, via Tab, or via
  Enter from the file tree / other views. Arrow keys navigate line-by-line with
  a visible blue highlight on the focused line. `Enter` opens the quick-add
  finding popover for the focused line. `Escape` clears line focus. The codeview
  has an inset focus ring (`outline-offset: -2px`) so the `overflow: hidden`
  container does not clip it.

- `[sidebar]` — only present when the sidebar is open. Uses `useNavList` over
  the current file's findings, comments, and features. Arrow keys move between
  annotation cards. `onFocusChange` scrolls the code view to the annotation's
  line range. `Space` expands/collapses a finding card. `Enter` expands the
  card and focuses the reply textarea. `Shift+Enter` focuses the codeview at
  the annotation's line. `Escape` in the textarea blurs back to the sidebar.

### Changes tab (Delta)

```
Tab cycle:  [delta-header] → [delta-filters] → [delta]
                  ↑________________________________|
```

- `[delta-header]` — baseline info bar with edit, set-baseline, and Compare
  buttons. `←` / `→` move between buttons. `Enter` / `Space` activates the
  focused button.
- `[delta-filters]` — activity filter row with kind toggles, severity dropdown,
  actor dropdown, and clear button. `←` / `→` move focus between the interactive
  controls. `Enter` / `Space` activates the focused control (toggles a kind
  filter, opens a dropdown).
- `[delta]` — activity stream. `useNavList` is used with:
  - `onSelect` (Space) — toggles commit-group and merge rows open/closed.
  - `onActivate` (Enter) — navigates to the annotation's file (switches to
    Browse, focuses codeview at the annotation's line via `pendingCodeviewLine`);
    for commit-group items, toggles the group.

### Findings tab

```
Tab cycle:  [findings-filter] → [findings-list]
                  ↑___________________|
```

- `[findings-filter]` — title row with search box, severity filters, and
  open/closed toggle. `←` / `→` move between filter buttons (skips the search
  input). `Enter` / `Space` activates the focused button.
- `[findings-list]` — scrollable card list. `Space` toggles collapse. `Enter`
  expands the focused card in place (show details / linked features).
  `Shift+Enter` navigates to the finding's file location in Browse (focuses
  codeview at the annotation's line via `pendingCodeviewLine`).

### Features tab

```
Tab cycle:  [features-tabs] → [features-list] → [features-filter]
                  ↑___________________________________|
```

- `[features-tabs]` — kind tab bar (All / Interface / Source / ...).
  `←` / `→` switch between tabs.
- `[features-list]` — card list. `Space` toggles collapse (and resets the
  snippet to visible if it was previously collapsed). `Enter` expands the
  focused card in place. `Shift+Enter` navigates to the feature's file
  location in Browse (focuses codeview at the annotation's line).
- `[features-filter]` — search box and sort controls.

---

## Styling

All focus styling is in `src/styles/components.css`.

### Nav area (container)

```css
[data-nav-area]:focus { outline: none; }

[data-nav-area]:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--accent-blue) 35%, transparent);
  outline-offset: 5px;
  border-radius: var(--radius-base);
}
```

Shown on keyboard focus (`:focus-visible`) only, not on mouse click. Low opacity
(35%) reads as a hint.

### Codeview area (container)

```css
[data-nav-area="codeview"]:focus-visible {
  outline: 1.5px solid color-mix(in srgb, var(--accent-blue) 55%, transparent);
  outline-offset: -2px;
}
```

Inset and slightly brighter than other nav areas because the codeview container
has `overflow: hidden` which would clip an outset outline.

### Codeview focused line

```css
.codeview-focused-line {
  background: color-mix(in srgb, var(--accent-blue) 25%, transparent);
  outline: 1.5px solid color-mix(in srgb, var(--accent-blue) 65%, transparent);
  outline-offset: -1px;
  border-radius: 2px;
}
```

Blue tinted background (25%) with a brighter outline (65%) to clearly indicate
which line is selected for annotation.

### List item (arrow-key focus)

```css
[data-nav-focused="true"] {
  outline: 1.5px solid color-mix(in srgb, var(--accent-blue) 65%, transparent);
  outline-offset: 2px;
  border-radius: var(--radius-base);
}
```

Brighter (65%) than the area indicator to distinguish the focused item.

### File tree node focus

```css
.tree-focused {
  outline: 1px solid var(--accent-blue);
  outline-offset: -1px;
}
```

Full-opacity, inset, to match the compact tree layout.

---

## Test coverage

`e2e/keyboard-nav.spec.ts` covers:

- View switching (keys 1–4, click tab button, input guard)
- Browse Tab cycling (filetree → codeview → sidebar, reverse, child button Tab)
- File tree navigation (arrows, expand/collapse with Space, Enter opens file
  and focuses codeview, Escape)
- Findings Tab cycling and list navigation (arrows, Space, Enter→Browse, Escape)
- Features Tab cycling, kind tab arrows, list navigation
- Changes arrow navigation, Space on commit-group, Tab suppression
- Cross-view: Tab from body, Enter navigate + codeview focus, `/` shortcut
- Focus ring CSS assertions

`e2e/keyboard-shortcuts.spec.ts` covers the shortcuts modal (visible, Escape
closes, overlay click closes, `/` shortcut listed).

---

## Known Issues

1. ~~**Browse: focus stuck in file tree.**~~ Fixed — Enter on a file moves
   focus to codeview. Enter on a folder opens it in the code browser.

2. ~~**Browse: folder expand/collapse should use Space, not Enter.**~~ Fixed —
   Space toggles folder expand/collapse. Enter opens files/folders.

3. ~~**Changes: Tab doesn't reach header or filters.**~~ Fixed — split into
   `delta-header` (baseline controls), `delta-filters` (kind toggles,
   severity/actor dropdowns), and `delta` (activity stream) nav areas. Tab
   cycles between all three. Arrow keys navigate within header and filter
   controls.

4. ~~**Findings: can't interact with filters via Enter.**~~ Fixed — added
   arrow-key navigation within `[findings-filter]`. `←` / `→` move between
   buttons, `Enter` / `Space` activates. Input fields (search box) are skipped
   by the arrow handler so typing works normally.

5. ~~**Findings: Enter on card navigates to code instead of comment.**~~ Fixed
   (`src/components/Sidebar.tsx`). Root cause: `onActivate` expanded the card
   and called `setScrollTargetLine(range.start)`, which scrolled the codeview
   to the finding's line — visually indistinguishable from "navigates to
   code". The textarea focus was also racy: the old `requestAnimationFrame`
   ran before React committed the expanded state, so the textarea wasn't in
   the DOM and focus silently fell back to the first button. Fix: removed the
   scroll side-effect from Enter (Shift+Enter still jumps to code), and
   replaced the RAF focus with a `pendingReplyFocusId` ref consumed by a
   `useEffect` on `expandedFindingId`, so the textarea is reliably focused
   once the expanded card renders.

6. **Findings: no keyboard path to the comment input (Findings / Features
   tabs).** Partially fixed. In the Browse sidebar, Enter on a finding card
   focuses the reply textarea and Cmd/Ctrl+Enter submits — this works. But in
   the standalone Findings and Features tabs there is no keyboard path to the
   reply textarea at all, because Enter there navigates to the file instead.
   Decide whether those tabs should (a) expose an inline reply affordance with
   the same Enter / Shift+Enter split as the sidebar, or (b) add a dedicated
   key (e.g. `R`) that opens the reply textarea on the focused card without
   changing the primary Enter behaviour.

7. ~~**Features: Space expand doesn't show code snippet.**~~ Fixed — when a
   feature card is re-expanded via Space, the snippet collapsed state
   (persisted in localStorage) is reset so the code snippet is always visible
   on expand.

8. ~~**Shortcuts modal missing `/` shortcut.**~~ Fixed — added `/` → "Focus
   search box (Findings / Features)" to the Search group in
   `KeyboardShortcutsModal.tsx`.

9. ~~**Navigate-to-file doesn't select the target line.**~~ Fixed — all
   `navigateToFile` paths (Findings Enter, Features Enter, Changes Enter,
   content search Cmd+Shift+F) now set `codeviewFocusedLine` so arrow-key
   navigation starts from the target line instead of line 1. Uses a
   `pendingCodeviewLine` field in the UI store to survive the view-transition
   clear effect — the clear effect (`setCodeviewFocusedLine(null)`) fires on
   `[selectedFilePath, viewMode]` changes and would race against direct sets.
   `pendingCodeviewLine` is consumed by the `pendingNavFocus` effect after the
   clear has run, ensuring the focused line is applied after the codeview
   renders.

10. ~~**Changes: MultiSelectDropdown options not keyboard-navigable.**~~ Fixed
    (`src/components/MultiSelectDropdown.tsx`). The dropdown overlay had no
    `keydown` handler — once open, it was mouse-only. The fix adds a
    `focusedIndex` state (–1 when closed) and routes `keydown` on the trigger
    button through a single handler that is active whether the dropdown is open
    or closed:
    - Trigger closed: `↓`, `Enter`, or `Space` opens the dropdown and sets
      `focusedIndex = 0`.
    - Trigger open / navigating: `↓`/`↑` increment/decrement `focusedIndex`
      (clamped to the option list). `Enter`/`Space` toggles the focused option.
      `Escape` closes without toggling.
    - Mouse hover updates `focusedIndex` so keyboard and mouse stay in sync.
    - The focused option receives a `multi-select-option-focused` class (same
      background as `:hover`) defined in `src/styles/overview.css`.
    - `e.stopPropagation()` is called inside the handler so the `delta-filters`
      area arrow-key handler doesn't also fire while navigating inside the
      dropdown.

11. ~~**Changes: invisible clear button is arrow-key reachable.**~~ Fixed
    (`src/components/DeltaView.tsx`). The `✕` clear button used CSS
    (`opacity: 0; pointer-events: none`) to hide itself when no filter was
    active, but remained in the DOM as a focusable `<button>`, so `←`/`→` in
    the `delta-filters` area could land on it. Two changes:
    1. `disabled={!hasActiveFilter}` is added to the button. A disabled button
       is not focusable via arrow keys.
    2. The `delta-filters` `onKeyDown` selector is updated from
       `'button, select'` to `'button:not([disabled]), select'` so the disabled
       button is excluded from the navigable item list even before the DOM
       updates.

12. ~~**Features: filter area has no arrow-key navigation.**~~ Fixed
    (`src/components/FeaturesView.tsx`). The `[features-filter]` nav area (the
    search box + sort controls row) had `tabIndex={0}` and `data-nav-area` but
    no `onKeyDown` handler, so Tab could land there but arrow keys did nothing.
    Added the same handler pattern used by `findings-filter` and
    `delta-filters`: `←`/`→` walk `button:not([disabled])` descendants,
    `Enter`/`Space` click the focused button, and the handler exits early when
    `e.target` is `INPUT` or `TEXTAREA` so typing in the search box is
    unaffected.

13. ~~**Sidebar: Enter on comment/feature cards has no textarea.**~~ Fixed
    (`src/components/Sidebar.tsx`). The `onActivate` callback in `useNavList`
    always tried to `querySelector('textarea')` inside the focused card and
    called `.focus()` on the result. Finding cards render a reply textarea when
    expanded, so this worked for them, but comment cards (plain `<div>`) and
    feature cards (`FeatureCard`) have no textarea. The fix adds a fallback:
    if `card.querySelector('textarea')` returns `null`, the handler falls
    through to `card.querySelector('button, a, input, [tabindex]')` and focuses
    the first interactive element found. This means Enter on a comment card
    focuses its Edit button, and Enter on a feature card focuses its first
    action button, rather than silently doing nothing.

14. ~~**Sidebar: Tab inside reply textarea goes to submit button.**~~ Fixed
    (`src/components/Sidebar.tsx`). The global Tab area-cycling handler in
    `App.tsx` registers on `document` in capture phase but explicitly returns
    early when `e.target.tagName === 'TEXTAREA'`, so native Tab applies —
    which moves focus to the adjacent submit button (`→`) instead of cycling
    to the next nav area. The fix adds an `onKeyDownCapture` prop on the
    sidebar `<aside>`:
    1. If the key is not Tab or the target is not a TEXTAREA, return immediately.
    2. Call `e.preventDefault()` to block native Tab.
    3. Call `sidebar.focus()` to move focus from the textarea to the sidebar
       container element.
    4. Dispatch a new `KeyboardEvent('keydown', { key: 'Tab', bubbles: true,
       shiftKey })` from the sidebar container. Because the dispatched event's
       target is the sidebar (not a TEXTAREA), the global capture handler
       processes it normally, finds 'sidebar' in the Browse Tab cycle, and
       focuses the next (or previous, for Shift+Tab) nav area.

15. ~~**Codeview: no keyboard line-range selection or annotation type picker.**~~
    Fixed across `src/stores/ui-store.ts`, `src/App.tsx`,
    `src/components/BrowseView.tsx`, `src/components/CodeRow.tsx`, and
    `src/styles/components.css`. Two new store fields drive the flow:
    - `codeviewSelectAnchor: number | null` — set when the user presses Enter
      on a focused line (Phase 1). While non-null, arrow keys still move
      `codeviewFocusedLine` (the non-anchor end of the selection), and
      `BrowseView` passes `isSelectRange={true}` to every `CodeRow` whose line
      number falls within `[min(anchor, focusedLine), max(anchor, focusedLine)]`.
      `CodeRow` renders `.codeview-select-range` (a lighter 12 % blue tint,
      distinct from the 25 % focused-line highlight) for those rows.
    - `codeviewTypePick: { start, end, anchor, current } | null` — set when the
      user presses Enter a second time (Phase 2). This clears `codeviewSelectAnchor`
      and shows a `typepick-pill` bar fixed at the bottom of the viewport. The
      pill lists Finding / Comment / Feature; `←`/`→` change `typePickIndex`
      (local `useState` in `App.tsx`); `Enter`/`Space` opens the existing
      quick-add popover with `kind` and `lineRange` pre-set; `Escape` restores
      `codeviewSelectAnchor` and `codeviewFocusedLine` to their Phase-1 values
      so the user can adjust the range before confirming.

16. ~~**Browse: sidebar (activity panel) shows no focus indicator when Tab
    lands on it.**~~ Fixed (`src/styles/components.css`). Root cause:
    `.sidebar-wrapper` (the grid child that contains the aside) has
    `overflow: hidden` (`sidebar.css:491`). The generic
    `[data-nav-area]:focus-visible` rule uses `outline-offset: 5px` — an
    outset ring — so the left/right/bottom edges were clipped by the wrapper
    and only the top edge around the header survived, reading as "just the
    header is highlighted". Fix mirrors the codeview case: added a
    `[data-nav-area="sidebar"]:focus-visible` rule with an inset outline
    (`outline-offset: -2px`, 55% opacity, 1.5px) so the whole panel reads as
    the focus target and nothing gets clipped.

17. **Browse: folder view in code editor is not arrow-key navigable.** Pressing
    Enter on a folder in the file tree opens a vim-style folder listing in the
    code viewer and moves focus there, but arrow keys do nothing — you can't
    move between entries in the listing to drill in. The codeview arrow-key
    handler assumes file content (line numbers) and has no branch for the
    folder-listing view. Needs a folder-mode handler (↑/↓ between entries,
    Enter to open the highlighted entry).

18. **Changes: delta-header arrow navigation misses "Previous baselines" and
    lacks focus indicator on Compare.** Two issues in the `delta-header` nav
    area:
    1. When a "Previous baselines" button is present, ←/→ arrow navigation
       skips over it — the button is not in the arrow-key walk list (likely a
       selector mismatch or the button renders outside the nav area container).
    2. The Compare button gets keyboard focus but shows no visible focus ring
       or highlight, so there's no feedback that it's the active target before
       you press Enter.
    Fix: verify all header buttons share the `delta-header` container and the
    arrow handler's selector matches them; add a focus-visible style for the
    Compare button (and audit the other header buttons for consistency).

19. **Findings: search input is skipped by arrow keys, and its clear button
    jumps focus away.** Two related issues in `[findings-filter]`:
    1. The search input is intentionally skipped by the ←/→ walk (so typing
       works), but this means there's no keyboard path to the search box from
       within the filter row — the only way in is `/` or a mouse click. The
       arrow handler should include the input as a stop (entering it focuses
       the field for typing) while still not consuming keys while typing.
    2. Pressing the search input's clear (✕) button moves focus to the next
       button in the row instead of returning to the search input. Clear
       should restore focus to the input so the user can keep typing a new
       query.
    Same pattern likely affects Features search; verify.

20. **Features: mouse-clicking expand/collapse drops keyboard context.** After
    arrow-keying to a feature card and then mouse-clicking the expand/collapse
    button (or anywhere outside the card), the nav area loses focus: Space no
    longer toggles the focused card and instead triggers the browser's default
    page-scroll. The click should either restore focus to the `features-list`
    nav area (so `data-nav-focused` and the keyboard handler remain in scope)
    or `useNavList` should not clear `focusedId` when focus moves to an
    interactive child inside the same nav area. Likely applies to Findings
    cards too — verify.

21. ~~**Browse sidebar: expand key and snippet visibility don't match spec.**~~
    Fixed (`src/components/Sidebar.tsx`, `src/components/FeatureCard.tsx`).
    1. Space: the `onSelect` handler in `Sidebar.tsx` only expanded finding
       cards — feature cards silently ignored Space. Extended to also toggle
       expansion on `item.kind === 'feature'`. Findings already worked; if
       Space appeared dead in testing it was likely the separate
       focus-context-loss bug (#20) rather than this handler.
    2. Snippet in Browse mode: `FeatureCard` had no `viewMode` guard on its
       inline snippet (`FindingCard` already had `viewMode !== 'browse'` on
       line 581). Added the same guard to `FeatureCard` so the snippet is
       hidden in Browse (where the codeview shows the same code) and visible
       on the standalone Features tab.

22. ~~**Browse: Tab focus ring only highlights the nav bar, not the content
    area.**~~ Fixed (`src/styles/layout.css`). Root cause: `.app-layout` uses
    CSS Grid with no explicit `grid-template-rows`, so the single implicit row
    track is `auto`-sized — its height equals the tallest grid item's
    *content* height. When a long file is open, that height exceeds the
    viewport. `.main-panel` stretches to fill the row track (correct per CSS
    Grid's default `align-self: stretch`), but its layout height is now taller
    than the viewport. The inset `outline-offset: -2px` ring is drawn relative
    to the element's full layout box, so the bottom of the ring sits below the
    fold — only the top edge (around the toolbar) is visible.
    The fix adds `grid-auto-rows: minmax(0, 1fr)` to `.app-layout`, which
    sizes the implicit row to exactly fill the grid container (the remaining
    viewport height below the tab bar) rather than the content. `align-items:
    stretch` is set explicitly for clarity. `.main-panel` also gets
    `min-height: 0` (prevents flex children from inflating it beyond the row
    track) and `position: relative` (to contain absolutely-positioned overlays
    like the type picker pill).
