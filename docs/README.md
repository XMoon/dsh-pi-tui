# dsh-pi-tui documentation

This directory is the repository's durable technical documentation. It is not a
project journal: the root `AGENTS.md` owns the short hard rule, and this file is
the canonical policy plus the index of every long-lived document.

## Policy (MUST)

`docs/` contains ONLY durable, cross-version technical facts, current
load-bearing architecture/behavior contracts, and reusable procedures. A
contract may change between releases, but it must remain useful without being
tied to one PR, milestone, run, branch SHA, or candidate version.

The positive/negative test for a proposed document or section:

| Belongs in `docs/` | Does NOT belong in `docs/` (where it goes instead) |
|---|---|
| Session writer authority and lifecycle invariants | M3-DONE, S4-D2 progress, qualification ledgers → GitHub Issue/PR |
| Durable JSONL / Session V2/V3 compatibility handling | An exact npm pairing table for one upgrade → release notes, compat matrix, changelog |
| The terminal untrusted-text contract | Screenshots, failure dumps, benchmark milliseconds from one PR → PR or test artifacts |
| How to run headless, tmux or Tern-pane smoke tests | A dated PASS record with counts/versions → CI or PR artifacts |
| The SDK-vs-client evidence-tier principle | A one-off comparison of one SDK pin against upstream main → PR/investigation reference |

Each long-lived fact has exactly ONE owning document. Link to it; never copy it.
Source code, tests, manifests and machine-generated inventories remain the
authority for implementation state. Update a repository document only when its
durable contract or reusable procedure actually changes — not because a PR,
milestone or review round progressed.

## STOP / Owner adjudication

If ANY accepted plan, PR task, reviewer, checklist or other instruction requires
creating or updating a `docs/` artifact that violates this policy, STOP THE
AFFECTED WORK BEFORE WRITING IT. Do not silently skip the required deliverable,
rewrite the plan on your own, relocate the artifact to another repository path,
or self-approve an exception. Report the conflicting requirement, the requested
path/content, the policy violation, the current owner/source of truth, and one
recommended compliant disposition; request explicit Owner adjudication. Resume
only after the Owner resolves the conflict and the accepted plan/contract is
amended. This applies even when an older plan called its documentation update
MANDATORY or BLOCKING.

## Canonical map

### Index and assets

| Path | Audience | What it owns |
|---|---|---|
| `README.md` | everyone | This policy and the complete documentation index |
| `dsh-pi-tui.png` | readers of the root README | The published screenshot asset; not a contract document |

### `architecture/` — long-lived product and application contracts

| Path | Audience | What it owns |
|---|---|---|
| `architecture/overview.md` | contributors | Ownership map and canonical layers, dependency direction, composition zone, source-placement policy and root ledger, architecture-gate scope |
| `architecture/host-client.md` | contributors | Host-owned vs Client-local locality, the semantic-port boundary, Direct/Remote equivalence, currentness/identity fences, Plugin Manager Host authority, workflow-terminal authority, coupling guard and qualification tiers |
| `architecture/concurrency.md` | contributors | Session writer authority (`SessionHandle` / `SessionWriteLease`), process-local transition/operation barriers, stale/generation fences |
| `architecture/failure-model.md` | contributors | `runDetached` / `runOwned` promise ownership, error observation and cancellation taxonomy |
| `architecture/surface-behavior.md` | contributors | Durable non-transcript workspace behavior: quit/queue, Task Center/Browser, Job Workspace, Settings, Task Quick, Plugin Manager/Detail, input completion and attachment intake |
| `architecture/surface-catalog.md` | contributors | Command/skill catalog ownership, standing scope, Host vs TUI authority and refresh semantics |
| `architecture/overlay-focus.md` | contributors | Managed-overlay / editor-seat / focus contract, synchronous reentrancy, one-shot closure and physical-screen leases |
| `architecture/transcript.md` | contributors | One DisplayPreset authority, semantic transcript classification, folding/reveal, Context/Work/Thinking disclosure |
| `architecture/terminal-output.md` | contributors | Untrusted-text projection: display policies, SGR whitelist, raw-vs-display authority, copy/search/terminal-sink constraints |
| `architecture/keybindings.md` | contributors | Physical key → semantic action → resolver → handler, the input ladder, leader machinery and the static gate |
| `architecture/input-history.md` | contributors | Per-cwd input-history persistence format, recall scopes, and the current-session vs broader-history split |
| `architecture/design-language.md` | contributors/reviewers | TUI visual vocabulary: semantic layers, role→token table, glyph safety, active device, responsive ladder, governance and visual checklist |

### `extensions/` — public extension contracts

| Path | Audience | What it owns |
|---|---|---|
| `extensions/tiers.md` | plugin authors | The three public tiers and their compatibility policy |
| `extensions/stable.md` | plugin authors | The Stable v2 public API contract and examples |
| `extensions/advanced.md` | plugin authors | The Advanced-tier author guide |
| `extensions/unstable.md` | plugin authors | The Unstable-tier API and its safety/preemption behavior |
| `extensions/authoring.md` | plugin authors | Tier-selection guidance and general authoring practice |

### `tsp/` — Tern Surface Protocol product boundary

| Path | Audience | What it owns |
|---|---|---|
| `tsp/overview.md` | TSP contributors | TSP-vs-Luau boundary, renderer ownership, capability/admission, run/verify entry points |
| `tsp/foundation.md` | TSP contributors | SDK/client/app authority split, node identity/revision, bounded reader surface lifecycle, seat ownership, async currentness and evidence tiers |
| `tsp/model-selection.md` | TSP contributors | The current two-page `/model` semantics and the single explicit writer |
| `tsp/preset-selection.md` | TSP contributors | The current two-page `/preset` semantics, footer writer and Reader |
| `tsp/session-browser.md` | TSP contributors | SessionReader, listing/search/lineage/workspace, guarded resume and the native viewer contract |

### `guides/` — reusable procedures

| Path | Audience | What it owns |
|---|---|---|
| `guides/code-review.md` | contributors/reviewers | Repository review checkpoints, evidence tiers, documentation-policy gate, PR acceptance vs stage closure |
| `guides/development.md` | contributors | Worktree policy, npm/source DSH modes, doctor/bootstrap, source-build diagnosis, benchmark/replay method |
| `guides/releasing.md` | ops | Versioning, bilingual changelog/README metadata, verification, tag and publication procedure |
| `guides/tmux-testing.md` | contributors | When/how to verify in tmux, capture flow, Focus-replay and measurement procedures, traps |
| `guides/tern-pane-testing.md` | TSP contributors | Real Tern-pane harness vs headless evidence, run conditions, assertion-vs-measurement and limits |
| `guides/tern-gui-testing.md` | TSP contributors | The real Tern GUI-window lane: hover, the client's theme, the native window and the accessibility tree |
| `guides/footer.md` | users | `/footer` builtin items, styles, custom text/commands, extension items and troubleshooting |
| `guides/dsh-compatibility.md` | users/contributors | Semver/prerelease matching method, manifest/matrix/mode authority, Session V2/V3 data handling, Source Mode validation |
| `guides/testing.md` | contributors | The test-tree ownership map, the new-test rules, the lane commands and the objective discovery guards |

## Source-of-truth boundaries

- **Behavior:** `src/**` plus its tests prove what the product does. A document
  explains the durable *why*, the owning authority, the sink and the must-not
  rules; it never becomes a second implementation inventory.
- **Allowed Host couplings:** `scripts/client-boundary-baseline.json` and
  `scripts/client-boundary-gate.mjs` are the authority for permitted Host
  coupling sites. Do not hand-maintain the allowlist in prose.
- **Architecture placement:** `scripts/source-root-baseline.json` plus
  `scripts/application-architecture-gate.mjs` own the root ledger and the
  dependency rules.
- **Versions and compatibility:** `package.json`, `src/dsh-compat-matrix.json`,
  `test/compat/dsh-mode.json`, `test/compat/dsh-source.json` and the release
  notes/changelog own live versions, floors and pairing. `README.md` /
  `README.en.md` own the published pairing summary.
- **Stage/task progress:** GitHub Issues and PRs own open obligations, review
  rounds, qualification records and handoffs. Documentation does not track them.
- **Generated inventories:** regeneration commands (for example
  `pnpm generate:pi-divergences`) and their JSON ledgers own generated reports;
  commit only the generated artifact the owning gate requires.

## How these documents evolve

Record a decision and its rationale in the owning document at the same time as
the behavior change. Write the rule and the *why*, not a walkthrough of the
implementation. Keep a new fact in exactly one place: link, don't copy. English
only, unless the user explicitly asks otherwise.
