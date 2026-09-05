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

## Inventory (baseline, generated from the current tree)

### DIRECT_HOST_REQUIRED

| File | Coupling | Notes |
|---|---|---|
| `src/index.ts` | `agents`, `sessions`, `subagents`, `jobs`, `attachments`, `llm`, `commands`, `settings`, `sessionPersistence`, `agentPresets`, `tools`, `permissionPresets`, `tokenMeter`, `agentDefaultModel`, `shell`, `planMode`, `sandboxPolicy`; `import:dsh-agent`, `import:dsh-session` | The runner: agent create/resume, session ownership, event subscription, input dispatch, queue/steer, lifecycle. The primary migration coupling point (plan §4.1). M1.8/M1.9 relocated `credentials`, `authorization` and `userQuestions` into the config/interaction adapters; `llm`/`tools`/`permissionPresets`/`tokenMeter` remain here ONLY for the runner's own non-command paths (boot diagnostics, status footer, the pre-mount surface prefetch and the image-submission preparation — never for command handlers). `planMode`/`sandboxPolicy` are the M0 status-seam wiring (the derives consume them through structural interfaces). |
| `src/session-fork.ts` | `import:dsh-agent`, `import:dsh-session` | Fork/rewind mechanics; Direct-mode agent handles (the AgentHandle escape, M8). |
| `src/rewind.ts` | `import:dsh-session` | Rewind mechanics. |

### MIGRATABLE

| File | Coupling | Notes |
|---|---|---|
| `src/commands.ts` | `import:dsh-agent`, `import:dsh-session` | The command runner — M1.7–M1.11 narrowed it to ZERO `ctx.get` and ZERO service-object access: every Host read/write a command performs goes through the semantic ports (`catalog`/`config`/`hostFile`/`sessionReader`/`sessionWriter`/`interaction`); the `CommandHostCapabilities` facade and `runner.host` are RETIRED. The remaining type-only imports are the runner's Direct ownership escape (live Agent/Session types), kept until M8. |
| `src/skill-catalog.ts` | `agentPresets`, `skills` | Already isolated: structural types + capability detection (decision 11). The pure catalog logic the Direct catalog adapter (M1.8) wires — the coupling stays attributed here. |
| `src/surface-catalog.ts` | `commands`, `import:dsh-agent` | Isolated catalog module; the runner's pre-mount surface prefetch and the coordinator's live-agent read hook (agent-owned, M8 escape — the sessionless STANDING read now routes through the catalog port, M1.8). |
| `src/skill-catalog-refresh.ts` | `import:dsh-agent` | Coordinator; agent-scoped refresh. |
| `src/subagent-viewer-submit.ts` | (structural `ctx.subagents` official prompt surface, injected) | The pure human-prompt delivery core (alpha.4's `ctx.subagents.prompt`); consumed by the `SubagentPort` (M1.2). |
| `src/runtime/direct/subagent-direct.ts` | `subagents` | The Direct `SubagentPort` adapter (M1.2) — the ONLY module in the prompt path that touches `ctx` (and the only one minting the caller-owned `requestId`); the runner depends on the port. Baseline entry added by the M1.2 relocation. |
| `src/runtime/direct/session-direct.ts` | `import:dsh-session`, `sessionPersistence`, `sessionQuery`, `agentPresets`, `tokenMeter` | The Direct `SessionReader` adapter (M1.3, extended M1.11 + master alignment) — owns semantic session-query listing with capability-aware activity ordering, bounded content search, best-effort context measurement (`measureContext`, the /status row) and committed-handle export (`readExportData`); the combined `title`+`agentPreset` projection batch delegates to `session-projection-direct.ts` (the official live-snapshot/cache-checkpoint ladder, with cold misses left unknown). The TUI-local title cache and the `readTitleSnapshots()` path are retired — the adapter's structural query surface no longer even declares them. The consumer (commands.ts) depends on the port. Baseline entries added by the M1.3/M1.11 relocations, the master projection-cache contract, and the projection module split (the cache/`sessionProjections` reads moved with it). |
| `src/runtime/direct/session-preset-direct.ts` | `import:dsh-agent`, `import:dsh-session`, `sessionQuery`, `agentPresets` | The Direct session-preset adapter — explicit resume/preset paths read cold sessions through the official `sessionQuery.observeSession()` observation seam (the engine owns live/cold source selection, persistence borrow/preparation, projection-cache hydration, tail replay, and the projection cut); picker enrichment stays on the live/cache-only projection path. The TUI only reads the `agentPreset` projection value and applies roster-aware legacy normalization. Legacy `code` → `ptc` translation is roster-aware and stays at the persisted identity seam in `src/runtime/session-preset.ts`. |
| `src/runtime/direct/session-projection-direct.ts` | `import:dsh-session`, `agentPresets`, (`sessionProjections` / `sessionProjectionCache` structural reads) | The Direct combined session-projection batch (the picker-projection alignment) — `SessionReader.projectionBatch()` implementation: live rows read the official `sessionProjections.snapshot()`, cold rows read the `sessionProjectionCache.cachedSnapshot()` checkpoint keyed by the `list()` header identity (or its predecessor-title hint), and cold misses remain unknown without activating a historical Session. This is Host coupling INSIDE the Direct adapter by design (the projection semantics are DSH-owned), not Client debt: a future Remote adapter maps the same port method onto the official client projection contract instead of copying this ladder. Baseline entry added with the module itself. |
| `src/runtime/direct/session-writer-direct.ts` | `sessionTitle` | The Direct `SessionWriter` adapter (M1.4, contract round 2) — identity-based (sessionId) operations over the live agents (runner-injected resolver) and the `ctx.sessionTitle` service; steer ORCHESTRATION stays in the runner (steerAll), the FINAL steer delivery goes through this port. Baseline entry added by the M1.4 relocation. |
| `src/runtime/host-file-port.ts` | (none) | The Host-file port interface (M1.10, contract review) — path-only candidates (`{path, kind}`, the official `FileReferenceCandidate` shape); the TUI's ranking/quoting/`@`-insertion value/label/description/directory-continuation are CLIENT policy in mentions.ts, never Host data. Zero Host coupling. |
| `src/runtime/direct/host-file-direct.ts` | (fs only; no ctx services) | The Direct `HostFilePort` adapter (M1.10) — the ONLY module in the `@`-file path that touches the filesystem: fd discovery (fork delegation) or the bounded recursive fallback scan, stat existence probes, `~` expansion. Returns path-only DTOs; discovery bounds only, no presentation. No ctx-service coupling (baseline-free). |
| `src/runtime/session-lifecycle-port.ts` | (none) | The session LIFECYCLE port interface (M1.5, contract-reviewed) — transport-neutral: serializable requests, `SessionHandle` (no Host types). Zero Host coupling. |
| `src/runtime/direct/session-lifecycle-direct.ts` | `agents`, `import:dsh-agent`, `import:dsh-session` | The Direct `SessionLifecycle` adapter (M1.5, contract-reviewed) — the ONLY module converting the semantic request into the Direct shapes (preset composition → `setup` callback, `SessionId`, seed). The runner keeps the process-local surface coordination (transition gate, operation barrier, generation/stale fences) around the port calls; DSH `SessionHandle` / `SessionWriteLease` is the cross-process writer authority. Baseline entries updated by the M1.5 contract revision (the port itself dropped to zero coupling). |
| `src/runtime/interaction-port.ts` | (type-only peer imports) | The interaction port interface (M1.6) — uses the official dsh-user-approval / dsh-user-questions types (declared peers). |
| `src/runtime/direct/interaction-direct.ts` | `approval`, `userQuestions` | The Direct `InteractionPort` adapter (M1.6) — owns the `userQuestions` / `approval` service access and the `approval/request` subscription; the listeners/providers stay runner-owned. Baseline entries added by the M1.6 relocation (commands.ts and index.ts drop `approval` / `userQuestions`). |
| `src/runtime/direct/catalog-direct.ts` | `llm`, `agentDefaultModel`, `agentPresets`, `tools`; `import:dsh-agent` (type-only, dsh-agent-presets) | The Direct `Catalog` adapter (M1.8) — owns the model/provider directory, the preset roster (read side), and the skill sub-domain's service discovery (`skills`/`agentPresets` through the skill-catalog.ts seam plus the `tools` loader probe for the host-vs-fallback injection decision); consumers depend on the port DTOs. Baseline entries added by the M1.8 relocation (commands.ts drops `llm`/`agentDefaultModel`/`agentPresets`/`tools` access). |
| `src/runtime/direct/model-selection-direct.ts` | `import:dsh-agent` | The Direct Agent-local model-selection owner (M1.12): installs one selection ref per Agent, folds durable Session intent/request headers, and maps explicit Session selection to the semantic catalog operations; a future Remote adapter replaces this ownership escape with `session.models` / `session.selectModel`. |
| `src/runtime/direct/config-direct.ts` | `settings`, `credentials`, `authorization`, `permissionPresets`, `commands`, `agentPresets`, `llm` | The Direct `ConfigPort` adapter (M1.9) — owns the Host schema knowledge (the `llm-pi-ai` / `permission` / `agent-presets` settings namespaces), the credential/authorization service access, the credential event wiring, the official `/permission` command line for the `/yolo` switch, and the `llm` directory reads ONLY for the provider-profile target resolution (the keyless-profile write + the merged /login option list). Consumers never name a settings namespace or touch the raw services — the merged /login options cross as the port's `CredentialProviderOption` DTO (semantic flags only: `canProvisionProfile` collapses the namespace/path facts; ONE adapter-owned rule `isKeylessProfileSlot` drives both the flag and the write-time validation, so they can never drift). The authorization contract is an EVENT surface (contract review): the adapter bridges the upstream callback-shaped interaction into detached begin→attemptId→notice/prompt events→respond/cancel — no callback-bearing interaction ever crosses the port (a Remote adapter replays the same events from the wire). Baseline entries added by the M1.9 relocation (commands.ts drops `settings`/`credentials`/`authorization`/`permissionPresets` access; the `/yolo` commands-execute access moves here; index.ts drops `credentials`/`authorization`; the `llm` entry was added with the M1 review round-2 target-resolution fix). |
| `src/image/*` | (structural `ctx.attachments` / `ctx.llm` subsets, injected) | Already seamed; image intake/submit/loader. |
| `src/model-menu.ts` | `import:dsh-agent` | Type-only model selection types. |
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
