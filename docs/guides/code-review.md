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
| Module/composition ownership | [Architecture](../architecture/overview.md) | Actual creation sites, ownership transfers and consumers |
| Host-owned or Direct/Remote behavior | [Host/client contract](../architecture/host-client.md) | Locality, semantic/wire authority, allowed composition, qualification and currentness |
| Session identity/generation, attachment or teardown | [Concurrency](../architecture/concurrency.md) | Live identities, stale fences and lifecycle probes |
| Detached work, cancellation or errors | [Failure model](../architecture/failure-model.md) | Promise ownership, observable failures and truthful cancellation/error taxonomy |
| Managed overlays/focus | [Overlay contract](../architecture/overlay-focus.md) | Logical commit before synchronous callbacks, reentrancy and physical focus |
| Surface/workspace behavior | [Surface behavior](../architecture/surface-behavior.md) | Reachable states, pending/unknown settlement, workspace leases and must-not rules |
| Public extensions | [Extension API](../extensions/stable.md), [authoring](../extensions/authoring.md) | Public semantics, caller-owned lifecycle and packed third-party coverage |
| Vendored fork | [Fork rules](../../packages/pi-tui/AGENTS.md) | Consumer-layer feasibility, divergence ownership and guarding regression tests |
| DSH distribution/worktree changes | [Compatibility](./dsh-compatibility.md), [local development](./development.md) | Exact tracked target/mode, distribution boundary and independent worktree state |

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
- When the diff adds or changes a test fake or a shared test fixture: does it
  implement exactly the capability the test exercises, and no more? A fake
  with capabilities the test never uses makes the test look like it covers
  more than it does; a shared fixture with no consumer is dead weight. This
  is a review judgement, not an automatic gate — see
  [`testing.md`](testing.md) §4 for why the objective part of the rule is
  deliberately left to the reviewer.

For critical authority/classification/routing/currentness, demand a decisive
proof through authoritative production input -> derived decision -> route/policy
-> observable sink. Split tests that inject a precomputed decision do not prove
the missing production connection. This checkpoint does not create a runtime
qualification requirement for documentation-only or unrelated changes.

**If the diff touches a rendering path, walk the visual checklist.** For PiTui-painted changes, copy
`docs/architecture/design-language.md` §11.2 into the PR and answer every line — role →
token per painted string, exactly one active device per region, whole-segment
action-bar drops, keymap-derived keys, the frozen size matrix, dark/light plus the
icon densities, before/after frames from the real `VirtualTerminal` **and** a real
terminal check — then record what was actually run. Visual quality itself is an
**Owner/Reviewer judgement**: "all tests pass" never closes a visual item, and an
unrun frame or terminal check is reported `NOT_RUN`, never as PASS. The vocabulary
lives in that one document; do not restate it here.

**Renderer-qualified visual review:** For PiTui-painted ANSI changes, keep the VirtualTerminal and real-terminal checks above. For changes to **TSP-native** nodes (Picker, Strip, Reader, native overlay), the VirtualTerminal is not evidence of Tern's layout, scroll or input. In addition to the source→intent→admission→business sink proof, require the relevant versioned Tern headless client lane, real pane dimensions, node/ancestor clipping and PNG plus pointer/keyboard paths appropriate to the changed behavior. Treat the physical GUI, IME, wheel/trackpad, font scaling and the real OS dark appearance not actually run as `NOT_VERIFIED` or Owner-accepted limitations, never `PASS`; the client's own light/dark rendering is reachable headlessly (`appearance`) and in a live window via `plugins run appearance:dark` (or Preferences › Appearance), so a headless run is not by itself a reason to mark it unverified. A unit CI pass cannot close Owner visual acceptance. See [`tsp/foundation.md`](../tsp/foundation.md) §6 and the owning TSP product contract; do not duplicate their specification here.

**Major UX supersession:** When a review contains a frozen product redesign, compare the PR to the **current Owner-accepted contract**, not a historical plan's retired Must list. Confirm that the docs mark retired screens, event semantics, tests and evidence as historical, while business authority/currentness and still-valid acceptance remain intact. Avoid promoting a single panel's measured geometry into a shared SDK/renderer rule.

## 3. Qualification and evidence

Use [qualification tiers](../architecture/host-client.md#qualification-tiers) for the
L1-L6 definitions, supported success vs negative evidence, production-equivalent
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

Stage progress, closure evidence and review rounds belong to the stage's GitHub
issue/PR, never to a repository document. An accepted fix round, green CI or an
existing adapter alone does not close a stage. Update a repository document only
when the durable ownership or contract it owns actually changed; do not reopen
unrelated frozen decisions for ordinary progress or docs-only governance changes.

Before accepting, make a second pass over the full delivery scope for issue
classes not covered by the findings already found. Report coverage and any gaps,
concrete findings with file:line/severity/root cause/impact, verification evidence
and remaining closure work. Do not invent findings to satisfy a quota.

## 5. Documentation-policy gate

Read the repository documentation policy in `AGENTS.md` and `docs/README.md`
before accepting any change that touches `docs/`. Check whether the PR added or
updated a repository document. If it did, state which durable contract or
reusable procedure changed and why the new text stays useful without this PR,
milestone, branch SHA or candidate version.

If the documentation change only records task progress, review rounds,
qualification counts, a dated investigation, generated inventory copies or a
handoff snapshot, report `DOC_POLICY_BLOCKER` and do not recommend merge. A
required artifact that belongs to a GitHub issue/PR is not made compliant by
moving it to another repository path.

When a frozen older plan requires an artifact that the current policy forbids,
follow the `STOP / OWNER adjudication` rule: report the conflicting text, the
requested artifact, the violation, the current authority and one recommended
compliant disposition, and request Owner adjudication. A reviewer must not
silently omit the older plan's deliverable to make the PR green, and must not
treat the conflict as a cosmetic comment.

When using `review-fix-loop`, completion requires its final complete `accepted`
state with no unresolved P0/P1/P2; a separate NON-BLOCKER label does not waive
that requirement. Approval of a PR does not authorize a merge or establish stage
completion. If the user has activated an external review track, follow the local
dual-review agreement as well; internal acceptance cannot substitute for the
user's outstanding confirmation.
