# Building and debugging against a local DSH checkout

This runbook records the local-source workflow used while migrating
`dsh-pi-tui` 0.4 to DSH `0.1.2-alpha.1`. It is intentionally separate from the
runtime compatibility policy in [`dsh-compatibility.md`](./dsh-compatibility.md):
this page explains how to build and diagnose an unpublished DSH package family,
not how users install the released products.

## Why source validation was needed

During the migration, the target DSH packages were not available from the
public npm registry:

```text
@deepseek-ai/dsh@0.1.2-alpha.1              E404
@deepseek-ai/dsh-agent-presets@0.1.2-alpha.1 E404
```

The lockfile therefore remains pinned to the intended release versions, while
local validation consumes the verified DSH checkout. Do not replace the target
versions with an older published version just to make a local install pass:
that tests a different API contract.

The two repositories used in the source validation were:

```sh
export DSH_SOURCE="$HOME/project/deepseek-harness"
export TUI_ROOT="$HOME/project/dsh-pi-tui-dsh-1.2"
```

Use an independent checkout for each repository. Do not share or symlink a
whole `node_modules` directory between worktrees; pnpm workspace links and
relative paths then resolve against the wrong checkout.

## Build order

The DSH packages export built `lib` artifacts. Build the DSH source before
trying to compile or run the TUI:

```sh
cd "$DSH_SOURCE"
node --version                 # DSH supports ^22.19.0 or >=24.0.0
pnpm install --frozen-lockfile
pnpm build:lib                 # host and client library artifacts
pnpm build                     # full DSH application/profile artifacts, if needed
```

For a TUI-only source check, the useful order is:

```sh
cd "$TUI_ROOT"
node_modules/.bin/tsc -p packages/pi-tui/tsconfig.json --noEmit
node_modules/.bin/tsc -p tsconfig.json --noEmit
(
  cd packages/pi-tui
  ../../node_modules/.bin/tsdown
)
node_modules/.bin/tsdown
```

Build the vendored fork first because the root bundle embeds
`@xmoon76/pi-tui`; building only the root package can leave the bundle using an
older fork `dist`.

## Connecting the TUI tests to DSH source artifacts

Every `@deepseek-ai/*` import in the TUI is peer-owned. The package is supposed
to resolve those modules from the DSH host, not bundle or publish duplicate DSH
packages. For source-only tests, create temporary links for the built DSH
package directories in the TUI checkout's `node_modules`:

```sh
python3 - <<'PY'
from pathlib import Path
import json
import os

source = Path(os.environ['DSH_SOURCE'])
target = Path(os.environ['TUI_ROOT']) / 'node_modules'
for base in ('packages', 'vendor'):
    for manifest in (source / base).glob('**/package.json'):
        try:
            package = json.loads(manifest.read_text())
        except Exception:
            continue
        name = package.get('name')
        if not isinstance(name, str) or not name.startswith('@deepseek-ai/'):
            continue
        destination = target / name
        if destination.exists() or destination.is_symlink():
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.symlink_to(manifest.parent, target_is_directory=True)
PY
```

These are validation links only. They must not be committed, and they must not
be installed into a real DSH profile. In particular, a real profile should not
contain an extra `node_modules/@deepseek-ai` tree: in-box packages must resolve
from the DSH installation itself. A duplicated profile copy can fail on the
first tool call with an error such as `reading prepare`.

After linking, verify the package exports point at built files and that the
corresponding `lib` directories exist. A missing module usually means one of
three things:

1. the DSH package was not built;
2. the package was omitted from the temporary link set; or
3. the package's `exports` map points at a stale or source-only path.

## pnpm and unpublished-version traps

The repository's pnpm setup verifies dependency metadata before running many
scripts. With unpublished target versions, that verification can report
`ERR_PNPM_TARBALL_URL_MISMATCH` and remove or replace temporary local links.
For a source-linked validation run, either bypass the verification step for
that invocation or call the installed binaries directly:

```sh
PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false node --test test/*.test.ts test/*.test.mjs
node_modules/.bin/tsc -p tsconfig.json --noEmit
node_modules/.bin/tsdown
```

The uppercase variable is deliberate: it is the pnpm configuration spelling
that worked for the local command chain. If a pnpm command still performs a
registry resolution, do not rewrite the lockfile or downgrade the DSH version;
restore the local links and use the direct binary path instead.

The production dependency audit can still run independently of the missing
alpha tarballs:

```sh
pnpm audit --prod --audit-level high
```

## Test sequence

With DSH artifacts built and temporary links present:

```sh
cd "$TUI_ROOT"

# Root migration and DSH-contract tests.
node --test test/*.test.ts test/*.test.mjs

# Vendored fork tests, without pnpm's registry verification wrapper.
node --test packages/pi-tui/test/*.test.ts

# Static and packaging checks.
node --test docs/tmux/*.test.mjs
node scripts/naming-gate.mjs
node scripts/client-boundary-gate.mjs
node --import tsx/esm scripts/check-host-keybindings.mts
git diff --check
```

The target-profile smoke is a separate level of evidence:

```sh
node scripts/pi2dsh-compat-smoke.mjs
```

It installs the candidate into an isolated DSH profile and drives the TUI in
`tmux`. The migration version also boots `standard`, `ptc`, `minimal`, and
`cordis` explicitly with `--preset`; this catches a missing Host service that a
standard-only boot would hide. It must be run against the exact published DSH
and `pi2dsh` versions from `test/compat/pi2dsh.json`, not against a locally
substituted older DSH.

For a packed artifact, run the structure/content checks offline when the target
peer packages are unavailable:

```sh
TARBALL_SMOKE_SKIP_INSTALL=1 node scripts/tarball-smoke.mjs ./xmoon76-dsh-pi-tui-*.tgz
```

Once the target DSH packages are published, rerun the same smoke without
`TARBALL_SMOKE_SKIP_INSTALL=1`, then run the target-profile smoke and the old-
runtime rejection smoke. See [`releasing.md`](./releasing.md) for the release
sequence.

## The duplicate `dsh-scope` symptom

The local DSH build exposed an upstream packaging/topology issue that is easy
to misdiagnose as a TUI preset bug. Several independently linked generated DSH
artifacts contained private copies of:

```ts
const kScope = Symbol('dsh.scope')
```

A scope carrier created by one copy was consequently invisible to another copy.
The observable result was exactly two failures in standing-mount tests, while
ordinary typechecks and most runtime tests passed.

For diagnosis only, the session temporarily changed the **generated local DSH
artifacts** from `Symbol("dsh.scope")` to `Symbol.for("dsh.scope")`, reran the
suite, and restored every artifact byte-for-byte afterward. With that temporary
correction, the complete root suite passed. This was not a TUI fix and must not
be committed or copied into the DSH source as a product workaround.

The durable fix belongs in the DSH build/package topology: the runtime must
have one shared `dsh-scope` identity. If this symptom appears again, first
inspect package duplication and `exports` resolution before changing preset
composition or Host rows.

## Failure classification from the migration session

- **`E404` for `0.1.2-alpha.1`:** The target package is not published in
  the configured registry. Use verified local source artifacts; do not alter the
  target contract.
- **`ERR_MODULE_NOT_FOUND`:** A package is unbuilt, missing from the temporary
  links, or has an invalid `exports` target. Inspect its `package.json` and
  `lib`.
- **`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`:** A profile is loading
  TypeScript from `node_modules`; build the package and consume its compiled
  export.
- **`ERR_PNPM_TARBALL_URL_MISMATCH`:** pnpm cannot verify an unpublished/local
  target tarball. Preserve the lockfile and use the direct binary or the
  verification override for local testing.
- **`reading prepare` on the first tool call:** A duplicate `@deepseek-ai`
  package was installed in the DSH profile. Remove the profile copy and let DSH
  resolve its in-box packages.
- **Standing-mount failures involving scope identity:** Independently built
  package copies have split the private `dsh-scope` symbol. Confirm the
  artifact topology; do not patch TUI preset rows.
- **`ENOSPC` while creating an isolated smoke fixture:** The test environment
  ran out of disk space, not necessarily a code failure. Remove temporary DSH
  homes, fixture directories, tarballs, and caches, then rerun.

## Cleanup checklist

Before committing TUI changes:

```sh
# Restore any temporary edits made inside the DSH checkout.
git -C "$DSH_SOURCE" status --short

# Remove source-validation links if they are not ignored by the checkout.
# Remove generated dist/tarball files when they are not needed for another gate.

cd "$TUI_ROOT"
git status --short --branch
git ls-files --others --exclude-standard
git diff --check
```

The final TUI status must contain only intentional source/documentation changes.
Local DSH links, generated `dist` directories, isolated homes, debug logs, and
`.tgz` files are validation artifacts, never release contents.
