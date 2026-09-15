# Server/client migration — coupling inventory

> Part of milestone M0 (see `docs/client-server-migration.md` for phase
> status). This file is the **coupling allowlist** referenced by the
> AGENTS.md "Server/client migration guardrails (hard rules)": existing
> Host coupling may stay here until its owning phase moves it; new coupling
> is rejected by `scripts/client-boundary-gate.mjs` (baseline allowlist +
> no-new-debt).

## How the allowlist works

- `scripts/client-boundary-gate.mjs` scans `src/` for Host-coupling patterns
  (the `ctx.get('service')` / `ctx.<service>` forms and
  `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-session` type imports) and
  compares against the frozen baseline
  `scripts/client-boundary-baseline.json`.
- The baseline is the **current** inventory below, at (file, pattern)
  granularity — a new pattern in an already-allowlisted file is still new
  debt and fails the gate.
- Updating the baseline is a deliberate maintainer action, only when a
  migration phase legitimately relocates coupling into a semantic port
  (e.g. M1 moves `subagents` out of the runner). Never update it to absorb
  new feature debt — that is exactly what the gate exists to stop.
- The gate deliberately does NOT flag: the TUI's own services
  (`TUI_STARTUP_SERVICE`, `PI_TUI_EXTENSIONS_SERVICE`), Cordis process
  services with no Host business state (`loader`, `appExit`), and
  `src/startup.ts` (the zero-dependency compatibility island — see
  `docs/client-server-migration.md` §Startup).
- The gate also covers `goal`, `planMode` and `sandboxPolicy` (dsh Host
  services with **zero baseline entries today** — no current `src/` usage).
  Any future feature that reads them is new Host coupling and must route
  through the runner/allowlist, never a UI module. The M0 status semantics
  layer is the sanctioned seam: `src/status/derive-*.ts` read the official
  services through STRUCTURAL interfaces (generic over the event type, so
  the derives carry no Host type imports), and the runner (`src/index.ts`)
  wires the real services in — the two new `index.ts` baseline entries
  (`planMode`, `sandboxPolicy`) are exactly that wiring, not UI debt.

## Categories

| Category | Meaning | Retirement |
|---|---|---|
| `DIRECT_HOST_REQUIRED` | Direct-mode-only machinery; must survive until the Host owns every write | M8 (prove Host-owned writes + cross-client concurrency first) |
| `MIGRATABLE` | Business Host access that a semantic port + wire adapter can replace | M1–M5, capability by capability |
| `CLIENT_LOCAL` | No Host coupling today; must stay that way | never |
| `TEMPORARY_EXCEPTION` | Allowed by design, not migration debt | never (documented carve-outs) |

The Direct owned-session retirement
(`src/runtime/direct/owned-session-retirement.ts`) is a structural,
callback-only helper: it imports no Host package and touches no `ctx`, so it
adds ZERO baseline entries. The runner (`src/index.ts`, already the primary
Direct coupling point) wires the live Agent / AgentHandle / sessions /
subagents into it — the same Direct ownership escape the runner already
owns. This is Direct ownership retirement, not a semantic-port or Remote
capability (see `docs/client-server-migration.md` §Direct ownership
retirement).

## Inventory (baseline, generated from the current tree)

### DIRECT_HOST_REQUIRED

| File | Coupling | Notes |
|---|---|---|
| `src/index.ts` | `agents`, `sessions`, `subagents`, `jobs`, `attachments`, `llm`, `commands`, `settings`, `sessionPersistence`, `agentPresets`, `tools`, `permissionPresets`, `tokenMeter`, `agentDefaultModel`, `shell`, `planMode`, `sandboxPolicy`; `import:dsh-agent`, `import:dsh-session` | The runner: agent create/open (Direct uses agents.resume internally), session ownership, event subscription, input dispatch and transition coordination. D2.1 routes semantic session writes, pending-input reads, Host command execution and Task Center child interruption through their domain ports; this remains the primary Direct coupling point (plan §4.1). M1.8/M1.9 relocated `credentials`, `authorization` and `userQuestions` into the config/interaction adapters; `llm`/`tools`/`permissionPresets`/`tokenMeter` remain here ONLY for the runner's own non-command paths (boot diagnostics, status footer, the pre-mount surface prefetch and the image-submission preparation — never for command handlers). `planMode`/`sandboxPolicy` are the M0 status-seam wiring (the derives consume them through structural interfaces). |
| `src/session-fork.ts` | `import:dsh-agent`, `import:dsh-session` | Fork/rewind mechanics; Direct-mode agent handles (the AgentHandle escape, M8). |
| `src/rewind.ts` | `import:dsh-session` | Rewind mechanics. |

### MIGRATABLE

| File | Coupling | Notes |
|---|---|---|
| `src/commands.ts` | `import:dsh-agent`, `import:dsh-session` | The command runner — M1.7–M1.11 narrowed it to ZERO `ctx.get` and ZERO service-object access: every Host read/write a command performs goes through the semantic ports (`catalog`/`config`/`hostFile`/`sessionReader`/`sessionWriter`/`interaction`); the `CommandHostCapabilities` facade and `runner.host` are RETIRED. The remaining type-only imports are the runner's Direct ownership escape (live Agent/Session types), kept until M8. |
| `src/skill-catalog.ts` | `agentPresets`, `skills` | Already isolated: structural types + capability detection (decision 11). The pure catalog logic the Direct catalog adapter (M1.8) wires — the coupling stays attributed here. |
| `src/surface-catalog.ts` | `commands` | Isolated catalog module; the runner's pre-mount surface prefetch and the coordinator's live-agent read hook (agent-owned, M8 escape — the sessionless STANDING read now routes through the catalog port, M1.8). |
| `src/skill-catalog-refresh.ts` | `import:dsh-agent` | Coordinator; agent-scoped refresh. |
| `src/subagent-viewer-submit.ts` | (structural `ctx.subagents` official prompt surface, injected) | The pure human-prompt delivery core (alpha.4's `ctx.subagents.prompt`); consumed by `SubagentPort` (M1.2). The runner resolves `queue` / `steer` for continuable viewer gestures against child activity and `busyEnter`; the port forwards the result. Task Center interruption is a separate `SubagentPort.interrupt()` operation (D2.1). |
| `src/runtime/direct/subagent-direct.ts` | `subagents` | The Direct `SubagentPort` adapter (M1.2/D2.1) — the ONLY module in the prompt and interrupt paths that touches `ctx` (and the only one minting the caller-owned prompt `requestId`); it maps explicit parent/child interruption to the official user-authority call. The runner depends on the port. Baseline entry added by the M1.2 relocation. |
| `src/runtime/direct/session-direct.ts` | `import:dsh-session`, `sessionPersistence`, `sessionQuery`, `agentPresets`, `tokenMeter` | The Direct `SessionReader` adapter (M1.3, extended M1.11 + master alignment) — owns master-visible semantic session-query listing (live rows remain visible without `cwd`; cold rows require `cwd`), official-parity content search (`SessionReader.search()` → `sessionQuery.searchSessions()` with master `ApiSessionList.search()` business semantics — the pure cursor/authorization/dedupe loop lives in `session-search-direct.ts`, the retired TUI-owned newest-100 + `filterEvents` private rule is gone) and best-effort context measurement (`measureContext`, the /status row); the combined `title`+`agentPreset` projection batch delegates to `session-projection-direct.ts` (the official live-cached-snapshot/cache-checkpoint ladder, with cold misses left unknown). The TUI-local title cache and the `readTitleSnapshots()` path are retired — the adapter's structural query surface no longer even declares them. The migration-era `readExportData` seam is RETIRED (Pre-Stage-D export convergence): the export plane is the `SessionArchivePort` (`session-archive-direct.ts`), never this reader. The consumer (commands.ts) depends on the port. Baseline entries added by the M1.3/M1.11 relocations, the master projection-cache contract, and the projection module split (the cache/`sessionProjections` reads moved with it). |
| `src/runtime/direct/session-archive-direct.ts` | `import:dsh-session` (the `dsh-session-log-export` utility package — the gate's prefix pattern classifies it under `import:dsh-session`) | The Direct `SessionArchivePort` adapter (Pre-Stage-D export convergence) — the ONLY module in the export path that touches the Host archive primitives: `sessionLogExportDeps` service resolution, `flushLiveSessionLog` through the store's durability barrier, the committed-log READ handle (never the cold-view observation seam), and the official full-tree ZIP stream (`streamSessionLogZip`, descendants + attachments). The FILE WRITE stays Client-local (`client-artifact-save.ts`); a future Remote adapter maps the same port onto `GET/HEAD /api/session.export`. Baseline entry added with the module itself. |
| `src/runtime/direct/session-preset-direct.ts` | `agentPresets`, `import:dsh-session`, `sessionQuery`, `sessionProjections` | The Direct session-preset adapter — explicit resume/preset paths read cold sessions through the official `sessionQuery.observeSession()` observation seam (the engine owns live/cold source selection, persistence borrow/preparation, projection-cache hydration, tail replay, and the projection cut); picker enrichment stays on the live/cache-only projection path. D2.3 adds `selectBlankSessionPreset()`, the official in-process `agentPresets.select(agent, id)` write used by the Direct catalog adapter to SWITCH an already-created BLANK Session (the Host owns the blank check, recompose transaction and durable `agent-preset/selected` commit). It is NOT the fresh-create/launch `--preset` path: a fresh Session carries its preset at creation time (Direct compose/mount setup; Remote atomic `session.create({ agentPreset })`). The TUI reads the current DSH V3 `agentPreset` projection value as-is; DSH owns historical V2→V3 preset migration, while the TUI retains only the narrow omitted-settings-default shim in `src/runtime/session-preset.ts`. |
| `src/runtime/direct/session-projection-direct.ts` | `import:dsh-session`, (`sessionProjections` / `sessionProjectionCache` structural reads) | The Direct combined session-projection batch (the picker-projection alignment) — `SessionReader.projectionBatch()` implementation: live rows read only already-materialized cells through the official `sessionProjections.cachedSnapshot()`, cold rows read the `sessionProjectionCache.cachedSnapshot()` checkpoint keyed by the `list()` header identity (or its predecessor-title hint), and cold misses remain unknown without activating a historical Session. Current DSH V3 preset identities are consumed as-is; this is Host coupling INSIDE the Direct adapter by design (the projection semantics are DSH-owned), not Client debt: a future Remote adapter maps the same port method onto the official client projection contract instead of copying this ladder. Baseline entry added with the module itself. |
| `src/runtime/remote/session-reader-remote.ts` | (none) | Experimental M2/D1.1 `SessionReader` adapter over the official DSH Client Session list/projection/search faces. It consumes detached Client facts only: ready list snapshots, authoritative `ids` order, `updatedAt`, projection values/faces, and official search results. It has no Host imports, persistence access, writer methods, or production wiring. |
| `src/runtime/remote/session-read-shadow.ts` | (none) | Experimental M2/D1.1 Direct-vs-Remote diagnostic comparator. It owns only an operation epoch and Connection-generation fence; it emits bounded parity facts and explicit discarded/unavailable outcomes. It never changes Direct authority or renders Remote data. |
| `src/runtime/surface-authority-port.ts` | (none) | Structural live-Session command/skill authority read port; only detached commands and human-skill metadata cross it. |
| `src/runtime/direct/surface-authority-direct.ts` | (none; reuses `surface-catalog`) | Direct M2/D1.2 adapter over the existing effective live surface collector; it resolves an already-live Agent and does not create or mutate Host state. |
| `src/runtime/remote/surface-authority-remote.ts` | (none) | Experimental M2/D1.2 adapter over official generated `commands.list` and `skills.list` Remotes; explicit detached whitelist, no Host imports, no writes or execution. |
| `src/runtime/remote/surface-authority-shadow.ts` | (none) | Experimental M2/D1.2 generation-fenced Direct-vs-Remote comparator; bounded command/skill mismatches and metadata-derived claim diagnostics only. |
| `src/runtime/task-read-port.ts` | (none) | Structural D1.3 Task read contract; carries only detached direct-child and status-only job facts, with the complete descendant tree deliberately outside the D1 port. |
| `src/runtime/direct/task-read-direct.ts` | (none) | Direct D1.3 Task read adapter; composes injected official child-list, live-Agent activity, and `jobs.list` faces without exposing Host objects or creating Agents. |
| `src/runtime/remote/task-read-remote.ts` | (none) | Experimental D1.3 adapter over official `ClientSessions.refreshSubagents()` and list snapshots; generation/cancellation-fenced, read-only, and detached/frozen. |
| `src/runtime/remote/task-read-shadow.ts` | (none) | Experimental D1.3 Task comparator; compares direct-child/jobs semantics and `buildTaskRows`, with bounded diagnostics and an explicit descendant-tree skip. |
| `src/runtime/presentation-read-port.ts` | (none) | Structural D1.3 presentation read contract; keeps durable history and live inputs as separate detached planes, plus window flags and open state, without a TUI or transport object. |
| `src/runtime/direct/presentation-read-direct.ts` | (none) | Direct D1.3 presentation reference adapter over existing Session event snapshots and assistant stream baseline; no duplicate history or stream tracker. |
| `src/runtime/remote/presentation-read-remote.ts` | (none) | Experimental D1.3 adapter over official `SessionBinding.eventSource`, `SessionFace` snapshots, and `loadOlder()` only; it preserves source order within each plane and protects detached payloads. |
| `src/runtime/remote/presentation-read-shadow.ts` | (none) | Experimental D1.3 semantic comparator; compares bounded durable/live ranges and rebuilds fresh Transcript, window, and Focus projections with lifecycle fences. |
| `src/runtime/direct/session-writer-direct.ts` | `sessionTitle`, `fileUploads` | The Direct `SessionWriter` adapter (D2.1) — identity-based (sessionId) semantic operations over the live Agent resolver and the `ctx.sessionTitle` service: explicit-mode ordinary prompts, dsh-web-style FIFO per-occurrence `updateQueue({ kind: 'steer' })` calls, official text-only/non-whitespace edit validation (with malformed structural blocks treated as non-text), edit/remove/steer queue mutations, user `rpcId` file-upload retirement after remove, user cancel with pending inbox preserved, normalized rename, and title refresh. Ordinary session verbs retain their caller-authorized resolver; queue occurrence verbs may use the separately fenced exact live continuable-child viewer resolver. Steer orchestration, barriers and revalidation stay in the runner. Baseline entry retained from the M1.4 relocation and updated for the converged contract. |
| `src/runtime/remote/session-writer-remote.ts` | (none) | Experimental M2/D2.2 `SessionWriter` adapter over the official `ClientSessions.binding(id).session` `SessionFace`. Identity-addressed writes only (never `sessions.open()`): the official `beginSubmission`→identified-`prompt` echo lifecycle, occurrence-level `updateQueue`, `cancel`, normalized `rename`, and an explicit `unsupported` title refresh. A Connection generation captured before dispatch fences the binding; a `RemoteResult` failure is classified rejected/cancelled/indeterminate without a Remote-only taxonomy. It resolves the prepared submission through a migration-local serializer seam and has no Host imports or production wiring. |
| `src/runtime/remote/write-failure.ts` | (none) | Experimental M2/D2.2 settlement classifier: maps an official `RemoteResult` failure (or an assembly throw) onto the shared `WriteOutcome` vocabulary. Domain and `gateway/bad-request` codes are proven refusals; universal carrier codes stay `cancelled`/`indeterminate`. Host-free and transport-free. |
| `src/runtime/remote/pending-input-reader-remote.ts` | (none) | Experimental M2/D2.2 `PendingInputReader` adapter over the official `SessionSnapshot.queue`. It preserves the official occurrence order and `queued`/`steering`/`context` placement verbatim, carries the optional plain `rpcId`, detaches/freezes content, and is Connection-generation fenced. It never reads Direct `nextTurn`/`nextStep` names and never infers placement from `running`. |
| `src/runtime/remote/host-command-remote.ts` | (none) | Experimental M2/D2.2 `HostCommandPort` adapter over the official generated `commands.execute(agentId, line, attachments, signal)` Remote — the attachment-preserving path (never the `SessionFace.command(line)` convenience that drops attachments). It forwards the full line, opaque attachments and caller signal unchanged and classifies settlement without a model fallback. |
| `src/runtime/remote/subagent-remote.ts` | (none) | Experimental M2/D2.2 `SubagentPort` adapter over the official generated `subagents.prompt` / `subagents.interruptByParent` Remotes. Continuation prompts keep the exact durable parent/child address and `continuable` mode with one pre-call request identity per human submit; interruption addresses the explicit direct parent. It never opens a child to write to it and never infers parent authority from UI nesting. |
| `src/runtime/pending-input-reader-port.ts` | (none) | Semantic pending-input projection: running state plus `queued` / `steering` / `context` placements, and an optional plain `rpcId` correlation string for user-origin occurrences. It contains no Direct or Remote transport vocabulary and never exposes the raw message `source`. |
| `src/runtime/direct/pending-input-reader-direct.ts` | (none; structural Direct read) | The Direct `PendingInputReader` adapter — the only consumer-facing read adapter that knows `Agent.inbox.nextTurn` / `nextStep` and their sources; it maps next-turn to `queued`, user-origin next-step to `steering`, all other next-step rows to `context`, projects a user `source.rpcId` to the plain `rpcId` correlation field, exposes no source field, and returns `undefined` when the session is unavailable. Its resolver is separately fenced for the exact live continuable child mounted by an interactive viewer. |
| `src/pending-submission.ts` | (none) | The D2.1 follow-up Client-local pending-submission ledger: insertion-ordered, request-id-keyed echoes (`transcript` / `queued` / `steering` placements) bridging the editor-clear → authoritative-occurrence window. Pure and Host-free; it never reads a Host inbox or the terminal. |
| `src/submission-presentation.ts` | (none) | The D2.2 client-local submission-presentation seam: one read-only optimistic-echo source the TUI presentation consumes. The Direct implementation wraps the existing `PendingSubmissions` ledger; the experimental Remote implementation reads the official `SessionSnapshot.pendingSubmissions` under the Connection generation. The renderer joins these items with authoritative pending-input rows by request/rpc identity only — never by text — and the seam owns no Host state. |
| `src/runtime/host-command-port.ts` | (none) | The D2.1 Host command execution port — carries session identity, the full selected line, opaque submitted attachments and signal; it owns execution only, not command claim precedence or TUI-local/extension/skill routing. Zero Host coupling. |
| `src/runtime/direct/host-command-direct.ts` | `commands` | The Direct D2.1 `HostCommandPort` adapter — resolves the live Agent by session id at call time and invokes the official `commands.execute` service. It preserves the selected line, attachments, signal and settled command result; it does not parse, claim or route commands. Baseline entry added with the new Direct adapter. |
| `src/runtime/host-file-port.ts` | (none) | The Host-file port interface (M1.10, contract review) — path-only candidates (`{path, kind}`, the official `FileReferenceCandidate` shape); the TUI's ranking/quoting/`@`-insertion value/label/description/directory-continuation are CLIENT policy in mentions.ts, never Host data. Zero Host coupling. |
| `src/runtime/direct/host-file-direct.ts` | (fs only; no ctx services) | The Direct `HostFilePort` adapter (M1.10) — the ONLY module in the `@`-file path that touches the filesystem: fd discovery (fork delegation) or the bounded recursive fallback scan, stat existence probes, `~` expansion. Returns path-only DTOs; discovery bounds only, no presentation. No ctx-service coupling (baseline-free). |
| `src/runtime/session-lifecycle-port.ts` | (none) | The session LIFECYCLE port interface (D2.1 convergence; D2.3 semantic convergence) — transport-neutral semantic `create`/`open` operations and `SessionHandle` (no Host types). D2.3 removed the ordinary `provider`/`model` inputs from `CreateSessionRequest` and converged `OpenSessionRequest` to `{ sessionId, signal? }` (no `resumeSessionId`/provider/model/preset knobs); `meta`/`seed`/`inheritedEventCount` remain Direct D2.4 fork inputs. Cancellation is client-local and never serialized. Zero Host coupling. |
| `src/runtime/direct/session-lifecycle-direct.ts` | `agentDefaultModel`, `agents`, `import:dsh-agent`, `import:dsh-session` | The Direct `SessionLifecycle` adapter (D2.1/D2.3) — the ONLY module converting semantic `create`/`open` requests into the Direct shapes (preset composition → `setup` callback, `SessionId`, seed) and mapping the client-local cancellation signal to `agents.create` / `agents.resume`; `agents.resume` is an implementation detail hidden behind semantic `open`. D2.3 moved the Direct-only lookups inside: the activation fallback reads the Host `agentDefaultModel.currentSelection()` (exactly like the official `ApiSessionAgentController.agentOptions()`), and `open` resolves the persisted recorded preset through `recordedSessionPreset`. The runner keeps the process-local surface coordination (transition gate, operation barrier, generation/stale fences) around the port calls; DSH `SessionHandle` / `SessionWriteLease` is the cross-process writer authority. Baseline entry gained `agentDefaultModel` with the D2.3 relocation. |
| `src/runtime/remote/model-remote.ts` | (none) | Experimental M2/D2.3 `ModelCatalog` adapter over the official `session.modelCatalog` / `session.selectModel` Remotes and the Session binding's `modelSelection` projection. Host-free structural inputs, a Connection-generation fence before/after dispatch, and operation-specific settlement (only a proven pre-commit code is `rejected`; no reuse of the D2.2 broad refusal helper). No second global-default write and no custom reasoning normalization. `defaultSelection()` is the CURRENT-generation directory-cache default (invalidated on a reconnect); `sessionSelection()` reads the Client binding's `modelSelection` projection and falls back to that cached default; `listProviders()`/`listModels()` are UNAVAILABLE (empty) in Remote D2.3 — provider-endpoint discovery has no official Remote capability and is never faked from the directory cache (the subagent allowlist that consumes it is a Direct-only surface). |
| `src/runtime/remote/preset-remote.ts` | (none) | Experimental M2/D2.3 `PresetCatalog` adapter over the official `agentPresets.list` roster and `agentPresets.select(sessionId, presetId)` blank-Session write. Host-free structural inputs, generation fence, and operation-specific settlement (`agent-preset/locked` etc. are proven rejections). No local blank reducer or recompose logic. |
| `src/runtime/remote/session-lifecycle-remote.ts` | (none) | Experimental M2/D2.3 `SessionLifecycle` adapter: ordinary create via official `ClientSessions.create()`, guaranteed-fresh explicit-preset create via generated `session.create({sessionId, cwd, agentPreset})` + Client-state reconciliation, open via `ClientSessions.open()/binding()`. Seeded/fork creates fail closed (D2.4) and a post-publication create error preserves the requested/published identity with no auto-retry. No Host imports and no invented Host resume RPC. |
| `src/runtime/interaction-port.ts` | (type-only peer imports) | The interaction port interface (M1.6) — uses the official dsh-user-approval / dsh-user-questions types (declared peers). |
| `src/runtime/direct/interaction-direct.ts` | `approval`, `userQuestions` | The Direct `InteractionPort` adapter (M1.6) — owns the `userQuestions` / `approval` service access and the `approval/request` subscription; the listeners/providers stay runner-owned. Baseline entries added by the M1.6 relocation (commands.ts and index.ts drop `approval` / `userQuestions`). |
| `src/runtime/direct/catalog-direct.ts` | `llm`, `agentDefaultModel`, `agentPresets`, `tools`; `import:dsh-agent` (type-only, dsh-agent-presets) | The Direct `Catalog` adapter (M1.8; D2.3 convergence) — owns the model directory (`loadDirectory()` = the official `session.modelCatalog` generation snapshot; `listProviders()`/`listModels()` remain the provider-discovery capability), the Session-local model write (`selectSessionModel()` → `WriteOutcome`, best-effort default save never undoing a committed Session choice), the preset roster + official blank-Session write (`roster()`/`selectSessionPreset()`), and the skill sub-domain's service discovery. Consumers depend on the port DTOs. Baseline entries added by the M1.8 relocation (commands.ts drops `llm`/`agentDefaultModel`/`agentPresets`/`tools` access). |
| `src/runtime/direct/model-selection-direct.ts` | `import:dsh-agent` | The Direct Agent-local model-selection owner (M1.12): installs one selection ref per Agent, folds durable Session intent/request headers, and maps explicit Session selection to the semantic catalog operations; a future Remote adapter replaces this ownership escape with `session.models` / `session.selectModel`. |
| `src/runtime/direct/config-direct.ts` | `settings`, `credentials`, `authorization`, `permissionPresets`, `commands`, `agentPresets`, `llm` | The Direct `ConfigPort` adapter (M1.9) — owns the Host schema knowledge (the `llm-pi-ai` / `permission` / `agent-presets` settings namespaces), the credential/authorization service access, the credential event wiring, the official `/permission` command line for the `/yolo` switch, and the `llm` directory reads ONLY for the provider-profile target resolution (the keyless-profile write + the merged /login option list). Consumers never name a settings namespace or touch the raw services — the merged /login options cross as the port's `CredentialProviderOption` DTO (semantic flags only: `canProvisionProfile` collapses the namespace/path facts; ONE adapter-owned rule `isKeylessProfileSlot` drives both the flag and the write-time validation, so they can never drift). The authorization contract is an EVENT surface (contract review): the adapter bridges the upstream callback-shaped interaction into detached begin→attemptId→notice/prompt events→respond/cancel — no callback-bearing interaction ever crosses the port (a Remote adapter replays the same events from the wire). Baseline entries added by the M1.9 relocation (commands.ts drops `settings`/`credentials`/`authorization`/`permissionPresets` access; the `/yolo` commands-execute access moves here; index.ts drops `credentials`/`authorization`; the `llm` entry was added with the M1 review round-2 target-resolution fix). |
| `src/image/*` | (structural `ctx.attachments` / `ctx.llm` subsets, injected) | Already seamed; image intake/submit/loader. |
| `src/model-menu.ts` | `import:dsh-agent` | Type-only model selection types. |
| `src/default-intent.ts` | (none) | The pure D2.3 sessionless `/model` default-intent state machine (operation ancestry + settle authority). It uses the structural `ModelSelectionValue` (generic over the caller's selection type) — no `ctx`, no Host services, no I/O, no Host import. |
| `src/sessions.ts` | `import:dsh-session` | Type-only session types. |
| `src/present.ts` | `import:dsh-session` | Type-only session event types in presentation. |
| `src/stats.ts` | `import:dsh-session` | Type-only. |
| `src/transcript.ts` | `import:dsh-session` | Type-only; transcript folding must consume the client session event/window, not transport (plan §20). |

### CLIENT_LOCAL (no Host coupling — keep it that way)

Terminal rendering, editor, keybindings, clipboard/OSC52, input history,
search UI state, picker cursor, overlay state, fullscreen, theme, draft
state, local shell card display, question/approval *presentation* (the
authority stays Host-owned), and session transition coordination
(`src/transition-gate.ts`, `src/transition.ts`,
`src/session-operation-barrier.ts` — the process-local single-writer
transition rules; zero Host coupling). Representative files:
`src/tui-app.ts`, `src/tui-editor.ts`, `src/theme.ts`, `src/present.ts`
(rendering half), `src/clipboard.ts`, `src/history.ts`, `src/search.ts`,
`src/overlay-broker.ts`, `src/keybinding-registry.ts`,
`src/editor-registry.ts`, `src/renderer-registry.ts`.
`src/session-artifact-filename.ts` (Pre-Stage-D export convergence) is
Client-local filename policy with ZERO Host coupling: the archive name
mirrors the upstream `sessionLogZipFilename` convention exactly and is
test-pinned against the upstream function (parity test in
`test/export-command.test.ts`), and the transcript name shares the same
safe full-Session-id convention. `src/client-artifact-save.ts` and
`src/save-location.ts` are the Client-local temp/atomic-commit sink and the
Save Location UI — zero Host coupling.

### TEMPORARY_EXCEPTION

| File | Coupling | Why it is allowed |
|---|---|---|
| `src/startup.ts` | (none by design) | Zero-dependency compatibility island; must never import experimental client/runtime code (plan §23). |
| `src/builtins.ts`, `src/extensions.ts` | `ctx.get(TUI_STARTUP_SERVICE)` / `ctx.get(PI_TUI_EXTENSIONS_SERVICE)` | The TUI's own services, not Host services; excluded from the gate patterns. |
| `src/index.ts` (`loader`, `appExit`) | `ctx.get('loader')`, `ctx.get('appExit')` | Cordis/dsh process services with no Host business state; excluded from the gate patterns. |

## Locality rules for new features

Per the AGENTS.md guardrails, every new feature declares its locality before
implementation:

- **Client-local**: terminal rendering, key handling, clipboard, draft state,
  local UI history, search filter UI state, picker cursor, overlay state,
  fullscreen, TUI theme.
- **Host-owned**: Agent, Session, subagent, jobs, tools, LLM/provider/model,
  skills, agent presets, persistence, session search, approval/question
  authority, workspace, Host filesystem references, Host-side shell/tool
  execution, credentials, settings.
- **Explicitly split** (must define which machine owns each operation):
  `!` / `!!` shell, `@file`, external editor, `/image`, `/export`, `/open`,
  working directory. Remote mode fails closed rather than silently running on
  the Client filesystem with Host semantics.

## How to update this file

1. A migration phase moves coupling into a semantic port: move the entry to
   the port's row, update `scripts/client-boundary-baseline.json` (the gate
   then stops flagging the relocated pattern), and record the phase in
   `docs/client-server-migration.md`.
2. New feature code must NOT appear here — the gate rejects it first.
3. Keep the `HOST_SERVICES` list in `scripts/client-boundary-gate.mjs` in
   sync with this inventory when upstream adds a service the migration must
   isolate.
