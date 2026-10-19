# TUI design language — before/after samples (v1)

> **Status: FROZEN v1 (Owner-confirmed 2026-10-14, after reviewing these frames
> in a real terminal).** `D1`–`D4` and `D6` were accepted as recommended; `D5`
> was amended by the Owner to a Title Case word plus ONE shared status marker,
> and the marker glyph is `‣` (U+2023): EAW-neutral, one cell, and not already
> owned by the transcript (`∙` is the assistant bullet and a working frame).
> See the spec §4.1.
>
> **The BEFORE frames are real product output.** They were painted by the real
> `TuiApp` + `VirtualTerminal` composition at commit `7ccaa20a` and read back
> from the terminal cells (§1).
>
> **An AFTER frame is real product output at the PR that landed its panel**,
> captured exactly like the BEFORE side. A surface whose PR has not landed yet
> still shows a hand-laid design target painted with the real theme tokens; each
> frame block says which it is, and the label is derived from whether the capture
> really exists.
>
> This document is VirtualTerminal evidence, not the human one: the real-
> terminal passes, and what each of them did and did not cover, are recorded in
> §8.

## 1. Method (how the BEFORE frames were produced)

The two existing visual suites (`test/settings-workspace-visual.test.ts`,
`test/job-workspace-visual.test.ts`) already drive the real composition. The
before-frames were produced with a temporary copy of each suite plus a dump
test that:

1. builds the same harness at a given `(columns, rows)`;
2. drives the real `/settings` command, or the real `/tasks` → Enter Job
   selection;
3. writes `vt.getViewport()` (one string per painted row) to a file;
4. writes a per-cell ink map by reading `vt.getCellFgRgb(row, col)` for every
   cell and folding it into `[token]text` runs.

Two traps this recorded, both relevant to any future visual evidence:

- **`vt.getViewport()` carries no SGR.** The viewport strings are already
  stripped, so a colour claim can only come from the cell read-back
  (`getCellFgRgb` / `getCellBgRgb`), never from the string.
- **The reverse token map is ambiguous by construction.** `textMuted` and
  `diffGutter` are both `#6B6B6B`, `textDim`/`diffMeta` are both `#888888`,
  `success`/`diffAdded` are both `#4EC87E`, `error`/`diffRemoved` are both
  `#E85454`, and `warning`/`borderFocus` are both `#E8A838`. A measured hex
  therefore only identifies a *value*, and the token was confirmed by reading
  the source line that paints it. The `warning`/`borderFocus` collision is the
  substantive one: it is why an ordinary pane focus currently reads as amber.

The temporary dump files are not part of this PR; §9 records the recipe so the
after-frames can be regenerated the same way.

## 2. Sample matrix

| Surface | Size | State shown |
|---|---|---|
| Settings | `120×40` | wide three-pane, L0 categories focused |
| Settings | `120×40` | wide three-pane, L2 detail focused (commit status visible) |
| Settings | `80×10` | short screen, minimum chrome |
| Settings | `44×20` | narrow single pane, L2 detail |
| Plugin Manager | `120×40` | B03 Auto Review danger confirmation, Cancel default |
| Plugin Manager | `80×10` | B03 confirmation: consequence wraps, pinned choices, scroll hint |
| Plugin Manager | `44×20` | B03 confirmation: consequence and choices fit |
| Job | `120×40` | Output page, running |
| Job | `120×40` | Output page, failed + gap + settled |
| Job | `120×40` | Command page |
| Job | `80×10` | short screen: facts row gone, facts in the bar |
| Job | `60×20` | narrow: compact tabs, metadata gone |
| Job | `44×20` | narrow: affordance yields to the command text |
| Picker overlay (`/model`) | `120×40` | opened: title + right-aligned count, group header, `[current]` chip, hint line |
| Picker overlay (`/model`) | `120×40` | a failed catalog: the failure word in `error`, its detail muted |
| Picker overlay (`/model`) | `80×24` | short overlay: the count still fits right-aligned, chip and hint intact |

`⋮` marks a run of elided blank rows. Frame widths are exact terminal cells;
the target frames are shown without trailing padding noise.

## 3. Settings

### 3.1 Wide 120×40 — L0 (categories focused)

**BEFORE — real output**

```text
SETTINGS · Categories                                                                                    2 editable rows
Scope: TUI settings document  ·  Refreshed 23:57 / Config READY
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
[CATEGORIES (3)]        SETTINGS (2)                                DETAILS
> Appearance            > Configured theme               Solarized  Configured theme
  Display                 Icon style                       symbols  Value       Solarized
  Other settings                                                    Source      plugin:acme/solarized
                                                                    Runtime     dark
                                                                    Scope       TUI settings document
                                                                    Freshness   Ready · on-open snapshot
                                                                    Description The palette family used by the
                                                                                transcript, editor and panels. The value
                                                                                is the source-qualified configured
                                                                                identity; the summary is its display
                                                                                name.
⋮
                                                                    [Change…]  [Copy value]
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Esc close | ↑↓ select | Enter open
```
**AFTER — real output at this HEAD**

```text
Settings · Categories                                                                                    2 editable rows
Scope: TUI settings document · Refreshed 09:35 · Config Ready
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
[Categories (3)]        Rows (2)                                    Details
> Appearance            > Configured theme               Solarized  Configured theme
  Display                 Icon style                       symbols  Value       Solarized
  Other settings                                                    Source      plugin:acme/solarized
                                                                    Runtime     dark
                                                                    Scope       TUI settings document
                                                                    Freshness   Ready · on-open snapshot
                                                                    Description The palette family used by the
                                                                                transcript, editor and panels. The value
                                                                                is the source-qualified configured
                                                                                identity; the summary is its display
                                                                                name.
⋮
                                                                    Change…  Copy value [C]
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
↑↓ select · Enter open · Esc close
```
What changes on this frame: the surface word becomes `Settings` in bold `textStrong` instead of all-caps `SETTINGS` in `primary`; the pane titles become Title Case and the rows pane stops calling itself `SETTINGS`; the focused pane is marked with the same `[Label]` + bold `primary` device the Job tabs use; the cursor is now `primary` while the selected row stays bold `textStrong`; the detail values are painted with real tokens; the action bar uses ` · ` and lowercase bare key letters.


### 3.2 Wide 120×40 — L2 (detail focused)

**BEFORE — real output**

```text
SETTINGS · Appearance / Configured theme                                                                 2 editable rows
Scope: TUI settings document  ·  Refreshed 23:57 / Config READY
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
CATEGORIES (3)          SETTINGS (2)                                [DETAILS]
> Appearance            > Configured theme               Solarized  Configured theme
  Display                 Icon style                       symbols  Value       Solarized
  Other settings                                                    Source      plugin:acme/solarized
                                                                    Runtime     dark
                                                                    Scope       TUI settings document
                                                                    Freshness   Ready · on-open snapshot
                                                                    Description The palette family used by the
                                                                                transcript, editor and panels. The value
                                                                                is the source-qualified configured
                                                                                identity; the summary is its display
                                                                                name.
⋮
                                                                    [Change…]  [Copy value]
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Esc back | ↑↓/Pg keys scroll | Enter change | R refresh | C copy value
```
**AFTER — real output at this HEAD**

```text
Settings · Appearance · Configured theme                                                                 2 editable rows
Scope: TUI settings document · Refreshed 09:35 · Config Ready
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Categories (3)          Rows (2)                                    [Details]
> Appearance            > Configured theme               Solarized  Configured theme
  Display                 Icon style                       symbols  Value       Solarized
  Other settings                                                    Source      plugin:acme/solarized
                                                                    Runtime     dark
                                                                    Scope       TUI settings document
                                                                    Freshness   Ready · on-open snapshot
                                                                    Description The palette family used by the
                                                                                transcript, editor and panels. The value
                                                                                is the source-qualified configured
                                                                                identity; the summary is its display
                                                                                name.
⋮
                                                                    Change…  Copy value [C]
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Enter change · ↑↓ scroll · r refresh · c copy value · PgUp/PgDn · Esc back
```
The commit `Status` row is the important one: today `Verified · …` and `Not saved · …` paint the same terminal-default ink, so a successful write and a refused write look identical. The target keeps the sentences and gives the status word its semantic token (`success` / `error` / `warning`), with the explanation left `textDim`.


### 3.3 Short 80×10 — L0

**BEFORE — real output**

```text
SETTINGS · Categories                                            2 editable rows
Scope: TUI settings document  ·  Refreshed 23:57 / Config READY
────────────────────────────────────────────────────────────────────────────────
[CATEGORIES (3)]        SETTINGS (2)
> Appearance            > Configured theme                             Solarized
  Display                 Icon style                                     symbols
  Other settings

────────────────────────────────────────────────────────────────────────────────
Esc close | ↑↓ select | Enter open
```
**AFTER — real output at this HEAD**

```text
Settings · Categories                                            2 editable rows
Scope: TUI settings document · Refreshed 09:35 · Config Ready
────────────────────────────────────────────────────────────────────────────────
[Categories (3)]        Rows (2)
> Appearance            > Configured theme                             Solarized
  Display                 Icon style                                     symbols
  Other settings

────────────────────────────────────────────────────────────────────────────────
↑↓ select · Enter open · Esc close
```
At 10 rows the chrome keeps header + diagnostic line + one pane-header row + the pinned bar, and the two rules survive because the body still clears the budget. This frame is the reason the diagnostic line must drop **whole trailing facts** rather than truncate: the left detail shortening is what forces that rule.


### 3.4 Narrow 44×20 — L2 (detail)

**BEFORE — real output**

```text
SETTINGS · Appearance / Configured theme
Scope: TUI settings document  ·  Refreshed …
────────────────────────────────────────────
Value       Solarized
Source      plugin:acme/solarized
Runtime     dark
Scope       TUI settings document
Freshness   Ready · on-open snapshot
Description The palette family used by the
            transcript, editor and panels.
            The value is the
            source-qualified configured
            identity; the summary is its
            display name.
⋮
[Change…]  [Copy value]
────────────────────────────────────────────
Esc back | ↑↓/Pg keys scroll | Enter change…
```
**AFTER — real output at this HEAD**

```text
Settings · Appearance · Configured theme
Scope: TUI settings document
────────────────────────────────────────────
Value       Solarized
Source      plugin:acme/solarized
Runtime     dark
Scope       TUI settings document
Freshness   Ready · on-open snapshot
Description The palette family used by the
            transcript, editor and panels.
            The value is the
            source-qualified configured
            identity; the summary is its
            display name.
⋮
Change…  Copy value [C]
────────────────────────────────────────────
Enter change · ↑↓ scroll · Esc back
```
The BEFORE bar ends `Enter change…` — a hint cut mid-word, because the Settings bar truncates its single string while the Job bar drops whole segments. The AFTER bar drops the lowest-priority segments instead (`c copy value`, then `r refresh`) and every painted segment stays a complete `Key verb` pair.


### 3.5 Wide 120×40 — L2 with a REFUSED write

**BEFORE — real output (a refused theme write)**

```text
SETTINGS · Appearance / Configured theme                                                                 2 editable rows
Scope: TUI settings document  ·  Refreshed 00:37 / Config READY
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
CATEGORIES (3)          SETTINGS (2)                                [DETAILS]
> Appearance            > Configured theme                    dark  Configured theme
  Display                 Icon style                       symbols  Value       dark
  Other settings                                                    Runtime     light
                                                                    Status      Not saved · settings namespace "tui-app"
                                                                                changed since it was read
                                                                    Scope       TUI settings document
                                                                    Freshness   Ready · on-open snapshot
                                                                    Description The palette family used by the
                                                                                transcript, editor and panels. The value
                                                                                is the source-qualified configured
                                                                                identity; the summary is its display
                                                                                name.
⋮
                                                                    [Change…]  [Retry save]  [Copy value]
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Esc back | ↑↓/Pg keys scroll | Enter change | R refresh | C copy value
```

**AFTER — real output at this HEAD**

```text
Settings · Appearance · Configured theme                                                                 2 editable rows
Scope: TUI settings document · Refreshed 09:35 · Config Ready
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Categories (3)          Rows (2)                                    [Details]
> Appearance            > Configured theme                    dark  Configured theme
  Display                 Icon style                       symbols  Value       dark
  Other settings                                                    Runtime     light
                                                                    Status      Not saved · settings namespace "tui-app"
                                                                                changed since it was read
                                                                    Scope       TUI settings document
                                                                    Freshness   Ready · on-open snapshot
                                                                    Description The palette family used by the
                                                                                transcript, editor and panels. The value
                                                                                is the source-qualified configured
                                                                                identity; the summary is its display
                                                                                name.
⋮
                                                                    Change…  Retry save  Copy value [C]
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Enter change · ↑↓ scroll · r refresh · c copy value · PgUp/PgDn · Esc back
```

This pair exists because it is the strongest single argument for the target ink table: in the BEFORE frame `Status  Not saved · settings namespace …` is painted in exactly the same terminal-default ink as `Value` and `Runtime` above it, so the one row that says the write was refused looks like every other fact. The target paints only the status **word** (`Not saved` in `error`, `Verified` in `success`, `Outcome unknown` in `warning`, `Saving…` in `textDim`) and leaves the reason `textDim`. Nothing else on this frame changes except the vocabulary the earlier pairs already listed.

### 3.6 The `[current]` state chip (candidate list)

A focused excerpt of the candidate rows (the choice page is otherwise unchanged apart from the retired verb brackets and the bar). The chip is one lowercase state chip per predicate: always `textMuted`, never recoloured by the row's selection — a surface that paints its row as one string must therefore keep the chip as its own span (a vendored `SettingsListTheme.value` slot paints `selected ? primary : textDim`, so the chip is pre-painted at the call site; the fork is never touched).

**BEFORE — real output (candidate rows, real colours)**

```text
  auto
  dark
  light
> Solarized  [← current]
```

**AFTER — target**

```text
  auto
  dark
  light
> Solarized  [current]
```

The arrow is gone because `←` (U+2190) is EAW-ambiguous (§4.3), and the chip stays because it is what separates a *state* from the row's own label/value (a candidate value can itself be a word, so `Solarized  current` would read as part of the value). Two states on one row are two chips (`[current] [unavailable]`), never one joined bracket pair — that shape belongs to the grouped badge class (§4.5).

### 3.7 Settings change list

| # | Before | After | Why |
|---|---|---|---|
| 1 | `SETTINGS` in `primary` | `Settings` in bold `textStrong` | `primary` must mean exactly one thing: active/actionable. It already paints links, inline code and picker cursors |
| 2 | Trails joined with ` · ` and `/`; `Refreshed 09:41 / Config READY` | one ` · ` join; `Config Ready` | one separator per job; no ALL-CAPS words |
| 3 | Pane titles `CATEGORIES (3)` / `SETTINGS (2)` / `DETAILS` | `Categories (3)` / `Rows (2)` / `Details` | the rows pane must not reuse the surface word; Title Case |
| 4 | Focus = `[Label]` in `borderFocus` (= `warning` amber) | Focus = `[Label]` in bold `primary` | ordinary focus must not read as a warning; the Job tab already uses this device |
| 5 | Cursor and row both `textStrong` | cursor `primary`, row bold `textStrong` | the cursor must be findable. The theme objects already split colour-on-glyph from bold-on-text (`settingsListTheme.cursor`, `selectListTheme.selectedText`); `SearchablePicker` still hardcodes a bold `→ ` |
| 6 | Detail values unstyled (terminal default) | primary value `text`, secondary values `textDim` | an unpainted value ignores the palette and invisibly breaks light/custom themes |
| 7 | Commit `Status` values all the same ink | status word gets `success`/`error`/`warning`, explanation `textDim` | verified and refused writes must not look identical |
| 8 | Buttons `[Change…]  [Copy value]` in `accent` | `Change…  Copy value [C]` in `primary` | one affordance ink and one grammar (`Verb [Key]` keyed, `Verb` click-only, `Verb…` opens a further step) family-wide |
| 9 | Bar truncated mid-hint (`Enter change…`) | whole-segment drop by priority | a half-word is a lie about what the key does |
| 10 | Bar ` \| ` separator; `R refresh`, `C copy value` | ` · `; `r refresh`, `c copy value` | cross-reference consensus (` · `) and no bare uppercase letters that read as ⇧ |
| 11 | Diagnostic line truncated (`Refreshed …`) | trailing facts drop whole | never cut a fact in half |
| 11 | Bar started with `Esc close` / `Esc back` | `Esc close` / `Esc back` moves to the TAIL | D8: the family puts `Esc` last everywhere — every overlay already does, and the two workspaces follow |
| — | Pane geometry `22 / 42 / 2`, breakpoints `108`/`76`, row-budget order, every write/confirm/status semantic | unchanged | this PR is vocabulary only |

### 3.8 Plugins category — the UI-only Rows navigation affordance (S4-D2 / D2-0)

**AFTER — real output at this HEAD** (captured through the production `/settings`
command, a `VirtualTerminal` and the real Settings workspace projection; the
capture is the `getViewport()` text with trailing padding trimmed). The L0
`Plugins` category keeps its one-step direct entry and, in the multi-column
projection, paints ONE UI-only affordance in the Rows pane: no `SettingsWorkspaceRowId`,
value, freshness or editable field exists for it, and a click opens the SAME page
as `Enter`/`Right` in the same Alt-Screen lease.

`120×40` (wide: Categories | Rows | Details; the Rows header counts the one
painted affordance, not Host settings rows):

```text
Settings · Categories                                                                                    2 editable rows
Scope: TUI preferences · Refreshed 15:11 · Config Ready
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
[Categories (4)]        Rows (1)                                    Details
  Appearance              Open Plugin Manager  Enter / Right        This category is a direct page entry. Press Enter o…
  Display
> Plugins
  Other settings






























────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Up/Down select · Right open · Enter open · Esc close
```

`80×24` (medium L0: Categories | Rows):

```text
Settings · Categories                                            2 editable rows
Scope: TUI preferences · Refreshed 15:11 · Config Ready
────────────────────────────────────────────────────────────────────────────────
[Categories (4)]        Rows (1)
  Appearance              Open Plugin Manager  Enter / Right
  Display
> Plugins
  Other settings














────────────────────────────────────────────────────────────────────────────────
Up/Down select · Right open · Enter open · Esc close
```

`80×10` (short screen: the entry stays visible above the pinned bar):

```text
Settings · Categories                                            2 editable rows
Scope: TUI preferences · Refreshed 15:11 · Config Ready
────────────────────────────────────────────────────────────────────────────────
[Categories (4)]        Rows (1)
  Appearance              Open Plugin Manager  Enter / Right
  Display
> Plugins
  Other settings
────────────────────────────────────────────────────────────────────────────────
Up/Down select · Right open · Enter open · Esc close
```

`44×20` (narrow: one column, no Rows pane and no second-column affordance; the
direct `Enter` entry is unchanged):

```text
Settings · Categories
Scope: TUI preferences · Refreshed 15:11
────────────────────────────────────────────
  Appearance
  Display
> Plugins
  Other settings











────────────────────────────────────────────
Right open · Enter open · Esc close
```

What changes on these frames (relative to the S4-D1 Settings frames above): the
Plugins Rows pane is no longer painted as an empty `Rows (0)` list; the single
affordance is indented like a real row (`textStrong` action name, `textMuted`
`Enter / Right` hint) but paints no `> ` cursor and is never the primary active
device. Below the body floor (`120×2`) neither the affordance nor any stale hit
target is painted, so only `Esc` remains available.

**Real-terminal record (2026-10-19, D2-0 candidate).** tmux 3.5a,
`TERM=tmux-256color`, the default auto-detected dark theme, terminal default
monospace font, no physical GUI (therefore no `GUI_PASS`). The TUI was launched
from an isolated `DSH_HOME` profile that links THIS worktree
(`@deepseek-ai/dsh-base` + `@xmoon76/dsh-pi-tui`; no user sessions, credentials
or real profile were used). At `120×40` `/settings` painted the frame shown
above; a real SGR left press+release at the painted row opened the SAME real
Plugin Manager page as `Enter` (the page reported the live Host catalog:
`22 plugins · 3 enabled`), `Esc` returned to `Settings · Categories` with
`> Plugins` selected, and `Enter` opened the same page again. Live resizes to
`80×24` and `44×20` matched the captured frames (the narrow projection painted
no Rows pane). The `80×10` short screen was also run from this real terminal and
painted the same cells as the `80×10` frame above:

```text
Settings · Categories                                            2 editable rows
Scope: TUI preferences · Refreshed 16:19 · Config Ready
────────────────────────────────────────────────────────────────────────────────
[Categories (4)]        Rows (1)
  Appearance              Open Plugin Manager  Enter / Right
  Display
> Plugins
  Other settings
────────────────────────────────────────────────────────────────────────────────
Up/Down select · Right open · Enter open · Esc close
```

Light/custom themes were not exercised in this tmux pass and stay `NOT_RUN`;
their headless cell/colour evidence is above.


### 3.9 B03 Auto Review — the shared dangerous confirmation (S4-D2 / D2-2)

**AFTER — real output at this HEAD.** The same confirmation view is reached
from the exact Auto Review bundle and from its addressable row; it is not a
second overlay. The consequence text is fixed, Cancel is the default and no
Host write happens before the explicit primary choice.

`120×40` (real tmux, dark theme):

```text
Plugins · Auto Review                                                                             22 plugins · 4 enabled
Auto Review safety confirmation — no Host change happens before the explicit choice
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Disable Auto Review?
Disabling Auto Review can change existing Auto sessions to Full access. Auto Review is not a sandbox. Continue?
The official Host teardown moves existing Auto sessions to Full access; Auto Review is not a sandbox.






























  Disable Auto Review
> Cancel
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Enter confirm · Esc cancel
```

`80×10` (real tmux: the complete consequence wraps above the pinned choices;
`PgUp/PgDn details` scrolls only the explanation):

```text
Plugins · Auto Review                                               4/22 enabled
Auto Review safety confirmation — no Host change happens before the explicit ch…
────────────────────────────────────────────────────────────────────────────────
Disable Auto Review?
Disabling Auto Review can change existing Auto sessions to Full access. Auto
Review is not a sandbox. Continue?
  Disable Auto Review
> Cancel
────────────────────────────────────────────────────────────────────────────────
Enter confirm · PgUp/PgDn details · Esc cancel
```

`44×20` (real tmux: the whole consequence and both choices fit):

```text
Plugins · Auto Review           4/22 enabled
Auto Review safety confirmation — no Host c…
────────────────────────────────────────────
Disable Auto Review?
Disabling Auto Review can change existing
Auto sessions to Full access. Auto Review is
not a sandbox. Continue?
The official Host teardown moves existing
Auto sessions to Full access; Auto Review is
not a sandbox.






  Disable Auto Review
> Cancel
────────────────────────────────────────────
Enter confirm · Esc cancel
```

**Real-terminal record (2026-10-19, D2-2 candidate).** tmux 3.5a,
`TERM=tmux-256color`, default auto-detected dark theme, terminal default
monospace font, no physical GUI (no `GUI_PASS`). The TUI was launched from an
isolated `DSH_HOME` profile that links this worktree and has the published
`@deepseek-ai/dsh-experimental-auto-review@0.2.1-rc.2` profile package selected.
At `120×40` `/plugins` → search `auto-review` → Details painted the real Host
card (`Enabled Yes`, `Risk` warning) and `Disable…` opened the confirmation
shown above; `Enter` on the default Cancel returned to Details with
`Enabled Yes` (zero Host write). The same flow was captured at `80×10` and
`44×20`; at `80×10` the pinned bar advertised `PgUp/PgDn details` and
`Esc cancel` and the complete warning was readable. Light/custom themes were
not run (`NOT_RUN`).


## 4. Job

### 4.1 Wide 120×40 — Output, running

**BEFORE — real output**

```text
JOB  job-a · bash                                                                                              ● RUNNING
progress: 3/8 checks · detail: Building components
Command  pnpm build && pnpm test:product                                                                       ↗ Command
[Output]  Command ──────────────────────────────────────────────────────────────────────────────────────────────────────
line 007
line 008
line 009
line 010
line 011
line 012
line 013
line 014
line 015
line 016
line 017
line 018
line 019
line 020
line 021
line 022
line 023
line 024
line 025
line 026
line 027
line 028
line 029
line 030
line 031
line 032
line 033
line 034
line 035
line 036
line 037
line 038
line 039
line 040
────────────────────────────────── Retained preview · not full history · rows 7-40/40 ──────────────────────────────────
Esc back | S / Shift+S stop | Follow ON | Find Ctrl+F / Ctrl+Shift+F / | C copy output | V command | PgUp/PgDn
```
**AFTER — real output at this HEAD**

```text
Job · job-a · bash                                                                                             ‣ Running
Progress: 3/8 checks · Detail: Building components
Command  pnpm build && pnpm test:product                                                                       ↗ Command
[Output]  Command ──────────────────────────────────────────────────────────────────────────────────────────────────────
line 007
line 008
line 009
line 010
line 011
line 012
line 013
line 014
line 015
line 016
line 017
line 018
line 019
line 020
line 021
line 022
line 023
line 024
line 025
line 026
line 027
line 028
line 029
line 030
line 031
line 032
line 033
line 034
line 035
line 036
line 037
line 038
line 039
line 040
Retained preview · not full history                                                                         rows 7-40/40
s stop · Follow on · Ctrl+F find · c copy output · Tab switch · PgUp/PgDn · Esc back
```
The tab strip is deliberately unchanged: `[Output]` in bold `primary` is the device the Settings pane focus now adopts. What changes: the header identity, the status word, the meta labels, and the facts row (whose two flanking rules are removed — the disclosure becomes a dim status line with the position right-aligned).


### 4.2 Wide 120×40 — Output, failed + gap + settled

**BEFORE — real output**

```text
JOB  job-a · bash                                                                               ● FAILED [GAP] [SETTLED]
Earlier output evicted
Command  pnpm build && pnpm test:product                                                                       ↗ Command
[Output]  Command ──────────────────────────────────────────────────────────────────────────────────────────────────────
line 001
line 002
line 003
line 004
line 005
line 006
line 007
line 008
line 009
line 010
line 011
line 012
build failed
⋮
────────────────────────────────── Retained preview · not full history · rows 1-13/13 ──────────────────────────────────
Esc back | Follow ON | [GAP] | Find Ctrl+F / Ctrl+Shift+F / | C copy output | V command | PgUp/PgDn
```
**AFTER — real output at this HEAD**

```text
Job · job-a · bash                                                                              ‣ Failed [GAP] [SETTLED]
Earlier output evicted
Command  pnpm build && pnpm test:product                                                                       ↗ Command
[Output]  Command ──────────────────────────────────────────────────────────────────────────────────────────────────────
line 001
line 002
line 003
line 004
line 005
line 006
line 007
line 008
line 009
line 010
line 011
line 012
build failed
⋮
Retained preview · not full history                                                                         rows 1-13/13
Follow on · [GAP] · Ctrl+F find · c copy output · Tab switch · PgUp/PgDn · Esc back
```
`● FAILED [GAP] [SETTLED]` becomes `‣ Failed [GAP] [SETTLED]`: the word is the signal, the colour is secondary, and `●` (U+25CF, East-Asian-Width *ambiguous*) is replaced by the EAW-neutral `‣` (U+2023), which keeps a one-cell glyph anchor without risking a two-cell paint on CJK-width terminals (Owner amendment to D5). The bracketed machine markers stay uppercase — that is the role ALL-CAPS keeps. Note the bar correctly advertises no Stop for a settled job in both frames.


### 4.3 Wide 120×40 — Command page

**BEFORE — real output**

```text
JOB  job-a · bash                                                                                              ● RUNNING
progress: 3/8 checks · detail: Building components
Full command                                                                                                Copy All [C]
Output  [Command] ──────────────────────────────────────────────────────────────────────────────────────────────────────
pnpm build && pnpm test:product
⋮
────────────────────────────────────────────── Full command · rows 1-1/1 ───────────────────────────────────────────────
Esc output | C copy all | Find Ctrl+F / Ctrl+Shift+F / | PgUp/PgDn
```
**AFTER — real output at this HEAD**

```text
Job · job-a · bash                                                                                             ‣ Running
Progress: 3/8 checks · Detail: Building components
Full command                                                                                                Copy All [C]
Output  [Command] ──────────────────────────────────────────────────────────────────────────────────────────────────────
pnpm build && pnpm test:product
⋮
                                                                                                              rows 1-1/1
c copy all · Tab switch · Ctrl+F find · PgUp/PgDn · Esc output
```
The page label `Full command` is stated once (summary row) instead of twice (summary row *and* status line); the status line keeps only the real position fact. `Copy All [C]` already follows the target affordance grammar (`Verb [Key]`).


### 4.4 Short 80×10 — Output

**BEFORE — real output**

```text
JOB  job-a · bash                                                      ● RUNNING
progress: 3/8 checks · detail: Building components
Command  pnpm build && pnpm test:product                               ↗ Command
[Output]  Command ──────────────────────────────────────────────────────────────
line 036
line 037
line 038
line 039
line 040
Esc back | S stop | Follow ON | Retained preview · not full history
```
**AFTER — real output at this HEAD**

```text
Job · job-a · bash                                                     ‣ Running
Progress: 3/8 checks · Detail: Building components
Command  pnpm build && pnpm test:product                               ↗ Command
[Output]  Command ──────────────────────────────────────────────────────────────
line 036
line 037
line 038
line 039
line 040
s stop · Follow on · Retained preview · not full history · Esc back
```
This frame proves why the proposal's "keep facts out of the action bar" rule cannot be adopted literally: at `80×10` the reading-facts row is not granted (`FACTS_MIN_ROWS = 12`), so the retained-output disclosure has nowhere else to live. The target keeps it on the bar, distinguishable from the hints because a fact reads `<Noun> <state>` and never starts with a key name.


### 4.5 Narrow 60×20 and 44×20 — Output

**BEFORE — 60×20 real output**

```text
JOB  job-a · bash                                  ● RUNNING
Command  pnpm build && pnpm test:product           ↗ Command
[Out]  Cmd ─────────────────────────────────────────────────
line 025
line 026
line 027
line 028
line 029
line 030
line 031
line 032
line 033
line 034
line 035
line 036
line 037
line 038
line 039
line 040
Esc back | S stop | Follow ON
```
**AFTER — real output at this HEAD**

```text
Job · job-a · bash                                 ‣ Running
Command  pnpm build && pnpm test:product           ↗ Command
[Out]  Cmd ─────────────────────────────────────────────────
line 025
line 026
line 027
line 028
line 029
line 030
line 031
line 032
line 033
line 034
line 035
line 036
line 037
line 038
line 039
line 040
s stop · Follow on · Esc back
```

**BEFORE — 44×20 real output**

```text
JOB  job-a · bash                  ● RUNNING
Command  pnpm build && pnpm test:… ↗ Command
[Out]  Cmd ─────────────────────────────────
line 025
line 026
line 027
line 028
line 029
line 030
line 031
line 032
line 033
line 034
line 035
line 036
line 037
line 038
line 039
line 040
Esc back | S stop | Follow ON
```
**AFTER — real output at this HEAD**

```text
Job · job-a · bash                 ‣ Running
Command  pnpm build && pnpm test:product
[Out]  Cmd ─────────────────────────────────
line 025
line 026
line 027
line 028
line 029
line 030
line 031
line 032
line 033
line 034
line 035
line 036
line 037
line 038
line 039
line 040
s stop · Follow on · Esc back
```
At 44 columns the BEFORE frame cuts the command to `pnpm build && pnpm test:…` so that the `↗ Command` affordance can fit. The target drops the affordance instead (the summary row is itself clickable, so the command fits in full; `Tab switch` is NOT advertised at 44 columns because the bar dropped it by priority — the command page stays reachable through the clickable summary row). This is the "an affordance yields to its content" rule.


### 4.6 Job change list

| # | Before | After | Why |
|---|---|---|---|
| 1 | `JOB  job-a · bash` (`JOB` all-caps `textStrong`) | `Job · job-a · bash` | one header grammar with Settings: `Surface · trail · trail` |
| 2 | `● RUNNING` / `● FAILED` | `‣ Running` / `‣ Failed` with the status token | the word carries the state; `●` (U+25CF, EAW-ambiguous) becomes the EAW-neutral `‣` (U+2023) so a CJK-width terminal cannot shift the right-aligned group. Owner amendment to D5: keep a one-cell glyph anchor (`‣`), and it is the SAME marker for every status — no per-status glyph set (`✓`/`✕`/`⊘`/`⏳`/`◐`/`○` are all rejected) |
| 3 | `[GAP] [SETTLED] [ERROR]` | unchanged (uppercase bracketed machine markers) | the single role ALL-CAPS keeps |
| 4 | `progress:` / `detail:` | `Progress:` / `Detail:` | labelled fact grammar `<Label>: <value>` |
| 5 | Affordance always painted on the summary row | affordance yields when content + affordance cannot both fit | never truncate the content to keep a redundant affordance |
| 6 | `[Output]  Command ────` | unchanged | already the target device |
| 7 | Facts row flanked by two full-width rules | dim status line, no flanks; note left, position right | a rule marks a boundary; a text line is never flanked (`D6`) |
| 8 | Bar ` \| `; `Follow ON`; `S stop`; `V command` | ` · `; `Follow on`; `s stop`; `Tab switch` | one separator, Title Case words, no bare uppercase letters; the page toggle is one symmetric `Tab` |
| 9 | Command page repeats `Full command` in the status line | stated once | a status line states only facts not already stated above it |
| 10 | Facts drop after every hint | safety facts outrank verbs and browsing hints | a disclosure must survive a tight row |
| 11 | Bar started with `Esc back` / `Esc output` | both move to the TAIL | D8: the family puts `Esc` last everywhere (all overlays already do) |
| — | Follow/End, Find, search layering, copy sinks, Stop admission, body floor, tab hit map, observer lease | unchanged | vocabulary only |

## 5. Picker overlay — the `/model` picker (PR5)

The **Overlay** archetype (§12.2) is the same vocabulary inside a rounded
`Frame` instead of a full terminal. The `/model` picker is its reference
surface: a `SearchablePicker` carrying a title row, group headers, a hint line
and the `/model` badge slot. The overlay is composited over the live editor, so
the screen around the box is the ordinary one.

**BEFORE — real output**

```text
🐋  dsh-pi-tui
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
                                                                                                                    full
↑0 ↓0  t0/s0
⋮
                        ╭──────────────────────────────────────────────────────────────────────╮
                        │ Models  5/5                                                          │
                        │                                                                      │
                        │ >                                                                    │
                        │                                                                      │
                        │   OpenAI · 3                                                         │
                        │ → Sol                                                        current │
                        │   Pro                                                        default │
                        │   Lite                                                               │
                        │   Anthropic · 2                                                      │
                        │   Opus                                                               │
                        │   Sonnet                                                             │
                        │                                                                      │
                        │   ↑↓ model · enter effort/select · esc close                         │
                        ╰──────────────────────────────────────────────────────────────────────╯
⋮
```
**AFTER — real output at this HEAD**

```text
🐋  dsh-pi-tui
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
                                                                                                                    full
↑0 ↓0  t0/s0
⋮
                        ╭──────────────────────────────────────────────────────────────────────╮
                        │ Models                                                           1/1 │
                        │                                                                      │
                        │ >                                                                    │
                        │                                                                      │
                        │   P1 · 1                                                             │
                        │ > Sol                          [current] [default] · effort ‹Medium› │
                        │                                                                      │
                        │   ↑↓ model · Enter effort/select · Esc close                         │
                        ╰──────────────────────────────────────────────────────────────────────╯
⋮
```

The devices it aligns, all of them §12.2 role assignments:

- **cursor** — `→ ` wrapped in `selectedText`, i.e. bold with no colour of its
  own, and an EAW-ambiguous glyph, becomes `> ` in `primary`; the picker now asks
  the theme for it (`selectListTheme.selectedPrefix`, a slot that existed and was
  unused). The search field above the list already painted its own `> ` prompt, so
  the two now agree instead of disagreeing.
- **title row** — `Models  5/5` (the count as a title suffix, the title carrying
  `groupHeader`'s bold `textMuted`) becomes role 1 (bold `textStrong`) with the
  count right-aligned in role 12 (`textMuted`) on the same row, dropped whole
  when it cannot fit (§8 step 6).
- **group header** — the whole `  OpenAI · 3` in bold `textMuted` becomes role 5:
  the label in `textDim`, the ` · 3` count in `textMuted`, never bold.
- **hint line** — `↑↓ model · enter effort/select · esc close` becomes
  `↑↓ model · Enter effort/select · Esc close`: key tokens capitalized, verbs
  lowercase, `Esc` last (§4.1, §7.1, D8). The picker's own default hints follow
  the same rule, as does the subagent model menu's.
- **the row state** — the bare words `current` / `default` become the
  `[current]` / `[default]` state chips in `textMuted` (§4.5), inside the SAME
  badge slot, pre-painted at the call site so the slot's selected-dependent
  paint can never recolour them — and the effort token that shares the badge is
  painted its own role-4 ink for the same reason: a nested span
  reset ends the outer ink for everything after it, so the unstyled tail used to
  fall back to the terminal default colour (measured). The token also keeps the
  LAST position, because the wrapped badge drops from the LEFT and the tail must be
  the fact the user is acting on. The wrap measurement uses the
  chip text, so the layout stays honest.
- **a failed catalog** — names the failure and paints that word `error` (D11)
  while its detail resumes the muted ink, because the chip-like pre-paint wins
  over the picker's own `noMatch` wrapper (the `status.ts:110` precedent). An
  ordinary empty filter stays muted: only a real failure is painted as one.

**BEFORE — real output**

```text
🐋  dsh-pi-tui
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
                                                                                                                    full
↑0 ↓0  t0/s0
⋮
                        ╭──────────────────────────────────────────────────────────────────────╮
                        │ Models  0/0                                                          │
                        │                                                                      │
                        │ > zzzznomatch                                                        │
                        │                                                                      │
                        │   Model catalog unavailable: connection refused                      │
                        │                                                                      │
                        │   ↑↓ model · enter effort/select · esc close                         │
                        ╰──────────────────────────────────────────────────────────────────────╯
⋮
```
**AFTER — real output at this HEAD**

```text
🐋  dsh-pi-tui
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
                                                                                                                    full
↑0 ↓0  t0/s0
⋮
                        ╭──────────────────────────────────────────────────────────────────────╮
                        │ Models                                                           0/0 │
                        │                                                                      │
                        │ > zzzznomatch                                                        │
                        │                                                                      │
                        │   Model catalog unavailable: connection refused                      │
                        │                                                                      │
                        │   ↑↓ model · Enter effort/select · Esc close                         │
                        ╰──────────────────────────────────────────────────────────────────────╯
⋮
```

The same overlay at `80×24` — the count still fits right-aligned, and every
device keeps its row:

**BEFORE — real output**

```text
🐋  dsh-pi-tui
────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
    ╭──────────────────────────────────────────────────────────────────────╮full
↑0 ↓│ Models  5/5                                                          │
    │                                                                      │
    │ >                                                                    │
    │                                                                      │
    │   OpenAI · 3                                                         │
    │ → Sol                                                        current │
    │   Pro                                                        default │
    │   Lite                                                               │
    │   Anthropic · 2                                                      │
    │   Opus                                                               │
    │   Sonnet                                                             │
    │                                                                      │
    │   ↑↓ model · enter effort/select · esc close                         │
    ╰──────────────────────────────────────────────────────────────────────╯
⋮
```
**AFTER — real output at this HEAD**

```text
🐋  dsh-pi-tui
────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
                                                                            full
↑0 ↓0  t0/s0

    ╭──────────────────────────────────────────────────────────────────────╮
    │ Models                                                           1/1 │
    │                                                                      │
    │ >                                                                    │
    │                                                                      │
    │   P1 · 1                                                             │
    │ > Sol                          [current] [default] · effort ‹Medium› │
    │                                                                      │
    │   ↑↓ model · Enter effort/select · Esc close                         │
    ╰──────────────────────────────────────────────────────────────────────╯
⋮
```

### 5.1 The `[current]` chip in a vendored value slot (PR5)

Two pickers route a row STATE through the vendored `SettingsList` value slot, whose
own paint is `selected ? primary : textDim`. Both now pre-paint the chip at the call
site, so the chip keeps `textMuted` in BOTH selection states, and the preset picker
moved its mark out of the `description` (which is painted only while the row is
selected) into the same slot the theme picker uses:

**BEFORE — real output**

```text
# current-before-theme-120x40.txt
# theme submenu, cursor ON the current row, 120x40
 0| 🐋  dsh-pi-tui
 1| ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 2| ❯
 3| ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 4|                                                                                                                     full
 5| ↑0 ↓0  t0/s0
 6|
 7|
 8|
 9|
10|
11|
12|
13|
14|                         ╭──────────────────────────────────────────────────────────────────────╮
15|                         │ >                                                                    │
16|                         │                                                                      │
17|                         │ > auto   ← current                                                   │
18|                         │   dark                                                               │
19|                         │   light                                                              │
20|                         │                                                                      │
21|                         │   Built-in palette                                                   │
22|                         │                                                                      │
23|                         │   Type to search · Enter/Space to change · Esc to cancel             │
24|                         ╰──────────────────────────────────────────────────────────────────────╯
25|
26|
27|
28|
29|
30|
31|
32|
33|
34|
35|
36|
37|
38|
39|

# SELECTED (cursor on the current row): "│ > auto   ← current                                                   │"
# chip cell (row 17, col 36) fg = 5220607
```
**AFTER — real output at this HEAD**

```text
# current-after-theme-120x40.txt
# theme submenu, cursor ON the current row, 120x40
 0| 🐋  dsh-pi-tui
 1| ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 2| ❯
 3| ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 4|                                                                                                                     full
 5| ↑0 ↓0  t0/s0
 6|
 7|
 8|
 9|
10|
11|
12|
13|
14|                         ╭──────────────────────────────────────────────────────────────────────╮
15|                         │ >                                                                    │
16|                         │                                                                      │
17|                         │ > auto   [current]                                                   │
18|                         │   dark                                                               │
19|                         │   light                                                              │
20|                         │                                                                      │
21|                         │   Built-in palette                                                   │
22|                         │                                                                      │
23|                         │   Type to search · Enter/Space to change · Esc to cancel             │
24|                         ╰──────────────────────────────────────────────────────────────────────╯
25|
26|
27|
28|
29|
30|
31|
32|
33|
34|
35|
36|
37|
38|
39|

# SELECTED (cursor on the current row): "│ > auto   [current]                                                   │"
# chip cell (row 17, col 35) fg = 7039851
```

**BEFORE — real output**

```text
# current-before-preset-120x40.txt
# preset picker, cursor ON the current row, 120x40
 0| 🐋  dsh-pi-tui
 1| ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 2| ❯
 3| ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 4|                                                                                                                     full
 5| ↑0 ↓0  t0/s0
 6|
 7|
 8|
 9|
10|
11|
12|
13|                         ╭──────────────────────────────────────────────────────────────────────╮
14|                         │ >                                                                    │
15|                         │                                                                      │
16|                         │ > Standard mode (standard)                                           │
17|                         │   PTC mode (ptc)                                                     │
18|                         │   Minimal mode (minimal)                                             │
19|                         │                                                                      │
20|                         │   Full coding agent with file editing, shell, file and web search,   │
21|                         │   skills, planning, goals, subagents, and workflows. · system ·      │
22|                         │   default · ← current                                                │
23|                         │                                                                      │
24|                         │   Type to search · Enter/Space to change · Esc to cancel             │
25|                         ╰──────────────────────────────────────────────────────────────────────╯
26|
27|
28|
29|
30|
31|
32|
33|
34|
35|
36|
37|
38|
39|

# SELECTED LABEL ROW (16): "│ > Standard mode (standard)                                           │"
# marker row (22): "│   default · ← current                                                │"
# marker cell (row 22, col 39) fg = 8947848
```
**AFTER — real output at this HEAD**

```text
# current-after-preset-120x40.txt
# preset picker, cursor ON the current row, 120x40
 0| 🐋  dsh-pi-tui
 1| ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 2| ❯
 3| ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 4|                                                                                                                     full
 5| ↑0 ↓0  t0/s0
 6|
 7|
 8|
 9|
10|
11|
12|
13|                         ╭──────────────────────────────────────────────────────────────────────╮
14|                         │ >                                                                    │
15|                         │                                                                      │
16|                         │ > Standard mode (standard)  [current] [default]                      │
17|                         │   PTC mode (ptc)                                                     │
18|                         │   Minimal mode (minimal)                                             │
19|                         │   Creator mode (cordis)                                              │
20|                         │                                                                      │
21|                         │   Full coding agent with file editing, shell, file and web search,   │
22|                         │   skills, planning, goals, subagents, and workflows. · system        │
23|                         │                                                                      │
24|                         │   Type to search · Enter/Space to change · Esc to cancel             │
25|                         ╰──────────────────────────────────────────────────────────────────────╯
26|
27|
28|
29|
30|
31|
32|
33|
34|
35|
36|
37|
38|
39|

# SELECTED LABEL ROW (16): "                        │ > Standard mode (standard)  [current] [default]                      │                        "
# marker row (16): "                        │ > Standard mode (standard)  [current] [default]                      │                        "
# marker cell (row 16, col 55) fg = 7039851
```

The measured ink in those frames: `← current` was `primary` (#4FA8FF) on the cursor
row and `textDim` (#888888) elsewhere; the `[current]` chip is `textMuted` (#6B6B6B)
in both states. Two states are two chips (`[current] [default]`), a plain space
apart, and the pair is handed to the slot as WHOLE parts: the renderer reserves one
chip and drops the rest whole (fork divergence X061), so a narrow frame shows
`[current]` — never `[defaul`, never a dangling separator — while the LABEL is what
truncates with `…` instead of pushing the state out of the row.

At `44×20` — the narrowest frame the ladder supports — the chip is still painted
whole and the lower-priority state yields entirely:

**AFTER — real output at this HEAD (44×20)**

```text
# current-after-preset-44x20.txt
# preset picker, cursor ON the current row, 44x20
 0| 🐋  dsh-pi-tui
 1| ────────────────────────────────────────────
 2| ╭──────────────────────────────────────────╮
 3| │ >                                        │
 4| │                                          │
 5| │ > Standard mode (standard)  [current]    │
 6| │   PTC mode (ptc)                         │
 7| │   Minimal mode (minimal)                 │
 8| │   Creator mode (cordis)                  │
 9| │                                          │
10| │   Full coding agent with file editing,   │
11| │   shell, file and web search, skills,    │
12| │   planning, goals, subagents, and        │
13| │   workflows. · system                    │
14| │                                          │
15| │   Type to search · Enter/Space to cha... │
16| ╰──────────────────────────────────────────╯
17|
18|
19|

# SELECTED LABEL ROW (5): "│ > Standard mode (standard)  [current]    │"
# marker row (5): "│ > Standard mode (standard)  [current]    │"
# marker cell (row 5, col 31) fg = 7039851
```


## 6. Measured ink inventory (BEFORE) → target role

Measured from the cell read-back at `120×40`; token names confirmed against the
painting source line.

| Element | BEFORE ink (measured) | AFTER role (spec §3.2) |
|---|---|---|
| Settings surface word `SETTINGS` | `primary` | role 1 `textStrong` bold |
| Settings trail / badge / diagnostic line | `textMuted` | roles 2/11/12 `textDim` / `textMuted` |
| Settings focused pane `[CATEGORIES (3)]` | `borderFocus` (`#E8A838` = `warning`) | role 7 `primary` bold |
| Settings unfocused pane `SETTINGS (2)` | `textMuted` | role 5 `textDim` |
| Settings cursor `> ` | same ink as the row (`textStrong`) | role 6 `primary` |
| Settings selected row | `textStrong` (bold) | role 8 `textStrong` bold |
| Settings unselected row | `text` | role 3 `text` |
| Settings row summary column | inherits the row ink | role 4 `textDim` |
| Settings detail labels | `textDim` | role 5 `textDim` |
| Settings detail values | **terminal default (unpainted)** — derived presentation text with no ink at all | role 3 `text` / role 4 `textDim` (the palette-invisible defect of §3.2) |
| Settings detail buttons | `accent` | role 14 `primary` |
| Settings candidate state chip | `[← current]` in the row ink (selected → `textStrong`) | row-state chip `[current]` in `textMuted`, never recoloured by selection; two states = two chips |
| Settings action bar | `textDim` | role 13 `textMuted` |
| Settings rules | `border` | role 15 `border` |
| Job `JOB` | `textStrong` | role 1 `textStrong` bold |
| Job id / ` · kind` | `textMuted` / `textDim` | roles 2 `textDim` |
| Job status word + dot | `primary`/`warning`/`error`, ALL-CAPS, `●` | role 9: Title Case word + the one shared `‣` marker |
| Job machine markers | `warning`/`error`/`textDim` | role 10, unchanged |
| Job meta facts | `textDim` | role 11 `textMuted` |
| Job summary / `Full command` | `textMuted` | role 4/5 `textDim` |
| Job affordances (`↗ Command`, `Copy All [C]`) | `primary` | role 14 `primary` |
| Job active tab `[Output]` | bold + `primary` hex | role 7 `primary` bold |
| Job inactive tab | `textDim` | role 5 `textDim` |
| Job body (log text) | terminal default, **unpainted by design** (the record-bytes rule, §3.2) | unchanged — raw recorded output is not repainted |
| Job facts row / action bar | `textDim` | roles 11/13 `textMuted` |
| Job tab rule / facts-row flanks | `border` | role 15 (flanks removed) |

The two rows in **bold** above are the substantive defects, not taste: an
unpainted value silently ignores the active palette, and a `borderFocus` equal
to `warning` makes ordinary focus read as a warning.

## 7. Responsive behaviour: before → after

| Size | BEFORE keeps | AFTER keeps |
|---|---|---|
| Settings `120×40` | header, diagnostic, 2 rules, 3 panes, pinned bar | same geometry; only vocabulary changes |
| Settings `100×40` | 2 panes (categories + rows at L0) | same |
| Settings `80×10` | header, diagnostic, 2 rules, 2 panes, pinned bar | same, plus whole-fact diagnostic drops |
| Settings `44×20` | single pane, no pane header, no badge, mid-word bar truncation | single pane; bar drops whole segments instead |
| Job `120×40` | status, meta, summary, tabs+rule, body, facts (2 flanks), bar | status, meta, summary, tabs+rule, body, dim status line, bar |
| Job `80×10` | status, meta, summary, tabs+rule, body(5), bar + facts | same rows; facts never repeat what the status line holds |
| Job `60×20` | `[Out]  Cmd`, summary + affordance, no meta, no facts row, bar + facts | compact tabs unchanged; affordance kept (fits); facts Title Case |
| Job `44×20` | `[Out]  Cmd`, command truncated to keep `↗ Command` | affordance yields, command fits in full |

The degradation **order** the spec freezes (§8) is what these rows check: rules
first, then the diagnostic line, then the notice, then the pane header, then the
badge, then bar segments, then right-side affordances. The action bar is the
physical last row at every size and the body floor never falls below 1 row from 3
terminal rows up — both already true today and both must stay true.

## 8. Real-terminal verification (Settings PR)

Performed on a real TTY (`tmux`, truecolor, this machine), driving the product
with `dsh --profile <profile>` and reading the pane back with
`tmux capture-pane -e`: a BEFORE profile linked to `next` without the Settings
PR, and an AFTER profile linked to the Settings PR worktree. Window sizes
`120×40` (wide, L0 + L2), `80×10` (short, L0 + L2) and `44×20` (narrow, L2) were
each captured, and the AFTER frames were reached through a LIVE RESIZE from
120 to 44 to 80 columns, so the resize path is covered too.

Per-cell ink of the three decisive cells, decoded from the real pane (the
same window, the same row, BEFORE → AFTER):

| Cell | BEFORE (real `next`) | AFTER (this PR) |
|---|---|---|
| the surface word in row 0 | `primary` (`SETTINGS`) | `textStrong` (`Settings`) |
| the focused pane label | `warning` — the amber `borderFocus`, i.e. an ordinary focus painted as a warning | `primary` (`[Details]`) |
| a detail value (`Value`, `Runtime`) | **terminal default — unpainted**, so the palette was bypassed | `text` for the primary value, `textDim` for a secondary fact |
| the pinned bar | `textDim`, `Esc` first, ` \| ` joins, `R refresh` / `↑↓/Pg keys scroll` | `textMuted`, `Esc` last, ` · ` joins, `r refresh` + a separate `PgUp/PgDn` |
| detail verbs | `[Change…]  [Copy value]` in `accent` | `Change…  Copy value [C]` in `primary` |

The narrow AFTER frame also demonstrates the degradation rule on a real
terminal: at `44×20` the diagnostic line keeps only `Scope: TUI settings
document` (trailing facts dropped whole, no `…`), and the bar reads
`Enter change · ↑↓ scroll · Esc back` — the lowest-priority segments are gone
as whole segments instead of the old `Enter change…` half-word.

NOT covered by this real-terminal pass (and not claimed): the mouse path, the
refused-write path inside a live session (it needs a forced authority conflict;
the refusal ink is covered by the `VirtualTerminal` cell read-back in
`test/settings-workspace-visual.test.ts`), CJK/wide-glyph terminals, and any
terminal other than this one. Those stay `NOT_RUN`, not PASS.

### 8.2 The state-chip value slot (`[current] [default]`)

**The `/preset` picker has a real-TTY pass.** It was driven with a throwaway
`DSH_HOME` whose profile LINKS this worktree (`"@xmoon76/dsh-pi-tui":
"link:<worktree>"`, `dsh --profile wt`; the bundle list must include
`@deepseek-ai/dsh-base`, otherwise the TUI never mounts), captured at `44×20`
and then after a live `tmux resize-window` to `120×40`. At both sizes the row
paints ONE WHOLE state chip inside the frame, no `[defaul` fragment, no
dangling separator, nothing overflowing. The real row, unbroken (two cells
between the label and the chip, four after it):

    │ > Standard mode (standard)  [default]    │

The ANSI read-back (`tmux capture-pane -e`) gives the
chip `38;2;107;107;107` (`textMuted`) in both, with the cursor row's label
`1m` + `245;245;245` (bold `textStrong`). A blank session has no CURRENT preset,
so the state a real `/preset` run shows is `[default]`; the `[current]` chip
itself needs a session whose current preset is already committed and is covered
on the `VirtualTerminal` side instead.

**The `/settings` Theme submenu is `NOT_RUN` on a real terminal.** Its rows use
the same `SettingsList` slot and the same chip, and the `VirtualTerminal`
read-back in §5.1 plus `test/surface-row-grant.test.ts` (`C-T13` ink, `C-T14`
narrow frame with an over-wide plugin theme name) cover it, but the nested
legacy list was not re-driven through the workspace bridge in a real pane, so
no real-TTY claim is made for it. That is a `NOT_RUN`, not a PASS.

| Claim | Evidence today |
|---|---|
| the pair is `[current] [default]`, both `textMuted` | `VirtualTerminal` cell read-back (§5.1, `test/preset-command.test.ts`) |
| a chip is never cut, and a dropped chip takes its separator | fork suite `packages/pi-tui/test/settings-list.test.ts` + the 120/67/66/…/44-column frames |
| the label yields (clipped with `…`) so the chip survives at 44 columns | `VirtualTerminal` frames at 44×20 (§5.1) and the mouse hit map after a resize |
| the same in a real TTY | `/preset` `44×20` + live resize `120×40` (whole chip, `textMuted`, cursor label `textStrong`); `/settings` Theme submenu `NOT_RUN` |

### 8.1 The Job workspace side was accepted on a real terminal by the Owner

The Job workspace is only reachable from the Task Browser, which lists Host
jobs, so a sessionless TUI cannot show it. The Owner ran the recipe below on a
profile with a live Host job and accepted the result; the Job PR merged on that
basis. Nothing in this document is claimed as real-terminal evidence for that
surface without that run.

Recipe, for any future change to the Job chrome: on a profile with a real
session that ran a `bash` tool call, open `/tasks`, press Enter on the job row,
then check `Job · <id> · <kind>`, the `‣ Running` / `‣ Failed` status, the
UNFLANKED reading-facts row (disclosure left, `rows a-b/N` right), the bar
(`s stop · Follow on · Ctrl+F find · c copy output · Tab switch · PgUp/PgDn ·
Esc back`), `Tab` switching both ways, and the affordance yield at 44 columns.

What remains machine-covered: the Job frames' text and per-cell ink in this
document come from the `VirtualTerminal` cell read-back, and the SHARED chrome
the Job bar reuses (rules budget, glyph widths, ` · ` joins, `Esc` last, a
`textMuted` bar) was verified on a real terminal in the Settings pass.

## 8a. Measured AFTER frames — S2 Web Search / Fetch (PR-B)

Real `TuiApp` + `VirtualTerminal` captures from
`test/settings-web-visual.test.ts` (the same test asserts the matrix widths,
the whole `[current]`/`[default]`/`[unavailable]` chips, the action-bar hints
and the per-cell ink). Provenance: `pnpm build` on the S2 worktree, then
`node scripts/run-with-temp-root.mjs node --test test/settings-web-visual.test.ts`;
timestamps normalized here only.

`120×40` — the Workspace `Other` launcher row selected (its Detail carries the
authoritative summary; `2 editable rows` is unchanged because the row is a
navigation row, not a field):

```text
Settings · Other settings · Rows                                   2 editable rows
Scope: Host Web provider settings · Refreshed <time> · Config Ready
──────────────────────────────────────────────────────────────────────────────
Categories (3)          [Rows (2)]                                  Details
  Appearance              Open existing settings… Existing settin…  Web Search / Fetch
  Display               > Web Search / Fetch Search: Messages · F…  Value       Search: Messages · Fetch: HTTP
> Other settings                                                    Scope       Host Web provider settings
                                                                    Freshness   Ready · on-open snapshot
                                                                    Description Host Web settings. Defaults: Messages
                                                                                search · HTTP fetch. The DeepSeek Search
                                                                                / Fetch APIs are billed separately and
                                                                                send the request to an external
                                                                                endpoint; Share Original Question sends
                                                                                up to 128 characters of the human
                                                                                question. The API key is stored as a
                                                                                credential reference and never shown.
                                                                                Enter configure.
──────────────────────────────────────────────────────────────────────────────
Up/Down select · Left back · Right open · Enter open · r refresh · Esc back
```

`72×24` — the legacy Web section after the Workspace handoff (the state chips
are whole; the value fact leads the selected row's description):

```text
╭──────────────────────────────────────────────────────────────────────╮
│ >                                                                    │
│                                                                      │
│   ────────────────────────                                           │
│   Working directory            /ws                                   │
│   ────────────────────────                                           │
│ > Web Search Provider          [current] [default]                   │
│   Web Fetch Provider           [current] [default]                   │
│   Search API Result Count      [current] [default]                   │
│   (21/28)                                                            │
│                                                                      │
│   Current: Messages · Messages is the official DeepSeek Messages     │
│   search; the DeepSeek Search API is a separately billed endpoint.   │
│   [current] follows a verified write; [default] marks the packaged   │
│   default. The choice applies to the next search, never to one       │
│   already running. Esc returns to the Workspace.                     │
│                                                                      │
│   Type to search · Enter/Space to change · Esc to cancel             │
╰──────────────────────────────────────────────────────────────────────╯
```

`44×20` — the floor: one WHOLE reserved chip survives, the label truncates with
`…`, the value fact and the return hint stay in the wrapped description, and the
legacy list's own single-string hint line truncates (pre-existing fork
behaviour; recorded as NOT_VERIFIED for the painted `Esc` word at this width):

```text
╭──────────────────────────────────────────╮
│ >                                        │
│                                          │
│   ────────────────────…                  │
│ > Web Search Provider    [current]       │
│   (21/28)                                │
│                                          │
│   Current: Messages · Messages is the    │
│   official DeepSeek Messages search;     │
│   the DeepSeek Search API is a           │
│   separately billed endpoint.            │
│   [current] follows a verified write;    │
│   [default] marks the packaged           │
│   default. The choice applies to the     │
│   next search, never to one already      │
│   running. Esc returns to the            │
│   Workspace.                             │
│                                          │
│   Type to search · Enter/Space to cha... │
╰──────────────────────────────────────────╯
```

Measured ink (cell read-back): `[current]`/`[default]` = `textMuted`,
`[not saved]` = `error`; the light palette supplies the same roles on its own
open. The surface paints no icon glyph, so `symbols` and `minimal` frames are
identical. Not run: a physical Tern GUI record (this renderer does not paint
these Settings surfaces) and a live palette switch inside the pre-painted
legacy chips.

## 8b. Real-terminal record — S2 Web Search / Fetch (PR-B)

Produced with the rc.2 CLI over an ISOLATED development home
(`/home/xmoon/.local/bin/dsh-next` with `DSH_NEXT_ROOT=<the S2 worktree>`,
`DSH_HOME=~/.dsh-pi-tui-next`, profile relinked to the worktree, bundle built
from the reviewed tree), `tmux new-session -d -s <name> -x 120 -y 40`, keys
sent one at a time, frames captured with `tmux capture-pane -p` (ANSI stripped
here) and the SGR presence checked with `-e` (20+ `\e[38;2;…` sequences per
frame). No network/paid endpoint was contacted.

`/settings` → `Other settings` → row selected (real Host Web settings mounted;
the launcher is a navigation row, so `2 editable rows` is unchanged):

```text
Settings · Other settings · Rows                                    2 editable rows
Scope: Host Web provider settings · Refreshed <time> · Config Ready
──────────────────────────────────────────────────────────────────────────────
Categories (3)          [Rows (2)]                                  Details
  Appearance              Open existing settings… Existing settin…  Web Search / Fetch
  Display               > Web Search / Fetch Search: Messages · F…  Value       Search: Messages · Fetch: HTTP
> Other settings                                                    Scope       Host Web provider settings
                                                                    Freshness   Ready · on-open snapshot
                                                                    Description Host Web settings. Defaults: Messages
                                                                                search · HTTP fetch. The DeepSeek Search
                                                                                / Fetch APIs are billed separately and
                                                                                send the request to an external
                                                                                endpoint; Share Original Question sends
                                                                                up to 128 characters of the human
                                                                                question. The API key is stored as a
                                                                                credential reference and never shown.
                                                                                Enter configure.
──────────────────────────────────────────────────────────────────────────────
Up/Down select · Left back · Right open · Enter open · r refresh · Esc back
```

Enter → the existing editor's Web section; Enter on the first row performed a
REAL official `web` settings mutation, and the row moved only after the
authoritative read-back (`[current]` kept, `[default]` gone, value fact
`DeepSeek Search API`):

```text
│ > Web Search Provider          [current]                             │
│   Current: DeepSeek Search API · Messages is the official DeepSeek   │
│   Messages search; the DeepSeek Search API is a separately billed    │
│   endpoint. …                                                        │
```

Esc → the Workspace restored on the `Web Search / Fetch` row with the NEW
summary; the endpoint editor (four rows down) and the credential panel (one
more) rendered their full contracts (`Search / Fetch API Endpoint` +
`Enter confirm · Esc cancel`; `DeepSeek API Key` + `Configured · source: file` +
`Configure…`/`Clear…`), each cancelled with Esc without a write:

```text
Settings · Other settings · Rows                                    2 editable rows
  Display               > Web Search / Fetch Search: DeepSeek Sea…  Value       Search: DeepSeek Search API · Fetch:
```

Then the provider was reset to the official default through the same UI
(`[current] [default]`, `Current: Messages`), so the isolated development home
is left at the shipped selection.

NOT_VERIFIED in this record: a physical Tern GUI frame (this renderer does not
paint these Settings surfaces). The live palette switch is covered in-process
instead: the mounted rows register a theme observer and rebuild their cached
chip ANSI, asserted by cell-ink in `test/settings-web-visual.test.ts`.

## 8c. Real-terminal record — S2 review delta (Task Center action bar)

Produced with the same isolated development home and rc.2 CLI as §8b
(`/home/xmoon/.local/bin/dsh-next` with `DSH_NEXT_ROOT=<the S2 worktree>`,
`DSH_HOME=~/.dsh-pi-tui-next`), `tmux new-session -d -s <name> -x 120 -y 40`,
launched with `env -u NO_COLOR`, keys sent one at a time, frames captured with
`tmux capture-pane -p` (plain, shown verbatim below) and `-e` (ANSI: 29–31
`\e[38;2;…` sequences per frame). The running and settled jobs were created by
ONE bounded background bash call from the Owner-authorized model run (no DeepSeek
endpoint was contacted); every other key press below is Task Center input.

The changed behaviour is the action bar, which advertises `s stop` only for the
row it can actually stop. In one session a running job and a settled job share
the roster, and the bar follows the SELECTED row: the settled job
(`canStop === false`) advertises no Stop, the running one does, `s` latches the
confirmation, and after `Y` the killed job drops the segment again.

Settled job selected — no `s stop`:

```text
 ╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
▸│ Tasks [TRACKED]  0 active · 1 done · 1/1 shown                                                                     │
 │                                                                                                                    │
 │ ── Jobs / executions ──                                          │ Selected                                        │
 │ → bash · sleep 20 && echo slow-done              ‣ Completed 20s │ bash · sleep 20 && echo slow-done               │
 │                                                                  │ kind      bash                                  │
 │                                                                  │ status    completed                             │
 │                                                                  │ elapsed   20s                                   │
▸│                                                                  │ started   2026-10-18T11:45:47.286Z              │
T│                                                                  │ detail    exit code: 0                          │
A│                                                                                                                    │
 │   Enter open · ↑↓ select · ←→ tree · / search · a scope · Shift+Tab type · Esc close                               │
 ╰────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

Running job selected — `s stop` present:

```text
 ╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
 │ Tasks [TRACKED]  1 active · 1 done · 2/2 shown                                                                     │
 │                                                                                                                    │
 │ ── Jobs / executions ──                                          │ Selected                                        │
 │ → bash · sleep 60 && echo long-done                ‣ Running 21s │ bash · sleep 60 && echo long-done               │
 │   bash · sleep 20 && echo slow-done              ‣ Completed 20s │ kind      bash                                  │
▸│                                                                  │ status    running                               │
 │                                                                  │ elapsed   21s                                   │
 │                                                                  │ started   2026-10-18T11:46:52.007Z              │
 │                                                                                                                    │
 │   Enter open · ↑↓ select · ←→ tree · s stop · / search · a scope · Shift+Tab type · Esc close                      │
 ╰────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

`s` — the confirmation the advertised key earns:

```text
▸╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
 │ Tasks [TRACKED]  1 active · 1 done · 2/2 shown                                                                     │
 │                                                                                                                    │
 │ ── Jobs / executions ──                                          │ Selected                                        │
 │ → bash · sleep 60 && echo long-done                ‣ Running 40s │ bash · sleep 60 && echo long-done               │
 │   bash · sleep 20 && echo slow-done              ‣ Completed 20s │ kind      bash                                  │
 │                                                                  │ status    running                               │
▸│                                                                  │ elapsed   40s                                   │
 │                                                                  │ started   2026-10-18T11:46:52.007Z              │
 │                                                                  │ Stop bash · sleep 60 && echo long-done?  Y con… │
 │                                                                                                                    │
 │   Y confirm stop · Esc cancel                                                                                      │
 ╰────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

`Y` — the job is `Killed` and the bar drops the segment:

```text
 ╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
 │ Tasks [TRACKED]  0 active · 1 done · 2/2 shown                                                                     │
 │                                                                                                                    │
 │ ── Jobs / executions ──                                          │ Selected                                        │
 │ → bash · sleep 60 && echo long-done                 ‣ Killed 55s │ bash · sleep 60 && echo long-done               │
❯│   bash · sleep 20 && echo slow-done              ‣ Completed 20s │ kind      bash                                  │
 │                                                                  │ status    killed                                │
 │                                                                  │ elapsed   55s                                   │
▸│                                                                  │ started   2026-10-18T11:46:52.007Z              │
 │                                                                  │ detail    signal: SIGTERM; cancelled by the us… │
 │                                                                                                                    │
 │   Enter open · ↑↓ select · ←→ tree · / search · a scope · Shift+Tab type · Esc close                               │
 ╰────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

The same rule in the EMPTY roster, measured across the pre-change build and the
reviewed build (nothing can be stopped either way):

BEFORE:

```text
 ╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
 │ Tasks [TRACKED]  0 active · 0/0 shown                                                                              │
 │                                                                                                                    │
 │ No matching tasks                                                                                                  │
 │                                                                                                                    │
 │   Enter open · ↑↓ select · ←→ tree · s stop · / search · a scope · Shift+Tab type · Esc close                      │
 ╰────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

AFTER:

```text
 ╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
 │ Tasks [TRACKED]  0 active · 0/0 shown                                                                              │
 │                                                                                                                    │
 │ No matching tasks                                                                                                  │
 │                                                                                                                    │
 │   Enter open · ↑↓ select · ←→ tree · / search · a scope · Shift+Tab type · Esc close                               │
 ╰────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

The `▸` / `T` / `A` / `❯` cells at column 1 of some rows are the collapsed
transcript rows and the editor boundary showing through the capturing overlay at
those rows — a pre-existing compositing artifact of the two surfaces, unrelated
to the action bar.

NOT_RUN in this record — a real-terminal frame would need an environment this
machine does not have: the refused-endpoint row's kept value (needs a Host that
keeps a different endpoint value). That state is pinned in-process instead
(`test/settings-web-provider.test.ts` and `test/settings-web-visual.test.ts`).
The Session Picker's empty roster was listed here too; review-delta 3 proved it
user-reachable and recorded it from a real terminal — see §8e.

## 8d. Real-terminal record — S2 review delta 2 (Web endpoint row)

Same isolated development home and rc.2 CLI as §8b/§8c
(`/home/xmoon/.local/bin/dsh-next` with `DSH_NEXT_ROOT=<the S2 worktree>`,
`DSH_HOME=~/.dsh-pi-tui-next`), `tmux new-session -d -s <name> -x 120 -y 40`,
launched with `env -u NO_COLOR`, keys sent one at a time, frames captured with
`tmux capture-pane -p` (plain, shown verbatim below) and `-e` (ANSI: 157
`\e[…m` sequences in the endpoint-row frame, truecolor `\e[38;2;…` included).
The route is the frozen one: `/settings` → `Other settings` → `Web Search /
Fetch` → the legacy Web section.

The changed fact is the ENDPOINT row's value slot: while the Host returns a
readable `baseURL` the slot paints that URL (the submenu shows it in full), and
`[unavailable]` is reserved for an authority that really could not be read — a
valid endpoint is never claimed unavailable. Four `Down` presses from the
section top put the cursor on that row:

```text
 ╭──────────────────────────────────────────────────────────────────────╮
 │ >                                                                    │
 │                                                                      │
 │   Web Fetch Provider           [current] [default]                   │
 │   Search API Result Count      [current] [default]                   │
 │   Share Original Question      [current] [default]                   │
 │ > Search / Fetch API Endpoint  https://api.deepseek.com/v1/tools     │
 │   DeepSeek API Key             [current]                             │
 │   Keyboard shortcuts           Defaults                              │
 │   (28/31)                                                            │
 │                                                                      │
 │   Current: https://api.deepseek.com/v1/tools · The API base the      │
 │   DeepSeek Search and Fetch APIs call (/search and /fetch are        │
 │   appended). Changing it sends the credential to that endpoint, so   │
 │   only a trusted https base is accepted.                             │
 ╰──────────────────────────────────────────────────────────────────────╯
```

`Enter` on the same row still opens the endpoint editor on the authoritative
value (unchanged by this delta; the editor owns the write and its verdict):

```text
 ╭──────────────────────────────────────────────────────────────────────╮
 │ Search / Fetch API Endpoint                                          │
 │ > https://api.deepseek.com/v1/tools                                  │
 │ Confirm only a trusted https URL: the saved endpoint receives the... │
 │ Changing this sends the DeepSeek API credential to a different en... │
 │ Official base: https://api.deepseek.com/v1/tools; /search and /fe... │
 │ Enter confirm · Esc cancel                                           │
 ╰──────────────────────────────────────────────────────────────────────╯
```

The write-verdict change of the same delta (a resolved mutation the Host did not
commit is `Not saved`, with the row back on the value the Host keeps) needs a
Host that keeps a DIFFERENT value than the one submitted, which this isolated
home cannot produce: it stays NOT_RUN as a real-terminal frame (the state is
pinned in-process at the frozen sizes by `test/settings-web-provider.test.ts`
and `test/settings-web-visual.test.ts`).

## 8e. Real-terminal record — S2 review delta 3 (Picker empty roster)

Same rc.2 CLI and worktree as §8d (`/home/xmoon/.local/bin/dsh-next` with
`DSH_NEXT_ROOT=<the S2 worktree>`), but a **FRESH isolated home**
(`DSH_NEXT_HOME=/tmp/dsh-empty-home`, the profile created by the launcher's own
`plugin add 'link:.'`), `tmux new-session -d -s <name> -x C -y R`, launched with
`env -u NO_COLOR`, keys sent one at a time, frames captured with
`tmux capture-pane -p` (plain, verbatim below) and `-e` (ANSI: 89 `\e[…m`
sequences at 120×40, 53 at 80×10, 51 at 44×20). Nothing is submitted before the
capture, so the surface is still the sessionless/deferred start: the command
surface is registered there (`src/app/bootstrap.ts`), and `/sessions` lists
nothing, which the picker states as one whole sentence.

120×40 — the refusal row (the box is centred in the frame; that leading offset is
trimmed here, every cell of the box is verbatim):

```text
 ╭──────────────────────────────────────────────────────────────────────────╮
 │ sessions · Current directory                                         1/1 │
 │                                                                          │
 │ >                                                                        │
 │                                                                          │
 │ > No readable sessions                                                   │
 │                                                                          │
 │   Type to filter · ↑↓ navigate · Enter select · Esc close                │
 ╰──────────────────────────────────────────────────────────────────────────╯
```

80×10 — the whole capture, verbatim: the shrunken overlay leaves the stopped
transcript's box columns and the status rows visible at the frame edges (the
sentence keeps its own row):

```text
🐋╭──────────────────────────────────────────────────────────────────────────╮
│ │ sessions · Current directory                                         1/1 │ │
│ │                                                                          │ │
│ │ >                                                                        │ │
╰─│                                                                          │─╯
──│ > No readable sessions                                                   │──
❯ │                                                                          │
──│   Type to filter · ↑↓ navigate · Enter select · Esc close                │──
[d╰──────────────────────────────────────────────────────────────────────────╯ll
↑0 ↓0  t0/s0
```

44×20 — the frozen floor: the whole sentence is readable, only the hint row
truncates:

```text
╭──────────────────────────────────────────╮
│ sessions · Current directory         1/1 │
│                                          │
│ >                                        │
│                                          │
│ > No readable sessions                   │
│                                          │
│   Type to filter · ↑↓ navigate · Enter   │
╰──────────────────────────────────────────╯
```

This closes the earlier NOT_RUN entry: the empty roster does NOT require an
artifact tree whose logs are refused — a sessionless start reaches it directly,
so §8c's "the Direct stack always lists the live Session" reason was wrong
(the in-process port-level roster stays as the extra 80×24/44×20 pin). `Esc`
closes the picker back to the idle surface in every size.

## 9. Re-verification recipe

For V2/V3 (and for any later surface PR), the after-evidence must be produced
from the implemented panels, not from this document:

1. `pnpm build` in the worktree (the fork `dist` is an input to the tests).
2. Run the two existing suites; then, for a visual capture, drive the real
   composition at each size in the matrix and dump `vt.getViewport()` plus the
   `getCellFgRgb` cell map exactly as §1 describes.
3. Check at least: `200×50`, `120×40`, `100×40`, `80×24`, `80×10`, `72×24`,
   `44×20`, and one CJK-content case; dark + light + one custom palette;
   `iconStyle` `symbols` and `minimal`.
4. Report only the states that were really run; an unrun size is `NOT_RUN`,
   never PASS. Visual quality is the Owner/Reviewer judgement, not a test
   result.

## 8f. Real-terminal record — S4-D3 terminal capability truth (PR-D3)

Method: a real `tmux` session (`TERM=screen-256color`, `NO_COLOR` unset) ran the
worktree's built bundle through an ISOLATED `DSH_HOME` (a copied dev profile
linking `/home/xmoon/project/dsh-pi-tui-wt/s4-d3`; the user's `pi-tui` profile
was never touched). Keys were sent with `tmux send-keys` and the pane was read
with `tmux capture-pane -p`; the ANSI sequences were stripped for this record.
The screenshots below are excerpts of the physical frames.

### 8f.1 Plugin Manager — the exact B11 Detail (bounded copy + F10)

```text
# 120×40 — two-column projection, Detail scrolled to the capability group
Plugins · Ralph loops                                             23 plugins · 4 enabled
Plugins                                     [Details]
TUI & Extensions                            Ralph loops 0.2.1-rc.2 [experimental]
  @xmoon76/dsh-pi-tui            [current]  @deepseek-ai/dsh-experimental-ralph-bundle
...
Source
Availability    Installation
Origin          Official DSH
Current version 0.2.1-rc.2
Upgrade         Upgrade: Shipped with DSH. Upgrade the DSH installation to
                change this bundle version; Plugin Manager cannot update it
                in place.
...
Compatibility
TUI surface     ralph is a Host foreground tool; its workflow events and
                result use existing Tool/Activity views.
Risk            May run multiple rounds and incur model cost. No dedicated
                Ralph UI or guaranteed Job.
Actions
```

```text
# 80×24 — one-column projection at the first paint; the existing PgDn scroll
# reaches the same Compatibility/Actions block (verified in the scrolled frame)
Ralph loops 0.2.1-rc.2 [experimental]
@deepseek-ai/dsh-experimental-ralph-bundle
Official DSH catalog entry
‣ Status
Installed       No
...
Upgrade         Upgrade: Shipped with DSH. Upgrade the DSH installation to
                change this bundle version; Plugin Manager cannot update it in
                place.
```

```text
# 80×10 — short-screen body: the Detail scrolls with PgDn; the action bar is
# the physical last row in every frame
Compatibility
TUI surface     ralph is a Host foreground tool; its workflow events and result
────────────────────────────────────────────────────────────────────────────────
Enter action · / search · i install · c copy · r refresh · Esc back
```

Further PgDn presses reach the `Risk` line and the pinned `Actions` block; a
body that does not paint an action admits no Enter/click for it (the D1/D2
stale-hit rule is unchanged).

```text
# 44×20 — narrow projection; the same facts wrap by cells and stay complete
‣ Status
...
Compatibility
TUI surface   ralph is a Host foreground
              tool; its workflow events and
              result use existing
              Tool/Activity views.
Risk          May run multiple rounds and
              incur model cost. No dedicated
              Ralph UI or guaranteed Job.
Actions
> Enable…
  Back
```

The `Risk` line used the semantic warning ink and `TUI surface` the neutral
text ink; the left list kept one `>` cursor and the action block kept one
focused action at every size. The 80×10 scrolled frame's action bar remained
the last physical row (`Enter action · / search · i install · c copy · r
refresh · Esc back`) and no half word or partial chip appeared. The 72×24 frame
matched the 80×24 wrapping. No CJK identity exists in the official 14-bundle
catalog; the CJK/wrap proof is the `plugin-manager-workspace-visual.test.ts`
44-column case.

### 8f.2 Web Search / Fetch rows (existing settings, updated copy)

```text
# 80×24 — Share Original Question selected
> Share Original Question      [current] [default]
  Search / Fetch API Endpoint  https://api.deepseek.com/v1/tools
  DeepSeek API Key             [unavailable]
  (27/30)

Current: on · On (packed default for the DeepSeek Search API): each call also
sends up to 128 characters of the triggering human question (ori_question),
never the full history or system prompt. Off: never. A running operation is
unchanged.
```

The 44×20 projection wrapped the same sentence by cells and kept `Type to
search · Enter/Space to change · Esc to cancel` readable. The endpoint editor
kept its title, the full URL and `Enter confirm · Esc cancel`; the panel's
danger note stated that changing the endpoint sends the credential and query to
a different endpoint and that only a trusted HTTPS base should be confirmed.
This isolated profile already carried a custom `commandcode` search provider;
the row truthfully states the custom route rather than pretending it is one of
the official candidates. The default `Messages`/`HTTP` copy and the
`[current] [default]` chip ordering are covered by the VirtualTerminal matrix
(`settings-web-visual.test.ts`).

### 8f.3 NOT_VERIFIED / boundaries

- No real Tern GUI, physical mouse/trackpad, or native account was used. Mouse
  hit/cell behavior is covered by `plugin-manager-workspace-visual.test.ts`
  (`getCellFgRgb`, press/release, stale hit map), not by the tmux record.
- The tmux host profile had no credential and no paid Web/LLM call was made.
- Light/custom theme frames for the new copy are the existing palette-token
  assertions in `plugin-manager-workspace-visual.test.ts`; the tmux record is
  dark-theme only.
- Cross-platform terminals/OS and the final published-package matrix remain S5
  work.

### 8f.4 Review-delta re-verification — Auto footer and endpoint trust copy

The review-delta code snapshot (the commit immediately preceding this
docs-only record) required a fresh real-terminal capture for the two visible
strings that changed after the first §8f record:

1. `/permission auto` now keeps the effective permission fact in the footer
   (the B03 `auto` preset was missing from the builtin label map).
2. The Web endpoint row's Detail now says the operator must confirm a trusted
   HTTPS base and that the program checks the URL SHAPE, not the host's trust.

Method: the same isolated `DSH_HOME` (a copied dev profile linking this
worktree) with the published `@deepseek-ai/dsh-experimental-auto-review` rc.2
bundle added to that profile's bundle list; the worktree was rebuilt at the
reviewed code snapshot; `TERM=screen-256color`, dark theme; `tmux` 120×40 for
the Auto footer and 80×24 / 44×20 for the endpoint Detail; keys were sent with
`tmux send-keys` and the pane read with `tmux capture-pane -p` (ANSI stripped
for this record). The user's `pi-tui` profile was not touched.

```text
# 120×40 — after `/permission auto`; the footer's text-token ink is
# 38;2;224;224;224, the same `text` role used by the other permission labels
[auto]  [ollama/deepseek-v4.1-flash:1017-cloud @max]  dsh-pi-tui-wt/s4-d3        compact
↑0 ↓0  t0/s0
```

```text
# 80×24 — `/settings → Other → Web Search / Fetch`, endpoint row selected
> Search / Fetch API Endpoint  https://api.deepseek.com/v1/tools
...
Current: https://api.deepseek.com/v1/tools · The API base the
DeepSeek Search and Fetch APIs call (/search and /fetch are
appended); base-owned, not an Optional Bundle. Changing it sends
the credential and query there; confirm only a trusted HTTPS
base — the URL shape is checked, not the host's trust.
```

```text
# 44×20 — the same sentence wraps by cells; no half word or clipped trust fact
Current:
https://api.deepseek.com/v1/tools ·
The API base the DeepSeek Search and
Fetch APIs call (/search and /fetch
are appended); base-owned, not an
Optional Bundle. Changing it sends
the credential and query there;
confirm only a trusted HTTPS base —
the URL shape is checked, not the
host's trust.
```

Not run for this delta: the other §8f sizes for these two strings, a
light/custom-theme real terminal, physical mouse/trackpad, a Tern GUI, native
credentials and paid API calls. Those remain `NOT_VERIFIED`; the §11.2 matrix
for the full Plugin Manager Detail is the earlier §8f record.

### 8f.5 Review-delta re-verification — zero-body-row Enter hints (80×2)

The review found that a 0-row body frame still advertised `Enter` in the
action bar even though the D2 revoke path makes that activation a no-op. The
bar now drops every `Enter …` segment when the current frame painted no body
row, keeping the real Esc destination (and the keys that still resolve).

Method: the same isolated `DSH_HOME` (copied dev profile linking this worktree,
with the published rc.2 B03 bundle selected for the confirmation frame); the
worktree was rebuilt at the reviewed code snapshot; `TERM=screen-256color`,
dark theme. A `tmux` 140×40 session opened `/plugins`, then the window was
resized to 80×2 for the list frame; a second session opened the exact B03
`Auto Review safety confirmation` and was resized to 80×2. ANSI is stripped
for the record.

```text
# 80×2 — Plugin Manager list: no Enter invite; Esc close stays real
Plugins · All                                                       5/23 enabled
/ search · i install · Tab filter · r refresh · Esc close
```

```text
# 80×2 — B03 safety confirmation: no Enter cancel; Esc cancel stays real
Plugins · Auto Review                                               5/23 enabled
Esc cancel
```

The mounted VirtualTerminal suite covers the same rule for the list, Details
and confirmation paths (`test/plugin-manager-workspace-navigation.test.ts`) and
asserts that Enter cannot write from a zero-row Remove/confirm frame.

Not run for this delta: other sizes with a 0-row body, light/custom themes and
physical mouse/trackpad remain `NOT_VERIFIED`.
