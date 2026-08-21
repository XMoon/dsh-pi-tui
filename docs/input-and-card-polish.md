# Input and card polish: bash completion, local-shell sandbox, question answers, goal cards, todo dock click, JSON folded previews

Six small, independent surface improvements, designed together because they
land in the same release cycle. Each section records the decision, the
rationale, the exact touch points, and the guarding tests. Workflow card
rendering (`tool-workflow/*`) is deliberately **out of scope** — reviewed and
kept as-is.

| # | Topic | Chosen approach |
|---|---|---|
| 1 | `!` / `!!` bash completion | Real-shell `compgen` bridge (command names + paths + a small subcommand table) |
| 2 | `!` / `!!` sandbox | New `/settings` row, default **bypass** (pi/kimi parity), opt-in sandbox |
| 3 | `ask_user_question` answers card | Folded: `N/M answered` summary; expanded: per-question answer lines |
| 4 | Goal cards (`get_goal`/`create_goal`/`update_goal`) | Folded: goal summary; expanded: field lines; named headers |
| 5 | Todo dock click (fullscreen) | Map the dock summary row to `toggleTodoPanel()` |
| 6 | JSON-result folded previews | Web parity audit: expanded stays verbatim, folded never leaks JSON |

---

## 1. Bash completion for `!` / `!!` lines

### Why

Today `!` lines get the editor's generic completion: slash commands (line-start
`/` only) and fd-backed path completion. Path completion already works inside
a `!` line (`!ls /u<tab>`), but the **command name** — the first word after
`!` — has no completion at all, and neither does a subcommand argument
(`!git che<tab>`). kimi's bash mode only reuses pi-tui's path completion;
pi has none. A real-shell `compgen` bridge is the only approach that matches
the user's actual environment (PATH, functions, `complete` specs) instead of
maintaining a parallel command database.

### Design

New module `src/shell-completion.ts`, consumed by `MentionProvider`
(`src/mentions.ts`). The provider detects a `!`-prefixed line and delegates to
the shell bridge; every other line keeps the current behavior.

**Trigger rules** (inside a `!`/`!!` line only):

| Cursor position | Completion source |
|---|---|
| First word (no space before cursor) | Command names via `compgen -A command` |
| Later words | fd path completion (existing) + subcommand table for known commands |
| `$` prefix | `compgen -A variable` (cheap, same spawn) |

**The compgen bridge** — one `bash -lc` spawn per request:

```text
bash -lc "compgen -A command -- '<prefix>'"        # command names
bash -lc "compgen -A variable -- '<prefix>'"       # $VAR names
bash -lc "compgen -W \"$(git --list-cmds)\" -- '<prefix>'"   # git subcommands
```

Decisions that matter:

- **`-lc`, never `-ic`.** An interactive shell sources `.bashrc` (slow, and
  runs user startup code on every keystroke — a side-effect risk). `-lc`
  sources `.bash_profile`-class files only; aliases are therefore NOT
  completed. Documented limitation, accepted: alias completion would require
  `-ic` and its startup cost.
- **One spawn per request, hard-capped.** `timeoutMs` 300ms, `AbortSignal`
  wired to the editor's suggestion signal, and the result commits
  latest-only (same epoch discipline as `AutocompleteRegistry.suggest`). A
  slow or missing `bash` degrades to `null` — the editor simply shows no
  suggestions, never an error.
- **Command-name cache.** The `compgen -A command` result for a cwd is
  cached with a 30s TTL (keyed by cwd + PATH). Command sets change rarely;
  this removes the spawn from the common keystroke path. Subcommand and
  variable completions are never cached (cheap enough, and freshness
  matters).
- **Subcommand table, not `complete -p` parsing.** Parsing bash's
  `complete` specs is a rabbit hole (function-backed completers cannot be
  invoked without sourcing the completion scripts). Instead a small
  per-command table: each entry carries a live lister (`git --list-cmds`)
  plus a static fallback list for commands/versions that cannot list
  themselves (git before 2.18 has no `--list-cmds`; the fallback wins when
  the lister produces nothing). Unknown commands fall back to fd path
  completion. The table is a `Record<string, {lister, fallback}>`
  constant — extending it is a one-line change.
- **Item shape.** `AutocompleteItem { value, label, description }`; the
  description carries the resolved command path (`which`-style, from
  `compgen`'s output only — no extra spawn) when available.
- **applyCompletion.** Command-name items replace the first word after the
  `!` prefix; path items keep the fork's existing apply path. The `!`/`!!`
  prefix itself is never touched.
- **Empty prefix.** A natural trigger with an empty command prefix stays
  quiet (typing `!` must not flash the whole command list); explicit Tab
  with an empty prefix lists the cached commands (capped).

**Touch points**

- `src/shell-completion.ts` — new module (bridge + cache + subcommand table).
- `src/mentions.ts` — `MentionProvider.getSuggestions` branches on a
  `!`-line; `applyCompletion` routes command-name items.
- `src/tui-editor.ts` — no change needed (the fork's autocomplete machinery
  already re-triggers after input; the provider swap is transparent).

**Tests**

- `shell-completion.test.ts` (headless, real `bash` present in CI): prefix
  parsing, compgen output parsing, timeout → `null`, abort → `null`,
  cache hit avoids a second spawn (inject a spawn counter), subcommand table
  lookup.
- `mentions` integration: a `!gi<tab>` virtual-terminal sequence shows
  command items; a `!ls /u<tab>` sequence still shows paths.
- Degradation: with `bash` unavailable (injected spawn failure) the editor
  shows no suggestions and the existing tests stay green.

---

## 2. Local-shell sandbox: `/settings` row, default bypass

### Why

`!`/`!!` are commands the **user** typed and chose to run — the sandbox is a
guardrail for commands the **model** runs autonomously. pi and kimi both
execute user `!` lines directly (pi: `createLocalBashOperations` → local
spawn; kimi: harness-local execution), with no sandbox concept at all.
Today dsh-pi-tui routes `!` through `ctx.shell` (`shell.resolve`/`run`),
which applies the executor's default sandbox policy — so a user's own
`rm` can be blocked by a policy aimed at the model. That is surprising and
inconsistent with both references.

### Design

New TUI settings field `localShellSandbox: 'bypass' | 'sandbox'`, **default
`bypass`** (pi/kimi parity). Persisted in the existing TUI settings document
(`settingsNamespace('tui')`, `src/index.ts` `tuiSettings` registration —
same document as `busyEnter`).

- `/settings` row (in `src/commands.ts`'s settings panel, next to
  `busy-enter`):

  ```text
  id:          'local-shell-sandbox'
  label:       'Local shell sandbox'
  description: '! / !! commands run outside the dsh sandbox (bypass, default) or under the sandbox policy'
  values:      ['bypass', 'sandbox']
  ```

  `onChange` persists through `tuiSettings.replace({ ...doc, localShellSandbox: value })`
  (same pattern as the `busy-enter` row).

- `runLocalShell` (`src/index.ts`): read the preference once per run.
  - `bypass` (default): execute through the **existing spawn path** — the
    current `ctx.shell === undefined` fallback, promoted to the primary
    path. It already has everything: bounded tail capture, 0600 full-output
    temp file, abort via `localShellController`, per-stream `StringDecoder`.
  - `sandbox`: keep the current `ctx.shell` resolve/run path unchanged.
  - The `!` context submission (guard → re-validate → followup) is
    **untouched** — only the execution backend changes.

**Why a setting instead of unconditional bypass**: the dsh shell executor
also carries DSH env and timeout semantics that some deployments rely on;
a one-line `/settings` flip preserves that for users who want it, while the
default matches every reference implementation.

**Touch points**

- `src/index.ts` — settings schema + base (`localShellSandbox: 'bypass'`),
  `runLocalShell` backend selection.
- `src/commands.ts` — the settings row + onChange persistence.
- `src/commands.ts` `TuiSettingsLike` — extend the document shape.

**Tests**

- Headless: with the preference `bypass`, `runLocalShell` does NOT call an
  injected fake `ctx.shell` (spawn path used); with `sandbox` it does.
- Settings row renders with `bypass` default; flipping persists through the
  injected settings document.
- Existing shell tests (bounded output, abort, truncation) stay green — they
  already exercise the spawn path.

---

## 3. `ask_user_question` answers card

### Why

Two rendering gaps, both visible in the transcript:

1. **Folded** cards show the raw result JSON (`— {"answers":[{"id":…` — the
   first two lines of `message.result`), because the generic folded preview
   (`tui-app.ts` `resultPreview = preview(message.result, …)`) has no
   `ask_user_question` special case.
2. **Expanded** cards show only `N/M answered` (`askAnswersSummary`) — the
   actual answers are gone. The design intent ("the questions were already
   shown in the question flow, the card only summarizes") leaves the user
   unable to recall what they chose after the flow closes. The web's
   `AskQuestionRow` has the same summary-only semantics, but its expanded
   Output section at least shows the formatted JSON; the TUI's plain-text
   card shows strictly less when expanded than when folded.

### Design

- **Folded** (`tui-app.ts` folded branch): special-case
  `ask_user_question` — `resultPreview` becomes
  `askAnswersSummary(message.result)` (`— 2/3 answered`), falling back to
  the generic preview when the result is not the expected JSON. No raw JSON
  ever shows on the folded row.

- **Expanded** (settled branch, `tui-app.ts` ~4433): keep the summary line,
  then render one line per answer:

  ```text
  Question [ok]  — 2/3 answered
    ● route → api
    ● api → openai
    ○ skip-semantics — skipped
  ```

  - answered: `● <id> → <selected.join(', ')>` (or the `custom` text when
    `selected` is empty), `textDim`.
  - skipped (empty `selected`, no `custom`): `○ <id> — skipped`, `textMuted`.
  - The `●`/`○` marks mirror the question flow's own option marks
    (`question.ts` uses `[✓]`/`[ ]`; the card uses the dot marks for
    compactness — same family, no new glyphs).
  - Cancelled/aborted flows keep the existing error-identity branch.

- New helper in `src/present.ts`: `askAnswersLines(text): string[] | undefined`
  — parses the `{"answers":[…]}` shape (same shape-checking discipline as
  `askAnswersSummary`), returns display lines, `undefined` on unparseable
  input. `askAnswersSummary` stays (folded preview + web parity).

**Touch points**

- `src/present.ts` — `askAnswersLines` (reuses the parse shape of
  `askAnswersSummary`).
- `src/tui-app.ts` — folded `resultPreview` special case; expanded body
  renders the answer lines after the summary.

**Tests**

- `present` unit tests: `askAnswersLines` for selected/custom/skipped/mixed
  entries, malformed JSON → `undefined`, non-`answers` shapes → `undefined`.
- Headless: folded card shows `— 2/3 answered` (never `{"answers":`);
  expanded card shows the per-question lines; cancelled flow still shows the
  error identity.

---

## 4. Goal cards (`get_goal` / `create_goal` / `update_goal`)

### Why

The three goal tools ship `presentCall` but no `presentResult`, and their
render text is the raw `{"goal":…}` JSON — so every settled goal card showed
the bare JSON (folded preview AND expanded body), under the generic
"Tool call" header. The `todo_write` tool was audited alongside: its render
text is already friendly ("Updated todo list: N pending, …") and its header
carries the `done/total` summary — **no gap there**; only the goal family
needs the treatment.

### Design

All TUI-side (the tool definitions are upstream; the pattern is the same as
the `ask_user_question` card — `present.ts` helpers + `tui-app.ts` special
cases):

- **Headers** (`TUI_TOOL_TITLES`): `Read Goal` / `Create Goal` / `Update
  Goal` — the same read/create/update vocabulary as the tool-side
  `presentCall` titles. Args summaries (`summarizeToolArgs`): `create_goal`
  shows the objective, `update_goal` shows the action, `get_goal` shows
  nothing (an empty summary keeps the header to the title instead of
  leaking `{}`).
- **Folded preview** (`goalResultSummary`): `phase active · revision 3 ·
  2/6 rounds`, or `no goal set` for `{"goal":null}` — never the raw JSON.
- **Expanded body** (`goalResultLines`): one field line per fact —
  `● objective: …`, `● phase · revision N`, `● rounds: N/M`,
  `● blocked: code — message` (when a blocked reason is present),
  `● activation: …`; a single `no goal set` line for an empty goal.
  Cancelled/aborted calls keep the error-identity branch.

Both helpers parse the shared `{"goal":…}` shape leniently (missing fields
are omitted, malformed text returns undefined → generic fallback).

**Touch points**

- `src/present.ts` — `GOAL_TOOL_NAMES`, titles, `summarizeToolArgs` goal
  branches, `goalResultSummary`, `goalResultLines`.
- `src/tui-app.ts` — folded `resultPreview` special case; expanded body
  renders the field lines.

**Tests**

- `present` unit tests: summary/lines for a full goal, `goal: null`, a
  blocked goal, malformed JSON → `undefined`.
- Headless: folded card shows the summary (never `"goal"`), expanded card
  shows the field lines, `no goal set` verdict, and the named headers
  (`Update Goal edit`, `Create Goal ship it`).

## 5. Todo dock click (fullscreen)
### Why

In fullscreen the dock strip shows the todo summary (`☑ 2 active · …`) while
the todo panel is hidden — but clicking it does nothing: `handleFullscreenClick`
maps only the question frame, the todo **panel** area (when visible), and
transcript messages. The dock row falls through to the message branch, so a
click on the summary expands a random message card instead. The interaction
"click the summary to open the list" was never implemented, not broken.

### Design

`handleFullscreenClick` (`src/tui-app.ts`): compute the todo panel's
bottom-up geometry once (today it is computed inside the
`todoPanelVisible` guard), then add a dock-row region check **before** the
todo-panel branch:

```text
dockHeight = this.dock.render(width).length        // 0 when the summary is hidden
dockTop    = todoTop - dockHeight
if (dockHeight > 0 && y >= dockTop && y < todoTop) { this.toggleTodoPanel(); return }
```

Click semantics form a closed loop — the mouse can open AND close the panel,
no Ctrl+T needed:

```text
summary row (panel closed)  ──click dock row──▶  compact panel (5 rows)
compact panel               ──click panel──▶     full list (all todos)
full list                   ──click panel──▶     summary row (panel closed)
```

Implementation: the todo-panel branch calls a small new helper
`handleTodoPanelClick()` instead of `toggleTodoExpanded()` directly:

```ts
private handleTodoPanelClick(): void {
  if (this.todoExpanded) this.toggleTodoPanel()  // full → back to the summary
  else this.toggleTodoExpanded()                 // compact → full
}
```

Rationale:

- Clicking the `☑` summary row opens the compact panel (`toggleTodoPanel()`),
  exactly like Ctrl+T — the first click always has a visible reaction.
- Clicking the panel keeps the existing compact → full expansion
  (`toggleTodoExpanded`) so the full list stays one click away.
- Clicking the FULL list closes the panel and restores the summary row
  (`toggleTodoPanel()`) — the "click becomes the todo summary" behavior.
  This is the missing half: previously closing required Ctrl+T.
- When the panel is open the summary is hidden (`todoSummaryText()` returns
  `''`), so `dockHeight` is 0 and the dock branch is inert — the two regions
  never fight.

**Why `render(width).length` for the dock height**: the dock is a `Text`
component; an empty text renders zero rows in the VStack, so the height is
reliable even with the fork's "emptied pane keeps old pixels" quirk (that
quirk affects painted rows, not layout height — the alt screen repaints
wholesale each frame).

**Touch points**

- `src/tui-app.ts` — `handleFullscreenClick`: hoist the todo geometry,
  add the dock region branch; new `handleTodoPanelClick()` three-state
  helper.

**Tests**

- Headless (virtual terminal, fullscreen): click on the dock row →
  `isTodoPanelVisible()` true (compact); click on the todo panel row →
  `isTodoPanelExpanded()` true (full); click the panel again →
  `isTodoPanelVisible()` false and the dock summary text restored; with the
  panel open (dock empty) a click at the dock's former position does not
  toggle the panel closed.

---

## 6. JSON-result folded previews (web parity audit)

### Why

An audit of every dsh tool definition (four parallel passes over all
`defineTool` registrations) found the families whose render text is a raw
`JSON.stringify` dump with no `presentResult`: `schedule_create` /
`schedule_list` / `schedule_delete`, `cordis_inspect_list` /
`cordis_inspect_query` / `cordis_inspect_self`, and `ralph` (whose render
leads with a friendly line, so only its JSON tail was at risk). The web
renders all of these through `GenericToolCard`: the folded row shows only
the args summary (never the result), and the expanded OUT section shows the
result text verbatim — **no JSON beautification on the web either**.

### Decision (align with the web)

- **Expanded body stays verbatim** — the web shows the result text as-is,
  so the TUI keeps the raw text too (it already did; no change).
- **Folded preview never leaks JSON.** The TUI keeps its result-preview row
  (a kimi-style feature the web lacks) but shows a parsed summary instead:
  ralph → its friendly first line (or `status · N rounds` for a bare-JSON
  result), `schedule_list` → `N scheduled` / `no scheduled jobs`,
  `schedule_create` → `kind · state`, `schedule_delete` → `deleted` /
  `not found`, `cordis_inspect_list` → `N providers` /
  `no providers`, `cordis_inspect_query` → `platform · provider · method`,
  `cordis_inspect_self` → `mode <mode>`. When nothing can be derived the
  preview row is dropped entirely — never the raw JSON.
- The agent-team family (experimental, not in the production bundle) is
  deliberately excluded: two of its tools (`send_message`,
  `interrupt_agent`) share names with subagent tools whose render text is
  friendly, and a name-keyed set cannot tell them apart.

**Touch points**

- `src/present.ts` — `FOLDED_JSON_RESULT_TOOLS`, `parseJsonValue`
  (prefix-tolerant), `foldedResultSummaryFor`.
- `src/tui-app.ts` — the folded `resultPreview` branch for the set.

**Tests**

- `present` unit tests: every tool's summary phrase, the ralph friendly
  prefix, bare-JSON ralph, error shapes, undeducible results → `undefined`.
- Headless: folded cards show the summaries and never the raw JSON keys.

---

## Non-goals

- Workflow card rendering (`tool-workflow/*`) — reviewed, kept as-is.
- Alias completion for `!` lines (`-ic` startup cost, side effects).
- Parsing bash `complete` specs for arbitrary command argument completion
  (subcommand table only; file arguments already covered by fd).
- Regular (non-fullscreen) mouse support — the main screen has no
  `onCellClick` by design (terminal scrollback).
- Any change to the `!` context-submission guard/followup flow.
- Expanded-body beautification of JSON-result tools — the web shows the
  result verbatim; the TUI aligns. (agent-team folded previews excluded:
  experimental, name collisions.)
