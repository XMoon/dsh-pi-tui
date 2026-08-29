# DeepSeek Harness compatibility

This document is the source of truth for the `dsh-pi-tui`/DSH version
boundary.

## Runtime compatibility

| dsh-pi-tui line | DeepSeek Harness line | Policy |
|---|---|---|
| `0.3.x` | `0.1.1` | Supported legacy runtime line |
| `0.4.x-alpha` | `>=0.1.2-alpha.1 <0.1.3` | Supported target line; DSH 0.1.3+ is validated per release |

The 0.4 line has no 0.1.1 runtime shim. It rejects an old Harness before the
profile can mount incompatible rows and prints both recovery paths:

```sh
npm install -g @deepseek-ai/dsh@0.1.2-alpha.1
npm install -g @xmoon76/dsh-pi-tui@0.3
```

The first command upgrades the Harness for 0.4. The second pins the compatible
TUI line when the installed Harness must remain on 0.1.1. The package peer
window rejects DSH 0.1.3 and later until that line is revalidated. The startup gate still rejects only versions below
`0.1.2-alpha.1`, so a manually forced future runtime fails through the normal
package contract rather than an early TUI-specific API branch. Peer
prerelease tuples are validated separately before each release.

## Data compatibility

Runtime compatibility and data compatibility are separate. A 0.4 runtime
requires the declared DSH 0.1.2 support window, but it continues to read
sessions created by 0.3.x.
Preset state is read through DSH's `agentPreset` session projection: the
creation header initializes the state and the newest `agent-preset/selected`
event wins.

The canonical preset id is `ptc`, resolved from DSH's official shipped root
(`standard`, `ptc`, `minimal`, `cordis`). No local preset copy or `code` alias is
shipped. When required, persisted `agentPreset=code` is normalized to `ptc` at
the restore/composition identity seam; new durable facts only write `ptc`.

## Validation

- Gate A validates the real TUI surface with `VirtualTerminal + TuiApp`.
- Gate B first validates the published `pi2dsh` consumer metadata against both
  the exact manifest DSH version and the candidate TUI version. An unsupported
  peer declaration is a release-blocking `ECOSYSTEM_CONTRACT_BLOCKER`, not a
  forced install or a runtime-smoke pass; only then does it run the target DSH
  and `pi2dsh` TTY matrix.
- The runtime-boundary smoke intentionally runs the 0.4 candidate against DSH
  0.1.1 and expects a friendly nonzero rejection, not a raw missing-export
  failure.
