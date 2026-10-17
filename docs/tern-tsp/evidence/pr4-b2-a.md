# PR4-B2-A headless basic commands evidence

This record covers the PR4-B2-A slice: admitting the already-implemented
PiTui-free TUI builtins to the TSP capability gate and making their confirmed
outcomes visible on the Tern surface. The historical PR4-0 / B1 capability
observations remain in their own files; this slice supersedes their
`NOT_REACHABLE` verdicts for exactly the commands listed below and for nothing
else.

The exact baseline commit SHA and the per-lane run ledger live in the PR
description (this file records the durable version pins and the result tiers).

## Runtime manifest

- `@stencil-hq/tern@0.1.0` (`pnpm-lock.yaml` resolution + integrity recorded in
  the PR description), DSH `@deepseek-ai/dsh-agent@0.2.0-rc.2` (npm mode),
  Node `24.21.0`, pnpm `11.7.0`.
- Real Tern CLI observed on this machine: `tern 0.9.2 (23735aa)`. The B1-B
  record's `0.8.4` is its own historical observation and is not reused here.
- These are observations, not a compatibility promise.

## Scope and evidence boundary

- The renderer remains experimental and opt-in (`DSH_PI_TUI_RENDERER=tsp`);
  PiTui and Direct remain the production defaults and are unchanged.
- No new picker, overlay, modal or navigation surface is introduced. The
  command line is still typed into the existing TSP composer, classified by the
  existing authority, admitted (or refused) by the same
  `tspBuiltinAvailability` gate at the same post-classification site, and then
  executed by the unchanged business handler.
- Notification follows ONE rule per command family, and never repeats an
  outcome the official Direct command-result card already carries:
  - `/title` / `/rename`: the card carries the handler's `CommandResult.text`
    (success text and error text alike) whenever the invocation executes on the
    Direct command plane, so the handler's own notice is suppressed exactly
    there — `titleRefusalNoticeOwner` / `titleSuccessNoticeVisible` (each derived
    from the mounted presentation + the command plane by the composition root in
    `registerCommands()`, after the mount).
    The PiTui surface keeps its long-standing notice beside the card, and the
    Client-registry path (no card) keeps the only feedback. The two results
    WITHOUT their own text (`no conversation yet — title left as-is`, `title
    regenerated: …`) always notify, because the card has no body to carry them.
    Other title outcomes (stale/transitioned/unsupported/thrown) keep their
    existing single owner: the Direct card.
  - the other B2-A commands (`/yolo`, `/logout <target>`, `/copy`): a CONFIRMED
    success is additionally written through the existing renderer-neutral notice
    sink on a non-PiTui mount (the frozen plan's §S2 supplement, keyed on
    `runner.app === undefined`). Refusal/cancellation/indeterminate keep their
    existing owner (the Direct card, or the controller's own local-command
    notice for the sessionless path). This is the plan's frozen behavior; the
    title rule above is narrower because the Owner ruled (relayed in the B2-A
    session) that a `/title` success must show the card plus the authoritative
    title and no duplicate Dock line.
  - **card-less transport (review F1/F4).** The Direct command plane appends the
    official `command/run` + `command/done` rows (the card); the Remote Client
    command registry appends none, so a returned `CommandResult.error` had NO
    visible owner there and the user saw only a restored draft. The submission
    controller now publishes that error text exactly once **inside the Client
    registry branch itself** — the branch that already knows this invocation has
    no card. The owner is therefore FROZEN at dispatch: the settlement performs
    no classification and holds no catalog-derived fact, so a Host-origin catalog
    change mid-flight can neither hide a Client-route error nor duplicate a
    Host-route one (F4). The scope is the B2-A command set
    (`TSP_B2A_RESULT_NOTICE_COMMANDS`, derived from the admitted set plus
    `/logout`); Host commands, the sessionless local path (which notifies itself)
    and sibling TUI commands (`/preset`, `/model`, …) keep their own owners.
- Direct business-path evidence is the real Host composition
  (`test/support/direct-tsp-fixture.ts`: real rc.2 services, real live Agents,
  the real runner/SubmissionController, the real TSP renderer over the shipped
  SDK `connect`). Only the model endpoint is scripted; the B2-A cases that need
  an authority the base fixture does not compose mount the SHIPPED plugin for it
  (`dsh-session-title`, `dsh-permission-presets` + approval/turn-outline,
  `dsh-authorization`), and the credential-port negative uses the explicit
  no-credentials composition (`withoutCredentials`).
- Tern Headless is **not** a physical GUI/OS-clipboard proof.

## Supported / unsupported matrix (this PR)

| Input | TSP result | Note |
|---|---|---|
| `/new` | SUPPORTED | Sessionless: only the target transaction creates a Session |
| `/fork` | SUPPORTED | Sessionless refuses without creating one; an existing Session enters the Host fork |
| `/title <text>`, `/rename <text>` | SUPPORTED | The same authoritative `SessionWriter` title write; alias parity |
| `/title`, `/rename` | SUPPORTED | The Host refresh-title path; a blank Session reports it truthfully |
| `/copy` | SUPPORTED — **qualification gap, see below** | Copies the authoritative last assistant text through the unchanged Clipboard Policy |
| `/yolo` | SUPPORTED | The official permission-preset writer; `unavailable`/`indeterminate` keep their original text |
| `/logout <target>` | SUPPORTED (explicit target only) | The original resolver runs; `unsetReference`/`deleteRecord` semantics unchanged |
| `/logout`, `/logout   ` | UNSUPPORTED | Draft restored, no picker call, no credential mutation |
| `/login`, `/display`, `/focus`, `/reload`, `/settings`, `/footer`, `/keybindings`, `/help`, `/status`, `/tasks`, `/subagents`, `/plugins`, `/rewind`, `/export`, `/transcript`, `/attach`, `/image`, bare `/skill`, `!`/`!!` | UNSUPPORTED (unchanged) | Needs PiTui UI or a not-yet-existing TSP surface |
| Genuine Host same-name command, extension/skill/ordinary input | Not touched by this gate | The production classifier's original winner decides |

## Frozen-plan acceptance coverage (A01–A20)

| ID | Status | Evidence |
|---|---|---|
| A01 — `/new` creates and publishes a real new Session | PARTIAL | `tern-tsp-headless-commands.test.ts` (A01): one persisted Session after the first `/new`, a different live owner after the second, zero model turns. The create/preflight-failure and abort branches are NOT exercised end to end here — they live in the unchanged session-runtime/lifecycle tests |
| A02 — `/fork` from the current Session; sessionless refuses | PARTIAL | Same file (A02 ×2): the sessionless refusal publishes no owner and persists nothing; the fork child is persisted with `parentSession === source`. The late-A/A→B→late-A navigation race and the failure-after-published-child path are NOT re-qualified here (they are the unchanged `SessionRuntime`/lifecycle tests' subject) |
| A03 — `/title <text>` writes and rereads the authoritative title | PARTIAL | Same file (A03/A04): the folded title read back from the live Session equals the new value, and the result is card-owned with no duplicate Dock line. The stale-owner / writer-held / indeterminate title outcomes are NOT witnessed end to end here (unchanged handler/runtime branches; the stale writer-held mapping is asserted in `a3-command-identity.test.ts`) |
| A04 — `/rename` is the same sink; Host `/rename` is not captured | PASS | Same file: A03/A04 drives the TUI `/rename` alias to the same authoritative title; A14 registers a GENUINE Host `/rename` and asserts its own handler ran once with the exact rawInput while no TUI title/rename write or notice occurred |
| A05 — bare `/title` (and bare `/rename`) regenerates when supported; a blank Session reports truthfully | PASS | Same file (A05 ×2): the deterministic fallback replaces the pinned title and the bare `/rename` alias reaches the same refresh with fresh feedback; a REAL persisted blank Session resumed through the official persistence seam receives the mandated `no conversation yet — title left as-is` Dock notice for BOTH bare forms, invents no title and starts no model turn |
| A06 — `/copy` uses the scope-pinned last assistant text | PASS (Direct) | Same file (A06 ×3): the emitted OSC 52 body is the base64 of the authoritative text (TMUX-agnostic assertion); the no-message case fails visibly and emits nothing; the BOTH-legs-fail case fails the real tty write one-to-one AND clears `TMUX`/`DISPLAY`/`WAYLAND_DISPLAY` for the gesture (restored after) so the POSIX helper chain is deterministically absent, and the failure is reported, never a successful copy. The case is skipped on macOS/Windows, where the shared policy attempts `pbcopy`/`clip` unconditionally and the e2e cannot fail that leg without touching the developer's real clipboard |
| A07 — `/yolo` goes through the official permission writer | PARTIAL | Same file (A07 ×2): with `dsh-permission-presets` mounted the live Session's approval policy reads `never`; without it the original `unavailable` text is shown, never success. `refused`/`superseded`/`indeterminate` have only the unchanged handler's source-shape/port guards (`a3-command-identity.test.ts:303,325`) — no behavioral Direct witness. No synthetic writer was injected (`permission-cycle.test.ts` covers the Shift+Tab cycle, NOT `/yolo`) |
| A08 — `/logout <reference>` clears through the credential port; an unavailable OR throwing port never reports success | PASS | Same file (A08 ×3): `resolve()` is defined before and `undefined` after with no message carrying the secret value; the `withoutCredentials` composition makes the real port report unavailable and the handler refuses truthfully; a reversible one-to-one fault on the production credentials service's `unset` (unwrapped Cordis identity, restored by identity) makes the port throw — the existing command-error path surfaces the failure, the stored reference survives, and no message claims a cleared credential |
| A09 — `/logout <keyless-flow-route>` reaches `deleteRecord` | **NOT_VERIFIED** | No authorization-flow provider is installed in this environment; the real seam is mounted, `list()` is empty, and the case is exercised as a truthful refusal (`unknown credential target`, no record mutation). No flow is simulated. `/logout` support is therefore limited to the **reference case**; the flow-route gap is reported to the Owner |
| A10 — bare `/logout` (and its whitespace-only form) is refused by the gate | PASS | Same file (A10): both the bare and the `/logout   ` gesture restore the exact draft, open no picker, and leave the stored credential intact; the refusal is reported exactly once |
| A11 — an unresolvable target returns the real error | PASS | Same file (A11): a hyphenated route reaches the handler's `flowForRoute` branch and reports `unknown credential target` (never the bare UI). Note: an env-var-shaped token such as `nonsense` is the pre-existing literal-reference path (`unsetReference('NONSENSE')`), which the same test's route case deliberately bypasses |
| A12 — `/model`, `/preset`, `/sessions`, `/resume`, `/search` keep working | PASS (inherited) | Unchanged by this PR; covered by the B1 suites and rerun as regression |
| A13 — every remaining PiTui-only builtin stays refused | PASS | Same file (A13): nineteen registered names in one session (`/settings`, `/help`, `/status`, `/rewind`, `/tasks`, `/subagents`, `/plugins`, `/reload`, `/export`, `/transcript`, `/attach`, `/image`, `/login`, `/skill`, `/display`, `/focus`, `/footer`, `/statusline`, `/keybindings`), each restoring its draft with a fresh notice; no Session, no model turn. The capability-gated siblings stay covered by their own suites (`/sessions`/`/resume`/`/search` refusal in `tern-tsp-direct-admission.test.ts`; `/model`/`/preset` presenter gating in the PR4-A suites), and `!`/`!!` by `tern-tsp-runner-interactive.test.ts` |
| A14 — genuine Host same-name winners keep their sink; an unclaimed argued line is not re-owned | PASS | Same file (A14 ×2): five genuine Host handlers (`/new`, `/copy`, `/logout`, `/title`, `/rename`) each ran once with the exact rawInput while no TUI write/notice/clipboard/credential effect occurred; an argued `/new argued-line` on an execute-kind Host descriptor is classified ordinary-submission — it reaches the MODEL, the Host handler never runs, no extra Session is created, and it is not refused as a TSP builtin |
| A15 — extension / skill / ordinary lines are never captured | PASS (inherited) | `tern-tsp-direct-admission.test.ts` (unchanged) |
| A16 — a no-panel builtin is never steered while running | PASS | Same file (A16, `busyEnter: 'steer'`): `/title` wrote while the turn ran with zero prompt writes; the following plain prompt steered |
| A17 — confirmed title/permission/logout/copy outcomes are visible | PASS | `/title` on TSP+Direct is card-owned with no duplicate Dock line: the RFL-001 witness counts the refusal across the WHOLE folded pane (exactly ONE visible sink, zero notice lines), A03/A04/A16 assert the card carries the success text while the Dock does not, and A05 keeps the two no-text notices. The plan-mandated success supplement is visible for `/yolo`/`/logout`/`/copy` (A07/A08 and the A06 real-client run); the gate/local refusals appear exactly once (A02/A10) |
| A18 — SDK decline falls back to PiTui unchanged | PASS (inherited) | `tern-tsp-renderer-selection.test.ts` (unchanged by this PR) |
| A19 — `/copy` after the emission keeps the Tern channel healthy; the OS clipboard receives the text | PASS | Agent-run real-Tern lane: the OSC 52 bytes reached the Tern tty, a later input still reached the clipboard policy, and the close flow settled. Owner-run (supplied evidence, not re-run by the agent): the OSC 52 copy in a real terminal reached the system clipboard. The agent cannot automate an OS-clipboard read in this environment, so that half is Owner-attested — see the qualification section |
| A20 — PiTui defaults are unchanged | PASS | `login-credentials`, `session-state`, `command-catalog`, `busy-enter` and the TSP suites rerun on this tree; `notifyTitleRefusal` reaches the same PiTui notice the base already emitted, and `notifyTitleSuccess`/`notifyOutcome` are no-ops wherever a `TuiApp` is mounted |

## `/copy` qualification gap (STOP_COPY_QUALIFICATION)

The plan requires a real-Tern clipboard qualifier as the merge gate for
`/copy`. What was measured:

- **OSC52_EMITTED (REAL_TERN_HEADLESS, Tern 0.9.2).** The production Direct/TSP
  subject launched inside a real headless Tern pane has `process.stdout.isTTY
  === true`; `/copy` typed through the real composer wrote exactly
  `ESC ] 52 ; c ; Q09QWS1NRS1SRUFMLVRFUk4= BEL` to the Tern-managed tty — the
  base64 of the authoritative assistant text — and the client painted the
  result notice. The recorded chunk is a one-to-one pass-through recorder: the
  original write still happened.
- **Channel integrity.** After that raw escape travelled over the same tty, a
  second `/copy` reached the same policy and emitted the sequence again, and
  `/exit` completed the production teardown with process exit 0 — the frame
  parser, ACK path, input loop and close flow were not broken by the OSC 52
  bytes. No `STOP_COPY_TSP_TTY`.
- **Native/helper leg: NOT_REACHED.** The Tern-launched subject inherits the
  serve process environment, which carries no `TMUX`; with no display and no
  clipboard helper on this machine the helper chain cannot accept anything. The
  tmux-buffer readback that the flow performs when `TMUX` is present was
  therefore measured as not reached.
- **OS clipboard: NOT_VERIFIED.** Nothing in this environment can observe the
  target clipboard changing, so the result may not be reported as
  `CLIPBOARD_CHANGED`.
- **Owner-reported OS clipboard success (supplied evidence).** The Owner ran
  the OSC 52 copy in a real terminal and confirmed the text reached the system
  clipboard. Combined with the agent-run channel-integrity lane this clears the
  plan's `STOP_COPY_QUALIFICATION`; the provenance stays split on purpose
  (agent: emission + channel; Owner: the real clipboard), because the agent
  cannot automate an OS-clipboard read here. The implementation is the
  unchanged Clipboard Policy — no helper-only shortcut and no Tern-specific wire
  call. `/copy` therefore reads PASS at the `OSC52_EMITTED` + Owner-verified
  clipboard tier; a fully automated cross-platform clipboard assertion remains
  out of scope for this PR.

## Acceptance limits (why some rows are PARTIAL)

This slice admits commands to an existing business closure; it does not
re-implement their internal state machines. The rows marked PARTIAL above are
limited to the TSP end-to-end tier, and their remaining branches stay the
unchanged owner's subject:

- A01/A02/A03 failure, stale and race branches: `SessionRuntime` /
  `DirectSessionWriter` / lifecycle tests, plus the `a3-command-identity` branch
  guards. Nothing in this PR changes those branches.
- A07 `refused`/`superseded`/`indeterminate`: the unchanged handler's branch
  mapping (source-shape guards) with no behavioural Direct witness; no synthetic
  permission writer was injected to manufacture one.
- The A06 cases that drive the REAL copy policy (the OSC 52 emission and the
  both-legs-fail fault) are skipped on macOS/Windows: the shared policy attempts
  the native helper unconditionally there, so the e2e cannot keep the gesture
  off a developer's real clipboard. On POSIX both cases clear
  `TMUX`/`DISPLAY`/`WAYLAND_DISPLAY` for the gesture (restored after), so only
  the terminal-client leg is exercised.
- A09 flow-route logout: no flow provider exists in this environment.
- A19 OS clipboard / physical GUI / Remote TSP: not observable or not
  qualified here, as recorded above and in the B1 evidence.

## Qualification tiers used

| Tier | What it is | Used for |
|---|---|---|
| Direct L6 | `test/tern-tsp-headless-commands.test.ts` over the real Direct composition + scripted TSP pane | A01–A08, A10, A11, A13, A14, A16, A17 |
| Remote L6 | `test/runner-remote-command-plane.test.ts` (real Remote composition, real Client registry / HostCommandPort; `F1 Remote` ×3 on PiTui + one Remote+TSP mount + the F4 forward race) | the card-less error owner (F1), the mid-flight catalog race (F4), the no-double-notification rule |
| Pure unit | `test/tern-tsp-command-admission.test.ts` (the predicate, the `/logout` input-shape rule, the title ownership tables and the notice scope) | the gate and the title notice policy |
| REAL_TERN_HEADLESS | `scripts/tern-pane-drive.mjs scripts/tern-pane-b2a-copy.mjs` (real Tern 0.9.2, real keys, real tty) | A19 (channel integrity + OSC52 emission) |
| Inherited | B1-B / PR4-0 suites rerun unchanged | A12, A15, A18 |

## Review closure

The independent review of the first implementation snapshot raised four findings
and closed all of them on the final tree; the per-command statuses above are the
reviewed mapping:

- **RFL-001 (closed) — duplicate title refusal on TSP+Direct.** A rejected or
  indeterminate `/title` appeared in both the Dock notice and the Direct
  command-result card. Closed by the composition-owned, title-only
  `titleRefusalNoticeOwner`/`titleSuccessNoticeVisible` facts (mounted
  presentation + command plane,
  set at registration after the mount) and the per-outcome notice entries. The
  witness counts the message across every live folded node (exactly one visible
  sink) and separately requires zero Dock notices.
- **RFL-002 (closed) — Host precedence negatives.** Genuine Host `/rename` and
  the execute-kind Host `/new argued-line` now have production
  source → controller → sink witnesses (A14).
- **RFL-003 (closed) — copy-policy e2e portability.** The A06 cases that drive
  the real copy policy now clear the POSIX helper gates only for the gesture
  (restored in `finally`) and skip on macOS/Windows, where the shared policy
  attempts the native helper unconditionally; the suite therefore cannot write
  its synthetic text into a real clipboard.
- **RFL-004 (closed) — changelog wording.** Both bilingual entries describe the
  command-specific outcome presentation (title results: Direct card; `/yolo`,
  `/logout`, `/copy`: planned Dock supplement).
- **F4 (external review, closed) — the card-less owner was re-derived at
  settlement.** The first F1 fix answered "does this result have a visible
  owner?" by re-running the line classifier at settlement, which consults the
  LIVE Host-origin catalog; a catalog change between dispatch and settlement
  could hide a Client-route error or duplicate a Host-route one. The owner is now
  fixed where the route is chosen (the Client registry branch), and the
  settlement-side fact was removed entirely. Witnessed by (a) a Remote `/copy`
  whose tty write registers a genuine Host `/copy` mid-flight — the route stays
  Client (no `command/run` row) and the error is published exactly once, and (b)
  a Direct `/copy` dispatched on a genuine Host claim that is revoked while the
  handler runs — the Host result card stays the only presentation (no extra Dock
  line). The second witness proves the freeze; the first covers the reviewer's
  requested mid-flight-catalog scenario end to end.
- **F5 (external review, closed) — a late outcome could land on the
  replacement Session.** A `/resume` starts its transition asynchronously and
  releases the submission FIFO, so a subsequent command can execute while the
  OLD Session is still current and settle after the replacement was published.
  Two supplements could therefore reach the new owner's surface: the card-less
  Client-route ERROR notice and the `/copy`/`/yolo` confirmed-success lines.
  Both are now fenced by the SAME captured Session scope the settlement uses
  (`deps.scope.isCurrent` / `runner.isSessionScopeCurrent`), with no settlement
  re-classification, no global notice owner and no new barrier. Witnessed by (a)
  a controller-level scenario where the owner is replaced while a Client command
  executes — the stale error is silent, while the same-session control receives
  it exactly once, and (b) a real Direct/TSP interleave: a `/resume` transition
  held inside the official resume gate plus a `/copy` whose native clipboard
  helper blocks on a marker, released only after the replacement became current
  — the late success is not announced on the new owner.
- **F1 (external review, closed) — card-less command errors were invisible.**
  On the Remote Client command registry no result card exists, so a returned
  `CommandResult.error` reached neither the Dock nor a card. The submission
  settlement now publishes it once, scoped to the B2-A commands and only when no
  card exists; the title refusal ownership moved to a three-state owner so that
  fix cannot double-report. Witnessed on the real Remote composition
  (`/copy` no-answer, `/yolo` unavailable, sessionless `/logout` exactly once)
  and on a Remote+TSP mount (the error reaches the Dock).

The reviewer explicitly accepted the plan-mandated success supplement for
`/yolo`/`/logout`/`/copy` (Dock + Direct card) as frozen §S2 behavior, and the
narrow `/title` card-ownership as the Owner-approved adjustment to it. Per
`docs/code-review.md`, this acceptance is a review verdict on the deliverable —
it is not stage closure and not permission to merge, and A09 / the OS-clipboard
qualification / physical GUI / Remote TSP remain outside it.

## Deliberate non-goals

- No new panel/picker/overlay/button; no second command dispatcher, registry or
  `TuiApp`.
- No change to `SESSIONLESS_COMMANDS` / `LOCAL_COMMANDS` as a routing authority.
- `/logout` is not whitelisted by name: only its argued form is admitted.
- No Tern-specific clipboard implementation; no automatic replay of a
  `superseded`/`indeterminate` permission write; no credential value in any
  message.
- No new public `TuiCommandRunner` member and no per-invocation ambient state:
  the title suppression fact is computed once by the composition root when the
  command surface registers.
