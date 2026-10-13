# Model selection in the experimental TSP renderer

The existing `/model` command has PiTui and native TSP presentation adapters.
This is the PR4-A implementation plus its Model-UX restructuring revision, not a
completed PR4 milestone: Direct and PiTui remain the production defaults and TSP
keeps the experimental renderer opt-in described in
[TSP integration](../tern-tsp.md).

The Owner-frozen Model UX is now the three-page task flow **Models → (one
model's) Overview → Full details**: pick a model, look at that model's own
properties, change its Reasoning Effort, and commit once from an explicitly
labelled action. The wide list edits a model in place through its side column;
every other layout opens THAT model's Overview, which carries the identity, the
details entry and every effort candidate in the native main list. The Full
details page is read-only. There is **no global action menu, no action strip and
no operation block**: a page shows the operations its own model entity offers and
nothing else.

## Availability and behavior

The mounted terminal must advertise `picker`, `row` and `card` before the
TUI-owned `/model` command becomes available; a pane missing any of them refuses
the command before invoking its handler and keeps the submitted draft. This
admission follows authoritative command classification: a genuine Host command
named `model` keeps its Host route, and other PiTui-only builtins remain
unavailable in TSP.

### Pages

| Page | Title | Content | Write |
|---|---|---|---|
| `models` | `Models` | provider scopes (wide) + the provider-grouped model list, plus the wide side column | wide only |
| `overview` | `Model overview` | the highlighted model's SHORT identity, its effort section (every advertised candidate), then its details entry and the remaining configured facts, all in the native main list | yes |
| `details` | `Full model details` | the model's COMPLETE values in the native **Reader** (an `overlay` the client wraps at its own width and the app scrolls), read-only | **never** |

`overview` is the model's OWN page, never a global menu: it always describes
exactly one model, and closing it (`Back` / `Esc`) returns to the model list. The
read-only `details` page is a logical page of the same flow, but it is PAINTED as
the native Reader instead of a picker (see "The read-only Reader").

### The wide model list and its side column (MEASURED pane width)

The wide shell is piped as provider scopes + model list + a Model Details column,
and it is KEPT on every pane that really gets the native SIDE preview (content
never collapses the shell):

Whether the pane really gets it is a MEASURED pixel breakpoint, not a column
count. The client keeps the preview BESIDE the list only once its own sheet is
wide enough; below that it still emits the `pv-side` class but paints the preview
UNDER the list, where the inline effort row is outside the visible region.

The table below is a CLIENT calibration, taken in a real pane (`tern 0.8.3`,
default font) with a model that advertises four candidates BEFORE this rule
existed (the probe drove the then-current presenter, which asked for the side
column at `cols >= 120`). It says where the CLIENT's breakpoint is — not what the
shipped presenter emits, which is the "real-pane verification" table's own matrix
further down:

| pane | `cols` (`cell.w` 8) | client's own preview mode | inline effort rows visible |
|---|---|---|---|
| 980x640 | 122 | `pv-side pv-below-auto` | 0 of 4 |
| 1020x640 | 127 | `pv-side pv-below-auto` | 0 of 4 |
| 1040x640 | 129 | `pv-side` | 4 of 4 |
| 1050x700 | 131 | `pv-side` | 4 of 4 |
| 1100x640 | 137 | `pv-side` | 4 of 4 |
| 1280x800 | 160 | `pv-side` | 4 of 4 |

The presenter knows only `SessionCaps.cols`/`cell` (the SDK reports no sheet box),
so the pane width is reconstructed as `cols * cell.w` and compared against the
measured `1040px` (`SIDE_PREVIEW_MIN_PANE_PX`). That reconstruction
UNDER-estimates the pane by the client's own chrome (measured: a 1040px pane is
129 columns = 1032px), so the boundary pane itself still goes compact — one cell
of margin, in the safe direction. Read against the shipped rule, the calibration
therefore means: every pane up to and including 1040px goes COMPACT (`md`,
`preview: 'none'`, every candidate in the Overview), and the side shell starts one
cell later, where the client is measured to really paint it. The earlier `cols >= 120` rule was 960px in
this environment: always below the boundary, which is what pushed the preview (and
the inline selector) under the list on an ordinary split pane.

- In the FULL column (`widePreviewFits` holds) the Model Details card head is the
  model name plus an app-rendered `›`. The card NODE carries the app's pointer
  target (`onClick`), and the `detail-card` zone's `Enter` opens the read-only
  Full details page; the card's own hint states that. When the column is BOUNDED
  the same zone opens the Overview instead, exactly as that card's own
  `Open model & effort ›` label says (see below). In the K2 ring the card is the
  `detail-card` zone in both forms. The SDK dispatches such an action by EXACT
  node id with no bubbling, and a real pane confirms the client attributes a click
  on the card's HEAD **and on its nested body text lines** to the card node, so
  the whole card is a hit area (see "Real-pane verification" below); the `Enter`
  path does not depend on the pointer at all.
- When the column provably presents the whole details card and every advertised
  effort (`widePreviewFits`), the column also renders the `Reasoning Effort`
  card, whose options are native `row`s acting as radio buttons. Clicking a row
  changes only that model's LOCAL draft; it never writes.
- When the budget cannot prove that (long identity, many/long effort labels, a
  short pane), the SAME column becomes the bounded summary: the identity
  (pre-wrapped), the keyboard hint, one optional one-line summary, then the
  configured Current/Default facts, capped at a provable line count and marked
  with `…` where it is cut. Its card head reads `Open model & effort ›`, the card
  node carries the same one pointer target, and the `detail-card` zone's `Enter`
  opens the model's Overview — the page that carries every candidate. The column
  can never render a candidate outside
  itself, and the K2 `effort` zone does not exist while the rows are not painted.

The model list highlights a model on arrow keys and on a row `select`/`activate`;
it never pages the surface away at `lg` (clicking the already-selected row must
not open anything).

### The compact model list and the compact/bounded Overview

On every pane below the measured side-preview threshold (and at every compact
width) the same picker renders `preview: 'none'`:

- the model list carries the provider-grouped rows and the inert failed-provider
  rows, and **no write action at all**: a row `select` or `activate` atomically
  selects that row and opens its Overview;
- the Overview's main list is ordered for the high-frequency task: the model's
  SHORT identity (one client-ellipsized line), the `Reasoning effort` section with
  EVERY advertised candidate (marked `●`/`○`) — or the same section carrying
  `Not available` when the model advertises none — then the single
  `View full model details ›` operation row, and only then the remaining
  configured facts (`Provider`, `ID`, `Current`, `Default`) as single-line
  summaries. Arrow keys move a ROW cursor over every row, `Enter` / a click drafts
  on an effort row, opens the read-only Reader on the details row, and is inert on
  a static row. The COMPLETE values never cost rows here: they are Reader facts,
  which is what keeps every candidate on the first screen at every width;
- the read-only `details` page is the native Reader (see below) and its only
  operation is its own `Back` row.

The compact picker shows the open-time subject (`Default model` / `Session model`)
once, on the native `strip`'s own line, because that is the picker's only
single-complete-line slot at `md` (the header title truncates a long line). That
line is a READ-ONLY DISPLAY with an empty chip list: it carries no `Action:` text,
no operation chip and no clickable entry, and it is not the removed global action
strip. The subject is never duplicated into the title, and at `lg` it uses the
picker's `subtitle` instead — so it has exactly one complete slot per layout.

The Overview is also what the wide BOUNDED column opens, so the pane width never
decides whether the full content is reachable.

### The read-only Reader (`details`)

The `details` page REPLACES the picker in the same layer with a native
`ui.overlay` (`size: 'lg'`, `modal: true`) instead of painting a picker page:

- a picker ROW renders ONE measured line and ellipsizes what does not fit, so it
  cannot be a reading surface for a long value — the previous revision pre-split
  every fact into continuation rows, which a real report showed as fragmented,
  unlabelled pieces of an ID. The Reader therefore renders each fact as its label
  plus ONE `ui.text({ text, wrap })` value node the CLIENT wraps at the width the
  layout really has: `char` for machine identifiers (a `provider/model/effort`
  slug or a model id may carry no break opportunity at all) and `word` for prose
  (the description and the transient status). Nothing is pre-wrapped, truncated or
  re-derived: the value is the directory's own string, every explicit break it
  carries (LF, CRLF and a blank line alike) is rendered as its own line by the
  client, and the page never uses Markdown for a field that is not defined as
  Markdown;
- the overlay's body is a NATIVE scroll container, and the app owns the keyboard:
  the Reader maps `↑`/`↓`, `PageUp`/`PageDown` and `Home`/`End` onto the SDK's
  `scroll` op for the body node it really built (the renderer resolves that node's
  wire id from the frame it rendered, so no id is ever guessed). There is no
  scroll position, cursor or height mirror in the app, and `Tab` is a consumed
  no-op on this page because it paints exactly ONE region;
- its one interactive node is a visible `Back` row bound to the SAME `back`
  intent `Esc` uses, so `Back` and `Esc` can never disagree about where the page
  returns: the wide details card enters it from the model list and the Overview's
  own details row enters it from the Overview, and `detailsReturn` keeps that
  origin across a resize. It carries no candidate, no draft and no writer. The row
  is the FIRST row of the scrollable body, so it is visible at the top of the page
  and travels with the content: after scrolling to a long value's tail, `Home` (or
  `Esc`, which is the same intent) is the way back — the row is never a dead
  control, because the page's own view keys are exempt from the phase gates.

The page's facts, in reading order: `Model`, `Provider`, `ID`, the configured
`Current`/`Default` (whose values carry their own effort from the ONE directory
DTO), the advertised `Description`, the current `Draft effort`, and the transient
`Status` when there is one. The complete values live HERE; the Overview only ever
shows one-line summaries of them, so a long value can never push an effort
candidate off the model's first screen.

### Scope and candidate namespaces

The SDK delivers the scope column's ids and the page's row ids on one channel, so
the two are told apart by **channel**, not by shape:

- A provider scope is chosen with `action { act: 'scope', value: <scope id> }`.
  `scope-all` is the every-provider entry; a provider scope is always `scope:`
  plus the provider ID. A value that names no scope at all, or a provider the
  current read does not advertise (including a failed provider's disabled scope),
  is refused with no state change. Only the model list page carries a scope
  column, so a scope action on the Overview fails closed — and the read-only
  Reader is not a picker at all, so it renders no scope column to filter with.
- A row `select` / `activate` carrying a scope-shaped id is NOT a scope click: it
  acts only on an id the CURRENT page really renders (`visibleModels` on the model
  list, the Overview's own row set). The Reader has NO selectable row of its own
  (its one interactive node is its `Back` row), so a row event on that page
  resolves nowhere. This is what
  keeps a catalogue that advertises a provider literally named `all` — or a model
  whose effort id IS `scope-all` or starts with the scope prefix — unambiguous.
- An effort candidate row carries its own `effort:` namespace, on the Overview
  exactly as in the wide inline selector, so a candidate value that looks like a
  scope id still takes the draft.
- The removed wire shapes are refused, not ignored: `details`, `effort-page`,
  `strip` (and any `strip-*` value) are not part of any page's action set, and a
  `more:<action>` row id resolves nowhere.

### Writing

Browsing (model rows, provider scopes, the Overview's rows) and clicking an
effort row only change local browse state — the highlight, the scope filter or
that model's draft effort. **Only the explicitly labelled action writes**, once:

- `Switch` for a live Session (the existing Session-model selection);
- `Save default` for a sessionless subject (the existing "confirm the model and
  save it as the future default" intent).

The provider-default sentinel submits without a `reasoningEffort`; a real effort
submits the advertised id. `Switch` / `Save default` are the same single `apply`
action id the earlier revision used, and neither operation is split in two.

The write action exists exactly where the owned page carries it: the wide model
list and the Overview (`applyOffered`). The compact model list has NO write, and
the read-only Reader paints no action bar at all, so no page operation can be
reached from it: a forged `action { act: 'apply' }` is refused on the wire before
any state change (the same admission the visible bar uses), and only the panel's
dismissal authority (`close`, the same intent `Esc` uses) stays admitted there. On a wide model list whose search matches NO model the write entry stays
VISIBLE but disabled — the plan's "no writable primary" is met by
non-operability rather than by hiding the entry — and a forged
`action { act: 'apply' }` is refused there too: the admission entry gates the
PAGE it came from (`applyOffered`) and the writer itself refuses a request with
no highlighted model, so such an event cannot write, change state or even
re-render. A resolved
refusal/unsupported/indeterminate outcome is reported by the
existing dock notice; the native picker itself paints its `message` only in its
error state, so no content page can host an outcome banner. That is a recorded
presentation limitation, not a hidden write.

### Keyboard (K2, frozen)

The logical zones are `models` (a page's native main list), `detail-card` (the
wide side column's Model Details card), `effort` (the wide side column's inline
Reasoning Effort radio rows) and `primary-action` (the action bar).
`zone` is presentation-local and is never business authority. Tab and Shift+Tab
walk the zones the CURRENT page really paints, in a ring:

| Page / layout | Ring |
|---|---|
| `models` `lg`, full preview, model advertises efforts | `models → detail-card → effort → primary-action` |
| `models` `lg`, full preview, model advertises no efforts | `models → detail-card → primary-action` |
| `models` `lg`, bounded preview | `models → detail-card → primary-action` |
| `models` `md` | `models → primary-action` |
| `overview` | `models → primary-action` |
| `details` (the Reader) | ONE region: `Tab` is a consumed no-op |
| `pending` (admitted write) | the bar holds the keyboard (`Esc` only) |
| `loading` (running re-read) | the model list keeps its search box on the model list page (everything else is refused but `Esc`); the Overview admits only `Esc`; the Reader keeps its own `Back`/`Esc`/scroll keys |
| `error` (failed read) | the bar holds the keyboard (`Tab`/`Shift+Tab` both stay there) — except on the Reader, which has no bar and keeps its own `Back`/`Esc`/scroll keys |

`Esc` is never swallowed. On a content page it is exactly the visible `Back`
(`overview → models`, `details → detailsReturn` — the Reader's own visible row
and `Esc` are the same intent); inside the action bar it
returns to the zone the bar was entered from; in the side regions it returns to
the model list; on the model list it closes the panel. An admitted write, a
running (re-)read and a failed read all close.

**The Reader is the one exception, and it is deliberate.** Its `Back` row is a
VISIBLE control on a read-only page, so it is never a dead one: `Back` (and the
`Esc` that is the same intent, and the page's own scroll keys) are pure VIEW
operations that change no draft, start no read and write nothing, so they stay
available while a (re-)read merely runs or has failed — the page keeps describing
a real model and the failure is reported as its own `Status` fact. Closing the
whole panel there would drop the page context its origin can restore. The other
phases keep their original admission exactly: an ADMITTED WRITE still owns the
panel (nothing navigates or scrolls under it), and a running read still refuses
every browse, every draft and every write.

| Zone | `↑↓` | `Tab` / `Shift+Tab` | `Enter` | `Esc` |
|---|---|---|---|---|
| model list | browse models (search box text stays editable) | → the next painted zone | full wide column: focus the `detail-card` zone; compact or bounded: open the highlighted model's Overview — **never writes** | close |
| `detail-card` | — | → the effort zone (only while painted), then the bar | open the read-only Full details page (full column) or the model's Overview (bounded column), matching the card's own head and hint — **never writes** | back to the model list |
| `effort` (wide inline rows) | change the draft | → the bar / ← the details card | confirm the draft onto the Primary Action — **never writes** | back to the model list |
| `overview` | move the ROW cursor over every `Model`/effort/configured-fact row | → the bar | draft on an effort row, open the details entry, inert on a static fact — **never writes** | `Back` to the model list |
| `details` (the Reader) | `↑↓`/`PageUp`/`PageDown`/`Home`/`End` scroll the Reader's native body (also while a read runs or has failed) | — (one region) | inert — **never writes** | `Back`/`Esc` to the page it came from |
| action bar | — | → the next zone in the ring | **the only key that writes**, once, when the FOCUSED action is the enabled Primary | return to the zone/page the bar was entered from (a failed read closes) |

The wide side regions are focused through the SDK's own `focus: 'preview'` and
every other list through `focus: 'list'`; the action bar has no native region, so
the FOCUSED action carries an app-rendered shape cue (`▸ Switch` / `▸ Save
default` / `▸ Retry` / `▸ Back` / `▸ Cancel`). A disabled action never carries the
cue, and neither does an action the current phase cannot run from the keyboard at
all (`pending`, `loading`), so the cue is always a promise about `Enter`.

`Ctrl+C` always remains the original application cancel owner, and a
Question/Approval modal owns the keyboard before the Model panel.

### The action bar

The native action bar lays its buttons on ONE line and does not wrap them, and the
bar has no scroll port of its own, so the bar is SHORT AND FIXED and the frozen
table caps it per page: no more than `Cancel` (+ `Retry`) (+ the one write) on the
model list, and `Back` + the one write on the Overview. The read-only `details`
page has NO picker and therefore NO action bar at all: its `Back` is the Reader's
own visible row (see "The read-only Reader").

| Page / phase | Action bar (left to right) |
|---|---|
| `models`, wide | `Cancel`, `Retry` (only while part of the directory failed), `Switch` / `Save default` |
| `models`, compact | `Cancel`, `Retry` (only while part of the directory failed) — **no write** |
| `overview` | `Back`, `Switch` / `Save default` — **no `Cancel`** |
| `details` (the Reader) | none — the page is not a picker; its `Back` row is its own node |
| `error` | `Cancel`, read-only `Retry` |
| `loading` | `Cancel`, a disabled `Switch` / `Save default` |
| `pending` | `Close`, a disabled `Selecting…` |

`Cancel` is the visible label of the stable `close` action, and while a write is
ADMITTED it reads `Close`: closing the panel does not cancel an operation that is
already with the Host, and the label must not promise an undo the contract does
not offer. The content pages therefore carry NO `Cancel` button: a user leaves them
with `Back` (or `Esc`, the same intent) and cancels from the model list, which is
what keeps the Overview inside the frozen two-entry cap. The `close` INTENT itself
stays admitted on every page, because it is the panel's own DISMISSAL authority —
the same intent `Esc` and the client's backdrop gesture use — and dismissing can
never write; only the page OPERATIONS (`back`, `retry`, `apply`) have to be really
rendered by the current bar. `Retry` is the stable `retry` action and is the only
action a failed read offers; it is read-only and re-reads through the command's
single read owner.

The action **ids** are the routing authority and stay stable: `close`, `back`,
`retry`, `apply`. The key map and the row router act on those ids, never on
display text.

### Loading, errors and retry

While the directory is loading the panel still admits the search box (frozen
§4.5: the query stays editable) and always admits `Esc`; every other key is
refused and the Primary Action renders disabled, so a loading panel can neither be
mutated nor left unable to close. The hint names the phase (`Selecting…` for an
admitted write, `Reading…` for a running read) rather than promising a `Tab`/`←→`
this phase refuses. The command's single directory-read owner serves both the
first read and every Retry: one in-flight read at a time, the same `runOwned`
task, captured scope, signal, presentation token and supersession semantics.

A read failure shows the native error state with one message and makes the bar's
`Retry` the only operable entry. A failed read has exactly ONE operable region —
that bar: the stale rows stay on screen for context, but the phase browses neither
the list nor the search box and refuses `Enter`, so `Tab` and `Shift+Tab` both
stay in the bar (where `←→` moves between `Retry` and the always-enabled `Cancel`)
instead of walking the keyboard into an inert list. A partial failure keeps the
reached providers usable, lists the failed provider as an inert row (compact) or
an error-dot scope (wide), and offers `Retry` on the model list itself.

A failed read on the READER reports the failure as its own `Status` fact and keeps
its `Back`/`Esc` working (see above); `Retry` itself belongs to the pages that
paint an action bar, so a user returns to the model list or the Overview to run it.

Pending saves disable every mutation entry (including the effort rows, the
Overview's rows and the Primary Action) and keep `Cancel` available; closing does
not cancel an admitted business operation. Rejected, cancelled and unsupported
outcomes leave the picker usable ON THE PAGE IT WAS ON, with its draft intact, and
report the outcome through the dock notice; indeterminate outcomes close it with
the original reconciliation notice. Hydration and disposal retire the picker
synchronously, and receivers bound to a previous panel serial and presentation
revision are never routed again.

## Layout budget

The wide column keeps its action-first structure and its budget: the identity is
pre-wrapped to at most two provable lines per field, and the Reasoning Effort
radio rows own the remaining vertical space. The complete description and the
extended facts never decide whether the selector stays inline — they live in the
read-only Reader, and the Overview keeps one-line summaries of them.

The fit is decided by a PROVABLE budget: the pane renders proportional text, so a
terminal column count is not a line count (`'W'.repeat(34)` wraps into two native
rows although 34 columns "fit"). Every line the column renders is either
pre-wrapped by the picker to the measured widest-glyph advance of the card font
(~14.6px for a `W`, priced at 20px) or clamped to one, so the rendered height is
known exactly; explicit newlines (`LF`, `CRLF`, `CR` and Unicode separators) and
tabs are counted as the renderer shows them. The resulting height is compared
against measured geometry (28.2px per line, 22.2px per single-line radio row,
~20px per extra label line, ~16px between cards, 10px of row-column padding) and
the usable height of the SHORTEST supported wide pane — 374px, measured at
1280x600 (1100x640 gives 414px, 1200x700 gives 474px, 1280x800 gives 574px).

374px is a LAYOUT BUDGET, not an SDK guarantee. Of the SDK's capability fields
(`Capabilities` / `session.caps`), only `cols` and `cell` describe geometry, and
the resize event only `cols`/`cell`/`visible`, so the presenter cannot detect a
shorter pane and cannot degrade further below the floor. The supported envelope is
a pane whose width is at least 400px (the width floor of the fact rows) and whose
wide usable height is at least 374px (about 600px of pane height at the measured
226px of chrome); every size in that envelope renders the same height-independent
decision, and the inline selector is promised only while the budget proves it.
Panes BELOW either floor are an explicitly accepted limitation — the column
becomes the bounded entry into the Overview, which is always reachable and always
shows every candidate, and neither this document nor the implementation claims
the wide column is visually safe there.

A SUMMARY row (the Overview's facts and the bounded column's lines) is a SINGLE
measured 18px line: the SDK ellipsizes what does not fit and never breaks an
unbroken fragment (a long id or glyph run), so "the row is 36px tall" is not a
readability budget. A summary value therefore folds every whitespace run into one
space and lets the CLIENT ellipsize it — the complete value is never read from a
summary row. The Overview's configured facts (`Provider`, `ID`, `Current`,
`Default`) are exactly that: one ellipsized line each, never a stack of
continuation rows, which is what keeps every effort candidate on the first screen.

The bounded wide column still pre-wraps its identity/fact lines to the shared
{@link factRowItems} rule below, because that column is a SHORTCUT into the
Overview rather than a reading surface: the measured slot (286px compact / 366px
wide) minus the width of the label the row shares its line with, priced at the
20px widest-glyph bound, with the Owner-frozen caps of 11 columns (compact) and 21
(wide) as upper bounds. That rule is shared with the `/preset` presenter and is
UNCHANGED by this revision; the `/model` READER (the `details` page) does not use
it and does not pre-wrap at all.

The single optional summary line of the wide column is ALWAYS exactly one rendered
line: any whitespace run — an explicit `LF`, `CRLF`, `CR` or Unicode line
separator included — folds into one space before it is clamped to the column
bound, and the full text stays in the Reader (`Description`, `Status`).
The card head is folded and clamped the same way; the complete name stays readable
in the list row and in the Reader.

### What these numbers do and do not guarantee

Every floor and column bound above is a LAYOUT PARAMETER OF THE VERIFIED
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
candidate in EVERY layout — it is entered from the compact model list, and from the
wide column whenever the budget cannot prove the inline selector. The wide inline
rows are the selector exactly while `widePreviewFits` proves they all fit.

The LAYOUT THRESHOLD is measured, and the measurement is recorded rather than
assumed: the pane width is reconstructed from `cols`/`cell` and compared against
the boundary the real client showed (1040px), one cell of margin in the safe
direction. A pane whose real geometry differs from this environment's (a different
font, a changed DPI, a browser zoom) can therefore be classified compact while the
client would in fact have room for the side column — which costs the inline
selector, never correctness, because the Overview remains the reachable path.
Classifying such a pane WIDE while the client paints below the list is the
direction that is not taken: that is the defect this revision fixes. The run does
NOT certify enlarged UI fonts at the wide layout, `PageUp`/`PageDown` through the
client's own control channel (the harness silently drops that name; the byte-level
mapping is covered by the headless suite), physical wheel/trackpad scrolling, IME,
themes or the Remote path: those stay `NOT_VERIFIED`.

### The action bar's measured limit

The action bar lays its buttons on ONE line and does not wrap them, and it has no
scroll port of its own, so a bar whose buttons do not fit its `pk-bar` is cut at
that edge. That is why the bar is short and fixed: at most the page's own `Back`
plus the failed-read `Retry` plus the ONE short write (`Switch` / `Save default`),
and the restructured bars are MEASURED at both supported extremes — see the
containment rows of "Real-pane verification" below: at 1280x800 `pk-bar` x
80..1200 holds `Cancel` [1047.6,728,60.5,28] and `Switch` [1120,726,68,32]
(right edge 1188), and at 400x600 `pk-bar` x 30..370 holds `Back`
[40,533,43.8,28] and `Switch` [294.1,531,68,32] (right edge 362.1). The earlier
five-entry details bar that was measured to clip is what the frozen two-entry caps
replace.

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
SDK over a scripted tty and asserts on the reconciled wire tree: the measured
layout rule at its own boundary (129 columns compact / 130 wide at the fixture's
cell, plus the cell-width dependence) and the wide/compact props, the open-time
subject per layout slot, the real `action('scope', …)`
filter with its refused shapes (a scope-shaped row `select`, an unknown or
disabled provider, a valueless action, a content page, a loading/failed read),
a radio-row `onClick` that only drafts, the compact row `select`/`activate` that
opens THAT row's Overview atomically, the Overview's priority row set (short
identity, effort section, details entry, then the configured summaries) and its Enter
semantics (inert static row, drafting effort row, details entry), the wide
details card and the bounded `Open model & effort ›` card (which opens the
Overview from BOTH its pointer handler and its `detail-card` zone Enter, while
the full card opens the read-only page from both), the read-only Reader and its
`Back` row (its complete values, its `wrap` kinds, and the SDK `scroll` ops its
own PageUp/PageDown/Home/End keys emit for the body node it really built — with
the negative control that the same keys emit none away from the Reader), the K2
zone walk with Enter refused outside the Primary
Action, the page-by-page action bar (and its refusal on the compact list), `Esc`
returning to the zone/page it came from, a resize that keeps
the page and the draft (the Reader included) AND a resize that leaves the
`detail-card`/`effort` zones
for the really visible list without changing any invisible draft, a loading panel
that keeps the search editable and closes
on `Esc`, the pending/refusal/indeterminate settlements (a refusal keeps the page
it happened on), the read-error Retry through the original read owner, the
Current/Default facts of a live versus sessionless subject, long unbroken/CJK/
emoji descriptions as ONE complete Reader value, effort candidate sets of 0, 1
and 7+ (with no phantom candidate), grapheme search, modal precedence, stale
receivers, legacy-pane
refusal, a pane with `picker` but without `row`/`card`, a same-name Host command,
and one live Direct Session selection that CHANGES the model (verified through
the real Session log and an authoritative reopen). `test/model-picker.test.ts`
keeps the PiTui picker behavior; `test/tern-tsp-model-profile.test.ts` keeps the
official Loader/ConfigEditor profile save, the authoritative reopen and disk
recovery through a fresh Context.

## Real-pane verification of the restructured surface

The restructuring revision is driven in a real Tern pane by the repository's own
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
[the harness guide](../tern-pane-harness.md). The Model-Responsive / Reader
revision's capturing run recorded the client as `tern 0.8.3 (e2b8656)` and
finished with **0 failures**; the per-pane matrix, the scroll evidence and the
artifact layout are in
[the reader evidence](./evidence/model-responsive-reader-20261013.md).

| Verified (all as harness `check`s) | Result |
|---|---|
| boot + shell | the production picker mounts in a real pane; the wide shell renders the subject, asks for the native `pv-side` preview, and the client really paints the SIDE column (no `pv-below-auto`) |
| the MEASURED boundary | at 1020x640 (127 columns) the presenter asks for `md` + `preview: 'none'` and the client paints `pv-none` with no inline row; at 1040x640 (129 columns) it is still compact — the one-cell margin of the `cols * cell` reconstruction; at 1050x700 (131 columns) it asks for `lg` + `side` and the client paints the real side column with all four candidate rows contained in it |
| the plan's §7.2 matrix, on THIS revision | 1100x640 and the short 1280x600 stay `lg` + real side with all four candidates contained and the footer contained; 900x640 and 560x640 are compact (`pv-none`, no inline row), open their Overview with `Back` + the one write contained, start the effort section on the first screen, and reach the Reader from the Overview's details row by pointer and back |
| the Overview's one-line summaries | for the long-identity model every Overview row is one native line (36px measured), so a 199-character ID or a long Current/Default can never wrap into a stack of rows and push the candidates off the screen |
| the wide column | the Model Details card head reads `Budget Mod… ›`; the footer is exactly `Cancel` + `Switch`; the inline selector renders all FOUR candidate rows (`○Default ●e1 ○e2 ○e3` — three advertised efforts plus the provider-default sentinel) and every row is inside the region the client paints it in |
| the Reader page | a click on the card HEAD *and* on a nested BODY TEXT line each opened the native `overlay`; the page paints NO picker at all (no action bar, no selectable row), and its long description is ONE client-wrapped value node (the client's own dump caps a node at 200 characters, so completeness is asserted on the wire and reachability on the pane) |
| the app-driven scroll | `Down` and `End` on the Reader each emitted one SDK `scroll` op for the body node the presenter really built, whose id is FRAME-SCOPED (`layer.model-details-reader-<serial>-rev-<rev>.model-details-body-<serial>-rev-<rev>`), and the CLIENT's own value node moved from `y=326` to `y=-568`; `Home` returned it to `y=326`, and 24 real line keys parked it in between (captured). The same keys away from the Reader emitted no op |
| every break kind renders | a `Status` value carrying LF, CRLF and an explicit blank line is rendered as FOUR native lines by the client (`64px` against the page's own `16px` line), so LF/CRLF/blank lines are honoured by the real client and not only by our wire (the client's node dump normalizes whitespace, so the dump is deliberately not the proof) |
| the Reader's return | its visible `Back` row (a REAL click) and `Esc` each returned to the page it was entered from, and the short 1000x400 split pane still opened it and still scrolled to the tail — as did the short wide 1280x600 pane |
| pointer/wheel scroll — OWNER EXEMPTION | this harness's control channel exposes NO pointer/wheel input (the lane probes three shapes and records the accepted set as `[]`), so the plan's pointer-scroll item cannot be discharged here; the same capability is verified through the app's own keys (`Down`/`Up`/`Home`/`End` at the top, the middle and the tail) |
| CJK/emoji glyphs | with `Noto Sans/Serif CJK` + `Noto Color Emoji` resolved by fontconfig, the long-value capture shows the CJK run as real glyphs and the rocket emoji in colour; before those fonts existed the same fixture rendered fallback blocks, which is recorded as an environment fact rather than a product result |
| the Reader's own view keys through a FAILED read (real pane) | the subject's own phase control made the read report a failure while the Reader was open: the failure appeared as the page's own `Status` fact, a scroll key still moved the CLIENT's viewport, and the visible `Back` row (a real click) returned to the model list — the row is never a dead control |
| the same rule for a RUNNING read (headless) | the headless suite covers the loading phase (a scroll key still emits the op; `Esc` returns to the origin with the panel still mounted and still loading), because the real-pane subject drives the failed phase only |
| no reused Reader frame (headless) | every Reader node id carries the frame's serial/revision, so a Back event from a retired Reader frame is refused rather than acting on a later one |
| the Overview's priority | at the split pane its first screen leads with `Model`, then `Reasoning effort` and every candidate (`Default`, `e1`, `e2`, `e3`) BEFORE the `View full model details ›` entry |
| the wide card's pointer hit | a real click on the card HEAD *and* on a nested BODY TEXT line (`sf-card-body > sf-text`, clicked at the centre of the fragment the client really shows) each opened the read-only page |
| real `select` / `activate` | a click on a NOT-selected row sends `select {item:"[\"shortp\",\"m2\"]"}`; clicking the now-selected row sends `activate`; the wide list only highlights (no page change, no write in either case) |
| the compact list at 400x600 | its footer renders `Cancel` alone (frames `Models:close`), i.e. no write from the list |
| the Overview at 400x600 | `Enter` opens it; its footer is `Back` + `Switch` (frame `{title:"Model overview", actions:[back, apply]}`) — no `Cancel` |
| footer containment (oracle) | 1280x800: bar `80,718,1120,48` holds `Cancel@1047.6,728,60.5,28` and `Switch@1120,726,68,32`; 400x600: bar `30,524,340,46` holds `Back@40,533,43.8,28 span=43.84` and `Switch@294,531,68,32 span=67.95` — every button lies fully inside its bar on both axes, and each visible span equals its full width (nothing clipped) |
| the one write | one real click on `Switch` produced exactly one `apply({provider:"shortp",model:"m",reasoningEffort:"e1"})` at the subject's writer seam; the admitted frame rendered `Close` + a disabled `Selecting…`; the (deliberately refused) outcome left the Overview usable with `[Back, Switch]` restored |
| the bounded column | with a model whose column cannot fit, the column offers the one `Open model & effort` entry, renders NO inline effort rows, and its BODY-text click and its `Tab`+`Enter` both open the same Overview |

What remains `NOT_VERIFIED` and is NOT claimed as passing:

- the +25% / +50% enlarged-UI-font matrix at the 400px floor and at the wide
  layout — the pre-existing Owner-accepted limitation above;
- `PageUp`/`PageDown` through the client's own control channel: this client's
  `key` command accepts `PageDown` but delivers no key for it (measured; `Down`,
  `Up`, `Home` and `End` are delivered), so the flow drives the same `scroll` op
  with those and the byte-level `CSI 5~`/`CSI 6~` mapping is covered headlessly;
- **pointer/wheel scrolling of the Reader body**: this harness's control channel
  exposes no pointer/wheel input at all (measured; the lane records `[]` for the
  shapes it tries), so the plan's pointer-scroll item is an explicit OWNER
  EXEMPTION — the same capability is verified through the app's own keys, which is
  what the app owns the keyboard for;
- IME, OS focus, dark themes, screen readers, terminal
  scaling, directories beyond the scripted sizes, the shipped full-profile/HMR and
  the Remote TSP application success path. The harness is a headless client: it
  says nothing about OS-level input methods, window focus or desktop font
  resolution.

A resolved write outcome is reported by the existing dock notice on any page that
cannot host a picker `message`.
