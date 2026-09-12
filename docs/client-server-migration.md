# Server/client migration — source of truth

> This document is the migration's source of truth (AGENTS.md "Server/client
> migration guardrails (hard rules)"). **Read it before touching
> Host-coupled code**; update it in the same PR as any phase work. The
> coupling allowlist lives in `docs/client-server-coupling.md`; the hard
> rules live in AGENTS.md.

## Status

```text
M0  DONE           (AGENTS.md guardrails, coupling inventory, boundary gate, baseline)
M1  DONE           (semantic ports + Direct adapters, no behavior change — M1.1–M1.12 landed: subagent, session read/write/lifecycle, interaction, catalog (models/presets/skills), config (settings/provider profiles/credentials/authorization/permissions/preset default), host-file (`@`-mention discovery + send-time canonicalization), and Agent-local model selection (durable Session intent plus global fallback); CommandHostCapabilities retired, `runner.host` removed, commands read Host state ONLY through ports; Direct ownership escapes (lock/lease/PINNED/guard/transition/barrier) untouched at M1 — the physical lock stack is removed legacy on the master baseline; contract review: authorization is an EVENT surface (begin → attemptId → notice/prompt events → respond/cancel — never a callback-bearing interaction across the port), Host-file candidates are PATH-ONLY DTOs (`{path, kind}`, the official FileReferenceCandidate shape — ranking/quoting/presentation are client policy in mentions.ts), the catalog directory DTO is semantic (no settings namespace/path), the /login credential options cross as the port's `CredentialProviderOption` DTO (semantic flags only — `canProvisionProfile` replaces any namespace/path, one adapter-owned rule drives both the flag and the write-time validation), keyless profile writes return written/skipped, and viewer follow-ups canonicalize against the CHILD workspace)
M2  IN PROGRESS   (D1 COMPLETE: D1.1 Session read shadow, D1.2 command/skill authority read shadow, and D1.3 subagent/task + presentation read parity; writes remain unimplemented)
M3  NOT STARTED   (experimental in-process wire: Semantic Port + Remote Adapter + DSH Connection)
M4  NOT STARTED   (experimental local Host process / IPC split)
M5  NOT STARTED   (external attach; localhost/SSH only)
M6  NOT STARTED   (production dual stack: direct default, wire opt-in)
M7  NOT STARTED   (default flip; direct rollback kept for >= 1 release)
M8  NOT STARTED   (Direct ownership retirement — only after concurrency proof)

Current production backend: direct
Experimental backend:      none (no complete Backend(kind=remote))
Experimental Remote:        read-shadow only (diagnostic/test opt-in)
Remote writes:              none
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
unload, and post-commit session transitions). The retirement is a
**Direct-only ownership escape** (`src/runtime/direct/owned-session-retirement.ts`,
structural callbacks only — no semantic-port change, no new Host coupling)
retained until M8 and is NOT a Remote session-close semantic. A future
Remote client closes its client-side observation/connection state through
official DSH client contracts; this fix does not invent a host
session-destroy RPC, does not add `close()`/`dispose()`/`drainSubagents()`
to the `SessionLifecycle` port, and does not expose
`drainContinuableDescendants` as a cross-backend capability. The ownership-
retirement portion remains pending; D1.1 does not change this Direct-only
semantic, and Direct remains the production backend.

### Lifecycle creation cancellation (Stage B / pre-M2)

`CreateSessionRequest` and `ResumeSessionRequest` may carry a client-local,
creation-only `AbortSignal`. In Direct mode the session lifecycle adapter maps
that signal to `ctx.agents.create` / `ctx.agents.resume`; the signal is valid
only through persistence load, unpublished setup, and publication, and is
never serialized. A future Remote adapter must map it to official
connection/client operation cancellation rather than sending the `AbortSignal`
over the wire. Stage B completes this contract and is not Remote backend work.

### Finalized content presentation (Stage C1 / pre-M2)

Stage C1 presents already-finalized `ContentBlock` values without changing
stream lifecycle or Host ownership. Transcript-facing flat projections retain
image and file attachment markers; FileBlocks render from durable name/byte
metadata only; and unknown finalized blocks use an explicit bounded JSON
fallback. The shared visibility rule covers transcript search and rewind
candidate eligibility/warnings; rewind preview/editor restoration remain
text-only by policy. Readable markdown export uses the richer projection.
Queue/steer/dequeue behavior remains outside this finalized-only stage; only
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
| M5 | `dsh-pi-tui attach <url>`; localhost + SSH tunnel only; remote `!` disabled until a Host-side shell seam; remote external editor unsupported | Security review; fail-closed locality checks |
| M6 | Production dual stack: `--backend wire-local` opt-in, direct default; extension CI matrix (direct × wire-local) | One stable observation cycle; no perceptible regression |
| M7 | Default flip to wire-local; `--backend direct` rollback kept for ≥ 1 release | Rollback verified on the release train |
| M8 | Direct ownership retirement (the SessionHandle `direct` escape — live Agent/AgentHandle; the physical lock stack is already removed legacy) | Proof: all TUI writes Host-owned, cross-client concurrency safe (Web+TUI, TUI+TUI, reconnect, cold resume, Host crash) |

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
  `serviceFor` / `standingKeyFor` discovery; the sessionless staged-preset
  catalog (`StagedPresetSkillCatalog`) stays client-side because no session
  exists yet to attach a Remote to.
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

### Session log access (alpha.4)

`Session.events` was REMOVED as a public getter in alpha.4. The official
reads are `session.seq` (the next event's offset — the count without
materializing the log), `session.eventAt(SessionSeq)` (one exact event), and
`session.snapshotEvents(from?, toExclusive?)` (a cached immutable range
snapshot; the TUI uses it only where a complete raw fold is genuinely
needed — transcript export, rewind/fork seeds, cold hydration — never for a
count or a last-event peek). A future Remote adapter maps these onto the
official client session contract; nothing in the TUI may regress to a live
`events` array (`scripts/check-no-session-events.mjs` gates `src/`).

### Subagent human prompt (alpha.4)

The interactive viewer's human prompt maps 1:1 onto the official
`subagent.prompt` remote:

```text
viewer Enter
  ↓ SubagentPort.prompt (client-semantic DTO)
  ↓ Direct: ctx.subagents.prompt({ requestId, parentSessionId,
      childSessionId, mode: 'continuable', content, clientTimeZone? })
  ↓ child inbox — a distinct FIFO turn, user provenance
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

`transcript-window` remains only Client presentation/window state. It owns
none of: history authority, paging cursor, reconnect, gap repair, or session
projection folding.

### Remote image submission

A future Remote Adapter should submit images through the official
`PromptContentPart[]` path (the same part vocabulary alpha.4's subagent
prompt accepts):

```text
PromptContentPart[]
→ Session.prompt(...)
→ Host-side image admission
```

The Client owns temporary/staged image bytes only. The Host owns:

- attachment admission (`admitPromptContent` promotes image parts to durable
  `ImageAttachmentRef`s before any message is created),
- durable attachment refs,
- the final `UserMessage`.

Do not treat a Direct-mode generated DSH `UserMessage` as the future
cross-process protocol: the wire caller must never cite an attachment it did
not upload.

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
  CI runs this release-family job only in npm mode; Source Mode runs the same
  parity scripts against the pinned source distribution in the Source checks
  lane. A different npm release is a local-only probe via
  `pnpm compat:dsh:client-family -- --dsh-version <version>`; it is not an
  additional CI lane. The exact-family override fences released packages in
  the selected rc line while retaining older legacy dependencies where the
  official release graph still requires them.

Production remains Direct. No Remote Backend, Session writer, UI wiring, retry
loop, raw persistence access, or duplicate event fold is introduced by D1.1/D1.2.

## D1.2 status — pinned-master command/skill authority shadow

D1.2 is complete for the experimental live-session authority read shadow. The
`next` Source Mode pin is `c291e7961a515f6d7af9304e7fd1d257929aef26` (`0.1.5-rc.2`).
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
- `RemoteTaskReader` consumes only the official `ClientSessions` list snapshot and
  `refreshSubagents(parentSessionId)`. Catalog errors are errors rather than an
  authoritative empty result; generation, operation, caller-cancellation, and
  disposal fences discard stale work.
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
- The official bounded Session history window is message-aligned, not
  turn-aligned. It can expose a closing assistant while an earlier turn-local
  durable fact is in the next older page. The Remote reader does not guess at
  completeness or prefetch unbounded history; this known capability gap is
  recorded as `presentation.leadingTurnCompleteness` until the official Session
  history contract exposes a bounded completeness target.
- `DirectPresentationReader` uses the existing Direct Session event snapshot and
  assistant stream baseline; it does not introduce a second stream tracker or
  history reducer. `RemotePresentationReadShadow` compares the matching durable
  range and live inputs, then rebuilds fresh `TranscriptFolder`,
  `TranscriptWindowController`, and Focus projections by hydrating durable
  events first and replaying the current live baseline.
- `scripts/dsh-remote-task-read-parity-smoke.mjs` proves same-Host continuable
  and one-shot child catalog parity, job parity, and a child/job status mutation.
  `scripts/dsh-remote-presentation-parity-smoke.mjs` proves a real bounded
  Client event window, records the leading-turn capability gap, verifies
  `loadOlder()` paging with retained overlap, and proves eventual semantic
  transcript/window/Focus parity without an external provider.
- `scripts/dsh-remote-d1-closure-smoke.mjs` aggregates the existing Session and
  authority proof surfaces with the D1.3 Task and presentation proofs into one
  bounded read-capability result.

The D1 closure ledger is:

| Read surface | Direct source | Official Client source | D1 result | Future owner |
|---|---|---|---|---|
| Session list | Direct SessionReader | `ClientSessions.list` | parity | — |
| projections | DSH projections | Client projection store | parity | — |
| search | sessionQuery | `ClientSessions.search` | parity | — |
| commands | `ctx.commands` | commands Remote | parity | — |
| skills | scoped skill registry | skills Remote | parity | — |
| direct-child subagents | Host subagent runtime | `ClientSessions.refreshSubagents` / `subagentsByParent` | parity | — |
| jobs | `ctx.jobs` | `ClientSessions.jobsBySession` | parity | — |
| history window | Direct Session events | `SessionBinding.eventSource` | parity | — |
| history paging | Direct full history | `SessionFace.loadOlder()` + eventSource | eventual parity; bounded leading-turn completeness skipped | DSH Session history contract |
| live Assistant presentation | Direct stream | transient event-source entries | parity | — |
| full descendant tree | `listDescendants` | no exact official equivalent | skipped | D5/upstream |
| `createdAt` | Direct query | no Client list field | skipped | later only if required |
| Direct `live` bit | attached-store fact | different Client running semantic | skipped | reconsider on flip |
| context pressure | token meter | no Client equivalent | skipped | later Host seam if retained |

The D1 skips are `session.createdAt`, `session.live`,
`session.measureContext`, `subagent.descendantTree`, and
`presentation.leadingTurnCompleteness`; each is explicit in the shadow report
and closure smoke. The last gap is an upstream Session history-window contract
limitation: message-aligned pages do not expose a bounded target for the start
of a leading turn, so the Remote reader does not guess or prefetch full history.

## Known blockers

| Blocker | Level | Mitigation |
|---|---|---|
| Client Runtime still carries web assembly assumptions (`dsh.client.platform: web`) | High | M2 consumes the protocol directly; M3 validates runtime packaging |
| DSH Connection / generated-remote dependency closure differs from the pi-tui profile | High | Experimental host composition; redesign the Remote Adapter before M3; never replace the default patch |
| Extension Cordis ownership across the split | High | Stable API untouched; ClientContext from M3 |
| Cross-client concurrency safety (Web+TUI, TUI+TUI, reconnect, cold resume, Host crash) | Critical | DSH SessionWriteLease is the cross-process writer authority; the full matrix is proven at M8 |
| Shell execution on the wrong machine | Critical | Locality hard rule; remote `!` fails closed |
| `@file` resolving on the Client filesystem | High | M1.10 sealed the locality boundary: all `@` discovery/canonicalization goes through `HostFilePort`; the M2 Remote adapter maps it to Host fileReferences |
| Credentials exposure beyond loopback | Critical | Attach limited to localhost/SSH until real auth |
| Dual-stack semantic drift | Medium | Shared backend contract test matrix |
| Bounded Session history pages do not expose leading-turn completeness | Medium | Track `presentation.leadingTurnCompleteness` upstream; do not guess or prefetch full history in the Remote reader |
| Upstream DSH contract changes | Medium | Public export audit + per-release compatibility matrix; no old/new runtime fallback |

## Startup constraint

`src/startup.ts` parses flags and gives a friendly error for Harness versions
below the 0.4 floor. Experimental Remote dependencies must never enter its
static import graph — load the selected backend via dynamic import in a
`runtime/backend-loader` module. The 0.4 Direct backend targets DSH
`>=0.1.2-alpha.4` (the alpha.2/alpha.3 baseline falls back to the previous
published 0.4 line, `0.4.0-alpha.1`); it has no old/new runtime fallback or
capability-detection branch. Future versions are not rejected without a
confirmed break.

## How to update this file

- Every phase completion: flip the phase status, record what landed, and
  update the "Current production backend / Experimental backend / Remote
  attach / Direct rollback" block.
- Every coupling relocation: update `docs/client-server-coupling.md` and
  the gate baseline in the same PR.
- Every new blocker or removed blocker: update the table.
