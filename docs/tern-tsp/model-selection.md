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
| `overview` | `Model overview` | the highlighted model's identity, its details entry and its effort candidates, all in the native main list | yes |
| `details` | `Full model details` | the model's complete wrapped facts (identity, Current/Default, description, draft effort, status) | **never** |

`overview` is the model's OWN page, never a global menu: it always describes
exactly one model, and closing it (`Back` / `Esc`) returns to the model list.

### The wide model list (`cols >= 120`) and its side column

The wide shell is piped as provider scopes + model list + a Model Details column,
and it is KEPT at every width that reaches `lg` (content never collapses the
shell):

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

At `cols < 120` the same picker renders `preview: 'none'`:

- the model list carries the provider-grouped rows and the inert failed-provider
  rows, and **no write action at all**: a row `select` or `activate` atomically
  selects that row and opens its Overview;
- the Overview's main list carries the wrapped identity facts, the single
  `View full model details ›` operation row, and the model's advertised effort
  candidates (marked `●`/`○`) — or one inert `Reasoning effort / Not available`
  row when the model advertises none. Arrow keys move a ROW cursor across every
  identity continuation line (so a long value is really readable), `Enter` /
  a click drafts on an effort row, opens the Full details page on the details
  row, and is inert on a static identity row;
- the Full details page is read-only and its only action is `Back`.

The compact picker shows the open-time subject (`Default model` / `Session model`)
once, on the native `strip`'s own line, because that is the picker's only
single-complete-line slot at `md` (the header title truncates a long line). That
line is a READ-ONLY DISPLAY with an empty chip list: it carries no `Action:` text,
no operation chip and no clickable entry, and it is not the removed global action
strip. The subject is never duplicated into the title, and at `lg` it uses the
picker's `subtitle` instead — so it has exactly one complete slot per layout.

The Overview is also what the wide BOUNDED column opens, so `cols` never decides
whether the full content is reachable.

### Scope and candidate namespaces

The SDK delivers the scope column's ids and the page's row ids on one channel, so
the two are told apart by **channel**, not by shape:

- A provider scope is chosen with `action { act: 'scope', value: <scope id> }`.
  `scope-all` is the every-provider entry; a provider scope is always `scope:`
  plus the provider ID. A value that names no scope at all, or a provider the
  current read does not advertise (including a failed provider's disabled scope),
  is refused with no state change. Only the model list page carries a scope
  column, so a scope action on the Overview or the details page fails closed.
- A row `select` / `activate` carrying a scope-shaped id is NOT a scope click: it
  acts only on an id the CURRENT page really renders (`visibleModels` on the model
  list, the Overview's own row set, the details page's own fact set). This is what
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
list and the Overview (`applyOffered`). The compact model list and the Full
details page have NO write, and a forged `action { act: 'apply' }` from them is
refused on the wire before any state change (the same admission the visible bar
uses). On a wide model list whose search matches NO model the write entry stays
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
| `overview`, `details` | `models → primary-action` |
| `pending` (admitted write) | the bar holds the keyboard (`Esc` only) |
| `loading` (running re-read) | the model list keeps its search box on the model list page (everything else is refused but `Esc`); the content pages admit only `Esc` |
| `error` (failed read) | the bar holds the keyboard (`Tab`/`Shift+Tab` both stay there) |

`Esc` is never swallowed. On a content page it is exactly the visible `Back`
(`overview → models`, `details → detailsReturn`); inside the action bar it
returns to the zone the bar was entered from; in the side regions it returns to
the model list; on the model list it closes the panel. An admitted write, a
running (re-)read and a failed read all close.

| Zone | `↑↓` | `Tab` / `Shift+Tab` | `Enter` | `Esc` |
|---|---|---|---|---|
| model list | browse models (search box text stays editable) | → the next painted zone | full wide column: focus the `detail-card` zone; compact or bounded: open the highlighted model's Overview — **never writes** | close |
| `detail-card` | — | → the effort zone (only while painted), then the bar | open the read-only Full details page (full column) or the model's Overview (bounded column), matching the card's own head and hint — **never writes** | back to the model list |
| `effort` (wide inline rows) | change the draft | → the bar / ← the details card | confirm the draft onto the Primary Action — **never writes** | back to the model list |
| `overview` | move the ROW cursor over every identity, details and effort row | → the bar | draft on an effort row, open the details entry, inert on a static fact — **never writes** | `Back` to the model list |
| `details` | move the read cursor (keeps a long value scrollable) | → the bar (only `Back`) | inert — **never writes** | `Back` to the page it came from |
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
model list, `Back` + the one write on the Overview, and `Back` ALONE on the
read-only page.

| Page / phase | Action bar (left to right) |
|---|---|
| `models`, wide | `Cancel`, `Retry` (only while part of the directory failed), `Switch` / `Save default` |
| `models`, compact | `Cancel`, `Retry` (only while part of the directory failed) — **no write** |
| `overview` | `Back`, `Switch` / `Save default` — **no `Cancel`** |
| `details` | `Back` alone — **no `Cancel`, no write** |
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
extended facts never decide whether the selector stays inline — they live on the
Full details page and in the Overview's continuation rows.

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

A fact row on the details page and in the Overview is a SINGLE measured 18px
line: the SDK ellipsizes what does not fit and never breaks an unbroken fragment
(a long id or glyph run), so "the row is 36px tall" is not a readability budget.
Every fact value is therefore pre-wrapped to the row's OWN one-line slot — the
measured slot minus the width of the label that row shares its line with, priced
at the 20px widest-glyph column bound — with the Owner-frozen caps of 11 columns
(compact) and 21 (wide) as upper bounds: the label-less rows of the narrowest
supported pane give 11 columns for compact (286px slot at a 400px pane; the cap
applies) and 17 for the wide side-preview list (366px slot at 1040px, the
narrowest pane that keeps the details column beside the list; 1100px gives 426px).
A row that carries a label gets a tighter bound from that label's own width. Every
value continues over as many rows as it needs, so no fact can be read only through
an ellipsis — including on the Overview's main list, which uses the same rule.

The single optional summary line of the wide column is ALWAYS exactly one rendered
line: any whitespace run — an explicit `LF`, `CRLF`, `CR` or Unicode line
separator included — folds into one space before it is clamped to the column
bound, and the full text stays on the Full details page (`Description`, `Status`).
The card head is folded and clamped the same way; the complete name stays readable
in the list row and on the Full details page.

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
fact value must have a complete reading path (its wrapped rows plus the native
list's own scrolling — the HISTORICAL PR4-A real-pane run checks exactly that by
walking the presentation cursor per width on the surfaces it measured), and every
Effort candidate must have a reachable path — the
Overview lists every candidate in EVERY layout (it is entered from the compact
model list, and from the wide column whenever the budget cannot prove the inline
selector), and the wide inline rows are the selector exactly while
`widePreviewFits` proves they all fit. The restructured Overview's own row cursor
is covered headlessly (the real-pane run below measured page/footer/pointer
behaviour, not a per-width cursor walk on that page). The run does NOT certify
enlarged UI fonts
at the wide layout, IME, themes or the Remote path: those stay `NOT_VERIFIED`.
Row granularity is therefore a COMPATIBILITY measure for the one-line native row —
a wrapped value is readable on its own rows — never a layout system of its own,
and it is not lowered further to paper over geometry the presenter cannot see.

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
```

The native Model suite drives the real runner, classifier, command handler and
SDK over a scripted tty and asserts on the reconciled wire tree: the wide/compact
layout props, the open-time subject per layout slot, the real `action('scope', …)`
filter with its refused shapes (a scope-shaped row `select`, an unknown or
disabled provider, a valueless action, a content page, a loading/failed read),
a radio-row `onClick` that only drafts, the compact row `select`/`activate` that
opens THAT row's Overview atomically, the Overview's row set and its Enter
semantics (inert static row, drafting effort row, details entry), the wide
details card and the bounded `Open model & effort ›` card (which opens the
Overview from BOTH its pointer handler and its `detail-card` zone Enter, while
the full card opens the read-only page from both), the read-only details
page and its `Back`, the K2 zone walk with Enter refused outside the Primary
Action, the page-by-page action bar (and its refusal on the compact list and the
details page), `Esc` returning to the zone/page it came from, a resize that keeps
the page and the draft AND a resize that leaves the `detail-card`/`effort` zones
for the really visible list without changing any invisible draft, a loading panel
that keeps the search editable and closes
on `Esc`, the pending/refusal/indeterminate settlements (a refusal keeps the page
it happened on), the read-error Retry through the original read owner, the
Current/Default facts of a live versus sessionless subject, wrapped long/CJK
descriptions, grapheme search, modal precedence, stale receivers, legacy-pane
refusal, a pane with `picker` but without `row`/`card`, a same-name Host command,
and one live Direct Session selection that CHANGES the model (verified through
the real Session log and an authoritative reopen). `test/model-picker.test.ts`
keeps the PiTui picker behavior; `test/tern-tsp-model-profile.test.ts` keeps the
official Loader/ConfigEditor profile save, the authoritative reopen and disk
recovery through a fresh Context.

## Real-pane verification of the restructured surface

The restructuring revision was driven in a real Tern pane (real Tern `0.8.2`,
`tern serve` + `tern ctl`, software rendering, the locked `@stencil-hq/tern@0.1.0`)
with the PRODUCTION `TspModelPicker` mounted over one official SDK inline surface
and REAL input: `ctl key` (real key events) and `ctl click <selector>` (real
pointer clicks). Measurements are quoted as the client's own element boxes
(CSS px at `deviceScaleFactor` 2), and the PNG/tree captures stay outside Git with
the review package.

| Verified | Result |
|---|---|
| real row gestures | clicking a NOT-selected model row sends `select {item}`; a double click sends `select` and then `activate` on the NEXT frame, and the wide list only highlights (no page change, no write); clicking the already-selected row sends `activate` |
| real keys | `Enter` on the model list opens the model's Overview (a real `enter` key event); `Esc` on the read-only page returns to the model list (`Back`, not close); `Tab` on the Overview renders the app's `▸ Switch` focus cue |
| the wide details card's pointer hit | a real click on the card HEAD (`.sf-card-head`), on a BODY TEXT line (`.sf-card-body .sf-text`) and on the card slot wrapper (`.pk-pv-slot`) each opened the read-only Full details page — the client attributes body-text clicks to the CARD node, so the `onClick` hit area is not limited to the header |
| the frozen footer caps | at 1280x800 the models footer is `Cancel` + `Switch`; at 400x600 the compact models footer is `Cancel` ALONE (no write) and the Overview footer is `Back` + `Switch`; the read-only page is `Back` alone (no `Cancel` anywhere on a content page) |
| footer containment | 1280x800: `pk-bar` x 80..1200 holds `Cancel` [1047.6,728,60.5,28] and `Switch` [1120,726,68,32] (right edge 1188); 400x600: `pk-bar` x 30..370 holds `Back` [40,533,43.8,28] and `Switch` [294.1,531,68,32] (right edge 362.1) — every button is fully inside its bar at both sizes |
| pointer operability of the one write | at 400x600 a real click on the primary button sent `action {act:'apply'}`, the panel showed `Close` + a disabled `Selecting…`, and exactly ONE `apply({provider,model,reasoningEffort})` reached the writer; the refusal path left the Overview usable with its buttons restored |
| resize | the real `resize` event drives the layout (400px ⇒ `cols` 47 ⇒ compact, `preview: 'none'`, no side column), and no resize paged or committed on its own |

What remains `NOT_VERIFIED` and is NOT claimed as passing:

- the +25% / +50% enlarged-UI-font matrix at the 400px floor and at the wide
  layout — the pre-existing Owner-accepted limitation above;
- physical wheel/trackpad, IME, OS focus, dark themes, screen readers, terminal
  scaling, directories beyond the scripted sizes, the shipped full-profile/HMR and
  the Remote TSP application success path.

A resolved write outcome is reported by the existing dock notice on any page that
cannot host a picker `message`.
