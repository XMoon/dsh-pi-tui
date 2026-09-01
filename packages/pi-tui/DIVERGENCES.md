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

## Divergences

### X001 — SelectList searchable/grouped picker (was #1)

- Category: `HARD_HOST_API`
- Files: `src/components/select-list.ts`
- Reason: `SelectList` gains an optional 5th constructor argument
  `SelectListOptions` (`enableSearch`, `header`, `noMatchText`, `showHint`,
  `initialQuery`), `SelectItem.group` + `SelectListTheme.groupHeader`,
  PageUp/PageDown page navigation, and substring search over
  value+label+description. `setFilter` is redefined to the same
  case-insensitive substring filter (upstream prefix-matched value only).
  Upstream 0.84.4 still has none of these.
- Consumer: host `/sessions` picker, model picker, category picker,
  autocomplete compact picker, dynamic title enrichment.
- Upstream status: open upstream PRs exist but are not part of the pinned baseline.
- Tests: "search", "group headers", "page keys", and "setFilter without
  search (X001 navigation bounds)" describes in `test/select-list.test.ts`.
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
- Files: `src/tui.ts`, `src/components/scroll-view.ts`, `src/components/text.ts`, `src/components/loader.ts`
- Reason: `Component` gains an optional `dispose()`; `Container.removeChild`/
  `clear`/`dispose` release child resources; `ScrollView` disposes its hide
  timer and render callback; `Text` gets a no-op `dispose()`; `Loader`
  disposes its animation timer. Upstream 0.84.4 has no `dispose` anywhere.
- Consumer: host pi-surface-compat gate (`test/pi-component-compat.test.ts`:
  close idempotent, dispose exactly once, surface disposal invalidates old
  leases, fullscreen migration keeps one live adapter) and the extension
  lifecycle (unstable mounts, overlay leases).
- Upstream status: absent.
- Tests: `test/pi-component-compat.test.ts` (bundle), ScrollView/layout
  describes in `test/layout.test.ts`.
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

### X013 — `setIndicator` never revives a stopped loader (was #13)

- Category: `BUGFIX_MISSING_UPSTREAM`
- Files: `src/components/loader.ts`
- Reason: setting the indicator on a stopped loader leaves it stopped.
  Upstream 0.84.4 unconditionally restarts the animation.
- Consumer: host busy indicator lifecycle.
- Upstream status: absent.
- Tests: none dedicated.
- Migration action: re-apply.

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
- Consumer: host surface restart (fullscreen toggle re-starts the terminal).
- Upstream status: absent.
- Tests: "repeated start() calls swap the resize listener instead of
  stacking it" in `test/terminal.test.ts` (X016 regression: two consecutive
  `start()` calls must leave exactly one listener and fire only the second
  handler).
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
- Files: `tsdown.config.ts`
- Reason: tsdown discovers configs by walking up from the CWD; the root
  bundle's `tsdown.config.ts` would shadow this package's build. The config
  reproduces the tsdown defaults (entry `src/index.ts`, ESM, `dist/`,
  declarations).
- Consumer: package build (`pnpm --dir packages/pi-tui build` must produce
  `dist/index.mjs` + `dist/index.d.mts`).
- Migration action: keep the XMoon shell; do NOT copy the upstream
  package.json / tsgo contract.

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
- Files: `src/tui-alt-screen.ts`
- Reason: `onScrollBoundary` reports final unconsumed wheel/page/primary-
  scrollbar edge attempts, `onBeforeViewportInput` lets a host claim semantic
  viewport keys before built-in Home/End/Page handling, and `clearSearch()`
  lets a host reset the built-in fullscreen transcript search. Upstream
  0.84.4 has none of these.
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

## Removed kimi-only code (do NOT re-apply)

These were part of the kimi-code snapshot but have no host consumer and are
not in the upstream baseline. They are intentionally dropped by the Earendil
re-vendor:

- `PasteBurst` + `disablePasteBurst`/`setDisablePasteBurst` (editor) — no host consumer.
- `inlineSlashTrigger` + inline-slash helpers (editor) — no host consumer.
- `setHistoryFilter` (editor) — no host consumer.
- `setText(text, { preservePasteRegistry })` (editor) — no host consumer.
- `AutocompleteProvider` `additionalBasePaths` + multi-root fan-out — no host consumer.
- `data?.["inlineSkill"]` Enter-non-submit carve-out (editor) — no host consumer.
- `getLayoutRoot()` (alt screen) — no consumer.
- `WIDTH_CACHE_SIZE = 4096` (utils) — kimi tweak; upstream 512 is retained.
  With X035's reuse fast path the cold-path width measurements are bounded
  to changed lines, so the larger FIFO is not needed.
- Negative-width `repeat()` guards (text/truncated-text/markdown/editor) —
  upstream baseline retained; X032's clamp protects the entry point. The
  one `Math.max(0, end - start)` padding guard in `layout.ts`
  (`targetText`) is also a local defensive keep alongside X032 (upstream
  0.84.4 pads without the clamp).

## Acceptance after syncing from upstream

- `pnpm --filter @xmoon76/pi-tui test` must pass in full; any failure among
  the guarding tests above means a local divergence was overwritten and lost.
- `pnpm gate:pi-surface-compat` (bundle) must pass — the re-vendor
  compatibility gate for the component lifecycle contract.

## Final status after the v0.84.4 re-vendor (2026-09)

- `KEEP` (re-applied on the Earendil v0.84.4 base): X001, X002,
  X004A, X004B, X005, X006, X007, X008, X009, X010, X011, X012, X013,
  X014 (measurement cache ONLY — the scrollbar thumb clamp is already in
  upstream 0.84.4, see the entry's scope note), X016, X018, X019, X020,
  X021, X022, X023, X024, X027, X028, X029, X030, X031, X032, X033, X034,
  X035 (per-frame processed-line reuse — restored after the PR-review
  benchmark showed a 100-500x per-frame regression without it), X036
  (FOCUS passthrough — restored; app-level listeners are a live host
  seam, not a kimi-only leftover).
- `ABSORBED_UPSTREAM`: X015 (dead `_lastEventType` — upstream baseline
  restored), X017 (regular mode owns no mouse — upstream baseline),
  X026 (copySelection/copyOnSelect — upstream 0.84.4 native).
- `PACKAGING_ONLY`: X025 (tsdown config — XMoon shell kept).
- `REMOVED_UNUSED` (kimi-only, no host consumer; X003 is removed
  because the old "fix" was a code-unit/grapheme mismatch defect — see the
  entry): PasteBurst,
  inlineSlashTrigger, setHistoryFilter, preservePasteRegistry,
  additionalBasePaths, inlineSkill data, getLayoutRoot,
  WIDTH_CACHE_SIZE 4096. (Defensive negative-width `repeat()` guards are
  dropped in text/truncated-text/markdown/editor; `layout.ts` retains one
  local `Math.max(0, end - start)` `targetText` padding guard alongside
  X032's entry-point clamp — the scrollbar thumb clamp itself is upstream
  baseline.)
