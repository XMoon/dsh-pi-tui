# Server/client migration — source of truth

> This document is the migration's source of truth (AGENTS.md "Server/client
> migration guardrails (hard rules)"). **Read it before touching
> Host-coupled code**; update it in the same PR as any phase work. The
> coupling allowlist lives in `docs/client-server-coupling.md`; the hard
> rules live in AGENTS.md.

## Status

```text
M0  IN PROGRESS   (AGENTS.md guardrails landed; coupling inventory + gate landed)
M1  NOT STARTED   (semantic ports, Direct adapters, no behavior change)
M2  NOT STARTED   (experimental Remote backend against an existing DSH Host)
M3  NOT STARTED   (experimental in-process wire: InProcessApiClient + ApiProxy)
M4  NOT STARTED   (experimental local Host process / IPC split)
M5  NOT STARTED   (external attach; localhost/SSH only)
M6  NOT STARTED   (production dual stack: direct default, wire opt-in)
M7  NOT STARTED   (default flip; direct rollback kept for >= 1 release)
M8  NOT STARTED   (Direct ownership retirement — only after concurrency proof)

Current production backend: direct
Experimental backend:      none
Remote attach:             unsupported
Direct rollback:           available
```

## Current state

`dsh --profile pi-tui` runs in-process: the TUI consumes Host services
directly (`ctx.get(...)` — see `docs/client-server-coupling.md` for the
inventory). Session ownership (owner.lock, lease/cooling, PINNED, divergence
guard, transition gate, operation barrier) is Direct-mode machinery and stays
authoritative until M8.

## Target

A DSH-native client: the TUI keeps terminal/editor/overlays/keybindings/
extension surface, and reaches Agent/Session/subagent/jobs/approval/
persistence through the official DSH client contract (`IApiClient`, Client
Runtime, mux/host streams) — over an in-process wire by default, IPC later,
HTTP/WS only for explicit remote attach. `dsh --profile pi-tui` keeps its
UX; `dsh-pi-tui attach <url>` is the explicit remote entry.

## Phases (one behavior axis per phase; each independently mergeable/verifiable/rollback-able)

| Phase | Content | Acceptance gate |
|---|---|---|
| M0 | Guardrails (AGENTS.md), this doc, coupling inventory, `scripts/client-boundary-gate.mjs` (baseline + no-new-debt) | Zero runtime behavior change; no new runtime dependency; all tests green |
| M1 | Semantic ports + Direct adapters (subagent first, then session read/write/lifecycle, catalog/config, interaction); narrow `TuiCommandContext` | Per domain: old-behavior test + adapter contract test both green; backend stays `direct` |
| M2 | Experimental Remote backend against an existing DSH Host (read-only first, then writes, then approval/question via `PendingWait` + `api.respond`) | Shadow parity on read paths; no session lock/lease/guard in Remote mode |
| M3 | Experimental in-process wire: separate Host/Client Cordis contexts, `InProcessApiClient` → `ApiProxy`, no TCP | Wire parity on the transcript parity suite; Host composition stays experimental |
| M4 | Local Host process / IPC split; crash semantics (TUI↔Host, Ctrl+C/D, SIGTERM, HMR, parent/child death) | IPC integration lane green; ordinary local mode: TUI owns ephemeral Host lifecycle |
| M5 | `dsh-pi-tui attach <url>`; localhost + SSH tunnel only; remote `!` disabled until a Host-side shell seam; remote external editor unsupported | Security review; fail-closed locality checks |
| M6 | Production dual stack: `--backend wire-local` opt-in, direct default; extension CI matrix (direct × wire-local) | One stable observation cycle; no perceptible regression |
| M7 | Default flip to wire-local; `--backend direct` rollback kept for ≥ 1 release | Rollback verified on the release train |
| M8 | Direct ownership retirement (lock/lease/PINNED/guard/transition/barrier) | Proof: all TUI writes Host-owned, cross-client concurrency safe (Web+TUI, TUI+TUI, reconnect, cold resume, Host crash) |

## Hard invariants (enforced by AGENTS.md guardrails)

- Direct stays the production default until an explicit milestone flips it.
- No new Host coupling outside the approved boundary (gate-enforced).
- No `TuiBackend` god object — narrow domain ports only.
- Host-owned behavior uses the official DSH wire contract; no TUI-specific
  RPC/DTO when DSH owns the concept; no second event fold (Client Runtime
  owns transport state, TUI owns presentation only).
- No callbacks across the process boundary — data/identity/method/event only.
- Session ownership safety is not migration cleanup (M8, after proof).
- `src/startup.ts` stays a zero-dependency compatibility island; experimental
  backend code loads only after startup selection (dynamic import).
- Migration work is off by default; every migration PR leaves Direct green.

## Known blockers

| Blocker | Level | Mitigation |
|---|---|---|
| Client Runtime still carries web assembly assumptions (`dsh.client.platform: web`) | High | M2 consumes the protocol directly; M3 validates runtime packaging |
| Host ApiProxy dependency closure differs from the pi-tui profile | High | Experimental host composition; never replace the default patch |
| Extension Cordis ownership across the split | High | Stable API untouched; ClientContext from M3 |
| Session lock removal before Host owns all writes | Critical | Deferred to M8 by rule |
| Shell execution on the wrong machine | Critical | Locality hard rule; remote `!` fails closed |
| `@file` resolving on the Client filesystem | High | Remote mode uses Host fileReferences |
| Credentials exposure beyond loopback | Critical | Attach limited to localhost/SSH until real auth |
| Dual-stack semantic drift | Medium | Shared backend contract test matrix |
| Upstream DSH contract changes | Medium | Structural/capability detection + compat matrix |

## Startup constraint

`src/startup.ts` parses flags and gives a friendly error on incompatible
Harness versions. Experimental Remote dependencies must never enter its
static import graph — load the selected backend via dynamic import in a
`runtime/backend-loader` module. Direct keeps the current compatibility
range; Remote capability-detects and raises the minimum only when a
production-default path truly requires it.

## How to update this file

- Every phase completion: flip the phase status, record what landed, and
  update the "Current production backend / Experimental backend / Remote
  attach / Direct rollback" block.
- Every coupling relocation: update `docs/client-server-coupling.md` and
  the gate baseline in the same PR.
- Every new blocker or removed blocker: update the table.
