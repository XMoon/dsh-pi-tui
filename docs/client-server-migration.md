# Server/client migration — source of truth

> This document is the migration's source of truth (AGENTS.md "Server/client
> migration guardrails (hard rules)"). **Read it before touching
> Host-coupled code**; update it in the same PR as any phase work. The
> coupling allowlist lives in `docs/client-server-coupling.md`; the hard
> rules live in AGENTS.md.

## Status

```text
M0  DONE           (AGENTS.md guardrails, coupling inventory, boundary gate, baseline)
M1  DONE           (semantic ports + Direct adapters, no behavior change AT THE TIME — M1.1–M1.12 landed: subagent, session read/write/lifecycle, interaction, catalog (models/presets/skills), config (settings/provider profiles/credentials/authorization/permissions/preset default), host-file (`@`-mention discovery; its historical send-time canonicalization was retired by the M3-3A official-mention realignment — submitted mentions stay literal, the Host's FILE_REFERENCE_PROMPT owns resolution), and Agent-local model selection (durable Session intent plus global fallback); CommandHostCapabilities retired, `runner.host` removed, commands read Host state ONLY through ports; Direct ownership escapes (lock/lease/PINNED/guard/transition/barrier) untouched at M1 — the physical lock stack is removed legacy on the master baseline; contract review: authorization is an EVENT surface (begin → attemptId → notice/prompt events → respond/cancel — never a callback-bearing interaction across the port), Host-file candidates are PATH-ONLY DTOs (`{path, kind}`, the official FileReferenceCandidate shape — ranking/quoting/presentation are client policy in mentions.ts), the catalog directory DTO is semantic (no settings namespace/path), the /login credential options cross as the port's `CredentialProviderOption` DTO (semantic flags only — `canProvisionProfile` replaces any namespace/path, one adapter-owned rule drives both the flag and the write-time validation), keyless profile writes return written/skipped, and viewer follow-ups addressed the CHILD workspace — historically via the
send-time canonicalization that M3-3A later retired for the official literal
mention semantics; the viewer send seam now routes identity-only)
M2  DONE   (D1 COMPLETE: D1.1 Session read shadow, D1.2 command/skill authority read shadow, and D1.3 subagent/task + presentation read parity; D2.1 DONE: Direct-only write-contract convergence + pending-input presentation parity; D2.2 DONE: experimental official Client ordinary-write adapters + submission-presentation seam — see the D2.2 status section; D2.3 DONE: model directory + Session-local model selection, blank-Session preset selection, ordinary create/open lifecycle convergence and presentation closure — see the D2.3 status section; D2.4 DONE: Host-owned fork/rewind convergence; D2 COMPLETE)
Pre-M3 DONE   (readiness closure, no behavior change — see the Pre-M3 status section: Direct semantic assembly centralized in `src/runtime/direct/backend-direct.ts`; `JobObservationPort` joined the `Backend` vocabulary; P1 `RemotePluginManagerPort` + `RemoteJobObservationPort` added but NOT production-composed; the centralized published-0.1.7-rc.2 Client/Remote structural contract gate is green; the focused same-Host lifecycle/model/preset smoke replaces the retired D2.3 lane)
Pre-M3 TS Architecture Convergence  DONE   (M3-oriented application-layer ownership convergence, NO behavior change — A5a + A5b; see the Pre-M3 TS Architecture Convergence status section)
M3-0 DONE          (entry contract frozen — the M3 architecture contract is docs/m3-entry-contract.md)
M3-1 DONE          (experimental in-process wire composition spine: reusable `RemoteHostRuntime` + `RemoteClientRuntime` + `backend-loader.ts` dynamic boundary, zero product cutover — see the M3-1 status section)
M3-2 DONE          (Remote Session owner spine: exact-`SessionBinding` `SessionOwnerAccess`/`SessionOwnerRetirement` provider, transport-neutral app/session runtime, Remote fork publication→open adoption — zero product cutover, see the M3-2 status section)
M3-3A DONE         (Remote session/runtime/catalog/host-file semantic closure: official contextPressure + turnOutline + sessionStatus projection reads, subagent allowlist on the official model directory, Remote skills/list + fileReferences/list adapters, truthful Host-file unavailable states, PresentationReader.loadThrough, one-source M3-3A semantic bundle — zero product cutover, see the M3-3A status section)
M3-3B DONE         (rc.2 retarget + frozen-contract reconvergence; rc.2 Question semantics in the semantic port on BOTH backends with a timed/continued UI lifecycle; Remote ConfigPort settings mirror; Remote `/api/session.export` archive; complete experimental Remote `Backend` + `BackendKind 'remote'` — zero product cutover, see the M3-3B status section)
M3-4 PR1 DONE      (application runtime-selection spine: `SelectedApplicationRuntime` core + the Remote application runtime aggregate + the internal selection seam in bootstrap; normal/default remains Direct, no public/config/env selector — see the M3-4 status section)
M3-4 IN PROGRESS   (main TUI Remote composition; PR1 of the PR train landed — full Remote main surface NOT YET COMPLETE)
M4  NOT STARTED   (experimental local Host process / IPC split)
M5  NOT STARTED   (external attach; localhost/SSH only)
M6  NOT STARTED   (production dual stack: direct default, wire opt-in)
M7  NOT STARTED   (default flip; direct rollback kept for >= 1 release)
M8  NOT STARTED   (Direct ownership retirement — only after concurrency proof)

Current production backend: direct
Experimental backend:      ONE complete Backend(kind='remote') assembly exists (M3-3B:
                           M3-3A semantics + interaction + config + archive + Plugin
                           Manager + Job observation); constructed/tested only, never
                           selected by normal startup
Experimental Remote:        reads + selected ordinary writes + interaction (approval +
                           rc.2 Question lifecycle) + ConfigPort settings mirror +
                           session archive (adapters proven in tests/smoke; the
                           M3-4 PR1 application aggregate can compose the whole graph
                           internally — still no production bootstrap call site)
Remote writes:              experimental/test only (no production wiring)
Remote attach:              unsupported
Direct rollback:           available
```

## Current state

`dsh --profile pi-tui` runs in-process: the TUI consumes Host services
directly (`ctx.get(...)` — see `docs/client-server-coupling.md` for the
inventory). Session writer ownership is DSH's `SessionHandle` /
`SessionWriteLease` (kernel flock) — the natural Server-side authority,
already in place on the master baseline; the TUI adds no physical
persistence lock (the owner.lock / lease / cooling / PINNED stack is
removed legacy). The TUI keeps only process-local surface coordination
(transition gate, operation barrier, generation/stale fences) around the
port calls.

D2.1 converges the current write boundaries without adding a Remote side
effect. Ordinary session prompts, dsh-web-style FIFO per-occurrence Ctrl+S steering, exact queue removal,
cancel and title writes use the semantic `SessionWriter`; the runner places
ordinary, explicit-queue, Ctrl+S, and command/fallback submissions on one FIFO
before async preparation; already-authorized
Host command execution uses `HostCommandPort`; and Task Center child
interruption uses `SubagentPort`. Pending input is read through the semantic
`PendingInputReader` projection, so consumers do not depend on Direct inbox
collection names. These remain Direct-AUTHORITATIVE in production. The
experimental Remote write adapters added in D2.2/D2.3 are test/smoke-only and
have no production wiring.

### Model-selection ownership

The Direct model catalog exposes the global `agentDefaultModel` only as a
fallback for Sessions without a local choice. Each live Agent owns its own
selection reference, reconstructed from durable `model/selection` intent and
the latest `request/header`; the TUI facade follows whichever Agent is live.
The semantic catalog names these operations explicitly as
`defaultSelection`/`saveDefaultSelection` and `sessionSelection`/
`selectSessionModel`, so a future Remote adapter can map them without moving
Agent, Session, or Context objects across the boundary.

### Direct ownership retirement (remaining M2 work)

The current Direct backend owns the in-process top-level Agent and must
quiesce/drain/dispose it during runner teardown (interactive exit, HMR
unload, and post-commit session transitions). A2 put that retirement behind the
consumer-owned `SessionOwnerRetirement` port
(`src/app/session/owner-access.ts`); the Direct adapter that implements it
(`src/app/direct/owner-retirement.ts` +
`src/runtime/direct/owned-session-retirement.ts`) still uses the Direct-only
`SessionHandle.direct` escape and is retained until M8. The port describes the
session layer's OWN need (quiesce/pre-cancel/retire/park one owner) and leaves
HOW an abort reaches the owner to the backend, so it is NOT a Remote
session-close semantic: a future Remote client closes its client-side
observation/connection state through official DSH client contracts. This work
does not invent a host session-destroy RPC, does not add
`close()`/`dispose()`/`drainSubagents()` to the `SessionLifecycle` port, and
does not expose `drainContinuableDescendants` as a cross-backend capability (the
runner injects it as a provider). The ownership-retirement portion (removing the
`direct` escape) remains pending, and Direct remains the production backend.

### Lifecycle creation cancellation (Stage B / pre-M2)

`CreateSessionRequest` and `OpenSessionRequest` may carry a client-local,
creation/open-only `AbortSignal`. In Direct mode the session lifecycle adapter
maps that signal to `ctx.agents.create` / `ctx.agents.resume`; the semantic
`open` operation still uses the Direct `resume` implementation detail. The
signal is valid only through persistence load, unpublished setup, and
publication, and is never serialized. A future Remote adapter must map it to
official DSH client operation cancellation rather than sending the
`AbortSignal` over the wire. Stage B completes this contract and is not Remote
backend work.

### Finalized content presentation (Stage C1 / pre-M2)

Stage C1 presents already-finalized `ContentBlock` values without changing
stream lifecycle or Host ownership. Transcript-facing flat projections retain
image and file attachment markers; FileBlocks render from durable name/byte
metadata only; and unknown finalized blocks use an explicit bounded JSON
fallback. The shared visibility rule covers transcript search and rewind
candidate eligibility/warnings; rewind preview/editor restoration remain
text-only by policy. Readable markdown export uses the richer projection.
Queue/steer/removal behavior remains outside this finalized-only stage; only
its rewind notification wording is generalized, and rewind does not re-stage
content. No attachment bytes/paths are resolved; migration remains
D1.1 is complete for the experimental read surface; Direct remains the production backend.

### Unified attachment intake (Stage C2 / pre-M2)

The TUI exposes `/attach <path>` as the canonical Client-local intake and
keeps `/image <path>` as an image-only compatibility command. Generic files
remain Client-local draft metadata until an agent-bound submission has
resolved/created its Session; Direct then streams the exact local file into
`ctx.attachments.saveFileStream()` and records only the resulting durable
FileBlock. This Stage C2 surface remains outside D1.1: no Session Controller file-upload receipt,
Connection transport, or Remote upload state is implemented here.

Locality is explicit: `/attach` and `/image` use the Client-local cwd, while
`@` mentions remain Host/session-scoped.

### Inline skill references (pre-M2 locality note)

Inline skill references are Client-local input presentation backed by the
existing skill catalog semantic port: the editor completes plain-text
`/name` tokens from the detached `HumanSkillSummary[]` and inserts literal
text only. Invocation is an ordinary user prompt; the Host `dsh-tool-skill`
pre-step owns gesture resolution and body injection. A future Remote
adapter must map the existing catalog to the official `skills.list` and must
not add a `skill.invoke`-style TUI RPC — the input layer needs no rewrite.

### Open/opaque Assistant block presentation timing (Stage C3 / pre-M2)

Stage C3 aligns the TUI's transient and durable-attempt presentation with
the pinned DSH client projection. A non-incremental/unknown block-start is
visible immediately as an opaque null-payload presentation row, while
text/reasoning/tool-call retain their existing lane-specific visibility.
The first block-end remains authoritative and replaces the open
presentation with the finalized ContentBlock. No synthetic ContentBlock is
persisted or exposed through semantic text/search state.

Stage C is complete after this change; D1.1 is complete for the experimental
read surface, and Direct remains the production backend.

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

### Session query and export ownership

Session list/projection/search/filter semantics belong to the public DSH
`sessionQuery` + projection services. The list keeps live Sessions even when
`cwd` is absent, while cold Sessions without `cwd` are omitted; semantic search
considers only cwd-bearing Sessions before applying its work bound. The picker's
`title` and `agentPreset` values are Host-owned DSH projections read through ONE semantic port method,
`SessionReader.projectionBatch()`: live rows read already-materialized `title`
and cached `agentPreset` cells via `sessionProjections.cachedSnapshot()` while the live preset prefers the Agent's
CURRENT composed roster entry (`agentPresets.composedPreset()`) — a
deliberate live-only exception (the running Agent's actual composition is
the authoritative effective preset even while it trails the durable
projection mid-switch), with the projection value as the fallback;
cold rows via the zero-I/O `sessionProjectionCache.cachedSnapshot()` checkpoint
keyed by the listing's header identity (with the official predecessor-title hint
where applicable). A cold cache miss remains unknown: the picker never activates
or observes a historical Session merely to fill labels. A future Remote adapter
maps this port method onto the official DSH client projection contract — it must
not copy private Direct state, and the TUI must never keep a second (private)
persistence of session derived state (the retired
`$DSH_HOME/cache/pi-tui-session-titles.json` title cache was exactly that).

Content search is the `SessionReader.search()` semantic port: the Direct
adapter mirrors master `ApiSessionList.search()` business semantics over the
official `sessionQuery.searchSessions()` seam (user/assistant message +
current-surface filters, cwd visibility authorization, dedupe, cursor fill,
the official 20-result window, and the provider-call work budget) — the retired
TUI-owned "newest 100 sessions + `filterEvents` loop + first 20 hits" private
rule is gone, so a match in an old session is found regardless of recency.
`undefined` means the content-search capability is unavailable or explicitly
disabled (the shipped SQLite FTS provider is `openAt: never` by default);
it never falls back to raw persistence and never means listing is unavailable.
A future Remote adapter maps the same port method onto the official
`session.search` contract without touching `/sessions`, `/resume` or `/search`.
No TUI semantic path uses `readRaw()` or scans physical persistence artifacts:
`/export` reads the committed logical log through the archive port's
persistence read handle (the full-tree ZIP semantics below), and the retired
repair stack has no runtime owner.

Session export is a separate Host streaming route:

```text
ordinary session control/history/state -> official Session client object / generated Remote
canonical session-log export           -> Connection HTTP GET/HEAD /api/session.export
```

It is not an ordinary JSON-RPC payload and must not be implemented by sending
physical persistence bytes to the Client for recompression.

### Pre-Stage-D Export convergence

```text
/export product semantics are now the official full Session-tree archive.

Direct:
    SessionArchivePort -> DirectSessionArchive
    -> DSH public Host archive primitives

Stage D later:
    same SessionArchivePort -> Remote adapter
    -> GET/HEAD /api/session.export

Client destination:
    post-command Save Location
    Client filesystem only

/transcript:
    TUI readable Markdown artifact
    same no-argument/save-location UX

SessionReader.readExportData:
    retired

D1.1 does not add a Remote archive adapter; the Remote Session read-shadow is
experimental only and Direct remains the production backend.
```

The Direct archive adapter (`DirectSessionArchive`) implements the narrow
`SessionArchivePort.open()` over the DSH public `session-log-export`
primitives: it flushes a live Session through the store's durability barrier,
opens a persistence READ handle for the committed log ONLY (never the
cold-view observation seam), and streams the official full-tree ZIP
(descendants + attachments) to the Client. The FILE WRITE stays Client-local:
after a successful `/export` or `/transcript` command settles, the runner
opens the Client-local Save Location UI and sinks the artifact through the
temp + atomic-commit helpers — the final artifact is never exposed partially
written. `/transcript` renders the readable Markdown from the CAPTURED
originating Session (never `liveAgent` at delayed settle time). The
migration-era `SessionReader.readExportData()` seam is retired; the archive
port is the single export plane for both Direct today and the Remote adapter
in Stage D.

## Phases (one behavior axis per phase; each independently mergeable/verifiable/rollback-able)

| Phase | Content | Acceptance gate |
|---|---|---|
| M0 | Guardrails (AGENTS.md), this doc, coupling inventory, `scripts/client-boundary-gate.mjs` (baseline + no-new-debt) | Zero runtime behavior change; no new runtime dependency; all tests green |
| M1 | Semantic ports + Direct adapters (subagent first, then session read/write/lifecycle, catalog/config, interaction); narrow `TuiCommandContext` | Per domain: old-behavior test + adapter contract test both green; backend stays `direct` |
| M2 | Experimental Remote Adapter against an existing DSH Host: Semantic Port reads first, then writes, then approval/question via the DSH Connection | Shadow parity on read paths; no physical session lock in Remote mode — DSH writer ownership stays Host-side |
| M3 | Experimental in-process wire: separate Host/Client Cordis contexts, DSH Connection over the Semantic Port, no TCP | Wire parity on the transcript parity suite; Host composition stays experimental |
| M4 | Local Host process / IPC split; crash semantics (TUI↔Host, Ctrl+C/D, SIGTERM, HMR, parent/child death) | IPC integration lane green; ordinary local mode: TUI owns ephemeral Host lifecycle |
| M5 | `dsh-pi-tui attach <url>`; localhost + SSH tunnel only; user-entered `!`/`!!` bypass mode remains Client-local, while `localShellSandbox=sandbox` stays unsupported until a real Client-side sandbox carrier exists; remote external editor unsupported | Security review; fail-closed locality checks |
| M6 | Production dual stack: `--backend wire-local` opt-in, direct default; extension CI matrix (direct × wire-local) | One stable observation cycle; no perceptible regression |
| M7 | Default flip to wire-local; `--backend direct` rollback kept for ≥ 1 release | Rollback verified on the release train |
| M8 | Direct ownership retirement (the SessionHandle `direct` escape — live Agent/AgentHandle; the physical lock stack is already removed legacy) | Proof: all TUI writes Host-owned, cross-client concurrency safe (Web+TUI, TUI+TUI, reconnect, cold resume, Host crash) |

The former in-process client wording is obsolete upstream architecture, not an
implementation target. Redesign the adapter around the DSH Connection, official
Session client object, and domain/generated remotes before starting M3. Do not
add old/new DSH runtime capability branches to the 0.4 Direct backend.

## Migration process and qualification governance

Permanent process rules for the migration (added after M3-3B; normative for
every stage closure from now on). They do not replace the phase plan above; they
define what "DONE" may mean.

### Mandatory stage closure protocol

A migration stage may be marked DONE only when four axes are closed:

```text
1. CONTRACT
   the exact released DSH authority is current
2. IMPLEMENTATION
   the semantic owner, adapter and composition are correct
3. QUALIFICATION
   the required L1-L6 evidence, as applicable, is complete
   the supported success path is proven
   the required negative/fail-closed paths are proven
4. SURFACE / REACHABILITY
   user-visible state/action/recovery has an explicit disposition
   reachability is classified
```

`CI green`, `adapter exists`, `RPC succeeds` or `unit tests pass` cannot
substitute for any missing axis.

### Qualification evidence levels

The test-layer vocabulary is owned by `## M3 test-layer contract (T0 handoff)` and
is NOT redefined here:

```text
L1 semantic-port contract
L2 Direct adapter contract
L3 Remote adapter contract
L4 Direct ↔ Remote parity
L5 official in-process wire integration
L6 application composition
```

A stage closure cites the level that actually proves the fact, and adds a level
only when that level is under test:

```text
adapter-level evidence      = L1-L3 as applicable
wire evidence               = L5
application/surface evidence = L6 when application ownership / reachability is
                              actually under test
```

Consequences a closure must respect:

- Structural fakes are legitimate at L1–L3 but never prove official generated
  Client object shape or production composition. Every wire-sensitive Remote
  capability needs at least one L5 proof before closure.
- L5 is the real Client Context → Gateway → Host path with no TUI runner. It
  proves prototype/accessor object shape, method receiver binding, real Remote
  namespace availability, production prerequisite composition, transport path,
  supported success-path interoperability and reverse disposal/lifetime where
  relevant.
- L6 uses the real runner/application owner wiring and settlement; it is required
  when application ownership, navigation, user recovery, presentation parity or
  reachability is the fact under test.
- An implementation file is never qualification evidence; name the test or smoke
  lane that proves the fact.

### Positive and negative evidence are separate

For a capability classified SUPPORTED in the production-equivalent topology,
positive success-path qualification is mandatory:

```text
Config supported
-> a real write must mutate Host authority and an authoritative reread must return it

Archive supported
-> real Host persistence must produce a real export stream/ZIP

Question continued answer supported
-> real projection/claim/answer path must complete
```

Negative evidence remains valuable:

```text
service absent -> unavailable
stale generation -> reject
unsupported sub-capability -> fail closed
Host 500 -> propagate
```

But a negative path never substitutes for a supported success path.

### Production-equivalent fixture manifest

Every NEW or materially modified L5 fixture from M3-4 onward MUST state at its
declaration site or immediately above the test:

```text
PRODUCTION PREREQUISITES REPRODUCED
  ...

TEST STAND-INS / SUBSTITUTIONS
  ...

DELIBERATELY ABSENT
  ...
```

Existing pre-governance L5 fixtures are grandfathered; when one is materially
touched it must be upgraded to the manifest form.

A fixture may use stubs for unrelated domains, but it must not claim to prove a
normal product topology while omitting a base prerequisite ordinary production
composition owns. `profileContext` + `ConfigEditor` + `Settings` are the
canonical example: they are production base/profile prerequisites, and
`RemoteHostRuntime` must not mount them merely to make a test pass.

### Surface reachability classification

Every row in a semantic/UI impact matrix carries a reachability value:

```text
SURFACE_REACHABLE
  -> L6 navigation/input proof when important

PROJECTION_ONLY
  -> semantic/projection proof is sufficient

TRANSIENT
FORBIDDEN_CONCURRENT_STATE
  -> MUST NOT weaken modal/input guards merely to make the state testable
```

A visible Question with an `answering` row in a Task Center projection is a valid
projection fact while Task Center stays intentionally non-navigable because the
Question owns the response seat; a product-invalid concurrent surface must never
be manufactured to make a state testable. The M3-3B impact matrix predates this
vocabulary; M3-4 onward matrices carry the value per row.

### Contract requalification on a DSH baseline change

If the exact DSH target changes during an active stage:

```text
STOP assumption-driven coding
-> diff released public contract
-> classify changed semantics / composition / outward behavior
-> amend frozen contract only where authority changed
-> update qualification matrix
-> rerun targeted L5/L6
-> resume stage
```

Classify each delta as `INHERITED`, `CONTRACT_AMENDMENT`,
`QUALIFICATION_ONLY`, `DEFERRED_WITH_OWNER` or `N/A`. Do not broadly reopen
unaffected stages merely because the version changed.

### Original-plan closure review (required gate)

Before setting a stage to DONE:

```text
1. reopen the original accepted implementation plan
2. check every Must / Must-not / Acceptance item
3. compare final code, not only latest addendum
4. verify supported success-path evidence
5. verify required failure/reconnect evidence
6. verify UI/reachability disposition
7. reconcile this live migration document
8. promote only intentional leftovers to the Debt Ledger
9. run broad gates
```

This review is distinct from normal PR review.

### Closure evidence template

Each completed M3-x status section carries one compact block:

```md
### Closure evidence

- Contract authority:
- Composition owner:
- Adapter-level evidence (L1–L3):
- Direct ↔ Remote parity (L4):
- Wire evidence (L5):
- Application/surface evidence (L6):
- Supported success path:
- Fail-closed/error paths:
- Reachability/UI disposition:
- Forbidden fallback verified:
- Original-plan closure review:
- Deferred items promoted to Debt:
```

### Debt boundary

Do not write stage-local qualification failures into the historical Debt Ledger.
A current-stage test/fixture/review gap belongs in the current plan or PR; only a
stage that intentionally exits with an unresolved obligation gets a later owner
and a Debt Ledger entry. This avoids turning transient implementation work into
permanent architecture debt.

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
- Generated Client Remote namespaces may be prototype accessors. Preserve the
  original Remote object identity; NEVER use `{ ...remote }` or rebuild/copy the
  namespace object.
- Forwarded event methods read receiver-owned state. Pass method seats bound to
  the source object; NEVER detach `$on` (or equivalent) without preserving
  `this`.
- ONE runtime graph owns ONE semantic assembly. A qualification test must not
  create an extra semantic bundle beside the Backend assembly and then claim
  "one wiring".
- Base-owned Host services are reused, not remounted. Additive migration
  composition may require/check them but must not silently replace their
  namespace/projection ownership.

These four are correctness contracts, not implementation style preferences; the
per-invariant forbidden forms and the composition-ownership rules live in
`docs/client-server-coupling.md`.

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
  execution.** The trusted command runs on the Client machine's shell with a
  USER-layer-only trust gate. External attach is a different security case from
  an explicit user-entered `!`: the command text would arrive from Host-owned
  settings and could otherwise trigger Client execution. Remote attach therefore
  keeps command mode fail-closed until an explicit attached-Host trust model is
  designed; the native layout applies meanwhile.
- **The `/footer` configurator and the /settings footer rows are
  client-local UI over Host-owned settings** (the dsh-pi-tui settings
  document via the settings service).

## P1 capability ledger (v0.4.9)

P1 (`v0.4.9`) is the DSH `0.1.7-rc.2` **core user-facing capability
checkpoint**. The scope below is frozen with the first P1 PR: after it lands,
a scope change needs an explicit P1.x follow-up rather than quietly expanding
an in-flight PR. Locality classes:

| Class | Meaning |
|---|---|
| P1 required | stable official Host capability with a real TUI user story |
| already present | inherited behavior the TUI must preserve, not reimplement |
| experimental | upstream experimental surface; never a `0.4.9` blocker |
| P2 backlog | useful, deliberately post-`0.4.9` |
| M3-owned | only correct behind the official Host/Client transport |
| N/A | Web-only surface with no TUI user story |

| Capability | Class | Official DSH authority | P1 action |
|---|---|---|---|
| Official Plugin Manager | P1 required | `@deepseek-ai/dsh-plugin-manager` — the `pluginManager` Host service mounted by the dsh-base layer | ONE TUI-native Plugin Manager surface (port + Direct adapter + one controller/panel) |
| `/plugins` direct entry | P1 required | same | canonical sessionless entry (never creates/switches a Session) |
| `/settings → Plugins` entry | P1 required | same | lazy `SettingItem.submenu` row hosting the SAME panel/controller; opening `/settings` alone reads no plugin inventory and there is no second manager |
| Current TUI classification | P1 required | `SELF_BUNDLE = '@xmoon76/dsh-pi-tui'` | exactly one `Current TUI` card, always wins over extension observations |
| Current TUI self-protection | P1 required | local surface-safety policy ∩ Host capability | no bundle disable/remove and no self-row enable/disable; derived effective actions, never forged `readOnlyReason`/`removable`; enforced in the controller/action dispatcher as well as the UI |
| TUI Extension classification | P1 required where identity is provable | internal read-only projection over the shared `piTuiExtensions` runtime | presentation classification only; exact+unique owner association; ambiguous identity falls back to DSH Plugin; no name heuristics; no duplicate card |
| TUI extension API-tier label | not inferable generically | runtime evidence only | never infer Stable/Advanced/Unstable from the absence of advanced/unstable contributions; only report observed advanced/unstable use as a factual diagnostic |
| Installed bundle/plugin inspection | P1 required | same (`listBundles` / `listPlugins` / `registries` / `inspect`) | render Host facts exactly; never infer manageability |
| Bundle/plugin enable/disable | P1 required | same (`setBundleEnabled` / `setPluginEnabled`) | official mutation for ordinary manageable targets; current TUI excluded locally |
| Bundle remove | P1 required | same (`removeBundle`) | confirmed, exact-identity mutation, then refresh |
| Bundle install | P1 required | same (`installBundle`) | pre-inspect, confirm, official install |
| Registry selection/fallback visibility | P1 required | same (`registries()`) | show offered/fallback/resolved registries; never retry for the Host |
| Install progress/log/cancel | P1 required | same (`plugin-manager/install-state` / `install-log` events, `cancelInstall`) | request-correlated, bounded presentation log tail |
| Install request recovery | P1 required | same (`waitForInstall(requestId)`) | reconcile an indeterminate result; never auto-retry `installBundle()` |
| Compatibility refusal diagnostics | P1 required | same (inspect/change compatibility result) | show package/version/required range/current runtime/exemption state; no TUI semver guessing |
| Exact-version exemption mutation | advanced / non-blocking | same (`listVersionExemptions` / `setVersionExemption`) | diagnostics required; grant/revoke only if it stays a small official action |
| Job live observation | P1 required **if B0 proof is green** | `@deepseek-ai/dsh-api-job-controller` (`JobController.follow()`) over `@deepseek-ai/dsh-jobs` (`JobRegistry.readAt()`) | official non-consuming Host observer only; a TUI events+`readAt` loop is forbidden |
| Job gap/loss presentation | P1 required if live view ships | same official follow frames | represent loss honestly; never a full-transcript claim |
| Job human Stop | already present / preserve | existing Direct job stop path | do not redesign |
| Task Center roster/search/type/scope/tree | already present / preserve | `TaskReadPort` (status-only) + official subagent catalog | regression baseline |
| Workflow presentation | already present / converge only | existing Workflow projection | reuse; no new workflow reducer |
| Tool Preparing | already implemented | official assistant transient events | no P1 work |
| `AgentPresetRegistry.readDocument()` viewer | P2 backlog | `AgentPresetRegistry.readDocument()` | record only |
| Agent Team | experimental | `packages/experimental/*` `agentTeam` Session projection | no Team code in P1 |
| Web work-detail vocabulary | P2 backlog (UX reference) | dsh-web presentation | no Focus/Compact renaming |
| Remote ClientJobs transport/reconnect | M3-owned | `@deepseek-ai/dsh-api-job-controller/client` `ClientJobs.observe()` over the DSH Connection | do not implement — P1 has no Client Context/Connection/transport |
| Complete Web Plugin Manager UI parity | N/A | dsh-web React UI | TUI-native UX only |
| Creator-mode marketplace/discovery | N/A | — | do not implement |

Already-covered behavior this ledger must not reimplement: Task Center confirmed
Stop, Quick Tasks, the merged Agent/Job roster, Tool Preparing, the Workflow
transcript model, and the Direct production backend (unchanged).

M3 owns every transport-shaped piece: `ClientJobs` reference-counted observation
over the DSH Connection, Remote reconnect recovery, and a Remote production
backend. P1 must not build a temporary TUI RPC or a TUI-owned follow protocol to
unlock one UI; if a P1 capability cannot be correct on the Direct path it is
reclassified, not smuggled in.

### P1-A status — Plugin Manager

`/plugins` (and the lazy `/settings → Plugins  Manage…` submenu) is ONE surface
over one runner-owned controller: a narrow `PluginManagerPort`, the Direct
adapter (`src/runtime/direct/plugin-manager-direct.ts`, the only module that
resolves the official `pluginManager` service), a controller that owns operation
state, and a rendering-only panel. The inventory is classified into Current TUI
(exactly `@xmoon76/dsh-pi-tui`, self-protected by DERIVED effective actions —
never by forging `readOnlyReason`/`removable`), TUI Extensions (only after an
exact + unique live-owner association, proven through a package-private
owner→Loader-entry-id projection over the shared `piTuiExtensions` runtime; no
name heuristics, no duplicate card), and DSH Plugins (everything else). Both
ownership decisions use official identity, never a package/module name: a
bundle row's `entryId` decides visibility, and a `PluginInfo.patchId` equal to a
`rowId` the self bundle declares (or an id in its `overrides` — e.g. the base
rows `cordis.patch.yml` disables) decides the protection-only narrowing, so the
TUI bundle's own patch layer cannot be undone from its own screen while an
independent row that merely shares a module specifier stays manageable. All
mutations (enable/disable/remove/install) go through the official service; the
TUI never spawns pnpm, edits `package.json`/patch YAML, or invents final state —
every operation is followed by a fresh official inventory read. The Direct
adapter imports the official rc.2 types for precision (a devDependency pin);
because the repo's naming gate requires every `@deepseek-ai/*` import in `src/`
to be a declared peer, `@deepseek-ai/dsh-plugin-manager` also joins the peer list
at the unchanged `>=0.1.7-rc.2` floor (the DSH base already ships the package —
the same pattern as `dsh-jobs`). The extension observation reports only facts the
shared runtime actually tracks (advanced/unstable capability use is observed
from the tracked capability slots, so it under-reports rather than infers).

### P1-B status — selected Job live output

The TUI bundle mounts the official `job-controller` row
(`@deepseek-ai/dsh-api-job-controller`, the same row the rc.1 web bundle mounts;
the dsh-base layer does not). The Direct adapter
(`src/runtime/direct/job-observation-direct.ts`) consumes
`JobController.follow()`, the official NON-CONSUMING Host observer: upstream
`packages/api/job-controller/src/observe.ts` reads only
`JobRegistry.readAt()` and never `JobRegistry.read()`, so it neither advances the
model `job_output` cursor nor acknowledges a completion notice. The selected Job
detail renders status/progress plus a bounded retained-output tail, marks an
official `lossy`/`gapBefore` eviction honestly, and keeps the final snapshot
readable after settlement. The observer is owned by the viewer (one Job at a
time) and is aborted on close, session transition, and surface teardown;
`TaskReadPort` stays status-only. If the `jobController` service is absent, the
detail degrades to the previous status-only view with an explicit note instead
of failing.

## rc.2 release-capability dispositions (v0.4.9)

The `0.4.9` line adapts the already-completed P1 product to published DSH
`0.1.7-rc.2`. Every meaningful rc.2 release item has exactly one disposition:

| rc.2 item | Disposition | Action in this release |
|---|---|---|
| Preset chooser-policy removal (`modeSelectionEnabled`) | ADAPTED | the DTO/Direct/Remote/command policy layer is deleted; `/preset` is a normal command over the official registry |
| Model exact-availability admission + background default save | ADAPTED | the Direct Session write admits the current provider/model, commits, then returns while the official default save runs detached |
| Dynamic tool enablement in an already-live Session | ADAPTED | official `developer/message` tool updates are tolerated by the fold/projections, and the Agent-loop tool-registry change is proven against a real Session; Plugin Manager bundle/plugin-row toggles in an installed profile report the official rc.2 `restart-required` outcome (no silent hot-apply claim) |
| Interrupted Plugin Manager operation recovery | INHERITED + integration proof | the TUI still owns request-id start/wait/cancel only; rc.2 owns run/process recovery |
| Registry/mirror install improvements | INHERITED | existing install-source/registry presentation regressions |
| Long tool-output fix | INHERITED | long multibyte tool-result regression over the real fold/search/export path |
| Long-conversation send fix | INHERITED | long-session fold + next-prompt regression |
| Schedule | **DEFERRED** (post-0.4.9) | stable rc.2 Host capability, but its optional composition is not a TUI plugin-install target and the TUI must not insert optional Schedule rows into its own protected bundle |
| Time Context | **DEFERRED** (post-0.4.9) | official Time Context uses browser request-zone facts; the TUI has no equivalent user-timezone authority and must not promote the Host process timezone into one |
| Approval `displayReason` | INHERITED / additive | no rc.2 blocker; the current generic reason presentation stays |
| Auto Review | DEFERRED / experimental | upstream experimental surface, never a release blocker |
| Web/Desktop shortcuts manager | WEB-ONLY / N/A | the TUI keeps its own keybinding owner |
| Desktop onboarding / window+background lifecycle / updater | WEB-ONLY / N/A | none |
| Web archive filter chrome | WEB-ONLY presentation; Workspace archive/pin remains a separate TUI follow-up | not mixed into rc.2 |
| Standard prompt token reduction | INHERITED | preset/runtime parity only |

Schedule and Time Context are the two upstream capabilities that exist in rc.2
but are deliberately **not** activated here. Their future owner is a
post-`0.4.9` product/composition slice (possibly around M3, depending on the
locality design) that must decide optional-composition ownership, enable/disable
UX, the timezone source, task catalog/history UX, and Remote locality. The
historical capability-debt items (Session/conversation references in `@`
completion, continuable Subagent follow-up images and queue editing, Session
archive/unarchive/pin, subagent delegation settings UI, turn-level Changed
Files/Review, preset read-document viewer, compatibility-exemption mutation UI,
Agent Team, and the M3-owned Remote items) remain tracked, unchanged, and
visible — none is silently dropped or implemented by this release.

## Official seam mapping (DSH 0.1.2-alpha.4) — history, skills, errors, diagnostics

The M2/M3 Remote backend maps to the official seams below (first shipped in
the alpha.2 line and still current in alpha.4) — it must
not copy Direct Host implementation or invent parallel protocols. The Direct
backend already consumes the same seams in-process (the session-preset
adapter uses `sessionQuery.observeSession()` only for explicit preset/resume
paths, while picker enrichment uses live projections and
`sessionProjectionCache.cachedSnapshot` without cold observation), so the Remote
adapter's job is transport mapping, not reimplementation.

- **Session history** — `session.follow` / `session.page` are the Remote
  history authority. The client renders from the official Session client
  object; it never builds its own history RPC or transport cursor.
- **Existing-session skills** — the official skills Remote serves the
  catalog for an existing session. The Remote adapter must not copy
  `serviceFor` / `standingKeyFor` discovery. There is no Session-addressable
  carrier before a Session exists, so the sessionless staged-preset standing
  catalog is **INTENTIONAL_UNSUPPORTED_IN_M3** on the wire; Remote completion
  fails closed instead of running Direct `StagedPresetSkillCatalog` against
  Client-local preset/cwd facts.
- **Remote errors** — use the official `RemoteResult<T>` / `RemoteError.code`
  vocabulary. Do not define a `TuiRemoteError` / `SessionRemoteError` family,
  and never `instanceof RemoteError` across bundle boundaries (identity does
  not survive the wire; match on `code`).
- **Preset / plugin diagnostics** — use `agentPresets.compositionInventory()`
  instead of parsing `agent.cordis.yml` by hand. It is a diagnostic surface,
  never a substitute for a real Agent mount smoke.
- **Transcript window** — `transcript-window` is CLIENT render retention
  only. It owns none of: history authority, transport cursor, gap repair
  protocol, projection fold, durability, or reconnect generation.

## Official seam mapping (DSH 0.1.2-alpha.4) — deep history, images, connection

The M2/M3 Remote backend should additionally map to the official seams below
(most first shipped in the alpha.3/alpha.4 line). The Direct backend keeps
its current implementation; these are recorded as the official Remote
opportunities, not as Direct-mode changes.

### Session log access (0.1.6 deprecation)

`Session.events` was REMOVED as a public getter in alpha.4. DSH 0.1.6 then
DEPRECATED the synchronous history readers `session.eventAt(SessionSeq)`,
`session.snapshotEvents(from?, toExclusive?)` and `session.ownEvents()`:
existing production logic may remain unmigrated for now, but NEW production
calls, aliases and wrappers are prohibited.

- `session.seq` remains the count/offset fact that needs no history
  materialization.
- The Direct backend's existing reader calls (transcript reconstruction,
  cold hydration, Direct status/presentation folds, and the client-local rewind picker) are
  compatibility debt FROZEN by `scripts/check-no-session-events.mjs`: an explicit
  file + normalized call-site allowlist, so a call cannot move to another file
  or be swapped for another call site, and a removed call must drop its
  allowance. `ownEvents()` has no allowance — its first appearance fails.
- Projection/state consumers must not scan history; they read the projection (or
  the current event).
- Remote/client history uses the official Client observation seam plus explicit
  async paging; nothing in the TUI may regress to a live `events` array or a
  synchronous raw-log wrapper.
- A genuine full-history read (fork, canonical export) must later use the
  official async authoritative seam — never a new TUI-private history service.
  D2.4's fork authority is the official `session.fork` exact-cut contract (see
  the D2.4 note below), never the Direct raw snapshot helper.

### Subagent human prompt (alpha.4)

The interactive viewer's human prompt maps 1:1 onto the official
`subagent.prompt` remote. The runner resolves the viewer's Enter or accelerated
composer gesture against the CHILD's running state and `busyEnter` preference;
the port receives only the resulting `queue` or `steer` delivery:

```text
viewer Enter / accelerated
  ↓ runner resolves delivery (child running + busyEnter)
  ↓ SubagentPort.prompt (client-semantic DTO)
  ↓ Direct: ctx.subagents.prompt({ requestId, parentSessionId,
      childSessionId, mode: 'continuable', delivery, content, clientTimeZone? })
  ↓ child inbox — queue or steer, user provenance
```

`requestId` is caller-minted (one UUID per human submit, before the call);
failures classify through the official RemoteError vocabulary
(`subagent/parent-unavailable`, `subagent/not-resumable`,
`subagent/unauthorized`, `subagent/delivery-unavailable`,
`gateway/cancelled`, …). Agent/model-authored messages are a DIFFERENT
contract (`ctx.subagents.sendMessage` → Steer) and must never back the
viewer's editor.

### Deep-history navigation

For jumping to an old turn, the future Remote backend should use the official
pair:

```text
turnOutline projection
+
Session.loadThrough(seq)
```

Design relationship:

```text
Host
  turnOutline:
    turn
    seq
    prompt
    response
Client
  select old turn
    ↓
  lookup turnOutline seq
    ↓
  Session.loadThrough(seq)
    ↓
  official Session client loads required history
    ↓
  TUI transcript-window anchors presentation
```

`turnOutline` is the official whole-log turn index (`@deepseek-ai/dsh-session-turn-outline`):
each entry carries the `turn/start` seq as the load-through target, so a window
paged back through that seq contains the whole turn. `Session.loadThrough(seq)`
is the official jump loader: it pages backwards until the window covers the
requested seq, with a shared low-water target for retargeting callers and a
no-progress guard.

M3 applies the same pair to `/rewind`. The current Direct picker derives
candidates from a complete `Session.snapshotEvents()`; the Remote path must not
silently shrink that product behavior to the bounded opening window. Candidate
identity/order/preview comes from the whole-log `turnOutline` projection.
`loadThrough(seq)` is paid only when the selected/visible candidate needs event
detail. The operation pins the exact Session binding generation; a Session
switch, binding replacement, reconnect-invalidated generation, close, or caller
abort drops late candidate/detail work instead of repainting a newer picker.
Normal transcript startup still keeps its bounded window and never prefetches the
whole log just to support `/rewind`.

The normal pi-tui Host composition does not otherwise need this Web-owned
projection unit, so M3-1's dynamic `RemoteHostRuntime` mounts
`@deepseek-ai/dsh-session-turn-outline` beside `dsh-session-stats`; the ordinary
`cordis.patch.yml` remains unchanged.

`transcript-window` remains only Client presentation/window state. It owns
none of: history authority, paging cursor, reconnect, gap repair, or session
projection folding.

### Remote image submission and durable reads

The Remote Adapter submits images through the official `PromptContentPart[]`
path (the same upload-shaped vocabulary used by Session/subagent prompts):

```text
Client-local draft bytes
→ PromptContentPart { type: 'image', mediaType, data(base64), name? }
→ Session.prompt(...)
→ Host-side image/model admission
→ durable ImageAttachmentRef in the Session log
```

Ownership is deliberately split:

- `/image`, clipboard paste and image-file IO are Client-local staging. Before a
  Session exists, only the TUI's own bounded RAM/pre-read safety caps are
  available; the Client must not invent the Host deployment's image policy.
- Once the first Session is created/retained, the Client re-applies the exact
  Session's `imageLimits` projection before serialization when that projection
  is available. This is a UX/preflight check, not the authority.
- `session/prompt` remains authoritative. The Host serializes image admission
  with model selection, resolves the current model metadata, refuses
  `MODEL_DOES_NOT_SUPPORT_IMAGES` through `session/attachment-invalid`, calls
  `admitPromptContent`, and persists the durable image references. The Remote
  TUI therefore does **not** call Host `ctx.llm.resolveModelInfo()` or
  `ctx.attachments.saveImages()`.
- A durable image already referenced by Session history is read through the
  official authorized `session/attachment({ sessionId, attachmentId })` Remote.
  Main transcript reads use the main binding identity; a child viewer uses the
  child Session/binding. Late bytes are fenced by that exact binding generation.
- Recalling/re-sending an old image does not put a Host-private attachment ref
  into a new wire prompt. When bytes are required, the Client obtains them via
  `session/attachment` and submits ordinary image data again.

This image path is separate from D4 generic files. Generic Client-local
`/attach` content still needs the `fileUploads/upload` receipt transaction and
remains intentionally unsupported on the M3 wire. The presence of the
`fileUpload` composition dependency in M3-1 does not silently enable that UX.

Do not treat a Direct-mode generated DSH `UserMessage` as the future
cross-process protocol: the wire caller must never cite an attachment it did
not upload/read through an authorized public carrier.

### Client command execution ownership

The wire split keeps two command planes distinct:

```text
Host-owned command
  commands/list descriptor/claim
  → TUI Client decides the route
  → HostCommandPort
  → commands/execute

TUI built-in / TUI skill-wrapper / Extension command
  Client-local registration
  → Client-local handler/callback
  → semantic ports / ordinary prompt as needed
```

The current Direct runner registers TUI handlers in Host `ctx.commands` and uses
`ctx.commands.execute(...)` as a convenient normalizer. That is an in-process
implementation detail, not the M3 contract. M3-4 moves those callbacks into the
Client Context: no TUI/extension handler function is registered into or invoked
through Host `ctx.commands`, and no callback crosses the wire. Host command
descriptors still own Host claim/collision precedence, and an advertised Host
command still executes exactly once through `HostCommandPort`.

Skill wrappers follow the same rule, with one deliberate Direct→wire
convergence. Direct today re-gets the live skill body and formats the TUI-owned
`renderSkillInvocation`; rc.2 exposes no `skills/read` Remote, but it **does**
ship the official explicit-user `/name` gesture in `dsh-tool-skill`. Remote M3
therefore keeps the same advertised slash-command claim/trailing instructions,
validates against the current `skills/list`, and submits the literal `/name
[instructions]` as one ordinary user prompt. The Host pre-step performs the
authoritative current `ctx.skills.get` + `isUserInvocable` check and body
injection. The Direct private body renderer stays a compatibility implementation
and is never promoted into a Client/Host protocol.

### Tool-card presentation ownership

The Direct TUI currently asks the Host tool registry for a scoped
`ToolDefinition` and executes `presentCall` / `presentResult`. Those are callback
functions and cannot be a wire contract.

rc.2's Client tool UI establishes the migration direction: Client cards derive
from raw `tool/call` / `tool/result` event fields plus persisted structured
content/metadata; Host `presentCall` / `presentResult` values do not enter the
Client. M3-4 follows that ownership rule:

- known first-party TUI cards are derived Client-side from replay-deterministic
  event data;
- public TUI extension tool renderers stay in the Client Context;
- an unknown/custom tool keeps the bounded generic/raw card rather than causing
  a Host registry lookup;
- the Remote branch has no `ctx.tools.get(...)`, Agent-scoped tool-definition
  lookup, or presenter callback transport.

This is presentation only. It never authorizes Client-side tool execution; all
tool business execution remains Host-owned.

### Skill catalog invalidation under rc.2

`skills/list({ sessionId })` is a valid Remote read, but the Host
`skills/change` invalidation event is **not** in rc.2's forwarded Remote-event
allowlist. A Client `$on('skills/change')` is therefore not an available
carrier, and M3 must not create a private forwarding event just to preserve the
Direct hot-refresh callback.

M3 classifies `SkillCatalogCapability.onSkillsChange()` as intentionally
unsupported on the wire. The Client strongly re-reads the live skill catalog on
binding/session entry, explicit `/reload`, and `connection/reset`. A provider
filesystem/runtime mutation between those boundaries may temporarily leave
autocomplete stale; execution remains safe because the Remote branch never
injects a cached Client-side skill body and Host authority handles the actual
gesture. A future upstream forwarded capability can remove this limitation
without changing the semantic ownership.

For M3's in-process pi-tui Host, `hostLoadsSkillBody` is a composition fact:
M3-1 proves the generated supported presets mount `@deepseek-ai/dsh-tool-skill`.
It is not inferred from a hidden Host service. M5/external attach must fail
closed rather than reuse that local composition assumption when the remote Host
cannot prove the capability.


### Permission/access facts on the rc.2 wire

Permission **preset selection** and the two underlying knobs are not the same
wire fact. rc.2's public `permissions` Session projection contains only
`PermissionSelection.currentValue`; the Host projection's internal
sandbox/approval fold is not part of the public Client value.

Therefore M3 freezes the split:

- current permission preset: public `permissions.currentValue`;
- selectable/default presets: `permissionPresets/catalog` + settings;
- preset apply (including Shift+Tab cycle): the semantic
  `ConfigPort.permissions.applyPermissionPreset()` path, which executes the
  official Host permission command. The Client computes the next catalog entry,
  fences the async write by the exact Session/binding generation, and refreshes
  from authoritative projection state. The Remote branch never calls Host
  `permissionPresets.set(session, next)`;
- independent effective sandbox mode: no public rc.2 Client read — omit the
  structured Remote status fact, never infer it from a preset name;
- independent session approval override: no public rc.2 Client read, and
  `InteractionPort.setApprovalPolicy()` is a synchronous boolean contract with
  no exact public synchronous carrier. Remote M3 returns `undefined`/`false` as
  *unavailable* and hides/disables the session Approval-policy settings row.
  It must not turn an unavailable read into `?? 'ask'`, scan the whole Session
  log to reconstruct a private Host fold, or infer the knob from the current
  preset.

Approval/question interactive waterfalls remain fully separate and continue to
use the official forwarded events.

### Local `!` / `!!` shell under a wire backend

The user shell gesture is Client-local, but the current Direct implementation has
two execution branches:

```text
localShellSandbox=bypass
  -> Client/TUI spawn(command, cwd=session cwd)

localShellSandbox=sandbox
  -> Host ctx.shell.resolve/execute(...)
```

Only the first branch is placement-safe for M3→M4. The Host `ctx.shell`
capability is not a Client-local wire service and must not be borrowed merely
because M3 happens to run both Contexts in one process.

Remote M3 contract:

- bypass mode remains a Client-local spawn;
- context-mode `!` sends the completed text back through the semantic
  `SessionWriter`, while `!!` remains presentation-only;
- currentness/cancel uses exact Session/binding generation plus
  `SessionWriter.cancel(sessionId)`, never an exact Agent object;
- explicit `localShellSandbox=sandbox` is
  **INTENTIONAL_UNSUPPORTED_IN_M3**: show a visible error and execute nothing.
  In particular, do not keep the Direct behavior that warns and silently falls
  back to unsandboxed spawn when the requested sandbox capability is absent.

A future true Client-local sandbox can remove this limitation without changing
ownership.

### Legacy TUI settings migration stays on the Host side

The one-shot `migrateLegacySettings()` path reads the retired Host profile
`$DSH_HOME/settings.yaml(.imported)`, writes Host Settings forms and validates a
historical preset through the Host preset registry. It is profile-data migration,
not a Client preference import and not a Remote protocol.

M3 ordering is:

```text
Host profile/bootstrap
  -> migrateLegacySettings(...)
  -> Remote Host/Client composition readiness
  -> first Remote settings mirror describe/commit
  -> Session compose/resume
```

The existing no-marker-on-failure/retry semantics remain unchanged. A Remote
Client never opens its own `$DSH_HOME` or calls a local preset registry to
complete this migration. M3-1 owns the ordering barrier; M3-3B settings readiness
depends on it. This keeps M4's process split a placement change rather than a
second migration redesign.

### Connection lifecycle

M2/M3 must not implement their own:

- heartbeat failure policy,
- slow Host ready timeout,
- reconnect-on-slow policy.

These belong to the official DSH Connection. The alpha line already
improved it:

- heartbeat allows a short missed pong (a socket is terminated only after
  `MAX_MISSED_HEARTBEATS` consecutive misses, not on the first),
- a slow Host ready only warns (`[connection] generation is still not ready
  after …ms`) instead of immediately aborting the generation.

The TUI Remote Adapter must not stack a second transport watchdog on top of
the official Connection.

## D1.1 status — Remote Session read shadow

D1.1 is the first M2 slice. It is complete for the experimental read surface,
while the overall M2 remains in progress:

- `RemoteSessionReader` maps the official Session Controller Client list,
  projection, and search faces to the existing `SessionReader` port.
- A list is available only when the official Connection generation exists and
  the Client list snapshot is `ready`; a ready snapshot with empty `ids` is a
  valid empty list. The adapter uses official `ids` order, maps `updatedAt`,
  omits `createdAt`, and keeps `live: false` because `running` is not the
  Direct attached-session equivalent.
- Projection values come from the official list row first, then the bound
  Client Session projection face. Search delegates to `ctx.sessions.search()`;
  disabled capability is unavailable, cancellation remains abort-shaped, and
  business/transport failures are not converted to empty results.
- `measureContext()` is explicitly unavailable until an official equivalent
  exists.
- `RemoteSessionReadShadow` compares only bounded detached facts (IDs/order,
  activity, cwd/lineage/origin, projections, and search). It explicitly skips
  `createdAt`, the unresolved `live` badge, and `measureContext`. Every async
  completion and failure is fenced by both operation epoch and Connection
  generation identity; stale results are reported as `discarded`.
- `scripts/dsh-remote-session-read-smoke.mjs` assembles the pinned Source Mode
  Connection, API Gateway, generated Session Remotes, and Session Controller
  Client over the official fixture. It exercises list/projection/search,
  `SessionBinding` `loadThrough`/`loadOlder` history paging, Connection reconnect,
  contiguous-window recovery, and a write-endpoint spy. The package dependencies
  used by this harness are development-only.
- `scripts/dsh-remote-session-read-parity-smoke.mjs` assembles one real Host
  Context (Session Store, live registry, projections, SQLite query provider,
  Session Controller, Gateway, Connection, and official forwarded events) and
  an independent Client Context over the official in-process carrier. It
  compares Direct and Remote list/title/agentPreset projection/search results
  before and after Host-side title and preset-selection updates, with no
  synthetic ready frame or private envelope.
- `compat:dsh:client-family` runs the fixture and same-Host parity gates in an
  isolated npm install using the exact DSH version declared by `package.json`.
  Its `--client-smoke-only` lane runs the Remote Session read smokes AND the D2
  closure (`smoke:remote-d2-closure`), so the exact-family npm distribution is
  covered by the same Direct ↔ official Host fork/rewind parity gate as source
  mode; a source-only closure step would leave the npm lane unproven.
  CI runs this release-family job only in npm mode; Source Mode runs the same
  parity scripts against the pinned source distribution in the Source checks
  lane. A different npm release is a local-only probe via
  `pnpm compat:dsh:client-family -- --dsh-version <version>`; it is not an
  additional CI lane. The exact-family override fences released packages in
  the selected rc line while retaining older legacy dependencies where the
  official release graph still requires them.

Production remains Direct. No Remote Backend, Remote Session writer, UI
wiring, retry loop, raw persistence access, or duplicate event fold is
introduced by D1.1/D1.2.

## D1.2 status — pinned-master command/skill authority shadow

D1.2 is complete for the experimental live-session authority read shadow. The
`next` Source Mode pin is `ddefc45fbc7f8e46dd73185e68295696d1297887` (`0.1.6-alpha.2`).
The shadow uses the official Connection and generated Remotes only:

- `commands/list(sessionId)` and `skills/list({ sessionId }, signal)` are mapped
  into detached command/skill metadata.
- It is live-Session-only and diagnostic-only; it never discovers a standing
  catalog, creates an Agent, installs TUI state, executes a command, loads a
  skill body, or performs a write.
- A cheap Direct-side live-Agent predicate gates both reads; eligible Direct and
  Remote observations start concurrently in one compare epoch, without waiting
  for Direct skill discovery. This reduces observation skew, not a catalog
  transaction: official reads expose no shared atomic authority revision, so a
  mismatch during mutation is not by itself proof of adapter divergence.
- Direct remains the production authority. Remote failures are unavailable/error
  outcomes, never authoritative empty catalogs, and every completion/failure is
  fenced by operation and Connection-generation identity.
- `definitionId`, input hint/presence, and attachment declarations are retained;
  `modelInvocable` is retained; Host-local skill `path` is deliberately omitted.
  The report also derives bare/argument claim policy from input metadata without
  invoking commands.
- `scripts/dsh-remote-surface-authority-parity-smoke.mjs` proves same-Host parity
  using a real Agent scope and the official generated Remote transport.

## D1.3 status — Task and presentation read parity

D1.3 completes the D1 read-side discovery and proof milestone for generic
presentation transport and projection parity. Production remains Direct; the
Remote path is an experimental, read-only shadow and introduces no write,
lifecycle, child-control, custom-serve, or production-backend switch.

- `DirectTaskReader` reads the live Direct child catalog and jobs registry. It
  re-projects child activity from the live Agent registry at read time and maps
  only status/detail/timestamp job facts into detached Task snapshots.
- `RemoteTaskReader` consumes only the official Client Session projections
  (`projectionsBySession[parent].values.subagentCatalog` through
  `refreshProjections`) for child membership, the Session list facts for
  parent availability, and the official ClientJobs retained `watchRows`
  roster for status-only jobs. Projection loading/error states are never an
  authoritative empty membership (a ready empty catalog is); generation,
  operation, caller-cancellation, and disposal fences discard stale work.
- `RemoteTaskReadShadow` compares direct-child membership/order, kind, label, mode,
  activity, diagnostics, parent availability, jobs, and the existing
  `buildTaskRows` projection. It records the complete descendant tree as an
  explicit upstream gap instead of inferring it from direct-child data.
- `RemotePresentationReader` consumes only `SessionBinding.eventSource`, the
  outward `SessionFace` snapshot, and `SessionFace.loadOlder()`. It preserves the
  event-source order within the durable and transient planes,
  deep-detaches/freeze-protects payloads, and synthesizes at most one assistant
  start marker per live tuple. It never fabricates an assistant end marker.
  `deliverables/presented` remains a generic durable Session event; no
  deliverables-specific Remote contract is added.
- The official bounded Session history opening window is TURN-ALIGNED under
  the rc.1 Client: including a turn's closing assistant necessarily includes
  that turn's own leading durable facts (the 0.1.6-era message-aligned
  mid-turn cut is gone upstream). The Remote reader therefore starts from a
  complete leading turn and the former `presentation.leadingTurnCompleteness`
  capability gap is CLOSED; `loadOlder()` still extends the window without
  prefetching unbounded history.
- `DirectPresentationReader` uses the existing Direct Session event snapshot and
  assistant stream baseline; it does not introduce a second stream tracker or
  history reducer. `RemotePresentationReadShadow` compares the matching durable
  range and live inputs, then rebuilds fresh `TranscriptFolder`,
  `TranscriptWindowController`, and Focus projections by hydrating durable
  events first and replaying the current live baseline.
- `scripts/dsh-remote-task-read-parity-smoke.mjs` proves same-Host continuable
  and one-shot child catalog parity, job parity, and a child/job status mutation.
  `scripts/dsh-remote-presentation-parity-smoke.mjs` proves a real bounded
  Client event window (turn-aligned opening page with a complete leading
  turn), verifies `loadOlder()` paging with retained overlap, and proves
  eventual semantic transcript/window/Focus parity without an external
  provider.
- `scripts/dsh-remote-d1-closure-smoke.mjs` aggregates the existing Session and
  authority proof surfaces with the D1.3 Task and presentation proofs into one
  bounded read-capability result.

## D2.1 status — Direct-only write-contract convergence

D2.1 converges the semantic write boundaries while keeping Direct as the only
production backend. No Remote write side effect, `BackendKind='remote'`, or
production backend change is part of this slice.

- `SessionWriter` now exposes one ordinary prompt with an explicit `queue` or
  `steer` mode, one official occurrence-level `updateQueue` operation with
  `edit` / `remove` / `steer` actions, semantic `cancel`, outcome-bearing
  `rename`, and explicit unsupported title refresh. `PendingInputReader`
  exposes the Host-owned queue projection (`queued` / `steering` / `context`)
  and running state; Direct maps its inbox internally, while consumers never
  read `nextTurn` / `nextStep` or message `source`. The Direct mapping is
  `nextTurn → queued` and `nextStep → steering` only for user-origin messages,
  otherwise `context`.
  Ctrl+S is runner-level FIFO best-effort orchestration over
  `updateQueue({ kind: 'steer' })`: payload-bearing Ctrl+S sends only the
  draft; an empty-draft gesture requires a running subject, and on an idle
  subject with a parked steering occurrence it emits an explanation notice
  instead of silently no-opping (it never synthesizes a write). The
  main-surface Alt+Up gesture is a TUI-only recall-all extension over
  `updateQueue({ kind: 'remove' })` for queued occurrences, not an in-place
  `edit`; both gestures stop
  on the first genuine failure and never claim cross-occurrence atomicity. An
  empty accelerated submit in an interactive continuable child viewer applies
  the same queued-occurrence choreography to that child and never calls the
  ordinary child prompt API. Direct resolves the live Agent by session id and
  reports only confirmed synchronous calls as `committed`. Prompt admission
  exceptions settle as the official `session/agent-busy` rejection; Host command
  cancellation-shaped exceptions settle as `cancelled`, while other command
  execution exceptions settle as `indeterminate`. Rename maps title validation
  to `session/title-invalid` and other failures to `gateway/internal`, with
  Agent resolution taking precedence over service lookup. Edit validation
  follows the official text-only, non-whitespace rules before Agent lookup;
  malformed blocks from the structural Direct input are treated as non-text.
  Successful `remove` also retires a user `rpcId` file-upload binding.
  Failures after a queue mutation, including upload retirement, settle
  `indeterminate`, while
  cancellation before a confirmed removal remains `cancelled`. Queue
  presentation consumes only the semantic pending-input projection;
  source-specific notice classification is not part of the D2.1 contract.
- `HostCommandPort` owns execution of an already-authorized Host command only.
  The runner retains claim precedence and keeps TUI-local commands, extension
  commands, and skill-wrapper delivery out of this seam. Direct forwards the
  full selected line, submitted attachments, live Agent identity and caller-
  owned signal; the settled command result remains available to the existing
  result sink. `host-command` is now part of the capability vocabulary and
  Direct's implemented set.
- `SubagentPort.interrupt()` owns Task Center child interruption with explicit
  direct-parent, child and continuable-mode identity. Direct maps it to the
  official user-authority call. D2.2 extends this to a settlement: a known
  authority/business refusal is `rejected`, while an unidentified failure
  settles `indeterminate` (the child may already be stopped) instead of
  throwing through the owned-task failure path.
- `SubagentPort.prompt()` carries the resolved `queue` or `steer` delivery for
  a continuable viewer prompt. The runner applies the child running state and
  `busyEnter` policy; Direct forwards the official human prompt unchanged
  through `ctx.subagents.prompt`.
- `SessionLifecycle.open()` is the semantic name for opening an existing
  Session. The Direct adapter still calls `agents.resume()` internally. Its
  creation/open payload remains transitional: provider/model convergence is
  D2.3, and seed/fork metadata convergence is D2.4.
- D2.1 converges prompt verbs, delivery modes and settlement outcomes only.
  `SessionWriter.prompt()` still receives the Direct-prepared `UserMessage`
  payload; attachment admission and the official Remote `PromptContentPart[]`
  boundary remain later work. This payload is not described as Remote-ready.

The future Remote writer must map the semantic `updateQueue(sessionId, itemId,
action)` directly to the official per-occurrence `Session.updateQueue(itemId,
action)` contract. Ctrl+S remains client-side FIFO choreography over
`{ kind: 'steer' }` calls, matching the dsh-web queued-placement gesture; no
TUI-specific batch RPC is needed. The main-surface Alt+Up recall-all extension
uses `{ kind: 'remove' }` calls and is not presented as Web edit parity. A future
Remote `PendingInputReader` should normalize the official durable inbox
projection (`session.projections.faceOf('inbox')`) rather than expose transport
fields. Remote
title auto-regeneration remains unsupported until its official Client contract
is available.

### D2.1 follow-up — pending-input presentation parity

D2.1 converged the pending-input read vocabulary but left the TUI consuming only
`queued` for user-visible presentation: an accepted running steer had no durable
visible representation until its durable `user/message` (the long `job_output`
wait was the reported repro). The follow-up completes the presentation half
without putting `steering`/`context` back into the queue pane and without Direct
`source` leaking across the semantic port.

- `PendingInputItem` optionally exposes a plain `rpcId` (the official prompt
  `requestId` / Host message `source.rpcId`). Only the correlation string crosses
  the port; the `source` object never does.
- The presentation split is: queue pane consumes `queued`; the conversation tail
  consumes `steering`; `context` has no pending user surface. This mirrors the
  official Client (`QueueDock` vs `ChatView`).
- Ordinary Direct human prompts mint a request id before their first async
  preparation await and persist it on the Direct user-message source as `rpcId`.
  Injected context, Host commands and non-prompt workflows do not.
- A new Client-local ledger (`src/pending-submission.ts`, zero Host coupling)
  holds one echo per in-flight human submission, keyed by request id and
  insertion-ordered. It is presentation-only; the durable transcript stays the
  sole record. Same-text submissions stay distinct because their ids differ.
  A known ordinary prompt on an existing session installs its echo
  synchronously, before the submit FIFO turn and any admission await, so a
  later queued submission is never textually invisible behind a blocked earlier
  one. Skill invocations (`/skill <name> ...` and per-skill wrappers) are
  deliberately excluded: the TUI skill handler owns their delivery and prepares
  the message without the submit request identity, so an echo there could
  neither dedupe against nor retire on the authoritative occurrence. They keep
  their existing command feedback.
- The runner publishes one atomic `TuiApp.setPendingInputPresentation({ queued,
  steering, running })`: authoritative `queued` rows plus local queued echoes in
  the queue pane, authoritative `steering` rows plus local user echoes in the
  ephemeral conversation-tail lane. Local echoes carry attachment markers so an
  attachment-only submission is never an empty row.
- The handoff correlates by identity only: an authoritative occurrence exposing
  the same `rpcId` suppresses the local echo in the same presentation frame;
  the durable `user/message` retires it (painted into the message tree first,
  so no blank frame). Suppression is render-time, so an echo is re-presented
  when the Host claims its pending occurrence before the asynchronous pre-step
  emits the durable message. Never by text.
- A running placement's local echo settles the gesture's generic working-row
  label: the accepted content is visible and a running steer is never labeled
  merely `Queued…`. Idle (transcript) submissions keep the generic `Submitting…`
  bridge and render their echo at the conversation tail until the durable row
  lands.
- Local echoes are main-session only, matching the pinned official Web (which
  skips the browser echo for continuable subagents). The child viewer still
  gains authoritative steering presentation, scoped to the exact child, and
  never leaks parent rows.

Per-occurrence QueueDock controls (Edit/Remove/Steer) are deliberately NOT part
of the TUI product surface. D2.2 keeps the queue-action semantic fully aligned
for both adapters while exposing only the bulk gestures; see the D2.2
queue-action surface decision below.

### 2026-09-30 addendum — pending Context presentation closure

D2.1 and its follow-up originally mirrored the official Web pending-user
visibility: `queued` → QueueDock, `steering` → pending user bubble,
`context` → no pending row. The 2026-09-30 TUI presentation closure
intentionally extends the Client-local policy to render existing semantic
`placement === 'context'` occurrences in a NON-USER ephemeral conversation-tail
row (generic `context-generic` chrome, bounded preview, waiting status), so a
background job or subagent settlement parked in the Host's next-step inbox is
immediately observable before it materializes. This is a TUI UX extension over
the official Web, not a Host/semantic parity fix:

- No Host/wire/port authority changes: the Direct/Remote
  `PendingInputReader` semantics are unchanged, the raw `source` still never
  crosses the semantic port, and no new Remote capability (RPC or event
  forwarding) exists.
- The join keeps ONE ordered tail: `steering`/local-user rows and `context`
  occurrences interleave in the snapshot's projection order. Correlation
  stays identity-only — a `context` occurrence never correlates with a
  client-local echo, so same-text rows never merge.
- Presentation-only lifecycle: the row is ephemeral, non-durable,
  non-searchable, outside `TranscriptFolder`/Work/Context-cluster projection,
  and never steals the viewport. The Host claim removes it; the durable
  `user/message` Context returns through the normal transcript path. See
  `docs/surface-decisions.md` for the full surface policy.

### D2.1 follow-up — interrupted parked-steering recovery

The official Agent contract leaves a next-step steering occurrence PARKED in the
inbox when the active turn is interrupted or a proposed step does not continue:
a rejected step leaves steering parked until the next wake. That is not a lost
message and not an error to replay — the next ordinary prompt wakes the Agent
and the parked next-step input is consumed with that turn.

- Parked steering is derived from semantic state alone: the coherent
  `PendingInputReader` snapshot has `running === false` AND at least one
  `placement === 'steering'` occurrence. No Session history reader is consulted,
  and `placement` stays `steering` (there is no `parked` placement).
- TUI presentation derives the lane label from `placement + running`:
  `running=true` renders `steering…`, `running=false` renders
  `waiting for next turn…`. Only the presentation label changes; the semantic
  row, its id and its `rpcId` are untouched. The rule is subject-scoped, so a
  continuable child viewer shows its own parked row and never leaks parent rows.
- An empty Ctrl+S while parked steering exists emits exactly one info notice
  (`pending steering is waiting for the next turn — send a message to continue`)
  and performs NO write: no `prompt`, no `updateQueue`, no `agent.steer`, no
  synthetic wake. An ordinary idle empty Ctrl+S with no parked steering stays
  silent (no added noise).
- Alt+Up recall deliberately stays queued-only; recalling a parked steering
  occurrence is deferred. The official `updateQueue({ kind: 'remove' })` has no
  placement/running precondition for a next-step occurrence, so a
  transport-independent "remove only while parked" cannot be expressed through
  the semantic port: the experimental Remote writer performs an asynchronous
  RPC, and the occurrence can become active between the client's idle snapshot
  and the Host's removal. A future Host conditional mutation (an expected
  placement/status/revision, or a `removeIfStillParked` shape) is the right
  seam; the TUI does not add a Direct-only branch for this optional UX.
- Empty Ctrl+S never claims to resume steering. A true "continue parked
  steering without a new message" capability requires an upstream Session
  wake/resumePending verb; until it exists the TUI only explains the recovery
  and Alt+Up recall stays queued-only.

## D2.2 status — experimental Remote ordinary writes

D2.2 adds the first Remote write adapters against the official DSH Client /
generated Remote contracts. They are consumed by tests and a same-Host smoke
only: production remains Direct, `BackendKind='remote'` does not exist, and no
environment/CLI switch turns a complete Remote backend on.

Planning hierarchy (durable guidance): this stage's scope is decided by the D2.2
plan; business semantics and the user-visible state lifecycle come from the
official DSH Web/Client outward contract; the dsh-pi-tui semantic ports express
those semantics transport-neutrally; the Direct adapter maps them back to
today's in-process implementation; and the TUI presentation expresses the same
lifecycle with terminal-native UI/UX. "Direct used to do X" is not a reason to
make X a cross-backend semantic, and an RPC success is not by itself proof of
correct presentation.

- `RemoteSessionWriter` resolves an addressed Session through the official
  `ClientSessions.binding(id)` identity face — never `sessions.open()`, which
  would move the Client's current selection. Ordinary prompts use the official
  `beginSubmission` → identified `prompt` lifecycle: exactly one optimistic
  identity (the official `requestId`) owns one human submit. The serializer seam
  is two-phase, mirroring the official contract: a cheap `preflight` decides
  D2.2 support and extracts the echo BEFORE any Host mutation (an unsupported
  payload never creates an echo), then the echo is registered, then the
  potentially expensive `serialize` runs, and only a genuine pre-prompt
  serialize/preflight failure abandons the echo. A failure of the identified
  `prompt` call itself NEVER abandons the echo — the Host may already have
  committed, and the official Client retires an identified failure itself.
  `updateQueue` maps the occurrence-level `edit`/`remove`/`steer` official
  `QueueAction`; `cancel` preserves queued work; `rename` returns the official
  normalized title; `refreshTitle` is explicitly `unsupported` (no official
  Client verb — this remains a D5/upstream gap).
- Settlement classification preserves the official code discriminator: a domain
  code, `gateway/bad-request`, or one of the pinned Gateway's PRE-invocation
  infrastructure codes (`gateway/invocation-unavailable`,
  `gateway/service-unavailable`, `gateway/arguments-invalid`,
  `gateway/context-*`, `gateway/lookup-*`, ... — all raised while the Gateway
  resolves the descriptor/arguments/receiver before the business method runs) is
  a proven `rejected`; `gateway/cancelled` is `cancelled`; `gateway/internal`,
  `gateway/result-invalid` (raised AFTER the method returned), an unknown
  `gateway/*` code, or a code-less failure is `indeterminate` — never a proven
  rejection. No write is auto-retried. On the Remote path `cancelled` means a
  cancellation proven by the official call contract OR an operation a captured
  Connection generation proved was not dispatched; D2.2 does not claim
  caller-originated in-flight prompt abort (the semantic `prompt` port has no
  `AbortSignal` today, and the port is not widened for a caller that does not
  exist). The Remote adapters consume the generated Remote's `RemoteResult`
  error branch as the settlement source: carrier failures arrive there, so a
  rejection of the generated call itself is an assembly/programming defect and
  PROPAGATES rather than being disguised as `indeterminate`; only the explicit
  local pre-dispatch steps (preflight, echo registration, serialization, mention
  canonicalization, identity minting) are caught and mapped to a known refusal.
- `RemotePendingInputReader` maps the official durable inbox projection
  (`session.projections.faceOf('inbox')`, whose `next-turn`/`next-step` lists
  survive a reconnect or restart re-materialization) into
  `queued`/`steering`/`context` with occurrence id, optional plain `rpcId`,
  official order, detached/frozen content, and a Connection generation fence. It never reads Direct `nextTurn`/`nextStep` names and never
  derives placement from `running`.
- `RemoteSubmissionPresentation` is the Remote half of the client-local
  submission-presentation seam (`src/submission-presentation.ts`): production
  Direct wires the existing ledger, and the experimental Remote assembly
  (tests/smoke) reads the official `SessionSnapshot.pendingSubmissions`, so the
  Remote path never runs a second optimistic identity beside the official echo.
  D2.2 has no production Remote backend, so the runner intentionally has no
  source-injection point yet — the complete Remote backend assembly (M3) is what
  injects the Remote source in place of the Direct ledger. The presentation join
  (`src/pending-presentation.ts`) correlates by request/rpc identity only —
  never by text — and renders an official echo's structured attachments as
  stable markers, so an image-only echo is never a blank row.
- `RemoteHostCommandPort` uses the official generated
  `commands.execute(agentId, line, attachments, signal)` Remote (the
  attachment-preserving path, never `SessionFace.command(line)`), forwarding
  the full line, the opaque attachment payload and the caller-owned signal
  unchanged. Claim classification stays in the runner, and a slow/failed
  execution never falls back to a model prompt. Host-command settlement is
  operation-specific: a signal already aborted BEFORE dispatch is `cancelled`
  (the command never ran), but a cancellation-shaped failure AFTER dispatch is
  `indeterminate` — the pinned executor appends `command/run` before the handler
  and `command/done` after it, so an aborted handler may already have run (and
  side-effected). The Direct adapter follows the same rule.
- `RemoteSubagentPort` uses the official generated `subagents.prompt` and
  `subagents.interruptByParent` Remotes with the exact durable parent/child
  address and `continuable` mode. The continuation request identity is minted in
  the pre-dispatch phase. Preparation (service lookup, signal, `@`-mention
  canonicalization, identity minting) is separated from the dispatch call: a
  preparation failure is a known pre-dispatch refusal (`rejected`), never
  indeterminate, and the generated call is not wrapped in a defensive catch (a
  rejection is an assembly defect and propagates). The settlement is
  code-based: every PROVEN refusal code (a `subagent/*` admission refusal such
  as `parent-unavailable`, `not-resumable`, `not-found`, `catalog-diagnostic`,
  `unauthorized`, `delivery-unavailable`, `projections-unavailable`,
  `attachment-invalid`, `invalid-time-zone`, `gateway/bad-request`, or a
  pre-invocation Gateway infrastructure code) is `rejected`; only
  `gateway/internal`, `gateway/result-invalid`, an unknown `gateway/*` code, or
  a code-less throw settles `indeterminate`. The runner then never restores an
  indeterminate viewer draft
  as unsent and never reports a false "not stopped" — the child's authoritative
  state decides, with no automatic replay. A committed interrupt admission is
  likewise never presented as a durably stopped child.
- Ctrl+S already converges on official per-occurrence `updateQueue({kind:'steer'})`
  choreography from D2.1 (`src/steer.ts`): FIFO best-effort, partial progress is
  real, no fake rollback, and the authoritative snapshot reconciles the
  remaining rows. The Remote adapter plugs into that same orchestration.

Validation for this stage: per-adapter unit contract tests (the Remote
writer, host-command, subagent-port, and pending-input reader suites) and
the submission-presentation and pending-input mapping tests. The 0.1.6-era
same-Host `smoke:remote-d2-write` integration smoke was retired with that
replacement coverage; the D2 closure smoke keeps proving lifecycle and
fork/rewind parity through the current d2.4 child, and D1 closure and the
boundary gate stay green. `packages/pi-tui/**` and the DSH source pin are
unchanged.

> Frozen-plan note: the maintainer froze `temp/m2/` plan documents. The D2.2
> plan's §29 ("serialize all prerequisites that may fail before admission ->
> begin official local submission -> call prompt") still describes the
> single-phase ordering; the implemented and reviewed contract is the two-phase
> `preflight -> beginSubmission -> serialize -> prompt` described above and in
> plan §19. The residue is recorded here for the owner; the frozen plan itself
> is not edited.

### D2.2 serialization / D4 boundary matrix

`PreparedMessage = unknown` and the current Direct `UserMessage` payload are a
migration input, never a future Remote protocol. The serializer seam extracts
only official semantic content and refuses anything that would require a new
Host-locality transaction:

| Current prepared content | D2.2 Remote | Owner |
|---|---|---|
| Plain text | supported | `RemotePromptSerializer` |
| Image input already representable as official prompt image data | supported (no new Host-locality/upload transaction) | `RemotePromptSerializer` |
| Already-durable reference the current pipeline already possesses without D4 work | supported | existing preparation |
| Client-local generic file/path needing `uploadFile` + receipt | **`unsupported` before `beginSubmission()` / Host mutation; draft preserved** | D4 |
| Direct private object shape with no official semantic | not a wire contract; the serializer maps only official content | migration seam |

### D2.2 queue-action surface — intentional product decision

QueueAction parity is a BACKEND semantic requirement: `SessionWriter.updateQueue`
exposes `edit` / `remove` / `steer`, both the Direct and Remote adapters map them
1:1 to the official occurrence mutation, and the adapter unit tests plus the
same-Host smoke cover all three (exact item id, exact content, committed /
business-reject / indeterminate, generation-before-dispatch vs
generation-after-dispatch).

The TUI intentionally does NOT expose a per-occurrence queue action UI. Its
product surface is:

```text
Alt+Up = recall all  -> per-occurrence remove + draft recall
Ctrl+S = steer all   -> per-occurrence FIFO steer
```

There is deliberately no row selection, single-row edit/remove/steer, row action
button/keybinding, per-row busy state, edit overlay, selection clamp, or
edit-target-disappearance lifecycle. The migration preserves DSH semantic
capabilities and expresses them with a TUI-native interaction surface; it is not
a React/Web affordance clone. Adapter-level `edit` support without an edit UI is
therefore expected and is not a D2.2 gap, and there is no follow-up that lands
later — this is the product decision.

### D2.2 Host command resource admission

Host-command unsupported resource admission is owned by submission preparation,
not `HostCommandPort` settlement. `HostCommandPort` receives an already-prepared
opaque official attachment representation and is a pure forwarder; it does not
decide whether a payload is a local file or a Remote receipt. The runner's
attachment preparation (`attachmentRefusal`) fails closed before dispatch — a
declared Host command refuses a file attachment with no receipt seam, so the
port is never invoked and the draft is preserved
(`test/submit-hot-path.test.ts`, "still refuses a FILE (no receipt seam)").
`HostCommandOutcome` is therefore deliberately not widened with an
`unsupported` branch.

## D2.3 status (COMPLETE) — experimental Remote model / preset / create-open lifecycle

D2.3 converges Session-local model selection, blank-Session preset selection,
ordinary fresh create and ordinary open onto the official DSH Host/Client
contracts. Production remains Direct; the Remote adapters are consumed by
tests only (the 0.1.6-era same-Host `smoke:remote-d2-lifecycle` smoke was
retired after its semantic scenarios gained adapter-level replacement
coverage — see the coverage note below). There
is still no
`BackendKind='remote'`, no CLI/environment switch, and no production Remote
Session mount.

Coverage note: the retired D2.3 same-Host harness also exercised real Client
Context → Gateway → Host Session Controller integration for create/open,
model selection, and preset selection. Those semantics remain covered by
adapter contract/unit tests (`remote-session-lifecycle`, `remote-model-port`,
`remote-preset-port`), and the same-Host integration lane for
create/open/model/preset is now restored by the focused
`smoke:remote-session-lifecycle-parity` (Pre-M3, see the Pre-M3 status section).

- `ModelCatalog` gained one semantic directory read, `loadDirectory()`, matching
  the official `session.modelCatalog()` generation snapshot (deployment
  default, routable providers, grouped models, isolated provider failures).
  `listProviders()`/`listModels()` remain a separately scoped provider-discovery
  capability used by the subagent allowlist picker, not the `/model` directory:
  Direct serves it from the in-process registry, while the experimental Remote
  adapter reports it UNAVAILABLE (no official provider-discovery Remote in
  D2.3) rather than faking it from the model-directory cache.
- `ModelCatalog.selectSessionModel()` now settles through the shared
  `WriteOutcome` vocabulary with operation-specific semantics: the Direct
  adapter resolves the request through the Host-owned `llm.resolveCallConfig`
  (provider/model validation + reasoning-effort normalization) and commits the
  NORMALIZED result; an unavailable model/effort is refused before any durable
  append. The Host owns the durable Session-local commit and the best-effort
  global-default save; a failed global-default save no longer rejects a
  committed Session selection — it is a diagnostic only, exactly like the
  pinned official `session.selectModel`. The live write runs inside the runner's
  writer barrier, so a transition that started first refuses it (a proven
  pre-dispatch `cancelled`, keeping the picker usable) and a transition that
  starts after waits for it. `saveDefaultSelection()` settles as
  `WriteOutcome` too (`rejected` for a proven pre-write refusal, `indeterminate`
  for an ambiguous settings write, `unsupported` on Remote), and the run-local
  sessionless default-intent ancestry lives in the pure `DefaultIntentTracker`
  the runner and its tests share.
- `RemoteModelCatalog` maps the directory read to `session.modelCatalog`, the
  Session write to `session.selectModel`, and the display authority to the
  Session binding's `modelSelection` projection under a Connection-generation
  fence (before and after dispatch). It performs no second global-default
  write and no custom reasoning normalization, its synchronous cached default
  is invalidated by a reconnect, and its refusal table is an EXACT allowlist —
  an unknown `session/model-*` code stays `indeterminate`, never a blind
  rejection.
- `PresetCatalog` gained `roster()` (path-free rows + Host-effective default,
  matching the rc.2 `agentPresets.list`) and
  `selectSessionPreset(sessionId, presetId)` (`OperationResult<{preset}>`). Both
  adapters map the blank-Session WRITE to the official blank check + recompose
  transaction + durable `agent-preset/selected` commit; the TUI owns neither
  the blank reducer nor the recompose. The runner's previous
  `recomposeBlank()` business path is retired. A FRESH create does NOT use this
  write: Direct composes/mounts the preset as creation-time setup, and the
  Remote fresh `/new` carries the preset ATOMICALLY in the generated
  `session.create({ agentPreset })`. `agentPresets.select` is only the
  blank-Session SWITCH of an already-created Session.
- `SessionLifecycle` converged: `CreateSessionRequest` no longer carries the
  ordinary `provider`/`model` semantic inputs and `OpenSessionRequest` is
  `{ sessionId, signal? }` (no `resumeSessionId`, provider/model or preset
  knobs). The Direct adapter resolves the Host global default for activation
  and the persisted recorded preset for an open; the `create`/`open` port
  surface stays the official Client concept. A fresh create quiesces ALL
  in-flight sessionless `/model` global-default writes and their fenced
  corrections before dispatch, so it consumes the settled Host default instead
  of racing any of them; that wait is abort-aware, so a hung Host save can never
  block first creation past shutdown.
- `RemoteSessionLifecycle` uses official `ClientSessions.create()` for the
  ordinary create (reconciled list row, then an explicit `retain`), the
  generated `session.create({sessionId, cwd, agentPreset})` + public
  `refresh()` reconciliation + `retain` for a guaranteed-fresh explicit-preset
  create (never create-then-select), and
  `ClientSessions.retain()` for open (no Host resume RPC is invented, and no
  Client-global selection slot is moved).
  `create`/`open` return a first-class two-axis result (ownership + lifecycle
  settlement, distinct from each other): a reconnect during a Host success is
  `created + superseded`, and during a Host refusal is `rejected + superseded` —
  the settlement is never downgraded to `indeterminate`. The Host-returned
  session identity (not the requested one) is authoritative; fork uses the
  official `ClientSessions.fork()` exactly once, and a post-publication create error
  is `published-with-error` carrying the published identity, and no same-id
  retry happens. The generated-create reconciliation reconciles the Client LIST
  row only, and the Client generation is then acquired by an explicit `retain`;
  it deliberately does NOT fabricate a
  `projectionValues` hint, because `SessionProjectionHints.asOfSeq` is a durable
  Host sequence the TUI does not own — the preset projection stays authoritative
  from the Host control stream/binding (plan §9.3 requires Client visibility +
  binding, not a synthesized projection). `open` is Client-LOCAL selection: it
  requires a valid current Client generation, acquires the Session with an
  explicit `retain` (an unknown identity fails closed as `unavailable`), releases
  the new reference when a synchronous subscriber supersedes the navigation, and
  never dispatches a Host mutation or an invented resume RPC
  (v2 §0.5/§0.7.4).
- Presentation closure: the `/model` picker enters a `Selecting…` state and
  dismisses only after the semantic write settles — a rejected/cancelled write
  walks back to the model list so the picker stays usable, a duplicate apply is
  never a second commit, and an indeterminate settle dismisses without retry.
  The footer model label shows the in-flight selection as `(selecting…)` while
  keeping the authoritative current value; a rejected settle keeps the prior
  current and shows the Host refusal; a late settle from a replaced Session
  generation cannot repaint the new Session and makes no close/open decision.
  `/model` and `/preset` capture their semantic SUBJECT once — the Session
  GENERATION plus the EXACT session identity (including `undefined` for a
  sessionless surface) — and re-fence it after every await and before any UI
  mutation, so a same-generation Session-identity drift is `superseded` too,
  not only a generation bump; the typed `/preset <id>` path binds the subject it
  started with, never whatever Session exists when an await returns. A
  live Session model write is NOT a sessionless global-default intent (the
  tracker is sessionless-only). A sessionless default write that settles
  `indeterminate` keeps an explicit `(unconfirmed)` footer marker until an
  authoritative Host read reconciles it (the persisted default either carries
  the choice — committed — or proves it did not land), and a failed intent is
  never seeded into a create. `/preset`
  reads blankness from the
  official turn-boundary projection (never the TUI transcript), revalidates the
  Session identity/generation inside the transition gate, and maps
  `agent-preset/locked` to the started-session wording. `/new` keeps the old
  surface until the create commits.

Validation for this stage: per-adapter contract tests for the Remote model,
preset and lifecycle adapters; the D2.3 Direct contract/outcome tests; and
headless model/preset/create/open presentation tests. The 0.1.6-era
same-Host `smoke:remote-d2-lifecycle` integration smoke was retired after
its semantic scenarios gained adapter-level replacement coverage; its
create/open/model/preset same-Host integration layer is restored by the
focused `smoke:remote-session-lifecycle-parity` (Pre-M3, see the Pre-M3
status section). The boundary gate stays green
and `packages/pi-tui/**` is unchanged.

## D2.4 status (COMPLETE) — Host-owned fork / rewind convergence

D2.4 moves `/fork` and `/rewind` to the semantic Host fork operation. The
request carries only the source Session id and an optional exact event cut
(`atSeq`; see the alpha.2 fork exact-cut convergence section below); Host owns
the cut, child identity, inherited prefix, lineage,
workspace attachment, source preset and activation default. Direct reproduces
that algorithm inside its lifecycle adapter and retains a real unselected
`AgentHandle` in the runner's park/claim pool. Remote calls
`ClientSessions.fork()` exactly once and distinguishes rejection,
published-with-error, indeterminate and superseded settlements without retry.

Fork publication and local navigation are separate: dispatch does not wait for
source idle or hold the destructive transition FIFO. A current child is adopted
through a short gated handoff; a child superseded by newer navigation remains
published and can later be opened without a second Direct writer. Rewind rows
use predecessor `turn/end` cuts, so the first human turn is intentionally not
offered. Production remains Direct; M8 still owns eventual Direct ownership
retirement.

**Production workspace parity.** Workspace inheritance is not an adapter-only
algorithm: the bundle mounts the official `@deepseek-ai/dsh-workspace` row
(`ctx.workspaceRegistry`) and the `tui-app` row injects it, so Cordis finishes
the registry's one-time history bootstrap before the surface can fork. Direct
fork then applies the official rule — the source's directly owning workspace, or
the nearest ancestor workspace of a subagent source — and attaches the published
child; a failed attach settles as `published-with-error` carrying the
authoritative child id. Activating this row runs the upstream one-time bootstrap
that groups stored Session headers by canonical cwd into durable workspace
records; that migration is DSH-owned (see `docs/client-server-coupling.md`).
Ordinary create stays cwd-only, exactly like official `session.create` without a
`workspaceId`; the TUI does not invent workspace membership for it.

**Command settlement durability.** `/fork` is a registered DSH command, and the
official executor appends `command/done` to the SOURCE session only after the
handler settles. Direct therefore commits the visible child inside the handler
but QUEUES the source owner's retirement, flushing it at an explicit
post-command-settlement seam. That seam WAITS for the retirement: the command
workflow reports completion — and the source owner releases its write lease —
only after `command/done` has landed AND the old owner is disposed. Every
NON-command path (the rewind picker's owned task) awaits the same retirement
inside the handoff. `/fork` additionally pins the source for the WHOLE
operation, from admission before the child exists: while that pin is held (and
the retirement is still running), opening or resuming the source waits for the
release instead of resuming a live, lease-held handle (`DirectOwnerPoolLike.
waitForRelease`). So there is exactly one handoff completion point, and an
immediate reopen after it is safe. If a retirement phase is CONTAINED as a
failure (notably `disposeOwner`), the pin still releases and the reopen fails
loudly on the official exclusive write claim rather than hanging behind a pin
that could never settle; the failed phase is already diag-logged by the
retirement helper, and a leaked handle remains its own bug. Retiring the source
inside the command handler would instead detach the Session first, and a
detached `Session.append` never reaches the persistence writer, so the durable
log would keep `command/run` without its `command/done`.

**Settlement taxonomy.** `session/fork-unavailable` means only "no legal fork
boundary" — no completed prefix for an omitted cut, or an explicit `atSeq` that
names no canonical event. A missing source is `session/not-found`, a
malformed cut is `gateway/bad-request`, and composition/activation/internal
failures are `gateway/internal` (the official taxonomy has no
`session/fork-failed`). On the Remote side, a disconnected client is a
client-local pre-dispatch `unavailable`, never a fabricated Host refusal, and the
impossible `session/fork-not-addressable` outcome is gone: a resolved official
`ClientSessions.fork()` already guarantees the child is addressable.

Validation for this stage: Direct/Remote lifecycle contract tests, pure rewind
candidate tests, runner busy-admission/supersession/park-claim tests, the
`command/run`/`command/done` pairing regression, the source-release/reopen
regressions (adapter `waitForRelease` contract + rewind-picker awaited
retirement), the `smoke:remote-d2-closure` aggregate, and the
`smoke:remote-d2-fork` same-Host Direct-vs-official-Host comparison. The smoke
was rebuilt for DSH `0.1.7-alpha.2` as a self-contained harness (see the fork
exact-cut convergence section below); it covers, as real Direct/Host pairs on
one Host and one real `workspaceRegistry`: an exact mid-turn cut with official
fork repair, an exact `turn/end` cut, nonexistent-seq refusal, omitted-cut
standalone-tail inclusion, queued-input exclusion proven through continuation,
subagent nearest-ancestor workspace inheritance with `origin`/`delegationDepth`
not copied, and activation through the Host default. The client-boundary gate
stays green and `packages/pi-tui/**` is unchanged.

**DSH 0.1.6 compatibility note.** D2.4 was validated against the then-current
DSH `0.1.6-alpha.1` family in npm mode, with Source Mode pinned to
`0a15e36e7f82b6ed45af6fa9759f29b40dcd965d`. The current line has since moved to
the published `0.1.6-alpha.2` family (see the alpha.2 Client lifetime
adaptation section below). This compatibility
stage now converges Host-owned fork on the Semantic Port. Direct keeps the
official mapping private; Remote calls `ClientSessions.fork()` and neither
adapter exposes a seed or child identity. 0.1.6 states
the official fork cut more precisely — a selected completed turn's seed ends at
and includes that `turn/end`, and queued input, title and model settings after
it do not enter the child seed — and D2.4 takes the official `session.fork` contract as its authority rather
than serializing TUI raw seed payloads into a Remote contract. Plugin-owned durable events such as `image/offload`
inherit by the official cut/prefix; the TUI keeps no event-type inheritance
whitelist. This note records the completed D2.4 convergence.

## DSH 0.1.6-alpha.2 Client lifetime adaptation (D2 COMPLETE)

DSH 0.1.6-alpha.2 changes Client Session lifetime to explicit `SessionReference`
ownership. D2 semantics remain complete; this adaptation changes only the Client
adapter/lifetime mapping and adds no migration milestone (no D2.5).

- `retain()` owns one exact Client generation and starts its initial history
  open; `SessionReference` is the ownership token. `binding()` is borrow-only and
  no longer an acquisition API, and `create()`/`fork()` publish a catalogued
  identity without guaranteeing a binding.
- The TUI declares its own reference sources (`tuiMainView` for the visible main
  surface, `tuiOperation` for one bounded operation pinning an existing
  generation) through the official `SessionReferenceSourceMap`, so it never
  impersonates the official Web view.
- Navigation must commit the new owner before the initial history open settles:
  `retain new -> install new owner -> release old`. `ready` is awaited only by an
  operation that genuinely must wait for that open (never by create/open). The
  adapter now RETURNS the retained owner this handoff needs; the caller-side
  `retain new -> commit -> release old` wiring remains deferred to Remote
  production composition / M3, so read this as the handoff contract, not as
  runner behavior.
- Host publication != Client view retention. `fork()` stays publication-only, so
  a superseded fork leaves a real, catalogued child that the TUI must not select;
  adoption happens on the navigation path through `open()`, which is what
  acquires the Client reference.
- Session identity is not a lifetime: the same `sessionId` retained after a full
  release is a NEW binding generation on the SAME connection. Every long async
  operation (writer, paging, model selection) therefore fences the exact binding
  generation, not merely its presence.
- Pending durable input is read from the official durable inbox projection
  (`session.projections.faceOf('inbox')`); the alpha.1 `SessionSnapshot.queue`
  no longer exists.
- `session/writer-held` (details `{ sessionId }`) is a proven pre-commit refusal:
  it settles `rejected` with actionable holder-recovery guidance, preserved
  details, a preserved draft, and no retry, takeover, or forced resume.
- The version identity of this line is `0.4.8`. The published
  `0.4.7-alpha.1` keeps its own alpha.1 contract: an `dsh-v0.1.6-alpha.1`
  runtime still pairs with that bundle, and it stays the startup notice's
  fallback for that runtime.

### Deferred to Remote production composition (M3)

Two plan items describe caller-side behavior the alpha.2 adaptation cannot reach
while Remote stays non-composed. They are **adapter-ready, not wired**, and M3
owns them — do not read this adaptation as having implemented them:

| Plan item | Adapter state (this PR) | Deferred owner |
|---|---|---|
| D3/D4 Remote fork adoption and owner handoff | `fork()` is publication-only and `open()`/`retain()` is the retain-capable adoption seam; `SessionHandle.client` carries the exact-generation owner with `clientOwnerOf()`. The Direct runner consumes only `direct`, so no `liveClientOwner` install, no `retain new -> commit -> release old`, and no old-reference release exists yet. | M3 caller/runtime composition (`adoptFork`, `transitionTo`) |
| writer-held TUI recovery | The writer settles a KNOWN `rejected` with preserved details and no retry, which is what a caller needs to restore a draft. The TUI draft restore, model-picker rollback, and queue-row preservation for a Remote caller are not observable without that caller. | M3 caller/UI wiring |

Everything else in the alpha2 scope is implemented on the adapter side and
covered by the unit/contract tests plus the same-Host smokes.

The D1 closure ledger is:

| Read surface | Direct source | Official Client source | D1 result | Future owner |
|---|---|---|---|---|
| Session list | Direct SessionReader | `ClientSessions.list` | parity | — |
| projections | DSH projections | Client projection store | parity | — |
| search | sessionQuery | `ClientSessions.search` | parity | — |
| commands | `ctx.commands` | commands Remote | parity | — |
| skills | scoped skill registry | skills Remote | parity | — |
| direct-child subagents | Host subagent runtime | Client Session projections (`projectionsBySession` / `subagentCatalog` via `refreshProjections`; the 0.1.6-era `refreshSubagents` / `subagentsByParent` mirror is retired) | parity | — |
| jobs | `ctx.jobs` (SessionId ownership) | official ClientJobs retained `watchRows` roster (the 0.1.6-era `jobsBySession` mirror is retired) | parity | — |
| history window | Direct Session events | `SessionBinding.eventSource` | parity | — |
| history paging | Direct full history | `SessionFace.loadOlder()` + eventSource | eventual parity; leading-turn completeness CLOSED by the rc.1 turn-aligned opening windows | — |
| live Assistant presentation | Direct stream | transient event-source entries | parity | — |
| full descendant tree | `listDescendants` | no exact official equivalent | skipped | D5/upstream |
| `createdAt` | Direct query | no Client list field | skipped | later only if required |
| Direct `live` bit | attached-store fact | different Client running semantic | skipped | reconsider on flip |
| context pressure | token meter | no Client equivalent | skipped | later Host seam if retained |

The D1 skips are `session.createdAt`, `session.live`,
`session.measureContext`, and `subagent.descendantTree`; each is explicit in
the D1 closure ledger and smoke. `presentation.leadingTurnCompleteness` CLOSED
with the rc.1 turn-aligned opening windows: the pagination smoke now asserts
a complete leading turn directly, so the skip is no longer carried. The
Remote reader still does not guess or prefetch full history.

## DSH 0.1.7-alpha.2 fork exact-cut convergence (B3)

DSH `0.1.7-alpha.2` changed the fork boundary contract; the Direct adapter
converged to it and the semantic port stayed `{ sourceSessionId, atSeq? }`
unchanged. The retired 0.1.6-era behavior (an explicit `atSeq` was advanced to
the next closing `turn/end`, and an out-of-range anchor fell back to the latest
completed turn) is gone on purpose:

- **Explicit `atSeq` is an EXACT inclusive event cut.** Any existing canonical
  event seq is legal — mid-turn, mid-step, before a tool result. Direct proves
  the canonical event exactly like the official controller
  (`source.events[boundary]?.seq === boundary`); it never floors, ceils, or
  falls back. A nonexistent seq rejects as `session/fork-unavailable` ("event
  N does not exist in session ...").
- **Omitted `atSeq` selects the latest completed prefix** — the latest
  `turn/end` plus standalone stable events (e.g. `session/title`) until the
  next `turn/start`, appended `user/message`, or `agent/inbox/spliced`
  boundary. The private Host mapping (`latestCompletedPrefixBoundary`, a
  faithful copy of the official selector) lives beside the Direct fork
  adapter; it is Host semantics, not picker semantics.
- **Seed construction is the official `buildForkSeed()`** from
  `@deepseek-ai/dsh-session/fork`: the inherited prefix `[0..boundary]`, the
  child-owned `session/end-seed { inherited: true }` marker at
  `seq = inheritedEventCount`, and synthetic fork closers (error tool results,
  `step/end`, `turn/end { reason: 'forked' }`) for an open tail. The TUI
  duplicates none of that repair vocabulary. `inheritedEventCount` stays
  exactly `boundary + 1` even when `seed.length` exceeds it.
- **The `@deepseek-ai/dsh-session` peer floor rose to `>=0.1.7-alpha.2`**
  because the `/fork` public subpath first exists there; the published
  `0.4.7-alpha.2` line remains the runtime fallback for a `0.1.6-alpha.2`
  Host (see `docs/dsh-compatibility.md`).
- **`/rewind` is unchanged**: it still sends predecessor `turn/end` sequences
  as `atSeq` — a client UX policy that remains legal now that `fork()` is a
  general exact-cut Host semantic.
- Remote stays the reference Host path: one `ClientSessions.fork()` call,
  `atSeq` forwarded byte-for-byte, no local seed, no normalization, no retry.

Validation: `test/direct-session-fork.test.ts` (exact cuts, official repair
shapes, omitted-boundary rules, observation disposal on every path), the Remote
lifecycle contract tests, and the rebuilt self-contained
`smoke:remote-d2-fork` alpha.2 harness (P1 exact mid-turn repair, P2 exact
turn/end, P3 nonexistent-seq refusal, P4 standalone-tail inclusion, P5
queued-input exclusion proven through child continuation, P6 lineage,
P7 subagent ancestor workspace, P8 activation default). The old D2.3-importing
harness was retired with the 0.1.6-era `dsh-agent-presets` package it named.

## Pre-M3 status (COMPLETE, no behavior change)

Pre-M3 pinned the semantic/backend/client boundaries M3 depends on. It is a
structural closure, deliberately NOT M3 and NOT the TypeScript architecture
refactor: production stays Direct, there is no backend flag, no Remote attach,
no UI/UX change, and no public Extension SDK change.

- **Direct backend assembly centralized.** `src/runtime/direct/backend-direct.ts`
  is the single owner that constructs the Direct semantic adapters from the
  runner-supplied resolvers; `src/index.ts` no longer constructs them one by
  one. The backend vocabulary gained `job-observation`, and the production Job
  viewer reads `backend.jobObservation` — the Direct adapter is no longer a
  runner-local side channel that bypasses `Backend`. The M2 shadow reads
  (`TaskReader`, `PresentationReader`, `SurfaceAuthorityReader`) deliberately
  stay OUT of `Backend`, and the model-selection owner plus the Direct
  assistant-stream install stay runner-owned.
- **P1 Remote parity (adapters only).** `RemotePluginManagerPort` maps the
  generated `pluginManager` Remote plus its forwarded install events through the
  SAME pure `plugin-manager-mapping.ts` the Direct adapter uses; a refused
  `RemoteResult` becomes one thrown Error. `RemoteJobObservationPort` consumes
  the official Client `IJobs` (`state.rows`/`state.observed`, ref-counted
  `watchRows`/`observe`) and owns no follow/cursor/reconnect/tail state machine.
  Neither adapter is production-composed.
- **Published-contract gate.** `test/remote-official-contract.test.ts` proves
  every M3-bound Remote adapter accepts the published DSH 0.1.7-rc.2 public
  Client/Remote face with NO cast; the three structural sources the gate proved
  narrower than the official contract were fixed rather than hidden.
- **Same-Host integration.** `smoke:remote-session-lifecycle-parity`
  (run inside the exact-family client lane) proves the restored D2.3 lane over a
  real Client Context → Gateway → Host Session Controller: ordinary create,
  explicit-preset create, open/retain, model select, and preset select + locked.

Still deferred to M3 (adapter-ready, not wired): Remote backend production
assembly; Connection ownership in the TUI process; Client Context lifetime;
backend selection/loading; Remote main-surface owner install; the
`retain new -> commit -> release old` transition; writer-held caller/UI
recovery; Remote submission-presentation composition; Client-owned TUI/extension
command execution; tool-card presentation without Host presenter callbacks;
whole-log `/rewind` over `turnOutline`; image prompt/read wiring; permission
preset/access convergence; Client-local-shell ownership + sandbox fail-closed
behavior; Host-local legacy-settings-migration readiness ordering; Remote
Task/Presentation production consumption; Remote Plugin Manager panel wiring;
Remote Job viewer wiring.

The M3 entry architecture is:

```text
TUI
  ↓
semantic Backend / Client-local presentation seams
  ↓
official Client domain services
  ↓
generated Remotes
  ↓
Connection / Gateway
  ↓
Host domain services
```

It is explicitly NOT a private giant RPC and NOT a re-implemented
Session/Job/Plugin Manager reducer.

## Pre-M3 TS Architecture Convergence status (DONE, no behavior change)

This stage extracts the runner/composition/session/submission/surface
ownership that M3 must touch out of the ~10.8k-line `src/index.ts`, so M3 is
`transport + composition + lifecycle ownership wiring` instead of also a giant
TypeScript restructure. It is structural only:

- **No behavior change.** Transition order, writer/transition contract, fork
  publication/adoption, image/model admission serialization, draft
  restore/suppress rules, UI/UX, and the Extension public API are frozen.
- **Production stays Direct.** `BackendKind` remains `direct`; there is no
  `remote` backend branch, no runtime backend flag, no Remote attach, and no
  Client Context production lifetime.
- **M3 has NOT started.** The published semantic `Backend`, the `src/runtime/*-port.ts`
  contracts, and the Remote adapter contract stay frozen; no new Backend verb
  or DTO change is part of this stage.
- **Landed slices.** A1 — `src/app/direct/runtime.ts` owns the Direct
  application composition POLICY and facades (the ONE `DirectModelSelectionOwner`,
  the `agentFor`/`queueAgentFor` selection logic, the semantic `Backend` call and
  the Direct assistant-stream install); `src/index.ts` keeps the
  `liveAgent`/`viewedQueueAgent` state and passes live getters, and in A1 still
  supplies the concrete Host lookups (`agents.get`/`sessions.get`) for the
  resolver callbacks. Those lookups belong to `app/direct`'s Direct composition
  seam (A5a moved them behind it). `src/app/bootstrap.ts` is the application
  composition root (A5a): it resolves the Host services the owners are built
  from and connects them (plan §23/§26), while every Direct-only fact stays
  behind `app/direct`. No second current-session truth exists.
- **A5 status — A5 COMPLETE.** A5a landed the bootstrap/facade cutover:
  `src/app/bootstrap.ts` owns the runner composition (`applyRunner` → the named
  coordinator `startRunner()` → the terminal `handleStartupFailure`;
  `registerRunnerDisposal` for the fiber disposal), `src/index.ts` is a thin
  package facade (Cordis contract, `Config` re-export, public root re-exports,
  the frozen `composeAgent` / `recordedPreset` declarations delegating to
  `app/direct/composition.ts`, and `apply`), every root helper implementation
  lives in its natural top-level module, and the Direct Host lookups live behind
  `app/direct`'s own seam. The entry's Host coupling is now only the
  `@deepseek-ai/dsh-agent` types its frozen `composeAgent` overloads declare.
  A5b then extracted every application handler group into a real owner, so
  `src/app/bootstrap.ts` (6186 → ~2.1k lines) is a composition root in the strict
  sense: resolve Host services → construct owners → bind/connect → start →
  dispose/fatal cleanup. Final owner locations: `app/surface/viewer-runtime.ts`
  (child viewer state/lifecycle), `app/surface/session-presentation.ts`
  (live-session presentation, compaction/resume/task projections),
  `app/surface/status-runtime.ts` (status derivation + context measurement),
  `app/surface/input-history.ts` (client-local history state AND persistence
  policy), `app/surface/settings-runtime.ts` (footer/display settings + boot
  display), `app/surface/application-events.ts` (the `TuiAppEvents` adapter) and
  `app/surface/client-actions.ts` (Client-local clipboard/editor actions);
  `app/command/surface.ts` (command authority, registration, catalog
  coordination, the `TuiCommandRunner` facade and the runtime binding),
  `app/command/model-selection.ts` (sessionless `/model` intent + selection
  facade) and `app/command/artifacts.ts` (`/export` + `/transcript`);
  `app/submission/controller.ts` (the input workflow with its FIFO/ack/
  local-echo state, dispatch, history integration and the writer-section seam)
  and `app/submission/local-shell.ts` (the `!`/`!!` shell + card lifecycle);
  `app/session/**` (ownership/scope/navigation) and `app/direct/**` (Direct
  composition) are unchanged. All extracted owners consume narrow injected
  capabilities and the semantic ports: no owner imports `app/direct/**` /
  `runtime/direct/**` (the protocol/DTO packages a few owners use —
  `dsh-commands` in the submission controller, `dsh-llm` in the local shell and
  the type-only `dsh-user-approval/types` in the surface runtime — carry no
  Host-ownership coupling and are not tracked by the boundary gate), and every
  write still enters through
  `SubmissionRuntime` → `SessionRuntime.withWriter`.
- **§23 composition-only / giant-root criterion: COMPLETE.** `src/app/bootstrap.ts`
  no longer implements any application handler group. The plan's forbidden
  residuals (`runLocalShell`, `dispatchViaSession`, `runLocalCommand`, `steerNow`,
  `dispatchUserInput`, `enterView`, `exitView`, `surfaceEvents`,
  `applyFooterSettings`, `initLiveSession`, `registerCommands`,
  `openRewindPicker`, `refreshStatusCheap`) are absent, there is no
  `TuiAppEvents` / `TuiCommandRunner` implementation literal, and no client-local
  history state/policy, command claim/catalog slot, submission FIFO/ack/
  local-echo state, viewer mutable state or footer/display state machine remains
  in the root. `test/a5b-bootstrap-closure.test.ts` locks those categories and
  the single-authority/construction facts; the ownership matrix
  (`test/a5b-root-declaration-matrix.json`, regenerated by the committed
  `scripts/a5b-root-matrix.mjs`, gated by `test/a5b-root-matrix.test.ts` and its
  deep `--check`) classifies every remaining root declaration by the plan §7.6.1
  categories with a per-row sweep verdict and an EMPTY `MUST_MOVE` residual.
  The §23 criterion is therefore complete without qualification; the plan's DONE
  conditions are unchanged.
- **Ownership targets** (`src/app/**`): `bootstrap` (composition root),
  `direct` (Direct application-side Host coupling + Direct-only facades),
  `session` (session navigation/lifetime + opaque `SessionSubject` authority),
  `submission` (TUI writer orchestration), `command` (TUI command-runner
  facade), `surface` (TUI/backend-consumer wiring). `src/runtime/**` keeps its
  semantic ports/adapters and must not import `src/app/**`.
- **Machine-enforced direction.** `scripts/pre-m3-architecture-gate.mjs`
  (`pnpm gate:architecture`) parses the TypeScript AST and rejects
  `runtime → app`, Direct imports from any module that is not a composition
  owner (`index.ts`, `app/bootstrap.ts`, `app/direct/**`, `runtime/**`) — the
  §5.2 presentation boundary in enumeration-free form, with one type-only
  historical exception allowlisted — `owner → bootstrap` (the
  `owner-imports-bootstrap` rule: `index -> bootstrap -> owners`, never the
  reverse), Remote composition statically reachable from `startup.ts`, and
  Direct adapter construction in `app/surface`. It is
  separate from `scripts/client-boundary-gate.mjs`, which remains the
  Host-coupling authority (see `docs/client-server-coupling.md`).

Every implementation move re-exports any existing package-root export from
`src/index.ts` (guarded by `test/public-entrypoint-compat.test.ts`); removing a
root export is a separate API PR, never a side effect of this stage.

## M3 test-layer contract (T0 handoff)

M3 adds production composition (Client Context, Connection/Gateway lifetime,
backend selection, Remote main-surface ownership, the retain → commit → release
transition). A regression test for such a fact belongs at the lowest layer that
can actually prove it. The layer vocabulary is:

```text
L1 semantic-port contract    the src/runtime/*-port.ts contract and its pure mapping
L2 Direct adapter contract   the Direct implementation of a semantic port
L3 Remote adapter contract   a Remote adapter against the official Client/Remote face
L4 Direct ↔ Remote parity    parity/shadow comparison of semantic outcomes
L5 in-process integration    real Client Context → Gateway → Host, no TUI runner
L6 application composition   the real runner/application owner wiring and settlement
```

Rules:

- Prove behavior at the lowest sufficient layer.
- Do not add runner (L6) tests for adapter-local (L2/L3) facts.
- Add L5 when Connection/Client lifetime is the fact under test.
- Add L6 when application owner wiring/settlement is the fact under test.
- Parity tests compare semantic outcomes, not internal implementation shape.
- Lifecycle tests assert intermediate ownership/cleanup where required
  (creation, handoff, retirement), not only the final state.

T0 (Pre-M3 Test Prep) landed the flat runner integration surface this vocabulary
needs:

- `test/runner-session-bootstrap.test.ts` — main-Session bootstrap/hydration;
- `test/runner-session-navigation.test.ts` — `/fork`, `/rewind`, `/new`
  navigation adoption and supersession (M3-3);
- `test/runner-startup-lifecycle.test.ts` — Loader barrier and startup
  process-lifecycle (M3-1);
- `test/runner-session-retirement.test.ts` — cancel → idle → drain → flush →
  dispose retirement ordering (M3-1 / M3-3);
- `test/runner-viewer-task-integration.test.ts` — child viewer and Task/Job
  surfaces bound to a Session owner (M3-5);
- `test/support/runner-session-fixtures.ts` — shared live-stream frame builders,
  the production-runner observer probe, and the durable model/selection event
  builder; and `test/support/remote-generation.ts` — the observable and
  snapshot-only Connection-generation harnesses shared by the Remote
  adapter/parity suites.

The split suites stay directly under `test/` so `test:product`
(`test/*.test.ts`) keeps discovering them; post-M3 may move them into
directories once the test runner is deliberately made recursive.

## M3-1 status (COMPLETE, zero product cutover)

M3-1 landed the reusable experimental Remote **composition spine** — it makes
the official DSH Client runtime boring to instantiate and boring to dispose
while changing nothing about which backend the user runs. Direct remains the
production default; `BackendKind` stays `'direct'`; `cordis.patch.yml`,
`src/startup.ts`, the public CLI and the entry exports are byte-for-byte
unchanged; no production bootstrap call site exists.

### Implementation owners (actual files)

- `src/app/remote/host-runtime.ts` — `RemoteHostRuntime`: fail-fast Host
  prerequisite barrier (`credentials, typert, typertGateway, agents,
  agentDefaultModel, attachments, commands, fs, llm, sessions,
  sessionProjections, sessionQuery, workspaceRegistry, jobController`),
  then the exact §2.4.1 additive rows as tracked fibers
  (client-connection → real client-file-upload → sessionStats →
  turnOutline → api-session-controller `{nativeOpen: false}` →
  api-settings-controller → api-remotes → session-log-export), the existing
  `jobController` asserted (same Typert binding, never duplicated), the
  in-process carrier (`createSharedFetchHandler('/api')` +
  `typertGateway.wireStream.open`, `ownsHost: true`), and reverse disposal.
- `src/app/remote/client-runtime.ts` — `RemoteClientRuntime` +
  `loadOfficialClientModulesOnce()`: process-wide single-flight scoped
  `window.__ModuleLoader__` capture of the exact six Web bundle entries
  (unknown/duplicate/non-function/missing registration rejected,
  `/client` dependencies resolved in capture order, globals restored in
  `finally` before any plugin runs), then the exact §2.4.3 Client order
  (typert → `installConnection` with the explicit composition transport →
  Gateway → the ten §2.4.2 `/remote` contributions → fileUpload → Sessions
  → Jobs), subscription-driven initial readiness (no production timeout,
  lifecycle-signal abort), and reverse disposal.
- `src/app/remote/runtime.ts` — `createExperimentalRemoteRuntime`:
  `waitForHostPrerequisites()` → `signal.throwIfAborted()` → Host runtime →
  Client runtime; failure unwinds (Host partial → no Client; Client partial →
  Host disposed → rethrow); overall disposal is Client then Host, idempotent.
- `src/runtime/backend-loader.ts` — the only value dynamic import of
  `app/remote/runtime.ts`; no static type edge. The architecture gate now
  enforces this single owner (`remote-dynamic-import-owner`) and classifies
  `app/remote/**` plus every `@deepseek-ai/dsh-*` `/client` `/remote` face
  as Remote composition for the startup static-graph rule.
- `test/remote-client-runtime.test.ts` — the L5 acceptance matrix (plan
  §22 A–L): prerequisite barrier, loader exactness/single-flight/global
  restoration, no-browser-global connect/list, real connect + ready list,
  real `fileUpload` dependency, `sessionStats`+`turnOutline` projection
  surfaces, same-binding identity, real Job roster, reconnect/generation
  reset/`connection/reset`/list recovery, `/api/session.export` through the
  production carrier, idempotent reverse disposal with zero owned
  refs/watchers and a surviving ordinary Host, and one Host-partial plus one
  Client failure class with full unwind.
- `package.json` — the nine composition peers (`dsh-api-gateway`,
  `dsh-api-job-controller`, `dsh-api-remotes`, `dsh-api-settings-controller`,
  `dsh-client-connection`, `dsh-client-file-upload`, `dsh-session-stats`,
  `dsh-session-turn-outline`, `dsh-typert-registry`) at `>=0.1.7-rc.2` and
  the four missing exact rc.2 dev pins.
- `scripts/client-boundary-gate.mjs` — the two package-import matchers now
  require exact package matching (`dsh-agent(?![\w-])` /
  `dsh-session(?![\w-])`). The earlier prefix pattern classified the
  composition owners' `dsh-session-stats` / `dsh-session-turn-outline` /
  `dsh-session-log-export` projection rows and the
  `dsh-agent-preset-registry/remote` contribution as the base
  `dsh-agent`/`dsh-session` type packages, so M3-1 briefly carried two
  `client-boundary-baseline.json` entries that were never real coupling.
  Narrowing the matcher removed those two and three stale `runtime/direct/*`
  entries that matched `dsh-agent-preset-registry` the same way; the
  composition owners now carry no baseline entry and are documented in
  `docs/client-server-coupling.md` instead.

### Carrier correction (supersedes the M3-0 `transport.rpc` wording)

The verified rc.2 public carrier is the explicit `installConnection(ctx,
{ transport })` hook, not a composition-owned `ClientConnectionRpc`:
`transport.fetch` adapts the Host `connection.createSharedFetchHandler('/api')`,
`transport.openStream` adapts the Host `typertGateway.wireStream.open`, and
`transport.ownsHost: true` is passed with no `location`. No global `fetch`,
WebSocket, fake `location`, or browser `Worker` is reachable on the
in-process path (proven by the trapped-globals L5 case). The frozen wording
in `docs/m3-entry-contract.md` §2.4.3/§4.2 has been corrected in place; no
ownership, stage boundary, or seam policy changed.

### Closure evidence

- Contract authority: `docs/m3-entry-contract.md` §2.4 (Host/Client composition
  closure), §4.1–§4.3 (lifetime, scoped loader, dynamic boundary); DSH
  `0.1.7-rc.2` at stage time, requalified to `0.2.0-rc.2` in M3-3B.
- Composition owner: `src/app/remote/host-runtime.ts` (`RemoteHostRuntime`) and
  `src/app/remote/client-runtime.ts` (`RemoteClientRuntime`), reachable only
  through `src/runtime/backend-loader.ts`.
- Adapter-level evidence (L1–L3): n/a — M3-1 introduced composition, not a Remote
  adapter contract.
- Direct ↔ Remote parity (L4): n/a.
- Wire evidence (L5): `test/remote-client-runtime.test.ts` (prerequisite
  barrier, loader exactness/single-flight, real connect + ready list,
  `sessionStats` + `turnOutline` projections, Job roster, reconnect, archive
  route, reverse disposal).
- Application/surface evidence (L6): n/a — no product cutover; the Direct
  runner regression (`test/runner-startup-lifecycle.test.ts`) stays the
  application proof.
- Supported success path: real in-process connect and the dependency-closed
  official Host composition.
- Fail-closed/error paths: unknown/duplicate bundle registration rejected;
  Host-partial and Client-failure classes fully unwound.
- Reachability/UI disposition: `NO_USER_VISIBLE_CHANGE` — no production call
  site and no backend selector.
- Forbidden fallback verified: no `WebSocket`, `document`, `navigator`, global
  `fetch` or browser `Worker` reachable on the in-process path.
- Original-plan closure review: not recorded — M3-1 closed before this protocol
  existed.
- Deferred items promoted to Debt: none.

## M3-2 status (COMPLETE, zero product cutover)

M3-2 landed the Remote **Session owner spine**: `app/session`'s ownership
orchestration is now transport-neutral, and a real Remote owner provider
exists — but nothing about which backend the user runs changed. Direct
remains the production default; `BackendKind` stays `'direct'`; no production
`createRemoteSessionOwnerServices` / `createExperimentalRemoteRuntime` call
site exists; `cordis.patch.yml`, `src/startup.ts` and the public entry exports
are unchanged. M3-3A owns the Remote semantic backend closure; M3-3B/M3-4 own
the composition and presentation.

### Implementation owners (actual files)

- `src/app/remote/session-owners.ts` — `createRemoteSessionOwnerServices`:
  the exact-`SessionBinding` provider of `SessionOwnerAccess` +
  `SessionOwnerRetirement` over one shared registry state (`WeakMap` keyed by
  the exact binding object → owner; owner → record with the ONE authoritative
  wrapper, strongly held so `retire` can `release()`; a released-wrapper
  `WeakSet` fence; a strong parked collection per session id). Wrapper
  replacement commits the new authority BEFORE releasing the replaced TUI
  reference exactly once; a same-id new binding mints a NEW owner;
  `completionIdentity` is deliberately `undefined` (never the sessionId);
  `whenIdleOrAbort` borrows the live binding through the official
  `ISessions.binding(id)` face, fences it by `Object.is` against the owner's
  binding identity, and observes `SessionSnapshot.running` with a
  subscribe-then-recheck lost-wakeup fence — abort stops the local wait only,
  never the Host session; `flush`/`preCancel` are deliberate no-ops (Host owns
  durability; the real Remote cancel is `SessionWriter.cancel`); `retire`
  detaches the wrapper state before `release()` (reentrancy) and reports a
  contained `release` phase failure, with `durabilityFailure` always
  `undefined`.
- `src/app/session/runtime.ts` — the ordinary transition maps the NEW owner
  ONCE in the synchronous commit section (a transaction-local
  `committedOwner`; the post-commit phases reuse it instead of re-wrapping the
  Remote reference wrapper). The owner publication is the transition's COMMIT
  POINT, and both failure classes follow from it:
  - PRE-publication failure — the acquired NEW owner is released exactly once,
    with that release AWAITED before the transition settles (the transition
    gate/barrier stay closed until the released reference/lease is actually
    gone — never a fire-and-forget retirement), the queued recalls settle
    aborted, and OLD stays current. Every owner-metadata lookup that can
    throw (`completionIdentity`, `sessionId`) runs BEFORE
    `setCurrentOwner`, so the commit point itself is seamless (plain
    assignments only);
  - POST-publication synchronous seam failure — contained as a failed
    post-commit step: the committed child stands, the queued recalls stay
    committed, the OLD retirement still runs; never a rollback.
  The fork adoption owns the SAME transaction-finally shape (`forkCommitted`
  flipped at the child publication): every pre-publication fork exit — a
  refused navigation inside the gate, the adoption-open failure, the
  stale-after-retain cleanup, an invariant failure, a pre-publication commit
  seam — restores the deferred recalls through ONE settle authority instead
  of per-branch restores, because the gate was held and a finishing writer
  may have deferred a queue recall against it.
- `src/session-fork.ts` / `src/app/session/ownership-core.ts` — the fork/
  rewind navigation identity (`RewindNavigationIdentity`, renamed from
  `RewindLiveIdentity`) is now session id + navigation epoch ONLY: the
  surface `generation` is removed from it at the type level. Mirroring the
  official Client split (ClientSessions owns Session identity/references and
  never a global current selection; view navigation belongs to the UI owner),
  navigation supersession and presentation-generation invalidation are
  independent axes — a commit section bumps the generation before the owner
  publication, so a local commit-seam failure (e.g. a `resetForGeneration`
  throw after the bump) can no longer be misclassified as user supersession.
  The monotonic navigation epoch alone still solves A → B → A staleness
  (locked by the rewind picker regression), the generation bump is never
  rolled back, and the transactions follow a PRE-PUBLICATION METADATA
  SNAPSHOT contract: every owner-metadata lookup a transaction still needs
  (the completion identity, the NEW owner's session id, and for the fork
  adoption also the SOURCE owner's id for its post-commit retirement)
  resolves BEFORE `setCurrentOwner` — the sole commit point — inside the
  pre-publication protected region, so any metadata throw is a
  pre-publication failure with an exactly-once NEW release (including the
  open-retained fork child). After the publication the phases consume only
  the captured primitive values and never re-resolve the owner: a contained
  post-publication seam failure still retires OLD, and a committed fork
  child still retires its source.
  The four "without a Direct owner" throws are now
  transport-neutral owned-generation failures; `adoptFork` grew the Remote
  publication→open adoption: an ownerless fork handle is retained through
  `lifecycle.open(childId)` inside the existing gate/barrier (one Host fork
  dispatch + at most one adoption open), the fence is re-checked after the
  retain, and a stale/disposed post-open adoption releases the NEW owner
  exactly once while OLD stays current (a pre-publication commit seam failure
  takes the same exactly-once release plus an explicit recall restore, and the
  fork-adoption ledger keeps the
  error path from re-parking the already-released owner — Direct or Remote);
  any post-publication adoption failure
  settles as a truthful "child published but adopting it failed" outcome
  (never a redispatch, never a fake-absent child); a Direct fork handle still
  adopts directly with zero extra opens.
- `src/app/bootstrap.ts` — the two Direct-attachment hard throws
  (`initLiveSession` / `refreshLiveCatalog`) are M3-2 staging no-ops for an
  owner without a Direct attachment; Direct behavior is byte-for-byte
  unchanged and the real Remote presentation/catalog providers arrive with
  the M3-4 Remote composition.
- `src/runtime/session-lifecycle-port.ts` — the stale "Direct runner does not
  consume it yet" note on `clientOwnerOf()` is replaced by the real ownership
  boundary: the Remote owner provider consumes it as its sole mapping source
  and `ClientSessionOwner` never leaves the Remote ownership implementation
  boundary.

### Evidence

- L6 `test/remote-session-owners.test.ts` — R1–R12: exact-binding identity,
  same-binding wrapper transfer with exactly-once release, released-wrapper
  resurrection refusal, same-id new-binding owner change, unknown-owner fast
  fail, idle fast path, running→idle settle with single unsubscribe, abort
  local-wait-only with listener cleanup (counting signal), exactly-once
  retire across modes, no-op flush/preCancel, parked retained-owner drain,
  contained release failure.
- L6 `test/session-runtime-remote-owner-handoff.test.ts` — H1–H12 over the
  real `bindSessionRuntime` + REAL Remote owner services + a Remote-shaped
  fake lifecycle: ordinary-switch ordering (retain NEW → commit NEW → release
  OLD → post-handoff init; owner mapped exactly once), pre-commit
  supersession, same-id rollover, rapid-switch A→B(superseded)→C, Remote fork
  successful adoption (fork ×1, open ×1, source release ×1), stale-before-open
  (open ×0), stale-after-open (NEW release ×1), failed open (no redispatch,
  truthful outcome, no leak), same-binding reconnect identity, full-scope
  re-materialize identity, exit-before-commit and fatal-after-commit release
  proof, pre-publication commit-throw exactly-once release (ordinary + fork,
  Remote publication-only AND the Direct owned-handle no-re-park lock; plus
  the gated slow-release proof that the transition stays open until the
  release completes), post-publication completion-seam containment (ordinary
  + fork), the recall-commit-point boundary (pre-publication restores the
  recalls for BOTH shapes; a post-publication contained failure keeps them
  committed exactly once; `transitionCommitted` flips only at the
  publication, locked through a direct `transitionTo` probe), plus the
  Direct-shaped no-extra-open adoption lock.
- Direct regression — `test/runner-session-retirement.test.ts` (retirement
  order unchanged), `test/runner-session-navigation.test.ts` (a production
  Direct `/fork` never performs the extra adoption open; resume list stays
  exactly the startup entry), `test/a2-ownership-cutover.test.ts` (the four
  commit shapes still publish only through the injected owner provider into
  `SessionOwnershipCore`; the production bootstrap still injects
  `directRuntime.owners`).

### Closure evidence

- Contract authority: `docs/m3-entry-contract.md` §5 (exact identity, handle
  mapping, retirement semantics, transition ordering, lifecycle reference
  table).
- Composition owner: `src/app/remote/session-owners.ts`
  (`createRemoteSessionOwnerServices`), consumed by the transport-neutral
  `src/app/session/**` orchestration.
- Adapter-level evidence (L1–L3): `test/remote-session-lifecycle.test.ts` — the
  pre-existing Remote `SessionLifecycle` adapter contract (structural Client
  lifetime harness) consumed by M3-2.
- Direct ↔ Remote parity (L4): `smoke:remote-session-lifecycle-parity`.
- Wire evidence (L5): n/a — the stage added no wire-sensitive adapter.
- Application/surface evidence (L6): `test/remote-session-owners.test.ts`
  (R1–R12) and `test/session-runtime-remote-owner-handoff.test.ts` (H1–H12)
  over the real `bindSessionRuntime` and real Remote owner services.
- Supported success path: ordinary switch/open/fork `retain → commit → release`
  with exactly-once release and Remote fork publication→open adoption.
- Fail-closed/error paths: a pre-publication failure releases NEW exactly once
  and keeps OLD current; a post-publication seam failure is contained; a
  released wrapper is refused; a stale-after-open adoption releases exactly
  once.
- Reachability/UI disposition: `NO_USER_VISIBLE_CHANGE` — zero product cutover,
  no production call site.
- Forbidden fallback verified: no Direct-owner resurrection and no extra
  adoption open on the Direct path.
- Original-plan closure review: not recorded — M3-2 closed before this protocol
  existed.
- Deferred items promoted to Debt: none.

## M3-3A status (COMPLETE, zero product cutover)

M3-3A closed the Remote **session / runtime / catalog / host-file semantic
foundation** against the published DSH 0.2.0-rc.1 contract
(`docs/m3-entry-contract.md` §1.1 requalification): the semantic ports no
longer inherit historical Direct shapes, and every M3-3A adapter constructs
from ONE M3-1 `RemoteClientRuntime`. Nothing about which backend the user
runs changed: Direct remains the production default, `BackendKind` stays
`'direct'`, no backend selector exists, and no production bootstrap call site
consumes the bundle. M3-3B owns the Remote ConfigPort, interaction flow and
the final complete Remote Backend assembly.

### Implementation owners (actual files)

- `src/runtime/session-reader-port.ts` + the two adapters — the context
  authority is now the official `contextPressure` projection numerator
  `projectedTokens ?? pressureTokens` (the shared
  `contextPressureOccupancy`; Direct reads the Host projection snapshot,
  Remote reads the exact retained binding's face — never a `tokenMeter`
  second authority, never an invented RPC). The reader also gained the
  official `turnOutline` navigation read (M3-4 `/rewind` boundary source)
  and the subject-neutral `sessionStatus(sessionId)` snapshot (M3-4/M3-5
  facts: model `next ?? lastUsed`, context pressure/breakdown, `tokenUsage`,
  `todos`, and the session's own cwd) through the shared
  `src/runtime/session-status-projection.ts` mapping — one session's values
  only, absent fields stay absent, no parent fallback, no StatsFolder.
- `src/subagent-model-menu.ts` — the allowlist picker consumes the official
  grouped model directory (`ModelCatalog.loadDirectory()`, the
  `session.modelCatalog()` semantic) in ONE async read; saved routes stay
  representable/removable as trailing rows, and ABSENCE is a claim only a
  READY directory that loaded the route's provider can make
  (`AllowlistCatalogState`: while the catalog is loading, after a
  whole-directory read failure, or for a provider in `directory.failures`,
  the saved row renders "saved route (…)" — never "not in the current
  catalog"); per-provider failure isolation renders from
  `directory.failures`; the
  historical `listProviders()` + `listModels(provider)` cross-backend pair is
  RETIRED from `ModelCatalog` (Direct keeps it only as the in-process
  `ctx.llm` face its own directory read uses). `llm.listModels` has no public
  Remote — no private RPC may ever back it.
- `src/runtime/remote/model-remote.ts` — `discoverModels` maps the official
  `llm/discoverModels(settingsNs='llm-pi-ai', request, signal)`: a Host
  refusal or replaced generation SURFACES (never `[]`), so the wizard
  distinguishes failure from fallback. `listConfigurableProviders` stays
  `undefined` on Remote (the /login merge's settings-only fallback; its sync
  mirror policy is M3-3B's).
- `src/runtime/remote/skill-remote.ts` — `RemoteSkillCatalog`: the official
  Session-addressed `skills/list` (detached DTO, abort → cancellation, Host
  error → error). The sessionless standing catalog and the Client skill-body
  read stay explicit unsupported; `hostLoadsSkillBody` is a composition
  fact (constant), and `onSkillsChange` installs no private event (the
  strong re-read boundaries own freshness).
- `src/runtime/host-file-port.ts` + both adapters — `listReferences`
  distinguishes an authoritative `ok` (empty included) from `unavailable`
  (reason carried); `resolveReference` gained the same third state (never
  fake `missing`). `query` is the OFFICIAL wire form (the path text
  following `@`, outside quotes — the grammar stripping is client policy in
  mentions.ts, never an adapter's). The SESSION scope maps the OFFICIAL
  Host authority on BOTH sides: Direct calls
  `ctx.fileReferences.list(agent, query, signal)` (the
  `dsh-file-reference-local` provider the composition mounts — the same
  service the wire forwards to; the adapter maps, it does not re-implement
  ranking/bounds/exclusions/caching), Remote maps
  `fileReferences/list(agentId, query, signal)` with generation fencing.
  The port's candidates are ALREADY filtered, ranked and bounded BY THE
  HOST AUTHORITY, in the Host's order — the MentionProvider is
  PRESENTATION-ONLY (quoting, `@` shape, labels, directory continuation)
  and never re-ranks or re-filters, so a Host-returned subsequence match
  can never be dropped by a second client-side scorer (regression-locked);
  the workspace compatibility path completes the legacy ranking INSIDE its
  adapter (the pure local `rankDiscovery`) to honor the same contract. The
  mention VALUE is the OFFICIAL shared grammar's (`formatFileMention` —
  quoting rules and safety refusals; a quoted directory keeps its quote
  open). The completion TRIGGER keeps the official `activeAtToken`
  baseline (start-of-line/whitespace only) plus FOUR INTENTIONAL TUI
  trigger extensions — CJK-glued mentions and `"`, `'`, `=` boundaries —
  documented in `src/file-completion/context.ts`; they only widen when
  the dropdown opens, never the Host query or the serialization.
  The WORKSPACE scope keeps the legacy fd/fdfind scanner as a Direct-only
  sessionless compatibility path with no official carrier (the wire answers
  `unavailable`); it must not define the session semantics.
  MENTIONS STAY LITERAL ON BOTH BACKENDS — and that is not a missing-carrier
  fallback but the OFFICIAL client contract itself (the official codec is
  `serialize: ref => ref`; the Host's `FILE_REFERENCE_PROMPT` — installed
  by the official `dsh-file-reference-local` row the TUI composition now
  mounts, the same row the web bundle uses — resolves relative paths from
  the workspace root). The Direct adapter's historical send-time
  existence-probe absolute rewrite is RETIRED: it was Direct-only behavior
  with no wire carrier and made the two backends send different bytes for
  the same input. Cancellation is its own outcome on BOTH adapters: an
  aborted signal REJECTS (`throwIfAborted`, entry-time — outranking every
  `unavailable` early return), never folded into `unavailable`.
- `src/runtime/presentation-read-port.ts` + readers —
  `PresentationReader.loadThrough(sessionId, seq)` maps the official Client
  `Session.loadThrough` jump (borrow → pin exact generation → ONE official
  call → generation + binding-identity recheck → snapshot → release); the
  TUI never hand-rolls a `loadOlder` chain. Direct answers with its full
  coverage snapshot after the cancellation check.
- `src/app/remote/m3a-semantics.ts` — `createRemoteM3ASemantics`: the
  partial assembly of every closed surface (sessionReader,
  pendingInputReader, sessionWriter, sessionLifecycle, subagent, catalog,
  hostFile, hostCommand, presentationReader) from ONE narrow runtime face
  (`RemoteM3ARuntimeSource`; the official-contract gate proves the real
  `RemoteClientRuntime` satisfies it). NOT a `Backend` — no
  interaction/config/sessionArchive, no `BackendKind` change. `dispose()`
  drops the adapter caches ahead of the Client Context; the M3-2 owner
  services stay their own owner.

### Supported / unsupported matrix (M3-3A surfaces)

| Surface | Remote state | Carrier / reason |
|---|---|---|
| SessionReader list/projectionBatch/search/blank | READY | official Client list/projection faces (D1.1, unchanged) |
| `measureContext` | READY | official `contextPressure` projection (`projectedTokens ?? pressureTokens`) |
| `turnOutline` | READY | official `turnOutline` projection off the exact binding |
| `sessionStatus` | READY | official projections + the session's own cwd fact |
| PendingInputReader / SessionWriter / SessionLifecycle / SubagentPort / HostCommandPort | READY | D1–D2 adapters, requalified |
| ModelCatalog `loadDirectory` / selection writes | READY | `session/modelCatalog` / `session/selectModel` (D2.3) |
| ModelCatalog `discoverModels` | READY | `llm/discoverModels` (failure surfaces) |
| ModelCatalog `listProviders`/`listModels` | RETIRED | no public Remote for `llm.listModels`; the official directory replaces the pair |
| ModelCatalog `listConfigurableProviders` | UNAVAILABLE (`undefined`) | config-schema ownership is M3-3B's ConfigPort |
| SkillCatalog `listHumanSkills` | READY | `skills/list` |
| SkillCatalog `standing` / `resolveSkill` / `onSkillsChange` | UNSUPPORTED | session-addressed list-only wire; no `skills/read`; no forwarded `skills/*` event |
| HostFile session scope | READY | Direct: `ctx.fileReferences.list(agent, query, signal)` (the official provider); Remote: `fileReferences/list(agentId, …)` — both with the official query form |
| HostFile workspace scope / existence | UNSUPPORTED (wire) / Direct-only compat | no official carrier — `unavailable`; the workspace scanner is a Direct-only compatibility path, `resolveReference` a Direct-only diagnostic seam (neither defines the cross-backend contract) |
| HostFile mention send semantics | OFFICIAL_LITERAL (both backends) | the official codec + `FILE_REFERENCE_PROMPT`; no send-time probe or rewrite anywhere |
| PresentationReader `read`/`loadOlder`/`loadThrough` | READY | official Client event window + jump loop |
| PresetCatalog roster/default/resolve/select | READY (requalified) | `agentPresets/list`/`select` |

### Projection / Presentation Availability Map (M3-4/M3-5 inputs)

Per addressed session (main retained, child retained, child catalog-only /
cold, after reconnect) — the authoritative facts M3-4/M3-5 may display:

| Fact | main retained | child retained | child catalog-only/cold | reconnect |
|---|---|---|---|---|
| modelSelection (`next ?? lastUsed`) | official projection value | same, from the CHILD's binding | no binding → absent (never the parent's) | generation-fenced: the old Host's value is dropped, the new binding repopulates |
| contextPressure (`projectedTokens ?? pressureTokens`, `contextWindow`) | official projection value | same, from the child's binding | absent — no guessing | generation-fenced |
| contextBreakdown | official projection value | same | absent | generation-fenced |
| todos | official projection value (`null` = none yet) | same | absent | generation-fenced |
| tokenUsage | official projection value | same | absent | generation-fenced |
| cwd | the session's own list-row fact | the child's own list-row fact | absent unless the row carries it | re-derived from the new list baseline |
| turnOutline | official projection value | same | absent (a projection read, never a history fold) | generation-fenced |
| running/activity | Client Session fact (`SessionSnapshot.running`) | the child's own | catalog semantics only | unknown while disconnected |
| presentation window (`read`/`loadOlder`/`loadThrough`) | official Client event window | same | no binding → `undefined` | the official reconnect re-opens; stale settles drop |

M3-5 must consume these through `sessionStatus`/`turnOutline` — it must NOT
build a `ChildStatusReader`, `ViewerStatusPort` or any parent-fallback.

### Evidence

- Unit: `test/remote-session-reader.test.ts` (R1–R6 parity + outline +
  status isolation + same-id binding replacement),
  `test/session-status-projection.test.ts` (Direct mapping + child
  correctness), `test/remote-skill-catalog.test.ts` (S1–S8),
  `test/remote-host-file-port.test.ts` (F1–F9),
  `test/remote-presentation-read.test.ts` (H1–H5 + fences),
  `test/remote-model-port.test.ts` (directory + official discovery),
  `test/subagent-model-menu.test.ts` (directory-driven picker UX),
  `test/remote-m3a-assembly.test.ts` (one-source wiring + disposal).
- Contract: `test/remote-official-contract.test.ts` — the published
  0.2.0-rc.1 faces satisfy every adapter source, the projection faces, the
  `Session.loadThrough` face, `llm/discoverModels`, and the M3-3A assembly.
- Same-Host: `test/remote-m3a-semantics-smoke.test.ts` (P1–P10: real Host
  Context → M3-1 in-process carrier → real official Client Context → the
  M3-3A bundle, including the official reconnect generation replacement).
  The D1 parity shadow's `session.measureContext` skip is RETIRED with it
  (the field now compares in `smoke:remote-session-read-parity` /
  `smoke:remote-d1-closure`).
- Mutation checks (plan §26): A (context mapping), C (workspace fake-empty),
  D (local-fs canonicalization), E (loadThrough fence), F (child fallback)
  each verified to fail the guarding tests; B is enforced structurally (the
  retired pair no longer exists on the port). (D's guard predates the
  literal-mention realignment, where the whole rewrite path was retired
  rather than mutation-guarded.)

### Closure evidence

- Contract authority: DSH `0.2.0-rc.1` (`next @ fa71168…`, package `0.5.0`) per
  `docs/m3-entry-contract.md` §1.1; requalified to `0.2.0-rc.2` in M3-3B.
- Composition owner: `src/app/remote/m3a-semantics.ts`
  (`createRemoteM3ASemantics`) over ONE M3-1 `RemoteClientRuntime`.
- Adapter-level evidence (L1–L3): the adapter suites listed under Evidence
  (session reader, skill catalog, host file, presentation read, model port,
  assembly).
- Direct ↔ Remote parity (L4): `smoke:remote-session-read-parity` /
  `smoke:remote-d1-closure` (the retired `measureContext` skip now compares).
- Wire evidence (L5): `test/remote-m3a-semantics-smoke.test.ts` (P1–P10)
  same-Host qualification through the real in-process carrier.
- Application/surface evidence (L6): n/a — zero product cutover; the Projection
  / Presentation Availability Map is the M3-4/M3-5 input, not a surface.
- Supported success path: real `contextPressure` / `turnOutline` /
  `sessionStatus` projection reads, the official `modelCatalog` directory,
  `skills/list`, `fileReferences/list` and `PresentationReader.loadThrough`.
- Fail-closed/error paths: sessionless standing skill reads, the skill body
  read, `skills/change` hot invalidation, workspace-scope `@file` and
  existence canonicalization stay unavailable rather than faked; an aborted
  signal rejects on both adapters.
- Reachability/UI disposition: `NO_USER_VISIBLE_CHANGE`; the availability map
  records what M3-4/M3-5 may display.
- Forbidden fallback verified: no `tokenMeter` second authority, no private
  `llm/listModels` RPC, no local-filesystem canonicalization.
- Original-plan closure review: not recorded — M3-3A closed before this
  protocol existed.
- Deferred items promoted to Debt: none.

## Known coverage follow-ups

Non-blocking coverage gaps with a named owner lane. These are not current
merge blockers; each records what is absent and the follow-up shape.

None currently for **Pre-M3**: the D2.3 same-Host integration lane is closed by
`smoke:remote-session-lifecycle-parity` (see the Pre-M3 status section). The
M3-only L5/L6 proofs frozen in `docs/m3-entry-contract.md` (Client command
execution, tool presentation, image submit/read, `turnOutline` rewind and skill
invalidation behavior) are stage acceptance tests, not missing Pre-M3 coverage.

## Known blockers

| Blocker | Level | Mitigation |
|---|---|---|
| Client Runtime still carries web assembly assumptions (`dsh.client.platform: web`) | High | M3-0 validated the packaging: every rc.2 `/client` entry is a `window.__ModuleLoader__` browser chunk with no Node-native entry, and the transport/generation/`installConnection` seams are public. M3-1 owns the scoped loader shim + the in-process explicit transport carrier (`connection.createSharedFetchHandler('/api')` + `typertGateway.wireStream.open`, installed through `installConnection`) (see `docs/m3-entry-contract.md` §4.2). No product redesign required |
| DSH Connection / generated-remote dependency closure differs from the pi-tui profile | High | M3-0 resolved the closure question with an explicit **dynamic composition owner**: after the Host-local legacy-settings migration prerequisite settles, M3-1 `src/app/remote/host-runtime.ts` mounts Host connection → fileUploads → `sessionStats`/`turnOutline` → session/settings controllers → forwarded events → session-log-export only while the experimental Remote runtime is alive; it reuses the already-mounted `jobController`. The Client mounts the explicit minimal `/remote`/Client set. The normal `cordis.patch.yml` is unchanged byte-for-byte — no hidden experimental rows or Loader flag (see `docs/m3-entry-contract.md` §2.4, §4.4, §11 M3-1) |
| Extension Cordis ownership across the split | High | M3-0 froze the direction (UI contributions in the Client Context, Host domain state behind public Remote facts, no callback across the wire); M3-6 implements it (see `docs/m3-entry-contract.md` §8) |
| Cross-client concurrency safety (Web+TUI, TUI+TUI, reconnect, cold resume, Host crash) | Critical | DSH SessionWriteLease is the cross-process writer authority; the full matrix is proven at M8 |
| Shell execution on the wrong machine | Critical | Locality hard rule: Remote `!`/`!!` **bypass** mode executes only in the Client/TUI process; an explicitly requested sandboxed local shell has no rc.2 Client carrier and fails closed. The Remote branch never borrows Host `ctx.shell` merely because M3 is in-process |
| `@file` resolving on the Client filesystem | High | M1.10 sealed the locality boundary: all `@` discovery/canonicalization goes through `HostFilePort`; the M2 Remote adapter maps it to Host fileReferences |
| Credentials exposure beyond loopback | Critical | Attach limited to localhost/SSH until real auth |
| Dual-stack semantic drift | Medium | Shared backend contract test matrix |
| Session history opening pages without a complete leading turn | Medium | Closed for the rc.1 turn-aligned opening windows; if a future contract re-introduces partial turns, track a `presentation.leadingTurnCompleteness` skip again instead of guessing or prefetching full history |
| Upstream DSH contract changes | Medium | Public export audit + per-release compatibility matrix; no old/new runtime fallback |

## Startup constraint

`src/startup.ts` parses flags and prints the advisory compatibility notice for
Harness versions below the current floor. Experimental Remote dependencies must
never enter its static import graph — load the selected backend via dynamic
import in a `runtime/backend-loader` module. The current line requires DSH
`>=0.1.7-rc.2`; `HARNESS_COMPAT` maps every older official tag to its
historically compatible TUI line (the `0.1.7-rc.1` runtime falls back to the
published `0.4.8` bundle, the `0.1.6-alpha.2` runtime falls back to the
published `0.4.7-alpha.2` bundle, `0.1.6-alpha.1` to `0.4.7-alpha.1`, and the
`0.1.5-rc.1`/`rc.2` family to `0.4.6`) and supplies the exact npm upgrade
command. There is no old/new runtime
capability-detection branch, and future versions are not rejected without a
confirmed break.

## How to update this file

- Every phase completion: flip the phase status, record what landed, and
  update the "Current production backend / Experimental backend / Remote
  attach / Direct rollback" block.
- Every coupling relocation: update `docs/client-server-coupling.md` and
  the gate baseline in the same PR.
- Every new blocker or removed blocker: update the table.
- Every stage closure: close the four protocol axes, add/refresh the
  `### Closure evidence` block, and run the original-plan closure review.
- Every DSH baseline change during an active stage: run the contract
  requalification flow before resuming implementation.

## M3-3B status (COMPLETE, zero product cutover)

M3-3B closed the **rc.2 contract reconvergence + config / interaction /
archive / Remote-backend assembly**. The DSH family floor moved as one unit
(peers `>=0.2.0-rc.2`, development/source target exact `0.2.0-rc.2` at
`639ed015…`) because the Question lifecycle consumes rc.2-only published
contracts; `0.5.0` remains the published pairing for rc.1 and older. Direct is
still the production default, no backend selector exists, and normal startup
still reaches the Remote graph only through the dynamic
`runtime/backend-loader.ts` boundary.

### rc.2 uplift + frozen-contract reconvergence

- `package.json` (all `@deepseek-ai/dsh-*` peers `>=0.2.0-rc.2`; all DSH dev
  deps exact `0.2.0-rc.2`), `pnpm-lock.yaml`, `test/compat/dsh-source.json`
  (`639ed015397290b3745d163aafe02ffee4aa3f84`), `test/dsh-peer-window.test.mjs`
  (accepts rc.2, explicitly rejects rc.1/0.1.7), `src/dsh-compat-matrix.json`
  (reserved `0.5.1` row `dshFrom 0.2.0-rc.2`; the published `0.5.0` row keeps
  its `0.1.7-rc.2 … 0.2.0-rc.1` history), `docs/dsh-compatibility.md`,
  `README*.md`, `CHANGELOG*.md`.
- `docs/m3-entry-contract.md` §2.1 now carries SEPARATE Approval and Question
  authority matrices (the old combined "waterfall only" row was stale for
  Question on rc.2).
- `test/remote-official-contract.test.ts` is the rc.2 published-surface gate:
  it proves `remote.userQuestions.attachWait/answer`, `Session
  userQuestions`, the `settings`/`credentials` Remote faces, the
  `/api/session.export` route constant and the composition-owned archive fetch
  still exist, so a future rc that renames or drops one fails HERE.

### Question semantics + UI lifecycle

- `src/runtime/interaction-port.ts` splits the interaction capability:
  `onApprovalRequest` + the fail-closed `setApprovalPolicy` stay, while the
  new `questions` sub-domain carries the rc.2 lifecycle — a detached
  `QuestionRequestView` (sessionId + callId + timed + detached question DTOs),
  `snapshot(sessionId)` (`userQuestions` projection + Inbox
  `user-question-reply` queued-reply fact), `claimTimedWait` (the
  transport-neutral `QuestionWaitClaim`: Host-seeded `remainingMs`, `ended`,
  `release`), and `answerContinued` (the official `answer` taxonomy via the
  shared `QuestionAnswerError`). Approval and Question are separate concerns
  and no Typert/Agent object crosses the port.
- `src/runtime/direct/interaction-direct.ts` maps the SAME semantics from the
  in-process Host: `user-questions/request` with the Session identity read
  from the request's Agent scope, `ctx.userQuestions.attachWait/answer`, and
  the official `sessionProjections` `userQuestions` + `inbox` reads (the one
  Direct coupling delta this stage adds).
- `src/runtime/remote/interaction-remote.ts` maps them over the wire:
  `$on('user-questions/request')` with the Session identity from the official
  Client scope, `remote.userQuestions.attachWait/answer`, and the
  `session.projections.faceOf('userQuestions'|'inbox')` reads, all generation
  fenced (a replaced Connection makes a claim absent, never stale).
- `src/app/surface/question-controller.ts` is the ONE TUI Question surface
  owner: claim-before-countdown, a presentation-only countdown that rejects
  the forwarded waterfall with the wire-preserved `ASK_TIMED_OUT` (never a
  Turn or question cancel), the first-real-answer-mutation freeze,
  projection-driven continued-question reachability, queued-reply read-only
  suppression, `REPLY_QUEUED`/`BAD_ANSWER` recovery, and claim release on
  settle/teardown. It layers AROUND the unchanged `QuestionFlow` (no fork, no
  second draft store, reentrancy fences intact).
- `src/tui-app.ts` gained a caller-owned status line on the flow and carries
  the primary `callId` on a settled tool card (`src/transcript.ts`), so
  `present.ts`'s existing summary/answer-line renderer is fed the
  authoritative `userQuestions.settled` batch — a presentation enrichment over
  the unchanged durable transcript event (no synthetic tool result).
- Activation note: the timed path is exercised when the composed agent preset
  declares the timed `ask_user_question` schema
  (`@deepseek-ai/dsh-tool-ask-user` with `mode: timed`). The generated preset
  mirror is a verbatim copy of the official assets and is never hand-edited,
  so the TUI is timed-CAPABLE while the shipped presets keep the official
  default; the blocking (legacy) flow is unchanged and still first-class.

### Remote ConfigPort

- `src/runtime/remote/config-remote.ts` implements the whole `ConfigPort`
  over ONE generation-aware, serialized settings mirror: listeners installed
  before the first `describe`, invalidation-during-read discarded and
  re-read (bounded), writes FIFO-serialized through the descriptor's
  revision and followed by an authoritative refresh (never an optimistic
  local patch), a generation change marks the snapshot non-current and a
  stale result never commits, and every subscription/listener is disposed
  exactly once.
- **First-read barrier (§2.3/§4.1).** `createRemoteBackendRuntime` awaits the
  mirror's first `describe()` as part of construction (after the M3-1 runtime
  already awaited its own readiness), so a freshly assembled Remote backend's
  settings/providers/permissions are readable instead of permanently stale. A
  transient failure is RECORDED (never swallowed): `readiness()` stays `stale`,
  `lastRefreshFailure()` carries the cause, and the next invalidation, write
  pre-flight or explicit read retries.
- **Currentness is semantic (§9.1).** `ConfigPort.configReadiness()` exposes
  `ready | stale | unavailable` (Direct is always `ready`; Remote reports the
  mirror). `/settings` announces a non-`ready` backend explicitly and the
  write path refuses immediately with an explicit unavailable reason instead of
  presenting last-known values as authoritative or silently no-op'ing. A
  reconnect refreshes from authority first: once that read commits, the write
  proceeds and the mirror is current again; when the refresh cannot succeed the
  write fails with the real reason and dispatches nothing. Sub-domains: `tuiSettings` (raw
  `keybindings`/`footerCustomItems`/`footerCommand`/`footerLayout` ride
  verbatim; a shared `mutationQueueKey`), footer USER-layer trust + custom
  items (never the merged value), provider profiles with ONE adapter-owned
  `canProvisionProfile` rule driving both the flag and write admission,
  credentials reference read/write, permissions (catalog/default/apply
  through `/permission <preset>`, `approvalOverrideOf` ALWAYS `undefined` —
  no `?? 'ask'`), preset default, and subagent model selection.
- `/login` (§9.3): the reference/API-key path IS supported, and the absent
  provider sign-in sub-capability is never silent — when this backend publishes
  no authorization surface, a keyless route's prompt states that OAuth/device
  sign-in is unavailable here. The wire cannot say whether a keyless route is
  OAuth-only or uses the conventional env-var reference, so a hard block would
  hide provider login entirely (which §9.3 also forbids).
- Explicit unsupported (docs/m3-entry-contract.md §10): `listRecords()` /
  `deleteRecord()` REJECT with a truthful unavailable error (never an empty
  record list), and the whole authorization sub-domain fails closed
  (`available()===false`, no fake targets, no private auth RPC). UI
  consequence (§9.4): the no-argument `/logout` picker still opens with the
  clearable references and its outcome says plainly that stored credential
  records cannot be enumerated or removed on this backend — no fabricated
  record row and no failed picker.
- Credential operations (`setReference`/`unsetReference`/`describeReference`)
  re-check the Connection generation before reporting their outcome, so a call
  that completed against a replaced Host is never presented as a success on
  the new one (`/login` reports it as unconfirmed instead of "login
  cancelled"; the `/logout` picker degrades a superseded describe to "not
  configured").

### Remote session archive

- `src/runtime/remote/session-archive-remote.ts` maps `SessionArchivePort`
  onto `GET /api/session.export` through the composition-owned fetch: the
  upstream `content-disposition` filename is authoritative, the returned
  stream is the live body (never buffered Client-side), 404 → `none`, the
  missing-services 500 → `unavailable`, anything else → a real failure, and
  the caller's abort travels through the same fetch signal. The existing
  `src/app/command/artifacts.ts` save UX is unchanged and remains the sole
  owner of the destination/local path/stream-to-file.

### Complete experimental Remote Backend

- `src/runtime/remote/backend-remote.ts` +
  `src/app/remote/runtime.ts#createRemoteBackendRuntime` assemble ONE
  `Backend` (`BackendKind` now `'direct' | 'remote'`) from the M3-3A bundle
  plus the M3-3B interaction, config and archive adapters, with the exact
  `REMOTE_IMPLEMENTED_CAPABILITIES` advertisement. There is no Direct
  fallback, no second Connection and no production selection: M3-4 owns the
  main-application cutover.
- The BASE Host owns `UserQuestionService` (`@deepseek-ai/dsh-base` mounts
  `id: user-questions`). `src/app/remote/host-runtime.ts` REQUIRES that existing
  service (a Host prerequisite) and verifies its stable Typert binding identity
  is unchanged across the M3 composition; it never mounts a second copy — a
  duplicate mount would replace the namespace owner and register the
  `userQuestions` Session projection unit twice. The Client side mounts the
  `@deepseek-ai/dsh-user-questions/remote` contribution
  (`src/app/remote/client-runtime.ts`).
- The forwarded-event seat is passed METHOD-BOUND: the Client `$on` reads its
  own service state, so a detached reference loses `this` (caught by the P11
  same-Host smoke).
- Generated Client namespaces are PROTOTYPE ACCESSORS. `sessions`, `settings`,
  `permissionPresets`, `agentPresets`, … exist only through accessors on the
  generated object, so spreading or rebuilding it (`{ ...source.remote }`, or
  copying its members into a wrapper) silently turns every namespace
  `undefined`. The adapters therefore keep the SOURCE object's identity and only
  pass event seats method-bound. `test/remote-config-port.test.ts` builds its
  wire the same way (non-enumerable accessors) and asserts that an own-property
  copy carries no namespace at all, so the shape cannot regress unnoticed; the
  same-Host smoke below reached a REAL Client and caught the defect that
  structural fakes had missed.
- The same-Host qualification (`test/remote-m3a-semantics-smoke.test.ts`) runs
  the assembled Remote backend over ONE real Host wire: the exact capability
  set, the rc.2 Question wire (live request → claim → timeout → late answer)
  plus reuse of the base `userQuestions` service and a subscription that
  follows a reconnect, the config plane reaching `ready` with a REAL settings
  write followed by the authoritative re-read, the complementary no-settings
  deployment still failing closed (unavailable diagnostic, no fabricated view,
  refused write), the session archive returning the upstream ZIP bytes, the
  backend/assembly interaction identity, and reverse disposal. The config plane
  is mounted by the fixture only — a profile directory separate from `home`, a
  bundle whose layer supplies the row's non-volatile fields, and app boot's own
  root `Include` fed the raw `insert`-dialect patch options — because the
  product composition must never mount `configEditor`/`settings` itself.
- `docs/m3-entry-contract.md` §1.3/§2.1 `interaction` row is reconverged:
  rc.2 publishes the full Question contract, no capability detection and no
  rc.1 fallback lane exists.

### M3-3B semantic / UI impact matrix

| Capability | User-visible state/action | M3-3B disposition | Authority |
|---|---|---|---|
| ordinary Question (blocking) | current QuestionFlow | `IMPLEMENTED`, preserved | forwarded waterfall |
| timed Question claim | claim opening + remaining time | `IMPLEMENTED` | Host `attachWait` frame + Client clock |
| timed timeout | Agent continues; Question remains answerable | `IMPLEMENTED` (no Turn/question cancel) | Host wait + projection |
| continued late answer | editable Question reachable after continuation | `IMPLEMENTED` | `userQuestions` projection + `answer` Remote |
| queued late reply | no duplicate editable submit; read-only notice | `IMPLEMENTED` | Inbox projection |
| final late answer card | final answer text/summary | `IMPLEMENTED` | `userQuestions.settled` |
| Question reconnect | answerability re-derived, no local reconstruction | `IMPLEMENTED` | Session projection + Inbox |
| Question draft | current TUI draft semantics | `IMPLEMENTED`, local-only | QuestionFlow/controller |
| approval request | current panel | `TERMINAL_NATIVE_EQUIVALENT` | forwarded waterfall |
| approval policy Remote | settings row unavailable | `INTENTIONALLY_UNSUPPORTED_WITH_REASON` | no public carrier |
| TUI settings | current values + writes | `IMPLEMENTED` | settings mirror |
| config reconnect | current/last-known/reconnecting truthfulness | `IMPLEMENTED` | Connection generation + mirror |
| API-key login | works | `IMPLEMENTED` | credentials Remote |
| OAuth/device login Remote | explicit unavailable | `INTENTIONALLY_UNSUPPORTED_WITH_REASON` | no public carrier |
| credential record list/delete | explicit limitation (rejects, never empty) | `INTENTIONALLY_UNSUPPORTED_WITH_REASON` | no public carrier |
| permission presets | selectable/apply/default | `IMPLEMENTED` | permissionPresets + settings + commands |
| Session export | same save UX on Remote | `TERMINAL_NATIVE_EQUIVALENT` | `/api/session.export` |
| Remote Backend existence | no production UI switch yet | `NO_USER_VISIBLE_CHANGE` | architecture stage only |
| generic Queue per-row actions | not implemented here | `DEFERRED_WITH_OWNER: Post-M3 Q1` | official inbox semantics |
| clientTimeZone | not corrected here | `DEFERRED_WITH_OWNER: Post-M3 T1` | official Client request metadata |

This matrix predates the reachability classification in §Migration process and
qualification governance; M3-4 onward matrices carry an explicit `Reachability`
value per row.

### Validation evidence

`test:product` (6436 passing) + `test:fork` (1178), `typecheck:*`, the
client-boundary and naming/architecture/keybinding gates, `gen:dsh-presets` +
parity, `compat:dsh:npm` (tarball × DSH 0.2.0-rc.2), the same-Host Remote
parity smokes, and the source-mode verification against the exact rc.2
release commit.

### Closure evidence

- Contract authority: DSH `0.2.0-rc.2` at
  `639ed015397290b3745d163aafe02ffee4aa3f84`; `docs/m3-entry-contract.md` §2.1
  (separate Approval/Question rows), §2.3 and §2.4.
- Composition owner: `src/app/remote/runtime.ts#createRemoteBackendRuntime`
  (`src/runtime/remote/backend-remote.ts`) over the M3-1 composition spine;
  `RemoteHostRuntime` reuses the base `userQuestions` service.
- Adapter-level evidence (L1–L3): `test/remote-config-port.test.ts` plus the
  M3-3B interaction/archive adapter suites.
- Direct ↔ Remote parity (L4): n/a for the M3-3B-specific Config / Question /
  Archive closure; the existing parity smokes remain broad regression coverage.
- Wire evidence (L5): `test/remote-m3a-semantics-smoke.test.ts` same-Host
  qualification (rc.2 Question wire, a real settings write with authoritative
  re-read, the archive ZIP bytes, reverse disposal).
- Application/surface evidence (L6) (Question surface):
  `test/runner-viewer-task-integration.test.ts` over the real runner — a parked
  continued Question is reachable through the literal `↓` Quick Tasks path and
  reopens the same `QuestionFlow`, and the Full Task Center (`/tasks`) parked
  path proves live authority removal/restoration when a queued reply appears and
  is discarded.
- Application/surface evidence (L6) (complete Remote main Backend): n/a in
  M3-3B — M3-4 owns the main-application cutover.
- Supported success path: a real Config write mutating Host authority, the real
  `/api/session.export` ZIP, and a live Question running request → claim →
  timeout → late answer.
- Fail-closed/error paths: no-settings deployment reports unavailable and
  refuses the write; approval policy returns `false`/`undefined`; credential
  records reject; OAuth/device login states unavailability; archive 404 →
  `none`, 500 → `unavailable`.
- Reachability/UI disposition: recorded in the M3-3B semantic/UI impact matrix
  above.
- Forbidden fallback verified: no second `userQuestions` mount, no
  `{ ...remote }` copy, method-bound `$on`, generated namespace identity kept.
- Original-plan closure review: not recorded — M3-3B closed before this
  protocol existed.
- Deferred items promoted to Debt: none in this change; the matrix carries
  `Post-M3 Q1` (generic Queue per-row actions) and `Post-M3 T1`
  (`clientTimeZone`) as `DEFERRED_WITH_OWNER`.

## M3-4 PR2 — Main Session Read / Presentation / Status (COMPLETE)

PR2 makes an internally selected Remote main Session run the read/presentation
side of the REAL main TUI (plan: `temp/m3/dsh-pi-tui-m3-4-pr2-pr5-sequential-
execution-plan-20260930.md` §7). Direct remains the production default; the
Remote composition is reachable only through the internal selection seam (a
pre-selected aggregate — no CLI/config/env selector exists).

### What landed

- **Application presentation-source handoff (§7.4)**: the Remote application
  aggregate (`app/remote/application-runtime.ts`) now constructs ONE
  branch-specific presentation bundle (`app/remote/presentation-source.ts`,
  satisfying the transport-neutral `RemoteApplicationSources` declared in
  `app/application-runtime.ts` — the bootstrap holds no static `app/remote`
  edge): the M3-3A `presentationReader` BY IDENTITY, the official
  `SessionSnapshot.pendingSubmissions` echo source
  (`RemoteSubmissionPresentation`), the eventSource live-ingress factory, and
  the Session-scoped official facts (sessionStatus / plan projection /
  running bit). The internal L6 composition entry is
  `applyRunnerWithRuntime(ctx, config, override)`; the production `apply()`
  stays Direct through the unchanged seam (source-locked).
- **Cold hydration through PresentationReader (§7.5)**: the presentation
  owner's ONE shared hydrate body now serves both branches — Direct keeps the
  full-log snapshot + live baseline; the Remote branch reads the bounded
  official window (`PresentationReader.read`), merges the opening-journal cut
  by seq, replays the reconstructed live inputs, and derives the same
  presentation-only folds (goal/title/todo/compaction). The bounded-window
  working fold falls back to the official `SessionSnapshot.running` bit only
  when the window cannot prove a turn boundary (see the closure condition
  below).
- **History paging (§7.6)**: the fullscreen transcript boundary gesture
  (`onTranscriptMoveOlder` at the loaded floor) dispatches ONE official
  `PresentationReader.loadOlder` page + a window re-hydrate
  (`rehydrateFromWindow`) — never a hand-rolled page chain; Direct returns
  false (its fold already holds the complete log).
- **Live ingress (§7.6)**: `app/remote/live-ingress.ts` subscribes the CURRENT
  binding's `eventSource` and feeds the EXISTING canonical pipeline — durable
  appends through `surface.routeSessionEvent`, transient `assistant/live-chunk`
  entries mapped onto the neutral `AssistantLiveInput` plane (one synthetic
  `start` per attempt tuple, the read-side partition rule), `replace` windows
  (reconnect/gap repair) triggering the full re-hydrate. Identity is the exact
  binding object + Connection generation; a stale publication detaches itself.
- **Pending-input / submission presentation (§7.7)**: the submission
  controller's presentation source is now INJECTED — Direct keeps its ledger;
  the Remote branch reads the official `pendingSubmissions` (the ONE
  optimistic identity there; the TUI runs no second Remote ledger). The
  pending-presentation join stays the single UI join.
- **Status projection convergence (§7.8)**: `SessionStatusProjection` gained
  the official `agentPreset` fact (both adapters map the same projection);
  the status owner reads the Remote-branch facts bundle (sessionStatus /
  plan wire view) for the Agent-shaped facts — welcome card, model label,
  composition section, cwd — never `agent.options`, never a parent fallback,
  never a zero-filled guess. Measurement fences bind by the current session
  id on Remote.
- **Lifecycle (§7.9)**: the resume quiesce uses the SELECTED runtime's
  retirement (`selectedRuntime.retirement.whenIdleOrAbort`); the Remote
  turn-end flush hook is a DELIBERATE no-op (no public Client flush verb; no
  hidden Host `sessions.flush`); the `--session` resume reads the recorded
  preset from the official projection and skips the launch-preset WRITE
  (read/presentation-only scope); switch/new/fork drive the same session
  runtime seams with `initLiveSession` dispatching to the Remote surface
  init for Remote-owned generations.

### Current-value facts are PROJECTION-owned, never window-folded

The Remote event window is BOUNDED (the official loader returns at most the
last ~2 turns / >=50 messages), so it must never be treated as session-global
current-state authority. On the Remote branch every CURRENT-VALUE fact is read
from its OFFICIAL projection/status source and the window fold is only the
fallback while that projection is unavailable:

| Fact | Official owner | Window fold on Remote |
|---|---|---|
| title | `title` projection | NEVER: an unavailable projection OMITS the title |
| goal | `goal` projection (its legal `null` = "no goal" is honored) | NEVER |
| todos | `todos` projection (the standing list of the current turn) | NEVER |
| token usage / cache rate / context capacity | `tokenUsage` + context projections (lifetime) | NEVER (a partial fold cannot count a lifetime) |
| cwd | the official session status/list row | NEVER (it is not an event at all) |
| plan / preset / model | `plan` / `agentPreset` / `modelSelection` projections | NEVER |
| transcript rows, working/busy, compaction, the recent-window performance metrics (TTFB / tok/s) | the official event window | the event window IS the authority (these facts ARE window-scoped) |

The rule is UNIFORM: on the Remote branch an unavailable projection yields
**unknown**, and unknown OMITS the fact — the bounded window never stands in
for a session-global value (a recent window is not a session's current title,
goal or standing todo list, and a lifetime billed sum is not the current
context occupancy). `UsageStatus.tokens` is therefore optional and the usage
section omits it (the footer formatters drop the token segment) when the
official counters cannot answer; the occupancy numerator is the official
context measurement only. `null` (no goal / no `todo/write` yet) and an absent
field both hide the fact, so the two dispositions are indistinguishable in the
UI by construction. The DIRECT branch is unchanged: there, the COMPLETE log is
the fold authority for these same facts. The goal badge uses ONE shared text
rule for a projection fact and a log event (`goalTextOf`).

The facts are also **live**, not once-per-hydrate. The official projection
store is a push channel, and the official feature contract exposes it as
per-key faces (`session.projections.faceOf(key).subscribe`) — the Session
snapshot never carries projection values. The Remote ingress subscribes to the
keys it presents (`CURRENT_PROJECTION_KEYS`, the list the semantic reader
reads), coalesced per frame, fenced by the exact retained binding, and on a
change re-applies the projection-owned facts and refreshes status/welcome. So
a model/preset/title/goal/todos/usage/context change made by the Host or by
another Client reaches this surface immediately instead of waiting for an
unrelated refresh (the Remote event routing for `model/selection` is
deliberately a no-op — no live Direct agent — so the projection channel is the
ONLY path).

`test/runner-remote-presentation.test.ts` proves the divergence cases directly:
title/goal/lifetime-usage whose source events sit OUTSIDE the truncated window
(mutation-verified — dropping the projection feed loses the title and the
lifetime counters), and a `modelSelection` value changed AFTER the surface
settled (mutation-verified — with an empty key list the footer keeps the old
model).

### Connection generation rollover (a defect this evidence found and closed)

Strengthening the reconnect evidence exposed a REAL production defect: the
live ingress retired itself whenever the Connection generation OBJECT changed,
so a reconnect (network loss, recovery) left the Remote surface permanently
dead for an unchanged subject — nothing re-establishes that subscription. The
contract is now explicit:

* the exact retained **binding object** is the ONLY retirement condition (a
  same-id rollover replaces it);
* a **generation rollover** does not retire the binding: the ingress ADOPTS
  the new generation and forgets the dead generation's window revision, so the
  next publication drives the authoritative re-hydrate through the normal
  `replace` path (or routes the new durable entries). It must never be
  swallowed as a duplicate revision, and it must never re-hydrate the DEAD
  window;
* the projection/snapshot value channels fence on the binding only: their
  values are live reads of the current store, so a rollover neither detaches
  them nor lets a stale value through.

### In-stage known boundaries (active M3-4 findings — NOT promoted to Debt)

- **Host command-name collisions (e.g. `/export`)**: the Remote Host
  composition mounts `session-log-export`, which registers a Host `/export`
  alongside the TUI built-in. Registration is PER-NAME isolated, and the
  isolation is NARROW BY CONSTRUCTION (M3-4 PR2): ONLY the official
  registry's duplicate-name refusal (`command "<name>" is already registered`)
  is tolerated, so the colliding name fails loudly with its exact name in the
  user notice and the diagnostics while later registrations install. Every
  other throw from the registry — an invalid name/description/handler/input,
  or a Cordis lifecycle failure — still fails fast (exactly as before), so a
  programming error can never degrade into a silently partial command
  surface. The command-plane split (Client-local registry vs
  `HostCommandPort`, plan §9.3) is the M3-4 command PR's ownership; M3-4
  closure must prove Remote session export works.
- **Lifetime turn/step counters on Remote**: the token/cache counters and the
  route context capacity come from the official `tokenUsage`/context
  projections (a bounded window cannot count a session's lifetime), while the
  RECENT-window performance metrics (TTFB / tok/s) and the turn/step counters
  still come from the bounded window's fold, because they are window-scoped
  facts. The
  lifetime `sessionStats` projection and its UI row are the command PR's
  ownership (plan §9.4).
- **Per-subject history paging latch**: one Remote `loadOlder` extension is
  in flight per SUBJECT, not per runner — a page still loading for the
  previous session cannot swallow the new session's first boundary gesture.
- **`refreshLiveCatalog` on Remote owners stays a no-op**: catalog-refresh
  currentness over the binding generation is the command PR's ownership; the
  startup prefetch snapshot remains the catalog until then (PR4-owned
  unavailable behavior, not a completed Remote catalog).
- **Launch-preset on Remote**: the requested preset is ALWAYS forwarded to
  the official `session.create({agentPreset})` — the Host is the single
  authority (an unknown/broken preset is refused at create time). The roster
  preflight only shapes an EARLY UX notice (a broken roster answer warns
  before the create); it never drops the requested value, and a preflight
  ERROR (an unreadable roster) logs without changing the create input. The
  `--preset` resume WRITE is skipped on Remote in PR2 (read-only scope); its
  final seam is verified with the preset lifecycle in the command PR.

### Working-fold proof hierarchy (the §7.5 equivalence closure)

The bounded-window working/busy fold follows a two-level proof hierarchy,
locked by `test/remote-working-fold-equivalence.test.ts`:

0. The compaction consumer's cache (`currentWorkingFromLog`) is keyed by the
   ownership generation + session id AND the Remote transport token it was
   captured under; the cold hydrate SEEDS it (no first-use window) and a
   window replace/reconnect INVALIDATES it (the old window's proof is void).
1. A COMPLETE window (`hasMore === false`) ALWAYS prefers the
   `workingFromLog` fold — including the transient wake gap where the
   official `running` bit has already flipped but the durable `turn/start`
   has not landed, and including the EMPTY window (the fold is false by
   definition: no turn is open). This is deliberate DIRECT PARITY: the
   canonical presentation is event-driven, and the Remote branch must not
   lead it. BOTH consumers follow the rule: the cold hydrate and the
   compaction-settle `currentWorkingFromLog` (once a complete-window fold
   landed, the running bit cannot override it).
2. A TRUNCATED window (`hasMore === true`) proves nothing about the LATEST
   boundary, so the official `SessionSnapshot.running` bit is the
   authoritative presentation fact. The upstream invariant (verified against
   the rc.2 agent-loop source): `running === false` ⇒ every turn has a
   durable `turn/end` (the driver exits only after the last `turn()`
   returns), so the fallback can never answer `true` where the fold would
   answer `false`; `running === true` covers the wake window before
   `turn/start` and mid-turn windows — both are the UI working fact.

### L6 evidence (plan §7.10/§7.11)

`test/runner-remote-presentation.test.ts` — the REAL runner
(`applyRunnerWithRuntime` + a pre-selected aggregate) over a REAL rc.2 Host
Context (the shared fixture + the TokenMeter/toolTodo/session-title/goal
projection rows + a scripted real `LlmAdapter`) → the official in-process
carrier → a real Client:

- Remote resume → the official window's transcript rows painted ONCE (no
  duplicate identity, no TUI ledger);
- CURRENT-VALUE facts whose SOURCE EVENTS precede the truncated window
  (title, goal, lifetime token usage) still render — the official projections
  own them; the bounded window is never their authority. Mutation-verified:
  without the projection feed the title and the lifetime counters disappear;
- navigation/currentness, each with POST-operation evidence that cannot be
  satisfied by keeping the old surface:
  - switch (`/resume <other>`): the new subject's rows paint and the replaced
    subject's rows retire;
  - same-id rollover (away and back): the official binding object captured
    while the id was current is asserted `notStrictEqual` the one retained
    after the rollover — the replaced exact binding the fences key on;
  - reconnect (`connection.reconnect()`): a durable turn AND a
    `modelSelection` value are committed synchronously after the previous
    Connection generation is aborted, so only the NEW generation's
    authoritative baseline (durable window + projection values) can put them
    on screen — the aborted generation is asserted not to have delivered them;
  - `/fork`: the child is identified from the Host session list, asserted to be
    a DIFFERENT id carrying the official `parentSession` lineage and to be
    retained by the Client, and discriminated by a CHILD-ONLY turn appearing
    while a PARENT-ONLY turn never does (a surface stuck on the parent shows
    the opposite);
  - `/new` re-initializes onto a fresh session with no rows carried over;
- a projection-owned value changed by another writer AFTER the surface settled
  (`modelSelection`) reaches the status through the official projection faces
  (mutation-verified);
- the pending dispositions are proven ONE BY ONE on a session the OFFICIAL
  Client reports as `running` (a held real turn): a `queue`-mode echo lands in
  the QUEUE pane (never the tail), a `steer`-mode echo lands in the TAIL user
  lane with `steering`, a non-user `next-step` inbox occurrence lands as the
  generic CONTEXT tail row (never the user lane), and the identified prompt's
  durable admission retires the echo BY IDENTITY while the authoritative row
  takes its place;
- REAL Host-side `agent/assistant-stream` frames → the official wire → the
  eventSource transient entries → the live chunk painted through the
  canonical pipeline;
- `loadOlder` extends the durable window through the OFFICIAL loader without
  replacing the subject. The full SURFACE_REACHABLE chain is proven
  dynamically: a REAL PageUp boundary gesture through the mounted surface
  (real runner + real wire) extends the loaded official history
  (mutation-verified: without the gesture the extension never happens);
  the gesture dispatch and the production surface fall-through are
  additionally locked in `test/transcript-history-extension.test.ts`;
- `sessionStatus` absent-field discipline (an unretained session reads
  `undefined`, never guessed facts);
- zero Direct graph construction on the Remote selection;
- the OFFICIAL pendingSubmissions echo drives the pending-presentation join:
  a real `beginSubmission` on the retained binding surfaces its text through
  the rendered pending rows (this closed a REAL PR2 defect — the Remote
  pending SUBJECT read `agentNow()` alone, so the pending pane never joined
  on the Remote branch; it now falls back to the current ownership session).

Supporting contract suites: `test/remote-live-ingress.test.ts` (the
ingress's own change partition, staleness detach by generation AND exact
binding identity, the hydrate→subscribe gap recovery, settle-assistant
routing, the replace tuple reset) and the §6.5 fence cases inside
`test/remote-working-fold-equivalence.test.ts` (a superseded owner commits
NOTHING; a current owner commits normally).

Fixture manifest discipline follows the shared fixture header: the only
SEMANTIC stand-in is the (unsupported) prompt serializer; the LLM endpoint
stand-in streams real chunks through the real Host agent loop. DELIBERATELY
NOT CLAIMED: production Remote submission, command catalog/execution, tool
cards, permission cycle, rewind, secondary surfaces (their owning PRs).

### PR2 UI/UX impact matrix (plan §5 / §7.10)

Every changed user-observable semantic, with the plan's §5 field set. Two
tables share the same row keys (the field set split for readability); a row's
`reachability` uses the plan's frozen vocabulary. "shared" means the Remote
row travels the SAME canonical presentation owner as Direct — PR2 introduces
no Remote-specific renderer, display mode, disclosure owner or viewport rule.

| # | Semantics | Semantic source (official) | Reachability | Surface | Visual state | Transition-in | Transition-out | Stale / reconnect | Session navigation |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Cold-resume transcript | `SessionBinding.eventSource` window | SURFACE_REACHABLE | transcript | the bounded window's durable rows render once, in official order | startup resume / switch / new / fork commit → `PresentationReader.read` | generation reset clears the folder; the next hydrate replaces it | `replace`/gap → authoritative re-hydrate; a replaced generation/binding drops the commit (§6.5 fences) | same path for resume/switch/new/fork |
| 2 | Older history | `Session.loadOlder` | SURFACE_REACHABLE | transcript (fullscreen history) | older rows become paintable at the loaded floor | fullscreen boundary gesture at the loaded floor | — (the window only grows) | a superseded/failed read is dropped | subject never replaced |
| 3 | Live assistant output | `eventSource` transient `assistant/live-chunk` | TRANSIENT (durable settlement supersedes) | transcript tail | live text in the pending assistant row, converging | ingress transient `append` | durable `assistant/message` settlement | a stale generation/binding detaches the subscription silently | same pipeline; inputs filtered to the current session |
| 4 | Reconnect | `SessionEventChange.replace` + `resync` | SURFACE_REACHABLE | transcript + status | the new window replaces the old baseline | reconnect `replace` change | the authoritative re-hydrate | this row IS the window replacement | — (no owner change) |
| 5 | Pending queued | official `pendingSubmissions` echo + `inbox` projection | SURFACE_REACHABLE | queue pane | the queued row in the existing pending styling | official `beginSubmission`, or the Host queue occurrence | durable user message / queue acceptance by identity | the snapshot channel re-joins; a new owner starts empty | reset at the generation bump |
| 6 | Pending steering | same | TRANSIENT | conversation tail (user row) | the ephemeral steering row | official echo placement `steering` | durable message by `requestId` | same | same |
| 7 | Pending context | `inbox` non-user occurrence | TRANSIENT | generic non-user context tail | the context row + waiting-next-step/turn label | Host inbox occurrence | next step/turn, or removal | same | same |
| 8 | Local echo → authoritative | `requestId` identity | SURFACE_REACHABLE | queue/tail → transcript | exactly one row, never duplicated | the matching durable/queue occurrence | identity handoff (never text equality) | the generation bump drops old echoes | same |
| 9 | Status: identity / running / working | list/binding `running` + the event-window fold | SURFACE_REACHABLE | footer activity + working row | the working/busy indication | turn-boundary events; a complete window folds, a truncated one reads the official `running` bit | turn end / idle | the fold cache is keyed by owner generation + transport token; a replace invalidates it | reset at commit |
| 10 | Status: cwd / model / preset | list-row `cwd`; `modelSelection`; `agentPreset` — all FOUR are official projections/status facts on Remote, never a window fold | SURFACE_REACHABLE | footer + welcome card | the session's OWN cwd/model/preset | the ingress snapshot channel | on projection change | an absent fact renders UNKNOWN/empty — never a client or global fallback | same |
| 11 | Status: plan / goal / todos / usage / context | `plan` / `goal` / `todos` / `tokenUsage` / `contextPressure` projections — the OFFICIAL current values, never the bounded window (its source events may precede it) | SURFACE_REACHABLE | footer plan state, goal line, todo dock, stats/context items | the session's own facts | projection/event updates | on change/settle | an absent projection is omitted | reset at commit |
| 12 | Access (permission / sandbox / approval) | Host permission/sandbox/approval services | PROJECTION_ONLY on Remote (unavailable) | footer badge / settings rows | Direct unchanged; Remote OMITS the section | — | — | — | omitted on Remote (§6.6) |
| 13 | Display modes | the ONE `TranscriptFolder` pipeline | SURFACE_REACHABLE | transcript | Full/Compact/Focus semantics identical to Direct | mode switch | — | — | unchanged |
| 14 | Fullscreen / narrow width | the shared window controller + renderer | SURFACE_REACHABLE | transcript viewport | follow-end/anchor and wrapping unchanged | fullscreen toggle / resize | — | — | unchanged |
| 15 | Session switch / new / fork | `app/session` transition + the `initLiveSession` seam | SURFACE_REACHABLE | all surfaces | the new subject's presentation | transition commit | the old owner's surfaces clear at the generation reset | a stale commit is dropped by the fences | this row IS the navigation |
| 16 | Unavailable projection | any absent official projection | PROJECTION_ONLY | omitted | nothing is shown | — | — | — | absent stays absent |
| 17 | Command-name collision | Host command registration (in-process) | SURFACE_REACHABLE | notification | the EXACT colliding name is named | TUI command registration | once per boot | — | — |
| 18 | Launch preset intent | official `session.create({agentPreset})` | SURFACE_REACHABLE | welcome card + notice | the new session runs the REQUESTED preset when the Host ACCEPTS it; a Host refusal surfaces as the create-failure notice | first-session / `/new` create with a launch or `/preset` intent | the session's own recorded preset takes over | a superseded create stays UI-silent | first-session and `/new` creates only (an existing session's preset is fixed) |
| 19 | Sessionless `/model` marker | the model-selection owner's in-flight intent (client-local) + the persisted official default | SURFACE_REACHABLE | footer model item | `m1 → m2 (selecting…)`, or `(unconfirmed)` for an ambiguous write | a sessionless `/model` selection | a COMMITTED save clears it; an UNRESOLVED one is reconciled by an authoritative Host read | an unresolved write keeps the explicit `unconfirmed` marker until a Host read establishes truth | a COMMITTED sessionless write becomes the persisted default that later sessions read; an UNRESOLVED intent is NOT seeded into creation (the create uses the actual Host default); a live session reads its own projection |

| # | Modes (Full/Compact/Focus) | Fullscreen | Narrow width | Search / disclosure | Interaction | Unsupported / error | Authority proof |
|---|---|---|---|---|---|---|---|
| 1 | shared folder — no Remote display mode | shared controller (anchor/follow-end) | shared wrapping | searchable via the shared search projection; disclosure owner unchanged | unchanged | an absent window yields no rows (never fabricated) | the ONE `TranscriptFolder` fed by the official `eventSource`; no second transcript |
| 2 | same | the existing fullscreen-only gesture | shared | search covers loaded rows | PageUp/wheel (existing) | a failed page leaves the viewport at the edge | the official `loadOlder` only — no hand-rolled chain |
| 3 | same | shared | shared | not search history until settled | unchanged | an abandoned attempt clears its previews | ONE ingress; no second stream tracker |
| 4 | same | shared | shared | — | — | a failed re-hydrate publishes nothing stale | the official window is the only source |
| 5 | shared queue pane | — | shared | not search history | the existing pane (per-row Queue actions intentionally not cloned) | an unavailable snapshot reads absent, not authoritative-empty | the official echo source is the ONLY Remote optimistic identity |
| 6 | shared tail | — | shared wrapping | ephemeral, not searchable | unchanged | same | identity join by `requestId` |
| 7 | shared tail (non-user) | — | shared | not searchable | none (display-only) | same | the Host projection owns the occurrence |
| 8 | shared | — | shared | — | — | a failed dispatch retires the echo | identity-only correlation |
| 9 | the working row in every mode | — | shared | — | Esc/cancel unchanged | a truncated window with no `running` bit reads not-working (fail-safe) | the fold + the official `running` bit; no second working state |
| 10 | footer items, mode-dependent layout | — | truncation preserves the label | — | — | unknown reads `no model` / empty cwd | official projections; the client cwd is never the session's workspace |
| 11 | dock/footer | — | shared | — | — | an absent projection is omitted | official projections; the goal text uses the ONE shared goal-text rule for both the projection fact and a log event |
| 12 | — | — | — | — | Shift+Tab cycle is a no-op on Remote (no live Agent) | Remote availability is explicit (absent), never a guessed `ask`/mode | §6.6 — an unsupported capability stays unsupported |
| 13 | these ARE the modes under review | — | — | — | — | — | no Remote-specific display state exists |
| 14 | — | unchanged | unchanged wrapping/truncation | — | — | — | shared |
| 15 | shared | shared | shared | search state resets per generation | — | — | the generation reset + exact-generation fences |
| 16 | — | — | — | — | — | this row IS the unsupported disposition | the shared mapper's absent-field discipline |
| 17 | — | — | — | — | — | the notice names the exact command | per-name isolation; the Host owns its command |
| 18 | shared notice/welcome rendering | — | shared notice wrapping | — | unchanged | a broken roster answer warns EARLY; the requested value still reaches the Host, whose refusal is the single authority | the Host create owns preset admission; the client preflight never drops or substitutes the requested value |
| 19 | the shared footer item | — | truncation preserves the label plus the marker | — | unchanged | an UNRESOLVED write keeps the explicit marker until an authoritative Host read reconciles it; a FAILED write walks the operation ancestry newest-first — a committed ancestor clears it, a nearer unresolved ancestor KEEPS its explicit marker, a pending ancestor restores the intent, and with none of those it clears | the marker is presentation-only client intent; the authoritative value stays the official default/projection |

### Validation evidence

The full suite (`pnpm test:bundle`) passes on the settled tree, including the
new L6 suite (gesture-driven history paging, session-status and
pending-join evidence), the live-ingress contract suite, the working-fold
equivalence + §6.5 fence cases, and the updated A2/A4 ownership locks
reflecting the branch-safe Direct-read shapes. `pnpm build`,
`pnpm typecheck`, `gate:architecture` (single dynamic Remote edge intact),
`gate:boundary` (no new Host coupling), the regenerated A5b root-declaration
matrix, the docs lane, and the updated deprecated-reader allowance (the
Remote `currentWorkingFromLog` folds the official window; the Direct
allowance text tracks the branch-guarded line) are all green.

## M3-4 status (IN PROGRESS — PR1 landed)

M3-4 composes the main TUI application over the Remote Backend. The stage is
a PR train; each PR closes its own slice with closure evidence.

### PR1 — Application Runtime Selection Spine (COMPLETE)

What landed (composition foundation ONLY — the full main TUI is NOT
Remote-ready):

- `src/app/application-runtime.ts`: the transport-neutral
  `SelectedApplicationRuntime` core — `kind` / `backend` / `owners` /
  `retirement` / `disposeTransport()`. It groups the already-required
  application composition ownership; it is NOT a new Backend SDK, imports no
  Host package and no `app/remote/**` / `runtime/remote/**`.
- `src/app/remote/application-runtime.ts`: the ONE Remote application
  runtime aggregate — `createExperimentalRemoteRuntime` (ONE Host + ONE
  Client wire) -> `createRemoteBackendRuntime` (ONE semantic assembly /
  Backend) -> `createRemoteSessionOwnerServices` (ONE owner registry shared
  by `owners` + `retirement`). The aggregate calls no constructor twice,
  constructs no Remote adapter itself, and `selected.backend` IS
  `backendRuntime.backend` (identity, never a copy). The `promptSerializer`
  is an injected dependency — PR1 injects it only in composition tests; no
  partial/production serializer is invented (that is the M3-4 submission
  PR's ownership).
- `disposeTransport()` owns exactly `backendRuntime.dispose()` then
  `wire.dispose()` (adapters before Client, Client before Host additive
  fibers), is idempotent and error-preserving, and never retires the
  currently selected Session (`app/session` keeps that ownership). A backend
  construction failure after the wire exists disposes the wire (original
  error surfaces, disposal failures ride its cause chain).
- `src/runtime/backend-loader.ts` stays the only dynamic-import owner with
  the ONE frozen dynamic edge into `app/remote/**`: the single entry module
  `app/remote/runtime.ts`, which statically re-exports the application
  runtime aggregate (an intra-`app/remote` static edge, never a second
  dynamic target). The architecture gate enforces the single owner, the
  single import expression and the single target. No static Remote edge
  exists anywhere reachable from `startup.ts` (its graph is unchanged).
- `src/app/bootstrap.ts`: the internal application runtime-selection seam
  (`selectApplicationRuntime`). The Remote branch is the SEAM's own
  ownership: it loads the Remote application aggregate through
  `runtime/backend-loader.ts` (the sole sanctioned dynamic boundary, making
  this seam the one product-level Remote construction owner) and composes it
  with the caller's Remote composition input; the Direct branch constructs
  the Direct runtime through its factory (a Remote selection constructs no
  Direct graph). The common session-runtime inputs
  (`owners`/`retirement`/`lifecycle` via `backend.sessionLifecycle`) and the
  `backend` constant now read from the selected core; Direct-only helpers
  (compose/agentFor/queueAgentFor/modelSelections/installAssistantStream/
  hasParkedOwners...) stay on `directRuntime` untouched. Normal package
  `apply()` selects Direct — no CLI option, config field, env var,
  cordis.patch backend row or public root export selects Remote.
- Teardown: the fiber disposer and the pre-mount abort path await the
  selected transport disposal AFTER the session retirement completes. The
  terminal-total fatal catch disposes it only when the (bounded) retirement
  settled — a timed-out or unknown retirement state intentionally leaves
  the transport undisposed rather than racing it (plan §4 ordering, never
  the reverse). Direct is a no-op on every path, and the Direct retirement
  ordering itself is unchanged.

Closure evidence for PR1:

- Composition/wire proof (below the real runner, NOT L6):
  `test/remote-application-runtime.test.ts` — ONE Host/Client/Backend/owner
  registry (identity assertions); a retained handle -> exact owner ->
  retirement releases the exact reference; MEASURED `disposeTransport`
  ordering (the adapter dispose fires before the Client Context disposal,
  which samples the M3 Host rows as still present; the Host rows are removed
  only after the whole disposal) + idempotence + ordinary-Host survival;
  error-preserving disposal (a real adapter-side dispose failure surfaces
  while the wire still unwinds); a Host-side wire construction failure
  (before any Client) unwinding with zero leaked fibers/registry rows; and a
  post-wire application composition failure (induced after the Client
  exists) unwinding the Client + Host additive fibers with the original
  error surfacing.
- Selection proof: `test/application-runtime-selection.test.ts` — Direct
  selection never loads the Remote module and carries the exact Direct
  instances; Remote selection invokes the loader exactly once, invokes NO
  Direct factory, and returns the ONE aggregate; missing lazy boundary fails
  closed; the production bootstrap calls the seam with the Direct branch
  only.
- Boundary proof: `test/pre-m3-architecture-gate.test.mjs` — the M3-4
  `bootstrap -> backend-loader -> dynamic app/remote/application-runtime`
  shape is the sanctioned one; any other dynamic importer and any static
  Remote edge (including from startup) still fail.
- Construction-failure closure (plan §12): `createRemoteBackendRuntime` is
  TRANSACTIONAL — a failure at any point after the first constructed part
  (semantics bundle, ConfigPort with its mirror subscriptions) reverse-unwinds
  every constructed part before the caller sees the rejection, so backend
  partial state never survives and adapters are always disposed ahead of the
  Client the caller then unwinds. The regression
  (`test/remote-backend.test.ts` "post-adapter construction failure") injects
  exactly in the adapters-constructed / factory-not-returned window (a
  throwing `fetch` getter, read after the semantics + config construction)
  and observes the real subscription release; it was mutation-verified (the
  test fails with the unwind disabled). The aggregate's own post-wire failure
  path (D2) covers the before-backend stage.
- Regression support: `test/remote-client-runtime.test.ts`,
  `test/remote-backend.test.ts`, `test/remote-session-owners.test.ts`,
  `test/session-runtime-remote-owner-handoff.test.ts`,
  `test/a2-ownership-cutover.test.ts`, `test/a5b-root-matrix.test.ts` all
  green on the adapted seam.

Frozen-plan reconciliation (explicit deviations, review-driven):
- Dynamic boundary: the plan's "ONE dynamic edge into `app/remote/**`" is
  preserved LITERALLY — one owner, one import expression, one target. The
  aggregate is reached through `app/remote/runtime.ts` (the single entry,
  which statically re-exports it), NOT through a widened two-target gate; a
  regression test fails on any second dynamic target or expression.
- L5 fixture substitutions: beyond the plan-sanctioned prompt serializer,
  the composition fixtures carry the proven M3-1 L5 minimal readiness inputs
  (`StubLlmAdapter` smoke route; hand-provided `agentDefaultModel` /
  `attachments` / `webServer`). These are declared in the fixture manifests
  (not presented as "serializer-only"). They do not weaken the
  composition-identity / disposal-ordering / failure-unwind proofs because
  those proofs never traverse the substituted paths — with the precision
  that the LLM adapter IS registered on the required Host `llm` service
  (part of the composed graph); no proof in these suites invokes it (no
  model turn runs), and the other values carry no Remote-wire state.

What PR1 does NOT claim: the TUI does not run remotely yet. Remote transcript
hydration, eventSource presentation, status projection, the production
submission serializer, command runtime, tool cards, rewind, images, local
shell, permission cycle and secondary surfaces are later M3-4 PRs (PR2+
consume the seam without re-deciding runtime/Connection/owner composition).
