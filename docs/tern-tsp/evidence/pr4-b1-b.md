# PR4-B1-B Session Browser command and Resume evidence

This record covers the B1-B command-admission and Resume extension. The
historical B1-A read-only behavior and its owner-accepted headless observations
remain in [PR4-B1-A evidence](./pr4-b1-a.md); B1-B does not retroactively
rewrite that record.

## Scope and evidence boundary

- The TSP renderer remains experimental and opt-in. PiTui remains the default.
- `test/tern-tsp-session-browser-commands.test.ts` exercises the production
  command registration, Direct `SessionReader`, Direct lifecycle, and session
  runtime through the scripted TSP event fixture. Its tty and model adapter are
  controlled; the session-switch cases do not issue model turns.
- `scripts/tern-pane-session-browser-read.mjs` runs the production Presenter in
  a real versioned Tern pane with real pointer/key input and negotiated
  capabilities, but uses a controlled Reader/subject. It proves painted
  presentation and action-intent delivery, **not** a business Session switch.
- `scripts/tern-pane-session-browser-direct.mjs` is the S4 production-composition
  flow: its subject leaves stdio with real Tern, seeds real persisted Sessions,
  and uses the production Direct Reader and runtime. Its result is recorded
  separately below; it does not use an external model endpoint or a physical
  terminal.
- Runtime manifest: `@stencil-hq/tern@0.1.0`, DSH npm dependency
  `@deepseek-ai/dsh-agent@0.2.0-rc.2`, Node `24.21.0`, pnpm `11.7.0`, and real
  Tern CLI `0.8.4`. These are observations, not a compatibility promise.

The production path is: authoritative command classification → TSP capability
admission → existing command handler/Session Browser Reader → captured
`SessionScope` → `SessionRuntime.switchSession(target, expectedScope)` → the
existing transition gate and Direct Session lifecycle → authoritative Reader
reread. The expected scope is rechecked inside the gate before navigation side
effects; a Session ID alone is not currentness authority. No second transition
gate, persistence reader, Session API, or persistence format is introduced.

## Frozen-plan B01–B16 coverage

The behavior column follows the frozen B1-B plan's acceptance matrix. Status is
limited to the cited source-to-sink evidence. A Remote Host command-catalogue
control does not qualify Remote Session Browser or Resume support.

| Plan behavior | Status | Evidence |
|---|---|---|
| B01 — `/sessions` is owned by the Client command registry, passes the post-classification TSP capability gate, and opens the native Picker; preserve the PiTui command path and Host same-name ownership, and refuse unsupported capability with the draft restored | PASS | The Direct command integration exercises the registered Browser command through the TSP command path; the unavailable-capability Direct case proves refusal, draft restoration, no Picker, and no Session/model creation. `session-picker-content-search.test.ts` retains the PiTui command surface; `tern-tsp-direct-admission.test.ts` proves genuine Host `/sessions`, `/resume`, and `/search` handlers remain the winners. |
| B02 — bare `/resume` opens the same Picker; `/search <query>` opens the same Cards Search; empty `/search` errors | PASS | The Direct command integration exercises all three command registrations, the shared Reader, sessionless entry, blank-search rejection before listing, and an unknown slash prompt that reaches the ordinary model route. |
| B03 — `/sessions <query>` and `/search <query>` keep their initial query through loading/list/metadata/content search; user input wins, with one 250 ms debounced search and no duplicate listing | PASS | Direct integration asserts one Reader list and one official Direct content search for each initial query. The Native TSP Presenter regression preserves trailing whitespace and cursor through a late projection and continued typing. Read-owner tests cover canonicalization, debounce, duplicate suppression, user query precedence, cancellation, and stale-result rejection. |
| B04 — exact/prefix `/resume` uses one list and the first listed matching main row; misses become the filtered query, and empty input opens the Browser | PASS — Owner-directed Native TSP rule | The Native TSP read-owner test pins the first listed main candidate across an ambiguous prefix and a later exact-id overlap, while skipping a preceding subagent; existing `findSessionMatch` tests retain exact, unique-prefix, and short-prefix behavior. Read-owner tests also suppress a matching typed target after a loading-time manual query edit and preserve manual query on a miss; the Native Presenter regression proves a whitespace-only edit during loading suppresses automatic switching without starting Host Search. The official-persistence Direct fixture proves a persisted `origin:'subagent'` remains in the Host list but cannot emit a Native TSP intent because matching is restricted to `panel.rows`; the Direct command integration proves a main-session match reaches the existing switch. This Owner-directed main-only rule resolves §4.3 `STOP_MATCH_CORPUS` for the Native TSP route; the frozen plan is not rewritten, and the PiTui fallback remains unchanged.
| B05 — Current/empty/loading/error/unavailable selections disable Resume; enabled Resume is primary; select only highlights | PASS — functional action state | Native-wire and controlled-Reader tests cover each disabled state, the Current reason field, and selection-only behavior. The real Direct Tern flow shows Current A disabled, permits selecting persisted B without dispatch, then enables primary Resume; after commit/reconnect it rereads B Current with Resume disabled. Screenshot/reason paint limits and the observed disabled-hover discrepancy are recorded below; G8 visible-action acceptance is not complete. |
| B06 — Footer action, list Enter, and row activate on B reach the same guarded `switchSession(B)` once | PASS | The Direct production-path integration observes one lifecycle open for each of the three routes and authoritatively rereads the resulting owner; duplicate pending input is inert. Native tests reject stale revision, foreign surface, and unlisted-row events. |
| B07 — successful persisted A→B flushes A, opens B through the official lifecycle, commits the new generation, hydrates TSP, and rereads Current | PASS | The Direct integration observes A flush before `agents.resume(B)` and then rereads B as live/Current with A persisted but not live. `agents.resume` is only the lifecycle sink witness; the authoritative Reader and Current row prove the committed owner. |
| B08 — sessionless Resume selects a persisted Session without creating a blank Agent; Current starts empty and only B is published | PASS | A fresh Direct runner lists persisted A/B with no current Agent, verifies an empty Current set and zero model turns, resumes B once, then rereads B as the sole live owner. |
| B09 — pre-publication open/flush/refusal failure keeps A Current, shows a retryable error, and preserves its uncommitted draft | PASS | The Direct integration injects flush and open refusal, verifies the old owner remains Current, the Browser remains retryable, and pending clears. Runtime owner-handoff tests verify a pre-publication failure does not drop the old draft or retire its owner. |
| B10 — post-publication retirement/catalog warnings, exit cancellation, and supersession never roll back committed B or report uncommitted success | PASS | Runtime handoff tests cover catalog failure and supersession; the targeted retirement test covers exit during post-commit quiescence while preserving the committed child. |
| B11 — a queued B request with stale A scope cannot switch from C, including A→C→A reuse | PASS | The runtime test exercises the real scope authority and rechecks the captured scope inside the transition gate before navigation side effects. |
| B12 — repeated Enter/activate/Footer, stale `resume#rev`, closed/replaced panels, and stale rows cannot duplicate admission | PASS | Direct and native tests prove one accepted open per route, a pending duplicate is inert, old revision/foreign surface/unlisted rows are rejected, and shared Model/Preset/Browser layers retire one another. |
| B13 — modal/Question priority, subject hydration, renderer dispose/reconnect, and late read/search results | PASS | Modal-seat, subject-retirement, late-read/search, and SDK-disposal tests pass. The real Tern Direct flow exits and settles the first renderer, then launches a fresh production Direct renderer in the same Tern pane; the new Direct Reader rereads B as the sole live Current. The controlled `/exit` teardown records a handled closed-session flush failure; this does not claim exit-time flush durability, and no unhandled failure was observed. |
| B14 — workspace A→B→A lineage, long CJK, and content-only results retain hierarchy without narrow-screen obstruction | PASS — `REAL_TERN_HEADLESS` | Tern 0.8.4 drives the Presenter at 1280×800, 900×640, 560×640, and 400×600, plus the 400×440 Reader tail. It checks cross-workspace lineage, long CJK/emoji text, a content-only result, Footer states, and Reader scrolling; the native regression test pins contiguous workspace groups. |
| B15 — genuine Host `/sessions` winner, Skill invocation, Client extension, unknown slash, and Remote command catalogue retain classifier-owner → route → observable-sink behavior | PASS | Direct tests observe Host `/sessions`/`/resume`/`/search` sinks, resolvable Skill invocation, Client extension execution, and unknown slash prompt routing. The Remote command-plane test reads the genuine Host `/sessions` descriptor, submits it, and observes exactly one official Host `command/run` sink. |
| B16 — Remote TSP Resume requires a genuine Remote Reader/SessionLifecycle/TSP-command/authoritative-reread L5/L6 path | UNKNOWN/NOT_VERIFIED | No production-equivalent Remote Session Browser or Resume success path is claimed. The B15 Remote Host `/sessions` command-catalogue test is only an ownership/routing control and is not Remote Browser evidence. |

## S4 — real Tern and Direct production composition

**Direct business-path status: PASS — `REAL_TERN_DIRECT_HEADLESS`. G8 visual acceptance: PARTIAL; the Owner accepts the observed paint issue as an external limitation, with no styling change.** The flow
`scripts/tern-pane-drive.mjs scripts/tern-pane-session-browser-direct.mjs`
completed against Tern 0.8.4. The subject uses Tern-owned stdio and the
production TSP connector; it does not install the scripted TSP pane. Its
isolated fixture seeds persisted A/B via official session persistence, starts A,
and types `/sessions` in the actual Tern input channel. After selecting persisted
B, the real Tern Footer enables primary Resume; the event ledger observes A's
flush before `agents.resume(B)`, then the production `DirectSessionReader` lists
B as the sole live owner and the client marks B Current. `agents.resume` is the
lifecycle sink witness, not the commit proof: the authoritative reread and
Current row establish the committed owner.

The flow also checks the native Picker at 1280×800, 900×640, 560×640 and 400×600,
opens the real Details Reader at 400×440, and clicks its Back row. It closes the
first subject through `/exit`, waits for fixture settlement and process exit,
then starts a fresh production Direct renderer in the same Tern pane without
reseeding storage. The new Direct Reader rereads B as Current with Resume
disabled. No model turn is issued; this is headless Tern evidence, not physical
GUI/IME/wheel/theme acceptance.

Local artifacts are retained under `temp/tern-pane-1X2i6A/` (tree, layout,
PNG, assertion ledger and `events.jsonl`). Key captures include
`01-session-browser-direct-tree-1280x800.png`,
`06-session-browser-direct-resume-enabled-400x600.png`,
`08-session-browser-direct-current-b-400x600.png`,
`09-session-browser-direct-reader-400x440.png`,
`10-session-browser-direct-reader-back-400x440.png`, and
`12-session-browser-direct-renderer-reconnected-current-b-400x600.png`.

**Observed Tern 0.8.4 hover paint discrepancy:** capture `08` leaves the pointer
on disabled Resume. Its layout records `.pk-btn.primary.off` and the label with
foreground and background both `rgb(101,101,101)` at `.45` opacity, so the label
is unreadable in the PNG even though the node tree retains the text/title. In
reconnected capture `12`, the pointer is elsewhere and Resume is readable. This
is a client paint discrepancy, not missing action metadata or a failed switch.
The Owner accepts this as an external Tern 0.8.4 limitation; no product or Tern
styling change was made. G8/§11.2 visible-action acceptance remains PARTIAL,
not PASS; `REAL_TERN_GUI` and physical Owner acceptance remain `NOT_VERIFIED`.

**Teardown boundary:** the controlled fixture logs a handled
`SessionHandleClosedError` from a flush during `/exit` teardown. Both subjects
settle and exit with code 0; this flow does not qualify exit-time flush
durability, which is covered separately by the B10 lifecycle lanes.
The controlled-Reader visual flow described below is a separate
presentation-only qualification.

## Design-language and visual qualification

The surface is a native Picker with a read-only Details Reader. The TSP action
descriptor retains `primary: true` for Resume in every state; that field identifies
the designated action, while `disabled` and its reason carry availability. Tern
0.8.4 paints disabled Resume as `primary off`, retaining the Owner-accepted B1-A
style ([B1-A evidence](./pr4-b1-a.md)); an eligible non-current row enables the
same primary action. The independently marked Current row is not inferred from
selection. The real-client captures include:

- `06-session-browser-footer-current-disabled-400x600.png` — the Current row and
disabled Resume are painted. The reason is asserted in `action.disabled` and is
present as button-title metadata in the captured tree; the PNG does not show the
reason, and tooltip paint was not verified.
- `07-session-browser-footer-resume-enabled-400x600.png` — non-current Resume is
enabled and primary while remaining inside the Picker.
- `08-session-browser-footer-resume-pending-400x600.png` — one Footer intent is
pending; the read-only visual subject does not perform a business switch.
- `11-session-browser-details-tail-400x440.png` — the real client scrolls the
native Details Reader to the end of the content.

The full run artifacts (flow/subject copies, assertion ledger, run log, tree and
layout captures, and PNGs) are retained locally under
`temp/tern-pane-0El58u/`; they are not committed. The real-client run exited
successfully and its ledger had no failed assertions. Tern reported software
rendering via llvmpipe. This is `REAL_TERN_HEADLESS`, not `REAL_TERN_GUI` and
not physical G8/Owner acceptance. Physical GUI, IME, wheel, theme, and physical
PageUp/PageDown remain `NOT_VERIFIED`.

## Qualification limits and regression lanes

Remote Session Browser/Resume remains `UNKNOWN/NOT_VERIFIED`; the B15 Remote
Host `/sessions` catalogue test proves only Host command ownership and routing,
not Remote Browser or SessionLifecycle support. The separate TSP Planning
Protocol v3 qualification is also `NOT_VERIFIED`. B1-B adds no public API and
changes no `SessionReader` method signature.

Feature-specific regression lanes are listed in the
[Session Browser contract](../session-browser.md). The principal Direct,
currentness, command-owner, and TSP mount lanes are:

```sh
node --import tsx/esm --test test/tern-tsp-command-admission.test.ts test/tern-tsp-direct-admission.test.ts test/tern-tsp-session-browser-commands.test.ts test/tern-tsp-session-browser-read.test.ts test/tern-tsp-session-browser.test.ts test/tern-tsp-session-browser-direct.test.ts test/session-runtime-remote-owner-handoff.test.ts test/runner-remote-command-plane.test.ts test/session-picker-content-search.test.ts test/tern-tsp-runner-interactive.test.ts test/sessions.test.ts
node --import tsx/esm --test --test-name-pattern='^A-07' test/tern-tsp-live-mount.test.ts
node scripts/tern-pane-drive.mjs scripts/tern-pane-session-browser-read.mjs
node scripts/tern-pane-drive.mjs scripts/tern-pane-session-browser-direct.mjs
```
