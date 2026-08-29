# DeepSeek Harness compatibility

This document is the source of truth for the `dsh-pi-tui`/DSH version
boundary.

## Runtime compatibility

| dsh-pi-tui line | DeepSeek Harness line | Policy |
|---|---|---|
| `0.3.x` | `0.1.1` | Supported legacy runtime line |
| `0.4.x-alpha` | `>=0.1.2-alpha.1 <0.1.3` | Supported target line; DSH 0.1.3+ is validated per release |

The 0.4 line has no 0.1.1 runtime shim. An old Harness remains outside the
supported peer window and must fail at the normal incompatible-runtime
boundary. The startup row prints both recovery paths when its concurrent
Loader mount gets to run first, but that friendly notice is best-effort:

```sh
npm install -g @deepseek-ai/dsh@0.1.2-alpha.1
npm install -g @xmoon76/dsh-pi-tui@0.3
```

The first command upgrades the Harness for 0.4. The second pins the compatible
TUI line when the installed Harness must remain on 0.1.1. The package peer
window rejects DSH 0.1.3 and later until that line is revalidated. The startup
notice only reports versions below `0.1.2-alpha.1`; a manually forced future
runtime fails through the normal package contract rather than an early
TUI-specific API branch. Peer prerelease tuples are validated separately before
each release.

## Data compatibility

Runtime compatibility and data compatibility are separate. A 0.4 runtime
requires the declared DSH 0.1.2 support window, but it continues to read
sessions created by 0.3.x.
Preset state is read through DSH's `agentPreset` session projection: the
creation header initializes the state and the newest `agent-preset/selected`
event wins.

The canonical shipped preset ids are `standard`, `ptc`, `minimal`, and `cordis`,
resolved from DSH's official shipped root. No local preset copy or `code` runtime
alias is shipped. DSH's user preset namespace still permits a custom preset
literally named `code`: explicit input and durable state preserve `code` when
that roster entry exists. Only an omitted legacy default or session value is
mapped to `ptc` after the current roster proves that `code` is absent; new
command/config writes are validated against the roster before they are saved.

## Validation

- Gate A validates the real TUI surface with `VirtualTerminal + TuiApp`.
- The independent official-preset gate installs only the exact target DSH and
  candidate artifact, then runs real `standard`/`ptc`/`minimal`/`cordis`
  Agent/Session creation, durable-header, degradation, and `/goal` isolation
  checks. It is runnable without a supported published `pi2dsh` release.
- Gate B separately validates the published `pi2dsh` consumer metadata against
  the exact manifest DSH version and candidate TUI version. An unsupported peer
  declaration is an `ECOSYSTEM_CONTRACT_BLOCKER`, not a forced install or a
  runtime-smoke pass.
- The runtime-boundary smoke intentionally runs the 0.4 candidate against DSH
  0.1.1 and requires a nonzero unsupported-runtime outcome. Friendly startup
  guidance is asserted when emitted, but raw import failure is accepted because
  DSH Loader mounts profile entries concurrently.
