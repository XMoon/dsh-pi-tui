# Host/client architecture and Direct/Remote contract

This document owns the long-lived Host/Client boundary: locality, the semantic
port contract, Direct/Remote equivalence, currentness/identity rules and the
qualification tiers. Direct remains the production backend; Remote is the
experimental in-process official wire with no public selector.

The current Host-coupling allowlist is
`scripts/client-boundary-baseline.json`, enforced by
`scripts/client-boundary-gate.mjs`. Do not recreate a hand-maintained
file-by-file inventory here: the gate and its baseline are the authority, and a
new coupling site in an already-allowlisted file is still new debt.

## Locality

Every Host-touching feature declares exactly one locality before implementation:

| Locality | Examples |
|---|---|
| Client-local | terminal rendering, editor/keybindings, clipboard/OSC 52, input history, search/filter/picker/overlay/fullscreen/theme/draft state, the current draft external editor, Client draft file/image intake, Client artifact output, local media/URL opening |
| Host-owned | Agent, Session, subagent, jobs, tools, LLM/provider/model catalog, skills, agent presets, persistence, session search, approval/question authority, Host workspace/filesystem references, Host shell/tool execution, credentials, settings |
| Split | `!`/`!!`, `@file`, `/open`, `/image`, `/export`, working directory |

The Client process cwd/filesystem is never the Host workspace. `@` means the
Host workspace under Remote attach; one authoritative Host `workingDirectory`
supplies the effective cwd while the Session header stays the immutable original
project. Only serializable data, opaque identity, methods and event facts cross
the boundary. Host service objects, Cordis Context, Agent/Session handles,
profile paths/manifests, `Dirent`/`Stats`/filesystem handles, callbacks,
renderers, editors/keybindings and executable component objects never cross.

Consequences that are part of the contract:

- A port exposes detached semantic facts and semantic operations; it never names
  a transport, a profile path or a Host implementation object.
- Host workspace semantics (`@file`, Host user-shell execution, future
  Host-owned filesystem editing/open) require an authoritative Host seam and
  fail closed until one exists.
- Client-local semantics (terminal/editor UI, draft external editor, Client
  draft intake and artifact output) stay Client-local.
- A Remote consumer never reads a Host `workingDirectory` to drive a
  Client-local gesture, and the Host never writes terminal bytes.
- On the Remote branch, `!`/`!!` execute in the Host environment through
  `HostUserShellPort`; until a qualified one-shot Host carrier exists they fail
  closed (`{ kind: 'unavailable', reason: 'carrier-gap' }`) and execute nothing,
  for both policies. The draft external editor stays Client-local; a future
  Host-filesystem editor/open is a separate capability.

## Semantic ports and composition

`Backend` is an assembly of narrow domain ports (`subagent`, `sessionReader`,
`pendingInputReader`, `sessionWriter`, `sessionLifecycle`, `interaction`,
`catalog`, `config`, `hostFile`, `sessionArchive`, `hostCommand`,
`pluginManager`, `jobObservation`, `hostUserShell`), never a `TuiBackend` god
object. A port exposes detached semantic facts, opaque identities/request ids,
event surfaces (for example authorization: begin → attemptId → notice/prompt →
respond/cancel) and semantic operations. It owns no Host database, state machine
or transport.

Host service resolution belongs to:

- the Direct semantic adapters in `src/runtime/direct/**`;
- the Direct runtime policy/facades in `src/app/direct/**`;
- the application composition root `src/app/bootstrap.ts`.

`src/app/host/**` is the bundle's permanent Host plane: it registers with
explicit `inject` and `ctx.reflect.get`, and consumers read only semantic DTOs or
port values. The Remote graph is ONE `RemoteHostRuntime` + ONE official Client
Context + ONE semantic assembly + ONE owner registry, reached only through the
single dynamic edge `src/runtime/backend-loader.ts` →
`src/app/remote/runtime.ts`. Base/profile-owned Host services are reused, never
remounted; optional generated Remotes are mounted by their feature Client owner
without duplicating core namespace or authority.

Must-not:

- Read an uninjected Host service from a UI/application module.
- Expose a Host service object, profile path, package manifest, Cordis Context
  or transport object through a port.
- Import the bootstrap composition zone from an owner.
- Construct a Direct semantic adapter in `src/app/surface/**`.
- Mount a second copy of a base prerequisite to satisfy Remote composition or a
  test.
- Create a second Client Context/Host graph/semantic bundle.
- Spread a generated Remote namespace or detach a receiver-sensitive method
  (`const on = source.remote.$on; on(...)`).
- Add a public `--backend`/env/config Remote selector before the migration
  milestone authorizes it.

Generated Client/Remote objects must keep their identity and prototype
accessors; a fixture must reproduce production prerequisites without adding a
second Host service or runtime graph.

## Direct/Remote semantic equivalence

Direct and Remote implement the SAME port and share the SAME pure
mapping/controller for a feature, so semantics cannot drift. Parity is asserted
on semantic outcomes, not internal shape. The official Client Runtime owns
Connection/Gateway/Remote namespaces/Sessions/Jobs/subscriptions and transport
state; the TUI owns presentation/fold only and keeps no second event fold or
transport copy.

Every Remote async result is fenced by the Connection generation captured
**before dispatch**:

- success, official refusal and transport rejection are all generation-bound;
- a reply carried by a superseded generation is never presented as the current
  generation's definite outcome;
- a known stale result becomes an indeterminate outcome (or
  `PluginManagerStaleResultError` at the port), not a refusal and not a success;
- the surface then reconciles through an authoritative reread or the original
  request id.

An indeterminate write is never auto-retried and never reported as committed.
Callbacks/components/renderers/editors/keybindings remain on their owning side;
Host-originated declarative UI crosses only as serializable facts/tree/action
identity.

Regression anchors: `test/application-runtime-selection.test.ts` (one loader
call, no Direct factory, no user selector),
`test/remote-plugin-manager.test.ts` (superseded mutation never paints success),
`test/remote-session-writer.test.ts` (post-dispatch generation replacement is
indeterminate, never replayed), `test/remote-client-runtime.test.ts` (one
materialized generation and binding identity).

## Currentness, operation ownership and request ids

Capture the generation/identity before dispatch, re-check it after every await
and before every visible mutation. A superseded result mutates nothing and is
either transport-neutral indeterminate (`WriteOutcome.kind: 'indeterminate'`)
or a quiet drop.

`OperationOwnership` is a second axis:

```text
superseded  = the result no longer owns the surface
              (it says nothing about whether the Host committed)
committed   = the operation settled; a Host commit stays a real commit even
              when its UI result is superseded
indeterminate = the outcome is not knowable; never retried automatically
rejected    = a proven pre-commit refusal; the caller may restore intent
cancelled   = the operation was cancelled before a definitive outcome
```

Install work is addressed by one caller-owned `requestId`: the same id is used
by `waitForInstall`/`cancelInstall`, a new explicit approval gets a NEW id, and
an unknown result is reconciled through the official wait/reread — never claimed
as success and never retried automatically.

The controller keeps one mutation in flight, keeps `busyValue` set until the
authoritative inventory reread completes, refuses writes from a stale/error/
loading snapshot, and blocks further writes after a failed reread until a
successful refresh. A stopped surface refuses pre-dispatch writes and does not
restore into a destroyed editor; a dispatched write keeps its accepted receipt
and is never reinterpreted.

## Plugin Manager

`@deepseek-ai/dsh-plugin-manager` is the sole authority for package/profile
truth, enablement, installed state, install/remove, compatibility and version
exemptions. The semantic port projects **detached** `PluginBundleFact`
(`official`, `availability`, `installTarget`, `version`, `enabled`, `installed`,
`optional`, `source`, `removable`, `readOnlyReason`, `error`, `rows`,
`overrides`), `PluginRowFact`, `PluginRegistriesFact`, `PluginExemptionFact` and
`PluginChangeFact` (`application`, `restartReason`, `version`, `pendingBuilds`,
`approvedBuilds`, `packageResult`, `registries`, `failedAt`). The port owns no
installed-package database, no enabled truth and no compatibility evaluation.

The ordering is fixed:

```text
Host fact
  -> shared detach/mapping (Direct and Remote use the same functions)
  -> detached snapshot
  -> buildPluginManagerModel / classifier
  -> controller admission (stable card value, canToggle, availability,
     self/read-only checks)
  -> UI action
  -> official Host mutation
  -> authoritative snapshot() reread
```

The classifier assigns a presentation section only from exact provenance: exact
`SELF_BUNDLE`, proven Loader `entryId`, Host `official:true` + exact rc.2 B01–B14
id, exact base bundle id, proven profile-owned non-official, else an audited
"Unverified origin". A `@deepseek-ai/` scope or an `experimental` substring is
never evidence. The UI never guesses a capability from a name, enablement,
`fiber` or availability.

Install lifecycle:

- ONE controller owns the install/reconcile/read epoch/state machine for both
  `/plugins` and Settings → Plugins; they share the same workspace/physical
  screen lease.
- `inspect` → explicit confirm → `installBundle`; approval reuses the exact
  Host-reported `pendingBuilds` under a NEW request id.
- `cancelInstall` reports `cancelled | too-late | not-running`; a closed/reopened
  page restores the current attempt rather than dispatching a second one.
- A blocked-build risk approval is explicit and dispatches the second real Host
  attempt only after approval.
- Disposal never cancels a Host install; an unknown result is not resubmitted.

Upgrade guidance is a source-derived read-only policy (no in-place update, no
version picker, no silent reinstall): shipped → upgrade DSH; profile-owned →
Remove then an explicit later Install; missing with an official target → Host
offered target; missing without a target → not installable; self → managed
outside the screen. It must not leak tokens and must not perform a mutation from
read-only advice. The exact B01–B14 copy is bounded app presentation for the
official Experimental bundles, not a public capability API; do not turn it into
a capability table in docs.

## Agent composition policy

Two independent communication preferences are parsed once and read live at each
agent-composition assembly:

- `ProgressUpdatesState = off | milestones | frequent` (default `milestones`);
- `ResponseStyleState = default | concise | explanatory` (default `default`).

`/settings` applies the runtime choice first and then performs the serialized
whole-document write; a failed save does not undo the live choice. Sections
register in a fixed order (progress updates 80, response style 81, Focus 90,
tool guidance 100+), and providers read the live state each assembly. Focus
suppresses the effective progress section for every cadence while leaving the
saved cadence untouched (restored on exit); response style stays active.

Locality: the preference state and rendering are Client-local; the Host-side
agent composition consumes the parsed values. Authority:
`src/domain/communication/policy.ts`, `src/domain/communication/focus.ts`,
`src/app/direct/system-prompt.ts`. Proof: `test/communication-policy.test.ts`
(Focus suppression + pinned section registration).

## Workflow terminal-state authority

A Workflow run/member status is settled ONLY by its own terminal event:
`tool-workflow/run-end` for the run and `tool-workflow/agent-end` for a member,
matching `runId` + `seq`. A run without `run-end` is an OPEN durable record and
reads `running`. Step/Turn closure, main-Agent idle and the next `turn/start`
carry no Workflow authority and never settle or "interrupt" a run.

ONE `WorkflowProjection` serves both the visual Transcript fold and
`/transcript` Markdown export, so the two cannot drift. The renderer only
derives counts/phase groups/aggregate status/disclosure mode and never writes
durable status back to the projection.

## Request-zone metadata

Request-zone metadata is Client-local **sampling** but Host-owned
**interpretation**:

- One per-submit `Intl.DateTimeFormat().resolvedOptions().timeZone` sample,
  validated against the strict IANA/`UTC` profile the Host reader enforces.
- Direct samples at the send point and writes
  `UserMessage.source.clientTimeZone`.
- Remote adds no TUI field: the official `SessionFace.prompt()` samples and the
  Host validates/canonicalizes it.
- Continuable child follow-up samples once immediately before dispatch on the
  official `subagents.prompt({ clientTimeZone })` request.
- An unsamplable/unusable zone refuses before dispatch and restores the draft.
  The Host process zone is never substituted.
- The Host owns `resolved`/`mixed`/`unavailable`, refresh cadence and display
  fallback. The TUI does not derive a zone from rendered timestamps and keeps
  no timezone setting/store.

## Terminal status authority

Exactly ONE adapter owns the main-Agent terminal outcome on each branch:

- **Direct** keeps the local durable-event evidence
  (`mainProgressAuthority: 'local-events'`): `agent/status` plus matched
  `turn/start`/`turn/end` in `src/app/surface/event-routing.ts`.
- **Remote** hands the outcome to this bundle's OWN Host composition
  (`mainProgressAuthority: 'host-snapshot'`):
  `src/app/remote/terminal-progress-host.ts` observes durable turn boundaries
  and live Agent status edges in true synchronous order, fences them by the
  exact live Agent object and the exact `agent.session` object, classifies with
  the shared `src/domain/terminal-progress/interval.ts` fold, and serves one
  per-session snapshot plus an ordered stream carrying
  `hostEpoch`/`agentEpoch`/`revision` over the private
  `piTuiTerminalProgress/watch` Typert contract.
  `src/app/remote/terminal-progress-source.ts` validates every frame, re-checks
  the Connection generation and exact retained binding per frame, and enforces
  per-watch provenance: an opening snapshot carries only the current `running`
  truth with `idle` (marked `restart`); a proven `done`/`error` is delivered
  only by an `update` of the watch that observed its interval. A broken
  frame-less stream fails closed to idle and is reported.
  `Surface.applyRemoteMainProgress` is the one Remote commit. The Host never
  writes terminal bytes.

Limits: this works only with this package's Host composition; an arbitrary
third-party DSH Host has no Remote terminal status. Real GUI terminals and real
Loader/official-wire packaging remain manual/pre-release qualification. The
`terminalProgress` setting round-trips on both branches as a Client-local
preference; only the physical projection differs.

## Coupling and architecture gates

```text
pnpm gate:boundary      scripts/client-boundary-gate.mjs + scripts/client-boundary-baseline.json
pnpm gate:architecture  scripts/application-architecture-gate.mjs
```

`client-boundary-gate.mjs` scans `src/**` for `ctx.get('<host service>')`,
`ctx.<host service>` (optional chaining included) and exact
`@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-session` imports (type-only counts),
then compares `(file, pattern)` pairs against the frozen baseline. A new pattern
in an already-allowlisted file is still new debt and fails. The baseline is
updated only for a deliberate migration-phase relocation, with the coupling
contract updated in the same PR.

The architecture gate enforces the dependency direction (see
[overview.md](./overview.md)) and the single sanctioned dynamic Remote edge.

## Qualification tiers

| Tier | Proves |
|---|---|
| L1 | Semantic-port contract |
| L2 | Direct adapter contract |
| L3 | Remote adapter contract |
| L4 | Direct↔Remote parity |
| L5 | Official in-process wire: real Client Context → Gateway → Host, no TUI runner |
| L6 | Application composition: real runner/owner wiring and settlement |

Rules:

- A closure cites the level that actually proves the fact; do not add a higher
  level "for completeness".
- Structural fakes are legitimate at L1–L3 but never prove official
  generated-object shape or production composition.
- Every wire-sensitive Remote capability needs at least one L5 proof. L6 is
  required when application ownership, navigation, recovery, presentation
  parity or reachability is the fact.
- Positive success-path evidence is mandatory for a SUPPORTED capability;
  negative evidence (absent service → unavailable, stale generation → reject,
  unsupported → fail closed) never substitutes for it.
- Every new/materially modified L5 fixture states
  `PRODUCTION PREREQUISITES REPRODUCED`, `TEST STAND-INS/SUBSTITUTIONS` and
  `DELIBERATELY ABSENT`. A fixture missing a production prerequisite documents
  it and never grants composition ownership; a blocked fixture reports
  `BLOCKED`, never a local same-name substitute.
- Every migration PR leaves the Direct path green. Remote L6/contract smokes and
  the `smoke:remote-*` lanes are the wire/application evidence, not
  implementation files.
- Never present a Host-only suite as a TUI PASS, a skipped/mode-gated CI step as
  passed, or a lane green on a different snapshot.
