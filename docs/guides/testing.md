# Testing guide

This document owns the rules for ADDING, CHANGING, RETAINING and RETIRING
tests in this repository.
It is the long-lived contract; the implementation lives in
`scripts/test-discovery.mjs`, `scripts/test-lanes.mjs` and the tests
themselves.

Read it before writing or revising a test. The seven rules below are the
whole policy —
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

## 1. The seven rules

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

**Test-worthiness gate — before improving assertions.** When adding, materially
changing, retaining or retiring a test, decide whether it independently detects
a current observable failure class that existing tests or real qualification do
not already protect. Consider the maintenance and execution cost; choose
**ADD, KEEP, REDUCE or RETIRE** as appropriate. In routine changes this is a
review judgement, not a mandatory per-case matrix or new CI gate. A plan's test
roster, a previously green test or a review request does not itself establish
that a test is worth keeping.

Do not create or preserve tests solely to freeze retired names/paths, historical
migration steps, implementation-private fields, helper calls, source order,
incidental construction counts, case inventories, titles or candidate versions.
Tests that only echo a mock's own answer, reimplement the expected result or
assert a tautology have no independent detection value. Ask whether a supported
extension or behavior-preserving refactor would fail the test; if so, its exact
shape must be part of an explicit **current, durable** contract to justify the
constraint.

Static/AST guards are still appropriate for **unique load-bearing** security,
trust-boundary, authority, compatibility or architecture invariants, including
an exact owner count when uniqueness is the contract. Do not replace a retired
source-text lock with another regex, roster or proxy test by default. Deleting
a redundant test is a valid outcome without a replacement; first identify any
specific surviving contract that would otherwise lose its only proof. When a
test is retired, also inspect test-only production hooks, fixtures and branches
for actual remaining consumers before keeping or removing them.

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
covers more than it does. A shared fixture must have a real consumer.

This rule is a REVIEW judgement, and it stays one: whether a fake exposes
more capability than its consumer USES depends on what the test is trying
to prove, which no static check can decide. A text scan of the test tree
cannot decide it either — a mention in a comment is not a consumer, and an
indirect consumer through another helper is not a text match — so the
repository leaves these decisions to the reviewer.

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

**A state change is not a painted frame.** A controller that sets its
phase, model or status and only THEN asks for a repaint lets a test observe
the new state while the terminal still shows the old frame. When the case
asserts what is PAINTED — or sends a key the surface only accepts once the
action is visible — wait for the FRAME, not for the controller state. The
same applies to a key: an input that a fence drops (not holds) is lost for
good, so a wait that ends before the surface is ready loses the command
rather than delaying it.

**A fixed sleep is a guess, and a guess is both slow and flaky.** A sleep
that stands in for a delivery the test can OBSERVE costs wall clock on every
run and still races on a loaded machine. Before writing one, look for the
fact the step actually needs:

| The step waits for | Wait for |
| --- | --- |
| a typed line to reach the composer | the composer holding that text |
| an Enter to take effect | the effect (the submit callback ran, the draft cleared) |
| the surface to accept a key | the surface's own readiness signal (for a TSP tty: the input becoming deliverable) |
| a repaint to land | the painted frame |
| a NOT to happen | a bounded observation window, with the reason next to it |

A sleep that remains is a statement that the fact is NOT observable, and
its reason must say which one. Note that a shared render wait is usually
NOT such a sleep: it covers the renderer's own throttled frame, and
shortening it breaks the cases that depend on the frame having landed.

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

Use the named `mise run` tasks from `mise.toml` for routine test lanes.
For specialized scripts without a mise task, use `mise exec -- pnpm ...`
to keep the repository's pinned Node/pnpm toolchain.


| Command | What it runs |
|---|---|
| `mise run test:product` | the product behaviour suite (the packaging safety gate) |
| `mise run test:tooling` | the development and release tooling suite |
| `mise run test:tmux` | the tmux terminal-tooling suite |
| `mise run test:fork` | the vendored `packages/pi-tui` suite |
| `mise run test` | all of the above |
| `mise run verify:release` | the full explicit release pipeline |

`mise run test:product` is run explicitly by `pack:release` (and therefore by
`verify:release`). `mise run test:tooling` is deliberately OUTSIDE the packed
artifact path: the artifact must never depend on the developer git/CI
environment.

`mise exec -- pnpm smoke:split-process` is a real two-process distribution proof, not part
of `verify:release`. The no-selector DEFAULT form (the complete qualification
lane) is Linux-only: on any other OS it is refused
(`INPUT_PLATFORM_FULL_UNSUPPORTED`) before the candidate is inspected. The
`--list` / `--case` / `--suite` selector forms run on Linux and macOS, where
macOS executes the SAME registry cases through its own real tmux PTY driver.
GitHub CI runs the Linux full lane automatically only on an npm release tag;
an ordinary PR's `skipped` status is not the proof. Any npm-mode remote
`refs/heads/...` branch can run the same full, candidate-backed proof
explicitly: use GitHub Actions **Run workflow** on that branch and enable
`Run full Host/Client Split qualification on the selected npm-mode branch`
(`run_split_process=true`). The verdict then requires the Split job to succeed
on that run. The manual input stays opt-in, and Source Mode is rejected rather
than silently skipped. Host/Client split-process development work may also run
the lane manually against the actual candidate tarball and record the package
SHA, DSH version, command, and PASS/FAIL (or `NOT_RUN`).

A failed lane prints the REAL caught error (stack when available) by default;
`SPLIT_PROCESS_SMOKE_KEEP=1` only preserves the temporary scene and no longer
decides whether you can see the cause. Each lifecycle scope prints
`[split] <ISO-UTC> START <step>`, then `DONE <step> durationMs=…` or
`ERROR <step> durationMs=…`; the failure report records the failing scope as
`failedStep` and keeps the named case/subscene scopes nested (for example
`case/recovery.detached-turn-interactions/maintenance-sweep`). The structured
`failure.json` retains the raw error message/stack; the Web credential
redactor is applied only to Web-case scopes. `SPLIT_PROCESS_TRACE=<path>` still
appends optional JSONL business facts and is not required to diagnose a failure.

The lane has one command entry with a strict selector. The DEFAULT form (no
selector) is the complete qualification of the DEFAULT LANE: it runs every
registry case that is not marked selectable-only, in registry order, and emits
T60 only from the actual successful case results. Environment-gated native real-OS
cases (for example the `managed-host` systemd suite) carry `defaultLane: false`;
the default lane never invokes them and reports
`managed-host native cases NOT_RUN (selectable-only)`, so it stays safe and stable
on hosts with no isolated test environment. Run those cases explicitly with
`--case` / `--suite`:

```sh
mise exec -- pnpm smoke:split-process -- <candidate.tgz>               # complete lane (Linux only)
mise exec -- pnpm smoke:split-process -- --list                        # the selectable registry (Linux + macOS)
mise exec -- pnpm smoke:split-process -- <candidate.tgz> --suite <suite>
mise exec -- pnpm smoke:split-process -- <candidate.tgz> --case <id>
mise exec -- pnpm smoke:macos-split -- --list                          # macOS: the SAME registry, no legacy scene
mise exec -- pnpm smoke:macos-split -- <candidate.tgz> --case <id>     # macOS: the shared selected runner
mise exec -- pnpm smoke:macos-split -- <candidate.tgz> --suite <suite>
mise exec -- pnpm smoke:macos-split -- <candidate.tgz>                 # macOS: the legacy A/P/M/L parity scene (no selector)
```

The GitHub Actions `CI` workflow also accepts an optional
`split_process_case` dispatch input: when set together with
`run_split_process: true` on an npm-mode branch dispatch, the Linux Split job
runs that ONE registered case instead of the full lane (the ordinary empty
input keeps the full lane unchanged). This is the repeatable Linux evidence
path for a selectable-only case that cannot run on a developer's non-Linux
host.

`--list` prints the full selectable registry — including the selectable-only
native cases — (`SPLIT_PROCESS_SELECTABLE_CASES scope=SELECTABLE_ONLY`) with a
trailing `platforms=` fact per row (the registry's executable support range),
and exits without resolving a candidate, creating a work root or installing
anything. `--suite` and `--case` run only the registered cases of that
suite/id through their own isolated installation and print, AFTER the scoped
servers/processes/work root are quiesced, one
`SPLIT_PROCESS_SELECTED_PASS id=… scope=SELECTABLE_ONLY platform=<os>` per case
followed by `SPLIT_PROCESS_SELECTED_FACTS` with the real Host/Client identities
and the quiescence fact; a non-quiesced run prints neither. That output names
the selectable subset only — it never claims the complete inventory, a `T60`
result or a Browser/Web product qualification. A case that deliberately skips
one qualified boundary (a scene the lane cannot run honestly) prints
`SPLIT_PROCESS_BOUNDARY_NOT_VERIFIED` with its blocker; it is never silently
counted as covered. Platform eligibility is a
registry fact, not a user API: every selected case — and a whole `--suite`,
refused as a unit, never silently filtered — must support the current OS, and
an unsupported selection fails closed as
`INPUT_UNQUALIFIED` / `INPUT_PLATFORM_CASE_UNSUPPORTED` before the candidate is
inspected, a work root exists or anything is installed. Only the audited shared
cases whose registry row lists `platforms=linux,darwin` are qualified on both
Linux and macOS; every other case stays Linux-only until real native evidence
exists. On macOS the no-selector form of
`smoke:macos-split` is the legacy A/P/M/L parity scene, unchanged; a
`--list`/`--case`/`--suite` selector on either entry point dispatches the ONE
shared registry and the same selected runner, never a macOS copy of the cases
or the legacy scene. A selector accepts at most one candidate and exactly one
`--case` or `--suite` (never both, never repeated); `--list` takes neither.
Unknown options, a missing or repeated selector, an extra positional, and a
required Browser qualification flag (`SPLIT_PROCESS_REQUIRE_WEB_BROWSER` /
`SPLIT_PROCESS_REQUIRE_WEB_PRODUCT`) combined with any selection other than
`--suite web` all fail closed as `INPUT_UNQUALIFIED` /
`INPUT_SMOKE_SELECTION_INVALID` before any scene exists. The full-only
whole-lane mutation control (`SPLIT_PROCESS_SMOKE_MUTATION`) is refused in
selector modes instead of being silently applied.

A selected Web case owns its own Browser requirement: `web.official-composition`
and `web.runtime-toggle` require the real pinned Playwright Chromium,
`web.product-browser-tui` requires the complete Browser×TUI Product subset,
and `web.startup-preference` has no Browser requirement. A missing Playwright
install is a failure/NOT_RUN, never `SPLIT_PROCESS_SELECTED_PASS`. The
`--suite web` form may carry both Browser require flags; a Full run without
those flags keeps the PA/PB Host/HTTP/TTY checks mandatory while their Browser
case may be `NOT_RUN`, and the Product case may be `NOT_RUN`. Full with the
require flags demands real Chromium PA/PB PASS and the Product Browser subset
PASS.

`web.product-browser-tui` proves the current Browser×Split Host/TUI differential
subset: one packed official Web Browser and a real Split TUI sharing a Host,
competing writes, stale refusals, crash recovery and three-way file locality.
It is not an inventory of every official Web UI feature and does not claim the
real Tern GUI/TSP native gesture path, which remains `NOT_VERIFIED` under its
separate owner.

### Fresh single-package installation smoke

`mise exec -- pnpm smoke:fresh-profile -- <absolute-candidate.tgz> [--dsh <qualified-target>]`
is a DIFFERENT distribution proof from the preseed Split smoke above. The Split
lane starts with a Profile that already declares the three Client platform
packages and proves the Host/Client business lifecycle; the Fresh lane creates a
brand-new isolated Profile that installs the candidate ONCE with
`clientPlatformProvisioning: 'bundled'`, then proves:

- the profile root dependencies contain only `@xmoon76/dsh-pi-tui` and the
  profile does not install `@deepseek-ai/dsh-client-store`, `zustand` or
  `immer` itself;
- the packed Client chunk carries the Store implementation without a runtime
  external import of those three packages;
- the real Public `dsh --profile pi-tui` Direct surface paints and exits
  cleanly, and `DSH_PI_TUI_BACKEND=daemon` reaches the Host-ready,
  Client-authenticated, official-Domains-ready and painted-surface milestones
  with exactly one Host identity and one Client process while the Host
  survives the Client exit and is then explicitly stopped;
- the Client process resolves no Store closure from the Profile or the source
  checkout, and every official Client factory receives the same platform Store
  namespace object;
- the installed `dist/acp-stdio.mjs` entry is a regular file while the manifest
  carries no package `bin` and no public `./acp-stdio` export;
  `dsh --profile pi-tui acp --help` succeeds and lists `stdio`; and the PUBLIC
  `dsh --profile pi-tui acp stdio` command fails closed with the stable
  missing-Host code (exit 3, empty stdout) before this run owns any Host, fails
  closed with the stable default-off listener code while a ready Host's TUI is
  still mounted, and — only after the SAME authenticated Host access that
  `/acp` uses explicitly enables the listener — drives the official ACP SDK
  `initialize` over a real OS child of that public command. Every captured
  stdout byte must be JSON-RPC NDJSON, the child must exit through a natural OS
  close with code 0, the Host/TUI identities must survive, and the listener
  returns to disabled afterwards. A child that does not exit naturally within
  the bounded window FAILS the gate even when the emergency owned-group cleanup
  succeeds: successful reclamation is resource proof, never transport proof.

The ACP SDK client is a test-only consumer here: this lane does not create a
Turn and does not prove the Session/Turn/approval business matrix. The packed
`acp.stdio-bridge-a1` Split selected case owns that matrix and runs against the
same candidate; the Fresh lane owns the single-package distribution entry, its
default-off/missing-Host fail-closed boundaries and its coexistence with the
running Host.

Passing an earlier published tarball with `--upgrade-old <path>` additionally
runs the historical upgrade paths against the same candidate; this is
qualification evidence, not a per-CI network download. The script and CI own
the accepted `--dsh` target matrix and the platform rows; docs do not duplicate
that live inventory. F0 is the pristine release gate and does not pre-seed
`allowBuilds.koffi`; the report says `controlledKoffi: "NO"` and `pristine:
true`. Historical F1/F2 upgrades may retain an old Profile's existing policy.
`pack:release` runs this gate against the same single packed tarball after the
eight public-package smokes.

The internal Upgrade qualification is the opt-in Vitest suite described under
[Split-process Vitest E2E](#split-process-vitest-e2e); it has no selector-based
CLI, no full/selected report shape and no compatibility alias. Both artifacts
in every upgrade scene are internal qualification
packages built from this repository or the candidate under test, not a
supported historical user release; the suite does not promise user upgrade or
rollback compatibility with early unpublished development snapshots.

The complete Split Process lane and the opt-in Upgrade Vitest scenes install
packaged payloads and drive real Host/Client processes over a PTY, so they
share the same exact-runtime input rule. A selected Process case runs only the
resources its own contract needs — the `bootstrap.host-runtime-disabled`
negative starts one real Host and deliberately no TUI Client. The DSH runtime
of a run is the exact `@deepseek-ai/dsh-agent` development pin of this
checkout, and every artifact must declare that SAME pin in its own
`package/package.json` — not a range, not a floor, and not the version a file
name suggests. The production Client refuses a replacement target pinned to a
different runtime, so an artifact built against another DSH version can never
produce the behaviour these lanes assert. Such a pairing stops before any work
root, install or process exists and is reported as `INPUT_UNQUALIFIED` with the
role, the artifact identity, both exact versions and the reason: it is an
invalid test pairing, not a product regression, and the fix is to rebuild the
artifact against the current pin. The full and selected Process entries use the
same preflight; a selected case installs nothing until that preflight has
qualified the exact pin. The Upgrade Vitest projects run the same pair guard
before their Scene root exists.

A default Split Process run is diagnosable without any environment variable.
The lane announces the qualified artifact identity at startup, one checkpoint
per setup phase and per business milestone (for example the Web Product group,
stale-peer and WP11 markers, so a long scene keeps default-visible interim
progress), and one lifecycle scope per case and Recovery subscene:
`[split] <ISO-UTC> START <scope>`, then `DONE <scope> durationMs=…` or
`ERROR <scope> durationMs=…` (nested scopes print their own ERROR; the raw
stack is printed once). On failure it prints a fixed summary plus the REAL
caught error (its stack when available) and writes exactly one default-retained
artifact — a `failure.json` in a fresh private directory under the OS temp root
(directory `0700`, file `0600`), never inside the work root the lane deletes
during cleanup. The report keeps the structural fields (lane, category, stable
code, checkpoint, `failedStep`, assertion site, wait label, elapsed, target pin,
artifact name/version/SHA, expected and observed notice, recent lifecycle
entries, per-process exit and official event names) and appends the caught
`error.name` / `message` / `stack`, bounded but UTF-8 intact, so the root cause
does not disappear. A failed lane assertion is locatable through its own
`<lane>.mjs:<line>` site, derived from the real stack, restricted to the lane
scripts and their extracted case/support modules, and omitted entirely when
nothing trusted can be read. The only code a report may name is one the lane
declares; an unknown `error.code` leaves the entry at its category instead of
becoming reported text, and a report write that fails is announced as
`DIAGNOSTIC_WRITE_FAILURE` with its errno only — never turning a failure into a
pass or blocking the cleanup. A passing run writes no report.

The only redaction applied to that text is the concrete Web credential policy:
a failure whose `failedStep` is a `case/web.*` scope passes the existing
redactor over the launch token, `token=` query value, Cookie/Set-Cookie/
Authorization header and loopback origin before the terminal and the report.
Non-Web scopes keep their real error text. The diagnostics never capture raw
terminal bytes, record contents or session text on their own.

`SPLIT_PROCESS_SMOKE_KEEP=1` preserves the isolated Process work root, which
holds the real profile, session logs and private telemetry of the run; it does
not gate whether the error text is visible. That directory stays local: never
attach or upload it as evidence.

Record a lane result exactly as the lane reports it: the candidate package
SHA256, the exact DSH pin, the command, and the PASS/FAIL with the checkpoint a
failure reached. Synthetic manifest-only tarballs are input-preflight
fixtures; they never qualify a pairing.

`mise exec -- pnpm smoke:direct-empty-retirement -- <candidate.tgz>` is a Linux/PTY-only
real-DSH smoke for the Direct session-retirement contract: it boots the
candidate tarball in a fully isolated `DSH_HOME` (official dsh + dsh-base +
candidate only, no model calls) and drives `/new`/`/exit` transitions,
verifying that no retirement phase hits an already-closed write handle, that
a committed empty session is durable through the official persistence
artifact plus a real resume, and that a no-session exit materializes
nothing. It also asserts the isolated profile composition (exactly the base
and candidate bundles, an empty user patch layer, the shipped bundle patch,
no `--patch` overlay), an isolated tmux socket, and the DSH process exit
status. The candidate tarball argument is required (no published-package
fallback); it is a manual qualification lane, not part of `verify:release`.

`mise exec -- pnpm smoke:macos-cua -- <candidate.tgz>` is an explicitly selected,
operator-assisted macOS native qualification for the official Computer use
bundle. It installs the candidate into ONE isolated `pi-tui` profile, starts
the real TUI in a private tmux server, and drives the MAC-09 matrix: the real
Plugin Manager selection, the PTC `cua` tool, macOS Accessibility and Screen
Recording on the official `DSH Computer Use.app`, the application-consent
Question, the official Host Attachment Store screenshot and Client image row,
one bounded TextEdit input, per-Session consent, the Split Client
disconnect/reconnect path and bundle withdrawal. The operator supplies an
image-capable model route patch and matching credentials through
`MACOS_CUA_PROFILE_PATCH` and `MACOS_CUA_CREDENTIALS`; the lane copies both
into the disposable DSH home with `0600`, never prints them and never grants a
macOS permission itself. The operator grants the TCC permissions to the exact
helper path the lane prints and answers each consent Question in the real
TUI. A missing native prerequisite reports `MACOS_CUA: NOT_VERIFIED` and exits
non-zero; unrun cases stay `NOT_VERIFIED`. The private JSON report (candidate
and runtime identities, anonymized Session/tool/Question/attachment digests,
image dimensions and cleanup facts, never screenshot bytes or credentials) is
written `0600` under `MACOS_CUA_EVIDENCE_DIR` or a fresh private directory.
The lane is never part of `mise run test`, `pack:release`, the Split smoke or a
Linux CI lane. Its L0 input/opt-in guard is
`test/tooling/macos-cua-parity.test.mjs`.

### Split-process Vitest E2E

`mise exec -- pnpm test:split:vitest` runs the opt-in split-process Pilot E2E files
through the `split-process` Vitest project and the real tui-test terminal backend.
It is deliberately not part of `mise run test`, `mise run check`, or the release
gate. It requires `SPLIT_VITEST_TMP_BASE` (a private 0700 directory outside this
checkout) and `SPLIT_VITEST_CANDIDATE_TGZ` (the exact built candidate tarball).
The accompanying Supervisor probe is run separately with an explicit mode, for
example `mise exec -- node test/support/split-supervisor-signal-probe.mjs --mode main-signal --signal SIGTERM`.

`mise exec -- pnpm test:split:upgrade` selects only the `split-upgrade` project.
It requires `SPLIT_VITEST_TMP_BASE` plus two absolute, single-hard-link `.tgz`
artifacts from genuinely different builds: `SPLIT_VITEST_UPGRADE_OLD_TGZ` and
`SPLIT_VITEST_UPGRADE_NEW_TGZ`. Both packages must name
`@xmoon76/dsh-pi-tui`, declare a readable SemVer version and the same exact
`@deepseek-ai/dsh-agent` development pin as this checkout; the default project
requires different package versions and different SHA256 digests. The pair is
qualified before any scene root, profile install or Host exists, and an invalid
pairing fails as `INPUT_UNQUALIFIED`, not as a product regression. The default
project runs the three default business files with `maxWorkers=2` and real file
parallelism; it starts no native OS manager. The two native projects
(`test:split:upgrade:systemd`, `test:split:upgrade:launchd`) are explicit
opt-in entries only, each with `maxWorkers=1` in its own manager conflict
domain: systemd needs an isolated Linux user manager, launchd a real macOS
`gui/<uid>` LaunchAgent. A missing manager environment is a nonzero
`NOT_VERIFIED`, never a skipped pass. An empty project run exits non-zero with
no tests; that empty result is a truthful `NOT_READY`, never an Upgrade PASS.

### Split-process business Project

`mise exec -- pnpm test:split:process` selects only the `split-process-business`
Vitest project: the current business anchors of the installed Split Host/Client
path (one packed candidate, real Hosts, real PTY Clients). It is opt-in and is
not part of `mise run test`, `mise run check` or `verify:release`. The package
script always passes `--project`; invoking this config without one runs every
configured project and is not an entry point.

`mise exec -- pnpm test:split:process:optional` selects only the
`split-process-optional` Vitest project (`test/integration/split-process/optional/**/*.vitest.ts`)
with the same private `SPLIT_VITEST_TMP_BASE` and `SPLIT_VITEST_CANDIDATE_TGZ`
inputs on Linux and macOS. It keeps optional locality checks (such as Client
Git branch non-attribution in a live Remote Session) explicitly separated from
the default business project.

The bounded read-authority probe (`readAuthority`) also supports a fixed
`directory-browse` mode over Supervisor-owned Host targets (`home`, `fixture`,
`missing`, `relative`) with optional `caller` abort or `carrier` drop on the
`fixture` target, settling on `directory-browse`, `directory-browse-rejected`,
or correlated `failed` without accepting raw Worker paths. Where a native
negative (such as an unreadable directory or refused Workspace proposal) cannot
expose an internal RPC count in the PTY dropdown, the PTY lane records only a
bounded sampled observation of the visible non-fallback state; decisive native
negative settlement is `NOT_VERIFIED` because no current query completion seam
is available. Lower-level Host/Remote contract tests own the
`unavailable`-vs-empty and zero-dispatch boundaries.

The project carries two distinct kinds of evidence. The PTY anchors drive the
real terminal surface; the non-PTY installed-entry qualification drives the
product's own packed Host/Client entries as real processes for bootstrap
admission, kernel seat ownership, authenticated HTTP/WebSocket transport and
stale-Host recovery. Non-PTY qualification is not a substitute for the surface
user journey and never claims a real GUI. The same-birth Linux zombie
classification is a Linux-only case (explicit `N/A` on Darwin); Darwin uses the
real dead-Host schema-2 recovery path instead of fabricating `/proc` state.

Two further non-PTY contracts are fixed (Linux and macOS):

- An in-flight authentication cancellation is keyed by the REAL pending
  `/connect` request, never by a spawn timestamp or sleep. A test-owned loopback
  origin holds the one expected real `/connect` transaction (the synthetic token
  is not a product secret), the real installed Client is still unauthenticated
  and has no Context/Ready/failure, then the test-owned SIGTERM reaches the
  Supervisor. The Client must close within five seconds, close the held socket
  and report the one shutdown cleanup, while the original Host and a real
  already-mounted peer stay usable. The two <5s bounds are conservative
  same-Worker monotonic measurements from the real request arrival and the
  signal RPC to the awaited close, not exact OS exit timestamps.
- A cross-home profile discovery uses ONE fixed alias `DSH_HOME` whose
  `profiles/pi-tui` resolves to the SAME canonical installed profile: the scope
  id (UID + canonical profile) is identical while the discovery root is
  distinct. Its registry/launch/Host log must start absent. The real detached
  Host candidate must record exactly the product `host-seat-conflict`
  (`HOST_ALREADY_OWNED`, same scope) and no Ready/profile boot. The exact
  conflict PID and its detached process group are the terminal authority even
  when the short-lived candidate was never captured; a captured candidate is
  bound to that same PID/birth. The Supervisor must settle the alias obligation
  (real log, no publication, exact PID/group terminal, alias qualification seat
  free, exact primary seat still held) before it releases the primary Host seat
  or calls the Scene clean. An unproven alias terminal is `NOT_QUIESCED`, never
  a pass. An abnormal abort may use the no-spawn branch only when the producer
  is joined or positively never dispatched, the `ENOENT` Host log is strict and
  no candidate was ever observed. For a joined producer the independent all-PID
  scan must find no candidate; for a positively never-dispatched reservation it
  must find no captured alias entry, because an unreadable unrelated PID cannot
  be a candidate when no producer ever existed.

The Session write/recovery, shared-session interaction, prompt-policy and
detached-turn continuity owners use only declared Supervisor operations. The
Supervisor allocates private public-launch workspace directories,
startup/serialization barriers and installation-mutation targets; typed
process-Client `home`/`cwd` remain Worker-supplied and Scene-validated. The
Worker never supplies arbitrary environment, PIDs, RPC names or result
envelopes. A declared Client business `SIGKILL` is a single exact business-PID
signal, never a process-group or Host signal. Pre-ready stops and module-absence
failures return terminal-only facts; they never expose a half-ready Client
handle. A stale authenticated Peer result is derived by the Supervisor from that
Peer's actual interaction/frame identity and sent once through the existing
official result route.

A declared read-authority probe is a bounded observation input, not a second
reader: the Supervisor owns the per-Client request file and correlation nonce,
accepts only typed operations with finite windows, and dispatches one `SIGUSR2`
to the exact live business PID. A Worker never supplies a request path, raw
JSON, PID, environment or generic signal for it, and a new operation is admitted
only after the previous one reached its recorded terminal phase. A read result
proves what the mounted official backend returned; retention, writes and answer
admission need separate durable evidence. A correlated `failed` record is a
settled probe outcome, not an in-flight request. A continued answer is admitted
only for a Session/callId already present in that Client's successful official
facts; the same observed pair may still reach the product's late-answer refusal.

Destructive business probes use the same exact-PID/birth fence and one-shot
admission as `SIGKILL`: a declared business `SIGHUP` may end as either a native
signal or the wrapper's exit 129, but is never accepted as a normal client exit.
A declared replacement-Host refusal is proved by the old Client's official
identity-mismatch failure, clean shutdown inventory, native exit code 1 and a
live authenticated successor Host in the same scope; an ordinary exit or forced
kill is not that proof. Both modes remain owned by the Supervisor's close,
reclaim and finalization path, and neither widens the generic signal or normal
terminal contract.

Two fixed external Worker-kill selectors cover the added lifecycle risks:
`--case client-domain-absent` at `client-opened-before-ack`, and
`--case stale-question-peer` at `qualification-client-spawned`. Each selector
is bound to one exact business test and independently proves its live checkpoint
before the single Worker kill. The former also proves exact module restoration;
the latter proves the real Peer terminal. They reuse the existing
`ABORTED_CLEAN`/seat/root audit and add no generic selector. An unrun selector is
`NOT_RUN`, never a pass.

It requires two private inputs:

- `SPLIT_VITEST_TMP_BASE`: an existing absolute canonical directory outside this
  checkout, owned by the current user, mode 0700. Each run uses its own writable
  root under it, and the Supervisor removes only the root it created;
- `SPLIT_VITEST_CANDIDATE_TGZ`: one explicit absolute `.tgz` path that is
  already canonical, a regular single-hard-linked file owned by the current
  user with no write bits (0444), outside the checkout, and built from this
  checkout's exact `@deepseek-ai/dsh-agent` pin. The Supervisor re-reads the
  real bytes and SHA256 before a Scene root, install or Host exists; a changed
  or replaced input is `INPUT_CANDIDATE_CHANGED`.

The Process business project, the default/native Upgrade projects and the
ordinary npm-mode standalone smokes (`smoke:official-presets`,
`smoke:startup-strictness`, `smoke:job-controller-profile` and
`smoke:direct-empty-retirement`) reuse the same account-level pnpm content store
and metadata cache. The default root is
`<account home>/.cache/dsh-pi-tui-test/{pnpm-store,pnpm-cache}`. Set
`SPLIT_VITEST_PNPM_CACHE_ROOT` for the Process/Upgrade projects, or
`DSH_TEST_INSTALL_CACHE_ROOT` for the standalone smokes, to an existing absolute
canonical directory that the current user owns with mode 0700, outside this
checkout, every candidate input directory (the Upgrade projects validate both
the old and new tarball directories), the Split `SPLIT_VITEST_TMP_BASE` and the
account home itself. The two overrides are separate test-run inputs with no
fallback to each other; the standalone smokes use the same default root when
their override is unset. The override is not a product setting; it is not passed
to the Host/Client/daemon runtime environment, and Scene cleanup never removes
the cache. The standalone `smoke:direct-empty-retirement` keeps its
checkout-local work root, so its cache override must stay outside that root and
the checkout. `smoke:official-presets` reads the standalone override only in its
npm distribution branch; its source-pack branch and every smoke not listed here
keep their original environment and install path. The Upgrade projects use the
same root for the initial old Profile, both side-by-side builds, later
reload/rollback Profile installs and the explicit profile removal. Pilot, the
Fresh profile lane, Source Mode and the other smokes do not enable this cache.

Only pnpm's downloaded content and metadata are shared: every Scene or
standalone run still creates its own HOME, DSH_HOME, profile, lockfile and
`node_modules` and runs a real install. pnpm imports installed files with `copy`
and the side-effects cache is disabled. The Process/Upgrade qualified Profile
graph has no lifecycle-script or patched dependency, and its installed files do
not share a writable inode with the shared store; a future dependency of that
class must re-qualify the pinned pnpm write semantics before the same claim
applies. The standalone smokes keep their existing `--ignore-scripts` install
policy; their install-only isolation is the same, and a future executed
build/patch graph must re-qualify the pinned pnpm write semantics before the
same claim applies. The standalone smokes pass the derived environment only to
their real install/add calls: CLI version and plugin-list checks, profile
assertions, tmux/PTY sessions and the real product runtime keep the caller's
original environment. An outer runner that deletes a private work tree must keep
the cache outside that tree. Do not prune or delete the cache while a run is
active; a damaged cache is an operator cleanup after every user has stopped,
with diagnostics preserved first.

The packed npm tarball smoke (`mise exec -- pnpm smoke:pack -- <candidate.tgz>`,
which `smoke:release` runs as its first packed smoke) uses the same
test-install-cache owner for only its real npm install branch. It keeps the
original `npm install --omit=dev --no-save`, registry, lifecycle scripts and
resolution, and changes only the `--cache` location to
`<qualified root>/npm-cache`. That child is separate from the pnpm
`pnpm-store`/`pnpm-cache` children; a root may hold both, but their content is
never mixed. The default root and the same `DSH_TEST_INSTALL_CACHE_ROOT` override
rules apply (absolute, existing, canonical, current-user-owned 0700, outside this
checkout, every candidate input directory and the disposable run root), and this
entry never reads `SPLIT_VITEST_PNPM_CACHE_ROOT`. Only npm's downloaded content
and metadata are shared: every smoke still creates its own probe package,
manifest, `node_modules` and real resolution. npm keeps its own lifecycle and
integrity handling; the pnpm `copy`/side-effects/virtual-store settings are not
npm guarantees. Source Mode, `TARBALL_SMOKE_SKIP_INSTALL=1` and the other packed
smokes never enable the cache. Do not prune or delete the cache while a run is
active, and an outer runner that deletes its private tree must keep the shared
cache outside it.

An independent npm-mode smoke uses:

```sh
DSH_TEST_INSTALL_CACHE_ROOT=/absolute/private/cache \
  mise exec -- pnpm smoke:startup-strictness -- /absolute/immutable/candidate.tgz
```

A Split Process run still uses:

```sh
SPLIT_VITEST_TMP_BASE=/absolute/private/run-root \
SPLIT_VITEST_CANDIDATE_TGZ=/absolute/immutable/candidate.tgz \
SPLIT_VITEST_PNPM_CACHE_ROOT=/absolute/private/pnpm-cache \
  mise exec -- pnpm test:split:process
```

The project's files run with real file parallelism. An explicit
`SPLIT_VITEST_RUN_ID` together with the SAME value in
`SPLIT_VITEST_PARALLEL_AUDIT_RUN_ID` makes the files report a `parallel-ready`
checkpoint and prove that the other real Scene's Worker (with its live Vitest
parent edge), Host and Client kernel identities are live at the same time;
select the project's files together and use a fresh private run root per round:

```sh
SPLIT_VITEST_RUN_ID=process-overlap-r1 \
SPLIT_VITEST_PARALLEL_AUDIT_RUN_ID=process-overlap-r1 \
mise exec -- pnpm exec vitest run --config vitest.split.config.ts \
  --project split-process-business \
  test/integration/split-process/business/host-file-completion.vitest.ts \
  test/integration/split-process/business/preset-defaults.vitest.ts
```

The installed-public-entry anchor
(`test/integration/split-process/business/public-daemon-entry.vitest.ts`) joins
that same checkpoint explicitly. It drives the packed public
`dsh --profile ...` CLI under a real PTY and proves the Direct default, the
daemon cold start, public Session/preset/peer/alias/Settings paths, the public
refusal boundary and the two-cold convergent launch on Linux and macOS arm64.
The public Client is observed through the real OS process tree and the public
daemon CLI, never an internal JSONL sink. Its cold anchor runs first in the
file; the remaining public business cases run after the overlap.

The public observation seam is test-only. The production kernel readers remain
the single birth/liveness authority; the seam adds exact argv/env framing,
controlling-tty facts and bounded enumeration, and one admission predicate is
shared by normal, late and destructive callers. The opt-in authority control
(`SPLIT_VITEST_PUBLIC_AUTHORITY_CONTROL=1`) drives fixed controlled
parent/child/sibling processes through the real Supervisor; it never accepts an
arbitrary command, PID or environment. The CLI-only TERM order proof lives in
the same Supervisor handler as the real TERM: it samples the Client/CLI kernel
identities immediately after the signal and fails a CLI-first or same-sample
indeterminate outcome instead of inferring order from timestamps. Select both files in ONE Vitest invocation (the Worker parent-edge
check requires one real Vitest main), set
`SPLIT_VITEST_PARALLEL_AUDIT_PAIR=public-daemon-entry`, and use a fresh run id:

```sh
SPLIT_VITEST_RUN_ID=public-overlap-r1 \
SPLIT_VITEST_PARALLEL_AUDIT_RUN_ID=public-overlap-r1 \
SPLIT_VITEST_PARALLEL_AUDIT_PAIR=public-daemon-entry \
SPLIT_VITEST_TMP_BASE=/absolute/private/run-root \
SPLIT_VITEST_CANDIDATE_TGZ=/absolute/immutable/candidate.tgz \
mise exec -- pnpm exec vitest run --config vitest.split.config.ts \
  --project split-process-business \
  test/integration/split-process/business/public-daemon-entry.vitest.ts \
  test/integration/split-process/business/host-file-completion.vitest.ts
```

`SPLIT_VITEST_PROCESS_PROBE_POINT` arms the fixed checkpoints the external
probe uses; `SPLIT_VITEST_PROCESS_FAILURE_POINT` arms the three failure
controls. A normal run sets neither. The external probe owns every
kill/main-signal proof:

```sh
mise exec -- node test/support/split-supervisor-signal-probe.mjs --mode process-worker-kill --at <window>
mise exec -- node test/support/split-supervisor-signal-probe.mjs --mode process-main-signal --signal SIGTERM
```

`<window>` is one of `bootstrap-install`, `host-spawned-before-ack`,
`client-reserved-before-spawn`, `client-opened-before-ack`,
`terminal-owner-client-opened-before-ack`, `clients-ready`, `fallback-host-ready`,
`host-contenders-spawned`,
`qualification-client-spawned`, `host-artifact-absent-started`,
`identity-witness-spawned` (Linux only), `finalize-compensation-started`,
`public-daemon-before-registry`, `public-daemon-before-ready-ack` and
`public-daemon-ownership-refused`. The three public windows run on both Linux
and macOS; the same-birth zombie window stays Linux-only.
`--case cross-home-seat-refusal` is accepted ONLY together with
`--mode process-worker-kill --at qualification-client-spawned`. It binds the
host-seat cross-home refusal test (Linux and macOS) instead of the default
startup/exit test and requires the same external kill to end in the
alias-settlement/absence/seat facts below; any other case value or mode/at
combination is refused.
Each installed-entry window binds one exact business test and only holds after
the Supervisor registered the real live child identities. `host-contenders-spawned`
is the batch of concurrent Host contenders, `qualification-client-spawned` a
registered live qualification Client against the authenticated Host (with the
fixed cross-home case, its alias reservation is also registered and its
registry/launch are still absent),
`host-artifact-absent-started` a committed scoped installed-copy mutation with a
live Host attempt, `identity-witness-spawned` the Linux holder registration
window before its zombie child identity exists, and
`finalize-compensation-started` the joined compensation of an intentionally
failed FINALIZE while a registered Client/helper is still live. The
`terminal-owner-client-opened-before-ack` window holds after the Supervisor
registered the real PTY Owner, its native session, exact Owner/shell/business
kernel identities and before the start acknowledgement; the Owner holds the
`/dev/ptmx` master and the Supervisor holds none. Its external Worker kill must
reclaim the Owner/helper/shell/business and reach the terminal `ABORTED_CLEAN`
receipt. The ordinary terminal-owner loss proof is separate: the exact Owner
SIGKILL leaves the Host PID/birth/instance live, the Client's kernel terminal is
proven, and a fresh Client authenticates and exits against the same Host.
`finalize-compensation-started` expects the compensated `NOT_QUIESCED` receipt and a retained diagnostic root;
the other windows pass only with the terminal `ABORTED_CLEAN` receipt, the
exact Host seat free, the registered kernel identities gone or
provably reused, and — for `clients-ready` — a separate real sibling Scene
already live at its authenticated checkpoint when the target is signalled,
held across the target's reclaim, then released to continue its own business
path and finalize. The `--case cross-home-seat-refusal` run additionally
requires the settled cross-home facts: the recorded real conflict (or the
admitted no-spawn branch), alias registry/launch absence, the alias
qualification seat free, the primary seat held before release, and no live
detached alias candidate after the root is removed. A checkpoint reached
without an external signal fails; an unrun window is `NOT_RUN`, never a pass.

The two positive public windows bind the cold installed-public positive test
(`starts one real public daemon Client and Host from the installed CLI`) on
both platforms; `public-daemon-ownership-refused` binds the separate negative test
(`refuses an unproven public Host ownership signal and compensates truthfully`).
The `public-daemon-before-registry` hold is after the detached Host/CLI/Client
are real but before the product registry is published. The external observer
rechecks the exact registry absence and the live birth-bound CLI/Client/Host
edge immediately before SIGKILL; if the registry is already published at that
point the window is `NOT_VERIFIED`/STOP, never a forced pass. A registry that
appears naturally after the trigger is handled by the ordinary bounded late
material reconciliation and official Host authentication; there is no
probe-owned registry-release flag or wait. The positive receipt must prove the
startup/close handler settlement join, the same captured identities, native
session/foreground/Host group terminality, both seats and material terminal,
a complete root removal, and the external Worker exit.
`public-daemon-before-ready-ack` holds after registry/authentication/surface but
before the Client start acknowledgement. The ownership-refused negative control
supplies a mismatched expected Host birth to the SAME destructive admission
boundary used by ordinary reclaim: the admission must reject it before any
TERM/KILL, the external probe must observe the same live target and no signal
attempt, then the probe releases compensation; the final receipt is
`NOT_QUIESCED` with a retained diagnostic root and a completed compensation.
A receipt that claims a signal attempt, loses the live target, or does not
complete the compensation is not this negative control's pass.

Additional reusable rules shared by the `split-process-business` and
`split-process-optional` projects:

- **Bounded bracketed paste (`client.paste(text)`):** accepts only non-empty
  UTF-8 text (<= 64 KiB, no `ESC` or `NUL`). Workers receive no generic
  raw-write API, and plain `type`/`Enter` is never a substitute for clipboard
  paste.
- **Native shell/sandbox prerequisites and Store readback:** Host workloads are
  fixed allowlisted scenarios with Supervisor-derived directories and no Worker
  path, env or raw-byte injection. Attachment proofs verify stored bytes via the
  Host's official Attachment Store (`readFileStream` / `readImage`). Two-OS
  shell/sandbox qualification requires a non-root user, real full POSIX sandbox
  enforcement, and a canonical private 0700 run root outside the checkout and
  outside OS temp (`TMPDIR`/`TMP`/`TEMP`) so the outside-workspace sibling
  target is genuinely outside both the Session workspace and temp.
- **History typed reads and `split-process-optional`:** history reads use typed
  Supervisor-owned directory targets (never raw `cwd` or generic RPC).
  `split-process-optional` is run separately from `split-process-business`; an
  unrun optional lane is `NOT_VERIFIED`, and passing it does not retire legacy
  cold-proof-hit or sentinel qualifications.

This Project is not the release full lane. `smoke:split-process` and
`smoke:macos-split` remain the separate distribution-boundary lanes described
above.

### Isolated single-file and probe runs

Prefer a repository-owned lane; it already owns and removes its disposable
temp root:

```sh
mise exec -- pnpm test:product -- --test-concurrency=4
```

A single file, or a probe outside any lane, runs through the containment
runner with a private, worktree-owned temporary base:

```sh
mkdir -p temp/test-runs
TMPDIR="$PWD/temp/test-runs" \
TMP="$PWD/temp/test-runs" \
TEMP="$PWD/temp/test-runs" \
node scripts/run-with-temp-root.mjs \
  node --test test/tui/marquee.test.ts
```

The suite is TypeScript and runs under Node's type-stripping loader; a
`.mjs` test needs no loader. `run-with-temp-root.mjs` creates one run root
under that base, points the child's `TMPDIR`/`TMP`/`TEMP` at it, and removes
the root once the run settles — normal exit, handled interruption or spawn
failure. A root it cannot prove unused is kept and the run is non-zero;
`DSH_TEST_KEEP_TMP=1` keeps the root for debugging.

Never run a fixture or a delegated review probe against the shared `/tmp`
root, and never create a shared `/tmp/node_modules` link or any other
globally visible artifact to make one resolve. Clean up only resources the
current run owns, and pass these constraints to every subagent you delegate.

A longer private temporary path can break a UI test that assumes a short
path: fix the test's path assumption instead of reusing the shared `/tmp`
root.

### Retained failure artifacts: investigate, then clean up

A failing smoke may intentionally retain a diagnostic report (for example,
`dsh-pi-tui-smoke-failure-*/failure.json`); documented keep settings can also
preserve a temporary work root. These artifacts are for investigation, not
indefinite storage. The executing agent is responsible for its runs, including
probes it delegates:

1. Record the exact retained paths from the run output and use them to diagnose
   the failure.
2. Once the investigation is complete, whether the failure was fixed, confirmed
   as a baseline issue or left unresolved, remove this agent's artifacts that
   are no longer needed. Confirm owned processes have stopped before deleting
   their resources; never delete by a broad `/tmp` prefix or glob.
3. Preserve artifacts needed for handoff and evidence explicitly requested by
   the operator (for example, an `--out` path or a documented evidence
   destination). Do not remove another run's artifacts. For each handoff
   artifact, identify its exact path, purpose and cleanup owner.
4. In the final task report, confirm cleanup of the agent's failed-run artifacts
   and enumerate any intentionally retained paths with their reasons.

## 3. Adding a test — the checklist

1. Name the observable failure class and check existing tests and real
   qualification for independent coverage; add nothing if no gap remains.
2. Check that a legitimate extension or refactor does not break the proposed
   assertions unless their exact shape is itself a durable contract.
3. Name the production owner; put the file in that owner's directory.
4. Name the evidence level the test really reaches.
5. Reuse an existing narrow fixture; do not widen a fake's capabilities.
6. Wait on an authoritative signal; justify any time window.
7. Run the lane that owns the file and confirm it is DISCOVERED (a test that
   does not appear in the lane's file list is not running).

## 4. The objective guards

The objectively checkable parts of the rules above have automatable guards;
test worthiness and assertion quality remain review judgements:

| Rule | Guard | Where |
|---|---|---|
| 6 — Discoverability | every discovered test file belongs to exactly one lane; the lanes never overlap; the infrastructure directories are never part of a lane | `test/tooling/test-discovery.test.mjs` |
| 6 — Discoverability (the rule itself) | the discovery rule finds the root level and every nested level, never finds the infrastructure directories, never double-discovers, and fails closed on an empty lane | `test/tooling/test-discovery.test.mjs` |
| 5 — Deterministic async | a file outside the recorded floor cannot introduce an unreasoned fixed wait, and a floor file's wait count cannot grow | `test/tooling/new-test-policy.test.mjs` |
| 6 — Discoverability (placement) | a new Domain, Integration or Tooling test lands in the right lane and reaches the right verification entry point | `test/tooling/new-test-policy.test.mjs` |
| 6 — Discoverability (execution) | the lane runner resolves the file list in its child and passes it in memory to Node's native test API, never on the process command line; Node still owns sharding, and the child runs from the repository root | `test/tooling/test-lane-runner.test.mjs` |
| 1 — Ownership First (the read side) | every production file a test reads by path EXISTS: a renamed or moved production module can never leave a source lock silently pointing at a different file | `mise exec -- pnpm gate:production-reads` |

The remaining rules (1, 2, 3 and 4) are review judgements, and they
stay that way on purpose: a mechanical gate for "is this test valuable"
would either be trivially satisfiable or would force tests to be split
into shape the gate likes. Rule 4 in particular is NOT checked by a text
scan of the test tree: a mention in a comment is not a consumer, and an
indirect consumer through another helper is not a text match — a gate built
on that would be a false assurance, which is worse than no gate.

## 5. The operator tools

Four recurring reports over the living test tree. They are read-only (the
baseline generator excepted, and it only rewrites the recorded floor), and
each has a package-script entry point:

| Command | What it reports |
|---|---|
| `mise exec -- pnpm report:execution-topology` | the script → leaf → CI job mapping, and the leaves driven by more than one script |
| `mise exec -- pnpm report:zero-consumer-exports` | the shared-helper exports that no consumer reads |
| `mise exec -- pnpm bench:parallel` | the product lane at several concurrency levels, with every run verified |
| `mise exec -- pnpm baseline:fixed-waits` | regenerates the fixed-wait floor the policy guard compares against |

The benchmark is the qualification tool for the parallel policy: it
verifies every run (exit code, signal, a complete report, `fail === 0`)
and requires the levels to report the SAME case counts, so a broken or
partial run can never produce a conclusion.

## 6. What this document does NOT own

- The architecture contracts: `docs/architecture/overview.md`.
- The release and packaging procedure: `docs/guides/releasing.md`.
- The tmux and Tern-pane verification procedures:
  `docs/guides/tmux-testing.md`, `docs/guides/tern-pane-testing.md`.
