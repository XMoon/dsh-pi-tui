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
service definition a cold start keeps the basic detached Host. Windows is not a
supported Daemon platform in this contract.

- **Manager vs. authentication authority.** The manager answers "how is the Host
  OS process supervised", never "is a Host ready". When a live Host is already
  reusable it is authenticated and reused before any manager work; the manager
  never replaces, adopts, kills or migrates a live Host (including a compatible
  different build or one without a product service definition). Readiness remains the official
  `/connect` Cookie + authenticated identity echo + `/proc` starttime handshake.
  A systemd `ActiveState=active` / `systemctl start` returning 0, or a launchd
  job whose `launchctl print` reports `state = running` / `kickstart` returning
  0, is only a submitted request, never `Ready`.
- **The installed service definition is the ONLY manager-IO admission.** A
  public cold start first authenticates and reuses a live Host. Only when it
  must start one does it inspect whether THIS Profile has an installed service
  definition: no unit/plist (or no user-manager directory) means an immediate
  detached Host spawn with no user-manager probe and no
  `systemctl`/`launchctl` invocation at all, so a missing, broken or absent
  user manager cannot affect the basic daemon. An installed Linux unit must be
  loaded by the real manager with this Profile's metadata, installed build and
  canonical `FragmentPath`; it is then started through exactly one
  `systemctl --user start <verified-name>`. An installed macOS LaunchAgent must
  be loaded by the real `gui/<uid>` launchd domain with this Profile's metadata,
  installed build and a printed source file that is the canonical target of the
  exact plist path; it is started through `bootstrap` (only when not loaded) and
  one `kickstart`. A manager error, an unloaded service, a foreign source or a
  conflicting loaded definition is a hard `HOST_MANAGER_START_FAILED` /
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
  user-created symlink to such a target are supported. The user's installer
  layout is not judged: an existing unit/account directory may be 0755/0775, a
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
  restarted. A same-identity unit is reused without restoring runtime defaults
  and without being rewritten. A FRESHLY created unit always gets exactly one
  `daemon-reload` BEFORE any cached `LoadState`/`FragmentPath` check (even when
  the manager still caches an older definition at the same path), so a later
  `start` can never dispatch a stale `ExecStart`; if that reload fails, the
  freshly created file is removed so a retry is a fresh install rather than a
  silent reuse of the cached unit. An existing loaded same-identity unit is not
  reloaded on reinstall, while an existing verified unit the manager has not
  loaded gets that one reload before `FragmentPath` verification. A foreign identity,
  different install build or mismatched canonical
  `FragmentPath` is `HOST_MANAGER_UNIT_CONFLICT` and is never overwritten;
  cross-build replacement belongs to an explicit upgrade flow. Installing a unit
  beside a running independent Host does not migrate it: the Host keeps running
  and is still `manager=process`.
- **User-owned macOS LaunchAgent identity.** The LaunchAgent belongs to the
  user. Its identity is the exact label `com.xmoon.dsh-pi-tui.<scope-prefix>`
  and the regular, non-symlink file
  `<account-home>/Library/LaunchAgents/<label>.plist`; the file must carry the
  `X-DshPiTuiOwner`, `X-DshPiTuiScopeId`, `X-DshPiTuiProfileIdentity` and
  `X-DshPiTuiInstallBuild` metadata and the current file `(dev,ino,content)`.
  The account home is the OS account home, never `$HOME`/`DSH_HOME`. A live job
  is attributed only when `launchctl print` reports a `LaunchAgent` whose
  `path` is the canonical target of that exact file, whose fixed launch facts
  (program, arguments, working directory, stdout/stderr sinks and the three
  official environment anchors) match the installed profile, and whose real
  `pid` equals the authenticated Host PID. User runtime directives outside
  those fixed facts belong to the user/launchd. Every mutating transition
  re-proves the captured file identity and, when a live Host is named, the
  loaded job PID immediately before the manager call: a changed file or job is
  refused before bootstrap, kickstart, bootout or unlink. The default job is
  created with `RunAtLoad=false` and `KeepAlive=false`: installation never
  enables login startup and launchd never auto-restarts the Host after a crash.
  The two private launchd logs are distinct, bounded, separately labelled
  sources; an installed-but-not-loaded plist does not govern an independent
  Host.
- **Explicit macOS installation and reuse.** `daemon install` writes only the
  account-home LaunchAgent plist, atomically as 0600 and never overwriting an
  existing file; it requires a queryable `gui/<uid>` domain and a same-label job
  that is not loaded from another source, and it never `bootstrap`s,
  `kickstart`s, enables or restarts a job, creates the profile runtime scope or
  migrates a running independent Host. A same-identity plist is reused
  byte-for-byte; a foreign identity, symlink, other scope/profile/build or
  foreign loaded job is refused. `daemon start` proves the fixed launch
  definition and known execution triggers before any `bootstrap`: changes to
  the program, arguments, working directory, log sinks, environment, umask,
  `RunAtLoad`, `KeepAlive` or a known trigger are refused rather than executed
  (a user-edited `RunAtLoad=true` can run a modified program during bootstrap);
  comments and harmless user runtime keys are preserved and never rewritten.
  `daemon uninstall` removes only that verified plist and, when the job is
  loaded from it, `bootout`s only that verified job whose process identity is
  proven by the authenticated Host record; a running/starting job without that
  proof is refused. It keeps the private logs, Sessions, Workspace and
  credentials, and leaves a running independent Host untouched.
- **Stop/log ownership.** An independent Host writes its private `host.log` and
  has no periodic auto-restart (only an explicitly enabled manager restarts a
  supervised Host; the default macOS LaunchAgent does not). Host stop remains
  the Host's own `runProfile` shutdown owner; the manager only sends the OS
  signal (`systemctl stop` or a verified `launchctl bootout`), and a Client
  exit/crash never stops the Host. A running/starting launchd job without an
  authenticated Host record has no proven process identity or exit proof:
  `stop`/`restart`/`uninstall` never boot it out or replace it; only a
  not-running, PID-less loaded definition is safe to unload.

## Daemon management commands

`dsh --profile pi-tui daemon status|start|stop|restart|logs|install|uninstall` is the ONE
public management grammar. It is nested under the existing command, needs no
interactive TTY, and operates on the official `profileContext` Profile alone: the
`DSH_PI_TUI_BACKEND` environment value, the persisted `tui-startup.backend` value
and the current terminal state never select, block or redirect a management
command. A management command publishes one typed intent to the same
`tuiDaemonStartup` service and the same launcher row; it resolves no Client
artifact, opens no Direct/Remote TUI, creates no Session/Agent/Writer and starts
no Host unless `start`/`restart` asks for one. The verbs are supported on Linux
and macOS. Linux attributes OS supervision through the verified systemd user
unit; macOS attributes it through an explicit user-level launchd LaunchAgent
when this Profile has one installed, and otherwise manages the independent Host
process. Neither platform requires a service manager for the basic daemon. On
macOS the supported domain is the current user's `gui/<uid>` domain: system
LaunchDaemons, `sudo`, login items and automatic `enable`/`disable` are not
used. `--help` provides neither startup service.

The exit and error taxonomy is fixed: `0` success (including a confirmed
`stopped`, an idempotent stop and an uninstall with no owned unit), `2` CLI usage,
`3` unsupported platform or identity/ownership refusal, `4` manager/OS failure or
an unavailable log source, `5` busy/timeout/transition-uncertain. Errors print
`dsh-pi-tui daemon: <STABLE_CODE>: <sanitized reason>`; raw Error text, command
argv, absolute private paths, Cookies, tokens and Host URLs never reach
stdout/stderr.

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
  and appends `acp=enabled|disabled|unavailable`; `acp-socket=<absolute public
  logical path>` is appended ONLY when that same Host's ACP controller proves
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
  target, the fixed launch facts match and the real job PID equals the
  authenticated Host PID. A loaded job in flux or a foreign/stale source is
  never attributed and stays fail-closed. `manager`
  names the VERIFIED supervision attribution: `systemd` only when the loaded
  unit's `MainPID` equals the authenticated Host PID, `launchd` only when the
  printed job source/facts match and its real PID equals the authenticated Host
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
  degrades to the process fallback; a different installed build or unknown
  service definition is a conflict; a live unauthenticated/incompatible Host is
  never replaced or killed.
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
  fixed launch facts match and whose real PID is the authenticated Host is
  stopped only through `launchctl bootout` of that verified job, followed by the
  same bounded kernel-identity wait; a loaded job with no live Host is booted
  out without any signal. The bounded wait then requires that recorded kernel identity to
  become `gone`/`different`; `unknown` stays uncertainty and is never treated as
  stopped. No platform invokes `readLinuxStarttime`/`/proc` or a Linux abstract
  admin seat on macOS. The Host's existing `SIGTERM` process-lifetime admission
  still runs the one official `runProfile` `shutdownOwner.shutdown()`; the
  management command adds no second shutdown owner, RPC or SIGKILL.
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
  instance; a failed recovery reports the real failure. An ordinary surface
  startup failure prints the controlled code, states that the Host was not
  stopped, and points at `daemon status`, `daemon logs` and an explicitly
  user-chosen `daemon restart` for the ACTIVE profile; it never tells the user
  to signal a PID and never promises that recovery will succeed. A
  Client-handoff/reexec failure keeps its dedicated expected-Host restore line
  instead: the Host was not stopped or replaced, and the user starts a
  compatible Client manually, because restarting the Host is not the recovery
  for a replaced expected Client instance.
- **restart and uninstall are ONE explicit transition.** `restart` stops, awaits
  a confirmed old-instance exit, and only then starts a new instance; a stop
  that is unknown, failed or still running forbids the start. An owned service
  definition whose install build differs from THIS installation is refused
  (exit 3) and left untouched: cross-build replacement belongs to the explicit
  upgrade flow, not to a management command — the metadata alone cannot prove a
  historical build's compatibility. An `install` only writes and verifies this
  Profile's service definition; it never starts, stops, enables or migrates
  anything, so a running independent Host keeps its instance and stays
  `manager=process`. `uninstall` is idempotent when no service definition is
  installed; it stops only a running verified systemd unit whose `MainPID` is
  the live Host (or a unit with no live Host) and only a verified loaded
  LaunchAgent, unlinks only this Profile's verified path, and reloads systemd.
  An `inactive`/unloaded unit or unloaded plist is unlink-only and leaves an
  independent running Host untouched; that successful result claims no
  interrupted Session. For a symlink the unlink leaves its source target
  intact; drop-in files and launchd private logs are also retained. It never
  removes the Profile, `DSH_HOME`, Sessions, credentials, `launch.json` or
  another Profile's service, and it never kills an independent Host. A reload
  failure is reported as a failure, never as a completed uninstall. A cold `start` never
  silently upgrades a different build. A mutating verb's exit 0 requires the
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
  `daemon logs` reads its two private files (`launchd.stdout.log` and
  `launchd.stderr.log`) as separately bounded, separately labelled streams and
  never pretends they are time-merged. After the launchd job is unloaded, or
  its plist was removed while retained launchd streams still exist, there is no
  live authority proving whether those streams or an older `host.log` is the
  most recent Host: `daemon logs` returns `LOG_SOURCE_UNAVAILABLE` and reads
  neither. A live independent Host keeps the bounded/sanitized scope `host.log`
  tail; with no plist, no live Host and no retained launchd stream, `host.log`
  is the only remaining source. A stale log from another process is
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
  (`seat-admin-<scopeId>.lock`), claimed through `bindDarwinKernelSeat`. `status`
  and `logs` take no seat and create no directory. The kernel releases the claim
  when the command exits, so there is no persistent lock file or second state
  machine. A second
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
