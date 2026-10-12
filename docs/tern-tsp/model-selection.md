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

**Wide layout** (`cols >= 120`, native `lg` picker with a side preview) shows
provider scopes (with per-provider counts and an error dot for a failed read), a
provider-grouped model list, and a Model Details column: provider, ID, the
Default/Current **value** of the highlighted model when one applies, and — for a
model that advertises reasoning metadata — a `Reasoning Effort` card whose
options are native `row`s acting as radio buttons. **Compact layout** (`cols <
120`) uses the same picker without a preview and drills through three pages:
model list, Model details, Reasoning Effort. Neither layout uses an overlay, a
self-drawn button or an injected stylesheet.

The open-time subject is fixed when the panel opens and is shown ONCE, in the
layout's own subject slot — never concatenated into the page title, because the
picker header truncates a long single line (measured `Models · Default f…` at
560 columns): the wide layout puts it in the picker `subtitle`, the compact
layout in the strip's own line above the action bar. The page title stays short
(`Models` / `Model details` / `Reasoning Effort`), so it never ellipsizes.

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
that model's draft effort. **Only the visible Primary Action writes**: `Apply`
with a live Session, `Save default` without one. The provider-default sentinel
submits without a `reasoningEffort`; a real effort submits the advertised id.

### Keyboard (K2, frozen)

Three logical zones — the model list, the effort selector, the Primary Action —
share Tab; `zone` is presentation-local and is never business authority.

| Zone | `↑↓` | `Tab` / `Shift+Tab` | `Enter` | `Esc` |
|---|---|---|---|---|
| model list | browse models (search box text stays editable) | → effort (only when the model advertises efforts), else → Primary Action / reverse | → effort, else focus the Primary Action — **never writes** | close |
| effort | change the draft | → Primary Action / ← model list | confirm the draft, focus the Primary Action — **never writes** | back to the model list (keeps the draft) |
| Primary Action | — | → model list / ← effort | **the only key that writes**, once, when the action is enabled | back to the previous zone (a failed read closes: see below) |

The effort zone is visibly focused through the SDK's own `focus: preview` (the
compact effort page through `focus: list`); the model-list zone through
`focus: list`. The SDK has no focus affordance for an action, so the FOCUSED
action carries an app-rendered shape cue (`▸ Apply` / `▸ Save default` / `▸ Retry`
/ `▸ Details` / `▸ Back` / `▸ Choose effort`).

Within the action zone `←→`/`↑↓` move the focused action and `Enter` activates
exactly that action through the same intent path the pointer uses — so every
visible action (including `Details`, `Back`, `Choose effort` and the
partial-failure `Retry`) is keyboard reachable, and only the Primary Action
resolves to a write. A disabled action never carries the cue, and neither does an
action the current phase cannot run from the keyboard at all (`pending`,
`loading`): the cue is a promise about `Enter`, so a phase that refuses `Enter`
marks nothing and shows no bar hint. `Esc` returns to the zone and page the
action bar was entered from (a details page stays a details page), and the compact
effort page's `Esc` returns to the page it was opened from, keeping the draft.
While a write is pending, `Esc` closes; a running (re-)read and a failed read
close too, because at that point the bar is the only region any key can run.
`Ctrl+C` always remains the original application cancel owner, and a
Question/Approval modal owns the keyboard before the Model panel.

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
always-enabled `Close`) instead of walking the keyboard into an inert list, and
its hint is `Retry first`. A partial failure keeps the reached
providers usable, lists the failed provider as an inert row (compact) or an
error-dot scope (wide), and offers an explicit `Retry failed providers` action.
Retry repairs the same mounted panel and preserves the query and every draft the
new directory still advertises.

Pending saves disable every mutation entry (including the effort rows and the
Primary Action) and keep `Close` available; closing does not cancel an admitted
business operation. Rejected, cancelled and unsupported outcomes leave the
picker usable with its draft and report the outcome; indeterminate outcomes
close it with the original reconciliation notice. Hydration and disposal retire
the picker synchronously, and receivers bound to a previous panel serial and
presentation revision are never routed again.

### The wide shell: an action-first details column

The wide layout (`cols >= 120`) ALWAYS keeps its structure: provider scopes, the
model list and a Model Details column. Content never collapses the shell, and the
column gives its vertical space to the ACTION: the Reasoning Effort radio rows,
which are what a user changes most often.

The column therefore shows, in this order: the model name (the card head, folded
to one clamped line), the provider and the model ID (each pre-wrapped to at most
two provable lines, the complete value readable in the Details page), the
keyboard hint, the Reasoning Effort card, and then a SINGLE optional line
carrying a transient notice or a one-line description summary when room is left.
When the effort rows cannot be inline, the SAME column becomes the bounded
summary and stays action-first: the bounded identity, the keyboard hint, the one
optional line and only then the configured Current/Default facts, capped at a
line count the budget proves. A long description, a long identity or the extended
Current/Default facts never decide whether the effort selector stays inline — the
complete description, every fact and every effort candidate that does not fit are
one `Details` / `Choose effort` action away in the same picker's pages, which the
action bar always offers.

The `Choose effort` page is offered in EVERY wide layout, not only when the
budget pages the column: it is the same native Picker list, over the same draft,
with the same K2 confirmation, and it is what keeps every candidate readable and
selectable when the environment's font or zoom makes the column's own fit unsure
(the inline radio rows stay the primary selector). Its own acceptance is that it
really reads, selects and returns — which the zoom and font matrix in the review
package checks per configuration. While that page is open the keyboard is on the
PAGE: the native list takes the focus even though the wide column keeps its inline
rows beside it, and leaving the effort zone for the model list (`Shift+Tab`, or
`Tab` from the action bar) leaves the page with it, so the model list's arrows and
`Esc` behave exactly as they do on the list.

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

374px is a LAYOUT BUDGET, not an SDK guarantee. `SessionCaps` carries only
`cols`/`cell` and the resize event only `cols`/`cell`/`visible`, so the presenter
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
not a claim that every string of the surface fits at that width.

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
list's own scrolling), and every Effort candidate must have a reachable path — the
`Choose effort` page is offered in every wide layout, even while the radio rows are
inline, and the zoom/font matrix in the review package verifies per configuration
that the page lists, steps and confirms the candidates over the same draft. Row
granularity is therefore a COMPATIBILITY measure for the one-line native row — a
wrapped value is readable on its own rows — never a layout system of its own, and
it is not lowered further to paper over geometry the presenter cannot see.

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
layout props, the open-time subject per layout slot, provider scopes, a radio-row
`onClick` that only drafts, the K2 zone walk with Enter refused outside the
Primary Action, the action-bar focus walk (including `Details` and the
partial-failure `Retry`), `Esc` returning to the zone/page it came from, the
resize from the wide effort zone into the compact effort page, a loading panel
that keeps the search editable and closes on `Esc`, the pending/refusal/
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

Physical mouse/wheel/IME/OS focus, dark themes, terminal scaling, screen readers,
directories beyond the scripted sizes, the shipped full profile/HMR, clean
live-Agent teardown and the Remote TSP application success path are NOT certified
by these lanes. Headless real-Tern runs (the renderer's own tree and PNG) are
kept outside the repository with the review package; this document records the
maintainable behavior and boundaries. A compact write outcome is reported by the
existing dock notice rather than inside the picker, because the native picker
renders a `message` only in its error state.
