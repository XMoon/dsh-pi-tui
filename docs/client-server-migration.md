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
M2  DONE   (D1 COMPLETE: D1.1 Session read shadow, D1.2 command/skill authority read shadow, and D1.3 subagent/task + presentation read parity; D2.1 DONE: Direct-only write-contract convergence + pending-input presentation parity; D2.2 DONE: experimental official Client ordinary-write adapters + submission-presentation seam — see the D2.2 status section; D2.3 DONE: model directory + Session-local model selection, blank-Session preset selection, ordinary create/open lifecycle convergence and presentation closure — see the D2.3 status section; D2.4 DONE: Host-owned fork/rewind convergence; D2 COMPLETE)
M3  NOT STARTED   (experimental in-process wire: Semantic Port + Remote Adapter + DSH Connection)
M4  NOT STARTED   (experimental local Host process / IPC split)
M5  NOT STARTED   (external attach; localhost/SSH only)
M6  NOT STARTED   (production dual stack: direct default, wire opt-in)
M7  NOT STARTED   (default flip; direct rollback kept for >= 1 release)
M8  NOT STARTED   (Direct ownership retirement — only after concurrency proof)

Current production backend: direct
Experimental backend:      none (no complete Backend(kind=remote))
Experimental Remote:        reads + selected ordinary writes (adapters proven in tests/smoke)
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

## P1 capability ledger (v0.4.9)

P1 (`v0.4.9`) is the DSH `0.1.7-rc.1` **core user-facing capability
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
| Official Plugin Manager | P1 required | `@deepseek-ai/dsh-plugin-manager` — the `pluginManager` Host service mounted by the dsh-base layer | TUI-native `/plugins` surface through a narrow semantic port + Direct adapter + controller/panel |
| Installed bundle/plugin inspection | P1 required | same (`listBundles` / `listPlugins` / `registries` / `inspect`) | render Host facts exactly; never infer manageability |
| Bundle/plugin enable/disable | P1 required | same (`setBundleEnabled` / `setPluginEnabled`) | official mutation, then refresh the official inventory |
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
`remote-preset-port`), but the same-Host integration lane for
create/open/model/preset is currently absent. This is a known non-blocking
coverage gap.

Future follow-up: add a focused `smoke:remote-session-lifecycle-parity`
covering ordinary create, explicit-preset create, open/retain, model select,
and preset select + locked — without restoring the retired monolithic D2.3
harness.

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
- `PresetCatalog` gained `roster()` (path-free rows + Host-effective default +
  `modeSelectionEnabled`, matching `agentPresets.list`) and
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
  respects the Host `modeSelectionEnabled` policy, reads blankness from the
  official turn-boundary projection (never the TUI transcript), revalidates the
  Session identity/generation inside the transition gate, and maps
  `agent-preset/locked` to the started-session wording. `/new` keeps the old
  surface until the create commits.

Validation for this stage: per-adapter contract tests for the Remote model,
preset and lifecycle adapters; the D2.3 Direct contract/outcome tests; and
headless model/preset/create/open presentation tests. The 0.1.6-era
same-Host `smoke:remote-d2-lifecycle` integration smoke was retired after
its semantic scenarios gained adapter-level replacement coverage; its
create/open/model/preset same-Host integration layer is not currently
replaced and remains a documented follow-up. The boundary gate stays green
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

## Known coverage follow-ups

Non-blocking coverage gaps with a named owner lane. These are not current
merge blockers; each records what is absent and the follow-up shape.

| Follow-up | Absent today | Follow-up shape |
|---|---|---|
| D2.3 same-Host integration lane | The retired 0.1.6-era `smoke:remote-d2-lifecycle` also proved real Client Context → Gateway → Host Session Controller integration for ordinary create, explicit-preset create, open/retain, model select, and preset select + locked. Adapter contract tests cover those semantics; the same-Host integration layer is not currently replaced. | A focused `smoke:remote-session-lifecycle-parity` covering those five flows, without restoring the retired monolithic D2.3 harness. |

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
| Session history opening pages without a complete leading turn | Medium | Closed for the rc.1 turn-aligned opening windows; if a future contract re-introduces partial turns, track a `presentation.leadingTurnCompleteness` skip again instead of guessing or prefetching full history |
| Upstream DSH contract changes | Medium | Public export audit + per-release compatibility matrix; no old/new runtime fallback |

## Startup constraint

`src/startup.ts` parses flags and prints the advisory compatibility notice for
Harness versions below the current floor. Experimental Remote dependencies must
never enter its static import graph — load the selected backend via dynamic
import in a `runtime/backend-loader` module. The current line requires DSH
`>=0.1.7-rc.1`; `HARNESS_COMPAT` maps every older official tag to its
historically compatible TUI line (the `0.1.6-alpha.2` runtime falls back to the
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
