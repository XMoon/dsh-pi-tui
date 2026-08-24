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
| `src/index.ts` | `agents`, `sessions`, `subagents`, `jobs`, `attachments`, `llm`, `commands`, `settings`, `sessionPersistence`, `agentPresets`, `tools`, `userQuestions`, `permissionPresets`, `tokenMeter`, `agentDefaultModel`, `shell`; `import:dsh-agent`, `import:dsh-session` | The runner: agent create/resume, session ownership, event subscription, input dispatch, queue/steer, lifecycle. The primary migration coupling point (plan §4.1). |
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
| `src/commands.ts` | `settings`, `llm`, `authorization`, `credentials`, `commands`, `approval`, `permissionPresets`, `sessionPersistence`, `tokenMeter`, `agentDefaultModel`, `agentPresets`, `tools`; `import:dsh-agent`, `import:dsh-session` | The command runner — the second god interface (plan §M1.3). M1 narrows it to `TuiCommandContext` capabilities; `sessionQuery` moved to the session reader port (M1.3), `sessionTitle` to the session writer port (M1.4). |
| `src/skill-catalog.ts` | `agentPresets`, `skills` | Already isolated: structural types + capability detection (decision 11). Model for the catalog port. |
| `src/surface-catalog.ts` | `commands`, `import:dsh-agent` | Isolated catalog module; standing-scope reads. |
| `src/skill-catalog-refresh.ts` | `import:dsh-agent` | Coordinator; agent-scoped refresh. |
| `src/subagent-viewer-submit.ts` | (structural `ctx.subagents` followup surface, injected) | The pure follow-up delivery core; consumed by the `SubagentPort` (M1.2). |
| `src/runtime/direct/subagent-direct.ts` | `subagents` | The Direct `SubagentPort` adapter (M1.2) — the ONLY module in the follow-up path that touches `ctx`; the runner depends on the port. Baseline entry added by the M1.2 relocation. |
| `src/runtime/direct/session-direct.ts` | `sessionPersistence`, `sessionQuery` | The Direct `SessionReader` adapter (M1.3) — owns the live-preferred listing, the bounded content search and the cached title batches; the consumer (commands.ts) depends on the port. Baseline entries added by the M1.3 relocation. |
| `src/runtime/direct/session-writer-direct.ts` | `sessionTitle` | The Direct `SessionWriter` adapter (M1.4) — wraps the raw agent/session write ops (followup, steer, dequeue, cancel) and the `ctx.sessionTitle` service (rename/refresh); the runner keeps the Direct-mode orchestration (guard/fence/barrier) around the port calls. Baseline entry added by the M1.4 relocation. |
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
