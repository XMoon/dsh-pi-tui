# TUI design language

> §1.3 records the Owner decisions and amendments
> (`D5`: the status keeps a glyph marker; `D7`: that marker is `‣`, not `∙`;
> `D16`: X061/X062 are the only authorized `packages/pi-tui/**` divergences for
> the settings row state). Any later change to the vocabulary follows §11.1 and
> lands in this file first.
>
> This document was derived from the real `VirtualTerminal` frames of the
> running product and from the current source owners linked below — not from
> concept drawings.
>
> Related contracts: [transcript.md](./transcript.md) (structure/folding),
> [surface-behavior.md](./surface-behavior.md) (workspace interaction),
> [overlay-focus.md](./overlay-focus.md) (seat/lease mechanics) and
> [terminal-output.md](./terminal-output.md) (untrusted-text projection).

## 1. Scope and authority

### 1.1 What this governs

The **visual vocabulary** of first-party TUI surfaces: information layering,
ink/colour assignment, case, glyph choice, the active-selection device, rules
and gutters, the header/body/status/action-bar responsibilities, and the order
in which chrome degrades on small terminals.

Applies to: the transcript, editor, footer, pickers, overlays, Settings, the Job
workspace, and every new surface. **Product meaning, visual hierarchy and accessibility remain common across renderers; the painting mechanism does not.** The existing cell/glyph/Frame rules are authoritative for PiTui-painted chrome. TSP-native components adapt those rules through §12.3; do not impose PiTui glyphs or a character-cell Frame on a client-owned widget.

### 1.2 What this never changes (STOP conditions)

This is a presentation contract. It must never silently change:

- Surface contracts: pane placement, input ladder, `Back`/`Stop`/`Copy`/`Find`/
  `Follow` semantics, admission, authority or the real write path
  ([surface-behavior.md](./surface-behavior.md), [transcript.md](./transcript.md),
  [overlay-focus.md](./overlay-focus.md)).
- The row-budget owners (`planSettingsChrome`, `planChrome`) and every hit map /
  `PaneBox` geometry. Vocabulary may change; measured geometry may not drift
  without a test update in the same PR.
- The live theme owner (`src/tui/theme/runtime.ts`) and the palette vocabulary
  (`src/domain/display/theme.ts`). This contract adds **no** colour token.
- The vendored fork (`packages/pi-tui/**`). Nothing here justifies a divergence
  on its own; the only authorized exception is an Owner amendment recorded in
  §1.3 (`D16`, X061/X062).
- The transcript's right-gutter and measurement contract (§13.4).

If a requested visual change needs a new layout/focus authority, a second theme
state, a fork change, or a public extension API change, **stop** and ask for an
Owner amendment instead of doing it under this document.

### 1.3 Owner decisions

Each decision was put to the Owner with a recommendation and at least one
alternative; this is the frozen outcome.

| # | Decision | Frozen outcome | Why / amendment |
|---|---|---|---|
| D1 | Direction | **"One active signal, quiet chrome"** (§2) | accepted as recommended: these are line-oriented full-width alt-screen roots, and a dashboard needs a geometry authority this repo forbids |
| D2 | Wide-screen column boundary | **2-cell gutter only** (no vertical glyph, no header filler rule) | accepted: zero added width, and no new EAW-ambiguous glyph role (§6.3) |
| D3 | Navigation cursor | **`>`** (U+003E) | accepted: already the measured geometry in both workspaces; `›`/`❯` are EAW-safe but already own other roles (icon semantics / legacy list cursor / transcript user marker); Pi's `→` is EAW-ambiguous and rejected (§4.3) |
| D4 | Action-bar separator | **` · `** (U+00B7) | accepted: all three reference TUIs join hint segments with it, and it is already this repo's dominant idiom; the `─` rule grandfathers the same EAW class (§4.2) |
| D5 | Status presentation | **a Title Case word plus ONE shared status marker** (glyph settled by D7 below) | **Owner amendment**: the word is the signal, but the glyph anchor is kept; `●` (U+25CF, EAW-ambiguous) must go, and the marker is **not** specialised per status (`✓` for done, `✕` for failed, `⊘` for cancelled …) — state is carried by the word and its token, never by a second glyph set (§4.1) |
| D6 | Job reading-facts row | **remove the two flanking rules** | accepted: a rule marks a boundary and a text line is never flanked (§6.2) |
| D15 | Editor-seat tenant boundary | **the nested History editor-seat tenant (`Ctrl+R`) draws ONE `─` (role 15) as its FIRST row and ONE as its LAST row, below the action bar**, so the seat is visibly bounded by the transcript above and the footer chrome below. This is a deliberate, Owner-confirmed exception to §6.2's "at most two rules per frame" (that surface may paint three: top boundary, Results/Preview divider, bottom boundary). **History prefers to keep both boundary rules and lets them compress the Results/Preview regions, but a rule must never cost the mandatory Header, Query or Action Bar, at least one result row and at least one Preview content row.** When the row budget cannot satisfy all of those, the **bottom rule is removed first, then the top rule**; with no previewable content, at least one status/message row survives. A rule never takes a transcript/footer row. On this surface the action bar is the last CONTENT row, not the last physical row | The seat declares its own boundary inside its grant rather than altering shared chrome |
| D16 | Fork exception for the settings row state | **X061** (`SettingItem.valueParts` plus the label-column clamp) and **X062** (`SettingItem.searchText` plus the `searchText ?? label` predicate) are the **only** `packages/pi-tui/**` divergences authorized for this surface, each with its ledger record and guarding test; every other §1.2 item stays in force | **Owner amendment**: the P2 that a state chip could be sliced (`[defaul`) or pushed out of the row (X061) and the P2 that the label-only search lost a keyword from the middle of an abbreviated name (X062) cannot be repaired through the public surface — only `render(width)` knows the value budget, and one string is both painted and searched — so the Owner kept the atomic chip and the display/search split instead of reverting them |

Re-opening any of these is a spec change (§11.1): edit this table in the same PR,
and note a user-visible consequence in the changelog.

### 1.4 Family-consistency decisions (same review)

Checking the frozen target against the rest of the family showed places where
the *target itself* would still leave two conventions standing. Each was chosen
by the Owner from an explicit option list during the same review — including the
two that widen the scope beyond Settings/Job (`D9` overlay adoption and `D10`
the sizing ladder) — so these are Owner decisions, not implementer inferences.

| # | Decision | Rule | Why |
|---|---|---|---|
| D7 | Status marker glyph | **`‣` (U+2023)**, one marker for every status | `∙` (U+2219) is already the transcript's assistant bullet and a working frame; one glyph must not carry two meanings in one family (§4.1) |
| D8 | `Esc` position | **the last segment everywhere** — workspace bar and overlay hint alike | every overlay (picker, approval, history, task, output viewer, configurator) already puts `Esc` last, and so do Pi/Kimi/OMP; the two workspaces move to match rather than creating a second order (§7.2) |
| D9 | Overlay adoption | overlays adopt the workspace devices: selection, current chip, title placement, count alignment, placeholder ink and list layout (§12.2) | otherwise "one active signal per region" only holds on two screens |
| D10 | Overlay sizing ladder | four steps — narrow `64`, standard `72`, wide `88`, full `100%` — each with its height rule; per-surface exceptions listed explicitly (§12.2) | today's 64/72/76/88/100% × 24/28/26 is a per-surface accident |
| D11 | Placeholder / loading / failure ink | new **role 16** `placeholder` = `textDim`; a *failed* placeholder's word uses `error`; loading is text, never animation; an unselectable row is `textDim` plus a reason word | today a failed catalog load and an empty list paint the same `textMuted` |
| D12 | Case | labels, verbs and segments = Title Case; explanations and sentences = sentence case (§4.1) | the earlier "Title Case or sentence case" was undecidable |
| D13 | `Esc` verb | names the real effect of the key (`back`, `close`, `cancel`, `output`) where the hint is shown. A **state-dependent ladder**, explicitly frozen in a product contract (e.g. native TSP `/model`: clear query, else close), is an allowed scoped amendment; its displayed cue must never promise the wrong branch | a single fixed word would make the hint lie about where the user lands; a dynamic Esc effect cannot be described truthfully by an invariant single-verb hint |
| D14 | Six additive rules | see below | each removes a place where two surfaces could legitimately disagree |

D14 in full:

1. **Bracket classes.** Brackets carry exactly six classes — machine marker,
   machine chip, state chip, key badge, grouped badge and the active device —
   told apart by case + ink + uniqueness of the bold `primary` bracket, never by
   position (§4.5). A surface must not invent a seventh, a state chip never
   joins two states, and a verb label never wears brackets.
2. **Notice row = role 17** (new): info `textMuted`, error `error`, with the
   `ℹ` / `✗` prefixes added to the glyph inventory.
3. **The status marker appears only on a standalone status group.** An inline
   fact (`Config Ready`, `Loading models…`, `rows 7-40/40`) never carries it.
4. **A list's second-level text has two allowed layouts** — a right-aligned value
   column (workspace lists) or an indented description line (overlay lists) —
   chosen by width; they are the same roles, not two role sets.
5. **Counters are role 12 with a lowercase unit suffix** (`3/8`, `rows 7-40/40`,
   `2 editable rows`, `CH91.9%`, `t3/s7`).
6. **Chrome never animates.** Loading is a word (`Loading models…`); the `∙`/`◦`
   working pair belongs to the transcript's working indicator.

## 2. Direction: "one active signal, quiet chrome"

### 2.1 Why

The family already agrees on **architecture**: a fullscreen workspace is a
layout root with one compact header, one body, one pinned bottom bar, and no
border box (`Frame` is for overlays only — `src/tui/components/frame.ts`).
Both workspaces already compute their whole chrome from one per-frame plan.

The problem is not too much decoration. The measured problem is that the family
has **two competing "active" devices and no shared ink ladder**:

- Settings marks the focused pane with `[TITLE]` painted `borderFocus`
  (`settings-workspace-panel.ts:760`), whose hex `#E8A838` **is** the `warning`
  token. Ordinary focus therefore reads as an amber warning.
- The Job workspace marks the active tab with `[Output]` painted
  `textStrong(…, 'primary')` (`job-inspector-panel.ts:433`) — a different device
  and a different colour for the same semantic.
- The editors of the two surfaces picked different inks for the same role:
  Settings brands itself with `primary` (`:514`); Job brands itself with
  `textStrong` (`:572`). Detail field labels are `textDim`, while the detail
  *values* are left unpainted and render in the terminal's default foreground —
  so a custom or light palette's `text` token is ignored there, and the
  `Status` field renders "Verified" and "Not saved" in exactly the same colour.

A "quiet" goal is not checkable. So the direction is stated as two rules that
can be reviewed against a frame:

1. **One active signal per region.** Within one screen region there is exactly
   one thing the eye should read as "here / current / actionable", and it uses
   exactly one device: the `[Label]` device (brackets + bold `primary`, §5.1.1)
   or the `>` cursor glyph in `primary` (§5.1.2).
2. **Chrome is quieter than content, and every role has one ink.** Text ink is
   assigned by role from a fixed ladder (§3.3); a role never borrows another
   role's ink to "make it pop".

### 2.2 What the direction rejects

- A boxed/panelised dashboard: it would fight the alt-screen layout root, cost
  horizontal space for borders, and compete with the overlay `Frame` vocabulary.
- "Quiet" as *dimming everything*: the current UI is already dim; the failures
  above are ambiguity and missing emphasis, not excess ink.
- One shared layout framework: the two workspaces keep their own row budgets;
  only vocabulary, the action-bar row layout, and the degradation order unify.
- Copying another product's chrome. Kimi/OMP/Pi are evidence that these
  conventions are mainstream (§4, §5, §7); their specific glyphs are not
  inherited where the repo's own width rules (EAW) disagree.

## 3. The role vocabulary

### 3.1 The six layers

| Layer | Question it answers | Where it lives |
|---|---|---|
| L1 Identity | Which surface am I in? | header left |
| L2 Context | Where inside it? | breadcrumb, meta line, kind |
| L3 Content | What am I reading / changing? | body, values, log text |
| L4 Active | Where is my cursor / what is current? | cursor + brackets + bold `primary` |
| L5 Status | What state is it in? | status words, markers, notices |
| L6 Chrome | What is structural only? | rules, gutters, hints, counts |

### 3.2 Role → token table (frozen)

`textMuted` (#6B6B6B dark) is *weaker* than `textDim` (#888888); the ladder is
`textStrong` > `text` > `textDim` > `textMuted` > `border`.

| # | Role | Painted with | Bold | Examples |
|---|---|---|---|---|
| 1 | Surface identity | `textStrong` | yes | `Settings`, `Job` |
| 2 | Context trail | `textDim` | no | `Categories`, `Appearance · Rows`, `job-a · bash` |
| 3 | Content (primary) | `text` | no | log lines, `Value` value, unselected list label |
| 4 | Content (secondary fact) | `textDim` | no | `Source`, `Runtime`, `Scope`, `Description`, list summary column |
| 5 | Field / column label | `textDim` | no | `Value`, `Categories (3)`, `Rows (2)`, `Details`, `Output`, `Command` |
| 6 | Active glyph (navigation cursor) | `primary` | no | `> ` leading a list row |
| 7 | Active label (focused pane / active tab) | `primary` | yes | `[Rows (2)]`, `[Output]` |
| 8 | Selected row text | `textStrong` | yes | the selected row's label and value |
| 9 | Status word (+ the shared marker `‣`) | `success` / `warning` / **`primary`** / `error` / `textDim` / **`textMuted`** | no | `‣ Running` (`primary`), `‣ Failed` (`warning`), `Completed` (`textDim`), `Ready` (`textMuted`), `Stale` (`warning`) |
| 10 | Machine marker | `warning` / `error` / `textMuted` | no | `[GAP]`, `[ERROR]`, `[SETTLED]` |
| 11 | Diagnostic line | `textMuted` | no | `Scope: … · Refreshed 09:41` |
| 12 | Count / position | `textMuted` | no | `2 editable rows`, `rows 7-40/40`, `3/8 checks` |
| 13 | Action hint | `textMuted` | no | `Esc back`, `Enter details` |
| 14 | Affordance (clickable/keyed verb) | `primary` | no | `↗ Command`, `Copy All [C]`, `Change…` |
| 15 | Rule / gutter | `border` | no | `─`, 2-cell column gutter |
| 16 | Placeholder / empty state | `textDim`, and `error` for the word of a *failed* one | no | `No matching commands`, `Model catalog unavailable: …`, `Waiting for retained output…` |
| 17 | Notice | `textMuted` (info) / `error` (error) | no | `ℹ Copy sent`, `✗ Copy failed` |

Corrections this table makes to the current code:

- **Identity is `textStrong`, never `primary`** (`SETTINGS` moves
  `primary` → `textStrong`). `primary` then means exactly one thing —
  *active or actionable* — instead of also meaning *brand*.
- **The cursor glyph is `primary`, the selected row's text is bold
  `textStrong`.** Today the workspaces paint the cursor in the *same* ink as the
  row it marks (`> Appearance`, both `textStrong`), so the cursor disappears
  into the row. The theme objects already split the two roles
  (`settingsListTheme.cursor = color.primary('›')`,
  `selectListTheme.selectedPrefix = color.primary`,
  `selectListTheme.selectedText = chalk.bold`); roles 6+8 adopt that split.
  The Host `SearchablePicker` consumes the same split through
  `selectListTheme.selectedPrefix` and paints `> ` with it, so its cursor is
  `primary` and width-safe.
- **`borderFocus` is not an ordinary-focus colour.** It is the attention /
  approval colour (palette comment: "approval panel"; the reference study found
  Kimi's token of the same name carries the same comment). Ordinary focus and
  the active tab both use `primary`. `borderFocus` stays for approvals.
- **Content values are painted `color.text`**, never left unpainted. Leaving
  them out makes them the terminal's default foreground and bypasses the
  palette (confirmed by the theme runtime and its tests).
- **The record-bytes exception.** Raw recorded text is *not* repainted and keeps
  the terminal's default foreground: whatever the user typed, and raw tool/Job
  output (the Job output and command bodies, markdown code blocks, diff bodies).
  The palette governs **derived presentation** text — labels, summaries,
  formatted facts and detail values — and that is where "unpainted" is a defect.
  The two must not be confused: the Settings detail pane's `Value`/`Source`/
  `Runtime` are derived and must be painted; the Job log body is raw and must
  stay unpainted. **The raw record stays the content authority and the
  exact-copy source; the terminal-bound presentation is a disposable projection
  that may remove untrusted controls** (see `terminal-output-safety.md`). A raw
  job log can therefore render with whitelisted SGR while the copied bytes stay
  byte-exact.
- **Secondary facts are one layer below their group's primary content**, not all
  at the same weight: in the Settings detail pane only the primary field's value
  is `text`; `Source`/`Runtime`/`Persisted`/`Scope`/`Freshness`/`Description`/
  `Issue` values are `textDim`.
- **A status word carries its semantic token.** `Verified` → `success`,
  `Not saved` → `error`, `Outcome unknown` → `warning`, `Saving…` → `textDim`.
  Today all four are the same colour.
- **A status token is only painted when the state is not the calm default.**
  `Ready` is `textMuted` (normal), `Stale` is `warning`, `Unavailable` is
  `error`; `Completed` is `textDim` (normal), `Running` is `primary`.

### 3.3 Ink ladder invariants

1. A subordinate role's ink is never stronger than the role it supports
   (context ≤ identity, label ≤ its value's importance, hint ≤ the hint's action).
2. `primary` encodes exactly one semantic — *active or actionable*. A region may
   show it on its active devices (the cursor glyph, the bracketed active label,
   the affordance group) but never on static text.
3. Colour is never the only signal: every coloured role also has a word or a
   shape (brackets, cursor, `[marker]`).
   This rule is **new** relative to the reference TUIs (none of them states it;
   one of them paints a disabled row by colour alone) — see §13.

### 3.4 How the transcript maps onto the role table

The transcript is a *content* surface, not chrome, so two of its markers stay
outside the role table and are **not** restyled by this document:

- the user marker `❯ ` in `roleUser` (plus the optional `roleUserBg` bubble) —
  a role marker, not a cursor;
- the assistant bullet `∙` in `primary` (`iconPrefix('assistant-bullet')`).

What the table does govern there: card/context headers are role 2/11
(`textDim` for tool/focus, `textMuted` for context-cluster chrome — both legal
"quieter than content" inks, with `textDim` preferred where the header must be
read), error words carry `error`; a generic tool result keeps its text ink and only the `[error]` pill carries the colour,
folded-body text is role 3/4, and the transcript's own `── … ──` compacted
marker is a role-15 *content* rule, which is why it is not counted against the
chrome rules budget of §6.2.

## 4. Words and glyphs

### 4.1 Case

- **Labels, verbs and segments are Title Case; explanations and sentences are
  sentence case.** `Value`, `Change…`, `Retry save`, `Follow on`,
  `Categories (3)`, `Esc back`, `Not saved` are labels/verbs; `Ready · on-open
  snapshot`, `read-only here · Other settings edits this row`,
  `Retained preview · not full history` are sentences. There is no ALL-CAPS role
  for words: `SETTINGS` → `Settings`, `JOB` → `Job`, `CATEGORIES (3)` →
  `Categories (3)`, `DETAILS` → `Details`, `RUNNING` → `Running`,
  `Config READY` → `Config Ready`.
- ALL-CAPS is reserved for two non-prose roles: **bracketed machine markers**
  (`[GAP]`, `[SETTLED]`, `[ERROR]`) and **acronyms / unit abbreviations**
  (`TTFB`, `CH91.9%`, `R5 116 tok/s` in the footer stats, `PS>` as a shell
  prompt). It is never used to give a *word* emphasis. The bracketed markers
  keep uppercase: they are the one role ALL-CAPS keeps.
- Status words are a fixed display map, with the raw status as the fallback for
  an unknown wire value: `running`→`Running`, `stopping`→`Stopping`,
  `completed`→`Completed`, `failed`→`Failed`, `killed`→`Killed`,
  `timed_out`→`Timed out`, `lost`→`Lost`.
- **A status group carries exactly ONE marker, and it is `‣` (U+2023) for every
  status — no per-status glyph.** Owner decisions D5 + D7: the written word is
  the signal, the marker is only a secondary anchor, and the marker must be EAW
  neutral. `∙` (U+2219) is *not* used here even though it is also neutral,
  because the transcript already paints it as the assistant bullet and as a
  working frame; `●` (U+25CF) is ambiguous and may paint two cells under
  `cjk-ambiguous-width`, which would shift a right-aligned status group.
  - The marker takes the word's token (`‣ Running`, `‣ Failed`), so the pair is
    one coloured unit.
  - **Do not introduce a status glyph set.** Two different reasons, and the
    first one alone would not be enough:
    - `●` (U+25CF), `○` (U+25CB), `◐` (U+25D0) and `×` (U+00D7) are
      EAW-**ambiguous**: they paint two cells under `cjk-ambiguous-width` and
      would shift a right-aligned status group.
    - `✓` (U+2713), `✕` (U+2715) and `⊘` (U+2298) are width-safe and are still
      rejected: a second glyph vocabulary makes the *shape* — not the written
      word — the thing a reader learns, and it grows without bound (`✓` for
      done, then `✓✓`, then a spinner, then a colour…). The word carries the
      state; the one `‣` marks that a status group is present.
  - **Only a standalone status group carries the marker.** An inline fact
    (`Config ready`, `Loading models…`, `rows 7-40/40`) never does.
  - A status with no word (a glyph-only state) is not allowed in chrome.
- Multiple words in one hint stay lowercase after the key: `Esc back`,
  `Enter details`, `C copy value`.
- **Key tokens are Capitalized; a bare letter is lowercase.** `Esc`, `Enter`,
  `PgUp`, `Shift+S` are capitalized, but an unmodified single letter is written
  `r refresh`, `c copy value`, `s stop` — because `R` reads as ⇧R and this repo
  already spells a shifted chord `Shift+S` (`formatKeyId`). The reference study
  found the same rationale in oh-my-pi's key formatter. This is a small
  user-visible wording change (`R refresh` → `r refresh`) and is part of the
  frozen rule set; every advertised key must still come from the live keymap
  (§7.1).

### 4.2 Breadcrumbs and separators

- **One separator per job** (this is the rule that removes the current
  ` · ` vs ` / ` vs ` | ` mixture):
  - ` · ` joins breadcrumb segments, facts **and action-bar hint segments**:
    `Appearance · Rows`, `job-a · bash`,
    `Retained preview · not full history · rows 7-40/40`,
    `Esc back · Enter details · r refresh`. (D4 — all three reference TUIs use
    ` · ` for exactly this, and it is already the dominant idiom in this repo.)
  - `: ` introduces one labelled fact in a prose line: `Scope: …`,
    `Progress: 3/8 checks`.
  - ` / ` joins alternatives *inside one key token*: a primary key plus its
    leader sequence (`Ctrl+F / Leader S`), or the sanctioned `PgUp/PgDn` pair.
    It never joins fields, and a hint never lists an action's second direct
    binding (§7.1).
  - Two spaces separate a fixed column label from its value within one row
    (`Command  pnpm build`; `Value       Solarized` uses the padded label column
    of the detail pane).
- A breadcrumb names the **trail**: `Categories` → `Appearance · Rows` →
  `Appearance · Configured theme`. The level word appears where the trail has
  no other name.
- The surface identity is joined to the trail with ` · `:
  `Settings · Appearance · Rows`, `Job · job-a · bash`.

### 4.3 Glyph safety (EAW) — hard rule

`test/icons.test.ts` already rejects East-Asian-Width **ambiguous** glyphs, hard
coded as `SAFE_EAW = {'neutral','narrow','halfwidth'}`, because VTE/WezTerm
`cjk-ambiguous-width` paints ambiguous glyphs **two** cells while
`visibleWidth()` measures them as one.

**This contract extends that rule to all chrome glyphs the design language introduces**:
every cursor, separator, bracket, marker or rule glyph is ASCII or EAW
neutral/narrow/halfwidth. Measured classes (`get-east-asian-width`
`eastAsianWidthType`):

| Glyph | Class | Verdict |
|---|---|---|
| `>` `\|` `/` `:` `(` `)` `[` `]` | ASCII/narrow | safe |
| `›` U+203A, `❯` U+276F, `»` U+00BB, `➜` U+279C | neutral | safe; `➜` is reserved to Task Quick's Full navigation action |
| `∙` U+2219, `◦` U+25E6, `▸` U+25B8, `▾` U+25BE | neutral | safe |
| `●` U+25CF, `·` U+00B7, `•` U+2022, `←` U+2190, `↗` U+2197 | **ambiguous** | CJK hazard |
| `─` U+2500, `│` U+2502 | **ambiguous** | CJK hazard |

**Grandfathered, accepted limitation:** several ambiguous glyphs are *already*
used across the chrome, and the `─` rule is drawn on nearly every fullscreen
frame — so a `cjk-ambiguous-width` terminal is already outside the supported
contract for this chrome. This contract therefore does not mass-migrate them, and does not
pretend that swapping one ambiguous separator for an ASCII one fixes the frame.
Measured, still in use and *not* introduced by this contract:

| Glyph | Where it is already painted |
|---|---|
| `─` U+2500 | every rule, the editor's top/bottom border, history's stacked divider |
| ` · ` U+00B7 | the fact/hint separator across the chrome (D4 makes this the only separator) |
| `↗` U+2197 | the Job `↗ Command` affordance |
| `←` U+2190 | the question flow's chrome hints, and the keybindings UI hint `←→: edit` (`keybindings/ui/list.ts:231`) |
| `▼` `▶` U+25BC/25B6 | the hardcoded sub-call / workflow disclosure (the registry's `▸`/`▾` are neutral) |
| `◆` U+25C6 | the footer configurator's move-mode marker |
| `▏` U+258F | the footer configurator's text-edit cursor |
| `●` `○` `◐` `×` | per-status glyphs; the status marker is the shared `‣`, never a per-status glyph set (D5) |

The forward-looking rule is narrower and checkable:

**Do not add a new ambiguous-glyph role, and do not put an ambiguous glyph in a
new place.** That is why D2 rejects a `│` column rule, and why Pi's `→` cursor
(U+2192, ambiguous) is rejected in favour of D3's `>`.

### 4.4 Canonical glyph inventory

| Role | Glyph | Notes |
|---|---|---|
| Navigation cursor | `> ` (2 cells) | one per list; D3 |
| Task Quick Full action | `➜` (U+279C, 1 cell) | muted action-type marker only; not a status or focus marker |
| Active/current label | `[Label]` | focus, active tab, current pane |
| Current-value marker | state chip `[current]` | lowercase chip at the end of the row's content, or inside the row's right-aligned fact slot when it has one (§4.5, §5.1.3); **no arrow** — `←` is EAW-ambiguous and the previous `← current` / `[← current]` forms are retired |
| Status marker | `‣` (U+2023) | the ONE marker for a standalone status group; one cell, EAW neutral; D5+D7 |
| Disclosure | `▸` / `▾` | collapse state only, never "selected" |
| Rule | `─` | boundary only |
| Fact + action-bar separator | ` · ` | D4; the single separator for segments and facts |
| Notice prefix | `ℹ` / `✗` | info / error notice rows; both EAW neutral; D14 |
| Ellipsis | `…` | truncation of *content* only, never inside an action hint |

### 4.5 Bracket classes

Brackets are this family's chip syntax and they already carry six distinct
classes. **A surface must not invent a seventh**, and the classes are told apart
by **case + ink + whether the bracket is the only bold-`primary` one on the
frame** — never by position alone.

| Class | Shape | Case | Ink | Examples |
|---|---|---|---|---|
| Machine marker | `[WORD]` | ALL-CAPS | semantic (`warning` / `error` / `textMuted`) | `[GAP]`, `[ERROR]`, `[SETTLED]` |
| Machine chip | `[WORD]` | ALL-CAPS | the carrying line's ink | `[ACTIVE]`, `[TRACKED]` |
| State chip | `[word]` | lowercase | `textMuted` for a neutral state, the semantic token for a problem state | `[current]`, `[default]`, `[unavailable]` (`warning`), `[read-only]`, `[yolo]`, `[plan]` |
| Key badge | `[K]` | as the key is spelled | the affordance's ink (`primary`) | `Copy All [C]` |
| Grouped badge | `[a · b · c]` | lowercase / sentence | the group's ink | footer `[● 1/3 agents · 2/5 tracked jobs · ↓ view]`, context `[████░░░░░░░░] 16%` |
| Active device | `[Label]` | Title Case | bold `primary` | `[Output]`, `[Rows (2)]`, `[Details]` |

Rules:

- A **state chip** carries exactly ONE boolean state. Several states on one row
  are several chips — `[current] [unavailable]` — never one bracket pair with a
  ` · ` join, because that shape belongs to the grouped badge.
- A **verb label never wears brackets**: an affordance is `Verb [Key]` (key
  badge) or `Verb…` (§7.1). `[Change…]`, `[Retry save]`, `[Confirm]` and
  `[Cancel]` are retired.
- The **active device** is the only bold-`primary` bracket on a frame. A chip
  never introduces bold on its own, and a neutral chip is never `primary`.
- **A state chip is always `textMuted` (`warning` for a problem state) and is
  never recoloured by the row's selection.** A surface whose row model paints the
  whole row as ONE string must therefore compose the chip as its own span — the
  selected row's emphasis applies to the label/value, not to the state chip. On a
  vendored list that offers only a single `value` slot painted `selected ?
  primary : textDim` (`SettingsListTheme.value`), pre-paint the chip at the call
  site with `color.textMuted(...)`: the nested span wins for the chip's own cells.
  Anything AFTER a nested span falls back to the terminal's default ink — **ANSI
  cannot resume a style** — so **every span that must keep an ink of its own is
  pre-painted too** (measured in the real `/model` frame: the selected row's badge
  kept ` · effort ‹high›` in the default colour until that token was painted its own
  role-4 ink). That is the pattern in `src/tui/commands/status.ts:110`, and **the
  vendored fork is never modified for the chip's ink**. The two contracts the slot
  itself cannot express — the whole-unit state layout (fork divergence X061) and
  the row's search basis (fork divergence X062) — are the sole exception, recorded
  as the Owner amendment `D16` in §1.3; nothing else here changes the fork.
- **A chip never introduces bold on its own; it may inherit the carrying row's
  weight.** Ink and weight are separate contracts: the INK is never inherited (a
  chip must not take the row's selection colour, `primary` / `textDim`), while
  the WEIGHT may be, because a terminal cannot unbold a nested span — where a row
  is painted as ONE emphasised run (the Settings candidate row composes
  `cursor + label + chips` and wraps that), the chip is `textMuted` *and* bold on
  the selected row, and that is accepted.
- **A state chip is atomic: it is painted WHOLE or not at all.** It is never cut
  (`[defaul`), and a chip that yields takes its separator with it — a dangling
  ` · ` is the same defect as a half chip. Where the state sits in a fixed-width
  fact slot whose width only the RENDERER knows (the vendored `SettingsList`
  value slot), the row hands the renderer whole parts
  (`SettingItem.valueParts`, fork divergence X061) instead of a pre-joined
  string; the renderer keeps the longest whole prefix that fits, highest
  priority first (`[current]` before `[default]`), and never slices a part. The
  slot also **reserves the widest chip**: the label column yields those cells
  and truncates with `…`, so a long label can never push the state out of the
  row, and no painted row exceeds the width it was given.
- `[current]` is a neutral state chip (`textMuted`); `[unavailable]` is a problem
  state (`warning`). A state chip is not the only signal on the row — the row's
  own value or label is.

## 5. The active device

One device, three uses:

```text
selection in a list         > Appearance            cursor glyph in primary
                            (the row's own text is bold textStrong)
focused pane / active tab   [Rows (2)] / [Output]   brackets + bold primary
current value (candidates)  Solarized  [current]    state chip, textMuted
```

### 5.1 Rules

1. **Focus / active = `[Label]` in bold `primary`.** Unfocused = `Label` in
   `textDim`. This single device replaces both `borderFocus` brackets
   (Settings) and the tone-overridden tab paint (Job). It costs the same cells
   as today's Settings device and makes Settings' pane focus and Job's tab focus
   visually identical.
2. **Selection = a `primary` cursor glyph in a 2-cell gutter + bold
   `textStrong` on the row's text.** The two halves carry different meanings:
   the glyph says *where the keyboard is* (an active/actionable thing, so
   `primary`), the bold text says *which row it is* (emphasis, not a second
   colour). The theme objects already split the two halves
   (`settingsListTheme.cursor = color.primary('›')`,
   `selectListTheme.selectedPrefix = color.primary`,
   `selectListTheme.selectedText = chalk.bold`), so the workspaces converge on
   the existing theme device instead of keeping their own — the Host
   `SearchablePicker` included, which asks that slot for its `> ` cursor.
3. **Selection ≠ current.** The keyboard cursor and the authoritative current
   value are different facts and get different markers. The current value is the
   **state chip `[current]`** (§4.5) in `textMuted` — always that ink, never
   recoloured by the row's selection (D9; the form was settled in review — the
   arrow and the `[← current]` shape are retired because `←`
   U+2190 is EAW-ambiguous and because a chip is what separates a state from the
   row's own label/value).
   **Position follows the row's layout**: a row that already has a right-aligned
   fact slot puts its state chips in that slot (the `/model` badge group), a row
   without one puts them at the end of its content. Several states are several
   chips (`[current] [unavailable]`), never one bracket pair with a join. The
   Job workspace has no list selection.
4. **PiTui-painted overlays** use the same three devices (D9): `> ` + bold
   `textStrong` for selection, `[Label]` + bold `primary` for the active tab/mode,
   and the `[current]` state chip. A PiTui picker must not invent `→`, an arrowed
   or bare-word current mark, or a leading `✓`. **TSP-native overlays** must
   preserve those *meanings*, but may use the native Picker cursor/focus and
   client-rendered rounded `current` / `default` badges without redundant literal
   brackets: see §12.3.
5. **Disabled / read-only / pending / failed** are words, not just inks: the
   detail pane's `Status` field, the read-only note and the `[Retry save]` verb
   already express them; unavailable candidates keep `[unavailable]`.
6. Focus is never carried by colour alone — the brackets are the shape signal,
   and in a single-pane (narrow) layout the breadcrumb names the level instead
   of inventing a second device.

### 5.2 Why the cursor keeps `primary` and the row does not

All three reference TUIs colour the cursor with their accent token and
distinguish cursor / current / selected by *position and glyph*, not by three
colours. This repo's problem was never too little colour; it was that the
workspaces painted the cursor in the same ink as the row it marked, so the
cursor could not be found. Assigning `primary` to the glyph and bold
`textStrong` to the row gives the eye one coloured anchor and one weight
anchor, without inventing a fourth meaning for `primary`.

## 6. Chrome geometry

### 6.1 Surface skeleton

```
<identity> · <context trail>                     <count / status>
<diagnostic line: facts>
────────────────────────────────────────────────────────────────
<optional pane header row>
<body>
────────────────────────────────────────────────────────────────
<optional notice>
<action bar>
```

- Fullscreen workspaces draw **no border box** and no vertical rules.
- Waist rows are granted in this order and dropped in reverse:
  identity → action bar → context trail → body floor → pane header → notice →
  diagnostic line → count/status → rules. (Both existing planners already do
  roughly this; §8 freezes the wording.)

### 6.2 Rules budget

- A rule marks a **boundary between chrome and content**. At most one rule per
  boundary, at most two per frame — with TWO Owner-confirmed exceptions: the
  nested editor-seat tenant (D15, `Ctrl+R` History), which paints a top and
  a bottom boundary rule of its own plus its Results/Preview divider (three
  rules, each on a distinct boundary); and the on-demand Task Quick accessory
  which paints exactly ONE top boundary
  rule (role 15 `border`) as the Footer↔Quick boundary of its combined Root
  position (editor seat → widgets → footer → Quick). That rule belongs to the
  accessory, never applies the D15 History rules, opens no generic third-rule
  allowance for Workspace/Overlay surfaces, and is the FIRST thing dropped
  when the row budget cannot cover every projected task row. The rules may
  compress the Results and Preview regions, but they are removed — bottom
  first, then top — before the Preview is squeezed below one content row.
- **A line whose own text is the content is never flanked by rules.** The Job
  reading-facts row's two flanking rules (`job-inspector-panel.ts:681`) are
  therefore removed (D6); the disclosure becomes a dim status line, and the
  boundary it used to mark is already marked by the tab row's rule above the
  body.
- A rule is the first thing to go when rows are scarce (`ruleRows` is already
  budgeted this way in Settings; the same budget applies to Job).

### 6.3 Columns, gutters and the pane header row

- Multi-column layouts are separated by a **2-cell gutter** (existing
  `COLUMN_GAP = 2`) and nothing else (D2).
- The pane header row is where a column declares itself: `Categories (3)`,
  `Rows (2)`, `Details` in `textDim`, the focused one in the `[Label]` device.
- Column boundaries must not be discoverable only by whitespace *and* the eye
  must not need a glyph: the pane header is on every multi-column frame, and a
  surface with more than two columns that needs stronger separation must come
  back for an Owner amendment rather than inventing a rule style locally.
- One older overlay still draws a `│` split for an independently-scrolled
  master/detail pair (`task-panel.ts:907` at ≥110 columns). This contract does **not**
  extend that device to the workspaces (D2): a new surface must not add a second
  convention. (The retired History `│`
  earlier overlay implementation was removed; `Ctrl+R` History is an embedded
  editor-seat tenant, not an overlay — see §12.)

### 6.4 Insets, alignment and truncation

- No outer inset; content starts at column 0 of its pane (existing behaviour).
- A fixed label column is padded to its width (`Value` column: 12 cells at pane
  width ≥ 26, 8 below — existing `:1003`); wrapped continuation lines align to
  that column.
- A list row is `cursor(2) + label + gap + value`; the **value truncates first,
  the label owns its cells first** (existing `rowLine`).
- **A state chip outranks the label's tail.** The value slot's *content* still
  truncates first (above), but a state chip is chrome, not content: the label
  column yields the cells for at least one whole chip (§4.5, fork divergence
  X061) — and is itself clipped to its column with `…` — so a long label is
  never allowed to cut a chip or push it out of the row. **The label clamp is
  every row's, not only a chip row's**: the column is `min(36, longest label,
  width − chip − 6)` in the `SettingsList`, and a wider label is truncated there
  with a visible `…` instead of painting past its column. The renderer
  guarantees the COLUMN, never a caller's disambiguation: a surface whose
  identity does not fit its column must make the visible part distinguishing
  itself — the name-bearing picker rows keep BOTH ends of an over-wide name
  (`abbreviateName`: head…tail around one `…`), declare the COMPLETE name as the
  row's search basis so the abbreviation can never hide it from the list's own
  search (fork divergence X062), and put the FULL name in the selected row's
  description — a caller that can neither fit a distinguishing part nor
  guarantee a differing description is not covered by this contract.
- Truncation of content uses `…`. **Action hints never truncate mid-word**: a
  segment is dropped whole (§7.2).

## 7. The action bar

### 7.1 Grammar

- A bar is a row of segments joined by ` · ` (D4).
- **Hint segment** = `<Key> <verb>`: `Esc back`, `Enter details`, `r refresh`,
  `c copy value`, `s stop`, `PgUp/PgDn`. Capitalized key token, lowercase verb;
  a bare unmodified letter is lowercase (§4.1).
- **One action advertises ONE key: the PRIMARY binding from the live effective
  keymap** (`keysFor(action)[0]`, or the action's leader sequence when it is bound
  only to one). An **action-bar segment** never enumerates an action's alternative
  bindings — they stay live and are listed in the keybinding UI, so a row never
  spends its cells repeating the same action three ways. `PgUp/PgDn` (one action,
  two symmetric page keys) is the only sanctioned two-key token in a bar hint.
  - **A modal's cancel/close device names its real keys.** The transcript search
    overlay paints `esc/ctrl+c` close because its shared Input swallows `Ctrl+C`, so
    that key has to stay discoverable where the user is typing. Naming the two keys
    that leave a modal is NOT a bar enumerating an action's alternatives (which the
    rule above forbids): a modal hint's whole job is telling the user what leaves
    it. `componentKeymap.keyHint` keeps the list form for these; a generic bar takes
    `keysFor(action)[0]` itself.
    - **Scoped exception — Approval decision bar.** The approval action sheet's
      pinned bar is a direct-action surface, not a generic hint row:
      `[y] Allow once · [n] Reject · [Esc] Cancel`, with `[c] Copy args` /
      `[e] Expand` as secondary segments when the width/grant allows. The bracketed
      key token plus capitalized verb names BOTH the keyboard shortcut and the
      fullscreen clickable action, so the label never lies about either channel.
      `Ctrl+C` remains a live cancel key but is not repeated in that three-decision
      bar; the bar must not be stretched to enumerate every alias. This exception is
      scoped to the blocking Approval seat and does not loosen the grammar for other
      surfaces.
- **State fact** = `<Noun> <state>`: `Follow on`, `Follow paused`,
  `rows 7-40/40`, `Retained preview · not full history`. A fact never begins
  with a key name, so the two segment kinds stay distinguishable on one row.
- Keys come from the **live effective keymap** for every action that is a
  rebindable app action (a bar takes `componentKeymap.keysFor(action)[0]`, the
  primary binding; the Job Stop segment is the existing correct pattern). This is
  the one governance rule all three reference TUIs
  state in their own words — each of them guards it (or its equivalent) in CI
  (§13).
- **A surface-local key that is deliberately NOT rebindable derives both its
  handler and its hint from one local constant.** The Settings workspace's
  `r refresh` and `c copy value` are such keys: they are read by raw character
  comparison today (`settings-workspace-panel.ts:1185-1186`) and there is no
  corresponding `APP_KEYBINDINGS` action. A future implementation must introduce ONE local
  table used by both the handler and the hint — not a new rebindable action
  (that is a keybinding-contract change, not a visual one) and not two copies of
  the letter. If these keys are ever made rebindable, that lands with the
  keybinding contract and the hint then switches to `componentKeymap`.
- An affordance with a key renders `Verb [Key]` (`Copy All [C]`); a
  **direct action with no key renders `Verb`** (`Retry save` — click-only); an
  affordance that opens a further step renders `Verb…` (`Change…`). The current
  whole-word brackets (`[Change…]`) are replaced by this rule, so Settings and
  Job affordances look the same.
- **A key badge spells a bare letter UPPERCASE, while the Action Bar hint keeps
  it lowercase.** `Copy All [C]` / `Copy value [C]` name the *key*; the bar says
  `c copy value` because `C` would read as ⇧C in prose (§4.1). The brackets are
  the discriminator, so the two forms are not a contradiction: one is a key
  badge, the other is a hint.
- Affordances are `primary` (role 14).

### 7.2 Ordering and degradation

Segment order is fixed: the surface's own actions first (the primary action, then
navigation, then secondary verbs, then pure browsing hints), and **`Esc` last**
(D8) — every overlay in the family already puts it last, as do Pi, Kimi and
oh-my-pi, so the two fullscreen workspaces move to match instead of keeping a
second order.

The `Esc` verb **names the real effect of the key on that surface** (D13):
`Esc back` returns to the parent page, `Esc close` leaves the surface, `Esc
cancel` abandons an in-progress action, `Esc output` returns from the Command
page to Output. A surface ordinarily keeps one verb; the verb must never be chosen for
cosmetic uniformity, because a hint that names the wrong destination is a lie.
An explicitly frozen state-dependent Esc ladder is the narrowly scoped exception described below.

**Scoped native exception to D13:** the Owner-frozen TSP `/model` Esc ladder first clears a non-empty search and otherwise closes; its single catalogue hint does not claim a fixed Esc destination. Where a surface does advertise Esc, its wording must describe the *current* outcome. This changes no other overlay's key contract.

The bar acts in this order: **compact a segment that declares a `short` form
first, then drop whole segments by ascending priority**, and only truncate as the
last resort with one segment left. `renderActionBarRow`
(`src/tui/presentation/action-bar.ts`, moved verbatim out of the Job panel) is the
reference implementation; the Settings bar (which today truncates mid-hint —
`Esc back | ↑↓/Pg keys scroll | Enter change…` at 44 columns) adopts it. `Esc`
carries the highest priority in every surface, so moving it to the tail does not
make it droppable.

Safety-relevant facts (`[GAP]`, `[ERROR]`, the retained-not-full disclosure) are
never dropped before a secondary verb or a browsing hint.

### 7.3 Facts on the action bar

The proposal suggested keeping facts out of the action bar. **That is not
implementable at every width**: the Job reading-facts row is granted only at
`width ≥ 100 && rows ≥ 12` and keeping ≥ 6 body rows
(`job-inspector-panel.ts:110-112, 211-215`), so at `80×10` the bar is the only
place the retained disclosure can live (verified: the captured 80×10 frame shows
`Esc back | S stop | Follow ON | Retained preview · not full history`).

This contract therefore allows state facts on the bar under §7.1's shape rule, and requires
that when the dedicated facts row *is* granted, the bar does not repeat it
(the existing `facts.readingFacts` gate).

## 8. Responsive degradation ladder

Frozen order of what yields as space shrinks (both workspaces already follow it;
this is the wording a new surface must match):

1. Vertical rules / extra decoration — never drawn.
2. Full-width rules — dropped below the body floor (`bodyWithoutRules < 5`).
3. Diagnostic line (`Scope:`/`Refreshed`, `Progress:`/`Detail:`) — dropped when
   it would leave fewer than 3 body rows.
   - **A surface's approved row policy may reserve part of ONE chrome row**, and
     facts still drop whole inside that reservation. The Job workspace's metadata
     row keeps its plan guarantee (§2.1): the gap/error facts hold at most HALF the
     row so an unbounded `progress:` can never make an `[ERROR]` unreachable — and
     within that half, whole facts are dropped rather than cut mid-word, with only
     a lone remaining fact truncatable. A reservation is a budget, not an exception
     to the no-half-word rule.
4. Notice row — dropped when it would leave fewer than 2 body rows.
5. Pane/tab header row — dropped with the body floor.
6. Count/status in the header — dropped whole, never truncated
   (`composeEdge` already drops the right region before the left).
7. Individual action-bar segments — dropped whole, lowest priority first.
8. Right-side affordances — a right-aligned affordance is painted only while the
   **whole** left-hand content still fits beside it; otherwise the affordance is
   dropped so the content keeps its cells (a truncated keyed affordance is worse
   than none, and the summary row is itself clickable). This is a fit test, not a
   width-class test: at 60 columns the command and `↗ Command` coexist, at 44 the
   affordance yields.

Invariants that hold at every size:

- The action bar is the physical last row and is never budgeted away. (On the
  nested History editor-seat tenant the D15 bottom boundary rule is the last
  physical row and the action bar is the last CONTENT row, immediately above
  it.)
- A body row is reserved from 3 terminal rows up.
- The breadcrumb (identity + trail) survives; only the right-hand badge yields.
- No "minimum terminal size" gate; a 44-column frame stays fully reachable.
  - **The state guarantee at the floor** (Owner decision): at 44 columns a row that carries state still paints **one WHOLE
    state chip** beside an identifiable label — the label yields its cells and
    truncates with `…` (§4.5's atomic-chip rule, fork X061). §8's "fully
    reachable" sentence alone never promised this; it is stated here so a
    surface cannot trade the chip away for label cells. At wider sizes the pair
    is complete, and the lower-priority chip yields whole rather than being cut.
- Layout math uses terminal cells (`visibleWidth`), never string length, and
  never requires East-Asian ambiguous width to be 1 (§4.3).

## 9. Theme and accessibility

- **No new palette tokens in this contract.** The role table maps onto the existing
  `ColorPalette`. If a genuine gap appears, re-valuing `borderFocus` or adding a
  token requires dark + light + custom fallback + contrast review + live-theme
  switch tests in the same PR.
- Never read the palette at module scope: styles come from `color.*` /
  `taskStatusColor()` / the theme factories at render time, so live theme
  switches (`setTheme`) keep working. `settingsListTheme()` is a function for
  exactly this reason (`runtime.ts:136-144`).
- Every state must be readable in monochrome: colour is a second signal
  (§3.3.3).
- `emoji` / `symbols` / `minimal` is an **icon density** setting, not a layout
  setting. Switching it must not change cursor width, hit targets, or the
  chrome glyphs in the inventory (§4.4) — those are chrome, not icons.
- Custom themes must not be able to break the frame: a palette missing the
  optional search tokens is already filled by `withSearchCurrentTokens`.

## 10. Reuse map

Use these; do not build a parallel owner.

| Need | Existing owner | Rule |
|---|---|---|
| Colours, bold/dim/italic | `src/tui/theme/runtime.ts` (`color`, `hexPaint`) | the only ink source |
| Palette vocabulary, built-ins | `src/domain/display/theme.ts` | no new token in this contract |
| Job status → colour | `taskStatusColor()` (`runtime.ts:116-128`) | extend the *wording* map next to it; do not fork the colour map |
| Picker / settings-list / editor / markdown palettes | `selectListTheme`, `settingsListTheme()`, `editorTheme`, `markdownTheme` | restyle through these, never by re-painting their components. `SearchablePicker` reads its cursor through the same slot |
| Semantic structural icons | `src/tui/icons.ts` (`iconFor`, `iconPrefix`, `iconLead`) + `src/domain/display/icons.ts` | chrome punctuation (cursor/brackets/rule) is **not** an icon and does not enter the registry |
| Overlay shells | `src/tui/components/frame.ts` (`Frame`, `FocusForwardingFrame`, `ResponsiveOverlayFrame`) | overlays keep the rounded frame; fullscreen workspaces never use it |
| Single physical row safety | `src/tui/presentation/lines.ts` (`sanitizedPhysicalLine`, `escapedPhysicalLine`) | every chrome string passes through it |
| Per-frame row budget | `planSettingsChrome` / `planChrome` in the owning panel | keep; do not share |
| Real-frame tests | `test/settings-workspace-visual.test.ts`, `test/job-workspace-visual.test.ts`, `test/virtual-terminal.ts` | extend; never add a second screenshot framework |

**Explicitly not to be built:** a CSS-in-TS layer, a token store, a
`SurfaceManager`/`WorkspaceRenderer`/layout DSL, a second focus manager, a modal
manager, a generic multi-layer component tree, a whole-repo regex gate for
chrome (see §11.3).

**The only extraction this contract authorizes** is the action-bar row layout: the Job
`ActionBarSegment` + `renderActionBarRow` pair already implements §7.2 and the
Settings bar needs exactly it. Extracting it to
`src/tui/presentation/action-bar.ts` (pure, stateless, no palette capture) is
justified by two real consumers. Do not extract anything else until a second
real consumer exists.

## 11. Anti-degradation governance

### 11.1 One canonical spec

- This file is the single source of truth for visual vocabulary.
- `AGENTS.md` links here from its TUI section (one line, "read before adding or
  restyling a surface"); `docs/README.md` lists it in the map.
- [surface-behavior.md](./surface-behavior.md), [transcript.md](./transcript.md)
  and [overlay-focus.md](./overlay-focus.md) keep owning *business/interaction*
  decisions. They must not restate this vocabulary, and this file must not
  restate their contracts. On conflict: stop and ask the Owner.
- New vocabulary (a new glyph role, a new status ink, a new device) requires a
  change to this file **in the same PR** that introduces it. New *usage* of
  existing vocabulary does not.

### 11.2 The PR visual checklist

Copy into every PR that changes a visible surface:

```text
[ ] Which archetype(s) from docs/architecture/design-language.md does this surface map to?
[ ] Role → token: does every painted string use its §3.2 token (no borrowed ink)?
[ ] Exactly one active signal per region (one [Label]/`> item` in primary)?
[ ] Can the reviewer distinguish selected / current / focused / disabled /
    pending / failed from the frame alone?
[ ] Header = where I am, body = what I see, status line = current facts,
    action bar = what I can do — no responsibility moved?
[ ] Do the advertised keys come from the live effective keymap, ONE per
    action (the primary binding)?
[ ] Action bar: whole-segment drops only; no partial word; safety facts kept?
[ ] New glyphs: ASCII or EAW neutral/narrow/halfwidth (§4.3)?
[ ] Wide / medium / narrow / short / CJK: full interaction still reachable
    (frozen matrix: 200×50, 120×40, 100×40, 80×24, 80×10, 72×24, 44×20)?
[ ] Dark / light / custom, and icons symbols / minimal checked?
[ ] No new shadow authority, focus owner, fork divergence, or duplicate layout
    framework? No new palette token?
[ ] before/after frames from the real VirtualTerminal included, plus a real
    terminal check per docs/guides/tmux-testing.md. Unrun items are marked NOT_RUN.
```

Visual beauty is an Owner/Reviewer judgement. "All tests pass" never closes a
visual item, and an unrun screenshot must never be reported as PASS.

**Renderer-qualified evidence:** the VirtualTerminal / tmux path above applies to PiTui-painted ANSI surfaces. When a PR instead changes a **TSP-native** surface, use the pinned SDK's scripted wire/production-path tests **and** an actual versioned Tern headless pane for the client's painted node/ancestor-clipping/PNG/action behavior. Declare `NOT_APPLICABLE` rather than `PASS` for PiTui-specific frame assertions; record physical GUI/IME/wheel/dark/custom fonts as `NOT_VERIFIED` unless actually exercised. Follow [`tsp/foundation.md`](../tsp/foundation.md) §6, [`guides/tern-pane-testing.md`](../guides/tern-pane-testing.md) and the owning TSP product contract. Owner visual acceptance is independent of CI and headless measurements.

### 11.3 Machine checks

Enforce only what is cheap and low-false-positive; the rest is review.

1. **Chrome glyph width gate** (`test/design-language.test.ts`): the canonical
   chrome glyph inventory (§4.4) must be 1 cell under `visibleWidth()` *and* EAW
   neutral/narrow/halfwidth, one glyph must not carry two meanings, and the
   rejected per-status glyphs are pinned as data. This makes §4.3
   regression-proof. It is a **static inventory check**: it never substitutes for
   the real-frame evidence §11.2 asks for, and it says nothing about a painted
   surface.
2. **Frame invariants in the two existing visual suites** (add, don't duplicate):
   - at most one bracketed active label per painted frame;
   - the action bar is the last physical row at every size in the matrix;
   - the body floor is ≥ 1 from 3 rows up;
   - no action-bar row contains `…` while more than one segment is painted;
   - a `Status` value of `Verified` and of `Not saved` do not paint the same
     token;
   - a status group paints the shared `‣` marker only — no second, per-status
     glyph (item 1's glyph inventory already rejects the ambiguous per-status
     sets by width class; assert it as a frame fact too).
3. **Degradation-ladder test**: for each size in the frozen matrix, assert the
   dropped/kept set matches §8 (this is the test that catches "someone made the
   header taller").
4. **Atomic state chip** (`packages/pi-tui/test/settings-list.test.ts` for the
   renderer contract, `test/preset-command.test.ts` + `test/surface-row-grant.test.ts`
   for the real frames): a chip is never painted partially (`[defaul`), a dropped
   chip never leaves its separator, an over-wide label is clipped with `…` instead
   of overflowing, and the chip survives every width from the 44-column floor up.

Items 1–3 are enforced by `test/design-language.test.ts` (item 1), the four frame
invariants in `test/support/design-language-frames.ts` — called from BOTH visual
suites — and the per-surface ladder matrix each of those suites walks over the
frozen sizes above (items 2–3). The `Verified`/`Not saved` ink check lives in the
Settings suite's `B-02`/`B-03`. This list is the contract; that helper is only
where it happens to be enforced.

4. **Snapshot policy**: snapshot only stable, spec-level frames; normalize
   timestamps, job ids and durations. Do not add a whole-frame ASCII snapshot
   that fails on every cosmetic change.
5. **No whole-repo regex gate.** A repo-wide search for `>`/`|` would flag
   transcript, Markdown and tool output that legitimately contain them. Any
   automated check is scoped to the canonical glyph inventory and to chrome
   consumers with real visual tests.

## 12. Surface archetypes

A new surface picks one and must justify any deviation.

| Archetype | Skeleton | Examples |
|---|---|---|
| **Workspace** (fullscreen) | §6.1, own row budget, pinned action bar | Settings, Job |
| **Overlay** (modal, non-fullscreen) | `Frame` box, single body, bottom hint | pickers |
| **Blocking editor-seat sheet** | `Frame` box in the editor seat (replaces the draft, never disposes it), pinned title/danger + one scrollable request body + pinned decision bar; Fullscreen paints real pointer cells, Regular is keyboard-only | Approval |
| **Pane** (embedded in the transcript/log) | header line + folded body, no action bar | tool cards, subagent cards, Thinking |
| **Status bar** | one row of items + separators, no interaction (a host-instruction line may be reserved above it — `footer/instruction.ts`) | footer |
| **Accessory band** (pinned, on-demand) | zero rows hidden; when active: ONE top separator rule (the §6.2 exception) + identity row + ≤3 single-line navigation rows (tasks, then the optional Full action), painted UNDER the whole footer as the frame's last region | Task Quick |

**Approval reading floor (PiTui).** The blocking editor-seat Approval sheet is a
decision surface, not a tool card: on terminals with at least 24 rows it keeps a
readable minimum frame — 12 physical rows at 24 terminal rows, rising to 16
from 40 rows up — always clamped by the live seat grant. The extra height is
inert display padding before the pinned decision bar, never scrollable request
content or a pointer target; below 24 rows the existing truthful short-screen
degradation applies. On the shortest viewports the compact body puts the actual
payload (`Command`, `Before`/`After`, `New content`, `Inserted text`, and the
generic/raw `Arguments` fallback) ahead of the Action/Target/Reason labels, so
even a one-content-row grant shows what will run or change. The body projects known tool arguments into `Action` /
`Target` / `Before` / `After` / `Command` / `New content` sections and keeps
every unknown field under `Other arguments`; an edit proposal is qualified as
`Intended input · not verified against disk` (it is the request's intended
input, not a disk-verified diff).

Shared minimum spec for **PiTui-painted** Workspace and Overlay: identity, one body, one bottom
bar, `Esc` last, whole-segment hint drops (never mid-word), role table respected. The
accessory band is its own archetype (not a Workspace/Overlay): it owns no hint bar, no
frame, and its separator is the §6.2 exception above.

Task Quick's optional Full navigation target follows all real task rows in the same
three-row window and exists only when its first-party Full callback is injected. It is
not a `TaskPanelItem`, task count, status or Footer fact. Paint `➜ Open Task Center…`
with `➜` immediately after the existing `> ` selection marker; keep `➜` muted,
the unselected label muted and the selected label `textStrong`. The arrow is the action
kind only; `>` remains the sole focus/selection signal. Use terminal-cell truncation and
keep the navigation target as one physical row.

A **TSP-native** read-only Reader may legitimately have its own visible Back row and no
action bar; its UI still needs a reachable, truthful navigation gesture (§12.3).

`Ctrl+R` History is deliberately NOT an Overlay: it is a component
projected into the shared editor seat (an embedded editor-seat tenant) and
aligned it to this vocabulary (role table, `> ` + bold `textStrong` selection,
`[Label]` active scope, ` · ` action-bar segments, whole-segment drops). Under
Owner decision D15 it also declares its own boundary with the surrounding chrome:
one `─` as its first row and one as its last row (below the action bar). It
creates no `Frame`, no new screen and no overlay node, and its pointer support
exists only inside Transcript Fullscreen.

### 12.2 Overlay specifics (D9, D10)

A **PiTui-painted** overlay is the same vocabulary in a rounded `Frame` instead of a full terminal. **TSP-native overlay/picker sheets are client-rendered and do not require our `Frame`**; translate semantic roles via §12.3:

| Item | Rule |
|---|---|
| Title | role 1 (bold `textStrong`) as the **first row inside the frame**; a title is never inset into the frame's top rule (`╭─ Title ─╮` is not our device — it would fight the `Frame` geometry contract). A context suffix (`Subagent allowed models`) is role 2. |
| Count / status | role 12, **right-aligned on the title row** (`Models` … `3/8`), exactly as a workspace header aligns its badge. Not a title suffix. |
| Selection | `> ` in `primary` + the row's text in bold `textStrong` (§5). |
| Current value | the state chip `[current]` in `textMuted` (§4.5), placed at the end of the row's content — or inside the row's right-aligned fact slot when it has one (`/model`'s badge group, the vendored `SettingsList` value slot). **Never recoloured by selection** — pre-paint it at the call site when the row paints itself as one string. No arrow, no bare word, no leading `✓` gutter. Two states are two chips (`[current] [unavailable]`), not one joined pair. **Painted whole or not at all**: in a slot whose width only the renderer knows, hand it whole parts (`valueParts`, X061) — it reserves one chip and drops the rest whole, and the label is what truncates. |
| Group header | role 5: the group label in `textDim`, its count in `textMuted`, joined by ` · ` (`Directory · 12`). Never bold. |
| Second-level text | an indented description line (2 cells after the cursor gutter) in `textDim`, wrapped at the list width; a right-aligned value column is the workspace form of the same roles (D14.4). |
| Disabled / unavailable row | `textDim` plus a reason word (`unavailable`, `read-only`); never colour-only (§3.3.3), and the cursor still moves onto it (no dead rows). |
| Placeholder / loading / failure | role 16: `textDim`; a failed one names the failure and paints that word `error` (`Model catalog unavailable: …`); loading is a word (`Loading models…`), never animation. |
| Bottom row | inside the frame; `Esc` is its **last** segment (D8) and the hint line uses ` · ` (D4). |
| Sizing ladder | The step is declared by **content type**: short menu `64`; default interactive list `72`; long values, badges or a detail column `88`; **full** for a surface that must present a whole document or decision (a long-command approval, a full-screen list). Resolution, in this order: **(1)** `full` is not a numeric step — `effective = columns` (a surface that needs its own margin, e.g. the full-screen task browser, declares that margin as a per-surface exception); **(2)** otherwise `effective = min(declared, columns)`, then snap **down** to the largest ladder step `≤ effective`; **(3)** if `effective < 64` there is no ladder step to snap to — the overlay takes **exactly `columns`** and degrades through its own row budget / `ROW_PRIORITY` / degenerate-grant rules instead of through frame size (there is no minimum terminal width for an overlay). The step is never raised because the terminal is wide. Height is `min(rows − 2, cap)` with the cap owned by the step (`24` narrow/standard, `28` wide, the terminal for full). A per-surface exception is allowed only when that surface's own doc names it with its reason — the PiTui `/model` sizing exception is `72×28`; the TSP-native `/model` instead lets each native sheet declare its own client size (catalogue `size:'md'`, Reader overlay `size:'lg'`), chosen from that surface's own measured pane geometry (see §12.3) |
| Assembly | mandatory chrome (title, search row, hint) is granted first, then the item window, then optional separators/scroll/status — the existing `overlay-focus-contract.md` budget rules stay authoritative. |

### 12.3 Native TSP surface adapter (product semantics, not PiTui geometry)

This is a **renderer-specific application of** D1–D14, not a new layout framework or an independent palette/theme authority. The final painter is Tern, not `Frame`, `VirtualTerminal`, `visibleWidth()` or our terminal-cell row budget. **Do not** wrap a native Picker in a lookalike PiTui Frame or add a duplicate status/preview strip to satisfy a character UI convention.

| Common semantic obligation | Native TSP expression / qualification |
|---|---|
| One selected / current / focused signal per region | Let the native Picker render its highlighted row, region `focus`, chip `on` and the client's pill badges. Selection, current configuration, local draft and keyboard ownership are separate facts. Do not add a second `>` glyph, a literal `[current]` inside an already self-contained native pill, or a misleading action focus arrow. |
| Identity and action affordances | Use a concise title; make the actual write verb explicit (`Switch`/`Save default`). Where a native action bar has no visible focused-button state, an app-provided `Verb [Enter]` cue is permitted **only when Enter really invokes it**. A Reader with its own Back row need not paint a redundant action bar. |
| Status / unavailable / disabled | Preserve text-visible reasons and semantic notice tones, not colour-only flags. Map semantic roles to the client's supported native badges/tones; do not invent ANSI palette assignments inside a native sheet. |
| Responsive hierarchy | Decide the high-frequency task path before assigning `size`, `preview`, `strip` and secondary pages. `preview: 'side'` or `'below'` is a hint and may disappear on normal split panes. Do not make essential controls visible only in Preview. Use the client-rendered sheet's actual geometry; the PiTui 64/72/88/full cell ladder does **not** prescribe TSP `size`. |
| One source of truth | Component-level draft/page/zone is presentation state, not a business writer. A real write goes through the existing command/Host owner. Native `select` (browse), `activate` (inspect) and `action` (explicit operation) must be individually mapped and tested rather than assumed equivalent. |
| Node continuity and stale events | Stable client IDs preserve viewport/scroll state **when measured**, but stale admission remains mandatory. Frame revision belongs on operations that must be refused from old frames; a Reader's scroll body should have a reading-lifetime identity. This is **not** an instruction to stabilize all IDs globally. |
| Keyboard and pointer agreement | App-side key router and native event router must converge on the same intent and admission. A pointer row click must reclaim the appropriate logical keyboard zone; disabled/read-only rows cannot accidentally write. `Esc` may have a documented product-specific search-clear/close ladder. |
| Accessibility and evidence | Review the real client tree, ancestor clipping and screenshots at the supported pane widths; use one real click/key path for material behaviors. Keep version/build, font and observation tier. A headless screenshot is **not** proof of physical window focus, IME, wheel, dark theme or enlarged-font behavior. |

**Current model example, not a universal template.** The `/model` surface uses a single `ui.picker` with `size:'md'`, `preview:'none'`, one Reasoning Effort `strip` and an explicit write footer; row activation opens a read-only native Reader. Another TSP surface may justify a different native composition, sheet size or number of pages through its own Owner-frozen product contract and evidence. See [`model-selection.md`](../tsp/model-selection.md).

## 13. Reference alignment and deliberate divergences

The reference study (Pi `earendil-works/pi` / `badlogic/pi-mono`, oh-my-pi
`can1357/oh-my-pi` @ main `818dd42b73`, kimi-code `MoonshotAI/kimi-code`) was
read as *evidence of what a mainstream TUI does*, never as a specification to
copy. Pi and kimi-code were fetched from GitHub (their local checkouts are not
present on this machine), so those quotes carry file+symbol rather than
line numbers.

### 13.1 Followed (consensus, and it also matches this repo)

| Rule | Where the references agree | Where this repo already does it |
|---|---|---|
| A navigation cursor is a **glyph in a gutter**, not a colour | pi `select-list.ts` `"→ "`; oh-my-pi `select-list.ts:592` `cursor + ' '`; kimi `SELECT_POINTER = '❯'` | `src/tui/panels/settings-workspace-panel.ts:766,774,887` (`'> '`), `settingsListTheme.cursor` |
| **Selection ≠ current** | pi `model-selector.ts` second `✓ ` gutter; kimi DESIGN §1 "当前项与选中项互相独立" | the candidate list's row-end mark (`:888`); this document keeps the device and replaces the arrow with the width-safe word |
| ` · ` joins metadata/hint segments | oh-my-pi `theme/symbols.ts:456` `"sep.dot": " · "`; kimi DESIGN §4; pi `settings-list.ts` hint line | both workspace meta/fact rows, `task-panel.ts:1275-1287` |
| **Key token Capitalized, verb lowercase** | pi `keyDisplayText`; oh-my-pi `key-hint-format.ts`; kimi DESIGN §4 | `Esc back`, `Enter details` (bare letters must change, §4.1) |
| Hints and keys come from the **keymap**, never a raw literal | pi AGENTS.md; kimi `printable-key-guard.test.ts` (CI-enforced); oh-my-pi `formatKeyHint` | `componentKeymap.keyHint('tasks.stop')` in Job; Settings still compares `'r'`/`'c'` |
| Every row is width-clamped through the shared helpers | pi/oh-my-pi/kimi docs | `fit()` / `truncateToWidth` / `visibleWidth`; `test/icons.test.ts` |
| A **small, counted** decoration budget | kimi DESIGN §3 "整个 dialog 全宽 `─` 仅 2 条（顶 + 底）", checklist-enforced; pi's de-facto 2 `DynamicBorder`s | `planSettingsChrome` grants 0 or 2 rules |
| Text contrast floor ≥ 4.5:1 | pi `docs/themes.md`; kimi AGENTS.md (+3:1 chrome) | palette comments ("tuned for ≥ 4.5:1 contrast on black") |
| `borderFocus` is approval-only | kimi `theme/colors.ts` "Focus / attention border — currently only the approval panel" | identical comment on our `ColorPalette.borderFocus` |

### 13.2 Deliberate divergences

| Decision | What the references do | What this contract does, and why |
|---|---|---|
| Surface identity ink | kimi paints the dialog title `primary` + bold; oh-my-pi insets it in the top rule in `accent` | `textStrong` bold, no colour. This repo already uses `primary` for links *and* inline code *and* selection (`markdownTheme.code`, picker prefixes), so a blue title would make "blue" mean brand + clickable + current at once. Keeping the identity weight-only keeps `primary` = active/actionable |
| Selected row's text | pi/oh-my-pi paint it with their accent token | bold `textStrong`; only the cursor glyph is `primary`. Same reason as above, and it matches this repo's existing picker device |
| Hint overflow | kimi truncates the whole line; pi truncates + one documented whole-segment drop; oh-my-pi's native path wraps and its ANSI footer clips in a height-1 row | **whole-segment drop by priority, never mid-word** (already implemented in Job). At a pinned height 1, wrapping is impossible and line truncation is what produces today's `Esc back · ↑↓/Pg keys scroll · Enter change…` |
| Status word case + marker | pi sentence case; oh-my-pi Title Case with `●`/`✓`/`✕`/`⊘` glyphs; kimi lowercase with a row-end `← current` | Title Case word plus one EAW-neutral `‣` anchor (D5 + D7). `●`/`○`/`◐`/`×` are rejected as width-unsafe, and the width-safe `✓`/`✕`/`⊘` are rejected because a per-status glyph vocabulary makes the shape the signal |
| Cursor glyph shape | pi `→`, oh-my-pi `❯`/`>`, kimi `❯` (and kimi forbids inventing `>`/`→` for its own dialogs) | `>` for this repo (D3): `→` is EAW-ambiguous, `❯` already owns the transcript's user marker, `›` already owns two icon semantics |
| "Never colour alone" | **no reference states this rule** (one paints a disabled row by colour only) | adopted anyway (§3.3.3) because our palette proves colour is unreliable here: `borderFocus` and `warning` are the same hex |
| Rules on a status line | kimi forbids an inner rule; oh-my-pi freely adds `├──┤` dividers | at most one rule per boundary and never flanking a text line (D6) |

### 13.3 What is realistically machine-checkable

The study checked what each project actually gates. kimi is the strongest
(named-chalk-colour scan, bare-printable-key scan, per-dialog exact-line
assertions); oh-my-pi has no snapshot gate but pins exact row strings, column
indices and theme glyph tokens; Pi gates formatting/lint only. **None of the
three has a TUI screenshot gate, and none gates a decoration budget or a
"colour alone" rule.**

That is why §11.3 restricts this repo's automated checks to the glyph width
gate, a handful of frame invariants in the two existing `VirtualTerminal`
suites, and the degradation-ladder matrix — and leaves the rest to the review
checklist.

### 13.4 Transcript right gutter and measurement

Every transcript block renders two cells short of the terminal's right edge.
`TRANSCRIPT_RIGHT_GUTTER = 2` lives in the source (not in this document); the
surface computes `transcriptContentWidth(width) = max(1, floor(width) - 2)`, so
a 1–3 cell terminal still yields one cell. The gutter is a transcript-surface
property only: editor, footer, welcome, overlays and pickers keep full width.

Measurement == render width is an invariant: `rebuildMessages` /
`refreshMessageRows` / `attachmentRangesOf` measure each component at exactly
the width the frame pass feeds it (`transcriptRenderWidth()`). A drift shifts
the fullscreen hit map, attachment spans and Focus disclosure by a line. The
gutter is applied by reducing the width passed to the child, never by appending
spaces; the wrapper is non-owning (the component caches own child lifecycle) and
does not forward `dispose()` — a cached `ImageThumbnail` must keep its loader.
Components keep their inner math without subtracting the gutter again.

Folded rows (Thinking compact, tool/system/compaction previews, local shell
previews) truncate at the content width at BUILD time so baked lines never wrap.
The max-token marker is exactly one row and is charged to the hit height (+1).
Width-cache identity is scoped: only width-BAKING host builds record
`builtWidth` and rebuild on resize; render-time width-aware builds (markdown,
bubbles, Thinking compact, plugin views) stay cached. Narrow-screen tests assert
`visibleWidth(row) <= transcriptContentWidth(terminalWidth)` — never
`terminalWidth - 2`, never a hardcoded truncated locator; fullscreen consecutive
clicks must use different cells.

Authority: `src/tui/components/transcript-leaves.ts`,
`src/tui-app.ts` (`transcriptRenderWidth`, `MessageComponentEntry.builtWidth`,
`syncSurfaceGeometry`). Proof: `test/rendering.test.ts`,
`test/image-collapse.test.ts`.

### 13.5 Selected-row marquee

Only the selected row's main label scrolls (initial pause → one cell per 250 ms
→ tail pause → loop). Connectors, markers, suffixes, status and elapsed values
stay fixed. The window slices by visible CELLS (CJK/emoji/ZWJ never split); one
unref'd timer per panel is armed only while an overflowing selected row exists
and is disposed on close. The session picker splits a fixed prefix from the
marqueeable title via `truncatePrimary`.

Authority: `src/tui/components/marquee.ts` (`SelectedMarquee`, `marqueeStateAt`,
`MARQUEE_STEP_MS`). Must-not: scroll the whole row, run a timer while nothing
overflows, or add a fork divergence for the picker seam. Proof:
`test/marquee.test.ts`, `test/task-panel.test.ts`.

### 13.6 Visual assertion updates

When a visual change breaks existing assertions, update them only to the NEW
literal — never to a looser matcher — and never drop a fixture to make the suite
pass. `NOT_RUN` is never reported as PASS. Visual quality remains an
Owner/Reviewer judgement; "all tests pass" cannot close a visual item.
