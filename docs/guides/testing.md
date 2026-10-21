# Testing guide

This document owns the rules for ADDING and CHANGING tests in this repository.
It is the long-lived contract; the implementation lives in
`scripts/test-discovery.mjs`, `scripts/test-lanes.mjs` and the tests
themselves.

Read it before writing a test. The six rules below are the whole policy —
they are deliberately few, because a rule that cannot be applied is a rule
that gets ignored.

## 0. Where the tests live

The test tree is organised by PRODUCTION OWNERSHIP, not by feature or by
when a test was written. A test file lives in the directory of the layer
that owns the behaviour it proves:

| Directory | Owns |
|---|---|
| `test/app/` | application lifecycle, submission, session/currentness, command authority |
| `test/architecture/` | AST / static ownership / no-new-debt guards over `src/**` |
| `test/client/` | Client-local capability (clipboard, media, local files) |
| `test/domain/` | UI-neutral policy, fold, projection |
| `test/extension/` | the public extension semantics |
| `test/integration/` | cross-owner real composition, wire, release-package qualification |
| `test/runtime/direct/` | the Direct adapter |
| `test/runtime/remote/` | the Remote adapter |
| `test/runtime/parity/` | the cross-adapter parity proofs |
| `test/tooling/` | the development and release tooling itself |
| `test/support/` | shared test harness — NOT test files |
| `test/fixtures/` | test input and data — NOT test files |
| `test/tmux/` | the tmux terminal tooling |
| `test/compat/` | DSH compatibility configuration — NOT test files |

A test that spans several layers is filed under the layer that owns the
COMPOSITION it exercises, not under every layer it imports.

`test/support/`, `test/fixtures/` and `test/compat/` are excluded from
discovery by DIRECTORY, so a file placed there is never run as a test
even if its name looks like one.

## 1. The six rules

### 1. Ownership First

Put a new test in the directory of its production owner. If you cannot name
that owner, the test does not yet know what it proves — work out what
behaviour it protects before deciding where it lives.

A test that is genuinely cross-owner belongs in `test/integration/`.

### 2. Contract First

Every new test must have a failure-detection value that no existing test
already has. Before adding one, answer:

- which observable behaviour does it protect?
- does an existing test already protect the same FAILURE CLASS (not merely
  the same code path)?
- why does this test need the layer it is in?

A new production function does not imply a new test file. Two tests that
assert the same contract at the same level are a maintenance cost with no
detection value.

### 3. Evidence Integrity

Name the evidence level a test actually reaches, and never claim more:

- a structural fake can prove an ADAPTER's semantics, never a real
  Client/Host wire;
- a headless render can prove a PRESENTATION, never a real terminal's
  behaviour;
- a source-lock can prove a STATIC contract, never a runtime behaviour.

When a test touches authority, currentness or an async lifecycle, assert
the necessary intermediate state and the failure path, not only the happy
end state. A test that observes only the final state cannot distinguish
"the operation completed" from "the operation completed by accident".

### 4. Minimal Test Infrastructure

Prefer an existing narrow fixture and Node's own test runner. Avoid:

- a universal fake or a universal fixture builder;
- re-implementing production logic inside the test;
- starting the whole application for a case a unit test would cover;
- a new shared abstraction that exists only to shorten a few lines.

A fake must implement exactly the capability the test exercises. A fake
with MORE capabilities than the test uses makes the test look like it
covers more than it does.

The part of this rule that can be checked objectively is that a shared
fixture has at least one consumer: a helper nobody reads is dead weight,
and the guard enforces it. Whether a fake exposes more capability than its
consumer USES depends on what the test is trying to prove, so that half
stays a review judgement.

### 5. Deterministic Async Testing

Wait for a real event, state or operation settlement. A fixed sleep is
acceptable only when the contract itself is about a time window, and the
reason must be stated next to it.

Prefer, in order: an authoritative completion signal (a published owner, a
settled writer, a rendered frame), a positive state observation, and — for
a negative fact — a bounded observation window whose bound is justified by
a measured fact.

A negative assertion ("this did NOT happen") must not be reduced to "it did
not happen within the time we happened to wait". If the observation window
is shortened, the shortening needs a causal reason: an upstream barrier
that provably covers every producer of the effect.

### 6. Discoverability & Execution Cost

A new test must be found by the lane that owns it. The lanes are PATTERNS
in `scripts/test-lanes.mjs`, not a list of files, so a test that moves
into an ownership directory keeps being discovered. A lane that matches
nothing FAILS CLOSED — it can never report green while discovering
nothing.

Before adding an expensive test, check:

- the setup cost and whether it runs repeatedly;
- whether a lower-level test could cover most of the edge cases;
- whether the test is isolated (its own temp root, its own ports, no
  shared state).

A test must not introduce an unreasoned multi-second fixed wait.

## 2. Running the tests

| Command | What it runs |
|---|---|
| `pnpm test:product` | the product behaviour suite (the packaging safety gate) |
| `pnpm test:tooling` | the development and release tooling suite |
| `pnpm test:tmux` | the tmux terminal-tooling suite |
| `pnpm test:fork` | the vendored `packages/pi-tui` suite |
| `pnpm test` | all of the above |
| `pnpm verify:prepush` | the full pre-push pipeline |

`pnpm test:product` is the lane the packaging lifecycle (`prepack`) runs.
`pnpm test:tooling` is deliberately OUTSIDE that lifecycle: the artifact
must never depend on the developer git/CI environment.

A single file:

```sh
node --test test/tui/marquee.test.ts
```

The suite is TypeScript and runs under Node's type-stripping loader; a
`.mjs` test needs no loader.

## 3. Adding a test — the checklist

1. Name the production owner; put the file in that owner's directory.
2. Name the failure class; confirm no existing test already covers it.
3. Name the evidence level the test really reaches.
4. Reuse an existing narrow fixture; do not widen a fake's capabilities.
5. Wait on an authoritative signal; justify any time window.
6. Run the lane that owns the file and confirm it is DISCOVERED (a test that
   does not appear in the lane's file list is not running).

## 4. The objective guards

The rules above are enforced by OBJECTIVE, automatable checks — not by
review judgement:

| Rule | Guard | Where |
|---|---|---|
| 6 — Discoverability | every discovered test file belongs to exactly one lane; the lanes never overlap; the infrastructure directories are never part of a lane | `test/tooling/test-discovery.test.mjs` |
| 6 — Discoverability (the rule itself) | the discovery rule finds the root level and every nested level, never finds the infrastructure directories, never double-discovers, and fails closed on an empty lane | `test/tooling/test-discovery.test.mjs` |
| 5 — Deterministic async | a file outside the recorded floor cannot introduce an unreasoned fixed wait, and a floor file's wait count cannot grow | `test/tooling/new-test-policy.test.mjs` |
| 4 — Minimal infrastructure | a shared fixture has at least one consumer | `test/tooling/new-test-policy.test.mjs` |
| 6 — Discoverability (placement) | a new Domain, Integration or Tooling test lands in the right lane and reaches the right verification entry point | `test/tooling/new-test-policy.test.mjs` |
| 6 — Discoverability (execution) | the lane runner passes the file list relative to the repository root, so the command line fits the Windows limit, and the child runs with the repository root as its working directory | `test/tooling/test-lane-runner.test.mjs` |
| 1 — Ownership First (the read side) | every production file a test reads by path EXISTS: a renamed or moved production module can never leave a source lock silently pointing at a different file | `pnpm gate:production-reads` |

The remaining rules (1, 2, 3, and the "a fake must not exceed its
consumer's needs" half of 4) are review judgements, and they stay that way
on purpose: a mechanical gate for "is this test valuable" would either be
trivially satisfiable or would force tests to be split into shape the gate
likes.

## 5. What this document does NOT own

- The architecture contracts: `docs/architecture/overview.md`.
- The release and packaging procedure: `docs/guides/releasing.md`.
- The tmux and Tern-pane verification procedures:
  `docs/guides/tmux-testing.md`, `docs/guides/tern-pane-testing.md`.
- The code-review procedure: `docs/guides/code-review.md`.
