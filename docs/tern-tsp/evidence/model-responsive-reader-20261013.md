# Model-Responsive / Reader revision — Gate A and acceptance evidence

This is the evidence for the `/model` revision that fixes two user-reported
defects: the **fragmented Full-details facts** (a long value was pre-split into
unlabelled one-line Picker rows) and the **Reasoning Effort entry that is not
visible on an ordinary split pane** (the presenter asked for the wide side column
at a pane where the client paints the preview UNDER the list, outside the visible
region).

It is the successor of [the PR4-A evidence](./pr4-a.md), whose measurements stay
valid for what they measured and are NOT rewritten. Read this document for
anything about the layout threshold, the Overview's priority, and the read-only
Reader.

> **Superseded in part.** The three-column shell this revision shipped — the
> `1040px` side-preview threshold, the provider scope column, and the wide Model
> Details card with its bounded `Open model & effort ›` form — was replaced by the
> **list-first** catalogue, which is ONE picker at every pane width with an
> explicit write in its footer.
>
> What stays valid HERE is the CLIENT calibration in §2 (where the client really
> paints the SIDE preview, and what it does with `pv-side` below its own
> breakpoint) and the Reader measurements in §3.
>
> What is HISTORY ONLY and must never be read as the current presenter: the
> "Decision" paragraph of §2 (its `SIDE_PREVIEW_MIN_PANE_PX` /
> `nativeSidePreview` rule), the file-by-file list of §4, the acceptance matrix of
> §5 and the per-area summary of §6 all describe the retired `lg` +
> `preview: 'side'` shell, its provider scope column, its `detail-card`/`effort`
> zones and the `detailsReturn` field, none of which exist any more; the Reader
> rows there also say it returned to the model list, because the probe drove the
> then-current wide-card path. Under the list-first contract
> the catalogue is a single `md`/`lg` picker with no scopes and no side column, and
> the Reader's ONLY origin and return is the model's Overview.
>
> The CURRENT contract is [Model selection](../model-selection.md) and the
> replacement evidence is
> [the list-first visual evidence](./model-list-first-visual-20261013.md).

## 1. Environment and method

| Item | Value |
|---|---|
| Repository / branch | `dsh-pi-tui` / `fix/tern-tsp-model-responsive-reader-ux`, based on `next` |
| Baseline | the `next` commit whose subject is `docs(tsp): record the runtime-gap closure and the upstream SDK issue`; the plan's "precise HEAD" matched `git rev-parse HEAD` exactly |
| SDK | `@stencil-hq/tern@0.1.0` (declared dependency; the locked install is unchanged by this revision) |
| DSH baseline | `@deepseek-ai/dsh-*` `0.2.0-rc.2` (declared); the revision changes no Host/DSH behavior |
| Client for the real-pane lane | `tern 0.8.3 (e2b8656)` — recorded by the harness in every run's ledger |
| Real-pane mode | `tern serve` (headless). **`REAL_TERN_HEADLESS` is not `REAL_TERN_GUI`**: no OS window, no wheel/trackpad |
| Fonts of the acceptance run | `Noto Sans/Serif CJK` + `Noto Color Emoji` installed and resolved by fontconfig (`fc-match emoji` → `NotoColorEmoji.ttf`, `fc-match -s "sans:lang=zh"` → `NotoSansCJK`). The headless client resolves system fonts, so this is the variable that makes the CJK/emoji captures readable; the earlier captures taken before these fonts existed are SUPERSEDED and are not evidence of anything except that fact |
| Lane commands | `node scripts/tern-pane-drive.mjs scripts/tern-pane-model-ux.mjs`; the headless suites named in Model selection's "Regression coverage" |

Every real-pane claim below comes from a `check` in that flow's ledger (a claim
the run must prove) or is marked as a `measure` (informational). Every containment
claim goes through `scripts/tern-pane-geometry.mjs`, so a node's own rect is never
mistaken for a visibility proof. The run directory keeps `assertions.json`,
`run.log`, the node trees, the PNGs and copies of the flow and subject.

## 2. Gate A1 — the client's own preview mode against the pane

The presenter knows only `SessionCaps.cols`/`cell`; the client decides
side/below/hide from its own sheet width. The old rule was `cols >= 120`, i.e.
960px at the measured 8px cell, and the client's breakpoint is a 980px SHEET — so
the old rule sat below the boundary and requested a side column the client then
painted under the list.

Measured by driving the presenter of the time with a model that advertises four
candidates (three advertised efforts plus the provider-default sentinel), reading
the client's own `pv-*` mode classes and the containment of the inline effort
rows. **This first table is a CLIENT calibration**: it establishes where the
client's breakpoint is, and it was taken before `nativeSidePreview` existed (the
probe subject has no `nativeScroll` seam). The acceptance of the shipped rule is
the §7.2 matrix of the CURRENT revision, run by the committed flow and listed in
§5 below — the two are deliberately kept apart:

| pane | `cols` | client preview mode | inline effort rows fully visible |
|---|---|---|---|
| 400x600 | 47 | `pv-none pv-hide` | 0 (no preview requested: compact) |
| 560x640 | 68 | `pv-none pv-hide` | 0 |
| 900x640 | 111 | `pv-none` | 0 (compact) |
| 980x640 | 122 | `pv-side pv-below-auto` | **0 of 4** (painted under the list, clipped) |
| 1000x640 | 124 | `pv-side pv-below-auto` | **0 of 4** |
| 1020x640 | 127 | `pv-side pv-below-auto` | **0 of 4** |
| 1040x640 | 129 | `pv-side` | **4 of 4** |
| 1050x700 | 131 | `pv-side` | 4 of 4 |
| 1100x640 | 137 | `pv-side` | 4 of 4 |
| 1200x700 | 150 | `pv-side` | 4 of 4 |
| 1280x800 | 160 | `pv-side` | 4 of 4 |
| 1280x600 | 160 | `pv-side` | 4 of 4 |

Two facts decide the revision:

1. **`pv-side` is not proof of a side column.** At 980–1020px the client carries
   BOTH `pv-side` and `pv-below-auto`, and it paints the preview under the list
   where none of the four candidate rows survives its region. The historical
   flow's `pv-side` assertion could not catch this.
2. **The boundary is a pane width, not a column count.** The client's sheet
   reaches its own 980px breakpoint at a 1040px pane, which is 129 columns here.

> The rows below are measurements of the CLIENT, not of the shipped presenter.

**Decision (HISTORY — superseded by the list-first contract, see the banner).** The
presenter reconstructs the pane width as `cols * cell.w` and
requires the measured `1040px` (`SIDE_PREVIEW_MIN_PANE_PX` in
`src/tui/tsp/model-picker-state.ts`). The reconstruction UNDER-estimates the pane
by the client's own chrome (1040px → 129 × 8 = 1032px), so the boundary pane
itself still goes compact — one cell of margin in the safe direction. A pane below
the threshold uses the compact picker (`md`, `preview: 'none'`) and reaches every
candidate through the model's Overview, which is what the client can really show.

**Positive control** (the wide shell is really usable): 1050x700 is classified
`lg` + `side`, the client paints `pv-side` WITHOUT `pv-below-auto`, and all four
candidate rows are contained inside the region the client paints them in.

**Negative control** (the defect's own shape): 1020x640 is classified `md` +
`preview: 'none'`, the client paints `pv-none`, and there is no inline row to clip
— the candidates are in the Overview's main list instead, and the flow asserts
they are all on its first screen.

## 3. Gate A2 — the native Reader

The Reader replaces the details picker with ONE `ui.overlay` in the same layer.
The capability questions and their measured answers:

| Question | Measured answer |
|---|---|
| Does an `overlay` render in the `layer` region on its own? | Yes: `sf-overlay` / `sf-ov-card` / `sf-ov-head` / `sf-ov-body`, with the head prop as the title. No picker is needed under it |
| Does `ui.text` wrap at the REAL layout width? | Yes: a `wrap: 'char'` value node carries the complete unbroken 180-glyph identifier and renders it as three lines with no ellipsis; `wrap: 'word'` preserves prose and explicit newlines (a blank line must be rendered as the client shows it) |
| Is the overlay body a real scroll container? | Yes — but only when addressed by the id the SDK really assigned. `Surface.scroll('reader-body', …)` and a hand-built dotted path both failed with the client's `unknown id …`; the ids are `layer.<key>` (the region root id is the region name, and the col that becomes the region root contributes only its children), so the presenter resolves the body's id from the very `View` it renders |
| Does the app-owned keyboard really move the client's viewport? | Yes: `Down` and `End` each emitted one SDK `scroll` op for the body node the presenter built — its id is frame-scoped, `layer.model-details-reader-<serial>-rev-<rev>.model-details-body-<serial>-rev-<rev>` — and the client's own value node moved from `y=326` to `y=-568` (its height is 1312px); `Home` returned it to `y=326`, and real line keys parked it in between |
| Does the visible `Back` row work, and does `Esc` agree? | Yes: a real pointer click on the row returned to the page the Reader was entered from, and `Esc` resolved the same `back` intent. The row is the FIRST row of the scrollable body and travels with the content, so after scrolling to a long value's tail, `Home` (or `Esc`) is the way back — measured, and documented in the contract rather than papered over. **SUPERSEDED DETAIL:** this revision's probe drove the THEN-CURRENT wide-card path, so its "returned to the model list" reading and the `detailsReturn` field it names describe THAT flow; the list-first contract lets the Overview's details entry be the Reader's only origin, so the row and `Esc` both return to that Overview |
| Can a forged write reach the page? | No: the Reader paints no picker, so there is no action bar to address; `apply` was refused, the page did not change, and the frame did not even re-render |

**Honest limitations of the lane itself**, all measured rather than assumed:

1. **No pointer/wheel input exists to drive.** The plan's §A2 asks for the overlay
   body's POINTER scroll. This harness can inject keys and clicks, and its control
   channel exposes no pointer/wheel verb at all: the lane itself probes
   `wheel 400 200 -3`, `scroll 400 200 -3` and `mouse wheel 400 200 -3` and records
   the accepted set as `[]` (a wider one-off probe of eleven shapes — `help`,
   `commands`, `keys`, `wheel`, `scroll`, `hover`, `mousemove`, `drag`, `pointer` —
   was rejected the same way). Pointer scrolling of the Reader is therefore
   `NOT_VERIFIED` and is an OWNER EXEMPTION request, not a PASS; what IS verified is
   the same capability through the app's own keys (`Down`/`Up`/`Home`/`End` move the
   client's viewport, at the top, the middle and the tail).
2. **`PageDown` is not deliverable either.** The harness's `ctl key` accepts
   `PageDown` but the client delivers NO key for it (measured; `Down`, `Up`, `Home`
   and `End` are delivered), so the lane drives the scroll op with the keys that
   arrive and the byte-level `CSI 5~`/`CSI 6~` → `page-up`/`page-down` mapping is
   covered by the headless suite instead.
3. **The client's node dump normalizes whitespace and caps a node at 200
   characters.** A value of `catalog is unreachable\r\nsecond line\r\n\r\nfourth
   line` comes back from the dump as `catalog is unreachable second line fourth
   line`, so the dump can never carry the byte or newline proof. The proof is the
   RENDERED line count instead: that value occupies `64px` against the page's own
   `16px` line — FOUR lines for three breaks — so the client really honours LF,
   CRLF and an explicit blank line. The WIRE value (with its `\r\n` bytes) is
   asserted by the headless suite. The 200-character cap likewise means
   completeness is a wire assertion, while the pane proves the shape (ONE value
   node, wrapped into many lines) and the reachability.
4. **CJK/emoji GLYPHS are readable — verified by the capture.** With `Noto
   Sans/Serif CJK` and `Noto Color Emoji` resolvable by fontconfig, the Reader's
   long-value capture (`lg-reader-long-1280x800`) shows the description's CJK run
   as real glyphs (`中文描述：完整可读完整可读完整可读完整可读`) and the rocket
   emoji in COLOUR, on the line after the ASCII text — which is also the CRLF the
   fixture carries. Before those fonts existed the same fixture rendered striped
   fallback blocks, and that earlier observation was recorded rather than passed;
   installing the fonts is what turned this item from an environment limitation
   into a normal screenshot check. The structural mechanism is measured on top of
   it: the client wraps the value at its real width, honours every explicit break
   (measured line count) and preserves the complete value.

## 4. What changed

> HISTORY ONLY: this file-by-file list names the retired three-column helpers (see
> the banner). The current owner modules and their rules are
> [Model selection](../model-selection.md).

| File | Change |
|---|---|
| `src/tui/tsp/model-picker.ts` | the measured `wide()` rule (`nativeSidePreview(cols, cellWidth)`); the Reader body's wire id resolved from the rendered `View` (never a guessed path) and frame-scoped; the Reader's own view keys admitted outside the phase gates (an admitted write still owns the panel); no `factCursor` |
| `src/tui/tsp/model-picker-state.ts` | `SIDE_PREVIEW_MIN_PANE_PX` + `nativeSidePreview`; the Overview's priority order and its single-line `summaryFact` rows; `detailReaderFacts` replaces the pre-split `detailFactItems`; `OVERVIEW_EFFORT_ID` |
| `src/tui/tsp/model-picker-view.ts` | the `details` page becomes the native Reader (`ui.overlay` + `ui.text({wrap})` + a `Back` row) whose keys carry the panel serial and frame revision, so a retired frame's node ids are never reused; the picker is not rendered on that page |
| `src/tui/tsp/model-picker-intents.ts` | the Reader's `PageUp`/`PageDown`/`Home`/`End`/`↑`/`↓` scroll intent and the `Esc` that is its visible `Back`, both outside the phase gates; `Tab` is a consumed no-op on that page; row events resolve nowhere there |
| `src/tui/tsp/session.ts` | the cell width is passed with each resize; the ONE Surface owner performs the Reader's native `scroll` op |
| `src/tui/tsp/picker-text.ts` | **unchanged**: `/preset` and the bounded column keep the shared fact-row rule |
| `scripts/tern-pane-model-ux.{mjs,mts}` | the measured boundary, the plan §7.2 matrix (1100/1280x600/900/560 plus the split pane), the Reader (wrap, scroll, Back/Esc, short panes), the long-value Overview's one-line-summary guard; the subject gained the long-value fixture, the per-frame row ids and the `nativeScroll` record |
| business layer | **unchanged**: `src/tui/commands/models.ts` and `src/app/command/model-presentation.ts` keep the one read/write owner, and no new Host API, wire operation, catalog or writer is introduced |

## 5. Acceptance matrix on the shipped revision

Run by the committed flow (`scripts/tern-pane-model-ux.mjs`), which drives the
PRODUCTION presenter — the same one that ships, with the `nativeScroll` seam — and
asserts the presenter's claim against the client's own rendering. Sizes the plan
§7.2 names, each driven end to end:

| pane | presenter asks | client paints | what the run proves |
|---|---|---|---|
| 400x600 | `md` + `none` | `pv-none pv-hide` | compact list (no write) → Overview with `Back` + the one write contained and every candidate on screen; one real click on the write reaches the writer exactly once |
| 560x640 | `md` + `none` | `pv-none pv-hide` | same compact path; the effort section starts on the first screen; the Overview's details row opens the Reader by pointer and returns |
| 900x640 | `md` + `none` | `pv-none` | same compact path, with all four candidate rows contained |
| 1000x640 | `md` + `none` | `pv-none` | the reported split pane: the candidates are in the Overview, not in a hidden preview |
| 1020x640 | `md` + `none` | `pv-none` | the presenter does NOT claim the wide shell where the client would paint below the list |
| 1040x640 | `md` + `none` | `pv-none` | the boundary pane itself stays compact (the reconstruction under-estimates by one cell) |
| 1050x700 | `lg` + `side` | `pv-side` | the first pane whose sheet passes the client breakpoint: the real side column with all four candidates contained |
| 1100x640 | `lg` + `side` | `pv-side` | the plan's wide size on this revision: candidates and footer contained |
| 1280x600 | `lg` + `side` | `pv-side` | the plan's SHORT wide pane: the candidates stay inline, and the Reader's truncation is recovered by scrolling to `End` |
| 1280x800 | `lg` + `side` | `pv-side` | the documented normal wide pane and every interaction path below |
| 1000x400 | `md` + `none` | `pv-none` | the short split pane: the Overview opens, its long-value rows are each ONE native line, and the Reader scrolls to the tail |

The long-value fixture's description carries a CRLF as well as LFs, and the
Reader's `Status` fact is driven with `LF + CRLF + an explicit blank line`: the
client renders it as FOUR native lines (`64px`) against the page's own `16px`
line, so every break kind is honoured by the real client, not just by our wire.

The Reader paths in that run: a real click on the card HEAD and on a nested BODY
TEXT line each opened the Reader; `Down`/`End` moved the CLIENT's value node from
`y=326` to `y=-568`, 24 real line keys parked it in between (captured as the plan's
MIDDLE checkpoint) and `Home` returned it to `y=326`; the visible `Back` row (a
real click) and `Esc` each returned to the real origin; the short 1000x400 and
1280x600 panes both scrolled to the tail; and the subject's own phase control drove
a FAILED read on the open Reader (the failure appeared as its `Status` fact, a
scroll key still moved the client's viewport, `Home` brought the way back, and the
visible `Back` row returned to the model list).

## 6. Acceptance summary

- The measured layout rule and both of its controls passed in the real pane
  (§2), including the exact pane shape the user reported, and the shipped rule was
  re-driven on the plan's §7.2 sizes (§5).
- The Reader's capability questions passed on the real pane (§3), with the
  app-driven scroll proved by the CLIENT's own geometry, not by our wire, at the
  top, in the middle and at the tail of the long value. The subject's own phase
  control also drove a FAILED read while the Reader was open: the failure was
  reported as the page's `Status` fact, a scroll key still moved the client's
  viewport, and the visible `Back` row returned to the model list. The same rule
  for a RUNNING read, and the frame-scoped ids that keep a retired frame retired,
  are covered by the headless suite rather than this lane.
- The headless Model suite covers the same contract where a headless pane can:
  the boundary at 129/130 columns and the cell-width dependence, the Overview's
  priority row set, the Reader's complete values and `wrap` kinds, its scroll
  intents (including the negative control away from the Reader), `Back`/`Esc`
  from both origins, a resize inside the Reader, the effort candidate sets of
  0/1/7+, and every write/refusal/stale/modal fence that existed before.
- `/preset`, the wide bounded column, the PiTui picker, the Host/Config write path
  and the public extension surface are untouched by the revision.

**Not verified** (and not claimed), i.e. the OWNER decision this evidence asks
for:

- **pointer/wheel scroll of the overlay body** — no such input exists in this
  harness's control channel (measured, §3.1), so the plan's pointer-scroll item
  cannot be discharged here; the equivalent capability is verified through the
  app's own keys. This is an explicit plan-adjustment request.
- plus, as before: enlarged UI fonts at the wide layout (the pre-existing
  Owner-accepted limitation in
  [the Model selection contract](../model-selection.md)), `PageUp`/`PageDown`
  through this client's own control channel (§3.2; the same scroll op is verified
  with `Down`/`End`/`Home` and the byte-level mapping headlessly), IME, OS focus,
  themes, screen readers, terminal scaling, and the Remote TSP application success
  path.
