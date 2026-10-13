# List-first model catalogue — Gate V1/V2 and the acceptance lane

This is the evidence for the `/model` **list-first** revision: the model catalogue
became ONE native picker at every pane width (no provider sidebar, no side column),
the ONE write became an explicit footer action everywhere, and the read-only
Reader's facts were grouped.

It succeeds the [Model-Responsive / Reader evidence](./model-responsive-reader-20261013.md),
whose measurements stay valid for what they measured (the client's own
side-preview breakpoint, the Overview's priority, the Reader's scroll contract) and
are NOT rewritten. The clauses of
[Model selection](../model-selection.md) that the three-column shell depended on
are SUPERSEDED by this revision — that document is the authority for the CURRENT
contract; this one records how it was measured.

## 1. Environment and method

| Item | Value |
|---|---|
| Repository / branch | `dsh-pi-tui` / `fix/tern-tsp-model-responsive-reader-ux`, based on `next` |
| SDK | `@stencil-hq/tern@0.1.0` (declared dependency; the locked install is unchanged by this revision) |
| DSH baseline | `@deepseek-ai/dsh-*` `0.2.0-rc.2` (declared); the revision changes no Host/DSH behavior |
| Client for the real-pane work | `tern 0.8.3 (e2b8656)` — recorded by the harness in every run's ledger |
| Real-pane mode | `tern serve` (headless). **`REAL_TERN_HEADLESS` is not `REAL_TERN_GUI`**: no OS window, no wheel/trackpad, light theme |
| Fonts | `Noto Sans/Serif CJK` + `Noto Color Emoji` installed and resolved by fontconfig; the client resolves `Geist`/`system-ui` for body text and `Berkeley Mono` for the monospace id/mark cells |
| Gate harness | `node scripts/tern-pane-drive.mjs <flow> --out <dir>`; each run directory keeps `assertions.json`, `run.log`, the node trees, the PNGs and copies of the flow and subject |
| Acceptance lane | `node scripts/tern-pane-drive.mjs scripts/tern-pane-model-ux.mjs` (the SHIPPED lane, updated by this revision) |

The two Gates ran BEFORE any production edit, because they decide the page's shape;
the acceptance lane runs AFTER it and asserts the shipped presenter. Every claim
below is either a `check` (an assertion the run must prove) or a `measure`
(informational), and every containment claim goes through
`scripts/tern-pane-geometry.mjs`, so a node's own rect is never treated as a
visibility proof. The gate runs are kept with their `visual-gate.md` files; the
failures they report are the FINDINGS below, not hidden passes.

## 2. Gate V1 — the list-first Picker in the real client

Run: `temp/tern-model-301-visual-v2-v1/run-d/` (its `visual-gate.md` carries the
per-size table and the screenshots; earlier `probe-*`/`run-a..c` directories are
kept because they are what proved the first point). The fixture was ONE synthetic
`ui.picker` — `mark`, `title`, `badges`, `facts`, group `order`, an optional inline
`kv` summary and two footer actions — mounted in ONE official inline surface, with
no app chrome, so every observation is about the CLIENT and the SDK props.

**The mount region is not optional.** A picker node rendered as
`surface.render(node)` lands in the `main` region, whose content block was 44px
tall: the sheet collapsed, `pk-scroll` kept 10px and NOT ONE row was painted. The
same node wrapped in `ui.col` and rendered as `surface.render({ layer })` got the
real pane box (sheet `80,68,1120,698` at 1280x800, a 380px `pk-scroll`, seven rows
surviving with the below preview). The production presenter already renders into
the `layer` region, which is what this confirms.

| Question | Measured answer |
|---|---|
| Pane geometry | 1280x800 → 160 cols; 1000x640 → 124; 900x400 → 111; 560x640 → 68; 400x600 → 47; every size `cell` 8x16 |
| Row anatomy | every row painted and contained `label` + provider `mark` + `detail` + the real `current`/`Default` badges; a long CJK+emoji name was fully readable at 1280 and 400 |
| Row `title` | the complete model id (a 141-character unbroken id) reaches the client intact as the row's own title attribute and never enters the visual line |
| Group `order` | the pinned `Current / Default` group first, then one group per provider, then the partial-failure group: headers and counts all correct, no row listed twice |
| `preview: 'below'` + inline `ui.kv` | really painted below the list at 1280x800, 1000x640 and 900x400, with no `pv-below-auto`-style clipping; at 560x640 and 400x600 the client itself `pv-hide`s it (identical to `none`, so a narrow pane pays nothing). At 900x400 the summary left the list only TWO rows instead of three — the one measured case where the summary squeezes the list |
| the ONE optional `Effort` column | renders correctly (head on the first group row, `facts` paint ONLY when the column is declared, no value where the model advertises none, the client auto-hides the whole column at 400x600). It takes a FIXED 106px of the row's text area at every width (`pk-txt` 1026px → 920px at 1280x800, 406 → 300 at 560x640) while the model label keeps its intrinsic width, so the row's provider DETAIL is what yields |
| Footer | `Cancel` + `Switch` are both painted and contained at 400x600 and 560x640, and a real click on each delivers exactly one `action` event (`close` / `apply`) with `Switch` reading as primary |
| Row events | a real click on a NOT-highlighted row sends `select`; a real click on the now-highlighted row sends `activate`; neither sends an action and neither writes |
| Focus affordance | the selected/current styles are native (`pk-row … sel` with `aria-selected`, a `pk-selbar`, and a separate `cur` + checkmark for current). Under either region focus the selected row, the selection bar and BOTH button class lists were byte-identical, i.e. the client paints no focus distinction on an action BUTTON. (The client's own `pk-sheet f-list`/`f-preview` region class is a LIST/preview-region fact already recorded in the project's Foundation evidence; the `focus` prop exposes no value for the action bar at all.) |
| Disabled rows | the client does NOT refuse them: a real click on a `disabled` row still sends `select` for it and paints it as selected. Its reason text is not painted either (it only reaches the client's own title attribute) |

**Decisions taken from it.**

1. The catalogue is ONE picker in the `layer` region, `layout: 'rows'`, no scopes
   column and no side column (the mount and row facts above).
2. Width decides ONLY informational chrome: the `lg` sheet plus the compact
   read-only summary from `900px` of reconstructed pane width upwards. That number
   is inside the region the client was measured to paint (888px paints, 544px is
   hidden) and it also keeps the ONE measured squeeze case (888px at a 400px-tall
   window) on the `none` side of the line.
3. The `Effort` column IS adopted: it makes the model's drafted effort visible at
   the first level (which is the product concern this revision answers) and its
   measured cost falls on the row's provider detail, not on the intrinsically
   sized model name; the client hides the column itself on the narrowest panes.
   The Overview remains the place where a draft is changed.
4. The action bar keeps an app-rendered focus cue: the `focus` prop has no value
   for it and the client paints no button focus distinction, so the focused action
   still changes shape while the keyboard is in the bar.
5. The list cursor is the APP's: with the app's own navigation disabled, six real
   `Down` keys moved no cursor and produced no event, so the presenter drives the
   client's highlight through the picker's own `selected` prop. That is also why
   the app — not the client — must refuse a row the current list does not offer.
6. The partial-failure `Retry failed providers` row is safe as a list row: keyboard
   browsing cannot land on it by itself (no cursor movement without the app), the
   app's own cursor walk CAN reach it, and a real click on it — highlighted or not
   — sends `select`/`activate` for it, which is exactly the read-only re-read.

## 3. Gate V2 — the grouped read-only Reader

Run: `temp/tern-model-301-visual-v2-v2-reader-a3/` (its `visual-gate.md` carries
the per-size table, the six answers and the screenshots; the earlier attempts are
kept). The fixture was ONE synthetic `ui.overlay` (`size: 'lg'`, `modal: true`)
with a `Back` row and a scrollable body, replicating the production Reader's shape.

| Question | Measured answer |
|---|---|
| Grouping | a `ui.col` + muted head line + `ui.rule` + a `lg` spacer left a 20px gap BETWEEN groups against a 2px gap INSIDE one. A bare `ui.section({head})` painted its heads but left 2px between groups against 8px inside — a hierarchy INVERSION (the gate's one real failure). `ui.section` + an explicit `lg` spacer also passed (22px against 8px) |
| `ui.kv` values | SHORT values render fully in both layouts (`grid` one line each; `inline` stacks one pair per row at 400x600). A pathological 190-glyph value WRAPS in `grid` (8 lines) but is CLIPPED in `inline`. `kv` is therefore only ever fed the short real facts |
| Long unbroken id | `wrap: 'char'` really breaks it (5 lines at 400x600, 3 at 1000x400 and 1280x800) and the whole id is contained at the top with no scrolling; `End` really moves the client's viewport and the tail stays contained |
| Whitespace | a control value with CRLF, LF and an explicit blank line rendered FOUR lines (64px) against the page's own 16px single line, at every size |
| `Back` | exactly ONE actionable `Back` row at every size. At the TOP it is a real click target; at the TAIL it has scrolled out of the viewport with zero visible span, i.e. `Esc` is the way back from the tail. The page must therefore keep `Esc` bound to `back` |
| Overlay box | 400x600: body `18,92,364,490`; 1000x400: body `140,92,720,290` with no clipping (bottom 382 < 400); 1280x800: body `280,92,720,690`; the scroll container is the body column |
| Long head | a 66-character model name remains complete in the node tree but the client ELLIPSIZES the overlay title on one line. A short model name is a clean title; a long one truncates, so the complete name is also carried as the Identity group's first fact |

**Decisions taken from it.** The Reader groups its facts with
`ui.col` + muted head + `ui.rule` + a `lg` spacer (not `ui.section`); each value is
a label plus ONE `ui.text({wrap})` (`char` for identifiers, `word` for prose), so a
long value can never be clipped by a one-line container; the overlay's head is the
model name and the complete name is an Identity fact as well; a transient notice
leads the page as its own line; and `Esc` stays bound to the Reader's `Back` intent
because the visible row cannot be reached from the tail.

## 4. The shipped presenter's acceptance lane

`scripts/tern-pane-model-ux.mjs` (flow) + `scripts/tern-pane-model-ux-subject.mts`
(subject) mount the PRODUCTION `TspModelPicker` over one official SDK inline
surface in a headless `tern serve` pane and send REAL pointer clicks and REAL keys.
It asserts the presenter's own claim against the client's own preview classes at
every supported size, the containment of what the client paints (footer buttons,
model rows, Overview candidates), the real `select`/`activate` split, the ONE write
through the subject's writer spy, the Reader's complete values and app-driven
scroll, and the failed-read phase. The run directories keep the ledger, the node
trees, the screenshots and `visual-acceptance.md`; the lane is part of the
repository's repeatable acceptance path (it is not part of `pnpm test`/CI, because
it needs the external Tern CLI). The final run of this revision is
`temp/tern-model-ux-lane-v2-a10`, taken after the review round's fixes; it carries
the per-size matrix over TEN panes, the per-size Overview + Reader pass, the twelve
§9 captures and `visual-acceptance.md`, and §5 below summarises its visual review.
Its earlier iterations are kept, and two of them are the reason its assertions read
the way they do: the short `900x400` pane is asserted through the contract's rule
(the list region plus its FIRST row/candidate contained, everything else reachable
by the list's own line keys) with every clipped span and the painted-at-once count
recorded as MEASUREMENTS, and a candidate count is an assertion on every pane tall
enough to mount the rows rather than on the one short pane where the client
virtualises them. Two of them are why the flow reads the way it does: an early
one measured the short 900x400 pane more strictly than the plan's short-height rule
requires (full containment of every row and candidate), so the flow now asserts
containment of the FIRST row and candidate plus the reachability of the rest and
records every clipped span as a measurement; and the round that fixed the review's
findings added the assertion that NO pending Overview frame offers a clickable
`Back`.

The measurements it established on the shipped presenter:

| Fact | Measured |
|---|---|
| The presenter's claim vs the client, per size | the catalogue asks for `lg` + `preview: 'below'` from a RECONSTRUCTED 900px upwards and for `md` + `preview: 'none'` below it, and the client's own classes agree at every tested size (888px → `sz-md pv-none`, 992px → `sz-lg pv-below`) |
| The effort column | the wire declares it at every catalogue width; `facts` paint only while it is declared; the client paints the `Effort` header on the first group row and auto-hides the column at 400x600; the fact slot measures 96px at every size that paints it, while the model NAME keeps its own intrinsic 76.6px |
| The `pk-txt` text area | 236px at 400x600 (column hidden), 300 at 560x640, 480 at 900x400, 740 at 1000x640, 920 at 1280x800 |
| The short 900x400 pane | the list region shows two complete model rows and clips the third at 18 of its 36px; the Overview's first screen shows the effort head plus three of four candidates (the fourth at 10 of 36px). Both remain reachable with the list's own line keys, which is the plan's short-height rule — the clipped spans are recorded as measurements, never as contained nodes |
| Real row events | one click on a non-highlighted row emits `select` for it (highlight only, still the catalogue, zero writes); one click on the highlighted row emits `activate` and enters that model's Overview |
| The one write | a real click on the Overview's primary wrote exactly once, with the drafted effort, through the subject's writer spy; the catalogue row then states the new `High` fact |
| The Reader | the long unbroken id renders as ONE client-wrapped node of 3 lines and the long description as ONE node of 83 lines (against the same font's 16px single line); a `catalog is unreachable` value carrying CRLF, LF and a blank line renders exactly 4.00 lines as the Reader's LEADING line; `Down` and `End` really move the client's viewport through the native `scroll` op addressed to this frame's body id; `Esc` and the visible `Back` row both return to the Overview |
| The partial failure | the catalogue's order ends with `Unavailable providers` (its inert rows) plus the ONE `Retry failed providers` row, and a real click on it reached the retry spy exactly once while the writer was never called |
| The admitted write's bar | every frame that carried the pending state paints `Close` + the disabled `Selecting…` and NO clickable `Back`; the settled (refused) page restores its `Back`, which then returns to the catalogue |
| The sessionless subject | the title reads `Choose default model`, the primary `Save default`, and no `current` badge is fabricated |
| The Overview's identity row | the page's FIRST main-list row is the model's own identity (its name, with the complete id as the row's `title`) at EVERY width — the caption alone cannot carry it, because the client ellipsizes a narrow title and paints no subtitle at 400/560px (measured in the captures) |
| Every size opens BOTH content pages | per size: `Enter` opens the Overview, the `Reasoning effort` head and its FIRST candidate are contained, all four candidates are listed, the LAST one is reachable with real line keys, a REAL pointer click on `View full model details ›` opens the Reader, the Reader really replaces the picker (no picker node, no button), its head is the MODEL NAME, its visible `Back` row and its first group head are contained, and `Esc` walks back to the Overview and then to the catalogue |
| The Overview's identity row, per size | the identity row is PAINTED and contained at all ten sizes: `400x600` → `40,170,320,36` carrying `Alpha Model` while the caption is elided to `Model over…` and no subtitle is painted; `560x640` → `40,170,480,36`; `1000x640` → `40,126,920,36`; `1280x800` → `90,126,1100,36`. The wire row carries `label` = the model name and `title` = the complete model id |
| The 400px floor (visual check of the capture) | the client ellipsizes the page title itself (`Switch mo…`) and paints NO subtitle, so the catalogue's one hint and the fact column are both absent there; the rows keep their provider mark and their real badges and the footer's `Cancel` + ONE write are fully visible and contained. It is the client's own floor behaviour, recorded as a limitation rather than as a passing hint |

## 5. The §9 visual review of the shipped captures

Four acceptance sizes (`1280x800`, `1000x640`, `560x640`, `400x600`) × three pages,
each captured by the lane and reviewed against the plan's seven labels. Every cell
below is a PASS; the number behind a non-obvious one is the lane's own measurement
(`temp/tern-model-ux-lane-v2-a10/visual-acceptance.md` carries the same review for
all twelve captures of the FINAL run, with the per-capture numbers; the earlier
runs' reports are kept beside their own screenshots).

| page | Hierarchy | Density | Alignment | Contrast | Consistency | Action clarity | Overflow |
|---|---|---|---|---|---|---|---|
| Models | PASS — a 32px group-head band against a 36px row pitch, then the rows, then the summary | PASS — 0.79–1.65 rows per 100px from the widest pane down to 400px; one line per model | PASS — the provider mark, the label and the provider detail share the row grid, with the fact column right-aligned | PASS — 10.55:1 text contrast; muted heads and labels against strong names; the primary is the only filled control | PASS — the same sheet, muted-label and footer rules as the other two pages; `Geist 13.5/400` body | PASS — `Cancel` + the ONE write, both contained at every size | PASS — 0 clipped rows at every size except the short 900x400 fold (measured below); the 400px title elision is the client's own floor behaviour |
| Overview | PASS — the model's own identity row leads the page (its name, painted at every size), with its real state in the subtitle where the pane paints one, then the effort section and the single details entry | PASS — the candidates own the page (1.38–2.65 rows per 100px); no inert fact rows | PASS — the section head, the candidate marks and their labels share one gutter | PASS — 10.55:1; the drafted candidate is the only filled mark | PASS — the same picker family as the catalogue | PASS — `Back` + the ONE write, both contained, and `●` marks the draft | PASS — 0 clipped candidates at every size except the short 900x400 fold (measured below) |
| Full Details | PASS — the model name is the overlay title, then Identity / Configuration / Description separated by a rule and a `lg` spacer (36px between groups against ≤5px inside one) | PASS — one label+value per fact, no cards and no unlabelled fragments | PASS — every value starts at the same left edge | PASS — muted labels against plain values | PASS — the same fact wording as the catalogue and the same footer rules (`Back` first) | PASS — the visible `Back` row plus the `Esc` that shares its intent | PASS — the long unbroken id and the description wrap fully (3 and 83 client-wrapped lines), with nothing pre-split by the presenter |

The short `900x400` pane is the one measured exception to "0 clipped": there the
catalogue's list shows two complete rows and clips the third at 18 of its 36px, and
the Overview's first screen paints three of the four candidates — the fourth
(`High`) is not even mounted while the scrollport is at the top, and the third
(`Medium`) is clipped at 10 of its 36px. Every one of them is reachable with the
list's own line keys, which is the plan's short-height rule, and the ledger records
each clipped span plus the painted-at-once count (`3/4`) as measurements rather than
counting them as contained nodes.

## 6. What stays NOT_VERIFIED

- **pointer/wheel scrolling** of the Reader body: this client's control channel
  exposes no pointer/wheel verb at all (the lane probes the shapes and records the
  accepted set as empty), so the plan's pointer-scroll item is an explicit OWNER
  EXEMPTION. The same capability is verified through the app's own keys.
- **`PageUp`/`PageDown` through the client's own control channel**: the `key`
  command accepts `PageDown` and delivers no key for it; the byte-level
  `CSI 5~`/`CSI 6~` mapping is covered by the headless suite, and the pane drives
  the same `scroll` op with `Down`/`Up`/`Home`/`End`.
- the client's EXACT breakpoint for painting the below-list summary (measured only
  between 544px hidden and 888px painted);
- `ui.kv` clipping for a pathological long value is a geometry-plus-screenshot
  inference (the gate did not read a DOM `scrollWidth`);
- **dark theme**: the client's own control channel accepted a `theme dark` request
  but its layout kept reporting `light` and its computed colours did not change, and
  injecting a `color-scheme` stylesheet did not produce a real dark rendering
  either — so no dark capture exists and the claim stays `NOT_VERIFIED` (the probe's
  screenshot is kept with the run);
- IME, OS-level focus, screen readers, terminal scaling, physical
  GUI, and the Remote TSP application path;
- the +25%/+50% enlarged-UI-font matrix at 400px, which remains the pre-existing
  Owner-accepted limitation recorded in
  [the PR4-A evidence](./pr4-a.md) §0.
