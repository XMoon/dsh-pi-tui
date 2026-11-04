# Host/client architecture and Direct/Remote contract

This document owns the long-lived Host/Client boundary: locality, the semantic
port contract, Direct/Remote equivalence, currentness/identity rules and the
qualification tiers. Direct remains the production backend. Remote is the
internal, Linux-only split-process backend: one Host process plus N Client
processes (N ≥ 1; `dist/local-host.mjs` / `dist/local-client.mjs`) over an
authenticated loopback HTTP/WebSocket carrier, entered through ONE lazy Client
edge (`app/remote-process/local-client-entry.ts -> app/bootstrap.ts`) after
the official PluginPackages resolution. It is not a package export, bin, backend
selector or Session surface. The former in-process composition is retired from
`src/**` into a test-only carrier and composes no production graph.

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
modules, not independent plugins.

Three real OS processes compose this package. Exactly TWO of them are roots of
the `app/bootstrap.ts` facade; the third enters through the official profile
runner and does not compose through that facade:

- **Direct (production default).** `src/index.ts -> app/bootstrap.ts` boots one
  Direct runtime over the caller's Host Context. No Remote module participates.
  This is one of the two `app/bootstrap.ts` roots.
- **Split Client (internal, Linux-only).** `local-client-entry.ts ->
  app/bootstrap.ts` owns its OWN Client Context, the official B1 transport and
  the one official Client Domain mount (`app/remote/client-runtime.ts`, mounted
  in two stages so the interaction owner exists before the Gateway's first
  generation). It then composes the ONE semantic assembly and owner registry
  through `createRemoteApplicationRuntimeFromClient()`
  (`app/remote/application-runtime.ts`) over the shared
  `app/remote/application-stage.ts`, and adopts that pre-built core through the
  selection seam instead of constructing a second graph. This is the second
  `app/bootstrap.ts` root.
- **Split Host (internal, Linux-only).** `local-host-entry.ts` boots the official
  profile through `runProfile()` with the Host-only overlay; it does NOT enter
  `app/bootstrap.ts`. The overlay's single built-in
  `@xmoon76/dsh-pi-tui/host-runtime` row owns the package's ONE private Typert
  contribution and its two business services. Base/profile-owned Host services
  are reused, never remounted.
- **Retired in-process carrier (test-only).** The former M3 in-process
  composition lives in `test/support/m3-inprocess/**`. It is not a real process
  composition at all: `src/**` must never import it, it must never enter the
  published bundle, and it exists only so the historical L5/L6 suites can
  exercise transport-neutral Remote semantics.

Optional generated Remotes are mounted by their feature Client owner without
duplicating core namespace or authority, and no composition may mount a second
copy of a base prerequisite.

Must-not:

- Read an uninjected Host service from a UI/application module.
- Expose a Host service object, profile path, package manifest, Cordis Context
  or transport object through a port.
- Import the bootstrap composition zone from an owner.
- Construct a Direct semantic adapter in `src/app/surface/**`.
- Mount a second copy of a base prerequisite to satisfy Remote composition or a
  test.
- Create a second Client Context/Host graph/semantic bundle inside one process
  composition (each independent split Client process owns its own Context by
  contract).
- Spread a generated Remote namespace or detach a receiver-sensitive method
  (`const on = source.remote.$on; on(...)`).
- Add a public `--backend`/env/config Remote selector before the migration
  milestone authorizes it.

Generated Client/Remote objects must keep their identity and prototype
accessors; a fixture must reproduce production prerequisites without adding a
second Host service or runtime graph.

## Split-process local Host transport

The internal split-process entry is one Host process plus N Client processes
(N ≥ 1) from ONE installed npm package. It is Linux-only, Linux abstract
AF_UNIX sockets are its only process admission authority, and the non-Linux
entry fails before writing runtime files with `B1_PLATFORM_UNSUPPORTED`. No PID
file, `O_EXCL` marker, registry record or `hasLiveClient()` result may stand in
for that kernel ownership.

- **Scope.** The official `resolveDshHome()` / `resolveProfileDir()` results
  canonicalized through `realpath` plus the current UID decide the scope. The
  private run directory is `<DSH_HOME>/run/dsh-pi-tui/<scopeId>/`, created and
  proved 0700. `scopeId` is sha256 over the fixed domain
  `dsh-pi-tui/local-scope/1`, the decimal UID and the canonical profile path;
  that domain is part of the published scope algorithm and evolves separately
  from the wire protocol below. The same canonical profile directory shares one
  scope across workspaces and package builds; the Client cwd is not a scope
  input.
- **Single Host seat, qualification-only Client seat.** The Host holds one
  abstract socket from before the profile Context exists until process
  termination; a second Host candidate loses `bind` and exits without building
  a Context, webserver, Agent or Session. Only the frozen `qualification` Client
  binds the second, Client abstract socket for its lifetime; a second
  qualification Client fails `CLIENT_ALREADY_ACTIVE` before spawning or touching
  a Host. A real `surface` Client — and the non-TUI `peer` — binds no
  profile-global seat: N independent Surface Clients, each with its own PTY,
  Cordis Client Context, official transport, Session reference and physical
  surface, may attach to the SAME Host concurrently and share its exact
  PID/starttime/`instanceId`. Kernel release on process death is the only
  stale-seat recovery.
- **Identity is authenticated, never registry-only.** The registry
  (`instance.json`, 0600) is an unauthenticated hint containing the scope,
  canonical profile path, `instanceId`, Host PID, Linux `/proc/<pid>/stat`
  starttime, loopback origin, protocol `dsh-pi-tui/local/1`, installed
  bundle/DSH versions and the installed-build fingerprint. Readiness requires
  the official `dsh-client-connection` `/connect` launch-token exchange (signed
  Cookie) and the owner-only authenticated identity Fetch route
  `/api/pi-tui.local-host`, with every identity field strictly equal to the
  registry and the current kernel starttime. A Client whose protocol or exact
  DSH runtime differs is `HOST_PROTOCOL_INCOMPATIBLE` before authentication; a
  Host that publishes a protocol or installed build other than its own is
  `HOST_BUILD_INCOMPATIBLE`; a mismatched authenticated identity is
  `HOST_IDENTITY_MISMATCH`; none replaces or kills the live Host.
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
- **Lifecycle.** A Client exit, crash or HUP disposes only its own Client
  subtree, official transport and Client root; a `qualification` Client also
  releases its qualification-only Client seat, while a `surface` Client holds
  no cross-process seat at all. No Client exit releases or stops another
  attached Surface Client, and none calls a Host shutdown. A Host starts on
  demand for one profile scope and then remains
  resident independent of Client attachment or idle time: only an explicit
  official stop (the Host entry admits `SIGTERM`/`SIGINT` into its one
  `runProfile` shutdown owner) or a real process/system failure ends it. There
  is no automatic idle expiry or orphan-interaction timeout, and a pending
  Question/Approval remains with the official Host authority until a legal
  answer, business settlement, explicit stop or process failure. The Host's
  official `runProfile` shutdown owner is the only Host stop; its cleanup first
  withdraws the identity route, then shuts down, then removes only files
  matching its own `instanceId`, then closes the kernel seat. A replaced Host's
  files are never deleted by another instance. A Client from a different
  installed build of the same protocol and DSH runtime is admitted through the
  same authenticated carrier and leaves the live Host, its work and its
  registry/launch files untouched. A Client whose protocol or DSH runtime
  differs is refused before authentication, also leaving the live Host
  untouched.
- **Session boundary.** The Client derives `connecting | connected | disconnected`
  from the official Connection state and generation on every read and never
  copies it into a long-lived flag. `sessionOpen` is a LIVE projection of the
  official `tuiMainView` reference count on the current Session — never the
  launch `--session` intent, the Domain mount or a cached boolean. No business
  mutation is replayed across a transport reconnect; a write whose ACK was lost
  is `indeterminate` and the next Client reconciles it from the Host's durable
  log instead of retrying. The protocol guarantees only a reconnect to the same
  Host; a Host crash is not a graceful migration.
- **Client-only reexec handoff.** Replacing the Client's own installed build
  never replaces the Host. The old Client captures its authoritative live facts
  (`connected` transport and current generation, mounted surface, the
  authenticated Host `instanceId`, and the current `tuiMainView` Session id),
  validates the replacement package resolved through the active official
  profile (a real installed package root with the same exact DSH runtime pin and
  a normal `dist/local-client.mjs`), and hands the SAME one-shot facts —
  expected Host instance, current Session id when one is open, DSH anchor,
  profile and target build fingerprint — to a replacement child process. It
  releases runner, UI, Domain graph, official transport and Client root, and
  then closes the seat this mode actually holds (the qualification Client seat
  when present; a no-op for `surface`), through the existing ONE stop
  coordinator; only after that complete release may the replacement entry be
  spawned on the inherited terminal as a new PID (`stdio: inherit`, no detached
  daemon, no second terminal owner). The old PID is only a waiting parent that
  forwards the child's exit status and holds no Client Context, TTY reader,
  seat or business
  object; a termination signal addressed to that PID is forwarded to the
  replacement child, and a signal arriving after the handoff was accepted but
  before the child spawned cancels the handoff without spawning. The
  replacement re-authenticates the expected Host, which is discovered with a
  no-spawn expectation (`HOST_HANDOFF_UNAVAILABLE` when the expected instance
  is absent/dead, `HOST_IDENTITY_MISMATCH` when another live instance owns the
  scope) and must reopen the same Session against the current generation;
  success requires the official Session history `openState` to be `'open'`, and
  a sessionless handoff must stay sessionless. Sessionless means the official
  `tuiMainView` authority owns no Session: another reference source (gateway,
  controller operation or child view) may legitimately retain a binding without
  making the TUI non-sessionless. Failure never
  starts or replaces a Host, never replays an unacknowledged write and never
  rolls back to the old build automatically: the replacement exits nonzero with
  a concise manual-recovery line. No Cookie, token, SessionHandle, writer or UI
  state crosses the handoff.

  The manual `/reload-client` command is the user-facing trigger of this SAME
  chain. It is a bare Client-local command registered beside `/exit` (no
  alias, argument schema, keybinding or Host RPC); `/reload` keeps its
  catalog/settings refresh semantics. Outside a real split-Client surface
  mount — Direct, or any composition without the Client OS entry — the command
  answers a fixed availability refusal and never creates a Session, reaches a
  Host RPC or becomes a model prompt. In a real split Client its handler makes
  ONE synchronous Client-local safety decision from the live owners: the
  Composer draft bytes (a whitespace-only draft counts), the real staged
  image/file draft stores (a pinned occurrence the editor no longer references
  still counts), unsettled accepted user writes (a submitted prompt or Host
  command, a steer, a local shell run and its context-mode output write, a
  queue mutation, a persisted configuration write registered by the config
  port — settings, credentials, the preset default — and the accepted action
  owner that may perform one: the local command, the picker-detached skill
  delivery and the rewind selection (whose pre-fork read runs before the fork
  owner exists), including their asynchronous preparation; explicitly
  read-only local commands and `/reload-client` itself never count),
  Client-local Question/Approval input (a presented or queued form, a saved
  continued draft, an answer still being delivered, a refused-admission wait)
  and an in-flight Session navigation/transition. Only
  when every fact is clear does that SAME call stack call the process-owned
  one-shot request. A refusal publishes one fixed, actionable notice and keeps
  the old Client, its editor/drafts and the Host entirely alive; there is no
  forced override, queued retry or UI snapshot, and the user clears the state
  and retries. The process preflight also refuses `already-current` when the
  profile-installed package is the running build, and an unavailable or
  incompatible installed target, without stopping the old Client. A granted
  request keeps every guarantee above (the SAME stop coordinator, seat close,
  spawn, no-spawn Host authentication and exact Session/generation fence), and
  success publishes no duplicate notice: the replacement Surface reaching
  `ready` is the evidence. The TSP renderer keeps its existing
  post-classification refusal and adds no native reload UI.

  An accepted Client reload may cancel in-flight Client-local attachment intake
  (`/attach`, `/image`, or inline attachment staging) and artifact saves
  (`/export`, `/transcript`). These operations are not protected as unsettled
  Host writes. Uncommitted results are discarded; already committed artifacts
  remain intact. The user may retry the cancelled operation after reload.


### Local protocol and version evolution

`dsh-pi-tui/local/1` is the required Host/Client wire contract. It is
independent of the `@xmoon76/dsh-pi-tui` package version and build fingerprint.
Both sides must name exactly this protocol and the same DSH runtime version;
the exact paired DSH version is owned by the package manifest, compatibility
matrix and release data, not by this document.

A v1 peer guarantees the required official Session, Turn, Job, Question and
Approval semantics plus this package's current required private Remotes (file
references and terminal progress). Optional read-only functionality may be
added without a protocol bump only when its consumers degrade safely: losing it
must not lose, rewrite or duplicate a business write, and a genuinely
unregistered optional Remote is classified by the official
`gateway/invocation-unavailable` answer, never by turning every network,
authentication or service failure into "unsupported". A breaking change to a
required wire API, or a new Client that cannot work without an RPC an old Host
does not have, requires the next protocol version. Capability registries,
version negotiation and probe-by-trial-write are not part of v1.

Client admission and Host self-publication are different decisions: a Client
compares only the protocol and exact DSH runtime, while the Host must publish
its own exact protocol, bundle, DSH runtime and build fingerprint.
Authentication then compares every identity field, including the Host buildId
and bundle, against the registry, and generation currentness compares the same
Host's full identity. A protocol or DSH mismatch never stops, replaces or
mutates the live Host; the Client reports the refusal and in-memory work stays
with the Host.

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

Host Workspace authority has exactly two owners, both official bundle rows with
the stable ids the official web bundle uses: `workspace`
(`@deepseek-ai/dsh-workspace`, the durable registry) and `workspace-controller`
(`@deepseek-ai/dsh-api-workspace-controller`, the `workspace` Typert Remote
namespace that serves `create`/`follow` and the other Workspace verbs). Direct
gates the controller on `tuiStartup` like the other Direct Host rows, so
`--help` mounts no Workspace Remote surface; the Host-only overlay removes only
that startup dependency from the SAME row in place, so a Split Host exposes one
`workspace` namespace owned by one Loader row. There is no
`split-host-workspace-controller`, no second registry, no hand-written Workspace
DTO/RPC and no Workspace persistence of the TUI's own: the controller's
`static inject` (`remoteAccess`, `typert`, `workspaceRegistry`) carries the real
dependencies, the Host realpaths and records the directory, and
`initializeDefault()` — which creates a Host directory — is never called during
startup. Host readiness asserts the `workspace` registry row and the
`workspace-controller` row are each ACTIVE exactly once for their official
package AND that the live controller carries the
`workspaceController`/`workspace` Typert binding; a readable service object
without it is not a working Workspace API.

The Host execution graph does not depend on the mutable `tui-startup` provider.
The Host-only overlay overrides the existing `webserver`, `workspace-files` and
`workspace-controller` rows with `inject: []` and removes `tuiStartup` from the
eight Host-only execution rows, which keep only their real service dependencies
(`split-host-connection`, `split-host-file-upload`,
`split-host-session-stats`, `split-host-turn-outline`,
`split-host-session-controller`, `split-host-settings-controller`,
`split-host-session-log-download`, `split-host-pi-tui-runtime`). A variable
Startup module lifetime therefore cannot own — and dispose with itself — the
Session, Agent, Connection and attachment ownership established for accepted
work; the row lifetimes stay with the single DSH Loader. The `tui-startup` row
itself remains mounted for the consumers that genuinely need its parsed startup
facts and keeps following the official HMR lifecycle, so this contract is
scoped to the listed execution rows and does not claim that every Host plugin,
service or setting survives an arbitrary reload.

`performance-host` remains an independent Host projection row, and
`visual-tools` remains an independent Loader row; neither is absorbed into the
built-in runtime. The legacy in-process Host composition is
`test/support/m3-inprocess/host-runtime.ts`: it carries the `TEST_ONLY_M3_CARRIER`
boundary, mounts its own additive official rows on an already-running Host
Context and verifies the built-in runtime's readiness gates, but it never mounts
the private contribution/services or the Performance projection, is not the
production Host graph, and cannot be reached from `src/**`. Nothing here promises
that an arbitrary Host business plugin reload is transparent to running work:
the Host rows and plugin resources follow the official DSH Loader and Plugin
Manager lifecycle, while a Client-only surface revision never touches a Host
fiber.

The Host-only readiness audit requires every official Session-serving row and
the built-in row to be ACTIVE, checks the official and private Typert
`serviceKey`/`namespace` bindings, and requires both `piTuiHostReady` and
`piTuiPerformanceReady` before it publishes the authenticated B1 identity. A
missing row, artifact, binding or readiness gate fails Host startup before any
identity is published.

### Host liveness observation

The Host-only entry installs exactly one internal, read-only
`HostActivityObserver` (`src/app/remote-process/host-activity.ts`) after the
readiness audit and before it publishes Ready. The observer owns no DSH
business object and never drives, stops or replaces Host work. Every internal
status response carries a fresh `HostActivitySnapshot` with a three-state
verdict, per-source states, diagnostic reasons and a volatile observation
epoch. `BLOCKED` reports positively observed current work or a future keepalive
obligation; `UNKNOWN` is the fail-closed answer for an unreadable, unloading or
unexcluded source; `OBSERVED_QUIESCENT` describes only the covered sources in
that transient window and is never a shutdown authorization, admission fence or
reusable lifecycle decision. Sources the installed DSH runtime cannot enumerate
remain `UNKNOWN`; only explicitly qualified passive Loader rows are treated as
idle, while any other active row (an official autonomous service, a
third-party plugin or a future row) fails closed as an unqualified Host source.
The epoch invalidates overlapping reads but is not an atomic barrier.

### Client composition, Session references and the real surface

The split Client keeps ONE Cordis root and ONE official
Typert/Connection/Gateway graph. Its Domain plane is mounted in two stages by
one owner: `mountRemoteClientDomainPrerequisites()` mounts the generated
`/remote` contributions (including the official `workspace` descriptor), the
package's ONE private contribution, the official
fileUpload Client and the official Session Client (including its `agent` scope
resolver) BEFORE the Gateway's first generation; `complete()` then mounts the
Jobs Client and awaits the official initial readiness. The M3 in-process path
keeps the one-call `mountRemoteClientDomains()` wrapper. These functions never
create or dispose the Context, Connection or Gateway. The official Client bundles and generated `/remote`
descriptors are resolved from the installed DSH anchor. The Client shell also
supplies the official web seed's platform static `@deepseek-ai/dsh-client-store`
from the installed Harness family (its declared DSH peer); the browser-form
`/client` bundles' `require` therefore resolves the SAME singleton the web shell
shares, while `@deepseek-ai/cordis` resolves as a normal import. No source-tree
descriptor may mix with that installation.

The Client mounts the generated `workspace` namespace and nothing beside it: no
`ClientWorkspaceModel`, no Client Workspace store, no cached Workspace list and
no extra Host plugin. Its state arrives only as the Host baseline and increments
of `workspace.follow`, so a Client reload, HMR revision or process exit disposes
its own `/remote` descriptor and never the Host controller or registry.

Session creation has exactly ONE directory authority. A Client's local directory
(`cd foo && dsh`) is only a PROPOSAL: the Client resolves an intent — the launch
or immutable-header directory, an official `workspace-id`, or the captured
source Session — through the Host Workspace Controller, and the resulting
official WorkspaceId, never a `cwd`, is the sole directory input to Session
create. The Host registry realpaths and validates the proposed directory, and
the Session Controller reads the durable directory from its own Workspace
record, so the persisted `header.cwd` and the Workspace membership always agree
and a Client can never make its own filesystem authoritative. The source-Session
route is membership-first: `/new` asks for the captured Session's official
membership, and only a historical Session without one falls back to that
Session's persisted immutable header directory, re-validated by the Host
registry. A status/effective working directory is never used, an unknown or
unreadable directory fails closed instead of falling back to a Host profile
directory, `HOME` or a default Workspace, and the pre-selection publishes no
Session and stops no owner — so a refusal leaves the current Session, its draft
and any running Turn untouched.

An ordinary create naming an unknown WorkspaceId is refused before publication.
A create that published and then failed to attach its membership reports the
real published identity (`published-with-error`), and a create dispatched
before a connection loss stays `indeterminate` with the requested id as
correlation only; neither is ever retried. `open`/`resume`/`--session` keep
addressing a Session by identity only: they never rewrite the header directory,
replace membership or attach a historical Session to the Client's current
directory. There is no implicit "current Workspace" global — each Client holds
its own selection intent, and two Clients of one Host may create in different
Workspaces.

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
memoized presentation/backend adapter release -> the root interaction delivery
owner -> the borrowed B1 transport -> the root Domain plane -> the Client root. The runner may trigger the memoized adapter release during its
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
permanently settle the Host event. A Client whose official answerer is already
attached may answer a re-delivered event id / call id once; the Host pending
map clears only on the Host's own settlement. A settled, cancelled or replaced
request is never resurrected from an old Client's painted card.

The DSH Client event pump starts with the Connection generation. Official Web
uses the existing Loader readiness gate (`loader.await().then(start)`) to mount
its plugin graph before starting the Gateway. A split Client composition must
order its interaction owner before the event pump can consume Host-pending
forwarded events; a fresh Client must not delegate a pending forwarded event
before that owner is attached. Use the official Loader readiness contract for
that ordering. A private PiTui pending store, permanent pending promise or
Gateway monkey-patch is not a substitute for this composition contract.

A Remote Client may resume a Session whose Host Turn is still running, because
a pending Question or Approval is exactly such a Turn. Its startup therefore
does not wait for Host idle before mounting the surface: the official live
binding is hydrated and the mounted interaction owner settles the pending
event. Direct keeps its in-process pre-mount idle wait.

The internal split mode also supports one Client-only surface revision
replacement on the SAME Client PID, Client Context and B1 transport: the
current runner, Client UI subtree and memoized application adapters are retired
in reverse order; the root Domain plane, root interaction delivery owner and B1
transport stay alive; then a fresh revision is mounted and must reach a real
TTY-ready state before it is reported mounted. A pending Host Question or
Approval survives that revision change and is handed to the new surface
exactly once. Host `runProfile`, Agent, Job and service fibers are untouched. Revision identity and status are
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
  npm tarball) is a distribution-boundary proof outside L1–L6: it is the only
  tier that observes a real Host process plus real Client OS processes. What it
  proves is a list of durable capability classes, not one boundary row: OS
  process admission and kernel-seat
  uniqueness; the official authenticated loopback carrier and Host identity;
  official Session open, durable history and live catch-up through a real
  surface; accepted Turn/Tool/Job/Child continuity across Client death; pending
  Question/Approval recovery; Client-only surface revision; the private Host
  Remotes over the authenticated wire; and the fail-closed upgrade/signal paths.
  It remains a lane-level proof: it never replaces Direct/Remote parity, it does
  not prove a capability the lane does not exercise, and a green split lane is
  not a TUI Session acceptance on its own.
