# Input and card polish: bash completion, local-shell sandbox, question answers, goal cards, todo dock click, JSON folded previews, shell editor mode

Seven small, independent surface improvements, designed together because they
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
| 7 | `!` / `!!` shell editor mode | The prefix is EDITOR STATE, never document text; serialized back into the textual protocol only at host boundaries |

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
- **One spawn per request, hard-capped.** `timeoutMs` 300ms locally,
  1500ms under GitHub Actions (a runner `bash -lc` cold start measured
  260-310ms — the tight cap made the suite flaky there; local stays tight),
  `AbortSignal`
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
- **Item shape.** `AutocompleteItem { value, label }` — the compgen
  command list carries names only, and resolving each candidate's path
  would need an extra `which`-style spawn per keystroke, so items carry no
  description (revised from an early draft that promised a `which`-style
  path; `$VAR` and subcommand items are name-only too).
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

## 7. `!` / `!!` shell editor mode: the prefix is state, never document text

### Why

The editor used to keep the literal shell prefix in the draft (`!git status`).
The prefix is presentation + state, not text: it must never be part of the
document (no cursor-offset/render hacks, no debounce to distinguish `!` from
`!!`), and the shell business layer (`src/shell-context.ts`) must keep
receiving the exact same wire text as before. kimi's `CustomEditor` stores
`inputMode: 'prompt' | 'bash'` and never puts the `!` in the buffer; this
extends that two-state model to dsh-pi-tui's two-shell-semantics (`!` =
context, `!!` = local).

### Design

Three explicit modes — `prompt`, `shell-context`, `shell-local` — owned by
`TuiEditor` (`src/tui-editor.ts`), with a pure codec in
`src/editor-input-mode.ts` (`shellPrefixForMode` / `serializeEditorInput` /
`editorModeFromHistoryEntry`). The buffer holds the bare command body; the
mode is serialized back into the textual `!`/`!!` protocol ONLY at host
boundaries.

**Transitions** (empty body only): `!` → shell-context, `!` → shell-local,
Backspace steps back (`!!` → `!` → prompt), Esc cancels the whole shell mode
(autocomplete Esc closes the dropdown first). A `!` after body text is an
ordinary character; in shell-local an empty-body `!` is a literal body
character (no fourth mode). Bracketed paste into an EMPTY PROMPT that starts
with `!`/`!!` normalizes into the matching mode in one synchronous pass; a
paste into a non-empty editor or an already-shell-mode editor is never
reinterpreted (its `!` is body text, so the serialized wire form matches the
pre-mode behavior).

**Boundaries** (the compatibility contract):

- **Submission** — Enter, Ctrl+Enter (queue), Ctrl+S (steer), the plugin
  action sink and the subagent submit path all serialize the mode into the
  wire form before the text leaves the app; the mode resets to `prompt`
  BEFORE the dispatch (a synchronous rejection restores the serialized text
  through `setEditorText`, which decodes the mode back). Emptiness checks
  judge the SERIALIZED form, so a bare `!`/`!!` still reaches the protocol.
- **Restores** — `setEditorText` / `setDraft` decode serialized input
  (`setSerializedInput`); `insertIntoEditor` stays raw. The subagent viewer
  draft slots and `mainDraftBeforeViewer` store the SERIALIZED form and
  decode on restore.
- **History** — entries stay serialized (no migration); recall decodes
  (`!!` before `!`); `onHistoryDraftSave`/`onHistoryDraftRestore` keep the
  mode across ↑/↓ browsing.
- **Completion** — `MentionProvider` synthesizes a VIRTUAL `!`/`!!` line for
  the shell grammar (`src/shell-completion.ts` untouched); the applied
  completion never writes the synthetic prefix into the buffer. In a shell
  mode a leading `/` is a PATH, never a slash command: natural triggers stay
  quiet and Tab forces path completion (the fork's `handleTabCompletion`
  routes a space-free leading-`/` line to slash completion, so `TuiEditor`
  intercepts Tab in shell modes).
- **Handoffs** — plugin editor handoffs transfer the WIRE form (a plugin's
  document IS the wire form) and the host restore decodes it back, with the
  flat cursor offset shifted by the prefix length (mode-derived for the
  host, text-derived for a plugin seat). `adaptHost` exposes
  `setSerializedInput` only when the underlying adapter implements it, so
  older structural adapters fall back to `setText` — never a dropped draft.
- **Esc ladder** — the busy cancel is Host-owned and runs before both the
  shell-mode exit and a replacement editor's Esc; a DECLINED plugin Esc
  falls through to the host cancel ladder; a CONSUMED Esc (plugin or
  `onSingleEscape`) disarms the pending double-Esc window.
- **Chrome** — the ↓ task-browser gate and the footer `↓ view` hint read the
  VISIBLE seat mode (`seatInputMode()`), never the hidden host editor's
  stale mode.

**Rendering** — the mode prompt is painted over the reserved 2-cell padding:
`❯ ` (roleUser), `! ` and `!!` (both `shellMode`) — all exactly two cells, so
the body/cursor never jump on a mode switch. The editor border uses
`shellMode` in shell modes via a dynamic function that reads the live palette
(theme-switch safe). The placeholder hint renders only in prompt mode.

**Touch points**

- `src/editor-input-mode.ts` (new) — the pure codec.
- `src/tui-editor.ts` — mode state, transitions, render, paste
  normalization, history hooks, Tab routing.
- `src/tui-app.ts` — boundary serialization/decoding, Esc ladder, seat-mode
  routing, footer hint.
- `src/mentions.ts` — the virtual completion prefix.
- `src/editor-seat-holder.ts` — `getInputMode`/`setSerializedInput` on the
  seat surface, wire-form handoff.

**Tests**

- `test/editor-input-mode.test.ts` — the pure codec (serialize/decode,
  `!!` before `!`, literal `!` in the body).
- `test/shell-editor-mode.test.ts` — transitions, paste normalization,
  submission serialization + rejection restore, history recall/draft
  restore, completion (virtual prefix, path-vs-slash), rendering (prompt
  symbols, border colors, no duplicate prefix), Esc priority (busy,
  autocomplete, plugin consume/decline, window disarm), handoff round-trips
  (mode, cursor, bare adapters), task-browser/footer seat-mode routing.
- `test/shell-completion.test.ts` — provider-level virtual-prefix coverage.

**Review record** — nine review rounds (codex / gpt-5.6-luna, read-only,
fresh context per round) over the feature commits: rounds 1–8 `needs-fixes`
(busy-Esc priority, bare-`!` emptiness checks, paste normalization scope,
handoff wire-form transfer, seat-mode routing, sink steer serialization,
adapter capability gating, declined/consumed plugin Esc handling, cursor
restoration), round 9 **accepted, no open findings**. 1964/1964 full-suite
tests, typecheck, `git diff --check`, and the pre-push gate (pack + all
smokes) clean; the vendored fork and the public extension surface are
unchanged.

**PR review round** (human, item-by-item against the plan) — six findings,
all fixed in follow-up commits:

1. The external editor (`Ctrl+G`) now round-trips the WIRE form:
   `launchExternalEditor` serializes the draft (`!pwd`, never the bare
   body) and decodes the saved text through `setSeatSerializedInput`, so
   `! ↔ !! ↔ prompt` switches made in `$EDITOR` follow (a plugin editor
   keeps identity). Regression tests: shell-mode round-trip, prompt draft
   edited into a shell line.
2. **Paste normalization moved BEFORE the base document** (the undo
   invariant): bracketed paste is captured at the raw layer, the
   empty-prompt `!` / `!!` prefix is stripped pre-insert, and the
   normalized content is re-wrapped as a bracketed paste for the fork's
   full `handlePaste` path (text normalization, large-paste registry,
   atomic undo). Undoing a normalized paste can never resurrect a raw
   `!!` in the document — the shell-editor-mode invariant holds, and
   large (>10 lines / >1000 chars) shell pastes enter the shell mode
   through the paste registry. Regression tests: undo after a normalized
   paste, large-paste registry.
3. **Handoff cursor coordinates unified on the WIRE document**: a host
   shell-mode cursor shifts by the mode prefix, a host prompt-mode
   literal `!` is a document character (never shifted), a plugin cursor
   IS the wire cursor, the decoding host restore shifts by the actually
   stripped prefix, and a legacy raw restore keeps the wire cursor (the
   `!` stays in the text). Regression tests for all four conversions.
4. **A mode transition cancels the open autocomplete**: `setInputMode`
   closes the dropdown (the completion grammar changed — a prompt-mode
   file list must not accept suggestions into a shell body). Regression
   tests in both directions (`!` entry, Backspace step-back).
5. **One-shot viewers reset the host editor to prompt mode**: the
   read-only placeholder bar routes through `setSeatSerializedInput`, so
   a stale shell mode never renders as `! viewing subagent: …`, and the
   preserved serialized main draft restores the shell mode on exit.
6. **Stable autocomplete extension compatibility**: the M5 plugin-chain
   query is adapted back to the WIRE document — a shell-mode body is
   re-prefixed (`git che` → `!git che`, cursor shifted) with the query
   shape unchanged, so a third-party plugin keeps parsing shell lines
   exactly as before the feature. Regression test asserts the wire lines
   in shell-context / shell-local / prompt.

All six fixes landed with regression tests, followed by two more review
rounds (codex / gpt-5.6-luna):

- **Round 10** (on the PR-review fixes): P1 — residual input before the
  opening marker / after the closing marker was forwarded straight to the
  base editor, bypassing the shell-mode interceptions, and split opening
  markers were not buffered (FIXED: residuals re-enter the full
  interception chain — a leading `!` in the same chunk enters the shell
  mode before the paste lands, trailing keys append as ordinary input —
  and a trailing `\x1b[20`/`\x1b[200`/`\x1b[201` prefix is stitched onto
  the next chunk, with a complete `~`-terminated marker never mistaken
  for a split prefix); P2 — the autocomplete reopen ran before the paste
  landed (FIXED: it now runs after the normalized paste and residuals).
- **Round 11**: P1 — the marker tail buffering missed the `\x1b[` /
  `\x1b[2` split boundaries (FIXED: every proper prefix of the markers is
  buffered; a LONE `\x1b` tail is deliberately NOT buffered — it IS the
  complete Esc key, and real terminals write a paste marker atomically);
  P2 — per-segment recursion could overflow the stack on a chunk with
  many paste segments (FIXED: the paste drain is iterative); P1 — the
  Stable-extension wire adapter and the provider's virtual prefix applied
  the prefix to the CURSOR line instead of LINE 0, breaking multiline
  drafts (FIXED: the wire document carries the prefix on line 0 only, and
  only a first-line cursor shifts by it); P2 — this review record went
  stale (updated here).
- **Round 12**: P1 — Ctrl+C cleared only the shell body, leaving a stale
  `!` / `!!` prompt on the now-empty editor (FIXED: the first Ctrl+C
  clears the body AND resets the mode to `prompt`, treating the
  serialized draft as non-empty — a bare `!` also clears back to the
  prompt before the exit window arms); P2 — the recorded test count went
  stale again (updated here).
- **PR review round 2** (human, wire-form boundary audit): two P1
  findings, both fixed —
  1. The replacement-editor declined-input fallback
     (`EditorSeatHolder.handleHostFallbackInput`) treated the plugin's
     wire document as the host's bare body: a declined `!` was consumed
     into the host mode state and VANISHED from the plugin. The fallback
     now round-trips through the wire coordinates (decode the staged
     draft via the narrow setTextAndCursor seam + the decoded mode, run
     the host editor, serialize the result back with the cursor shifted
     by the prefix). Regression tests: declined `!`/`!!`/Backspace
     round-trips on the plugin document.
  2. The autocomplete wire adapter only covered get/query, not apply:
     accepting an absolute-path suggestion in a shell mode ran the fork's
     apply on the BARE body, so `/u` was mistaken for a slash command
     (`//usr/ `), and Stable-extension suggestions suffered the same
     asymmetry. The apply is now SYMMETRIC: non-shell applies run on the
     VIRTUAL wire document and the synthetic prefix is stripped from the
     result. The delegated provider also inherits the shell-mode
     natural-trigger suppression (a leading `/` never consults the plugin
     chain mid-typing, which would double-apply on the next Tab).
     Regression tests: `/u` → `/usr/` in both shell modes, extension
     suggestions accepted into the bare body, natural-typing suppression.
- **Round 14** (on the round-2 fixes): P1 — `adaptHost` always exposed
  `setInputMode` even when the underlying adapter does not implement it,
  so a half-capable adapter (setSerializedInput without setInputMode)
  silently discarded the decoded mode in the declined-input fallback
  (FIXED: the mode setter is capability-gated exactly like
  setSerializedInput, and the wire round-trip requires the FULL pair —
  a partial adapter falls back to the raw path, so a declined `!` is
  never dropped). Regression test: a partial adapter preserves a
  declined `!` in the plugin document.
- **Round 15**: P1 — `getDraft()` returned the bare body while
  `setDraft()` decoded the wire form, so read-merge-restore callers (the
  runner's restore paths, the dequeue merge, the steer action) silently
  lost the shell mode (FIXED: `getDraft()` now returns the WIRE form —
  the symmetric counterpart of `setDraft()` — and `submitDraft` consumes
  it directly without re-serializing); P1 — a Stable extension may return
  a completion prefix computed on the WIRE line it received (e.g. `!ch`),
  and applying it on the bare body corrupted the result (FIXED: the
  delegated apply normalizes a wire-prefixed prefix back to bare
  coordinates — line 0 in a shell mode only — before the host apply, so
  the synthetic prefix is never doubled or stripped twice); P2 — the
  async-polling test helpers were flagged as fixed-delay polling
  (BY DESIGN: the poll-until-deadline helpers are the repository's
  established async-UI pattern — the same waitForDropdownRow shape used
  across tui-editor/rendering tests — with a bounded deadline and a
  condition check, never a fixed-delay assertion). Regression tests:
  getDraft/setDraft wire symmetry incl. merge-restore round-trips, and a
  wire-prefixed extension prefix applying cleanly.
- **Round 16**: P1 — the extension prefix normalization stripped a
  MID-BODY literal `!` token (e.g. `echo !ch`) along with the synthetic
  prefix (FIXED: the strip now applies ONLY when the prefix starts at
  the WIRE line start — `cursorCol + synthetic − prefix.length === 0` —
  so a literal document `!` is never touched); P2 — the marker-tail
  buffering was flagged for swallowing an incomplete non-paste CSI tail
  that never receives a continuation (BY DESIGN, documented in code and
  here: the stitched tail flows through the normal chain when it never
  forms a marker — which also REPAIRS split CSI sequences the fork
  otherwise drops — and real terminals send each key's sequence
  atomically, so an input stream ending mid-CSI does not occur in
  practice; the upstream editor is strictly worse, losing the tail
  immediately). Regression tests: a mid-body `!` completion token keeps
  its literal `!`; an incomplete CSI tail buffers without loss and
  stitches a split sequence.
- **PR review round 3** (human, multiline shell audit): P1 — a
  continuation line (`! echo foo \` + `/u`) still treated a leading `/`
  as a slash command, because the line-0-only virtual prefix was also
  used for the host's SHELL-SEMANTIC routing (natural-trigger
  suppression, apply classification, Tab gating). FIXED: the two
  concepts are now split — the WIRE representation keeps the synthetic
  prefix on line 0 only (shell-grammar parse + extension query), while a
  SHELL-SEMANTIC context stages the prefix on the CURSOR line of ANY
  shell-mode line and strips it from the result, so slash-vs-path
  routing, apply classification and Tab gating treat every line as
  shell-owned. Regression tests: continuation-line `/u` in both shell
  modes (natural typing stays quiet, Tab lists `/usr/`, accept never
  doubles the slash), plus a provider-level multiline apply/Tab-gate
  test.
- **Round 18** (on the round-3 fix): P1 — the Stable-extension
  delegating provider's natural-trigger suppression still carried the
  `cursorLine === 0` restriction, so a continuation-line `/` could still
  consult the plugin chain mid-typing (FIXED: the suppression now covers
  ANY line of a shell-mode document, matching the host provider's
  shell-semantic rule; the wire query keeps the line-0-only prefix).
  Regression test: the extension chain is never consulted on a
  continuation-line natural `/` trigger (Tab still consults it once).
- **Round 20** (after a rebase; rounds 17/19 were stale pre-rebase diff
  artifacts of main's own hook/runtime-migration commits): P1 — a plugin
  editor CONSUMING input mutated its document without notifying seat
  subscribers, so EditorHost.subscribe observers (the continuable-viewer
  draft mirror) kept a stale snapshot and could merge an outdated draft
  on handoff/viewer exit (FIXED: a consumed key now calls
  `notifyChanged()` alongside `invalidate()`); P1 — the completion mode
  adapters read the HIDDEN host editor's mode, so a stale shell mode
  leaked into completion routing while a plugin editor occupied the seat
  (FIXED: the MentionProvider mode source and the delegated provider's
  getMode now read the VISIBLE seat via `seatInputMode()`). Regression
  tests: a plugin-consumed key pushes the fresh snapshot to
  subscribers; a prompt-semantics plugin seat never gets the hidden
  host's synthetic prefix.
- **Round 21**: P1 — the ADVANCED editor controls' `setEditorText`
  wrote the draft RAW through the seat, so replacing a shell-mode draft
  with plain text left the stale `!`/`!!` mode active and the
  replacement submitted as a shell command (FIXED: the advanced setter
  now routes through `setSeatSerializedInput` — the host editor decodes
  serialized input, a plugin editor gets the raw text); P2 — the
  async-polling test helpers were flagged AGAIN as fixed-delay polling
  (BY DESIGN, re-confirmed: `waitForRender` itself — the repository's
  established async-test helper — is a 20ms-delay flush, and the
  same waitForDropdownRow poll-until-deadline shape ships in
  tui-editor.test.ts; poll-until-deadline with a condition check is the
  repository's async-UI pattern, never a timing assertion). Regression
  test: advanced controls replace a shell-mode draft through the wire
  boundary (plain text clears the mode; serialized text re-enters it).

The full-suite tests (2060+), typecheck, `git diff --check` and the
pre-push gate (pack + all smokes) all pass; the vendored fork and the
public extension surface remain unchanged.

---

## Review record

Independent review chain (codex / gpt-5.6-luna, read-only, fresh context per
round) over the three commits plus the round-1 fixes:

- **Round 1 — needs-fixes (10 findings).** P1: folded question/goal previews
  leaked raw JSON on parse/shape failure; folded branches did not prioritize
  `message.error`; question-modal clicks outside the frame reached background
  routing; failed compgen runs were cached as empty command sets; the
  completion bridge had no deterministic spawn/cache test seam; the sandbox
  preference silently downgraded to spawn when `ctx.shell` is absent. P2:
  answer summary totals could disagree with the expanded lines (malformed
  entries); the question-frame stale guard checked rows only; completion and
  `!` execution used different working directories; the item-shape doc
  promised a path description that was never implemented.
- **Round 1 fixes.** Folded previews drop the row entirely when nothing safe
  can be derived and never run for failed calls; the question branch captures
  every click while a question is up; `CompgenRun { ok, lines }` with
  success-only caching plus an injectable runner and cache-reset seam;
  `parseAnswerEntries` shares one normalization (a malformed entry
  invalidates the whole set, web `every-isAnswer` parity); `termColumns` is
  recorded and guarded alongside rows; `!` runs in `sessionCwd()` (pi
  parity); an opted-in sandbox with no shell capability notifies every run.
- **Round 2 verdict — accepted, no open findings.** 154/154 targeted and
  1227/1227 full-suite tests, typecheck, `git diff --check`, and the CJK scan
  all clean; the working tree was not modified by the reviewer.

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
