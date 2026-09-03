# DeepSeek Harness compatibility

This document is the source of truth for the `dsh-pi-tui`/DSH version
boundary.

## Runtime compatibility

| dsh-pi-tui line | DeepSeek Harness line | Policy |
|---|---|---|
| `0.3.x` | `0.1.1` | Supported legacy runtime line |
| `0.4.0-alpha.1` | `>=0.1.2-alpha.2` | Superseded target line; accepts the alpha.2/alpha.3 DSH family |
| `0.4.0-alpha.2` | `>=0.1.2-alpha.4` | Previous 0.4 prerelease; validated the alpha.4/alpha.5 DSH family |
| `0.4.x-alpha` | `>=0.1.2-alpha.4` | Supported target line; each release validates the concrete DSH family |

The 0.4 line has no 0.1.1 runtime shim. An old Harness remains outside the
supported peer window and must fail at the normal incompatible-runtime
boundary. The startup row prints both recovery paths when its concurrent
Loader mount gets to run first, but that friendly notice is best-effort. The
published peer contract intentionally uses a lower bound only: later DSH
versions remain eligible until a concrete compatibility failure is found.

```sh
# 推荐：安装本 TUI 当前验证过的 exact DSH（0.1.2-alpha.5 属于 npm alpha
# channel，不是 latest；exact 版本让恢复目标确定，不随 alpha tag 漂移）
npm install -g @deepseek-ai/dsh@0.1.2-alpha.5

# 或跟随 DSH alpha channel
npm install -g @deepseek-ai/dsh@alpha

npm install -g @xmoon76/dsh-pi-tui@0.3
```

The first command upgrades the Harness for 0.4 (the concrete family validated
by the current Source baseline is `0.1.2-alpha.5`; the peer contract stays
lower-bound-only at `>=0.1.2-alpha.4`). The second pins the compatible
TUI line when the installed Harness must remain on 0.1.1; a Harness on the
alpha.2/alpha.3 baseline instead stays on `@xmoon76/dsh-pi-tui@0.4.0-alpha.1`,
the last line that accepts it. Later DSH versions are
eligible under the lower-bound-only peer contract; each release still runs its
concrete runtime and preset gates. The startup notice only reports versions
below `0.1.2-alpha.4`; an incompatible future runtime fails through the normal
package contract rather than an early TUI-specific API branch. Peer prerelease
tuples are validated separately before each release.

Note that `npm install -g @deepseek-ai/dsh` without an explicit `@alpha`
follows npm's `latest` dist-tag, which is NOT the alpha.5 line — always name
the exact version or the `alpha` channel explicitly.

## Data compatibility

Runtime compatibility and data compatibility are separate. A 0.4 runtime
requires the declared DSH lower bound, but it continues to read
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

## Source Mode validation

Source Mode is a CI and local-validation adapter for an unpublished DSH
checkout. It is not a published package-install mode and it never changes the
package contract or vendors DSH into this repository.

The pin lives in [`test/compat/dsh-source.json`](../test/compat/dsh-source.json)
and contains the full DeepSeek Harness commit SHA and expected version. The
source lane then:

1. checks out that exact SHA;
2. runs the official `pnpm install --frozen-lockfile`, `pnpm build:official`,
   and `pnpm release:pack --family dsh` commands; the temporary consumer install
uses `--no-frozen-lockfile --lockfile=false` so the tracked registry lockfile
cannot be consulted for unpublished DSH metadata;
3. validates the embedded `package/package.json` metadata for the complete DSH
   tarball family required by this TUI; and
4. installs those tarballs through temporary pnpm overrides before running the
   ordinary TUI, preset, and old-runtime checks.

The CI policy is deliberately explicit: `next` pushes and pull requests whose
base is `next` use Source Mode; `main` and every tag, including `next-v*`, use
registry-backed npm mode with a frozen lockfile. The Source Mode ecosystem
check prints `SKIPPED: requires published compatible DSH/pi2dsh combination`
because the published `pi2dsh` bridge cannot prove compatibility against an
unpublished source family. That check remains blocking in npm mode.

For local validation, use the isolated driver rather than workspace symlinks:

```sh
pnpm compat:dsh:source -- --dsh-dir "$HOME/project/deepseek-harness"
pnpm compat:dsh:npm
```

A dirty local DSH tree is allowed only with a visible reproducibility warning;
CI requires a clean checkout. Source-only overrides and generated manifests are
removed with the temporary validation workspace and must never be committed to
`package.json`, the lockfile, or a release tarball.

## Validation

- Gate A validates the real TUI surface with `VirtualTerminal + TuiApp`.
- The independent official-preset gate installs only the exact target DSH and
  candidate artifact, then runs real `standard`/`ptc`/`minimal`/`cordis`
  Agent/Session creation, durable-header, degradation, and `/goal` isolation
  checks. It is runnable without a supported published `pi2dsh` release.
- Gate B separately validates the published `pi2dsh` consumer metadata against
  the exact manifest DSH version and candidate TUI version. An unsupported peer
  declaration is an `ECOSYSTEM_CONTRACT_BLOCKER`, not a forced install or a
  runtime-smoke pass. **Temporarily disabled in CI (2026-09-02):** the
  published `pi2dsh@0.24.0` bridge is runtime-incompatible with the
  `0.1.2-alpha.4` baseline — its `^0.1.2-alpha.1` peers satisfy alpha.4
  semver-wise (so the metadata preflight passes), but the bridge predates the
  alpha.4 Session/subagent APIs and fails the real runtime smoke. The gate is
  switched off (with a documented re-enable procedure in `.github/workflows/ci.yml`)
  until a `pi2dsh` release declares and runs on DSH `>= 0.1.2-alpha.4`; the
  official-preset gate above keeps the real preset coverage meanwhile. The
  local driver (`pnpm smoke:pi2dsh`) remains available for manual runs.
- The runtime-boundary smoke intentionally runs the 0.4 candidate against DSH
  0.1.1 and requires a nonzero unsupported-runtime outcome. Friendly startup
  guidance is asserted when emitted, but raw import failure is accepted because
  DSH Loader mounts profile entries concurrently.
