# Profile-scoped Host daemon and management contract

This document owns the profile-scoped Host process-manager and administrative
daemon-command lifecycle. The canonical Host/Client locality, semantic ports,
backend selection and Client detach contract remain in
[host-client.md](./host-client.md). Do not duplicate that authority here.

## Profile-scoped Host process manager

The basic daemon is an independent Host process. A public `daemon` cold start
that finds no reusable authenticated Host brings one up without requiring any
system service manager; the profile-scoped manager facts decide only OS
supervision, never the Host business services, the authenticated carrier, the
Session/Writer authority or readiness. Linux supports the verified systemd user
unit; macOS supports an explicit user-level launchd LaunchAgent when one is
installed for this Profile. Both managers are optional: with no installed
service definition a cold start keeps the basic detached Host. Windows supports
only the independent process: `status`, `start`, `stop`, `restart` and `logs`
are available, there is no Windows service manager, and `install`/`uninstall`
are explicitly `UNSUPPORTED_PLATFORM` before any scope or manager work. The
Windows Host is a normal independent Host: a supported interactive daemon
Client attaches to it exactly like on Linux/macOS, client exit never stops it,
and only an explicit authenticated stop or real process failure ends it. ACP
uses the same profile-scoped local endpoint as Linux/macOS, with a local Named
Pipe on Windows (see [host-acp.md](./host-acp.md)); the runtime controls, stdio
bridge and next-launch preference keep the same contract. The supported domain is native
Windows 11 x64, an ordinary (non-elevated) user and an ordinary local fixed-NTFS
profile path.

- **Manager vs. authentication authority.** The manager answers "how is the Host
  OS process supervised", never "is a Host ready". When a live Host is already
  reusable it is authenticated and reused before any manager work; the manager
  never replaces, adopts, kills or migrates a live Host (including a compatible
  different build or one without a product service definition). Readiness remains the official
  `/connect` Cookie + authenticated identity echo + the platform's exact kernel
  identity handshake (Linux schema 1 `/proc` starttime, macOS schema 2 Darwin
  identity, Windows schema 3 token SID + creation FILETIME).
  A systemd `ActiveState=active` / `systemctl start` returning 0, or a launchd
  job whose `launchctl print` reports `state = running` / `kickstart` returning
  0, is only a submitted request, never `Ready`.
- **Windows is process-only, with kernel seats and a per-instance stop Event.**
  The Host and the short-lived management seat are `Global\` named mutexes
  derived from the scope: a newly created mutex receives a protected owner-only
  DACL, while an already existing named object is adopted only after its current
  owner SID and DACL are proved (ACE shape is not a boundary). The same canonical
  profile under another DSH home competes for the same Host seat.
  `stop` opens the authenticated instance's exact process handle (token SID +
  creation FILETIME must match the registry), opens that instance's native stop
  Event, calls `SetEvent` once, and proves the original held handle terminal
  before reporting `stopped`. There is no SIGTERM, `taskkill`,
  `TerminateProcess`, PID lookup or second shutdown owner: the Event only
  delivers the existing `requestStop`/official `runProfile.shutdown` path.
- **The installed service definition is the ONLY manager-IO admission.** A
  public cold start first authenticates and reuses a live Host. Only when it
  must start one does it inspect whether THIS Profile has an installed service
  definition: no unit/plist (or no user-manager directory) means an immediate
  detached Host spawn with no user-manager probe and no
  `systemctl`/`launchctl` invocation at all, so a missing, broken or absent
  user manager cannot affect the basic daemon. An installed Linux unit must be
  loaded by the real manager with this Profile's metadata and
  canonical `FragmentPath`; a historical install build is an `other-build`
  diagnostic, never a start refusal. It is then started through exactly one
  `systemctl --user start <verified-name>`. An installed macOS LaunchAgent must
  be loaded by the real `gui/<uid>` launchd domain with this Profile's metadata,
  the three official profile environment anchors and a printed source file that
  is the canonical target of the exact plist path; it is started through
  `bootstrap` (only when not loaded) and one `kickstart`. A manager error, an
  unloaded service, a foreign source or a conflicting loaded definition is a
  hard `HOST_MANAGER_START_FAILED` /
  `HOST_MANAGER_UNIT_CONFLICT` and never degrades to a detached process.
- **Public vs. internal start boundary.** Only the real public surface launch —
  a strictly-decoded public Client launch envelope with no internal exact-id
  handoff — requests the public start (`hostStartPolicy: 'public'`). Internal
  qualification/peer/manual surface launches and the Client reexec handoff keep
  the exact historic detached process path and never consider a user service
  definition.
- **User-owned unit identity.** The systemd user unit belongs to the user. Its
  identity is the exact profile unit name
  (`dsh-pi-tui@<slug>-<scope prefix>.service`), the
  `X-DshPiTuiOwner`, `X-DshPiTuiScopeId`, `X-DshPiTuiProfileIdentity` and
  `X-DshPiTuiInstallBuild` metadata, and the running manager's canonical
  `FragmentPath` matching the canonical target of that profile unit path. The
  target must be a readable regular file; an existing legal unit and a
  user-created symlink to such a target are supported. `X-DshPiTuiInstallBuild`
  records the install build the FILE was generated from; on Linux it is
  provenance and an `other-build` diagnostic, never an admission that must equal
  the currently installed build. The user's installer layout is not judged: an
  existing unit/account directory may be 0755/0775, a
  legal directory symlink, a shared package store or a root-owned system install.
  Runtime directives — including `ExecStart`, `WorkingDirectory`, `Environment`,
  `Restart`, `ExecStartPre`, `ExecStop` and drop-ins — belong to the user and
  systemd and are not unit identity requirements. Host authentication and
  `MainPID` still prove readiness and supervision separately.
- **Explicit installation and reuse.** `daemon install` is the ONLY path that
  writes a unit. It requires a genuinely reachable systemd user manager, proven
  by a real bounded `systemctl --user` request BEFORE any write. The target is
  the fixed `<account-home>/.config/systemd/user`; it is NOT required to appear
  in the pre-write `UnitPath`, because systemd omits a still-empty directory
  from that property. A FRESH unit name is also checked against the LIVE manager
  first: when the manager already runs this exact unit name from another
  existing file (a foreign service), the install refuses before any write or
  reload. Only a cached `FragmentPath` that is definitively missing (ENOENT —
  an obsolete cache of a removed file) may be reloaded away; an inaccessible or
  otherwise unresolvable loaded source stays refused. Any post-write failure (a rejected
  reload, a unit the manager still reports `not-found`, a post-reload state
  query that itself fails, or a `FragmentPath` that does not adopt the fresh
  file) removes exactly the file this install
  created, so a failed install never leaves a poisoned unit that blocks the
  basic daemon. The post-write `daemon-reload` plus the manager's real
  `LoadState`/`FragmentPath` are the load authority. The initial definition is
  created atomically as 0600 with
  no-overwrite, uses validated installation facts and minimal official
  environment anchors, carries no token, Cookie, secret, one-shot backend
  selector or qualification injection, and is never enabled, started, stopped or
  restarted. A fresh unit launches the stable LEXICAL Profile entry
  (`<profile>/node_modules/@xmoon76/dsh-pi-tui/dist/local-host.mjs`) after
  proving that path resolves to the current official install, so the generated
  file does not freeze a physical package-store path. A same-identity unit is
  reused without restoring runtime defaults and without being rewritten — for a
  historical install build too. A FRESHLY created unit always gets exactly one
  `daemon-reload` BEFORE any cached `LoadState`/`FragmentPath` check (even when
  the manager still caches an older definition at the same path), so a later
  `start` can never dispatch a stale `ExecStart`; if that reload fails, the
  freshly created file is removed so a retry is a fresh install rather than a
  silent reuse of the cached unit. An existing loaded same-identity unit is not
  reloaded on reinstall, while an existing verified unit the manager has not
  loaded gets that one reload before `FragmentPath` verification. A foreign
  identity or mismatched canonical `FragmentPath` is
  `HOST_MANAGER_UNIT_CONFLICT` and is never overwritten. Installing a unit
  beside a running independent Host does not migrate it: the Host keeps running
  and is still `manager=process`.
- **User-owned macOS LaunchAgent identity.** The LaunchAgent belongs to the
  user. Its identity is the exact label `com.xmoon.dsh-pi-tui.<scope-prefix>`
  and the regular, non-symlink file
  `<account-home>/Library/LaunchAgents/<label>.plist`; the file must carry the
  `X-DshPiTuiOwner`, `X-DshPiTuiScopeId`, `X-DshPiTuiProfileIdentity` and
  `X-DshPiTuiInstallBuild` metadata and the current file `(dev,ino,content)`.
  The `X-DshPiTuiInstallBuild` value is a recorded provenance fact, not the
  owner: a plist generated by an older installed build of the SAME Profile is
  still this Profile's own LaunchAgent. The account home is the OS account
  home, never `$HOME`/`DSH_HOME`. A live job is attributed only when
  `launchctl print` reports a `LaunchAgent` whose `path` is the canonical
  target of that exact file, whose three official profile environment anchors
  (`DSH_HOME`, `SPLIT_PROCESS_DSH_ANCHOR`, `SPLIT_PROCESS_PROFILE`) match the
  installed Profile, and whose real `pid` equals the authenticated Host PID.
  The program/arguments, working directory, stdout/stderr sinks, `RunAtLoad`,
  `KeepAlive`, triggers, umask and any extra environment keys are the user's
  own launchd configuration and are executed as written; they are not identity
  requirements. Every mutating transition re-proves the captured file identity
  and, when a live Host is named, the loaded job PID immediately before the
  manager call: a changed file or job is refused before bootstrap, kickstart,
  bootout or unlink. The default job is created with `RunAtLoad=false` and
  `KeepAlive=false`: installation never enables login startup and launchd never
  auto-restarts the Host after a crash. The two private launchd logs are the
  DEFAULT sinks; a stopped/unloaded plist does not govern an independent Host.
- **Explicit macOS installation and reuse.** `daemon install` writes only the
  account-home LaunchAgent plist, atomically as 0600 and never overwriting an
  existing file; it requires a queryable `gui/<uid>` domain and a same-label job
  that is not loaded from another source, and it never `bootstrap`s,
  `kickstart`s, enables or restarts a job, creates the profile runtime scope or
  migrates a running independent Host. A FRESH plist names the stable lexical
  entry `<profileDir>/node_modules/@xmoon76/dsh-pi-tui/dist/local-host.mjs`,
  which survives an official profile package upgrade; the resolver proves that
  named entry resolves to the very same physical Host entry the official
  profile facts name and that the nearest manifest above it is this installed
  product package. An existing same-identity plist is reused byte-for-byte,
  regardless of its recorded install build; a foreign identity, symlink, other
  scope/profile or foreign loaded job is refused. `daemon start` proves the
  captured file identity and the three profile launch anchors before any
  `bootstrap`, then executes the user's launchd configuration as written: a
  custom program that never becomes a real authenticated Host fails truthfully
  with no detached fallback, and no user runtime directive is defaulted or
  rewritten. A verified loaded-but-IDLE job (no PID) is unloaded and
  re-bootstrapped from the CURRENT on-disk plist before it is started, so an
  off-disk user edit is the definition launchd executes; a `spawn scheduled` or
  otherwise unconfirmed transition is refused and a running PID is never
  touched. An explicit cold `daemon start` or `restart` may apply ONE bounded
  migration to a plist whose decoded `ProgramArguments` is exactly this
  product's historical two-string generated block (node executable plus an
  installed product `dist/local-host.mjs` of this Profile). Provenance is
  proven only when the old package lives under THIS Profile's own
  `node_modules` layout (hoisted or `node_modules/.pnpm/<pkg>@<ver>_<hash>`),
  is still readable, and its computed build identity equals the plist's
  recorded `X-DshPiTuiInstallBuild`. A pruned old package, an external
  readable store and a pin to another Profile/build cannot prove provenance
  and stay `user-managed`. When proven, only that decoded second entry becomes
  the current stable named entry and, when the entry actually migrates, the
  adjacent generated `X-DshPiTuiInstallBuild` value is updated; every other
  byte, comment, extra key and user-customized argv is preserved. A
  user-customized argv, a restructured XML, a binary plist or an unrecognized
  shape is never rewritten. `daemon install` itself never
  migrates or rewrites a plist. `daemon uninstall` removes only that verified
  plist and, when the job is loaded from it, `bootout`s only that verified job
  whose process identity is proven by the authenticated Host record; a
  running/starting job without that proof is refused. It keeps the private
  logs, Sessions, Workspace and credentials, and leaves a running independent
  Host untouched.
- **Stop/log ownership.** An independent Host writes its private `host.log` and
  has no periodic auto-restart (only an explicitly enabled manager restarts a
  supervised Host; the default macOS LaunchAgent does not). Host stop remains
  the Host's own `runProfile` shutdown owner; the manager only sends the OS
  signal (`systemctl stop` or a verified `launchctl bootout`), and a Client
  exit/crash never stops the Host. A running/starting launchd job without an
  authenticated Host record has no proven process identity or exit proof:
  `stop`/`restart`/`uninstall` never boot it out or replace it; only a
  not-running, PID-less loaded definition is safe to unload.

## Host startup environment

The real Linux/macOS Host entry performs ONE startup environment bootstrap
before the official profile boot snapshots `process.env`: it appends the
common user and platform tool directories that already exist (the user home's
`.local/bin` and `bin`, the mise/asdf shims, the Cargo/Go/Volta/Bun/pnpm
directories and the platform package-manager plus system directories) to the
PATH inherited from the OS manager or the detached launcher. The inherited PATH
keeps its exact bytes and order, so an explicitly configured service PATH keeps
precedence and a same-name system tool may win; only `process.env.PATH`
changes, no shell, Client or Profile environment is imported, and the service
definition, manager identity and other environment variables are untouched.
`DSH_PI_TUI_HOST_PATH_MODE=inherit` in the ACTUAL Host environment disables the
augmentation completely; unset or `augment` is the default, and any other value
is a fixed startup failure. The bootstrap runs once on a Linux/macOS Host cold
start (systemd, launchd, detached and internal process qualification); Direct,
Client and Windows paths never run it, and a candidate directory that appears
later requires a Host restart to be adopted.

## Host log emission contract

The Host process owns the bytes written to its stdout/stderr sinks; `daemon
logs` only selects and sanitizes one proven source (see the logs bullet below)
and never filters, parses or rewrites record content.

- By default a Host writes a SMALL human-readable production stream: one
  `dsh-pi-tui host: ready (profile=<profile>, pid=<pid>)` line at Ready, one
  line for a startup failure, cleanup failure, warning or warning/error
  diagnostic, one line when Web or ACP autostart becomes enabled, and one line
  when the Host stopped after a successful cleanup. It never writes the raw
  qualification entry records (`m4a0` JSONL), the complete
  `services`/`ownerEntries`/`entries` readiness snapshot or internal control
  receipts to the user-visible log.
- `DSH_PI_TUI_ENTRY_RECORDS=1` in the ACTUAL Host process environment restores
  the complete original JSONL record stream on stdout: one JSON object per
  line, the original fields and order, no additional human lines. It is read
  once when the module loads and affects only a newly started process; it is
  not a Profile setting, management command or runtime toggle, and a `dsh
  daemon start`/`logs` CLI environment is not automatically the Host
  environment of a systemd unit or launchd job.
- A record written through an explicitly provided sink always receives the
  original record unchanged, regardless of the switch. That channel carries
  structural tests, the real surface Client's private `0600` record file and
  business injection probes.
- The default never silences a real startup or cleanup failure: its concise
  line carries the existing phase/code/step and bounded single-line error text
  (never a stack). The log is an explanation only; the Host business owner
  still decides readiness, the failure exit code and whether to stop or
  restart.

## Daemon management commands

`dsh --profile pi-tui daemon status|start|stop|restart|logs|install|uninstall` is the ONE
public management grammar. It is nested under the existing command, needs no
interactive TTY, and operates on the official `profileContext` Profile alone: the
`DSH_PI_TUI_BACKEND` environment value, the persisted `tui-startup.backend` value
and the current terminal state never select, block or redirect a management
command. A management command publishes one typed intent to the same
`tuiDaemonStartup` service and the same launcher row; it resolves no Client
artifact, opens no Direct/Remote TUI, creates no Session/Agent/Writer and starts
no Host unless `start`/`restart` asks for one. `status`, `start`, `stop`,
`restart` and `logs` are supported on Linux, macOS and Windows. Linux attributes
OS supervision through the verified systemd user unit; macOS attributes it
through an explicit user-level launchd LaunchAgent when this Profile has one
installed, and otherwise manages the independent Host process. Windows has no
service manager: every verified Host is `manager=process`, and `install` /
`uninstall` are unsupported before any scope or manager work (exit 3). Neither
POSIX platform requires a service manager for the basic daemon. On macOS the
supported domain is the current user's `gui/<uid>` domain: system LaunchDaemons,
`sudo`, login items and automatic `enable`/`disable` are not used. `--help`
provides neither startup service.

The exit and error taxonomy is fixed: `0` success (including a confirmed
`stopped`, an idempotent stop and an uninstall with no owned unit), `2` CLI usage,
`3` unsupported platform or identity/ownership refusal, `4` manager/OS failure or
an unavailable log source, `5` busy/timeout/transition-uncertain. Errors print
`dsh-pi-tui daemon: <STABLE_CODE>: <sanitized reason>`; raw Error text, command
argv, absolute private paths, Cookies, tokens and Host URLs never reach
stdout/stderr.

### Headless Web CLI

`dsh --profile pi-tui web status|enable|disable|url|open` is the ONE headless
Web control grammar. It is nested under the same command, needs no interactive
TTY, publishes one typed `web-control` intent to the same launcher row, and
never resolves a Client artifact, opens a Direct/Remote TUI, creates a
Session/Agent/Writer, replaces a Host or starts a Host. `web` and `web --help`
are pure help and publish no service. The verbs are supported on Linux, macOS
and Windows; `--session`, `--continue` and `--preset` are refused before any
Host probe, in either argument position.

Every verb operates on the official `profileContext` Profile and the current
same-scope authenticated Host only: the read-only scope facts, official
`/connect` Cookie, identity echo and fresh kernel identity are the same local
authority `daemon status` uses. A missing/dead/unverifiable Host exits `3`
with `HOST_NOT_RUNNING` / `HOST_IDENTITY_REFUSED` / `HOST_AUTH_FAILED`; none of
the five verbs starts a Host. `status` prints one `web=<state>` line for any
legal Host state and exits `0`; `enable`/`disable` print the Host-reached state
(`0` only when it matches the request, `4` for a settled `unavailable`, `5`
with `WEB_OUTCOME_UNCONFIRMED` for a still-changing or mismatched state), and a
write whose response is lost is reported as unknown without any automatic
retry. `url` prints exactly one official authenticated URL on stdout and
nothing else; `open` asks the local OS opener on the CLI machine and reports
only `browser=requested`, never that a Browser page loaded. The URL contains
the Host's official launch token: it must be treated as a credential, is never
logged or embedded in diagnostics, and the product offers no automatic expiry
or revocation. The Host's own `PiTuiWebAccess` service remains the only Web
state authority and the only mutation writer.

- **Status is a pure read.** The management command performs no Host
  control-plane mutation: it does not create the profile run directory or a
  service definition, does not reload/start/stop the manager, starts no Host, Session, Agent
  or TUI, and writes no credential, setting or job. The surrounding official
  DSH Profile Boot keeps its existing behavior; this contract is about the
  management control plane, not a claim that the whole CLI process is
  write-free. `status` may read the private scope files, query the manager and
  run the official authenticated `/connect` handshake. Its stable `key=value`
  block carries `profile`, `manager`, `user-manager`, `host`, `unit`,
  `unit-state` and `compatibility` (plus a bounded `pid`/`instance` while one
  is live). When the authenticated Host is `ready`, `status` also makes ONE
  read-only observation through the Owner-only `/api/pi-tui.acp-status` route
  and appends `acp=enabled|disabled|unavailable`; `acp-socket=<public local endpoint
  address>` is appended ONLY when that same Host's ACP controller proves
  the listener `enabled`. Every other outcome (no Host, an
  unauthenticated/unreadable/incompatible Host, a failed, invalid or
  foreign-instance response, `changing` or a Host-reported `unavailable`)
  prints `acp=unavailable` and never a guessed `disabled`. The ACP observation
  never changes the manager/Host verdict, stderr or exit code, and none of the
  other management verbs performs it. With no installed service definition the command issues NO manager query and
  reports `user-manager=not-checked`; `user-manager=available|error` only
  describes the real manager query (`systemctl show` or `launchctl print`) of an
  installed service definition, and no absence is inferred or reported as
  `absent`. On macOS the installed fact is the verified LaunchAgent plist: with
  no plist the command never inspects a unit path, resolves a systemd runtime
  directory or invokes `systemctl`/`journalctl`/`launchctl`, and reports
  `user-manager=not-checked`, `unit=none`, `unit-state=not-found`; an
  authenticated live Host is `manager=process` and `host=ready`, and with no
  Host the macOS status is `manager=unmanaged` and `host=stopped`. With an owned
  plist it reports `unit=<label>`, the real `launchctl print` outcome as
  `user-manager=available|error`, and `unit-state` as the actual launchd job
  state (`running`, `not-running`, `spawn-scheduled`, `not-found` or `unknown`);
  `manager=launchd` only when the printed source is that plist's canonical
  target, the three profile anchors match and the real job PID equals the
  authenticated Host PID. A loaded job in flux or a foreign/stale source is
  never attributed and stays fail-closed. On Windows there is no service
  definition or manager query at all: `status` always reports
  `user-manager=not-checked`, `unit=none`, `unit-state=not-found`; an
  authenticated Host is `manager=process`, and no Host is `manager=unmanaged`.
  It never invokes `systemctl` or `launchctl`; the ACP observation is the same
  authenticated `GET /api/pi-tui.acp-status` read as on the other platforms, and
  an enabled listener prints its local Named Pipe address. `manager`
  names the VERIFIED supervision attribution: `systemd` only when the loaded
  unit's `MainPID` equals the authenticated Host PID, `launchd` only when the
  printed job source/anchors match and its real PID equals the authenticated Host
  PID, `process` for a verified independent Host (even when a user bus
  exists), otherwise `unmanaged`; it never means "a manager executable exists".
  `unit` is the installed service-definition fact and is independent of
  `manager`. A manager active state or a registry PID is not readiness: a
  supervised but unauthenticated Host is `starting`/`unresponsive`, and an
  unreadable/contradictory state is `unknown`.
  For the systemd manager, an `activating` unit is a Host that may still come up: it is
  reported `starting` (never `stopped`) even before any `MainPID` exists, while
  any other unconfirmed transition (`deactivating`, `reloading`, an unrecognized
  `ActiveState`) beside a live Host keeps the authenticated `host=ready` truth,
  reports `manager=unmanaged` (neither independent-process nor systemd
  supervision is proven), and exits nonzero (the supervisor may retire it
  before any caller acts). An `active`/`activating` unit whose `MainPID` is
  NOT the authenticated Host's PID is an ownership refusal, and an ended unit
  (`inactive`/`failed`) beside a live Host supervises nothing. `MainPID=0` alone
  never proves a Host is stopped.
  A missing Host with no unit conflict is `stopped` and exit 0; manager error,
  unsafe/foreign unit, incompatible protocol/DSH and unverifiable liveness are
  nonzero and are never reported as `stopped`.
- **start reuses before it creates.** `start` first authenticates and reuses a
  live compatible Host, so a warm start is idempotent on the same
  `instanceId` — including while the user manager is erroring: reuse needs no
  manager, so a manager error never fails that path (`status` still reports
  the same combination nonzero, because its question — "is everything
  confirmed?" — includes the supervisor). Otherwise it creates only the needed
  0700 scope run directory (including the private launchd log sinks on macOS)
  and asks the existing `ensureLocalHost({hostStartPolicy:'public'})` to bring
  one up, then waits for authenticated readiness. A manager error never
  degrades to the process fallback. On Linux a historical install build is an
  `other-build` diagnostic, not a start refusal: the manager-defined unit is
  started through systemd as-is. On macOS a same-Profile LaunchAgent recorded
  from an older installed build follows its explicit start/restart migration
  contract; the loaded job's canonical source and profile anchors remain the
  ownership proof. A live unauthenticated/incompatible Host is never replaced
  or killed.
- **stop needs proven supervision.** A loaded `active`/`activating` profile unit
  whose `MainPID` is the authenticated Host is stopped only through
  `systemctl --user stop <verified-name>`, followed by a bounded wait for the
  original MainPID to exit. An independent authenticated Host — no service
  definition, a unit reported `inactive`/`failed`, an installed but unloaded
  unit, or a plist whose job is not loaded — is stopped
  only by one SIGTERM to the verified original PID after re-authentication,
  re-checking the kernel starttime and the product Host entry command identity;
  this routing does not depend on whether the machine happens to have systemd.
  On macOS the same independent-process branch proves the schema-2 Darwin kernel
  identity instead: after the fresh authenticated handshake
  `assertRecordedHostKernelIdentityCurrent()` must still prove the SAME kernel
  process, the kernel read is repeated immediately before the signal, and a
  `gone`/`different`/`unknown` observation or a replaced registry instance is
  refused with ZERO signals. A loaded macOS LaunchAgent whose printed source and
  profile anchors match and whose real PID is the authenticated Host is
  stopped only through `launchctl bootout` of that verified job, followed by the
  same bounded kernel-identity wait; a loaded job with no live Host is booted
  out without any signal. The bounded wait then requires that recorded kernel identity to
  become `gone`/`different`; `unknown` stays uncertainty and is never treated as
  stopped. On Windows an independent authenticated Host is stopped only through
  its exact per-instance native Event: the command opens the recorded PID with
  `PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE`, proves the same token SID
  and creation FILETIME, verifies the instance Event's existing-object private
  boundary, calls `SetEvent` once, and waits on the ORIGINAL held handle to become
  terminal; it never sends SIGTERM, `taskkill` or `TerminateProcess`. A
  `gone`/`different`/`unknown` observation, a replaced registry instance, a
  missing Event or a different process identity is refused without a signal.
  No platform invokes `readLinuxStarttime`/`/proc` or a Linux abstract admin
  seat on macOS, and Windows never invokes a POSIX `/proc`, UID or signal path.
  The Host's existing `SIGTERM` process-lifetime admission (POSIX) or native
  Event admission (Windows) still runs the one official `runProfile`
  `shutdownOwner.shutdown()`; the management command adds no second shutdown
  owner, RPC or SIGKILL.
  No process group and no `pkill`. A live Host beside an active unit with a
  different `MainPID`, a unit in flux, a foreign or wrong-scope unit, or an
  unreadable manager is refused instead of being signalled. A timeout is exit 5
  and never escalates to SIGKILL or claims `stopped`.
- **Authentication or compatibility failure is reported, not auto-recovered.**
  A live Host that fails the Cookie/identity/starttime handshake is
  `unresponsive`; one whose protocol or DSH runtime differs is `incompatible`.
  Both are nonzero diagnostics, and the product never restarts, stops,
  rewrites or enables a service definition on its own. An explicit `stop`,
  `restart` or `uninstall` may still act on an already-verified current-Profile
  service when the manager is available and its `MainPID`/printed PID is the
  live Host PID the command is about to stop (or there is no live registry
  Host): readiness and compatibility are Host verdicts, not the
  service-ownership verdict. Foreign identity, wrong scope, wrong
  `FragmentPath`/plist source, a mismatched `MainPID`/PID and an
  independent Host without a fresh authenticated identity remain refusals.
  A restart still stops the old instance and proves a new authenticated Ready
  instance; a failed recovery reports the real failure. A live-Host typed
  refusal (`LocalScopeError` protocol/DSH/authentication class) prints the
  controlled code, states that the Host was not stopped, and points at `daemon
  status`, `daemon logs` and an explicitly user-chosen `daemon restart` for the
  ACTIVE profile; it never tells the user to signal a PID and never promises
  that recovery will succeed. A Client-local startup failure — for example a
  missing Client dependency — is a different owner: the terminal names the
  controlled Client classification and the private
  `$DSH_HOME/logs/pi-tui-client/startup-*.log` incident file, is not available
  from `daemon logs`, and does not suggest a Host restart. A
  Client-handoff/reexec failure keeps its dedicated expected-Host restore line
  instead: the Host was not stopped or replaced, and the user starts a
  compatible Client manually, because restarting the Host is not the recovery
  for a replaced expected Client instance.
- **restart and uninstall are ONE explicit transition.** `restart` stops, awaits
  a confirmed old-instance exit, and only then starts a new instance; a stop
  that is unknown, failed or still running forbids the start. On Linux an owned
  systemd unit from a HISTORICAL install build is this Profile's unit: the
  explicit `start`/`restart` adopts the current install instead of refusing.
  `restart` performs a read-only feasibility check of the bounded
  generated-field migration BEFORE any stop, and only after the old kernel Host
  is proven gone does it rewrite — in ONE atomically replaced main unit file —
  exactly the recognized historical PiTui `ExecStart` target (to the stable
  lexical Profile entry, preserving the original Node executable token) and,
  only in that same confirmed migration, `X-DshPiTuiInstallBuild`; every other
  main-unit byte, its mode and any drop-in stay untouched. The write is admitted
  only for a current-user-owned regular main unit file (never a symlink),
  followed by one `daemon-reload` and a re-inspection of the NEW file plus the
  manager's `FragmentPath`. An unrecognizable/user-custom `ExecStart`, a unit
  already pointing at the stable entry, a symlinked unit, or an
  unwritable/foreign-owned unit is never rewritten: a custom command is used by
  systemd as-is, while a necessary migration the current user cannot perform is
  diagnosed BEFORE the Host is stopped. The macOS LaunchAgent is the
  same-Profile user service: an explicit `daemon restart` stops the
  authenticated old Host, proves its kernel identity gone, proves the loaded
  job booted out, then may apply the ONE bounded generated-entry migration
  described above before bootstrapping the same plist and proving the new
  authenticated Host. When a user-authored launchd command deliberately runs
  another compatible build, the restart still succeeds but the output
  truthfully reports `compatibility=other-build` and states that the running
  build differs from the installed profile; it never claims the installed code
  was adopted. An `install` only writes and verifies
  this Profile's service definition; it never starts, stops, enables or migrates
  anything, so a running independent Host keeps its instance and stays
  `manager=process`. `uninstall` is idempotent when no service definition is
  installed; it stops only a running verified systemd unit whose `MainPID` is
  the live Host (or a unit with no live Host) and only a verified loaded
  LaunchAgent, unlinks only this Profile's verified path, and reloads systemd.
  The historical install build is never an uninstall refusal. A same-Profile
  plist recorded from an older installed build is explicitly uninstallable
  without reinstalling that build.
  An `inactive`/unloaded unit or unloaded plist is unlink-only and leaves an
  independent running Host untouched; that successful result claims no
  interrupted Session. For a symlink the unlink leaves its source target
  intact; drop-in files and launchd private logs are also retained. It never
  removes the Profile, `DSH_HOME`, Sessions, credentials, `launch.json` or
  another Profile's service, and it never kills an independent Host. A reload
  failure is reported as a failure, never as a completed uninstall. A cold
  `start` never spawns a second Host beside a manager-started one and never
  silently rewrites a user-custom unit or plist. A mutating verb's exit 0 requires the
  post-transition snapshot to contain NO blocking failure AND the expected
  outcome: `start`/`restart` need an authenticated Ready Host (plus a new
  `instanceId` for `restart`), `stop` needs `host=stopped`, and `uninstall` needs
  the owned service definition confirmed gone (after the platform reload when
  one exists). A Ready
  observation never outranks a supervision/ownership failure, and an uninstall
  whose OS actions committed but whose confirmation failed reports the failure
  (no reinstall, no rollback).
- **logs use one proven source.** A loaded profile unit that actually governs
  the current Host (or governs a stopped/starting profile) reads
  `journalctl --user-unit <verified-name> --no-pager -o cat` with a bounded
  line count. An independent Host, or a profile with no loaded unit, reads the
  scope `host.log` (new files 0600; an existing user mode is readable, the final
  path is never followed as a symlink, and the tail is byte-capped). The source
  follows the SAME verified attribution as `status`: a live Host beside a running
  unit whose `MainPID` differs, a unit in flux, or an unreadable manager is an
  explicit exit-4 log-source failure and never a guessed file. There is no
  arbitrary path/command input and no business side effect; missing/unreadable
  output is exit 4. On macOS a verified loaded LaunchAgent is the source:
  `daemon logs` reads the stdout/stderr sinks THAT JOB DECLARES in
  `launchctl print` as separately bounded, separately labelled streams and
  never pretends they are time-merged. A verified loaded job that declares no
  sink makes `logs` return `LOG_SOURCE_UNAVAILABLE`; the product's default
  private file names are never substituted for a user configuration, and a
  missing log never blocks `status`/`start`/`stop`/`restart`.
  After the launchd job is unloaded, or
  its plist was removed while retained launchd streams still exist, there is no
  live authority proving whether those streams or an older `host.log` is the
  most recent Host: `daemon logs` returns `LOG_SOURCE_UNAVAILABLE` and reads
  neither. A live independent Host keeps the bounded/sanitized scope `host.log`
  tail; with no plist, no live Host and no retained launchd stream, `host.log`
  is the only remaining source. On Windows the only source is the scope
  `host.log`; a newly created log inherits its parent directory's ACL and is
  admitted by the shared private-file predicate, while an existing file is
  admitted with the product's private boundary (current owner SID, present DACL
  and no ordinary-account grant beyond the current SID/System/Administrators).
  ACE count, protected bit and inherited/explicit form are not part of that
  boundary; a foreign/public/final-reparse file is an explicit log-source failure
  rather than a guessed tail. A stale log from another process is
  never presented as the current record. Output is bounded and
  best-effort
  sanitized (ANSI/control sequences, token/cookie/Authorization and
  connect/launch URL material); the user-facing notice states that the
  sanitization cannot promise every secret shape in free-form user text.
- **Mutating verbs serialize per Profile, not globally.** `start`, `stop`,
  `restart`, `install` and `uninstall` hold one short-lived profile-scoped admin
  seat. Linux holds the abstract socket name
  (`\0dsh-pi-tui-admin-<scope prefix>`); macOS holds the existing Darwin `admin`
  `O_EXLOCK` seat file in the account-home seat chain beside the Host singleton
  (`seat-admin-<scopeId>.lock`), claimed through `bindDarwinKernelSeat`;
  Windows holds a separate purpose-derived `Global\` named mutex with the same
  private boundary as the Host seat. `status` and `logs` take no seat and
  create no directory. The kernel releases the claim when the command exits, so
  there is no persistent lock file or second state machine. A second
  concurrent mutating command for the same Profile gets `DAEMON_CONTROL_BUSY`
  and exit 5 before any Host/service mutation; another Profile is unaffected. A
  normal Client cold start keeps its existing Host kernel-singleton semantics
  and takes no admin seat. On macOS `install`/`uninstall` take the same admin
  seat before writing or removing the verified LaunchAgent plist; they do not
  create the profile runtime scope.
- **Running-work boundary.** `stop`/`restart` are explicit user Host control and
  can interrupt a running Session, accepted Turn, tool or pending Interaction;
  `uninstall` prints the same warning only when it actually stopped a running
  unit, and `install` never prints it. The official Host `runProfile` shutdown
  remains the only shutdown owner and the management command never answers,
  cancels, replays or rolls back a pending business result. The CLI prints a
  stable line that current work may be interrupted and that unsettled writes are
  not replayed automatically.

### Headless ACP CLI

`dsh --profile pi-tui acp status|enable|disable` is the ONE headless ACP
management grammar. The three verbs are nested under the existing `acp`
command, need no interactive TTY, publish one typed `acp-control` intent to the
same launcher row, and never resolve a Client artifact, open a Direct/Remote
TUI, create a Session/Agent/Writer, spawn the ACP stdio adapter, install or
start/stop a Host, or enable a Profile `autoStart`. `acp stdio` remains the
machine protocol bridge and the management verbs never write human text into
that stream; `acp` and `acp --help` are pure help and publish no service. The
verbs are supported on Linux, macOS and Windows; `--session`, `--continue` and
`--preset` are refused before any Host probe, in either argument position.

Every verb operates on the official `profileContext` Profile and the current
same-scope authenticated Host only: the read-only scope facts, official
`/connect` Cookie, identity echo and fresh kernel identity are the same local
authority the Web CLI uses, and no verb starts a Host.

- **Status is a pure read.** `acp status` performs exactly ONE observation
  through the existing Owner-only `GET /api/pi-tui.acp-status` route and
  prints exactly one `acp=enabled|disabled|changing|unavailable` line with exit
  `0`. It never issues a write, never creates the profile run directory and
  never starts a Host. Only a genuine authenticated same-instance answer is
  printed; an old Host without the route, a timeout, a malformed/foreign reply
  or any other unprovable outcome exits `4` with `ACP_CLI_UNAVAILABLE`, an
  empty stdout and never a guessed `disabled`. The observation is independent
  of the compressed `daemon status` summary: `acp status` reports the Host's
  real four-state vocabulary, while `daemon status` keeps its existing
  `enabled|disabled|unavailable` projection.
- **One write, one route.** `acp enable|disable` sends exactly ONE
  authenticated Owner-only `POST /api/pi-tui.acp-control` with the current
  instance id and the requested operation; the Host-entry's ONE ACP runtime
  controller remains the only listener owner. The CLI never connects to the
  public local endpoint, never opens a second controller and never starts a Host.
  Runtime toggling does not rewrite the profile `acp-autostart` preference, does
  not stop the Host/Agent/Session/TUI, and disabling closes existing ACP peers,
  stops accepting new ones and retires the owned endpoint (the POSIX inode or the
  Windows Named Pipe name).
- **Fixed write result contract.** A reply that proves the requested target was
  reached prints `acp=enabled|disabled` and exits `0`. A verified settled
  `unavailable` prints `acp=unavailable` and exits `4` with `ACP_UNAVAILABLE`.
  A reply that proves a `changing` or target-mismatched state prints that actual
  state and exits `5` with `ACP_OUTCOME_UNCONFIRMED`. A deterministic
  pre-dispatch refusal keeps the empty-stdout taxonomy: missing/dead Host exits
  `3` with `HOST_NOT_RUNNING` (the message names the explicit
  `daemon start` next step but never performs it), authentication refusal exits
  `3` with `HOST_AUTH_FAILED`, wrong instance/identity exits `3` with
  `HOST_IDENTITY_REFUSED`, and an unsupported platform, old Host without the
  route, or strict schema/media/method rejection exits `4` with
  `ACP_CLI_UNAVAILABLE`. A lost response, timeout, abort, unverifiable reply or
  Host `503` after dispatch exits `5` with `ACP_OUTCOME_UNCONFIRMED`: the write
  may have committed, the CLI never replays it and never claims it did not
  happen.
- **One-shot ownership.** The ACP management arm uses the existing one-shot
  `DaemonControlRunner` lifecycle: the operation starts only on the real
  cold-ready commit, is aborted by its fiber disposal, settles `appExit` exactly
  once, and maps an unexpected local throw to
  `dsh-pi-tui acp: ACP_CLI_UNAVAILABLE` rather than a daemon/Web/stdio code.
  Every failure line is one stable `dsh-pi-tui acp: <CODE>: <sanitized reason>`
  line; raw Error text, argv, private paths, socket paths, Cookies and Host
  URLs never reach stdout/stderr.
