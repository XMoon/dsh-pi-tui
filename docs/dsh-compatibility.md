# DeepSeek Harness compatibility

This document is the source of truth for the `dsh-pi-tui`/DSH version
boundary.

## Runtime compatibility

The DSH versions below are the published tags in the official [DeepSeek Harness
release list](https://github.com/deepseek-ai/deepseek-harness/releases). Each
fallback was checked against the peer manifest at its corresponding TUI tag.

| dsh-pi-tui line | Official DeepSeek Harness tags for the recommended pairing | Policy |
|---|---|---|
| `0.2.x` (latest `v0.2.2`) | `dsh-v0.1.0-rc.8` | Legacy runtime line |
| `0.3.x` | `dsh-v0.1.1-rc.1`, `dsh-v0.1.1-rc.2` | Legacy runtime line |
| `0.4.0-alpha.1` | `dsh-v0.1.2-alpha.2`, `dsh-v0.1.2-alpha.3` | Earlier 0.4 prerelease |
| `0.4.0-alpha.2` | `dsh-v0.1.2-alpha.4`, `dsh-v0.1.2-alpha.5` | Previous 0.4 prerelease |
| `0.4.1` (published) | `dsh-v0.1.2-rc.1` | Historical stable |
| `0.4.3-alpha.2` (historical next npm line) | `dsh-v0.1.3-alpha.2` | Last official runtime tag for this TUI line |
| `0.4.5` (published stable) | `dsh-v0.1.5-rc.1`, `dsh-v0.1.5-rc.2` | Current stable; validated against the published npm rc.1 family |
| `next` npm line (current checkout) | `dsh-v0.1.5-rc.1`, `dsh-v0.1.5-rc.2` | Same target while the next prerelease is being qualified |
| No historical fallback | `dsh-v0.1.0-rc.7`, `dsh-v0.1.2-alpha.1`, `dsh-v0.1.3-alpha.1`, `dsh-v0.1.5-alpha.1`, `dsh-v0.1.5-alpha.2` | Upgrade DSH to a supported release |

The table is keyed to the official release tags above. Do not widen a pairing
from a package peer lower bound alone: npm/node-semver excludes a prerelease
whose major/minor/patch tuple differs from the comparator's prerelease tuple.
For example, `>=0.1.2-rc.1` does not include `0.1.3-alpha.1`, and
`^0.1.1-rc.1` does not include `0.1.2-alpha.1`. The 0.4.5 release raises the
floor to the published npm `0.1.5-rc.1` release; the open peer range also
accepts the compatible `0.1.5-rc.2` family. Its startup notice is best-effort
because Loader rows mount concurrently. The floor is a registry release, so
the notice suggests the exact npm upgrade target.

For the current stable 0.4 line, install the recommended DSH family and the
stable TUI. DSH `0.1.5-rc.1` is the minimum; `0.1.5-rc.2` is also compatible.
The recommended install command explicitly allows the DSH native install
scripts:

```sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs,fs-ext @deepseek-ai/dsh@0.1.5-rc.2
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@latest
```

The current `next` checkout is npm mode. Use the isolated npm driver, which
installs the exact DSH version declared by the checkout's `package.json`
(`0.1.5-rc.1`) from the public registry and exercises the TUI build/test/
package path:

```sh
pnpm compat:dsh:npm
```

The startup notice on an old runtime suggests the exact published upgrade:

```sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs,fs-ext @deepseek-ai/dsh@0.1.5-rc.2
```

If the official `dsh-v0.1.0-rc.8` runtime must be kept, use the compatible
0.2 TUI line:

```sh
npm install -g @deepseek-ai/dsh@0.1.0-rc.8
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.2
```

For official `dsh-v0.1.1-rc.1` or `dsh-v0.1.1-rc.2`, use the compatible 0.3
TUI line:

```sh
npm install -g @deepseek-ai/dsh@0.1.1-rc.1
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.3
```

The historical 0.4.1 stable pair uses the concrete `dsh-v0.1.2-rc.1` tag.
Official `dsh-v0.1.2-alpha.2`/`alpha.3` use
`@xmoon76/dsh-pi-tui@0.4.0-alpha.1`, `alpha.4`/`alpha.5` use
`@xmoon76/dsh-pi-tui@0.4.0-alpha.2`, and `dsh-v0.1.3-alpha.2` uses
`@xmoon76/dsh-pi-tui@0.4.3-alpha.2`. The current npm-mode checkout is
separate: its peer floor is `>=0.1.5-rc.1`, and its exact npm family is
verified by the frozen lockfile.

The root README intentionally uses DSH's moving `latest`/`alpha` channels for
ordinary stable/preview installs; the exact release pairing and compatibility
checks in this document and the dated changelogs remain pinned. For a
reproducible release verification, always name a published version explicitly.

## Data compatibility

Runtime compatibility and data compatibility are separate. A 0.4 runtime
requires the declared DSH lower bound, but it continues to read
sessions created by 0.3.x. The minimum DSH `0.1.5-rc.1` runtime persists
Session V2; compatible `0.1.5-rc.2` persists Session V3 and owns the V2-to-V3
migration when an older session is opened.
Preset state is read through DSH's `agentPreset` session projection: the
creation header initializes the state and the newest `agent-preset/selected`
event wins.

The canonical shipped preset ids are `standard`, `ptc`, `minimal`, and `cordis`,
resolved from DSH's official shipped root. No local preset copy or `code` runtime
alias is shipped. DSH's V2→V3 migration owns historical session header and
`agent-preset/selected` conversion from `code` to `ptc`; the current projection
therefore preserves a native custom preset literally named `code`. Only an
omitted legacy settings default is mapped to `ptc` after the current roster
proves that `code` is absent; new command/config writes are validated against the
roster before they are saved.

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

The CI policy is deliberately explicit: pushes to `next` and pull requests
whose base is `next` follow the tracked `test/compat/dsh-mode.json` policy;
`main` and every tag, including `next-v*`, always use registry-backed npm mode
with a frozen lockfile. Source Mode builds and validates the pinned source
family from `test/compat/dsh-source.json`'s `expectedVersion`; npm Mode uses the
exact DSH version declared by the checkout's `package.json` and resolved by its
frozen lockfile. The Source Mode ecosystem check prints
`SKIPPED: requires published compatible DSH/pi2dsh combination` because the
published `pi2dsh` bridge cannot prove compatibility against an unpublished
source family. That check remains blocking in npm mode.

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
- **Second, independent Gate B blocker (extension API v2).** The published
  `pi2dsh@0.24.0` bridge hard-gates the host API version
  (`api().apiVersion !== 1` ⇒ it refuses to host Pi components), and the
  candidate now reports **API v2** (`docs/extension-api.md`). The pinned
  consumer therefore also needs a v2-aware release; its manifest
  (`test/compat/pi2dsh.json`) keeps recording `apiVersion=1` because that is
  the consumer's own requirement — never silently rewritten to match this
  host. Re-enabling Gate B requires a `pi2dsh` release that accepts API v2.
- The runtime-boundary smoke intentionally runs the 0.4 candidate against DSH
  0.1.1 and requires a nonzero unsupported-runtime outcome. Friendly startup
  guidance is asserted when emitted, but raw import failure is accepted because
  DSH Loader mounts profile entries concurrently.
