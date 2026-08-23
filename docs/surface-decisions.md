# Surface decisions: plain-exit, queue notices, credential targets

Small user-visible behaviors that each needed a decision; kept in one doc
so a contributor can find the rationale without reading every file.

## Tool-card rendering follows the Web's render intents end to end

The TUI's tool cards already used the Web's row model
(`toolCardHeader` — design titles, SUMMARY_KEYS summaries, workspace-
relative paths) and the tool-owned render intents for the cards it
handled (`read`, `search`, `terminal`, `diff`). This change closes the
remaining gaps where a card fell back to raw JSON or raw result text:

- **`card: 'web'` result views** (`web_search` / `web_fetch`) now render
  their structured shape — the provider answer and source list (title —
  url, snippet under each) for a search, the URL and HTTP status for a
  fetch — with the same truncation marker placement as Web WebBlock.
  Previously the switch had no `web` case and the card fell through to
  the raw result text.
- **Generic cards with object `rawInput`** render per-tool one-line
  shapes instead of pretty JSON: `todo_write` renders a checklist
  (`●`/`○`/`✓` rows), `terminal_read`/`terminal_send`/`terminal_signal`
  a session target line, `session_event_trace`/`session_event_read` a
  `session_id · seq` line. Unknown objects keep the pretty-JSON fallback
  (the Web's own generic body behavior).
- **Generic cards with `content` blocks** (the plan tools'
  `exit_plan_mode`, plan review) render the content text instead of the
  raw model-facing result. Both the pending call (`presentCall.content`)
  and the completed result (`presentResult.content`) paths honor this.
- **The no-view generic fallback** renders with the Web's `resultText`
  semantics when result blocks are available: text blocks verbatim,
  other block shapes as pretty JSON — instead of the joined raw text
  alone.
- **Folded-card previews** add what the header lacks: `web_search`
  shows the query, `web_fetch` the URL, `skill` the skill name. The
  `todo_write` header itself now reads `2/3 done · first active` instead
  of a raw args dump (Web TodoRow parity), so the folded row does not
  repeat it.

Pure helpers live in `src/present.ts` (`webCardLines`,
`genericRawInputLines`, `resultTextLines`, `foldedCallPreview`,
`summarizeToolArgs`); the render layer in `src/tui-app.ts` owns colors
and layout. Pinned by `test/rendering.test.ts`.

## Plain `exit` quits the TUI

Typing exactly `exit` (trimmed, lowercase) in the editor and pressing Enter
quits the TUI — shell muscle memory. The intercept sits at the very top of
the runner's `dispatchUserInput`, BEFORE session creation and before the
busy-Enter steer gate, so `exit` never births a session and always quits
regardless of the delivery preference. `/exit` remains the command form;
any other prompt (including `exit!` or `Exit`) still goes to the model.

## Background-subagent settlement notices never appear in the queue pane

The queue pane is the mirror of the agent's inbox and therefore a
USER-INPUT surface (kimi's queue pane lists only queued prompts). dsh
pushes two kinds of background-subagent notices into the parent's inbox:

- continuable children: `source.kind === 'subagent-settled'` (the
  continuation manager's settlement notice);
- one-shot background subagent jobs: `tool-jobs` completion notices whose
  summary starts with `subagent `.

Both are the runtime's account of a child ending, not steerable input, so
the queue mirror drops them (`isSubagentSettlementNotice`). The task
browser is their surface: terminal job rows (one-shot), inactive child rows
(continuable), `/subagents` for transcripts. A FAILED settlement
additionally surfaces once as a transient error notify
(`subagentNoticeIsFailure`, classified on the producers' deterministic
wording — "finished and" is the only success phrasing for
`subagent-settled`; `[status: failed|killed]` for tool-jobs). The dsh-side
delivery is unchanged: the parent model still receives the notice; only the
TUI's queue mirror filters it. Bash-job notices stay in the queue.

Classification helpers: `src/index.ts` (`isSubagentSettlementNotice`,
`subagentNoticeIsFailure`), pinned by `test/queue-notices.test.ts`.

## /login and /logout resolve credential targets, not just DEEPSEEK_API_KEY

The official deepseek adapter authenticates through `DEEPSEEK_API_KEY`;
the llm-pi-ai adapter (a multi-provider seam) declares one route per
provider, each carrying its own `apiKeyEnv` credential ref in the
`llm-pi-ai` settings section (`providers.<route>.apiKeyEnv`). /login and
/logout resolve their argument against the MERGED credential catalog: the
llm configurable-provider directory (`ctx.llm.listConfigurableProviders()` —
every installed pi-ai catalog route, dormant or not, plus hand-declared
profiles) overlaid on the settings section. A route with a stored profile
carries its `apiKeyEnv`; a route without one falls back to the conventional
derived reference (`<ROUTE>_API_KEY`, the web Models page derivation). The
set is deduped by ref, deepseek official first. The settings-only read is
the fallback when the llm service is absent.

- no argument → a searchable picker grouped by configured / available ·
  catalog / custom (the fork's SelectList renders the group headers from
  the `group` field — never synthetic selectable header rows), with an
  `[ Add New Platform ]` action row last, then the key-entry question;
- an argument matching a route name (or its first word, so `/login
  deepseek` reaches the official entry) → that route's `apiKeyEnv`;
- an env-var-looking argument (`OPENAI_API_KEY`, `MY_CUSTOM_KEY`) → used
  verbatim, uppercased when typed lowercase (the original escape hatch —
  `/login my_custom_key` sets `MY_CUSTOM_KEY` exactly like the old
  `.toUpperCase()` did). The typed name is NEVER re-derived through
  `deriveKeyRef` — that would silently corrupt the target into
  `MY_CUSTOM_KEY_API_KEY` (a wrong-ref regression, guarded by a test);
- a valid route pattern that names NO catalog entry (e.g.
  `/login acme-gateway`) → the add-provider wizard with the route
  pre-filled: wire protocol, base URL, display name, API key, then
  `llm.discoverModels` probes the endpoint for its advertised models
  (failure falls back to hand entry; at least one model is required), and
  the profile persists through `settings.mutate` + the credential. The
  base URL and models are required ONLY for hand-declared routes — a
  catalog route has both from the installed catalog, so `/login
  anthropic` still just asks for the key. `apiKeyEnv` is written into the
  profile only when a key was stored (web parity: a keyless route keeps
  provider-native auth). The profile write and the key write are reported
  separately, so a persisted profile with a failed key write says
  "provider added, but storing the key failed" instead of claiming the
  whole add failed;
- anything else → an error listing the valid options.

Without the settings service (or the llm-pi-ai section) the option set
degrades to the official target only, preserving the old behavior.

The `/login`/`/logout` surface refreshes the footer model row and the
welcome card on `llm/adapters-updated`, `settings/document-updated`
(llm-pi-ai/llm-deepseek namespaces only) and the credential events
(`credentials/reference-updated` and `credentials/record-updated` — the
0.1.1-rc.1 split of the old `credentials/updated`), so a provider added
here — or edited externally in `settings.yaml` / `.credentials.yaml` —
shows up without a restart. `/login` supports both CredentialRef
(API-key) and CredentialKey authorization-flow targets.

Resolution helpers: `src/provider-catalog.ts` (`providerOptionsFor`,
`credentialOptionsFor`, `resolveCredentialArg`, `deriveKeyRef`,
`ROUTE_PATTERN`), pinned by `test/provider-catalog.test.ts` and
`test/login-credentials.test.ts`.

## The subagent viewer is mode-aware: continuable = interactive, one-shot = read-only

The child viewer's interactivity is keyed SOLELY to the catalog mode carried
through the whole chain (`SubagentListEntry.mode` → `TaskBrowserRow.mode` →
`SubagentViewerTarget.mode`), never guessed from running/inactive state, and
never re-derived inside the viewer. A `continuable` viewer's editor is LIVE:
Enter delivers the text as the child's NEXT turn through
`ctx.subagents.followup(exactLiveParent, childId, …)` — FIFO, no interrupt,
no steer. Decisions a future change must not silently reverse:

- **The viewer editor is a PLAIN text editor.** Everything typed — including
  lines that start with `/` — is delivered to the child as text; slash
  commands are NOT executed against the parent, and the child gets no
  command-execution wire. Parent-only actions (Ctrl+S steer, Ctrl+Enter
  queue, Alt+↑ dequeue, Shift+Tab permission, Ctrl+F/Ctrl+Shift+F main
  search, Ctrl+C/D exit chords, ↓ task browser, Ctrl+G external editor,
  Ctrl+V image intake) are consumed by the host BEFORE the ladder reaches
  the editor, so the viewer can never act on the parent session.
- **The write path is exactly one**: the runner's `onSubagentSubmit` →
  `submitSubagentFollowup` (src/subagent-viewer-submit.ts) → the exact live
  direct parent check → `ctx.subagents.followup`. Never
  `ctx.agents.get(childId).followup(...)` (bypasses the continuation
  manager / cold resume / direct-parent authority), never the parent's
  submit/steer/queue path.
- **Viewer submissions never enter the shared editor history.** An ↑ recall
  in the MAIN editor must not resend a child-scoped follow-up to the
  parent. The fork editor's own per-editor recall is untouched.
- **Failed deliveries restore into the child's OWN draft slot**, merged
  below anything the user typed meanwhile (`mergeDraft` semantics), and a
  send that outlives a viewer switch/close restores into the OLD child's
  slot via `restoreSubagentDraft` — the current surface is never polluted
  (the TuiApp viewer generation is the stale-guard anchor).
- **Transcript rows come only from the child's real session events** — an
  accepted follow-up never inserts a fake user row; the child's own
  `user/message` event lands in the viewer folder through the normal
  folding.
- **Images are out of scope** for viewer follow-ups: the main-session image
  draft store is deliberately never shared with the child (a per-child
  image store is a later milestone).
- **The footer switches to the VIEWED child while a subagent viewer is
  open.** The parent session's status (permission/model/plan/task badges,
  extension footer segments) describes a session the user is not looking
  at, so the runner pushes a `SubagentViewerFooter` (label, mode badge
  `[subagent · continuable]` / `[subagent · one-shot]`, activity, cwd,
  the child's OWN turns/steps and stats line from a per-viewer StatsFolder
  fed only the child's own events) and clears it on exit / session swap.
  The footer is refreshed at step/end and turn/end (never on streaming
  deltas). **Extension footer segments do not render while viewing**:
  viewer mode is host-owned chrome, the extension surface already exposes
  `viewerMode` in its session state, and the first-party builtin's
  turn/step segment would otherwise duplicate the child counters with the
  parent's. Header extension badges keep rendering (they do not conflict
  with the child identity). No extension API changed (additive-only).
