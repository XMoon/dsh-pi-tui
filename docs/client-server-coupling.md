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
- The **application-layer dependency direction** between the new `src/app/**`
  owners, the frozen `src/runtime/**` semantic layer, and presentation modules
  is enforced separately by `scripts/pre-m3-architecture-gate.mjs`
  (`pnpm gate:architecture`, see the Pre-M3 TS Architecture Convergence status
  in `docs/client-server-migration.md`). This file stays the Host-coupling
  authority only; the two gates answer different questions.

## Composition ownership and wire-shape inventory

`scripts/client-boundary-gate.mjs` remains the mechanical
no-new-business-coupling gate; it does not infer Cordis composition semantics it
cannot see. The legacy `File | Coupling | Notes` allowlist below is grandfathered
and remains the mechanical coupling inventory; this section is the
composition-semantics inventory.

Every NEW or materially changed composition-sensitive domain from M3-4 onward
must have an ownership row here that records locality, composition owner,
allowed consumer, wire source, reuse-vs-additive mount and evidence owner; the
canonical M3-3B rows below already use that shape.

`Evidence owner` is the test/smoke lane or the document that carries the proof.
The frozen architecture statements live in `docs/m3-entry-contract.md` §2.4.4;
qualification evidence lives in `docs/client-server-migration.md`.

### Composition-owner classes

```text
BASE_HOST_PREREQUISITE   ordinary DSH/base/profile composition owns it;
                         migration code may require/read/adapt/verify identity
                         but MUST NOT mount a second copy merely to satisfy
                         Remote composition
M3_ADDITIVE_HOST         a Host contribution genuinely added by the M3
                         composition contract; it may mount only the rows frozen
                         in m3-entry-contract.md
GENERATED_CLIENT_REMOTE  official Client-side generated Remote/service
                         contribution; the TUI consumes it and does not
                         reconstruct its namespace object
CLIENT_LOCAL             terminal/editor/clipboard/draft/overlay/keybinding/
                         shell gesture+card/UI extension state; no Host
                         semantic coupling is invented for it
HOST_OWNED               Host execution environment, process lifetime and
                         Host-side policies (incl. user-shell execution —
                         the M3-4 PR3 shell amendment)
SPLIT                    one capability split across the Client gesture/
                         presentation and the Host execution authority
                         (incl. the user-shell request/stream bridge and
                         the `!` result handoff into Session)
```

### Core vs optional-feature Remote composition (2026-10-03 clarification)

The classes above describe the current M3 core graph; they do not turn the
current composition owners into universal registries. Generated Remote
availability is not sufficient evidence for `M3_ADDITIVE_HOST` ownership, and it
does not imply `RemoteHostRuntime` must own the Host plugin.

```text
CORE GENERATED REMOTE
  mounted/disposed by RemoteClientRuntime (the m3-entry-contract.md §2.4.2
  current M3 core generated contribution closure)

OPTIONAL FEATURE GENERATED REMOTE
  may be mounted/disposed by that feature's Client owner when the feature is
  adopted and the selected released DSH target actually provides the public
  contract; it reuses the existing Connection/Gateway and duplicates no core
  namespace/authority

HOST FEATURE WITH REMOTE
  remains feature-owned on Host unless an accepted contract explicitly
  reclassifies it as base/common/core
```

No current row of this inventory is added, moved or reclassified by this
clarification; update the rows only when a real coupling/composition change
lands.

### Canonical M3-3B ownership rows

| Domain/service | Locality | Class | Composition owner | Consumer | Wire/source | Mount rule | Evidence owner |
|---|---|---|---|---|---|---|---|
| `userQuestions` Host service | Host-owned | `BASE_HOST_PREREQUISITE` | `@deepseek-ai/dsh-base` (row `user-questions`) | `InteractionPort` (Direct + Remote) | forwarded `user-questions/request` waterfall + Host service | reuse; never mount a second `UserQuestionService` in `RemoteHostRuntime` | `test/remote-m3a-semantics-smoke.test.ts` |
| `userQuestions` Client Remote | Client-local consumption of a Host authority | `GENERATED_CLIENT_REMOTE` | official client contribution (`@deepseek-ai/dsh-user-questions/remote`) | `QuestionInteractionPort` + the `userQuestions` Session projection | generated `/remote` namespace | additive Client contribution; preserve the generated object identity | `test/remote-m3a-semantics-smoke.test.ts` |
| `configEditor` | Host-owned | `BASE_HOST_PREREQUISITE` | profile/base composition (`profileContext` config plane) | `ConfigPort` settings mirror | Host settings/config plane | reuse; `RemoteHostRuntime` must not mount it | M3-3B same-Host smoke (fixture-mounted only per `docs/client-server-migration.md`) |
| `settings` | Host-owned | `BASE_HOST_PREREQUISITE` | profile/base composition | Remote Config adapter | generated `settings` Remote | reuse; no second settings authority or namespace | `test/remote-config-port.test.ts` + same-Host smoke |
| `jobController` | Host-owned | `BASE_HOST_PREREQUISITE` | the existing TUI row | `JobObservationPort` | `IJobs` + generated `job` Remote | reuse; no second job observation authority | `test/remote-job-observation.test.ts` + the Job roster in `test/remote-client-runtime.test.ts` |
| M3 Host API/session helper rows | Host-owned | `M3_ADDITIVE_HOST` | `RemoteHostRuntime` (§2.4.1) | the M3 adapters | official Host plugins + generated Remotes | additive; mount only the frozen §2.4.1 closure | `test/remote-client-runtime.test.ts` |
| TUI Task Center / Question presentation | Client-local | `CLIENT_LOCAL` | TUI application surface | user-facing surfaces | semantic ports/projections only | never becomes Host authority | `test/runner-viewer-task-integration.test.ts` |
| Application runtime selection (`SelectedApplicationRuntime`) | Client-local composition | composition spine (M3-4 PR1) | `src/app/remote/application-runtime.ts` (Remote aggregate) + `selectApplicationRuntime` in `src/app/bootstrap.ts` (the seam) | `bindSessionRuntime` common inputs (`owners`/`retirement`/`lifecycle`) and the runner's `backend` | Remote aggregate reuses the M3-1 wire + M3-3B backend + M3-2 owner services; reached ONLY through `runtime/backend-loader.ts` (the ONE frozen dynamic edge into `app/remote/runtime.ts`, which statically re-exports the aggregate) | exactly ONE Remote Host/Client graph, ONE semantic assembly, ONE owner registry per selected runtime; no second construction site; no public/config/env selector — normal `apply()` stays Direct | `test/remote-application-runtime.test.ts` + `test/application-runtime-selection.test.ts` + the dynamic-boundary rules in `test/pre-m3-architecture-gate.test.mjs` |

The exact package/row names may evolve; the ownership rule must remain explicit.

### Duplicate-mount prohibition

Before mounting any Host service/plugin row in M3+:

```text
1. determine whether base/profile already owns it
2. determine whether mounting replaces a Cordis namespace owner
3. determine whether projection units/event handlers would be registered twice
4. freeze the owner in m3-entry-contract.md
5. record the coupling/owner row here
```

A missing service in a fixture is not evidence that production
`RemoteHostRuntime` should own it — fix the fixture to reproduce the production
prerequisite instead.

### One runtime graph / one semantic assembly

A product runtime or L5 qualification should have ONE Host graph → ONE
Connection/Client graph → ONE semantic assembly → ONE Backend assembly. Do not
create semantics manually AND call `createRemoteBackendRuntime()` (which creates
another semantics bundle) and then treat that as evidence of one production
wiring. Extra semantic bundles are allowed only in a test explicitly about
multiple independent consumers, never implicitly in the main qualification
fixture.

### Generated Client / Remote identity invariant

Official generated Client namespace properties may be prototype accessors.
Therefore:

```ts
const bad = { ...source.remote }
```

is forbidden for semantic adapter wiring: an own-property spread copies
bookkeeping fields only, so the generated prototype namespaces disappear and
`settings` / `credentials` / `llm` / `presets` / `commands` become `undefined`.
Preserve the source object's identity and pass the original generated object
through. A structural fake used by L3 tests should model important accessor
behavior when the adapter depends on the generated object shape, but L5 real-wire
qualification remains mandatory.

### Receiver/method-binding invariant

Forwarded event methods may read receiver-owned state. Forbidden:

```ts
const on = source.remote.$on
on(...)
```

Required:

```ts
const on = source.remote.$on.bind(source.remote)
```

or an equivalent call that preserves the receiver. This applies to any generated
Client method whose contract is receiver-sensitive, not only `$on`.

### L5 fixture topology

Every NEW or materially modified test described as real-wire / real-Host from
M3-4 onward must list, next to the fixture:

```text
reproduced production prerequisites
stand-ins
deliberately absent services
```

Existing pre-governance fixtures are grandfathered and are upgraded only when
materially touched; the canonical manifest contract is in
`docs/client-server-migration.md` §Production-equivalent fixture manifest. This
document records the stable ownership rule;
`docs/client-server-migration.md` records the qualification evidence. A fixture
may stand in for an unrelated domain, but it must not omit a base prerequisite
that ordinary production composition owns and still claim to prove the product
topology.

### Coupling review checklist

Before accepting a new Host/Client coupling:

```text
[ ] locality is explicit
[ ] semantic port owner is explicit
[ ] composition owner is explicit
[ ] official wire/source is explicit
[ ] generated object identity is preserved
[ ] receiver-sensitive methods preserve binding
[ ] no duplicate service/projection owner
[ ] no second Connection/Client/semantic graph
[ ] L5 evidence exists when wire shape matters
```

## Application-layer ownership target (Pre-M3 TS Architecture Convergence)

The stage moves M3-critical runner ownership out of `src/index.ts` into
`src/app/**`. Host business coupling is allowed only in
`runtime/direct/**` and `app/direct/**`; the other application owners consume
semantic ports / the `Backend` / narrow injected callbacks. Status below is
`planned` until its slice lands.

| Owner | Owns | Host coupling | Status |
|---|---|---|---|
| `src/app/direct/**` | Direct application runtime: the Direct resolver POLICY and facades (the ONE `DirectModelSelectionOwner`, `agentFor`/`queueAgentFor`, the semantic `Backend` call, the assistant-stream install, model-selection/image-admission facade) | allowed zone — the Direct application coupling owner: the concrete Host lookups (`agents.get`/`sessions.get`/`agentDefaultModel`) move behind this module's composition seam; in A1 they are still supplied temporarily by the runner | current policy (A1); the A3 scope-bound stats/routing/approval reads land as command-runtime surface hooks resolved by the runner (A3-5) |
| `src/app/session/**` | current session subject/generation, transition gate + operation barrier ownership, ordinary create/open/switch and fork adoption orchestration, opaque `SessionSubject` authority | none | current (A2) |
| `src/app/submission/**` | the submission domain's APPLICATION orchestration and its `WriteOutcome` classification + draft/queue/card settlement: plain prompt, busy delivery, Ctrl+S steer sweep, queue pull-back, HostCommandPort submission + agent-facing fallback, shell submit, writer-barrier admission, prompt admission, draft restore/consume | none | current (A3-3/A3-4; the A3 fix round moved the remaining entrypoints in) |
| `src/app/command/client-command-registry.ts` | (none) | M3-4 PR4 §D2: the CLIENT-owned command execution registry — TUI built-ins and dynamic skill wrappers register here (their ONLY registration surface on the Remote branch); the Client handler runs in the Client Context with a Client-minted correlation id. It calls no Host service, exposes no wire surface and owns no Host id. The protocol package it imports (`dsh-commands`, types + the `CommandId` brand) is not Host-ownership coupling and is not tracked by the boundary gate. |
| `src/app/remote/command-source.ts` | (none) | M3-4 PR4 §D1: the Remote branch's command-authority bundle (the metadata-only authority reader + the shared Connection generation), assembled from the SAME aggregate; no second Connection and never moved into the Backend. |
| `src/app/remote/session-facts-compose.ts` | (none) | M3-4 PR4 §3.3/§3.6: the whole-log projection + bounded-paging composition for `sessionStats`/`lastAssistantText` (official projections for lifetime truth, the exact binding's window for the recent figures). Host-import-free. |
| `src/tool-presentation-client.ts` | (none) | M3-4 PR4 §5: the Client-derived tool presenter (diff/terminal cards from raw call arguments, generic fallback otherwise). Never consults `ctx.tools`, never invokes `presentCall`/`presentResult`; the `dsh-tools` import is type-only presentation vocabulary. |
| `src/app/command/**` | the SEMANTIC `TuiCommandRunner` facade: scope/currentness facts, scoped catalog, skill execution, stats/read, catalog refresh, prompt admission and the writer exposure (the presentation dependency bag is finalized in A5) | none | current (A3-5) |
| `src/app/surface/**` | the mounted surface (`createSurfaceRuntime` two-phase owner + `start()`), the opening journal, the unified status projection store instance, the surface-local TuiApp option wiring (image loader, history search, clipboard/link, extension registries + input routes, resize/workflow hooks), the extension `SurfaceHost` + Plugin Manager + keybinding sync + attach seams, the completion-notification/terminal-focus presentation, the Task Center (`TaskBrowserRuntime` + browser + Job viewer) and the approval/question presentation providers | none | current (A4) |
| `src/app/bootstrap.ts` | the application composition root (A5-2, plan §22/§23): the process/Cordis startup prerequisites, the runner lifetime controller + diagnostics, Host service resolution, the owner constructions/bindings (Direct application runtime, session ownership + runtime, submission runtime + its controller/user shell, surface runtime + the surface owners, command authority/model-selection/artifacts), callback connection, the surface mount, disposal/retirement registration and the startup/fatal cleanup. Composition only, never a business domain; M3 starts here. | `agents`, `sessions`, `subagents`, `jobs`, `attachments`, `llm`, `commands`, `settings`, `agentPresets`, `tools`, `permissionPresets`, `agentDefaultModel`, `planMode`, `sandboxPolicy`, `sessionQuery`; `import:dsh-agent`, `import:dsh-session` | current (A5-2) — the earlier "connects owners only, never a Host-coupling zone" wording is superseded by §23/§26: resolving the services the owners are built from IS the composition root's job, while every Direct-only fact stays behind `app/direct` §23's composition-only / giant-root criterion is **COMPLETE** (A5b): `startRunner()` carries no application handler group — the extracted owners (`app/surface/{viewer-runtime,session-presentation,status-runtime,input-history,settings-runtime,application-events,client-actions}.ts`, `app/command/{surface,model-selection,artifacts}.ts`, `app/submission/{controller,user-shell}.ts`) consume narrow injected capabilities and the semantic ports, so none of them introduces concrete Agent/Session Host coupling, a raw Host service lookup or Direct-runtime coupling (the protocol/DTO packages a few of them use — `dsh-commands`, `dsh-llm` and the type-only `dsh-user-approval/types` — are not Host-ownership coupling and are not tracked by the boundary gate); the ownership matrix records an empty unowned residual. See `docs/client-server-migration.md`. |

`src/runtime/**` (semantic ports, `backend.ts`, `direct/**`, `remote/**`) keeps
its current coupling and must not import `src/app/**`. Only `src/index.ts`,
`src/app/bootstrap.ts`, `src/app/direct/**` and `src/runtime/**` may import
`app/direct/**` / `runtime/direct/**` — every other module (the non-Direct
application owners `app/session`, `app/submission`, `app/command`, `app/surface`,
and all presentation such as `tui-app.ts`, `transcript.ts`, `present.ts`,
`footer/**`, `components/**`) consumes semantic DTOs / Backend ports / narrow
injected callbacks; the single proven historical exception is the type-only
`legacy-settings-migration.ts` import, recorded in the gate allowlist (a value
import of the same target still fails). `app/surface/**` must not construct
Direct adapters, and experimental Remote composition must not be statically
reachable from `startup.ts`.

The A3 application owners confirm the boundary: `src/app/submission/runtime.ts`
and `src/app/command/runtime.ts` hold NO Host coupling (no `ctx.get`/`ctx.<service>`
and no `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-session` import). Every
Direct fact they read arrives as a narrow injected surface hook, and the
session/skill writes go through `SessionRuntime.withWriter` / the semantic
`SkillCatalogCapability` port. The boundary gate therefore still reports
the unchanged `scripts/client-boundary-baseline.json` (28 coupled files).

The A4 surface owner confirms the same boundary: `src/app/surface/**` holds NO
Host coupling (no `ctx.get`/`ctx.<service>`, no `@deepseek-ai/dsh-agent` /
`@deepseek-ai/dsh-session` import, no `app/direct`/`runtime/direct` import) and
constructs no Direct adapter. Every Host/Direct fact it needs arrives as a
narrow injected capability or a semantic port. The Task Center consumes
`TaskSurfaceSource` — the production capability of the A4 plan §15.2, not a new
`Backend` port and not a second task model. M3-5 PR2 replaced the old
`TaskSurfaceAgents` group with the SELECTED `TaskSurfaceRead` bundle
(`currentKey` + `currentSessionId` + the semantic `readTask` + the commit-time
`activityOf`), renamed the jobs half's `get`/`kill` to OPTIONAL selected-Job
capabilities (Remote advertises neither until PR3), and made
`TaskSurfaceSource.sessionId()` the transport-neutral ownership read: the runner
keeps the `SessionId`/`JobId` casts, the retained-snapshot session fence, the
`ownership` subject fences, the `SessionRuntime.withWriter` interruption
admission and the `cleanedUp` latch. On the Remote branch the Task rows/activity
come exclusively from `RemoteApplicationSources.task`
(`readDescendants`/`jobs`/`subscribeJobs`/`subscribeSessions`) and the child
viewer from `RemoteApplicationSources.childView`; the Host `subagent/start|end`
and `agent/status` channels are registered on the Direct branch only, so no Host
event doubles as a Remote Task authority. The runner also keeps the semantic
status DERIVATION, because the `status/derive-*` seam is the sanctioned
Host-reading path (`planMode` / `sandboxPolicy` / `permissionPresets` /
`sessionProjections`); the surface owns the store instance and the app's own
projection. The boundary gate therefore still reports the unchanged
`scripts/client-boundary-baseline.json` (28 coupled files), and the A5b-0 root
matrix is regenerated for the M3-5 PR2 root declarations.

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

The bundle also mounts one Host row the base layer deliberately leaves to the
web bundle: `@deepseek-ai/dsh-workspace` (`cordis.patch.yml`, row id
`workspace`), injected by the `tui-app` row. D2.4 Direct fork must observe the
official workspace membership (`workspaceRegistry` in the
`session-lifecycle-direct.ts` row below), and that service only exists while the
row is mounted. It is the same official row the web bundle inserts, and the DSH
installation already ships the package; activating it performs the upstream
one-time history bootstrap that groups stored Session headers by canonical cwd
into durable workspace records. See the D2.4 status and the fork exact-cut
convergence sections in `docs/client-server-migration.md`.

## Inventory (baseline, generated from the current tree)

### DIRECT_HOST_REQUIRED

| File | Coupling | Notes |
|---|---|---|
| `src/index.ts` | `import:dsh-agent` | The package FACADE (A5, plan §28/§29): module docs, the Cordis contract (`name`, `inject`), the `Config` re-export, the public root re-exports, and `apply(ctx, config)` delegating to `app/bootstrap`'s `applyRunner`. A5-1 relocated the helper IMPLEMENTATIONS to their natural top-level modules with every root export preserved; A5-2 moved the runner body to `src/app/bootstrap.ts`. The one remaining Host import is `@deepseek-ai/dsh-agent`, whose types are part of the frozen public `composeAgent` overload declarations (the Direct body lives in `app/direct/composition.ts`). |
| `src/app/direct/composition.ts` | `agentPresets`, `import:dsh-agent` | The public `composeAgent` / `recordedPreset` helper's Direct implementation (A5-1, plan §27): resolve the preset an agent will be composed from and build the setup that installs the Agent-scoped model selection, the preset mount and the TUI prompt sections. Direct-only by construction (the Host preset registry, `installModelSelection`), so it lives under `app/direct` while `src/index.ts` keeps the public overload declarations and delegates — which keeps the entry one-way (`index -> bootstrap -> app/direct`). Baseline entries added by the A5-1 relocation: both patterns were already `index.ts` entries (the `import:dsh-agent` one stays in the entry for its public overload types). |
| `src/app/direct/runtime.ts` | `agents`, `sessions`, `subagents`, `import:dsh-agent` | The Direct application runtime (Pre-M3 A1): the Direct resolver POLICY and facades — the ONE `DirectModelSelectionOwner`, the live-Agent / queue-Agent / registered-Agent selection logic, Host Session accessor forwarding, model-selection/image-admission facade and the Direct assistant-stream install — delegating adapter assembly to `runtime/direct/backend-direct.ts`. It holds NO mutable current-session truth (live getters into the session authority). A5-3 completed the A1 promise: the Direct-only Host lookups (`agents`/`sessions` for the resolver and retirement seams, `subagents` for the descendant drain) moved behind this module's own composition seam (`directHostAccessors`), so `app/bootstrap` hands over the Context plus the verified owner/ledger seams and never a Direct fact it resolved itself. The three baseline entries added by that relocation are the same services the composition root still resolves for its own startup gate. No UI, transition, draft, command routing or panel state. Baseline entry added by the A1 relocation. |
| `src/app/direct/owner-registry.ts` | `import:dsh-agent` | The Direct Agent↔OwnerRef registry (A2): one exact Agent OBJECT maps to one opaque `SessionOwnerRef` (stable across repeated `SessionHandle` wrappers; different Agents stay distinct even on the same session id). `fromHandle` is the ONLY `SessionHandle → SessionOwnerRef` path; `currentDirectAttachment()` is the explicitly A2-TRANSITIONAL derived projection of the ownership core's current owner (never identity/currentness, never a sessionId→Agent reverse lookup). Baseline entry added by the A2-2b relocation. |
| `src/app/direct/owner-retirement.ts` | `import:dsh-agent` | The Direct adapter for the consumer-owned `SessionOwnerRetirement` port (A2 §3.3): the exactly-once shutdown cancel, the abort-aware quiesce mechanism and the official close-order retirement (`cancel → idle → descendants → flush → dispose`), plus park/retireParked over the Direct owner pool. The port speaks only opaque `SessionOwnerRef`s; every Direct fact (Agent, AgentHandle, cancel policy, descendant drain, durable flush) stays here or arrives as a boundary dependency. Baseline entry added by the A2-3 relocation. |
| `src/rewind.ts` | `import:dsh-session` | Rewind mechanics. |

### MIGRATABLE

| File | Coupling | Notes |
|---|---|---|
| `src/commands.ts` | `import:dsh-agent`, `import:dsh-session` | The command runner — M1.7–M1.11 narrowed it to ZERO `ctx.get` and ZERO service-object access: every Host read/write a command performs goes through the semantic ports (`catalog`/`config`/`hostFile`/`sessionReader`/`sessionWriter`/`interaction`); the `CommandHostCapabilities` facade and `runner.host` are RETIRED. The remaining type-only imports are the runner's Direct ownership escape (live Agent/Session types), kept until M8. |
| `src/skill-catalog.ts` | `agentPresets`, `skills` | Already isolated: structural types + capability detection (decision 11). The pure catalog logic the Direct catalog adapter (M1.8) wires — the coupling stays attributed here. |
| `src/surface-catalog.ts` | `commands` | Isolated catalog module; the runner's pre-mount surface prefetch and the coordinator's live-agent read hook (agent-owned, M8 escape — the sessionless STANDING read now routes through the catalog port, M1.8). |
| `src/skill-catalog-refresh.ts` | (none) | Coordinator; its refresh target is the branch-opaque `CatalogReadTarget` (M3-4 PR4 §2.3): Direct feeds the exact Agent, the Remote branch a session-keyed target the command source resolves, so the coordinator carries no Host type import. The `import:dsh-agent` baseline entry was REMOVED by that relocation (coupling reduced). |
| `src/subagent-viewer-submit.ts` | (structural `ctx.subagents` official prompt surface, injected) | The pure human-prompt delivery core (alpha.4's `ctx.subagents.prompt`); consumed by `SubagentPort` (M1.2). The runner resolves `queue` / `steer` for continuable viewer gestures against child activity and `busyEnter`; the port forwards the result. Task Center interruption is a separate `SubagentPort.interrupt()` operation (D2.1). |
| `src/runtime/direct/subagent-direct.ts` | `subagents` | The Direct `SubagentPort` adapter (M1.2/D2.1) — the ONLY module in the prompt and interrupt paths that touches `ctx` (and the only one minting the caller-owned prompt `requestId`); it maps explicit parent/child interruption to the official user-authority call. The runner depends on the port. Baseline entry added by the M1.2 relocation. |
| `src/runtime/direct/backend-direct.ts` | (none) | The Direct semantic-assembly owner (Pre-M3): builds the complete `Backend` from the runner-supplied Direct-only resolvers (live-Agent/queue-Agent lookup, preset compose, Session accessors, settings/model-selection/ownership seams). It resolves no Host service itself and owns no UI, transition, draft, panel or command routing. |
| `src/runtime/direct/session-direct.ts` | `import:dsh-session`, `sessionPersistence`, `sessionQuery`, `agentPresets`, `sessionProjections`, `sessionProjectionCache` | The Direct `SessionReader` adapter (M1.3, extended M1.11 + master alignment) — owns master-visible semantic session-query listing (live rows remain visible without `cwd`; cold rows require `cwd`), official-parity content search (`SessionReader.search()` → `sessionQuery.searchSessions()` with master `ApiSessionList.search()` business semantics — the pure cursor/authorization/dedupe loop lives in `session-search-direct.ts`, the retired TUI-owned newest-100 + `filterEvents` private rule is gone) and best-effort context measurement (`measureContext`, the /status row — M3-3A: the official `contextPressure` projection numerator `projectedTokens ?? pressureTokens`, no `tokenMeter` second authority; the projection reads also feed `turnOutline` and the subject-neutral `sessionStatus` snapshot); the combined `title`+`agentPreset` projection batch delegates to `session-projection-direct.ts` (the official live-cached-snapshot/cache-checkpoint ladder, with cold misses left unknown). The TUI-local title cache and the `readTitleSnapshots()` path are retired — the adapter's structural query surface no longer even declares them. The migration-era `readExportData` seam is RETIRED (Pre-Stage-D export convergence): the export plane is the `SessionArchivePort` (`session-archive-direct.ts`), never this reader. The consumer (commands.ts) depends on the port. Baseline entries added by the M1.3/M1.11 relocations, the master projection-cache contract, and the projection module split (the cache/`sessionProjections` reads moved with it). |
| `src/runtime/direct/session-archive-direct.ts` | `import:dsh-session` (the base `dsh-session` type package — `SessionId`; `dsh-session-log-export` is a separate package and the exact-match matcher no longer conflates the two) | The Direct `SessionArchivePort` adapter (Pre-Stage-D export convergence) — the ONLY module in the export path that touches the Host archive primitives: `sessionLogExportDeps` service resolution, `flushLiveSessionLog` through the store's durability barrier, the committed-log READ handle (never the cold-view observation seam), and the official full-tree ZIP stream (`streamSessionLogZip`, descendants + attachments). The FILE WRITE stays Client-local (`client-artifact-save.ts`); a future Remote adapter maps the same port onto `GET/HEAD /api/session.export`. Baseline entry added with the module itself. |
| `src/runtime/direct/session-preset-direct.ts` | `agentPresets`, `import:dsh-session`, `sessionQuery`, `sessionProjections` | The Direct session-preset adapter — explicit resume/preset paths read cold sessions through the official `sessionQuery.observeSession()` observation seam (the engine owns live/cold source selection, persistence borrow/preparation, projection-cache hydration, tail replay, and the projection cut); picker enrichment stays on the live/cache-only projection path. D2.3 adds `selectBlankSessionPreset()`, the official in-process `agentPresets.select(agent, id)` write used by the Direct catalog adapter to SWITCH an already-created BLANK Session (the Host owns the blank check, recompose transaction and durable `agent-preset/selected` commit). It is NOT the fresh-create/launch `--preset` path: a fresh Session carries its preset at creation time (Direct compose/mount setup; Remote atomic `session.create({ agentPreset })`). The TUI reads the current DSH V3 `agentPreset` projection value as-is; DSH owns historical V2→V3 preset migration, while the TUI retains only the narrow omitted-settings-default shim in `src/runtime/session-preset.ts`. |
| `src/runtime/direct/session-projection-direct.ts` | `import:dsh-session`, (`sessionProjections` / `sessionProjectionCache` structural reads) | The Direct combined session-projection batch (the picker-projection alignment) — `SessionReader.projectionBatch()` implementation: live rows read only already-materialized cells through the official `sessionProjections.cachedSnapshot()`, cold rows read the `sessionProjectionCache.cachedSnapshot()` checkpoint keyed by the `list()` header identity (or its predecessor-title hint), and cold misses remain unknown without activating a historical Session. Current DSH V3 preset identities are consumed as-is; this is Host coupling INSIDE the Direct adapter by design (the projection semantics are DSH-owned), not Client debt: a future Remote adapter maps the same port method onto the official client projection contract instead of copying this ladder. Baseline entry added with the module itself. |
| `src/runtime/remote/session-reader-remote.ts` | (none) | Experimental M2/D1.1 `SessionReader` adapter over the official DSH Client Session list/projection/search faces. It consumes detached Client facts only: ready list snapshots, authoritative `ids` order, `updatedAt`, projection values/faces, and official search results. It has no Host imports, persistence access, writer methods, or production wiring. |
| `src/runtime/remote/session-read-shadow.ts` | (none) | Experimental M2/D1.1 Direct-vs-Remote diagnostic comparator. It owns only an operation epoch and Connection-generation fence; it emits bounded parity facts and explicit discarded/unavailable outcomes. It never changes Direct authority or renders Remote data. |
| `src/runtime/surface-authority-port.ts` | (none) | Structural live-Session command/skill authority read port; only detached commands and human-skill metadata cross it. |
| `src/runtime/direct/surface-authority-direct.ts` | (none; reuses `surface-catalog`) | Direct M2/D1.2 adapter over the existing effective live surface collector; it resolves an already-live Agent and does not create or mutate Host state. |
| `src/runtime/remote/surface-authority-remote.ts` | (none) | Experimental M2/D1.2 adapter over official generated `commands.list` and `skills.list` Remotes; explicit detached whitelist, no Host imports, no writes or execution. M3-4 PR4 added a commands-only, generation-fenced `readCommands` metadata read so the command provider and the skill provider degrade independently (one absent skill registry must not zero the Host command catalog). |
| `src/runtime/remote/surface-authority-shadow.ts` | (none) | Experimental M2/D1.2 generation-fenced Direct-vs-Remote comparator; bounded command/skill mismatches and metadata-derived claim diagnostics only. |
| `src/runtime/task-read-port.ts` | (none) | Structural Task read contract (M3-5 PR2): the FULL Task Center dataset — one root Session, its complete descendant catalog in stable DFS pre-order (`parentId` + `depth` + mode/label/activity/`hasChildren`/diagnostic per entry) and the root's status-only job roster. `readDescendants()` replaced the old direct-child read; the descendant tree is no longer an upstream gap. |
| `src/runtime/direct/task-read-direct.ts` | (none) | Direct Task read adapter (M3-5 PR2); composes the injected official `listDescendants`, the live-Agent registry activity, and `jobs.list` faces without exposing Host objects or creating Agents. |
| `src/runtime/remote/task-read-remote.ts` | (none) | Experimental Task read adapter (M3-5 PR2) over the official Client Session projections: a RECURSIVE `subagentCatalog` walk (`projectionsBySession` + `refreshProjections`, root failure throws, an unreadable/absent child branch degrades to a branch-scoped `corrupt`/`unavailable` diagnostic whose siblings stay visible — the owner-ruled branch-isolation policy, not the current Host `listDescendants()` whole-traversal rethrow — and an `unknown` mode an `unsupported` diagnostic whose children are still traversed), activity from the official Session-list `running` bit, and the ClientJobs retained `watchRows` roster; generation/cancellation/operation-fenced, read-only, detached/frozen, and it never retains or opens a child log. The rc.2 carrier cannot distinguish the `null` (missing Session) from the non-null (catalog-less baseline) `ready` provenance — recorded as an explicit user-visible failure-scope limitation in `client-server-migration.md`. |
| `src/runtime/remote/task-read-shadow.ts` | (none) | Experimental Task comparator (M3-5 PR2); compares the FULL descendant tree (ids/order/kind/label/mode/activity/`hasChildren`/`parentId`/`depth`, diagnostics, job roster) plus `buildTaskRows`, with bounded diagnostics. The former `subagent.descendantTree` skip is REMOVED: nothing is skipped. |
| `src/app/direct/child-view.ts` | (none) | Direct child-view source (M3-5 PR2): composes the live/cold child Session read, the Agent registry activity, and the live assistant-stream baseline into the viewer's `ViewerChildSource`. Constructed only on the Direct branch; no Host object escapes and no per-child subscription exists (the Host firehose already routes the viewed child). |
| `src/app/remote/child-view.ts` | official Client `ISessions`/`PresentationReader`/`SessionFace`/eventSource, through the ONE Remote aggregate | Remote child-view source (M3-5 PR2): acquires ONE `tuiChildView` `SessionReference` from the exact durable `SubagentAddress` (parent + child + catalog mode, never a plain id, never a Host Agent), awaits its open, hydrates through the SHARED `PresentationReader`, subscribes the SHARED `RemoteLiveIngress`, pages via `loadOlder`, and releases exactly once with the ingress disposed first. |
| `src/runtime/presentation-read-port.ts` | (none) | Structural D1.3 presentation read contract; keeps durable history and live inputs as separate detached planes, plus window flags and open state, without a TUI or transport object. |
| `src/runtime/direct/presentation-read-direct.ts` | (none) | Direct D1.3 presentation reference adapter over existing Session event snapshots and assistant stream baseline; no duplicate history or stream tracker. |
| `src/runtime/remote/presentation-read-remote.ts` | (none) | Experimental D1.3 adapter over official `SessionBinding.eventSource`, `SessionFace` snapshots, and `loadOlder()` only; it preserves source order within each plane and protects detached payloads. |
| `src/runtime/remote/presentation-read-shadow.ts` | (none) | Experimental D1.3 semantic comparator; compares bounded durable/live ranges and rebuilds fresh Transcript, window, and Focus projections with lifecycle fences. |
| `src/runtime/direct/session-writer-direct.ts` | `sessionTitle`, `fileUploads` | The Direct `SessionWriter` adapter (D2.1) — identity-based (sessionId) semantic operations over the live Agent resolver and the `ctx.sessionTitle` service: explicit-mode ordinary prompts, dsh-web-style FIFO per-occurrence `updateQueue({ kind: 'steer' })` calls, official text-only/non-whitespace edit validation (with malformed structural blocks treated as non-text), edit/remove/steer queue mutations, user `rpcId` file-upload retirement after remove, user cancel with pending inbox preserved, normalized rename, and title refresh. Ordinary session verbs retain their caller-authorized resolver; queue occurrence verbs may use the separately fenced exact live continuable-child viewer resolver. Steer orchestration, barriers and revalidation stay in the runner. Baseline entry retained from the M1.4 relocation and updated for the converged contract. |
| `src/runtime/remote/session-writer-remote.ts` | (none) | Experimental M2/D2.2 `SessionWriter` adapter over the official `ClientSessions.binding(id).session` `SessionFace`. Identity-addressed writes only, and never a Client-global selection verb. alpha.2 made `binding()` borrow-only, so each write borrows the existing generation and pins it with a temporary `tuiOperation` reference for the whole operation (never materializing a cold Session); a replaced live binding fails the dispatch closed. The official `beginSubmission`→identified-`prompt` echo lifecycle, occurrence-level `updateQueue`, `cancel`, normalized `rename`, and an explicit `unsupported` title refresh. A Connection generation captured before dispatch fences the binding too; a `RemoteResult` failure is classified rejected/cancelled/indeterminate without a Remote-only taxonomy, and `session/writer-held` settles `rejected` with preserved `details` and actionable holder guidance. It resolves the prepared submission through a migration-local serializer seam and has no Host imports or production wiring. |
| `src/runtime/remote/write-failure.ts` | (none) | Experimental M2/D2.2 settlement classifier: maps an official `RemoteResult` failure (or an assembly throw) onto the shared `WriteOutcome` vocabulary. Domain and `gateway/bad-request` codes are proven refusals; universal carrier codes stay `cancelled`/`indeterminate`. Host-free and transport-free. |
| `src/runtime/remote/pending-input-reader-remote.ts` | (none) | Experimental M2/D2.2 `PendingInputReader` adapter over the official alpha.2 durable inbox projection (`session.projections.faceOf('inbox')`). It maps `next-turn` to `queued`, a user-origin `next-step` message to `steering`, every other `next-step` message to `context`, preserves the official order, carries the optional plain `rpcId`, detaches/freezes content, and is Connection-generation fenced. It never reads Direct `nextTurn`/`nextStep` names, never infers placement from `running`, and never reads the removed alpha.1 `SessionSnapshot.queue`. |
| `src/runtime/remote/host-command-remote.ts` | (none) | Experimental M2/D2.2 `HostCommandPort` adapter over the official generated `commands.execute(agentId, line, attachments, signal)` Remote — the attachment-preserving path (never the `SessionFace.command(line)` convenience that drops attachments). It forwards the full line, opaque attachments and caller signal unchanged and classifies settlement without a model fallback. |
| `src/runtime/remote/subagent-remote.ts` | (none) | Experimental M2/D2.2 `SubagentPort` adapter over the official generated `subagents.prompt` / `subagents.interruptByParent` Remotes. Continuation prompts keep the exact durable parent/child address and `continuable` mode with one pre-call request identity per human submit; interruption addresses the explicit direct parent. It never opens a child to write to it and never infers parent authority from UI nesting. |
| `src/runtime/pending-input-reader-port.ts` | (none) | Semantic pending-input projection: running state plus `queued` / `steering` / `context` placements, and an optional plain `rpcId` correlation string for user-origin occurrences. It contains no Direct or Remote transport vocabulary and never exposes the raw message `source`. |
| `src/runtime/direct/pending-input-reader-direct.ts` | (none; structural Direct read) | The Direct `PendingInputReader` adapter — the only consumer-facing read adapter that knows `Agent.inbox.nextTurn` / `nextStep` and their sources; it maps next-turn to `queued`, user-origin next-step to `steering`, all other next-step rows to `context`, projects a user `source.rpcId` to the plain `rpcId` correlation field, exposes no source field, and returns `undefined` when the session is unavailable. Its resolver is separately fenced for the exact live continuable child mounted by an interactive viewer. |
| `src/pending-submission.ts` | (none) | The D2.1 follow-up Client-local pending-submission ledger: insertion-ordered, request-id-keyed echoes (`transcript` / `queued` / `steering` placements) bridging the editor-clear → authoritative-occurrence window. Pure and Host-free; it never reads a Host inbox or the terminal. |
| `src/submission-presentation.ts` | (none) | The D2.2 client-local submission-presentation seam: one read-only optimistic-echo source the TUI presentation consumes. The Direct implementation wraps the existing `PendingSubmissions` ledger; the experimental Remote implementation reads the official `SessionSnapshot.pendingSubmissions` under the Connection generation. The renderer joins these items with authoritative pending-input rows by request/rpc identity only — never by text — and the seam owns no Host state. |
| `src/runtime/host-command-port.ts` | (none) | The D2.1 Host command execution port — carries session identity, the full selected line, opaque submitted attachments and signal; it owns execution only, not command claim precedence or TUI-local/extension/skill routing. Zero Host coupling. |
| `src/runtime/direct/host-command-direct.ts` | `commands` | The Direct D2.1 `HostCommandPort` adapter — resolves the live Agent by session id at call time and invokes the official `commands.execute` service. It preserves the selected line, attachments, signal and settled command result; it does not parse, claim or route commands. Baseline entry added with the new Direct adapter. |
| `src/runtime/direct/plugin-manager-direct.ts` | `pluginManager` | The Direct P1-A `PluginManagerPort` adapter — the ONLY module that resolves the official `@deepseek-ai/dsh-plugin-manager` Host service and maps its records/events onto detached TUI facts. It performs package/profile mutations ONLY through the official service (never pnpm, package.json, patch YAML or a profile path) and exposes no Host object above the port. The base layer already mounts the service; this is a P1 Host seam that M3 later re-points at the official client contract. Pre-M3 extracts the pure record mapping into the shared `plugin-manager-mapping.ts` (the Remote adapter uses the SAME mapping). M3-5 PR4: the official `plugin-manager/changed` notification maps to ONE transport-neutral invalidation hint (`subscribeInvalidation`) — the payload is never treated as inventory truth. Baseline entry added with the module. |
| `src/runtime/direct/job-observation-direct.ts` | `jobController` | The Direct P1-B `JobObservationPort` adapter — the ONLY module that resolves the official `@deepseek-ai/dsh-api-job-controller` service and consumes `follow()`, the official NON-CONSUMING Host observer (it reads only `JobRegistry.readAt()`; it never calls `jobs.read()`, never advances the model `job_output` cursor and never acknowledges a completion notice). The TUI inserts the same `job-controller` row the rc.1 web bundle mounts; the adapter owns only the observer lifetime and frame mapping. Pre-M3 serves this port through the `Backend` (`backend.jobObservation`) instead of a runner-local construction. Same process/Context — NOT M3. Baseline entry added with the module. |
| `src/runtime/plugin-manager-mapping.ts` | (none) | The ONE pure Plugin Manager record mapping (P1, shared by Pre-M3): official `@deepseek-ai/dsh-plugin-manager` records → detached `PluginManagerPort` facts, used by BOTH the Direct Host-service adapter and the generated-Remote adapter so the presentation semantics cannot drift. No Cordis context, Host service or `RemoteResult` crosses it. |
| `src/runtime/remote/plugin-manager-remote.ts` | (none) | Experimental `PluginManagerPort` adapter over the official generated `pluginManager` Remote namespace plus the typed Remote's forwarded `plugin-manager/changed\|install-state\|install-log` events. Mapped through the shared pure mapping; a refused `RemoteResult` becomes one thrown Error (the controller's failure entry), with no retry and no second install state. Composed by the M3 Remote application runtime (`src/app/remote/m3a-semantics.ts`) and served through `Backend.pluginManager`; the forwarded `plugin-manager/changed` AND a new official Connection generation each map to ONE transport-neutral invalidation hint, while an authoritative `snapshot()` reread remains the only business truth (M3-5 PR4). |
| `src/runtime/remote/job-observation-remote.ts` | (none) | Experimental P1 `JobObservationPort` adapter over the official Client `IJobs` (`state.rows` metadata authority, `state.observed` text/gap/streaming/error, reference-counted `watchRows`/`observe`). It owns no follow/cursor/reconnect state machine and never re-clips the official bounded render tail; both leases release exactly once. NOT production-composed. |
| `src/plugin-manager/extension-inventory.ts` | (none) | The TUI-internal read-only projection over the shared `piTuiExtensions` runtime: it aggregates the runtime's own contribution-health records and the internal owner→Loader-entry-id projection into detached observations, used ONLY for presentation classification. It is not a second inventory, loader or enable/disable authority, and is not part of the public Extension API. The service-side seam (`_ownerEntryIds()`, `recordOwnerEntry()`) is package-private. Zero Host-service coupling (the ledger view is injected). |
| `src/runtime/host-file-port.ts` | (none) | The Host-file port interface (M1.10, contract review) — path-only candidates (`{path, kind}`, the official `FileReferenceCandidate` shape); the TUI's ranking/quoting/`@`-insertion value/label/description/directory-continuation are CLIENT policy in mentions.ts, never Host data. Zero Host coupling. |
| `src/runtime/direct/host-file-direct.ts` | (fs only; no ctx services) | The Direct `HostFilePort` adapter (M1.10) — the ONLY module in the `@`-file path that touches the filesystem: fd discovery (fork delegation) or the bounded recursive fallback scan, stat existence probes, `~` expansion. Returns path-only DTOs; discovery bounds only, no presentation. No ctx-service coupling (baseline-free). |
| `src/runtime/session-lifecycle-port.ts` | (none) | The session LIFECYCLE port interface (D2.1/D2.3/D2.4 convergence, alpha.2 ownership escape) — transport-neutral semantic `create`/`open` operations and `SessionHandle` (no Host types). `SessionHandle` carries exactly one backend ownership escape: Direct's `direct` (live Agent + AgentHandle) or Remote's `client` (`ClientSessionOwner`: an exact-binding token plus a `release()` that must run exactly once); `clientOwnerOf()` reads the latter. The Direct runner does not consume `client` yet: Remote stays non-composed until its production composition phase. No `SessionReference` import enters this module. D2.3 removed the ordinary `provider`/`model` inputs from `CreateSessionRequest` and converged `OpenSessionRequest` to `{ sessionId, signal? }` (no `resumeSessionId`/provider/model/preset knobs); `ForkSessionRequest` carries only `sourceSessionId` and optional `atSeq`; seed, child identity, lineage, workspace and model/preset inheritance remain Host-owned. Cancellation is client-local and never serialized. Zero Host coupling. |
| `src/runtime/direct/session-lifecycle-direct.ts` | `agentDefaultModel`, `agents`, `import:dsh-agent`, `import:dsh-session`, `sessionQuery`, `workspaceRegistry` | The Direct `SessionLifecycle` adapter (D2.1/D2.3/D2.4) — the ONLY module converting semantic `create`/`open`/`fork` requests into Direct shapes (preset composition → `setup` callback, `SessionId`, and the official alpha.2 fork mapping: exact `atSeq` cut or `latestCompletedPrefixBoundary` default, seed through the public `@deepseek-ai/dsh-session/fork` `buildForkSeed()`, `inheritedEventCount = boundary + 1`) and mapping the client-local cancellation signal to `agents.create` / `agents.resume`; `agents.resume` is an implementation detail hidden behind semantic `open`. D2.3 moved the Direct-only lookups inside: the activation fallback reads the Host `agentDefaultModel.currentSelection()` (exactly like the official `ApiSessionAgentController.agentOptions()`), and `open` resolves the persisted recorded preset through `recordedSessionPreset`. The runner keeps the process-local surface coordination (transition gate, operation barrier, generation/stale fences) around the port calls; fork dispatch stays outside the destructive transition FIFO, stale Direct children enter a runner-owned park/claim pool, and `open` claims a parked owner before `agents.resume()`. DSH `SessionHandle` / `SessionWriteLease` is the cross-process writer authority. Baseline entries gained `agentDefaultModel` with D2.3 and `sessionQuery`/`workspaceRegistry` with D2.4. |
| `src/runtime/remote/model-remote.ts` | (none) | Experimental M2/D2.3 `ModelCatalog` adapter over the official `session.modelCatalog` / `session.selectModel` Remotes and the Session binding's `modelSelection` projection. Host-free structural inputs, a Connection-generation fence before/after dispatch, and operation-specific settlement (only a proven pre-commit code is `rejected`; no reuse of the D2.2 broad refusal helper). No second global-default write and no custom reasoning normalization. `defaultSelection()` is the CURRENT-generation directory-cache default (invalidated on a reconnect); `sessionSelection()` reads the Client binding's `modelSelection` projection and falls back to that cached default; `listProviders()`/`listModels()` are UNAVAILABLE (empty) in Remote D2.3 — provider-endpoint discovery has no official Remote capability and is never faked from the directory cache (the subagent allowlist that consumes it is a Direct-only surface). |
| `src/runtime/remote/preset-remote.ts` | (none) | Experimental M2/D2.3 `PresetCatalog` adapter over the official `agentPresets.list` roster and `agentPresets.select(sessionId, presetId)` blank-Session write. Host-free structural inputs, generation fence, and operation-specific settlement (`agent-preset/locked` etc. are proven rejections). No local blank reducer or recompose logic. |
| `src/runtime/remote/session-lifecycle-remote.ts` | (none) | Experimental M2/D2.4 `SessionLifecycle` adapter, aligned to the alpha.2 reference contract: ordinary create via official `ClientSessions.create()` + one explicit `retain`, guaranteed-fresh explicit-preset create via generated `session.create({sessionId, cwd, agentPreset})` + public `refresh()` reconciliation + `retain`, open via `retain()` (`binding()` is borrow-only; there is no Client-global selection verb), and Host-owned fork via exactly one `ClientSessions.fork({sessionId, atSeq?})` with NO retain (publication is independent from navigation adoption, which is the separate `open()` call). A post-publication retain/reconcile failure preserves the published identity as `published-with-error`; fork failures preserve published identity or become indeterminate without retry. No Host imports and no invented Host resume RPC. |
| `src/runtime/remote/session-reference.ts` | (none) | The alpha.2 Client reference-ownership seam — the only place the TUI declares its own `SessionReferenceSourceMap` labels (`tuiMainView`, `tuiOperation`, and M3-5 PR2's `tuiChildView`) through a type-only import of the public `@deepseek-ai/dsh-api-session-controller/client` entry. It owns the three lifetime patterns: `acquireMainSurfaceReference()` (navigation create/open; may materialize a generation and never awaits `ready`), `acquireChildViewReference()` (one subagent child viewer's exact generation, addressed by its durable `SubagentAddress` and never materializing a Host Agent) and `pinExistingGeneration()` (borrow an existing generation first, then retain it with `tuiOperation`, so a plain read/write can never cold-open a Session). Release is exactly once (idempotent). No concrete Client implementation, Host implementation, or runtime import. |
| `src/runtime/interaction-port.ts` | (type-only peer imports) | The interaction port interface (M1.6) — uses the official dsh-user-approval / dsh-user-questions types (declared peers). |
| `src/runtime/direct/interaction-direct.ts` | `approval`, `userQuestions`, `sessionProjections` | The Direct `InteractionPort` adapter (M1.6; M3-3B Question reconvergence) — owns the `userQuestions` / `approval` service access, the `approval/request` subscription, and the `sessionProjections` read that maps the official `userQuestions` + `inbox` durable state (the SAME semantics the Remote adapter maps over the wire); the listeners/providers are registered by the surface owner (`SurfaceRuntime.attachInteraction`). Baseline entries added by the M1.6 relocation (commands.ts and index.ts drop `approval` / `userQuestions`) plus the M3-3B `sessionProjections` read. |
| `src/runtime/direct/catalog-direct.ts` | `llm`, `agentDefaultModel`, `agentPresets`, `tools` (the row also takes a type-only `AgentPreset` from `dsh-agent-preset-registry`; the base-package matchers track neither that package nor this file) | The Direct `Catalog` adapter (M1.8; D2.3 convergence) — owns the model directory (`loadDirectory()` = the official `session.modelCatalog` generation snapshot; `listProviders()`/`listModels()` remain the provider-discovery capability), the Session-local model write (`selectSessionModel()` → `WriteOutcome`, best-effort default save never undoing a committed Session choice), the preset roster + official blank-Session write (`roster()`/`selectSessionPreset()`), and the skill sub-domain's service discovery. Consumers depend on the port DTOs. Baseline entries added by the M1.8 relocation (commands.ts drops `llm`/`agentDefaultModel`/`agentPresets`/`tools` access). |
| `src/runtime/direct/model-selection-direct.ts` | `import:dsh-agent` | The Direct Agent-local model-selection owner (M1.12): installs one selection ref per Agent, folds durable Session intent/request headers, and maps explicit Session selection to the semantic catalog operations; a future Remote adapter replaces this ownership escape with `session.models` / `session.selectModel`. |
| `src/runtime/direct/config-direct.ts` | `settings`, `credentials`, `authorization`, `permissionPresets`, `commands`, `agentPresets`, `llm` | The Direct `ConfigPort` adapter (M1.9) — owns the Host schema knowledge (the `llm-pi-ai` / `permission` / `agent-presets` settings namespaces), the credential/authorization service access, the credential event wiring, the official `/permission` command line for the `/yolo` switch, and the `llm` directory reads ONLY for the provider-profile target resolution (the keyless-profile write + the merged /login option list). Consumers never name a settings namespace or touch the raw services — the merged /login options cross as the port's `CredentialProviderOption` DTO (semantic flags only: `canProvisionProfile` collapses the namespace/path facts; ONE adapter-owned rule `isKeylessProfileSlot` drives both the flag and the write-time validation, so they can never drift). The authorization contract is an EVENT surface (contract review): the adapter bridges the upstream callback-shaped interaction into detached begin→attemptId→notice/prompt events→respond/cancel — no callback-bearing interaction ever crosses the port (a Remote adapter replays the same events from the wire). Baseline entries added by the M1.9 relocation (commands.ts drops `settings`/`credentials`/`authorization`/`permissionPresets` access; the `/yolo` commands-execute access moves here; index.ts drops `credentials`/`authorization`; the `llm` entry was added with the M1 review round-2 target-resolution fix). |
| `src/image/*` | (structural `ctx.attachments` / `ctx.llm` subsets, injected) | Already seamed; image intake/submit/loader. |
| `src/default-intent.ts` | (none) | The pure D2.3 sessionless `/model` default-intent state machine (operation ancestry + settle authority). It uses the structural `ModelSelectionValue` (generic over the caller's selection type) — no `ctx`, no Host services, no I/O, no Host import. |
| `src/sessions.ts` | `import:dsh-session` | Type-only session types. |
| `src/stats.ts` | `import:dsh-session` | Type-only. |
| `src/transcript.ts` | `import:dsh-session` | Type-only; transcript folding must consume the client session event/window, not transport (plan §20). |

### CLIENT_LOCAL (no Host coupling — keep it that way)

Terminal rendering, editor, keybindings, clipboard/OSC52, input history,
search UI state, picker cursor, overlay state, fullscreen, theme, draft
state, the shell editor mode / gesture parsing / shell card / bounded tail /
fold/copy presentation (execution is Host-owned — see the user-shell SPLIT
below), question/approval *presentation* (the
authority stays Host-owned), and session transition coordination
(`src/transition-gate.ts`, `src/transition.ts`,
`src/session-operation-barrier.ts` — the process-local single-writer
transition rules; zero Host coupling). Pending-input presentation is
Client-local policy over the semantic projection: the ephemeral steering lane's
`steering…` / `waiting for next turn…` label derives from the subject's
`placement + running` state in `src/tui-app.ts`, and the parked-steering
recovery notice in `src/steer.ts` explains the official next-wake path while
performing no Host write. Representative files:
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

### User shell ownership (shell amendment, M3-4 PR3)

`!` and `!!` are both Host-side user-shell operations; bypass/sandbox are
Host execution policies, not locality choices, and the two gestures differ
only in result routing (`!` submits into Session/model; `!!` stays
presentation-only). The ownership split:

```text
CLIENT_LOCAL:
  shell editor mode
  gesture parsing
  shell card / bounded-tail presentation
  local bounded display cache / temp artifact (labelled Client-owned)

HOST_OWNED:
  user-shell execution
  cwd / workspace
  PATH / environment
  shell discovery
  process lifetime
  process cancellation

SPLIT:
  request/stream/control bridge (HostUserShellPort)
  `!` result handoff into Session (SessionWriter)
```

The application owner (`src/app/submission/user-shell.ts` (renamed by the
PR3 refactor) consumes the narrow `HostUserShellPort` semantic port; it never
owns Client process execution. The Direct adapter is the in-process Host
(bypass spawn and the `ctx.shell` sandbox policy live behind adapter
ownership); the Remote adapter reports the truthful unavailable state because
the rc.2 terminal-controller Remote is a retained interactive PTY carrier and
fails the one-shot qualification (CARRIER_GAP, U11a/U11b open). No row of
this inventory may describe the application submission owner as the owner of
Client process execution.

Clipboard writes are CLIENT_LOCAL and share ONE app-level policy. The
fullscreen drag selection and `/copy` are the same user copy intent and both
call `copyToClipboard()`; it delivers through two INDEPENDENT legs — the
terminal-client OSC 52 sequence and the native/platform compatibility helpers
(`tmux load-buffer`, `pbcopy`, `wl-copy`, `xclip`, `xsel`, `clip`). A helper
success must never suppress the terminal-client leg: on a remote host a helper
that succeeds would otherwise short-circuit the copy and strand the text in the
remote clipboard, which the user cannot paste from. The Direct/Remote backend
mode does not determine clipboard locality (ORCA/xterm.js is remote transport
with a Direct backend). The OSC 52 leg is best-effort by construction (no ACK),
so an emitted sequence is never proof that the user's clipboard changed. No Host
clipboard semantic port or Remote RPC exists for this.

### TEMPORARY_EXCEPTION

| File | Coupling | Why it is allowed |
|---|---|---|
| `src/startup.ts` | (none by design) | Zero-dependency compatibility island; must never import experimental client/runtime code (plan §23). |
| `src/builtins.ts`, `src/extensions.ts` | `ctx.get(TUI_STARTUP_SERVICE)` / `ctx.get(PI_TUI_EXTENSIONS_SERVICE)` | The TUI's own services, not Host services; excluded from the gate patterns. |
| `src/index.ts` (`loader`, `appExit`) | `ctx.get('loader')`, `ctx.get('appExit')` | Cordis/dsh process services with no Host business state; excluded from the gate patterns. |
| `src/app/remote/host-runtime.ts` | (none — `ctx.reflect.get(...)` is not a tracked pattern) | M3-1 experimental Remote Host composition owner (`docs/m3-entry-contract.md` §2.4.1). The earlier `import:dsh-session` baseline entry was removed when the gate matcher was narrowed to exact package matching; the module imports `dsh-session-stats` / `dsh-session-turn-outline` / `dsh-session-log-export` projection plugins, not the Host `dsh-session` type package. |
| `src/app/remote/client-runtime.ts` | (none) | M3-1 experimental Client composition owner (`docs/m3-entry-contract.md` §2.4.2/§2.4.3). The earlier `import:dsh-agent` baseline entry was removed when the gate matcher was narrowed to exact package matching; the import is `dsh-agent-preset-registry/remote` — a Remote contribution, not the Host `dsh-agent` type package. |

The M3-1 composition owners also introduce the first scanned `src/app/remote/**`
coupling of a new kind: they mount official Host plugin rows by plugin object
(the rows' own `inject` declarations carry the service dependencies) and read
service presence through `ctx.reflect.get(...)` for fail-fast diagnostics. This
is Host-side composition sanctioned by the frozen M3-0 contract, not Client-side
business coupling; the M3-4 bootstrap integration owns any future inventory
relocation.

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

Two UI ownership forms are legal (2026-10-03 clarification):

```text
CLIENT IMPERATIVE UI:
  callbacks/components/renderers/editors/keybindings
  remain Client-local (the existing PiTui extension API).

HOST DECLARATIVE SURFACE:
  Host state/callbacks remain Host-owned;
  only serialized facts/tree/action identity cross an official Remote;
  Client owns rendering and local input presentation.
```

No executable callback/component/renderer/editor object crosses the process
boundary in either form, and neither form creates a current rc.2 capability.

### Direct command compatibility mirror vs Host-origin ownership (M3-4 PR5)

The one command-registry seam where Direct couples to the Host, and the exact
boundary of that coupling:

```text
Direct commands.register(TUI definition)
  = compatibility EXECUTION mirror
  != semantic Host-origin ownership

effective winner's exact registered `definitionId`
  = mirror provenance discriminator

Host-only catalog source
  != display/completion synthesis
```

- A successful Direct Host registration of a TUI definition is a mirror: it
  exists so in-process Host dispatch keeps working, and this surface records the
  exact `definitionId` it stamped on that registration. Host ORIGIN is the
  effective winner view with those stamped mirrors SUBTRACTED; raw registry
  membership is never origin.
- A same-name **Agent-scoped** genuine Host definition SHADOWS the global mirror
  as the complete effective descriptor (official `ScopedLayers` winner rule), so
  it keeps its own identity — including no identity at all — and must not be
  subtracted by name.
- The origin map's inputs are pure Host rows on every path (Host global layer +
  Host-derived scoped overrides on Direct sessionless; the effective
  `commands.list(agent)` view on Direct live; the Host-derived surface snapshot
  on Remote). Client registrations, extension contributions and completion
  synthesis join only the DISPLAY list and the advertised-claim view, and never
  flow back into origin authority.
- `definitionId` is provenance/discovery metadata ONLY — never authorization,
  trust, or a capability grant.

## How to update this file

1. A migration phase moves coupling into a semantic port: move the entry to
   the port's row, update `scripts/client-boundary-baseline.json` (the gate
   then stops flagging the relocated pattern), and record the phase in
   `docs/client-server-migration.md`.
2. New feature code must NOT appear here — the gate rejects it first.
3. Keep the `HOST_SERVICES` list in `scripts/client-boundary-gate.mjs` in
   sync with this inventory when upstream adds a service the migration must
   isolate.
4. Composition ownership changes follow the row classes above:
   - a semantic coupling move updates the allowlist row and the boundary
     baseline intentionally;
   - a composition-owner change updates this ownership inventory and amends
     `docs/m3-entry-contract.md` when the frozen architecture changed;
   - implementation progress alone never changes frozen ownership;
   - a fixture that adds a production prerequisite documents its topology and
     does not automatically grant product composition ownership.
