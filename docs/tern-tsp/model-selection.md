# Model selection in the experimental TSP renderer

The existing `/model` command has PiTui and native TSP presentation adapters.
This is the PR4-A implementation, not a completed PR4 milestone: Direct and
PiTui remain the production defaults and TSP keeps the experimental renderer
opt-in described in [TSP integration](../tern-tsp.md). The Owner froze the Model
UX (wide B2 single-surface explorer, compact sequential drill-down, K2 keyboard,
explicit-apply-only writes, native components only) before this implementation;
the code follows that spec rather than choosing a layout of its own.

## Availability and behavior

The mounted terminal must advertise `picker`, `row` and `card` before the
TUI-owned `/model` command becomes available; a pane missing any of them refuses
the command before invoking its handler and keeps the submitted draft. This
admission follows authoritative command classification: a genuine Host command
named `model` keeps its Host route, and other PiTui-only builtins remain
unavailable in TSP.

**Main layout** (`cols >= 120`, native `lg` picker with a side preview) shows
provider scopes (with per-provider counts and an error dot for a failed read), a
provider-grouped model list, and a Model Details column: provider, ID, the
Default/Current **value** of the highlighted model when one applies, and — for a
model that advertises reasoning metadata — a `Reasoning Effort` card whose
options are native `row`s acting as radio buttons. The details and effort pages
are CONTENT pages of the same picker: at either width they render with
`preview: 'none'`, carry no scope column and no side summary that would duplicate
what the page itself shows, and keep the `lg`/`md` size of the current width.
The model list is the only page with a scope column. The compact layout
(`cols < 120`) uses the same picker without a preview and drills through three
pages: model list, Full model details, Reasoning Effort. Neither layout uses an
overlay, a self-drawn button or an injected stylesheet.

A provider scope is chosen on the SDK's own channel: a scope-column click is
`action { act: 'scope', value: <scope id> }`, never a row `select`. A row
activation is a model highlight or an effort candidate, so a scope-shaped row id
can never reach the filter (§ "Scope and candidate namespaces" below).

The open-time subject is fixed when the panel opens and is shown ONCE, in the
layout's own subject slot — never concatenated into the page title, because the
picker header truncates a long single line (measured `Models · Default f…` at
560 columns): the `lg` layout puts it in the picker `subtitle` (on every page),
the `md` layout in the strip's own line above the action bar. The page title stays
short (`Models` / `Full model details` / `Reasoning Effort`): the verified client
renders all three complete from the measured 560px pane upward, and at the 400px
width floor it ellipsizes `Full model details` to `Full model …` (measured, see
the action-bar note below) — a layout limit of the floor, not a claim that the
title is unconditionally complete.

The details area carries the configured-selection facts, both derived from the
one directory read: `Current` only for a live Session (never for a sessionless
subject) and `Default` from `directory.default` **including its own effort**, so
a persisted default effort is never lost when the default is not the current
model. The list marks the directory default with a `Default` badge and the live
Session's model with a `current` badge. The subject wording is never reused as a
fact label. A model description is rendered in full on the compact details page, wrapped
into complete rows (grapheme- and display-column-aware, so an emoji surrogate
pair is never split and a CJK line holds half as many code points as an ASCII
one; verified at 900x640 and 560x640 with ASCII, CJK and emoji text). The wide
card shows the same description while the geometry budget above holds.

Browsing (model rows, provider scopes, details pages, the More page's rows) and
clicking an effort radio row only change local browse state — the highlight, the
scope filter or that model's draft effort. **Only the visible Primary Action
writes**: it reads the short `Confirm` and states its full name — `Switch Model`
with a live Session, `Choose & Save as Default` without one — in the operation
block, so one action performs one operation through one writer. The
provider-default sentinel submits
without a `reasoningEffort`; a real effort submits the advertised id. Naming the
button never changes what the writer does: the live write is the existing Session
selection and the sessionless write is the existing "confirm the model and save
it as the future default" intent, and neither is split into two operations.

### Keyboard (K2, frozen)

Up to four logical zones share Tab — the model list, the effort selector, the
strip (only while it carries the `More actions…` chip) and the action bar;
`zone` is presentation-local and is never business authority. Tab and Shift+Tab
walk the zones the CURRENT page really paints, in a ring: on the model list
`models → strip (only while its chip is rendered) → effort (only when the
highlighted model advertises efforts) → action bar`; the details and More pages
have the two-stop `list ↔ action bar`
ring; the effort page has `models ↔ effort ↔ action bar`.

| Zone | `↑↓` | `Tab` / `Shift+Tab` | `Enter` | `Esc` |
|---|---|---|---|---|
| model list | browse models (search box text stays editable) | → strip (while its chip is rendered), then the effort selector (the inline one while the side preview is not paged, otherwise its effort PAGE), then the action bar / the same ring backwards | → the effort selector when the model advertises efforts (inline while the side preview is not paged, otherwise its effort PAGE), else focus the action bar — **never writes** | close |
| effort | change the draft | → action bar / ← back along the ring: the STRIP while the selector is inline, the model list on the effort PAGE | confirm the draft, focus the action bar — **never writes** | back to the PAGE the effort page was opened from (the model list while the selector is inline), keeping the draft |
| strip | — | → the effort selector, then the action bar / the ring backwards | open `More actions…` — **never writes** | back to the model list |
| More page | move the secondary-action cursor | → action bar / ← list | run the selected secondary operation — **never writes** | back to the model list |
| action bar | — | → the next zone in the ring | **the only key that writes**, once, when the FOCUSED action is the enabled Primary | return to the zone/page the bar was entered from (a failed read closes) |

The rings are per page, and the `effort` zone means two different things: on the
model list at wide width it is the INLINE selector rendered by the side column, so
its reverse stop is the strip; on the effort PAGE the ring is
`model list ↔ effort ↔ action bar`, because that page renders no strip chip. The
details and More pages always have the two-stop `list ↔ action bar` ring.

The effort zone is visibly focused through the SDK's own `focus: preview` (the
effort PAGE through `focus: list`), the strip through `focus: strip`, and every
other list through `focus: list`. The SDK has no focus affordance for an action,
so the FOCUSED action carries an app-rendered shape cue (`▸ Confirm` / `▸ Retry` /
`▸ Back` / `▸ Cancel`).

The bar itself is SHORT by design (see "The action bar, the operation block and the More page" below):
`←→`/`↑↓` move across the two entries it renders and `Enter` activates exactly
the focused one through the same intent path the pointer uses, so every visible
action is keyboard reachable and only the Primary Action resolves to a write. The
secondary operations are equally keyboard reachable without ever entering the
bar: Tab reaches the strip, `Enter` opens the More page, its arrows move the
cursor and `Enter` runs the selected operation. A disabled action never carries
the cue, and neither does an action the current phase cannot run from the keyboard
at all (`pending`, `loading`): the cue is a promise about `Enter`, so a phase that
refuses `Enter` marks nothing and shows no bar hint. `Esc` returns to the zone and
page the action bar was entered from (a details page stays a details page, the
More page stays the More page), and the effort page's `Esc` returns to the page it
was opened from, keeping the draft.
While a write is pending, `Esc` closes; a running (re-)read and a failed read
close too, because at that point the bar is the only region any key can run.
`Ctrl+C` always remains the original application cancel owner, and a
Question/Approval modal owns the keyboard before the Model panel.

### The action bar, the operation block and the More page

The native action bar lays its buttons on ONE line and does not wrap them, and the
bar has no scroll port of its own. A bar whose buttons do not fit its `pk-bar` is
cut at that edge, which is what used to push the ONE write action partly or
entirely outside the sheet at narrow panes and enlarged UI fonts. The bar is
therefore SHORT AND FIXED: `Cancel` plus at most one short entry besides the
page's own `Back`, and the full business meaning lives next to the list instead of
inside a button.

| Page | Action bar (left to right) |
|---|---|
| model list | `Cancel`, `Confirm` |
| Full model details | `Cancel`, `Back`, `Confirm` |
| Reasoning Effort | `Cancel`, `Back`, `Confirm` |
| More actions | `Cancel`, `Back` (this page never writes) |
| `loading` / `pending` / `error` | `Cancel`, Primary (a disabled `Confirm` while loading, a disabled `Selecting…` while the write is admitted, the read-only `Retry` while the directory read failed) |

`Confirm` is the visible label of the same stable `apply` action: the live write
still switches the Session's model and the sessionless write still confirms the
model and saves it as the future default, in ONE operation. The complete name of
that operation — `Choose & Save as Default`, `Switch Model`, or `Retry loading
models` — is stated by the OPERATION BLOCK, one headless column rendered by the picker on
the model list page: `Selected model: <provider> /
<model>`, `Reasoning effort: <label>` while the model advertises efforts, `Action:
<complete name>` and one plain sentence of consequence. Its lines are rendered
WHOLE and wrapped by the client at whatever width the region really has (measured:
the sentence becomes two lines at a 400px pane). The verified client places that
region BELOW the list at `md` and HIDES it at the narrowest panes — see the
measured limitation below.
At `lg` the same region IS the side column, and a four-line block whose sentence
wraps into eight to twelve lines at the column's own 248px text slot would alone
exceed the fixed 374px budget the column shares with the details card and the
inline effort radios: it would evict the inline Rational Effort selector at every
pane. The wide page therefore states the same operation in the strip's own line
instead — `Action: <complete name>` — and the side column keeps its action-first
structure and its budget exactly as before.

The SECONDARY operations never enter the action bar. They live on the `More
actions` page — the same picker, one more page — whose rows are exactly the
operations that can act right now, in this order: `Full model details…` (only while
a model is highlighted, because it renders THAT model's facts and would otherwise
open an empty page), `All reasoning effort levels…` (only while the highlighted
model advertises effort options), `Retry failed providers (N)` (only while part of
the directory failed, `N` being the failure count) and `Back to models`. The page is reached from the
model list's single strip chip `More actions…`, which the SDK delivers as
`action { act: 'strip', value: 'strip-more' }` on the same channel as the bar
actions, and from the keyboard through the `strip` zone.

`Cancel` is the visible label of the same stable `close` action, so its backdrop
and `Esc` behavior are unchanged. The action **ids** are the routing authority and
stay stable (`close`, `details`, `effort-page`, `back`, `retry`, `apply`), the
More page's rows carry the `more:` prefix of the action they run, and the strip
chip carries `strip-more`; the key map and the row router act on those ids, never
on display text.

#### Scope and candidate namespaces

The SDK delivers the scope column's ids and the page's row ids on one channel, so
the two are told apart by **channel**, not by shape:

- A provider scope is chosen with `action { act: 'scope', value: <scope id> }`.
  `scope-all` is the every-provider entry; a provider scope is always `scope:`
  plus the provider ID. A value that names no scope at all, or a provider the
  current read does not advertise (including a failed provider's disabled scope),
  is refused with no state change. Only the model list page carries a scope
  column, so a scope action on a drill-down page fails closed.
- A row activation (`select` / `activate`) carrying a scope-shaped id is NOT a
  scope click: it highlights a model when it names a visible row and is otherwise
  ignored. This is what keeps a catalogue that advertises a provider literally
  named `all` — or a model whose effort id IS `scope-all` or starts with the scope
  prefix — unambiguous.
- An effort candidate row carries its own `effort:` namespace, so a candidate
  value that looks like a scope id still takes the draft.
- The strip's chip arrives on the action channel as `action { act: 'strip', value:
  'strip-more' }`, its own id namespace again: a strip click can never be read as a
  bar action or as a provider scope. The More page's rows carry the `more:` prefix
  of the action they run, and only the `apply` action they can reach is ever a write.

### Loading, errors and retry

While the directory is loading the panel still admits the search box (frozen
§4.5: the query stays editable) and always admits `Esc`; every other key is
refused and the Primary Action renders disabled, so a loading panel can neither
be mutated nor left unable to close. The hint names the phase (`Selecting…` for
an admitted write, `Reading…` for a running read) rather than promising a
`Tab`/`←→` this phase refuses. The command's single directory-read owner
serves both the first read and every Retry: one in-flight read at a time, the
same `runOwned` task, captured scope, signal, presentation token and supersession
semantics. A read failure shows the
native error state with one message and makes the Primary Action the read-only
`Retry` (reachable from the keyboard). A failed read has exactly ONE operable
region — that bar: the stale rows stay on screen for context, but the phase
browses neither the list nor the search box and refuses `Enter`, so `Tab` and
`Shift+Tab` both stay in the bar (where `←→` moves between `Retry` and the
always-enabled `Cancel`) instead of walking the keyboard into an inert list, and
its hint is `Retry first`. A partial failure keeps the reached
providers usable, lists the failed provider as an inert row (compact) or an
error-dot scope (wide), and offers `Retry failed providers (N)` as one row of the
`More actions` page, so a failure can never widen the action bar and push the one
write action out of it.
Retry repairs the same mounted panel and preserves the query and every draft the
new directory still advertises.

Pending saves disable every mutation entry (including the effort rows and the
Primary Action) and keep `Cancel` available; closing does not cancel an admitted
business operation. Rejected, cancelled and unsupported outcomes leave the
picker usable with its draft and report the outcome; indeterminate outcomes
close it with the original reconciliation notice. Hydration and disposal retire
the picker synchronously, and receivers bound to a previous panel serial and
presentation revision are never routed again.

### The model list page: an action-first details column

The model list page at `cols >= 120` ALWAYS keeps its structure: provider scopes,
the model list and a Model Details column. Content never collapses the shell, and
the column gives its vertical space to the ACTION: the Reasoning Effort radio
rows, which are what a user changes most often. The two drill-down pages (Full
model details, Reasoning Effort) render no scopes and no side column at all: they
are content pages, and their complete facts or candidate list is what fills them.

The column therefore shows, in this order: the model name (the card head, folded
to one clamped line), the provider and the model ID (each pre-wrapped to at most
two provable lines, the complete value readable in the details page), the
keyboard hint and — inside that same details card, while room is left — a SINGLE
optional line carrying a transient notice or a one-line description summary; the
Reasoning Effort card follows it.
When the effort rows cannot be inline, the SAME column becomes the bounded
summary and stays action-first: the bounded identity, the keyboard hint, the one
optional line and only then the configured Current/Default facts, capped at a
line count the budget proves. The description's full text and the extended
Current/Default facts never decide whether the effort selector stays inline; the
identity's own bounded lines ARE priced, so a longer identity can move the effort
rows to the Effort page — never the shell itself. Whatever does not fit is
one `More actions…` strip chip away in the same picker's pages (the `More
actions` page's `Full model details…` and `All reasoning effort levels…` rows),
which the model list always offers.

The complete Effort page is reachable in EVERY layout through the `More actions`
page (or, at compact width, straight from the model list with `Enter`), not only
when the budget pages the column: it is the same native Picker list, over
the same draft, with the same K2 confirmation, and it is what keeps every
candidate readable and selectable when the environment's font or zoom makes the
column's own fit unsure (the inline radio rows stay the primary selector). Its own
acceptance is that it really reads, selects and returns — which the real-pane run
checks BY KEYBOARD per width and per UI-font configuration at the 400px floor
(open `More actions…`, run `All reasoning effort levels…`, step a candidate, return — or take the compact `Enter` shortcut).
The compact layout keeps a
second, direct path: `Enter` on the model list opens the effort page when the
highlighted model advertises efforts, so a keyboard user never has to visit the
details page first. While the effort page is open the keyboard is on the PAGE:
the native list takes the focus, and leaving the effort zone for the model list
(`Shift+Tab`, or `Tab` from the action bar) leaves the page with it, so the model
list's arrows and `Esc` behave exactly as they do on the list.

A fact row on the Details page is a SINGLE measured 18px line: the SDK ellipsizes
what does not fit and never breaks an unbroken fragment (a long id or glyph run),
so "the row is 36px tall" is not a readability budget. Every fact value is
therefore pre-wrapped to the row's OWN one-line slot — the measured slot minus
the width of the label that row shares its line with, priced at the 20px
widest-glyph column bound — with the Owner-frozen caps of 11 columns (compact)
and 21 (wide) as upper bounds: the label-less rows of the narrowest supported
pane give 11 columns for compact (286px slot at a 400px pane; the cap applies)
and 17 for the wide side-preview list (366px slot at 1040px, the narrowest pane
that keeps the details column beside the list; 1100px gives 426px). A row that
carries a label gets a tighter bound from that label's own width. Every value
continues over as many rows as it needs, so no fact can be read only through an
ellipsis.

The single optional line is ALWAYS exactly one rendered line: any whitespace run
— an explicit `LF`, `CRLF`, `CR` or Unicode line separator included — folds into
one space before it is clamped to the column bound, and the full text stays on the
Details page (`Description`, `Status`). The card head is folded and clamped the
same way; the complete name stays readable in the list row and on the Details
page.

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
(`Capabilities` / `session.caps`), only `cols` and `cell` describe geometry, and the
resize event only `cols`/`cell`/`visible`, so the presenter
cannot detect a shorter pane and cannot degrade further below the floor. The
supported envelope is a wide pane whose usable height is at least 374px (about
600px of pane height at the measured 226px of chrome) whose width is at least
400px (the width floor of the Details fact rows above); every size in that
envelope renders the same height-independent decision, and the inline selector is
promised only while the budget proves it. Panes BELOW either floor are an
explicitly accepted limitation — the column scrolls instead of degrading, and
neither this document nor the implementation claims the layout is safe there. At
the 400px floor the picker's own header subject line is still ellipsized: the
guarantees in this section are about the Details fact rows and the Effort paths,
not a claim that every string of the surface fits at that width. The 400px width
floor is also the floor of the fact ROWS only: the ACTION BAR has its own,
larger requirement (measured below), so a pane between 400px and about 680px is
inside the fact-row envelope while the five-button details bar still clips its
Primary Action.

Measured coverage of this rule (a representative catalogue of mainstream model
shapes, tabulated in the review package) is the reason this document promises the
inline Effort selector only while the budget proves it: every 1–5 option model in
the sample keeps it inline (the worst case — a two-line provider, a two-line id
and a description summary — costs ~363px), while a model whose identity plus
options no longer fit (eight or more options, a long identity, or labels longer
than the column) uses the Effort page. The table in the review package separates
the CAPACITY curve (`widePreviewNeededPx` against different pane heights) from
the production decision, which is the fixed 374px budget and therefore does not
become more permissive on a taller pane. No-effort models draw no selector at all
and are not counted as Effort drill-downs.

### What these numbers do and do not guarantee

Every floor and column bound above is a LAYOUT PARAMETER OF THE VERIFIED
ENVIRONMENT — the measured Tern build, its default UI font at the 100% scale it
was measured at — and NOT a universal no-clipping guarantee. A different UI font,
an enlarged terminal font, a changed system DPI or a browser/UI zoom moves the
ratio between the picker's content area and the glyph advance, which a fixed
pixel budget cannot track, and the presenter has no reliable way to read the
details area's real geometry: the SDK reports terminal `cols` and a cell size,
not the picker sheet's own box. A stricter guarantee needs a Tern-side
content-area or layout capability, which is out of scope here; reverse-engineering
the client's CSS is explicitly not done.

What has to hold in every environment is reachability, not a pixel promise: a long
fact value must have a complete reading path (its wrapped rows plus the native
list's own scrolling, which the real-pane run checks by walking the presentation
cursor per width), and every Effort candidate must have a reachable path — the
complete Effort page is two steps away in every layout (`More actions…` then
`All reasoning effort levels…`), and the
compact layout reaches it directly from the model list with `Enter`; the
real-pane run verifies BY KEYBOARD, per width and per UI-font configuration at the
400px floor, that the page opens, steps and returns. The run does NOT certify
enlarged UI fonts at the wide layout, IME, themes or the Remote path: those stay
`NOT_VERIFIED`. Row
granularity is therefore a COMPATIBILITY measure for the one-line native row — a
wrapped value is readable on its own rows — never a layout system of its own, and
it is not lowered further to paper over geometry the presenter cannot see.

### The action bar's measured limit, and the 400px client limitation

The action bar lays its buttons on ONE line and does not wrap them, and it has no
scroll port of its own, so a bar whose buttons do not fit its `pk-bar` is cut at
that edge. That is why the bar is short and fixed now: the previous revision put
four or five entries in it (including the whole `Choose & Save as Default`
sentence as the write button), and a real-pane measurement found the write action
clipped from 560px down on the details page and entirely outside the sheet at the
400px floor and at enlarged UI fonts. With `Cancel` + one SHORT entry
(`Confirm` / `Retry` / `Back`) plus the secondary operations moved to the More
page, the bar's requirement drops to about 200px of pane, well below the
documented 400px width floor. Measured with the production presenter in a real
pane: at 400x600 the bar is a 30–370px box holding `Cancel` and `Confirm`, both
fully contained, at the client font AND at a +25% and +50% UI font; the details
page's `Cancel`/`Back`/`Confirm` are likewise contained at the 560x640 pane (a
500px bar) and at 900x640, where the previous five-entry bar already clipped the
write action.

The OPERATION BLOCK is subject to a client limitation that must be stated
plainly. The verified client renders the picker's preview region — the region the
block is rendered into — BELOW the list at `md` (measured at 900x640: the list ends
at y=378, the block's four lines sit at y=399/421/443/465, fully inside the region,
and the strip starts at y=510) and NOT into the wide side column at `lg`, and it
WRAPS the block's long sentence naturally on two lines at a 400px-wide pane. At the 400x600 floor, however, the
client marks the picker `pv-hide` and DROPS the whole preview region, so the block
is absent there:

> **KNOWN_CLIENT_LIMITATION.** At the 400x600 floor (and at any pane the client
> decides to hide the preview region in) the OPERATION BLOCK is not displayed.
> What is guaranteed at that width is the short footer itself: `Cancel` and
> `Confirm` are complete and readable, the highlighted target stays identifiable
> in the list, and every operation stays reachable by mouse and by keyboard. The
> full operation meaning is NOT readable there, and that is recorded rather than
> worked around by shortening the meaning or by drawing a region of our own.

The wide page states the operation in one line instead of the full block, because
the block's own wrapped height (8–12 lines at the side column's 248px text slot)
exceeds the column's whole 374px budget and would therefore destroy the inline
Reasoning Effort selector the Owner asked to keep.

**Owner decision — Model Picker Responsive Action Explanation (ratified).** Based on
these real-pane measurements the unified requirement "at 560px and above EVERY
layout must permanently display the complete, auto-wrapping operation-consequence
explanation" is CANCELLED, and the explanatory content's layout is accepted per
layout class instead:

- `md` shows the complete explanation through the below-the-list region (measured
  at 900x640: all four of its lines sit fully between the list and the strip, so it
  is rendered as a headless column — a card head cost one of that region's few
  lines and pushed the consequence sentence past its bottom edge);
- `lg` shows the complete business action NAME in the strip and keeps the side
  column's Model Details and its inline Reasoning Effort, with no multi-line
  explanation added;
- the 400px floor does not show the complete consequence explanation, per the
  `KNOWN_CLIENT_LIMITATION` above — but the TARGET stays identifiable there by
  another means: the highlighted model's own row states its drafted effort
  (`<provider> · <effort label>`, measured `provider p · High`), so the write's
  model AND effort are readable on the confirmation page even where the block is
  dropped.

Every layout still has to satisfy: the primary action button is completely visible,
the target Model/Effort is identifiable, the write happens only after an explicit
confirmation, the keyboard and mouse paths are equivalent, and there is no blind
write and no duplicate submission. The decision changes only the layout acceptance
of the explanatory text; no business write or safety constraint changes.

**Owner decision — Model Picker 400px Font Scaling (`KNOWN_UI_LIMITATION` /
`OWNER_ACCEPTED`).** At a 400x600 pane with an ENLARGED UI font — both +25% and
+50% — the native client truncates the selected model/provider/effort information
(measured: at +25% the highlighted row renders only `Reasoning Model` and
`Default`, at +50% likewise, and the strip subject is ellipsized too), so the target
is not readable there while `Confirm` still is and stays enabled. The Owner
explicitly ACCEPTS this as a known client-side UI limitation and lets the user
decide whether to confirm; no geometry-based write guard and no further
font-specific layout workaround is added, and the K2 explicit-apply and Host Writer
semantics are unchanged. Both configurations are recorded as known UI limitations
and are NOT claimed as visually passing. This waiver does NOT apply to the
default-font 400x600 layout, to the normally supported widths, to an incorrect
selection, or to a duplicate write. The exact per-configuration
measurements, the fragments that were really clicked and the screenshots live in
[the PR4-A evidence](./evidence/pr4-a.md) §0. The `lg`/`md` sizes, the fact-row
slots, the scope column and the Effort paths are unaffected: the operation block is
NOT rendered into the wide side column and that column's 374px budget is unchanged
(a multi-line block there would evict the inline effort radios).

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
disabled provider, a valueless action, a drill-down page, a loading/failed read),
a radio-row `onClick` that only drafts, the K2 zone walk with Enter refused
outside the Primary Action, the page-by-page action bar (`Cancel` /
the `more:`-prefixed More-page rows / the page's own `Back` / the one Primary
Action, whose full name the operation block states), the `strip` zone and the
`More actions…` chip (`action(act:'strip')`), `Esc` returning to the zone/page it came
from, the resize from the wide effort zone into the compact effort page, a
loading panel that keeps the search editable and closes on `Esc`, the
pending/refusal/
indeterminate settlements, the read-error Retry through the original read owner,
the Current/Default facts of a live versus sessionless subject, wrapped long/CJK
descriptions, grapheme search, modal precedence, stale receivers, legacy-pane
refusal, a pane with `picker` but without `row`/`card`, a same-name Host command,
and one live Direct Session selection that CHANGES the model (verified through
the real Session log and an authoritative reopen). `test/model-picker.test.ts`
keeps the PiTui picker behavior; `test/tern-tsp-model-profile.test.ts` keeps the
official Loader/ConfigEditor profile save, the authoritative reopen and disk
recovery through a fresh Context.

## Qualification limits

Physical wheel, IME and OS-focus semantics, dark themes, terminal scaling, screen
readers, directories beyond the scripted sizes, the shipped full-profile/HMR,
clean live-Agent teardown and the Remote TSP application success path are NOT
certified by these lanes: the real-pane driver summarized in
[the evidence doc](./evidence/pr4-a.md) §0 exercises pointer clicks and keys on
exactly the paths it lists, and nothing beyond them. Headless real-Tern runs (the renderer's own tree and PNG) are
kept outside the repository with the review package; this document records the
maintainable behavior and boundaries. A compact write outcome is reported by the
existing dock notice rather than inside the picker, because the native picker
renders a `message` only in its error state.
