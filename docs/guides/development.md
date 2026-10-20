# Local development guide

This guide owns the reusable development environment, worktree, build and
debugging procedures. Machine-specific paths are examples, not requirements.

## Worktrees and isolation

The repository uses long-lived `main` (released line, npm mode) and `next`
(forward-integration line, tracked npm/source mode) checkouts. Create additional
worktrees per task; each worktree owns its own `node_modules` and `dist`. The
worktrees may share the pnpm store and source-pack cache, but a `node_modules`
directory must never be copied or symlinked between them.

The root `mise.toml` pins Node 24 (as CI does) and turns on mise's
`idiomatic_version_file_enable_tools` for pnpm, so the pnpm version comes from
`package.json`'s `packageManager`. Run `mise install` once per worktree. When
bumping `packageManager`, commit the regenerated `pnpm-lock.yaml`; pnpm 12 records
the resolved pnpm under `packageManagerDependencies`, and `--frozen-lockfile`
fails without it.

## Daily entry point

```bash
pnpm dev:doctor
```

The doctor is read-only and reports `READY`, `STALE`, `MISSING` or `BROKEN`.
For every non-ready result, repair the CURRENT worktree with:

```bash
pnpm dev:bootstrap
```

The bootstrap is idempotent: it does not remove `node_modules` or rewrite a
tracked lockfile. The root `pnpm-workspace.yaml` uses
`verifyDepsBeforeRun: warn`, so pnpm may report stale dependencies without
repairing them; dependency repair remains owned by `dev:bootstrap`. Source-mode
shells override the setting to `false` because their materialized DSH
distribution intentionally differs from the tracked registry metadata.

## Distribution modes

Mode selection is policy-driven, not branch-name-driven:

- A worktree with `test/compat/dsh-mode.json` follows its tracked `mode` (`npm`
  or `source`) — the SINGLE branch-level switch.
- Legacy fallback (checkouts without the mode file): a worktree with
  `test/compat/dsh-source.json` uses source mode; without it, npm mode.
- `DSH_MODE` or `--mode` explicitly selects a mode for a one-off check; it beats
  the tracked policy.
- `DSH_DEV_MODE` is GENERATED development state (what `dev:bootstrap`
  materialized into `.dsh-dev-env`). It is only a legacy fallback when no tracked
  mode policy exists and never overrides `dsh-mode.json`.

### npm mode

The main worktree uses the tracked lockfile and the registry DSH package family.
Bootstrap runs the equivalent of a frozen install only when the local state is
missing or stale:

```bash
pnpm dev:doctor
pnpm dev:bootstrap
```

### Source mode

Source mode reads the repository and exact 40-character commit from
`test/compat/dsh-source.json`. The source pack cache is keyed by
`repository + exact commit SHA` and separates shared Git objects from per-SHA
checkouts:

```text
~/.cache/dsh-pi-tui/deepseek-harness.git/
~/.cache/dsh-pi-tui/harness-worktrees/<exact-sha>/
~/.cache/dsh-pi-tui/source-packs/<exact-sha>/
```

The normal flow is:

```bash
pnpm dev:doctor
pnpm dev:bootstrap
pnpm dev:doctor
```

The second doctor reports `READY` when the source pack and materialization are
correct. If it warns that the source environment is not loaded, use
`source ./.dsh-dev-env` or `pnpm dev:shell` before commands that need the
source-distribution environment.

Bootstrap reuses a valid pack for the exact SHA. On a miss it uses a shared bare
Harness object repository plus an independent worktree for the SHA, invokes the
official DSH build/pack driver, requires a clean/reproducible source identity,
validates the full tarball family and atomically publishes the cache directory.
The disposable staging directory is created beside the final output so all
validation completes before one same-filesystem rename. Unknown pack-output
entries are rejected; only the official `publish-order.txt` is removed. Different
SHAs have different worktree paths; multiple agents bootstrapping the same SHA
wait on a per-SHA lock and reuse the first valid result. A provided `DSH_DIR` is
an ephemeral, non-cache build and may be dirty for deliberate debugging; it is
never reported as a durable `READY` environment. An explicitly supplied
`--distribution` is read from its existing path, recorded as ephemeral, and can
never become `READY`. Invalid/mismatched input fails with an actionable error
instead of being silently repaired.

The generated `.dsh-dev-state.json`, `.dsh-dev-env` and `.envrc` files are
local-only and ignored by Git. They contain the selected mode, package-manager/
Node identity, lockfile/package hashes, source SHA, source-pack path and owning
worktree root. Generated environment variables are honored only by that root.

## Branch roles and promotion

Branch roles define development and promotion workflow. They do not determine npm
dist-tags; the release workflow derives `latest` vs `next` from the pushed tag
prefix (see [releasing.md](./releasing.md)).

- `main` is the released compatibility line. Its tracked mode is `npm`, and its
  validated DSH target must be a published version.
- `next` is the forward-integration line. It may stay in `npm` mode while a
  published DSH release is being qualified, then switch to `source` mode when
  development moves to an unpublished DSH commit.

The promotion establishes the invariant that both long-lived branches carry
`test/compat/dsh-mode.json` and `test/compat/dsh-source.json`:

- `dsh-mode.json` selects the branch's normal local/CI distribution.
- `dsh-source.json` records the current validated DSH source family, including
  the exact source identity used when Source Mode is selected. npm Mode follows
  the exact DSH version declared in the checkout's `package.json` and frozen
  lockfile.

`main` must keep `mode: "npm"`. `next` may change its mode as upstream
development requires. Release tags always use npm distribution regardless of the
branch development mode.

### Promoting a mature `next` snapshot to `main`

```text
next development
        |
        | decide the intended release scope
        v
next fixed snapshot / promotion branch
        |
        v
A. reserve the release identity
        |
        v
B. qualify the published DSH baseline
        |
        v
C. release-scoped capability development
        |
        v
D. RC freeze
        |
        v
E. final release qualification
        |
        v
F. finalize the release metadata
        |
        +----------------------------->  main
                                         |
                                         +-- verify the merged candidate
                                         |
                                         +-- release tag / publication
                                         |
                                         +------ merge released main ------> next
```

Create the promotion branch from the exact `next` commit:

```sh
git switch next
git pull --ff-only
git switch -c promote/next-to-main-<dsh-release>
```

The version may be reserved early, together with every version-coupled field
(`current.since`, the current row's `tui`, startup guidance, release-note
pairing), atomically. An untagged version is a RESERVED candidate identity, not
evidence the release exists. Reservation is NOT the feature-freeze boundary; the
explicit RC freeze before final qualification is.

Allowed scope on the promotion branch:

- reserve the release identity;
- qualify the target published DSH baseline first (existing TUI behavior,
  upstream contract changes, installation, Source Mode, Direct/Remote seams,
  persistence/native primitives, the old peer floor);
- perform the compatibility migration/cleanup the baseline requires;
- implement release-scoped capabilities with their feature tests;
- fix regressions/blockers discovered during release development;
- enter RC freeze, then run the FINAL qualification against the exact candidate;
- finalize release metadata (bilingual changelogs, release-note guidance,
  release-specific docs), preferably in a dedicated final commit.

Unrelated opportunistic features, next-release work, future unpublished-DSH
adaptations and unrelated cleanup/refactors are prohibited.

After RC freeze, only release blockers, regressions, compatibility/correctness
fixes, packaging, test/gate fixes, documentation corrections and release
metadata are accepted. A significant new capability reopens the release scope and
invalidates/restarts the affected final-qualification evidence.

Merge the promotion with a normal merge commit; do not squash it. Preserve
ancestry for later `main -> next` synchronization. After promotion, verify the
merged state, tag the verified commit, publish through the tag workflow, and
merge the released `main` back into `next`. Never reset `next` to `main`; when a
newer `next` source target exists, never replace it with the older published
target during the back-merge.

Normal changes start from `main` and merge forward into `next`. Next-only work
(an unpublished DSH API/behavior) stays on `next` until the next promotion. Do
not copy commits independently into both branches.

### New-DSH-capability peer-floor decisions

- **Optional capability:** the TUI works on the old floor and the new feature is
  additive. The floor may stay, but the implementation must use a real
  capability/version boundary, must not unconditionally import/use an API absent
  from the old floor, and must prove BOTH states.
- **Mandatory release contract:** the release cannot work without the newer API.
  Raise the peer floor with the failing seam/call site as evidence; do not keep
  an old floor for compatibility optics.

## Build order

The root bundle embeds `@xmoon76/pi-tui`, so build the fork first:

```text
fork typecheck -> root typecheck -> fork tsdown -> root tsdown
```

```bash
pnpm typecheck:fork
pnpm typecheck
pnpm build
```

Building only the root can embed a stale fork `dist`. Never test a stale fork
dist and never share/symlink a whole `node_modules` between worktrees.

## Diagnosing unpublished/local DSH targets

Generic failure classification:

| Symptom | Meaning | Action |
|---|---|---|
| `E404` | The version is not published in the configured registry | Do not downgrade the target; check the registry/pin |
| `ERR_MODULE_NOT_FOUND` | Unbuilt/omitted package or invalid `exports` | Build the family; inspect package exports |
| `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` | A profile is loading TypeScript from `node_modules` | Use the source-mode distribution, not raw TS |
| `ERR_PNPM_TARBALL_URL_MISMATCH` | pnpm cannot verify an unpublished/local tarball | Preserve the lockfile; use the Source Mode helper |
| `Cannot read properties of undefined (reading 'prepare')` on first tool call | Duplicate `@deepseek-ai` copy in the profile | Remove the duplicate; the profile must resolve the Host family as peers |
| Two standing-mount failures while typecheck/most tests pass | Split `dsh-scope` identity between independently built artifacts | Inspect package duplication/exports resolution; fix the DSH build topology |
| `ENOSPC` | Environment/disk | Free space; do not patch dependencies |

The duplicate `dsh-scope` symptom: independently built/linked DSH artifacts each
carry a private `Symbol('dsh.scope')`, so a carrier from one copy is invisible to
another. This is a DSH build/package topology problem (one shared identity), not
a TUI preset bug. Do not commit a temporary `Symbol.for` diagnostic edit into
DSH or this repository.

Never rewrite `package.json` or the lockfile with `file:`/`link:`/`workspace:`
specs to route around an unpublished package.

## Cleanup before committing

Validation leaves generated artifacts. Restore temporary DSH-checkout edits,
delete generated source overrides/manifests and unused `dist`/tarballs, then:

```bash
git status --short --branch
git ls-files --others --exclude-standard
git diff --check
```

Local DSH links, generated `dist`, isolated homes, logs and `.tgz` files are
validation artifacts, never release contents. They must not remain in
`package.json`, the lockfile or a release tarball.

## Offline and packaged verification

When peer packages are unavailable:

```bash
TARBALL_SMOKE_SKIP_INSTALL=1 node scripts/tarball-smoke.mjs <tgz>
```

This checks structure/content only; re-run without the skip once the family is
published. The official-presets smoke with `--distribution` boots `standard`,
`ptc`, `minimal` and `cordis` explicitly (a standard-only boot can hide a missing
Host service). The `pi2dsh` check always runs against the published ecosystem —
it installs the published DSH and pi2dsh from the registry — so it refuses a
source pack and reports that combination as a SKIP. A SKIP is not a pass, the
npm lane must not run against source tarballs, and the gate is blocking in
both modes.

## Benchmarks and profilers

Benchmark entry points:

- `pnpm bench` — full sweep;
- `pnpm bench:fast` — short sweep;
- `pnpm bench:smoke` — reduced sweep, exercised by `test/tooling/bench-smoke.test.mjs`.

They are observational, manual and non-default. Compare on the same machine and
Node version after `pnpm build`; `bench:smoke` asserts no timing threshold. Never
turn a wall-clock number into a CI gate, and never compare numbers across
machines or Node versions.

Surviving regression gates are structural:

- structural work counters and ordered production call traces (for example
  `test/transcript-history-extension.test.ts` asserts
  `moveOlder → capture → repaint → restore:top`, not a threshold;
  `test/fullscreen-scroll-geometry-epoch.test.ts` pins the row-map contract);
- `DSH_TUI_SCROLL_PROFILE=1` emits one stderr line per coalesced scroll frame
  (latency, write, snapshot stages, bytes, rowsRW);
- `DSH_TUI_RENDER_PROFILE` covers transcript presentation commits.

Both profilers are opt-in diagnostics. Benchmark/probe harnesses must use
explicit positive bounds (`MAX_LINES`/`MAX_FRAMES`), a per-worker timeout and a
hard memory cap. Never write `for (i = 0; i < args.lines || 300; ...)` — when
`--lines` is omitted the condition is always true. Run heavy probes under a hard
memory/time bound (for example `systemd-run --user --scope -q
-p MemoryMax=2G -p MemorySwapMax=0 timeout 600 <cmd>`).

## Running the source-built DSH interactively

For source-mode interactive testing, use the worktree's own built DSH CLI, a
built TUI bundle and an isolated profile that links that bundle:

```bash
export DSH_NEXT_ROOT=<source-mode worktree>
export DSH_HOME=<isolated home>
cd "$DSH_NEXT_ROOT"
pnpm dev:bootstrap
source ./.dsh-dev-env
pnpm build
"$DSH_NEXT_ROOT/node_modules/.bin/dsh" plugin --profile pi-tui -- add 'link:.'
cd -
exec "$DSH_NEXT_ROOT/node_modules/.bin/dsh" --profile pi-tui "$@"
```

- Keep `DSH_HOME` isolated from the real `~/.dsh`; the `pi-tui` profile inside it
  is a `link:.` to the worktree, so the plugin add must run from that root.
- dsh treats the startup cwd as the workspace, so the final `exec` runs from the
  caller's directory.
- After changing `packages/pi-tui/src`, run `pnpm build` explicitly (the root
  bundle embeds the fork dist).
- Authentication: a fresh isolated home has none. Configure it yourself, or copy
  the approved credential/profile inputs only with explicit permission, preserve
  `0600`, keep `sessions/`/`storages/`/`user-history/` fresh, and never inspect or
  display copied contents.

## Full Source compatibility

```bash
pnpm compat:dsh:source -- --dsh-dir "/path/to/deepseek-harness"
```

This is the CI-equivalent full Source compatibility proof: exact upstream source
→ official build/pack → full family → TUI build/type/test → candidate install →
runtime/preset compatibility. It is NOT part of the routine loop. Run it only
when the change affects the DSH source/distribution boundary (source pin, target
metadata, distribution infrastructure, source/npm discrepancy, unpublished
commit) or when explicitly requested. GitHub CI is authoritative for routine PR
compatibility.

## Safety rules

- Do not run an ordinary `pnpm install` in a source-mode worktree as a repair.
- Do not use `--force`, delete `node_modules` or delete `pnpm-lock.yaml` to repair
  source mode.
- Do not copy or symlink `node_modules` between worktrees.
- Do not use a branch name or package version as a source-pack cache key.
- Do not modify the real `pi-tui` profile during development.
- The interactive source launcher must use an isolated `DSH_HOME`.
- The managed per-SHA Harness checkout must remain clean (ignored build outputs
  are acceptable).
- Background bash jobs may ignore the `workdir` parameter; prefix them with an
  explicit `cd <repo> && ...` when the checkout matters.
- The node `--test` spec reporter is unreliable for the full suite; for full
  acceptance use TAP and require `# fail 0`. The spec reporter is fine for a
  single file or a small explicit list.
