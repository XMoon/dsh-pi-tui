# Server/client migration — source of truth

> This document is the migration's source of truth (AGENTS.md "Server/client
> migration guardrails (hard rules)"). **Read it before touching
> Host-coupled code**; update it in the same PR as any phase work. The
> coupling allowlist lives in `docs/client-server-coupling.md`; the hard
> rules live in AGENTS.md.

## Status

```text
M0  DONE           (AGENTS.md guardrails, coupling inventory, boundary gate, baseline)
M1  DONE           (semantic ports + Direct adapters, no behavior change — M1.1–M1.11 landed: subagent, session read/write/lifecycle, interaction, catalog (models/presets/skills), config (settings/provider profiles/credentials/authorization/permissions/preset default) and host-file (`@`-mention discovery + send-time canonicalization); CommandHostCapabilities retired, `runner.host` removed, commands read Host state ONLY through ports; Direct ownership escapes (lock/lease/PINNED/guard/transition/barrier) untouched; contract review: authorization is an EVENT surface (begin → attemptId → notice/prompt events → respond/cancel — never a callback-bearing interaction across the port), Host-file candidates are PATH-ONLY DTOs (`{path, kind}`, the official FileReferenceCandidate shape — ranking/quoting/presentation are client policy in mentions.ts), the catalog directory DTO is semantic (no settings namespace/path), the /login credential options cross as the port's `CredentialProviderOption` DTO (semantic flags only — `canProvisionProfile` replaces any namespace/path, one adapter-owned rule drives both the flag and the write-time validation), keyless profile writes return written/skipped, and viewer follow-ups canonicalize against the CHILD workspace)
M2  NOT STARTED   (experimental Remote backend against an existing DSH Host)
M3  NOT STARTED   (experimental in-process wire: Semantic Port + Remote Adapter + DSH Connection)
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
persistence through a narrow **Semantic Port**. A **Remote Adapter** maps that
port to a **DSH Connection** and the official DSH client contract (Client
Runtime, mux/host streams) — over an in-process wire by default, IPC later,
HTTP/WS only for explicit remote attach. `dsh --profile pi-tui` keeps its
UX; `dsh-pi-tui attach <url>` is the explicit remote entry. Host-owned domain
services and generated remotes remain in the DSH host; the port must not
recreate them as TUI-specific DTOs.

### Ownership vocabulary

- **Semantic Port** — the TUI-facing domain contract, independent of transport.
- **Remote Adapter** — translates the port to a remote connection without
  moving Host ownership into the TUI.
- **DSH Connection** — the official transport/client-runtime boundary.
- **Domain / Generated Remotes** — DSH-owned operations exposed by the host;
  the TUI consumes them rather than inventing parallel RPC shapes.
- **Host domain services** — persistence, sessions, tools, approvals, jobs and
  other stateful services that remain composed and owned by DSH.

### Session query and raw export ownership

Session list/title/search/filter semantics belong to the public DSH
`sessionQuery` service. The Direct adapter may use its provider-independent
`filterEvents` seam when the shipped SQLite full-text provider is disabled
(`openAt: never`), and may retain a narrowly scoped raw-persistence fallback
only when that semantic capability is absent or explicitly disabled. `readRaw()`
is reserved for raw-artifact fidelity such as export or repair, not as the
long-term semantic search contract.

Raw session export is a separate Host streaming route:

```text
ordinary session control/history/state -> official Session client object / generated Remote
raw session export                    -> Connection HTTP GET/HEAD /api/session.export
```

It is not an ordinary JSON-RPC payload and must not be implemented by sending a
complete raw transcript to the Client for recompression.

## Phases (one behavior axis per phase; each independently mergeable/verifiable/rollback-able)

| Phase | Content | Acceptance gate |
|---|---|---|
| M0 | Guardrails (AGENTS.md), this doc, coupling inventory, `scripts/client-boundary-gate.mjs` (baseline + no-new-debt) | Zero runtime behavior change; no new runtime dependency; all tests green |
| M1 | Semantic ports + Direct adapters (subagent first, then session read/write/lifecycle, catalog/config, interaction); narrow `TuiCommandContext` | Per domain: old-behavior test + adapter contract test both green; backend stays `direct` |
| M2 | Experimental Remote Adapter against an existing DSH Host: Semantic Port reads first, then writes, then approval/question via the DSH Connection | Shadow parity on read paths; no session lock/lease/guard in Remote mode |
| M3 | Experimental in-process wire: separate Host/Client Cordis contexts, DSH Connection over the Semantic Port, no TCP | Wire parity on the transcript parity suite; Host composition stays experimental |
| M4 | Local Host process / IPC split; crash semantics (TUI↔Host, Ctrl+C/D, SIGTERM, HMR, parent/child death) | IPC integration lane green; ordinary local mode: TUI owns ephemeral Host lifecycle |
| M5 | `dsh-pi-tui attach <url>`; localhost + SSH tunnel only; remote `!` disabled until a Host-side shell seam; remote external editor unsupported | Security review; fail-closed locality checks |
| M6 | Production dual stack: `--backend wire-local` opt-in, direct default; extension CI matrix (direct × wire-local) | One stable observation cycle; no perceptible regression |
| M7 | Default flip to wire-local; `--backend direct` rollback kept for ≥ 1 release | Rollback verified on the release train |
| M8 | Direct ownership retirement (lock/lease/PINNED/guard/transition/barrier) | Proof: all TUI writes Host-owned, cross-client concurrency safe (Web+TUI, TUI+TUI, reconnect, cold resume, Host crash) |

The former in-process client wording is obsolete upstream architecture, not an
implementation target. Redesign the adapter around the DSH Connection, official
Session client object, and domain/generated remotes before starting M3. Do not
add old/new DSH runtime capability branches to the 0.4 Direct backend.

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

## Feature locality ledger (M0–M5 footer/status work)

Every new feature declares its machine ownership (AGENTS.md guardrail):

- **Status projection (the `StatusStore` + derives, `src/status/`) is
  Host-owned.** The runner derives composition/access/plan/workspace/usage/
  host from DSH services (agent options, permission presets, sandbox
  policy, plan controller, token meter, session events). The TuiApp only
  projects its OWN surface state (interaction/activity/surface/view). The
  Direct backend provides the facts; a Remote backend must source the same
  derivations from the DSH client contract — the status seam is the
  sanctioned migration port (see `docs/client-server-coupling.md`).
- **The footer surface (composer/layout/items/configurator, `src/footer/`)
  is client-local presentation.** It consumes the snapshot; no Host
  service is read there. The extension footer items ride the public
  extension service (Host-composed, Stable). User Custom Text definitions are
  compiled into the same local item contract, but their raw definition
  collection is Host-owned settings data and is persisted separately from the
  client-local `FooterLayoutV1` placement references. The Direct config port
  resolves definitions from the settings descriptor's USER layer only;
  merged/project values are pass-through storage and cannot create
  `user:*` definitions. It exposes a parsed runtime projection plus an
  exact raw USER storage projection, so unrelated writes preserve
  unknown/future definition kinds. A future Remote adapter must carry both
  fields through one whole-document settings round-trip; it
  must not invent a callback or merge definitions into layout refs.
- **The footer command status line (M5) is DIRECT-ONLY, client-local
  execution.** The trusted command runs on the Client machine's shell
  (like the local `!` shell) with a USER-layer-only trust gate. There is
  no Remote/wire story yet: remote attach must fail closed — the command
  mode stays disabled and the native layout applies until a Host-side
  execution seam exists (the same blocker as remote `!`).
- **The `/footer` configurator and the /settings footer rows are
  client-local UI over Host-owned settings** (the dsh-pi-tui settings
  document via the settings service).

## Known blockers

| Blocker | Level | Mitigation |
|---|---|---|
| Client Runtime still carries web assembly assumptions (`dsh.client.platform: web`) | High | M2 consumes the protocol directly; M3 validates runtime packaging |
| DSH Connection / generated-remote dependency closure differs from the pi-tui profile | High | Experimental host composition; redesign the Remote Adapter before M3; never replace the default patch |
| Extension Cordis ownership across the split | High | Stable API untouched; ClientContext from M3 |
| Session lock removal before Host owns all writes | Critical | Deferred to M8 by rule |
| Shell execution on the wrong machine | Critical | Locality hard rule; remote `!` fails closed |
| `@file` resolving on the Client filesystem | High | M1.10 sealed the locality boundary: all `@` discovery/canonicalization goes through `HostFilePort`; the M2 Remote adapter maps it to Host fileReferences |
| Credentials exposure beyond loopback | Critical | Attach limited to localhost/SSH until real auth |
| Dual-stack semantic drift | Medium | Shared backend contract test matrix |
| Upstream DSH contract changes | Medium | Public export audit + per-release compatibility matrix; no old/new runtime fallback |

## Startup constraint

`src/startup.ts` parses flags and gives a friendly error for Harness versions
below the 0.4 floor. Experimental Remote dependencies must never enter its
static import graph — load the selected backend via dynamic import in a
`runtime/backend-loader` module. The 0.4 Direct backend targets DSH
`>=0.1.2-alpha.1`; it has no old/new runtime fallback or capability-detection
branch. Future versions are not rejected without a confirmed break.

## How to update this file

- Every phase completion: flip the phase status, record what landed, and
  update the "Current production backend / Experimental backend / Remote
  attach / Direct rollback" block.
- Every coupling relocation: update `docs/client-server-coupling.md` and
  the gate baseline in the same PR.
- Every new blocker or removed blocker: update the table.
