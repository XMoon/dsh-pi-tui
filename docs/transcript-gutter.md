# The transcript right gutter (width contract)

## What it is

Every transcript block renders **two cells short of the terminal's right
edge** (`TRANSCRIPT_RIGHT_GUTTER = 2` in `src/tui-app.ts`), so content never
visually collides with the terminal boundary. The gutter is a property of
the **transcript surface only** — the editor, footer, welcome card,
overlays, pickers and other chrome keep the full terminal width.

This width contract fixes the 0.3.4 disclosure / Focus /
Thinking rework, which made more components truncate to the FULL terminal
width (compact Thinking's fixed-row geometry, folded tool rows, the user
bubble's full-row background) and made the "text touches the right edge"
look prominent. The fix deliberately is NOT a global padding change and
never touches the vendored fork.

## The contract

```text
TUI terminal width
├─ welcome / chrome / editor / footer / overlay  → full width
└─ transcript surface
   ├─ right gutter: 2 cells
   └─ transcript content width (transcriptContentWidth(columns))
      ├─ user marker / bubble
      ├─ assistant bullet / markdown
      ├─ Thinking disclosure
      ├─ Focus activity
      ├─ tool / system / compaction cards
      ├─ local shell cards
      ├─ notify rows
      └─ plugin-rendered components (host-applied, never plugin-owned)
```

- `transcriptContentWidth(width) = Math.max(1, Math.floor(width) - 2)` —
  never 0/negative, so a 1–3 cell terminal still yields 1 cell.
- `TranscriptGutterComponent` wraps every transcript block at the
  `messagesView` boundary (`rebuildMessages`); plugin-rendered components
  inherit the gutter automatically — a renderer never knows it exists.
  The wrapper is **non-owning**: `dispose()` does not forward to the
  child. The component caches (`messageComponents` / `focusActivityComponents`)
  own the child lifecycle (`pruneMessageComponents`, stale-rebuild and
  session-switch dispose them); `messagesView` is only a projection /
  mount point. The fork's `Container.clear()` disposes every child on
  every `rebuildMessages` — forwarding the dispose would kill a CACHED
  component the cache then reuses (an `ImageThumbnail` drops its loader
  subscription and never repaints on the settle).
- **Measurement == render width.** `rebuildMessages` / `refreshMessageRows`
  / `attachmentRangesOf` measure every transcript component at
  `transcriptRenderWidth()` — the exact width the wrapper feeds the frame
  pass. A drift between them shifts the fullscreen click hit-map, the
  image-attachment spans and the Focus disclosure rows by one line.
- Components keep their own inner layout math (bullet prefix, Focus indent,
  bubble marker) and never subtract the gutter again — no double
  subtraction.

## Rules

- The gutter is applied by **reducing the layout width** passed to the
  child (`child.render(width - gutter)`), never by appending two spaces to
  rendered rows — appended spaces cannot make Markdown/tables/diffs wrap
  earlier and would desync the row geometry from the hit-map.
- Folded rows (Thinking compact, tool/system/compaction previews, local
  shell previews) truncate at the transcript content width at build time,
  so the baked lines fit the paint width exactly and never wrap into a
  second row.
- The max-tokens truncated marker is truncated to the content width and
  wrapped in the gutter boundary too: it is exactly ONE row on any
  terminal. Its row is charged to the message's hit height (+1) — a wrap
  would add framebuffer rows the hit-map does not count and shift every
  click below it.
- The width cache identity is SCOPED: `MessageComponentEntry.builtWidth`
  is recorded only for width-BAKING host builds (folded
  system/compaction/tool cards). A terminal width change rebuilds those
  entries at the new content width (the resize latch in
  `syncSurfaceGeometry`), so a stale truncation never wraps at the new
  paint width — while render-time width-aware builds (markdown, bubbles,
  Thinking compact, PLUGIN views) stay cached: a resize never re-runs a
  plugin renderer for unchanged content (the renderer-cache contract,
  plan §23).
- Narrow terminals: existing fixed-row geometry tests must assert
  `visibleWidth(row) <= transcriptContentWidth(terminalWidth)`, never
  `<= terminalWidth - 2` (that is ≤ 0 at 1–2 cells) and never a hardcoded
  `'Think'` locator (at 8 columns the compact title truncates to
  `▸ Thi…`).
- Fullscreen clicks must use a different cell for consecutive clicks (the
  alt screen treats a fast same-cell repeat as a double-click word
  selection) — this predates the gutter but bites resize tests harder once
  rows re-derive at narrower widths.

## Why not the alternatives

- A per-component `width - 2` patch (only Thinking, only tool cards) would
  leave the rest of the transcript touching the edge — this is a surface
  contract, not a card fix.
- Changing the fork's `Text`/`Markdown`/`Container`/`TuiMainScreen` would
  change the editor, footer, overlays and third-party consumers — the wrong
  abstraction layer.
- Overwriting the rightmost two columns with spaces is a repaint hack that
  never changes the real wrap geometry.
