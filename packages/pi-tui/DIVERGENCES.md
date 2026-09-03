# pi-tui divergence ledger (Earendil v0.84.4 baseline)

Source of record for every local divergence from the pinned upstream baseline.
Read this file before editing `packages/pi-tui/src`; re-verify every entry on
each re-vendor (see `UPSTREAM.json` for the pinned baseline).

## Baseline

- Upstream: `earendil-works/pi`, package `packages/tui`
- Tag: `v0.84.4`, commit `b79e4cc834970cca69daebffab7df1da7d1e52c4`
- Previous baseline (history): kimi-code fork snapshot `44a6c70e` (v0.84.3),
  vendored at the initial scaffold (`54d6c22`, 2026-08). A 2026-08-22 sync
  audit (`d8b11ca`) pruned eight old-ledger entries that were part of the
  kimi snapshot itself, not XMoon changes. With the Earendil v0.84.4
  baseline those kimi-code behaviors are divergences again where the host
  still depends on them; they are re-entered below with their real
  provenance (X029–X032).

## Categories

- `HARD_HOST_API` — public seam the dsh-pi-tui host (root bundle) consumes; removing it breaks the host contract.
- `PUBLIC_COMPONENT_CONTRACT` — public component behavior the host's extension surface relies on.
- `LOCAL_UX` — host-facing UX behavior.
- `BUGFIX_MISSING_UPSTREAM` — a real bugfix upstream has not absorbed.
- `PERF_HOST_DEPENDENT` — performance divergence the host's render
  architecture is built around; dropping it is a measurable regression
  even though nothing fails functionally.
- `PACKAGING` — package/build shell owned by XMoon.
- `ABSORBED_UPSTREAM` — upstream now provides an equivalent; do NOT re-apply.
- `STALE_LEDGER` — ledger entry that no longer matches reality; fixed in place.
- `REMOVED_UNUSED` — old kimi-only or defective divergence; do NOT re-apply
  (used by X003 and the removal notes).

## Machine gate (do not skip)

`pnpm gate:pi-vendor-diff` (scripts/pi-vendor-diff-gate.mjs) verifies the
local `src/` against the PINNED upstream blobs (UPSTREAM.json) and the
machine-readable manifest `vendor-divergences.json` (id → files, mirroring
the `Files:` lines below; entries whose divergence was REMOVED/ABSORBED are
intentionally absent — their files must match upstream):

- FAIL — a local src file differs from the pinned upstream blob (or does
  not exist upstream) without any manifest entry covering it: an
  UNACCOUNTED divergence. The ledger must be updated (or the change
  reverted) before the migration can be called settled.
- WARN — a manifest entry whose src files ALL match upstream (stale
  ledger: absorbed or accidentally reverted) or that lists a file which no
  longer exists locally. `--strict` promotes warnings to failures.

Upstream resolution: `$PI_UPSTREAM_REPO` → `~/project/pi` → GitHub
codeload tarball of the pinned commit. The gate runs in CI (source-checks
job, `pnpm gate:pi-vendor-diff` — the codeload fallback covers runners
without a local checkout) and locally via `pnpm gate:pi-vendor-diff`.
Keep `vendor-divergences.json` in sync with this file on every re-vendor.

## Divergences

### X001 — SelectList searchable/grouped picker (was #1)

- Category: `HARD_HOST_API`
- Files: `src/components/select-list.ts`
- Reason: `SelectList` gains an optional 5th constructor argument
  `SelectListOptions` (`enableSearch`, `header`, `noMatchText`, `showHint`,
  `initialQuery`), `SelectItem.group` + `SelectListTheme.groupHeader`,
  PageUp/PageDown page navigation, substring search over
  value+label+description, and `setMaxRows()` for host-owned responsive
  overlay budgets. Render also self-limits to the live row grant: group
  headers (a window spanning k groups renders k header rows) and the
  scroll indicator are folded into the same budget, shrinking the item
  window until the list fits with the hint tail intact. The shrink is
  RENDER-LOCAL (a `visibleCount` derived from `maxVisible`) — the
  persistent `maxVisible` stays the budget-derived baseline so a
  selection move or a PageUp/PageDown can use the full grant again.
  `setFilter` is redefined to the same
  case-insensitive substring filter (upstream prefix-matched value only).
  The filter query's canonical single-source-of-truth (getFilter/setItems
  stay in sync with setFilter) is X041 — re-apply both together.
  Upstream 0.84.4 still has none of these.
- Consumer: host `/sessions` picker, model picker, category picker,
  autocomplete compact picker, dynamic title enrichment.
- Upstream status: open upstream PRs exist but are not part of the pinned baseline.
- 2026-09 audit hardening: zero-match navigation invariant — with
  `displayItems.length === 0` every navigation key (up/down/pageUp/pageDown)
  is a no-op, so `selectedIndex` stays 0 (a wrap on the empty list would
  otherwise produce -1/1). Search keys still reach the search box (typing
  refines the query), so the guard sits on the navigation branches only.
- Tests: "search", "group headers", "page keys", "setFilter without
  search (X001 navigation bounds)" and the zero-match navigation test in
  `test/select-list.test.ts`.
- Migration action: re-apply on top of Earendil 0.84.4 `select-list.ts`; keep
  upstream layout contract (`truncatePrimary`, description behavior).

### X002 — SelectList `setItems` selection/search preservation (was #2)

- Category: `HARD_HOST_API`
- Files: `src/components/select-list.ts`
- Reason: `setItems()` replaces the item list while the picker is open,
  re-applying the active query and keeping the selection when the row
  identity survives. Upstream 0.84.4 has no `setItems`.
- Consumer: host `/sessions` picker enriches rows with titles as they load.
- Upstream status: absent.
- Tests: `setItems` and search describes in `test/select-list.test.ts`.
- Migration action: re-apply with X001.

### X003 — Editor multi-line insert cursor (was #3, REMOVED as a defect)

- Category: `REMOVED_UNUSED` (was billed as a bugfix; the re-vendor
  re-verify gate found it to be a defect)
- Files: `src/components/editor.ts`
- Reason: the old divergence wrote a GRAPHEME COUNT into `cursorCol`, but
  the editor treats `cursorCol` as a CODE-UNIT offset everywhere else
  (`line.slice(0, cursorCol)` etc.). It worked only for BMP CJK by
  accident (1 code unit == 1 grapheme); a supplementary-plane grapheme at
  the end of the last inserted line (ZWJ family emoji, combining
  sequence) landed the cursor MID-grapheme and the next keystroke split
  the surrogate pair (document corruption). Upstream's code-unit end is
  correct — the line end is always a grapheme boundary. The old "Right
  arrow moves one grapheme" behavior is provided by the editor's
  grapheme-aware cursor MOVEMENT, not by the insert cursor.
- Consumer: none (the old behavior was harmful).
- Upstream status: upstream behavior retained.
- Tests: "places the cursor at the code-unit end after a multi-line
  insert ending in a supplementary-plane grapheme" in
  `test/editor.test.ts` (ZWJ family emoji preserved after typing).
- Migration action: NOT re-applied; upstream `.length` restored.

### X004A — Editor bounded paste registry (was #4a)

- Category: `BUGFIX_MISSING_UPSTREAM`
- Files: `src/components/editor.ts`
- Reason: the paste buffer is capped (`MAX_PASTE_STORED_CHARS = 256 * 1024`)
  instead of growing unboundedly; beyond the cap a paste expands inline like
  ordinary multi-line text. Upstream 0.84.4 stores every paste.
- Consumer: host editor paste path (multi-MB pastes must not multiply memory).
- Upstream status: absent.
- Tests: "expands pastes beyond the storage cap inline instead of
  markers" and the undo describes in `test/editor.test.ts`.
- Migration action: re-apply.

### X004B — Editor shallow undo snapshots (was #4b, ledger corrected)

- Category: `BUGFIX_MISSING_UPSTREAM` (ledger claim corrected in this audit)
- Files: `src/components/editor.ts`, `src/undo-stack.ts`
- Reason: the old ledger claimed "no whole-document undo clones". That claim
  was FALSE: `pushUndoSnapshot` shallow-clones, but `UndoStack.push` then
  `structuredClone`s the snapshot again, so every edit still deep-clones the
  whole document. Fix: `UndoStack.push` stores the snapshot as-is (both
  consumers already pass detached containers — editor shallow-clones
  lines/pastes, input passes immutable strings), making the shallow snapshot
  actually effective.
- Consumer: host editor undo path (multi-MB paste memory).
- Upstream status: upstream deep-clones on every push.
- Tests: undo describes in `test/editor.test.ts` (must still pass with the
  detached-snapshot semantics).
- Migration action: re-apply the shallow snapshot AND change `UndoStack.push`
  to store as-is; update the ledger claim to match the real implementation.

### X005 — Editor autocomplete latest-wins (was #5)

- Category: `BUGFIX_MISSING_UPSTREAM`
- Files: `src/components/editor.ts`
- Reason: autocomplete uses requestId + text/cursor snapshot rejection (no
  serial task chain), so an abort that never settles (a provider ignoring the
  signal) cannot stall the chain forever. Upstream 0.84.4 still chains
  `autocompleteRequestTask` serially.
- Consumer: host editor autocomplete (providers may ignore AbortSignal).
- Upstream status: absent.
- Tests: "latest-wins: a never-settling provider cannot stall the newer
  request (X005)" in `test/editor.test.ts` (a provider whose first request
  never settles must not block the second keystroke's suggestions), plus
  the editor autocomplete describes.
- Migration action: re-apply; do NOT restore the serial task chain.

### X006 — Word-forward skips punctuation at segment start (was #6)

- Category: `BUGFIX_MISSING_UPSTREAM`
- Files: `src/word-navigation.ts`
- Reason: `wordForward` skips leading punctuation of the next segment instead
  of stopping on it (CJK-aware). Upstream 0.84.4 stops before it (a no-op
  move).
- Consumer: host editor word navigation.
- Upstream status: absent.
- Tests: "skips leading punctuation of a word-like segment (dsh-pi-tui
  divergence X006)" in `test/word-navigation.test.ts` (reaches the branch
  via a custom segmenter — the default Intl.Segmenter classifies leading
  punctuation as non-word-like) plus the word-navigation describes.
- Migration action: re-apply.

### X007 — Component `dispose()` lifecycle (was #7)

- Category: `HARD_HOST_API` / `PUBLIC_COMPONENT_CONTRACT`
- Files: `src/tui.ts`, `src/components/scroll-view.ts`, `src/components/text.ts`, `src/components/loader.ts`, `src/components/box.ts`, `src/components/settings-list.ts`, `src/components/stack.ts`
- Reason: `Component` gains an optional `dispose()`; `Container.removeChild`/
  `clear`/`dispose` release child resources; `ScrollView` disposes its hide
  timer and render callback; `Text` gets a no-op `dispose()`; `Loader`
  disposes its animation timer. Upstream 0.84.4 has no `dispose` anywhere.
  COMPLETED in the 2026-09 follow-up audit so the contract covers EVERY
  ownership path, not just Container/ScrollView:
  - `Box.removeChild`/`clear` dispose removed children (Box had its own
    override that silently skipped dispose);
  - `SettingsList` owns its submenu slot — `closeSubmenu`, submenu
    replacement and `dispose()` release the component (dispose bypasses the
    navigateAfterClose resurrection);
  - `OverlayHandle.hide()`/`hideOverlay()` dispose the removed component
    ONLY with the new opt-in `OverlayOptions.disposeOnHide` — default false
    (upstream behavior) because hide()+re-mount is a legitimate screen-
    migration pattern; the host opts IN for every overlay entry it owns
    (panels behind an owning FocusForwardingFrame) and opts OUT for the
    remountable extension/advanced/unstable leases.
  - `Stack` maintains a SECOND `entries` layout representation and
    therefore must clear it on dispose together with Container.children —
    without the override the fullscreen layout engine (which reads
    `[LAYOUT_NODE]().entries`) would keep observing already-disposed
    children after `Stack.dispose()` (re-vendor lifecycle follow-up P2).
- Ownership map after the completion: Container removal → dispose;
  Stack removal → dispose; ScrollView disposal → child dispose;
  Box removal → dispose; SettingsList submenu slot → dispose;
  Overlay hide (disposeOnHide) → dispose; overlay hide (default) → caller
  owns.
- 2026-09 audit hardening: `Container.dispose()` is now IDEMPOTENT — the
  children are detached BEFORE disposal (a repeated dispose is a no-op
  instead of double-disposing the children). Deliberately NOT `this.clear()`
  (ScrollView overrides clear() to throw). The host's final surface
  teardown relies on exactly-once disposal: `OverlayBroker.disposeAll()`
  physically unmounts every still-tracked overlay (running disposeOnHide)
  WITHOUT restoring dependents, so a caller that never invoked its closer
  (e.g. an open OutputViewer) still releases its panel-owned timers.
- Consumer: host pi-surface-compat gate (`test/pi-component-compat.test.ts`:
  close idempotent, dispose exactly once, surface disposal invalidates old
  leases, fullscreen migration keeps one live adapter) and the extension
  lifecycle (unstable mounts, overlay leases).
- Upstream status: absent.
- Tests: `test/pi-component-compat.test.ts` (bundle), ScrollView/layout
  describes in `test/layout.test.ts`, `Container.dispose`/`ScrollView.dispose`
  idempotency in `test/dispose-lifecycle.test.ts`, Stack dispose clears
  entries and remains idempotent (VStack/HStack, repeated dispose, disposed
  stack paints nothing through the layout engine) in `test/layout.test.ts`.
- Migration action: re-apply on top of Earendil 0.84.4 `tui.ts`; do not
  break the upstream renderer lifecycle.

### X008 — Timed-out OSC 11 queries drop from the queue (was #8)

- Category: `BUGFIX_MISSING_UPSTREAM`
- Files: `src/tui.ts`
- Reason: a timed-out background-color query is removed from the pending
  queue so the reply counter stays in sync — a late reply is swallowed as a
  terminal protocol response instead of leaking +1 and misaligning the
  queue/counter pair. Upstream 0.84.4 keeps the timed-out query in the queue
  (its counter check differs).
- Consumer: host theme autodetect (OSC 11 background query).
- Upstream status: absent.
- Tests: `test/osc11-query.test.ts` (timed-out queries never leak into the
  reply counter).
- Migration action: re-apply; keep the upstream reply-swallowing order
  (`isOsc11BackgroundColorResponse` first, then the counter check).

### X009 — No stray spacer blank on the final row when exiting (was #9)

- Category: `BUGFIX_MISSING_UPSTREAM`
- Files: `src/tui-main-screen.ts`
- Reason: `beforeTerminalStop` writes the spacer blank only when the cursor
  must actually move; on the final row a stray blank would stay visible after
  the TUI exits. Upstream 0.84.4 writes it unconditionally.
- Consumer: host exit path (clean terminal state after quit).
- Upstream status: absent.
- Tests: none dedicated (covered by exit-path behavior).
- Migration action: re-apply.

### X010 — Width state sync; capped ESC-prefix scans (was #10)

- Category: `BUGFIX_MISSING_UPSTREAM`
- Files: `src/stdin-buffer.ts`
- Reason: the stdin buffer caps ESC-prefix scanning
  (`MAX_ESCAPE_SEQUENCE_LENGTH = 1024`) so a never-terminating ESC prefix
  degrades to a plain character instead of an O(n²) reslice. (The main
  screen's width-state sync half of the old #10 is already in upstream
  0.84.4 — only the ESC cap is local.)
- Consumer: host resize handling, corrupt/oversized input streams.
- Upstream status: absent.
- Tests: ESC/sequence describes in `test/stdin-buffer.test.ts`.
- Migration action: re-apply.

### X011 — Input prompt clips on extremely narrow widths (was #11)

- Category: `BUGFIX_MISSING_UPSTREAM`
- Files: `src/components/input.ts`
- Reason: `Input` clips its prompt instead of overflowing at tiny widths.
  Upstream 0.84.4 returns the raw prompt (a line wider than the terminal).
- Consumer: host narrow-terminal support (40-column minimum).
- Upstream status: absent.
- Tests: none dedicated (narrow-width renders exercised by editor/settings
  describes).
- Migration action: re-apply.

### X012 — Deterministic fuzzy tie sort (was #12)

- Category: `BUGFIX_MISSING_UPSTREAM`
- Files: `src/fuzzy.ts`
- Reason: `fuzzyFilter`'s sort order is deterministic on score ties (stable
  by input order). Upstream 0.84.4 sorts by score only (engine-dependent on
  ties).
- Consumer: host fuzzy search (stable ordering across runs).
- Upstream status: absent.
- Tests: ordering describes in `test/fuzzy.test.ts`.
- Migration action: re-apply.

### X013 — `setIndicator` never revives a stopped loader (was #13, REMOVED as unconsumed)

- Category: `REMOVED_UNUSED`
- Files: `src/components/loader.ts`
- Reason: the old divergence made `setIndicator` leave a stopped loader
  stopped (upstream unconditionally restarts the animation). The 2026-09
  relocation audit verified there is NO consumer: the host's busy
  indicator is the host-side `WorkingIndicator` (src/), the host never
  imports `Loader`/`CancellableLoader`/`setIndicator`, and no fork
  internal constructs a `Loader`. The earlier ledger row claiming
  "Consumer: host busy indicator lifecycle" was false.
- Consumer: none (verified).
- Upstream status: upstream behavior retained (setIndicator restarts).
- Tests: none (nothing to guard).
- Migration action: NOT re-applied; upstream baseline restored (2026-09).

### X014 — Measured line widths cached (was #14, scope corrected)

- Category: `BUGFIX_MISSING_UPSTREAM`
- Files: `src/layout.ts`
- Reason: `measureWidth` caches the max visible line width per
  (component, width) in the layout context, so a frame measures each
  component once instead of re-running `visibleWidth` over its lines at
  every call site. Upstream 0.84.4 re-measures on every call.
  Scope note: the old #14 also claimed a scrollbar thumb pad clamp. That
  clamp (`thumbHeight = Math.max(...)`, `maxThumbTop`) SHIPPED in upstream
  0.84.4 — it is upstream baseline, not a local divergence; do not
  re-apply or double-count it.
- Consumer: host layouts that call measureWidth repeatedly per frame
  (transcript, fullscreen).
- Upstream status: absent (cache only).
- Tests: scrollbar/measure describes in `test/layout.test.ts`.
- Migration action: re-apply ONLY the `maxWidthCache` field + `measureWidth`
  cache lookup; keep the upstream thumb clamp verbatim.

### X015 — Dead `_lastEventType` state (was #15)

- Category: `ABSORBED_UPSTREAM`
- Files: `src/keys.ts`
- Reason: the old ledger removed a dead `_lastEventType` field. Earendil
  0.84.4 HAS the field (it feeds `isKeyRelease`). Restoring the upstream
  baseline restores the field; no local action needed.
- Migration action: none (upstream baseline).

### X016 — `start()` must not stack resize listeners (was #16)

- Category: `BUGFIX_MISSING_UPSTREAM`
- Files: `src/terminal.ts`
- Reason: restarting `ProcessTerminal` re-registers the resize handler only
  once (the PREVIOUS start()'s listener is removed BEFORE the new handler is
  assigned — `stop()` can only remove the current reference). Upstream
  0.84.4 stacks listeners on restart.
- 2026-09 audit completion: a repeated start() now swaps EVERY owned
  handler safely, not just the resize listener — the previous stdin "data"
  handler is removed and the previous StdinBuffer destroyed before the new
  ones are created (a stale StdinBuffer callback and a stale stdin listener
  would both forward into the NEW inputHandler, delivering one stdin event
  twice), the keyboard-negotiation buffer/timer is cleared, and the
  pre-raw `wasRaw` state is captured ONLY on the first start (a repeated
  start finds stdin already raw; re-capturing would make the eventual
  stop() restore raw mode instead of the original cooked state). The
  Kitty keyboard protocol is pushed (CSI > flags u) exactly ONCE per
  start/stop cycle: a repeated start keeps the negotiated mode and does
  not push again, so stop()'s single pop (CSI < u) restores the terminal
  instead of leaving it in enhancement mode after exit.
- Consumer: host surface restart (fullscreen toggle re-starts the terminal).
- Upstream status: absent.
- Tests: "repeated start() calls swap the resize listener instead of
  stacking it", "repeated start() calls swap the stdin data handler instead
  of stacking it", "repeated start() keeps the ORIGINAL raw state so
  stop() restores cooked mode" and "repeated start() pushes the Kitty
  keyboard protocol exactly once" in `test/terminal.test.ts` (X016
  regression: two consecutive `start()` calls must leave exactly one
  listener per resource, deliver one stdin event exactly once, restore
  the original raw mode on stop, and keep the keyboard-protocol
  push/pop balanced).
- Migration action: re-apply; keep the remove-before-assign ORDER (assigning
  the new handler first silently reverts the fix — the removed listener is
  then the new one and the old listener leaks).

### X017 — Regular mode owns no mouse (was #17)

- Category: `ABSORBED_UPSTREAM`
- Files: `src/tui-main-screen.ts`, `src/tui-alt-screen.ts`
- Reason: mouse handling lives on the alt screen; the regular surface stays
  mouse-free. Earendil 0.84.4 has the same ownership.
- Migration action: none (upstream baseline).

### X018 — Click granularity guard + `onCellClick` (was #18)

- Category: `HARD_HOST_API`
- Files: `src/tui-alt-screen.ts`
- Reason: `onCellClick` fires only for character-granularity (single) clicks —
  a double click selects a word (native behavior) instead of disclosing, and
  a plain click skips the clipboard feedback so the host callback owns the
  click. Upstream 0.84.4 has no `onCellClick` at all.
- Consumer: host `TuiApp` fullscreen click-to-expand
  (`onCellClick: (x, y) => this.handleFullscreenClick(x, y)`).
- Upstream status: absent.
- Tests: `onCellClick` describes in `test/tui-alt-screen.test.ts`.
- Migration action: re-apply on top of Earendil 0.84.4 (keep the upstream
  double-click word selection and copy-on-select behavior).

### X019 — Text no-op `dispose()` (was #19)

- Category: `HARD_HOST_API` (part of X007 lifecycle)
- Files: `src/components/text.ts`
- Reason: `Text` gets a no-op `dispose()` so `Loader`'s override typechecks.
- Migration action: re-apply with X007.

### X020 — Editor `clearHistory()` (was #20)

- Category: `HARD_HOST_API`
- Files: `src/components/editor.ts`
- Reason: drops every prompt-history entry (and browsing state) so a host can
  swap the whole history context on a session/workspace switch. Upstream
  0.84.4 has no such method.
- Consumer: host `editor-seat-holder` (`clearHistory` on session switch).
- Upstream status: absent.
- Tests: editor-history keybindings describes in `test/editor.test.ts`.
- Migration action: re-apply.

### X021 — Wrapped lines are foreground-balanced (was #21)

- Category: `BUGFIX_MISSING_UPSTREAM`
- Files: `src/utils.ts`
- Reason: `AnsiCodeTracker.getLineEndReset()` closes EVERY non-background
  attribute (bold, dim, italic, underline, blink, inverse, hidden,
  strikethrough, foreground) at the end of each wrapped physical line, and
  `wrapSingleLine` closes them on the final line too. The background stays
  open so cell padding keeps its background. Upstream 0.84.4 closes only
  underline + OSC 8 (its markdown table fix resets styles per table cell, but
  wrapped content outside tables still leaks).
- Consumer: host transcript rendering (wrapped styled content → padding →
  table borders).
- Upstream status: partially absorbed (markdown table cell reset exists);
  the general wrap balancing is absent.
- Tests: "should close foreground color at the end of every wrapped line" and
  "should close foreground at line end while preserving background" in
  `test/wrap-ansi.test.ts`, and "should not leak wrapped inline-code color
  into table borders" in `test/markdown.test.ts`.
- Migration action: re-apply; verify foreground/bold/dim/italic/underline/
  blink/inverse/hidden/strikethrough/OSC8/background preservation.

### X022 — Editor public cursor synchronization `setCursor` (was #22)

- Category: `HARD_HOST_API`
- Files: `src/components/editor.ts`
- Reason: `Editor.setCursor({ line, col })` clamps the requested position to
  an existing line and grapheme boundary without firing `onChange`, then
  requests a repaint. Upstream 0.84.4 has no such method.
- Consumer: host `editor-seat-holder` replacement-editor fallback.
- Upstream status: absent.
- Tests: "sets and clamps the cursor without firing onChange" in
  `test/editor.test.ts`.
- Migration action: re-apply.

### X023 — Editor side-effect-free text/cursor staging `setTextAndCursor` (was #23)

- Category: `HARD_HOST_API`
- Files: `src/components/editor.ts`
- Reason: `Editor.setTextAndCursor(text, cursor)` normalizes line
  endings/tabs, replaces the document and cursor without firing `onChange`,
  cancelling autocomplete, leaving history browsing, pushing undo, or
  clearing the paste registry. Upstream 0.84.4 has no such method.
  TIGHTENED in the 2026-09 follow-up audit: the paste registry is PRUNED to
  the markers that survive in the staged text (neither "keep all" — a
  replaced document orphaned multi-hundred-KB entries — nor "clear all" —
  surviving markers must keep expanding).
- Consumer: host `editor-seat-holder` declined-key replacement fallback.
- Upstream status: absent.
- Tests: public staging/normalization tests in `test/editor.test.ts` and the
  declined replacement fallback tests in `test/editor-registry.test.ts`
  (bundle).
- Migration action: re-apply.

### X024 — Line-head selections copy without the emoji-column indent (was #24)

- Category: `BUGFIX_MISSING_UPSTREAM`
- Files: `src/tui-alt-screen.ts`
- Reason: `copySelectionToClipboard` strips 1-3 leading spaces from a copied
  line when the selection starts at its head (column 0), so host transcript
  lines copied via fullscreen drag selection no longer carry the bullet
  column's padding. Upstream 0.84.4 keeps the leading spaces.
- Consumer: host fullscreen drag-copy UX.
- Upstream status: absent.
- Tests: "copies line-head selections without the emoji-column indent" and
  "keeps leading spaces when the selection starts mid-line" in
  `test/tui-alt-screen.test.ts`.
- Migration action: re-apply on top of Earendil 0.84.4 (keep the upstream
  `getActiveSelectionText` structure).

### X025 — Explicit tsdown build config (was #25)

- Category: `PACKAGING`
- Files: `tsdown.config.ts`, `src/native-module-path.ts`
- Reason: tsdown discovers configs by walking up from the CWD; the root
  bundle's `tsdown.config.ts` would shadow this package's build. The config
  reproduces the tsdown defaults (entry `src/index.ts`, ESM, `dist/`,
  declarations). The package is also RENAMED from the upstream scope
  (`@earendil-works/pi-tui` → `@xmoon76/pi-tui`), so upstream's
  self-referencing native-module lookup (`TUI_PACKAGE_NAME` in
  `native-module-path.ts`) must follow the rename — otherwise the
  installed-package candidate for `.node` prebuilds can never resolve
  (round-2 review finding). Package `author` follows the pinned upstream
  metadata (`Mario Zechner`) — the old `Moonshot AI` value was a kimi-era
  leftover; the LICENSE already carries the correct upstream copyright.
- Consumer: package build (`pnpm --dir packages/pi-tui build` must produce
  `dist/index.mjs` + `dist/index.d.mts`); native prebuild discovery
  (native-modifiers / Windows VT input) if native assets are ever shipped.
- Migration action: keep the XMoon shell; do NOT copy the upstream
  package.json / tsgo contract; on re-vendor, re-apply the
  `TUI_PACKAGE_NAME` rename to `@xmoon76/pi-tui` and keep `author` in sync
  with the pinned upstream metadata (never restore the kimi-era
  `Moonshot AI`).

### X026 — Injectable selection clipboard handler (was #26)

- Category: `ABSORBED_UPSTREAM`
- Files: `src/tui-alt-screen.ts`
- Reason: upstream 0.84.4 natively provides `copySelection?` plus
  `copyOnSelect`, `getCopyOnSelect()`, `setCopyOnSelect()`,
  `hasActiveSelection()`, `copyActiveSelectionToClipboard()`. Do NOT re-apply
  the old patch; the host keeps its clipboard policy in `src/clipboard.ts`
  and injects it via the native `copySelection` callback.
- Migration action: none (upstream baseline); verify the host callback path
  still drives the `Copied!` / `Copy failed` flash.

### X027 — fd directory typing never relies on the trailing separator (was #27)

- Category: `BUGFIX_MISSING_UPSTREAM`
- Files: `src/autocomplete.ts`
- Reason: `typeDirectoryOutputLines` classifies fd's plain-text stdout lines
  with `statSync` (follows symlinks), keeping the trailing separator only as
  a fallback when the stat fails. Upstream 0.84.4 still relies on
  `endsWith("/")` and slices directory names (`path.slice(0, -1)`).
- Consumer: host `@` file completion.
- Upstream status: absent.
- Tests: `typeDirectoryOutputLines` describe in `test/autocomplete.test.ts`
  plus the fd-backed `@` describes.
- Migration action: re-apply ONLY the directory classification on top of
  Earendil 0.84.4; keep the upstream nested ordering / fuzzy changes; do NOT
  reintroduce `path.slice(0, -1)` on bare directory lines.

### X028 — Fullscreen viewport boundary, pre-input, and search-reset seams (was #28)

- Category: `HARD_HOST_API`
- Files: `src/tui-alt-screen.ts`, `src/components/scroll-view.ts`
- Reason: `onScrollBoundary` reports final unconsumed wheel/page/primary-
  scrollbar edge attempts, `onBeforeViewportInput` lets a host claim semantic
  viewport keys before built-in Home/End/Page handling, and `clearSearch()`
  lets a host reset the built-in fullscreen transcript search. Upstream
  0.84.4 has none of these. ALSO PART OF THIS ENTRY (2026-09 audit): the
  `ScrollView.canScroll` getter — it drives the navigation fall-through (a
  non-scrollable primary viewport must let PageUp/Home/End fall through to
  the focused component instead of consuming them). `canScroll` lives in
  scroll-view.ts; losing it on a future re-vendor would silently consume
  navigation keys on short transcripts. The HOST additionally claims the
  fork's `previousPrompt`/`nextPrompt` keys (Ctrl+Up/Ctrl+Down) through
  `onBeforeViewportInput` for its own turn navigation — the fork's built-in
  OSC 133 scan finds nothing in DSH transcripts (permanent no-op).
- Consumer: host virtual transcript (page older/newer), Home/End ownership,
  host search (`app.transcript.jumpLatest`, `app.transcript.search`),
  `clearSearch` on jump-latest.
- Upstream status: absent.
- Tests: boundary/overscroll/page/scrollbar/search cases in
  `test/tui-alt-screen.test.ts` and the fullscreen Home/End cases in the
  bundle.
- Migration action: re-apply on top of Earendil 0.84.4 (keep the upstream
  `shouldDeferViewportInputToOverlay` behavior; only report a boundary when
  the primary scroll view actually reached an edge).

### X029 — Editor history callbacks (kimi-code, host-dependent)

- Category: `HARD_HOST_API`
- Files: `src/components/editor.ts`
- Reason: `onRecall`, `onHistoryDraftSave`, `onHistoryDraftRestore` — the
  host's `TuiEditor` assigns all three to keep the input mode (`!`/`!!`)
  across history recall and draft browsing. Kimi-code provenance; upstream
  0.84.4 has none of them.
- Consumer: host `src/tui-editor.ts` (input-mode history contract).
- Upstream status: absent.
- Tests: editor-history keybindings describes in `test/editor.test.ts`
  (bundle tests cover the mode round-trip).
- Migration action: re-apply.

### X030 — `decodePrintableKey` re-export (kimi-code, host-dependent)

- Category: `HARD_HOST_API`
- Files: `src/index.ts`
- Reason: the host imports `decodePrintableKey` from the package root
  (`src/footer/configurator.ts`, `src/keybinding-ui/list.ts`). Upstream
  0.84.4 defines it in `keys.ts` but does NOT re-export it from `index.ts`.
- Consumer: host footer configurator, keybinding UI.
- Upstream status: present in `keys.ts`, missing from the public entry.
- Tests: bundle tests exercise the footer/keybinding paths.
- Migration action: add the re-export to `src/index.ts`.

### X031 — CJK URL boundary tokenizer (kimi-code, host-dependent)

- Category: `BUGFIX_MISSING_UPSTREAM`
- Files: `src/components/markdown.ts`
- Reason: marked's GFM autolink absorbs CJK/full-width punctuation right
  after a bare URL into the link text/href. `CjkBoundaryUrlTokenizer` cuts
  the match at the first CJK punctuation (balanced full-width parens stay
  part of the URL). Kimi-code provenance; upstream 0.84.4 (and 0.84.3) does
  not have it. The old ledger's "landed upstream" note was wrong for this
  entry.
- Consumer: host transcript Markdown rendering of CJK content.
- Upstream status: absent.
- Tests: "CJK punctuation after bare URLs" cases in `test/markdown.test.ts`.
- Migration action: re-apply.

### X032 — Container.render width clamp (kimi-code, defensive)

- Category: `BUGFIX_MISSING_UPSTREAM`
- Files: `src/tui.ts`
- Reason: `Container.render` clamps the width to at least 1 so extremely
  narrow/non-positive terminal column counts never propagate into components
  (negative `repeat()` counts would throw). Kimi-code provenance; upstream
  0.84.4 does not clamp. The host supports 40-column terminals and guards
  non-TTY at startup; the clamp is a cheap defense-in-depth for the whole
  component tree.
- Consumer: host narrow-terminal support.
- Upstream status: absent.
- Tests: "Container width clamp (dsh-pi-tui divergence X032)" in
  `test/tui-render.test.ts` (widths 0 / -3 / 5 must clamp to 1 / 1 / 5)
  plus the bundle suite's narrow-width renders.
- Migration action: re-apply (3-line patch).

### X033 — Overwide rendered lines are truncated, not fatal (kimi-code, host-dependent)

- Category: `BUGFIX_MISSING_UPSTREAM`
- Files: `src/tui-main-screen.ts`
- Reason: upstream 0.84.4 THROWS (with a crash log) when a rendered line
  exceeds the terminal width. The host's components can overflow by a
  column in narrow terminals (wide graphemes at small widths, defensive
  host layouts), and a throw stops the whole TUI. The main screen
  truncates overwide non-image lines to the terminal width instead.
  IMPORTANT ordering detail: the truncation runs BEFORE the segment reset
  is appended — sliceByColumn drops trailing zero-width codes at the cut
  column, so the reset must be appended AFTER the slice or a truncated
  styled line leaks its open style into subsequent rows. Kimi-code
  provenance; upstream 0.84.4 (and 0.84.3) throws.
- Consumer: host narrow-terminal support (40-column minimum) and defensive
  host layouts.
- Upstream status: absent (upstream throws).
- Tests: "TUI overwide line handling (dsh-pi-tui divergence X033)" and
  "appends the segment reset AFTER the truncation slice (styled leak
  regression)" in `test/tui-render.test.ts` (overwide + styled + CJK
  lines at width 4 must truncate, not throw; truncated styled lines must
  carry their full segment reset) plus the bundle suite's narrow-width
  renders.
- Migration action: re-applied; with X035 the truncation lives in the
  per-line processing pass (slice, then reset) so the ordering holds for
  both the cold path and the reuse fast path.

### X034 — wordWrapLine single-grapheme overwide guard (kimi-code, host-dependent)

- Category: `BUGFIX_MISSING_UPSTREAM`
- Files: `src/components/editor.ts`
- Reason: a single atomic grapheme wider than maxWidth (a CJK character at
  width 1, a ZWJ family emoji at narrow widths) cannot be split further;
  re-wrapping it recurses forever (RangeError: Maximum call stack size
  exceeded). The guard keeps the grapheme as its own chunk, letting it
  overflow by one column — the main screen's X033 truncation then clips it.
  (The editor's narrow-width rendering at 1-8 columns depends on it.)
  Kimi-code provenance; upstream 0.84.4 recurses.
- Consumer: host editor on narrow terminals (40-column minimum, shrunk
  windows) with CJK/emoji drafts.
- Upstream status: absent (upstream recurses).
- Tests: "wordWrapLine narrow width" and "Editor narrow width rendering"
  describes in `test/editor.test.ts` (wide grapheme at maxWidth 1, CJK
  text at widths 1-8, ZWJ family emoji, TUI at 5 columns).
- Migration action: re-applied (sub-grapheme check before the recursion).

### X035 — Per-frame processed-line reuse (main screen, host render contract)

- Category: `PERF_HOST_DEPENDENT`
- Files: `src/tui-main-screen.ts`, `src/utils.ts`, `src/tui.ts`
  (`SEGMENT_RESET` export)
- Reason: the main screen keeps the previous frame's RAW lines and
  per-line kitty image ids. A line whose raw string is reference-identical
  to the previous frame reuses its processed output verbatim (truncate →
  normalize → segment reset, image-id scan), so a steady frame costs
  O(#changed lines) instead of re-normalizing, re-measuring
  (`visibleWidth`), and re-scanning the whole transcript. The cold path
  measures width through the `asciiVisibleWidth` fast path (ANSI-aware
  ASCII scan with early exit past the limit) before falling back to
  `visibleWidth`. The HOST is built around this contract: the bundle's
  `BulletedComponent` and `ThinkingCompactComponent` keep their rendered
  output REFERENCE-STABLE precisely so this cache keeps hitting on steady
  frames (see their doc comments in `src/tui-app.ts`). Provenance: in the
  fork since the initial kimi-code snapshot vendoring (`54d6c22`); the
  2026-08 transcript perf work (virtual window, lazy dirty projection)
  hardened the same contract. Upstream 0.84.4 reprocesses every line every
  frame (`map` truncate + `applyLineResets` + full kitty re-scan): measured
  ~30-370 ms CPU per frame at 1k-10k rendered lines with only the trailing
  spinner line changing, vs ~0.1-1.6 ms with the cache
  (`test/render-preprocess-bench.ts`). Upstream's `BoundedTerminalWriter`
  solves a DIFFERENT problem (never forming a >1 MiB output string) and
  does not replace this cache; both are retained.
- Consumer: host main-screen transcript rendering (long sessions,
  streaming, spinner frames).
- Upstream status: absent.
- Tests: "Per-frame processed-line reuse (dsh-pi-tui divergence X035)" in
  `test/tui-render.test.ts` (steady frames stay near-constant — generous
  time budget that only an order-of-magnitude regression can fail; and a
  reference-identical frame writes nothing).
- Migration action: re-apply (processing pass + `previousRawLines` /
  `previousLineImageIds` caches + `asciiVisibleWidth`; the width-change
  path must invalidate reuse; `restoreRenderState`/`resetRenderState`
  clear the caches).

### X036 — FOCUS_IN/FOCUS_OUT reach app-level input listeners (alt screen)

- Category: `HARD_HOST_API`
- Files: `src/tui-alt-screen.ts`
- Reason: the fullscreen viewport input handler performs its own selection
  cleanup on FOCUS_OUT but does NOT consume the focus report
  (`return undefined`), and FOCUS_IN passes through as well — app-level
  input listeners installed via `addInputListener` (the host's
  `routeInput`→`handleInput` seam) still receive `\x1b[O` / `\x1b[I`.
  The main-screen renderer lets focus reports through, and terminal
  focus tracking (notification suppression, clipboard-image hints)
  depends on that fan-out. Upstream 0.84.4 consumes both events in the
  viewport handler, so they never reach app-level listeners on the alt
  screen (an input-listener parity break between the two screens).
- Consumer: host app-level input listeners (`TuiApp.routeInput` on every
  screen; focus-report based notification/clipboard tracking).
- Upstream status: absent (upstream consumes).
- Tests: "lets focus reports reach app-level input listeners" in
  `test/tui-alt-screen.test.ts` (an app-level listener must observe both
  `\x1b[O` and `\x1b[I`); the selection-cleanup behavior on focus loss is
  covered by the neighboring focus describes.
- Migration action: re-apply (passthrough AFTER the FOCUS_OUT selection
  cleanup; keep the cleanup).

### X037 — Editor-owned submit binding `tui.editor.submit` (2026-09 follow-up audit)

- Category: `HARD_HOST_API` / `PUBLIC_COMPONENT_CONTRACT`
- Files: `src/keybindings.ts`, `src/components/editor.ts`
- Reason: the editor's submit check consults a DEDICATED `tui.editor.submit`
  binding (default `enter`) instead of `tui.input.submit`. Keybindings are
  process-global: the host remaps the editor's submission by writing the
  binding, and sharing it with `tui.input.submit` leaked the remap into
  every plain `Input` (question free-text, task/history search, picker
  search boxes) — a `submit: ctrl+x` config made plain Inputs submit on
  ctrl+x. `tui.input.submit` stays the plain-Input binding (always `enter`
  at the host) and is never remapped. `shouldSubmitOnBackslashEnter` reads
  the editor binding too.
- Consumer: host `onEditorSubmitSync` (keybindings/manager.ts), the
  dispose-time default restore, the `editorAccepts` inventory
  (src/tui-app.ts).
- Upstream status: absent (upstream has only `tui.input.submit`).
- Tests: "editor submit binding split (X037)" in `test/editor.test.ts`;
  bundle: the anti-pollution tests in `test/keybinding-integration.test.ts`.
- Migration action: re-apply BOTH halves — the binding definition AND the
  two editor.ts call sites — or the split silently reverts.

### X038 — PasteBurst non-bracketed paste fallback RESTORED (was wrongly REMOVED_UNUSED)

- Category: `BUGFIX_MISSING_UPSTREAM`
- Files: `src/paste-burst.ts`, `src/components/editor.ts`
- Reason: terminals that lose bracketed-paste markers (iTerm2/tmux) deliver
  pastes as rapid plain-character streams; the trailing Enter must insert a
  newline instead of submitting a half-pasted draft. The 2026-09 re-vendor
  deleted it as "no host consumer" — a WRONG criterion for an
  editor-internal terminal-input bugfix (it needs no host consumer by
  design). Restored in the kimi form: `PasteBurst` class (≥8 chars at ≤8ms
  intervals, 30ms active window, 120ms Enter-suppress window),
  `disablePasteBurst` constructor option + `setDisablePasteBurst()` (tests
  and integrations opting out), kimi-exact SINGLE-char tracking — a
  multi-char chunk RESETS the burst (multi-char reads are typed-ahead text
  or whole-line injections, not a terminal dribbling a paste; this also
  keeps synchronous whole-string test input submitting normally).
- Consumer: host editor paste path (every remap/SSH/tmux session without
  bracketed paste).
- Upstream status: absent.
- 2026-09 audit cross-divergence (X037 × X038): the burst's Enter is the
  PHYSICAL Enter that currently carries the submit binding
  (`isPhysicalSubmitEnter` = physical Enter AND `tui.editor.submit` match).
  A remapped submit chord (e.g. Ctrl+X) is a chord, not a paste's trailing
  Enter: it resets the burst and submits even mid-burst — the suppression
  never applies to it. Previously the "is Enter" test was the semantic
  submit match alone, so a remapped submit key was suppressed into a
  newline while the burst was active.
- Tests: "paste-burst fallback (X038)" describes in `test/editor.test.ts`,
  including the two X037 × X038 cross tests (remapped submit chord submits
  mid-burst; a physical Enter under a remapped submit breaks the burst
  instead of submitting).
- Migration action: re-apply `paste-burst.ts` verbatim + the editor
  integration (tracking block after the bracketed-paste section, the
  submit-branch check, the two insert-point feeds, the option/setter).
  LESSON: "no host consumer" is only a valid removal criterion for
  Host-API patches — internal bugfixes, perf contracts and product
  behaviors need their own criteria (see the removed-code section below).

### X039 — `WIDTH_CACHE_SIZE` 4096 restored (kimi-era perf contract)

- Category: `PERF_HOST_DEPENDENT`
- Files: `src/utils.ts`
- Reason: the non-ASCII width cache holds 4096 entries (upstream 512). The
  host renders CJK-heavy transcripts; width changes, theme invalidations
  and cold renders re-measure many non-ASCII lines and a 512-entry FIFO
  thrashes. X035 bounds the STEADY frame; this bounds the burst paths.
  Deliberately restored after the re-vendor briefly took upstream's 512
  (the old ledger had listed 4096 as removable "kimi tweak" — the removal
  criterion for a perf contract is the measured benefit, not host imports).
- Consumer: every `visibleWidth` caller.
- Upstream status: absent (upstream 512).
- Tests: covered by the wrap/layout suites (no dedicated test — a size
  constant).
- Migration action: keep 4096 unless a benchmark says otherwise.

### X040 — `Input.setValue` cursor placement

- Category: `PUBLIC_COMPONENT_CONTRACT`
- Files: `src/components/input.ts`
- Reason: `setValue(value, { cursor })` places the cursor at the END of the
  new value by default — every caller pre-fills a query/draft the user
  continues typing, and the historical clamp left a fresh Input's cursor at
  0, so `setValue("foo")` + typing "x" produced "xfoo" (SelectList
  initialQuery, task/history panels, question draft restore).
  `{ cursor: "preserve" }` keeps the clamped-cursor behavior for mid-edit
  replacements.
- Consumer: host pickers/panels via X001 `initialQuery`; question flow
  draft restore.
- Upstream status: absent (upstream and the kimi snapshot clamp only).
- Tests: "setValue cursor semantics (X040)" in `test/input.test.ts`.
- Migration action: re-apply with X041 (setFilter depends on it).

### X041 — SelectList canonical filter query

- Category: `HARD_HOST_API` (extends X001/X002)
- Files: `src/components/select-list.ts`
- Reason: the filter query has ONE source of truth (`filterQuery`, written
  by every `applyFilter` call). Previously `setFilter()` narrowed
  `filteredItems` while `getFilter()`/`setItems()` kept reading the search
  box — a programmatic filter (`/sessions <query>`) desynced from the
  rendered box, was silently DROPPED by the next keystroke, lost across
  category switches and `setItems` refreshes, and `getFilter()` lied (empty)
  with search disabled. `setFilter()` now syncs the search box (cursor at
  the end via X040) before applying; `getFilter()` returns the canonical
  query; `setItems()` re-applies it.
- Consumer: host `/sessions` picker prefill, categorized picker Tab cycle,
  MarqueeFilterAdapter, dynamic row enrichment.
- Upstream status: absent (upstream has no search).
- Tests: "canonical filter state (X041)" in `test/select-list.test.ts`.
- Migration action: re-apply together with X001/X002 (same file, same
  feature).

### X042 — Focusable propagation on Input-owning lists

- Category: `PUBLIC_COMPONENT_CONTRACT`
- Files: `src/components/select-list.ts`, `src/components/settings-list.ts`
- Reason: `SelectList`/`SettingsList` implement `Focusable`: the focused
  flag propagates to the input the user actually types into (SelectList's
  search Input; SettingsList's search Input AND the open submenu
  component). Without it a focused list never emitted the hardware
  `CURSOR_MARKER` and the IME candidate window mispositioned — the kimi
  package README states the wrapper contract ("every wrapper owning an
  Input/Editor must implement Focusable") but the kimi list components
  themselves did not implement it either; the host compensates with its
  FocusForwardingFrame for the Frame layer. Both lists also expose
  `setMaxRows()` so a responsive host can lower the item window while
  preserving the live filter, selection and submenu state, and their
  render caps the selected row's description block to the grant so the
  hint always survives — on degenerate tiny grants the render keeps the
  tail (hint + trailing rows) rather than the head. SettingsList also
  exposes the `RowBudgetAware` seam: the current grant is forwarded to
  an open submenu that implements it, so nested lists (the host's /model
  pickers) reflow on resize without SettingsList knowing their type.
- Consumer: host pickers/settings overlays (mounted behind frames).
- Upstream status: absent.
- Tests: fork lifecycle/X041 suites assert the focused flag shape; the
  host-side wiring is covered by the bundle suites.
- Migration action: re-apply (getter/setter pair + SettingsList
  propagateFocus on submenu open).

### X043 — Deferred viewport input listener registration (alt screen)

- Category: `HARD_HOST_API`
- Files: `src/tui-alt-screen.ts`
- Reason: `TuiAltScreenOptions.deferViewportListener` skips the constructor
  registration of the viewport input listener; `installViewportListener()`
  (idempotent) registers it later. Input listeners dispatch in REGISTRATION
  order, and the constructor registered the viewport listener FIRST — every
  host listener installed afterwards (the app's single router, the
  unstable raw-capture stage) only saw a chunk AFTER the viewport had
  already consumed wheel/mouse events and semantic scroll keys, breaking
  the host's "a raw capture sees/consumes/rewrites ANY chunk" contract in
  fullscreen and diverging from the main screen's routing. The host
  installs its router first, then the viewport listener.
- Consumer: host `setFullscreen` (src/tui-app.ts) — router first, viewport
  second; `onBeforeViewportInput` (X028) still runs inside the viewport
  listener before its built-in keys.
- Upstream status: absent (upstream always registers in the constructor).
- Tests: "viewport listener registration order (X043)" in
  `test/tui-alt-screen.test.ts`.
- Migration action: re-apply the option + method pair; the default
  (constructor registration) preserves upstream behavior.

### X045 — Editor expanded-cursor mapping `getExpandedCursor()` (round-2 review)

- Category: `HARD_HOST_API`
- Files: `src/components/editor.ts`
- Reason: `getExpandedCursor()` maps the cursor offset into
  `getExpandedText()`'s coordinate space (every paste marker before the
  cursor grows the offset by its content length; the editor's start-snap
  keeps inside-marker cursors at the marker's start). getExpandedText is
  upstream-native but gives no cursor pairing — draft HANDOFFS (seat
  transfers via wireCursorOf) need both the text and the cursor to
  survive marker expansion, or the transferred cursor lands at the wrong
  visual position.
- Consumer: host `src/editor-seat-holder.ts` (wireCursorOf),
  HostEditorAdapter/SeatEditor optional `getExpandedCursor?()`.
- Upstream status: absent.
- 2026-09 audit robustness: `getExpandedText()` and `getExpandedCursor()`
  now share ONE single-pass marker tokenizer
  (`expandPasteMarkersSinglePass`) instead of two algorithms. The upstream
  multi-round replace re-scans the output of earlier rounds, so a paste
  whose CONTENT contains a literal marker string for a LATER paste id
  would be re-expanded — corrupting real text and desyncing the expanded
  cursor. Single-pass expansion never re-scans inserted content, and the
  text/cursor pair can never disagree about which markers expanded.
  The cursor mapping compares the RAW cursor against RAW marker
  coordinates throughout and accumulates the expansion delta separately —
  an earlier draft compared an already-expanded cursor against later raw
  marker ends, over-counting markers the cursor never passed (a cursor
  between two markers jumped past the second one on handoff). A cursor
  INSIDE an atomic marker snaps to that marker's EXPANDED end
  (`markerStart + delta + content.length` — the marker is REPLACED by the
  content, so the raw marker length must not be added; an earlier draft
  used `markerEnd + delta + content.length`, which could return a cursor
  beyond the expanded text end on a single-marker document).
- Tests: "expanded cursor mapping (X045)" in `test/editor.test.ts`,
  including the marker-collision test (a literal `[paste #N ...]` inside
  an earlier paste's content survives verbatim while the real marker still
  expands, and the expanded cursor lands at the expanded end) and the
  every-raw-position mapping test (before the first marker, inside it,
  between two markers, exactly at the second marker's start, inside it,
  after every marker — the between-markers case fails under the mixed
  raw/expanded algorithm, and the inside-marker cases fail when the snap
  formula adds the raw marker length; a snapped cursor is asserted to
  never exceed the expanded text).
- Migration action: re-apply together with the host's expanded-draft
  wiring (round-2 P1: steer/submit/getDraft/viewer wires and seat
  handoffs all carry expanded text).

### X046 — Cell-size replies consumed before input listeners

- Category: `HARD_HOST_API`
- Files: `src/tui.ts`
- Reason: `TuiBase.handleTerminalInput()` now consumes the cell-size
  response (CSI 6;H;W t) BEFORE the input listeners, alongside the OSC11
  and color-scheme replies — every terminal-owned protocol reply is
  filtered before the host/raw listeners run. Upstream consumes it AFTER
  the listeners, so a listener that consumes every chunk (a
  question/approval modal, an unstable raw capture) could swallow the
  reply and leave the cell dimensions stale — which also made the
  preHostInput contract's "capture cannot break terminal negotiation"
  claim false for the cell-size query.
- Consumer: host fullscreen image rendering (cell dimensions must update
  even while a modal owns the input path).
- Upstream status: absent (upstream consumes after the listeners).
- Tests: "consumes cell size responses BEFORE input listeners — a
  consume-everything listener cannot swallow them (X046)" in
  `test/tui-cell-size-input.test.ts`.
- Migration action: re-apply the ordering (cell-size consume before the
  listener loop).

### X044 — Protected autocomplete seam

- Category: `HARD_HOST_API`
- Files: `src/components/editor.ts`
- Reason: `requestAutocomplete`/`cancelAutocomplete` are `protected` (were
  private): the host's TuiEditor subclass drives explicit/context-gated
  completion and stale-dropdown cancellation through them. A private method
  forced the host into `as unknown as` casts that keep COMPILING through
  upstream signature changes and explode at runtime — exactly the class of
  silent breakage the re-vendor gates exist to prevent.
- Consumer: host `src/tui-editor.ts` (six former cast sites).
- Upstream status: absent (upstream keeps them private).
- Tests: "protected autocomplete seam (X044)" in `test/editor.test.ts`
  (subclass compilation + no-throw with no provider).
- Migration action: visibility change only; re-apply if upstream reverts
  it.

## Host-side relocation audit (2026-09)

Which divergences could move into the host bundle (`src/`) instead of
patching the vendored package, to ease future re-vendors. Verified
per entry against actual consumers; re-run this audit only when a
consumer actually changes.

- DROPPED as unconsumed: X013 (see its entry).
- Movable in principle, deliberately kept: X030 (a host-side copy of the
  pure `decodePrintableKey` would zero the `index.ts` delta, but the
  1-line re-export is the cheaper re-apply; the package `exports` map
  only exposes the root entry, so the host cannot deep-import).
- Movable in principle, deferred: X001/X002 (a host-owned searchable
  picker component could replace the extended fork SelectList — the host
  already wraps it heavily and upstream natively provides the
  `truncatePrimary` seam). Deferred until upstream's direction is clear:
  upstream has absorbed host-seam features before (X026
  copySelection/copyOnSelect), and a host-owned picker permanently forks
  the picker UX. Revisit if upstream rejects search/groups.
- NOT movable (no host injection point — verified): X004A/X004B/X005/X020/
  X022/X023 (editor + undo internals; no public API reaches them),
  X006/X012/X027 (consumed inside fork-exported components/providers —
  the host's `MentionProvider` wraps the fork's
  `CombinedAutocompleteProvider`, whose fd classification and fuzzy
  ordering live inside it), X007/X019 (fork-wide dispose contract;
  ScrollView/Loader timers are unreachable host-side), X008/X010/X016/X018
  (terminal/stdin and alt-screen mouse-routing internals), X009/X033/X035 (the processing happens
  between component render and the terminal write), X011/X014/X021/X031/
  X032/X034 (component/layout/wrap internals), X024 (the native
  `copySelection` callback receives only the final text — the host
  cannot tell a column-0 selection from a mid-line one without a fork
  change at least as large), X036 (the viewport input listener registers
  in the constructor, before any host listener, so the fork must let the
  events through), X028/X029 (they ARE host seams; the plumbing must
  exist fork-side).
- Long-term upgrade lever: upstream the generic improvements (X005, X006,
  X007, X008, X012, X014 cache, X016, X021, X033, X035 — all valuable to
  any pi-tui consumer), then downgrade entries to ABSORBED_UPSTREAM as
  they land.


## Removed kimi-only code (do NOT re-apply)

These were part of the kimi-code snapshot and are not in the upstream
baseline. REMOVAL CRITERIA (2026-09 audit lesson, from the PasteBurst
regression): "no host consumer" is only valid for Host-API patches.
Editor-internal bugfixes need terminal-environment coverage arguments, perf
contracts need measurements, product behaviors need explicit product
decisions. Each removal below names its criterion:

- ~~`PasteBurst`~~ — REMOVED as "no host consumer", RE-APPLIED as X038:
  the criterion was wrong for an editor-internal terminal-input bugfix.
- `inlineSlashTrigger` + inline-slash helpers (editor) — PRODUCT DECISION:
  the host chose explicit, context-gated Tab completion over kimi's
  opt-in inline `/` dropdown (default-off in kimi too).
- `setHistoryFilter` (editor) — PRODUCT DECISION (parity enhancement):
  kimi's shell-mode ↑ filters history by mode; DSH recall is mode-agnostic
  by design. Revisit only as an explicit parity feature.
- `setText(text, { preservePasteRegistry })` (editor) — SUPERSEDED: X023's
  `setTextAndCursor` prune keeps surviving markers' entries and releases
  vanished ones — a strictly better contract than the manual opt-in flag.
- `AutocompleteProvider` `additionalBasePaths` + multi-root fan-out —
  HOST API with no consumer (verified): the host's MentionProvider owns
  multi-root fan-out itself.
- `data?.["inlineSkill"]` Enter-non-submit carve-out (editor) — PRODUCT
  DECISION: DSH has no mid-prompt inline-skill token concept; slash
  commands submit on Enter by design (same as kimi's non-inlineSkill
  path).
- `getLayoutRoot()` (alt screen) — no consumer (verified).
- ~~`WIDTH_CACHE_SIZE = 4096` (utils)~~ — REMOVED as a "kimi tweak", then
  RESTORED as X039 (PERF_HOST_DEPENDENT): a perf contract's removal
  criterion is the measured benefit, not the absence of host imports;
  CJK-heavy burst re-measurement thrashes a 512-entry FIFO.
- Negative-width `repeat()` guards (text/truncated-text/markdown/editor) —
  upstream baseline retained; X032's clamp protects the entry point. The
  one `Math.max(0, end - start)` padding guard in `layout.ts`
  (`targetText`) is also a local defensive keep alongside X032 (upstream
  0.84.4 pads without the clamp).

## Acceptance (before declaring a re-vendor settled)

- `pnpm --filter @xmoon76/pi-tui test` must pass in full — any failure
  among the guarding tests above means a local divergence was overwritten
  and lost.
- `pnpm gate:pi-surface-compat` (bundle) must pass — the re-vendor
  compatibility gate for the component lifecycle contract.
- `pnpm gate:pi-vendor-diff` must pass — every local src change is covered
  by `vendor-divergences.json` and no ledger entry is stale (see the
  Machine gate section above).
