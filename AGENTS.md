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

## Naming and writing

- Repository/profile/package names are `dsh-pi-tui`, `pi-tui`, `@xmoon76/pi-tui`
  (private vendored fork), and `@xmoon76/dsh-pi-tui` (the only published
  package). Never introduce the reserved `dsh-tui` / `@deepseek-ai/dsh-tui`
  naming family.
- User-facing strings, code comments, commit messages, and docs are English;
  `README.md` and `CHANGELOG.md` are the intentional Simplified-Chinese exceptions.
- Keep `README.md` / `README.en.md` and
  `CHANGELOG.md` / `CHANGELOG.en.md` synchronized.
- Changelog entries describe user-visible outcomes, not review rounds, divergence IDs, CI/tooling work, or implementation mechanics. Follow `docs/releasing.md` for release details.
- Before adding a command, check this repository and official dsh for confusing or near-synonym names. This applies to new independent commands; preserve explicit existing aliases such as `/statusline` for `/footer`.

## Repository boundaries

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

The current production backend is Direct. The long-term migration is tracked in
`docs/client-server-migration.md`.

- Direct remains the production default until an explicit migration milestone;
  do not silently change `dsh --profile pi-tui`, `--session`, or `--preset`, or
  implement future milestones opportunistically during unrelated work.
- New Host-owned behavior must not add direct Host coupling outside the approved
  semantic-port boundary. `scripts/client-boundary-gate.mjs` enforces the
  existing baseline and no-new-debt rule; baseline changes are deliberate phase
  relocations only, with migration and coupling docs updated in the same PR.
- Every Host-touching feature declares locality (Client-local, Host-owned, or
  split), its narrow semantic-port owner, and its wire story. Never assume
  Client cwd/filesystem equals Host cwd/filesystem: remote shell, `@file`,
  external-editor, and export must fail closed until a Host seam exists.
- Keep Client-local and Host-owned state explicit; callbacks/renderers/editor
  objects never cross the process boundary. Do not replace Context with a
  universal god object; keep ports narrow and domain-owned.
- Prefer official DSH client/Remote/event contracts over TUI-specific RPCs,
  DTOs, or duplicate transport state.
- Direct and wire implementations share semantic contracts and contract tests;
  do not maintain two independent feature semantics. Remote async results must
  re-check generation/identity before mutating visible state. Every migration PR
  leaves the Direct path green.
- Direct session-safety mechanisms remain authoritative until the migration
  roadmap explicitly retires them.

Read `docs/client-server-migration.md` and `docs/client-server-coupling.md`
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

Read `docs/extension-api.md` and `docs/plugin-authoring.md` before changing an
extension-facing contract.

## Correctness invariants

- **One Direct surface per session.** Until Host-owned writes and cross-client
  concurrency are proven, Direct permits one process-owned surface per session;
  `owner.lock`, lease/cooling, PINNED, the transition gate, and
  `SessionOperationBarrier` remain authoritative. Do not weaken them or
  reintroduce per-submit persistence reads on the hot path. See
  `docs/concurrency.md`.
- **No bare fire-and-forget promises.** Use the repository's `runDetached` /
  `runOwned` ownership model and preserve its failure semantics. See
  `docs/failure-model.md`.
- **Use semantic key matching.** TUI components use `matchesKey`/the keyboard
  abstraction, never raw terminal escape-sequence equality; terminals may use
  CSI-u / modifyOtherKeys.
- **Respect Cordis injection.** Do not read an uninjected service through a bare
  `ctx.foo`; use the declared injection or the appropriate `ctx.get(...)` path.
- **Agent-scoped DSH services use the live Agent object as scope.** Do not
  substitute the Cordis context or silently omit required scope.
- **Do not recreate catalog probes.** Cold command/skill discovery uses the
  standing scope; do not call `agents.create()` merely to discover a catalog.
  See `docs/surface-catalog.md`.
- **Question flow stays in the editor seat.** Keep one unified, budgeted
  scrollport and preserve its seat/modal ownership. See
  `test/question-flow.test.ts` and `test/rendering.test.ts`.
- **Context presentation does not rewrite model input.** Keep model-facing bytes
  untouched; render parsed skill/system envelopes, never raw XML. See
  `test/rendering.test.ts`.
- **Repair real DSH frames only.** Never rewrite a whole log as one zstd frame;
  refuse ambiguous duplicate-seq references, and make `--yes` repairs with a
  backup, verification, and 0600 output. Do not validate serializers solely
  through a self round-trip. See `docs/repair-session.md`.

## Development

Common checks:

```sh
pnpm build
pnpm typecheck
pnpm test
```

Use the smallest relevant validation for the current change. Prefer targeted
tests first; do not run expensive compatibility suites mechanically.

When entering a development worktree:

```sh
pnpm dev:doctor
```

Use `pnpm dev:bootstrap` only when the environment is not ready. Keep each
worktree's `node_modules` and `dist` independent; never symlink them, and build
in that worktree before using a profile.

* `main` is the released npm-backed compatibility line; `next` is the
  forward-integration line and may use its tracked Source Mode.
* Normal feature/fix work lands on `main`, then merges `main -> next`; do not
  duplicate shared implementations. Use `next` directly only for explicit
  next-only work requiring an unpublished DSH API or contract.
* A promotion uses a real merge commit; never squash/reset long-lived history or
  replace `next`'s newer DSH target/policy with `main`'s released one.
* Do not modify the real-use `pi-tui` profile during development.
* `compat:dsh:source` is a full distribution-boundary verification, not a
  routine test after ordinary TUI changes.

Read `docs/local-development.md` before changing DSH mode, worktree/bootstrap
behavior, or promoting `main`/`next`. Read `docs/dsh-compatibility.md` for
distribution compatibility.

## Release

* Follow `docs/releasing.md`. Publishing is performed by GitHub CI from the
  release tag; never run `npm publish` from a development machine.
* Release commits/tags also require explicit user approval. Keep bilingual
  changelogs synchronized and user-facing.

## Documentation map

Read these only when the task touches the corresponding area:

* `docs/README.md` — complete documentation index and ownership map.
* `docs/client-server-migration.md` — Direct → DSH-native client roadmap.
* `docs/client-server-coupling.md` — current Host-coupling inventory.
* `docs/concurrency.md` — Direct session ownership and safety.
* `docs/failure-model.md` — detached async ownership/error handling.
* `docs/extension-api.md` — public extension compatibility contract.
* `docs/plugin-authoring.md` — extension tier/authoring guidance.
* `docs/surface-catalog.md` — command/skill catalog ownership.
* `docs/local-development.md` — worktrees, Source Mode, branch promotion.
* `docs/tmux-testing.md` — visual/TTY verification and real-testing traps.
* `docs/dsh-compatibility.md` — DSH distribution compatibility.
* `docs/releasing.md` — release/tag/publish procedure.
* `docs/repair-session.md` — session-log repair contract.
* `packages/pi-tui/AGENTS.md` — vendored-fork rules.

When a subsystem already has a dedicated contract document, keep detailed
implementation history there or in its regression tests rather than growing
this file. Update behavior decisions and rationale in the owning doc in the
same PR; keep each fact in one place and link rather than copy it.
