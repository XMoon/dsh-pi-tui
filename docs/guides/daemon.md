# Run dsh-pi-tui in daemon mode

Daemon mode gives one DSH Profile an independently running local Host and a
terminal Client that attaches to it. The Host can keep sessions and turns alive
after the terminal Client disconnects. It is a **local** Linux/macOS mode,
not a remote-network login or a second session authority.

## Select a backend

Direct is the default. To try daemon mode for a single interactive launch:

~~~sh
DSH_PI_TUI_BACKEND=daemon dsh --profile pi-tui
~~~

Alternatively, set **Settings → General → Startup backend** to `daemon`
and start a new TUI. This stored setting applies on the next launch only;
it does not change the backend of a Client already running. A one-launch
`DSH_PI_TUI_BACKEND` override has precedence over the Profile setting and
does not write it back.

Daemon mode requires a real interactive TTY and a supported Linux or macOS
system. A supported daemon launch authenticates or starts the Profile's one
Host as necessary; it does **not** automatically install a system service.

## Leave a Client or stop the Host

In daemon mode, `/exit` (alias `/quit`) closes the terminal Client; it is
**not** the same as stopping the Profile's background Host. A detached Host
may still have active work. For a deliberate Host shutdown use
`dsh --profile pi-tui daemon stop`.

This distinction is different in Direct mode, where the TUI owns its
in-process session lifecycle. Do not use a process kill or a guessed PID
as a replacement for the authenticated Profile control commands.

## Inspect and manage one Profile

All commands below select the same Profile explicitly:

| Intent | Command |
|---|---|
| Inspect Host and manager state, including ACP when provable | `dsh --profile pi-tui daemon status` |
| Start the Profile Host when needed | `dsh --profile pi-tui daemon start` |
| Stop the verified Profile Host | `dsh --profile pi-tui daemon stop` |
| Restart with manager/identity checks | `dsh --profile pi-tui daemon restart` |
| Inspect available Host logs | `dsh --profile pi-tui daemon logs` |
| Install the optional user service definition | `dsh --profile pi-tui daemon install` |
| Remove the owned user service definition | `dsh --profile pi-tui daemon uninstall` |

`status` and `logs` are read-only observations: they neither create nor
start a Host or service definition. A manager's “running” state alone is
not Host readiness; an authenticated Host identity is required. If an
installed unit belongs to a different build/profile, control operations
refuse rather than taking over an unknown process.

## Optional OS supervision

Without a service definition, daemon mode can still use the independent
Host process. `daemon install` is an **explicit** opt-in to profile-scoped
supervision: a verified systemd user unit on Linux or a user LaunchAgent on
macOS. Installing the definition is not an implicit start, enable or
restart, and does not migrate a live Host into a new manager.

The `daemon stop`, `restart` and `uninstall` operations can interrupt
Host work. Check `daemon status` and the running sessions first.

## Optional local ACP listener

The Host-owned ACP v1 listener is independent of the daemon backend choice
and is default-off. Its Profile auto-start preference and the **current**
running listener state are separate controls. `daemon status` shows a
socket address only for a listener that has been positively verified as
enabled; never guess a socket from the home/profile path.

For contributor-level process, authentication, ACP admission and Client
detach guarantees, see [Host/Client](../architecture/host-client.md),
[daemon process ownership](../architecture/host-daemon.md) and
[ACP listener contract](../architecture/host-acp.md).
