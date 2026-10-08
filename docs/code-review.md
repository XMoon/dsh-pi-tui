# Code review

This is the repository-specific supplement for reviewing `dsh-pi-tui` changes,
whether or not the reviewer has a review skill installed. Explicit user
instructions and the owning repository/source contracts take precedence; expose
conflicts rather than silently reconciling them. This document does not authorize
fixes, commits, pushes or merges.

The reusable `review-fix-loop` skill owns reviewer lifecycle and the
review/fix/re-review loop. This document owns the project review checkpoints; the
linked subsystem documents remain the authorities for their contracts.

## 1. Establish scope and load the owning contracts

Record the absolute repo/worktree path, branch, review base, HEAD and the actual
reviewed state. Include committed, staged, unstaged and untracked deliverables as
applicable. A SHA identifies the reviewed state only for a committed-only scope.
For re-review, compare against the actual prior reviewed snapshot, not merely the
last SHA; if that delta cannot be established, review the full cumulative scope.
A final acceptance covers the complete current deliverable, not just the newest
commit or fix round.

Read `AGENTS.md` and supply this document and applicable requirements/contracts
to the reviewer through readable paths or embedded content. Do not assume that a
subagent inherited the caller's skill or documents. Load only contracts touched
by the change:

| Change area | Authority to read | Review focus |
|---|---|---|
| Module/composition ownership | [Architecture](architecture.md) | Actual creation sites, ownership transfers and consumers |
| Host-owned or Direct/Remote behavior | [Migration](client-server-migration.md) and [coupling](client-server-coupling.md) | Locality, semantic/wire authority, allowed composition, qualification and currentness |
| Session identity/generation, attachment or teardown | [Concurrency](concurrency.md) | Live identities, stale fences and lifecycle probes |
| Detached work, cancellation or errors | [Failure model](failure-model.md) | Promise ownership, observable failures and truthful cancellation/error taxonomy |
| Managed overlays/focus | [Overlay contract](overlay-focus-contract.md) | Logical commit before synchronous callbacks, reentrancy and physical focus |
| Public extensions | [Extension API](extension-api.md), [authoring](plugin-authoring.md) | Public semantics, caller-owned lifecycle and packed third-party coverage |
| Vendored fork | [Fork rules](../packages/pi-tui/AGENTS.md) | Consumer-layer feasibility, divergence ownership and guarding regression tests |
| DSH distribution/worktree changes | [Compatibility](dsh-compatibility.md), [local development](local-development.md) | Exact tracked target/mode, distribution boundary and independent worktree state |

## 2. Review the implementation and its system contracts

Read every changed hunk and relevant surrounding code, callers/callees, tests and
owning contracts. Use history where it explains a non-obvious invariant. Look
for real failure scenarios, not style preferences. A credible finding should
trigger a scan of its root cause across callers, siblings, symmetric operations
and equivalent paths within the affected contract; report unrelated issues
separately rather than expanding the authorized fix scope.

For applicable areas, ask:

- Who owns the fact and its composition? Did a projection, cache, presentation
  layer or local mirror become a second business authority?
- Does a new shared helper/classifier answer the intended semantic question from
  authoritative production inputs? Enumerate consumers; a union of display rows
  or a consistently reused helper is not proof of live authority.
- Are Direct and Remote implementations proving the same semantic contract?
  Are Client-local state and Host-owned facts still separate?
- Does the real generated Client/Remote retain its identity, prototype accessors
  and receiver-sensitive methods? Does the fixture reproduce the production
  prerequisites without adding a second Host service or runtime graph?
- Can stale async results commit after reconnect, session replacement or
  retirement? Do probes demonstrate real identities, generation changes,
  reentrancy ordering, attachment counts and idempotent teardown where touched?
- Are supported, unavailable, unsupported, cancelled and failed outcomes
  distinguished by the actual contract rather than a broad catch or fallback?
- Is a UI state legitimately reachable under the seat/modal contract, or only a
  projection/transient fact? Do not weaken production guards to make a fixture
  navigable.

For critical authority/classification/routing/currentness, demand a decisive
proof through authoritative production input -> derived decision -> route/policy
-> observable sink. Split tests that inject a precomputed decision do not prove
the missing production connection. This checkpoint does not create a runtime
qualification requirement for documentation-only or unrelated changes.

## 3. Qualification and evidence

Use [migration qualification governance](client-server-migration.md#migration-process-and-qualification-governance)
for L1-L6 definitions, supported success vs negative evidence, production-equivalent
fixture manifests and surface reachability. Do not redefine those classifications
here or label a structural fake as real-wire/application evidence. Wire-sensitive
and application-ownership changes need the levels required by that contract;
negative/fail-closed evidence cannot replace a supported success path.

A review fix is a new semantic delta when it changes shared-primitive
semantics/precedence, authority/identity discrimination, routing, lifecycle commit
points or capability/error taxonomy. Revisit affected production callers and
siblings, including paths beyond the original finding. Old tests that bypass the
changed primitive do not establish the new semantics. Preserve green lanes only
when their inputs and semantic dependencies are unaffected; do not mechanically
rerun every suite.

Follow `AGENTS.md` Development for build ordering, applicable validation and
non-duplication. Keep the reviewed tree frozen while a reviewer is using it.
Record each lane's command, result and corresponding state, distinguishing:

- actually run by the reporter;
- supplied evidence from another runner/reviewer;
- inherited evidence with unchanged inputs and semantic dependencies;
- skipped, not applicable, not run or failed.

Inspect CI mode conditions and nested execution before claiming a lane is
covered; overall CI success is not evidence that every lane ran. Use guarding
tests or targeted probes that would fail for the defect, not merely fixture
counts or a path that bypasses the changed decision. For documentation-only
changes, use consistency, reference and diff checks rather than unrelated builds
or runtime smokes.

## 4. PR acceptance is not stage closure

For a stage/milestone, reopen the original accepted plan and map each Must,
Must-not, acceptance, ownership, qualification, UI/UX and documentation item to
the delivered implementation/evidence. Use DONE, PARTIAL, FAIL, BLOCKED or
N/A_WITH_REASON as appropriate. DEFERRED_WITH_OWNER is valid only for an explicitly
approved scope adjustment, with owner, reason and closure condition; do not
relabel an unmet mandatory item as a non-blocking follow-up.

Migration stage closure additionally follows the original-plan closure review
and closure-evidence template in the migration governance linked above. An
accepted fix round, green CI or existing adapter alone does not close a stage.
Update live progress/evidence in the migration document and ownership in the coupling
inventory. Do not reopen unrelated frozen decisions for ordinary progress or docs-only
governance changes.

Before accepting, make a second pass over the full delivery scope for issue
classes not covered by the findings already found. Report coverage and any gaps,
concrete findings with file:line/severity/root cause/impact, verification evidence
and remaining closure work. Do not invent findings to satisfy a quota.

When using `review-fix-loop`, completion requires its final complete `accepted`
state with no unresolved P0/P1/P2; a separate NON-BLOCKER label does not waive
that requirement. Approval of a PR does not authorize a merge or establish stage
completion. If the user has activated an external review track, follow the local
dual-review agreement as well; internal acceptance cannot substitute for the
user's outstanding confirmation.
