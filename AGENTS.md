# AGENTS.md

`dsh-pi-tui` is a third-party TUI mode for DeepSeek Harness (`dsh`). Read this file
before editing. Read subsystem docs only when the task touches that subsystem.

## Execution discipline

- **Stay in scope.** Do only the requested work; report unrelated bugs, cleanup opportunities, refactors, or improvements separately; do not implement them unless required by the task.
- **Investigation is read-only by default.** Review, investigate, compare, assess, research, and planning requests do not authorize source changes.
- **Prefer the smallest sufficient change.** Do not introduce speculative abstractions, APIs, hooks, dependencies, compatibility layers, or future migration work.
- **Do not fix unrelated pre-existing failures.** Distinguish them from
  regressions caused by the current work and report them separately.
- **Do not hide contradictions.** Prefer fast failure over silent defaults, broad catches, speculative fallbacks, or validation for states guaranteed by internal contracts. Validate at real system boundaries.
- **Never push or force-push without explicit user approval.** Local commits are allowed when appropriate; remote changes are not.

## Repository documentation policy (hard gate)

Repository `docs/` contains ONLY durable, cross-version technical facts,
current load-bearing architecture/behavior contracts, and reusable procedures.
A contract may change between releases, but it must remain useful without
being tied to one PR, milestone, run, branch SHA, or candidate version.

NEVER add or retain in `docs/`: implementation plans, milestone roadmaps,
progress/TODO/debt trackers, PR/review/qualification ledgers, dated
investigations, version-pinned measurements/screenshots/benchmarks, handoff
notes, or generated/static copies of facts already owned by source, manifests,
gates, tests, releases, or GitHub issues/PRs. Do not create `docs/archive`,
`docs/history`, `docs/plans`, or `docs/evidence` as a workaround.

`docs/README.md` is the canonical documentation policy and index. Each
long-lived fact has ONE owning document. Source, tests, manifests and
machine-generated inventories remain the authority for implementation state.
Update a repository document only when that document's durable contract or
reusable procedure actually changes. Do not update repo docs merely because
a PR, milestone or review round progressed. Preserve unique load-bearing
contracts before deleting or consolidating an existing document.

**MANDATORY STOP / OWNER DECISION:** If ANY accepted plan, PR task, reviewer,
checklist, or other instruction requires creating/updating a `docs/` artifact
that violates this policy, STOP THE AFFECTED WORK BEFORE WRITING IT. Do not
silently skip the required deliverable, rewrite the plan on your own, relocate
the artifact to a different repository path, or self-approve an exception.
Report the conflicting requirement, requested path/content, policy violation,
current owner/source of truth, and one recommended compliant disposition;
request explicit Owner adjudication. Resume only after the Owner resolves the
conflict and the accepted plan/contract is amended. This rule applies even if
the older plan called its documentation update MANDATORY or BLOCKING.

Reviewers must treat violations or an unadjudicated documentation conflict
as a blocker, not a cosmetic documentation comment.

## Code review

Before reviewing code changes, read `docs/guides/code-review.md` and pass it plus the
applicable requirements/contracts to the reviewer. It supplements the generic
review loop; subsystem contracts remain authoritative. PR acceptance is not
stage closure or permission to merge.

Before adding a surface or restyling one, read `docs/architecture/design-language.md`
(the canonical TUI visual vocabulary, role→token table and governance) and walk
its §11.2 checklist for any change that alters what a surface paints.

## Naming and writing

- Repository/profile/package names are `dsh-pi-tui`, `pi-tui`, `@xmoon76/pi-tui`
  (private vendored fork), and `@xmoon76/dsh-pi-tui` (the only published
  package). Never introduce the reserved `dsh-tui` / `@deepseek-ai/dsh-tui`
  naming family.
- User-facing strings, code comments, commit messages, and docs are English;
  `README.md` and `CHANGELOG.md` are the intentional Simplified-Chinese exceptions.
- Keep `README.md` / `README.en.md` and
  `CHANGELOG.md` / `CHANGELOG.en.md` synchronized.
- Changelog entries describe user-visible outcomes, not review rounds, divergence IDs, CI/tooling work, or implementation mechanics. Follow `docs/guides/releasing.md` for release details.
- Before adding a command, check this repository and official dsh for confusing or near-synonym names. This applies to new independent commands; preserve explicit existing aliases such as `/statusline` for `/footer`.

## Repository boundaries

### Source module placement

Before adding a production module, identify the layer that owns its state/lifetime/IO.

- `src/app/**` — application lifecycle, orchestration, currentness and owner composition.
- `src/runtime/**` — semantic ports/contracts plus Direct/Remote backend adapters.
- `src/domain/**` — transport/UI-neutral semantic models, policies, folds and derived state.
- `src/client/**` — Client-local non-TUI platform capabilities such as local media,
  clipboard, artifact IO and Client-local path completion.
- `src/tui/**` — terminal rendering, pickers, panels, commands and interaction.
- `src/extension/**` — public extension compatibility boundary.

A feature may span several layers when the responsibilities differ: file completion
owns neutral query/ranking/discovery policy in `domain/file-completion/**`, the
Client-local filesystem capability in `client/file-completion/**`, the terminal
trigger/presentation in `tui/file-completion/**` and the Direct Host WORKSPACE
compatibility IO in `runtime/direct/file-completion/**`. Do not recreate the retired
mixed `src/file-completion/**` directory.

Do not add an ordinary new root feature/helper (`src/*.ts`, `*.tsx`, `*.mts`,
`*.cts`). Root modules are limited to documented entries/facades/compatibility
islands guarded by the architecture gate; the gate scans all four extensions.

Choose placement by the owning layer, not by the feature noun. A domain may appear in
multiple layers when the responsibilities differ (for example `app/command/**` owns
application command execution while `tui/commands/**` owns terminal slash-command
presentation).

Do not create a parallel root feature tree when a canonical owner layer exists, do not
move code only for visual symmetry, and do not hide cross-layer dependencies behind a
generic Context/Services bag.

When placement is ambiguous, stop before creating the file and identify the state owner,
lifecycle owner, IO authority, primary callers and forbidden dependencies. Read
`docs/architecture/overview.md` for the complete taxonomy and dependency direction.

### Vendored pi-tui

`packages/pi-tui/**` is a protected vendored fork, not a normal implementation layer.

- Implement behavior in the root bundle whenever it can be done correctly through the existing consumer/public surface.
- Treat the fork as read-only for ordinary feature/bug work.
- Cleaner, smaller, more direct, or easier to test is not sufficient reason for a fork change.
- Every intentional fork source difference must belong to an existing/new X### divergence and have a guarding regression test.
- `packages/pi-tui/UPSTREAM.json` is the sole upstream baseline source;
  `packages/pi-tui/vendor-divergences.json` is the authoritative schema-v2
  inventory; `DIVERGENCES.md` is its generated human report.
- Read `packages/pi-tui/AGENTS.md` before editing anything in that package.

### Package ownership

- `@xmoon76/pi-tui` is private and bundled into `@xmoon76/dsh-pi-tui`; it is never published independently.
- Every published/runtime `@deepseek-ai/*` import/dependency resolves as a peer from the installed Harness. Dev/test dependencies may declare those packages; do not add duplicate runtime copies to the published package or tracked lockfile through `file:`, `link:`, or `workspace:` specs.
- Keep public entry-point types structural. Do not expose internal classes such as `TuiApp`, private registries, screens, terminal objects, or repository-private paths through public declarations.
- `src/startup.ts` remains a zero-dependency compatibility island. Optional runtime/backend imports must not enter its static dependency graph.

## Server/client architecture

The current production backend is Direct. The durable Host/Client contract is
`docs/architecture/host-client.md`; migration stage status lives in GitHub
issues/PRs, not in repository docs.

- Direct remains the production default until an explicit migration milestone;
  do not silently change `dsh --profile pi-tui`, `--session`, or `--preset`, or
  implement future milestones opportunistically during unrelated work.
- New Host-owned behavior must not add direct Host coupling outside the approved
  semantic-port boundary. `scripts/client-boundary-gate.mjs` and
  `scripts/client-boundary-baseline.json` enforce the existing baseline and the
  no-new-debt rule and remain the authority for allowed sites. Baseline changes
  are deliberate phase relocations only; update
  `docs/architecture/host-client.md` only when the durable coupling/authority
  contract actually changes. Stage status and qualification records belong to
  GitHub issues/PRs, not repository docs.
- The application composition facade `src/app/bootstrap.ts` has exactly TWO
  real OS process composition roots. The Direct root is
  `src/index.ts -> app/bootstrap.ts` (the Host process; the runner shares the
  Host Context and its services). The internal split Client root is
  `src/app/remote-process/local-client-entry.ts -> app/bootstrap.ts`: ONE
  lazy dynamic import, executed only after the official `PluginPackages`
  resolution is live, with the Client process's own Context, `appExit`,
  transport and mounted Client domains. It is the only
  `app/** -> app/bootstrap.ts` dynamic exception; never make it static, never
  extend it to another owner, and never let the two roots share a Context,
  plugin service object or Host service instance. See
  `docs/architecture/overview.md` (composition zone) and
  `docs/architecture/host-client.md`.
- Every Host-touching feature declares locality (Client-local, Host-owned, or
  split), its narrow semantic-port owner, and its wire story. Never assume
  Client cwd/filesystem equals Host cwd/filesystem. Host workspace semantics —
  `@file`, Host user-shell execution, and any future Host-owned filesystem
  editing/open — require an authoritative Host seam and fail closed until one
  exists. Client-local semantics — terminal/editor UI, the current draft
  external editor, Client-local draft file/image intake, and Client-local
  artifact output — stay Client-local by contract.
- Keep Client-local and Host-owned state explicit; callbacks/renderers/editor
  objects never cross the process boundary. Do not replace Context with a
  universal god object; keep ports narrow and domain-owned.
- Prefer official DSH client/Remote/event contracts over TUI-specific RPCs,
  DTOs, or duplicate transport state.
- Direct and wire implementations share semantic contracts and contract tests;
  do not maintain two independent feature semantics. Remote async results must
  re-check generation/identity before mutating visible state. Every migration PR
  leaves the Direct path green.
- Direct session-safety mechanisms remain authoritative until an explicit
  migration milestone retires them; current stage status is tracked in GitHub
  issues/PRs, never in repository docs.

Read `docs/architecture/host-client.md` and `docs/architecture/overview.md`
before changing Host-owned behavior.

## Extension boundary

`@xmoon76/dsh-pi-tui/extensions` is a public compatibility boundary.

- Stable APIs stay semantic and must not expose TUI/terminal/repository
  internals. Low-level capabilities belong to Advanced/Unstable supported
  entries, never private imports.
- Preserve existing public semantics and caller-owned lifecycle across unload/HMR
  and surface recreation.
- Prefer additive evolution. Do not silently repurpose or remove exported
  behavior.
- First-party success is insufficient for public API changes; preserve
  third-party-style packed/public-export coverage.
- Do not expand the Extension API merely for future flexibility or to make an
  internal implementation/test easier.

Read `docs/extensions/stable.md` and `docs/extensions/authoring.md` before changing an
extension-facing contract.

## Correctness invariants

- **One Direct surface per session.** DSH `SessionHandle` / `SessionWriteLease`
  is the sole cross-process Session writer ownership authority on the master
  baseline; one process-owned surface per session is guaranteed by DSH
  authority. Do not add a second persistence/artifact-level owner lock in the
  TUI. The TUI still owns process-local surface correctness:
  `SessionTransitionGate`, `SessionOperationBarrier`, and stale/generation
  fences. Keep the submit hot path free of persistence reads. See
  `docs/architecture/concurrency.md`.
- **No bare fire-and-forget promises.** Use the repository's `runDetached` /
  `runOwned` ownership model and preserve its failure semantics. See
  `docs/architecture/failure-model.md`.
- **Use semantic key matching.** TUI components use `matchesKey`/the keyboard
  abstraction, never raw terminal escape-sequence equality; terminals may use
  CSI-u / modifyOtherKeys.
- **Respect Cordis injection.** Do not read an uninjected service through a bare
  `ctx.foo`; use the declared injection or the appropriate `ctx.get(...)` path.
- **Agent-scoped DSH services use the live Agent object as scope.** Do not
  substitute the Cordis context or silently omit required scope.
- **Do not recreate catalog probes.** Cold command/skill discovery uses the
  standing scope; do not call `agents.create()` merely to discover a catalog.
  See `docs/architecture/surface-catalog.md`.
- **Question flow stays in the editor seat.** Keep one unified, budgeted
  scrollport and preserve its seat/modal ownership. See
  `test/question-flow.test.ts` and `test/rendering.test.ts`.
- **Managed overlays follow the overlay/focus contract.** Logical intent is
  committed before any fork call that can synchronously run a plugin callback,
  and a callback's newer operation always wins; the host derives the focused
  seat from the live physical focus. See `docs/architecture/overlay-focus.md`.
- **Context presentation does not rewrite model input.** Keep model-facing bytes
  untouched; render parsed skill/system envelopes, never raw XML. See
  `test/rendering.test.ts`.
- **Prove lifecycle invariants with a probe, not with intuition.** For
  generation/lease, proxy-receiver, attachment and teardown-idempotence changes,
  confirm the real numbers and identities (a targeted probe or test) instead of
  reasoning from the code alone — this repository has had a double
  `markAttachment()` inflate a generation. See `docs/architecture/concurrency.md`.

## Development

Common checks:

```sh
pnpm build
pnpm typecheck
pnpm test
```

Use the smallest relevant validation for the current change. Prefer targeted
tests first; do not run expensive compatibility suites mechanically.

Adding or changing a test? Read `docs/guides/testing.md` first: it owns the
test-tree ownership map, the new-test rules, the lane commands and the
objective discovery guards.

A stage-final validation must not run the same suite twice. `pnpm verify:release`
is the repository's full pipeline: `typecheck:fork` + `typecheck:bench`,
`test:fork`, `test:tmux`, `test:tooling`, the architecture / boundary /
keybinding / naming / session-event / installation-doc / pi-divergence /
pi-vendor gates, `pnpm audit`, and finally `pnpm pack:release`. `pack:release`
is the explicit local orchestrator: `clean` + `clean:fork` + `build` +
`typecheck:bundle` + `test:product` + `pack:artifact` + `smoke:release`
(the eight packed-artifact smokes: tarball, extension fixture, advanced,
phase4, unstable, vim, examples, composeAgent). So in one pass never also run
`typecheck:bundle`, `test:product`, `scripts/tarball-smoke.mjs` or
`scripts/compose-agent-compat-smoke.mjs` by hand, and never invoke
`pnpm pack:artifact`/`pack:release` while a build or an artifact-dependent gate
is running. `pnpm test` already contains `test:fork` + `test:product` +
`test:tooling` + `test:tmux`; prefer it over the individual pieces. What a
stage-final pass still needs ON TOP of `verify:release`: the migration contract
smokes (`smoke:remote-*`), `smoke:boundary`, `smoke:startup-strictness`, the
published-DSH compatibility checks (`compat:dsh:npm`, `compat:dsh:client-family`
— `verify:release` does NOT contain them), `git diff --check` (unstaged and
staged), plus whatever stage-specific validation the authority plan for the
current stage requires (e.g. the Pre-M3 plan's §35.5/§35.6 matrix).

**Never re-run a lane that is already green on the same state.** Before a
stage-final pass, take stock of what has already run against the CURRENT tree
and run only the remainder — re-running a green lane after an edit that does
not touch its inputs buys no evidence and costs the whole suite. A delta
invalidates a lane only when it touches that lane's inputs: `packages/pi-tui/**`
for the fork lanes, `src/**` + `test/**` + `scripts/**` for the bundle suites,
`docs/**` and the doc-gate inputs for `test:tmux`/the documentation gates.
A docs-only or comment-only delta does not invalidate a suite already green on
the same code. State which lanes were already green (and against which state)
and which were run for the delta, so the evidence stays auditable. CI runs the
full pipeline on the PR; the local stage-final pass exists to catch failures
before pushing, not to reproduce CI.

**Start a long lane only on a frozen tree.** Begin a stage-final pass — or any
lane that takes minutes — only once every known finding is fixed, no review
round or acceptance item is in flight, and you cannot name a reason another edit
is expected; until then run only the delta-targeted tests. An edit made while a
lane runs voids that run: kill it explicitly, record why, and re-run once after
the tree is frozen instead of letting it finish and then running the same state
twice.

`ci.yml` coverage is what makes a green PR check evidence instead of work to
reproduce: `Source checks` runs `build:fork`, `typecheck:fork`,
`typecheck:bench`, `test:fork`, the `smoke:remote-*` parity/closure lanes (five
of them only when the resolved DSH mode is `source`), `test:tmux`,
`gate:installation-doc`, `test:tooling`, `gate:pi-surface-compat`,
`generate:pi-divergences` with a `git diff --exit-code` on `DIVERGENCES.md`,
`gate:pi-divergence-ledger`, `gate:pi-vendor-diff --strict` and the naming gate;
`Build and pack` runs the root `build`, `typecheck:bundle` and `test:product`
in separate jobs, then a lifecycle-free `pack:artifact` candidate qualified by
the eight packed-artifact smokes through `smoke:release`; the qualification job
also runs `smoke:startup-strictness`. The remaining jobs
run `smoke:boundary`, `smoke:official-presets`, `compat:dsh:client-family`, the
tarball smokes and `pnpm audit`. `split-process` runs only for an npm release
tag: PR, main and next runs legitimately report it as `skipped`, and
Host/Client split-process development work must run `pnpm smoke:split-process`
manually against the actual candidate tarball. The lanes CI does NOT run — therefore the only ones a stage-final pass
must run locally — are
`compat:dsh:npm`, `gate:keybindings`, `gate:boundary`, `gate:architecture`,
`scripts/check-no-session-events.mjs`, `gate:dsh-preset-parity`,
`smoke:remote-d2-fork` and `smoke:remote-session-lifecycle-parity`; a mode-gated
CI step that was skipped counts as not covered.

**Keep one run ledger per session** (lane → last green state → its inputs) and
consult it before every run: having to run a lane again is a fact to state, not
a habit to fall back on.

Validation mechanics for this toolchain:

* `packages/pi-tui/dist` is a build INPUT to the root bundle and to the tests:
  run `pnpm build` before testing anything that depends on the fork, and never
  run a build and an artifact-dependent test or gate at the same time.
* Some bundle paths run under Node's strip-only TypeScript loader: new `src/**`
  files must not use TypeScript parameter properties
  (`constructor(private readonly x: T) {}`) — assign explicit fields instead.
* `scripts/client-boundary-gate.mjs` counts a Host package import even when it is
  TYPE-ONLY (`@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-session`). Prefer a
  local structural type or the owning port's type; see
  `docs/architecture/host-client.md`.
* Extending a shared interface (e.g. `TuiCommandRunner`, `TuiSettingsDoc`) also
  reaches its test fakes and literal builders: update them with the change and
  let `pnpm typecheck:bundle` enumerate the remainder.
* Changing WHAT the public entry re-exports (moving or re-exporting a
  publicly-exported type/function) changes the emitted declaration graph: the
  bundled `dist/*.d.mts` may only carry the top-level regions allowlisted in
  `scripts/tarball-smoke.mjs`. Run `pnpm build`, then `pnpm pack:artifact`, then
  `pnpm smoke:release -- ./xmoon76-dsh-pi-tui-<version>.tgz` before pushing —
  the ordinary product suite does NOT cover this (it is a `smoke:release`/CI
  check), and a stale `dist` or an old tgz makes it pass locally. For the full
  local route use `pnpm pack:release` instead.
* A publicly-exported helper therefore follows the canonical owner-layer placement
  (`## Repository boundaries` → `### Source module placement`) and is exposed through
  the public entry (`src/index.ts`) or an existing documented facade. Do not create a
  new root `src/*.ts` module merely to satisfy declaration bundling. The root
  ledger `scripts/source-root-baseline.json` is CLOSED at the seven stable
  entries/facades with no legacy root left (the architecture gate also forbids
  every retired root path); those entries are not a template for new modules. If the declaration/tarball boundary
  cannot expose the canonical nested owner, STOP and report the packaging constraint
  instead of growing the root baseline.

When entering a development worktree:

```sh
pnpm dev:doctor
```

Use `pnpm dev:bootstrap` only when the environment is not ready. On a
source-mode worktree (a worktree whose tracked `test/compat/dsh-mode.json`
selects `source` — `next` is not always source-mode), a plain `pnpm install`
before bootstrap leaves the DSH workspace state incorrect (`workspace DSH
incorrect` / `local state missing`); run `pnpm dev:doctor` first and let
`pnpm dev:bootstrap` perform the dependency install itself, then re-run
`pnpm dev:doctor` until it reports `READY`. A plain `pnpm install` after
bootstrap re-resolves `@deepseek-ai/*` to registry versions and breaks the
source-mode workspace again; use `pnpm dev:shell` (or
`source ./.dsh-dev-env`) for commands that need the source environment, and
re-run `pnpm dev:bootstrap` after any real install. Keep each worktree's
`node_modules` and `dist` independent; never symlink them, and build in that
worktree before using a profile.

* `main` is the released npm-backed compatibility line; `next` is the
  forward-integration line and may use its tracked Source Mode.
* Normal feature/fix work lands on `main`, then merges `main -> next`; do not
  duplicate shared implementations. Use `next` directly only for explicit
  next-only work requiring an unpublished DSH API or contract.
* A promotion uses a real merge commit; never squash/reset long-lived history or
  replace `next`'s newer DSH target/policy with `main`'s released one.
* Do not modify the real-use `pi-tui` profile during development.
* `compat:dsh:source` is a full distribution-boundary verification, not a
  routine test after ordinary TUI changes. Run it only when the DSH source or
  distribution boundary changes (source pin, target metadata, distribution
  infrastructure, source/npm discrepancy, or an unpublished DSH commit), or
  when explicitly requested; skip it for TUI-only changes when DSH is
  unchanged.

Read `docs/guides/development.md` before changing DSH mode, worktree/bootstrap
behavior, or promoting `main`/`next`. Read `docs/guides/dsh-compatibility.md` for
distribution compatibility.

## Release

* Follow `docs/guides/releasing.md`. Publishing is performed by GitHub CI from the
  release tag; never run `npm publish` from a development machine.
* Release commits/tags also require explicit user approval. Keep bilingual
  changelogs synchronized and user-facing.

## Issue management

GitHub Issues are the single entry point for open work, stage progress and
verification evidence. `docs/` never carries that state (see the documentation
policy above).

* **Find before you create.** Search the open issues first. If an issue already
  owns the work, update it; do not open a second one for the same obligation.
* **Not every change needs an issue.** An issue is required for a known
  leftover, a deferred or bounded item, work that spans several PRs, and
  anything that carries an owner and a re-entry trigger. A small fix that one
  PR completes end to end may be managed by the PR alone — creating an issue
  for it is overhead, not governance. When an issue does exist for the work,
  the PR updates it.
* **One obligation per issue.** An issue owns one problem, one feature or one
  qualification check, with its own acceptance criteria. Use an epic (label
  `epic`) as the parent for a work stream, and sub-issues for the work items.
* **Parent is not dependency.** A sub-issue expresses a work split; "Blocked by"
  expresses the dependency. Record real dependencies as "Blocked by" /
  "Blocking" — an item's startability usually depends on a *different* issue
  than its parent.
* **Do not manufacture TODOs.** `NOT_VERIFIED` boundaries, accepted exclusions
  and deferred scopes are dispositions, not open defects. Keep them on the issue
  that records them, with their re-entry trigger, instead of spawning a TODO
  row for each.
* **Deferred work carries a trigger.** A deferred issue states the condition
  under which it re-enters work, and who owns it. A closed issue carries its
  evidence: a PR, a CI run, or a test reference.
* **PRs update their issue.** When a PR closes or advances an issue, say so in
  that issue. Do not append to an epic as a substitute for the work item.
* **Labels.** `epic` for a parent, `area:*` for the work stream, `kind:feature`
  / `kind:qualification` / `kind:milestone` for the nature of the item,
  `status:deferred` for an item with a stated re-entry trigger.
* **Use the issue forms.** `.github/ISSUE_TEMPLATE/` holds the four forms:
  `bug_report.yml`, `feature_request.yml`, `qualification_task.yml` (evidence
  as the deliverable) and `work_item.yml` (the standard Context / Scope /
  Acceptance / Dependencies / Evidence / Status structure). An issue that does
  not match a form still follows the same structure.
* **Name a code name before you rely on it.** A short code (`M4`, `S4-D2`,
  `B13`, `J-02`, …) is a local label from some plan, ledger or gate. Whenever
  you use one, say which effort it belongs to and what it designates —
  the stage, the scope and the claim it covers — so the reader never has to
  guess. A code name is not self-explanatory, it is not stable across efforts,
  and it does not transfer between efforts that happen to reuse the letters.
  Its meaning lives with the issue, PR or ledger that owns it, not here.
* **Do not infer status from a code name or a merge.** A merged PR is not a
  stage closure, and a stage that is closed on one effort says nothing about
  another. Read the owning issue or PR for the actual status.

## Pull requests

* Pull requests use `.github/pull_request_template.md`. Keep the description
  proportional to the change, report only verified evidence, and update an
  owning Issue when one exists. The template summarizes applicable review
  evidence; it does not replace `docs/guides/code-review.md`, authorize merge,
  or imply stage closure.

## Documentation map

- `docs/README.md` — the documentation policy and the complete index.
- `docs/architecture/` — ownership/Host-client, session and failure contracts, surface behavior, transcript/terminal output, keybindings, input history and the design language.
- `docs/extensions/` — the public extension tiers/API and authoring guidance.
- `docs/tsp/` — the experimental TSP renderer, product boundary and TSP surfaces.
- `docs/guides/` — development, review, release, testing and compatibility procedures.

Read only the owning document for the subsystem you touch; `docs/README.md` maps
every long-lived document. Do not create a second documentation map here.
