# Model selection in the experimental TSP renderer

`/model` has PiTui and native TSP presentation adapters. Direct and PiTui remain
the production defaults; TSP keeps the experimental opt-in described in
[overview.md](./overview.md). This document owns the current TSP `/model`
product contract and the single read/write owner.

The Owner-frozen Model UX is TWO pages, both the model's own:

1. **Models** — the working catalogue.
2. **Full details** — the read-only Reader.

On the catalogue the user picks a model, changes its Reasoning Effort in the
catalogue's own native `strip`, and commits once from the explicitly labelled
footer action. A row activation (`Enter`, or a click on the already-highlighted
row) opens that model's Full details DIRECTLY, with no intermediate page.

## Catalogue

The catalogue is ONE native picker at every pane width: a single column of model
rows, no provider sidebar, no side column, no preview region. There is no global
action menu, no global operation block and no second-level effort menu; the ONE
Reasoning Effort editor is the catalogue's strip.

- The catalogue is ordered with a pinned `Current · Default` group first, then
  each configured provider's models in its own order.
- A row carries the model's name as its own label (never a caption), a provider
  mark, real lowercase `current`/`default` state chips, and the complete model id
  in its `title`.
- Search filters the same rows; it never changes the offered set's authority.
- The row identity (`mark`, `badges`, `title`, `facts`/`columns`) is a client
  capability; the presenter does not guess it from props.
- The strip lists every Reasoning Effort candidate at every width. Its chips
  wrap rather than scroll when the pane is narrow.
- The catalogue asks for the client's `size:'md'` dialog at every width. A pane
  narrower than the client's own cap is unchanged by that choice; an `lg` sheet
  would fill most of a wide pane. These are client/build layout parameters, not
  a universal no-clipping guarantee.

## Full details Reader

The Reader is a read-only native overlay:

- It carries each value ONCE; the client wraps it at the layout's real width, so
  no app-side bound clips it.
- The app drives the native scroll container with the SDK's `scroll` op for the
  body node it actually built; it resolves that node's wire id from the rendered
  frame, never by guessing. There is no scroll position, cursor or height mirror
  in the app.
- `Tab` is a consumed no-op because the page paints exactly ONE region.
- The one interactive node is a visible `Back` row bound to the same `back`
  intent as `Esc`, so Back and Esc can never disagree. The catalogue enters the
  Reader and is where it always returns, across resize and re-read. The Back row
  is the first row of the scrollable body; after scrolling to a long value's
  tail it is outside the viewport, so `Esc` is the way back from the tail.
- The Reader carries no candidate, no draft and no writer.
- A scroll op inherits the SDK credit/queue boundary: when a frame credit is
  blocked and a repaint intervenes, one scroll keypress can be delivered against
  a body the client never received and be rejected; that single keystroke is
  dropped. Do not add a second scroll queue, ACK watchdog or retry.

## Identity and admission namespaces

Do not use one broad "stable id" rule:

- **Picker/layer key:** stable for one panel (`panel.serial`). A per-revision
  Picker key was measured to remount the client and move the viewport; preserving
  the panel key kept row coordinates stable.
- **Reader body/Back:** a separate epoch per new reading.
- **Mutating/read-operation action ids:** revision-tokened (`apply#<rev>`,
  `retry#<rev>`). `close` is untokened for dismissal.
- **Picker row events:** validate the current offered row and page.
- **Effort strip items:** the composite candidate id validates both the
  originating model and candidate, so a delayed chip click cannot draft a
  different model.
- **Keyboard Esc:** state-dependent by the Model product contract.

Every action must re-check the current subject (panel/phase/target/revision)
before mutating. A stale action is refused, not applied to the current row.

## Writing

The write path is exactly one explicit action (`Switch` for a live Session,
`Save default` for the sessionless global default), committed through the
existing Host/Client writer:

- Selecting a model or an effort only changes the draft/candidate; nothing is
  written until the explicit footer action.
- A live Session model selection is a Session WRITE: it dispatches inside the
  writer barrier; a transition that started first refuses it, a transition that
  starts after waits for it.
- The picker enters an in-place `Selecting…` state (a duplicate apply is never a
  second commit); the footer shows `(selecting…)` over the authoritative current
  value.
- The outcome drives presentation: `committed` follows the authoritative
  projection; `rejected`/`cancelled` returns to the list with the Host refusal;
  `indeterminate` dismisses without retry and never claims the requested model.
- Sessionless `/model` writes the Host global default and is awaited before a
  fresh create; a failed latest intent is walked back in the UI and is never
  seeded into create. The sessionless marker derives from that one intent tracker.
- No blind retry: an unknown post-dispatch outcome is reconciled by
  authoritative reread, never claimed as success.

## Keyboard

| Key | Effect |
|---|---|
| `↑`/`↓` | Move the catalogue highlight |
| typing / Backspace | Edit the catalogue search |
| `Tab` | Enter the effort strip / move between its regions |
| `←`/`→` | Select an effort candidate |
| `Enter` on a row | Open Full details |
| `Enter` on the explicit footer action | Commit the one write |
| `Esc` | Back from Full details; cancel the catalogue |

A row activation never writes. `Enter` on a highlighted row opens the Reader;
the write is only the labelled footer action.

## Loading, errors, retry

- Loading paints the catalogue shell without fabricating rows.
- A provider-failure row is an inert failure row, not a model.
- An empty catalogue is shown as no models; it is never filled from a
  hard-coded list.
- A read failure paints an explicit Retry; the page stays usable and the draft
  survives where applicable.
- A resolved write outcome is reported by the dock notice on any page that
  cannot host a picker `message`; a read failure or write outcome on the Reader
  is its leading line.
- Outcomes leave the picker on the page it was on, with its draft intact, and
  report through the dock notice; indeterminate outcomes close it with the
  original reconciliation notice.
- Hydration/disposal retire the picker synchronously; receivers bound to a
  previous panel serial and presentation revision are never routed again.

## Ownership and lifecycle

`src/app/command/model-presentation.ts` is the narrow Client-local presentation
contract carrying the open-time subject, apply/retry entries and the panel
handle. `src/tui/commands/models.ts` is the singular read/write owner: it
captures Session scope, loads the directory once per read, brands effort ids,
tracks default-save intentions and admits live selection through the existing
writer. PiTui and TSP renderers share the same projection; neither owns a second
catalogue/writer.

## Limits

- Enlarged UI fonts at the wide layout, `PageUp`/`PageDown` through the client's
  control channel, physical wheel/trackpad, IME, OS focus, dark themes, terminal
  scaling, directories beyond the scripted sizes, full-profile/HMR and the Remote
  TSP success path are `NOT_VERIFIED` unless a specific run proves them.
- **Owner-accepted limitation:** at a 400px-wide pane with an enlarged UI font
  (+25%/+50%) the client truncates the selected model/provider/effort
  information. The action remains visible and enabled; the Owner accepts the
  limitation and no geometry-based write guard is added. This waiver does not
  apply to the default-font 400px layout, normally supported widths, an
  incorrect selection or a duplicate write.
- The +25%/+50% matrix and the exact sheet-density breakpoint are not claimed as
  passing.

## Real-pane verification

Reproducible run (headless Tern pane; not part of `pnpm test`/CI):

```sh
node scripts/tern-pane-drive.mjs scripts/tern-pane-model-ux.mjs
```

The flow/subject scripts mount the PRODUCTION `TspModelPicker` over one official
inline surface and send real input; containment claims go through the visibility
oracle (`scripts/tern-pane-geometry.mjs`), never a node's own rect. See
[the harness guide](../guides/tern-pane-testing.md) for run preconditions and
evidence rules.
