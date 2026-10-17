# Gate-3B qualification log

## Execution environment

- Worktree/branch: `/home/xmoon/project/dsh-pi-tui-wt/gate3b`, `audit/gate3b-closure-20261016`, based on the verified `origin/next` tree. Exact immutable baseline/current revision is in the PR body; repository policy keeps commit SHAs out of `docs/**`.
- Package: `@xmoon76/dsh-pi-tui` `0.5.1`; Node `24.21.0`; `packageManager` pins pnpm `11.7.0`, which the top-level worktree CLI/doctor used.
- The isolated `compat:dsh:npm` helper resolved its internal installer to pnpm `12.11.2`; that PASS covers the frozen npm dependency/tarball path, not proof that the nested installer used the `11.7.0` pin.
- DSH distribution: tracked mode `npm`; resolved DSH family `0.2.0-rc.2`; workspace DSH resolution correct.
- `pnpm dev:doctor`: `READY` after refreshing the local state for the test-only package manifest changes with `pnpm dev:bootstrap`. The package install used the frozen lockfile and completed. The pnpm launcher emitted a `minimumReleaseAge` node_modules/lockfile warning; it is recorded rather than represented as a product-test result.
- Direct is the production backend; Remote remains experimental. No real terminal M evidence is available.

## Targeted delta evidence

| Command / witness | Result | Scope and limits |
|---|---|---|
| `pnpm dev:bootstrap` then `pnpm dev:doctor` | PASS; doctor reports `READY` | Refreshed npm-mode local state after the testing dependencies changed. |
| `node --import tsx/esm --test test/job-command-reader.test.ts` (initial run) | Exposed one assertion mismatch in the held Command-copy test; the Bash and Pwsh J-02 producer witnesses passed in that run. | The assertion expected a `Command` prefix on the Command document body; the actual screen correctly paints `Full command` followed by the raw document. No product code changed. |
| `node --import tsx/esm --test --test-name-pattern='C-01 Command Copy All keeps the trigger label' test/job-command-reader.test.ts` | PASS after correcting the assertion to check the actual document bytes | Re-runs the changed held-copy regression. |
| `node --import tsx/esm --test test/job-command-reader.test.ts` (after bootstrap) | PASS | Requalifies the full changed test file, including both official producer witnesses and the held-copy regression. |
| `node --import tsx/esm --test --test-name-pattern='P16:' test/remote-m3a-semantics-smoke.test.ts` (after bootstrap) | PASS | Exercises the real Remote `/settings` path, Host authority reread, and new same-Host/same-field Direct↔Remote parity witness. |

The J-02 fixture uses the official published Bash/Pwsh producer packages and real Registry/JobController/Direct observation/TUI path. Its `ShellExecutor` is deliberately controlled, so it proves producer label/dataflow, not actual OS shell execution. The Remote Command Copy All L6 witness in `test/runner-remote-job-viewer.test.ts` seeds a real Host Job label directly; it is a distinct consumer-path witness, not a same-run official-producer Remote proof. M-01 remains `NOT_RUN`.

## Prior CI evidence and reuse boundary

Baseline GitHub Actions on the prior `next` integration tree reported green. It is historical evidence only, not a same-tree pass for this closure branch; the exact run pointer is recorded in the PR body. Source-mode-only checks were skipped because this worktree is in npm mode; `skipped` is not `PASS`.

## Frozen-tree stage-final validation

**Result on the current worktree:** the single `pnpm verify:prepush` run passed its pre-pack sublanes and build, then stopped at `typecheck:bundle` on TS7006 for the new test fixture's untyped `runMaintenance` callback. The callback received an explicit `AbortSignal` type; `pnpm typecheck:bundle` and the previously unexecuted `pnpm test:product` then passed separately. The composite was not rerun, avoiding repetition of already-green lanes. The independent npm compatibility path also passed its frozen install, package and smoke checks.

| Lane | Result | Notes |
|---|---|---|
| `pnpm verify:prepush` | FAIL at `typecheck:bundle` (first run) | The one-line test type issue was corrected and its failed/unexecuted sublanes passed separately. PR CI remains the full composite check. |
| `pnpm typecheck:bundle` | PASS after correction | Reran only the failed typecheck sublane on the corrected test tree. |
| `pnpm test:product` | PASS after correction | Reran the product suite omitted when the composite stopped. |
| `pnpm compat:dsh:npm` | PASS | Frozen npm dependency install and isolated package/smoke path passed; its internal installer resolved pnpm `12.11.2` (see environment note above). |
| `pnpm gate:keybindings` | PASS via `verify:prepush` | The gate ran before the type-only test correction; its `src/**` input is unchanged. |
| `pnpm gate:boundary` | PASS via `verify:prepush` | The gate ran before the type-only test correction; its production-source input is unchanged. |
| `pnpm gate:architecture` | PASS via `verify:prepush` | The gate ran before the type-only test correction; its production-source input is unchanged. |
| `node scripts/check-no-session-events.mjs` | PASS via `verify:prepush` | The guard scans `src/**`; its input is unchanged. |
| `pnpm gate:dsh-preset-parity` | PASS | Standalone parity check on the current worktree. |
| `pnpm smoke:remote-d2-fork` | PASS | Required local Remote/D2 fork migration smoke. |
| `pnpm smoke:remote-session-lifecycle-parity` | PASS | Required local Remote session lifecycle parity smoke. |
| `pnpm test:docs` | PASS | Rerun after this final qualification-record update. |
| `git diff --check` and `git diff --cached --check` | PASS | Checked after the final documentation update; no staged changes were present. |

Mode-gated source checks remain `NOT_RUN (mode=npm; CI step skipped)`, not PASS. The current PR CI must independently report its applicable jobs. Artifact/build consumers were run serially.

## Manual qualification

`M-01..M-04` and `M-06..M-07`: `NOT_RUN (ENV_UNAVAILABLE)`. `M-05`: `PARTIAL` — an isolated npm-mode tmux 3.5a run on Linux/WSL2 at Main 80×24 used a real model-backed Bash Job and a synthetic two-line CJK draft. Captures show the unselected and selected Full-action row spacing at `temp/gate3b-tmux-manual.SfRsEf/artifacts/quick-active-live.txt` and `quick-open-full-selected.txt`. Full Task Center activation was inconclusive; Fullscreen, widgetsBelow variants, other sizes, clicks, wheel and resize remain unrun. The disposable DSH_HOME and copied credentials were removed after the run; original profile files were untouched. See [manual-terminal-checklist.md](manual-terminal-checklist.md). No Owner waiver exists; closure remains `PENDING_MANUAL`.
