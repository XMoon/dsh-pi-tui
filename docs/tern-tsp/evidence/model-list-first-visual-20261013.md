# List-first model catalogue — Gate V1/V2 and the acceptance lane

This is the evidence for the `/model` **list-first** revision and its follow-up: the
model catalogue is ONE native picker of ONE size at every pane width (no provider
sidebar, no side column, no preview region, no fact column), it carries the ONE
Reasoning Effort editor as its own native `strip`, a row activation opens the
read-only Reader DIRECTLY (there is no intermediate page), and the ONE write is an
explicit footer action everywhere.

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
| Size probe (untracked spike) | `node scripts/tern-pane-drive.mjs scripts/tern-pane-size-probe.mjs` with `GATE_PICKER_SIZE=md\|lg`, one synthetic twelve-row picker whose only variable is the SDK `size` prop; used to decide the sheet size, kept under `temp/tern-model-size-probe/` |

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
2. ~~Width decides ONLY informational chrome (the `lg` sheet plus the compact
   read-only summary from `900px` upwards).~~ **SUPERSEDED**: the summary and the
   fact column were retired (they cost a fixed slice of every row and of the sheet
   body for one line of information), and the sheet is now the client's `md` dialog
   at EVERY width — see §4's size measurements and the official product's own
   precedent recorded in the contract.
3. ~~The `Effort` column IS adopted.~~ **SUPERSEDED**: the column cost a fixed
   106px of the row's text area at every width for a value that read as a column
   detached from its model, and the effort is now edited in the catalogue's own
   native `strip` instead — a first-class control rather than a fact. The
   measurements above stay valid for what they measured.
4. The action bar keeps an app-rendered focus cue: the `focus` prop has no value
   for a button and the client paints no button focus distinction, so the focused
   action still carries a shape of its own while the keyboard is in the bar. It is
   the design language's `Verb [Enter]` key badge.
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
(subject) mount the PRODUCTION `TspModelPicker` over one official SDK inline surface
in a headless `tern serve` pane and drive it with REAL pointer clicks and REAL keys.
It asserts the presenter's own claim against the client's own classes at every
supported pane size, the containment of everything the client paints (the sheet, the
footer, the rows, the strip's chips), the real `select`/`activate` split, the ONE
write through the subject's writer spy, the Reader's complete values and its
app-driven scroll, and the strip's phase gate. The run directories keep the ledger,
the node trees, the screenshots and `visual-acceptance.md`; the lane is part of the
repository's repeatable acceptance path (it is not part of `pnpm test`/CI, because it
needs the external Tern CLI).

**This section describes the CURRENT source.** The run below is the lane's final run on the
tree it names by hash, and its record carries the sha256 of the four production modules it
really rendered — every fence below is rendered BY that run, and the lane asserts each of them
on the real client:

- a chip click hands back its **composite** id verbatim (`effort:["alpha","m-alpha"]\u0000high`
  in the fixture) and drafts only that model's local effort;
- a MOUSE click on another model while the strip owns the keyboard hands the keys back to the
  list (asserted by the hint and by the next `↓` moving the ROW, not the draft);
- leaving the Reader and entering it again gives the second reading its OWN scroll-container
  id, and that reading's own `End` addresses that id;
- a read that fails as a WHOLE leaves ONE `Retry` — the bar's — with no retry ROW beside it, the
  failed providers still on screen as read-only context, and the "Unavailable providers" group
  count and the catalogue total both following that row's absence;
- `Esc` with a typed filter CLEARS that filter and leaves the panel open (asserted from the
  strip, from the list and from a FAILED read), and a second `Esc` then closes it while an
  ordinary key still cannot edit the search box in that phase;
- a SEARCH with no matches empties the list and the client paints NO empty copy at all (the wire
  still carries the picker's `empty` prop): the "no model is advertised" sentence is therefore
  not reachable from a filtered list on this client, and the lane records the measurement so a
  future client that starts painting one flips it.

The run is `temp/tern-model-ux-lane-v2-a41`; its `visual-acceptance.md` carries the per-pane
table, the seven-label review of every capture and the provenance record. Earlier runs are
kept beside their own screenshots as HISTORY — their hashes describe the source of their own
moment and are never quoted as evidence for this one. Two of them are why the assertions read
the way they do: Every earlier
the short `900x400` pane is asserted through the contract's
rule (the list region plus its FIRST row contained, everything else reachable by the
list's own line keys) with every clipped span and the painted-at-once count recorded
as MEASUREMENTS, and a frame that carries an admitted write must offer no clickable
entry the phase cannot run.

The measurements it established on the shipped presenter:

| Fact | Measured |
|---|---|
| The sheet, per pane | the catalogue asks for `size: 'md'` at EVERY width and the client's own class agrees (`sz-md`, and `sz-lg` never appears). A separate synthetic probe (one twelve-row picker whose only variable is the `size` prop, kept under `temp/tern-model-size-probe/`) measured what the choice means: `lg` fills 1120x698 of a 1280x800 pane and 940x538 of a 1000x640 one, while `md` is a centred 680x540 / 680x498. At 560x640 and 400x600 both sizes give the same 500px and 340px sheet, because the client shrinks `md` below its own cap |
| No informational chrome, at any width | `preview: 'none'` with no `pk-pv` node, no fact cell (`pk-fact`/`pk-fh`), no `columns` in the wire and no `pv-below` class at any tested pane |
| The strip is the ONE effort editor | the wire carries `label: 'Reasoning Effort'` and one item per advertised candidate of the HIGHLIGHTED model, with the local draft marked `on`; a real click on a different chip moves `on` and writes NOTHING; a model that advertises no effort paints no strip, and one forward `Tab` reaches the bar |
| The strip's phase gate | the strip exists only while the phase is `ready`: an admitted write, a running re-read and a failed read paint NO strip (the client paints no disabled strip item), and a strip click in those phases changes neither the draft nor the writer |
| The strip's own focus | while the keyboard is on the strip the picker asks for the client's own region focus (`focus: 'strip'`) and the sheet really switches to the measured `pk-sheet f-strip` class; one more `Tab` returns it to `f-list` |
| The strip's chip labels | the client wraps the chips onto further rows but can neither shrink nor wrap ONE chip: at 400x600 the chip container measures 193.27px while the widest chip measures 308.59px, so the presenter clamps each label to the pane's own capacity with a MIDDLE ellipsis. Two candidates that differ only in their tail stay distinguishable, every clamped chip is contained and each one still delivers its own strip click with zero writes; at 1280x800 the same labels are untouched |
| One node identity per panel | the picker's wire id is UNCHANGED across a real selection click (asserted in the lane), and the isolated A/B/C/D probe (`scripts/tern-pane-identity-probe.mjs`, kept under `temp/tern-model-identity-probe/`) proves the cause: with a per-frame key the same click moved every row by four rows, while with ONE stable key every row kept its exact coordinates and only the highlight moved. A forty-row catalogue through the production presenter (`scripts/tern-pane-scroll-probe.mjs`, `temp/tern-model-scroll-probe/p17`) sends all 42 rows again, keeps the client's own scroller (and its scrollbar) and its click frame is byte-identical before and after |
| The two pages | the client is only ever on `models` or `details`: `Enter`/`activate` on a catalogue row opens the read-only Reader DIRECTLY (no intermediate picker frame at any tested pane), its head is the model's own name, and its visible `Back` row and the `Esc` that shares its intent return to the catalogue |
| The ONE write | a real click on the footer's primary writes exactly once, with the strip's draft, through the subject's writer spy |
| The Reader | the long unbroken id renders as ONE client-wrapped node (3 lines) and the long description as ONE node of 83 lines against the same font's 16px single line; a value carrying CRLF, LF and a blank line renders exactly 4.00 lines as the page's LEADING notice (a wire span with the `error` tone in the error phase); `Down`/`End` really move the client's viewport through the native `scroll` op addressed to this frame's body id (one dropped scroll was observed under a stalled frame credit — the documented F3-004 boundary, recorded rather than hidden) |
| The short 900x400 pane | the list region paints two complete model rows and clips the third at its fold; the third is reached with the list's own line keys. The clipped span is recorded as a measurement, never counted as a contained node |
| The partial failure | the order ends with `Unavailable providers` (each row stating `<Provider> · unavailable` in words) plus the ONE `Retry failed providers` row, whose real click reaches the retry spy exactly once while the writer is never called |
| The admitted write's bar | every frame carrying the pending state paints `Close` + the disabled `Selecting…`, offers no strip, and no entry the phase cannot run; the refused page is usable again with the draft the strip chose |
| The sessionless subject | the title reads `Choose default model`, the primary `Save default`, and no `current` badge is fabricated |

## 5. The §9 visual review of the shipped captures

Four acceptance sizes (`1280x800`, `1000x640`, `560x640`, `400x600`) × the TWO pages,
plus the eight-wide-label strip variants at the widest and the narrowest pane, each
captured by the lane and reviewed against the plan's seven labels. The per-capture
numbers live in the run's own `visual-acceptance.md`; the review below is the
summary, and every cell is a PASS with the exception named underneath.

| page | Hierarchy | Density | Alignment | Contrast | Consistency | Action clarity | Overflow |
|---|---|---|---|---|---|---|---|
| Models | PASS — the group head band, then one row per model, then the strip, then the bar | PASS — one line per model; the strip costs one 48px row for up to four candidates and wraps for more | PASS — the provider mark, the label and the details share the row grid; the strip's label column is its own gutter | PASS — muted group heads and labels against strong names; the draft chip is the one filled chip; the primary is the only filled control | PASS — the same sheet, hint and footer rules on every pane | PASS — `Cancel` + the ONE write, both contained; the focused entry carries the `[Enter]` badge | PASS — 0 clipped rows at every size except the short 900x400 fold (measured); the 400px title elision is the client's own floor behaviour |
| Full Details | PASS — the model name is the overlay title, then Identity / Configuration / Description separated by a rule and a `lg` spacer (36px between groups against ≤5px inside one) | PASS — one label+value per fact, no cards and no unlabelled fragments | PASS — every value starts at the same left edge | PASS — muted labels and heads against content values; the notice carries its own role ink | PASS — the same fact wording as the catalogue, and the Reader keeps `Back` first | PASS — the visible `Back` row plus the `Esc` that shares its intent | PASS — the long unbroken id and the description wrap fully (3 and 83 client-wrapped lines), with nothing pre-split by the presenter |
| The 8-wide-label strip | PASS — the strip is still one labelled region under the list | PASS — the chips wrap onto eight rows at 400x600 (282px) and four at 1280x800 (146px) | PASS — every chip shares the strip's chip gutter | PASS — the draft chip is the only filled one | PASS — the same chip rules as the four-candidate strip | PASS — 8/8 chips answered their own click with zero writes | PASS — every chip is contained after the clamp (`xspan == width`) at BOTH panes; at 400x600 the labels are the clamped `…` form, at 1280x800 they are untouched |

## 6. What stays NOT_VERIFIED

- **pointer/wheel scrolling** of the Reader body: this client's control channel
  exposes no pointer/wheel verb at all (the lane probes the shapes and records the
  accepted set as empty), so the plan's pointer-scroll item is an explicit OWNER
  EXEMPTION. The same capability is verified through the app's own keys.
- **`PageUp`/`PageDown` through the client's own control channel**: the `key`
  command accepts `PageDown` and delivers no key for it; the byte-level
  `CSI 5~`/`CSI 6~` mapping is covered by the headless suite, and the pane drives
  the same `scroll` op with `Down`/`Up`/`Home`/`End`.
- the FORMULA behind the client's `size` caps: `md` measured a 680px-wide sheet at
  both 1000x640 and 1280x800 and simply followed the pane below that, while `lg`
  filled 87-94% of it — the numbers are measured, the rule that produces them is not
  read from the client;
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

## 7. The frozen design-language checklist (§11.2)

`docs/tui-design-language.md` requires this checklist in every PR that changes a
visible surface. Filled for the model picker:

```text
[x] Which archetype(s) from docs/tui-design-language.md does this surface map to?
    Overlay: the catalogue is the native modal picker sheet and the Full details page
    is the native modal Reader. §12 names `/model`'s own sizing exception, and this
    revision brings the sheet back to that dialog size (always `md`).
[x] Role → token: does every painted string use its §3.2 token (no borrowed ink)?
    The native client paints the sheet, so its roles are the client's; OUR spans are
    the Reader's muted group heads and fact labels (role 2/5), its content values
    (role 3, painted by the client's own content ink) and its notice, which now
    carries its own role ink (role 17: `error` for a refused or failed write, `muted`
    for a cancellation) instead of borrowing the content's or guessing from the page's
    phase. A failed provider's row states its state in
    WORDS (`<Provider> · unavailable`) because §3.3.3 forbids colour-only signalling.
[x] Exactly one active signal per region (one `[Label]`/`> item` in primary)?
    Yes, and the signals are the client's own devices: the list's cursor row, the
    strip's `on` chip, the focused region (`pk-sheet f-list` / `f-strip`) and the
    action bar's ONE `[Enter]` key badge. The presenter adds no second colour cue.
[x] Can the reviewer distinguish selected / current / focused / disabled / pending /
    failed from the frame alone?
    Selected: the client's highlighted row. Current/default: the row's own lowercase
    state chips. Focused: the region class plus the `[Enter]` badge. Disabled/
    unavailable: the dim row plus the `· unavailable` word. Pending: the disabled
    primary reading `Selecting…`. Failed: the client's error state plus our message
    line. Each is a shape or a word, never colour alone.
[x] Header = where I am, body = what I see, status line = current facts, action bar =
    what I can do — no responsibility moved?
    The picker's title states what committing does, its subtitle is the ONE keyboard
    hint, the body is the rows plus the strip, and the footer carries the operations.
    The Reader's title is the model name and its body is the grouped facts.
[x] Do the advertised keys come from the live effective keymap?
    The picker's own keys (`Tab`/`Shift+Tab`, `↑↓`, `Enter`, `Esc`) are the surface's
    LOCAL keys, not rebindable `APP_KEYBINDINGS` actions, and the ONE hint is derived
    from the same ring (`tabZone`) the handler walks, so the promise and the behaviour
    cannot drift. No hard-coded letter key is advertised.
[x] Action bar: whole-segment drops only; no partial word; safety facts kept?
    The bar is the client's: it lays its two buttons on one line, both are contained
    at every tested pane, and the presenter never truncates a label itself (the strip
    chip clamp is content, not a hint).
[x] New glyphs: ASCII or EAW neutral/narrow/halfwidth (§4.3)?
    None added. The revision REMOVES glyphs: the `▸` focus prefix is gone (`▸` is the
    disclosure role) and the `●`/`○` candidate marks are gone with the retired page;
    `test/design-language.test.ts` passes unchanged.
[x] Wide / medium / narrow / short / CJK: full interaction still reachable?
    The lane drives ten panes from 400x600 to 1280x800 (including the short 900x400)
    plus CJK/emoji and 141-character unbroken fixtures; the sheet is one dialog at all
    of them, every candidate is reachable, and the short pane's clipped fold is
    recorded as a measurement with the row reachable by key.
[x] Dark / light / custom, and icons symbols / minimal checked?
    LIGHT only: the real client cannot be driven into a dark rendering (its control
    channel accepts `theme dark` and still lays out light), so dark stays NOT_VERIFIED
    as an Owner-accepted waiver. Icon variants are the client's own.
[x] No new shadow authority, focus owner, fork divergence, or duplicate layout
    framework? No new palette token?
    None: no fork change, no new token, no new module — the change is the presenter's
    own node tree plus one text-clamp helper beside its twin in `picker-text.ts`.
[x] before/after frames from the real VirtualTerminal included, plus a real terminal
    check per docs/tmux-testing.md. Unrun items are marked NOT_RUN.
    The frames are REAL-CLIENT captures (headless `tern serve`) because this surface IS
    the external client, not our VirtualTerminal; the lane's run directory keeps the
    before/after PNGs and §5 reviews them. The physical GUI / IME / OS-focus checks stay
    NOT_RUN and are listed in §6.
```
