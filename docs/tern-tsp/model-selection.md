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

Browsing (model rows, provider scopes, details pages) and clicking an effort
radio row only change local browse state — the highlight, the scope filter or
that model's draft effort. **Only the visible Primary Action writes**: it reads
`Switch Model` with a live Session and `Choose & Save as Default` without one —
one action, one operation, one writer. The provider-default sentinel submits
without a `reasoningEffort`; a real effort submits the advertised id. Naming the
button never changes what the writer does: the live write is the existing Session
selection and the sessionless write is the existing "confirm the model and save
it as the future default" intent, and neither is split into two operations.

### Keyboard (K2, frozen)

Three logical zones — the model list, the effort selector, the Primary Action —
share Tab; `zone` is presentation-local and is never business authority.

| Zone | `↑↓` | `Tab` / `Shift+Tab` | `Enter` | `Esc` |
|---|---|---|---|---|
| model list | browse models (search box text stays editable) | → effort (only when the model advertises efforts), else → Primary Action / reverse | → effort, else focus the Primary Action — **never writes** | close |
| effort | change the draft | → Primary Action / ← model list | confirm the draft, focus the Primary Action — **never writes** | back to the model list (keeps the draft) |
| Primary Action | — | → model list / ← effort | **the only key that writes**, once, when the action is enabled | back to the previous zone (a failed read closes: see below) |

The effort zone is visibly focused through the SDK's own `focus: preview` (the
effort PAGE through `focus: list`); the model-list zone through `focus: list`.
The inline `focus: preview` exists only on the model list page, the only page
that renders a side column. The SDK has no focus affordance for an action, so the
FOCUSED action carries an app-rendered shape cue (`▸ Switch Model` /
`▸ Choose & Save as Default` / `▸ Retry` / `▸ Full details…` / `▸ Back to models`
/ `▸ Back to details` / `▸ All effort levels…` / `▸ Cancel`).

Within the action zone `←→`/`↑↓` move the focused action and `Enter` activates
exactly that action through the same intent path the pointer uses — so every
visible action (including `Full details…`, the page's `Back …`, `All effort
levels…` and the partial-failure `Retry`) is keyboard reachable, and only the
Primary Action resolves to a write. A disabled action never carries the cue, and
neither does an action the current phase cannot run from the keyboard at all
(`pending`, `loading`): the cue is a promise about `Enter`, so a phase that refuses
`Enter` marks nothing and shows no bar hint. `Esc` returns to the zone and page the
action bar was entered from (a details page stays a details page), and the
effort page's `Esc` returns to the page it was opened from (`Back to details`
when the details page opened it, otherwise the model list), keeping the draft.
While a write is pending, `Esc` closes; a running (re-)read and a failed read
close too, because at that point the bar is the only region any key can run.
`Ctrl+C` always remains the original application cancel owner, and a
Question/Approval modal owns the keyboard before the Model panel.

### The action bar, page by page

The main page offers the three intuitive operations only — `Cancel`, the reading
entry `Full details…` and the ONE Primary Action — plus `Retry failed providers`
while part of the directory failed. It never repeats an effort shortcut next to
the details drill-down.

| Page | Actions (left to right) |
|---|---|
| model list | `Cancel`, `Full details…` (disabled with no highlighted model), `Retry failed providers` (partial failure only), Primary |
| Full model details | `Cancel`, `Back to models`, `All effort levels…` (only when the model advertises effort options), `Retry failed providers` (partial failure only), Primary |
| Reasoning Effort | `Cancel`, `Back to details` \| `Back to models` (the page it was opened from), `Retry failed providers` (partial failure only), Primary |
| `loading` / `pending` / `error` | `Cancel`, Primary (a disabled `Selecting…` while the write is admitted; the read-only `Retry` while the directory read failed) |

`Cancel` is the visible label of the same stable `close` action, so its backdrop
and `Esc` behavior are unchanged. The action **ids** are the routing authority
and stay stable (`close`, `details`, `effort-page`, `back`, `retry`, `apply`);
only the labels are Owner-frozen strings, and the key map routes by id, never by
display text.

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
error-dot scope (wide), and offers an explicit `Retry failed providers` action.
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
one `Full details…` (and, from there, `All effort levels…`) action away in the
same picker's pages, which the action bar always offers.

The complete Effort page is reachable in EVERY layout through the details page,
not only when the budget pages the column: it is the same native Picker list, over
the same draft, with the same K2 confirmation, and it is what keeps every
candidate readable and selectable when the environment's font or zoom makes the
column's own fit unsure (the inline radio rows stay the primary selector). Its own
acceptance is that it really reads, selects and returns — which the real-pane run
checks BY KEYBOARD per width and per UI-font configuration at the 400px floor
(open the details page, open the complete Effort list, step a candidate, return).
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
complete Effort page is one `Full details…` action away in every layout, and the
compact layout reaches it directly from the model list with `Enter`; the
real-pane run verifies BY KEYBOARD, per width and per UI-font configuration at the
400px floor, that the page opens, steps and returns. The run does NOT certify
enlarged UI fonts at the wide layout, IME, themes or the Remote path: those stay
`NOT_VERIFIED`. Row
granularity is therefore a COMPATIBILITY measure for the one-line native row — a
wrapped value is readable on its own rows — never a layout system of its own, and
it is not lowered further to paper over geometry the presenter cannot see.

The ACTION BAR is a separate constraint from the columns and the fact rows. The
native client lays its buttons on ONE line and does not wrap them, and the bar
carries no scroll port of its own, so a bar whose buttons do not fit its
`pk-bar` is cut at that edge. Measured per page and per pane (the action bar of
each of the three pages):

| Pane | model list (4 buttons) | Full model details (5 buttons) | Reasoning Effort (4 buttons) |
|---|---|---|---|
| 1280x800 | fits | fits | fits |
| 900x640 | fits | fits | fits |
| 560x640 | fits | **Primary clipped** (67px of 171px visible, label cut to `Choose &`) | fits |
| 400x600, client font | Primary clipped (38px of 171px) | Primary invisible; `Retry failed providers` clipped to 54px of 139px | Primary clipped (22px of 171px) |
| 400x600, UI font +25% | Primary invisible; `Retry failed providers` clipped | `All effort levels…`, `Retry failed providers` and Primary all clipped/invisible | Primary invisible; `Retry failed providers` clipped |
| 400x600, UI font +50% | the same SET of buttons clips (fragment widths differ) | the same SET | the same SET |

So the bar's real requirement is the width of ITS OWN button set: the 5-button
DETAILS bar needs roughly 680px of pane, which is why it already clips the Primary
at the measured 560px pane while the 4-button model-list and effort bars still fit
there. That fifth button is `Retry failed providers`, which exists only while part
of the directory failed: measured at 560x640, that bar is `Cancel` 42–96,
`Back to models` 98–203, `All effort levels…` 205–314,
`Retry failed providers` 316–455, Primary 463–634 inside a 30–530px bar, so
WITHOUT a failed provider the same page's four buttons would end at 493 and fit —
a GEOMETRIC DERIVATION from those measured boxes, not a measured no-failure pane.
At the 400x600 floor, and on any of the three pages at an enlarged UI font,
buttons fall outside the sheet entirely — the `▸` focus cue is then invisible or
unreadable too, so even the keyboard write can only be triggered blind.

The Owner-frozen wording is never abbreviated to make this fit, and no button is
self-drawn or wrapped: these are `STOP`-class environment limits reported to the
Owner (the plan's §8 condition), not a silent PASS and not a license to change the
frozen UI here. [The PR4-A evidence](./evidence/pr4-a.md) §0 carries the
per-configuration measurements, the fragments that were really clicked and the
screenshots. The `lg`/`md` sizes, the fact-row slots and the Effort paths are
unaffected by this: it is the ONE action bar per page that cannot present its
rightmost button at these widths.

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
`Full details…` / `All effort levels…` / the page's own `Back …` / the
partial-failure `Retry` / the one Primary Action, with `Choose & Save as Default`
sessionless and `Switch Model` live), `Esc` returning to the zone/page it came
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
