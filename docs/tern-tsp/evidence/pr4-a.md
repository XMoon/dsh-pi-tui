# Tern TSP PR4-A Model evidence — the native Model B2 selection UI

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
Model success path, and catalogues beyond the scripted sizes.

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
