# Preset selection in the experimental TSP renderer

`/preset` has PiTui and native TSP presentation adapters. Direct and PiTui remain
the production defaults; TSP keeps the experimental opt-in described in
[overview.md](./overview.md).

The Preset surface is TWO pages:

1. **Catalogue** — ONE native cards picker whose footer carries the native
   business buttons (the panel's only writer).
2. **Details** — ONE read-only page (identity, complete description, a shipped
   preset's official Mode guide inline, a native Back navigation row).

## Catalogue

ONE native `ui.picker` with `size:'md'`, `layout:'cards'` and no preview region.
The cards layout gives each card's detail its own line; there is no
two-column grid, no breakpoint and no second keyboard contract.

- Cards are ordered Built-in first, then Custom; each group keeps the roster's
  own order and is a real `PickerGroup` with its count.
- Each card carries the preset's name, classification and a one-line summary
  (`No description.` when none is published). A declaration that cannot compose
  a session keeps `Custom · Failed to load: <reason>`, an error dot and a
  `Failed to load` badge; it stays browsable/readable but can never be written.
- The raw preset id rides the card's `title` and is complete on the Details
  page. The shipped presets keep their fixed English copy; a user declaration
  reusing a shipped id keeps its own name and is classified Custom — never
  silently relabelled and never given the official guide.
- The committed state is stated by the cards' native badges (`Current`,
  `Next session`, `Default`, `Draft`) at every width and in full on Details.
  The ready-phase picker paints no status text (`lead`/`message` unpainted, the
  subtitle becomes the header tooltip), so the write-scope sentence lives on
  Details.

| Badge | Source | Shown when |
|---|---|---|
| `Current` | the live Session's preset (`runner.currentPreset()`) | the card IS that preset |
| `Next session` | the run-local pending preset | a sessionless subject, on the pending card |
| `Default` | the effective new-session default | the card IS that preset |
| `Draft` | the browse target | the browse target is none of the above |

A sessionless panel never fabricates `Current`; a live panel never invents
`Next session`.

## Footer — the ONE writer

The footer is the client's own action bar with exactly the native business
buttons:

```text
[Close]            [Set default] [Use next]
 dismiss            secondary       primary
```

- `Close` is the panel's dismissal authority — the same intent as `Esc` and the
  backdrop gesture. It never cancels an admitted write.
- `Use next` (sessionless) stages the run-local pending preset; `Use session`
  (blank live Session) commits the durable in-session selection. It is
  `primary`.
- `Set default` (also `primary`) commits the new-session default.
- `primary` is a VISUAL grouping flag only: the client packs non-primary entries
  left and primary entries right in array order. The wire order is
  `Close, Set default, Use*`; the painted order is asserted against the client,
  never inferred from the wire.

A footer entry that cannot act is disabled with its reason as the SDK
`disabled` string (`Already the default`, `Settings unavailable`,
`Preset failed to load`, `No preset selected`). The client greys it and exposes
the reason as the tooltip; it paints no in-place reason text, so the load-bearing
statements are the card badges/details and the Details facts. The same
availability decision is consumed by the one admission point, so a greyed entry
cannot write through the key map, a pointer click, a bound `onClick` or a
synthetic action.

The focused entry carries the design language's `Verb [Enter]` cue only while
Enter really runs it (the footer's arrows walk the enabled ring; `Tab`/
`Shift+Tab` toggle the `list`/`actions` zones). An admitted write or a running
read offers only `Close`; a failed read swaps the writes for `Retry` (primary)
plus `Close`.

## Details

A card activation (`activate` or `Enter`) replaces the picker with ONE native
`lg` overlay describing the selected preset. It is strictly READ-ONLY: no
footer, no operation rows, no second writer. It carries the identity facts, the
complete description, the load-failure reason where relevant, and — for a
shipped preset only — the official Mode guide inline. A user declaration never
receives the official guide.

The way back is a native `ui.row({onClick})` navigation row bound to the same
`back` intent as `Esc`. No stylesheet is used on this layer: the client paints
no stylesheet border/background on an `el` button. The Back row is the first row
of the scrollable body; after scrolling to a long value's tail it is outside the
viewport, so `Esc` remains the way back. A `scroll` op can only name a node the
current frame really built.

## Writes

`Use*` and the typed `/preset <id>` verb both run the ORIGINAL
`applyPresetSelection` with the scope the panel was opened on:

- Without a Session it stages the run-local pending preset and creates nothing.
- With a live blank Session it enters the existing session-transition gate and
  commits the Host's durable `agent-preset/selected` selection. The Host's blank
  check stays the final authority, so a Session that started while the panel was
  open is refused with the original `agent-preset/locked` outcome.
- A STARTED Session never gets a selectable picker; the bare `/preset` path
  notifies the refusal (pointing at `/new` or `/preset default`) and returns an
  error. `/preset status` stays a read. Blankness comes from the Host
  turn-boundary authority, never the TUI transcript; an unknown blank state
  opens the picker and lets the Host decide.

`Set default` and the typed `/preset default <id>` verb call the SAME extracted
writer: validate through `presets.resolve`, write through the existing Config
owner, and refresh the standing catalog only when no higher-precedence override
masks the new default. It affects future Sessions only; it never recomposes the
current Session and never rewrites the run-local pending preset. The Config
write is an awaited settings mutation, not a `WriteOutcome`, so a raise is
reported transparently as UNCONFIRMED — never as a proven rollback and never
retried automatically; the panel dismisses and the next read is authoritative.

Browsing, searching, activating a card and reading Details only change local
presentation state. Closing never cancels an admitted business operation.

A settlement that arrives after the panel's captured subject moved commits no
frame and takes no close decision; the fence retires that panel on its next
touch, and the renderer's hydration frame drops the rendered layer. A settlement
from a panel a newer invocation already replaced never closes or repaints the
new one, and a late roster read/failure never hydrates a moved subject. Notices
are fenced by the same two markers: the operation token owns the write
settlement; the presentation token owns the display.

## Loading, errors and retry

- The panel mounts immediately in its loading state and the roster read runs as
  owned background work through the command's single read owner. A running read
  admits the search box and `Esc` only, offers dismissal alone, and keeps the
  previous cards until the new read arrives.
- An empty roster is a readable state (`No agent presets configured.`), never a
  silent "take the first card". A search that matches nothing paints no card/group
  and disables both writes (`No preset selected`).
- A failed read shows the native error state with the failure text and `Retry`
  (primary, beside `Close`), which re-enters loading through the SAME read owner
  (one read in flight). The failed phase has exactly ONE operable region — that
  footer — and its search box stays editable, so the Esc ladder still clears a
  non-empty query before closing.
- Supersession is explicit: every `/preset` invocation takes the panel's
  presentation token, so a newer invocation retires whatever panel the previous
  one had open while an already-admitted Host write still settles through its
  own owner. Hydration/disposal retire the panel synchronously; a late roster
  read can never reopen it.

## Identity and lifecycle

- The picker, its layer and the footer keep ONE identity for the panel's life:
  their keys carry the panel serial, so a highlight, notice or repaint never
  remounts the list or re-anchors its scroll position. A stale footer action is
  fenced by the frame token in its id (`use#<revision>`, `set-default#<revision>`,
  `retry#<revision>`); `close` is deliberately untokened.
- The Details page takes ONE identity per READING: the overlay, Back row and
  scrolling body carry the panel serial plus the reading epoch, fresh on every
  entry. A re-render within one reading changes nothing; a queued `scroll` from
  a previous reading can never address the next one's body.
- No stylesheet exists on this layer. The way back is the native navigation row.

## Ownership

`src/app/command/preset-presentation.ts` is the narrow Client-local presentation
contract carrying the open-time subject, the apply/set-default entries and the
panel handle. `src/tui/commands/models.ts` is the singular read/write owner: it
captures Session scope, runs the one roster read, keeps the operation token and
calls the original `applyPresetSelection` / default writer.

## Limits and verification

Physical GUI, IME, the real OS window's dark-mode chrome, enlarged fonts,
physical wheel/trackpad, the Remote TSP preset path and any pane size not
actually run are not claimed. The client's own light/dark rendering is
headless-testable via the `appearance` command.
A real-pane run is a headless client; it says nothing about OS input methods or
desktop font resolution. Layout parameters measured on one client build are not
universal no-clipping guarantees; reachability is the contract.

```sh
node scripts/tern-pane-drive.mjs scripts/tern-pane-preset-ux.mjs
```

See [the harness guide](../guides/tern-pane-testing.md) for run preconditions,
visibility-oracle rules and evidence tiers.
