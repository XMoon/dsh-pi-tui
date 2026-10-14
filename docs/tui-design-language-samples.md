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
> **The AFTER frames are design targets, not product output.** They were laid
> out by hand against the target spec and painted with the *real* theme tokens,
> so their colour is truthful while their geometry is a design statement. The
> real after-frames must be regenerated from the implemented panels in V2/V3
> and reviewed in a real terminal before this visual item can be called done.

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

The temporary dump files are not part of this PR; §7 records the recipe so the
after-frames can be regenerated the same way.

## 2. Sample matrix

| Surface | Size | State shown |
|---|---|---|
| Settings | `120×40` | wide three-pane, L0 categories focused |
| Settings | `120×40` | wide three-pane, L2 detail focused (commit status visible) |
| Settings | `80×10` | short screen, minimum chrome |
| Settings | `44×20` | narrow single pane, L2 detail |
| Job | `120×40` | Output page, running |
| Job | `120×40` | Output page, failed + gap + settled |
| Job | `120×40` | Command page |
| Job | `80×10` | short screen: facts row gone, facts in the bar |
| Job | `60×20` | narrow: compact tabs, metadata gone |
| Job | `44×20` | narrow: affordance yields to the command text |

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
**AFTER — target (real tokens)**

```text
Settings · Categories                                                                                    2 editable rows
Scope: TUI settings document · Refreshed 09:41 · Config ready
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
                                                                    Change…  Copy value [C]
⋮
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
**AFTER — target (real tokens)**

```text
Settings · Appearance · Configured theme                                                                 2 editable rows
Scope: TUI settings document · Refreshed 09:41 · Config ready
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
                                                                    Change…  Copy value [C]
⋮
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Enter change · ↑↓ scroll · r refresh · c copy value · Esc back
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
**AFTER — target (real tokens)**

```text
Settings · Categories                                            2 editable rows
Scope: TUI settings document · Refreshed 09:41 · Config ready
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
**AFTER — target (real tokens)**

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

**AFTER — target (real tokens)**

```text
Settings · Appearance · Configured theme                                                             2 editable rows
Scope: TUI settings document · Refreshed 09:41 · Config ready
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
Enter change · ↑↓ scroll · r refresh · c copy value · Esc back
```

This pair exists because it is the strongest single argument for the target ink table: in the BEFORE frame `Status  Not saved · settings namespace …` is painted in exactly the same terminal-default ink as `Value` and `Runtime` above it, so the one row that says the write was refused looks like every other fact. The target paints only the status **word** (`Not saved` in `error`, `Verified` in `success`, `Outcome unknown` in `warning`, `Saving…` in `textDim`) and leaves the reason `textDim`. Nothing else on this frame changes except the vocabulary the earlier pairs already listed.

### 3.6 Settings change list

| # | Before | After | Why |
|---|---|---|---|
| 1 | `SETTINGS` in `primary` | `Settings` in bold `textStrong` | `primary` must mean exactly one thing: active/actionable. It already paints links, inline code and picker cursors |
| 2 | Trails joined with ` · ` and `/`; `Refreshed 09:41 / Config READY` | one ` · ` join; `Config ready` | one separator per job; no ALL-CAPS words |
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
**AFTER — target (real tokens)**

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
s stop · Follow on · Find Ctrl+F · c copy output · v command · PgUp/PgDn · Esc back
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
**AFTER — target (real tokens)**

```text
Job · job-a · bash                                                                              ‣ Failed [GAP] [SETTLED]
Progress: 3/8 checks · Detail: Building components · Earlier output evicted
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
Follow on · [GAP] · Find Ctrl+F · c copy output · v command · PgUp/PgDn · Esc back
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
**AFTER — target (real tokens)**

```text
Job · job-a · bash                                                                                             ‣ Running
Progress: 3/8 checks · Detail: Building components
Full command                                                                                                Copy All [C]
Output  [Command] ──────────────────────────────────────────────────────────────────────────────────────────────────────
pnpm build && pnpm test:product

  --watch would go here, wrapped by the reader
⋮
rows 1-1/1
c copy all · Find Ctrl+F · PgUp/PgDn · Esc output
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
**AFTER — target (real tokens)**

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
**AFTER — 60×20 target (real tokens)**

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
**AFTER — 44×20 target (real tokens)**

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
At 44 columns the BEFORE frame cuts the command to `pnpm build && pnpm test:…` so that the `↗ Command` affordance can fit. The target drops the affordance instead (the summary row is itself clickable, and `v command` stays advertised), so the command fits in full. This is the "an affordance yields to its content" rule.


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
| 8 | Bar ` \| `; `Follow ON`; `S stop`; `V command` | ` · `; `Follow on`; `s stop`; `v command` | one separator, Title Case words, no bare uppercase letters |
| 9 | Command page repeats `Full command` in the status line | stated once | a status line states only facts not already stated above it |
| 10 | Facts drop after every hint | safety facts outrank verbs and browsing hints | a disclosure must survive a tight row |
| 11 | Bar started with `Esc back` / `Esc output` | both move to the TAIL | D8: the family puts `Esc` last everywhere (all overlays already do) |
| — | Follow/End, Find, search layering, copy sinks, Stop admission, body floor, tab hit map, observer lease | unchanged | vocabulary only |

## 5. Measured ink inventory (BEFORE) → target role

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

## 6. Responsive behaviour: before → after

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

## 7. Re-verification recipe

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
