# Model selection in the experimental TSP renderer

The existing `/model` command has PiTui and native TSP presentation adapters.
This is the PR4-A implementation plus its **list-first** UX revision, not a
completed PR4 milestone: Direct and PiTui remain the production defaults and TSP
keeps the experimental renderer opt-in described in
[TSP integration](../tern-tsp.md).

The Owner-frozen Model UX is the three-page task flow **Models → (one model's)
Overview → Full details**: pick a model, look at that model's own properties,
change its Reasoning Effort, and commit once from an explicitly labelled action.
The model catalogue is ONE native picker at every pane width — a single column of
model rows, no provider sidebar and no side column — and the ONE write is an
explicit footer action everywhere. There is **no global action menu, no action
strip and no operation block**: a page shows the operations its own model entity
offers and nothing else.

## Availability and behavior

The mounted terminal must advertise `picker`, `row` and `overlay` before the
TUI-owned `/model` command becomes available; a pane missing any of them refuses
the command before invoking its handler and keeps the submitted draft. Those are
the three kinds the presenter really constructs: the catalogue/Overview picker,
the Reader's `Back` row and the read-only Reader's overlay. The list-first
revision retired the wide details Cards, so `card` is no longer an admission
requirement. This admission follows authoritative command classification: a
genuine Host command named `model` keeps its Host route, and other PiTui-only
builtins remain unavailable in TSP.

### Pages

| Page | Title | Content | Write |
|---|---|---|---|
| `models` | `Switch model` (live) / `Choose default model` (sessionless) | the provider-grouped model catalogue, with the compact read-only summary below the list on a wide pane | **yes**, at every width |
| `overview` | `Model overview` | the highlighted model's OWN identity row, then its effort section (every advertised candidate), then its one details entry | yes |
| `details` | the model's own name | the model's COMPLETE values, grouped, in the native **Reader** (an `overlay` the client wraps at its own width and the app scrolls), read-only | **never** |

The title states what the page's ONE write really does, so there is no separate
subject slot to keep in sync with it and nothing to truncate. `overview` is the
model's OWN page, never a global menu: it always describes exactly one model, and
closing it (`Back` / `Esc`) returns to the catalogue. The read-only `details` page
is a logical page of the same flow, but it is PAINTED as the native Reader instead
of a picker (see "The read-only Reader").

### The catalogue (one list-first picker at every width)

The catalogue is ONE native picker: `layout: 'rows'`, `md` on a narrow pane and
`lg` on a wide one, `preview: 'none'` or `'below'`, and NO `scopes` column at any
width. Width decides only how much INFORMATIONAL chrome the page paints — never
what can be reached, drafted or written.

- **Rows.** ONE row per (provider, model). `label` is the model name (the main
  information), `mark` is a deterministic 1–2 character abbreviation of the
  provider's own advertised name (`{text, seed}`, never a fabricated logo),
  `detail` is the provider name, `title` is the complete model id, and `badges`
  carry the REAL `current` (a live Session fact) and `Default` (the directory
  fact) only — the browse highlight is never painted as either. The row id is the
  provider+model JSON pair, so the same model id under two providers is two
  independently addressable rows. The catalogue's ONE fact column states the
  model's **drafted effort** (and nothing for a model that advertises none), so
  the effort a user would commit is visible at the first level; the Overview stays
  the place where it is CHANGED.
- **Order.** A pinned `Current / Default` group comes first and each configured
  model appears exactly ONCE (it is not repeated in its provider's group), then
  one group per provider. No `Recent` group, no MRU and no row listed twice.
- **Partial failure.** Only while the current read reports failed providers, the
  list ends with a `Unavailable providers` group holding one inert row per failed
  provider plus the ONE read-only `Retry failed providers` row. That row is the
  phase's only operation and routes to the command's existing read owner — never
  to the writer. The client keeps a disabled row selectable (measured), so the
  app itself refuses every row shape the list does not currently offer.
- **The compact summary (wide panes only).** From a reconstructed pane width of
  `900px` (`wideCatalog`) upwards the catalogue asks for its `lg` sheet and paints
  a compact READ-ONLY summary below the list: the highlighted model's Provider,
  its drafted effort and its `current`/`Default` state as an inline `ui.kv`. It
  carries no handler, no candidate and no write, so hiding it removes information
  and nothing else — the same rows, the same ONE write and the same pages remain.
  Below the threshold the same catalogue renders `md` + `preview: 'none'`.

### The Overview

The Overview's main list, in the frozen priority order:

1. the model's own IDENTITY row: its name, with the complete model id as the row's
   `title`. It comes first because the page's caption cannot carry the identity on
   a narrow pane — the client ellipsizes a title and paints no subtitle at all at
   400 and 560px (measured) — and a user choosing an effort and committing the
   write must be able to see WHICH model they are configuring at every width;
2. the `Reasoning effort` section, carrying EVERY advertised candidate (marked
   `●` for the current draft and `○` otherwise) — or the explicit `Not available`
   statement when the model advertises none, so no phantom candidate is invented;
3. the single `View full model details ›` operation row.

The configured Current/Default state stays OUT of the list: the subtitle carries
it (`<provider> · current · Default`) where the pane paints a subtitle, and the
COMPLETE values live in the read-only Reader. One inert identity row plus the
effort section is what keeps every effort candidate on the first screen at every
width without a wall of fact rows.

Arrow keys move a ROW cursor over the page's real rows; `Enter` (or a pointer
activation) drafts on an effort row, opens the read-only Reader on the details
row, and is INERT on the identity row and on the section head — only an effort row
changes the draft and only the details row leaves the page.

### The read-only Reader (`details`)

The `details` page REPLACES the picker in the same layer with a native
`ui.overlay` (`size: 'lg'`, `modal: true`, head = the model's own name) instead of
painting a picker page:

- a picker ROW renders ONE measured line and ellipsizes what does not fit, so it
  cannot be a reading surface for a long value. The Reader renders each fact as
  its label plus ONE `ui.text({ text, wrap })` value node the CLIENT wraps at the
  width the layout really has: `char` for machine identifiers (a
  `provider/model/effort` slug or a model id may carry no break opportunity at
  all) and `word` for prose (the description and the transient notice). Nothing is
  pre-wrapped, truncated or re-derived: the value is the directory's own string,
  every explicit break it carries (LF, CRLF and a blank line alike) is rendered as
  its own line by the client, and the page never uses Markdown for a field that is
  not defined as Markdown;
- the facts are GROUPED, because a bare stack of properties reads as diagnostic
  output rather than as a product detail view: **Identity** (the complete model
  name — the overlay's own head ellipsizes a long one — then provider and model
  ID), **Configuration** (the configured `Current`/`Default`, whose values carry
  their own effort from the ONE directory DTO, and the current draft effort) and
  **Description** (when the directory advertises one). Each group is a `ui.col`
  whose muted head line and following `ui.rule` separate it, with a `lg` spacer
  between groups: a bare `ui.section` head was MEASURED to leave a SMALLER gap
  between groups than inside one (2px against 8px, while this structure measures
  20px against 2px on the same pane);
- a transient notice (a read failure, or the last write outcome) leads the page as
  its own line, so the state the facts were read in is stated where it is read;
- the overlay's body is a NATIVE scroll container, and the app owns the keyboard:
  the Reader maps `↑`/`↓`, `PageUp`/`PageDown` and `Home`/`End` onto the SDK's
  `scroll` op for the body node it really built (the renderer resolves that node's
  wire id from the frame it rendered, so no id is ever guessed). There is no
  scroll position, cursor or height mirror in the app, and `Tab` is a consumed
  no-op on this page because it paints exactly ONE region;
- its one interactive node is a visible `Back` row bound to the SAME `back`
  intent `Esc` uses, so `Back` and `Esc` can never disagree about where the page
  returns: the OVERVIEW enters it (through its own details row) and that is
  therefore where it always returns, across a resize and a re-read alike. It carries no candidate, no
  draft and no writer. The row is the FIRST row of the scrollable body, so it is
  visible at the top of the page and travels with the content: **after scrolling
  to a long value's tail the row is outside the viewport (measured), so `Esc` is
  the way back from the tail** — it is never a dead control, because the page's
  own view keys are exempt from the phase gates.

### Row, candidate and retry namespaces

The SDK delivers the list's row ids on the row channel and the action bar on the
action channel, so the two are told apart by **channel**, not by shape:

- A model row's id is the JSON provider+model pair; an effort candidate row
  carries its own `effort:` namespace; the section head (`overview-effort`), the
  details entry (`overview-details`), an inert failure row (`failure:<provider>`)
  and the one retry row (`retry-failed`) each have their own id, so no candidate
  value can be confused with a model, a head or an operation.
- A row `select` / `activate` acts only on an id the CURRENT page really renders
  (`visibleModels` on the catalogue, the Overview's own row set). The Reader has
  NO selectable row of its own (its one interactive node is its `Back` row
  dispatched as its own `onClick`), so a row event on that page resolves nowhere.
- There is no provider-scope channel at all any more: a forged
  `action { act: 'scope' }` or a scope-shaped row id resolves nowhere, because no
  page paints a scope column.
- The removed wire shapes are refused, not ignored: `details`, `effort-page`,
  `strip` (and any `strip-*` value) are not part of any page's action set, and a
  `more:<action>` row id resolves nowhere.

### Writing

Browsing (model rows, the Overview's rows) and clicking an effort row only change
local browse state — the highlight or that model's draft effort. **Only the
explicitly labelled action writes**, once:

- `Switch` for a live Session (the existing Session-model selection);
- `Save default` for a sessionless subject (the existing "confirm the model and
  save it as the future default" intent).

The provider-default sentinel submits without a `reasoningEffort`; a real effort
submits the advertised id. `Switch` / `Save default` are the same single `apply`
action id the earlier revision used, and neither operation is split in two.

The write action exists on the catalogue and on the Overview (`applyOffered`),
i.e. on EVERY pane width — the list-first revision retired the "compact list
commits nothing" rule. Its target is the HIGHLIGHTED model together with its
already-drafted effort, so a whole-model switch needs no drill-down and the
Overview is only needed to CHANGE an effort. The read-only Reader paints no action
bar at all, so no page operation can be reached from it: a forged
`action { act: 'apply' }` is refused on the wire before any state change (the same
admission the visible bar uses), and only the panel's dismissal authority
(`close`, the same intent `Esc` uses) stays admitted there. A search that matches
NO model leaves the write entry VISIBLE but disabled — the plan's "no writable
primary" is met by non-operability rather than by hiding the entry — and the
writer itself refuses a request with no highlighted model, so such an event cannot
write, change state or even re-render. A resolved
refusal/unsupported/indeterminate outcome is reported by the existing dock notice;
the native picker itself paints its `message` only in its error state, so no
content page can host an outcome banner. That is a recorded presentation
limitation, not a hidden write.

### Keyboard (K2, frozen)

The logical zones are `models` (a page's native main list) and `primary-action`
(the action bar) — the list-first shell paints exactly these two at every width,
and the read-only Reader is not a picker and has no second region at all.
`zone` is presentation-local and is never business authority. Tab and Shift+Tab
walk the two zones:

| Page / phase | Ring |
|---|---|
| `models` and `overview` | `models → primary-action` |
| `details` (the Reader) | ONE region: `Tab` is a consumed no-op |
| `pending` (admitted write) | the bar holds the keyboard (`Esc` only) |
| `loading` (running re-read) | the catalogue keeps its search box on the `models` page (everything else is refused but `Esc`); the Overview admits only `Esc`; the Reader keeps its own `Back`/`Esc`/scroll keys |
| `error` (failed read) | the bar holds the keyboard (`Tab`/`Shift+Tab` both stay there) — except on the Reader, which has no bar and keeps its own `Back`/`Esc`/scroll keys |

`Esc` is never swallowed. On a content page it is exactly the visible `Back`
(`overview → models`, `details → the Overview it was opened from` — the Reader's
own visible row and `Esc` are the same intent); inside the action bar it returns to the zone the bar
was entered from; on the catalogue it closes the panel. An admitted write, a
running (re-)read and a failed read all close.

**The Reader is the one exception, and it is deliberate.** Its `Back` row is a
VISIBLE control on a read-only page, so it is never a dead one: `Back` (and the
`Esc` that is the same intent, and the page's own scroll keys) are pure VIEW
operations that change no draft, start no read and write nothing, so they stay
available while a (re-)read merely runs or has failed — the page keeps describing
a real model and the failure is reported on it. Closing the whole panel there
would drop the page context its origin can restore. The other phases keep their
original admission exactly: an ADMITTED WRITE still owns the panel (nothing
navigates or scrolls under it), and a running read still refuses every browse,
every draft and every write.

| Zone | `↑↓` | `Tab` / `Shift+Tab` | `Enter` | `Esc` |
|---|---|---|---|---|
| `models` (catalogue) | move the row cursor over every visible model AND the retry row | → the bar | open the highlighted model's Overview, or run the retry row's read-only re-read — **never writes** | close |
| `models` (Overview) | move the ROW cursor over the section head, every candidate and the details entry | → the bar | draft on an effort row, open the details entry, inert on the section head — **never writes** | `Back` to the catalogue |
| `details` (the Reader) | `↑↓`/`PageUp`/`PageDown`/`Home`/`End` scroll the Reader's native body (also while a read runs or has failed) | — (one region) | inert — **never writes** | `Back`/`Esc` to the page it came from |
| action bar | — | → the other zone | **the only key that writes**, once, when the FOCUSED action is the enabled Primary | return to the zone the bar was entered from (a failed read closes) |

The list drives the client's highlight through the picker's own `selected` prop:
the client does NOT own list navigation (measured — arrow keys move nothing
without the app moving `selected`), so this walk is the app's and it is what makes
every visible row keyboard reachable. The action bar has NO native region at all —
`focus` names only `list`/`scopes`/`tabs`/`strip`/`preview` — and the client paints
no focus distinction on its buttons (measured: both button class lists are
byte-identical under either region focus; the client's own `f-list`/`f-preview`
region class belongs to the list/preview region, not to the bar), so the FOCUSED
action carries an app-rendered shape cue
(`▸ Switch` / `▸ Save default` / `▸ Retry` / `▸ Back` / `▸ Cancel`). A disabled
action never carries the cue, and neither does an action the current phase cannot
run from the keyboard at all (`pending`, `loading`), so the cue is always a
promise about `Enter`.

The catalogue carries exactly ONE short hint, in its `subtitle` slot:
`Enter: effort & details`. It is painted only while the phase really admits
`Enter` (a running re-read and an admitted write refuse it), it names no business
action, and no other page repeats it.

`Ctrl+C` always remains the original application cancel owner, and a
Question/Approval modal owns the keyboard before the Model panel.

### The action bar

The native action bar lays its buttons on ONE line and does not wrap them, and the
bar has no scroll port of its own, so the bar is SHORT AND FIXED and the frozen
table caps it per page: `Cancel` + the ONE write on the catalogue, `Back` + the
ONE write on the Overview, and `Cancel` + the read-only `Retry` on a failed read.
A partial failure does NOT add a third button: its context and its one read-only
operation row live at the end of the list. The read-only `details` page has NO
picker and therefore NO action bar at all: its `Back` is the Reader's own visible
row (see "The read-only Reader").

| Page / phase | Action bar (left to right) |
|---|---|
| `models`, every width | `Cancel`, `Switch` / `Save default` |
| `overview` | `Back`, `Switch` / `Save default` — **no `Cancel`** |
| `details` (the Reader) | none — the page is not a picker; its `Back` row is its own node |
| `error` | `Cancel`, read-only `Retry` |
| `loading` | `Cancel`, a disabled `Switch` / `Save default` |
| `pending` | `Close`, a disabled `Selecting…` |

`Cancel` is the visible label of the stable `close` action, and while a write is
ADMITTED it reads `Close`: closing the panel does not cancel an operation that is
already with the Host, and the label must not promise an undo the contract does
not offer. The Overview therefore carries NO `Cancel` button: a user leaves it
with `Back` (or `Esc`, the same intent) and cancels from the catalogue, which is
what keeps it inside the frozen two-entry cap. The `close` INTENT itself
stays admitted on every page, because it is the panel's own DISMISSAL authority —
the same intent `Esc` and the client's backdrop gesture use — and dismissing can
never write; only the page OPERATIONS (`back`, `retry`, `apply`) have to be really
rendered by the current bar. `Retry` is the stable `retry` action and is the only
action a failed read offers; it is read-only and re-reads through the command's
single read owner, exactly like the list's own retry row.

The action **ids** are the routing authority and stay stable: `close`, `back`,
`retry`, `apply`. The key map and the row router act on those ids, never on
display text.

### Loading, errors and retry

While the directory is loading the panel still admits the search box (frozen
§4.5: the query stays editable) and always admits `Esc`; every other key is
refused and the Primary Action renders disabled, so a loading panel can neither be
mutated nor left unable to close. The command's single directory-read owner serves
both the first read and every Retry: one in-flight read at a time, the same
`runOwned` task, captured scope, signal, presentation token and supersession
semantics.

A read failure shows the native error state with one message and makes the bar's
`Retry` the only operable entry. A failed read has exactly ONE operable region —
that bar: the stale rows stay on screen for context, but the phase browses neither
the list nor the search box and refuses `Enter`, so `Tab` and `Shift+Tab` both
stay in the bar (where `←→` moves between `Retry` and the always-enabled `Cancel`)
instead of walking the keyboard into an inert list. A partial failure keeps the
reached providers usable, lists the failed providers as inert rows under
`Unavailable providers`, and offers the ONE read-only `Retry failed providers` row
at the end of the list.

A failed read on the READER reports the failure as its own leading line and keeps
its `Back`/`Esc` working (see above); `Retry` itself belongs to the pages that
paint an action bar, so a user returns to the catalogue or the Overview to run it.

Pending saves disable every mutation entry (including the Overview's rows and the
Primary Action) and keep `Cancel` available; closing does
not cancel an admitted business operation. Rejected, cancelled and unsupported
outcomes leave the picker usable ON THE PAGE IT WAS ON, with its draft intact, and
report the outcome through the dock notice; indeterminate outcomes close it with
the original reconciliation notice. Hydration and disposal retire the picker
synchronously, and receivers bound to a previous panel serial and presentation
revision are never routed again.

## Layout threshold

The presenter knows only `SessionCaps.cols`/`cell` (the SDK reports no sheet box
and no pane height), so the pane width is RECONSTRUCTED as `cols * cell.w` and
compared against the measured `900px` (`SUMMARY_MIN_PANE_PX`). That threshold
decides ONE thing: whether the catalogue asks for its `lg` sheet and paints its
compact read-only summary. Everything else — the rows, the order, the ONE write,
the Overview, the Reader — is identical on both sides of it, which is what makes
the narrow and the wide pane the same product instead of two layouts.

The number comes from the real client (`tern 0.8.3`): with `preview: 'below'`
requested, an `888px` pane (900x400) really paints the summary while a `544px` pane
(560x640) is `pv-hide`d, so the client's own breakpoint lies between them and is
not measured exactly. `900px` is inside the region the client was measured to
paint, and it also keeps the ONE measured case where the summary squeezed the list
(an 888px pane in a 400px-tall window leaves two model rows instead of three) on
the `none` side of the line. The exact client breakpoint between 544px and 888px
stays `NOT_VERIFIED`; a pane the reconstruction classifies narrow therefore loses
only the summary, never a candidate, a page or the write.

A SHORT pane is a supported case with a measured shape of its own: at `900x400`
(888px, i.e. `md` + `preview: 'none'`) the catalogue's list region shows two
complete model rows and clips the third at its own fold, and the Overview's first
screen shows the `Reasoning effort` head plus three of four candidates — both are
reached with the list's own line keys, which is the plan's short-height rule
("the native list scrolls independently and keeps the selected row"). The summary
is the only thing withheld on that pane, and nothing else is lost.

At the 400px floor the client gives the header only about fourteen characters, so
the page title itself is ellipsized (`Switch mo…`) and its SUBTITLE slot is not
painted at all — which also means the catalogue's one hint is invisible there, and
the client auto-hides the fact column as well. That is exactly why the Overview
carries the model's name as its first ROW rather than as a caption: the row is
painted at every width, the caption is not. That is the client's own floor
behaviour, measured in the acceptance lane's 400x600 capture: the catalogue still
shows every row with its provider mark and its real badges, and the footer's
`Cancel` + the ONE write are fully visible and clickable, so the model is chosen
and committed at that width — the effort is reached by entering the model's
Overview (`Enter` or a click on the highlighted row), which is the same path every
narrow pane uses.

The catalogue's rows are ONE line each: the SDK ellipsizes what does not fit and
never breaks an unbroken fragment, so the model's complete id is carried in the
row's `title` and the complete values are read in the Reader. The row identity
(`mark`, `badges`, `title`, `facts` with `columns`) is a MEASURED client
capability, measured on the synthetic list-first picker before this revision
shipped. The ONE fact column carries the drafted effort: the client gives it a
FIXED 106px of the row's text area at every width (measured: `pk-txt` 1026px →
920px at 1280x800) and hides it by itself at 400x600, while the model NAME keeps
its intrinsic width — the row's provider DETAIL is what yields — which is why the
column is used here and the plan's "only while it does not cost the model name its
width" rule holds.

### What these numbers do and do not guarantee

Every floor and threshold above is a LAYOUT PARAMETER OF THE VERIFIED
ENVIRONMENT — the measured Tern build, its default UI font at the 100% scale it
was measured at — and NOT a universal no-clipping guarantee. A different UI font,
an enlarged terminal font, a changed system DPI or a browser/UI zoom moves the
ratio between the picker's content area and the glyph advance, which a fixed pixel
budget cannot track, and the presenter has no reliable way to read the details
area's real geometry: the SDK reports terminal `cols` and a cell size, not the
picker sheet's own box. A stricter guarantee needs a Tern-side content-area or
layout capability, which is out of scope here; reverse-engineering the client's
CSS is explicitly not done.

What has to hold in every environment is reachability, not a pixel promise: a long
fact value must have a complete reading path, and every Effort candidate must have
a reachable path. The Reader carries each value ONCE and the client wraps it at
the layout's own real width (so no bound of ours can clip it), the app drives the
native scroll container with the SDK's `scroll` op, and the Overview lists every
candidate at EVERY width — it is the only place a candidate is offered, so no
pane can hide one.

The run does NOT certify enlarged UI fonts at the wide layout, `PageUp`/`PageDown`
through the client's own control channel (the harness silently drops that name;
the byte-level mapping is covered by the headless suite), physical wheel/trackpad
scrolling, IME, themes or the Remote path: those stay `NOT_VERIFIED`.

### The action bar's measured limit

The action bar lays its buttons on ONE line and does not wrap them, and it has no
scroll port of its own, so a bar whose buttons do not fit its `pk-bar` is cut at
that edge. That is why the bar is short and fixed: at most the page's own `Back`
plus the failed-read `Retry` plus the ONE short write (`Switch` / `Save default`).
The catalogue's two-button bars and the Overview's two-button bar are MEASURED at
both supported extremes — see the containment rows of "Real-pane verification"
below — and the 400px floor keeps `Cancel` + `Switch` inside the bar.

**Owner decision — 400px enlarged-font scaling (`KNOWN_UI_LIMITATION` /
`OWNER_ACCEPTED`).** At a 400x600 pane with an ENLARGED UI font — both +25% and
+50% — the native client truncates the selected model/provider/effort information
(measured: at +25% the highlighted row renders only `Reasoning Model` and
`Default`, at +50% likewise, and the subject line is ellipsized too), so the target
is not fully readable there while the action stays visible and enabled. The Owner
explicitly ACCEPTS this as a known client-side UI limitation and lets the user
decide whether to confirm; no geometry-based write guard and no further
font-specific layout workaround is added, and the K2 explicit-apply and Host
Writer semantics are unchanged. Both configurations are recorded as known UI
limitations and are NOT claimed as visually passing. This waiver does NOT apply to
the default-font 400x600 layout, to the normally supported widths, to an incorrect
selection, or to a duplicate write. The exact per-configuration measurements, the
fragments that were really clicked and the screenshots live in
[the PR4-A evidence](./evidence/pr4-a.md) §0.

## Ownership and lifecycle

`src/app/command/model-presentation.ts` is a narrow Client-local presentation
contract carrying the open-time subject, the apply/retry entries and the panel
handle. `src/tui/commands/models.ts` remains the singular read/write owner: it
captures Session scope, loads the directory (once per read), brands effort ids,
tracks default-save intentions and admits live selection through the original
writer. Both renderers share the pure projection in
`src/tui/pickers/model-directory.ts`; neither introduces a catalog or a writer.

The PiTui adapter keeps the existing picker and its overlay broker. The native
presenter is split by responsibility inside `src/tui/tsp/`: `model-picker.ts`
owns panel lifecycle, interaction admission and coordination; `model-picker-state.ts`
owns the panel state and pure selectors; `model-picker-intents.ts` owns the pure
key/event → intent map (the whole K2 contract); `model-picker-view.ts` builds the
node tree and binds intents. Every key and every pointer callback passes through
the one admission point, which rechecks the subject, the live panel, the
presentation revision, the phase and the zone before any mutation. The official
SDK remains the sole tty owner; no new Host lookup, wire operation, transport
cache or public extension API is introduced.

## Regression coverage

Build before running artifact-dependent tests, as required by `AGENTS.md`.

```sh
node scripts/run-with-temp-root.mjs node --test \
  test/model-picker.test.ts \
  test/tern-tsp-model-picker.test.ts \
  test/tern-tsp-model-profile.test.ts

# The acceptance lane headless tests cannot cover: the client's own pointer hit
# areas, real event shapes, and footer containment (not part of `pnpm test`/CI).
node scripts/tern-pane-drive.mjs scripts/tern-pane-model-ux.mjs
```

The native Model suite drives the real runner, classifier, command handler and
SDK over a scripted tty and asserts on the reconciled wire tree: the list-first
catalogue's rows (one per provider+model, the provider `mark`, the real
`current`/`Default` badges, the complete id in `title`), its pinned-then-provider
order with each configured model exactly once, the `select`-highlights /
`activate`-opens-Overview split (including a retired receiver that can never
re-target a page), the ONE write on the catalogue at every width with the
highlighted model's own draft, the compact summary's real facts and its
information-only role, the README-level refusals (a forged scope action, a
scope-shaped or failure-shaped row id, a candidate id on the wrong page), the
retry row's read-only re-read by pointer AND from the keyboard cursor, the
Overview's priority row set and its Enter semantics (inert section head, drafting
candidate, details entry), the read-only Reader (its grouped
Identity/Configuration/Description structure, its complete values and `wrap`
kinds, its frame-scoped Back/body ids, the SDK `scroll` ops its own keys emit for
the body node it really built — with the negative control that the same keys emit
none away from the Reader — and its origin-preserving return), the K2 two-zone
walk with Enter refused outside the Primary Action, the page-by-page action bar
(including the failed read's `Cancel` + `Retry`), `Esc` returning to the zone/page
it came from, a resize that keeps the panel, the page and every draft at both sides
of the threshold, a loading panel
that keeps the search editable and closes
on `Esc`, the pending/refusal/indeterminate settlements (a refusal keeps the page
it happened on), the read-error Retry through the original read owner, the
Current/Default facts of a live versus sessionless subject, long unbroken/CJK/
emoji descriptions as ONE complete Reader value, effort candidate sets of 0, 1
and 7+ (with no phantom candidate), the measured summary threshold and its
cell-width dependence, grapheme search, modal precedence, stale
receivers, legacy-pane
refusal, a pane with `picker` but without `row`/`overlay`, a same-name Host command,
and one live Direct Session selection that CHANGES the model (verified through
the real Session log and an authoritative reopen). `test/model-picker.test.ts`
keeps the PiTui picker behavior; `test/tern-tsp-model-profile.test.ts` keeps the
official Loader/ConfigEditor profile save, the authoritative reopen and disk
recovery through a fresh Context.

## Real-pane verification of the list-first surface

The revision is driven in a real Tern pane by the repository's own
harness, and the run is REPRODUCIBLE:

```sh
node scripts/tern-pane-drive.mjs scripts/tern-pane-model-ux.mjs
```

`scripts/tern-pane-model-ux.mjs` (flow) + `scripts/tern-pane-model-ux-subject.mts`
(subject) mount the PRODUCTION `TspModelPicker` over one official SDK inline
surface in a headless `tern serve` pane and send REAL input; every containment
claim goes through the visibility oracle (`scripts/tern-pane-geometry.mjs`), so a
node's own rect is never mistaken for a visibility proof, and the ledger separates
`check` (a claim the run must prove) from `measure` (informational). The run
directory keeps `assertions.json`, `run.log`, the node trees, the PNGs and copies
of the flow and subject — see
[the harness guide](../tern-pane-harness.md). The measurements of this revision —
the two pre-implementation Gates and the acceptance lane of the shipped presenter,
with their per-pane matrices, screenshots and every `NOT_VERIFIED` item — are in
[the list-first visual evidence](./evidence/model-list-first-visual-20261013.md).

What remains `NOT_VERIFIED` and is NOT claimed as passing:

- the +25% / +50% enlarged-UI-font matrix at the 400px floor and at the wide
  layout — the pre-existing Owner-accepted limitation above;
- the client's EXACT breakpoint for painting the below-list summary (measured only
  between 544px hidden and 888px painted);
- `PageUp`/`PageDown` through the client's own control channel: this client's
  `key` command accepts `PageDown` but delivers no key for it (measured; `Down`,
  `Up`, `Home` and `End` are delivered), so the flow drives the same `scroll` op
  with those and the byte-level `CSI 5~`/`CSI 6~` mapping is covered headlessly;
- **pointer/wheel scrolling of the Reader body**: this harness's control channel
  exposes no pointer/wheel input at all (measured; the lane records `[]` for the
  shapes it tries), so the plan's pointer-scroll item is an explicit OWNER
  EXEMPTION — the same capability is verified through the app's own keys, which is
  what the app owns the keyboard for;
- the `ui.kv` CLIPPING behaviour for a pathological long value inside the compact
  summary: the Gate measured that `layout: 'inline'` clips a 190-glyph value and
  that `layout: 'grid'` wraps it, so the summary is only ever fed the short real
  facts; the summary is informational by contract and the complete value is in the
  Reader;
- IME, OS focus, dark themes, screen readers, terminal
  scaling, directories beyond the scripted sizes, the shipped full-profile/HMR and
  the Remote TSP application success path. The harness is a headless client: it
  says nothing about OS-level input methods, window focus or desktop font
  resolution.

A resolved write outcome is reported by the existing dock notice on any page that
cannot host a picker `message`; a read failure or write outcome ON the Reader is
its leading line instead.
