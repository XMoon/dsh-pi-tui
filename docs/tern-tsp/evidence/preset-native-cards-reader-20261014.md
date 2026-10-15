# Tern TSP Preset evidence — the native cards catalogue, the Overview and the Mode Guide

Durable summary of the **native preset UX revision**: what it changes, the frozen UX
contract it implements, what the real Tern client actually paints (and what it does NOT),
the ownership/admission invariants, what each verification tier proves, and which pitfalls
became rules or regressions.

This file records behavior and coverage, not volatile run results: counts and commit
identities live in the pull request body and comments, and the raw real-pane artifacts
(node trees, PNGs, the ledger, `events.jsonl`) live in the run directory
`node scripts/tern-pane-drive.mjs` creates under `temp/`, together with the review package.

Companion documents: [preset selection](../preset-selection.md) (the current product
contract, ownership, coverage and limits), [Model selection](../model-selection.md) (the
sibling native surface whose presenter split, reading-identity and group-separation devices
this revision reuses) and [TSP integration](../../tern-tsp.md) (protocol boundary,
capability matrix, evidence ledger).

## 1. What this revision changes

- **The catalogue becomes a native CARD list.** `/preset` no longer renders preset rows
  whose long description was pre-split into measured one-line `fact` rows; it renders ONE
  `ui.picker` with `layout:'cards'`, `size:'md'`, `preview:'none'` and two `PickerGroup`s
  (`Built-in`, `Custom`) over the live roster, so every card carries the preset's name, its
  real classification, a one-line summary and its real state badges.
- **The reading page becomes a native overlay.** The old second picker page (`Preset
  details`, a list of `fact:` rows) is replaced by a native `lg` overlay: the selected
  preset's complete identity and relationship facts, the TWO explicit operation rows
  (`Use …`, `Set as default for new sessions`), the read-only `Read mode guide` row for a
  SHIPPED preset, and then the full description / failure reason.
- **The Mode Guide ships.** A shipped preset's official English guide (pinned to
  `deepseek-ai/deepseek-harness@d7432673`, `guide-locales.ts`) is rendered as native
  Markdown in the same overlay type, with `Back` as its ONE interactive node.
- **Identity is per-lifetime.** The picker and the layer keep the panel serial; a reading
  page takes a fresh epoch on every entry, so a `scroll` op queued by a previous reading can
  never address the next one's body.
- **No new authority.** No `PresetCatalog` method, Host wire operation, writer, Session
  gate, input owner, stylesheet or public extension API was added; PiTui behaviour, the
  typed verbs and the Config writer keep their existing semantics.

## 2. The owner-frozen UX contract it implements

- ONE native `ui.picker` at `size:'md'`, `layout:'cards'`, `preview:'none'`, no scopes and no
  columns; ONE column at EVERY pane width (the client's `cards` layout is a per-item detail
  line, never a two-column grid).
- Built-in cards first, then Custom, each group keeping the roster's order; a card's second
  line names its kind and carries a ONE-line summary (`No description.` when the declaration
  publishes none); a broken declaration keeps `Failed to load: <reason>` there, is marked
  with an error dot and a badge, and can never be written.
- The committed facts are the cards' own native badges (`Current`, `Next session`,
  `Default`, `Draft`); a shipped card keeps the fixed English copy, and a user declaration
  that reuses a shipped id stays Custom with its own copy and gets NO official guide.
- A card ACTIVATION (`activate`, or `Enter`) REPLACES the picker with the Overview; a plain
  `select` only moves the browse target; neither writes.
- The Overview's operation rows are `Back`, `Use for next session` / `Use in this session`,
  `Set as default for new sessions` and — for a SHIPPED preset only — `Read mode guide`. The
  frozen first focus is `Back`, so opening the page and pressing `Enter` again never writes.
  `Tab`/`Shift+Tab` walk the ring; `Enter` runs the focused row; the arrows /
  `PageUp`/`PageDown`/`Home`/`End` scroll the page's own body.
- A disabled operation row states its reason IN WORDS in the row itself
  (`Preset failed to load`, `Already the default`, `Settings unavailable`) and registers NO
  click at all.
- The Guide is read-only: native Markdown, `Back` as its only interactive node, no footer,
  no write and no second modal.
- An admitted write states itself (`Applying preset…` / `Saving default…`) on the page it
  was admitted from and offers ONLY its dismissal (`Close`, never `Cancel`); a KNOWN refusal
  restores the SAME page with its target and its reason; `saved` and `unconfirmed` settings
  writes both dismiss, and the next read is authoritative.

## 3. What the real client actually paints (Gate A findings)

Measured with the production presenter inside a real, headless Tern pane
(`tern serve` + `ctl`, Tern `0.8.3 (e2b8656)`), at 1280x800, 900x640, 560x640 and the 400x600
minimum:

| Finding | Evidence |
|---|---|
| The `md` picker is a **modal sheet**, and the catalogue's own layer may carry NOTHING but that sheet. | A sibling text line collapsed the layer column to its header block (`52px` high), and the client painted the sheet OVER it: the status lines were visible only as ghosted text behind the modal dim in the capture. The card badges and the Overview are therefore the only visible statements of the committed facts. |
| The picker's `subtitle` prop is a **title tooltip**, not a painted row. | `pk-title` carries `title="Agent presets · Next session: cordis · New-session default: ptc · Tab actions"`; no `text` node holds that line at any tested size. |
| A native `md` picker really paints ONE column of `54px` cards. | Every painted `pk-row` shares one x and one width (the list width minus its 20px inset) and no two share a y; the row height is exactly 54px at all four sizes. |
| The client **virtualizes** the scrolled list and pins a sticky group head. | At a scrolled position only the visible window's cards exist in the tree (7 painted of 17 at 560/900/1280; all 17 materialized at 400x600), and the current group head is painted a second time as `pk-sticky pk-row grp`. |
| The sheet shrinks below its cap on a narrow pane. | 340x458 at 400x600, 500x498 at 560x640, and the measured `680x(498..540)` modal box from 900px up. |
| The Overview's frozen first screen fits at EVERY supported pane. | At 400x600 the `lg` body is `364x336` and `Back`, `Use for next session`, `Set as default for new sessions` and `Read mode guide` are all contained (y 175..415); the same holds at 560/900/1280. |
| The Guide is complete and really scrolls. | The `standard` guide is 1103 characters of pinned official copy; at 1280x800 it fits its body (`594 < 626`), and at 400x600 it is 818px tall in a 490px body, where one real `End` key moved the client viewport 360px and put the last official `Expected output:` line on screen. |
| Long values are complete and client-wrapped. | A 194-character unbroken identity renders 6 lines, a 1809-character CRLF/CJK/emoji description 54 lines and a 239-character failure reason 6 lines, all from the roster's own untouched strings. |

## 4. Ownership, admission and lifecycle invariants

- **One command owner.** `src/tui/commands/models.ts` still captures the Session scope, owns
  the roster read and the operation token, and calls the original `applyPresetSelection` for
  `Use` and the single extracted `setPresetDefault` for the typed verb and the Overview row.
- **One admission point.** Every key, every SDK row event and every bound `onClick` closure
  passes through the presenter's `act`, which rechecks the live panel, the subject, the
  presentation revision, the phase, the page and the SAME `actionEnabled` predicate the page
  renders. A disabled operation therefore registers no click AND is refused on the program's
  own `action` channel.
- **Two identity lifetimes.** The picker and the layer keys carry the panel serial, so a
  highlight, a notice or a repaint never remounts the list; the Overview/Guide overlay, its
  `Back` row and its scrolling body carry `${serial}-${epoch}`, a fresh epoch on every entry,
  so a retired reading's ids are never reused. Footer action ids carry the frame token
  (`use#<revision>`, `retry#<revision>`); `close` is deliberately untokened, and the reading
  pages' rows are frame-bound closures instead.
- **One layer.** Opening the Model or the Preset presenter retires the other first; a
  Question/Approval modal seat still takes precedence over both, and a retired frame's node
  ids are never routed again.
- **PiTui is unchanged.** Its overlay keeps its original fields, wording and one-step Enter.

## 5. Verification tiers — what each one proves

| Tier | What it covers in this revision |
|---|---|
| `FACT_CODE` | The frozen UX, the action availability and the three-page contract in `preset-picker-state` / `-intents` / `-view`; the pinned guide copy in `preset-guide-content`; the command-side read/write ownership; the capability predicate. |
| `SDK_SCRIPTED` | The production presenter over the shipped SDK with a scripted tty: the card/group projection, the Overview/Guide pages, the K2 ring, the settlement matrix, the stale/fenced receivers (a forged footer token, a forged disabled-row action, a retired frame, a foreign surface), the reading identity and the real `scroll` target, the loading/error/empty/no-match phases, Model/Preset mutual exclusion and the strengthened fail-closed capability. |
| `REAL_TERN_HEADLESS` | The production `TspPresetPicker` inside a real Tern pane at 1280x800, 900x640, 560x640 and 400x600: `layout:'cards'` + `lay-cards` + `sz-md`, the ONE-column 54px cards, the groups and counts, the real badges, the real `select`/`activate` shapes, the Overview's operation rows as real pointer targets, the `lg` Guide with its official English copy and its real client scroll to the tail, the long-value wrapping and the stale-token control. Run with `node scripts/tern-pane-drive.mjs scripts/tern-pane-preset-native-ux.mjs`. |
| `L6` (command/Host) | The real classifier, capability admission, original handler and Direct Host sinks: the capability refusal keeping the draft and creating no Session, the real `agent-presets` registry roster, sessionless staging without a Session, both started-Session refusals, the typed verbs keeping their original routes and never opening a picker, a Host-owned `preset` keeping its route, the blank live-Session switch over a REAL persisted Session (one durable `agent-preset/selected`, the authority reread, the started-Session locked negative, a clean teardown), and the default write through the REAL configuration plane (the Overview row and the typed verb write the same `selectedDefault`, and a fresh Context composes the persisted default back through a live registry). |
| `NOT_VERIFIED` / `GUI_BLOCKED` | Physical mouse/wheel/IME/OS focus, dark themes, terminal scaling and screen readers; the shipped full profile/HMR; catalogues and terminal sizes beyond the scripted ones; Remote TSP preset success. |

The real-pane tier is a HEADLESS real-renderer run (`tern serve` with the pane's node tree
and PNG captures); it is not a physical GUI/IME qualification.

## 6. Gate G8 — the seven visual criteria, as observed

| Criterion | State | Basis |
|---|---|---|
| Hierarchy | PASS (headless) | The catalogue is the preset entities only; the Overview states what the preset IS, then (after one rule) what can be done with it, then its description; the Guide is read-only with `Back` pinned outside its scrolling body. |
| Density | PASS (headless) | The cards are the client's fixed 54px rows with no invented whitespace and no repeated fact column; the Overview's first screen carries the identity, the relationship facts and both writes at every supported pane. |
| Alignment | PASS (headless) | The native picker and overlays own the geometry: no `Frame`, no side column, no injected stylesheet, and the layer carries exactly one page node. |
| Contrast | PASS (headless) | Current / Next session / Default / Draft are native badge TEXT, a disabled row carries a worded reason, and the notice and failure text are painted, never colour-only. |
| Consistency | PASS (headless) | The status chips are native pills, the keyboard cue is the design language's `Verb [Enter]` (never a shape glyph), and selection, current configuration and keyboard focus stay separate facts. |
| Action clarity | PASS (headless) | The writes read `Use for next session` / `Use in this session` / `Set as default for new sessions` and act on the page's own preset; `Close` never means "cancel the write". |
| Overflow | PASS (headless) | No one-word-per-line text, no lost operation and no unreachable `Back` at any tested size; a long value is complete in the body that really scrolls. |
| Physical GUI, IME, wheel, dark/custom themes, enlarged fonts | NOT_VERIFIED | Owner attestation required; the headless PNGs are not a physical-GUI qualification. |

## 7. Pitfalls that became rules or regressions

| Pitfall | Rule / regression |
|---|---|
| A sibling status line in the layer, painted behind the modal picker's dim | The catalogue's layer carries NOTHING but its one picker node; the committed facts are the cards' native badges and the Overview's relationship facts. The real-pane lane asserts that no painted row holds `Next session:` / `New-session default:` and that the header's tooltip carries them. |
| Treating the picker's `subtitle` as a visible row | The `subtitle` is a title TOOLTIP; nothing load-bearing may live there, and the evidence records the exact `title` attribute the client builds. |
| Counting the client's PINNED group head as an in-flow group row | The real-pane lane separates `pk-sticky pk-row grp` from the in-flow group rows before it counts groups. |
| A card detail that is the only readable copy of a long value | A card is ONE ellipsized line by construction; `Enter` opens the Overview, where every value is the roster's own COMPLETE string with the client's own wrapping (194-character id, 1809-character description, 239-character reason all asserted to be complete). |
| A `select` treated as a write, or a click on the already-selected card mistaken for a plain selection | `select` only moves the browse target; `activate` (or `Enter`) opens the event's OWN row; the SDK scripted suite and the real-pane lane each drive both shapes and assert zero writes. |
| An operation row that is disabled but still clickable | A disabled row registers no `onClick` at all AND `actionEnabled` refuses the same intent on the program's `action` channel; the real-pane lane clicks the disabled default row and forges a raw action at its id, and the scripted suite dispatches the same event. |
| A reading page whose body id changes per frame (the client remounts the scroll container) or is reused across readings | The overlay, `Back` and body keys carry the panel serial plus the reading's epoch; the scripted suite asserts a stable picker identity across highlight/notice changes and a NEW body identity per reading, and the real-pane lane asserts every `scroll` op names the body of the CURRENT frame. |
| A forged footer action from a stale frame | Footer ids carry the frame revision token; the scripted suite sends a token from an earlier frame and the real-pane lane a well-formed `use#99999`, and both assert no write. |
| A capability gate that lists kinds the presenter does not really build (or fewer than it does) | The predicate requires `picker`, `row`, `overlay`, `text`, `md` AND the `scroll` feature, and the regression asserts each of those five kinds and the missing feature refuse `/preset` before the handler. |
| A shipped guide borrowed from a Custom declaration that reuses a shipped id | The guide lookup requires the row's ALREADY-DERIVED shipped classification, never the id alone; both suites assert a Custom `minimal` gets no Guide row and no official copy. |
| A `pending` page that keeps offering the writes (or a `Cancel` that reads as "undo the write") | An admitted write states itself and offers only `Close`, on the page it was admitted from; a KNOWN refusal restores that SAME page, and the scripted suite asserts both. |

## 8. How to reproduce

```sh
# Build first: packages/pi-tui/dist is an input to the root bundle and the tests.
pnpm build

# The preset suites, plus the surfaces they touch.
node scripts/run-with-temp-root.mjs node --test \
  test/tern-tsp-preset-picker.test.ts \
  test/tern-tsp-preset-runner.test.ts \
  test/tern-tsp-model-picker.test.ts \
  test/tern-tsp-command-admission.test.ts \
  test/preset-command.test.ts \
  test/preset.test.ts

# Types, then the documentation/gate lanes that cover this area.
pnpm typecheck
pnpm test:docs
pnpm gate:architecture
pnpm gate:boundary
pnpm gate:keybindings
git diff --check

# The real-pane acceptance lane (external Tern CLI; NOT part of `pnpm test` or CI).
node scripts/tern-pane-drive.mjs scripts/tern-pane-preset-native-ux.mjs --out temp/<run>
```

The real-pane lane creates its own run directory and deletes nothing: its `assertions.json`
ledger, `events.jsonl` (every key, row/action event, request spy call, native scroll and
reduced frame record), the per-size node trees and the PNG captures are the evidence. Its
subject is `scripts/tern-pane-preset-native-ux-subject.mts`, copied into the run directory
with the flow so the artifacts stay auditable without this machine.
