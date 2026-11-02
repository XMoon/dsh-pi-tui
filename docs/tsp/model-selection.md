# Model selection in the experimental TSP renderer

`/model` has PiTui and native TSP presentation adapters. Direct and PiTui remain
the production defaults; TSP keeps the experimental opt-in described in
[overview.md](./overview.md). This document owns the current TSP `/model`
product contract and the single read/write owner.

The composer carries ONE combined Model / Reasoning Effort control, and the
registered `/model` command carries TWO native presentations of the same
directory:

1. **Quick menu** — the anchored composer selector; a selection commits
   immediately for a live Session.
2. **Full panel** — the Owner-frozen TWO-page UX: **Models** (the working
   catalogue) and **Full details** (the read-only Reader), with the explicit
   `Switch` / `Save default` footer action.

On the full catalogue the user picks a model, changes its Reasoning Effort in the
catalogue's own native `strip`, and commits once from the explicitly labelled
footer action. A row activation (`Enter`, or a click on the already-highlighted
row) opens that model's Full details DIRECTLY, with no intermediate page.

## Composer quick menu

- The trigger is ONE button labelled from the committed Status projection: the
  model name plus the effective Reasoning Effort. With no model it reads
  `Model`; with no effort NO empty effort slot is reserved and no value
  (`Default`/`High`/`Off`) is invented. The tooltip carries the complete
  sanitized model and effort facts, never a truncated display value.
- The menu belongs to the trigger's own positioning container and floats up from
  it, right-aligned with the button. It MAY cover the editor's prompt area, and
  it occupies no layout height: the Composer box, the caret and the transcript
  scroll position do not move when it opens or closes.
- Root order is fixed: `Model`, then `Reasoning Effort` — present only when the
  current model really advertises candidates — then the independent, non-scrolling
  footer `All models & details…`. Nothing else joins the root: no settings,
  refresh or confirmation row.
- The Model page is a searchable list in the directory's own provider order with
  one row per `(provider, model)` pair, so the same model id advertised by two
  providers stays two rows. Only the list body scrolls; Back, the native search
  field and the footer stay fixed. The search is a display filter over the rows
  the command read: it never changes the offered set, and a search that matches
  nothing says so instead of selecting an invisible row.
- The Effort page lists exactly the current model's advertised candidates, read
  from the same directory DTO. The provider-default candidate submits an ABSENT
  `reasoningEffort` field, never a sentinel string, and a model with no reasoning
  metadata has no Effort page at all.
- Choosing a row that differs from the committed value is one Session write,
  committed through the same command owner as the full panel's footer action and
  reported by the same semantic settlement. Choosing the committed model or the
  committed effort is a dismissal with zero writes; a model switch never inherits
  the previous model's effort — the payload comes from the target model's own
  advertised candidates and declared default.
- Before a Session exists the trigger opens the FULL panel with its explicit
  `Save default`; the quick selector never offers an immediate global-default
  write. The command decides this from the Session scope it captured, not the
  renderer from a display snapshot.
- While a write is in flight the menu shows only that pending state: no second
  dispatch from a click, `Enter` or a double click, and `Esc` neither cancels the
  dispatched write nor restates an older result. `committed`, `indeterminate` and
  `superseded` dismiss the panel; `rejected`, `cancelled` and `unsupported`
  restore the page the user was on. Only the command's own notices describe the
  outcome, and the Composer label is re-projected from the authoritative Status —
  never from what the menu was clicked on.
- Keys belong to the menu while it is open: `↑`/`↓` move the candidate highlight,
  `Enter` activates the highlighted row (it never sends the Composer draft),
  `Tab`/`Shift+Tab` walk `Back → Search → Options → Full` (or
  `Rows → Full` on the root), and typing edits only the menu's own query. The
  draft and its UTF-16 caret are unchanged across the whole open/close cycle, and
  closing returns the caret to the Composer. `Esc` clears a non-empty search
  first, then returns subpage → root → closed, and is never an Agent cancel.
  `Ctrl+C` revokes the menu's interaction identity and still reaches the original
  cancel owner.
- The quick menu is never expanded together with the Permission menu, and every
  higher seat (the modal seat, the temporary Screen, the Work Hub, the Session
  Browser, the Preset picker and the full Model panel) retires it synchronously
  before it paints. Hydration, a new presentation scope and disposal revoke it
  too, so no older read, click or write settlement can paint or act on the newer
  subject.

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
- Its groups are Identity, then Configuration when the subject has configuration
  facts, then Description when the model advertises one. Where the pane negotiated
  the `kv` kind, each of the two labelled groups paints as ONE aligned grid and the
  Description stays a standalone complete wrapped text; where it did not, the same
  labelled facts are the original muted-label line over the complete value line.
  The layout is a display choice only: the fact set, its order, its values and the
  group boundaries are identical either way, a grid value is never ellipsized or
  pre-split by the app, and a missing `kv` kind never drops a fact, refuses the
  Reader, adds a duplicate text copy of a gridded fact, or changes the write path.
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
- **Quick-menu container and search field:** the panel serial only, so a repaint
  never remounts the scroller (losing the list position) or the search field
  (losing the caret).
- **Quick-menu action rows (options, Back, Full, Retry):** panel serial + frame
  revision + paint token. A token from an older frame is not in the current view,
  so the SDK drops a lagging click before the app sees it; the surviving intent is
  then re-checked against the rows the current frame really offers, and a raw
  provider/model identity never enters an HTML key.
- **Keyboard Esc:** state-dependent by the Model product contract.

Every action must re-check the current subject (panel/phase/target/revision)
before mutating. A stale action is refused, not applied to the current row.

## Writing

The full panel's write path is exactly one explicit action (`Switch` for a live
Session, `Save default` for the sessionless global default), committed through
the existing Host/Client writer; the composer quick menu commits the same
semantic operation directly for a live Session (see *Composer quick menu*).

- On the full catalogue, selecting a model or an effort only changes the
  draft/candidate; nothing is written until the explicit footer action.
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

Full panel:

| Key | Effect |
|---|---|
| `↑`/`↓` | Move the catalogue highlight |
| typing / Backspace | Edit the catalogue search |
| `Tab` | Enter the effort strip / move between its regions |
| `←`/`→` | Select an effort candidate |
| `Enter` on a row | Open Full details |
| `Enter` on the explicit footer action | Commit the one write |
| `Esc` | Back from Full details; cancel the catalogue |

Composer quick menu:

| Key | Effect |
|---|---|
| `↑`/`↓` | Move the current page's candidate highlight |
| `Enter` | Activate the highlighted row (never send the draft) |
| typing / Backspace / `←`/`→` | Edit the menu's own search field |
| `Tab` / `Shift+Tab` | Move between the menu's regions |
| `Esc` | Clear the search; then subpage → root → closed |
| `Ctrl+C` | Revoke the menu and reach the original cancel owner |

A full-panel row activation never writes: `Enter` on a highlighted row opens the
Reader, and the write is only the labelled footer action. In the quick menu a
selection IS the commit, for a live Session only.

## Loading, errors, retry

- Loading paints the catalogue shell without fabricating rows; the quick menu
  states `Loading models…` and offers no directory-derived value.
- A provider-failure row is an inert failure row, not a model; the quick menu
  keeps the usable provider groups and states the failed provider beside them.
- An empty catalogue is shown as no models; it is never filled from a
  hard-coded list.
- A read failure paints an explicit Retry; the page stays usable and the draft
  survives where applicable. One Retry is one request to the command's read
  owner, never a second reader.
- A resolved write outcome is reported by the dock notice on any page that
  cannot host a picker `message`; a read failure or write outcome on the Reader
  is its leading line.
- Outcomes leave the picker on the page it was on, with its draft intact, and
  report through the dock notice; indeterminate outcomes close it with the
  original reconciliation notice.
- Hydration/disposal retire the picker and the quick menu synchronously;
  receivers bound to a previous panel serial and presentation revision are never
  routed again.

## Ownership and lifecycle

`src/app/command/model-presentation.ts` is the narrow Client-local presentation
contract carrying the open-time subject, apply/retry entries and the panel
handle. Its optional quick variant is a PRESENTATION choice only: it receives the
same request object, and `apply`, `retry`, `isCurrent` and `runOwned` stay the
command's own. `src/tui/commands/models.ts` is the singular read/write owner: it
captures Session scope, loads the directory once per read, brands effort ids,
tracks default-save intentions and admits live selection through the existing
writer — for the full panel and the quick menu alike, from one handler body. The
quick menu is a temporary panel of the mounted renderer, not a fifth business
presenter and not a second catalog, writer or subscriber. PiTui and TSP renderers
share the same projection; neither owns a second catalogue/writer.

## Limits

- Enlarged UI fonts at the wide layout, `PageUp`/`PageDown` through the client's
  control channel, physical wheel/trackpad, IME, OS focus, the real OS window's
  dark-mode chrome, terminal scaling, directories beyond the scripted sizes,
  full-profile/HMR and the Remote TSP success path are outside the headless
  contract; only a specific run may claim them.
- **Owner-accepted limitation:** at a 400px-wide pane with an enlarged UI font
  (+25%/+50%) the client truncates the selected model/provider/effort
  information. The action remains visible and enabled; the Owner accepts the
  limitation and no geometry-based write guard is added. This waiver does not
  apply to the default-font 400px layout, normally supported widths, an
  incorrect selection or a duplicate write.
- The +25%/+50% matrix and the exact sheet-density breakpoint are not claimed as
  passing.
- The quick menu's own sizes are fixed CSS limits inside the trigger's anchor
  (no measured re-layout, no geometry state machine). The verified pane sizes are
  the documented product sizes below; a smaller window or a larger UI font is not
  claimed as passing.

## Real-pane verification

Reproducible runs (headless Tern pane; not part of `pnpm test`/CI):

```sh
node scripts/tern-pane-drive.mjs scripts/tern-pane-model-ux.mjs
node scripts/tern-pane-drive.mjs scripts/tern-pane-composer-model-quick-ux.mjs
```

The flow/subject scripts mount the PRODUCTION presenter over one official inline
surface and send real input; containment claims go through the visibility oracle
(`scripts/tern-pane-geometry.mjs`), never a node's own rect. The quick-menu flow
additionally asserts the anchor distance from the trigger and that the Composer
and editor layout boxes do not change while the menu is open. See
[the harness guide](../guides/tern-pane-testing.md) for run preconditions and
evidence rules.
