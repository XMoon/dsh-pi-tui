# Local development environment

`dsh-pi-tui` keeps two long-lived worktrees on the development machine:

```text
~/project/dsh-pi-tui       # main: registry-backed DSH (npm mode)
~/project/dsh-pi-tui-next  # next: pinned DSH source distribution (source mode)
```

Each worktree owns its own `node_modules`. The worktrees may share the pnpm
store and the source-pack cache, but a `node_modules` directory must never be
copied or symlinked between them.

## Daily entry point

Run this before coding in either worktree:

```bash
pnpm dev:doctor
```

The doctor is read-only. It reports `READY`, `STALE`, `MISSING`, or `BROKEN`.
For every non-ready result, repair the current worktree with:

```bash
pnpm dev:bootstrap
```

The bootstrap is idempotent. It does not remove `node_modules` or rewrite a
tracked lockfile. The root `pnpm-workspace.yaml` uses
`verifyDepsBeforeRun: warn`: pnpm may report stale dependencies but does not
automatically repair the worktree. Dependency repair remains owned by the
explicit `dev:bootstrap` command. Source-mode shells override this setting to
`false` because their materialized DSH distribution intentionally differs
from the tracked registry metadata.

## Distribution modes

Mode selection is policy-driven, not branch-name-driven:

- A worktree with `test/compat/dsh-mode.json` follows its tracked `mode`
  (`npm` or `source`) — the SINGLE branch-level switch.
- Legacy fallback (checkouts without the mode file): a worktree with
  `test/compat/dsh-source.json` uses source mode; without it, npm mode.
- `DSH_DEV_MODE` or `--mode` can explicitly select a mode for a one-off check.

The main branch intentionally has no mode file and no source-pin file, so
its default remains npm. The next branch carries BOTH tracked files:
`test/compat/dsh-mode.json` (the live switch) and `test/compat/dsh-source.json`
(the source fallback's exact SHA — never deleted, so the branch can flip
back to source with a one-line diff). A main-to-next merge must preserve
that next-only policy rather than adding it to main.

### main / npm mode

The main worktree uses the tracked lockfile and the registry DSH package family.
Bootstrap runs the equivalent of a frozen install only when the local state is
missing or stale:

```bash
cd ~/project/dsh-pi-tui
pnpm dev:doctor
pnpm dev:bootstrap
```

### next / source mode

Flip the tracked policy to source (one line), commit, push:

```diff
- "mode": "npm"
+ "mode": "source"
```

The next worktree then reads the repository and exact 40-character commit SHA
from `test/compat/dsh-source.json`. The source pack cache is keyed by:

```text
repository + exact commit SHA
```

The source cache separates shared Git objects from per-SHA checkouts:

```text
~/.cache/dsh-pi-tui/deepseek-harness.git/
~/.cache/dsh-pi-tui/harness-worktrees/<exact-sha>/
~/.cache/dsh-pi-tui/source-packs/<exact-sha>/
```

The normal flow is:

```bash
cd ~/project/dsh-pi-tui-next
pnpm dev:doctor
pnpm dev:bootstrap
pnpm dev:doctor
```

The second doctor reports `READY` when the source pack and worktree
materialization are correct. If it warns that the source environment is not
loaded, use `source ./.dsh-dev-env` or `pnpm dev:shell` before commands that
need the source-distribution environment.

Bootstrap reuses a valid pack at:

```text
~/.cache/dsh-pi-tui/source-packs/<exact-sha>/
```

On a cache miss it uses a shared bare Harness object repository plus an
independent worktree for the exact SHA, invokes the existing official DSH
build/pack driver, requires a clean/reproducible source identity, validates
the full DSH tarball family and then atomically publishes the cache directory.
Normal source-pack validation checks the manifest, package metadata, and
artifact layout. It intentionally does not inspect every archived file; bad
inputs fail through the normal package/tar read path and are reported to the
user. The disposable staging directory is created beside the final output, so
all validation completes before one same-filesystem atomic rename. Unknown
pack-output entries are rejected; only the official `publish-order.txt`
auxiliary file is removed.
Different SHAs have different worktree paths; multiple agents bootstrapping
the same SHA wait on a per-SHA lock and reuse the first valid result. A
provided `DSH_DIR` is treated as an ephemeral, non-cache build and may be
dirty for deliberate debugging. Its pack is kept under the OS temporary
folder for the current shell, is recorded as ephemeral state, and is never
reported as a durable `READY` environment; normal OS cleanup defines its
lifetime.
An explicitly supplied `--distribution` is read from its existing path rather
than copied; it is always recorded as ephemeral and can never become `READY`.
Invalid or mismatched input fails with an actionable error instead of being
silently repaired.

The worktree materialization uses the existing DSH distribution helper and
its temporary pnpm overrides. Tracked package metadata is restored after the
install, while `node_modules` retains the validated source distribution.

If direnv is unavailable, enter a shell with the generated source environment:

```bash
pnpm dev:shell
```

The generated `.dsh-dev-state.json`, `.dsh-dev-env`, and `.envrc` files are
local-only and ignored by Git. They contain the selected mode, package-manager
and Node identity, lockfile/package hashes, source SHA, source-pack path, and
owning worktree root. Generated environment variables are honored only by that
root, so manually sourcing one worktree's environment cannot select a different
worktree's DSH mode.

## Daily local loop

The next worktree stays on the pinned Source development environment. The
daily loop is:

```bash
cd ~/project/dsh-pi-tui-next
pnpm dev:doctor
```

- `READY` → reuse the current environment and run the normal project checks
  (`pnpm typecheck`, `pnpm test`, targeted tests, `pnpm build`).
- `STALE` / `MISSING` / `BROKEN` → run `pnpm dev:bootstrap`, then
  `pnpm dev:doctor` again, then run the normal project checks.

`dev:bootstrap` is environment preparation only, not a full compatibility
run. It reuses a valid per-SHA source pack from:

```text
~/.cache/dsh-pi-tui/source-packs/<exact-sha>/
```

The cached DSH source pack is rebuilt only when the per-SHA cache is
missing or invalid (a changed pin selects a different cache key).

A stale local development environment may require re-materializing the
worktree with `dev:bootstrap`, but a valid source pack is still reused.

When the source environment must actually be loaded (commands that need the
source-distribution variables), enter it with:

```bash
pnpm dev:shell
```

then continue with the ordinary development commands.

## Full Source compatibility

```bash
pnpm compat:dsh:source -- --dsh-dir "$HOME/project/deepseek-harness"
```

This is the CI-equivalent full Source compatibility proof: exact upstream DSH
source → official build/pack → full DSH family → TUI build/type/test →
candidate/fresh install → runtime/preset compatibility.

It is NOT part of the routine daily loop. Ordinary TUI changes are validated
with the normal project checks inside the existing Source environment. Run
the full verifier only when the change affects the DSH source distribution
boundary (source pin, distribution infrastructure, source/npm discrepancy,
unpublished DSH commit) or when explicitly requested. Pull requests targeting
`next` run this lane in GitHub CI, which is authoritative for routine PR
compatibility.

## Safety rules

- Do not run an ordinary `pnpm install` in the source-mode worktree as a repair.
- Do not use `--force`, delete `node_modules`, or delete `pnpm-lock.yaml` to
  repair source mode.
- Do not copy or symlink `node_modules` from main to next (or the reverse).
- Do not use a branch name or package version as a source-pack cache key.
- Do not modify the real `pi-tui` profile while working on the development
  worktree. The `pi-tui-dev` profile may continue to link the main checkout.
- The managed per-SHA Harness checkout must remain clean. Generated ignored
  build outputs are acceptable; tracked or untracked working-tree changes must
  be removed before a durable source-pack build.

The bootstrap commands pass source-mode pnpm settings to every subprocess, so
an agent does not need to manually reproduce the CI source-distribution flow.
