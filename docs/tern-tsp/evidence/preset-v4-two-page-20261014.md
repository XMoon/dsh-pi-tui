# Tern TSP Preset evidence — the v4 two-page revision (cards catalogue + Details reader)

Durable summary of the **v4 Owner-frozen two-page revision**: what it changes, the contract
it implements, what the real Tern client actually paints (and what it does NOT), the
ownership/admission invariants, what each verification tier proves, and which pitfalls became
rules or regressions.

This file records behavior and coverage, not volatile run results: counts and commit
identities live in the pull request body and comments, and the raw real-pane artifacts
(node trees, PNGs, the ledger, `events.jsonl`) live in the run directory
`node scripts/tern-pane-drive.mjs` creates under `temp/`, together with the review package.

Companion documents: [preset selection](../preset-selection.md) (the current product
contract), [Model selection](../model-selection.md) (the sibling native surface whose
presenter split and reading-identity devices this revision reuses) and
[TSP integration](../../tern-tsp.md) (protocol boundary, capability matrix, evidence ledger).
The v3 revision's own record stays in
[preset-native-cards-reader-20261014.md](./preset-native-cards-reader-20261014.md).

## 1. What this revision changes

- **THREE pages become TWO.** The v3 shape (`Catalog → Overview → Guide`, business actions
  as accent `ui.row` operation rows) is retired. The Owner froze the v4 contract: the
  catalogue's footer is the ONLY writer — the THREE native `pk-btn` entries — and reading is
  ONE `lg` overlay (Details) carrying the complete identity, the full description and a
  SHIPPED preset's official Mode guide INLINE as native Markdown.
- **The footer is the Owner-shaped three-button bar.** Wire order `Close, Set default, Use*`
  (Owner ruling "a"); both writes carry `primary`, `Close` stays plain, and the client's own
  pack rule (non-primary left in array order, `primary` right) renders the Owner mock:
  `[Close]  [Set default] [Use next]`. `primary` is a VISUAL weight only; admission consumes
  the same `actionEnabled` predicate for every entry.
- **The Back control is the native NAVIGATION row** (`ui.row({onClick})`, `← Back to
  presets · Esc`) at the TOP of the reading body — Owner A4 amendment 2026-10-14, final
  form: the measured client paints no stylesheet border/background on an `el` button
  (syntax ladder + pixel scan, §3), so the styled `html.button` and its sheet were RETIRED;
  and the client scrolls every overlay child in the ONE body scroller, so the row is the
  pointer path at the page top while `Esc` is the ALWAYS-available fixed path at any scroll
  position. Pointer and keyboard share the ONE `back` intent through the single admission.
- **Identity is unchanged in kind**: panel-serial keys for the picker/layer, one epoch per
  Details reading for the overlay/Back/body; frame tokens on the footer's write ids;
  `close` untokened.
- **NO stylesheet exists on this layer** (Owner A4 amendment): the earlier scoped Back-button
  sheet was retired with the styled button; no Host port, wire operation or public API is
  added.
- **The pinned guide copy carries its source attribution**: the upstream repository is MIT
  (`deepseek-ai/deepseek-harness`, `Copyright (c) 2026 DeepSeek`); the transcription's
  header records the pin (commit + path) and the license, and the scripted suite
  exact-compares all four shipped compositions against the pinned values.

## 2. The contract it implements

- ONE native `ui.picker` at `size:'md'`, `layout:'cards'`, `preview:'none', no scopes; ONE
  column at EVERY pane width; `Built-in` then `Custom` groups keeping the roster's order.
- Cards carry name, classification, ONE-line summary (`No description.` when none), the
  complete `Failed to load: <reason>` for a broken declaration (error dot + badge), the raw
  id in `title`, and the real state badges (`Current`, `Next session`, `Default`, `Draft`).
- The ready-phase picker paints NO status text; the committed facts are the cards' badges,
  the scope/relationship sentences live on the Details page (Owner ruling "a").
- `select` only browses; `activate`/`Enter` open the EVENT row's Details; the footer's
  focused ENABLED entry is the only writer; `Esc` on the catalogue clears a non-empty query
  first (every phase, error included), then closes.
- The Details page is strictly read-only; `Back` (row click, `Enter`, `Esc` from any
  position) returns to the catalogue keeping query and target; the body scrolls with the
  arrows/PageUp/PageDown/Home/End through the SDK `scroll` op addressed at the body the
  CURRENT frame built.
- An admitted write states itself (`Applying preset…` / `Saving default…`) and offers ONLY
  its dismissal; a KNOWN refusal restores the catalogue with its target and its reason;
  `saved` and `unconfirmed` default writes both dismiss.

## 3. What the real client actually paints (Gate A + acceptance findings)

Measured with the production presenter inside a real, headless Tern pane
(`tern serve` + `ctl`, Tern `0.8.3 (e2b8656)`), at 1280x800, 900x640, 560x640 and 400x600:

| Finding | Evidence |
|---|---|
| The footer really paints THREE native buttons in the Owner shape at every size. | `Close` and `Set default` share the left cluster, `Use next` (primary, filled) is rightmost; all contained with ≥16px hit targets, at 1280/900/560/400. |
| The pack rule is: non-primary LEFT in array order, `primary` RIGHT in array order, one flexible gap. | Cross-checked with `[use, set-default, close]` (round: `Set default \| Close \| Use next`), `[close, set-default, use]` (`Close …gap… Set default Use next`) and both-writes-primary (`Close \| Set default Use next`). The SDK `end` flag was a measured NO-OP on this build. |
| A disabled footer entry is `off` (measured `opacity 0.45`) + the reason as the button's `title` ATTRIBUTE. NO in-place reason text exists on any path. | `pk-btn primary off` with `title="Already the default"`; the reason string never appears as painted text at any size. Owner ruling "a" accepts tooltip + Details facts as the substitute. |
| The ready-phase picker paints NO `lead`, no `message`, and its `subtitle` is the header title tooltip only. | Probes 3/3m painted neither status line (`tooltip: "Agent presets"`); a sibling layer line is clipped behind the modal sheet (v3 record). |
| A BARE page node as the layer region root paints NOTHING. | The first Gate A round shipped `{layer: <picker>}`; the client ACKed the frame and left `sf-layer` EMPTY. The production `ui.col` wrapper is load-bearing. |
| An `el` BUTTON really paints, and a stylesheet styles exactly THREE property classes on it — padding, text color, font-weight — but NEVER border or background. | `sf sf-el sf-act`; with a sheet delivered the button's box grew 16px → 18/20px from its padding, and a probe sheet's `color: rgb(220,0,0)` + `font-weight: 700` painted verbatim (computed layout, gate-a-12). A syntax ladder — relative `rgb(from ...)`, `color-mix()`, plain `var()`, and literal `rgba()` borders/backgrounds — was accepted and dropped every time: the computed `backgroundColor` stays transparent and the PNG shows no border line (gate-a-11 pixel scan: only the label's glyph runs, no edge line at the button box). REVIEW ROUND 2 (F1): the first v4 acceptance lane mounted the production presenter over its own surface WITHOUT the sheet install, so its Back evidence was a bare 16px row. REVIEW ROUND 3 (F1 residual) + OWNER DECISION: "visibly bordered/filled button" is NOT deliverable by any stylesheet value on this target, so the Owner amended A4 — the Details way back is the NATIVE `ui.row({onClick})` NAVIGATION row (`← Back to presets · Esc`), the styled `html.button` and its sheet are RETIRED. |
| One REAL click on the Back navigation row runs its `onClick` exactly once. | The SDK dispatches the node's handler; the evidence is the handler's effect: exactly one Back intent, page back to the catalogue. |
| `Tab`+`Enter` on the `el` button fires NOTHING. | Re-measured on this build; the keyboard contract stays application-owned (matches `foundation.md` §5). |
| The inline guide is taller than its viewport at 400x600 and really scrolls to its tail. | One `End` key (app-driven `scroll` op, one retry across the documented credit stall) moved the viewport ~995px and put the last official `Expected output:` line on screen. |
| The Details page's frozen first screen (Back row + Name/ID/Type/Scope) is contained at every size; at the TAIL the Back row has scrolled out with the body and `Esc` is the fixed path (real Esc-at-tail return asserted). | Real-tree containment at all four sizes; a Custom declaration's page stops after the description with no `md` node and no `Mode details` text. |
| The sheet shrinks below its cap on a narrow pane. | ~340px wide at 400x600; the one-column 54px card rows and pinned group head behave as recorded in the v3 evidence. |

## 4. Ownership, admission and lifecycle invariants

- **One command owner.** `src/tui/commands/models.ts` still captures the Session scope, owns
  the roster read and the operation token, and calls the original `applyPresetSelection` for
  `Use*` and the single extracted `setPresetDefault` for the footer button and the typed
  verb.
- **One admission point.** Every key, every SDK row event and the Back row's bound
  `onClick` passes through the presenter's `act`, which rechecks the live panel, the
  subject, the presentation revision, the phase, the page and the SAME `actionEnabled`
  predicate the footer renders. A disabled entry therefore cannot write through any channel.
- **Two identity lifetimes** (unchanged in kind): panel-serial keys for the picker/layer;
  `${serial}-${epoch}` for the Details overlay, its Back row and its body, a fresh epoch
  per entry. Footer write ids carry `#<revision>`; `close` is untokened.
- **One layer.** Opening the Model or the Preset presenter retires the other first; a
  Question/Approval modal seat still takes precedence over both, and a retired frame's node
  ids are never routed again.
- **No stylesheet (Owner A4 amendment).** The earlier scoped Back-button sheet was retired
  with the styled button; the layer uses NO stylesheet at all. The interim round-2
  `styles`-gate (ONE predicate gating admission + install, mutation-verified both
  directions) was removed together with the sheet it gated.
- **PiTui is unchanged.** Its overlay keeps its original fields, wording and one-step Enter.

## 5. Verification tiers — what each one proves

| Tier | What it covers in this revision |
|---|---|
| `FACT_CODE` | The frozen UX, the footer's array order and availability, the two-page contract in `preset-picker-state` / `-intents` / `-view`; the pinned guide copy; the command-side read/write ownership; the capability predicate (the five kinds the layer builds + the `scroll` feature). |
| `SDK_SCRIPTED` | The production presenter over the shipped SDK with a scripted tty: the footer array/weights/reasons, the Details identity/scope/inline-guide/read-only shape, the K2 ring (Tab zones, footer arrows), the settlement matrix, the stale/fenced receivers (forged footer token, forged disabled action, a retired frame, a foreign surface), the reading identity and the real `scroll` target, the loading/error/empty/no-match phases (the error phase's Esc ladder included), Model/Preset mutual exclusion and the per-kind fail-closed capability. |
| `REAL_TERN_HEADLESS` | The production `TspPresetPicker` inside a real Tern pane at 1280x800, 900x640, 560x640 and 400x600: the PAINTED footer order and Owner shape, the `off` greying + tooltip reason, real pointer `select` (on a NOT-highlighted card) and `activate` shapes, REAL pointer clicks on BOTH `Use next` and `Set default` (plus the keyboard Enter path), the Back navigation row painted with its destination label + `Esc` twin (captured pre-click) and its real click path, the inline guide's real scroll to the tail, the long-value fixture's complete id/description/reason with client-painted line counts and its scroll-to-tail, the Details first-screen containment, and the stale-token control. Run with `node scripts/tern-pane-drive.mjs scripts/tern-pane-preset-native-ux.mjs`. |
| `L6` (command/Host) | Unchanged in kind from the v3 record: the real classifier, capability admission, original handler and Direct Host sinks (sessionless staging, blank-live durable switch, started refusals, typed verbs, the Config default write and a fresh-Context reread). |
| `NOT_VERIFIED` / `GUI_BLOCKED` | Physical mouse/wheel/IME/OS focus, dark themes, terminal scaling and screen readers; the shipped full profile/HMR; catalogues and terminal sizes beyond the scripted ones; Remote TSP preset success. |

The real-pane tier is a HEADLESS real-renderer run (`tern serve` with the pane's node tree
and PNG captures); it is not a physical GUI/IME qualification.

## 6. Gate G8 — the seven visual criteria, as observed

| Criterion | State | Basis |
|---|---|---|
| Hierarchy | PASS (headless) | TWO pages, no repeated layer: the catalogue states what each preset IS (badges/summary), the footer is the only writer, the Details page is the continuous read. |
| Density | PASS (headless) | The first screen carries target + three footer buttons at every size; the Details first screen carries Back + Name/ID/Type/Scope without scrolling. |
| Alignment | PASS (headless) | The native picker/overlay and the client's own pack rule own the geometry; the layer carries exactly one page node inside the app's `ui.col`. |
| Contrast | PASS (headless) | The writes are filled `primary`, `Close` is quiet, a disabled entry greys to `opacity 0.45` AND carries the reason attribute; the Details page states reasons in words, and its Back reads as NAVIGATION (arrow + destination + `Esc` twin, accent/weight from the native row styling). |
| Consistency | PASS (headless) | Business actions are native BUTTONS here and on the Model surface; the Details Back is the same native `ui.row({onClick})` navigation-row family as the Model Reader's Back; the keyboard cue is the design language's `Verb [Enter]`. |
| Action clarity | PASS (headless) | `Use next`/`Use session`/`Set default` act on the browse target with the scope sentence one Enter away; `Close` never means "cancel the write". |
| Overflow | PASS (headless) | No clipped footer at any tested size; the inline guide scrolls to its tail; long values are complete in the body that really scrolls. |
| Physical GUI, IME, wheel, dark/custom themes, enlarged fonts | NOT_VERIFIED | Owner attestation required; the headless PNGs are not a physical-GUI qualification. |
| ~~STOP: a visibly bordered/filled Details Back button~~ | RESOLVED BY OWNER (A4 amendment, 2026-10-14) | The pinned client drops stylesheet border/background on `el` buttons (ladder + pixel-scan evidence above). The Owner amended A4 (final form): the Details way back is the NATIVE `ui.row({onClick})` navigation row at the TOP of the reading body (destination label + `Esc` twin; the client scrolls all overlay children in ONE body scroller, so the row leaves view at the tail and `Esc` is the always-available fixed path); the styled `html.button` and its sheet are retired, and Use/Set default stay native buttons in the catalogue footer. |

## 7. Pitfalls that became rules or regressions

| Pitfall | Rule / regression |
|---|---|
| A bare page node as the layer region root | The layer root is ALWAYS the `ui.col` wrapper (`presetPickerLayer`); the real-pane lane asserts the catalogue's picker node exists in the client tree, so the "ACKed but unpainted" shape fails loudly. |
| Trusting the wire array order for the painted footer | The painted order is the client's pack rule (non-primary left, `primary` right); the lane sorts painted buttons by x and asserts the Owner shape against the CLIENT tree, never against the wire. |
| The SDK `end` flag as a layout instruction | Measured NO-OP on this build; the footer's shape comes from array order + `primary` only. |
| An in-place disabled reason on a footer entry | This client paints none (tooltip attribute only). Owner ruling "a": the reason rides the tooltip, the card's own detail line, and the Details page's facts; the scripted suites assert the `disabled` string and the admission refusal, the lane asserts the `off` greying + attribute. |
| A status line on the ready-phase catalogue | `lead`/`message`/`subtitle` carry nothing visible (tooltip at best); the committed facts are the cards' badges and the Details facts (Owner ruling "a"). The lane asserts no painted status row. |
| A stylesheet scoped by `data-role`/`data-surface` | Measured moot: this client emits neither attribute for `el` props — and (Owner A4 amendment) drops stylesheet border/background on `el` buttons outright, so the sheet was retired entirely; the Back control is the native navigation row. |
| Assuming `Tab`+`Enter` fires an `el` button | It does not (re-confirmed while the styled-button variant existed, now retired); the application owns Back's keyboard (`Enter`/`Esc` → the same `back` intent) and the suites drive both paths. |
| Counting the pinned group head as an in-flow row | Unchanged rule from the v3 record; the lane separates `pk-sticky` rows first. |
| A `select` treated as a write, or an activate opening the wrong card | Unchanged: `select` browses, `activate`/`Enter` open the EVENT row; both suites assert zero writes and the opened head. |
| A forged footer action from a stale frame | Footer ids carry the frame token; a forged `use#99999` (and a forged action at the disabled entry) writes nothing — scripted suite and real-pane lane each drive one shape. |
| A capability gate with passenger kinds | The regression drops EACH required kind individually (picker/row/overlay/text/md) with all others + `scroll` present, plus the missing-`scroll` case: every case must refuse `/preset` on its own. |
| The error phase swallowing the Esc ladder | F1: the footer's zone keeps the search editable, so `Esc` still clears a non-empty query before closing; the scripted suite drives it under a failed read. |
| Evidence captured from a surface that skipped a production mount step | REVIEW ROUND 2 (F1): the first v4 lane mounted the production presenter over its OWN surface and skipped the renderer's mount-time stylesheet install, so the pane under-styled the one control the lane had to qualify — the evidence was wrong before the styling question could even be asked. Any lane mounting a production presenter over a hand-rolled surface must reproduce the mount-time side effects the product performs. |

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
with the flow so the artifacts stay auditable without this machine. The Gate A probes
(`scripts/tern-pane-preset-gate-a{,-subject}.*`) remain in the tree as the recorded
feasibility instrument for the findings in §3.
