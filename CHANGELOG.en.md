# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Task Quick now appends a distinct `➜ Open Task Center…` navigation row after
  real tasks when the Full Task Center is available. It shares selection and
  paging without becoming a task or affecting `showing x-y/N`, status counts or
  Footer badges. Enter or a same-row Fullscreen click first exits Quick and
  restores the Editor, then opens the same Full Task Center as `/tasks`. The
  regular main screen remains keyboard-only.

- The Task Quick window is now on-demand and lives UNDER THE WHOLE FOOTER:
  even with live tasks, the window occupies **zero rows** by default. It
  appears only when the cursor sits on the focused editor's last visual line
  (the last soft-wrapped segment of a non-empty multi-line draft included) and
  you press `↓`; `↑` at the first row or `Esc` returns to the editor with the
  draft and cursor byte-for-byte intact. When open it is the frame's LAST
  region, below the footer, with ONE `border`-ink separator rule as the
  Footer↔Quick boundary (the rule yields first when the task rows cannot all
  fit), followed by the identity row and at most three task rows. While
  open, `↑↓/PgUp/PgDn` move the selection across
  the whole task row set (first row selected, tail clamped, paging by the
  painted rows) and `Enter` — or a same-task-row click in fullscreen — opens
  the existing typed detail with the row's REAL identity (Job view, subagent
  viewer, parked Question reopen), never a Stop. Shell mode, autocomplete,
  history browsing and blocking modals keep `↓` for its editing meaning. The
  footer's `↓ view` hint now tracks the real admission (a disabled action or a
  blocking owner drops only the hint — the task count and `?N`/`!N` stay). On an
  extreme frame where the hint-enabled Footer candidate leaves no task row, both
  hint and `↓` entry are withheld without shrinking the Footer. The legacy modal
  Quick is retired: `↓` opens this on-demand window and
  `/tasks` remains the Full Task Center. The task panel's action bar also
  settles to the design language: `Enter open` leads, navigation and low-frequency
  management verbs drop as whole segments by priority, the real `Esc close` or
  `Esc back` remains last, and wheel scrolling/live task refreshes keep Enter
  within the painted task window. Advertised bindings use canonical keymap labels.
  Full Task Center rows now share one `‣` marker and semantic
  Title Case status word instead of a per-status glyph set.

- A Task Quick window now sits below the editor (sharing ONE live row budget
  with the Editor, the footer and the transcript: the editor seat, the
  status/footer, at least one transcript row and the existing plugin widget
  zones come first, and only the remainder goes to the window — so a long task
  list can never push the Editor or the Footer off screen; an extreme frame or
  an empty projection paints no row at all). Its rows are the SAME Task Runtime
  projection `/tasks` shows (Job roster, Subagent catalog and parked Question
  attention — never a second catalog), each row showing the task identity, its
  real mode and the `‣ Running` / `‣ Failed` / `‣ Awaiting answer` status
  words with the true `showing x-y/N` position. Passive painting, refresh,
  wheel and resize never change failure acknowledgement (`!N`) or a Question's
  answer state. In fullscreen the wheel scrolls only the window under the
  pointer; the regular screen stays keyboard-only.



- The experimental TSP renderer's `/preset` now uses the v4 two-page native flow: the
  catalogue is ONE native `cards` picker grouped `Built-in` / `Custom` with their counts,
  and every card carries the preset's name, its kind, a one-line summary and its real state
  badges (`Current`, `Next session`, `Default`, `Draft`); a broken declaration states its
  reason on its own card and stays readable but can never be written. The catalogue footer
  carries the THREE native buttons — `Close` on the left, `Set default` beside `Use next` /
  `Use session` on the right (the primary highlight) — as the panel's ONLY writer; a
  disabled button greys out and carries its reason as its tooltip. `Enter` (or a click on
  the selected card) opens the preset's single read-only Details page: the complete name /
  ID / type and scope sentence, its relation to the current session, the next session and
  the new-session default, the full description and failure reason, and — for a shipped
  preset — the official English "Mode details" and "How to use" sections INLINE as one
  continuous Markdown scroll (no third layer). The page opens with the native navigation row
  `← Back to presets · Esc`; the click, Enter and Esc all return to the catalogue keeping
  the search and the selection. Browsing, searching, reading and going back never write; while a write is in
  flight only `Close` remains, a refused write returns to the catalogue and states why, and
  long names, IDs and descriptions wrap completely and scroll to the end on the Details
  page.
- `Ctrl+R` history now declares its own boundary: one `─` above the identity row
  and one below the action bar (against the footer), so the seat is visibly
  bounded by the transcript and the status/footer. Both are preferred and may
  compress the Results/Preview regions, but a rule never costs the header, query
  or action bar, at least one result row or at least one Preview content row:
  when the budget cannot satisfy all of those the bottom rule is removed first,
  then the top one, and a loading/empty/failed state keeps its one status row. A
  rule never takes a transcript/footer row. This is an explicit Owner amendment
  (D15) of the design rule "at most two rules per frame".
- `Ctrl+R` history finished its visual and lifecycle closure: the title is
  `Input History` (Title Case), the active scope is a bold-`primary` `[Label]`,
  a result row uses a `primary` `> ` cursor with bold selected text (time and
  directory stay `textDim`), the Fullscreen actions are the bracket-less
  `Copy All [Alt+C]` / `Use Selected [Enter]`, the hint row degrades by whole
  segments (never mid-key, `Esc` always last), and no-match/loading and a failed
  load use different inks. When a new session is published — including reopening
  the same session id or a same-owner generation change — the old history seat
  closes immediately: Enter, copy and async search results from it are neither
  written nor shown in the new session, a seat cleanup failure cannot roll back
  the published session, and a Question / Approval / Save Location still parks
  and restores the SAME history seat once the last blocker settles.

- `Ctrl+R` history search no longer opens a centered floating overlay: it takes
  over the bottom editor seat, so the live Transcript and the status/footer stay
  visible and every width gets the same vertical layout (header with the scope and
  the `F2` hint, query, results, divider, Preview). The single-line results list
  follows the selection (at most 8 rows) and the Preview below it soft-wraps the
  FULL selected prompt with its own scroll position (`Alt+↑`/`Alt+↓` one row,
  `Alt+PgUp`/`Alt+PgDn` one page, `Alt+Home`/`Alt+End` first/last) — the `… more`
  truncation is gone. `F2` switches between the roughly 63% and 80% seat heights,
  and a short terminal yields the Preview and its hints before it hides the query
  or the selected row. `Enter` (or clicking `[Use selected]`) writes the entry back
  into the CURRENT editor and never submits; `Alt+C` (or `[Copy all]`) copies the
  entry's original text; `Esc`/`Ctrl+C` cancels and leaves the draft, cursor, input
  mode and any unexpanded paste content exactly as they were. The session identity
  is captured when the seat opens; after a session switch it neither accepts nor
  copies the previous session's content, and a search that resolves for that
  previous session is not shown as a current result. A window resize keeps the Preview on
  the same passage of the original text. The mouse is Fullscreen-only and left-button only:
  clicking a result only selects it, the wheel scrolls only the region under the pointer,
  and a Preview drag copies an exact fragment of the original text, ending at the released
  cell (a drag that leaves the preview, or a window-width change mid-drag, cancels instead
  of copying); the regular main screen
  stays keyboard-only and the terminal's own selection and scrollback are untouched.
- `/settings` now has consistent three-level keyboard navigation and same-pane
  editing. ASCII `Right` advances exactly one level, `Left` returns one level
  (inert at L0), `Enter` follows the same hierarchy, and `Esc`/`Backspace` step
  back and close at the outermost level; `Tab`/`Shift+Tab` remain inert. Wide
  terminals show three columns (categories / settings rows / details), medium ones
  the current level's two columns, and narrow ones a single column: all remain
  projections of the SAME `categories → rows → detail` levels. For the editable
  `Configured theme` and `Transcript display`, L1 `Right`/`Enter`, the painted
  `[Change…]` button, or ordinary visible Detail content opens the choice in the
  SAME L2 pane, with the current value and Runtime/Persisted facts above the
  candidates. `Up`/`Down`/`Home`/`End` move the candidate; `PgUp`/`PgDn` and the
  wheel over facts scroll only the fact region, while the candidate wheel scrolls
  independently. `Enter` or `[Confirm]` confirms explicitly; `Left`/`Esc`/
  `Backspace` or `[Cancel]` cancels directly to L1 without writing. If the selected
  candidate identity has scrolled out of view, the first Enter only reveals it;
  confirmation requires a later Enter. Even at 44×8 the old value, current
  candidate identity and explicit `Enter confirm` hint remain visible. Only
  buttons and candidates that are really painted can be clicked. The workspace
  shows the real Appearance / Display facts and each row's configuration Scope and
  backend readiness (`Ready` / `Last-known` / `Unavailable` / `Read error`); `R`
  re-reads, `C` copies only the selected row's exact source value, and browsing or
  picking writes no configuration. A confirmed change is stored through the
  existing serialized whole-document write path and then re-read from the
  authority: the Detail names the live runtime fact (`Runtime`) and the stored
  preference (`Persisted`) separately and states the commit as `Saving…`,
  `Verified`, `Not saved · <reason>`, `Commit accepted · verification unavailable`
  or `Outcome unknown · <reason>` — only a completed write whose authoritative
  re-read agrees is called Verified. A REJECTED write re-reads the authority first:
  a value that is still the previous one is reported as Not saved, while a value
  already in place (another writer may have set it first) or an authority that
  cannot be read is reported as Outcome unknown — never a claimed success, and
  never a refusal the authority contradicts. On a non-ready backend the theme is
  neither applied nor written; a display preset may already be live locally and
  then says so instead of claiming a save. A plugin theme is resolved again by its
  source-qualified identity at confirm time, so an unloaded plugin theme is listed
  as unavailable and refused rather than redirected to a same-named custom file.
  Icon style and Thinking detail stay read-only rows (their button row points at
  `Other settings`), and the existing complete settings editor remains fully
  available: `Other settings` → `Open existing settings…` retires the workspace
  and restores the surface it paused before opening the original editor, so Theme,
  the Plugin Manager, keybindings, permissions and extension settings keep every
  existing write path.
- A Job opened from the Task Center now renders in its own fullscreen workspace:
  the Job status, progress, output gaps, observation errors, terminal state and
  the retained output are presented as separate regions instead of one joined
  block, with a pinned bottom row (`Esc back` plus Stop only while it can act)
  and a disclosure that the retained output is a preview, not the full history.
  `Esc` returns to the same Task Center with its selected row, draft and scroll
  state, and the surface that was showing before (regular or fullscreen) is
  restored unchanged — leaving the workspace never rewrites the user's display
  preference. A Stop that is refused or cannot be confirmed now reports its
  result on the workspace's own notice row, instead of only on the surface the
  user has left (on a very short terminal the status and `Esc back` keep their
  rows first).
- The Job workspace Output is now really browsable and searchable:
  `PgUp`/`PgDn`, `↑`/`↓`, `Home`, the mouse wheel and the scrollbar move only the
  Job output — never the background transcript, the Task Browser or the editor
  input. Opening a Job follows the newest output, any manual browse pauses that
  follow, and only an explicit `End` resumes it; a newer snapshot, a shrinking
  body or a terminal resize never silently re-arm it, and the bottom row follows
  the state: `Follow ON`, or `Follow PAUSED` (with the `End` resume hint while
  `End` can act — while the query is being edited it is omitted, because `End`
  belongs to the input there). `Ctrl+F` (or whatever the live keymap really
  binds) and `/` search only the CURRENT retained Job output: every hit is
  highlighted with the current one emphasised, `i/N` and `0/0 · No matches` are
  shown, `Enter` switches to result navigation where `n`/`N` cycle the hits, the
  first `Esc` leaves only the search (the Job stays open and follow stays paused)
  and the second `Esc` returns to the Task Center; while a search owns the
  ordinary keys the bottom row no longer advertises Stop, and while the query is
  being edited it also omits the Find/End hints, because those keys belong to the
  query input there.
- The Job workspace gained a Command reading page: a shell (`bash`/`pwsh`) Job
  opens it with `v` or by clicking the `Command:` summary in the header, showing
  the ORIGINAL command text unmodified (indentation, tabs, trailing spaces and
  line breaks included) with its own scrolling and Find, plus mouse drag-selection
  of any original fragment; `C` or a click on `[Copy All]` copies the whole
  original command once, and `Esc` returns to the Output page without closing the
  workspace. Non-shell Jobs still show only `Label:` and never get a fabricated
  Command page. On the Output page `C` copies the retained output as of that
  keypress. Both copies go through the existing local clipboard strategy: success
  reads `Copy sent`, failure reads `Copy failed`, and the message never claims the
  system clipboard was confirmed (OSC52 has no acknowledgement). An empty
  retained output answers `Nothing to copy`, and a not-yet-observed or
  unavailable one answers `Output unavailable`: neither writes the clipboard and
  neither reports a false success. Terminal control sequences inside the Job
  metadata (`label`/`detail`/`progress`) are only ever shown as sanitized text in
  the workspace header and notice row (a Stop settlement embeds the Job label
  there) and are never passed to the terminal from those rows. The Command page
  suspends the terminal's native copy-on-select while it is shown, so a rapid
  double click on `[Copy All]` cannot overwrite the full command with a screen
  word.
  When the retained window is truncated, a paused view keeps the same
  still-present row where it can, the bottom row number is a position inside this
  retained preview only, and `[GAP]` still comes only from the official fact.
- The Job workspace now has a clear visual hierarchy: the top row always shows the
  fixed `JOB` marker, the Job identity, a themed status dot and the UPPERCASE
  status plus the independent `[GAP]`/`[ERROR]`/`[SETTLED]` markers; real progress
  and detail get their own row next to the output-gap and observation-error
  reasons. Under the title, clickable and readable `Output` / `Command` reading
  tabs (the current one bracketed; `Out`/`Cmd` on narrow terminals) switch pages
  exactly like `v`/`Esc`; the command entry is the right-aligned `↗ Command`, and
  the command page is titled `Full command` with `Copy All [C]`. The log body keeps
  the terminal's own background — no card or second frame — and a wide terminal
  gets one rule row under the body with "retained preview, not full history" plus
  the real preview line numbers; where that row does not fit, the bottom bar keeps
  the same disclosure, never both at once. Very narrow or short terminals drop the
  optional rows in a fixed order, always keeping at least one body row for the
  current page and a reachable `Esc`; at `80×1` only the bottom `Esc` remains. A
  live theme switch applies immediately.
- The Footer's Performance item gains the whole-Session rate and shows both
  scopes in the default layout: the speed placement now defaults to
  `speed-both` (`R5 116 · All 44 tok/s`), with `speed-all` (`All 44 tok/s`)
  available on its own. Under width pressure it collapses to its leading fact
  (`R5 116t/s`, or `All 44t/s` when no recent sample exists) and then drops by
  importance; the legacy `speed` / `full` / `latency` styles in saved layouts
  keep their meaning, and the `/status` detail line shows TTFB, R5 and All.
- The performance facts now come from the TUI's own Host `piTuiPerformance`
  projection: identical on Direct and Remote and unaffected by reconnects or
  local paging, while the main session and a viewed child each show their own
  Session's figures. A scope with no eligible sample is omitted — never
  `0 tok/s`.
- The experimental TSP renderer's `/model` is now ONE **list-first** catalogue at
  every window width: the wide provider sidebar, the side details column and the
  bounded `Open model & effort ›` card are gone. The catalogue is a single native
  picker whose rows carry the model name, a short Provider mark, the real
  `current`/`default` badges and the complete model id, grouped as
  `Current · Default` first and then by Provider. Below the list the catalogue
  paints its OWN **Reasoning Effort strip**: one button per candidate the
  highlighted model advertises, with the model's current draft marked — so the
  frequent task (choose the model, set its effort, confirm) happens on ONE page. A
  strip click, or putting the keyboard on the strip with `Tab` and using its arrow
  keys, changes only that model's local draft, and a model that advertises no
  effort shows no strip at all. The explicitly named `Switch` (live session) or
  `Save default` (sessionless) commits ONCE from the footer at EVERY width, so
  switching the whole model needs no second page; a row click only moves the
  highlight, and clicking the highlighted row (or `Enter`) opens that model's
  read-only **Full details** page directly: there is no intermediate page and no
  second-level effort menu. `Esc` follows one ladder on the catalogue: it clears a typed
  SEARCH first (the panel stays open with the query emptied, and the keyboard stays in the
  zone it was in) and closes only once there is nothing left to clear — in the list, the
  effort strip and the action bar alike, with `Tab`/`Shift+Tab` moving between the zones.
  A read that fails as a whole leaves exactly ONE Retry (the bar's): the list's partial-failure
  row exists only while the catalogue is really ready, and its failure information stays as
  read-only context. The catalogue, its layer and that page now keep ONE node
  identity for the panel's whole life (a per-frame id made the client remount the list,
  which moved the whole viewport when a lower model was clicked), so the native scrollbar
  and wheel stay available and clicking a visible row no longer moves the viewport. The notice at the top of that page is now inked by what it
  reports — an error for a write that was refused, unsupported or threw, information for
  a cancellation — where write-outcome notices used to read as information. The window no longer grows with the terminal either: the
  catalogue always asks for the client's medium dialog (measured, the `lg` sheet
  filled 1120x698 of a 1280x800 pane — 87% of both axes — where the medium one is
  680x540, the same choice the official product's own pickers make), and the client
  shrinks it by itself below that cap. The catalogue asks for no preview region any
  more (the client reserves a fixed share of the sheet for one and the read-only
  summary that used to live there was a single line). The read-only Full details page is a native Reader
  whose facts are grouped into Identity / Configuration / Description: each value
  is ONE complete string wrapped by the client at the real width (an unbroken
  identifier by character, a description by word with its blank lines preserved),
  `↑`/`↓`, `PageUp`/`PageDown` and `Home`/`End` drive the native scroll to the very
  end, and only its visible `Back` row or `Esc` returns to the page it came from
  (`Esc` is the way back from the tail, where the row has scrolled away). The page
  has no submit entry at all and a forged submit is refused. A partially failed
  read lists its providers under `Unavailable providers` with ONE read-only
  `Retry failed providers` row, so the footer keeps its two buttons. The former
  `More actions` page, `Action: …` strip, `Operation` block, Provider scope column,
  the vague `Confirm` verb and the compact-list "no write" rule are all removed;
  the write is still the same single business operation and the read still has the
  same single owner. Re-verified in a real Tern pane (0.8.3): the presenter's own
  layout claim against the client's preview classes at every supported size, both
  footer buttons fully inside the bar at the 400px floor, exactly one write per
  click, and the Reader's complete values, keyboard scrolling and return. Still NOT
  verified: the 400px floor and the wide layout under +25% / +50% enlarged UI fonts
  (the pre-existing Owner-accepted limitation), wheel/trackpad scrolling, IME,
  themes and the Remote path — see the real-pane and not-verified sections of
  `docs/tern-tsp/model-selection.md`.

- The fullscreen Settings workspace now speaks the same visual language as the
  rest of the TUI: the header reads `Settings · <trail>` (a bold identity word and
  a dim trail instead of a blue `SETTINGS` brand word), the diagnostic line's
  status word is Title Case with a semantic colour (`Ready` / `Stale` /
  `Unavailable`), pane focus uses the same bracketed bold-blue device as the Job
  tabs, and the column titles read `Categories (3)` / `Rows (2)` / `Details`.
  Detail values no longer fall back to the terminal's default foreground: the
  primary value takes one ink and secondary facts a weaker one, while the commit
  status word (`Verified` / `Not saved` / `Outcome unknown` / `Saving…`) carries
  its own semantic colour — a refused write no longer looks like a successful one.
  The current value is marked with a `[current]` state chip, and a row with two
  states paints two chips. Detail actions read `Change…`, `Retry save`,
  `Copy value [C]`, `Confirm` and `Cancel` instead of bracketed verbs, and the
  pinned action bar joins hints with ` · `, keeps `Esc` last and drops whole
  segments by priority instead of cutting a hint mid-word. L2 choosing keeps the
  focused multi-column title unless it would replace the only content row; its
  keyboard Copy is available only while `c copy` is painted. At 44×8, a long
  identity may reclaim the optional chooser heading and excess facts (never the
  original `Value` row), but cannot be confirmed until the full identity and
  `Enter confirm` are visible together.

- The fullscreen Job workspace now speaks the same visual language as the rest of
  the TUI: the header reads `Job · <id> · <kind>` (a bold identity word and a dim
  trail); the status reads `‣ Running` / `‣ Failed` — ONE East-Asian-width-neutral
  marker plus a Title Case status word, instead of `●` with ALL CAPS and instead
  of a glyph per status — and the metadata line reads
  `Progress: … · Detail: … · Error: …`, dropping a fact whole inside its reserved
  half row instead of cutting it mid-word. The reading-facts row loses its two
  flanking rules and becomes a dim status line (disclosure left, position right),
  and the Command page no longer repeats `Full command`. The pinned action bar
  joins with ` · `, keeps `Esc` last (with the highest drop priority), spells its
  facts `Follow on` / `Follow paused` and its bare key letters lowercase
  (`s stop`, `c copy output`, `Tab switch`), and takes the weakest readable ink; a
  right-aligned entry such as `↗ Command` or `Copy All [C]` is painted only while
  the whole content fits beside it, so a narrow row keeps the output and leaves no
  dead click region.

- The Job workspace now uses `Tab` to switch between its Output and Command pages
  in **both** directions (the former `v` open verb is removed and doing nothing);
  the action bar advertises `Tab switch` on both pages, while the mouse paths (a
  tab click, the summary row's `↗ Command` entry) and `Esc output` returning to
  Output are unchanged. While a Find owns the ordinary keys the toggle yields, as
  it did before. Copying the current page's exact original moved to a bare `c`
  (the key that really acted was `Shift+C` while the bar wrote `C`), matching the
  Settings workspace and the `Copy All [C]` / `Copy value [C]` badges exactly.

- The "current value" state in the `/settings` Theme submenu and the `/preset` picker
  is the `[current]` state chip instead of the literal `← current`: both pickers use
  ONE position (the row's value slot), and its ink is pinned to the weakest token in
  BOTH selection states. The preset's `default` state moved out of the description too
  and sits beside it as a `[default]` chip — two states are two chips, a plain space
  apart. A chip is now painted whole or not at all: on a narrow terminal the LABEL
  yields and is clipped with `…`, instead of the chip being cut in half or pushed out
  of the row by a long preset name. An over-wide name keeps BOTH ends on its label
  (head…tail around one `…`) instead of only its head, and that abbreviation is a
  drawing fact: the row's COMPLETE name stays its search basis, so a keyword from the
  middle of a long name still finds it.

- The pickers (the `/model` overlay and its family) now speak the same visual
  language as the workspaces: the selection cursor is `>` in `primary` — asked from
  `selectListTheme.selectedPrefix` instead of being inlined, and no longer the
  colourless bold EAW-ambiguous `→ `; the hint line capitalizes its key tokens,
  lowercases its verbs and keeps `Esc` last (`↑↓ model · Enter effort/select · Esc
  close`); the title row carries only the title (bold) with the count right-aligned
  in the weaker ink on the same row instead of a suffix (dropped whole when it does
  not fit); a group header splits into its label and its count in two weaker inks
  instead of one bold span; the `current` / `default` row states are the
  `[current]` / `[default]` state chips whose ink stays the weakest one even on a
  selected row; and a failed catalog paints its failure word `error` while an
  ordinary empty filter stays muted. Two states on one row are two chips a single space apart;
  ` · ` stays the chrome / grouped-badge separator. The selected row's text is bold `textStrong`
  instead of a colourless bold default, and the badge's effort value is painted its own
  secondary ink (`textDim`): a nested span's reset ends the outer colour for everything
  after it, so a pre-painted state chip used to leave that value in the terminal's
  default colour. The
  settings-list family's cursor glyph follows (`›` → `>`).

### Fixed

- A skill's slash command no longer disappears after a new or switched Session
  (`/new`, `/resume`, `/fork`): the catalog refresh no longer treats the TUI's
  own compatibility mirror as a genuine Host command, so the skill stays in the
  completion list and `/name args` still runs as a skill. A genuine same-name
  Host command keeps winning the name.
- A command that was offered by the completion list but the target Session does
  not actually provide now returns the COMPLETE original input (staged
  attachments included) to the editor when it is refused — the submitted words
  are never swallowed, and a draft typed while the refusal settles stays ABOVE
  the restored text.
- Input submitted after a Session switch but before its recall history is
  reloaded no longer vanishes from ↑: the reload merges the inputs the Session
  already accepted with its disk rows, in order and without duplicates, and the
  previous Session's entries still never appear in the new Session's history.
- While a Question / Approval / Save Location captures the input, the Footer no
  longer advertises the Task Center `↓ view` (the narrow-screen `↓`), which
  could not act there. The hint returns once the modal settles, the editor is
  empty and the other conditions still hold; the parked `?N` and failure `!N`
  figures stay visible throughout. The hint is also withheld while
  `app.tasks.open` is explicitly disabled or while `↓` has been given to
  another action (a keymap change applies immediately) — the footer never
  promises a key the router no longer resolves.

## [0.5.1] - 2026-10-08

### Installation and version pairing

This stable release moves the exact DSH family used for development and
compatibility validation to the published `0.2.0-rc.2`, and the runtime peer
floor rises to `>=0.2.0-rc.2`; installing DSH requires explicitly allowing its
native install scripts:

```sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty @deepseek-ai/dsh@0.2.0-rc.2
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.5.1
dsh --profile pi-tui
```

Users who must keep an older DSH: `@deepseek-ai/dsh@0.2.0-rc.1` and `0.1.7-rc.2`
use the released `@xmoon76/dsh-pi-tui@0.5.0`; `@deepseek-ai/dsh@0.1.7-rc.1` uses
`@xmoon76/dsh-pi-tui@0.4.8`.

### Added

- **Terminal-native progress and status reporting.** `/settings → Terminal
  progress` turns from a switch into four modes: `9;4+7501` (default), `9;4`,
  `7501` and `Off`. On top of the existing OSC 9;4 progress bar, the default
  also reports the Agent's semantic state through OSC 7501 (working, waiting
  for approval, waiting for an answer, done, error, idle): done/error is
  reported once a real run's last turn result is proven, an interrupted or
  cancelled run returns to idle, a proven final state is retained until exit,
  and a temporary handover (`$EDITOR`, a fullscreen round-trip) clears the live
  state first. Switching modes takes effect immediately, and a persisted `On`
  reads as the dual-protocol default. Both protocols are generic terminal
  protocols, not tied to one terminal: other terminals show whatever they
  support.

- **The pane's working directory follows the current Session (OSC 7).** It is
  re-reported after startup, a session switch, a fullscreen round-trip and an
  `$EDITOR` round-trip; a Direct session without an official cwd falls back to the
  launch directory, and a DSH Remote backend publishes nothing — a Host cwd is
  never leaked into the Client terminal (currently enabled only for terminals
  identified as Tern).

- **The subagent viewer now treats the child session as a real display subject
  and adds a single-line subject bar.** While a viewed child session is on
  screen, its model/preset/permission, context pressure and window, cumulative
  token usage, todos and working directory all come from that child session's
  own session state (`model ?` while the child has no model yet — never the
  parent's model) and update the moment their event lands; the main session's
  identity head card is hidden while viewing and returns on exit. The subject
  bar sits under the header and shows `‹ back`, the child label, `● running` /
  `○ inactive` and the child's own `provider/model @effort`; the old
  `[viewing subagent · …]` marker and the footer `view-scope` identity block no
  longer render (legacy custom layouts still load/edit/save). The extension API
  gains the optional `session.displaySubject` projection for the viewed child;
  the released session-snapshot semantics are unchanged — plugins still see only
  the live/main session, so entering or leaving a viewer never looks like a
  session switch.

- **Optional official Git commit attribution guidance (off by default).** When
  enabled, the Agent is instructed to add
  `Co-Authored-By: @xmoon76/dsh-pi-tui <dsh-pi-tui@xmoon.org>` to commits it
  creates; the `product-model` mode additionally adds
  `Assisted-By: <provider>/<model>`. This is Agent guidance, not
  repository-level enforcement: no Git hooks are installed, no commands are
  rewritten, no repositories are probed, and manual commits stay untouched.

- **Compact collapses settled historical process spans to their header.** Only
  the live or Preparing newest span of the current window keeps its `Think:` /
  `Action:` previews; a settled historical span collapses to its header (the
  `N actions · …` statistics stay), and a historical think-only span shows
  `Thought <duration>`.

- **Context entries that have arrived but not yet entered the model history are
  visible in the conversation tail.** A finished background job, a subagent
  settlement or another non-user Context no longer waits silently: it shows one
  bounded preview row in the original Context/User/Context order, leaves as soon
  as the Host takes it over, and never pulls the viewport away from where you are
  reading.

### Changed

- **The Question tool's input semantics converge to selection / editing /
  progression.** Multi-select questions toggle checkboxes with `Space` (or
  digits / clicks), while `Enter` only continues like `→` (skipping when
  unanswered); free text saves live, so an un-Enter-ed draft survives `Esc` and
  cross-question navigation; a saved custom answer shows its value on revisit
  (masked questions show bullets). Hints now read
  `space toggle · ↵ continue/review`.

- **The top header is strictly ONE physical line.** The session title is
  ANSI/CJK/emoji-safe truncated to the remaining cell width (ellipsized, then
  dropped when no cell remains) and no longer wraps at any width or display
  preset — a very long main title (especially while a child viewer is open) can
  no longer push the editor and pinned chrome off screen.

- **A mid-turn notice inside a collapsed Focus now renders outside the Thought.**
  The opening notice that woke the turn stays before the Thought; notices that
  arrive mid-turn (a background job finishing, a subagent settling) now render
  after the collapsed Thought (in raw chronological order when expanded) and
  stay reachable through full-text search.

- **Scrolling and repainting are faster in large sessions.** Plain scrolling and
  paging at a history boundary no longer remeasure the whole transcript
  geometry; a measured session of ~1.6 MB of text showed ~80% lower per-frame
  scroll CPU (an observation, not a CI threshold). Scroll, click and copy
  semantics are unchanged.

- **Command and settings discovery copy states conditional capabilities
  truthfully.** `!`/`!!`, the `/settings` local-shell sandbox row, `/title`,
  `/login`, `/logout`, `/transcript`, `/attach` and `/model` now spell out the
  "requires backend / Host support" condition; registration and behavior are
  unchanged.

### Fixed

- **A long user message can be expanded and collapsed symmetrically.** A single
  click anywhere on a collapsed bubble expands it, and a single click anywhere on
  an expanded bubble collapses it (the tail `▴ Collapse` control stays
  available); drag selection remains intact. Regular long-user markers advertise
  the effective key as `expand/collapse`.

### Compatibility

- **The DSH dependency baseline moves to the published `0.2.0-rc.2` family as a
  whole.** Every `@deepseek-ai/dsh-*` peer floor rises to `>=0.2.0-rc.2`, and the
  development/source qualification target pins exact `0.2.0-rc.2`. This line's
  Question lifecycle depends on contracts published only in rc.2 (the
  `userQuestions` Remotes and Session projection), so rc.1 and older families are
  no longer inside this line's declared compatibility range; older runtimes
  should pick their paired TUI line from the installation table above.

> **Known limitations:** Direct is still the production default; Remote is this
> project's own experimental composition that requires explicit configuration and
> its Host extension, and this release does not promise general availability. The
> OSC 7 pane working directory and the OSC 9;4 "waiting for input" refinement are
> currently enabled only for terminals identified as Tern.

## [0.5.0] - 2026-09-28

### Installation and version pairing

This stable release moves the exact DSH family used for development and
compatibility validation to the published `0.2.0-rc.1`; the runtime peer floor
stays `>=0.1.7-rc.2`, and the upgrade advice plus recovery command for old
runtimes now point at `0.2.0-rc.1`. Installing DSH requires explicitly
allowing its native install scripts, and `--allow-scripts` converges to the
three packages that genuinely run scripts (DSH `0.2.0-rc.1` pins Koffi to
`3.1.1`, so fresh Linux installs no longer need the remaining allowlist
entries):

```sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty @deepseek-ai/dsh@0.2.0-rc.1
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.5.0
dsh --profile pi-tui
```

Users who must keep an older DSH: `@deepseek-ai/dsh@0.1.7-rc.2` can keep the
released `@xmoon76/dsh-pi-tui@0.4.9` (this release keeps the same floor, so
upgrading to this version also runs); `@deepseek-ai/dsh@0.1.7-rc.1` uses
`@xmoon76/dsh-pi-tui@0.4.8`; the older `@deepseek-ai/dsh@0.1.6-alpha.2` uses
`@xmoon76/dsh-pi-tui@0.4.7-alpha.2`.

- **The official native implementation of the session write lease is confirmed
  as the `@deepseek-ai/node-addon-system/flock` prebuilt family, and this
  repository retires the obsolete `fs-ext` manual-build workaround.** Isolated
  install and compatibility environments no longer modify the official
  distribution; a missing native payload fails loudly as a distribution
  problem instead of a consumer-side node-gyp patch. DSH Source Mode
  validation likewise moved to the `0.2.0-rc.1` release commit and fully
  passed (the previous release waived it because the upstream rc.2 source
  tree could not self-clean).

### Fixed

- When many subagents are tracked, the Task Center no longer starts several full
  descendant traversals for one burst of lifecycle/tool/job/open invalidations:
  invalidations arriving while a refresh is in flight are coalesced into a single
  trailing refresh, so a new subagent is no longer pushed back by a refresh
  storm. The cost of one upstream recursive traversal is unchanged by this fix.

## [0.4.9] - 2026-09-25

### Installation and version pairing

This stable release moves the DSH compatibility target to the published
`0.1.7-rc.2` (peer floor `>=0.1.7-rc.2`): rc.2 retires the rc.1 preset
chooser-policy contract, introduces exact current-availability admission plus a
background default save for in-session model switches, and records dynamic tool
updates inside an already-running session. `0.4.8`/rc.1 remains the previous
released pairing; this line is a deletion-based adaptation on top of rc.1, not a
stacked compatibility branch. Installing DSH requires explicitly allowing its
native install scripts:

```sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs,fs-ext @deepseek-ai/dsh@0.1.7-rc.2
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.4.9
dsh --profile pi-tui
```

To keep an older DSH runtime, install the TUI line paired with it:
`@deepseek-ai/dsh@0.1.7-rc.1` uses `@xmoon76/dsh-pi-tui@0.4.8`,
`@deepseek-ai/dsh@0.1.6-alpha.2` uses `@xmoon76/dsh-pi-tui@0.4.7-alpha.2`, and the
older DSH `0.1.5-rc.1`/`rc.2` family uses `@xmoon76/dsh-pi-tui@0.4.6`.

### Added

- **`/plugins`: manage the active profile's plugins and bundles from the TUI.** The new Plugin Manager drives the official DSH Plugin Manager and lists packages in classified sections: the `dsh-pi-tui` bundle currently providing this surface (Current TUI — read-only and self-protected, so it cannot be disabled/removed from its own screen); packages that are exactly associated with a live TUI extension contribution (TUI Extensions); and every other ordinary DSH plugin (DSH Plugins). It shows bundle metadata, declared plugin rows, enabled/read-only/removable state, compatibility errors and the configured registries, and performs enable/disable, remove (with a confirmation bound to the exact package identity) and install. Installation first runs the official inspect to show the package and the selected registry, then streams progress and logs with safe cancellation; closing the panel never cancels an install, reopening resumes the same request, and a lost response is reconciled through the official `waitForInstall` instead of installing twice. `/settings` gains a `Plugins  Manage…` row that lazily opens the same surface.

- **`/tasks`: open a Job to see non-consuming live output.** The Job detail now shows status, progress and the retained output tail through the official Job Controller `follow()` stream, and says so explicitly when earlier output was evicted. This is a read-only preview: it never consumes the model's `job_output` cursor, never affects completion notices, and never becomes session history. Esc returns to the same Task Center and Stop behavior is unchanged.

- **Startup no longer looks like a dead terminal: `Starting DSH…` while the Host Loader settles.** When an optional plugin keeps the Host Loader from settling (for example a remote MCP server whose initial connect or `tools/list` never answers), the TUI now writes a single `Starting DSH…` line before it starts waiting and clears it as soon as the Loader settles; non-TTY output stays silent. No timeout, no skipping a pending plugin, no half-composed Agent — the global readiness wait is simply visible.

### Fixed

- **`/quit`, `exit` and Ctrl+C no longer fail retirement with `retire phase failed ... phase=cancel` (`cannot read inbox state: its projection registration is not active`).** An interactive exit now cancels the current Direct Agent's first work synchronously BEFORE requesting `appExit`, so the Host root teardown can no longer unregister the inbox projection ahead of the later cancel; `idle → descendant drain → flush → dispose` still complete inside the watchdog-bounded `appExit` disposal, and the exit never awaits the full Host teardown. The cancel is deduplicated by Agent object identity, so the new Agent of a committed session transition is still cancelled, and a first cancel that throws is not recorded as done — the real retirement retries it.

- **A live Agent that loses its standing preset composition now fails loudly instead of silently addressing the model with a truncated request.** The profile mounts the official `@deepseek-ai/dsh-invariants` registry (enabling exactly the `@deepseek-ai/dsh-agent-preset-registry` check) plus the official `agent-preset-registry/invariant` companion: as soon as a live Agent is no longer joined to any preset, the next prompt assembly fails loud instead of sending a tool list that had collapsed to `subagent` alone. The TUI still does not remount, reparent or recreate an Agent — preset lifetime stays DSH-owned.

- **The exit resume hint no longer names the wrong profile when the TUI was started with the positional `dsh <profile>` form.** The hint used to scrape `process.argv` for `--profile`; under `dsh <name>` the launcher only synthesizes that flag for its own argument parsing and leaves `process.argv` untouched, so the hint fell back to the hardcoded `pi-tui` — wrong for `dsh tui`, `dsh rescue`, or any other non-`pi-tui` profile. It now reads the Host's official `profileContext.name`, which is correct for `--profile <name>`, `--profile=<name>`, `dsh <name>` and `--from-default-profile <name>` alike; only a profile-less mount (tests, an embedded surface) still falls back to the argv scrape.

### Improved

- **Task Center renames the user-visible `All` scope to `Tracked` and clarifies the footer job denominator as the current tracked roster.** A direct `/tasks` now opens the full Task Center on `[TRACKED]` (`A` toggles `ACTIVE` ↔ `TRACKED`; Quick→Full still preserves `ACTIVE`), making explicit that it lists the work the Job Registry / Subagent catalog currently tracks, not the session's execution history: DSH `0.1.7` temporarily registers foreground `bash`/`pwsh` work while it runs (observable and stoppable), removes the record when the command completes inside the foreground wait so the row leaves the Task Center with the registry (the Transcript tool card keeps the execution history), while handed-out background jobs stay visible in `TRACKED` after settlement as long as the registry retains them. The footer's job denominator (preferred density now reads `1/3 tracked jobs`) is likewise the current registry roster — it may shrink when upstream removes a record — never a session lifetime total (compact density keeps `1/3j`). No job history cache was added and background job retention is unchanged.

- **`/preset` is a normal command adjudicated by the official registry alone.** rc.2 retired the rc.1 `modeSelectionEnabled` deployment-visibility policy, so `0.4.9` deletes the whole TUI-side policy layer (the DTO field, the Direct/Remote adapter branches, the command-visibility cache and its background probe): `/preset` appears in completions and `/help` whenever the command catalog is healthy, and selectability is decided only by the official `agentPresets` registry at execution time. `/preset default <id>` validates and then persists without reading any policy roster, and a blank in-session switch still goes through the official select. After upgrading to rc.2, any leftover field in an old profile is ignored by DSH; the TUI never migrates or deletes it.

- **An in-session `/model` switch no longer waits for the default save.** The Direct session switch now matches rc.2: it first admits the exact current provider/model availability, normalizes through the official call config, commits `model/selection`, and returns immediately; the global-default save becomes best-effort background work whose failure is only diagnosed — it never rolls back the choice and never blocks the picker. The TUI's old default-write generation/reassert ordering is gone; overlapping writes are serialized by the official `AgentDefaultModel`. On the same Agent, an image-bearing prompt admission (including an explicit `/skill`) shares the official per-Agent serialization window with a `/model` switch: overlapping switches apply in call order, an image capability check can no longer pass under a model a concurrent switch already replaced, and text-only prompts stay unserialized.

- **rc.2 dynamic tool updates: a running session records official `developer/message` tool updates and the TUI tolerates them safely.** When the DSH Agent loop records `tool-addition`/`tool-removal` for a tool-registry change, `Session.toolHistory()` is the sole authority; the TUI invents no card and keeps Ctrl+F search, export, fork/rewind and all three display projections stable, with new regressions for very long multibyte tool output and for the next prompt after a long session. Note: enabling or disabling a bundle/plugin row through the Plugin Manager inside an installed profile returns the official rc.2 `restart-required` outcome (never a silent hot-apply), which the TUI presents as-is — this release makes no "no Session recreation required" hot-apply claim.

## [0.4.8] - 2026-09-24

### Installation and version pairing

This stable release moves the DSH compatibility target to the published
`0.1.7-rc.1` (peer floor `>=0.1.7-rc.1`): TUI preferences move into the
profile-owned plugin configuration, agent presets switch to the official
declarative registry, and background jobs, the sandbox shell, the task center,
and the remote read surfaces adopt the rc.1 runtime contracts. Installing DSH
requires explicitly allowing its native install scripts:

```sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs,fs-ext @deepseek-ai/dsh@0.1.7-rc.1
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.4.8
dsh --profile pi-tui
```

To keep an older DSH runtime, install the TUI line paired with it:
`@deepseek-ai/dsh@0.1.6-alpha.2` uses `@xmoon76/dsh-pi-tui@0.4.7-alpha.2`, and
`@deepseek-ai/dsh@0.1.5-rc.2` uses `@xmoon76/dsh-pi-tui@0.4.6`; the older DSH
`0.1.1-rc.1`/`rc.2` uses `@xmoon76/dsh-pi-tui@0.3`.

### Added

- **Compatible with DeepSeek Harness `0.1.7-rc.1`: settings move to profile-owned plugin configuration and agent presets switch to the official declarative registry.** TUI preferences (theme, footer, display preset, notifications, key bindings, …) now live in the `tui-app` plugin's profile configuration; `/settings` changes apply immediately and persist per field. Existing preferences in the legacy `settings.yaml` migrate automatically on first start (including the Focus-preference convergence into display presets); the migration only reads the legacy file, is retryable, and never overwrites values changed after migration. The agent preset roster is now the official `standard` / `ptc` / `minimal` / `cordis` declarations (default selection and "set as default" are adjudicated by the Host), and the guessed alias mapping for the legacy `code` default is gone. The minimum runtime is now `dsh 0.1.7-rc.1`: background jobs, the sandbox shell, the task center, and the remote read surfaces adopt the rc.1 official runtime contracts (session-owned jobs, the shell execute/result lifecycle, official projections and job rosters for the task center) with existing interactive behavior unchanged.

- **Two independent communication settings: Progress updates and Response style.** `/settings` now separates the mid-turn update cadence (Milestones default / Frequent / Off) from the visible answer's density (Default / Concise / Explanatory); the next model step picks up the change without restarting the agent. Preferences are saved across sessions, never affect each other or the display preset, and Focus only suppresses the effective progress section (the saved cadence is untouched) while the response style stays active in Focus.

- **Long user messages collapse.** A text-only prompt longer than 10 terminal
  visual rows renders its first 4 rows, one
  `── N rows compacted · … to expand ──` marker, and its last 3 rows; `Ctrl+O`
  expands and collapses the long prompts within the most recent 3 USER turns, and
  fullscreen can expand a single message by clicking that marker row or a search
  hit. In fullscreen an expanded prompt gains a tail `▴ Collapse · …` control
  that collapses it with a plain click, and long input in the `steering…` lane
  folds by the same visual-row rule with its status line always visible. The
  decision uses the wrapped visual rows at the current width (CJK and emoji count
  their real cells) and is recomputed after a resize. Disclosure keeps the
  viewport — follow-latest keeps following and historical browsing stays on the
  same semantic row — and the tail control is fullscreen-only and never copied
  into the clipboard. Known limitation: a search jump expands the matched message
  but does not scroll onto the exact matched row.
- **A fullscreen `↓ Latest` hint.** Once the fullscreen transcript leaves the live
  tail (manual scroll-up or a browsed history window), the bottom shows a
  clickable `↓ Latest · <key>`; it takes the same path as `Ctrl+End` straight back
  to the GLOBAL latest and disappears again at the tail.
- **`/model` is now an immediate, searchable palette.** The panel opens at once
  with `Loading models…` and fills in place when the directory read settles;
  provider is a group only, one search covers provider/model names and ids, and
  `Enter` on a reasoning model focuses the inline effort on the same row
  (`←`/`→` pick, `Enter` commits, `Esc` returns). DSH session and global-default
  model semantics are unchanged.
- **`/settings` "Subagent allowed models" uses the same searchable grouped
  list.** `Enter` toggles an allowed route directly; the official whole-section
  write, last-route guard, serialized writes, and failure rollback are unchanged.
- **The Job detail overlay has its own bottom action hint.** A running job shows
  `S stop · Esc back`; once the job settles the Stop hint disappears and its key
  becomes a no-op, while `Esc back` stays visible under a long body, a short
  terminal, or a narrow width.
- **Accepted but not yet landed input stays visible and reads the official
  durable inbox projection.** A submitted steering or queued prompt shows a
  client-local echo in the queue pane or the conversation tail until its
  authoritative transcript lands; the echo is correlated with the authoritative
  message by request id, never by text, and recovers after a reconnect or
  restart. A writer held by another DSH instance or context now surfaces
  actionable quit-and-retry guidance instead of an internal diagnostic.

### Changed

- **Compact and Focus now share one collapsed `Think:` + `Action:` vocabulary, and both headers count `actions`.** The collapsed card no longer understands only genuine tool calls: the `Action:` slot shows the latest non-Thinking TURN-OWNED Process evidence in chronology — a genuine tool call, a live Preparing call, an LLM retry, or an unpaired tool-result diagnostic (honestly rendered as `Unpaired … result`, never disguised as a successful call). The header follows with `N actions · subtype ×count` (e.g. `7 actions · read ×3 · bash ×2 · +1`, where `+1` counts the remaining action SUBTYPES): a genuine tool contributes its `callCount` (a merged read group is still two calls), a retry occurrence contributes one, an orphan result and Preparing contribute nothing, and `ask_user_question` / `exit_plan_mode` stay owned by their interaction panel — neither occupying the Action slot nor counting. Focus and Activity share one classifier, selection rule, formatter and subtype ordering; singleton stats such as `1 action · read ×1` are never special-cased away. Tool stays the strict underlying semantic: a retry does not become a tool.
- **A `subagent/descriptor` no longer produces a transcript card at all.** It is the CHILD session's identity record (version / mode / provider / label), and a continuable child logs it BEFORE its first `turn/start` (upstream asserts `descriptorIndex < turnStartIndex`), so it belongs to no model turn. The child viewer keeps showing the child's label/mode/activity from its own authoritative state while the transcript body carries no synthetic `Subagent` identity card; the parent's own genuine `tool/call name=subagent` remains the delegation evidence and carries the Action. Old-window `N tool calls` counts no longer include descriptor rows.
- **A slash command is a real standalone transcript node with its own disclosure.** A command's lifecycle is session-level: DSH appends `command/run`/`command/done` as direct log-only events with **no model turn opened for them**, and the settled result renders outside model history (`/compact [running]` → `/compact [ok]`). The command card is an INDEPENDENT row: it is never an Activity member (it splits the surrounding Process run), never enters the `N actions`/`N tool calls` stats, and is never swallowed by the collapsed Focus `Action:` slot or Thought — so the common "agent finished, user runs `/compact` while idle" case keeps its feedback visible. Its fold stays independent of the Focus root, a long outcome stays operable (folded one-line preview, expanded full body), command-only sessions stay visible and searchable, and Ctrl+F reveals pre-turn/inter-turn/tail commands through the anchored window. A manual `/compact` fuses with its compaction card through the official `sourceCommandId`/`sourceEventSeq` relationship only (never name/text/adjacency matching): the compaction card becomes the single visible owner while the command's name/args/outcome stay searchable through it.
- **The Activity card loses its identity icon, and container chrome loses its outer indent.** The user-visible name stays `Activity` (the internal owner kind is unchanged) but its identity no longer varies by icon style: `▸ Activity` / `▾ Activity` (the `🧰` / `✦` glyphs and their icon semantic are removed), identified by the disclosure marker and the name alone. Focus, Activity, the pending Activity card and the Context cluster drop their decorative two-cell outer indent, so a collapsed container header and its expanded canonical rows share one transcript left edge (no more "collapsed indented, expanded flush" inversion). Genuine INTERNAL indentation stays: Thinking bodies, Tool payload/result insets, PTC child/grandchild trees, assistant/user wrapped continuations, and the standalone Context cards' (notice / relay / recall) own body — their header sits flush while the summary/payload, the relay body and its long-message marker are indented 2 cells, matching the Tool card's payload inset. That indent is applied after the body wraps at the reduced content budget, so a narrow terminal never overflows just to keep the lead.
- **The Activity header now shows the process span's OWN wall-clock duration.** The timing is a presentation-only sidecar sourced entirely from session event times (thinking, tool call/result, plus point evidence from retries), aggregated inside the existing single summary walk; running cards tick with the existing repaint heartbeat (no per-card timers), missing evidence omits the duration (never a fake `0s`), a consecutive-read group that spans turns drops its timing so an Activity span never crosses a turn boundary, and the Preparing → durable tool-call handoff keeps the earliest authoritative start so elapsed seconds no longer reset from `3s` to `0s`. Token usage stays on the Focus header (a turn-level fact); Activity aggregates a Process span, has no trustworthy per-span usage attribution, and therefore NEVER displays, estimates or allocates tokens.
- **Compact's Action slot now shows PTC active sub-calls like Focus.** For example `Code · Bash ×2 running`; width degradation preserves the running state before sacrificing root description text, and nested child start/settle refreshes the collapsed Activity card immediately.
- **Transcript-detail vocabulary convergence.** The `/settings` "Tool output" row becomes "Transcript detail" (Bulk expansion for recent collapsible transcript content); the Ctrl+O description becomes "Expand/collapse recent transcript detail" and Alt+T becomes "Expand/collapse thinking detail" (disclosure, not visibility); the Display description now reads "…Compact folds contiguous process into Activity spans"; `/help` uses the same wording with effective key labels.
- **The Advanced API gains `advanced.host.setTranscriptDetailExpanded()`.** The previous `setToolsExpanded()` remains as a deprecated alias driving the same runtime state (never a second field).
- **Fullscreen scrolling is smoother in large sessions and under Focus/Compact.** Pure scroll/repaint frames no longer remeasure the whole transcript geometry and rebuild per-row click identities every frame: the snapshot is rebuilt only when content, disclosure, image loading or terminal size actually changes (geometry epoch). Scroll frame time drops by roughly 37% on ~1500-block sessions, 27% under expanded Focus and 16% under Compact; click and copy hit semantics are unchanged (a press/release pair whose cell shifted between frames is still rejected).

- **Transcript disclosure, search and viewport now converge on one owner and reveal model.** Every hidden region has one operable owner on the current surface: the regular surface uses the shared `Ctrl+O` master for Work, Context clusters, ordinary folds, long/pending-user folds and the assistant delivered-files tail; when that key is unavailable (remapped away or disabled) those folds all fail open and no un-openable header or `(ctrl+o to expand)` hint is rendered. Delivered files have their own per-owner capability: fullscreen Compact/Focus, or any surface without the key, simply shows every file. Thinking stays Alt+T-owned and equally fails open (no compact card, no dead hint) on a regular surface without an effective Alt+T key. Expanded Focus now presents each contiguous Process run as an independently collapsible nested `Work` container (collapsed by default on fullscreen, openable by mouse or temporary search reveal; regular Focus keeps it fully revealed while its Thought is expanded), and an explicit Thought collapse returns that turn's nested Work to Compact depth. A mouse click on an internal blank row now collapses the NEAREST shared container (nested Work beats the outer Thought, a cluster-internal blank collapses the cluster, a boundary/global blank is inert). Search reveal is now a container path: navigation temporarily opens every hidden ancestor without writing manual state, an ordinary dismiss promotes those owners atomically, and an explicit collapse revokes the temporary reveal; search only reveals a genuinely hidden match (a fail-open or already-visible row mints no owner). Disclosure transitions still reuse the existing semantic viewport transactions (no second viewport model).
- **Conversation display now has one canonical Full/Focus/Compact preset state.** `/display` is the primary control and `/focus` remains compatible.
- **The Compact display preset is now available.** `/display compact`, the `display-preset` setting, and a persisted `displayPreset: compact` all activate Compact for real: the conversation and Assistant intermediate output stay visible in chronology, contiguous reasoning/tool process folds into `Activity` spans with Header + Think + Action previews (click or `Ctrl+O` to expand the raw process rows, with `Ctrl+O` as the bulk owner), injected `notice` / `relay` / `recall` context becomes standalone presentation (producer summary, Agent message, Session recall), and adjacent ambient injections (instructions/catalog/snapshot) collapse into an expandable Context cluster. Compact remains opt-in; the default is unchanged.
- **The Context cluster header now shows both the disclosure state and the Context identity.** The collapse/expand marker (`▸`/`▾`) is followed by the Context identity icon: `▸ 📎 Context · N injections` under emoji, `▸ ⋅ Context · N injections` under symbols, and `▸ Context · N injections` under minimal (the decorative icon disappears with no dangling space). The `Activity` header follows the marker-only rule instead (no Context-style identity icon).
- **Collapsed Focus absorbs mid-turn process notices into the Thought.** A `notice` that arrives while the Agent is already working (a background job finishing, a subagent settling) no longer occupies its own row: it is folded into the collapsed Thought and fully restored in raw chronology when Focus is expanded. A notice in the turn's opening foundation stays visible (it explains why the Agent resumed) and a mid-turn `relay` stays independently visible. A hidden mid-turn notice remains reachable through full-text search, which reveals it temporarily and restores the collapsed view on dismiss without creating new manual expansion state.
- **Rebuilding the presentation when search opens no longer scales quadratically with history size.** In a large session, the search-reveal re-projection now resolves the reveal owner once per projection epoch, with a benefit that grows with the history length.
- **Settled `ask_user_question` and `exit_plan_mode` (Plan review) cards are now surfaced as human-interaction evidence instead of being folded into Process.** Both are identified by tool identity only — the authoritative set is exactly these two, no new semantic class, and the set is never widened because a card looks rich or once required an approval: under Compact they become `Work` boundaries and render standalone (never counted toward the span tool count or the Tool preview); collapsed Focus hoists them out of the Thought like a user/steer or surfaced-context row (raw relative order, never across the committed-answer/steer ordering fence); expanded Focus restores their exact raw position; Full is unchanged. Their own expand/collapse is independent of the Focus root (collapsing the root does not reset them) and reuses the existing tool-card interaction (fullscreen click; the regular surface fails open per the existing capability). A still-running question or plan review is untouched — its panel keeps sole ownership and no duplicate settled-style card appears — and partially answered, skipped, cancelled or errored question cards stay independently readable. Every other tool (todo/goal/subagent/workflow/schedule/cordis/bash/edit/…) stays ordinary Process.
- **Question / Approval keep response ownership while read-only context inspection remains available.** While a response modal is open, fold, Thinking disclosure, fullscreen jump-latest, Todo presentation, and proven fullscreen presentation hits remain usable through direct or leader-bound inspection triggers; fixed Question / Approval response keys take precedence over conflicting global inspection remaps, while submit, session changes, and lifecycle actions remain protected.
- **Full-text search in long sessions is much faster.** Typing and stepping
  with `Enter`/`Shift+Enter` now rebuild the transcript tree at most ONCE per
  operation and no longer re-measure or re-render the entire window for every
  character; a same-window jump is near-instant and a cross-window jump performs
  exactly one necessary re-projection.
- **Rendered search matches are reused per live card.** When a card's rendered
  lines are unchanged, repeated navigation reuses its complete match results;
  changing the query rescans only the cached corpus, and changed card content
  rebuilds that corpus automatically without changing semantic `N/M` identity.
- **Anchor-only results navigate near usable rendered hits when possible.** In
  fullscreen, source-local or card-level rendered candidates are brought into
  view; a range that is already fully visible is left alone instead of being
  snapped back to a fixed position. Approximate navigation never upgrades a
  result to strong highlight and falls back to the honest source anchor when no
  rendered candidate exists.
- **The current search result is more prominent and follows the theme.** A
  provable current occurrence uses an explicit themed foreground/background
  block instead of relying on the terminal's inverse attribute; a
  source-anchored-only hit instead washes a weaker background over its owning
  card/source row, while every other hit stays weakly underlined — prominence
  never disguises an occurrence as "proven".
- **The transcript stays browsable and interactive while the search box is
  open.** In fullscreen you can keep scrolling with the wheel / `PageUp` /
  `PageDown`, drag the scrollbar, select and copy text, and expand/collapse
  cards with the mouse while the search box keeps keyboard focus
  (`Home`/`End`, `Ctrl+U`/`Ctrl+D` and typing still belong to the box); the
  editor, submit and other modals stay blocked by the search box.

- **Quick Tasks is now navigation-only.** The Footer `↓` Quick Tasks view
  responds only to the arrows, `Tab`, `Enter`, and `Esc`; every other key is a
  no-op (`S`/`/`/`T` no longer arm a stop, enter search, or switch views), `N` /
  `Shift+N` and Quick's `T` shortcut into the full view became the bottom "Open
  Task Center" row plus `Enter`, and the full Task Center gains `Shift+Tab`
  reverse type cycling.
- **Interrupted parked steering is presented accurately with its recovery path.**
  After the active turn is interrupted, a steering row still parked in the inbox
  reads `waiting for next turn…` and is consumed by the official next-wake
  semantics on the next ordinary prompt; an empty Ctrl+S then explains the
  recovery instead of silently no-opping.
- **The Focus header shows the real run state.** An open turn reads `Working`,
  `Waiting for approval · 12s`, or `Waiting for input · 12s`, and settles on
  `Turn complete`; time spent waiting on the user no longer counts toward the run
  duration.
- **The Focus compact Tool row uses the tool identity plus the official
  description.** A foreground Bash call shows `Bash · <description>` and a
  background card shows `<tool name> · <content description>`; an unknown custom
  tool keeps its raw name, and the full command stays in the expanded tool card.
- **A short fullscreen opens the Todo panel with 3 rows.** On terminals with at
  most 16 rows the compact Todo panel shows 3 items (5 otherwise), re-derived
  from the current height on resize.
- **Fullscreen drag selection and `/copy` share one clipboard policy.** Both
  attempt the terminal OSC 52 leg and the native helper leg independently, and a
  helper success no longer suppresses OSC 52; this fixes remote setups (e.g.
  ORCA/xterm.js) where a selection was copied to the remote host's clipboard.
- **File edit/write diff cards follow the official bounded contextual diff.**
  Shared context lines are no longer misreported as additions or deletions and
  sparse edits in large files stay exact; only a fragment past the official
  bounded edit search (256 edits) degrades to a coarse replacement, with the
  folded `+N/-M` totals derived from the same source as the expanded body.
- **A Task Center Job detail returns one level, and capturing-overlay focus
  restoration is unified.** Opening a Job **status detail** from Quick Tasks or
  the full Task Center returns with `Esc` to the same Task Center instance
  (selected row, scroll, filter, search, and disclosure preserved) before a
  second `Esc` returns to the editor; a subagent job that resolves to a child
  session still opens that transcript directly. After a close, a restored
  **capturing** overlay regains keyboard focus and the focused seat, a
  nonCapturing notice does not take focus or suppress its siblings, and a
  Question / Save Location settle or a fullscreen swap is an internal restore
  that keeps the current logical hierarchy, visibility and focus intent, and
  front order.
- **`/fork` and `/rewind` now use the official DSH Host fork semantics.** The
  Host owns the completed-turn cut, child identity, lineage, workspace, and
  model/preset composition; Direct and Remote follow the same semantics. A
  running `/fork` fixes its cut at fork admission instead of waiting for the old
  turn to finish, and if navigation is superseded, the published child remains
  available from the session list. The official Host fork cannot represent an
  empty-prefix child, so rewind is no longer offered for the first user turn.
- **Workspace membership is now shared with the Web surface.** The TUI profile
  mounts the official workspace service, and `/fork` of a session that belongs to
  a workspace puts the child in that same workspace, where Web lists it.

### Fixed

- **The collapsed Think preview no longer freezes on the first line.** In both the running and settled states the Think slot reads the latest logical line of the bounded reasoning tail: while streaming the window follows the right edge (the latest token stays visible), and when settled it head-truncates the latest line (previously a multiline reasoning body always rendered its first line, so the UI looked stuck while reasoning continued). Focus and Compact share one preview implementation via the new compact-process-preview authority module.
- **Restoring an old session no longer crashes when an injected-context source is missing or malformed.** A log row whose context source is empty or not an object degrades safely to a standalone generic Context row; unknown or future context forms are never mistaken for ambient injections and never fabricate a summary or sender.
- **Ctrl+F full-text search now works per occurrence, not per card.** The `N/M`
  counter and `↑`/`↓` step through every occurrence inside one card. Every
  visible match is marked weakly; the current occurrence uses the strongest
  style ONLY when its semantic occurrence can be proven to map to a rendered
  occurrence, otherwise it is anchored to the owning source region without a
  strong highlight (never a wrong one). Fullscreen follows the same rule
  instead of jumping to the window bottom.
- **Closing search keeps the current position and representable disclosure.** Closing with
  `Esc` or the search toggle no longer returns to the window that was visible before
  search; a card, Thought, PTC path, or Workflow Run/Phase temporarily opened to show
  the current result remains open when it has an existing user disclosure owner.
  Search highlights, search-only rows, reveals without a durable owner, and content the
  user explicitly collapsed during search are still cleared. `Ctrl+End` still returns
  explicitly to the latest content.
- **A session switch no longer leaves the previous search's current hit
  behind.** A new session never inherits the old session's search highlight or
  temporary reveal.

- **A failed TUI startup is no longer silently treated as an optional plugin
  failure.** When startup commits but the `tui-app` row never mounted, the bundle
  prints an actionable error and **exits nonzero**, never a warning-plus-success
  with a lingering process.
- **Preset-selection visibility follows the deployment policy.** With
  `modeSelectionEnabled` set to `false`, `/preset` no longer appears in the slash
  candidates or `/help` while typing it still fails closed under the official
  policy; an unavailable roster keeps the current presentation.
- **Fullscreen historical scroll position is no longer pulled back to the tail.**
  When the queue pane, other chrome, or a terminal resize changes the viewport
  height, a view that had scrolled away from the live tail keeps its position;
  only an explicit scroll to the end resumes following.

### Compatibility

- **PTC/workflow runtime aligned with the official composition.** The `ptc`
  preset receives its PTC runtime from the official `ptc-runtime` row, the TUI no
  longer inserts the retired `code-runtime-worker-thread` row, and the host-plane
  workflow row is aligned to the official `workflow-ptc`. This release's DSH peer
  floor is `>=0.1.7-rc.1`; a runtime below it gets its paired TUI line and the
  exact npm upgrade target from the startup notice.

> **Known limitation:** The production default backend remains Direct; remote attach is not supported.

## [0.4.7-alpha.2] - 2026-09-18

### Installation and version pairing

This release moves the `next` npm line's DSH compatibility target to
`0.1.6-alpha.2` (peer floor `>=0.1.6-alpha.2`). Its native install scripts must
be explicitly allowed:

```sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs,fs-ext @deepseek-ai/dsh@0.1.6-alpha.2
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.4.7-alpha.2
dsh --profile pi-tui
```

To keep an older DSH runtime, install the TUI line paired with it:
`@deepseek-ai/dsh@0.1.6-alpha.1` uses `@xmoon76/dsh-pi-tui@0.4.7-alpha.1`, and
`@deepseek-ai/dsh@0.1.5-rc.2` uses `@xmoon76/dsh-pi-tui@0.4.6`.

### Changed

- **The DSH compatibility target moves to `0.1.6-alpha.2`.** Client Session lifetime now uses the official explicit reference ownership (`retain` / `release`), so the runtime peer floor rises to `>=0.1.6-alpha.2`. A Harness still on `0.1.6-alpha.1` gets an actionable startup upgrade notice (and may keep using the published `0.4.7-alpha.1` TUI line).
- **Pending input now reads the official durable inbox projection.** Queued/steering rows no longer depend on a transient in-session queue snapshot and recover after a reconnect or restart; a writer held by another DSH instance or context now surfaces actionable quit-and-retry guidance instead of an internal diagnostic.
- **`/fork` and `/rewind` now use the official DSH Host fork semantics.** The Host owns the completed-turn cut, child identity, lineage, workspace, and model/preset composition; Direct and Remote follow the same semantics.
- **A running `/fork` fixes its cut at fork admission.** It no longer waits for the old turn to finish; if navigation is superseded, the published child remains available from the session list.
- **Workspace membership is now shared with the Web surface.** The TUI profile mounts the official workspace service, and `/fork` of a session that belongs to a workspace puts the child in that same workspace, where Web lists it.
- **Rewind is no longer offered for the first user turn.** The official Host fork cannot represent an empty-prefix child.
- **Long user messages now collapse in both directions.** In fullscreen, an expanded prompt gains a tail `▴ Collapse · …` control that collapses it with a plain click (no longer `Ctrl+O` alone); long input in the `steering…` lane folds by the same visual-row rule with its status line always visible. Disclosure keeps the viewport — follow-latest keeps following and historical browsing stays on the same semantic row. The tail control is fullscreen-only, is never copied into the clipboard, and regular keeps `Ctrl+O` as its collapse owner without injecting terminal-native-selectable chrome into the scrollback.

## [0.4.7-alpha.1] - 2026-09-17

### Installation and version pairing

This release moves the `next` npm line's DSH compatibility target to
`0.1.6-alpha.1` (peer floor `>=0.1.6-alpha.1`). Its native install scripts must
be explicitly allowed:

```sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs,fs-ext @deepseek-ai/dsh@0.1.6-alpha.1
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.4.7-alpha.1
dsh --profile pi-tui
```

To stay on the older DSH `0.1.5-rc.1`/`0.1.5-rc.2`, keep the stable
`@xmoon76/dsh-pi-tui@0.4.6`; for the older DSH `0.1.1-rc.1`/`rc.2` use
`@xmoon76/dsh-pi-tui@0.3`.

### Added

- **Long user messages collapse by default.** A text-only prompt longer than 10
  terminal visual rows renders its first 4 rows, one
  `── N rows compacted · … to expand ──` marker, and its last 3 rows, so a
  trailing instruction stays visible; `Ctrl+O` expands and collapses the long
  prompts within the most recent 3 USER turns, and fullscreen can expand a single
  message by clicking that marker row or a search hit. The decision uses the
  wrapped visual rows at the current width (CJK and emoji count their real cells)
  and is recomputed after a resize. Known limitation: a search jump expands the
  matched message but does not scroll onto the exact matched row.
- **A fullscreen `↓ Latest` hint.** Once the fullscreen transcript leaves the live
  tail (manual scroll-up or a browsed history window), the bottom shows a
  clickable `↓ Latest · <key>`; it takes the same path as `Ctrl+End` straight back
  to the GLOBAL latest and disappears again at the tail.
- **`/model` is now an immediate, searchable palette.** The panel opens at once
  with `Loading models…` and fills in place when the directory read settles;
  provider is a group only, one search covers provider/model names and ids, and
  `Enter` on a reasoning model focuses the inline effort on the same row
  (`←`/`→` pick, `Enter` commits, `Esc` returns). DSH session and global-default
  model semantics are unchanged.
- **`/settings` "Subagent allowed models" uses the same searchable grouped
  list.** `Enter` toggles an allowed route directly; the official whole-section
  write, last-route guard, serialized writes, and failure rollback are unchanged.
- **The Job detail overlay has its own bottom action hint.** A running job shows
  `S stop · Esc back`; once the job settles the Stop hint disappears and its key
  becomes a no-op, while `Esc back` stays visible under a long body, a short
  terminal, or a narrow width.
- **Accepted but not yet landed input stays visible.** A submitted steering or
  queued prompt shows a client-local echo in the queue pane or the conversation
  tail until its authoritative transcript lands; the echo is correlated with the
  authoritative message by request id, never by text.

### Improved

- **Quick Tasks is now navigation-only.** The Footer `↓` Quick Tasks view
  responds only to the arrows, `Tab`, `Enter`, and `Esc`; every other key is a
  no-op (`S`/`/`/`T` no longer arm a stop, enter search, or switch views), `N` /
  `Shift+N` and Quick's `T` shortcut into the full view became the bottom "Open
  Task Center" row plus `Enter`, and the full Task Center gains `Shift+Tab`
  reverse type cycling.
- **Interrupted parked steering is presented accurately with its recovery path.**
  After the active turn is interrupted, a steering row still parked in the inbox
  reads `waiting for next turn…` and is consumed by the official next-wake
  semantics on the next ordinary prompt; an empty Ctrl+S then explains the
  recovery instead of silently no-opping.
- **The Focus header shows the real run state.** An open turn reads `Working`,
  `Waiting for approval · 12s`, or `Waiting for input · 12s`, and settles on
  `Turn complete`; time spent waiting on the user no longer counts toward the run
  duration.
- **The Focus compact Tool row uses the tool identity plus the official
  description.** A foreground Bash call shows `Bash · <description>` and a
  background card shows `<tool name> · <content description>`; an unknown custom
  tool keeps its raw name, and the full command stays in the expanded tool card.
- **The collapsed Thinking preview follows the reasoning tail.** While reasoning
  streams, the one-line compact preview always shows the newest token, clipping
  overflow from the left, driven only by real reasoning deltas; a settled row
  still reads from the start of its line.
- **A short fullscreen opens the Todo panel with 3 rows.** On terminals with at
  most 16 rows the compact Todo panel shows 3 items (5 otherwise), re-derived
  from the current height on resize.
- **Fullscreen drag selection and `/copy` share one clipboard policy.** Both
  attempt the terminal OSC 52 leg and the native helper leg independently, and a
  helper success no longer suppresses OSC 52; this fixes remote setups (e.g.
  ORCA/xterm.js) where a selection was copied to the remote host's clipboard.
- **File edit/write diff cards follow DSH 0.1.6's bounded contextual diff.**
  Shared context lines are no longer misreported as additions or deletions and
  sparse edits in large files stay exact; only a fragment past the official
  bounded edit search (256 edits) degrades to a coarse replacement, with the
  folded `+N/-M` totals derived from the same source as the expanded body.
- **A Task Center Job detail returns one level, and capturing-overlay focus
  restoration is unified.** Opening a Job **status detail** from Quick Tasks or
  the full Task Center returns with `Esc` to the same Task Center instance
  (selected row, scroll, filter, search, and disclosure preserved) before a
  second `Esc` returns to the editor; a subagent job that resolves to a child
  session still opens that transcript directly. After a close, a restored
  **capturing** overlay regains keyboard focus and the focused seat, a
  nonCapturing notice does not take focus or suppress its siblings, and a
  Question / Save Location settle or a fullscreen swap is an internal restore
  that keeps the current logical hierarchy, visibility and focus intent, and
  front order.

### Fixed

- **A failed TUI startup is no longer silently treated as an optional plugin
  failure.** When startup commits but the `tui-app` row never mounted, the bundle
  prints an actionable error and **exits nonzero**, never a warning-plus-success
  with a lingering process.
- **Preset-selection visibility follows the deployment policy.** With
  `modeSelectionEnabled` set to `false`, `/preset` no longer appears in the slash
  candidates or `/help` while typing it still fails closed under the official
  policy; an unavailable roster keeps the current presentation.
- **Fullscreen historical scroll position is no longer pulled back to the tail.**
  When the queue pane, other chrome, or a terminal resize changes the viewport
  height, a view that had scrolled away from the live tail keeps its position;
  only an explicit scroll to the end resumes following.

### Compatibility

- **PTC/workflow runtime aligned with the official 0.1.6 composition.** The `ptc`
  preset receives its PTC runtime from the official `ptc-runtime` row, the TUI no
  longer inserts the retired `code-runtime-worker-thread` row, and the host-plane
  workflow row is aligned to the official `workflow-ptc`.

> **Known limitation:** The production default backend remains Direct; remote attach is not supported.

## [0.4.6] - 2026-09-13

### Installation and version pairing

This stable release keeps the same DSH compatibility range as 0.4.5: the minimum
is `0.1.5-rc.1`, and `0.1.5-rc.2` is also compatible. We recommend rc.2; its
native install scripts must be explicitly allowed:

```sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs,fs-ext @deepseek-ai/dsh@0.1.5-rc.2
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.4.6
dsh --profile pi-tui
```

Do not pair this release with the historical DSH `0.1.3-alpha.2` line. Users who
must keep an older DSH should install the matching historical TUI: use
`@xmoon76/dsh-pi-tui@0.4.1` for DSH `0.1.2-rc.1`,
`@xmoon76/dsh-pi-tui@0.4.3-alpha.2` for DSH `0.1.3-alpha.2`, and
`@xmoon76/dsh-pi-tui@0.3` for the older DSH `0.1.1-rc.1`/`rc.2` line.

### Added

- **Explicit delivered-file presentation.** `present` tool cards now show a human-readable file list, while the final assistant answer summarizes the delivered paths and descriptions in a compact turn tail.

### Fixed

- **Focus live presentation stability.** Streaming Markdown in expanded Focus no longer jitters when content height grows or shrinks; historical updates, preparing-tool transitions, completion, and Focus/fullscreen changes release stale height baselines correctly while preserving explicit user scroll intent.

> **Known limitation:** The production default backend remains Direct; remote attach is not supported.

## [0.4.5] - 2026-09-11

### Installation and version pairing

This stable release has a minimum DSH version of `0.1.5-rc.1` and is also
compatible with `0.1.5-rc.2`. We recommend rc.2; its native install scripts
must be explicitly allowed:

```sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs,fs-ext @deepseek-ai/dsh@0.1.5-rc.2
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.4.5
dsh --profile pi-tui
```

Do not pair this release with the historical DSH `0.1.3-alpha.2` line. Users
who must keep an older DSH should install the matching historical TUI: use
`@xmoon76/dsh-pi-tui@0.4.1` for DSH `0.1.2-rc.1`,
`@xmoon76/dsh-pi-tui@0.4.3-alpha.2` for DSH `0.1.3-alpha.2`, and
`@xmoon76/dsh-pi-tui@0.3` for the older DSH `0.1.1-rc.1`/`rc.2` line.

### Added

- **PTC / `run_code` nested tool tree.** Sub-calls inside a `run_code` program now
  render as a recursive tree under the root Code card instead of scattered top-level
  tool rows; Focus, `/search`, and Markdown export preserve the nesting and show a
  compact active-child hint.
- **Session presentation aligns with DSH Session semantics across V2/V3 persistence generations.**
  Live answers, tool results, Thinking, and cold-resumed sessions now render consistently;
  Focus, Transcript, and Stats no longer duplicate transient stream content.
- **`/search` converges into the Session Browser.** `/sessions`, `/resume`, and
  `/search` share one global view for session metadata and content; older sessions
  are searchable, and metadata filtering remains available when content search fails.
- **Unified attachment intake.** `@` mentions, `/image` arguments, and pasted content
  now share one pipeline, keeping image, file, placeholder, and draft submission
  behavior consistent.
- **Inline `/skill` references complete in drafts.** `/name` tokens can complete from
  the detached skill catalog; acceptance inserts only the reference, and the final
  ordinary prompt lets the Host inject the recognized skill.
- **Scalable Workflow UI.** Run/Phase cards show members for small runs and aggregate
  summaries, abnormal previews, and a filterable Task Viewer for large runs; completed,
  cancelled, and interrupted states are presented distinctly.
- **Workflow lifecycle/model parity with DSH alpha.2.** Workflow preserves complete run
  and member statuses, with cold replay, live records, search, and `/transcript` using
  the same result model.
- **`/export` saves the full Session archive.** The command now produces the
  official full Session-tree archive (descendants + attachments) and asks
  for a Client-local save directory after the command succeeds; the file
  name is fixed to the full Session id. The old single-log JSONL export is
  gone.
- **New `/transcript` command.** Saves a readable Markdown transcript of the
  current Session to a Client-local directory, with the same
  no-argument/save-location UX as `/export`.
- **Welcome card visual refresh.** The session-head card now shows an original round-backed whale ASCII mascot (five variants, one picked per process) with three responsive layouts: side-by-side (whale left, facts right) at 72+ columns, stacked (whale centered above the facts) at 24–71 columns, and a compact text layout (🐋 title) below 24 columns. The whale keeps a fixed cyan → blue brand gradient that does not follow theme switches; facts still render in full (long values wrap, never truncate); the idle invitation, the `setWelcomeCard()` contract, and fullscreen scroll/anchor/click mapping are unchanged.

### Changed

- **Updated builtin default Footer layout.** The default statusline (no custom Footer) now uses two rows: row 1 keeps permission, model, tasks, cwd, branch and extension items on the left, with plan state and Focus Mode on the right; row 2 composes token usage, cache hit, TTFB, throughput and the turn/step counters on the left (the semantic decomposition of the stats line), with the full context pressure (`used/window (percent)`) on the right. Users with a saved custom `footerLayout` are unaffected.

### Improved

- **Streaming tool preparation UX.** Preparing cards migrate more reliably
  around block completion: delayed names keep a bounded prefix, empty call
  ids migrate to the authoritative block-end id, and parallel previews keep
  independent bytes and summaries.
- **Content-block presentation.** Open opaque assistant blocks render
  immediately (no longer waiting for the stream to end), pending finals are
  fenced, stale confirmed assistant previews refresh, and the continuable
  subagent viewer keeps its viewing history.
- **Commands are decided by the whole LINE, not by the command name.** The DSH decision table
  (`CommandDescriptor.input`) distinguishes a `leadingInput` command (e.g. `/goal`), whose arguments are part of the
  invocation, from an execute-kind one (e.g. `/compact`), where only the BARE token is an invocation. Previously any
  name present in the command catalog sent the whole line to the command plane — `/compact anything` executed the
  command, ignored the busy queue/steer policy while running, and was even refused by the command attachment rule when
  it carried an image. Such a line now behaves exactly like an ordinary prompt: it follows the busy policy
  (queue/steer, and Ctrl+Enter takes the opposite), and its image is delivered to the model as a multimodal prompt.
  Real invocations — `/compact`, `/goal <objective>`, `/plan <message>` — still execute through the command plane, and
  the attachment rule only applies to a line a command actually claims.
- **`!`/`!!` shell lines refuse attachments instead of passing the placeholder to the shell.** The local shell never
  admitted or consumed drafts, so `!echo [image #1]` used to run with the placeholder as ordinary shell arguments and
  leave the image staged. The line is now refused like any other local command, and the draft comes back with its
  attachment intact.
- **Command attachments follow the command's own declaration.** A command may be invoked with attachments
  only when its descriptor declares `input.attachments`; anything else refuses the line up front
  (`/<name> does not accept attachments; remove them first`) instead of handing the host a placeholder with
  no payload. A declaring command receives the submitted images as encoded attachments on the host command
  call, and a command submission consumes them only after handler success — a failed command restores the
  draft WITH its attachments. File attachments are refused for commands (the host expects an upload receipt
  this client cannot produce yet). Skill invocations are unaffected: an explicit `/skill <name> [image #1]`
  and a skill wrapper stay agent-facing, so their images ride the delivered prompt instead of the command
  wire. The policy follows the FINAL authority: an unknown `/name [image #1]` line whose command only appears
  with the session (a session-scoped host command) is checked again after the session resolves — an undeclared
  command refuses it instead of running with an empty payload and consuming the draft.
- **An attachment-bearing `/name args` line is no longer treated as a client command.** A client command
  contribution claims the BARE `/name` token only, so a line such as `/deploy [image #1]` (an attachment
  always brings input with it) was never a contribution invocation: it is an ordinary multimodal submission
  that reaches the model — the plugin handler does not run and no "local command" attachment refusal is
  raised.
- **A plugin reload during a deferred start never runs the next generation.** If the contribution is
  unloaded/replaced while the first submission resolves its session (even under the same owner and id),
  the submitted command does **not** run the new handler and is **never** downgraded to a model prompt:
  the submission is aborted with `/<name> is no longer available` and the draft is restored for a retry.
- **Ctrl+Enter now follows the web submission semantics.** While the agent is running, Ctrl+Enter takes
  the **opposite** of the busy-Enter behavior: it steers under the default `busyEnter=queue` and queues
  under `busyEnter=steer` (an idle agent always queues). The old `app.input.queue` action is kept as a
  deprecated, key-less action, so a stored remap still means "queue" instead of being silently turned
  into the opposite behavior; the new `app.input.submitAccelerated` owns Ctrl+Enter.
- **Throughput statistics use observable decode throughput.** Footer tok/s now uses counted output
  tokens over the observable decode window; burst samples are not mixed with full LLM wall time or
  counts from other response stages.
- **Focus steer chronology is more reliable.** Early, late, and same-timestamp steer/answer events use
  the provable boundary; answers crossed by a steer are not lost or shown twice.

### Fixed

- **A stale command handle can no longer remove a newer registration.** A dispose handle names ONE registration:
  a repeated or late `dispose()` (a fiber cleanup arriving after an HMR reload re-registered the same id) no longer
  removes the newer contribution or drops its health record.
- **Text-input keyboard ownership is corrected.** Free-text editing no
  longer loses its line-editing keys to the parent: in Question's “Type
  something.” edit, `←/→` are the text cursor (previously they could commit
  and move on, or page back), and `Home/End/Ctrl+A/E/B/F/Delete` etc. all
  reach the shared Input. Optionless questions now use an explicit two-layer
  state: in the EDIT layer `←/→` move the text cursor, `↵` commits, and
  `Esc/Ctrl+C` only leave the edit for the NAVIGATION layer, where `↵`
  re-enters the edit, `←/→` page between questions (or skip), and
  `Esc/Ctrl+C` cancel the whole flow (previously Esc either stranded such a
  question in a half-dead, uneditable state or cancelled the whole flow
  outright). The Question edit-mode and Task Center search-mode footers only
  advertise what the current mode actually does (no more `↑↓ select` /
  `A active/all` list actions while typing). Transcript search now closes on
  Esc or Ctrl+C (the `app.transcript.search.close` defaults were extended —
  previously the overlay's Input swallowed Ctrl+C), and shows a
  `↵ next · ⇧↵ prev · esc/ctrl+c close` hint under the input. The
  `/keybindings` search box is rendered by the shared Input: full
  cursor/Home/End/Delete/word-move editing works, and the hint flips between
  `Esc: clear` (non-empty query) and `Esc: close`.
- **Direct sessions are now fully retired on exit.** Exiting the TUI now retires
  the main Agent, its continuable subagents and Agent-scoped background jobs in
  a fixed order: cancel the main Agent and await quiescence → drain continuable
  descendants → final persistence flush → release the AgentHandle. Previously
  the process could linger for ~5 minutes after exit while a continuable
  subagent stayed alive; exit now completes within seconds, and the diagnostics
  distinguish surface close, Host retirement and launcher exit. Session
  switches (/new, /fork, rewind, /sessions) also retire the old owner's
  continuable descendants after the commit.
- **Presentation details.** Diff presentation aligns with official DSH semantics
  (folded multi-hunk diffs stay bounded; edit headers and result parity are
  preserved); `@` file completion keeps full paths and fixes marquee routing
  and host cleanup; model selection survives fork and rewind; steers after a
  Focus thought are kept for non-user turns and opening steers are distinguished
  from mid-turn input; assistant tool-result presentation survives the
  presentation pipeline.
- **Session open/switch robustness.** Opening or switching sessions (/new,
  /resume, fork, rewind, /sessions) no longer drops state: the previous session
  stays visible and usable until the new one is ready, a failed initial bootstrap
  no longer strands the surface (retry still opens), the old Agent keeps write
  authority until the new session takes over, and late-arriving assistant stream
  fragments are reassembled per official semantics without half-built or
  orphan blocks.

### Compatibility

- **Client command contributions are bare-token invocations only (breaking).** DSH `matchEnter`
  parity: a contribution is a slash-MENU entry, so it claims the BARE `/name` token only — `/name args`
  is not an invocation. It is an ordinary submission that reaches the model (busy policy and
  attachments included), and the plugin `handler` never runs for it. Previously `/deploy prod` ran the
  plugin handler. A plugin that needs arguments should open its own picker from the bare command, or
  expose the capability to the model as a tool.
- **The extension API version is now 2 (breaking).** `api().apiVersion` reports `2` because the
  plugin command contribution contract below is a breaking change to the STABLE surface (removed
  `execution`/`argumentProvider`, required `handler`); `1` stays the M0–M3 foundation, so a plugin
  can tell the two schemas apart. A plugin still declaring the removed v1 shape is rejected at
  registration instead of being silently reinterpreted.
- **Plugin command contributions now follow the DSH client command model (breaking).** The
  `execution: 'local' | 'submission'` ownership metadata is REMOVED: a contribution IS a client-owned
  command (a required `handler`, no host descriptor) that joins the `/` menu and executes locally, never
  steered. A name that collides with the current host catalog FAILS the candidate synthesis as a whole
  (no menu rows are installed, the collision is recorded on the contribution's health and surfaced once,
  naming every colliding contribution of that failed pass)
  while the host command keeps its claim — it can never be downgraded to a model prompt. A contribution
  used to advertise a prompt-style name should simply not be registered (an unclaimed `/name args` line
  is already a prompt; the host-side skill owns discovery). `sessionless: true` runs the command before a
  session exists; the default `false` resolves/creates the session first. A collision with the SESSION's
  host catalog fails the whole candidate pass at synthesis time (upstream `source-failed` parity: the
  source's command rows are withdrawn until a synthesis succeeds again) while the host claims stay
  refreshed — input authority is never lost — and the collision is recorded on the contribution's health
  and surfaced once per identity/failure generation (the notice names every collision of that pass); a
  collision with the TUI's own static command names
  is rejected at registration. The never-wired `argumentProvider` field is removed too (use
  `registerAutocomplete`).
- **Standalone composition callers retain `ModelSelectionRef` compatibility.** The
  root `composeAgent(ctx, ref)` form remains supported, and its setup installs
  the caller-owned selection without requiring an Agent; the Direct runner
  continues to use the explicit Agent-local installer form.

> **Known limitation:** The production default backend remains Direct; remote
> attach is not supported.

## [0.4.3-alpha.2] - 2026-09-08

### Installation and version pairing

For this prerelease line, install the matching DSH first and then add the TUI
bundle into a profile:

```sh
npm install -g @deepseek-ai/dsh@0.1.3-alpha.2
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.4.3-alpha.2
dsh --profile pi-tui
```

Users who must keep an older DSH should pin the matching TUI:
`0.1.1-rc.2` → `@xmoon76/dsh-pi-tui@0.3`; `0.1.2-alpha.2`/`alpha.3` →
`@xmoon76/dsh-pi-tui@0.4.0-alpha.1`; `0.1.2-alpha.4`/`alpha.5` →
`@xmoon76/dsh-pi-tui@0.4.0-alpha.2`; `0.1.2-rc.1` →
`@xmoon76/dsh-pi-tui@0.4.1`. The complete version matrix and update/remove
commands are in the README's “Install into a DSH profile” section.

### Added

- **PTC / `run_code` nested tool tree.** Sub-calls dispatched inside a
  `run_code` program now render as a recursive sub-call tree under the root
  Code card: a full identity chain (`subCallId`/`parentCallId`/`rootCallId`)
  supports grandchild topology, and orphan start/settle facts are parked
  privately and connected when their parent appears — never promoted to
  top-level surface rows. The tree is aligned with Focus, display and search:
  in collapsed Focus, `run_code` stays the formal Tool slot with a compact
  active-child hint (e.g. `Bash running` / `Bash ×2 running` /
  `Bash +1 running`, with a width-degradation ladder); the `/search` corpus
  recursively includes sub-call descendants (matches locate the root Code
  card); markdown export keeps nested output.
- **Session presentation aligns with DSH v2 semantics.** The Direct adapter
  ingests official `agent/assistant-stream` live frames (completed-turn
  fences, revision-gap resynchronization); Transcript/Focus/Stats fold the
  transient plane; cold replay restores thinking from assistant/message
  blocks; the old durable assistant/chunk private path is gone.
- **`/search` converges into the Session Browser.** `/sessions`, `/resume`
  and `/search` now share one session browser: typing a query enters a global
  search view (local metadata matches ∪ content matches) that is never
  scoped by the workspace tabs, and hit snippets render on the matching
  session rows; when content search is unavailable or fails, local metadata
  filtering keeps working and the browser stays open.
- **Session content search aligns with official DSH semantics.** The Direct
  adapter now uses `sessionQuery.searchSessions()` (matching DSH master
  `ApiSessionList.search()`: visibility authorization, dedupe, cursor
  pagination, 20-result window), removing the old “newest 100 sessions +
  filterEvents” private rule — matches in old sessions are now found.
- **Unified attachment intake.** `@` mentions, `/image` arguments and pasted
  content share one attachment intake pipeline: a bounded signature probe
  separates images from generic files, generic files keep their metadata and
  stream at submit time, and placeholder/draft submission behavior is
  unified.
- **Inline `/skill` references complete in drafts.** A `/name` token at a
  whitespace boundary in a prompt-mode draft completes against the detached
  human skill catalog; accepting inserts the literal reference without
  submitting, and the final ordinary prompt lets the Host `dsh-tool-skill`
  pre-step inject every recognized skill.

### Improved

- **Streaming tool preparation UX.** Preparing cards migrate more reliably
  around block completion: delayed names keep a bounded prefix, empty call
  ids migrate to the authoritative block-end id, and parallel previews keep
  independent bytes and summaries.
- **Content-block presentation.** Open opaque assistant blocks render
  immediately (no longer waiting for the stream to end), pending finals are
  fenced, stale confirmed assistant previews refresh, and the continuable
  subagent viewer keeps its viewing history.

### Fixed

- **A stale command handle can no longer remove a newer registration.** A dispose handle names ONE registration:
  a repeated or late `dispose()` (a fiber cleanup arriving after an HMR reload re-registered the same id) no longer
  removes the newer contribution or drops its health record.
- **Text-input keyboard ownership is corrected.** Free-text editing no
  longer loses its line-editing keys to the parent: in Question's “Type
  something.” edit, `←/→` are the text cursor (previously they could
  commit and move on, or page back), and `Home/End/Ctrl+A/E/B/F/Delete`
  etc. all reach the shared Input. Optionless questions now use an
  explicit two-layer state: in the EDIT layer `←/→` move the text
  cursor, `↵` commits, and `Esc/Ctrl+C` only leave the edit for the
  NAVIGATION layer, where `↵` re-enters the edit, `←/→` page between
  questions (or skip), and `Esc/Ctrl+C` cancel the whole flow (previously
  Esc either stranded such a question in a half-dead, uneditable state
  or cancelled the whole flow outright). The Question edit-mode and Task
  Center search-mode footers only advertise what the current mode
  actually does (no more `↑↓ select` / `A active/all` list actions while
  typing). Transcript search now closes on Esc or Ctrl+C (the
  `app.transcript.search.close` defaults were extended — previously the
  overlay's Input swallowed Ctrl+C), and shows a
  `↵ next · ⇧↵ prev · esc/ctrl+c close` hint under the input. The
  `/keybindings` search box is rendered by the shared Input: full
  cursor/Home/End/Delete/word-move editing works, and the hint flips
  between `Esc: clear` (non-empty query) and `Esc: close`.
- **Direct sessions are now fully retired on exit.** Exiting the TUI now
  retires the main Agent, its continuable subagents and Agent-scoped
  background jobs in a fixed order: cancel the main Agent and await
  quiescence → drain continuable descendants → final persistence flush →
  release the AgentHandle. Previously the process could linger for ~5
  minutes after exit while a continuable subagent stayed alive; exit now
  completes within seconds, and the diagnostics distinguish surface close,
  Host retirement and launcher exit. Session switches (/new, /fork, rewind,
  /sessions) also retire the old owner's continuable descendants after the
  commit.
- **Presentation details.** Diff presentation aligns with official DSH
  semantics (folded multi-hunk diffs stay bounded; edit headers and result
  parity are preserved); `@` file completion keeps full paths and fixes
  marquee routing and host cleanup; model selection survives fork and
  rewind; steers after a Focus thought are kept for non-user turns and
  opening steers are distinguished from mid-turn input; assistant
  tool-result presentation survives the presentation pipeline.
- **Session open/switch robustness.** Opening or switching sessions (/new,
  /resume, fork, rewind, /sessions) no longer drops state: the previous
  session stays visible and usable until the new one is ready, a failed
  initial bootstrap no longer strands the surface (retry still opens), the
  old Agent keeps write authority until the new session takes over, and
  late-arriving assistant stream fragments are reassembled per official
  semantics without half-built or orphan blocks.

### Compatibility

- **The `next` line now requires DeepSeek Harness `0.1.3-alpha.2` or later.**
  The startup notice on an old runtime now gives the exact npm upgrade
  command (`npm install -g @deepseek-ai/dsh@0.1.3-alpha.2`) instead of
  referencing an unpublished master source baseline.
- **This release is validated against the exact npm `0.1.3-alpha.2` family.**
  The peer floor is `>=0.1.3-alpha.2`, dev/test dependencies and the frozen
  lockfile resolve to that exact family, and compatibility/preset/boundary
  smokes run against that family from the registry.

> **Known limitation:** The production default backend remains Direct; remote
> attach is not supported.

## [0.4.1] - 2026-09-04

### Installation and version pairing

For this stable release, install the matching DSH first and then add the TUI
bundle into a profile:

```sh
npm install -g @deepseek-ai/dsh@0.1.2-rc.1
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.4.1
dsh --profile pi-tui
```

Users who must keep DSH `0.1.1-rc.2` should use `@xmoon76/dsh-pi-tui@0.3`. The
complete version matrix and update/remove commands are in the README's “Install
into a DSH profile” section.

### Added

- **Streaming tool preparation cards.** Tool calls now show live cards during
  preparation; Focus also shows a compact summary of preparing tools and keeps a
  stable position when a tool name arrives late.

### Improved

- **Focus preparing projection.** Preparing-tool state keeps the correct order
  across the regular view, the expanded Focus view, and viewer changes; when a
  block ends it is migrated to the formal tool card or safely cleared.
- **Unified keyboard exit confirmation.** Built-in exit entries such as Ctrl+C
  and Ctrl+D require a same-key second press, so different keys cannot confirm
  one another. Ctrl+D remains editor-owned forward-delete for a non-empty draft,
  and custom exit-key mappings remain intact.

### Fixed

- Fixed preparing-tool identity migration across block completion and viewer
  changes, avoiding duplicate, misplaced, or incorrectly cleared cards from late
  events.
- Fixed exit-confirmation hints and editor/command-surface routing so narrow
  terminals retain the necessary prompt.

### Compatibility

- **Continue using DSH `0.1.2-rc.1`.** Version 0.4.1 retains the
  `>=0.1.2-rc.1` support range; users who must keep DSH `0.1.1-rc.2` should use
  `@xmoon76/dsh-pi-tui@0.3`.
- Version 0.4.1 retains the 0.4 line's Session and legacy-data compatibility.

> **Known limitation:** The production default backend remains Direct; remote
> attach is not supported.

## [0.4.0] - 2026-09-03

### Installation and version pairing

For this stable release, install the matching DSH first and then add the TUI
bundle into a profile:

```sh
npm install -g @deepseek-ai/dsh@0.1.2-rc.1
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.4.0
dsh --profile pi-tui
```

Users who must keep DSH `0.1.1-rc.2` should use `@xmoon76/dsh-pi-tui@0.3`;
users on the DSH `0.1.2-alpha.2`/`alpha.3` baseline should pin
`@xmoon76/dsh-pi-tui@0.4.0-alpha.1`, and users on the alpha.4/alpha.5 baseline
should pin `@xmoon76/dsh-pi-tui@0.4.0-alpha.2`. The complete matrix and
update/remove commands are in the README's “Install into a DSH profile” section.

### Added

- **Task Center.** `/tasks` is rebuilt as a three-layer task surface: footer
  badge → Quick Tasks (footer down, Active scope) → the full Task Center
  (`/tasks`, All scope). An explicit search mode treats printable keys as
  query text only — they can never fire destructive actions, and Esc exits
  search before closing the panel. `Stop` (`S` → `Y` confirmed) replaces the
  old bare-`i` interrupt and is re-validated at dispatch time against the
  session fence and the Agent registry. The footer badge shows separate
  running/total agent and job counts plus unacknowledged failure attention;
  opening either surface acknowledges only the failure rows actually visible.
- **Terminal completion notification.** When the main agent settles while the
  terminal is not focused, a system notification fires (OSC 9 / OSC 777 /
  bell, chosen by the terminal environment). It triggers only on a true
  settle — never on retries, compaction, queued continuations or subagent
  ends. `/settings` gains `Completion notification` mode (Unfocused / Always
  / Off) and method (Auto / OSC 9 / OSC 777 / Bell) rows.
- **`/settings` gains Subagent model selection.** The toggle and the
  "Subagent allowed models" route picker read and write the official
  `subagent-model-selection` settings section directly (default off;
  enabling requires at least one route; sampled at NEW session composition,
  never rewriting a running session).
- **Tool-card action payloads are first-class.** Compact tool cards show the
  action payload directly, expanded payloads keep their blank lines, and
  narrow/zero-width rows are handled explicitly.
- **Footer custom command items.** The `/footer` Add picker gains
  `+ Create Custom Command` — items with a refresh interval, timeout and
  semantic tone. Commands activate only from the USER-layer trusted source
  (project configuration can never supply or activate a command), and the
  render path never spawns.
- **`/model` selection is persisted per live Agent.** Each live Agent owns
  its own selection reference; the footer and `/model` follow the current
  Agent, with latest-wins fencing between the global default and
  session-local choices.
- **The Focus expanded view preserves user steer chronology.** The initial
  user stays before the Thought and later steers/users return to their
  actual chronological position; the compact Message becomes the third
  process slot (Think → Tool → Message) showing the newest up to three rows.
- **The fullscreen mouse-wheel step is configurable.** `/settings` gains a
  `Mouse wheel lines` row (1/2/3/5/8, default 1).
- **Todo panel interaction polish.** With five or fewer items the panel is a
  two-state summary ↔ list; rapid consecutive clicks coalesce into one
  gesture instead of flashing the panel away.
- **Long-session search is a stable indexed projection.** Fullscreen search
  uses stable item identities over a single corpus; a query iterates only
  the entries dirtied since the last run, and jumps anchor by the stable
  turn.
- **Status-line and `/status` context readings are unified and
  deduplicated.** Ordinary refreshes read the cache; `/status` forces one
  measurement into the cache, so the panel and footer can no longer
  disagree.

### Improved

- **`/sessions` and `/resume` are faster and cancellable.** The picker opens
  input-first (Enter while loading can never resume); each session gets one
  combined projection read (live rows read the in-memory snapshot, cold rows
  read the durable cache, and only genuine cache misses run a bounded
  observe); progressive enrichment is cancellable — closing, quitting or
  re-opening aborts the scan; `/resume <arg>` shares the same lifecycle.
- **Paste handling is more reliable.** A large paste followed by `Ctrl+G`
  no longer loses content in the external editor (`$EDITOR` sees the
  expanded text); outbound drafts (steer / submit / queue / subagent
  submission) expand paste markers uniformly instead of leaking literal
  markers onto the wire.
- **The editor submit binding is independent.** A dedicated
  `tui.editor.submit` binding (Editor-only) means question free-text and
  search boxes are no longer submitted by `submit: ctrl+x`-style configs.

### Fixed

- **Surfaces keep their state across terminal resizes.** The queue pane,
  todo panel, history-search overlay and approval dialog rebuild from raw
  state at the live geometry without losing component state, focus or
  overlay semantics.
- **The diff view no longer shows unprovable line numbers.** When the DSH
  FileDiff contract carries no hunk anchors, the gutter is hidden — absolute
  line numbers are never guessed.
- **The Focus expanded view keeps the initial user prompt before the
  Thought.** Injected system rows no longer push the first user message
  below the Thought.
- **The builtin todo summary returns after the panel closes.** With an
  extension host attached, closing the panel no longer leaves the dock's
  todo summary permanently empty.
- **Stability hardening.** The process slot is held until the final dispose
  and editor-mount/component disposal is hardened, reducing races on exit
  and HMR.
- Explicit cold resume shows startup progress before the TUI mounts
  (`Resuming session…` / `Preparing conversation…`) instead of a blank
  terminal that reads as a hang.
- Search overlay Next/Prev no longer skip newly arrived matches.
- A live tail append refreshes the whole read group, so search jumps never
  anchor a stale window.
- An instantly-exiting footer command child no longer crashes the TUI
  (EPIPE swallowed).

### Migration notes and compatibility

- **The 0.4 line moves to DeepSeek Harness 0.1.2.** The declared support
  range is `>=0.1.2-rc.1`; runtimes below rc.1 get a startup notice:
  alpha.4/alpha.5 fall back to `@xmoon76/dsh-pi-tui@0.4.0-alpha.2`,
  alpha.2/alpha.3 fall back to `@xmoon76/dsh-pi-tui@0.4.0-alpha.1`, and
  older runtimes fall back to 0.3.
- Development/test dependencies and the Source Mode pin move to
  `dsh-v0.1.2-rc.1`; the published peer floor stays `>=0.1.2-rc.1`.
- Agent preset identity is roster-aware; an omitted legacy `code` default
  falls back to `ptc` when the roster proves `code` is absent.
- Upstream alpha caveat: DSH 0.1.2-alpha.1 still has an upstream
  subagent-dispose caveat.

> **Known limitation:** the production default backend remains Direct; remote
> attach is not supported yet.

## [0.4.0-alpha.2] - 2026-09-03

### Installation and version pairing

For this prerelease, install the matching DSH first and then add the TUI bundle
into a profile:

```sh
npm install -g @deepseek-ai/dsh@0.1.2-alpha.5
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.4.0-alpha.2
dsh --profile pi-tui
```

Users who must keep DSH `0.1.1-rc.2` should use `@xmoon76/dsh-pi-tui@0.3`;
users on the DSH `0.1.2-alpha.2`/`alpha.3` baseline should pin
`@xmoon76/dsh-pi-tui@0.4.0-alpha.1`. The complete matrix and update/remove
commands are in the README's “Install into a DSH profile” section.

### Added

- **Task Center.** `/tasks` is rebuilt as a three-layer task surface: footer
  badge → Quick Tasks (footer down, Active scope) → the full Task Center
  (`/tasks`, All scope). An explicit search mode treats printable keys as
  query text only — they can never fire destructive actions, and Esc exits
  search before closing the panel. `Stop` (`S` → `Y` confirmed) replaces the
  old bare-`i` interrupt and is re-validated at dispatch time against the
  session fence and the Agent registry. The footer badge shows separate
  running/total agent and job counts plus unacknowledged failure attention;
  opening either surface acknowledges only the failure rows actually visible.
- **Terminal completion notification.** When the main agent settles while the
  terminal is not focused, a system notification fires (OSC 9 / OSC 777 /
  bell, chosen by the terminal environment). It triggers only on a true
  settle — never on retries, compaction, queued continuations or subagent
  ends. `/settings` gains `Completion notification` mode (Unfocused / Always
  / Off) and method (Auto / OSC 9 / OSC 777 / Bell) rows.
- **`/settings` gains Subagent model selection.** The toggle and the
  "Subagent allowed models" route picker read and write the official
  `subagent-model-selection` settings section directly (default off;
  enabling requires at least one route; sampled at NEW session composition,
  never rewriting a running session).
- **Tool-card action payloads are first-class.** Compact tool cards show the
  action payload directly, expanded payloads keep their blank lines, and
  narrow/zero-width rows are handled explicitly.

### Improved

- **`/sessions` and `/resume` are faster and cancellable.** The picker opens
  input-first (Enter while loading can never resume); each session gets one
  combined projection read (live rows read the in-memory snapshot, cold rows
  read the durable cache, and only genuine cache misses run a bounded
  observe); progressive enrichment is cancellable — closing, quitting or
  re-opening aborts the scan; `/resume <arg>` shares the same lifecycle.
- **Paste handling is more reliable.** A large paste followed by `Ctrl+G`
  no longer loses content in the external editor (`$EDITOR` sees the
  expanded text); outbound drafts (steer / submit / queue / subagent
  submission) expand paste markers uniformly instead of leaking literal
  markers onto the wire.
- **The editor submit binding is independent.** A dedicated
  `tui.editor.submit` binding (Editor-only) means question free-text and
  search boxes are no longer submitted by `submit: ctrl+x`-style configs.

### Fixed

- **Surfaces keep their state across terminal resizes.** The queue pane,
  todo panel, history-search overlay and approval dialog rebuild from raw
  state at the live geometry without losing component state, focus or
  overlay semantics.
- **The diff view no longer shows unprovable line numbers.** When the DSH
  FileDiff contract carries no hunk anchors, the gutter is hidden — absolute
  line numbers are never guessed.
- **The Focus expanded view keeps the initial user prompt before the
  Thought.** Injected system rows no longer push the first user message
  below the Thought.
- **The builtin todo summary returns after the panel closes.** With an
  extension host attached, closing the panel no longer leaves the dock's
  todo summary permanently empty.
- **Stability hardening.** The process slot is held until the final dispose
  and editor-mount/component disposal is hardened, reducing races on exit
  and HMR.

### Compatibility

- **The minimum DSH is raised to `>=0.1.2-alpha.4`** (from
  `>=0.1.2-alpha.2`). Runtimes below alpha.4 get a startup notice:
  alpha.2/alpha.3 fall back to `@xmoon76/dsh-pi-tui@0.4.0-alpha.1`, older
  runtimes fall back to 0.3.
- Development/test dependencies and the Source Mode pin move to
  `dsh-v0.1.2-alpha.5`; the published peer floor stays `>=0.1.2-alpha.4`.

> **Known limitation:** the production default backend remains Direct; remote
> attach is not supported yet.

## [0.4.0-alpha.1] - 2026-09-01

### Installation and version pairing

```sh
npm install -g @deepseek-ai/dsh@0.1.2-alpha.3
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.4.0-alpha.1
dsh --profile pi-tui
```

Users who must keep DSH `0.1.1-rc.2` should use `@xmoon76/dsh-pi-tui@0.3`.

### Added

- **Footer custom command items.** The `/footer` Add picker gains
  `+ Create Custom Command` — items with a refresh interval, timeout and
  semantic tone. Commands activate only from the USER-layer trusted source
  (project configuration can never supply or activate a command), and the
  render path never spawns.
- **`/model` selection is persisted per live Agent.** Each live Agent owns
  its own selection reference; the footer and `/model` follow the current
  Agent, with latest-wins fencing between the global default and
  session-local choices.
- **The Focus expanded view preserves user steer chronology.** The initial
  user stays before the Thought and later steers/users return to their
  actual chronological position; the compact Message becomes the third
  process slot (Think → Tool → Message) showing the newest up to three rows.
- **The fullscreen mouse-wheel step is configurable.** `/settings` gains a
  `Mouse wheel lines` row (1/2/3/5/8, default 1).
- **Todo panel interaction polish.** With five or fewer items the panel is a
  two-state summary ↔ list; rapid consecutive clicks coalesce into one
  gesture instead of flashing the panel away.
- **Long-session search is a stable indexed projection.** Fullscreen search
  uses stable item identities over a single corpus; a query iterates only
  the entries dirtied since the last run, and jumps anchor by the stable
  turn.
- **Status-line and `/status` context readings are unified and
  deduplicated.** Ordinary refreshes read the cache; `/status` forces one
  measurement into the cache, so the panel and footer can no longer
  disagree.

### Fixed

- Explicit cold resume shows startup progress before the TUI mounts
  (`Resuming session…` / `Preparing conversation…`) instead of a blank
  terminal that reads as a hang.
- Search overlay Next/Prev no longer skip newly arrived matches.
- A live tail append refreshes the whole read group, so search jumps never
  anchor a stale window.
- An instantly-exiting footer command child no longer crashes the TUI
  (EPIPE swallowed).

### Migration notes

- **0.4.0-alpha.1 moves to DeepSeek Harness 0.1.2.** The declared support
  range is `>=0.1.2-alpha.2`; users keeping DSH 0.1.1 should pin
  `@xmoon76/dsh-pi-tui@0.3`.
- Agent preset identity is roster-aware; an omitted legacy `code` default
  falls back to `ptc` when the roster proves `code` is absent.
- Upstream alpha caveat: DSH 0.1.2-alpha.1 still has an upstream
  subagent-dispose caveat.

## [0.3.6] - 2026-08-31

### Added

- `@` mentions and `/image` arguments share one file-completion engine
  (path parsing, ranking, quoting, directory continuation).
- Long sessions use a bounded transcript window (overlapping paging,
  `Ctrl+End` back to the latest, preserved window anchors).
- Submission has immediate feedback and an observable latency timeline
  (`Submitting…` / `Queued…`).

### Changed

- `/footer` saving is discoverable and transactional (Save changes / Unsaved
  states, Esc confirmation).
- Session writes use a fail-closed ownership model (owner lock +
  single-writer boundary).

### Fixed

- Async completion results always repaint the active screen.
- The footer honors the real available budget on narrow terminals, fullscreen
  changes and command surfaces.
- Transcript window changes, search and live follow no longer lose viewport
  anchors.

> **Known limitation:** the production default backend remains Direct; remote
> attach is not supported while M2–M8 are unfinished.

## [0.3.5] - 2026-08-28

### Added

- **The `/footer` configurator is redesigned as a hierarchical status-line
  editor.** Row Selector → Edit Row → Item Editor; `A` opens a searchable
  Add Picker; the preview and help are a fixed shell; the save key moves to
  `S`.
- **Footer supports user-defined static text items.** `+ Create Custom
  Text`, read only from the USER settings layer.
- **Builtin footer items expose meaningful finite styles.** Model /
  Permission / Working directory / Context / Token usage / Performance /
  Turns gain distinguishable variants.
- **Plugin theme selections are SOURCE-QUALIFIED
  (`plugin:<owner>/<id>`).** Plugin and file themes no longer share a bare
  name namespace; an unloaded plugin degrades deterministically to the
  built-in dark palette.
- **An `Icon style` setting** switches between Emoji, Symbols and Minimal
  structural icon palettes, applied immediately.
- **Keybindings are user-orchestrable.** Semantic actions resolved through a
  context-aware keymap; `/keybindings` shows the effective table,
  `conflicts` lists conflicts, `reload` re-reads, `reset` clears; `<leader>X`
  multi-key bindings; `DSH_PI_TUI_SAFE_KEYBINDINGS=1` ignores all overrides.
- **The `/help` and `/settings` key copy is key-neutral.** It never claims a
  physical key that a remap could make stale.
- **A trusted command status line (Claude/Kimi style).** `footer: command`
  hands the status surface to a user-configured command (JSON snapshot on
  stdin, stdout rendered, periodic refresh, fallback to the native layout on
  failure); only a USER-layer `footerCommand` is ever executed.

### Changed

- The footer is a composable, user-configurable surface (`custom` preset +
  versioned `footerLayout`).
- Plugins can contribute configurable footer items (`chrome.footer.item`
  slot).
- The question flow and task browser route keys through semantic component
  actions.

### Fixed

- Empty input no longer manufactures a message or a side effect (Enter /
  Ctrl+Enter / Ctrl+S are silent no-ops).
- Editor ↑/↓ history is projected onto the active session.
- Terminal window titles are human-readable (`dsh · <title>`, sanitized
  against ANSI/OSC).
- Ghost Tool Cards after compaction/prune are gone.

## [0.3.4] - 2026-08-25

### Added

- **Ctrl+R searches your input history.** A modal panel filters live; `Tab`
  cycles Current session / Current directory / All directories; bounded
  recent-first scanning (5000-line global budget); paged continuation;
  `Enter` puts the selection back into the editor for editing.
- **`/tasks` shows the full subagent lineage as a tree.** Depth indentation
  with `├─` connectors in stable pre-order; nested descendants are read-only.
- **The selected row's long label marquees** instead of truncating.

### Changed

- **Thinking blocks are disclosure, not visibility.** `Alt+T` is the one
  bulk owner; `Ctrl+O` owns only tool/system/compaction detail.
- **`!` / `!!` shell lines are a first-class editor mode.** The prompt
  itself becomes `!`/`!!`; pasting `!git status` lands as mode + command.
- **Local shell cards preview instead of flooding the screen.** A running
  card collapses to the newest 5 lines, a settled card to at most 20;
  `Alt+K` quick-dismisses settled cards.

### Fixed

- A startup-time TDZ (footer command lifecycle slots declared too late).
- Ctrl+V image paste works again on Linux Wayland/X11 (forced buffer
  encoding).
- Task overlays no longer draw a black mask beside the border.

## [0.3.3] - 2026-08-24

### Added

- **Continuable subagent viewers are interactive.** A live conversation
  surface with the child's own draft, FIFO delivery, and failed deliveries
  merged back into the draft; one-shot children stay read-only.
- **The task browser shows the subagent mode** (`continuable` / `one-shot`).
- **Focus Mode** folds a running turn's intermediate activity into a live
  Thought block; clicking expands it and streaming continues into the open
  region.
- **`Home/End keys` are configurable in `/settings`** (Input / Viewport).
- **`@`-file mentions reach the model as absolute paths.**
- **The task browser filters by row type** (Tab cycles All → subagent →
  bash → pwsh).
- **Pi-style rewind: `Esc Esc` (or `/rewind`)** forks the conversation from
  an earlier user turn; the original session is never modified.
- **`/fork` and `/rewind` share one fork chain.**

### Changed

- Esc never destroys your queue again (keepInbox semantics).
- `/sessions` scopes by directory (Current directory / All directories).
- The question review page is a pure review (Enter submits, Esc cancels,
  `←` returns).

### Fixed

- Session transitions are a single-writer transaction: a switch waits for
  the current activity, failures leave no half-created branch, and two
  processes can never write one session.
- The double-Esc rewind chord is truly consecutive.
- Fullscreen drag selection and `/copy` no longer fake a successful copy
  (tmux / platform helpers / OSC 52 fallback).
- The `Press Ctrl+C again to exit` hint lives in the footer for exactly the
  exit window.
- A settled background job card keeps its command.
- `@dir` completion no longer depends on a trailing slash.

## [0.3.2] - 2026-08-22

### Added

- **User input renders as a brand-blue bubble** with a matching `❯` prompt
  (overridable palette token).
- **`/image <path>` completes paths.**
- **Mixed image messages keep an inline `🖼️` placeholder.**
- **Fullscreen: click an attachment to collapse/expand the picture** (with a
  constant identity line).

### Fixed

- Injected context rows never leak their XML envelopes when expanded.
- The image summary marker `🖼️` (U+FE0F) no longer overlaps the filename.
- Write / skill / read_image cards fold their content, never the raw XML
  envelope.

## [0.3.1] - 2026-08-21

### Changed

- A startup gate explains an unsupported harness (detected version, minimum
  version, upgrade command).
- The `/login` surface separates the two credential planes in its copy.

## [0.3.0] - 2026-08-21

### Added

- **Provider-native sign-in.** `/login` understands the two credential
  planes: the API-key path and OAuth / device-code native login; secret
  prompts render masked.
- **`/logout` clears both credential planes.**

### Changed

- **Minimum compatible DeepSeek Harness is `dsh-v0.1.1-rc.1` or later** (no
  longer 0.1.0-rc.8).
- The header version badge shows the dsh version first, then the `tui-`
  version.

### Security

- Authorization secrets are never printed, logged, put in input history,
  written to the transcript, or shown in `/status`.

## [0.2.2] - 2026-08-21

### Added

- **Merged task browser as the single background surface.** `/tasks` opens
  one searchable list over jobs AND subagents; `/subagents` became an alias.
- **Alias registration for TUI commands** (`/quit`, `/resume`, `/rename`,
  `/subagents`).
- **Subagent-family tool cards show their model.**
- **`!` / `!!` shell lines complete like a real shell** (command names,
  `$VAR`, git subcommands).
- **Local shell sandbox preference.** User-typed commands bypass the dsh
  sandbox by default.
- **Question cards show their answers; goal cards are readable.** Folded
  previews never leak raw JSON.
- **Fullscreen todo dock click.**

### Changed

- Queue pane notice classification (user rows `❯` / notice rows `⏳`).
- Ctrl+J is no longer a host keybinding.
- `!` / `!!` run in the session workspace.

### Removed

- **`/queue` command removed outright.** The queue pane is the single queue
  surface.

### Fixed

- Alt+↑ dequeue only pulls the user's own messages back.
- The double-Ctrl+C exit chord is visible and forgiving (1.5s window +
  hint).
- Folded cards never leak raw JSON.

## [0.2.1] - 2026-08-21

### Changed

- The repository root is now the published package (no behavior change for
  npm consumers).

## [0.2.0] - 2026-08-21

### Added

- **Extension platform v1.** A third-party Cordis plugin can contribute
  chrome, widgets, slash commands, themes, settings rows, autocomplete,
  keybindings, renderers, overlays, and even replace the editor; plugins
  import only `@xmoon76/dsh-pi-tui/extensions` and are fully
  lifecycle-owned.
- **Tiered extension surface.** Stable `extensions` + `advanced`
  (experimental) + `unstable` (no compatibility guarantee).
- **`/login` can add a provider the deployment has never configured** (a
  guided wizard + endpoint model probing).
- **Real-plugin validation.** A vim modal editor, a questionnaire form and
  an interactive shell example.
- **`@dir/` mention completion reopens after Tab.**
- **`/sessions` and `/resume` categorize the session list** (Main / All /
  Subagents).
- **Faster session-title loading** (progressive batches + local cache).
- **Context-compaction progress and results** (notices + an expandable
  compaction card).
- **`/model` dismisses after applying an effort.**
- **The footer wraps on narrow terminals.**

### Changed

- A TUI surface has an explicit lifetime (generation / dispose).
- Ctrl+C and Esc follow pi's editor semantics.

### Security

- Plugin text can no longer inject terminal control sequences.

### Fixed

- The host can never be shadowed or stalled by a plugin.
- Editor replacement is safe (atomic handoff, stale handles become inert).
- Narrow terminals stay intact.

## [0.1.8] - 2026-08-18

### Changed

- The question dialog's back/skip verbs are now the arrow keys (`→` / `←` /
  `↑↓`).

### Fixed

- Arrow/Esc/Tab work again on Kitty-keyboard-protocol terminals (zellij,
  WezTerm, Windows Terminal, kitty).
- Skill slash commands no longer swallow the user's arguments.

## [0.1.7] - 2026-08-18

### Fixed

- A user-loaded skill now actually runs (an idle agent starts a fresh turn
  with it).
- The subagent transcript viewer no longer freezes the main transcript.

## [0.1.6] - 2026-08-18

### Added

- Open-time session lock (a second live process is refused; a crashed
  owner's stale lock is taken over automatically).
- Plain `exit` quits the TUI.
- `/login` and `/logout` resolve credential targets.
- Per-cwd input history stored as JSONL.
- Inline skill autocomplete in the editor.
- Web-parity tool cards (web results, todo checklists, plan review).
- Task browser panel (status dots, live ticking).

### Changed

- Background-subagent settlement notices leave the queue pane.
- Editor-area chrome (todo summary moves into the dock strip).

### Fixed

- Question dialog arrow keys scroll at the scrollport edges.
- Session repair strips the trailing empty zstd frame.

### Removed

- Dead `@deepseek-ai/dsh-session-query` peer dependency.

## [0.1.5] - 2026-08-17

### Added

- Surface catalog coordinator (resume prefetch, cold-skill reads).
- Unified question page scrollport (expand, scroll-position preservation).

## [0.1.4] - 2026-08-16

### Added

- Busy-Enter setting (Enter steers while the agent is running).
- `!` shell submits command + output to the session; `!!` stays local.
- Subagent viewer covering the editor with a read-only viewer bar.
- Task browser merges continuable subagents with the jobs registry.
- `/rename` alias of `/title`.

### Changed

- Question dialogs live in the editor seat.
- Transcript markdown reflows on resize.

## [0.1.3] - 2026-08-16

### Added

- Background jobs get their own surface (queue notices, footer badge, task
  browser, output viewer).
- Theme detection chain and diff tokens.
- `@` file mentions.
- `/quit` as a native alias of `/exit`.

### Changed

- Multi-row tool cards with command/diff previews.
- Performance: window projection, cross-turn read groups, message component
  cache.

### Fixed

- Question flows serialize FIFO.
- Repair-session (torn zstd tail safety, fsynced backup).
- Local-shell output is bounded.

## [0.1.2] - 2026-08-15

### Added

- Queued-input pane and `/queue` management; Ctrl+S steers the whole queue.
- `ask_user_question` rebuilt as a navigable flow with review.
- Session creation deferred until the first user message.
- `/yolo` alias; permission mode badge.
- Real LCS diff rendering for edit/write tool cards.

### Fixed

- Notify survives repaints.
- Slash-command autocomplete no longer lags a keystroke.

## [0.1.1] - 2026-08-15

### Fixed

- `@deepseek-ai/*` declared as peerDependencies (no duplicate copies in the
  profile).

## [0.1.0] - 2026-08-15

### Added

- First public release: `@xmoon76/dsh-pi-tui`, a TUI surface for DeepSeek
  Harness profiles (`dsh --profile pi-tui`), built on a vendored pi-tui
  fork and bundled as a single self-contained package.
- Transcript engine (windowing, incremental folding, web-parity tool
  cards).
- Approval dialogs and permission modes; a complete slash-command set.
- Fullscreen layout, Ctrl+F transcript search, theme system.
- Single-package release model.

[Unreleased]: https://github.com/XMoon/dsh-pi-tui/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/XMoon/dsh-pi-tui/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/XMoon/dsh-pi-tui/compare/v0.4.9...v0.5.0
[0.4.9]: https://github.com/XMoon/dsh-pi-tui/compare/v0.4.8...v0.4.9
[0.4.8]: https://github.com/XMoon/dsh-pi-tui/compare/v0.4.6...v0.4.8
[0.4.7-alpha.2]: https://github.com/XMoon/dsh-pi-tui/compare/next-v0.4.7-alpha.1...next-v0.4.7-alpha.2
[0.4.7-alpha.1]: https://github.com/XMoon/dsh-pi-tui/compare/next-v0.4.3-alpha.2...next-v0.4.7-alpha.1
[0.4.6]: https://github.com/XMoon/dsh-pi-tui/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/XMoon/dsh-pi-tui/compare/v0.4.1...v0.4.5
[0.4.3-alpha.2]: https://github.com/XMoon/dsh-pi-tui/compare/v0.4.1...next-v0.4.3-alpha.2
[0.4.1]: https://github.com/XMoon/dsh-pi-tui/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.6...v0.4.0
[0.4.0-alpha.2]: https://github.com/XMoon/dsh-pi-tui/compare/next-v0.4.0-alpha.1...next-v0.4.0-alpha.2
[0.4.0-alpha.1]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.6...next-v0.4.0-alpha.1
[0.3.6]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/XMoon/dsh-pi-tui/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/XMoon/dsh-pi-tui/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/XMoon/dsh-pi-tui/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.8...v0.2.0
[0.1.8]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/XMoon/dsh-pi-tui/releases/tag/v0.1.0
