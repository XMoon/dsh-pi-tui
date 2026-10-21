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

This rule is a REVIEW judgement, and it stays one: whether a fake exposes
more capability than its consumer USES depends on what the test is trying
to prove, which no static check can decide. A text scan of the test tree
cannot decide it either — a mention in a comment is not a consumer, and an
indirect consumer through another helper is not a text match — so the
repository does not pretend to check it. `docs/guides/code-review.md` §2
carries the question the reviewer answers.

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

### 7. Case Titles

The unit of readability is the CASE TITLE — the full name a CI reporter
shows for one `test()` / `it()`, not the file it lives in. A reader who
sees a failure in a CI log must learn, from the title alone, what condition
was set up and what result was expected.

Write the title as **condition → observable result**, in English, in the
business/lifecycle vocabulary of the system:

```ts
test('a late detach of surface A does not unbind the newer surface B', …)
```

Put the shared context in the enclosing `describe()` and let the case carry
only what is specific to it:

```ts
describe('Session switching during pending reads', () => {
  test('rejects the older session result', …)
  test('keeps the current session title visible', …)
})
```

Three rules decide whether a title needs work:

1. **No plan, milestone or review codes as the subject.** A code like `A5b`,
   `B4A-07`, `PR5`, `M3-4` or `RFL-002` is a local label from the effort
   that wrote the test. A reader of a CI log does not have that effort, so a
   title led by a code hides the behaviour. When a code has real failure
   provenance value, keep it as a short `Regression: PR #…` comment next to
   the case, not as its name.
2. **The title states the RESULT, not the topic.** "tests the writer
   admission" names a subject; "a stale scope refused at admission takes
   the distinct stale path and runs no write" names an outcome. A title
   that does not say what must be observed cannot fail loudly — the reader
   cannot tell a missing assertion from an intended one.
3. **The title does not overclaim the evidence.** A title must not say
   `real Host`, `end-to-end` or `wire` for a structural fake, and must not
   say `rejects` for a behaviour that actually ignores the input.

Titles that already satisfy the three rules are left ALONE. Renaming a
clear title creates churn and loses the history the name carries; the goal
is readability, not uniformity.

**Removing a code must not remove the MEANING around it.** A qualifier
between the code and the sentence — the category the case belongs to, the
scenario it names — is part of what the title says, so it stays:

| before | after |
|---|---|
| `B3 F4 control: with no settled entry …` | `control: with no settled entry …` |
| `A0 fullscreen seat preflight: the alt screen …` | `fullscreen seat preflight: the alt screen …` |
| `L6 §37 shell (Remote, CARRIER_GAP): the shell routes …` | `shell (Remote, CARRIER_GAP): the shell routes …` |

A BRACKETED qualifier that directly follows the code is part of the code
label and goes with it — it names the review or the variant, and a reader
of the log has neither: `PR4 F2b.2 (review round 4): …` becomes
`…: …`.

The CODE is what goes: `A5b`, `B4A-07`, `PR5`, `§1C-3`, `step 8`, `finding C`,
`assertion 7`, `A:`. Everything the title says ABOUT the behaviour stays.

**Evidence levels are not title prefixes.** `L1`–`L6` are the
Host/Client qualification tiers defined in
[host-client.md](../architecture/host-client.md#qualification-tiers); most
tests in this repository are not Host/Client evidence at all, and a
`[L1]`-style prefix on an ordinary TUI, tooling or static test is a false
label. A test that could be mistaken for a higher tier states its real
evidence once, in the enclosing `describe()` or at the top of the file, in
one sentence. Do not add a `Contract:` / `Evidence:` template to every
case, and do not add a comment to a case whose title already says it.

**Files are named by owner, not by the case.** A test file's name states
the production owner it covers. A file whose name is only a code or a
milestone (a `m3-4-pr4-guards.test.ts`) hides that owner and should be
renamed to the contract it actually guards. The file's cases then read as
ordinary English without any prefix.

A file name that already carries a MEANINGFUL subject keeps it, even when
its prefix is a milestone: `s4-d2-auto-review.test.ts` names the Auto
Review capability it covers, so only the milestone goes and the file becomes
`auto-review.test.ts`. The test is whether the name lets a reader find the
behaviour, not whether the prefix happened to be a project code.

The full name is `test/<production-owner>/<contract-or-behaviour>.test.<ext>`
in kebab-case. The directory supplies the ownership; the basename names
the behaviour without requiring any project history.

#### Worked examples

These show the SHAPE of the title to aim for. Removing the code label is
mechanical; the rest is the author's judgement.

| Instead of | Write |
|---|---|
| `PR5 §1C-3 (R6-1): only the winner stamped with THIS surface's mirror id is subtracted` | `subtracts only the winning command belonging to the active surface mirror` |
| `P1-3: attach A → attach B → late detach A leaves B bound` | `a late detach of surface A does not unbind the newer surface B` |
| `M5: a STALE command handle never untracks a later registration` | `a stale command handle cannot remove a newer registration` |
| `A5b: the composition zone is one facade plus its bootstrap helpers, and nothing else` | `the composition zone is one facade plus its bootstrap helpers, and nothing else` |

The last row is the common shape of this cleanup: the CODE is redundant,
because the enclosing `describe()` or the file's owner already supplies
the context. Dropping the code is a rename with no loss.

#### Checking the result

The case list is collected from a RUN, not from a text scan: a table-driven
case builds its title at run time, and a `describe()` chain contributes to
the title the reader sees, so a regex cannot produce the list.

The judgement "is this title clear" stays with the REVIEWER, exactly like
rule 4 above. A mechanical pass can tell that a title no longer leads
with a plan code; it cannot tell that the remaining words still say what
the case does. So the evidence for a title change is the PAIRING of the
old title with the new one, and it belongs in the pull request — not in a
manifest that has to be kept in sync with the tree.

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
| 6 — Discoverability (placement) | a new Domain, Integration or Tooling test lands in the right lane and reaches the right verification entry point | `test/tooling/new-test-policy.test.mjs` |
| 6 — Discoverability (execution) | the lane runner passes the file list relative to the repository root, so the command line fits the Windows limit, and the child runs with the repository root as its working directory | `test/tooling/test-lane-runner.test.mjs` |
| 1 — Ownership First (the read side) | every production file a test reads by path EXISTS: a renamed or moved production module can never leave a source lock silently pointing at a different file | `pnpm gate:production-reads` |

The remaining rules (1, 2, 3 and 4) are review judgements, and they
stay that way on purpose: a mechanical gate for "is this test valuable"
would either be trivially satisfiable or would force tests to be split
into shape the gate likes. Rule 4 in particular is NOT checked by a text
scan of the test tree: a mention in a comment is not a consumer, and an
indirect consumer through another helper is not a text match — a gate built
on that would be a false assurance, which is worse than no gate.
`docs/guides/code-review.md` §2 carries the question instead.

## 5. The operator tools

Four recurring reports over the living test tree. They are read-only (the
baseline generator excepted, and it only rewrites the recorded floor), and
each has a package-script entry point:

| Command | What it reports |
|---|---|
| `pnpm report:execution-topology` | the script → leaf → CI job mapping, and the leaves driven by more than one script |
| `pnpm report:zero-consumer-exports` | the shared-helper exports that no consumer reads |
| `pnpm bench:parallel` | the product lane at several concurrency levels, with every run verified |
| `pnpm baseline:fixed-waits` | regenerates the fixed-wait floor the policy guard compares against |

The benchmark is the qualification tool for the parallel policy: it
verifies every run (exit code, signal, a complete report, `fail === 0`)
and requires the levels to report the SAME case counts, so a broken or
partial run can never produce a conclusion.

## 6. What this document does NOT own

- The architecture contracts: `docs/architecture/overview.md`.
- The release and packaging procedure: `docs/guides/releasing.md`.
- The tmux and Tern-pane verification procedures:
  `docs/guides/tmux-testing.md`, `docs/guides/tern-pane-testing.md`.
- The code-review procedure: `docs/guides/code-review.md`.
