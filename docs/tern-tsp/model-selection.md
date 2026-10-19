# Model selection in the experimental TSP renderer

The existing `/model` command has PiTui and native TSP presentation adapters.
This is the PR4-A implementation plus its **list-first** UX revision, not a
completed PR4 milestone: Direct and PiTui remain the production defaults and TSP
keeps the experimental renderer opt-in described in
[TSP integration](../tern-tsp.md).

The Owner-frozen Model UX is TWO pages, and both are the model's own:
**Models** (the catalogue, which is the WORKING page) and **Full details** (the
read-only Reader). On the catalogue a user picks a model, changes its Reasoning
Effort in the catalogue's own **strip** (the native Picker region between the list
and the footer), and commits once from the explicitly labelled footer action; a row
activation (`Enter`, or a click on the already-highlighted row — the client's own
double click) opens that model's Full details DIRECTLY, with no intermediate page in
between. The catalogue is ONE native picker at every pane width — a single column of
model rows, no provider sidebar, no side column and no preview region — and the ONE
write is an explicit footer action. There is **no global action menu, no global
operation block and no second-level effort menu**: the ONE Reasoning Effort editor
is the catalogue's strip.

### Superseded layouts: history is not this surface's contract

Earlier Model plans proposed a wide Explorer, provider sidebar, a three-page `Models → Overview → Full details` path and a second-level Effort editor. The PR #301 Owner revision **retired** those shapes: one working list with the **only** Effort editor as a native `strip`, direct read-only Reader and the explicit footer write are now authoritative. Historical plans and their measurements remain valid **as dated evidence only**, not as Must/acceptance requirements. This exact composition is `/model`-specific, not a global requirement for every TSP picker. Real-client evidence is Tern `0.8.3 (e2b8656)` headless; dark theme, physical wheel/trackpad, IME/OS focus and enlarged-font matrix are not silently promoted to PASS.

## Availability and behavior

The mounted terminal must advertise `picker`, `row` and `overlay` before the
TUI-owned `/model` command becomes available; a pane missing any of them refuses
the command before invoking its handler and keeps the submitted draft. Those are
the three kinds the presenter really constructs: the catalogue picker,
the Reader's `Back` row and the read-only Reader's overlay. The list-first
revision retired the wide details Cards, so `card` is no longer an admission
requirement. This admission follows authoritative command classification: a
genuine Host command named `model` keeps its Host route, and other PiTui-only
builtins remain unavailable in TSP.

### Pages

| Page | Title | Content | Write |
|---|---|---|---|
| `models` | `Switch model` (live) / `Choose default model` (sessionless) | the provider-grouped model catalogue, with its own Reasoning Effort strip below the list | **yes**, at every width |
| `details` | the model's own name | the model's COMPLETE values, grouped, in the native **Reader** (an `overlay` the client wraps at its own width and the app scrolls), read-only | **never** |

The title states what the page's ONE write really does, so there is no separate
subject slot to keep in sync with it and nothing to truncate. The `details` page is PAINTED as the native Reader instead of a picker (see "The
read-only Reader"), and it is always entered from the catalogue: its visible `Back`
row and the `Esc` that shares its intent return there.

### The catalogue (one list-first picker at every width)

**One node identity per panel, and that is a defect fix.** The picker and its layer keep
ONE node key for as long as the panel lives (`model-<serial>`); the Reader's body and its
`Back` row keep ONE key **per reading** (the panel serial plus that reading's epoch, so
re-entering the Reader takes a new one). The frame revision never reaches a long-lived key.
MEASURED on the real client with a 42-model
catalogue: a key that changes per frame makes the SDK diff `del(oldPicker) + add(newPicker)`,
so the client REMOUNTS the list — and a freshly mounted list brings its selected row into
view, which moved the whole viewport under a click (the click on a row four rows above the
selection shifted the list by exactly four rows). The isolated A/B/C/D probe confirms the
cause: with one stable key and the same `selected` change, every row keeps its exact
coordinates and only the highlight moves; with a per-frame key the list shifts. The full
catalogue is sent again, so the client's own scroller (and its scrollbar and wheel) is
back.

The fence that the per-frame key used to provide is not weakened, it MOVED:
- the bar's actions carry the frame revision in their own id (`apply#<rev>`,
  `retry#<rev>`) and are rebuilt every frame, so an action event from an earlier
  revision is refused at admission exactly like a node id that was never rendered;
  `close` is deliberately the ONE untokened action, because `Esc` and the client's own
  backdrop gesture must dismiss the panel from any frame;
- a ROW event is validated against what the panel offers right now (a row id the current
  page does not carry resolves nowhere), and the node id must belong to a frame this pane
  really built, which is what refuses a foreign panel's id;
- the cross-PANEL isolation is the `serial`: a reopened panel gets its own node ids, so a
  previous panel's id can never act on its replacement;
- a STRIP item id names the MODEL it was built for as well as the candidate value
  (`effort:<row id>\u0000<value>`), and a strip click must match BOTH the model the strip
  currently shows and a candidate that model advertises. A click is delivered asynchronously,
  so the user can select another model in between; a value-only check would then let the
  previous model's candidate draft into the newly highlighted one whenever both happen to
  advertise the same value. (`modelRowId` is a JSON string, so a raw NUL cannot occur inside
  the model half — the first NUL separates the two exactly, and an effort VALUE may itself
  contain a NUL, as the synthetic provider default does);
- a ROW click also reclaims the keyboard: selecting a row is a list interaction, so the focus
  returns to `models`. Otherwise the zone that was live before the click keeps owning the keys
  — the user highlights a model with the mouse while their next `↑`/`↓` drafts the PREVIOUS
  model's effort (or walks the action bar) without ever seeing the highlight move;
- the read-only Reader paints no action bar and its only operation is navigation, so it needs
  no action token of its own; its node ids carry the panel SERIAL and the READING's epoch —
  one identity for as long as one reading is open (a per-frame key remounted the container and
  retired the app's own scroll target), and a NEW reading takes a new one, so a `scroll` op
  queued by a closed Reader can never address the next reading's body.

The catalogue is ONE native picker: `layout: 'rows'`, ALWAYS `size: 'md'`,
`preview: 'none'` at every width, and NO `scopes` column ever. The sheet is a dialog
at every pane width — the client shrinks it by itself when the pane is narrower than
its own cap — so the page's shape never changes with the window.

- **Rows.** ONE row per (provider, model). `label` is the model name (the main
  information), `mark` is a deterministic 1–2 character abbreviation of the
  provider's own advertised name (`{text, seed}`, never a fabricated logo),
  `detail` is the provider name, `title` is the complete model id, and `badges`
  carry the REAL `current` (a live Session fact) and `default` (the directory
  fact) only — the browse highlight is never painted as either. The row id is the
  provider+model JSON pair, so the same model id under two providers is two
  independently addressable rows. A row states NO effort of its own: the effort is
  edited in the page's strip below, where every candidate of the highlighted model
  is visible and actionable at once.
- **Order.** A pinned `Current · Default` group comes first and each configured
  model appears exactly ONCE (it is not repeated in its provider's group), then
  one group per provider. No `Recent` group, no MRU and no row listed twice.
- **Partial failure.** Only while the current read reports failed providers, the
  list ends with a `Unavailable providers` group holding one inert row per failed
  provider plus the ONE read-only `Retry failed providers` row. That row is the
  phase's only operation and routes to the command's existing read owner — never
  to the writer. The client keeps a disabled row selectable (measured), so the
  app itself refuses every row shape the list does not currently offer.
- **The Reasoning Effort strip (every width).** Below the list the catalogue paints
  the native Picker `strip`: its head reads `Reasoning Effort` and it carries ONE
  button per candidate the HIGHLIGHTED model advertises, in the directory's own
  order, with the local DRAFT marked as the client's own "on" item. It is painted —
  and its action channel admitted — ONLY while the phase is `ready`: the client
  paints no disabled strip item, so a strip left on screen during an admitted write,
  a running re-read or a failed one would be a promise the panel cannot keep (the
  same `stripOffered` predicate gates the display and the admission). A chip label is
  clamped to the pane's own strip capacity with the design language's content
  ellipsis: the client WRAPS the chips onto further rows but can neither shrink nor
  wrap ONE chip, so a label wider than the chip container would be cut at the sheet's
  edge (measured in a 400x600 pane: the container is 193.27px while the widest chip
  measures 308.59px). The budget is the reconstructed pane width minus the measured
  strip chrome (`stripLabelColumns`: the sheet is `pane - 44px` wide up to the client's
  measured `680px` cap — so the budget stops growing with the window at that cap — and
  the label column, gutters and chip padding take `169px`; one column per 12px of the
  strip's own 12.5px font, display-width aware), and the clamp keeps BOTH ends
  (`clampMiddle`): an effort
  name is free-form, two candidates can differ only in their tail, and a strip item
  carries no `title`, so a head-only clamp could render one label for two different
  candidates. The COMPLETE label stays exactly where it came from — the directory and
  the Reader's configured facts. While the strip owns the
  keyboard the picker requests the client's OWN region focus (`focus: 'strip'`, the
  measured `pk-sheet f-strip` class), so the region is not signalled by our ink. Clicking a
  button (or placing the keyboard on the strip with `Tab` and using its arrows)
  changes that model's local draft and NOTHING else — no write, no page change. A
  model that advertises no effort metadata paints NO strip at all, and no page hides
  that editor behind a second page. The strip is what makes the frequent task
  (choose → set the effort → confirm) a one-page operation.
- **No preview region.** The catalogue asks for `preview: 'none'` at every width:
  the client reserves a fixed ~36% of the sheet body for `preview: 'below'`
  (measured: 214px of the 594px body at 1280x800) and the read-only summary once
  painted there was a single line, so the band read as dead space above the footer.
  Everything the page offers lives in its own list, its own strip and its own
  footer.

### The read-only Reader (`details`)

The `details` page REPLACES the picker in the same layer with a native
`ui.overlay` (`size: 'lg'`, `modal: true`, head = the model's own name) instead of
painting a picker page:

- a picker ROW renders ONE measured line and ellipsizes what does not fit, so it
  cannot be a reading surface for a long value. The Reader renders each fact as
  its label plus ONE `ui.text({ text, wrap })` value node the CLIENT wraps at the
  width the layout really has: `char` for machine identifiers (a
  configured-selection value (`provider · model · effort`) or a model id may carry
  no break opportunity at
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
  no-op on this page because it paints exactly ONE region. That op inherits the
  SDK's own credit/queue boundary (the documented F3-001 class): when the frame
  credit is blocked and a repaint intervenes, ONE scroll keypress can be delivered
  against a body the client never received and be rejected, so that single
  keystroke is dropped. The app deliberately adds no second scroll queue, ACK
  watchdog or retry for it — see
  [the runtime-gap record](./evidence/runtime-gap-20261013.md) §F3-004;
- its one interactive node is a visible `Back` row bound to the SAME `back`
  intent `Esc` uses, so `Back` and `Esc` can never disagree about where the page
  returns: the CATALOGUE enters it (a row activation) and that is therefore where it
  always returns, across a resize and a re-read alike. It carries no candidate, no
  draft and no writer. The row is the FIRST row of the scrollable body, so it is
  visible at the top of the page and travels with the content: **after scrolling
  to a long value's tail the row is outside the viewport (measured), so `Esc` is
  the way back from the tail** — it is never a dead control, because the page's
  own view keys are exempt from the phase gates.

### Row, candidate and retry namespaces

The SDK delivers the list's row ids on the row channel and the action bar on the
action channel, so the two are told apart by **channel**, not by shape:

- A model row's id is the JSON provider+model pair; an effort candidate row
  carries its own `effort:` namespace (the catalogue's strip items use it too); the
  strip's own head, an inert failure row (`failure:<provider>`)
  and the one retry row (`retry-failed`) each have their own id, so no candidate
  value can be confused with a model, a head or an operation.
- A row `select` / `activate` acts only on an id the CURRENT page really renders
  (`visibleModels` on the catalogue). The Reader has
  NO selectable row of its own (its one interactive node is its `Back` row
  dispatched as its own `onClick`), so a row event on that page resolves nowhere.
- There is no provider-scope channel at all any more: a forged
  `action { act: 'scope' }` or a scope-shaped row id resolves nowhere, because no
  page paints a scope column.
- The removed wire shapes are refused, not ignored: `details` and `effort-page`
  are not part of any page's action set, a `strip` click is admitted ONLY while the
  catalogue really paints the strip and ONLY for a candidate of the model that strip
  shows (any `strip-*` value included), and a `more:<action>` row id resolves nowhere.

### Writing

Browsing (model rows) and clicking a strip item only change
local browse state — the highlight or that model's draft effort. **Only the
explicitly labelled action writes**, once:

- `Switch` for a live Session (the existing Session-model selection);
- `Save default` for a sessionless subject (the existing "confirm the model and
  save it as the future default" intent).

The provider-default sentinel submits without a `reasoningEffort`; a real effort
submits the advertised id. `Switch` / `Save default` are the same single `apply`
action id the earlier revision used, and neither operation is split in two.

The write action exists on the catalogue (`applyOffered`), i.e. at EVERY pane
width — the list-first revision retired the "compact list commits nothing" rule. Its
target is the HIGHLIGHTED model together with the effort its strip drafted, so
switching a model AND setting its effort both happen on the one page. The read-only Reader paints no action
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

The logical zones are `models` (a page's native main list), `strip` (the
catalogue's own Reasoning Effort strip, painted only while the highlighted model
advertises candidates) and `primary-action` (the action bar). The read-only Reader
is not a picker and has no second region at all. `zone` is presentation-local and
is never business authority. Tab and Shift+Tab walk the zones the current page
really paints:

| Page / phase | Ring |
|---|---|
| `models`, highlighted model advertises efforts | `models → strip → primary-action` |
| `models`, highlighted model advertises none | `models → primary-action` |
| `details` (the Reader) | ONE region: `Tab` is a consumed no-op |
| `pending` (admitted write) | the bar holds the keyboard (`Esc` only) |
| `loading` (running re-read) | the catalogue keeps its search box (everything else is refused but `Esc`); the Reader keeps its own `Back`/`Esc`/scroll keys |
| `error` (failed read) | the bar holds the keyboard (`Tab`/`Shift+Tab` both stay there) — except on the Reader, which has no bar and keeps its own `Back`/`Esc`/scroll keys. The list's partial-failure RETRY ROW is **not part of the page** in this phase (see below): it belongs to a catalogue that is really showing its content |

`Esc` is never swallowed, and on the catalogue it follows the Owner's ladder: **while
the search filter is not empty it clears that filter** (in whatever zone the keyboard
is — the panel stays open and the query empties), and **once there is nothing left to
clear it closes the panel**. The zone ring — `Tab`/`Shift+Tab` — is what moves the
keyboard between the list, the strip and the bar, so `Esc` never has to return to a
zone. On the Reader `Esc` is exactly the visible `Back` (its own row and `Esc` are the
same intent), and an admitted write — the one state whose only reachable action is its
dismissal — closes.

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
| `models` (catalogue) | move the row cursor over every visible model AND the retry row | → the strip (then the bar) | open the highlighted model's read-only Full details DIRECTLY, or run the retry row's read-only re-read — **never writes** | clear the search filter, else close (see above) |
| `strip` (catalogue) | `↑↓`/`←→` move the DRAFT over the highlighted model's candidates | → the bar | hand the keyboard to the action bar — **never writes** | clear the search filter, else close (see above) |
| `details` (the Reader) | `↑↓`/`PageUp`/`PageDown`/`Home`/`End` scroll the Reader's native body (also while a read runs or has failed) | — (one region) | inert — **never writes** | `Back`/`Esc` to the page it came from |
| action bar | — | → the other zone | **the only key that writes**, once, when the FOCUSED action is the enabled Primary | clear the search filter, else close (see above) |

### The visible vocabulary (frozen design language)

This surface follows the **semantic** Overlay archetype of `docs/tui-design-language.md`,
with its renderer-specific **Native TSP adapter** (§12.3). The historical
character-cell `/model` sizing exception is not the Tern sheet's size policy: this
page uses the client's measured `size:'md'`. The concrete native adaptations
are recorded here so the product contract and actual painted frames cannot drift:

- **The focused action carries a key badge, never a glyph.** The focused entry's
  label is the canonical `Verb [Key]` affordance form (`Switch [Enter]`,
  `Retry [Enter]`); `▸` is the design language's DISCLOSURE role and is never used
  for focus or selection, and a verb label never takes brackets.
- **The ONE hint is `<Key> <object>` and names the next `Tab` zone** (`Tab effort`,
  `Tab actions`, `Tab list`) — the same ring `tabZone` walks, so the hint and the
  handler cannot disagree. It replaces the earlier `Enter: effort & details`, whose
  colon/ampersand form the vocabulary does not allow.
- **One separator**: the pinned group head is `Current · Default` and the configured
  selection's values join as `provider · model · effort`; ` / ` never joins fields.
- **State chips are the client's own pills.** The row badges stay the lowercase
  `current` / `default` because the native picker paints each badge as its own
  rounded chip in the muted ink (measured: `span.pk-badge`, 18px tall, its own
  background, `rgb(101,101,101)`); the design language's bracketed `[current]` form is
  its chip syntax for a surface with NO box of its own. The current native
  rounded Pill already communicates the state without redundant bracket characters;
  this is a **renderer adaptation**, not a change to the PiTui bracketed-chip
  vocabulary or an instruction to synthesize an extra selection glyph. The
  separately painted PiTui badge slot (`src/tui/pickers/model-picker.ts`) is out
  of scope. A future literal-bracket preference would be a new Owner UX amendment.
- **A failed provider states itself in words**: its row reads
  `<Provider> · unavailable` — a disabled row may not be signalled by colour alone.
- **The Reader's notice has a role ink** (`textMuted` for information, `error` for a
  failure) instead of the content's own ink — and the notice CARRIES that tone itself:
  a refused write leaves the panel `ready` again, so the read phase cannot tell it from
  a cancellation, and only the outcome can. Its labels/heads are the muted role while
  values are content.
- No new glyph role, no new palette token, no fork divergence and no new layout
  framework: the whole change is the presenter's own node tree.

The strip is the ONE effort editor, and the app never lets a stale or forged
receiver use it: a strip click is admitted only while the CATALOGUE really paints
the strip, and only for a value that is a candidate of the model the strip currently
shows — anything else changes nothing. `↑↓`/`←→` inside the strip move the same
local draft a click does, so the visible state and the K2 zone can never disagree.

The list drives the client's highlight through the picker's own `selected` prop:
the client does NOT own list navigation (measured — arrow keys move nothing
without the app moving `selected`), so this walk is the app's and it is what makes
every visible row keyboard reachable. The action bar has NO native region at all —
`focus` names only `list`/`scopes`/`tabs`/`strip`/`preview` — and the client paints
no focus distinction on its buttons (measured: both button class lists are
byte-identical under either region focus; the client's own `f-list`/`f-preview`
region class belongs to the list/preview region, not to the bar), so the FOCUSED
action carries an app-rendered shape cue
(`Switch [Enter]`, `Save default [Enter]`, `Retry [Enter]`, `Cancel [Enter]`). The
badge is the design language's `Verb [Key]` affordance form, not an invented focus
glyph: `▸` is that language's DISCLOSURE role and must never mean "focused". A disabled
action never carries the cue, and neither does an action the current phase cannot
run from the keyboard at all (`pending`, `loading`), so the cue is always a
promise about `Enter`.

The catalogue carries exactly ONE short hint, in its `subtitle` slot, in the
design language's `<Key> <object>` form: it names the zone `Tab` reaches NEXT
(`Tab effort` while the highlighted model has a strip, `Tab actions` when it does
not, `Tab actions` from the strip itself, and `Tab list` from the action bar — the
same ring the key walk uses). It is painted only while the phase really admits keys
(a running re-read and an admitted write refuse them), it names no business action,
and no other page repeats it. `▸`/`▾` never appear: that glyph pair is the
disclosure role, and the focused action is marked by its `[Enter]` key badge.

`Ctrl+C` always remains the original application cancel owner, and a
Question/Approval modal owns the keyboard before the Model panel.

### The action bar

The native action bar lays its buttons on ONE line and does not wrap them, and the
bar has no scroll port of its own, so the bar is SHORT AND FIXED and the frozen
table caps it per page: `Cancel` + the ONE write on the catalogue, and `Cancel` +
the read-only `Retry` on a failed read.
A partial failure does NOT add a third button: its context and its one read-only
operation row live at the end of the list. The read-only `details` page has NO
picker and therefore NO action bar at all: its `Back` is the Reader's own visible
row (see "The read-only Reader").

| Page / phase | Action bar (left to right) |
|---|---|
| `models`, every width | `Cancel`, `Switch` / `Save default` |
| `details` (the Reader) | none — the page is not a picker; its `Back` row is its own node |
| `error` | `Cancel`, read-only `Retry` |
| `loading` | `Cancel`, a disabled `Switch` / `Save default` |
| `pending` | `Close`, a disabled `Selecting…` |

`Cancel` is the visible label of the stable `close` action, and while a write is
ADMITTED it reads `Close`: closing the panel does not cancel an operation that is
already with the Host, and the label must not promise an undo the contract does
not offer. The catalogue is the only page with an action bar, so its two-entry cap
(`Cancel` + the ONE write) holds at every width. The `close` INTENT itself
stays admitted on every page, because it is the panel's own DISMISSAL authority —
the same intent `Esc` and the client's backdrop gesture use — and dismissing can
never write; only the page OPERATIONS (`back`, `retry`, `apply`) have to be really
rendered by the current bar. `Retry` is the `retry` action — rendered as `retry#<revision>`
like every other page operation, so an earlier frame's entry cannot run it — and it is the only
action a failed read offers; it is read-only and re-reads through the command's single read
owner, exactly like the list's own retry row (which exists only while the phase is `ready`).

**The partial-failure retry ROW is offered only while the phase is `ready`** (`retryRowOffered`,
the ONE predicate the row set, its painted order and the row router all read). A read that
fails as a whole puts the panel in `error`, where the action bar is the only operable region:
leaving the row painted — and its event admissible — would offer a SECOND `Retry` beside the
footer's, reachable with the mouse while the keyboard is refused, and `Esc` would have two
meanings at once. The failed providers themselves stay on screen as read-only context.

The action **ids** are the routing authority, and they are revision-scoped so a stale frame
cannot act on a newer one: `close` is the ONE untokened id (the dismissal `Esc` and the
client's own backdrop both send it from any frame), while `retry`, `apply` — and any future
`back` — are rebuilt every frame as `<base>#<revision>` and refused at admission unless the
token names the current revision. The Reader's `Back` is not a bar action at all: it is a
native Row `onClick` on the read-only page. The key map and the row router act on those ids,
never on display text.

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
paint an action bar, so a user returns to the catalogue to run it.

Pending saves disable every mutation entry (including the strip and the Primary
Action) and keep `Close` available; closing does
not cancel an admitted business operation. Rejected, cancelled and unsupported
outcomes leave the picker usable ON THE PAGE IT WAS ON, with its draft intact, and
report the outcome through the dock notice; indeterminate outcomes close it with
the original reconciliation notice. Hydration and disposal retire the picker
synchronously, and receivers bound to a previous panel serial and presentation
revision are never routed again.

## Sheet size (one dialog at every width)

The catalogue asks for `size: 'md'` at EVERY pane width, and the choice is MEASURED
rather than tuned: with a twelve-row fixture in the real client (`tern 0.8.3`), an
`lg` sheet filled `1120x698` of a `1280x800` pane (87% of BOTH axes) and `940x538` of
a `1000x640` one, while the same fixture at `md` is a centred `680x540` at 1280 and
`680x498` at 1000. At a `560x640` pane both sizes give `500px` and at `400x600` both
give `340px`: the client shrinks an `md` sheet below its own cap, so a narrow pane is
unchanged by this choice and only a wide one stops being filled.

Two independent precedents agree. The official product (`oh-my-pi`) uses
`size: 'md'` for every picker — its own model picker included — and reserves `lg`
for a separate fullscreen hub; and the frozen design language names `/model` as
`72x28` (≈576px), i.e. a dialog, not a sheet that grows with the terminal.

Nothing in the presenter reads the pane width to decide the sheet form any more (the
retired `900px` reconstruction and its `LARGE_SHEET_MIN_PANE_PX` are gone). The pane
width is still reconstructed for ONE purpose: the strip's own chip-label budget
({@link stripLabelColumns}).

A SHORT pane is a supported case with a measured shape of its own: at `900x400`
(888px) the catalogue's list region shows two complete model
rows and clips the third at its own fold; the strip below it wraps instead of
scrolling, so at that pane (and with 7+ candidates) the client paints EVERY item,
just in more rows — measured on the real client: a four-item strip occupies 78px in
two rows at 400x600, and an eight-item long-label strip 282px in eight rows, with all
eight items contained and individually clickable. The cost is paid by the list's own
viewport, which is the plan's short-height rule ("the native list scrolls
independently and keeps the selected row").

At the 400px floor the client gives the header only about fourteen characters, so
the page title itself is ellipsized (`Switch mo…`) and its SUBTITLE slot is not
painted at all — which also means the catalogue's one hint is invisible there. That
is exactly why the catalogue's rows carry the model's name as their own label and
never as a caption: a row is painted at every width, a caption is not. That is the client's own floor
behaviour, measured in the acceptance lane's 400x600 capture: the catalogue still
shows every row with its provider mark and its real badges, and the footer's
`Cancel` + the ONE write are fully visible and clickable, so the model is chosen
and committed at that width; the effort is reached with the SAME strip every width
paints (one `Tab`, then its chips — they simply wrap onto more rows there).

The catalogue's rows are ONE line each: the SDK ellipsizes what does not fit and
never breaks an unbroken fragment, so the model's complete id is carried in the
row's `title` and the complete values are read in the Reader. The row identity
(`mark`, `badges`, `title`, and `facts`/`columns` in general) is a MEASURED client
capability, measured on the synthetic list-first picker before this revision
shipped — and it is also what retired the fact column here: the client gives a
declared column a FIXED 106px of the row's text area at every width (measured:
`pk-txt` 1026px → 920px at 1280x800) and hides it by itself at 400x600, while the
model NAME keeps its intrinsic width and the row's provider DETAIL is what yields.
That fixed cost bought one value that read as a column detached from its model, so
the effort is now edited in the page's own `strip` instead, which costs the LIST's
viewport rather than every row's text area.

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
native scroll container with the SDK's `scroll` op, and the catalogue's strip lists
every
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
The catalogue's two-button bar is MEASURED at
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
`current`/`default` badges, the complete id in `title`), its pinned-then-provider
order with each configured model exactly once, the `select`-highlights /
`activate`-opens-the-Reader split (including a retired receiver that can never
re-target a page), the ONE write on the catalogue at every width with the
highlighted model's own draft, the catalogue's OWN Reasoning Effort strip (its
items per highlighted model, a real strip click drafting and never writing, a
forged or stale strip value changing nothing, and a model without effort metadata
painting no strip), the README-level refusals (a forged scope action, a
scope-shaped or failure-shaped row id, a candidate id on the wrong page), the
retry row's read-only re-read by pointer AND from the keyboard cursor, the fact that
a row activation opens the read-only Reader DIRECTLY (there is no intermediate page,
and the two-page set is asserted), the read-only Reader (its grouped
Identity/Configuration/Description structure, its complete values and `wrap`
kinds, its PER-READING Back/body ids, the SDK `scroll` ops its own keys emit for
the body node it really built — with the negative control that the same keys emit
none away from the Reader — and its origin-preserving return), the K2 THREE-zone
walk (the list, the effort strip and the bar) with Enter refused outside the
Primary Action, the page-by-page action bar
(including the failed read's `Cancel` + `Retry`, and the fact that the failed providers stay
as read-only context while the list's retry ROW is gone), `Esc`'s ladder (a typed filter is
cleared first, from the strip and from a failed read alike, and only then does the panel
close; an ordinary key still cannot edit the search box in a failed read), a resize that
keeps the panel, the page and every draft at every width
(and the sheet form unchanged by it), a loading panel
that keeps the search editable, the pending/refusal/indeterminate settlements (a refusal keeps the page
it happened on), the read-error Retry through the original read owner, the
Current/Default facts of a live versus sessionless subject, long unbroken/CJK/
emoji descriptions as ONE complete Reader value, effort candidate sets of 0, 1
and 7+ (with no phantom candidate), the strip's phase gate and its chip-label
budget, the client's measured `md` sheet cap as the SAME dialog at every pane width,
the Reader's queued-scroll credit-stall lock (F3-004),
grapheme search, modal precedence, stale
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
- the client's EXACT sheet-density breakpoint (measured only between the 544px and
  888px panes that bounded its old `preview: 'below'` painting);
- the strip's behaviour at the 400px floor and with 7+ candidates is MEASURED (the
  real client wraps the strip, paints every item and keeps each one clickable: a
  four-item strip is two rows of 78px at 400x600 and an eight-item long-label strip
  is eight rows of 282px, with 0 clipped) — what stays `NOT_VERIFIED` is only the
  strip's own wheel/horizontal scrolling (the harness has no pointer/wheel verb) and
  its `on`/`sel` contrast under a dark theme;
- `PageUp`/`PageDown` through the client's own control channel: this client's
  `key` command accepts `PageDown` but delivers no key for it (measured; `Down`,
  `Up`, `Home` and `End` are delivered), so the flow drives the same `scroll` op
  with those and the byte-level `CSI 5~`/`CSI 6~` mapping is covered headlessly;
- **pointer/wheel scrolling of the Reader body**: this harness's control channel
  exposes no pointer/wheel input at all (measured; the lane records `[]` for the
  shapes it tries), so the plan's pointer-scroll item is an explicit OWNER
  EXEMPTION — the same capability is verified through the app's own keys, which is
  what the app owns the keyboard for;
- the `ui.kv` CLIPPING behaviour for a pathological long value (the retired
  read-only summary is gone; the Gate's measurement that `layout: 'inline'` clips a
  190-glyph value stands as history only);
- IME, OS focus, dark themes, screen readers, terminal
  scaling, directories beyond the scripted sizes, the shipped full-profile/HMR and
  the Remote TSP application success path. The harness is a headless client: it
  says nothing about OS-level input methods, window focus or desktop font
  resolution.

A resolved write outcome is reported by the existing dock notice on any page that
cannot host a picker `message`; a read failure or write outcome ON the Reader is
its leading line instead.
