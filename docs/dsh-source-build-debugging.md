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

The DSH packages export built `lib` artifacts. Source Mode deliberately uses
the upstream release commands so the validation boundary matches the artifact
that DSH publishes:

```sh
cd "$DSH_SOURCE"
node --version                 # DSH supports ^22.19.0 or >=24.0.0
pnpm install --frozen-lockfile
pnpm clean                     # remove stale local generated state only
pnpm build:official
pnpm release:pack --family dsh --out "$TMPDIR/dsh-source-pack"
```

`dsh-source-pack.mjs` performs this sequence, validates the exact checkout SHA,
reads package identity from each tarball's embedded manifest, removes the
registry-only `publish-order.txt`, and writes the source distribution manifest.
For the complete isolated TUI flow use `pnpm compat:dsh:source`; do not replace
it with direct workspace links. If the official pack already exists, reuse it
without rebuilding DSH:

```sh
pnpm compat:dsh:source -- \
  --distribution "$TMPDIR/dsh-source-pack" \
  --skip-runtime
```

The DSH checkout is required only when building a new pack; manifest-only
verification can reuse a downloaded distribution without `--dsh-dir`. Do not
start two Source Mode drivers against the same output directory at once.

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
packages. Source Mode therefore uses the official DSH release tarballs, not
workspace symlinks:

```sh
cd "$TUI_ROOT"
pnpm dsh:source:pack -- --dsh-dir "$DSH_SOURCE" --out "$TMPDIR/dsh-source-pack"
pnpm prepare:dsh:test -- \
  --mode source \
  --distribution "$TMPDIR/dsh-source-pack" \
  --workspace "$TUI_ROOT" \
  --config test/compat/dsh-source.json
```

`prepare-dsh-test-environment.mjs` validates the manifest and every embedded
`package/package.json`, writes a marked temporary pnpm override block, installs
with `--no-frozen-lockfile --lockfile=false` (the temporary source lane must not
consult the registry lockfile), and verifies that the installed DSH packages
came from local `.tgz` files. The tracked `package.json` and lockfile are never
rewritten with `file:`, `link:`, or `workspace:` dependency specs. The source
pack itself contains only the official `.tgz` family plus
`dsh-source-distribution.json`.

Do not use workspace symlinks as compatibility evidence. They bypass the
published package boundary and can resolve against the wrong worktree. A
missing module in the tarball flow usually means one of three things:

1. the pinned DSH package was not built;
2. the package was omitted from the official family pack; or
3. the package's embedded `exports` map points at a stale or source-only path.

A real DSH profile must not contain an extra `node_modules/@deepseek-ai` tree:
in-box packages must resolve from the DSH installation itself. A duplicated
profile copy can fail on the first tool call with an error such as `reading
prepare`.

## pnpm and unpublished-version traps

The repository's pnpm setup verifies dependency metadata before running many
scripts. With unpublished target versions, a plain registry install can report
`ERR_PNPM_TARBALL_URL_MISMATCH`. In Source Mode, run the preparation helper
first; it installs the complete tarball family through temporary overrides and
then checks the actual installed paths. Do not rewrite the lockfile, downgrade
the DSH version, or restore a workspace-link workaround when a registry
resolution is attempted.

For a diagnostic run that already has a prepared source workspace, call the
installed binaries directly if pnpm's command wrapper performs an unrelated
registry check:

```sh
node --test test/*.test.ts test/*.test.mjs
node_modules/.bin/tsc -p tsconfig.json --noEmit
node_modules/.bin/tsdown
```

The production dependency audit can still run independently of the missing
alpha tarballs:

```sh
pnpm audit --prod --audit-level high
```

## Test sequence

With the DSH tarball family built and the temporary source overrides prepared:

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
node scripts/official-presets-smoke.mjs \
  ./xmoon76-dsh-pi-tui-*.tgz \
  --distribution "$TMPDIR/dsh-source-pack"
```

It installs the exact source tarball family into an isolated DSH profile and
boots `standard`, `ptc`, `minimal`, and `cordis` explicitly with `--preset`;
this catches a missing Host service that a standard-only boot would hide. The
published `pi2dsh` consumer check is intentionally skipped for Source Mode and
must print `SKIPPED: requires published compatible DSH/pi2dsh combination`.
Run `node scripts/pi2dsh-compat-smoke.mjs` without `--distribution` only for the
npm lane, using the exact published versions from `test/compat/pi2dsh.json`.

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
  target tarball. Preserve the tracked lockfile and use the Source Mode helper,
  which disables lockfile resolution only in its temporary install.
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

# Remove any generated source override/manifest files when they are not needed.
# Remove generated dist/tarball files when they are not needed for another gate.

cd "$TUI_ROOT"
git status --short --branch
git ls-files --others --exclude-standard
git diff --check
```

The final TUI status must contain only intentional source/documentation changes.
Local DSH links, generated `dist` directories, isolated homes, debug logs, and
`.tgz` files are validation artifacts, never release contents.
