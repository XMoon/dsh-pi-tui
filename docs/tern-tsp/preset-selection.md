# Preset selection in the experimental TSP renderer

The existing `/preset` command now has PiTui and native TSP presentation
adapters. This is the PR4-A Preset implementation, not a completed PR4
milestone: Direct and PiTui remain the production defaults and TSP keeps the
experimental renderer opt-in described in [TSP integration](../tern-tsp.md). The
Owner froze the UX before this implementation (one compact native picker,
Built-in/Custom rows, a read-only Details page, independent
Current/Next-session/default/Draft facts, two-zone K2, explicit-action-only
writes); the code follows that spec rather than choosing a layout of its own.

The information structure borrows the official DSH Web preset section
(Built-in/Custom grouping, name, description, preset id, new-task default,
failed-to-load reason), but NOT its write semantics: the Web surface writes a
default on a healthy card click, while this surface keeps the frozen
browser-never-writes rule and requires an explicitly focused action, exactly like
the native Model picker. The Web surface's `View configuration` /
`agentPresets.read` YAML viewer, its Mode Guide, its Creator workflow and its
Coding Tools visibility rules have no counterpart in this repository's
`PresetCatalog` port and are deliberately not imitated.

## Availability and behavior

The mounted terminal must advertise the `picker` kind before the TUI-owned
`/preset` command family becomes available. The whole family rides that ONE
capability (`/preset`, `/preset <id>`, `/preset status`, `/preset default
[<id>]` share one registered command name), so no typed verb gets a raw-string
door around authoritative command classification; a pane without the kind refuses
them before invoking the handler and keeps the submitted draft. A genuine Host
command named `preset` keeps its Host route, and every other PiTui-only builtin
stays unavailable in TSP.

The capability is the `picker` kind alone, because that is the only kind this
layer could plausibly be missing: the status/hint lines and the layer column are
the core `col`/`text` kinds the native Model layer already depends on, and no
known Tern pane advertises `picker` without them.

One native `ui.picker` at the fixed `md` size with no preview column renders both
pages: the preset list and the read-only `Preset details` page. No overlay, no
self-drawn button, no injected stylesheet, no second overlay or confirmation
dialog.

The list is ordered Built-in first, then Custom, each group keeping the roster's
own order. The SDK declares no group node, so the grouping is a row-order fact
and every row's own second line names its kind (`Built-in · …` / `Custom · …`)
followed by a ONE-line description (`No description.` when the declaration
publishes none). A row that cannot compose a session (`broken`) keeps its
diagnostic in that same line (`Custom · Failed to load: <reason>`), is marked
with an error dot and a `Failed to load` badge, and stays browsable and readable
but can never be written. The raw preset id rides the row's `title` and is
complete on the Details page; the shipped four presets keep their fixed English
copy and a user declaration that reuses a shipped id keeps its OWN name and is
classified Custom, never silently relabelled.

The session/default facts are three INDEPENDENT single lines above the picker:

| Fact | Source | Shown when |
|---|---|---|
| `Current session: <id>` | the live Session's preset (`runner.currentPreset()`) | a live subject |
| `Next session: <id>` | the run-local pending preset (`runner.pendingPreset`) | a sessionless subject (in place of Current) |
| `New-session default: <id>` | the effective default (roster `defaultId`, else the Config owner's value) | always while a roster is known |
| `Draft: <id>` | the browse target, only while it is NOT one of the committed facts above | the user browsed away from every committed fact |

`none` stands for an absent value. A sessionless panel never fabricates a
`Current`, and a live panel never invents a `Next session`; the live Session's
own preset also carries the picker's native current marker. Each of these lines
is rendered as exactly ONE row: the value is asked for a single truncated line
(`truncate`/`lines`), so an unbroken 180-character id cannot turn the header into
a variable-height block that pushes the action bar out of a short pane (measured
on the real renderer at 400x600: every header/hint line stays one 15px row).
`Draft` is also marked as a badge on its row, so the browse target and the
committed facts are distinguishable at a glance.

The `Details` action opens the SAME picker over the highlighted row's complete,
inert facts: `Name`, `ID`, `Type (Built-in/Custom)`, the full `Description`, the
relationship facts it IS (`Current session` / `Next session` / `New-session
default`), `Failed to load` with its full reason, and the panel's own `Status`
notice while one exists. Every value is wrapped into complete rows by the shared
measured fact-row algorithm (the same one the Model picker uses, extracted to
`src/tui/tsp/picker-text.ts`), so a long description, a CJK/emoji name, an
explicit newline or an unbroken id is readable to its last row through the
native list's own scrolling — verified on the real renderer by walking the
keyboard through the rows of an unbroken 182-character id.

### Keyboard (K2, frozen)

Two logical zones — the list (including the Details page's fact rows) and the
action bar — share Tab; `zone` is presentation-local and never business
authority.

| Zone | `↑↓` | `Tab` / `Shift+Tab` | `Enter` | `Esc` |
|---|---|---|---|---|
| list | browse the rows (search box text stays editable) | → action bar / ← list | **browses only — never writes** | close |
| Details page | step the inert fact rows (the list scrolls to the row being read) | → action bar / ← list | **never writes** | back to the list, keeping the browse target |
| action bar | `←→`/`↑↓` move the focused action, skipping disabled ones | → list / ← back (a failed read is the exception: both stay in its bar) | **the only key that writes**, once, and only the FOCUSED enabled action | back to the zone it was entered from; a pending write, a running read and a failed read close |

The action bar is fixed and ordered `Details` (replaced by `Back` on the Details
page), `Use preset`, `Set new-session default`, `Close`; a failed roster read
replaces the writes with a single `Retry`. The `Use` wording follows the subject:
`Use for next session` without a Session, `Use in this session` for a still-blank
live Session. Entering the bar focuses the first AVAILABLE write (`Use`, else
`Set new-session default`, else `Details`/`Back`, else `Close`), and the focused
action carries an app-rendered shape cue (`▸ label`) because the SDK has no focus
affordance for a button. A disabled action never carries the cue, and neither
does a phase that refuses Enter from the bar at all (`loading`, `pending`) — the
cue is a promise about Enter. The bar-internal arrows cycle in render order among
enabled actions only, so a disabled `Set new-session default` (a broken row, or
the row that already IS the default) is never a dead focus target.

The SAME enabled decision is consumed by the one admission point, not only by the
rendering: an SDK `action` event (a pointer click, or any synthetic event naming
an action id) is refused while that action is disabled, so a disabled entry can
neither write nor dismiss the panel. Only the keyboard's `focusedAction` and the
rendered `disabled` flag are safe on their own; the admission consumes the same
predicate so the visible bar and the write path can never disagree.

`Ctrl+C` always remains the original application cancel owner, and a
Question/Approval modal owns the keyboard before the preset panel.

### Writes

`Use preset` and the typed `/preset <id>` verb both run the ORIGINAL
`applyPresetSelection` with the scope the panel was opened on. Without a Session
it stages the run-local pending preset and creates nothing; with a live Session
it enters the original session-transition gate and commits the Host's durable
`agent-preset/selected` selection — the Host's blank check stays the final
authority, so a Session that started while the panel was open is refused with the
original `agent-preset/locked` outcome. A blank live Session is the only case
where `Use in this session` can exist; a STARTED Session never gets a picker at
all (see below).

`Set new-session default` and the typed `/preset default <id>` verb call the SAME
extracted writer: validate through `presets.resolve`, write through the existing
Config owner, and refresh the standing catalog only when no higher-precedence
override masks the new default. It affects future Sessions only; it never
recomposes the current Session and never rewrites the run-local pending preset,
which is why the surface states `changes new sessions only` explicitly. The
Config owner's write is an awaited settings mutation, not a `WriteOutcome`, so a
raise is reported transparently as UNCONFIRMED — never as a proven rollback and
never retried automatically; the panel dismisses and the next read is
authoritative.

Browsing (rows, search, the Details page) only changes local browse state.
Closing the panel never cancels an admitted business operation.

A settlement that arrives after the panel's captured subject moved commits no
frame and takes no close decision — the fence retires that panel on its next
touch, and the rendered layer is dropped by the renderer's own hydration frame.
A settlement from a panel a newer invocation already replaced never closes or
repaints the new one, and a late roster read (or a late read failure) never
hydrates a moved subject.

### Loading, errors and retry

The panel is mounted IMMEDIATELY in its loading state (`Loading agent presets…`)
and the roster read runs as owned background work through the command's single
read owner, so the user gets instant feedback and may type a search query. A
running read admits the search box and `Esc` only.

An empty roster is a readable state (`No agent presets configured.`), never a
silent fallback to "select the first row". A failed read shows the native error
state with the failure text and one `Retry`, which re-enters loading through the
SAME read owner (one read in flight at a time). A failed read has exactly ONE
operable region — that bar — so `Tab` and `Shift+Tab` both stay in it instead of
walking the keyboard into an inert list, and its hint is `Retry first`.

A started Session (`sessionBlank() === false`) never opens a selectable picker:
the bare `/preset` path notifies the historical refusal message (pointing at
`/new` or `/preset default`) and returns an error, while `/preset status` stays a
read. Blankness comes from the Host turn-boundary authority, never from the TUI
transcript; an unknown blank state opens the picker and lets the Host be the
final authority.

Supersession is explicit: EVERY `/preset` invocation takes the panel's
presentation token, so a newer invocation retires whatever panel the previous one
had open while an already-admitted Host write still settles through its own
owner. A retired frame's node ids are gone from the renderer's target map, so an
event addressed at a previous revision (or at a foreign surface) is refused.
Hydration and disposal retire the panel synchronously, and a late roster read can
never reopen it.

### Ownership and lifecycle

`src/app/command/preset-presentation.ts` is a narrow Client-local presentation
contract carrying the open-time subject, the apply/set-default entries and the
panel handle. `src/tui/commands/models.ts` remains the singular read/write owner:
it captures Session scope, runs the one roster read, keeps the operation token
and calls the original `applyPresetSelection` / default writer.

`src/tui/pickers/preset-presentation-pitui.ts` keeps the original PiTui
behavior: the roster overlay opens only once the rows are known, rows keep their
exact original fields and wording, Enter on a row applies it in one step, and no
Retry/Details/Set-default action appears out of nowhere.

The native presenter is split by responsibility inside `src/tui/tsp/`:
`preset-picker.ts` owns panel lifecycle, interaction admission and coordination;
`preset-picker-state.ts` owns the panel state, the pure selectors, the row
projection, the status facts and the Details facts; `preset-picker-intents.ts`
owns the pure key/event → intent map (the whole K2 contract); `preset-picker-view.ts`
builds the node tree. Every key and every pointer event passes through the one
admission point, which rechecks the live panel, the subject, the presentation
revision and the phase before any mutation. Row ids carry their own `preset:`
namespace so a real preset id (any text, `:` and Unicode included) can never
collide with an action id or a Details fact-row id.

The renderer keeps ONE layer: opening the Model or the Preset presenter retires
the other first, so two panels can never coexist, and a Question/Approval modal
seat still takes precedence over both. The official SDK remains the sole tty
owner; no new Host lookup, wire operation, transport cache or public extension
API is introduced.

## What these numbers do and do not guarantee

The layout has no pixel budget of its own: the picker is always the compact `md`
shape, which is the same surface the Model picker's compact drill-down uses.
The measured facts behind the header and fact-row bounds (the `md` sheet's
content box, the fact-row one-line slot of 286px at a 400px pane, the ~7.8px/char
text advance) are LAYOUT PARAMETERS OF THE VERIFIED ENVIRONMENT — the measured
Tern build and its default UI font at the scale it was measured at — not a
universal no-clipping guarantee. The SDK's `Capabilities` carries only `cols` and
`cell` for geometry, so the presenter cannot read the picker sheet's real
geometry and does not try to; it promises one rendered row per header line and a
complete reading path per fact value, not a pixel fit for arbitrary fonts, DPI or
zoom.

Reachability is the invariant: a long value always has a complete reading path
(its wrapped rows plus the native list's scrolling), and every visible action is
keyboard reachable — proven on the real renderer at 1280x800, 900x640, 560x640
and the 400x600 minimum pane, and for the worst-case 180-character unbroken
identity at that minimum.

## Regression coverage

Build before running artifact-dependent tests, as required by `AGENTS.md`.

```sh
node scripts/run-with-temp-root.mjs node --test \
  test/tern-tsp-preset-picker.test.ts \
  test/tern-tsp-preset-runner.test.ts \
  test/preset.test.ts \
  test/tern-tsp-command-admission.test.ts
```

`test/tern-tsp-preset-picker.test.ts` drives the production presenter over the
real SDK pane and asserts on the reconciled wire tree: the Built-in/Custom
classification and ordering, a user preset reusing a shipped id, the independent
Current/Next-session/default/Draft facts, the K2 write admission (list Enter and
row activation never write; only the focused enabled action does), the arrow
cycle skipping disabled actions, the broken-row refusal, the read-only Details
page, complete CJK/emoji/newline/unbroken-id facts, loading/error/Retry, the
pending and settlement dispositions (staged/committed/indeterminate dismiss;
refused/locked stay usable), the empty roster with a reachable fallback, special
ids, a retired revision, an empty roster's focus fallback, Model/Preset layer
mutual exclusion and the fail-closed capability for a pane without the kind.

`test/tern-tsp-preset-runner.test.ts` runs the REAL classifier, capability
admission, original handler and Direct Host sinks: the capability refusal keeping
the draft and creating no Session, the native panel over the real
`agent-presets` registry roster, sessionless staging without a Session, the
started-Session refusal for both the bare and the typed path, the typed verbs
keeping their original routes and never opening a picker, a Host-owned `preset`
keeping its route, the blank live-Session switch over a REAL persisted Session
resumed through the official persistence seam (one durable `agent-preset/selected`,
the authority reread, the locked negative, a clean teardown), and the default
write through the real configuration plane (the picker's action and the typed
verb write the same profile document, and a fresh Context reads the persisted
default back). Both suites carry the
disabled-action admission refusal (a synthetic event naming a disabled action
writes nothing and never dismisses the panel); the presenter suite additionally
carries the lifecycle fences — a settlement after the captured subject moved
commits no frame and takes no close decision, a settlement from a panel a newer
invocation replaced never touches the new panel on either the apply or the
new-session-default path, and a late read never hydrates a moved subject. `test/preset.test.ts` keeps the PiTui preset behavior and the
shipped display copy; `test/tern-tsp-command-admission.test.ts` keeps the
post-classification admission predicate.

## Qualification limits

Physical mouse/wheel/IME/OS focus, dark themes, terminal scaling and screen
readers are NOT certified by these lanes; the real-pane runs are headless
(`tern serve` + the pane's own node tree and PNG), and a real-pane run on Tern
`0.8.0` is recorded in the review package rather than in the repository.

The blank live-Session switch IS certified end-to-end, through a test-infrastructure
seam rather than a product change: the TSP renderer refuses `/new` (a PiTui-only
builtin under the frozen PR3-B admission) and the official registry handle's
`dispose()` removes its session from the store, so no fixture could hand the
runner a blank Session. The fixture therefore uses the OFFICIAL persistence seam
directly — `create(header)` takes write ownership, `flush()` materializes the
artifact, and `close()` releases the handle without deleting the stored log — and
the runner's ordinary startup then resumes that persisted, released, blank
Session. The test drives the real TSP picker: the Host turn-boundary authority
reports the resumed Session as blank (a `Current session` fact, the `Use in this
session` wording, and no started-Session refusal), the focused action commits
through the original `applyPresetSelection` and the Host writer, the live
Session's own log gains exactly ONE `agent-preset/selected` while no Session is
re-created, the official Session projection and a reopened panel both reread the
new preset as Current, the new-session default is untouched, and a Session that
then STARTS is refused with the original `agent-preset/locked` wording without
writing anything. No durable commit is simulated, no projection is tampered with,
and no production authority, API or `/new` admission changed.

`Set new-session default` IS certified through the real configuration plane: the
test mounts the official preset-declaring plugin and the registry as REAL profile
rows, drives the picker's action, and reads the new `selectedDefault` out of the
real profile document the ConfigEditor/Loader wrote — then composes a FRESH
Context over that document and reads the persisted default back through a live
`agentPresets` registry. The typed verb writes the same document, which is how the
shared writer is proven. Remote TSP preset success and the shipped full
profile/HMR are open, as are catalogues and terminal sizes beyond the scripted
ones.
