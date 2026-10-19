# Tern TSP PR4-A Model evidence — the native Model B2 selection UI

> **Navigation (2026-10-13).** This file records the PR4-A measurements as they
> were taken; its content is NOT rewritten. The later Model-Responsive / Reader
> revision — the measured side-preview threshold, the Overview's priority order and
> the read-only Reader that replaced the pre-split details rows — is evidenced in
> [model-responsive-reader-20261013.md](./model-responsive-reader-20261013.md),
> which supersedes this file wherever it describes the `details` page as a Picker
> page, the `cols >= 120` wide rule, or `pv-side` as proof of a side column.

> **Status: PR open, increments accepted — the STAGE GATES ARE NOT CLOSED.**
> This file is the durable summary of PR4-A Model (native `/model` model + Reasoning
> Effort selection inside the experimental TSP renderer). It records what is
> certified, at which evidence tier, and which pitfalls became rules or regressions.
> The machine-readable numbers, the per-round tables and the review-round ledger live
> in the pull request and its review comments; PNG captures and short-lived logs stay
> outside Git. Historical evidence files are never rewritten
> ([pr1.md](./pr1.md), [pr2.md](./pr2.md), [pr3-a.md](./pr3-a.md),
> [pr3-b.md](./pr3-b.md), [pr4-0.md](./pr4-0.md)).
>
> **Plan:** `temp/tern/model/dsh-pi-tui-tern-tsp-pr4a-model-b2-owner-frozen-implementation-plan-v2-20261011.md`
> (worktree-local; the approved surface is in
> [../model-selection.md](../model-selection.md), which is the authoritative contract).

## 0. Owner revision superseding four B2 statements below

The Owner revised the B2 Model UX in a follow-up PR. The body of this file is kept
as the historical PR4-A record; where it disagrees with
[../model-selection.md](../model-selection.md), the revision below wins. A LATER
revision (§0.3) restructured the pages again and supersedes parts of this table
too.

| B2 statement (still in the body) | Current contract |
|---|---|
| §1/§2: an "always-available `Choose effort` page", and the write labels `Apply` / `Save default` | The MAIN footer no longer carries an effort entry; the complete list is the `More actions` page's `All reasoning effort levels…` (or the compact model list's `Enter` shortcut). The one Primary Action reads `Switch Model` (live) or `Choose & Save as Default` (sessionless); `Cancel` replaces the visible `Close`. |
| §2: "the wide shell (`cols >= 120`) never collapses: provider scopes + model list + details column" | The three-column shell belongs to the model LIST page. The details and effort pages are content pages: `preview: 'none'`, no `scope`/`scopes` props, no side summary. |
| §2: a provider scope click is described together with row activations | A scope click is the SDK's own `action { act: 'scope', value }` channel; a scope-shaped row `select` is not a scope click, and a scope action on a drill-down page or outside `ready` fails closed. |
| §3/§4: reachability is stated as the always-offered wide `Choose effort` page | Reachability is the `More actions…` → `All reasoning effort levels…` path in every layout, plus the compact model list's own `Enter` shortcut to the effort page. |

The revision changes no business authority: the same one handler, catalog/read
owner, writer, default-intent tracker, admission point and SDK tty owner remain.
Its own scope-action root cause, tests, real-pane evidence and remaining limits
are recorded in the pull request that carries it.

### 0.1 Real-pane verification of the revision

> **Superseded in part by §0.1b.** This subsection measures the FIRST revision of
> the footer (four or five entries in the action bar, including the whole
> `Choose & Save as Default` sentence as the write button). The Owner replaced
> that footer design after those measurements, so the clipping table and the
> `KNOWN_CLIENT_LIMITATION` below describe THAT revision; §0.1b records the
> short-bar revision that replaced it. The scope-column click protocol, the
> drill-down pages and the write authority measured here are unchanged.

Measured in a real Tern pane (`tern serve`, real Tern 0.8.0 with the locked
`@stencil-hq/tern@0.1.0`, software rendering) driving the PRODUCTION
`TspModelPicker` with real pointer clicks and real keys; the driver and its PNG /
node-tree captures are worktree-local and are not committed.

Wording readability, pointer reachability and keyboard operability are reported
SEPARATELY, and each is measured the way it can actually be measured: a DOM string
or a text node's own rect is NOT a visibility proof (the client clips at an
overflow edge and keeps the full string in the DOM while CSS cuts it), so the bar
is checked by geometric CONTAINMENT inside its own `pk-bar`/`pk-sheet` box,
pointer reachability by clicking the actually-visible fragment, and wording by the
captured PNG. An unproven path is recorded as `NOT_VERIFIED`, never as a PASS.

| Verified | Result |
|---|---|
| A real pointer click on the left Provider column | delivered as `action { act:'scope', value:'scope:q' }`; the list really filtered to that provider's rows; `All models` sent `scope-all` and restored every provider; **zero writes** |
| The main footer | `Cancel` / `Full details…` / `Retry failed providers` / `Choose & Save as Default`, and no `Choose effort` |
| The details page | `Full model details` with `preview: none`, no scope column and no side preview box; footer `Cancel` / `Back to models` / `All effort levels…` / `Retry failed providers` / Primary; at wide width the complete CJK + emoji description is in the rendered tree, and at the compact widths walking the presentation cursor really scrolls every part of it on screen (the native list renders only the window near its viewport) |
| The effort page | `Reasoning Effort` with no scope column, `Back to details`, and the complete 7-candidate list of a model whose wide column cannot inline them |
| The one write | at 1280x800 the Primary click wrote exactly once with the draft chosen on the effort page; the K2 keyboard path (`Tab`,`Tab`,`Enter`) also wrote exactly once |
| The action bar at 1280x800 and 900x640 | every button box fits its own bar on all three pages (model list / details / effort); the pointer click on the Primary writes |
| The action bar at 560x640 | the model-list and effort bars fit; the FIVE-button DETAILS bar does NOT — its Primary box is 463–634px inside a 500px-wide bar, so only 67px of 171px is visible and the label is cut to `Choose &` |
| Details -> complete Effort list -> step -> Back, per configuration | verified by KEYBOARD at 900x640 and 560x640 in the client font, AND at 400x600 in the client font, +25% and +50% (widths and fonts are two separate sweeps, not a full cross product): the list opens, a candidate step really moves the selection, and `Esc` returns to the details page and then to the model list |

#### Measured limitations of the FIRST revision's action bar (superseded by §0.1b)

The action bar lays its buttons on ONE line and does not wrap, and it has no
scroll port of its own, so a bar cut at its own edge loses the rightmost buttons.
Measured per page and per pane, with the visible fragment of each overflowing
button:

| Pane | model list (4) | Full model details (5) | Reasoning Effort (4) |
|---|---|---|---|
| 1280x800 | fits | fits | fits |
| 900x640 | fits | fits | fits |
| 560x640 | fits | Primary 67px of 171px visible | fits |
| 400x600, client font | Primary 38px of 171px | Primary 0px; `Retry failed providers` 54px of 139px | Primary 22px of 171px |
| 400x600, +25% | Primary 0px; `Retry failed providers` 117px of 214px | `All effort levels…` 86px of 167px; `Retry failed providers` 0px; Primary 0px | Primary 0px; `Retry failed providers` 91px of 214px |
| 400x600, +50% | Primary 0px; `Retry failed providers` 81px of 254px | `All effort levels…` 44px of 197px; `Retry failed providers` 0px; Primary 0px | Primary 0px; `Retry failed providers` 50px of 254px |

The bar's requirement is the width of its OWN button set, which is why the
five-button DETAILS bar already clips at the measured 560px pane while the
four-button model-list and effort bars fit there. That fifth button is
`Retry failed providers`, which exists only while part of the directory failed:
measured at 560x640, that bar is `Cancel` 42–96, `Back to models` 98–203,
`All effort levels…` 205–314, `Retry failed providers` 316–455, Primary 463–634
inside a 30–530px bar, so WITHOUT a failed provider the same page's four buttons
would end at 493 and fit — a GEOMETRIC DERIVATION from those measured boxes, not a
no-failure-pane run. At 400x600 the Primary's label is
clipped to `Cho…` at the client font (the 38px fragment really does trigger the
write) and the button has NO visible fragment at +25%/+50%; the focused action's
`▸` cue measures 4.2px of a 158px label at the floor and 0px at an enlarged font,
so at those configurations the keyboard write can only be triggered BLIND (it
still writes exactly once — verified). The details title `Full model details` is
also ellipsized to `Full model …` at 400x600 (rendered advance 5.07px/char against
6.84 at 560px) while it is complete at 560px and 900px; the strip subject
`Default model` is complete at the client font and ellipsized to `Default mo…` at
+25%/+50%.

The Owner-frozen wording is NOT abbreviated and no button is self-drawn or
wrapped: these are `STOP`-class environment limits reported to the Owner (the
plan's §8 condition), not a silent PASS and not a reason to change the frozen UI
here. Physical IME, focus/theme behavior, full-profile/HMR, enlarged UI fonts at
the WIDE layout and the Remote TSP Model success path remain `NOT_VERIFIED`
exactly as recorded in §5.

### 0.1b Owner footer revision: the short bar, the operation block and the More page

A second real-pane measurement round (same environment: real Tern 0.8.0, locked
`@stencil-hq/tern@0.1.0`, the production presenter in a real pane) found that the
previous revision's action bar could not present its one write action at narrow
panes, and the Owner therefore replaced that part of the design: the bar is now
`Cancel` + exactly one short entry, the complete business meaning moved into a
wrapping OPERATION BLOCK, and the secondary operations moved to a `More actions`
page reached from a strip chip.

| Verified | Result |
|---|---|
| The strip's chip really speaks | a real pointer click on `More actions…` is delivered as `action { act: 'strip', value: 'strip-more' }` on the action channel, so the chip needs no second event path |
| The operation block's region | the picker's preview region renders the block BELOW the list at `md`; measured at 900x640 the list ends at y=378, the block's four lines sit at y=399 / 421 / 443 / 465 (each 20.16 tall, EVERY one fully inside the region on both axes), the strip starts at y=510 and the bar at y=558 — so the complete explanation is really readable there, which is why the block is rendered as a headless column: a card head cost one of the region's few lines and pushed the consequence sentence past the region's bottom edge. A long sentence WRAPS naturally (two lines at a 400px-wide pane). At `lg` that region is the side column, where the block's own wrapped height (8–12 lines at the 248px text slot) would exceed the column's 374px budget and evict the inline effort radios, so the wide page states the operation in the strip's own `Action: <name>` line and the column's budget is UNCHANGED |
| The 400x600 ENLARGED-FONT configurations (+25% and +50%) | `KNOWN_UI_LIMITATION` / `OWNER_ACCEPTED` (Owner decision "Model Picker 400px Font Scaling"): the native client truncates the selected model/provider/effort text there (at +25% the highlighted row renders only `Reasoning Model` and `Default`), so the target is not readable while `Confirm` stays enabled; the Owner accepts the limitation, adds no geometry-based write guard, and keeps the explicit-apply and writer semantics. NOT claimed as a visual-acceptance pass; the waiver does not cover the default-font 400x600 layout, the normal supported widths, a wrong selection or a duplicate write. |
| The block at the 400px floor | the client marks the picker `pv-hide` at a 400x600 pane and DROPS the whole preview region, so the block is absent there — recorded as `KNOWN_CLIENT_LIMITATION`. The TARGET still stays identifiable there: the HIGHLIGHTED model's own row states its drafted effort (`<provider> · <effort label>`, measured: `provider p · High`), so the width keeps the short footer's completeness, target identifiability and interaction reachability |
| The More page's offered set | with a no-match search `secondaryActions` lists neither `Full model details…` (it renders THAT model's facts, so without a highlighted model it would open an empty page) nor `All reasoning effort levels…`, while `Retry failed providers (N)` and `Back to models` stay reachable; the wire gate refuses every unoffered id (`more:apply`, `more:close`, a forged `more:<id>`) |
| The wide block | its own wrapped height would exceed the side column's whole 374px budget, so `lg` states `Action: <complete name>` in the strip instead and keeps the inline effort radios; the Owner RATIFIED this per-layout acceptance ("Owner decision — Model Picker Responsive Action Explanation": the "560px and above everywhere" requirement is cancelled; `md` keeps the full explanation, `lg` keeps the name, the floor keeps the client limitation, and every layout must still have a fully visible primary button, an identifiable target, explicit-confirmation-only writes, keyboard/mouse parity and no blind write) |
| The bar's new requirement | `Cancel` (54px) + `Confirm` (68px) plus the bar's own padding need about 200px of pane, against ~680px for the previous five-entry details bar |

Measured bar containment (every button's box inside its own `pk-bar` — a node's own
rect is not a visibility proof). The final driver artifact of this revision is 46
assertions, 0 failures, 3 recorded measurements (the earlier 44-assertion run
predates the two later checks and is superseded):

| Pane / page | bar box | buttons | result |
|---|---|---|---|
| 400x600 client font, model list | 30–370px | `Cancel`, `Confirm` | both contained |
| 400x600 +25% UI font, model list | 30–370px | `Cancel`, `Confirm` | both contained |
| 400x600 +50% UI font, model list | 30–370px | `Cancel`, `Confirm` | both contained |
| 400x600 client font, More page | 30–370px | `Cancel`, `Back` | both contained |
| 900x640 model list / details | 110–790px | `Cancel`,`Confirm` / `Cancel`,`Back`,`Confirm` | all contained |
| 560x640 details (the previous design clipped its write action here) | 30–530px | `Cancel`, `Back`, `Confirm` | all contained |
| 1280x800 model list | 80–1200px | `Cancel`, `Confirm` | both contained |

Other verified facts of the revision: a real pointer click on the strip chip is
delivered as `action { act:'strip', value:'strip-more' }` and opens the `More
actions` page, whose rows are `Full model details…`, `All reasoning effort
levels…`, `Retry failed providers (1)` and `Back to models` with a
`Cancel`/`Back` bar and zero writes; the keyboard reaches the strip with ONE Tab
from the model list (`models -> strip -> effort -> action bar`), Enter opens the
More page, one ArrowDown moves the native selection onto the next row and Enter
runs it; the operation block is PRESENT at 900x640 with `Action: Choose & Save as
Default`, its four lines at y=399/421/443/465 all fully inside the region between
the list (bottom y=378) and the strip (top y=510), and ABSENT at the 400x600 floor
at the client font and at +25%/+50% (the client's `pv-hide`).

### 0.2 What the revision's automated lanes cover

The production presenter suite now drives the real SDK event channel end to end:
one `pane.event({ ev:'action', act:'scope', value })` reaches the renderer's event
route → `TspModelPicker.handleEvent` → `actionIntent` → `act` admission → the new
picker props and filtered rows. It also pins the
negative shapes (a scope-shaped row `select`, an unknown or failed provider, a
missing value, a drill-down page, the `loading` / `pending` / `error` phases),
the page-by-page footer, the `Back` target per entry page, and the K2 write
admission.

### 0.3 Successor revision: the Models → Overview → Full details restructuring

A later revision restructured the Model UX again. The body of this file and
[§0](#0-owner-revision-superseding-four-b2-statements-below) remain the
historical PR4-A record; where they disagree with
[../model-selection.md](../model-selection.md), the restructuring wins.

| Statement still in §§0–0.2 | Current contract |
|---|---|
| The short footer's write reads `Switch Model` / `Choose & Save as Default` | The write reads `Switch` / `Save default`; the same one `apply` action and the same one business operation. |
| The `Operation` block carries the complete business meaning, and the wide strip states `Action: <name>` | Both are REMOVED. No page renders an operation block, an `Action:` strip, a `More actions…` chip or a `More actions` page. |
| The complete effort list lives on the `Reasoning Effort` page, reached through the `More actions` page (or the compact `Enter` shortcut) | The `Reasoning Effort` page is REMOVED. Every candidate lives in the model's own **Overview** main list, entered from a compact model-list row and from the wide bounded column; the wide inline radio rows stay the selector exactly while `widePreviewFits` proves they fit. |
| The details/effort pages are the drill-downs, opened from the More page | `ModelPickerPage` is now `models \| overview \| details`; the wide details CARD and the Overview's own `View full model details ›` row open the read-only Full details page, whose return page is `models` or `overview` respectively. |
| The `strip` K2 zone and its chip | REMOVED. The zones are `models`, `detail-card` (the wide card), `effort` (the wide inline rows) and `primary-action`. |
| A failed read's Primary Action is the read-only Retry under the `apply` id | `retry` is its OWN action id; a forged `apply` on the details page or the compact model list is refused on the wire. |

The restructuring changes no business authority: the same one handler,
catalog/read owner, writer, default-intent tracker, admission point and SDK tty
owner remain, and the write payload rules are untouched. What is covered
headlessly (the full page/zone/action matrix and the retained invariants) is
described in [../model-selection.md](../model-selection.md), and its real-pane run
(real Tern 0.8.2 through the repository's real-pane harness,
`scripts/tern-pane-model-ux.mjs`: card head/body pointer hit, real
`select`/`activate`, footer containment and the one write at 400x600 and
1280x800) is tabulated in that same document's "Real-pane verification" section; only the enlarged-font matrix and the
orthogonal wheel/IME/theme/Remote paths stay `NOT_VERIFIED`. The measured
guarantees of §0.1/§0.1b still belong to the surfaces those runs measured and are
not inherited by the new pages.

## 1. What PR4-A adds

- The native `/model` panel inside the TSP renderer: provider-scoped model list, an
  action-first Model Details column, a complete Details page, Reasoning Effort radio
  rows plus an always-available `Choose effort` page, and one explicit
  `Apply` / `Save default`.
- The ORIGINAL command keeps every business authority: the single directory-read
  owner, the single writer, the default-intent tracker, branded effort ids, the same
  apply/default entries, the same notice and outcome vocabulary. The native UI is a
  presentation over that handler, never a second owner.
- The renderer contract requires the native `picker`/`row`/`card` kinds. A pane without
  them (an older Client) fails closed: no native model UI is mounted and the
  pre-existing refusal path answers `/model`, with no write.
- Direct and PiTui stay the defaults; TSP stays opt-in
  (`DSH_PI_TUI_RENDERER=tsp`) and experimental, and no Host, SDK, RPC, public
  extension or `packages/pi-tui/**` contract changes.

## 2. The owner-frozen UX contract

- The wide shell (`cols >= 120`) **never collapses**: provider scopes + model list +
  details column, whatever the content. Content never decides structure; the current
  model's complete details and effort set move into the picker's own pages instead.
- The details column is **action-first**: the details card carries the folded card head,
  the provider and the ID (each pre-wrapped to at most two provable lines), the keyboard
  hint and then at most ONE optional line inside the same card (the transient notice,
  else a one-line description summary); the Reasoning Effort card follows it. The
  description's full text and the extended Current/Default facts never decide whether the
  effort rows stay inline, but the identity's own bounded lines are priced, so a longer
  identity can move the effort rows to the `Choose effort` page — it never changes the
  wide shell.
- `Details` is always offered at wide; `Choose effort` is offered in EVERY wide layout,
  including while the rows are inline — the same native Picker list, over the same
  draft, with the same confirmation. It is the path that keeps every candidate readable
  and selectable when the environment's font or zoom makes the column's own fit unsure.
- K2 (see the table in [../model-selection.md](../model-selection.md)): `Tab`/`Shift+Tab`
  cycle the three zones; arrows browse the list or step the draft; `Enter` on the model
  list moves to the effort selector when the highlighted model advertises efforts and to
  the Primary Action otherwise, and in the effort zone it moves straight to the Primary
  Action — only the focused Primary Action writes; `Esc` returns to the zone and the page
  the bar was entered from, while an admitted write, a running read and a failed read
  close.
- The write subject is a fixed short line captured at open — `Default model`
  (sessionless) or `Session model` (live) — measured fully rendered at the 400px
  minimum supported pane width, where the older longer sentence was ellipsized.

## 3. Measured layout contract, and the accepted environment limits

- A fact row's `detail` is a SINGLE measured line with an ellipsis, and the renderer
  never breaks an unbroken fragment, so "the row is 36px tall" is not a readability
  budget. Every fact value is pre-wrapped to the row's OWN one-line slot — the measured
  slot minus the label that row shares its line with, priced at the 20px widest-glyph
  column bound — with the frozen caps of 11 columns (compact) and 21 (wide) as upper
  bounds. A value continues over as many rows as it needs, so no fact can be read only
  through an ellipsis.
- The fit is decided by a PROVABLE budget, never by a column count: the pane renders
  proportional text (`W` priced at 20px against a measured ~14.6px advance), measured at
  28.2px per line, 22.2px per single-line radio row, ~20px per extra label line, ~16px
  between cards and 10px of row-column padding. The usable details height of the
  shortest supported wide pane measures 374px (1280x600), against 414px at 1100x640,
  474px at 1200x700 and 574px at 1280x800 — about 226px of chrome above it.
- 374px is a **LAYOUT BUDGET, not an SDK guarantee**: of the SDK capability fields
  (`Capabilities` / `session.caps`: `term`, `ver`, `kinds`, `features`, `apc`, `credits`,
  `cols`, `cell`, `dark`, `reduceMotion`, `hour12`) only `cols` and `cell` describe
  geometry, and the resize event carries only `cols`/`cell`/`visible` — nothing reports
  the picker sheet's own box. The presenter therefore cannot read the details area's real
  geometry and cannot degrade below the floor. The
  supported envelope is a wide pane with at least 374px of usable height and 400px of
  width; below either floor the column scrolls instead of degrading, and nothing here
  claims the layout is safe there.
- What has to hold in every environment is **reachability**, not a pixel promise: a long
  fact value has its own wrapped rows plus the native list's own scrolling, and every
  effort candidate has the `Choose effort` page in every wide layout. A measured
  real-Tern font/zoom matrix shows the wide *inline* column clipping its last candidates
  once the UI font grows, while every drill-down cell still reads, steps and returns in
  all four configurations. That is recorded, and deliberately NOT repaired by lowering a
  character count.

## 4. Ownership, admission and lifecycle invariants

- One `/model` handler, one catalog/read owner, one writer, one default-intent tracker,
  one SDK tty owner, and one admission point that checks the subject, the live panel,
  the frame revision, the phase and the zone before any mutation. A stale frame, a
  superseded subject, a modal seat or an admitted write can never change panel state.
- The native presenter is split by responsibility: `model-picker.ts` owns lifecycle,
  admission and coordination; `model-picker-state.ts` owns the pure panel state, the
  selectors and the measured budget; `model-picker-intents.ts` is the whole pure
  key/event → intent map (the K2 contract, including the search box); `model-picker-view.ts`
  is pure node construction, with every intent bound to a frame revision. The directory
  projection is shared with the PiTui picker.
- Row, scope and radio-row activations are BROWSE only — they change the highlight, the
  filter or a draft. Only the explicit Primary Action writes, exactly once. A disabled
  action owns no `Enter` and carries no cue, and neither does an action the current
  phase cannot run from the keyboard (an admitted write, a running read): the `▸` cue is
  a promise about `Enter`.

## 5. Verification tiers — what each one proves

| Tier | Proves |
|---|---|
| Scripted tty + the production presenter over the reconciled SDK node tree | The K2 map and the phase admission, the cue/hint honesty, the pages, the budget decisions, the scope/candidate namespaces, the refusal of events from a previous frame. Real `onClick`/key dispatch, real props — never a renderer-local field. |
| Real Tern pane, real keys and pointer clicks (headless driver, PNG + tree captures at several sizes) | The layout decisions in a real pane: the wide column keeping its candidates inside the preview at several wide sizes, the compact drill-down, the 400px/1280x600 floors, long/CJK/emoji and blank-line/CRLF descriptions, no-effort models, live vs sessionless facts, the pending/loading/error phases and the keyboard action-bar focus. |
| Isolated official profile | The default omission in a real YAML plus a fresh Loader restart. An explicit-effort write through that official persistence chain is NOT yet qualified end to end. |
| Official Host origin/admission | A real Host same-name `/model` keeps the original Host route even with the native UI enabled, and is classified before a handler runs. |
| Live Agent (Direct) | One durable Session model-selection record and an authoritative reopen. |

Layering inside those tiers, so no future reader merges them: a full read error → `Retry`
has an original-handler path proof, while partial recovery and preserved drafts are proven
at the presenter + retry-spy layer rather than end to end through the command's own read
owner.

Not certified anywhere in this PR (`GUI_BLOCKED` / `NOT_VERIFIED`): physical GUI, IME,
focus and theme behavior, full-profile and HMR, clean live-Agent teardown, the Remote TSP
Model success path, and catalogues beyond the scripted sizes. (This is the historical
PR4-A record; the Owner revision's §0.1 adds real-pane pointer and keyboard evidence for
the specific paths it lists, and nothing beyond them.)

## 6. Pitfalls that became rules or regressions

| Trap hit during the work | What the repository now relies on |
|---|---|
| The action bar has no native focus affordance, and an app-rendered cue can easily promise an `Enter` the phase refuses (an admitted write or a running read admit only `Esc`). | The focused action carries the `▸ label` cue, and a single keyboard-actionability predicate decides whether the phase may show it at all; those phases mark nothing and their hint names the phase (`Selecting…` / `Reading…`) instead of a key. |
| A `detail` row looks tall enough to hold a paragraph; the renderer actually clips it to one measured line and never breaks an unbroken fragment. | Every fact value is pre-wrapped to its own label-aware one-line slot; the complete text lives on its own rows, never behind an ellipsis. |
| A "one line" claim that ignored explicit line breaks was wrong by a whole row. | The folding prices `LF`, `CRLF`, `CR` and Unicode separators as one break and prices tabs; the summary and head lines are folded before they are clamped. |
| The picker delivers the scope column's ids and the page's row ids on ONE channel, so resolving them by order only moved the collision. | Effort candidates carry their own wire namespace and that namespace is the only place a candidate value is read; a candidate whose value looks like a scope id (or IS the every-provider id) still changes the draft, and the scope entries still filter. |
| "Every provider" was a magic id string, so a catalogue advertising a provider literally named `all` was indistinguishable from it, and a row id shaped like a scope id could be read as a filter. | "Every provider" is the ABSENCE of a provider (`undefined`), its own entry carries a colon-free id while a provider scope is always `scope:` + the provider id, and a row id resolves by the current page first — the two can never collide, in either direction. |
| A failed read left the keyboard in an inert model zone, and `Esc` there returned to (or was dropped in) the same region. | In the error phase the bar is the only operable region: Tab and Shift+Tab both stay there, `←→` moves between Retry and Close, and `Esc` closes. A width flip re-normalizes zone and page so the keyboard never sits in a zone that is not painted. |
| A test that sent an event after a no-op frame change was refused, and it looked like a product failure. | The wire frame identity is deliberately frozen: the current frame maps every node to its revision, so an event from a previous frame is refused BY DESIGN and tests must wait for the next committed frame. |
| A test edit that only `node --test` accepted failed the bundled CI typecheck. | `node --test` runs the suites through Node's strip-only TypeScript loader and does NOT typecheck them: after editing tests, run the full `pnpm typecheck`. New `src/**` files must also avoid TypeScript parameter properties. |
| The renderer's geometry is not observable, so a fixed pixel or character budget silently became a "guarantee". | Measured constants are layout parameters of the verified environment. Reachability is the invariant; a fixed count is never lowered to paper over a layout problem, and a strict guarantee needs a Tern-side content-area capability rather than CSS reverse-engineering. |

## 7. How to reproduce

```sh
# the model suites, and every TSP suite plus the PiTui model picker
node scripts/run-with-temp-root.mjs node --test \
  test/tern-tsp-model-picker.test.ts test/model-picker.test.ts test/tern-tsp-model-profile.test.ts
node scripts/run-with-temp-root.mjs node --test test/tern-tsp-*.test.ts test/model-picker.test.ts

# types and the gates that cover this area
pnpm typecheck:bundle
pnpm gate:architecture && pnpm gate:boundary && pnpm gate:keybindings
```

Real Tern pane, headless: `tern serve --control <sock> --out <dir>`, then
`tern ctl run|type|key|click|resize|tree|dump|shot|quit`. `ctl key` takes Playwright key
names (`Tab`, `Shift+Tab`, `Escape`, `Return`), and `ctl css <name> <path>` swaps a
stylesheet in place, which is how the font/zoom matrix is driven. The PR4-A driver and its
per-step captures are worktree-local (they are not committed).

Prerequisites, so one pass is not mistaken for the whole type surface: the vendored fork's
`dist` is a build INPUT to the bundle and to the tests (`pnpm build`), and `pnpm typecheck`
runs three configurations (fork, bundle, bench) while `pnpm test` covers the fork, product,
tooling and docs suites — running only the bundle pass or only `node --test` leaves the
others unchecked.

Evidence levels — do not merge these into a stronger claim: a scripted tty that answers
the official handshake is not a real Tern pane; driving the production routing chain is
not DSH wire (L5) or the product in a real pane (L6); a passing count is
snapshot-qualified and does not transfer to a later tree.
