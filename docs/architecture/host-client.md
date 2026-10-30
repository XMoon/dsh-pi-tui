# Host/client architecture and Direct/Remote contract

This document owns the long-lived Host/Client boundary: locality, the semantic
port contract, Direct/Remote equivalence, currentness/identity rules and the
qualification tiers. Direct remains the production backend; Remote is the
experimental in-process official wire with no public selector. An internal,
Linux-only split-process entry (`dist/local-host.mjs` / `dist/local-client.mjs`)
qualifies the same npm package over an authenticated loopback HTTP/WebSocket
carrier; it is not a package export, bin, backend selector or Session surface.

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
`pluginManager`, `jobObservation`, `hostUserShell`, `deliveredFileRead`), never a
`TuiBackend` god object. A port exposes detached semantic facts, opaque identities/request ids,
event surfaces (for example authorization: begin → attemptId → notice/prompt →
respond/cancel) and semantic operations. It owns no Host database, state machine
or transport.

Host service resolution belongs to:

- the Direct semantic adapters in `src/runtime/direct/**`;
- the Direct runtime policy/facades in `src/app/direct/**`;
- the application composition root `src/app/bootstrap.ts`.

`src/app/host/**` is the bundle's permanent Host plane: it registers with
explicit `inject` and `ctx.reflect.get`, and consumers read only semantic DTOs or
port values. `src/app/host/pi-tui-host-runtime.ts` is the ONE built-in Host
Runtime Loader row; `src/app/host/features/**` are its two internal business
modules, not independent plugins. The Remote graph is ONE `RemoteHostRuntime` +
ONE official Client Context + ONE semantic assembly + ONE owner registry,
reached only through the single dynamic edge `src/runtime/backend-loader.ts` →
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

## Split-process local Host transport

The internal split-process entry is two OS processes from ONE installed npm
package. It is Linux-only, Linux abstract AF_UNIX sockets are its only process
admission authority, and the non-Linux entry fails before writing runtime files
with `B1_PLATFORM_UNSUPPORTED`. No PID file, `O_EXCL` marker, registry record or
`hasLiveClient()` result may stand in for that kernel ownership.

- **Scope.** The official `resolveDshHome()` / `resolveProfileDir()` results
  canonicalized through `realpath` plus the current UID decide the scope. The
  private run directory is `<DSH_HOME>/run/dsh-pi-tui/<scopeId>/`, created and
  proved 0700. The same canonical profile directory shares one scope across
  workspaces; the Client cwd is not a scope input.
- **Single Host / single TUI seat.** The Host holds one abstract socket from
  before the profile Context exists until process termination; a second Host
  candidate loses `bind` and exits without building a Context, webserver, Agent
  or Session. The Client holds a second abstract socket for its lifetime; a
  second Client fails `CLIENT_ALREADY_ACTIVE` before spawning or touching a
  Host. Kernel release on process death is the only stale-seat recovery.
- **Identity is authenticated, never registry-only.** The registry
  (`instance.json`, 0600) is an unauthenticated hint containing the scope,
  canonical profile path, `instanceId`, Host PID, Linux `/proc/<pid>/stat`
  starttime, loopback origin, protocol `m4-b1/1`, installed bundle/DSH versions
  and the installed-build fingerprint. Readiness requires the official
  `dsh-client-connection` `/connect` launch-token exchange (signed Cookie) and
  the owner-only authenticated identity Fetch route
  `/api/pi-tui.local-host`, with every identity field strictly equal to the
  registry and the current kernel starttime. A different build or protocol is
  `HOST_BUILD_INCOMPATIBLE`; a mismatched authenticated identity is
  `HOST_IDENTITY_MISMATCH`; neither replaces or kills the live Host.
- **Official carrier only.** The Host reuses the base `typert-gateway` row and
  mounts exactly one `dsh-client-connection` owner and one `dsh-api-remotes`
  forwarded-event source on the Host-only overlay. The Client installs the
  official Node `typert-registry`, `client-connection` and `api-gateway` halves
  on the single A0 Client Context with a Cookie-bearing
  `fetch`/`createWebSocket` and `streamBaseUrl`. `ownsHost`, in-process
  RPC/openStream bridges, custom Bearer/Basic auth and any second business RPC
  are prohibited. The only private route is the read-only GET identity route
  behind the official `/api` admission; it carries no Session, write,
  shutdown, approval or version-switch operation.
- **Secret boundary.** The launch token lives only in the Host process and its
  0600 `launch.json` (atomic same-directory rename); the Client keeps its own
  Cookie in memory only. Neither token, Cookie nor `connectUrl` may appear in
  the registry, stdout/stderr, logs, argv or environment. The registry and
  launch files are 0600, the run directory 0700, and unsafe ownership, modes or
  symlinks fail closed.
- **Lifecycle.** A Client exit, crash or HUP disposes only the Client subtree,
  official transport, Client root and Client seat. It never calls a Host
  shutdown. The Host's official `runProfile` shutdown owner is the only Host
  stop; its cleanup first withdraws the identity route, then shuts down, then
  removes only files matching its own `instanceId`, then closes the kernel seat.
  A replaced Host's files are never deleted by another instance.
- **Session boundary.** The Client derives `connecting | connected | disconnected`
  from the official Connection state and generation on every read and never
  copies it into a long-lived flag. `sessionOpen` is a LIVE projection of the
  official `tuiMainView` reference count on the current Session — never the
  launch `--session` intent, the Domain mount or a cached boolean. No business
  mutation is replayed across a transport reconnect; a write whose ACK was lost
  is `indeterminate` and the next Client reconciles it from the Host's durable
  log instead of retrying. The protocol guarantees only a reconnect to the same
  Host; a Host crash is not a graceful migration.

### Host composition and the built-in PiTui runtime

The Host Profile's Loader is the only Host composition authority: one
`runProfile()` creates the Host Context, and every Host service row is owned by
that Loader. The Host-only overlay disables the TUI surface rows, keeps the B1
Connection and API-remotes rows, and adds exactly the official Session-serving
rows plus ONE built-in `@xmoon76/dsh-pi-tui/host-runtime` row. That built-in row
owns the package's ONE private Typert contribution and its two private business
services (`piTuiFileReferences`, `piTuiTerminalProgress`); the feature modules
are not independent Loader rows, configurable plugins or package subpaths. The
row publishes `piTuiHostReady` only after both service bindings are live.

`performance-host` remains an independent Host projection row, and
`visual-tools` remains an independent Loader row; neither is absorbed into the
built-in runtime. `src/app/remote/host-runtime.ts` is only the legacy in-process
test composition for the old L5 fixtures: it mounts its own additive official
rows and verifies the built-in runtime's readiness gates, but it never mounts
the private contribution/services or the Performance projection and is not the
production Host graph.

The Host-only readiness audit requires every official Session-serving row and
the built-in row to be ACTIVE, checks the official and private Typert
`serviceKey`/`namespace` bindings, and requires both `piTuiHostReady` and
`piTuiPerformanceReady` before it publishes the authenticated B1 identity. A
missing row, artifact, binding or readiness gate fails Host startup before any
identity is published.

### Client composition, Session references and the real surface

The split Client keeps ONE Cordis root and ONE official
Typert/Connection/Gateway graph. Its Domain plane is mounted by one
`mountRemoteClientDomains()` call: the generated `/remote` contributions, the
package's ONE private contribution, then the official fileUpload -> Sessions ->
Jobs Client plugins. This function never creates or disposes the Context,
Connection or Gateway. The official Client bundles and generated `/remote`
descriptors are resolved from the installed DSH anchor. The Client shell also
supplies the official web seed's platform static `@deepseek-ai/dsh-client-store`
from the installed Harness family (its declared DSH peer); the browser-form
`/client` bundles' `require` therefore resolves the SAME singleton the web shell
shares, while `@deepseek-ai/cordis` resolves as a normal import. No source-tree
descriptor may mix with that installation.

Above the Domains, the Client mounts exactly one Client UI subtree (extension
host + first-party builtins), one split application runtime (Backend + the ONE
shared owner registry + presentation bundle) and one real runner fiber. The
runner adopts the pre-built Remote selection by identity; the Client bootstrap
never constructs a second Backend, owner registry or presentation graph. A
mounted Session is committed to the visible surface only through the official
`retain()` reference, `ready` AND `openState === 'open'`; `ready` alone is not
an open history.

Disposal is one reverse chain, owned by `LocalClientHandle.dispose()`: runner
surface (TUI state + the owned `tuiMainView` reference + session retirement +
the selected presentation/backend adapters) -> Client UI subtree -> the SAME
memoized presentation/backend/Domain release -> the borrowed B1 transport ->
the Client root. The runner may trigger the memoized adapter release during its
own teardown; the bootstrap's later call never unmounts a second time. A Client
exit, SIGTERM/SIGKILL, terminal EOF or surface teardown never calls the Host's
shutdown, cancels a Host Agent, or releases a Host Session on the UI's behalf.

The internal surface mode gives the tty to PiTui and routes structured
telemetry to a private 0600 JSONL file; the frozen B1 stdin/stdout JSON control
channel remains the qualification mode only, and JSON records never share the
real terminal. A surface-mode Client is the shell for the official web-form
Client bundles, so it supplies exactly the platform statics those bundles
require; it does not add a second transport, session RPC or Host service.

### Client detach, pending interactions and Client-only surface revisions

Detaching a Client (clean exit, SIGKILL, transport loss or surface teardown)
never terminates Host work that the Host already accepted. The Host's exact
Agent, Turn, Tool, Job and Child objects keep their own Host lifetimes; a new
Client attaches through the official authenticated Session reference and reads
the durable Session log plus the live event stream. Only an explicit human
Stop/navigation action sends the Host Agent cancel; a Client detach is a
release of the Client's `tuiMainView` reference and transport, never a Host
cancel in disguise.

The Host Gateway's pending forwarded events are the ONE recovery channel for a
Question or Approval that was waiting when the Client left. A Client surface
teardown must not settle a Host-owned forwarded request: it drops its local
presentation without sending an answer, cancellation or `next` that would
permanently settle the Host event. A later Client receiving the same event id /
call id may answer it once through the official answerer; the Host pending map
clears only on the Host's own settlement. A settled, cancelled or replaced
request is never resurrected from an old Client's painted card.

The installed rc.4 Client event pump consumes a Host-pending forwarded event
as soon as its Connection generation opens, before a fresh Client's official
Domain/interaction owner can register an answerer; the pump has no pre-start
listener gate or replay buffer. A fresh Client therefore cannot recover a
legacy Host-pending Question/Approval after the prior Client dies with only the
public rc.4 Client API. That is an upstream capability gap, not a Host Gateway
pending-map failure and not a reason to add a private PiTui pending store; an
upstream pre-pump registration gate/buffer or an explicit Client restore API is
required before this contract can be claimed end to end.

The internal split mode also supports one Client-only surface revision
replacement on the SAME Client PID, Client Context and B1 transport: the
current runner, Client UI subtree and memoized application/Domain graph are
retired in reverse order, then a fresh revision is mounted and must reach a
real TTY-ready state before it is reported mounted. Host `runProfile`, Agent,
Job and service fibers are untouched. Revision identity and status are
qualification observations only; they grant no Host authority, and no second
runner may ever hold the tty at the same time.

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

Regression anchors: `test/app/application-runtime-selection.test.ts` (one loader
call, no Direct factory, no user selector),
`test/runtime/remote/remote-plugin-manager.test.ts` (superseded mutation never paints success),
`test/runtime/remote/remote-session-writer.test.ts` (post-dispatch generation replacement is
indeterminate, never replayed), `test/runtime/remote/remote-client-runtime.test.ts` (one
materialized generation and binding identity).

## Delivered-file read (Host-owned)

The delivered-files PREVIEW reads file content, so it is Host-owned, not
Client-local:

| Fact | Authority |
| --- | --- |
| Locality | Host-owned (the file lives in the Host workspace) |
| Semantic port | `DeliveredFileReadPort` — `stat(sessionId, path, signal)` and `read(sessionId, path, offset, signal)`: the caller chooses the OFFSET only, the page bound is the port's own (`DELIVERED_FILE_PAGE_LINES`, one page per read) |
| Direct adapter | `runtime/direct/deliverables-direct.ts` over the in-process official Host file service |
| Remote adapter | `runtime/remote/deliverables-remote.ts` over the official generated `workspaceFiles` namespace |
| Host service | `@deepseek-ai/dsh-api-workspace-files` (`workspaceFiles`), mounted ONCE by the bundle's `cordis.patch.yml` row and reused by the Remote Host graph |
| Wire story | the official `workspaceFiles/stat` and `workspaceFiles/read` Remotes — no TUI-specific RPC, DTO or transport state |

Path facts: the DECLARED path is whatever the Session's durable
`deliverables/presented` event recorded — a Host path string, resolved by the
Host (`absolute`, or relative to the Session's header workspace root). The
Client never resolves it against its own cwd, never opens it locally, and never
falls back to the Client filesystem when the Host cannot answer. The preview is
read-only: there is no write, open, reveal or download capability here.

Session scope is derived by the Host from the Session identity, not chosen by the
Client. Direct resolves it exactly like the official Remote lookup does — the
live Session header, then the persisted header, then the deployment's workspace
root — and refuses with `session-unavailable` when no header exists.

Both adapters serve ONE failure vocabulary (`not-found`, `not-text`,
`not-regular-file`, `too-large`, `session-unavailable`, `service-unavailable`)
mapped from the official `workspace-file/*` refusals plus the generated Remote's
`gateway/lookup-not-found` scope refusal; an unrecognized failure is rethrown so
the surface reports an honest unknown instead of inventing a state. Remote reads
are generation-fenced: a reply (success OR refusal) carried by a superseded
Connection generation becomes `SupersededReadError`, never the new generation's
definite outcome. The preview itself holds at most one 120-line page and reads no
other file — see `transcript.md` for the panel's presentation rules.

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

The concrete controller/install admission, request-id reconciliation and
stopped-surface behavior are owned by
[surface-behavior.md](./surface-behavior.md#plugin-manager-and-plugin-detail);
this section keeps only the transport-neutral ownership taxonomy and the
pre-dispatch generation rule.

## Provider credentials and DeepSeek Account

The `ConfigPort` keeps the three credential planes distinct:

- `providers` — detached provider-profile facts and the keyless-profile write;
- `credentials` — API-key references (`setReference`/`unsetReference`) and
  stored credential RECORDS (`listRecords`/`deleteRecord`), presence only;
- `authorization` — provider-native attempts as detached
  notice/prompt/settled events answered through `respond`/`cancel`;
- `account` — the DeepSeek Account state/attempt, profile, wallet balances,
  watch, start/cancel sign-in, sign-out and the running-account-task risk read.

The account DTOs are detached (`AccountView`, `AccountProfile`, wallet decimal
strings, safe attempt ids/phases/error codes). A token, grant payload, PKCE
value, `PlatformSession` or generic Host service object never crosses the port.
`AccountClientMetadata` (`version`, `locale`, `timezoneOffsetSeconds`) is
sampled per Platform request; the offset is never cached across a DST change.

The bundle patch mounts the official `@deepseek-ai/dsh-host-webserver` row with
the stable id `webserver`, `host: 127.0.0.1`, `port: 0` and the `tuiStartup`
gate, and the TUI runner injects both `deepseekAccount` and `webServer`. The
official PlatformAccount registers `/oauth/callback` on that Host listener
while an attempt waits for the browser; the Direct adapter obtains the callback
origin from `webServer.getOrigin()` (loopback HTTP only) and calls
`startSignIn(client, origin, 'web')`. The Client never supplies a callback URL,
opens a second HTTP server, or parses the browser callback. `--help` mounts no
listener. A bind failure fails the Host row instead of falling back to a public
interface.

`watch(signal)` yields the complete initial state and later snapshots; ending
the signal only stops observation and never cancels the attempt. Cancellation
addresses the exact `SignInAttemptId`. `signOut` removes the local grant and
leaves remote revocation in the background; a remote failure never restores the
local grant, and independent API keys stay stored. The running-account-task read
is a risk hint only: the Direct adapter reads `ctx.agents` (the declared
`runtime/direct/config-direct.ts` baseline entry) to project that hint, while
the official `deepseek-account/signed-out` listener owns the actual cancellation
of matching account tasks.

Remote has no qualified account wire for this stage: its `account` sub-domain is
an explicit `available: false` that rejects operations and yields no state. The
local grant is never read from the credential document by the TUI.

Authority: `src/runtime/config-port.ts` (`ProviderProfileConfig`,
`CredentialConfig`, `AuthorizationConfig`, `AccountConfig`),
`src/runtime/direct/config-direct.ts` (`DirectAccountConfig` and the provider/
credential/authorization adapters), `src/app/command/credential-workflow.ts`,
`src/app/command/account-workflow.ts`, root `cordis.patch.yml`. Surface behavior
is owned by [surface-behavior.md](./surface-behavior.md#models-page) and the
command destinations by [surface-catalog.md](./surface-catalog.md).

Must-not: expose a token/grant/PKCE value, start Account sign-in outside
`deepseekAccount`, clear the Account grant through `deleteRecord`, infer a
credential from a route/profile, mount a second webserver identity, or widen the
callback listener beyond loopback in the shipped profile.

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

Direct and Remote use the SAME detach/mapping functions:

```text
Host fact
  -> shared detach/mapping (Direct and Remote use the same functions)
  -> detached snapshot
  -> surface-behavior controller/UI
```

Every Remote read/mutation/wait/cancel/inspect result is fenced by the
pre-dispatch Connection generation and raises `PluginManagerStaleResultError`
when superseded; the surface contract interprets that as indeterminate plus an
authoritative reread, never as a refusal or success. The UI never guesses a
capability from a package name, `@deepseek-ai/` scope, `experimental` substring,
enablement, `fiber` or availability.

The controller, inventory read epoch, install state machine, request-id
reconciliation, retry/unknown handling, workspace lease and Detail copy/upgrade
guidance are owned by
[surface-behavior.md](./surface-behavior.md#plugin-manager-and-plugin-detail).

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
`src/app/direct/system-prompt.ts`. Proof: `test/app/communication-policy.test.ts`
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
  `src/app/host/features/terminal-progress.ts` observes durable turn boundaries
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
- The Linux split-process lane (`smoke:split-process`, driven from an installed
  npm tarball) is a distribution-boundary proof outside L1–L6. It proves OS
  process admission, the official authenticated loopback carrier and the
  `sessionOpen=false` boundary; it is not a TUI Session or Direct/Remote parity
  proof.
