# Host/client architecture and Direct/Remote contract

This document owns the long-lived Host/Client boundary: locality, the semantic
port contract, Direct/Remote equivalence, currentness/identity rules and the
qualification tiers. Direct is the default public backend; `daemon` is the
opt-in local split-process backend: the Host/Client link is supported on
Linux, macOS and Windows (native x64, ordinary local fixed-NTFS paths), and one
Host process plus zero or more Client processes
(`dist/local-host.mjs` / `dist/local-client.mjs`; the Host lifetime is
independent of Client attachment) over an authenticated loopback HTTP/WebSocket
carrier, entered through ONE lazy Client edge
(`app/remote-process/local-client-entry.ts -> app/bootstrap.ts`) after
the official PluginPackages resolution. The split transport is not a separate `remote` public backend, package export,
bin or Session surface: `daemon` is selected through the official startup
configuration and preserves the same semantic Host/Client contract. The former in-process composition is retired from
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
| Host-owned | Agent, Session, subagent, jobs, tools, LLM/provider/model catalog, skills, agent presets, persistence, session search, approval/question authority, Host workspace/filesystem references, Host shell/tool execution and Host shell completion, credentials, settings |
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
  `HostUserShellPort`; the Client never spawns the command or supplies Host
  environment facts. The single authenticated Owner-only Host endpoint requires
  a live Agent and the identical live Session object (`agent.session ===
  sessions.get(sessionId)`) before preparation and again immediately before spawn.
  Gateway `remoteAccess` resource decisions run only for non-Owner peers in the
  pinned DSH contract, so they are not an authorization fact for Owner calls.
  Host shell completion resolves ONE explicit target — the exact live Session
  or the exact Host-issued Workspace id, else the explicit unselected state——
  and uses that Host source's cwd/PATH/filesystem authority; it never falls
  back to the Client machine. A Workspace target is resolved through the
  official Host `workspaceRegistry` before the completion and re-read after it
  (a replaced/removed Workspace or an unreadable path retires the answer), and
  it involves no Session, Agent or Session write. The Client-local
  `selectionRevision` is an admission epoch that never crosses the wire. The
  draft external editor stays Client-local; a future Host-filesystem
  editor/open is a separate capability.
- `!`/`!!` execution is ONE Host-owned one-shot authority on both backends. A
  POSIX Host keeps the raw Bash argv; a Windows Direct or Split Host uses the
  live official `ctx.shell.pwshPath` with the official composed PowerShell argv
  (`-NoLogo -NoProfile -NonInteractive -Command` with the public
  `ENCODING_PREAMBLE` and `ENV_OVERRIDES`) and accepts the official ACL
  backend's real `partial` or `full` enforcement. A missing official shell
  capability refuses before any spawn — never a bare `pwsh`, `cmd`, Git Bash,
  WSL or sandbox downgrade, and `partial` is never advertised as full. A
  Remote Client executes the command on the Host, never on the Client OS; the
  Host shell's literal-path dialect is projected from the AUTHENTICATED Host
  publication schema (schema 3 = PowerShell, schema 1/2 = Bash), never guessed
  from the Client platform. Windows Remote completion exposes only literal-path
  candidates — no command, variable or git-subcommand source.

## Semantic ports and composition

`Backend` is an assembly of narrow domain ports (`subagent`, `sessionReader`,
`pendingInputReader`, `sessionWriter`, `sessionLifecycle`, `interaction`,
`catalog`, `config`, `hostFile`, `sessionArchive`, `sessionMarkdown`,
`hostCommand`, `pluginManager`, `jobObservation`, `hostUserShell`,
`hostShellCompletion`, `deliveredFileRead`, `webAccess`, `cuaAccess`,
`sessionWorkspaceFacts`, `schedule`), never a
`TuiBackend` god object. A port exposes detached semantic facts, opaque identities/request ids,
event surfaces (for example authorization: begin → attemptId → notice/prompt →
respond/cancel) and semantic operations. It owns no Host database, state machine
or transport.

Host service resolution belongs to:

- the Direct semantic adapters in `src/runtime/direct/**`;
- the Direct runtime policy/facades in `src/app/direct/**`;
- the application composition root `src/app/bootstrap.ts`.

`SessionWriter.prompt` carries one OPTIONAL acceptance notification
(`options.onAccepted`) beside its `WriteOutcome` result. It proves the HOST
accepted the message — Direct after the live Agent's synchronous Inbox
insertion committed, Remote through the official
`beginSubmission.onAccept` (re-checked against the captured connection
generation and the exact pinned binding) — and it is not the write's terminal
state: an accepted prompt can still fail during execution. A write result is
NEVER acceptance authority: a committed outcome that did not fire the callback
leaves a held Composer attempt unaccepted (it settles as unknown with the draft
retained), so an adapter that omits the callback cannot clear the composer. The
port's outcome taxonomy is unchanged; `updateQueue` never carries the
notification, and the Composer-side meaning of the accepted/refused/unknown
split is owned by
[surface-behavior.md](./surface-behavior.md#composer-submission-policy).

`HostCommandPort` has ONE official-receipt seam beside `execute`:
`stageFileReceipt`. It stores ONE Client file snapshot under the receiving
Session and returns the Host-minted `receiptId` the command wire cites — Direct
uses the official `fileUploads.uploadStream` (whose resolver `commands.execute`
consumes), Remote reuses the SAME composition-owned authenticated receipt
uploader as the prompt path. There is no second upload transport, no Client-side
receipt registry and no fallback to a durable attachment reference; staging is
admitted inside the ONE Session writer section against the ACTUAL Session id, so
a staging failure proves no command was dispatched.

`src/app/host/**` is the bundle's permanent Host plane: it registers with
explicit `inject` and `ctx.reflect.get`, and consumers read only semantic DTOs or
port values. `src/app/host/pi-tui-host-runtime.ts` is the ONE built-in Host
Runtime Loader row; `src/app/host/features/**` are its private business
modules, not independent plugins. The row publishes readiness only after the
shared private contribution and every required service binding are live.

Three real OS processes compose this package. Exactly TWO of them are roots of
the `app/bootstrap.ts` facade; the third enters through the official profile
runner and does not compose through that facade:

- **Direct (production default).** `src/index.ts -> app/bootstrap.ts` boots one
  Direct runtime over the caller's Host Context. No Remote module participates.
  This is one of the two `app/bootstrap.ts` roots.
- **Split Client (internal, local split).** `local-client-entry.ts ->
  app/bootstrap.ts` owns its OWN Client Context, the official B1 transport and
  the one official Client Domain mount (`app/remote/client-runtime.ts`, mounted
  in two stages so the interaction owner exists before the Gateway's first
  generation). It then composes the ONE semantic assembly and owner registry
  through `createRemoteApplicationRuntimeFromClient()`
  (`app/remote/application-runtime.ts`) over the shared
  `app/remote/application-stage.ts`, and adopts that pre-built core through the
  selection seam instead of constructing a second graph. This is the second
  `app/bootstrap.ts` root.
- **Split Host (internal, local split).** `local-host-entry.ts` boots the official
  profile through `runProfile()` with the Host-only overlay; it does NOT enter
  `app/bootstrap.ts`. The overlay's single built-in
  `@xmoon76/dsh-pi-tui/host-runtime` row owns the package's ONE private Typert
  contribution and its five business services. Base/profile-owned Host
  services are reused, never remounted.
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
- Add a public backend or Remote selector beyond the authorized
  `DSH_PI_TUI_BACKEND` / `tui-startup.backend` (`direct | daemon`) contract in
  "Public backend selection" below, and never a `--backend` CLI flag.

Generated Client/Remote objects must keep their identity and prototype
accessors; a fixture must reproduce production prerequisites without adding a
second Host service or runtime graph.

## Public backend selection (`direct | daemon`)

`dsh --profile pi-tui` selects ONE backend per cold launch. The single
configuration authority is the official Profile Config `tui-startup.backend`
(rendered by the startup row's `.volatile()` schema), overridable for one launch
by the `DSH_PI_TUI_BACKEND` environment variable. The fixed precedence is
`DSH_PI_TUI_BACKEND` > Profile backend > `direct`, and `direct` is the default.
There is no `--backend` CLI flag and no `wire-local` alias: an empty or unknown
environment value (including case variants) is an illegal input that fails
closed with a stable reason, never a silent Direct fallback; an illegal Profile
value fails closed unless a valid environment value overrides it for that launch.

The startup row publishes exactly one service. `direct` publishes the existing
`tuiStartup` (the in-process Direct TUI). `daemon` publishes
`tuiDaemonStartup`, and the `pi-tui-daemon-launcher` row spawns exactly ONE
foreground Client (`dist/local-client.mjs`) that authenticates the local Host and
mounts the real surface, then the CLI process waits for that Client's real exit.
The daemon supervisor owns no Host: the Client entry authenticates/ensures the
one Profile Host itself, and the launcher never calls `ensureLocalHost`, binds a
Host seat or creates a Session/Agent/Writer. Under the daemon supervisor the
Host-business Loader rows that do not gate on `tuiStartup` (visual tools, job
controller, workspace history bootstrap, file references) and the `webserver`
required entry are conditionally disabled, so the short-lived supervisor PID owns
no second Host authority and never trips a required-entry startup failure.

The `--session` / `-c` / `--preset` launch intent reaches the Client as ONE
public `sessionLaunch` value resolved Client-locally by the existing
`app/bootstrap.ts` Session runner (Host roster, Workspace membership, exact
resume) — never an exact-id bypass. It is dropped on Client reexec so the
confirmed exact Session is restored instead of re-running the public intent.

The daemon backend is the LOCAL split process on Linux, macOS and native
Windows (the supported Windows domain is the ordinary local user with a local
fixed-NTFS Profile): it requires a real interactive TTY, and any unsupported OS
or a non-interactive launch fails closed. A real public-managed start uses the
platform's supervision path when one exists: Linux delegates to the verified
systemd user unit, and macOS to the verified user-level LaunchAgent; on Windows
no service unit is used and the detached Host starts directly. In both
supervised cases the strict-absence detached Host process remains the fallback
only when no service definition is installed. The
public `dsh daemon status/start/stop/restart/logs/install/uninstall`
management verbs cover both the launchd job and the independent macOS Host
process (see the management section below). Selection is cold-launch only: writing the Profile value shows "applies on next
launch" and never hot-switches the running process or restarts the Host, and an
environment override never writes back to the Profile. The `.volatile()` Config
value lets a Direct and a Remote TUI Client read and write the same Host Profile
node through the official revision-checked Settings mutation.

## Split-process local Host transport

The internal split-process entry is one Host process plus zero or more Client
processes from ONE installed npm package. The Host lifetime is independent of
Client attachment and may continue with zero active Clients. The local Host
transport is supported on Linux, macOS and Windows for interactive Clients.
On Windows the supported domain is native Windows 11 x64, an ordinary user and
an ordinary local fixed-NTFS profile path; the same independent Host,
management plane, official Web frontend and ACP ingress (the same profile-scoped
local endpoint, a native Named Pipe) are available; `daemon install`/`uninstall`
remain unsupported because no Windows service manager owns the Host. The kernel admission
authority is platform-owned: Linux uses abstract AF_UNIX sockets for the Host
Singleton and the qualification-only Client seat; macOS uses `O_EXLOCK`-held
seat files, re-proved by inode and directory identity before Ready; Windows uses
purpose-derived `Global\` named mutexes created with a protected owner-only DACL
and adopts an existing named object only after proving its owner and DACL. The
macOS Host seat lives under the OS account home, while the qualification-only
Client seat stays in the private scope directory. A real `surface` Client
automatically discovers or starts the local Host, then completes the internal
`/connect` Cookie exchange and authenticated identity verification. No manual
connect command, address or token input is required. Any other platform fails
before writing runtime files with `B1_PLATFORM_UNSUPPORTED`. No PID file,
`O_EXCL` marker, registry record or `hasLiveClient()` result may stand in for
the kernel seat where one is required. Windows `daemon install`/`uninstall` are
unsupported because no Windows service manager owns the Host; ACP ingress is
available on Windows over the same profile-scoped local endpoint (see
[host-acp.md](./host-acp.md)).

- **Scope.** The official `resolveDshHome()` / `resolveProfileDir()` results
  canonicalized through `realpath` plus the current POSIX UID or Windows token
  SID decide the scope. The private run directory is
  `<DSH_HOME>/run/dsh-pi-tui/<scopeId>/`. On Linux, components THIS product
  creates are 0700, while an existing user layout (an existing 0755/0775
  directory, legal directory symlink or another owner) is used as-is and never
  chmodded or rejected by a UID/mode gate. On macOS the per-DSH-home run
  directory is created and proved 0700; the Darwin Host seat
  uses the account-home root described below. On Windows the official home and
  profile must resolve to a local fixed NTFS path; the drive prefix is
  canonicalized but the remaining filesystem case is preserved. Directories and
  named objects THIS product creates receive protected owner-only DACLs; files
  created inside a legitimate private directory inherit that directory's ACL and
  are admitted by the shared existing-object predicate below. A new file need not
  itself carry the protected bit. `scopeId` is
  sha256 over the fixed domain `dsh-pi-tui/local-scope/1`, the decimal UID and
  the canonical profile path on POSIX, and over
  `dsh-pi-tui/local-scope/win32/1`, the canonical token SID and the canonical
  profile path on Windows; that domain is part of the published scope algorithm
  and evolves separately from the wire protocol below. The same canonical
  profile directory shares one scope across workspaces and package builds; the
  Client cwd is not a scope input.
- **Single Host seat, qualification-only Client seat.** The Host holds one
  platform kernel claim from before the profile Context exists until process
  termination: one abstract socket on Linux, one `O_EXLOCK` file descriptor on
  macOS, one purpose-derived `Global\` named mutex on Windows (created with a
  protected owner-only DACL; an existing object is adopted only after its owner
  and DACL are proved). On macOS the Host seat file is
  `<real account home>/.dsh-pi-tui/run/<scopeId>/seat-host-<scopeId>.lock`
  (file mode 0600; the `run` and per-scope directories are created and proved
  0700). The account home is the real `os.userInfo().homedir` for the effective
  UID — never `$HOME`, `DSH_HOME` or `$TMPDIR`. A pre-existing account-level
  `~/.dsh-pi-tui` may be readable (0755), but it must remain owned by the UID
  and not group/other-writable; only its owner can create the private `run`
  chain below it. The qualification-only Client seat remains in
  `<DSH_HOME>/run/dsh-pi-tui/<scopeId>/`. Because the Host seat is keyed only by
  the canonical-profile `scopeId`, two different DSH homes whose profile links
  resolve to the same canonical profile directory compete for the SAME Host
  seat: the second Host candidate loses the claim and cannot start. Registry,
  Cookie material and Session state stay under each DSH home; there is no
  cross-DSH-home Host discovery, and a Client in the second home is refused
  rather than silently attaching to a Host it did not authenticate. A second
  Host candidate loses the claim and exits without building a
  Context, webserver, Agent or Session. Only the frozen `qualification` Client
  binds the second, qualification-only claim for its lifetime; a second
  qualification Client fails `CLIENT_ALREADY_ACTIVE` before spawning or touching
  a Host. On Windows no qualification/Client seat is created; the Host and the
  short-lived admin seat are the only mutex users. A real `surface` Client — and
  the non-TUI `peer` — binds no profile-global seat; it is admitted automatically
  by the authenticated `/connect` + identity chain described below. Zero or more
  independent Surface Clients, each with its own PTY, Cordis Client Context,
  official transport, Session reference and physical surface, may attach to the
  SAME Host
  concurrently and share its exact PID/starttime/`instanceId`. Kernel release on
  process death is the only stale-seat recovery.
- **Identity is authenticated, never registry-only.** The registry
  (`instance.json`; a newly written POSIX file is 0600, and a new Windows file
  inherits its parent directory's ACL and is admitted by the shared
  existing-object predicate below) is an
  unauthenticated hint containing the scope, canonical profile path, `instanceId`,
  Host PID,
  loopback origin, the local protocol identity, installed bundle/DSH versions
  and the installed-build fingerprint. Its identity material is versioned by
  schema: Linux schema 1 carries the `/proc/<pid>/stat` starttime, macOS schema 2
  carries the complete PR-1 Darwin kernel identity (boot session, unique process
  id, process UUID and start timestamp as exact decimal strings), and Windows
  schema 3 carries the token user SID plus the process creation FILETIME as an
  exact unsigned 64-bit decimal string. Readiness requires the official
  `dsh-client-connection` `/connect`
  launch-token exchange (signed
  Cookie) and the owner-only authenticated identity Fetch route
  `/api/pi-tui.local-host`, with every identity field strictly equal to the
  registry and the live kernel identity re-read as the SAME process. An
  unavailable kernel read is `PROCESS_STARTTIME_UNAVAILABLE`; a gone/different
  process is only a stale candidate, never authorization to signal it. A Client whose protocol or exact
  DSH runtime differs is `HOST_PROTOCOL_INCOMPATIBLE` before authentication; a
  Host that publishes a protocol or installed build other than its own is
  `HOST_BUILD_INCOMPATIBLE`; a mismatched authenticated identity is
  `HOST_IDENTITY_MISMATCH`; none replaces or kills the live Host.
- **Native process identity uses the installed DSH Koffi owner.** The Darwin
  and Windows kernel identity bridges lazily load Koffi from the current running
  DSH installation: the verified DSH anchor resolves
  `@deepseek-ai/dsh-subprocess-local` and that package's own declared `koffi`
  dependency. Windows additionally opens processes with
  `PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE`, reads
  `GetProcessTimes`/the token user SID, and keeps the exact handle for a stop;
  an access-denied/unknown read is never treated as gone. A Direct CLI's own `argv[1]` installation identity takes
  precedence over any inherited Split anchor; the environment anchor is used
  only by the Split Host/Client entries themselves. Koffi is not a production
  dependency or independently versioned runtime of this bundle. The bridge must not hard-code a Koffi version, select
  by version number, or fall back to the TUI package, a Profile, a global module
  path or an accidental hoist. The loaded `koffi` package's actual API/ABI is the
  compatibility authority; an unavailable or incompatible addon remains
  `NATIVE_UNAVAILABLE`/`ABI_UNSUPPORTED` and must never weaken process-identity
  checks.
- **Official carrier only.** The Host reuses the base `typert-gateway` row and
  mounts exactly one `dsh-client-connection` owner and one `dsh-api-remotes`
  forwarded-event source on the Host-only overlay. The Client installs the
  official Node `typert-registry`, `client-connection` and `api-gateway` halves
  on the single A0 Client Context with a Cookie-bearing
  `fetch`/`createWebSocket` and `streamBaseUrl`. `ownsHost`, in-process
  RPC/openStream bridges, custom Bearer/Basic auth and any second business RPC
  are prohibited. The private routes behind the official `/api` Owner admission
  are read-only: the GET identity echo, the GET ACP status observation and the
  POST workspace-object observation, which returns only the current Host
  instance's own `(device, inode)` for one bounded absolute directory path. None
  carries a Session, Workspace registration, file content, write, shutdown,
  approval or version-switch operation.
- **One operator Peer per connection generation.** The Gateway admits the
  Client's signed Cookie as an API operator, and a forwarded
  `user-questions/request`/`approval/request` answer is accepted only from the
  very Peer that owns the open forwarded-event stream (`$events/result`:
  "Remote event result belongs to another Peer" otherwise). The Client's
  borrowed authenticated fetch therefore speaks with the live connection's
  Cookie instead of exchanging a new one per call; the only Cookie rotation
  point is the connection's own re-admit before a socket RE-open, which
  re-publishes both sides on the new operator.
- **Secret boundary.** The launch token lives only in the Host process and its
  `launch.json` (a new POSIX file is written 0600 with an atomic
  same-directory rename; a new Windows file inherits its parent directory's ACL
  and is admitted by the shared existing-object predicate below); the Client
  keeps its own Cookie in memory
  only. Neither token, Cookie nor `connectUrl` may appear in the registry,
  stdout/stderr, logs, argv or environment. New POSIX registry/launch files are
  0600 and a new POSIX run directory is 0700; on Windows new files inherit their
  parent directory's ACL and are admitted by the shared existing-object predicate
  below. An existing POSIX user-chosen owner or mode is
  not a read policy and is never rewritten. The managed internal files still fail
  closed on a final-path symlink (`O_NOFOLLOW`), a non-regular file, an oversized
  record, a malformed schema, a registry/launch mismatch and any unauthenticated
  Host identity. On Windows the distinction is by object origin: a NEW directory
  or named object receives the protected self-only SDDL at creation; a NEW file
  inherits its parent directory's ACL and need not carry the protected bit;
  a LEGITIMATE EXISTING product object is admitted by its current owner SID, a
  present non-null DACL and no grant to another ordinary account (LocalSystem and
  BUILTIN Administrators remain allowed). ACE count,
  order, protected bit and explicit-vs-inherited representation are ordinary ACL
  representations, not a security boundary. A foreign/public grant, a
  null/missing DACL, a final reparse and an ACE this reader cannot interpret
  still fail closed.
- **Lifecycle.** A Client exit, crash or HUP disposes only its own Client
  subtree, official transport and Client root; a `qualification` Client also
  releases its qualification-only Client seat, while a `surface` Client holds
  no cross-process seat at all. No Client exit releases or stops another
  attached Surface Client, and none calls a Host shutdown. A Host starts on
  demand for one profile scope and then remains
  resident independent of Client attachment or idle time: only an explicit
  official stop (the Host entry admits `SIGTERM`/`SIGINT` on POSIX, or its
  per-instance native stop Event on Windows, into its one `runProfile` shutdown
  owner) or a real process/system failure ends it. There
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
- **Explicit Host-stop-on-exit (M6 UX PR2).** The ordinary Client detach above
  is the default and never stops a Host. ONE narrow, separately authorized
  exception exists: when a running Daemon Client has itself made a verified
  `daemon → direct` Profile transition and the user then explicitly chooses
  `Stop daemon Host and exit` in the whole-Host stop confirm, the final exit
  root runs ONE authenticated `daemon stop` for that exact Profile AFTER the
  terminal is restored. It is a Profile-management action (not a Session Turn
  cancel), it interrupts every connected Client/Session/Job of that Host, and
  it requires the confirm's destructive choice — a save, a preference change or
  an ordinary exit never triggers it. The stop's own pre/post proof is the only
  success source; a refusal keeps the truthful "not confirmed" wording and the
  control plane's stable exit code.
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
  before the child spawned cancels the handoff without spawning. On Windows a
  normal Client exit follows the same natural stop path as `/exit`. An explicit
  supervisor disposal may request termination of its direct child (the Win32
  TerminateProcess path) and waits for that child's ACTUAL exit inside the
  bounded shutdown budget; the Host is never addressed, signalled or stopped by
  that path. An abnormal console/terminal loss is not a graceful stop and the
  implementation does not assert a specific process exit order for that case.
  Windows `/reload-client` is not available: the refusal is decided before any
  reexec intent, surface release or stop, the current Client/Host/Session/draft
  are kept, and the fixed notice tells the user to exit and relaunch. The
  Windows normal exit plus relaunch path is the supported way to adopt an
  updated build. On Linux/macOS the replacement re-authenticates the expected
  Host, which is
  discovered with a no-spawn expectation (`HOST_HANDOFF_UNAVAILABLE` when the expected instance
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


### Profile-scoped Host process manager

The daemon process-manager lifecycle and profile ownership contract are now
owned exclusively by [host-daemon.md](./host-daemon.md#profile-scoped-host-process-manager).

### Daemon management commands

The authoritative status/start/stop/restart/logs/install/uninstall semantics are
in [host-daemon.md](./host-daemon.md#daemon-management-commands).

### Host-owned local ACP v1 front door (local endpoint)

The ACP transport and bounded connection/session-view contract are owned by
[host-acp.md](./host-acp.md#host-owned-local-acp-v1-front-door-unix-socket).

### Local protocol and version evolution

`dsh-pi-tui/local/2` is the required Host/Client wire contract. It is
independent of the `@xmoon76/dsh-pi-tui` package version and build fingerprint:
two builds that both name `local/2` interoperate across versions. Both sides
must name exactly this protocol and the same DSH runtime version; the exact
paired DSH version is owned by the package manifest, compatibility matrix and
release data, not by this document. `local/2` is the protocol baseline of the
first Split-mode opening; `local/1` pairs are refused at
connect with `HOST_PROTOCOL_INCOMPATIBLE`, and a refusal never stops, replaces
or mutates the live Host or its running Turns.

The Client's DSH runtime identity is the DSH installation that owns the CLI in
Direct, or the official Profile launcher's install anchor in a Split surface
Client. Every Client UI version fact, boot diagnostic and Account metadata value
reads that ONE Client-local source. The authenticated Host record's
`dshVersion`/`bundleVersion` are Host identity and compatibility evidence only,
never a substitute for the Client's own installed runtime version; the TUI
bundle version is always this package's own manifest version.

A v2 peer guarantees the required official Session, Turn, Job, Question and
Approval semantics plus this package's current required private Remotes (file
references, terminal progress and session-view presence — the last one feeds
the prompt admission gate and is REQUIRED, never degraded). Optional read-only
functionality may be added without a protocol bump only when its consumers
degrade safely: losing it must not lose, rewrite or duplicate a business write,
and a genuinely unregistered optional Remote is classified by the official
`gateway/invocation-unavailable` answer, never by turning every network,
authentication or service failure into "unsupported". A breaking change to a
required wire API, or a new Client that cannot work without an RPC an old Host
does not have, requires the next protocol version. Capability registries,
version negotiation and probe-by-trial-write are not part of v2.

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
owns the package's ONE private Typert contribution and its private business
services (`piTuiFileReferences`, `piTuiTerminalProgress`, `piTuiWebAccess`,
`piTuiHostUserShell`, `piTuiSkills`, `piTuiAuthorization`,
`piTuiCredentialRecords`, `piTuiSessionPolicy`); the feature modules are not
independent Loader rows, configurable plugins or package subpaths. The row
publishes `piTuiHostReady` only after every service binding is live.

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

### Sessionless `@file` discovery

An `@file` query made without a Session is a HOST WORKSPACE discovery, never a
Client filesystem read:

- **Authority.** The Host-issued `workspaceId` from the official
  `workspaceRegistry` is the target; the registry is re-read per request and
  resolves the canonical root. Once that readable root is proven, the SAME
  Host-dialect classifier the Session router uses decides the route from the
  raw token: a BARE query (`@foo`, `@.env`) is answered by the published
  `@deepseek-ai/dsh-file-reference-local/search` `WorkspaceFileSearch` over the
  root, with the official published defaults (`maxResults` 20, `maxEntries`
  50 000 and the exported excluded directory basenames); an EXPLICIT path scope
  (`@src/`, `@../shared/`, `@/abs`, `@~/Down`, a Windows drive/UNC form)
  enumerates exactly the scope the user typed through the shared scoped Host
  scanner anchored at the registry root — a parent `..` or an absolute Host
  path may therefore name a directory outside the registered root, because the
  user, not the workspace index, selected it. Ranking, ordering and the result
  bound for the bare route stay with the official engine, and explicit
  spellings/ranking are the shared TS8-A policy, so Direct and Remote answer the
  same query with the same semantics. The Client sends the exact `workspaceId`,
  the official query form and its cancellation through the single private
  `piTuiFileReferences/listWorkspace(workspaceId, query, signal)` endpoint; it
  never sends a cwd, a path guess, a Client filesystem fact or its Client-local
  selection revision. The registry-derived root is the ONLY cwd of an explicit
  sessionless scope — the Client's launch directory, home and OS never
  participate.
- **Zero Session/Agent IO.** The Host service performs no `Session.create`, no
  Agent lookup and no Workspace registration for a discovery; it re-reads the
  registry per request, re-checks that the same id still resolves to the same
  root after the scan, and answers `unavailable` — never `ok([])` — for a
  missing/unreadable root or a replaced registration. Only a completed official
  enumeration of zero matches is an authoritative empty result.
- **Owner-only.** `listWorkspace` validates the live `ctx.invocation` Owner peer
  (and the invocation/peer/Host-service lifetimes) BEFORE any registry lookup or
  file read, and re-checks the same identity before returning. The WorkspaceId
  is a target identity, not a file-access credential, and the Owner path does
  not claim to pass through `remoteAccess` resource decisions.
- **Unselected means zero dispatch.** Without a confirmed `workspaceId` the port
  answers `unavailable` without any Remote call; the surface guides the user to
  the existing Browser. The Client launch directory is only a candidate, and
  only after a `(dev, ino)` object equivalence proof against the authenticated
  Host identity: on Linux through `/proc/<hostPid>/root` and the Host
  starttime; on macOS and Windows through the Host's own Owner-only
  workspace-object observation plus the schema 2 / schema 3 kernel identity and
  the current official Connection generation. Windows additionally requires
  the directory object captured at Client launch (a missing capture is never
  replaced by a later `stat('.')`) and an ordinary local fixed-NTFS path on
  both sides; drive-relative, root-relative, UNC/network and device spellings
  are refused. The proof is asynchronous and is re-run before every
  Workspace resolution/create/adoption and before `-c` resumes; a rename,
  recreation, Host restart, Cookie/generation replacement or unreadable fact
  revokes it back to the unselected Browser path. An explicit choice survives
  the next sessionless create while an automatic one is one-shot.
- **Session scope is unchanged.** A live Session keeps
  `piTuiFileReferences/list(sessionId, query, signal)` — the Host router's bare
  official `ctx.fileReferences` route plus the accepted explicit-path Host
  augmentation (including child effective cwd and home/absolute/parent
  spellings). The two scopes share the port and the result vocabulary but not a
  directory authority.

### Sessionless default-model write

A sessionless `/model` `Save default` is a HOST-owned write, never a Client
settings edit:

- **One Owner-only private service.** The Host exposes exactly one private method,
  `piTuiDefaultModel/saveSelection(selection, signal)`, delegating to the OFFICIAL
  `agentDefaultModel.saveSelection()` business service. The wire carries only the
  three model-selection fields (provider, model, optional reasoning effort) — no
  Session id, cwd, settings namespace or config patch. The Host refuses
  `owner-required` BEFORE reading any default-model/config/Loader service, and a
  `saved` reply is only possible on a profile-backed Host whose ConfigEditor and
  active `@deepseek-ai/dsh-agent-default-model` Loader entry actually exist (the
  upstream save silently resolves without them). The Client never invents a
  settings write, never calls `settings.replace`/`ConfigEditor.edit`, and never
  creates a Session to persist the default.
- **The write and the UI are different axes.** The Host result is the durable
  business settlement (`saved`/`refused`); the Client's own currentness — picker
  supersession, the pending/unconfirmed footer marker, Connection generation —
  only decides whether a result may still paint the surface. A committed Host
  write is never downgraded because a later Client read failed, and a dispatched
  failure (lost ACK, `gateway/internal`, no code) stays `indeterminate`, never a
  blind rejection or an automatic retry.
- **Live Session selection is unchanged.** A live Session's model choice keeps
  the official `session.selectModel` (the Host best-effort default save is its
  side effect); the TUI performs no second global-default write for it.

Host directory browsing is a separate READ authority with exactly one owner:
the official `directory-picker` bundle row
(`@deepseek-ai/dsh-host-directory-picker-browse`, the `browse` capability; not
the `native`/`auto` chooser, which serves no remote listing primitives) and the
`DirectoryPickerController` child the Workspace Controller installs. That child
owns the generated `directoryPicker/list` Remote verb; the Host's own filesystem
scan supplies the home directory, the canonical listed path, the ancestry
crumbs, the child DIRECTORY rows with their hidden flags and the truncation
mark. The TUI consumes it through ONE transport-neutral
`HostDirectoryBrowsePort`: Direct calls the same in-process controller handler
per read, Remote calls the same generated namespace over the authenticated
Connection with a captured generation, and a read whose generation was replaced
is rejected instead of presented as the new connection's state. A missing
controller/namespace, a non-browse capability or an official availability code
answers the truthful `unavailable` outcome; only the official
`directory-picker/unreadable` refusal is a `failed` outcome for the requested
path, and an empty level stays a successful empty listing. The generic
`gateway/internal` code is NOT an availability discriminator: the official
controller uses it for any unexpected handler failure (and the Client carrier
for a dropped transport), so it reaches the caller as an observable failure
rather than being hidden behind an `unavailable` outcome. The port never reads the Client filesystem, never
normalizes or joins a path itself, keeps no cache, and performs no Workspace
registration or Session create — `workspace.create` remains the separate
Workspace write authority. Direct gates the browse row on `tuiStartup`; the
Host-only overlay removes only that gate in place, and readiness asserts the
browse row and the child `directoryPickerController`/`directoryPicker` binding
are each live exactly once.

The Host execution graph does not depend on the mutable `tui-startup` provider.
The Host-only overlay overrides the existing `webserver`, `workspace-files`,
`workspace-controller` and `directory-picker` rows with `inject: []` and
removes `tuiStartup` from the eight Host-only execution rows, which keep only their real service dependencies
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

### Official Web frontend availability and the startup preference

A Split Host owns the official Web frontend as a TOGGLEABLE Host capability, not
as a boot mode. The Host-only overlay declares the official Web-only Loader row
set the installed DSH Web composition needs once — including the mandatory
`dsh.client.inject` closure of the shipped official Client UIs, the official
file-actions and message-quotes Client features, and the official
`workspace-changes` Host recorder the deliverables UI injects, so the Browser
graph and the Host service those packages declare can actually resolve. Every
row starts `disabled: true`, so an ordinary Split Host serves no SPA root and no
`/plugins` browser graph;
`/connect` and `/api` remain the only network surface, and a real TUI Client
connects and operates without Web. The private `piTuiWebAccess` namespace of the
same built-in runtime's ONE Typert contribution is the ONLY control surface:
`getStatus()` and `setEnabled(enabled)` flip `disabled` on exactly those roster
rows through the official `Entry.update` on the live Loader. The exact ids,
packages and their order are fixed by the official package manifests and locked
by source tests; this document carries no second roster. The authority is
therefore the Loader row plus the official
`webApp`/`clientModules`/`terminalController` services, read on every query; there
is no persisted `enabled` flag, no settings file, no profile patch write of the
toggle and no second listener, Host process or Web bundle.

The third method of the same namespace, `getAuthenticatedUrl()`, returns the
official launch URL of THIS serving Host — `connection.authenticatedUrl(
webServer.getOrigin() + '/')` — and answers only while the live status is
`enabled`. The value carries the Host's official launch token, so it is produced
only for an explicit user action (Open Browser / Copy Link), never stored in a
status object, never logged and never attached to a diagnostic or a trace. There
is no "short-lived URL", no Client-synthesized token, no cookie or pairing
mechanism and no Session deep-link scheme: the page opens the official Web home
and the user chooses a session inside it.

The headless `dsh --profile pi-tui web` commands are a SECOND, short-lived
transport adapter over that SAME Host service: one private Owner-only HTTP route
on the official Connection (`/api/pi-tui.web-control`, GET status and the three
write/read operations) exists only while the Host is published. Its `url`
operation is the one deliberate token-output exception: the CLI prints the raw
Host-returned URL on stdout for the user's explicit `web url` action; `web
status`, `enable` and `disable` never receive or print the URL. The adapter
holds no status, token, persisted flag or mutation queue of its own, does not
change the Typert Web RPC descriptors or `local/2`, and all writes still flow
through the ONE `PiTuiWebAccess.setEnabled()` serialization and the live Loader
rows. A Host build without the private route answers `404`, which the CLI
reports as unsupported (`WEB_CLI_UNAVAILABLE`) instead of inventing a state.

Activation is per Host lifetime, and the NEXT cold boot is a PROFILE preference:
the base-profile row `pi-tui-web-preferences` owns the durable boolean
`autoStart`, written through the ordinary revision-checked Settings/ConfigEditor
user patch and edited ONLY inside the `Settings → Host → Web UI` page's
`Next Host Start` section (there is no standalone preference row). Its schema default is OFF, it is independent of the running Host's
Web state, and switching it never enables or disables a live Host. The Host-only
entry consumes it after `runProfile()` + Loader settlement and BEFORE the
readiness audit / Ready publication: `autoStart: true` calls the SAME
`piTuiWebAccess.setEnabled(true)` and requires the reached `enabled` state; a
failure is one bounded `web-autostart-unavailable` diagnostic — a fixed failure
category plus the Host's own small state vocabulary, never an exception message
and never a URL, token or profile path — and the Host still publishes Ready with
the Web state its own service truthfully reports. `autoStart: false` touches no Web row and keeps this
default-off composition. A profile whose Loader does not project the
`pi-tui-web-preferences` section is a corrupted composition and fails Host
startup instead of being read as Off.

The official Settings write is a PROFILE-level operation: `settings.mutate`
→ `ConfigEditor.edit` reconciles and recomposes the whole profile patch stack
before and after writing the user patch, which re-applies this overlay's
declarative `disabled: true` rows. The private service therefore keeps the
current Host lifetime's last SUCCESSFULLY requested enablement as a TARGET
INTENT — never a state authority, never persisted, never surviving a process
restart — and after the official `app-boot/config-reload` it restores the live
roster through the SAME `setEnabled` path when the recomposition diverged from
that target. `getStatus()` keeps reading only the live Loader rows and the
official Web services, so a repair that cannot be completed is reported as the
roster's real state (`disabled` or `unavailable`), never as a fabricated
restoration. The FINAL Web state is preserved across a settings write; a
recomposition still unloads and remounts the Web rows for a short window, so a
browser connection may briefly drop and reconnect. The `autoStart` preference
is still read exactly once, at cold boot, and is never re-applied by a settings
write.

Enable assembles the browser graph first (`modules`, `client-hmr`,
`cordis-client-runner`, `terminal-controller`, then the presentation rows) and
mounts the SPA fallback LAST, so the official index never advertises a graph that
does not exist. Disable withdraws the SPA fallback FIRST and then unloads the
whole Web-only roster, including `terminal-controller`, `client-hmr`,
`cordis-client-runner` and `clientModules`. Neither direction touches the shared
Host owners: `webserver`, Gateway, Connection, Session/Agent/Job/Workspace/LLM
rows and the built-in PiTui Host Runtime keep their lifetime, accepted Host work
continues, and `/connect` plus `/api` stay authenticated and reachable. A failed
enable withdraws whatever it mounted; a disable that cannot prove the Web state
closed reports `unavailable` instead of claiming success. EVERY declared row must
reach ACTIVE for `enabled`: the `workspace-changes` provider is activated BEFORE
the `ui-deliverables` consumer that injects it (the toggle activates one awaited
row at a time), so a PENDING consumer or a missing provider makes the composition
`unavailable` and the failed enable rolls the whole roster back. There is no
tolerated PENDING row: `enabled` always means the complete official Web surface,
including the changed-files UI, is actually live.

The optional Browser roster may include Host-owned providers whose lifetime
follows Web enablement rather than the Host process. In particular, the official
session-reference provider registers an Agent pre-step listener: while Web is
enabled, canonical session references can affect the input of any Agent on that
Host, including a TUI-owned session. Disabling Web disposes that listener; an
already accepted Agent step must not be dropped or reassigned by the toggle.
Process-global Cordis inspect providers, in contrast, are registered once with
the Host registry and do not depend on Web serving state. Neither family creates
another Session, Agent, Connection or model-input authority.

The changed-files surface is ONE official chain, not a pi-tui feature: the
Web-only `workspace-changes` Host row records each eligible top-level turn's
working-tree changes (git snapshots plus whole-file captures around file-tool
intents), appends a Session-log `workspace/changes` event carrying only the turn
number, and keeps the summary and per-file comparisons in Host process memory
while that Session lives. The official `ui-deliverables` Host face serves them
through its authenticated `/api/changes.summary`, `/api/changes.diff` and
`/api/changes.open` routes, and the Browser paints the Changed Files card and
Review page from exactly those answers. Consequences of this contract:

- The chain exists only while Web is enabled; with Web off the row is not mounted
  and no turn is observed, and the Direct Host never mounts it.
- A summary or comparison the Host process no longer owns (Session disposed, Host
  restarted) stays unavailable: no card is painted for it and the routes answer
  404 instead of replaying a persisted shadow cache.
- The recorder's official default budgets and classifications apply (git command
  timeout, output/file caps, binary/oversized refusal), and a turn with a tool
  result but no file change appends no event and paints no card. Git operations
  may write git's own `core.splitIndex`/git-lfs state inside the repository, so
  the row observes the user's own workspace rather than providing a sandboxed
  read-only mirror.
- The file actions are the official Client capability: `Download` hands the
  original bytes to the Browser (the browser owns the destination, and Web offers
  no Desktop-only Save as), while `Copy image` uses the Browser Clipboard API and
  fails visibly when the permission or the source is unavailable; neither action
  makes the Host write the file. `message-quotes` inserts a Markdown `> `
  blockquote into the current composer draft and writes nothing until the user
  explicitly sends, at which point it is an ordinary user message.
- The shared `dsh-deliverable-file-references` Host row stays mounted in the base
  PiTUI profile with Web off and on. Its official system-prompt section is
  consumed by the effective Agent/preset assembly, while the `present` tool and
  the TUI `/deliverables` panel remain separate capabilities with no Web
  prerequisite. The effective assembled prompt, not the Loader row inventory,
  is the authority for whether a preset consumes that guidance.
- The Office conversion provider is Web-only: enabling the official Browser
  graph publishes `officeKit` (rc.2 renamed it from `officeToPdf`) for the
  document-preview sidebar; disabling Web disposes that provider together with
  the Web graph while retaining protected Host owners. `office-kit` writes its
  output under the Host's own DSH home, never a Client cwd. The shared
  `mcpManager` is deliberately NOT a Web row: the bundle's Host composition
  mounts it once (Direct and Host-only), so the Web toggle never mounts,
  remounts or unloads it and the same Host instance survives `/web`
  off → on → off.
- `harness-dev-context` remains deliberately uncomposed. Its developer
  instructions assume that the Agent is editing the DSH GUI that serves the
  page, and expose the DSH implementation path, GUI URL and HMR/build workflow;
  those are not ordinary PiTUI coding instructions. `web-runtime` therefore
  keeps `surfaceContext: false`.

#### Web Search/Fetch Host settings authority (rc.2)

The official `web` / `web-deepseek-api` Settings sections are the ONLY authority
for Search/Fetch provider selection, result count, Send Original Question, the
two Billing modes and the YAML-only advanced overrides. The semantic
`WebProviderConfig` is a detached read/write DTO: `read()` projects the official
descriptor values (`searchBilling`/`fetchBilling` MUST be one of the official
`auto`/`account`/`api-key` values or the read is unavailable — never silently
defaulted to `auto`; a missing single endpoint is NOT an error) plus read-only
`advanced` facts copied from the Host descriptor (`search*`/`fetch*` values;
the retired `baseURL`/`apiKeyEnv`/`apiKey` contribute only a
`legacyOverrideDetected` presence fact, never a value). The same read carries
the opaque Host settings-authority generation and BOTH namespace revisions; a
read that cannot prove all three is unavailable and authorizes no write.
`readFresh()` is the explicit observation: Direct performs a real descriptor
read, and Remote waits for any already-started refresh and starts a NEW official
`describe`, never accepting a ready cache. Page entry, explicit `r`, queue
admission and post-write verification use that fresh path.

Writes are exactly the existing provider/count/question setters and the two
Billing `set` operations against the official revision-checked
`settings.mutate` path; there is no `baseURL` setter, no automatic migration and
no TUI-side endpoint store. Every write is bound to the ORIGINAL capture: the
adapter re-proves the captured generation, the target namespace revision and
the relevant raw facts synchronously at its actual dispatch boundary (Direct:
immediately before `settings.mutate`; Remote: inside the mirror write queue
after its fresh `describe`, before the official call). A moved target revision
— including a sibling field in the same `web` namespace — is a definite
refusal; a genuinely independent namespace is never compared for count,
question or provider. Billing additionally binds the `web` provider dependency
revision and re-reads the raw eligibility: its own API must still be the
explicitly selected route and that capability's YAML override must still be
unset. These are TWO namespace observations, not one atomic cross-namespace
transaction: the official Settings CAS is per namespace, so a provider change
that lands after Billing has already been dispatched is a real post-dispatch
outcome, never retroactively a proven pre-dispatch refusal. A synchronous
currentness fact over the adapter's known authority (Direct: the live service
identity and ONE coherent descriptor read; Remote: the ready mirror generation
and both descriptor revisions) drives the launcher freshness, the per-row
affordance and the command owner's admission/receipt attribution. It starts no
Host RPC. Count/question require the API observation, provider writes require
the `web` observation and Billing requires both; a genuinely independent
namespace revision never blocks another row. A legal no-op is a distinct
zero-write `no-changes` outcome; `accepted`
is only a receipt, and `Saved` requires a trusted fresh readback that still
belongs to the captured generation and proves the requested raw value/action.
An accepted-but-unattributable readback is `unverified`, and a lost/ambiguous
receipt is `outcome-unconfirmed`; neither is ever reported as a proven refusal.
A non-empty Search/Fetch override is the Host's effective configuration for that
capability: the TUI never writes the matching Billing field, and it never
derives a request endpoint or credential from the override or from the
credential-presence metadata — the Host operation decides the actual route and
credential from the current Session.

The Client-side `/web` command is the ONE user entry and holds no Web state of
its own. On PiTui it is a TYPED DEEP LINK into the ONE Settings workspace's
`Host · Web UI` page: the SAME screen lease (no overlay, no second Settings
surface), mounted on the page's first really-painted frame, and the command
resolves only when that mount settled — a real failure closes the lease and is
the command's error, never a silent navigation to the Rows level. The
experimental TSP renderer keeps its native picker over the same
application-level presentation request. Both reach the SAME semantic
WebAccessPort; the backend assembly is Direct = truthful unavailable (the
Direct process owns no Web toggle, and the page states
`Unavailable · Split Host only`) and Split Client = the private
`piTuiWebAccess` namespace of the ONE mounted contribution. Disabling is the
same frontend serving switch described below: it never revokes a Browser
cookie, an existing Browser page, a Bearer token or a live Browser WebSocket.
The listener stays `127.0.0.1`-only, and the first release formally supports
only the trusted same-machine user (no LAN, public proxy or SSH tunnel
guarantee).

A user decision is bound to the Host generation it was DISPLAYED under, not
only to the generation a single RPC was sent in. `WebAccessPort` therefore
exposes `currentGeneration()` / `subscribeGeneration(listener)` (the Remote
adapter forwards the ONE Connection generation source; Direct owns no
transport generation) and accepts an optional `expectedGeneration` on
`setEnabled`/`getAuthenticatedUrl`. The adapter refuses BEFORE dispatch when
the live generation no longer matches — zero Host dispatch, a thrown
`SupersededReadError` — and a generation change revokes the visible actions and
re-reads before any new action is offered. A status observation is painted as
the current Host fact only while the generation sampled before and after its
read is the same and non-empty; a reply from a replaced Host never qualifies an
action. Legacy callers that pass no `expectedGeneration` (the TSP picker path)
keep their previous behavior.

This is a frontend SERVING switch, not an authorization boundary. It makes no
promise about an already-loaded browser page, an existing Browser cookie or a
live Browser WebSocket, and it must never be described as revoking Browser
access, blocking Browser operations or logging Web out. Sessions, Agent
ownership, Host identity, TUI transport generation and DSH data formats are
invariant across a toggle; the `autoStart` preference is likewise a next-launch
configuration fact, never a second runtime authority.

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

### Canonical TUI preferences and migration

The 20 durable TUI preferences live in the ONE profile row
`pi-tui-preferences` (package subpath `@xmoon76/dsh-pi-tui/preferences`), whose
`.volatile()` Config is also the Settings namespace and whose `piTuiPreferences`
Cordis service carries the live references. The row is a CONFIG-ONLY carrier:
it starts no TUI, Agent, Session, Gateway, timer or watcher, it is not gated on
`tuiStartup`, and it is disabled only in the daemon supervisor PID. Its
auto-generated Settings page is hidden because that page would expose the
internal migration marker; `Settings.describe()`/`mutate()` remain the
authority and every consumer still writes through the official
revision-checked path.

Persistence and read authority are therefore single-sourced:

- Direct reads the row's live volatile references through the injected
  `piTuiPreferences` service and writes path-scoped `SettingsForms.mutate`
  operations against the row.
- A Split Host reads the same row and serves its descriptors over the official
  Settings wire; a Remote Client reads and writes only that namespace (a
  missing canonical section is `unavailable`, never a fallback to an old
  namespace or to schema defaults).
- The retired `tui-app` and `split-host-pi-tui-runtime` rows keep their
  published schemas only for installed-profile/API compatibility and as
  migration sources. They are not a runtime preference authority, and their
  USER values are never copied back after migration.
- Footer command/custom-item trust reads only the canonical USER layer; a
  project, home or command-line layer can never authorize execution.

The Host owns a one-shot migration barrier, run by the Direct runner before the
first display/Agent read and by the Split Host entry after Loader settlement
and before the Web/ACP startup preferences and Ready publication. It re-reads
the profile USER patch inside the official profile file lock, resolves each
field as canonical USER -> legacy Direct/Split profile USER (RAW-equal sources
migrate once; different sources are a fail-closed conflict) -> the retired
`settings.yaml(.imported)` document -> leave inherited, then writes the
migrated fields plus `legacySettingsMigrationVersion: 2` in ONE official
`ConfigEditor.edit`. Conflicts, unreadable sources, `!!js` scalars and refused
writes fail the start visibly and never advance the marker; the old profile
rows and the imported document are preserved for downgrade/diagnosis. A Split
Client never reads the Host profile and never migrates.

The official Web roster is declared by the BUNDLE from the ONE production
roster table (a generated bundle layer, default-disabled), not by the
Host-only command-line overlay: an overlay config override makes the official
ConfigEditor refuse that row's user writes. The Host-only overlay keeps only
the three fixed non-user values without volatile Settings forms (Web runtime
silence, Office Kit Host output directory, Office Skill user Python); the
private `piTuiWebAccess` service remains the only runtime owner of the toggle.

### Per-Turn TUI prompt policy and session-view presence

Four TUI-owned system-prompt sections — `tui:progress-updates` (80),
`tui:response-style` (81), `tui:git-attribution` (82) and `tui:focus-mode` (90)
— are installed per ordinary root Agent by ONE shared policy
(`app/agent/prompt-sections.ts`), on the Direct branch at composition and on a
Split Host through the `agent/created` observation of the official registry.
Their text derives from the canonical `pi-tui-preferences` live references and
the per-Turn policy; a `complete` persona keeps the official suppression
result (the complete section is the sole prompt), and a subagent-origin
Session never gets these sections.

The per-Turn policy is a SAME-SESSION fact, frozen exactly once per Turn: the
official `turn/start` publication synchronously samples the Session's current
verified TUI viewers `{ eligible, focus }` and the four section texts read that
frozen snapshot until `turn/end` clears it. The three preference axes
(progress cadence, response style, git attribution) stay live reads at every
assembly. An ineligible Turn renders none of the four texts; section presence
is never a claim of rendered text.

Who counts as a current verified TUI viewer differs by backend and is never a
Profile fact:

- Direct: the local surface is the only viewer — eligible when the committed
  main view is exactly this Agent's Session, Focus when the local display
  preset is Focus.
- Split: the Host folds the **authenticated per-Peer presence** projection
  (`piTuiPromptPresence`, one private `syncView` method): each Client asserts
  its own currently viewed Session id (or `null`) plus its Client-local display
  preset under a monotonic revision, and the Host commits exactly one record
  per `RemoteInvocation.peer.id`, returning the ACK only after the commit.
  A non-Owner caller is denied at the Gateway dispatch; an untrusted or
  subagent Session id is a definite `session-not-live` refusal; a stale
  revision never touches the committed record; a disposed Peer's record is
  retired with its `peer.signal` lifetime. The per-Turn fold compares the
  record's Session/Agent objects by identity against the CURRENT Host
  registries (a same-id replacement invalidates the voter) and ORs presets —
  any current Focus viewer makes the Turn Focus.

A Split Client re-projects its view after every navigation commit and every
display mutation, and its prompt admission (ordinary, steer and queued) awaits
the current revision's Host ACK before the Client starts its own new Turn; a
refused or unconfirmed presence refuses that submission truthfully and never
replays it. `syncView` is part of the required `dsh-pi-tui/local/2` baseline:
a same-protocol Host always serves it and the admission gate never degrades,
while a different-protocol Host is refused at connect. Another Client is never
delayed by an unACKed change — the Turn samples the most recent ACKed roster at
its start. The durable `displayPreset` profile value is a startup preference
only; it is never a Focus voter, and a Web/ACP-only Session stays on the
official prompt.

Regression anchors: `test/app/agent-prompt-sections.test.ts` (frozen Turn on
real Session boundaries),
`test/app/pi-tui-prompt-presence-wire.test.ts` (ACK-after-commit, peer
identity, stale revision, untrusted Session, peer retirement),
`test/integration/host-agent-prompt-parity.test.ts` (Direct/Host model-facing
parity and the negative cases).

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

### Subagent settings authority

The official `subagent` limits and `subagent-model-selection-settings`
preference are Host-owned Settings. `ConfigPort.subagentLimits` and
`ConfigPort.subagentModelSelection` expose them as TWO typed semantic
sub-domains; a consumer never names a namespace or a JSON path. Each `read()`
projects ONE current descriptor into detached typed `effective` and `inherited`
values with its exact revision and opaque Host generation, and reports
`unavailable`/`unreadable` rather than inventing schema defaults. A rewrite is
one official revision-checked settings mutation built from the caller's field
intents; Reset is the official field `unset`, never `set(inherited)`.

Direct reads the live in-process settings service and uses its current Settings
service authority identity as the generation. Remote uses the ONE existing settings mirror and
the mirror's current Connection generation; it refuses a replaced generation
before dispatch (and again inside the shared write queue), uses the caller's
captured revision rather than a refreshed one, and keeps the existing accepted
write lifetime across the Host settlement and post-write refresh. A dispatched
write whose settlement cannot be observed is `outcome-unconfirmed`, never a
proven refusal. DSH rc.3 may materialize a Reset value in the USER patch while a
sibling override remains; the resulting effective value is the Host authority,
and no consumer may require USER-field deletion as Reset success. Settings page
drafts, dirty state and pointer state remain Client-local and never cross the
boundary.

### Agent-loop, shell-execution and session-log settings authority

`ConfigPort.agentLoopSettings`, `ConfigPort.shellExecutionSettings` and
`ConfigPort.sessionLogUpload` expose the official
`agent-loop.maxParallelToolCalls`, the ACTIVE model-tool shell executor's
`timeoutMs`/`maxOutputBytes`, and `session-log-deepseek.enabled` as narrow
typed semantic sub-domains. A consumer never names a namespace or a JSON path:
each read projects ONE current Host descriptor into detached
`effective`/`inherited`/`overridden` facts with its exact revision and opaque
Host generation, and reports `unavailable`/`unreadable` — never a fabricated
schema default. The `overridden` port fact is the effective/inherited
difference; the TUI labels it `Differs from base` / `Matches base`, not USER
override presence. The subagent Reset rule applies unchanged: Reset is the official
field `unset`, and the Host readback decides the effective value; USER-field
deletion is not a success criterion.

The shell sub-domain treats the executor identity as a HOST observation. The
adapter selects the namespace from the Host's served Settings descriptors
following official dsh-web: prefer `pwsh-sandbox` when both are served, otherwise
use the single served row, and report `unavailable` when none is served; the
Client OS is never consulted. Two served namespaces are not an ambiguity.
A write re-proves the same current served row and generation/revision before
dispatch; the served-row identity is part of the page's currentness, so a
same-revision switch to the other namespace is read-only. Direct uses the in-process Settings authority; Remote
uses the ONE existing settings mirror and its Connection generation, pins the
caller's captured revision, keeps the existing accepted-write lifetime across
the settlement and post-write refresh, and refuses a replaced generation. Both
shell caps are dispatched as ONE path-op batch in that one namespace. Remote
does not write from a stale mirror and does not claim a last-known Session-log
value as current; `false` is a real value and the row is absent when the Host
does not serve the namespace. Page drafts, dirty state and pointer state remain
Client-local.

### Saved agent-preset default authority

`ConfigPort.presetDefault` answers two different questions and never merges
them. The registry's effective default (deployment default merged with the
saved `agent-preset-registry.selectedDefault` user value and the chooser policy)
is a read; the one-argument `set(id)` is the ordinary `/preset default` write,
which dispatches ONE revision-checked official Settings mutation for FUTURE
Sessions and never starts, switches or mutates the current Session. An accepted
write is not an effective-value readback: the caller needs a fresh read.

The Computer Use page uses the confined guarded seam on the same sub-domain.
`readDecision()` returns the live settings-authority generation, the exact
`agent-preset-registry` revision and the effective default, or `undefined` when
the current authority cannot prove all three; a caller without that proof offers
no write (never a fallback to the unguarded `set`). `setGuarded(id, decision)`
dispatches ONE `selectedDefault` path mutation at that captured pair and refuses
BEFORE dispatch when the authority was replaced or the revision moved — Direct
checks the live settings service, and Remote re-checks inside the ONE serialized
settings-mirror queue with the same before-dispatch fence every typed section
uses, so a decision queued behind another write is never rebased onto the new
Host. The caller's own Computer Use observation is an independent authority at
that boundary: `setGuarded` carries the caller's FULL captured-eligibility
predicate (observation identity, provider/platform and the exact painted preset
decision) and both adapters re-prove it at the actual dispatch (Direct
immediately before the official mutation, Remote inside the queue head), so a
superseded observation or an independently settling read that makes the captured
action ineligible dispatches nothing even at an unchanged settings pair. A
proven same-authority readback still attributes the accepted preset write even
when unrelated Computer Use UI changes afterwards. `accepted` means the official mutation settled; only a later same-authority
observation that serves the target value confirms the change, and an
unobservable settlement is `outcome-unconfirmed`, never retried or painted as
saved. There is no second preset store, optimistic Client value or Session
side-effect.

### Per-package extension configuration authority

`ConfigPort.extensionConfigs` is the narrow semantic sub-domain for one
opted-in npm package's profile-owned Config carrier row. The caller supplies
the official package manifest `name`; the adapter derives the row id through
the single `extensionConfigRowId` rule and never accepts a namespace, row id
or profile path. It grants no install, selection or execution authority: it
addresses only a row the official composition already mounted.

`read()` projects the official Settings form's `value.data`, `base.data` and
`user.data` into detached JSON values — preserving `null`, `false`, `0`,
arrays and absent data — with the exact revision and an opaque Host
generation; `userDataPresent` is own-field presence at `user.data`, never
value inequality. A missing row is `unavailable`, a non-current Remote mirror
is `stale`, and an unreadable descriptor is `unreadable`; none is replaced by
an empty default.

A write is ONE official revision-checked Settings mutation whose paths are
relative to `data`, dispatched at the caller's captured generation and
revision. Direct reads the in-process Settings authority; Remote uses the ONE
existing settings mirror and re-checks generation and revision inside the
serialized dispatch queue. `accepted` requires the official write to settle
AND a fresh authoritative read-back to serve the same generation; a
dispatched failure whose settlement cannot be observed is
`outcome-unconfirmed` and is never retried. There is no second store, mirror,
write counter or Client-side optimistic value, and no namespace, path or
secret crosses the port.

The same sub-domain backs the Stable persisted extension-setting branch. A
plugin declares a JSON-scalar `path` and a closed choice list; the Settings
workspace resolves the writable package only through the CURRENT Client's
exact registration owner → live Loader entry → ACTIVE package observation. An
author-supplied package name, a prefix guess or a Host-only registration is
never accepted. A saved choice is ONE CAS mutation plus a fresh
same-generation readback: `set` requires the authoritative EFFECTIVE leaf to
carry the target, and `unset` requires it to equal the inherited leaf. The
official SettingsForms/ConfigEditor `unset` restores the inherited effective
value; when a sibling USER override remains, the USER leaf may remain present
and is displayed truthfully rather than treated as failure. The independent
Client apply step is triggered through the existing mount owner reconcile.
Runtime-only settings keep their in-process registry writer and never touch
this sub-domain.

### Client-local external `./tui` loading

An opted-in npm package's `./tui` entry is loaded ONLY by the CURRENT Client,
through that Client's EXISTING official Cordis Loader. The semantic owner is
`src/app/client-extensions/**`, shared by Direct and Split:

- Inputs are ONE committed official Host `PluginManagerPort.snapshot()`
  (`bundles[].enabled` plus the live `plugins[].patchId/moduleName/enabled/
  fiberPhase` rows), the current process's official `PluginPackages.packageOf`
  identity/manifest, and the existing pure Client-extension qualification.
  A Client-local `package.json` scan, a profile path read or a second npm
  resolver is never an authority.
- `ConfigPort.extensionConfigs` supplies the package's effective `data` value
  verbatim. An unavailable/stale/unreadable read is an explicit Client-local
  state; a previously mounted package is unloaded through the official Loader
  with awaited Fiber cleanup, so it never becomes `{}`, a stale value or a
  live ACTIVE entry.
- The Loader entry id is `pi-tui-client-` + the validated 32-char
  `extensionConfigRowId` suffix. `loader.create()` returning is not activation:
  the entry's real Fiber must exist, settle and be ACTIVE.
- Code identity is the SHA-256 of the exact module file the official Loader's
  ESM resolver will import — never a `require`-condition path or a second
  resolver. The official package version is a second currentness input: a
  changed version, or a failed first apply after a successful import, is
  remembered as an import-attempt identity so a same-PID retry cannot report
  new disk bytes as ACTIVE. Identity memory is process-lifetime per Loader,
  so a same-PID surface revision inherits the identity of the module v1 that
  Node's ESM cache actually holds.
- A transition to `reload-required` emits one actionable user notice through
  the existing PiTui notification seam: Split says `/reload-client`; Direct
  says to restart the Client. This is an advisory, not a Plugin Manager page
  or a second management surface.
- Unload captures the real Fiber, removes the entry from the Loader tree
  first, then awaits that Fiber's terminal disposal before the id may be
  reused. A same-PID byte change is never re-imported; the old entry keeps
  running and the package becomes `reload-required` until a new process
  imports the new module.
- Direct mounts these entries in its own Host-process Loader as ephemeral
  Client runtime entries — never as profile `cordis.patch.yml` rows. The Host
  Plugin Manager projection excludes only the entries PROVEN owned by the
  current Client mount owner: they are Client runtime facts, not manageable
  profile plugins; a Host row that merely shares the naming shape stays
  visible. A Split Client mounts
  them in its own Client Context/Loader; closing one Client releases only
  that Client's entries.
- The Plugin Manager's committed-explicit-refresh callback drives an
  incremental reconcile. It is a process-local method pointing at the CURRENT
  surface revision; there is no polling, Gateway callback or cross-process
  callback, and a superseded revision never publishes a stale observation.

The live Entry/Fiber and per-package `pending`/`active`/`error`/
`reload-required` observation is the only Client runtime status. `pending` is
published only from a REAL Loader activation attempt; it is never inferred
from the Host's `enabled` flag. The ONE observation source carries a semantic
revision and an idempotent subscribe/unsubscribe lease; the Plugin Manager
page reads it late-bound and a change repaints that page without re-running
the Host inventory read. Official Plugin Manager `enabled` is
install/selection truth and is never re-labelled as Client ACTIVE.

### MCP server management (ONE Host manager)

The ONE official Host MCP manager (`@deepseek-ai/dsh-mcp-manager`,
`ctx.mcpManager`) is a SHARED Host row, declared exactly once in the bundle's
`cordis.patch.yml` (Direct and Host-only both mount it; the daemon supervisor
does not). It is deliberately NOT part of the Web-only roster: `/web` on → off →
on keeps the same manager instance, and a Web-off Host still owns the manager.
The row resolves `${credential:…}` entry templates through the already-mounted
`credentials` provider; no second manager service exists.

The manager owns the ONLY fleet and status truth: the profile's
`mcp-manager.servers` configuration plus plugin `register()`ed entries, and the
`disabled`/`connecting`/`connected`/`reconnecting`/`waiting-credentials`/
`failed`/`closed` runtime states. `McpServerPort`
(`src/runtime/mcp-server-port.ts`) is the ONE transport-neutral management
surface — `watch`, `probe`, `restart` — implemented in-process by the Direct
adapter and by the generated `@deepseek-ai/dsh-mcp-manager/remote` contribution
on the Split wire. Every observation and operation result is bound to an opaque
Host generation identity; a result from a generation that is no longer current
is discarded, never presented as a fact. `restart` is dispatched at most once
and returns only that the Host settled the request — never "connected" (the new
status arrives through `watch`). Failures are `unavailable`, `rejected`
(a proven Host refusal), `superseded` (page/generation no longer current) and
`outcome-unconfirmed` (dispatched, settlement unobservable — never retried).

`McpManagedServerView.configured` only says that an entry still exists; it is
NEVER the configuration-source verdict. The read-only
`ConfigPort.mcpServerSources` projects the EFFECTIVE `mcp-manager.servers` key
set from the official Host Settings (Direct in-process; Remote through the ONE
existing settings mirror and its `describe()` refresh); every `ready` read
carries the opaque Host generation identity it was read from, and a consumer
must treat a key set from another generation as `Unknown` rather than combine it
with a roster. Classification is
`Configured` when that key set holds the name, `Retained/removed` for a manager
record with no live entry, `Plugin-owned` only for a live entry the CURRENT key
set does not hold, and `Unknown` whenever the key set is not current/unreadable
or still settling (a non-atomic watch/Settings window may not be resolved into
`Plugin-owned`).

`ConfigPort.mcpServerConfiguration` is the narrow SPLIT read/write sub-domain for
the SAME namespace: Direct uses the in-process Settings descriptor, Remote uses
the ONE settings mirror (never a second mirror). One `ready` read carries the
Host generation, the official namespace revision and the effective/base layers
of ONE descriptor; provenance is derived from the effective entry versus the
base entry (the ConfigEditor materializes inherited entries into the USER patch
on writes, so USER key presence is not an override verdict). Every CRUD write is
ONE official `SettingsForms.mutate('mcp-manager', ops, expectedRevision)`;
Remote additionally fences the Connection generation and uses the accepted-write
lifetime. A resolved write is re-read before it is reported saved; a lost
post-write read is `outcome-unconfirmed`, never replayed. This sub-domain owns
configuration facts only: the manager watch remains the sole live
connection/status authority, and no resolved secret, namespace or profile path
crosses the port.

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
descriptors are resolved from the installed DSH anchor. The Client Shell also
carries the official platform Store engine (`@deepseek-ai/dsh-client-store`
with its Zustand/Immer runtime closure) as build-time code: the Node Client
supplies that ONE module namespace through `CLIENT_PLATFORM_MODULES`, so the
browser-form `/client` bundles' `require` resolves the same singleton the web
shell shares. This is a distribution/assembly fact, not a second Store or Host
authority. `@deepseek-ai/cordis` and every other official DSH package still
resolve from the installed DSH Runtime; no source-tree descriptor may mix with
that installation.

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

Remote explicit `/new` and Folder New use a discriminated
workspace-new-conversation lifecycle request. The command captures the official
Connection generation at the gesture; the Remote adapter resolves the Workspace
and, in that same operation,
reads one complete `workspace.follow` baseline (including the archive set) and one
raw `session.list` result. A failed or partial read never becomes an empty
candidate set. Candidates are considered in raw official Session-list item order
and must be main-origin, unarchived members with the canonical header cwd,
`blank === true`, and no known different preset. The first eligible id is sent as
the official create's optional reuse candidate; with none, `sessionId` is omitted.
The Host may return that candidate or another actual identity, and only the
returned identity is retained and committed. Every explicit New dispatches exactly
one official create: a returned exact binding maps back to the existing owner, so
the surface keeps its generation, drafts, recall, ingress and live owner; a
same-id different binding remains a real replacement. The raw proof and generation capture
are operation-local and never serialized or cached. Every dispatched create is one-shot: rejection,
published-with-error and indeterminate outcomes keep their distinct truth and are
never retried automatically.

An ordinary create naming an unknown WorkspaceId is refused before publication.
A create that published and then failed to attach its membership reports the
real published identity (`published-with-error`), and a create dispatched
before a connection loss stays `indeterminate` with the requested id as
correlation only; neither is ever retried. `open`/`resume`/`--session` keep
addressing a Session by identity only: they never rewrite the header directory,
replace membership or attach a historical Session to the Client's current
directory. `-c, --continue` is a WORKSPACE-SCOPED read: it may select only when
the Host has CONFIRMED a `workspaceId` for this launch, the official
`workspace.follow` membership baseline exists, and the official main Session
roster intersects it. The first intersecting row in roster order wins. The
membership observation must still be on the SAME Host/Connection generation as
the roster: a replacement between the two abandons the automatic continue
rather than pairing stale membership with a newer roster. An unconfirmed
Workspace produces no Host write; an already-authorized Direct launch path or a
verified Remote auto proposal may still be resolved by the existing Workspace
preflight (which can create-or-reuse the official Workspace record), exactly as
the ordinary sessionless mount. The launch creates no Session, and a
missing/failed baseline, a replaced connection or an unconfirmed Workspace
never falls back to another Workspace or to a fabricated empty membership.
There is
no implicit "current Workspace" global — each Client holds
its own selection intent, and two Clients of one Host may create in different
Workspaces.

Above the Domains, the Client mounts exactly one Client UI subtree (extension
host + first-party builtins), one split application runtime (Backend + the ONE
shared owner registry + presentation bundle) and one real runner fiber. The
runner adopts the pre-built Remote selection by identity; the Client bootstrap
never constructs a second Backend, owner registry or presentation graph. A
mounted Session is committed to the visible surface only through the official
`retain()` reference. Explicit open/resume additionally requires `ready` AND
`openState === 'open'`; `ready` alone is not an open history. Create adoption is
the official navigation exception: it commits the returned identity after reference
acquisition without awaiting initial history readiness, while the existing
publication-to-ingress fence catches events that arrive before subscription.

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
Stop sends the Host Agent cancel. Leaving a Session through the Client's
`/new`, a session switch or `/resume` is a Client detach too: it releases the
Client's `tuiMainView` reference and transport, never a Host cancel in
disguise, so the Host Turn the Client was watching keeps running and
persisting. (The Direct backend inside the Host process is the exception, and
it belongs to `docs/architecture/concurrency.md`: there the adapter owns the
Agent lifecycle, so its navigation stops the replaced owner before creating
the next Session.)

Herdr Session-restore reporting is Client-local. The Client process owns the
one Herdr reporter; the Host never creates one. A Split/daemon Client builds
the reported resume command from the entry's officially verified Profile and
pins `DSH_PI_TUI_BACKEND=daemon` with `env`, because the Profile may later be
saved back to Direct while the Hosted Session still lives. The reported command
names a persisted Session, not the old Client process: Herdr restarting a Pane
does not preserve that Client's OS PID/TTY or a running Turn, and publishing
the command does not prove the original Host instance. A live Host is reused
only through the official local discovery/authentication; an absent Host is
whatever the public daemon CLI starts for that Profile. The Host remains the
sole Session owner throughout.

OSC 7577 program-resume reporting is the Client-local terminal counterpart of
that Session fact. Direct reports from its own process; the public daemon
supervisor gives an admitted foreground Client ONE versioned, non-secret
launch-facts handoff plus the protocol token, and the record's owning PID is
the stable supervisor PID (not the disposable Client or Host PID). The Client
entry captures and deletes both private fields before ensuring a Host, and the
Host/manager/ACP/fallback environments never receive them. The Host never
writes OSC 7577. A supported Client reexec forwards the capability only when
the replacement manifest declares the internal v1 handoff; an accepted reload
to an older target withdraws the old record instead. The exact output
projection, fail-closed launch scope and human-exit-vs-generic-disposal clear
rule are owned by [terminal-output.md](./terminal-output.md).

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

Navigation-first admission (split Client, PiTUI surface only): the ONE root
interaction delivery owner holds each official forwarded invocation and hands
it to the current surface only while the application has committed the
request's own Session, no presentation-only navigation hold is active, and the
official request signal is live. The owner's ONLY outward answerability view is
`currentEligibleRequests()`: a transient, identity-only list (Session id +
`question`/`approval`) of the invocations THIS Client root still holds, removed
the moment one settles, aborts or the root disposes. It carries no request
body, option, answer or Host pending record; a UI may use it as a POSITIVE
answerability fact and must never treat its absence, a Reader `attention`
value or the right to read `session.state` as one. A request whose Session is not the committed
subject waits; it is never painted onto another Session's editor, and a
Reader-side `attention` candidate is not a substitute for that live forwarded
request. The PiTUI modal-safe `Alt+W` entry commits the hold first, withdraws
the local modal seat, and opens the existing registered Session Workspace; the
same official invocation is re-offered after the user returns to its Session.
The hold bumps a presentation epoch before the seat is withdrawn; a committed
Session replacement instead fences the outgoing request through the synchronous
committed-subject check (the coalesced scope notification also bumps the
epoch). In both cases the local cancellation is never sent as a human answer,
cancel or deny. The hold is released by the physical Workspace close, or at
once when that entry cannot present. A TSP split surface is not bound to the
committed-subject gate and keeps its native admission; Direct keeps its
unconditional presentation delegation.

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

## Session activity and Workspace facts (read-only)

`SessionWorkspaceFactsPort` is the ONE UI-neutral read-authority seam for facts
that are NOT the mounted surface's own Session. It is read-only: it submits no
question answer, approval, cancel, open, retain or create, owns no Client
workspace/question/approval store and keeps no cross-session cache.
`SessionReader` remains the ONE Session-listing authority.

- **Browser read lifecycle.** Every renderer's Session Browser presents one
  renderer-neutral `SessionBrowserReadOwner` over `SessionReader.list()`,
  `projectionBatch()` and `search()`; the renderer owns only its physical
  Presenter seat (the PiTUI fullscreen Session Workspace, the native TSP picker) and keeps no
  second roster, query generation, search timer or reader. An accepted Resume
  carries the captured `SessionScope` into
  `SessionRuntime.switchSessionOutcome(target, expectedScope)`, and only its
  settled `committed` outcome is success — an accepted intent, a matched row or
  a closed Presenter is not.
- **Roster observation.** The owner advances its monotonic `listRevision` only
  on a SEMANTIC roster change (membership/order/title/preset/cwd/format/
  `updatedAt` and the tri-state `blank` fact as actually painted); a projection
  batch, a search page, a repaint or an Activity update never advances it, and an
  unchanged official notification restarts neither the projection batch nor the
  content search. A blank-only change re-derives visibility and prunes accepted
  search/selection state synchronously, but does not itself trigger a projection
  batch or Host search. Remote maps the official list row's `blank` bit as a
  tri-state semantic fact; absent stays unknown rather than becoming false.
  A reader that already owns an official observable list (Remote's
  `ISessions.list`) exposes the optional internal `SessionReader.observableList`
  snapshot/subscribe face; the owner then subscribes and NEVER polls: the
  Client Session Manager owns list arrival, so no periodic roster refresh
  request is issued. A reader without that face keeps its pull cadence (Direct
  keeps the PiTUI single-re-armed 20 s local refresh; TSP never adds a poll) —
  the capability decides, never the renderer's network state, and both
  renderers receive the same push updates when the face exists. An explicit `refresh()` still asks the reader for one real
  read. A failed pull keeps the last accepted roster with a nonfatal freshness
  status; a disconnected observable source keeps that roster as latest-known
  metadata and never turns it into an empty Session universe. An accepted
  roster re-filters the presented search results to the Sessions it still
  lists, so a removed Session is never selectable (or readable) while the
  refreshed Host search, a projection batch or an unavailable/error search
  state is still pending.

- **Two activity consumers, one classifier.** `observeActivity(signal)` is the
  ONE per-open INCREMENTAL observation the Session Browser drives: it commits
  the caller's roster (identity/epoch first), publishes the official running
  projection in that same frame with every unmeasured row honestly unknown, and
  commits each measured row as its own publication. Its snapshot carries the
  roster revision it was measured on AND its own monotone Activity revision;
  they never relabel each other. `readActivity(rows, signal)` keeps the EXACT
  precise sample (one fenced complete answer for an explicit roster) for the
  qualification probe and focused reads; the Browser never calls it for its
  ordinary roster. Both consume exactly the main rows the caller obtained —
  never an alternative corpus, no added or dropped row, `subagent` children
  excluded — and share the SAME validators/`deriveAttention` classification.
- **Running.** The official list row (`RemoteSessionListRow.running`) owns the
  normal running fact: the Client Session Manager replays the Host status
  mutations into that row, so there is one current authority and no
  cross-source comparison. A `phase=ready` list is an arrival latch, NOT a
  fresh generation baseline: only the Client domain's FIRST established
  Connection generation may claim the list as a running baseline, and a
  replacement revokes every proven positive. After a rollover only a
  current-generation forwarded `api-session/status` event or a targeted exact
  `session.state` may re-prove running; rows without that evidence stay
  unknown rather than a fabricated idle. `SessionSummary.live` (the old Direct
  attachment bit) is never a running source, and a missing live Agent is
  unknown rather than idle.
- **Bounded scheduling.** The observation owns a fixed budget of at most FOUR
  actual concurrent unary requests: three for the priority lane (the current
  Session, locally eligible rows, running rows, positive pending hints) and one
  reserved background slot for ordinary unresolved discovery. A worker issues
  each read's `state` and `projections` sequentially, so the limit is on real
  requests, never on worker count. Only a discovery that promotes a row hands
  its exact projection to the priority lane; every independent recheck re-reads
  its own pair, so a failed or malformed projection is never reused. Ordinary
  unresolved rows receive ONE exact `session.projections` discovery per
  unchanged relevant source revision — never an all-roster periodic pair scan —
  and a discovery that proves no active entry leaves `attention: 'unknown'`
  (the Gateway pending kind was not sampled), never `none`. A completed
  discovery attempt is remembered as SCHEDULING evidence only, scoped to the
  Connection generation and the relevant hint witness; it lives for the facts
  adapter's surface-runtime lifetime, so a close/reopen with an unchanged source
  does not repeat ordinary discovery. The adapter observes the official list and
  Connection generation for that whole lifetime (Client-store subscriptions
  only, no Host work while closed), so a relevant source revision change — the
  pending-hint witness or an official `running`/status transition, even one that
  changes and reverts while the panel is closed — deletes the receipt; equal
  witness values are not proof of the same revision. Receipts are bound to
  the official authorized roster, are discarded on a generation
  replacement/loss, record nothing for a denied/unavailable/failed read, and are
  never an answerability fact, never cached payload and never consulted by the
  answer gate or the Writer. Only
  active rows (running, eligible, observed pending, current) keep ONE re-armed
  20 s recheck, because the Gateway has no global public pending event; ordinary
  idle rows are never re-sampled. Each read owns an operation identity: an
  invalidation recorded while its row is in flight is coalesced (priority wins)
  and dispatched when that read settles, so the newest epoch always converges,
  and an older completion can never release a newer request's slot.
- **Connection loss.** A generation loss or replacement immediately revokes
  every proven positive fact (including a row that only had `running`), cancels
  queued/in-flight reads, clears the dispatch authority so no new unary read
  leaves while disconnected, and drops the discovery memory; a valid current
  generation resumes from the official snapshot plus targeted status/state proof
  and ONE discovery pass. A latest-known list `running=true` that the new
  generation has not proved is a SCHEDULING trigger for that targeted read,
  never a positive fact; a replayed `phase=ready` row can never prove running by
  itself. Rows stay unknown until re-proved: an old sample can never revive a
  Working or Needs row.
- **Pending.** The two official passive sources are the Host
  `session.state(...).pendingInput` kind sample and the cold-safe
  `session.projections(...).values.userQuestions.active` timed-Question
  projection with the same binding's `inbox` queued-reply records. The port
  reports `question`/`approval`/`other` as a kind clue, never as answer
  authority: `other` is unknown, `plan-review` is identified ONLY by the
  official `AskUserQuestionItem.intent.kind`, and a `continued` call is a
  late-answer candidate only while no same-`callId` `user-question-reply` is
  already queued. `none` requires a `sequenced` projection whose active records
  AND inbox were both read and show no answerable call; an unreadable source,
  `null`, `migration-required` (including cache hints) or a missing
  `userQuestions` unit is `unknown`, never `active: []`. Two sources that
  genuinely conflict fail closed to `unknown`. The answer itself never travels
  through this port, and the port makes no answer-authority claim: `attention`
  is a candidate classification for the SUPPORTED authenticated owner
  answer-Client composition (the split Client's ONE `interactions:'answer'`
  owner with the root Question/Approval listener). The official
  `session.state`/`session.projections` reads supply the Host facts and
  visibility; the existing owner event consumer plus the Gateway's
  first-settlement own answer authority and final settlement. Host permission
  to read `session.state` is NOT answer authorization, and this port makes no
  answerability claim for an arbitrary read-allowed peer; a non-owner peer
  composition is outside this port's supported use. A Client navigation or
  Session reference change is never an answer: a consumer must re-check the
  live forwarded request through the existing interaction lifecycle and must
  never treat `attention:'question'` alone as proof that the request is still
  answerable. The official request lifecycle decides.
- **Failure vocabulary.** `remote-access/denied` is `denied`,
  `gateway/invocation-unavailable` is `unavailable` (the optional read method is
  genuinely not registered), and every network/Host/codec/timeout failure is
  `unknown`. A failed or denied row keeps its in-row Unknown/Denied and never
  clears or zero-fills the other rows. Abort and Connection-generation
  replacement discard the WHOLE sample (abort / `SupersededReadError`); a
  superseded generation is never published as the current one. The Remote
  adapter bounds per-Session passive reads (six concurrent reads) as
  backpressure; the bound never truncates the roster.
- **Workspaces.** `followWorkspaces(signal, mode)` is one caller-owned per-open
  observation over the official `workspace.follow` stream (Remote) or the
  official Host `workspaceRegistry` plus `domain/changed` re-reads (Direct). The
  forwarded frames are `baseline`/`replace`/`upsert`/`remove`/`order` plus
  `invalidated` (the current generation's membership is no longer proven); the
  registry-global `archived`/`pinned` sets are not Workspace membership and are
  ignored. Every generation starts with exactly one baseline, and a baseline is
  validated against the current Connection generation and the physical stream
  item before it is accepted; a missing baseline is an unknown Workspace state,
  never an empty one. The `single-generation` mode (the `-c` startup pairing
  and explicit one-shot probes) ends the observation on a generation
  replacement and never stitches old membership onto a new roster. The
  `recovering` mode (the Browser) uses the official reconnecting Gateway
  `$stream`: a physical carrier loss or a Connection loss emits `invalidated`
  and the SAME logical handle consumes a fresh baseline from the replacement
  generation. A resumed stream that does not prove a fresh baseline within its
  bounded resume window fails truthfully instead of waiting forever; a terminal
  (non-carrier) failure ends the handle and is never retried on the same
  generation — only a NEW Connection generation may open ONE new logical
  handle. The Browser installs its ONE per-open generation observation from the
  moment it opens, so even an open with no usable generation rebinds when a real
  one arrives; a duplicate opening baseline inside one physical generation is a
  protocol error. The handle is disposed exactly once and its asynchronous SDK
  quiescence is observed, never left floating. Workspace
  identity/path/title/membership are the Host's values; the Client cwd, HOME or
  PATH is never a membership input.
- **Direct parity.** Direct reads the exact live Agent status and the official
  `workspaceRegistry` it already owns; it fabricates no cross-Session pending
  fact (`attention: 'unknown'`) because it owns no Gateway forwarded-event truth
  for another Session. Its existing in-process Question/Approval modal and
  Session/Writer/Navigation lifecycle are unchanged.

### Selected Session Inspector (exact projection read)

The Session Workspace also answers the ONE selected main Session's full facts
without touching the roster summary or the activity sample:

- **Authority.** `SessionWorkspaceFactsPort.openInspector(sessionId,
  onInvalidated)` opens ONE caller-owned source for the already-authorized main
  Session id; `session-inspector-projection.ts` maps exactly these official
  projection keys to a detached `SessionInspectorData`: `sessionStats`,
  `tokenUsage`, `contextPressure`, `modelSelection`, `agentPreset`, `title`,
  `workingDirectory`, `goal`, `todos`. The whole-log `sessionStats` unit is
  summary-excluded, so it is read only through this exact path; raw buckets,
  totals and averages are derived from the official values, and a missing or
  malformed unit omits its own group (never a fabricated zero). The context
  occupancy is explicitly approximate; `migration-required` is a refusal, not
  a value. The standard bundle declares the official
  `@deepseek-ai/dsh-session-stats` row once under its historical
  `split-host-session-stats` id; the Host-only overlay only withdraws its Direct
  `tuiStartup` admission gate, so a standard Direct or Split Host registers the
  unit exactly once.
- **Direct.** An attached Session reads ONE synchronous official
  `sessionProjections.snapshot(session, keys)` cut. A cold Session uses the
  official `sessionPersistence.stat` and then one caller-owned, non-activating
  `sessionQuery.observeSession(sessionId, {projectionMode:'all'})` lease; a
  `migration-required` stat is refused BEFORE the observation. It never retains,
  resumes, activates, migrates or materializes the Session, and it reads no
  Agent status or list hint into the DTO.
- **Remote.** The selected Session reads ONE passive official
  `session.projections` unary at that id. Only a `sequenced` envelope with an
  exact cut is a value; `migration-required`, `cached`, null and unknown
  envelopes are truthful non-values. The source subscribes only for
  invalidation witness: the selected id's relevant stored projection values, its
  official list-row running bit, the borrowed binding identity and the
  Connection generation. A relevant same-identity change is `changed`; a
  generation/binding identity or authorization change is `source-replaced` and
  revokes the prior cut. It never calls `refreshProjections`, `retainInfo`/
  `retain`, polls, or uses merged list hints as an exact value. A missing
  generation or unlisted target performs no RPC.
- **Presentation and lifecycle.** A renderer reports only the typed main
  Session its committed frame really painted (never a Folder, Show more, Add,
  Reader, inline directory editor or search editor without a painted result).
  The SAME admitted id stays reported while a read-only Inspector identity page
  is really painted (the PiTUI inline/full Inspector or the TSP Details
  reading); entering or leaving that page neither clears nor reopens the source.
  The read owner debounces a settled selection (~150 ms), keeps at most ONE
  physical exact read per open, coalesces same-source changes into ONE trailing
  read, and fences every result by the panel, selection/source epoch and the
  request identity. A roster removal clears the selection at the acceptance
  boundary; retire aborts the source/request without waiting for the network.
  The report carries the presenter's actual Browse/Search provenance. A Search
  target must still be an ACCEPTED search result (main roster membership alone
  is insufficient): its source/timer/flight is retired synchronously at the
  search/roster acceptance boundary, before that accepted state is published.
  A same-id provenance change keeps the source and cut. An Inspector-only
  publication is explicitly marked: a presenter whose visible consumer can show
  the cut stores the detached data and requests a presentation-only repaint, but
  advances no semantic target/action revision, rebinds no source and normalizes
  no selection; a presenter with nothing visibly affected may skip the render.
  A late or stale result is inert. The DTO carries no Session-switch authority:
  the existing Browser Resume owner remains the only switch authority. The
  consuming surfaces are owned by [surface-session.md](./surface-session.md) and
  [tsp/session-browser.md](../tsp/session-browser.md); this seam stays data-only
  and adds no second reader.

Authority: `src/runtime/session-workspace-facts-port.ts`,
`src/runtime/remote/session-workspace-facts-remote.ts`,
`src/runtime/direct/session-workspace-facts-direct.ts`,
`src/runtime/session-inspector-projection.ts`; the port is a required
read-only `Backend` member served once by the Direct assembly and the ONE
Remote M3A assembly.

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

## Host accepted input history search (Host-owned)

The Daemon Host derives a searchable projection of the Profile's accepted user
input from the OFFICIAL Session log. This is a Host-owned read surface; it does
not change the Client-local input-history format, the Direct JSONL recall path
or the current Ctrl+R/↑↓ contract owned by
[input-history.md](./input-history.md).

| Fact | Authority |
| --- | --- |
| Accepted occurrence | the official durable `session/event`: an `agent/inbox/spliced.inserted[]` or `user/message` whose `source.kind === 'user'`; the FIRST event per `(sessionId, messageId)` is the one immutable occurrence. `source.kind` is the sole PRODUCER authority: request correlation (`rpcId`), principal, client time zone and presentation metadata are optional and never participate in admission, deduplication or completeness. The official request correlation of that first admission is carried as optional metadata for exact recall merge only |
| Corpus membership | the official immutable Session header `origin` is the root-only authority: a Session with `origin === 'subagent'` contributes ZERO occurrences (search, readText and recall), even though its delegated initial task is still `source.kind === 'user'`; an ordinary fork contributes only its own post-`inheritedEventCount` input. A verified child target answers the truthful ready-empty state, never another Session's rows |
| Event-time directory | Session header `cwd` folded with each `working-directory/change` in seq order at first acceptance; a missing header directory, or a delivered change whose value is not a usable absolute Host path, is the explicit unknown `null` for that interval (never the previous directory, never the Client cwd); a later valid change restores it |
| Fork inheritance | the official `inheritedEventCount` cut: prefix events fold cwd but never create a child occurrence |
| Official corpus roster | ONE `sessionPersistence.list` snapshot merged with the Host `sessions` live registry; a same-id live/persisted Header must pass the official `assertSessionHeadersCompatible` check, and the live Header is the visible one |
| Cold legacy scope | A full pass may terminally omit a persisted-only Session only when the same official list positively reports `formatStatus === 'migration-required'` and materialized `location.kind === 'jsonl'`, the exact live registry has no object, and no accepted/pending/held/dropped/repair/disposal/rebuild/active-candidate/index-fault obligation exists. The pre-list checkpoint cut and exact claim/witness fence the terminal; an existing live/provisional checkpoint is never deleted by this policy. Omission performs no per-ID `stat`/`open`/`read` and deletes only derived occurrence/checkpoint/proof rows; it is not source deletion, accepted coverage or durable proof. A later official `current` classification or real resume re-enters the normal path. If the cut, exact registry or an obligation changes before the terminal, the stale legacy roster record is not replayed: a sufficient same-round current terminal is preserved, otherwise the existing exact-ID repair owns the current handoff |
| Derived index | ONE disposable SQLite projection under the running Profile (`$PROFILE/.dsh-pi-tui/history-search/v3.sqlite`, private directory/file modes; the dormant v2 file is never opened, migrated or deleted); it is rebuilt from official reads whenever the official log and the projection disagree and is never a persistence authority |
| Durable cold source proof | ONE row per Session in the same `v3.sqlite` records the exact official source path, opaque revision, install/config scope digest and checkpoint digest of one COMPLETE cold replay. Any checkpoint-changing batch, marker rewrite, reset or delete revokes it in the SAME transaction. An aborted transaction may restore the OLD valid proof together with the old checkpoint; a failed or partial NEW replay must never create a new proof |
| Restart recovery | Only a qualified runtime/backend may compare a committed persisted proof across Host restarts; unqualified sources replay through official handles. The upstream revision API itself remains instance-scoped. A qualified hit performs no official `open`/`read`/`stat`/replay, releases no accepted obligation and settles only the per-ID round evidence; a stale or refused hit keeps the ordinary round barrier and hands the official replay to the existing repair owner |
| Source binding | Proof eligibility is bound to the exact pass-scoped official persistence binding (raw service, official Symbol, Loader provider entry/activation, effective root/codec and installed release identity) plus the selected snapshot classification. A replaced service binding, an invalidated runtime authority, a missing required official service on a mounted index, or changed snapshot metadata retires prior-proof reuse and coverage; absence stays `unavailable` (`service-missing`) and a present observation only returns `incomplete`/unproven until a complete full pass replays and re-proves officially |
| Completeness | the index publishes `loading`, `ready`, `incomplete` (`source-uncertain`, `reconciling`, `resource-limit`, `source-read-failed`) or `unavailable` (`index-unavailable`, `service-missing`); a partial or failing pass never answers an authoritative empty list. The search additionally answers a cursor-free `partial` under the first-cold-round contract below. First/full coverage is proven only by a full round that visited and settled every authoritative Session; storage health and one-Session repair do not prove coverage, and a failed/partial pass remains `loading`/`incomplete` until a complete full round. A legal optional metadata absence (no correlation metadata, an unknown event-time directory, non-text content) is not a source fault; a malformed required payload of an explicit user message never becomes a silent omission |
| Live growth | the official `session/event` plane feeds a bounded buffer; reaching the bound marks the affected Sessions dirty and re-reads the official source instead of dropping accepted rows |
| Destructive round | before the first known destructive publication of a full round (deletion, rebuild or marker rewrite), the round establishes an `incomplete` barrier and holds it through every required deletion, accepted-payload/repair settlement and per-ID terminal commit. Read-only discovery preserves the prior `ready` epoch; the round-local deletion cut and its cut-bound witness fence derived deletion |
| Full/point ownership | one full-inventory round and independent exact-ID repairs share ONE per-ID single-flight claim: a repair requested while the full round owns that id is coalesced and handed off after the full candidate settles. Every ordinary drain entry is admitted by that same claim at the actual serial-writer boundary; a full claim may perform only its own explicit short drain. Unsettled authoritative repair, held and dropped obligations keep new accepted input protected and coalesce the necessary successor. Ordinary input that arrives after the authoritative terminal remains drainable, waits for claim release and is awakened by the existing bounded drain; claim lifetime alone never makes it held. The terminal `commitWitness` is the second, non-substitutable fence |
| Verification/read boundary | the single Host maintenance owner runs the 30 s full-corpus roster check and per-Session official repairs OUTSIDE the serial index writer; Owner `search`/`readText`/`readSessionRecall` wait only for accepted short index commits, never for a background `list`/`open`/`stat`/`observeSession` Promise. The writer completeness check uses an index-owned SQL existence probe, never a full checkpoint materialization |
| Remote surface | the private `piTuiHistorySearch` namespace with exactly three Owner-only unary methods: `search` (three scopes, keyset cursor, bounded preview + immutable content hash), `readText` (exact original text chunks by content hash) and `readSessionRecall` (ONE exact Session, at most 100 newest-first full-text rows under a fixed 64 KiB serialized UTF-8 budget, trim + blank/`!` normalization, `loading`/`incomplete`/`unavailable` otherwise) |
| Direct | unchanged: the Direct Host never mounts this index and keeps its existing Client-local input history |

`ready` covers the officially visible corpus within the supported search scope,
including terminal cold-legacy omissions; it does not claim that every historical
format was read. The fixed partial roster total still includes enumerated omitted
IDs, but their unreadable terminals never increase the verified-readable numerator.
An omitted ID has no checkpoint, so exact Session recall remains `loading` rather
than returning a fabricated ready-empty result. Normal official resume/write
migration publishes a real seeded live Session and the existing point repair
re-admits its input without a new prompt or periodic pass.

A HEALTHY first cold round may answer `partial` while official coverage is
still unproven. `partial` carries up to the requested limit of rows plus
`progress { settled, total }`: `total` is the fixed expected roster sampled by
that one round, and `settled` is the number of expected IDs that currently
satisfy the SAME read permit (never a replay/batch/query-hit count). The permit
is derived synchronously from that round, not from a second registry: expected
membership, a terminal that is a complete authoritative replay or a qualified
durable proof hit, the exact captured live object (or absence), no pending/
held/dropped/reconcile/active-candidate/repair/disposal/rebuild obligation for
the ID, and a committed clean `history_sessions` row (`dirty = 0`,
`uncertain_sources = 0`). Disposal prefix proofs, no-read seeds and
coverage-only settlements never grant it. A partial page has no cursor and
never claims `ready`; `settled === total` stays partial until the round's full
terminal proof, and a cursor/More request against a cold partial answer is
`stale`. `readText` uses the same permit and otherwise answers `loading`
instead of probing an unproven old row. Any real fault (malformed/conflicting
live input, source read failure, writer failure, buffer overflow, or a failed
disposal proof) stops partial publication and keeps the existing incomplete
reason; ordinary warmup lag, unvisited IDs and normal repairs only exclude
their own IDs. The complete first round still publishes the original `ready`
result/cursor/empty behaviour and complete-coverage proof.

The first cold round traverses the official roster in ONE bounded recent-first
order: live Sessions first, then the newer of the official header creation time
and the cached accepted-time hint (DESC), with an exact code-unit Session-id
tie-break. The cached hint only schedules work; it never grants search or body
eligibility. Periodic maintenance rounds keep roster order and add no
per-ID official `stat`/`list`.

The Host actively prewarms the complete index without blocking Host readiness;
a first search/read answers `loading` only until an eligible verified partial
subset exists, then the cursor-free `partial` page. `ready` is published only
after every official Session, every buffered live event and the error verdict
have settled; a partial or failed first full round answers `incomplete` rather
than `ready`. Destructive maintenance barriers are gated by proven/full
coverage, not by hiding already eligible first-cold partial rows. Coverage is
a round-local proof: a successful point repair of one Session never proves an
unvisited or unsettled ID; a later complete full round may establish it. The
30 s roster check and the per-Session official repairs are single-flight
maintenance work: they may make the index `incomplete` while a destructive
round is committed, but they never hold the Owner read barrier. An already
verified epoch stays readable during a read-only background check; a keyset
cursor becomes stale only when committed content actually changes. An
unresolved accepted-coverage obligation is fail-closed: it is settled only by a
current authoritative replay, never by a timeout, repeated roster absence or an
equal checkpoint alone. A full round finishes only after its official-ID
traversal has completed and every required deletion, accepted payload, repair
and terminal settlement has settled; a point completion observed while the
traversal is still pending cannot release the global barrier. While coverage is
unproven, each authoritative ID requires a current-incarnation authoritative
replay: a clean prior-process checkpoint plus a matching live identity is not a
proof of this Host's observed source. The ONE scoped exception is a qualified
cold durable proof: it is the current-incarnation evidence of a complete cold
replay performed by the same qualified official backend, and it is only
compared while the exact source binding, snapshot metadata, projected
checkpoint and runtime authority all still match. A proof never makes a
different source generation, an unqualified backend, a live record, a dirty or
uncertain checkpoint, or an outstanding accepted/repair obligation eligible. A completed final ordinary pending drain
is also a terminal owner and can settle the traversed round without waiting for
the periodic timer. While coverage is unproven, the forced current-incarnation
replay is ordered AFTER the disposed-live dirty/short-durable-source guard;
accepted provisional rows are never reset before that official proof. A
required initial authoritative reset invalidated by ordinary pending is handed
to the point-repair owner AFTER the round's own ordinary drain settles, so the
mandatory replay observes the post-drain accepted checkpoint; a normal
contiguous drain against an older clean checkpoint is not full coverage. A live
authoritative replay first takes an ordinary pending remainder over as its own
held obligation, so an unchanged backlog cannot refuse every reset; only after
that ownership transfer may a stale candidate re-arm the same coalesced repair,
and a mandatory source proof never falls back to the periodic timer. On a fixed
legal source, that handoff converges through one current authoritative replay
without a competing ordinary write or repeated observation of the same cut.
Only a real accepted-source change, exact source-identity replacement or still
unsettled independent obligation drives a follow-up; an unchanged no-progress
stale remains incomplete rather than becoming an immediate retry loop.

The occurrence projection and its nullable event-time directory are identified by
the source-proof contract: a persisted proof recorded under a different
projection/proof contract is never reused. The Host replays each affected
Session from the official log through the existing replay path — replacing its
derived rows and proof — instead of upgrading stored rows in place. A legal
optional metadata absence never blocks that rebuild; a real source failure still
stays incomplete. Downgrade compatibility is not promised: an older Host keeps
its own admission and proof semantics.

The search is a literal Unicode lower-case substring match over the first
accepted text. `all` addresses every accessible Session of the authenticated
Profile, `session` one exact id, and `directory` the event-time effective
directory (path-normalized; never a realpath or a Client fallback). The preview
is bounded and explicitly not recoverable full text; full text is read only
through `readText`, keyed by the stored content hash. The opaque keyset cursor is
v2: one Host service incarnation, one index revision, a digest of the exact
request context (scope, literal query, normalized scope id) and one canonical
signed 64-bit SQLite row anchor. It carries no query, path, official id or whole
row, and stays below the fixed 2048-byte wire bound; the anchor is re-read
against the same scope/query match set without selecting content. A different
incarnation/revision/hash, or a deleted, rebuilt or re-scoped anchor, is `stale`
instead of silently re-ranking the caller's page. The Host refuses a non-Owner,
an ended peer or an aborted invocation before any official read or index query.

Restore invalidation is an explicit operator procedure, not a runtime
feature. Before restoring a backup, rolling back/cloning a filesystem snapshot
or replacing the offline source, stop the owning Host with the existing daemon
control (`dsh --profile <profile> daemon stop`), confirm the Host exited and the
kernel seat is free, and prevent the supervisor or a Client from restarting it;
stop any other writer of the same source. After the restore, resolve the ACTUAL
canonical Profile directory (never `DSH_HOME` or a Session root), then move the
existing `.dsh-pi-tui/history-search/v3.sqlite`, `v3.sqlite-wal` and
`v3.sqlite-shm` as ONE set into a new owner-only backup directory inside that
private `history-search` directory (`umask 077`, a private `mktemp -d`,
skip absent files, never a wildcard delete). A symlink, foreign owner or
unexpected file stops the procedure for manual inspection. Leave `v1.sqlite`,
the dormant `v2.sqlite` set, other artifacts and the original Sessions
untouched, restart the Host, and let the v3 index rebuild from the official
source; history search reports loading or incomplete until that rebuild proves
full coverage. Do not copy the backed-up `v3` set back over the restored
source. Automatic rollback detection is not promised.

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
[surface-plugins.md](./surface-plugins.md#plugin-manager-and-plugin-detail);
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

### Provider-native authorization over the Split wire

The internal Split Host serves provider-native sign-in through this package's
OWN private `piTuiAuthorization` Typert namespace (`list`, `run`, `respond`,
`cancel`). The installed official `@deepseek-ai/dsh-authorization` service and
the official credential store remain the only authorization authority: the
private bridge never writes a grant/token, never invents a flow and never
decides that an attempt succeeded. A Host without the official service keeps
running and answers `list` as a definite `unavailable` (never an empty roster)
and `run` as `failed`/`NO_FLOW`.

`run` is ONE ordered attempt stream owned by the exact `RemoteInvocation.peer`
that opened it: `started` first (a stream admission, never an authorization
acknowledgement), then the official notices/prompts/prompt withdrawals in Host
order, then exactly one terminal frame from the official `begin()` settlement.
`authorized` is published only when the official seam observed a
credential-record commit inside the attempt; a human decline is `cancelled`;
official refusals and failures are `failed` with their safe code (`NO_FLOW`,
`UNKNOWN_METHOD`, `ALREADY_IN_FLIGHT`, `NOT_COMMITTED`, ...). `respond` and
`cancel` reject an attempt that does not belong to the calling peer. A prompt's
own signal withdraws that prompt only and leaves the whole attempt alive.
`cancel` requests withdrawal and returns an ACK only: the terminal still comes
from the official settlement, which may be `authorized` when the commit was
already accepted.

A Remote client treats a lost stream, a lost OR refused answer acknowledgement,
a Connection generation replacement, a frame naming another attempt, or a
caller teardown that closes the stream as the FOURTH outcome `unconfirmed`: the
Host may still commit, the UI never claims failed/cancelled/authorized and never
retries automatically. A refused answer closes the attempt's local flow (the
answer is never re-sent) instead of leaving it waiting for an event the Host may
not deliver. `listTargets` is a
generation-fenced detached snapshot; `targetsState()` distinguishes `ready`,
`unavailable` (the Host has no authorization service) and `stale` (no
authoritative read for this Connection generation), and a stale roster may not
route a `/login` attempt. The typed answer is the only secret-bearing direction
and rides the authenticated unary `respond` once; frames, events, logs and
diagnostics never carry a credential record or token.

### Stored credential records over the Split wire

The internal Split Host serves stored credential RECORDS through this package's
OWN private `piTuiCredentialRecords` Typert namespace (`list`, `delete`). The
installed official `ctx.credentials` store remains the ONLY authority for
record storage, presence, deletion and its file lock/atomic write and
`credentials/record-updated` event: the bridge is metadata-only, never caches a
record, never writes one and never reimplements the store. The generated
`credentials` namespace stays REFERENCE-only (`describe|set|unset`); the two
key spaces are disjoint, so a record delete is never an `unset(ref)`.

`list` returns every stored record's detached `{key, kind}` (`kind` is exactly
`api-key` or `grant`), including records whose owning plugin/flow is not
registered (an orphan) and the DeepSeek Account grant — Account filtering is an
application-entry ownership rule, not a Host `deleteRecord` restriction. Any
extra field, secret value, env mapping or Host record object fails the whole
result instead of being forwarded. `delete(key)` re-validates the official
`<scope>/<id>` grammar and calls `deleteRecord(exactKey)` exactly once; an
absent key is the official no-op and any legal scope (a foreign orphan
included) is a valid target. Both methods are Owner-only (peer principal AND
invocation signals), checked before the store is read or written; a Host
without the credentials plugin still becomes Ready and answers a definite
service-unavailable failure, never an empty list.

A Client read captures the Connection generation and re-checks it before
committing the metadata, so an old empty or failed answer never overwrites the
current Host. A dispatched delete is bracketed by the accepted-write lifetime
(the Client reload gate observes it) and never replayed. Only a definite
pre-invocation refusal (`gateway/bad-request`) is a normal failure; a lost ACK,
a transport throw, `gateway/cancelled`, `gateway/internal` or an invalid result
leaves the commit unproven and surfaces as the stable
`RECORD_DELETE_UNCONFIRMED` outcome: the UI never claims success or failure,
keeps the exact key and offers a read-only re-read of the current Host. Only the
authoritative absence (a fresh read after the ACK) may report a local clear, and
that copy never claims an issuer revoke or a model switch. The official
`credentials/record-updated` event remains the single change notice; there is
no second watch, poll or optimistic Client mirror.

### Exact-Session approval and sandbox policy over the Split wire

The Split Host serves the exact live Session's INDEPENDENT approval-policy and
sandbox-mode facts through this package's OWN private `piTuiSessionPolicy`
Typert namespace (`read`, `setApproval`). The installed official `ctx.approval`
and `ctx.sandboxPolicy` services remain the ONLY policy authorities: the bridge
never writes a Session event itself, never caches a policy value, never touches
the permission-preset table, never applies `/permission`, and never fabricates
a Client-side `unconfirmed`. Approval and sandbox stay SEPARATE knobs: an
effective sandbox mode is a POLICY fact, never proof that a sandbox provider
actually enforces a call, and no preset name is ever decoded back into either
knob.

`read(exactSessionId)` returns a detached DTO whose two sides each carry either
the proven `effective` value plus the Session `override` when the Host states
one, or their own `service-not-installed` unavailability. A missing override is
ABSENT (not a guessed `ask`/`read-only`), a missing session is a definite
`session-not-live`, and a throwing official read or an unknown enum fails the
whole read — never a fabricated "no override". `setApproval(exactSessionId,
'ask'|'never')` validates the parameter, resolves the EXACT live Agent and
requires `agent.session === sessions.get(sessionId)` immediately before ONE
official `approval.setPolicy(liveAgent, policy)` call; it never touches the
sandbox, the permission presets or the transcript. A value already equal to the
effective policy is the official no-op and still `applied`, with no
`approval/policy` event appended.

Both methods are Owner-only (peer principal AND invocation signals), checked
before any service is read or the log is touched. A Host without the approval
or sandbox plugin still becomes Ready; the missing side is that side's
unavailable fact and a missing approval service makes the write a definite
refusal. The write wire result is only `applied | refused`; `unconfirmed` is the
CLIENT classification of a dispatched write whose outcome it cannot prove (a
lost ACK, transport throw, `gateway/internal`/`cancelled`/`result-invalid`).
A proven pre-invocation refusal (`gateway/bad-request`) or a missing current
Connection generation is a definite "not sent"; everything unproven is
`unconfirmed`, is never retried and is never rendered as "not applied". A legitimate `applied`
ACK stays applied even if the generation is replaced afterwards — only the old
surface's presentation ownership ends. Reads capture the generation OBJECT
identity and re-fence before committing; a Remote write is bracketed by the
SAME accepted-write lifetime counter as the configuration port, so the Client
reload gate observes it through ONE fact.

The application keeps ONE Client-local policy observation owner (checking /
ready / unavailable / failed), keyed by Connection generation, exact session id
and observed subject epoch, with latest-read-serial wins; the Settings approval
row and the status/footer sandbox+approval facts consume the SAME snapshots.
Its listeners distinguish a committed read from a REVOCATION (subject or
Connection generation change): the open Settings page re-reads its row facts on
both (so the old Host's policy leaves the page immediately and returns to
`Checking…` until the new generation answers), while the status owner repaints
only on commits — a revocation inside an owner-commit callback must never
trigger a full status read of a published-but-uninitialized owner. The Settings
`Verified` state still requires a fresh authoritative readback of that exact
Session's EFFECTIVE policy; the port's `applied` alone is never proof.

The account DTOs are detached (`AccountView`, `AccountProfile`, wallet decimal
strings, safe attempt ids/phases/error codes). An `AccountView` is last-known
unless paired with a local opaque `AccountObservationLease` issued by its adapter;
Direct validates the installed Host Account service identity and observation epoch,
while Remote validates the lease against the actual Connection generation and
Account watch epoch. The lease never crosses the generated Remote payload or
persisted state. Carrier failure, Connection generation loss/replacement, or
watch invalidation immediately revokes the affected observation; invalidation is
not a `signed-out` fact. A token, grant payload, PKCE value, `PlatformSession` or
generic Host service object never crosses the port. `AccountClientMetadata`
(`version`, `locale`, `timezoneOffsetSeconds`) is sampled per Platform request;
the offset is never cached across a DST change. `version` is the installed DSH
runtime version, which the official Host Account service maps to the Platform
`x-client-version` header; it is never the TUI bundle version, and an
unprovable version fails closed before any metadata-bearing Account request.

The base profile mounts the official `@deepseek-ai/dsh-host-webserver` row with
stable id `webserver`, `host: 127.0.0.1`, and `port: 0`; the Direct runner injects
both `deepseekAccount` and `webServer`. The official `DeepSeekAccount` service
registers `/oauth/callback` on that Host listener while an attempt waits for the
browser.
Direct obtains the origin from `webServer.getOrigin()` and calls
`startSignIn(client, origin, 'web')`; a Client never supplies a callback URL,
opens a second HTTP server, or parses the browser callback. `--help` mounts no
listener. A bind failure fails the Host row instead of falling back to a public
interface.

The rc.2 base bundle mounts the concrete
`@deepseek-ai/dsh-deepseek-account` service as the ONE Host Account owner: the
`deepseekAccount` Cordis service is the Typert `account` namespace owner. The
internal Split Host reuses that base row and does NOT insert a second
account-controller row. This Host owner remains active whether the optional
Browser Web roster is enabled or disabled. Host readiness requires the
`deepseekAccount/account` Typert binding and exactly one ACTIVE Loader row for
that exact package identity; a Web UI row is not that service. The Client mounts
`@deepseek-ai/dsh-deepseek-account/remote` on the same authenticated `remote`
object and Connection as its other generated contributions. It does not mount
another Host owner, create an Account store, copy the generated namespace, or
introduce a feature-specific carrier.

The semantic Account port carries only detached `AccountView`, profile and
wallet DTOs, safe attempt ids/phases/error codes, and per-operation
`AccountClientMetadata`. Token, grant payload, PKCE material, Platform session,
Cookie, and Host service objects never cross it. Account profile and balance are
independent reads; `null`, a returned `failed` outcome, and a Remote failure
remain distinct.

For a Split Client, the browser callback origin comes only from the `origin` of
the Host identity authenticated by the `/connect` Cookie and Host identity echo.
The Client composition passes that provenance unchanged to the Remote Account
adapter. Immediately before `startSignIn`, the adapter requires the current
Connection generation and the exact canonical `http://127.0.0.1:<port>` shape;
it then calls the official generated method with that origin and the fixed
`loginSource='web'`. Missing provenance or a disconnected generation fails
closed. Registry hints, Client environment, arbitrary user input, `localhost`,
other loopback spellings, and another legal listener are not substitutes for
that authenticated identity. The official service forwards its argument and
does not independently compare it to its listener; this contract establishes
the trusted source used by this Client adapter, not a new upstream Host policy.

`watch(signal)` yields the rc.2 `AccountUpdate` frames
(`{type:'snapshot'|'credentials-changed', state:AccountView}`): both frame types
are current Host views and `credentials-changed` is a fresh snapshot, never a
sign-out. The adapter validates the envelope only at this external stream
boundary and forwards `state` as the detached view; ordinary Account RPCs
(`getState`/`startSignIn`/...) keep their bare `AccountView` shape. An
invalidation revokes its affected observations and is distinct from signed-out.
Ending the signal, disposing the generated stream, closing a page, or retiring a
Client surface stops observation only; it never cancels the Host browser attempt.
Cancellation addresses the exact `SignInAttemptId`. The Watch subscription is the
single writer of the page's AccountView; a mutation response is never treated as a
second AccountView snapshot. Once a mutation settles, the prior page snapshot is
last-known and cannot authorize another mutation until the next complete Watch
snapshot or explicit Refresh. An unknown mutation outcome is reported as
unconfirmed and is never replayed automatically; explicit Refresh releases the
current Watch and reopens the official watch for a complete initial snapshot. A
result from a replaced Connection generation cannot become current.

`hasRunningAccountTasks()` is an asynchronous Host fact in Direct and Remote.
The official controller evaluates the current `agents.list()` with the official
running-account-task predicate; the TUI does not substitute its own busy state
or a cached Boolean. A failed or unavailable Remote read rejects instead of
claiming `false`. Sign-out confirmation represents `checking`, `known`, and
`unavailable` explicitly: pending or unknown disables the destructive action,
and a failed check has an explicit retry. A failed or unconfirmed sign-out
acknowledgement closes the confirmation and is never replayed automatically;
explicit Refresh reopens the official Watch. The official
`deepseek-account/signed-out` listener remains the sole owner of cancelling
matching account tasks.

`signOut` removes the local grant before background Platform revocation; a
remote failure never restores the grant, and independent API-key references stay
stored. The local grant is never read from the credential document by the TUI.

Authority: `src/runtime/config-port.ts` (`AccountConfig`),
`src/runtime/direct/config-direct.ts` (`DirectAccountConfig`),
`src/runtime/remote/config-remote.ts` (`RemoteAccountConfig`),
`src/app/remote-process/local-host-entry.ts` and
`src/app/remote-process/host-bootstrap.ts` (Split Host composition/readiness),
`src/app/remote/client-runtime.ts` (generated Client contribution),
`src/app/command/account-workflow.ts`, and
`src/tui/panels/account-workspace-page.ts`. Surface navigation is owned by
[surface-settings.md](./surface-settings.md#settings-workspace).

Must-not: expose a token/grant/PKCE value; start Account sign-in outside the
official Host Account authority; clear the Account grant through
`deleteRecord`; infer a credential or callback origin from a route/profile;
mount a second Host listener or Account Controller; let Web enablement own the
Host Account Controller lifetime; interpret an unavailable running-task read as
`false`; or widen the shipped callback listener beyond loopback.

## Plugin Manager

`@deepseek-ai/dsh-plugin-manager` is the sole authority for package/profile
truth, enablement, installed state, install/remove, compatibility, version
exemptions and version updates. The semantic port projects **detached**
`PluginBundleFact` (`official`, `availability`, `installTarget`, `version`,
`listedByDefault`, `enabled`, `installed`, `optional`, `source`, `removable`,
`update` (`'registry' | 'git'`, absent when the Host offers neither),
`readOnlyReason`, `error`, `rows`, `overrides`), `PluginRowFact`,
`PluginRegistriesFact`, `PluginExemptionFact` and `PluginChangeFact`
(`application`, `restartReason`, `version`, `pendingBuilds`, `approvedBuilds`,
`packageResult`, `registries`, `failedAt`). It also carries the update facts:
`PluginVersionListFact` (the Host-listed newer versions with their registry,
attempts, per-version tags/publication/prerelease/deprecation/bundle/
compatibility and omitted count, or the Host refusal), `PluginUpdateProgressFact`
(`requestId`, `checking|removing|installing|restoring`) and
`PluginUpdateResultFact` (`from`, `to`, the last `step`, the target `result`
and the SEPARATE optional `restore`). The port owns no installed-package
database, no enabled truth, no compatibility evaluation and no local semver
comparison.

Direct and Remote use the SAME detach/mapping functions:

```text
Host fact
  -> shared detach/mapping (Direct and Remote use the same functions)
  -> detached snapshot
  -> surface-behavior controller/UI
```

`listVersions(name, {})` and `updateBundle(name, exactVersion, { registry,
requestId })` are the official update read/write for a bundle whose Host
`BundleInfo.update` is `'registry'`. The Host alone declares the update source
(`registry` or `git`), which registry answered, which exact version is offered,
whether it declares a bundle and whether it accepts the running DSH version; it
re-checks the exact target before changing the profile and may run its own
remove/install/restore sequence. A `git`-managed bundle states its Host source
but never offers the registry action: the TUI never guesses a newer version,
accepts an arbitrary registry, or reproduces the update with removeBundle +
installBundle.
`plugin-manager/update-state` is the official stage hint only, never proof of
success; `cancelInstall(requestId)` stops ONLY the target installation step and
never the whole update or the Host's restore. `updateBundle` is called once per
confirmed attempt and never retried.

Every Remote read/mutation/wait/cancel/inspect/list-versions/update result is
fenced by the pre-dispatch Connection generation and raises
`PluginManagerStaleResultError` when superseded; the surface contract interprets
that as indeterminate plus an authoritative reread, never as a refusal or
success. The UI never guesses a
capability from a package name, `@deepseek-ai/` scope, `experimental` substring,
enablement, `fiber` or availability. Official Experimental identity comes from
the release's read-only `EXPERIMENTAL_BUNDLES` set plus the TUI's frozen legacy
Bxx presentation exceptions; that identity is still gated on the Host
`official:true` fact, so a same-name non-official package never inherits it.

The controller, inventory read epoch, install state machine, request-id
reconciliation, retry/unknown handling, workspace lease and Detail copy/upgrade
guidance are owned by
[surface-plugins.md](./surface-plugins.md#plugin-manager-and-plugin-detail).

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

## Session artifact reads: archive vs official Markdown

Two independent artifact capabilities share the ONE Client save workflow
(`ArtifactSaveOwner`); only the Markdown capability also has a pure read-only
surface consumer. Neither is a Session writer or Session retain:

- `SessionArchivePort` (`/export`) opens the official full Session-tree ZIP
  stream (root log, descendants, attachments). Its shape and ownership are
  unchanged.
- `SessionMarkdownPort` (`/transcript` and the PiTUI Sessions `Space` Reader) is
  the read-only official complete committed Session transcript selected by
  Session id. It never streams an archive, never accepts a formatter choice,
  descendants, output path or Client cwd, and never writes output.

`SessionMarkdownPort.read(sessionId, signal)` answers `ready {markdown}` /
`none` / `unavailable`, or rejects a real failure. The adapter mapping is:

- **Direct** (Host-owned, in-process): the official
  `sessionQuery.readSession` complete committed live-preferred logical snapshot
  (including any fork-inherited prefix) is rendered by the official
  `formatSessionMarkdown`; the optional `sessionPersistence.stat` artifact path
  is passed through as the formatter's `Session file:` source. An absent
  `sessionQuery` is `unavailable`; the official stable
  `SESSION_QUERY_SESSION_NOT_FOUND` code is `none`; every other read/stat/abort
  failure rejects. `readSession` itself has no cancellation parameter, so abort
  is observed before and after the awaited read (the same limitation as the
  official Host route).
- **Remote** (Split Client): the official authenticated
  `GET /api/session.markdown?sessionId=...` over the SAME composition-owned
  fetch every Remote adapter consumes — never a caller-built URL, cookie,
  private Remote or second Host plugin. A `200` must be the official
  `text/markdown` body and is returned byte-exactly (no trim, recode, sanitize
  or prefix); the official `session not found` 404 body is `none`; an unknown
  404 (unregistered route) and the official missing-`session-query` 500 body are
  `unavailable`; auth/permission, other 5xx, malformed/HTML/empty success and
  transport failures reject. The Client never reconstructs the formatter and
  never reads a Remote `Session.snapshot*`.

The SAME `SessionMarkdownPort` has a second, pure read-only consumer: the PiTUI
Sessions `Space` Reader. It reads the exact full Session id through the same
Direct/Remote adapter and displays the returned official Markdown in-place. It
has no save path, Agent writer, Session `open`/`retain`, descendant read or
`FileSaveOwner`; its local display projection (`sanitizeDisplayText`) never
changes the Port's raw Markdown or the `/transcript` save bytes. It adds no Host
route, formatter, cache, polling or second transcript source. Its read is
cancelled by the Reader, Sessions lease and runner signals, and a late result is
inert after close, lease release or Session removal.

The captured command-origin Session id is the target for `/transcript`: a later
Session switch never redirects the save. The Client chooses the destination directory, applies
collision/overwrite policy and commits atomically; a Host artifact path may
appear verbatim INSIDE the Markdown (`Session file:`) but is never the Client
save target. Business availability is decided by the port's answer at save
time, never by a pre-read backend capability flag; the mounted `TuiApp` save
dialog is the separate Client-local capability a renderer without one must
refuse. The official Markdown is the Host formatter's text contract, not a
byte-for-byte reproduction of the TUI Transcript cards (Workflow/Context/visual
card semantics stay display-only).

Proof: `test/runtime/direct/session-markdown-direct.test.ts`,
`test/runtime/remote/remote-session-markdown.test.ts`,
`test/app/remote-semantics-smoke.test.ts`, `test/app/export-command.test.ts`,
`test/extension/runner-remote-command-plane.test.ts`,
`test/tui/session-workspace-panel.test.ts` and
`test/app/session-workspace-lifecycle.test.ts`.

## Host Schedule management

`SchedulePort` is the ONE semantic seam for the Host-wide task manager behind
`/schedule`. The task store, the single timer, the session FIFO, the CAS
revision and the delivery receipts are owned by the official Host
`@deepseek-ai/dsh-schedule` domain; the port carries official records and
official refusal codes unchanged, so neither adapter owns a task copy, a cron
evaluator or a notification queue. Method surface: `catalog`, `list`, `view`,
`history`, `deliveryLimits`, `create`, `edit`, `run`, `deleteInactive` and
`onChanged`; `signal` is a Client-local currentness fence, not a wire field.

Locality and activation are split in one place each:

- **Direct** mounts, once per Host process, the official `schedule` row plus the
  three official activation prerequisites its Session-creating targets need —
  `connection`, `fileUploads` and `sessionController` — gated on the profile's
  TUI startup admission. `DirectSchedulePort` resolves the in-process service
  per operation; a Host without it answers the ONE truthful
  `ScheduleUnavailableError`, never an empty catalog.
- **Split Host-only** keeps the SAME `schedule` row and drops only its direct
  admission gate; the three Direct-only prerequisites are disabled there because
  the overlay already mounts its own `split-host-connection`,
  `split-host-file-upload` and `split-host-session-controller` exactly once.
  Never a second Schedule row: the Host timer must not depend on a Client or the
  optional Web frontend.
- **Split Client** mounts the official `@deepseek-ai/dsh-schedule/remote`
  contribution in the ONE Client Domain roster and reads the generated `schedule`
  namespace over the authenticated Gateway. `schedule/changed` is part of the
  official forwarded-event allowlist, so an invalidation never needs a private
  wire message.

Currentness: a read whose reply belongs to a superseded Connection generation
is superseded and never painted as the current Host state. A mutation that was
dispatched but whose settlement cannot be proven — a transport failure, a
cancellation that raced the Host transaction, or a reply landing after the
generation was replaced — is an UNKNOWN outcome: it is never replayed and never
reported as a rollback; the workspace re-reads the authoritative catalog once
the connection is current again. The delivery receipt proves a durable Session
inbox acknowledgement, never a completed model turn.

Proof: `test/runtime/schedule-port.test.ts`,
`test/runtime/direct/schedule-direct.test.ts`,
`test/runtime/remote/schedule-remote.test.ts`,
`test/runtime/parity/schedule-management-parity.test.ts`,
`test/app/schedule-workspace-controller.test.ts`,
`test/app/schedule-host-profile.test.ts`.

## Agent Team mode

`TeamModePort` is the ONE semantic seam for the Root Session's Agent Team
selection. The saved selection and the "a model request has already run" fact
are owned by the official Host projections — `agentTeam` and
`modelSelection.lastUsed` — and the only write is the official Root-only
`agentTeams.setEnabled`, which appends the single durable `team/mode` record and
flushes the Session itself. The port never mirrors an enabled value, never
appends a Session event, and never grants a child Session write authority.

Method surface: `read(sessionId)` (a synchronous `ready` / `stale` /
`unavailable` snapshot), `subscribe(sessionId, listener)` (a same-Session
projection change feed) and `setEnabled(sessionId, enabled, signal)` (the
semantic write settlement `committed` / `rejected` / `cancelled` /
`indeterminate`). Calls pass the exact Session id the caller captured; the
adapter re-resolves that Session's live Root on every call.

- **Direct** reads `sessionProjections.snapshot(session, ['agentTeam',
  'modelSelection'])`, proves `subagents.rootOf(agent) === agent`, observes
  `sessionProjections.onChanged` for the two keys, and forwards
  `ctx.agentTeams.setEnabled`. A rejected Root check is a proven refusal; a
  flush/observation failure after the Root admission is indeterminate.
- **Split Client** reads the exact `sessions.binding(sessionId)` faces and
  re-arms them on a Connection generation replacement, proving Root identity
  from the Session snapshot (falling back to the Session-list subagent origin
  when a binding cannot expose it), and writes through the official generated
  `@deepseek-ai/dsh-agent-team/remote` `agentTeams/setEnabled` namespace. A
  dispatched write whose settlement cannot be proven is indeterminate and is
  never replayed.

### Agent Team board (read-only)

`TeamBoardReadPort` is the ONE semantic seam for the Root Session's READ-ONLY
shared Team board — a SEPARATE contract from `TeamModePort`. It reads the
official `agentTeam` projection's `{enabled, tasks, failure}` and reaches no
Team write (no create/update/claim/complete). A read is `ready` / `stale` /
`unavailable` (`not-root` | `session-missing` | `authority-missing`); an
`enabled:false` board is still a readable `ready` with its retained tasks, and
a `failure` is returned ALONGSIDE the last valid tasks. It does not reuse the
`TeamModePort` availability rule (which also requires the write namespace and
`modelSelection`), so a legal read-only board stays readable. Direct proves
`subagents.rootOf(agent) === agent` and reads
`sessionProjections.snapshot(session, ['agentTeam'])`; Split Client reads the
exact `sessions.binding(sessionId)` `faceOf('agentTeam')`, re-armed on the
Connection generation / binding, and needs no `agentTeams` write namespace.
Team members are the Root (`lead`) plus the already-read official Subagent
catalog rows (`path ?? childId`) — never a second catalog crawl.

Proof: `test/runtime/direct/team-mode-direct.test.ts`,
`test/runtime/remote/team-mode-remote.test.ts`,
`test/runtime/direct/team-board-read-direct.test.ts`,
`test/runtime/remote/team-board-read-remote.test.ts`.

## Workflow terminal-state authority

A Workflow run/member status is settled ONLY by its own terminal event:
`tool-workflow/run-end` for the run and `tool-workflow/agent-end` for a member,
matching `runId` + `seq`. A run without `run-end` is an OPEN durable record and
reads `running`. Step/Turn closure, main-Agent idle and the next `turn/start`
carry no Workflow authority and never settle or "interrupt" a run.

ONE `WorkflowProjection` serves the visual Transcript fold, so the card and
the Workflow status vocabulary cannot drift. It is NOT the `/transcript`
Markdown authority: that artifact is the official Host-authored Session
transcript, and the Workflow/Context card record stays display-only. The
renderer only derives counts/phase groups/aggregate status/disclosure mode and
never writes durable status back to the projection.

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
- The Linux split-process lane (`smoke:split-process`) and the macOS
  public-selector lane (`smoke:macos-split`, driven from an installed npm
  tarball inside a private macOS tmux server) are distribution-boundary proofs
  outside L1–L6: they are the tiers that observe a real Host process plus real
  Client OS processes. What it
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
