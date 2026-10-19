# TUI design language — rollout plan (v1)

> Companion to `docs/tui-design-language.md` (the spec) and
> `docs/tui-design-language-samples.md` (the before/after frames).
>
> **Status: FROZEN v1 (Owner-confirmed 2026-10-14, see the spec's §1.3).** PR0 is
> complete (this document set); PR1 may start. The plan is written for a coding
> agent that has not read the investigation: every PR states its scope, its
> explicit non-goals, the exact tests to run, the evidence it must attach, and
> how to roll it back.

## 0. Ground rules for every PR in this rollout

1. **Vocabulary only.** No PR here may change an input ladder, an authority, a
   write path, a hit map, an observer lease, a row-budget *grant order*, or a
   `PaneBox`/`VisiblePaneLayout` geometry. If a change seems to need one, stop
   and ask.
2. **No fork change.** `packages/pi-tui/**` stays untouched; nothing in this
   rollout justifies a divergence — the only exception is `D16` in
   `docs/tui-design-language.md` §1.3 (X061/X062, Owner amendment 2026-10-14),
   and it authorizes nothing else.
3. **No new theme owner or token.** Ink comes from `color.*` /
   `taskStatusColor()` / the existing theme factories, read at render time.
4. **Targeted evidence first.** `pnpm build` (the fork `dist` is a test input),
   then only the suites the diff can affect — never a full pipeline per commit.
   Use `node scripts/run-with-temp-root.mjs node --test <file…>` for a single
   suite. Run the full `pnpm verify:prepush` once per PR, on a frozen tree, at
   the end.
5. **Every visual PR attaches frame evidence**: plain `VirtualTerminal` frames
   before/after at the sizes it touches, plus one real-terminal check per
   `docs/tmux-testing.md`. An unrun size is reported `NOT_RUN`, never PASS.
6. **Snapshot discipline**: assert spec-level facts (row order, one active
   device, whole-segment drops, token identity), not whole-frame ASCII.

## 1. PR0 — Design gate (documents only)

**Goal:** the spec, the samples and this plan exist, are linked from the doc map,
and are the reviewable basis for the Owner's `D1`–`D6` confirmation.

**Deliverables**

| File | Content |
|---|---|
| `docs/tui-design-language.md` | the frozen-once-confirmed spec: role table, case, separators, glyph safety, active device, chrome geometry, action bar, degradation ladder, reuse map, governance, reference alignment |
| `docs/tui-design-language-samples.md` | real BEFORE frames + target AFTER frames for Settings and Job, the measured ink inventory, the responsive table, the re-verification recipe |
| `docs/tui-design-language-rollout.md` | this plan |
| `docs/README.md` | a map row pointing at the first two |
| `AGENTS.md` | one line in the TUI area: read the design language before adding or restyling a surface |

**Non-goals:** no product code, no test change, no `AGENTS.md` reorganisation
beyond the one line.

**Acceptance:** documents reviewed; the Owner has accepted, amended, or rejected
each of `D1`–`D6`; the spec's §1.3 is updated to the frozen state (or the
alternative chosen).

**Rollback:** revert the docs commit; nothing else depends on it.

## 2. PR1 — V1 shared action-bar row (the only extraction)

**Goal:** make the *one* proven-shared presentation helper reusable, with **zero
behaviour change**, so V2/V3 do not each hand-roll a segment-dropping bar.

**Scope**

- New: `src/tui/presentation/action-bar.ts` — the `ActionBarSegment` shape
  (`text`, `priority`, optional `short`) and the row layout currently inlined as
  `renderActionBarRow` in `src/tui/panels/job-inspector-panel.ts:688-715`. Pure
  and stateless: it takes segments + width and returns one painted-agnostic
  string; it must not read the palette, capture module state, or import a panel.
- `src/tui/panels/job-inspector-panel.ts`: delete the local copy, import the
  shared one. No string, priority or order changes.
- `test/icons.test.ts` (or a new small `test/design-language.test.ts` if that
  file's scope gets muddy): extend the existing width-gate pattern with the
  canonical chrome glyph inventory from the spec §4.4 — every entry must be
  `visibleWidth() === 1` **and** an EAW class in
  `{neutral, narrow, halfwidth}`. This is the spec's §4.3 rule made checkable.

**Non-goals:** do not migrate Settings in this PR, do not rename any literal, do
not touch `planChrome` or the segment priorities, do not add a generic
"chrome" module.

**Tests:** `node scripts/run-with-temp-root.mjs node --test test/job-workspace-visual.test.ts test/job-inspector-workspace.test.ts test/job-output-interaction.test.ts`
must be green **unchanged** (that is the no-behaviour-change proof), plus the new
glyph gate. `pnpm typecheck:bundle`.

**Evidence:** the git diff must show no literal or priority change; state
explicitly that the Job frames are byte-identical.

**Rollback:** revert; the helper has one consumer at this point.

## 3. PR2 — V2 Settings workspace facelift

**Goal:** apply the spec to `settings-workspace-panel.ts` without moving a single
row grant, hit target or write path.

**Scope (all in `src/tui/panels/settings-workspace-panel.ts` unless noted)**

1. Header (role 1/2): `SETTINGS` → `Settings` in bold `textStrong`; breadcrumb
   separators all ` · `; trail in `textDim`; badge in `textMuted`.
2. Diagnostic line (role 11/12): `Scope: … · Refreshed HH:MM · Config <word>`,
   with the readiness word Title Case and painted `textMuted`/`warning`/`error`
   by readiness; **trailing facts drop whole** before any truncation.
3. Pane titles (role 5/7): `Categories (3)`, `Rows (2)`, `Details`; focused =
   `[Label]` in bold `primary` (replacing `borderFocus`); unfocused `textDim`.
4. List rows (role 6/8): cursor `> ` in `primary`, selected row text bold
   `textStrong`, unselected `text`, summary column `textDim` (values only).
5. Detail pane (role 3/4/5/9): labels `textDim`; primary value `text`; secondary
   values `textDim`; the `Status` field's status **word** takes
   `success`/`error`/`warning`/`textDim` with the reason left `textDim`.
6. Buttons (role 14): `Change…`, `Retry save`, `Copy value [C]`,
   `[Confirm]`/`[Cancel]` → `Confirm`/`Cancel` — all `primary`; keep
   `layoutButtons`' whole-button drop.
7. Action bar: route through the PR1 helper with the spec §7.2 order — the
   surface's own actions first and **`Esc` as the last segment** (D8), while
   `Esc` keeps the highest drop priority (7), then the primary action 6,
   navigation 5, secondary verbs 4…; bare key letters lowercase.
8. **Flip the shared separator to ` · `** in
   `src/tui/presentation/action-bar.ts` (`ACTION_BAR_SEPARATOR`). The helper is
   shared, so this PR also changes the Job bars — that is intended and is part
   of this PR's acceptance (run the Job visual suites). Do **not** add a
   per-caller separator option.
9. **The two Settings-local keys stay non-rebindable, with one source of truth.**
   Introduce a single local table used by BOTH the handler and the hint for
   `r refresh` / `c copy value` (today `data === 'r'` is compared at
   `settings-workspace-panel.ts:1185-1186` and the hint repeats the letters).
   Do not add new `APP_KEYBINDINGS` actions, and do not switch these hints to
   `componentKeymap` — making them rebindable is a keybinding-contract change,
   not a visual one (spec §7.1).
10. **The candidate list's current mark becomes the `[current]` state chip**: the
    `'← current'` mark at `settings-workspace-panel.ts:888` loses the arrow and
    the outer bracket pair, and a row with two states paints two chips
    (`[current] [unavailable]`) instead of `[← current · unavailable]` — spec
    §4.5/§5.1.3. The chip is **always `textMuted` and is never recoloured by the
    row's selection**, so the candidate row can no longer be painted as ONE
    coloured string: the chip is composed as its own span while the label/value
    take the row emphasis. Also retire the bracketed verb labels in the same PR
    (`[Change…]` → `Change…`, `[Retry save]` → `Retry save`, `[Confirm]` →
    `Confirm`, `[Cancel]` → `Cancel`, `[Copy value]` → `Copy value [C]`).
11. **Update the one prose reference in `docs/extension-api.md:301`** from the
    `← current` marker to the `[current]` state chip, in this same PR (the owning
    doc must not go stale). No public type changes: `currentValue` stays an
    opaque display string.

**Non-goals:** `planSettingsChrome` row grants and the `ruleRows`/`metaRows`
conditions; `layoutForWidth` breakpoints (`108`/`76`) and the `22/42/2` geometry;
`PaneBox`/`PaneLayout` math; the write/confirm/verify path; the choice-list
semantics; the legacy `open-legacy` entry.

**Tests:** `test/settings-workspace-visual.test.ts` (the main blast radius — 52
assertions mention `SETTINGS`), `test/legacy-settings-migration.test.ts`,
`test/surface-lifecycle-closure.test.ts`, plus the PR1 glyph gate. **The Job
visual suites also run in this PR** (`job-workspace-visual`,
`job-inspector-workspace`, `job-output-interaction`) because the separator
constant is shared with the Job bar. Then `pnpm typecheck`.

**Evidence:** before/after frames at `120×40` (L0 + L2), `80×10`, `44×20`, dark +
light, `symbols` + `minimal`; one real-terminal check.

**Rollback:** visual-only; a per-site revert of the literals/inks. No state or
contract depends on them.

**Reviewer must check:** the row grants are untouched (diff `planSettingsChrome`
and `render` line by line), only one `[Label]` per frame is painted with
`primary`, and the narrow frame no longer truncates a hint mid-word.

## 4. PR3 — V3 Job workspace facelift

**Goal:** apply the spec to `job-inspector-panel.ts` with no change to the
observation, admission, follow/find/copy or tab hit-map behaviour.

**Scope (all in `src/tui/panels/job-inspector-panel.ts` unless noted)**

1. Header (role 1/2): `JOB  job-a · bash` → `Job · job-a · bash` (identity
   `textStrong`, trail `textDim`).
2. Status (role 9, decisions `D5` + `D7`): Title Case word from a display map
   (`running`→`Running` … `timed_out`→`Timed out`, raw status as fallback),
   painted by `taskStatusColor`, with the `●` glyph **replaced by the one shared
   `‣` marker** — `● RUNNING` becomes `‣ Running`, `● FAILED` becomes `‣ Failed`.
   Do not simply delete the marker, and do not map a different glyph per status.
   Bracketed machine markers `[GAP]`/`[ERROR]`/`[SETTLED]` keep their case and
   priority order.
3. Metadata (role 11): `Progress: … · Detail: …`, `Error: …`; whole trailing
   facts drop before truncation.
4. Summary row: keep `Command  <label>` / `Full command`; make the right-side
   affordance yield when content + affordance cannot both fit (spec §8, step 8;
   the 44-column frame now shows the whole command).
5. Tabs: unchanged device (`[Label]` bold `primary`).
6. Reading-facts row (decision `D6`): remove the two flanking rules; the row
   becomes a dim status line — note left (`textDim`), position right
   (`textMuted`). Do not repeat a fact already stated above it (the Command page
   drops the duplicated `Full command`).
7. Action bar: PR1 helper + spec priorities; facts Title Case
   (`Follow on`, `Follow paused`); bare key letters lowercase (`s stop`,
   `Tab switch`); **`Esc` moves to the last segment** (D8) while keeping the top
   drop priority; safety facts (gap/error/retained disclosure) outrank secondary
   verbs and the page hint. The ` · ` separator already landed in PR2 (the
   constant is shared) — do not touch it here. **Owner amendment:** the page
   toggle is `Tab` (both directions, advertised on both pages) and the former
   Job-local `v` open verb is removed.

**Non-goals:** `planChrome` grants and their thresholds (`COMPACT_*`,
`FACTS_MIN_*`, `METADATA_MIN_BODY_ROWS`); the body floor; the tab hit map
(`painted`/clip arithmetic); the scroll view configuration; follow/End
re-arming; find layering; copy sinks; the stop admission path; the observer
lease.

**Tests:** `test/job-workspace-visual.test.ts`, `test/job-inspector-workspace.test.ts`,
`test/job-output-interaction.test.ts`, `test/job-command-reader.test.ts`,
`test/tasks-browser.test.ts`, `test/runner-viewer-task-integration.test.ts`,
`test/runner-remote-job-viewer.test.ts`, + the PR1 glyph gate. Then
`pnpm typecheck`.

**Evidence:** before/after frames at `120×40` (Output running, Output
failed+gap, Command), `80×10`, `60×20`, `44×20`, dark + light; one real-terminal
check.

**Rollback:** visual-only, per-site.

**Reviewer must check:** the disclosure still cannot disappear while the
position can; `[GAP]`'s warning ink and `[ERROR]`'s error ink are unchanged; the
Command page still advertises only what it can do (no Stop/Follow).

## 5. PR4 — V4 governance enablement (no surface change)

**Goal:** make the spec self-enforcing for *future* work, without a mass
migration.

**Scope**

- `docs/code-review.md`: add the visual checklist (spec §11.2) as an item for
  any PR whose diff touches a rendering path, with the note that visual quality
  is an Owner/Reviewer judgement and `NOT_RUN` is not PASS.
- Add the frame invariants to the two existing visual suites (spec §11.3.2) and
  the degradation-ladder matrix test (§11.3.3): one `[Label]` active device per
  frame, pinned bar last, body floor ≥ 1 from 3 rows, no `…` inside a
  multi-segment bar, and the dropped/kept set per size.
- `docs/README.md` / `AGENTS.md`: keep the single pointer; do **not** duplicate
  the vocabulary there.

**Non-goals:** no sibling-surface restyle in this PR (see PR5), no whole-repo
regex gate, no snapshot framework.

**Tests:** the two visual suites + the new matrix test; `pnpm test:docs` if the
doc-map lint cares about the new rows.

## 6. PR5 — V5 opportunistic sibling rollout (optional, split freely)

Each sibling is its own small PR, taken **only when that surface is being
touched for another reason**, and each must not invent a device:

| Target | What to align (§12.2 applies to all of them) | Do not touch |
|---|---|---|
| `SearchablePicker` | cursor `→ ` → `>` in `primary`; hint lines to `Key verb` case with `Esc` last; count moved from the title suffix to the right-aligned role 12; group headers to role 5; failure placeholder word to `error`; the `current`/`default` facts become `[current] [default]` state chips inside the existing badge slot; the theme's prefix instead of the hardcoded string | the picker's row budget/`ROW_PRIORITY`, the search field, the caps |
| history panel | **done in B3-B** (it is an embedded editor-seat tenant, not an overlay): Title Case identity, role-table inks, `> ` + bold `textStrong` selection, `[Label]` active scope, bracket-less `Copy All [Alt+C]` / `Use Selected [Enter]`, and a History-local whole-segment action bar; the old `│` split was already retired by B3-A | its geometry, the 0.63/0.80 grant, the list/Preview breakpoints, the storage/query contract |
| Task Center full panel | **B4-B:** status groups now use the shared `‣` + Title Case word with the semantic status token; the action bar keeps `Esc` last, lowercase bare `s`, and a keymap-derived `Shift+Tab` hint. Remaining `→` cursor and `│` split stay separate debt | its tree, marquee, and Stop semantics |
| Task Quick accessory | **B4-B supersedes B4-A position/rule:** on-demand below the whole Footer, with at most one Quick-owned top separator at the Footer boundary; retains role 1 bold `textStrong` identity, role 12 right-aligned `showing x-y/N`, role 3/4 content/context inks, one `‣` + a Title Case status word in its semantic token, no brackets or action bar, and depth indentation only. It remains a first-party embedded accessory, not a Workspace/Overlay; no bottom rule or full frame (§4.3/§6.2) | no second Footer/boundary or extra Frame; retain existing Task Runtime authority |
| output viewer / approval dialog | title ink, hint grammar and case; keep the approval bracketed-key device (spec §11.4) | the approval decision semantics and the 1-row stop hint |
| footer configurator / keybindings UI | `accent` → the role table for interactive inks; help-line verb case | the user-selectable tone vocabulary (`accent` stays available there) |
| all overlays | the four-step sizing ladder once that overlay is touched for another reason (D10) | each surface's existing height cap until then |

**SettingsList-family requirement (the `[current]` chip's ink).** Three sites
route a row state through the vendored `SettingsList`: `pickers/theme-menu.ts:119`
(its `currentValue` slot), `pickers/preset-presentation-pitui.ts:50` (today a word
inside the `description`) and the `/settings` submenu. The vendored list paints
`SettingsListTheme.value` as `selected ? primary : textDim`, so **swapping the
string alone yields the wrong ink in both states**. Requirements:

1. pre-paint the chip with `color.textMuted(...)` at the call site — the
   `src/tui/commands/status.ts:110` precedent, where the nested style wins and the
   slot's outer paint resumes after it;
2. **do not** change `settingsListTheme().value` and **do not** touch
   `packages/pi-tui/**`: no fork divergence and no new theme abstraction — the
   two divergences this PR needs, X061 (the whole-unit state slot and label
   column) and X062 (the `searchText ?? label` predicate), are the `D16` Owner
   amendment in `docs/tui-design-language.md` §1.3, and nothing else in the fork
   may change;
3. move the preset picker's chip out of the `description` into its `currentValue`
   slot, so both pickers use one position;
4. assert the painted cell colour in the real overlay frame: the chip's foreground
   is `textMuted` on BOTH the selected and the unselected row — not `primary`,
   not `textDim`.

**Gate for the whole rollout (V4 done):** all fourteen decisions frozen; PR1–PR4
merged; the visual checklist in `docs/code-review.md`; the matrix test and glyph
gate green; the samples doc's "AFTER" section replaced by real frames that the
Owner accepted in a real terminal for Settings and Job, wide + narrow, dark +
light.

## 7. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| A row grant or geometry drifts while restyling | medium | PR2/PR3 list the frozen constants as non-goals; the reviewer diffs the chrome plans; the matrix test pins the dropped/kept set |
| Existing assertions on `SETTINGS`/`JOB`/`RUNNING`/`[GAP]` break loudly | high (expected) | enumerate the tests in each PR; update assertions only to the new literal, never to a looser matcher |
| Lowercase bare key letters (`R refresh` → `r refresh`) confuse long-time users | low | it is a wording change; note it in the changelog |
| Dropping the `↗ Command` affordance at narrow widths removes a mouse-discoverable entry | low | the summary row is itself clickable (D-03) and `Tab switch` stays advertised |
| Painting detail values with `text` changes how a custom/light palette looks | medium (intended) | check light + one custom palette in the evidence; it is the fix, not a regression |
| `borderFocus` looks "lost" once ordinary focus stops using it | low | it keeps its approval role; the palette is unchanged |
| The new glyph gate fails on an existing chrome literal | low | the gate covers only the canonical inventory in the spec §4.4; the grandfathered `─`/` · ` are listed as accepted |
| Scope creep into a "chrome framework" | medium | PR1 extracts exactly one helper; the spec's §10 names what must not be built |
