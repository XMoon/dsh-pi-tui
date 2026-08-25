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
  through the runner/allowlist, never a UI module.

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
| `src/index.ts` | `agents`, `sessions`, `subagents`, `jobs`, `attachments`, `llm`, `commands`, `settings`, `sessionPersistence`, `agentPresets`, `tools`, `permissionPresets`, `tokenMeter`, `agentDefaultModel`, `shell`; `import:dsh-agent`, `import:dsh-session` | The runner: agent create/resume, session ownership, event subscription, input dispatch, queue/steer, lifecycle. The primary migration coupling point (plan §4.1). M1.8/M1.9 relocated `credentials` and `authorization` into the config adapter; `llm`/`tools`/`permissionPresets`/`tokenMeter` remain here ONLY for the runner's own boot diagnostics, status footer and the pre-mount surface prefetch (never for command handlers). |
| `src/session-lock.ts`, `src/session-lock-proc.ts` | owner.lock open/steal | Direct-mode session ownership; never removed as "cleanup" (AGENTS.md guardrail). |
| `src/session-lease-manager.ts`, `src/session-lease-cooling.ts` | lease/cooling state machine | Same. |
| `src/guard.ts` | write-path divergence guard | Same. |
| `src/transition-gate.ts`, `src/transition.ts` | transition gate | Same. |
| `src/session-operation-barrier.ts` | operation barrier | Same. |
| `src/open-locks.ts` | lock bookkeeping | Same. |
| `src/session-fork.ts` | `import:dsh-agent`, `import:dsh-session` | Fork/rewind mechanics; Direct-mode agent handles. |
| `src/rewind.ts` | `import:dsh-session` | Rewind mechanics. |

### MIGRATABLE

| File | Coupling | Notes |
|---|---|---|
| `src/commands.ts` | `import:dsh-agent`, `import:dsh-session` | The command runner — M1.7–M1.11 narrowed it to ZERO `ctx.get` and ZERO service-object access: every Host read/write a command performs goes through the semantic ports (`catalog`/`config`/`hostFile`/`sessionReader`/`sessionWriter`/`interaction`); the `CommandHostCapabilities` facade and `runner.host` are RETIRED. The remaining type-only imports are the runner's Direct ownership escape (live Agent/Session types), kept until M8. |
| `src/skill-catalog.ts` | `agentPresets`, `skills` | Already isolated: structural types + capability detection (decision 11). The pure catalog logic the Direct catalog adapter (M1.8) wires — the coupling stays attributed here. |
| `src/surface-catalog.ts` | `commands`, `import:dsh-agent` | Isolated catalog module; the runner's pre-mount surface prefetch and the coordinator's live-agent read hook (agent-owned, M8 escape — the sessionless STANDING read now routes through the catalog port, M1.8). |
| `src/skill-catalog-refresh.ts` | `import:dsh-agent` | Coordinator; agent-scoped refresh. |
| `src/subagent-viewer-submit.ts` | (structural `ctx.subagents` followup surface, injected) | The pure follow-up delivery core; consumed by the `SubagentPort` (M1.2). |
| `src/runtime/direct/subagent-direct.ts` | `subagents` | The Direct `SubagentPort` adapter (M1.2) — the ONLY module in the follow-up path that touches `ctx`; the runner depends on the port. Baseline entry added by the M1.2 relocation. |
| `src/runtime/direct/session-direct.ts` | `sessionPersistence`, `sessionQuery`, `tokenMeter` | The Direct `SessionReader` adapter (M1.3, extended M1.11) — owns the live-preferred listing, the bounded content search, the cached title batches, the best-effort context measurement (`measureContext`, the /status row) and the export read (`readExportData`); the consumer (commands.ts) depends on the port. Baseline entries added by the M1.3/M1.11 relocations. |
| `src/runtime/direct/session-writer-direct.ts` | `sessionTitle` | The Direct `SessionWriter` adapter (M1.4, contract round 2) — identity-based (sessionId) operations over the live agents (runner-injected resolver) and the `ctx.sessionTitle` service; steer ORCHESTRATION stays in the runner (steerAll), the FINAL steer delivery goes through this port. Baseline entry added by the M1.4 relocation. |
| `src/runtime/session-lifecycle-port.ts` | (none) | The session LIFECYCLE port interface (M1.5, contract-reviewed) — transport-neutral: serializable requests, `SessionHandle` (no Host types). Zero Host coupling. |
| `src/runtime/direct/session-lifecycle-direct.ts` | `agents`, `import:dsh-agent`, `import:dsh-session` | The Direct `SessionLifecycle` adapter (M1.5, contract-reviewed) — the ONLY module converting the semantic request into the Direct shapes (preset composition → `setup` callback, `SessionId`, seed). The runner keeps the ownership machinery (lock/lease/PINNED/transition/barrier) around the port calls. Baseline entries updated by the M1.5 contract revision (the port itself dropped to zero coupling). |
| `src/runtime/interaction-port.ts` | (type-only peer imports) | The interaction port interface (M1.6) — uses the official dsh-user-approval / dsh-user-questions types (declared peers). |
| `src/runtime/direct/interaction-direct.ts` | `approval`, `userQuestions` | The Direct `InteractionPort` adapter (M1.6) — owns the `userQuestions` / `approval` service access and the `approval/request` subscription; the listeners/providers stay runner-owned. Baseline entries added by the M1.6 relocation (commands.ts and index.ts drop `approval` / `userQuestions`). |
| `src/runtime/direct/catalog-direct.ts` | `llm`, `agentDefaultModel`, `agentPresets`, `tools`; `import:dsh-agent` (type-only, dsh-agent-presets) | The Direct `Catalog` adapter (M1.8) — owns the model/provider directory, the preset roster (read side), and the skill sub-domain's service discovery (`skills`/`agentPresets` through the skill-catalog.ts seam plus the `tools` loader probe for the host-vs-fallback injection decision); consumers depend on the port DTOs. Baseline entries added by the M1.8 relocation (commands.ts drops `llm`/`agentDefaultModel`/`agentPresets`/`tools` access). |
| `src/runtime/direct/config-direct.ts` | `settings`, `credentials`, `authorization`, `permissionPresets`, `commands`, `agentPresets`, `llm` | The Direct `ConfigPort` adapter (M1.9) — owns the Host schema knowledge (the `llm-pi-ai` / `permission` / `agent-presets` settings namespaces), the credential/authorization service access, the credential event wiring, the official `/permission` command line for the `/yolo` switch, and the `llm` directory reads ONLY for the provider-profile target resolution (the keyless-profile write + the merged /login option list). Consumers never name a settings namespace or touch the raw services. Baseline entries added by the M1.9 relocation (commands.ts drops `settings`/`credentials`/`authorization`/`permissionPresets` access; the `/yolo` commands-execute access moves here; index.ts drops `credentials`/`authorization`; the `llm` entry was added with the M1 review round-2 target-resolution fix). |
| `src/image/*` | (structural `ctx.attachments` / `ctx.llm` subsets, injected) | Already seamed; image intake/submit/loader. |
| `src/model-menu.ts` | `import:dsh-agent` | Type-only model selection types. |
| `src/sessions.ts` | `import:dsh-session` | Type-only session types. |
| `src/present.ts` | `import:dsh-session` | Type-only session event types in presentation. |
| `src/preset-events.ts` | `import:dsh-session` | Type-only. |
| `src/stats.ts` | `import:dsh-session` | Type-only. |
| `src/transcript.ts` | `import:dsh-session` | Type-only; transcript folding must consume the client session event/window, not transport (plan §20). |

### CLIENT_LOCAL (no Host coupling — keep it that way)

Terminal rendering, editor, keybindings, clipboard/OSC52, input history,
search UI state, picker cursor, overlay state, fullscreen, theme, draft
state, local shell card display, question/approval *presentation* (the
authority stays Host-owned). Representative files: `src/tui-app.ts`,
`src/tui-editor.ts`, `src/theme.ts`, `src/present.ts` (rendering half),
`src/clipboard.ts`, `src/history.ts`, `src/search.ts`, `src/overlay-broker.ts`,
`src/keybinding-registry.ts`, `src/editor-registry.ts`, `src/renderer-registry.ts`.

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
