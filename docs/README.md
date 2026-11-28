# dsh-pi-tui documentation

This directory is the repository's durable technical documentation. It is not a
project journal: the root `AGENTS.md` owns the short hard rule, and this file is
the canonical policy plus the index of every long-lived document.

## Policy (MUST)

Default to no new or expanded `docs/` content. The same admission rule applies
to new files, new sections and added paragraphs in existing documents. The
proposer must establish a concrete reader need that existing documentation or
the authoritative source does not adequately meet. A fact being correct,
durable or useful to implement the current PR is not sufficient.

Admit only the minimum sufficient content for lasting behavior or architecture
contracts, necessary design rationale, and reusable operating or development
procedures that real readers need. A contract may change between releases, but
must remain useful beyond one PR, milestone, run, branch SHA or candidate version.

Do not turn documentation into a maintained prose mirror of ordinary internal
functions, types, state fields, call chains, file or registration lists, test
rosters, or fixture/probe/receipt implementations. Describe necessary public
interfaces, load-bearing invariants and procedural steps only to the extent
needed to explain the contract or perform the procedure.

Never add or retain implementation plans, milestone roadmaps, progress/TODO/debt
trackers, PR/review/qualification ledgers, decisions awaiting approval, dated
investigations, version-pinned measurements/screenshots/benchmarks, handoff
notes, or generated/static copies of facts already owned by source, manifests,
gates, tests, releases or GitHub issues/PRs. Use the existing authoritative
carriers; do not create `docs/archive`, `docs/history`, `docs/plans` or
`docs/evidence` as a workaround.

Each long-lived fact has exactly ONE owning document. Link to it; never copy it.
Source code, tests, manifests and machine-generated inventories remain the
authority for implementation state. Ordinary implementation changes, internal
refactoring, module moves and test changes default to no documentation update
when the lasting contract and reusable procedure are unchanged. Actual contract
changes, incorrect descriptions and obsolete procedures must be corrected in
their owning document. Change only the necessary portion, remove obsolete or
duplicated text in the affected scope, and preserve unique load-bearing contracts.
Do not expand unrelated sections or move redundant content into other long-lived
documents.

Planners must not prescribe documentation updates mechanically; executors must
not expand them on their own. Reviewers requesting new or expanded documentation
bear the same necessity burden as any other proposer. Reviewers must treat
violations of this policy or unresolved documentation conflicts as merge blockers.

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
| `dsh-pi-tui-shared-session.svg` | readers of the root README | An illustrative Direct vs multi-client Daemon diagram; not an architecture contract |

### `architecture/` — long-lived product and application contracts

| Path | Audience | What it owns |
|---|---|---|
| `architecture/overview.md` | contributors | Ownership map and canonical layers, dependency direction, composition zone, source-placement policy and root ledger, architecture-gate scope |
| `architecture/host-client.md` | contributors | Host/Client locality, semantic ports, backend selection, Split transport, Direct/Remote equivalence, currentness and Session/Host authority; canonical owner for Client detach |
| `architecture/host-daemon.md` | contributors | Profile-scoped daemon supervision, Host process management and administrative command lifecycle |
| `architecture/host-acp.md` | contributors | Host-owned local ACP v1 listener, bounded protocol admission and session-view contract |
| `architecture/concurrency.md` | contributors | Session writer authority (`SessionHandle` / `SessionWriteLease`), process-local transition/operation barriers, stale/generation fences |
| `architecture/failure-model.md` | contributors | `runDetached` / `runOwned` promise ownership, error observation and cancellation taxonomy |
| `architecture/surface-behavior.md` | contributors | Shared non-transcript interaction contracts: quit, queue, composer submission, task/job views, Web/ACP quick controls, model picker, schedule, task quick and common docks; entry links to separately owned surfaces |
| `architecture/surface-session.md` | contributors | Session Workspace browsing, navigation, currentness, switching and guarded resume behavior |
| `architecture/surface-settings.md` | contributors | Settings Workspace page navigation, edit/write settlement and configuration presentation |
| `architecture/surface-plugins.md` | contributors | Plugin Manager/Detail surface interactions, inventory display and install/update workflows |
| `architecture/surface-input.md` | contributors | Attachment intake, input completion, session `@` routing and shell-input surface behavior |
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
| `tsp/work-hub.md` | TSP contributors | Native Work Hub entry, read-only Picker/Inspector/Details, capability and return contract |

### `guides/` — reusable procedures

| Path | Audience | What it owns |
|---|---|---|
| `guides/development.md` | contributors | Worktree policy, mise toolchain, npm/source DSH modes and runbooks, isolated profiles, doctor/bootstrap, source-build diagnosis, benchmark/replay method |
| `guides/releasing.md` | ops | Versioning, bilingual changelog/README metadata, verification, tag and publication procedure |
| `guides/tmux-testing.md` | contributors | When/how to verify in tmux, capture flow, Focus-replay and measurement procedures, traps |
| `guides/tern-pane-testing.md` | TSP contributors | Real Tern-pane harness vs headless evidence, run conditions, the appearance/theme switch, assertion-vs-measurement and limits |
| `guides/tern-gui-testing.md` | TSP contributors | The real Tern GUI-window lane: the native window, the OS chrome/font stack, the live-window Appearance switch, control-injected pointer/key input and the client `a11y` tree (not OS input or an OS reader) |
| `guides/footer.md` | users | `/footer` builtin items, styles, custom text/commands, extension items and troubleshooting |
| `guides/dsh-compatibility.md` | users/contributors | Semver/prerelease matching method, manifest/matrix/mode authority, Session V2/V3 data handling, Source Mode validation |
| `guides/daemon.md` | users | Local Linux/macOS daemon mode, backend selection, safe Host control and optional supervision |
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
  `mise exec -- pnpm generate:pi-divergences`) and their JSON ledgers own generated reports;
  commit only the generated artifact the owning gate requires.

## How these documents evolve

Apply the admission policy above. Write the rule and the *why*, not a
walkthrough of the implementation. English only, unless the user explicitly
asks otherwise.

For a documentation-only change or a new product behavior:

1. Read the root `AGENTS.md`, this map and the owning architecture contract.
   Verify the claim against current source/tests or the reusable procedure;
   a PR plan or a historical screenshot does not establish current behavior.
2. Choose the smallest owning document. Separate user-facing steps from the
   developer contract; do not create a second copy of an authoritative rule.
   A large file is split only at a real independently owned responsibility,
   retaining the shared lifecycle/authority contract in its canonical owner.
3. When moving a section, preserve its semantics and add an entry link from
   the old top-level section. Update this canonical index and all references
   to moved nested anchors; check any source/test comments that point at it.
4. Run the repository documentation gate with `node scripts/docs-gate.mjs`
   (also part of `mise run check`), and review links, source-path claims and
   formatting. A green path/index check cannot prove the written semantics.
