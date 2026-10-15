# Preset selection in the experimental TSP renderer

The existing `/preset` command has PiTui and native TSP presentation adapters. This is the
native TSP Preset surface, not a completed PR4 milestone: Direct and PiTui remain the
production defaults and TSP keeps the experimental renderer opt-in described in
[TSP integration](../tern-tsp.md). The Owner froze the v4 UX before this implementation — a
TWO-page shape, ONE native cards catalogue whose footer carries the three native business
buttons (the panel's only writer), and ONE read-only Details page (identity, complete
description, a shipped preset's official Mode guide INLINE, a native Back navigation row) — and the
code follows that contract rather than choosing a layout of its own. Owner-approved
substitutes from the 2026-10-14 session: (ruling "a") the disabled reason is the footer
entry's tooltip plus the Details page's facts and the write-scope sentence lives on the
Details page, because the real client offers no paintable catalogue status slot; (A4
amendment) the Details way back is the native `ui.row({onClick})` navigation row instead of
a styled `html.button`, because the measured client paints no stylesheet border/background
on an `el` button.

The information structure borrows the official DSH Web preset section (Built-in/Custom
grouping, name, description, preset id, new-task default, failed-to-load reason, and the
official English Mode guides), but NOT its write semantics: the Web surface writes a default
on a healthy card click, while this surface keeps the frozen browser-never-writes rule and
requires an explicitly focused footer entry. The Web surface's `View configuration` /
`agentPresets.read` YAML viewer, its Creator workflow and its Coding Tools visibility rules
have no counterpart in this repository's `PresetCatalog` port and are deliberately not
imitated.

## Superseded UX

Three earlier shapes are **history, not contracts**, and none is ACTIVE:

- the `rows` catalogue whose long description was pre-split into measured one-line `fact`
  rows on a second `Preset details` picker page (`factRowItems` / `factCursor`);
- the 2026-10-12 plan's HTML-like two-column card grid with a surface-wide stylesheet;
- the v3 three-page shape (`Catalog → Overview → Guide`) whose business actions were accent
  `ui.row` operation rows on the Overview — superseded by the v4 Owner decision: business
  actions are the catalogue's native footer BUTTONS, and reading is ONE page with the guide
  inline.

The measured facts behind the current shape are in
[preset-v4-two-page-20261014.md](./evidence/preset-v4-two-page-20261014.md); the earlier
records stay where they were written
([preset-native-cards-reader-20261014.md](./evidence/preset-native-cards-reader-20261014.md),
[pr4-a-preset.md](./evidence/pr4-a-preset.md)).

## Availability and behavior

The mounted terminal must advertise the `picker`, `row`, `overlay`, `text` and `md` kinds
AND the `scroll` feature before the TUI-owned `/preset` command family becomes available:
those are the nodes the layer really builds (the native `ui.row({onClick})` Back
navigation, the identity `text` facts, the inline `md` guide) and the operation its reading
keys really issue. No stylesheet is used anywhere on this layer (Owner A4 amendment,
2026-10-14: the measured client paints no stylesheet border/background on an `el` button,
so the Details way back is native navigation — the `styles` feature and the sheet were
retired). The whole family rides
that ONE capability (`/preset`, `/preset <id>`, `/preset status`, `/preset default [<id>]`
share one registered command name), so no typed verb gets a raw-string door around
authoritative command classification; a pane that advertises less refuses them before
invoking the handler and keeps the submitted draft. A genuine Host command named `preset`
keeps its Host route, and every other PiTui-only builtin stays unavailable in TSP.

The layer carries exactly ONE page node — the catalogue's picker, or the Details overlay.
That is a measured constraint, not a preference: the native `md` picker is a modal sheet, so
a sibling text line collapses the layer column to its header block and the client paints the
sheet over it. (A page node handed to the region BARE — without the layer's `ui.col` wrapper
— is ACKed but paints nothing; also measured.)

### The catalogue

ONE native `ui.picker` at `size:'md'` with `layout:'cards'` and no preview region renders the
preset cards. The `cards` layout means each card's detail gets its own line; it is never a
two-column grid, so there is no breakpoint, no stylesheet and no second keyboard contract:
ONE column at every pane width.

The cards are ordered Built-in first, then Custom, each group keeping the roster's own order,
and the two groups are real `PickerGroup`s with the counts of the cards below them. Each card
carries the preset's name, its classification and a ONE-line summary (`No description.` when
the declaration publishes none); a declaration that cannot compose a session keeps
`Custom · Failed to load: <reason>` there, is marked with an error dot and a `Failed to load`
badge, and stays browsable and readable but can never be written. The raw preset id rides the
card's `title` and is complete on the Details page; the four shipped presets keep their fixed
English copy, and a user declaration that reuses a shipped id keeps its OWN name and is
classified Custom, never silently relabelled and never given the official guide.

The committed state is stated by the cards themselves — the native `Current`, `Next session`,
`Default` and `Draft` badges, present at every pane width — and in full by the Details page.
The ready-phase picker paints NO status text: `lead` and `message` stay unpainted and the
`subtitle` becomes the header's title tooltip (both measured), which is why the write-scope
sentence lives on the Details page (Owner ruling "a").

| Fact | Source | Shown when |
|---|---|---|
| `Current` | the live Session's preset (`runner.currentPreset()`) | the card IS that preset |
| `Next session` | the run-local pending preset | a sessionless subject, on the pending card |
| `Default` | the effective new-session default | the card IS that preset |
| `Draft` | the browse target | the browse target is none of the above |

A sessionless panel never fabricates a `Current`, and a live panel never invents a
`Next session`.

### The footer — the ONE writer

The catalogue's footer is the client's own action bar carrying EXACTLY the three native
buttons, in the Owner-approved visual shape:

```
[Close]            [Set default] [Use next]
 退出          次要操作          主要操作
```

- `Close` (plain) is the panel's DISMISSAL authority — the same intent `Esc` sends and the
  client's backdrop gesture; it never cancels an admitted write.
- `Use next` (sessionless subject) stages the run-local pending preset; `Use session`
  (blank-live subject) commits the durable in-session selection. `primary` — the client
  paints it rightmost with the filled weight.
- `Set default` (`primary` too) commits the new-session default. `primary` is a VISUAL
  grouping flag only: the client packs non-primary entries left and `primary` entries right
  in array order (measured, Tern 0.8.3), and marking both writes is what puts them together
  on the right, beside each other, exactly as the Owner mock draws.

The wire array order is `Close, Set default, Use*` (Owner ruling "a"). The painted order is
the CLIENT's pack rule and is asserted by the real-pane lane, never by the wire.

A footer entry that cannot act is DISABLED with its reason as the SDK `disabled` string —
`Already the default`, `Settings unavailable`, `Preset failed to load`, `No preset selected`.
The client greys such an entry (`off`, measured `opacity 0.45`) and exposes the reason as the
button's tooltip attribute; it paints NO in-place reason text, which is why the load-bearing
statements are the cards' own badges/details and the Details page's facts (Owner ruling
"a"). The SAME availability decision is consumed by the one admission point, so the greyed
entry cannot write through any channel: the key map, a pointer click, a bound `onClick`, or a
synthetic SDK `action` event.

The focused entry carries the design language's `Verb [Enter]` cue, and only while Enter
really runs it (the footer's arrows walk the enabled ring; `Tab`/`Shift+Tab` toggle the
`list`/`actions` zones). An admitted write or a running read offers ONLY `Close`; a failed
read swaps the writes for `Retry` (`primary`, rightmost) plus `Close`.

### The Details page

A card activation (`activate`, or `Enter`) REPLACES the picker with ONE native `lg` overlay
describing the selected preset. It is strictly READ-ONLY: no footer, no operation rows, no
write anywhere on it — the catalogue's footer is the only writer. Its ONE interactive node is
the native Back NAVIGATION row (`ui.row({onClick})`, Owner A4 amendment 2026-10-14, final
form): the label states the destination (`← Back to presets`) and its keyboard twin (`Esc`),
the row sits at the TOP of the reading body where every reading starts and reads as
NAVIGATION — never as a business write (the page is read-only). MEASURED: the client scrolls
every overlay child in the ONE body scroller, so the row leaves the viewport at the tail;
the ALWAYS-available fixed path is `Esc`, admitted at any scroll position through the same
ONE intent, and the catalogue keeps the query and the browse target for the way back.

The body is ONE continuous scroll carrying, in order:

- the complete identity — `Name`, `ID`, `Type (Built-in/Custom)`, and the scope sentence
  `Use: next session only | current blank session · Default: future new sessions` — from the
  roster's own untouched strings, wrapped by the client at the width the layout really has;
- its relationship facts, stated only for a row that really IS that subject
  (`Current session` / `Next session` / `New-session default`), and the complete
  `Failed to load` reason for a broken declaration;
- one rule, then the full `Description`;
- for a SHIPPED preset only, the official Mode guide INLINE: the pinned official English
  copy — the `Mode details` and `How to use` sections, verbatim from
  `deepseek-ai/deepseek-harness@d743267388641bc76f17c45ce8b4c231aed1d32c`
  (`packages/client/ui-agent-preset/src/client/guide-locales.ts`, MIT-licensed; the
  transcription's header carries the attribution) — as native Markdown in the same scroll. There is no `Read mode guide` jump and no third page. A Custom
  declaration that reuses a shipped id stops after the description and never borrows the
  official guide.

The arrows / `PgUp` / `PgDn` / `Home` / `End` scroll the body through the SDK's `scroll` op;
a running or failed read never leaves the page dead (`Back`/`Esc` always work).

### Keyboard and pointer

| Page | Keys | Result |
|---|---|---|
| catalogue, list | `↑↓`, typing, `Backspace` | move the browse target / edit the search — never a write |
| catalogue, footer | `Tab` toggles list↔footer; the footer's arrows walk the enabled ring; `Enter` on the focused enabled entry | `Use*`/`Set default` write once; `Close` only dismisses |
| catalogue, `Esc` | clears a non-empty search first, then closes | the frozen search-clear/close ladder, in every phase (error included) |
| Details | `Enter` runs Back; `Esc` is Back from ANY position (including the tail); `↑↓`/`PgUp`/`PgDn`/`Home`/`End` scroll the body | the top-of-body Back row is the pointer path; `Esc` is the fixed path everywhere |
| an admitted write | `Esc` closes the panel; `Ctrl+C` stays the application's | closing a panel never cancels the admitted operation |

`Ctrl+C` always remains the original application cancel owner, and a Question/Approval modal
owns the keyboard before the preset panel.

### Writes

`Use*` and the typed `/preset <id>` verb both run the ORIGINAL `applyPresetSelection` with
the scope the panel was opened on. Without a Session it stages the run-local pending preset
and creates nothing; with a live Session it enters the original session-transition gate and
commits the Host's durable `agent-preset/selected` selection — the Host's blank check stays
the final authority, so a Session that started while the panel was open is refused with the
original `agent-preset/locked` outcome. A blank live Session is the only case where
`Use session` can exist; a STARTED Session never gets a picker at all.

`Set default` and the typed `/preset default <id>` verb call the SAME extracted writer:
validate through `presets.resolve`, write through the existing Config owner, and refresh the
standing catalog only when no higher-precedence override masks the new default. It affects
future Sessions only; it never recomposes the current Session and never rewrites the
run-local pending preset. The Config owner's write is an awaited settings mutation, not a
`WriteOutcome`, so a raise is reported transparently as UNCONFIRMED — never as a proven
rollback and never retried automatically; the panel dismisses and the next read is
authoritative.

Browsing, searching, activating a card and reading the Details page only change local
presentation state. Closing the panel never cancels an admitted business operation.

A settlement that arrives after the panel's captured subject moved commits no frame and takes
no close decision — the fence retires that panel on its next touch, and the rendered layer is
dropped by the renderer's own hydration frame. A settlement from a panel a newer invocation
already replaced never closes or repaints the new one, and a late roster read (or a late read
failure) never hydrates a moved subject. NOTICES are fenced by the same two markers: the
operation token owns the write's settlement and the presentation token owns the display.

### Loading, errors and retry

The panel is mounted IMMEDIATELY in its loading state and the roster read runs as owned
background work through the command's single read owner, so the user gets instant feedback
and may type a search query. A running read admits the search box and `Esc` only, offers the
dismissal alone, and keeps whatever cards the previous read left on screen until the new read
arrives.

An empty roster is a readable state (`No agent presets configured.`), never a silent fallback
to "take the first card". A search that matches nothing paints no card and no group head, and
both writes are disabled (`No preset selected`). A failed read shows the native error state
with the failure text and `Retry` (`primary`, rightmost beside `Close`), which re-enters
loading through the SAME read owner (one read in flight at a time); the failed phase has
exactly ONE operable region — that footer — and its search box stays editable, so the Esc
ladder still clears a non-empty query before closing.

A started Session (`sessionBlank() === false`) never opens a selectable picker: the bare
`/preset` path notifies the historical refusal message (pointing at `/new` or
`/preset default`) and returns an error, while `/preset status` stays a read. Blankness comes
from the Host turn-boundary authority, never from the TUI transcript; an unknown blank state
opens the picker and lets the Host be the final authority.

Supersession is explicit: EVERY `/preset` invocation takes the panel's presentation token, so
a newer invocation retires whatever panel the previous one had open while an already-admitted
Host write still settles through its own owner. Hydration and disposal retire the panel
synchronously, and a late roster read can never reopen it.

### Identity and lifecycle

- The picker, its layer and the footer keep ONE identity for as long as the panel lives: their
  keys carry the panel serial, so a highlight, a notice or a repaint never remounts the list
  and never re-anchors its scroll position (the previous per-frame keys did, measured in the
  sibling Model probe). A stale footer action is fenced by the frame token in its id
  (`use#<revision>`, `set-default#<revision>`, `retry#<revision>`); `close` is deliberately
  untokened.
- The Details page takes ONE identity per READING: the overlay, its Back navigation row and its
  scrolling body carry the panel serial plus the reading's epoch, a fresh one on every entry.
  A re-render inside one reading changes nothing, and a `scroll` op queued by a previous
  reading can never address the next one's body. The presenter resolves a frame's body id
  from the SDK's OWN assignment while it indexes that frame, so a scroll can only ever name
  a node the current frame really built.
- NO stylesheet exists on this layer (Owner A4 amendment): the earlier scoped Back-button
  sheet was retired after the measured client painted no border/background on an `el`
  button (syntax ladder + pixel scan, `preset-v4-two-page-20261014.md` §3); the way back is
  the native navigation row instead.

### Ownership and lifecycle

`src/app/command/preset-presentation.ts` is a narrow Client-local presentation contract
carrying the open-time subject, the apply/set-default entries and the panel handle.
`src/tui/commands/models.ts` remains the singular read/write owner: it captures Session scope,
runs the one roster read, keeps the operation token and calls the original
`applyPresetSelection` / default writer.

`src/tui/pickers/preset-presentation-pitui.ts` keeps the original PiTui behavior: the roster
overlay opens only once the rows are known, rows keep their exact original fields and wording,
Enter on a row applies it in one step, and no Retry/Details action appears out of nowhere.
The PiTui path also keeps its ORIGINAL command settlement: the roster read is awaited inside
the handler there, so an empty roster is still the successful command carrying
`no agent presets configured`, and a real read failure is still rethrown to the command path —
which owns the failure notice, the health record and the draft restore. Only the native TSP
path mounts the panel immediately and reads the roster as owned background work; both paths
use the SAME read owner.

The native presenter is split by responsibility inside `src/tui/tsp/`:
`preset-picker.ts` owns panel lifecycle, interaction admission and coordination;
`preset-picker-state.ts` owns the panel state, the pure selectors, the card/group projection
and the action availability; `preset-picker-intents.ts` owns the pure key/event → intent map
(the whole two-page keyboard contract); `preset-picker-view.ts` builds the intent-bound node
tree; `preset-guide-content.ts` holds the pinned official guide copy. Every key, row event and
bound `onClick` passes through the one admission point, which rechecks the live panel, the
subject, the revision, the phase, the page and the SAME enabled predicate the page renders.
Row ids carry their own `preset:` namespace, so a real preset id (any text, `:` and Unicode
included) can never collide with an action id.

The renderer keeps ONE layer: opening the Model or the Preset presenter retires the other
first, so two panels can never coexist, and a Question/Approval modal seat still takes
precedence over both. The official SDK remains the sole tty owner; no new Host lookup, wire
operation, transport cache or public extension API is introduced.

## What these numbers do and do not guarantee

The layout has no pixel budget of its own: the picker is the client's own `md` sheet, which
shrinks below its measured `680px` cap on a narrow pane, and the cards are the client's fixed
`54px` virtual rows. The measured boxes
([evidence](./evidence/preset-v4-two-page-20261014.md)) are LAYOUT PARAMETERS OF THE VERIFIED
ENVIRONMENT — Tern `0.8.3` at its default UI font and scale — not a universal no-clipping
guarantee. The SDK's `Capabilities` carries only `cols` and `cell` for geometry, and the
presenter deliberately keeps NO width mirror: the client wraps every reading value itself, so
there is nothing to break-point. The promises are reachability and completeness: a long value
always has a complete reading path inside the body that really scrolls, the three footer
buttons and the Details Back are on screen at every supported pane, and every visible action
is keyboard reachable.

## Regression coverage

Build before running artifact-dependent tests, as required by `AGENTS.md`.

```sh
node scripts/run-with-temp-root.mjs node --test \
  test/tern-tsp-preset-picker.test.ts \
  test/tern-tsp-preset-runner.test.ts \
  test/preset.test.ts \
  test/tern-tsp-command-admission.test.ts
```

`test/tern-tsp-preset-picker.test.ts` drives the production presenter over the real SDK pane
and asserts on the reconciled wire tree: the cards layout with the two groups and their
counts, the classification and the badge set, a user preset reusing a shipped id, the
`select`/`activate`/`Enter` split, the Owner-shaped footer (array order, frame tokens,
`primary` weights, the disabled reasons), the catalogue write admission (only the focused
enabled entry writes, once), the Details page's complete identity/scope facts, the inline
pinned guide with no writer at all, the Back BUTTON as the page's ONE interactive node, the
complete long values inside the real scroll body, the navigation ladder (`Esc`/`Back`, the
search-clear ladder in the error phase too, a pending write's `Close`), the reading identity
and scroll target, the loading/error/empty/no-match phases, the settlement dispositions, the
stale/forged receivers, Model/Preset layer mutual exclusion and the fail-closed capability
(each required kind individually missing, and the missing `scroll` feature, all refuse
`/preset`).

`test/tern-tsp-preset-runner.test.ts` runs the REAL classifier, capability admission, original
handler and Direct Host sinks: the capability refusal keeping the draft and creating no
Session, the native panel over the real `agent-presets` registry roster, sessionless staging
without a Session, the started-Session refusal for both the bare and the typed path, the typed
verbs keeping their original routes and never opening a picker, a Host-owned `preset` keeping
its route, the blank live-Session switch over a REAL persisted Session resumed through the
official persistence seam (one durable `agent-preset/selected`, the authority reread, the
locked negative, a clean teardown), and the default write through the real configuration plane
(the FOOTER button and the typed verb write the same `selectedDefault`, and a fresh Context
reads the persisted default back). Both suites carry the disabled-operation admission refusal
(a synthetic event naming a disabled action writes nothing and never dismisses the panel);
the RUNNER suite additionally carries the notice fence (a settled write whose surface was
replaced notifies nobody, with a positive control on the same seam), and
`test/preset-command.test.ts` carries the standing-notice fence. The presenter suite
additionally carries the lifecycle fences — a settlement after the captured subject moved
commits no frame and takes no close decision, a settlement from a panel a newer invocation
replaced never touches the new panel on either the apply or the new-session-default path, and
a late read never hydrates a moved subject. `test/preset.test.ts` keeps the PiTui preset port
behavior and the shipped display copy; `test/tern-tsp-command-admission.test.ts` keeps the
post-classification admission predicate.

## Qualification limits

Physical mouse/wheel/IME/OS focus, dark themes, terminal scaling and screen readers are NOT
certified by these lanes; the real-pane runs are headless (`tern serve` plus the pane's own
node tree, PNG and layout capture) and are driven by
`scripts/tern-pane-preset-native-ux.mjs`, whose artifacts stay in its own run directory under
`temp/`. The painted footer ORDER, the Owner shape, the `off` greying and the tooltip-only
reason are real-pane measurements, not wire facts.

The blank live-Session switch IS certified end-to-end, through a test-infrastructure seam
rather than a product change: the TSP renderer refuses `/new` (a PiTui-only builtin under the
frozen PR3-B admission) and the official registry handle's `dispose()` removes its session
from the store, so no fixture could hand the runner a blank Session. The fixture therefore
uses the OFFICIAL persistence seam directly — `create(header)` takes write ownership,
`flush()` materializes the artifact, and `close()` releases the handle without deleting the
stored log — and the runner's ordinary startup then resumes that persisted, released, blank
Session. The test drives the real TSP picker: the Host turn-boundary authority reports the
resumed Session as blank (a `Current` badge, the `Use session` wording, and no
started-Session refusal), the focused footer entry commits through the original
`applyPresetSelection` and the Host writer, the live Session's own log gains exactly ONE
`agent-preset/selected` while no Session is re-created, the official Session projection and a
reopened panel both reread the new preset as Current, the new-session default is untouched,
and a Session that then STARTS is refused with the original `agent-preset/locked` wording
without writing anything. No durable commit is simulated, no projection is tampered with, and
no production authority, API or `/new` admission changed.

`Set default` IS certified through the real configuration plane: the test mounts the official
preset-declaring plugin and the registry as REAL profile rows, drives the footer's own button,
and reads the new `selectedDefault` out of the real profile document the ConfigEditor/Loader
wrote — then composes a FRESH Context over that document and reads the persisted default back
through a live `agentPresets` registry. The typed verb writes the same document, which is how
the shared writer is proven. Remote TSP preset success and the shipped full profile/HMR are
open, as are catalogues and terminal sizes beyond the scripted ones.
