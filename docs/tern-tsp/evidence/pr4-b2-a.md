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
- Notification is a SUCCESS supplement only: a confirmed success of the B2-A
  commands is also written through the existing renderer-neutral notice sink
  (which the TSP Dock renders). Refusal/cancellation/indeterminate outcomes keep
  their existing owner — the Direct command card, the controller's own
  local-command error notice, or the handler's existing inline `notify` — so no
  outcome produces two lines. On a `TuiApp`-backed renderer the supplement is a
  no-op and PiTui behavior is byte-for-byte the previous behavior.
- Direct business-path evidence is the real Host composition
  (`test/support/direct-tsp-fixture.ts`: real rc.2 services, real live Agents,
  the real runner/SubmissionController, the real TSP renderer over the shipped
  SDK `connect`). Only the model endpoint is scripted; the B2-A cases that need
  an authority the base fixture does not compose mount the SHIPPED plugin for it
  (`dsh-session-title`, `dsh-permission-presets` + approval/turn-outline,
  `dsh-authorization`).
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
| A01 — `/new` creates and publishes a real new Session | PASS | `tern-tsp-headless-commands.test.ts` (A01): one persisted Session after the first `/new`, a different live owner after the second, zero model turns |
| A02 — `/fork` from the current Session; sessionless refuses | PASS | Same file (A02 ×2): the child is persisted with `parentSession === source`; the sessionless case publishes no owner and persists nothing |
| A03 — `/title <text>` writes and rereads the authoritative title | PASS | Same file (A03/A04): the folded title read back from the live Session equals the new value |
| A04 — `/rename` is the same sink; Host `/rename` is not captured | PASS | Same file (A03/A04 for the alias; A14 for the genuine Host winner) |
| A05 — bare `/title` regenerates when supported | PASS | Same file (A05): the deterministic fallback replaces the pinned title |
| A06 — `/copy` uses the scope-pinned last assistant text | PASS (Direct) | Same file (A06 ×2): the emitted OSC 52 payload is the authoritative text; the no-message case fails visibly and emits nothing |
| A07 — `/yolo` goes through the official permission writer | PASS | Same file (A07 ×2): with `dsh-permission-presets` mounted the live Session's approval policy reads `never`; without it the original `unavailable` text is shown, never success |
| A08 — `/logout <reference>` clears through the credential port | PASS | Same file (A08): `resolve()` is defined before and `undefined` after; no message carries the secret value |
| A09 — `/logout <keyless-flow-route>` reaches `deleteRecord` | **NOT_VERIFIED** | No authorization-flow provider is installed in this environment; the real seam is mounted, `list()` is empty, and the case is exercised as a truthful refusal (`unknown credential target`, no record mutation). No flow is simulated. `/logout` support is therefore limited to the **reference case**; the flow-route gap is reported to the Owner |
| A10 — bare `/logout` is refused by the gate | PASS | Same file (A10): draft restored, no picker, the stored credential survives |
| A11 — an unresolvable target returns the real error | PASS | Same file (A11): a hyphenated route reaches the handler's `flowForRoute` branch and reports `unknown credential target` (never the bare UI). Note: an env-var-shaped token such as `nonsense` is the pre-existing literal-reference path (`unsetReference('NONSENSE')`), which the same test's route case deliberately bypasses |
| A12 — `/model`, `/preset`, `/sessions`, `/resume`, `/search` keep working | PASS (inherited) | Unchanged by this PR; covered by the B1 suites and rerun as regression |
| A13 — every remaining PiTui-only builtin stays refused | PASS | Same file (A13): sixteen commands in one session, each restoring its draft with a fresh notice; no Session, no model turn |
| A14 — genuine Host same-name winners keep their sink | PASS | Same file (A14): four genuine Host `/new`, `/copy`, `/logout`, `/title` handlers each ran once; no extra Session, no OSC 52, no credential mutation, no refusal |
| A15 — extension / skill / ordinary lines are never captured | PASS (inherited) | `tern-tsp-direct-admission.test.ts` (unchanged) |
| A16 — a no-panel builtin is never steered while running | PASS | Same file (A16, `busyEnter: 'steer'`): `/title` wrote while the turn ran with zero prompt writes; the following plain prompt steered |
| A17 — confirmed title/permission/logout/copy outcomes are visible | PASS | Success is supplemented as a real `dock.notice-n*` line (A03/A04/A05/A07/A08 and the A06 real-client run); refusals stay with their existing owner (the Direct command card, or the controller's local-command notice) and A02/A10 assert the line appears EXACTLY ONCE, so no outcome is reported twice |
| A18 — SDK decline falls back to PiTui unchanged | PASS (inherited) | `tern-tsp-renderer-selection.test.ts` (unchanged by this PR) |
| A19 — `/copy` after the emission keeps the Tern channel healthy | PARTIAL | Real Tern flow below: the OSC 52 bytes reached the Tern tty and a later input still reached the clipboard policy, with a clean exit. The OS clipboard itself is **NOT_VERIFIED** — see the qualification gap |
| A20 — PiTui defaults are unchanged | PASS | `login-credentials`, `session-state`, `command-catalog`, `busy-enter` and the TSP suites rerun on this tree; `notifyOutcome` is a no-op wherever a `TuiApp` is mounted |

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
- **Consequence (Owner decision needed).** Per the frozen plan this is
  `COPY_PRODUCT_SUCCESS_NOT_VERIFIED` → **STOP_COPY_QUALIFICATION**: `/copy`
  must not be claimed as fully supported until a run in an environment with an
  observable clipboard (a display + `wl-copy`/`xclip`, a tmux client, or a
  physical Tern GUI) produces at least one observable success. The
  implementation stays exactly the unchanged Clipboard Policy; no helper-only
  shortcut, no Tern-specific wire call and no "verified" wording were added.

## Qualification tiers used

| Tier | What it is | Used for |
|---|---|---|
| Direct L6 | `test/tern-tsp-headless-commands.test.ts` over the real Direct composition + scripted TSP pane | A01–A08, A10, A11, A13, A14, A16, A17 |
| Pure unit | `test/tern-tsp-command-admission.test.ts` (the predicate and the `/logout` input-shape rule) | the gate itself |
| REAL_TERN_HEADLESS | `scripts/tern-pane-drive.mjs scripts/tern-pane-b2a-copy.mjs` (real Tern 0.9.2, real keys, real tty) | A19 (channel integrity + OSC52 emission) |
| Inherited | B1-B / PR4-0 suites rerun unchanged | A12, A15, A18 |

## Deliberate non-goals

- No new panel/picker/overlay/button; no second command dispatcher, registry or
  `TuiApp`.
- No change to `SESSIONLESS_COMMANDS` / `LOCAL_COMMANDS` as a routing authority.
- `/logout` is not whitelisted by name: only its argued form is admitted.
- No Tern-specific clipboard implementation; no automatic replay of a
  `superseded`/`indeterminate` permission write; no credential value in any
  message.
