# Overlay & focus contract

The blocking/overlay surface system (Question / Save Location modals, the
Approval editor-seat action sheet, the Task Center and Job viewer, pickers,
`/model`, history search, and plugin overlays from the extension tiers) is a
state machine whose hardest failures are **synchronous reentrancy** bugs: a focus
callback runs in the middle of another operation and the outer operation then
overwrites the newer fact. This document records the model and the rules that keep
it closed. Use it as a **regression checklist** when you touch `/model`, add a
modal, change a plugin UI tier, or work on the fullscreen lifecycle — it exists so
the next change does not have to rediscover the same hard-won edge cases.

Implementation: `src/tui/interaction/overlay-broker.ts` (logical authority),
`src/tui/interaction/approval-runtime.ts` (the approval queue/one-shot
settlement), `src/tui/panels/approval-dialog.ts` (the approval action-sheet
presentation), `src/tui/interaction/editor-seat*.ts` (the editor seat) and
`src/tui-app.ts` (host mount / seats / fullscreen coordination; the application
keeps it the composition facade), `packages/pi-tui/src/tui.ts` (physical focus
transaction, divergence **X056** — see `packages/pi-tui/DIVERGENCES.md`).

## 1. Authority map

Exactly one authority owns each fact. Never infer a fact from a different
layer.

| Fact | Authority | Notes |
|---|---|---|
| Overlay topology: roots, parent/children, modal suspension ownership | `OverlayBroker` logical nodes | every node has at most ONE suppressor |
| Per-node intent: `explicitHidden`, `resumeFocus`, `zOrder`, `closed`, `remountable` | `OverlayBroker` | intent is committed BEFORE any fork call that can fire a plugin callback |
| Physical state: raw mounted/hidden, `focusedComponent`, fork `focusOrder` | the vendored fork | driven only through the broker primitives |
| `focusedSeat` / current editor seat | host, derived from the LIVE physical focus | never from "an overlay entry exists" or capture policy |
| Fork focus transaction: `overlayFocusRestore`, `focusRevision`, release stamps | fork `setFocusInternal` | supersession-aware (X056) |

Non-negotiable distinctions:

- `nonCapturing` is a **mount/show policy** (no auto-focus, no sibling
  suppression). It is **not** "can never own the keyboard": an explicit
  `focus()` from a focus-capable lease can make a nonCapturing overlay the
  physical keyboard owner.
- **logical focus intent ≠ physical focus fact.** The broker's `resumeFocus`
  is intent; `raw.isFocused()` is fact. The host derives the seat from the
  fact; restores use the intent.
- **suppression ≠ explicit hidden.** `explicitHidden` survives its
  suppressor's close; suppression is re-homed, not preserved as visibility.
- **logical `zOrder` must match the CURRENT physical visual order** — not the
  creation order. It is promoted only when the fork actually promotes the
  physical order (mount, capturing show, explicit focus).
- **a forwarding container can be the physical focus owner without owning the
  keyboard.** The fork's mouse dispatch promotes the seat's physical mount
  (`EditorSeatMount`) to the focus target, and the vendored `Container` forwards
  `focused` and input to the child the press named (divergence **X051**). The raw
  physical focus therefore legitimately stays on the mount while its occupant
  receives the keys. The host answers "who receives input" by resolving that
  mount to its one live occupant (`TuiApp.physicalInputOwner()` /
  `ownsPhysicalKeyboard()`); a consumer must never infer the input owner from raw
  object identity. The resolution answers the focus question ONLY: every consumer
  keeps its own ACTIVE/current and modal/tenant admission on top of it, so a
  resolved occupant still cannot bypass a Question/Approval/Save or overlay gate.

## 2. The transaction invariant

> An operation performed inside a synchronous plugin callback is the NEWER
> fact. The outer operation must not overwrite it after the callback returns.

For every transition, answer all five:

1. Which logical state must be committed before the callback can run?
2. Which physical call synchronously runs plugin code?
3. What may that callback mutate (this node / the pending target / another
   overlay / the graph / focus state)?
4. What does the outer function still write after the callback?
5. Can any of those writes overwrite the newer fact?

The callbacks to consider (not just `focus()`): Advanced `onFocus` /
`onBlur`, the imperative `custom()` `done()` / `close()`, `dispose()` /
`onClose()`, and any `Focusable.focused` setter. Callbacks may call
`focus / show / blur / hide / close / mount` on **any** existing lease.

## 3. Transaction map

| Transition | Committed before the callback | Physical call | Outer post-write |
|---|---|---|---|
| mount | node registration, roots, parent/children, focus intent, z; raw is mounted with `initialFocus:false` | `showPhysical`/`focusPhysical` in `commitMount` | only hide the adopted children + the coarse seat signal |
| show | `detach` + `explicitHidden=false` + focus intent | `setHidden(false)` | none |
| focus | `detach` + `resumeFocus=true` + clear the explicit-target flag | `setHidden(false)`, then at most one `focus()` | a guarded compensation only when the node still requests focus |
| hide / blur | `explicitHidden=true` / `resumeFocus=false` + release stamp | `releaseKeyboard()` (focuses the logical next owner) | the physical hide/unfocus only while the released intent still stands |
| close | `closed=true`, removed from `nodes`/`roots`, children re-homed | retarget `focusPhysical` / seat | `raw.hide()` (the node can no longer be resurrected) |
| Question/Save/Approval suspend | suspension ownership + per-root intent | `focusSeatOwner()` | hide only the roots the suspension still owns |
| Question/Save/Approval resume | `newerOwner`/successor suspension from the LIVE blocker | `reveal()` — one focus, or transfer to the successor without revealing | none |
| Approval seat mount | the pending request is the ACTIVE owner; its sheet frame + suspension set exist | seat projection + one focus only while Approval is still the derived live occupant (a newer focus/mount or Question/Save wins) | none |
| Approval seat release | the active slot is cleared and the suspension set still names only this request | unproject the sheet; `showNext` commits the successor; then transfer the suspension to an active successor (no reveal) or reveal/focus once when drained | dispose the released sheet before the suspension resume |
| fullscreen detach | close non-remountables; snapshot the prior physical owner | seat release/handoff (bounded, so the fork's per-hide fallback cannot fire) | derive the owner from LOGICAL intent (`frontmostFocusable`, with the prior owner as a fallback only while it still requests focus and is not explicit-hidden), then detach the raws |
| fullscreen rebind / restore | the logical graph survives; rebind with `initialFocus:false` | rebind / one restore focus | none |
| session switch / final teardown | close the Job/Settings workspace before its parent browser; clear refs | — | none |
| Job workspace open / close | commit the screen lease, latch it BEFORE any callback, pause the return screen (`preserveScreen`) | the workspace panel's `Esc`/`tasks.stop` intents | `activeScreen` derives the physical owner from the lease (see §10.1) |
| Settings workspace open / close | commit the screen lease (mutually exclusive with the Job lease), latch it BEFORE any callback, pause the return screen (`preserveScreen`) | the Settings panel's `Esc` intents and the legacy handoff | `activeScreen` derives the physical owner from the lease (see §10.3) |
| `custom()` done/close (factory or callback) | `settled` latch; the mounted lease is reclaimed | focus callbacks | no stale `pendingBrokerSettles` entry |

## 4. Reentrancy matrix

The failure mode is always: *outer operation → synchronous callback mutates the
pending/current target → outer returns and writes stale state*. Each row names
what guarantees the newer operation wins.

| Outer | Callback | Nested operation | Guarantee |
|---|---|---|---|
| mount | previous `onBlur` | focus / show / blur / hide / close / mount | fork `focusRevision` + per-component release stamps + broker post-check; a nested mount takes the higher z |
| mount | next `onFocus` | mount C (capturing or nonCapturing) | graph committed first; the nested mount takes the higher z |
| focus | previous `onBlur` | blur / hide / close the PENDING target (incl. an idempotent `setHidden(true)` and `hideOverlay()`) | fork release stamp → re-derive; never install a released target |
| focus | previous `onBlur` | `unfocus({ target })` with a caller target | broker `explicitTargetForwarded` skips its post-check |
| focus | next `onFocus` | self blur / hide / close | release stamp + revision (the release starts a nested transition) |
| blur / hide | the release target's `onFocus` | focus / show / blur / hide / close | the release's physical write is guarded by its own intent |
| blur / hide / modal suspend | any release callback | mount a sibling / re-show | the owner is re-derived from the logical `frontmostFocusable` |
| fullscreen detach | previous `onBlur` | any | snapshot the prior owner, release/hand off to the seat (bounded), then derive the owner from logical intent |
| modal settle | — | a root detached from the suspension by an earlier callback | `newerOwner = frontmostFocusable(roots \ suspension)` |
| custom | `onFocus` / `onBlur` | `done()` / `close()` | the mounted lease is reclaimed; `settled` is idempotent |

## 5. Fork focus-transition rules (X056)

- Every `setFocusInternal` stamps a monotonic `focusRevision`; after the
  previous component's `onBlur` and after the next component's `onFocus` it
  checks whether a newer transition superseded it and, if so, stops without
  overwriting.
- Its `overlayFocusRestore` bookkeeping is **pending**: it is applied only when
  the transition completes, so a superseded outer transition cannot consume a
  blocked restore (including an `unfocus({ target })` resume).
- A pending `nextFocus` whose component was **explicitly released** during the
  transition (`unfocus` — even on a not-yet-focused target —, `hide`, an
  idempotent `setHidden(true)`, or public `hideOverlay()`) is never installed;
  the transition re-derives the topmost still-visible overlay. Release stamps
  are per component, so several releases in one callback cannot mask one
  another.
- The optional overlay options (`preserveOrder`, `preserveFocus`,
  `initialFocus`) are additive; the default `setHidden(false)` / `focus()` /
  `showOverlay()` behavior still promotes and takes focus.

## 6. Modal response ownership and read-only inspection

Question and Approval own the response plane: editing, selection/decision,
submit/cancel, and every lifecycle, session, business, or plugin mutation. They
do not own the entire TUI. An explicit read-only inspection plane remains
available while a response modal is visible.

Keyboard routing follows this priority:

1. an active nested inspection child, when the existing ownership stack can
   support it;
2. fixed Question response keys (the component) and Approval fixed/reading keys
   (the approval runtime/sheet);
3. a direct trigger of the explicit inspection-safe semantic allowlist;
4. a leader prefix or completion, when the completed semantic action is in the
   same inspection-safe allowlist;
5. all remaining input is consumed by the response modal.

Leader prefixes are modal-aware rather than a generic Host passthrough: fixed
response keys cancel a pending prefix and continue through Question/Approval,
while leader-bound lifecycle, session, editor, business, and plugin actions
remain blocked. The normal Host shortcut ladder is never run generically behind
a response modal. Inspection may change presentation or viewport state, but must not
mutate the answer, submit/steer editor input, change session/context identity,
or trigger lifecycle/business/plugin actions. Todo presentation is allowed;
Todo/business mutation is not.

Transcript Search is intended inspection, not a product-level prohibition. It
is deferred from this PR because the current `OverlayBroker` mounts a new
managed overlay under an active Question/Approval suspension as hidden; making
Search a temporary keyboard owner would require a new nested inspection-child
ownership primitive. The follow-up is **Milestone A follow-up — nested
transcript Search under Question/Approval**. Until that ownership proof exists,
the existing modal routing consumes Search input rather than falling through to
the generic Host ladder.

Fullscreen Question pointer handling uses the same semantic boundary:

- clicks inside the Question frame remain Question-owned;
- outside clicks may activate only explicit presentation/inspection targets:
  transcript disclosure, attachment collapse/expand, Todo presentation, and
  Workflow run/phase disclosure;
- Workflow member/agent viewer actions, editor focus, session/context changes,
  lifecycle/business mutation, arbitrary plugin actions, and ambiguous hits stay
  blocked;
- press/release uses the last-painted geometry and semantic owner/row/hit
  identity, with a Question-instance fence;
- a presentation rebuild must not change modal focus ownership.

Approval keyboard inspection uses the same semantic allowlist. Approval's own
fixed and reading keys (`y/n/Esc/Ctrl+C`, arrows, PgUp/PgDn, Home/End, `c`,
`e`) are claimed before the inspection allowlist so a remap cannot steal a
decision or the reading viewport.

Approval pointer ownership is **fullscreen-only** and uses the same painted-frame
discipline as Question:

- the last PAINTED action-cell ranges are the only decision/copy/expand targets;
  blank space, border padding and unpainted actions are inert;
- press/release must name the SAME action segment of the SAME live approval
  frame; a scroll, expand, resize, abort or A→B replacement invalidates it;
- a wheel over the painted body scrolls the sheet; every other wheel while the
  blocking sheet is active stays inert behind it;
- Regular/Main keeps no approval pointer path at all — it is keyboard-only by
  contract, and an SGR report there never becomes an approval decision;
- outside the seat frame, only the existing modal-safe presentation/inspection
  hits are reachable.

A sheet rebuild (resize/expand) keeps the same request, the one settlement path
and the modal focus ownership; it never creates a second dialog hit map.

### 6.1 Timed and continued Questions

Three layers stay separate:

- **Projection** owns open/continued/settled state.
- **Inbox** owns a late reply durably queued.
- **Controller** owns the mounted card/countdown/reachability.
- **Flow** owns form state only.

The Host wait is claimed BEFORE the local clock starts. The countdown is
presentation only and never cancels the turn or the Question; the first real
mutation freezes the clock. Reachability is projection-driven and reactive
(Direct change feed; Remote `userQuestions` + `inbox` + Connection generation).
A queued late reply removes the interaction (`REPLY_QUEUED`, read-only). Final
answers come from `userQuestions.settled`.

A continued Question outlives its editor seat as a `ContinuedQuestionEntry`
keyed `(sessionId, callId)` with `visible|parked`. Esc parks; only an explicit
human reopen (Task Center attention row) reopens. Cold recovery starts parked.
Settlement/queued/vanished/unreadable removes the entry. A replacement
publication withdraws presentation only and never settles the Host request.

Must-not: synthesize a Host timer write, guess a duration before the first
frame, auto-reopen, report a Host-driven end as user cancel, or add an
`/answer` shortcut. Authority:
`src/app/surface/question-controller.ts` (`ASK_TIMED_OUT`, `ASK_CANCELLED`,
`ASK_ABORTED`, `QUESTION_REPLY_QUEUED`, `ContinuedQuestionEntry`),
`QuestionFlow`, `src/runtime/interaction-port.ts`.

Proof: `test/app/question-park-reopen.test.ts`,
`test/app/question-remote-lifecycle.test.ts`.

### 6.2 Esc and visible-seat priority

- The Host busy-cancel runs before the shell-mode exit and before a replacement
  editor's Esc; a DECLINED plugin Esc falls through to the host ladder; a
  CONSUMED Esc disarms the pending double-Esc window.
- The `↓` Task Browser gate and the footer `↓ view` hint read the VISIBLE seat
  mode. Host execution callbacks (`onSubmit`, MentionProvider mode source,
  delegated `getMode`) read the Host editor mode freshly decoded from a plugin
  wire document.
- Never let a mode-less plugin seat inject `prompt` into a Host `!` submit (that
  would leak a session-excluded command into the model path), and never let a
  stale hidden-host mode drive completion routing.

## 7. Regression checklist for future changes

When you add or change an overlay path, cover the family it belongs to:

- **New modal** (like Question / Save Location): it must use
  `suspendVisibleRoots` / `resumeSuspendedRoots`, never snapshot or hide
  handles itself; check settle after a callback detached a root.
- **New plugin-facing overlay tier or callback**: assume `onFocus` / `onBlur`
  may synchronously call `focus` / `show` / `blur` / `hide` / `close` / mount.
  Assert the callback counts (`focusCount` / `blurCount`) do not gain fabricated
  transitions, and that a newer operation wins.
- **`/model` or any picker**: re-opening must close the previous instance; a
  fullscreen swap must rebind the same logical node, not rebuild.
- **Fullscreen lifecycle**: the logical graph, visibility intent, focus intent,
  z-order and modal suspensions survive; non-remountable overlays are closed
  first; the owner is derived from logical intent (physical focus can be
  overwritten by the outer `setFocus(editor)`); a swap that interleaves an
  overlay's own mount must still leave that overlay projected IN LOGICAL ORDER —
  register the remount capability before the physical mount, never append it
  afterwards — and, when it was the pre-swap keyboard owner, focused (see §11).
- **Approval**: it is a blocking editor-seat frame, not a managed overlay node.
  It owns one action sheet per active request and suspends the visible managed
  roots through the broker's modal suspension. The stage identity is re-read after
  the park hook, after the Save cancellation and inside the seat projection, so a
  settled prompt's tail can never cancel the newer Save Location a cleanup opened,
  and a throwing seat mount can never latch the stage, leak its frame or leave a
  ghost projection. A failed presentation also rejects ITS OWN promise (a queued
  prompt no longer has an executor to do it) and runs the LAST-blocker restore
  once the queue drained (see §11). A newer focus or capturing mount issued inside
  the mount window wins over the late projection focus; the approval frame stays
  projected and takes the keyboard back through the live derivation.
- **Session / teardown**: the Job workspace closes before its parent
  (Task Browser); callbacks capture the owning session identity; a parent that
  was disposed WITHOUT its closer must still notify its owner (see §10). The Job
  screen is a temporary physical-screen lease, not an overlay node (see §10.1).
- **A new owner-closing overlay** (viewer / browser family): give it ONE
  per-open finalizer wired BOTH into the returned closer AND into the frame's
  fourth `onDispose`; precommit the latch before the user callback runs; keep
  the physical hide and the owner notification as INDEPENDENT
  `runSyncDisposalSteps` steps (see §10).
- **A new blocker that takes the seat** (question / save / approval class):
  commit the blocking intent BEFORE the park and before any call that can run a
  plugin callback, then park the optional tenant; the modal must never be able
  to observe an unblocked seat (see §11).
- **A private optional seat tenant**: one record, one per-open token, one
  caller-owned `close`; REFUSE before the factory; restore only at the LAST
  blocker; re-validate `isCurrent()` at every ACTIVE input / re-projection /
  focus / screen-swap entry and re-project the live winner; give it no
  host-classified protocol delivery; never let the tenant become a second
  focus/currentness authority (see §11).
- **A failed blocking presentation**: keep the rollback steps, the FIFO advance
  and the caller's promise settlement INDEPENDENT (a throwing step surfaces
  aggregated, never truncating); commit the successor fact BEFORE the handover
  runs; gate the advance on the failed state still owning the seat; a successor
  UNIONS the inherited suspension set and then takes its own suspension over the
  still-visible roots; and fence the handover tail after that suspension on the
  successor still being the live owner (see §11).
- **Assertions to add**: `assertOverlayForestForTest()` after reentrant
  operations; focus/blur counts around internal restores; the logical
  `remountOrder` front after a reentrant mount; no shadow state (`wasFocused`,
  `desiredFocus`, ordinals, `previouslyFocused`) may reappear.

## 8. By-design boundaries

- An editor-seat modal (Question / Save Location) is **not** a managed
  overlay: while it captures the seat, `hasFocusedOverlay()` stays false
  (the physical focus belongs to the flow's seat frame) even though
  `handleInputCore` consumes every key. A consumer asking "is an overlay
  owning the keyboard?" must therefore test the seat-modal ownership
  separately (e.g. the footer's `↓ view` gate in
  `TuiApp.taskBrowserAvailable()`).
- A non-remountable overlay does **not** survive a fullscreen swap (its raw and
  its callbacks die with the screen); this matches the baseline behavior.
- A Question / Save Location settle restores **visibility only** for the roots
  it directly suspended; the graph below them is preserved, never flattened.
  The keyboard owner it focuses may instead be a newer root that a callback
  detached from the suspension (the explicit-operation override below).
- An explicit `show()` / `focus()` during a modal is an ownership override the
  caller is responsible for; the modal does not silently re-hide it.

## 9. Nested row grant = the parent content budget

An overlay that hosts an in-place submenu is a row-budget owner: the live
geometry decides how many content rows exist, and every nested list consumes
that grant instead of the whole terminal height.

- Chain: `ResponsiveOverlayFrame` geometry (`geometryOf()` → `onGeometry`) →
  `SettingsList.setMaxRows(maxHeight - 2)` → the fork's `RowBudgetAware`
  submenu slot (`forwardBudgetToSubmenu`, on open and on every change) →
  the submenu component's own budget → its render → the `Frame` → the
  compositor. The frame border owns two of the overlay rows.
- Consumer rule: a submenu's EFFECTIVE budget is
  `min(own standalone cap, parent content grant)`. A panel mounted as its own
  overlay (`/keybindings`) never receives `setMaxRows` and therefore keeps its
  standalone cap — nested and standalone happen to share one component, not
  one geometry authority.
- Assembly rule inside a budgeted panel: mandatory chrome (title, search row,
  operation hint) is placed FIRST in the budget, then the item window, then
  the optional separators/scroll markers/status. Mandatory rows are never
  head-cut, so a `slice(0, limit)`-style trim may not be used for the bottom
  chrome. At a narrow width the frame's own truncation may still cut a hint's
  tail text; the row itself stays painted.
- Bottom-chrome rule per view (the hint does NOT have to be the last row
  everywhere — only the MAIN list fixes it there):
  - MAIN shortcut list: the operation hint row
    (`Enter: details … Esc: close/clear`) is the LAST row of every grant, so
    every optional row is dropped before it.
  - LEADER editor: the operation row (`Esc: back`, carried by the
    record/reset row) must stay painted; its `Saving…` and error/status rows
    may legitimately follow it (the pre-existing order) and are the last of
    the optional rows to be dropped.
  - Binding-choice view (and the action detail): the shared footer-sticky
    viewport keeps the `Esc: back` hint as the last row, with the two choice
    rows retaining their painted ordinal.
  - Unavailable fallback: `Esc: back` is the mandatory tail; a short grant
    drops its blank spacer first, then the error detail, then the title.
- Degenerate-grant rules, MAIN LIST ONLY (do not transfer them to the leader
  editor, the binding choice or the unavailable fallback): at one row only the
  operation hint is drawn; at two rows the title joins it; at three the search
  row joins them. Below the physical floor (a terminal too short for both
  frame borders plus a hint) the frame degrades by the existing compositor
  clamp, not by a second geometry authority. Optional rows (blank separators,
  scroll markers, the description line, the status line) are dropped
  lowest-priority-first; the status/error line outranks the optional
  description, and the list keeps at least one actionable row.
- Documented exception: the independent key-recorder view (`KeyRecorder`,
  reached from the leader editor or a binding choice) is NOT a budgeted
  assembly — it renders its fixed view regardless of the panel grant, so on a
  grant shorter than that view the compositor clamp applies. This PR keeps
  that degradation (no second scrollport) and pins it in
  `test/tui/keybinding-editor.test.ts`; "every render branch fits the grant"
  holds for the panel's own assemblies, not for the recorder view.
- Legacy limits are retained deliberately: `/settings` keeps
  `SettingsList(items, 6, …)` and `configuredMaxHeight = 28`, so the nested
  `Keyboard shortcuts` submenu is bounded by 26 content rows on any terminal
  taller than 30 rows. This is a viewport/grant fix, NOT the Settings
  Workspace (a separate Settings Workspace design): the fork's SettingsList still lacks
  filtered-state Home/End paging, and the main settings list still shows at
  most six visible rows.
- Evidence: `test/app/surface-row-grant.test.ts` (real `/settings` command →
  live geometry → submenu → painted frame, resize, question AND approval
  suspension, the real bare `/keybindings` budget with its teardown count, and
  a 44-column CJK frame/painted hit map), `test/app/theme-picker.test.ts` (Theme
  submenu grant), `test/domain/rendering.test.ts` (standalone budget, navigation and
  close) and `test/tui/keybinding-editor.test.ts` (per-panel grants, degenerate
  grants, painted mouse hit maps including the scrolled choice ordinal, and
  the recorder degradation).

## 10. One-shot closure: output viewer and task browser

A managed overlay that owns an external resource (an OutputViewer's refresh
timer, a Task Browser's owner slot) — and the selected-Job workspace of §10.1 —
has exactly ONE per-open finalizer, and every close route funnels through it:

- **Esc / the returned closer**: mark the close requested, then run the physical
  hide and the finalizer as INDEPENDENT steps (`runSyncDisposalSteps`), so a
  throwing hide cannot strand the owner notification and a throwing notification
  cannot leave the overlay mounted. A repeated call is a no-op.
- **A physical disposal that never calls the closer** (`TuiApp.dispose`, a
  fullscreen screen swap, a broker detach): the owning
  `ResponsiveOverlayFrame.dispose()` fires its FOURTH constructor argument
  (`onDispose`). That argument is the SAME finalizer — it notifies once whatever
  removed the frame, and it never touches the overlay handle.
- **The finalizer latches BEFORE the user callback** (precommit), so a callback
  that re-enters the closer, opens a newer overlay, or throws can never produce
  a second notification.
- **A throwing owned-child `dispose` is independent of the notification**: the
  frame attempts both and surfaces the collected failure (the exact original
  value for one failure, an `AggregateError` carrying both for two).
- **Suppression is not closure.** `setHidden(true)` changes visibility and the
  keyboard owner only; the suppressed instance keeps its state and is restored
  when the suppressing owner closes. Only `Frame.dispose` is a closure. A Job
  workspace does not even suppress its Task Browser as an overlay: it PAUSES the
  whole physical screen the browser lives on (§10.1).
- **The Task Browser owner gets a reason exactly once per open** (`cancel` /
  `select` / `external`; the retired modal promotion leaves no `promote` reason;
  Quick — the Full Task Center IS the browser and the on-demand accessory is
  not a modal to promote from). Every terminal reason resets the dataset
  scope. The retired browser identity is cleared BEFORE the Job workspace is
  closed, so a callback that synchronously opens a newer browser wins; a late
  callback from a retired browser is a strict no-op.
- **A retired browser's navigation tails are generation-fenced.** The tails
  close over the monotonic epoch of the browser that opened them, so a browser that
  a synchronous callback opened while the old one was closing (for example a
  plugin `onFocus` fired by the restore of physical focus) keeps the slot. The
  retired browser's OWN token cannot express this: its `onRetired` legitimately
  clears it, so "the token is clear" cannot be told apart from "someone newer
  owns the slot". (This fence guards a synchronous open during the close.)
- **The on-demand Task Quick is NOT an overlay**: it is the first-party
  pinned accessory as the LAST pinned row of both roots — under the whole
  footer — and `focused` (written by the TUI
  focus transition) is its one visibility authority. Exiting restores the
  current seat occupant and the band collapses to zero rows (the separator
  rule is painted by the band itself and disappears with it). Entering it is a normal
  `setFocus(taskQuick)` from the keymap-admitted `app.tasks.open`; leaving it
  restores the CURRENT seat occupant. Every blocking owner terminates it at
  its own composition commit — before the new owner takes focus — and an
  ACTIVE projection that empties exits through the component's `onEmpty`
  (guarded to the real focused component, so a hidden empty commit never
  re-enters the host lifecycle).
- **The Job workspace closes before its parent browser's physical hide** on an
  explicit close; on a physical disposal the workspace's own finalizer releases
  it. Either way the observer is released exactly once (per-open `releaseOnce`),
  and a stale finalizer can never clear a newer instance's token or closer.
- **Instance identity, not the session**: a Job workspace's currentness is its
  per-open object token; the ownership subject (session + generation) is only the
  destructive-intent fence. `jobs.read()` — the consuming cursor — is never part
  of closing.

Evidence: `test/app/surface-lifecycle-closure.test.ts` (Esc, returned closer, screen
swap, parent-only close, Quick/Full restore, Job A → B, session reset, final
dispose, throwing child dispose, Sign-in notice identity) and
`test/app/job-inspector-workspace.test.ts` (the workspace screen lease itself).

## 10.1 Job workspace: a temporary physical-screen lease

A selected Job (a `/tasks` row) renders in its OWN fullscreen workspace. The
lease is deliberately NOT an OverlayBroker node: a second physical screen owner
would have to be projected, suppressed, remounted and focused through the broker
graph, and a fullscreen swap would then destroy the very Task Browser the
workspace must return to.

- **One leased screen, one owner.** `TuiApp.openJobInspector` mints a
  short-lived `TuiAltScreen` whose layout root and keyboard focus target is the
  `JobInspectorPanel`. `this.jobWorkspace` is the ONE lease record, and
  `activeScreen` is derived from it (`jobWorkspace.screen ?? fullscreen ?? tui`),
  so every render request, input route, overlay mount and focus write targets the
  same physical owner. There is no parallel `isJobOpen` boolean.
- **The return surface is paused, never rebuilt.** The screen that opened the
  workspace (the regular `TuiMainScreen` or the transcript `TuiAltScreen`) is
  stopped with `preserveScreen: true`: its object tree, overlay graph, focus,
  draft, scroll state and Task Browser selection survive. Closing the workspace
  restarts the SAME instance and only re-assigns focus when that screen has no
  focused component left — the workspace never forces the editor back.
- **`this.fullscreen` stays the USER's transcript mode.** A workspace never
  assigns or clears it, never calls `setFullscreen` and therefore never fires
  `onFullscreenChange`; a display-mode request arriving while a workspace is
  leased is refused (the preference value itself is untouched) instead of
  detaching the paused surface. `activeScreen.mode` — not `this.fullscreen` — is
  the predicate for "the active screen is a viewport owner" (for example the
  focus-report pass-through).
- **Modal pre-emption is by closure, not layering.** A Question, Approval or Save
  Location that ARRIVES while a workspace is leased closes it FIRST (the three
  entry points run `jobWorkspace.close()` before they commit their own state), so
  the blocking owner mounts and focuses on the restored surface and the workspace
  can never swallow the keys the user must answer with. A workspace open that
  finds a blocking owner already active is refused and releases the observation
  lease it just acquired.
- **One non-truncating close batch.** `close()` commits the instance latch and
  clears the lease BEFORE any callback, then attempts the screen stop, the panel
  release, the return-surface restore and the exactly-once owner notification as
  independent steps. A re-entrant callback that synchronously leases a NEWER
  workspace wins: the stale workspace never restores its own screen over it, and
  the owner notification runs last so it observes the restored physical state.
- **Observer ownership stays in the Task Runtime.** The workspace only PRESENTS
  the ONE captured `JobInspectorState`; the selected-Job observer, its per-open
  `releaseOnce`, the Stop capability fence and the Stop mutation all stay in
  `app/surface/task-runtime`. The panel holds no backend read and no second
  subscription. The Command reader's edge auto-scroll timer is NOT a second Job
  refresh: it belongs to one pointer gesture, scrolls only its own viewport, is
  `unref()`d, and is released on release, page switch, resize, terminal blur,
  workspace exit and dispose.
- **Two mutually exclusive bodies inside the ONE leased screen.** The workspace
  mounts both reading pages and both Search rows for the whole panel lifetime and
  makes them mutually invisible through the layout's own `visible` entries, so
  exactly one body and exactly one Search row are ever laid out and exactly one
  ScrollView is the primary viewport. Switching pages therefore never rebuilds a
  ScrollView (the Output page keeps its follow intent, anchor and query) and
  never creates a second physical owner: the same `TuiAltScreen`, the same
  `setLayoutRoot(panel)` root and the same keyboard focus target remain in force,
  with the physical focus only moving between the panel root and the CURRENT
  page's Search row. `Esc` on the Command page returns to Output (a logical
  intent of the same panel), never a screen swap.
- **The header's copy/reading affordances resolve against the LAST PAINTED
  frame.** The Command summary row, its `↗ Command` entry, its `Copy All [C]`
  button and the other reading page's tab are plain painted cells with no
  mouse-handling component, so the alt screen's existing `onCellPress`/
  `onCellClick` callbacks reach the panel. The panel reads its hit regions and the
  header's painted top row at the frame-painted boundary (the same X054 geometry
  query the Command selection uses) and a click acts only when the release
  re-proves the press-time action, page, Command source identity AND the same
  relative row/cell range; a repaint in between refuses it, and a row the frame
  truncated keeps only the label cells it really painted (the ellipsis that
  `truncateToWidth` substitutes is inert). The Command BODY is the one region that DOES own the
  pointer: its published `MouseRegion` returns `capture: true` on a left press,
  and the gesture, its selection and its timer are released on any page switch,
  label change, resize, blur or dispose, so no ghost selection or timer can
  outlive the frame it belonged to.
- **Final dispose releases the lease first.** `TuiApp.dispose()` closes a still
  leased workspace before the overlay teardown and the screen stops, so no
  temporary screen keeps a terminal input handler into the dying surface.

### 10.2 Command selection read-through

The Command drag selection deliberately does NOT use the alt screen's own
`getActiveSelectionText()`: that path slices the PAINTED screen rows, trims each
row and strips a leading 1–3 cell indent (X024), so it cannot reproduce a shell
command's TABs, trailing spaces or soft wraps. The reader keeps its own
`visual row + display cell -> original UTF-16 half-open range` mapping instead
and asks the alt screen only for the last painted rects. It never enables a
second global SGR parser and never installs a second selection owner, so the
fork's scrollbar interaction, wheel routing and native selection elsewhere on the
same screen are untouched.

### 10.3 Settings workspace: a second, mutually exclusive screen lease

`/settings` opens a fullscreen Settings
workspace with the same temporary physical-screen lease as the Job workspace, and
the two leases are MUTUALLY EXCLUSIVE. The whole surface is a read projection
whose writable-row set and value contracts are owned by
[surface-behavior.md](./surface-behavior.md) `Settings Workspace`; this section
owns only the lease, focus and write-lifecycle mechanics.

- **One lease latch for every workspace.** `TuiApp.openSettingsWorkspace` mints a
  short-lived `TuiAltScreen` whose layout root and keyboard focus target is the
  `SettingsWorkspacePanel`, and commits it to `this.workspaceLease` BEFORE the
  physical switch. `activeScreen` derives the physical owner from the leases
  (`jobWorkspace.screen ?? workspaceLease.screen ?? fullscreen ?? tui`); the
  refusal checks share ONE freeze depth (`workspaceLeaseFreezeDepth`), so a
  lifecycle transition, a blocking owner's commit window, or an existing lease
  withholds a new one and no two physical owners can ever coexist. The same
  latch hosts the `/plugins` root and (see §10.4) the transcript image
  workspace.
- **The return surface is paused, never rebuilt**, exactly as §10.1: the screen
  that opened the workspace is stopped with `preserveScreen: true`, its object
  tree, overlay graph, focus, draft and scroll state survive, and closing restarts
  the SAME instance.
- **The Settings Plugins page is a CHILD of this ONE lease.** The Plugins
  category is a direct page entry, not an empty Rows level: the composition
  lazily builds the one `PluginManagerWorkspacePanel` only when the category's
  content column is first really painted (never on `/settings` alone, never
  while a narrow rail merely selects it), and that page paints only its
  business body inside a local viewport the root grants every frame.
  `/plugins` is only a deep link into the SAME lease
  (`TuiApp.openSettingsWorkspace` with the Plugins category selected); there is
  no second plugin screen primitive, nested Alt Screen, second focus owner or
  overlay fallback. The page's selection/search/filter/scroll and
  painted-hit-map revision are per-page; the one `PluginManagerController`
  outlives the page, and leaving the page (a focus yield back to the rail)
  never closes it, never releases its Host claim and never cancels an in-flight
  Host install. Only a real category change or the Settings teardown disposes
  the page once and releases the ONE token-owned claim; a late/stale token
  cannot release a newer claim. The root owns the shared pane header and the
  ONE physical last-row bar, moving the page's own semantic line there only
  while the plugin content holds the keyboard.
- **The workspace has ONE focus state and ONE input owner.** The category rail
  is the selection owner and the direct content page (About, Models, Account) is
  the content owner; the panel routes every key to the owner that currently
  holds the focus. Selecting a category on the rail paints the selected page at
  once while the rail keeps the focus; `Enter`/`Right` transfers the focus to
  that page and runs no page action by itself; `Esc`/`Backspace`/`Left` returns
  it to the rail without disposing the page. A page may only refuse a bare
  `Left` while it owns a modal, an auth flow or a pending Host mutation, and it
  answers that with a pure query that never reads the Host. The configuration
  categories keep their own three-level browse (L0 `categories` → L1 `rows` →
  L2 `detail`) inside the same focus state: ASCII `Right` advances exactly one
  level; `Left` returns one level and is inert at L0. `Enter` follows the same
  transitions, except that a writable L1 row enters its inline choice in the
  same L2 transition. `Esc`/`Backspace` step back (and close at L0) — wide,
  medium and narrow behave identically, and a new open starts on the About
  home. The `Tab`/`Shift+Tab` region-key contract is owned by
  [surface-behavior.md](./surface-behavior.md#settings-workspace); those keys
  only re-focus an existing region and never activate a page, row or write.
  Leaving the workspace is therefore always one reachable key (the Action Bar
  is pinned to the physical last row at every height, down to a one-row
  terminal).
- **Width only projects panes.** Wide paints all three columns; medium derives its
  two columns purely from the current level (`categories + rows` at L0,
  `rows + details` otherwise); narrow paints the current level alone. A direct
  content category paints the category rail and its content column (the About
  projection or the real page) and no configuration pane. No second
  "visible window" state is stored, hidden panes are neither painted nor
  addressable, and row text is laid out against the pane width it is actually
  painted in.
- **Every key inside the workspace is consumed** by the panel (navigation,
  refresh, copy, or inert). Ordinary typing never reaches the hidden editor, the
  transcript or a Host composer action — the `handleInputCore` ladder hands
  Settings the key before any Host action, mirroring the Job branch. A key that
  arrives before the first paint resolves against the LIVE level, never a guessed
  layout.
- **Mouse follows the last painted frame.** The row cells and Detail actions are
  plain painted cells reached through the alt screen's existing
  `onCellPress`/`onCellClick`: a category/row click selects and focuses its level
  without advancing; ordinary visible Detail content clicked from L1 enters L2
  (the same one-step choice for a writable row, browse for a read-only row). Any
  click leaving L2 cancels an uncommitted choice atomically, including a click on
  the same row/category. A click acts only when release re-proves the press-time
  kind, id, painted row, cell range, state version, level AND category. Refresh,
  selection, level, category AND terminal geometry all bump that version — a
  resize refuses a straddling gesture even when the target's own cells did not
  move. An unrepainted root chrome change is the same boundary: the App notice
  can move/shrink a direct page's content box and child grant without a terminal
  resize, so the root re-derives the live box from the live chrome before each
  pointer gesture and a release must still match the box and grant its press was
  admitted against. The same holds for a focus transfer that changes the
  Plugin Manager child's projection: whenever that transfer changes the rail /
  content layout — at 76..119 columns, where the pair follows the keyboard, as
  well as at narrow widths, where one region is painted at a time — only the real
  Esc is admitted, in both directions of the Categories/content swap, until the
  destination frame paints. This guard is specific to the embedded Plugin
  Manager child; About/Models/Account own their own gates. Wheel events are the panel's own `handleMouse` and scroll only the painted
  region under the pointer (facts and candidates have independent wheel regions;
  a hidden pane owns no wheel). A wheel-scrolled list keeps its viewport (only a
  selection or viewport change rebases it, so a shrink still reveals the
  selection). The workspace screen suspends the fork's native copy-on-select:
  The Settings workspace has no drag-copy contract, and the panel's own `Copy value`/`C` verb is
  the only copy source (a plain click can never put a character on the clipboard).
  The Action Bar advertises only the keys the current level and row grant actually
  honour: below the body floor it shows the Esc/back semantics alone.
- **The L2 edit phase is a transient phase of the SAME lease.** On a writable
  row, `Right`/`Enter`/`[Change…]` opens an in-pane candidate choice
  directly from L1; `Left`/`Esc`/`Backspace`/`[Cancel]` cancels to L1 with zero
  writes. The choice is presentation state inside the panel, never a fourth
  navigation level, a second screen or a second focus owner. The shared Detail
  pane keeps the current Runtime/Persisted facts above the candidates; `PgUp`/
  `PgDn` scroll only those facts and the candidate wheel scrolls its own region.
  Candidate identity is the exact underlying value (source-qualified for themes)
  and must be visible before
  keyboard confirmation; if it is offscreen, the first Enter only reveals it.
  A candidate whose source is gone is listed as unavailable and refused. At most
  ONE commit is in flight
  per open: while a write is pending the edit/retry verbs are not painted and no
  second confirm can be started (no unbounded queue, no background watcher), and
  `Esc` still steps back or closes. A settlement is fenced twice — the app's
  `settingsWorkspace === record` check and the panel's own request identity — so a
  commit that lands after the user left the workspace, or after a retry superseded
  it, can never repaint, notify or address a replacement workspace. Closing does
  NOT cancel an already dispatched Host write: it still completes under its runner
  owner, and a non-`verified` outcome is recorded by the WRITE OWNER
  (`commitSettingsWorkspaceField` warns on the runner diagnostics with the field,
  the value and the real reason) — so the failure of a write dispatched before the
  close stays diagnosable even though no UI sink is live any more.
- **Write currentness is explicit, never inferred from the UI.** A commit
  only counts as `Verified` on a completed mutation of the row's own ConfigPort
  authority (the TUI settings document for theme/display, the Host
  `pi-tui-visual-tools` form section for Visual tools) plus an authoritative
  re-read that agrees with a `configReadiness() === 'ready'` backend. A non-ready backend refuses the theme commit before it applies
  anything; a display commit may apply the Client-local runtime fact and then
  reports that it could not be stored. A REJECTED write is never attributed: the
  authority is re-read (the Remote adapter forces that read on a failed RPC, whose
  failure does not prove a refusal), and only an authority that is current and still
  carries the value the request STARTED from yields `Not saved`; a third value, a
  requested value already in place or an unreadable authority yields
  `Outcome unknown`, a success whose readback could not be performed yields
  `Commit accepted · verification unavailable`, and a success whose readback readably
  disagrees is a failure. The terminal detections and the live scheme listener are
  fenced on the runtime owner's own deliberate-selection intent
  (`TuiApp.noteThemeSelection()`), never on the asynchronous document; the leased
  workspace screen joins that tracking sync while it owns the terminal, and a detection
  released by a screen hand-off is re-sampled once on the surface that takes over when the
  intent still follows the terminal. The Detail names the runtime and the
  persisted fact separately, and the panel keeps no second truth store.
- **The Detail projection is ambiguity-free.** Terminal sequences and unknown
  controls are stripped at the display boundary, but CR/LF/TAB render as visible
  `\n`/`\r`/`\t`, other controls as `\xNN`, and a literal backslash as `\\` — two
  different raw values (a real newline vs a literal `\n`) can never look the same.
  The copy source stays the untouched DTO value.
- **Blocking owners pre-empt by closure** (§10.1): Question/Approval/Save run
  `abandonWorkspaceForBlockingOwner()`, which closes the Job AND Settings leases
  under one freeze window before committing their own state. A Settings open that
  finds a blocking owner already active is refused.
- **The legacy bridge closes before it opens.** The `Other settings` row runs
  `openLegacySettings()` only after the workspace's own `close()` has retired the
  lease and restored the return surface, so the existing `SettingsList` mounts on
  the real return surface instead of stacking under a second physical owner; a
  failed legacy open reports the real error on the restored surface and never
  resurrects the closed workspace.
- **Read projection, not a second store.** The panel holds no ConfigPort and no
  subscription: the `/settings` command assembles a detached snapshot at open and
  at the explicit `R` refresh, and the panel renders it. Its only write verb hands
  ONE explicit `{ field, value }` request to the command-owned channel, which runs
  it on the existing serialized whole-document path and re-reads the authority; the
  panel keeps just the transient choice/pending/settled presentation and drops any
  settlement that does not match its live request identity. Copy captures the row's
  exact source value synchronously and the app's settlement re-proves THIS
  workspace record before it may notify, so a late clipboard result can neither
  repaint nor address a replacement workspace.

### 10.4 Image workspace: the third leased screen

`/view-image` and a fullscreen transcript image-body click open the Image UX
PR2 workspace. It is the SAME temporary physical-screen lease as §10.1/§10.3
(`leaseWorkspaceScreen('image', …)` commits the one `this.workspaceLease`), not
an OverlayBroker node. It is mutually exclusive with the Job, Settings and
direct `/plugins` leases, and it obeys the same paused-return-surface,
modal-pre-emption, exactly-once close and final-dispose rules.

- **Why a screen, not an overlay.** The pinned renderer's overlay compositor
  returns the BASE line unchanged when that line already contains an inline
  image (`compositeTuiLine` → `isImageLine(baseLine)`), so a framed overlay
  would silently drop its rows over transcript images and could not reliably
  paint the image itself. A leased screen makes the image an ordinary BASE line
  of its own `TuiAltScreen` — the proven `Image` rendering path — with the
  transcript screen paused underneath.
- **Two internal states, one screen owner.** The workspace panel hosts the
  mounted-window occurrence LIST (`SearchablePicker`, no full-text search) and
  the read-only VIEWER as mutually exclusive states of the SAME layout root.
  Enter moves list → viewer; `Esc back` returns to the exact same list instance
  and selection; a second Esc closes the workspace. A viewer opened directly
  from a transcript image body has no list below and advertises `Esc close`.
  No nested Alt Screen, no second focus owner, no overlay fallback.
- **The return surface is paused, never rebuilt.** Opening/closing the workspace
  never rebuilds, scrolls, collapses or expands the transcript; the paused
  screen's object tree, focus, draft and scroll state survive. A session
  switch, blocking Question/Approval/Save owner, or final dispose closes the
  lease through the shared primitive — a retired occurrence scope can never be
  re-authorized against the replacement session.
- **Read authority and protocol scope.** The viewer reads through the ONE
  existing `ImageLoader` keyed by the occurrence's immutable presentation scope
  and `attachmentId`; one subscription, one idempotent unsubscribe, no second
  cache or read service. PR2 renders real pixels on Kitty only: the AltScreen
  deliberately disables the iTerm2 image capability and its cursor-up framing
  is outside the fork's ANSI width layer, so the iTerm2 workspace shows the
  real metadata plus `Preview unavailable`; native iTerm2 workspace pixels are
  deferred to separate renderer/protocol work. Transcript thumbnails keep their
  existing per-surface capability behavior.

## 11. Optional seat tenant: PARK / REFUSE
A private Client-local caller may project ONE optional tenant into the editor
seat. The seam and its arbitration are shipped; its first real tenant is
`Ctrl+R` (`TuiApp.openHistorySearch`) projects the
`HistoryPanel` into the seat through `TuiApp.tryOpenOptionalSeatTenant`. The
seam stays private and no extension service opens a tenant. The three BLOCKING
owners (Question, Approval, Save Location) outrank it, and the record never
becomes a second authority over them or over the editor seat.

- **Authority.** The single record (`phase: 'active' | 'parked'`, one per-open
  `token`, one caller-owned `close`) lives in `TuiApp`. The component and its
  lifetime stay caller-owned, and `EditorSeatHolder` stays the only owner of the
  host/plugin editor it manages. Currentness is the caller's `isCurrent()`
  predicate (its session/generation subject) — never a status cwd/text, a
  `TuiApp.generation` on its own, or a shadow `focused` boolean.
- **REFUSE is a capacity result.** The open checks a disposed surface, a live
  Question (`activeQuestions`), a pending approval (`approvals.hasPending()` —
  an ACTIVE prompt OR a queued one, so the synchronous window between a settle
  and the next `showNext()` is still blocking) and a live Save Location
  (`activeSaveLocation`) BEFORE the factory runs: a refused request calls no
  factory, calls no `close`, writes no notification and leaves the blocking
  owner untouched. The seat-arbitration gates (`optionalSeatBlocking`, the
  projection focus fence and the `↓ view` affordance) read that same pending
  fact.
- **One source of truth for the seat projection.** `seatFallbackComponent()`
  derives the physical occupant from the LIVE owner — Question frame > Save
  Location frame > live Approval action sheet > ACTIVE-and-current optional tenant
  > the latest host/plugin editor — and returns `undefined` while a blocking owner
  is live but its frame is not built yet, so a synchronous callback's late tail
  can never project a newer winner over it. `mountSeatChild()`, `focusSeatOwner()`,
  the fullscreen focus fallbacks and the plugin `viewSwap` guard all read that ONE
  derivation;
  physical focus is never inferred from, and never rewritten by, a parked
  tenant.
- **The subject is re-validated at every ACTIVE entry.** `revalidateOptionalSeat()`
  runs at the input entry, at the re-projection entry (`mountSeatChild`), at the
  focus entry (`focusSeatOwner`), at the protocol fence and at BOTH screen-swap
  entries (`setFullscreen`), which also re-sync the SHARED seat mount through
  `projectSeatOccupant()` (a swap projects the live owner BEFORE the new screen
  takes the keyboard and retires the stale record AFTER the swap is committed,
  so a throwing cleanup cannot half-swap the surface). A record whose
  `isCurrent()` went false is RETIRED there — its caller cleanup runs exactly
  once, like an explicit close — and the seat re-projects and focuses the live
  winner, so the physical mount can never keep painting a panel whose
  session/generation is gone while the fork still dispatches keys to it. The
  focus entry protects a NEWER owner that the retirement's cleanup established:
  it samples the broker's monotonic focus-INTENT revision around the
  re-validation and skips its fallback only when that revision moved DURING the
  call (a capturing overlay focused itself, or an already focused one
  re-requested focus — comparing the focused component's identity would miss
  both). That revision counts EVERY keyboard handoff the broker performs: its
  explicit `focus()` AND the auto-focus the fork performs inside
  `setHidden(false)` for a hidden capturing overlay (a cleanup's `show()` /
  `focus()`), which never passes through the broker's focus seam — an uncounted
  handoff would let the fallback steal the keyboard back from that newer owner.
  An owner the broker is RELEASING right now moved its revision before the
  call and therefore never vetoes the fallback — which is exactly what keeps the
  fork's own unfocus fallback from restoring the `preFocus` of a just-retired
  component. Whenever nothing was retired the pre-existing fallback semantics are
  unchanged (the broker's suspension/resume paths rely on them).
- **A failed park rolls the blocking owner back.** The park of a blocking owner
  (Question / Save Location / approval) runs the stale tenant's caller cleanup,
  which may throw. The owner then ROLLS BACK instead of staying half-committed,
  and the rollback is a per-step batch of INDEPENDENT obligations: the failed
  state is latched settled and its `abort` binding released (it leaves every owner
  slot here, so nothing else could ever unbind the caller's signal), the owner
  slot is cleared only while the failed state STILL owns it — a cleanup that
  aborted the old modal, synchronously opened a NEWER same-type modal and then
  threw must not have its newer owner wiped (the new Question / Save frame stays
  mounted and the new approval stays answerable) — the Save prompt is released,
  the seat is re-projected to the live owner, the derived seat is re-published (a
  hostless `TuiApp` only mirrors it through the render funnel's host branch) and
  the frame repainted. The ORIGINAL failure then propagates, aggregated with a
  rollback failure, both kept BY IDENTITY (a user-thrown `AggregateError` is ONE
  entry and is never flattened into its `.errors`), so the caller's promise
  rejects and no unpresented owner blocks later requests. An abandoned
  presentation also (a) advances its FIFO successor through the EXISTING queue
  authority — a Question's handover with the same suspension transfer and focus
  order, an approval's `showNext()` — so a flow a cleanup legally queued while the
  failing one still owned the seat is presented instead of staying pending
  forever, and (b) when nothing is queued, hands back any suspension roots it
  acquired (`releaseAbandonedSuspension`): a callback inside its window can open a
  newer overlay that the broker appended to its set, and dropping the state
  without resuming them would strand live roots hidden with nobody left to
  restore them. Neither obligation may truncate the other: a throwing rollback
  step (seat remount, focus setter, repaint) still lets the queue advance run, and
  an approval's `showNext()` failing still lets the host rollback run — both
  failures surface by identity with the primary one. The advance is GATED on the
  failed state still owning the seat when its park failed: a cleanup that aborted
  it through the normal path already handed the seat — and with it the queue
  authority — to a NEWER successor, and dequeuing "on behalf of" the abandoned
  flow would overwrite that live successor and leave it pending forever. The
  successor fact is committed BEFORE the handover runs (`shiftLiveQuestion()`,
  then `handOverQuestion`): a throwing handover step has already installed and
  logically committed its successor, so "the handover returned normally" must
  never decide whether the settlement's restoration runs — that would clear the
  live successor's owner slot and strand its promise. The handover UNIONS the
  predecessor's suspension set into the successor's (never dropped) and then
  ALWAYS takes its own `suspendVisibleRoots` over whatever is still visible, once
  it is committed as the live owner: "has a frame" is NOT the same fact as "its
  initial suspension completed" — a predecessor can be superseded by a root's
  `onBlur` WHILE that suspension is running, leaving its frame installed and its
  roots neither hidden nor resumed, and the superseded suspension then skips its
  remaining hides because the set was handed over. Re-suspending closes both:
  already hidden roots are filtered by visibility (no re-suspension, no focus
  move), and a root a callback re-showed while the modal owned the seat is hidden
  exactly like at a fresh presentation. Because that suspension is a NEW callback
  window, the handover mirrors `presentQuestion`'s fences: only a still-live
  successor focuses its frame and publishes its seat, while a superseded one hands
  back the suspension it still owns (its successor already took the graph) and
  never re-focuses its retired frame over the newer owner.
  Without all of this, a caller-side cleanup failure would leave an
  unpresented modal blocking every later request while a retired component stayed
  painted.
- **PARK is committed before the blocker's first callback.** A Question commits
  `activeQuestions` and parks the tenant BEFORE the Save Location handoff; an
  approval commits its pending prompt as active BEFORE the park, the Save
  Location cancellation and the mount; a Save Location commits
  `activeSaveLocation` BEFORE the park. The tenant therefore never flashes an
  intermediate ACTIVE → PARK round trip, and a settling Save Location can never
  take its "nothing else is active" restore path behind a prompt that is
  already mounting.
- **Question → Save Location handoff.** A Question that supersedes a Save
  Location passes its own state into `settleSaveLocation(state, result,
  handoff)`. When that flow is STILL the live active one, the prompt transfers
  its `suspendedOverlays` INTO the flow's set (a UNION — a callback inside the
  batch may already have opened a newer overlay that the broker appended to that
  flow, and those roots must be resumed by its own settle, not stranded) and
  SKIPS the seat remount, the focus
  fallback and `resumeSuspendedRoots` (the question resumes the graph once, at
  its own final settle). Prompt disposal, the abort-listener cleanup and the
  promise settlement stay independent steps, and the handoff target is re-read
  INSIDE the batch AFTER those cleanup callbacks: `prompt.dispose()` aborts the
  prompt's completion port, whose subscribers can synchronously cancel or
  replace the superseding flow, so a settle/dead target makes the handoff a
  no-op and the prompt restores normally instead of resurrecting a dead
  presentation. `presentQuestion` fences every one of its own callback windows
  (the optional-tenant park, the activity projection, the handoff, the broker
  suspension, the frame focus) with the same live-flow identity test, so a
  preempted flow never mounts, focuses or publishes its frame — and in
  particular never hides a live overlay root into a dead flow's suspension set,
  which nothing would ever resume.
- **Restore only at the LAST blocker.** The Question/Save final settles clear
  their owner first, then call `maybeRestoreOptionalSeat()`; an approval
  restores only after `showNext()` proved the LIVE queue drained (`active ===
  undefined && queue.length === 0`), so a queued A → B approval keeps the tenant
  PARKED between the two prompts. The restore re-reads `isCurrent()` and the
  live blocker set; a stale subject is retired instead of restored. The
  focus fallback that follows a settle (`focusSeatFallback`) re-reads the live
  owner too: a capturing overlay that a callback of the SAME batch opened (or
  another blocking owner that appeared) keeps the keyboard instead of being
  blurred by a pre-settle snapshot and re-focused by the broker afterwards.
- **Exactly-once identity.** `retireOptionalSeat(token)` drops the identity
  FIRST, latches `finalized` BEFORE the caller's `close()`, and attempts the
  cleanup and the fallback projection as INDEPENDENT `runSyncDisposalSteps`
  entries; a lease that arrives late is a strict no-op for the newer record. A
  monotonic request revision fences BOTH a re-entrant factory and a re-entrant
  previous `close()`: a candidate whose revision went stale releases exactly
  itself and never installs (there is no unconditional
  `finally { optionalSeat = old }`).
- **Input.** While the tenant is `active`, current and PHYSICALLY focused — and
  after every modal / viewer / search / capturing-overlay owner had its turn —
  the ordinary keys go to its `handleInput` and are consumed: the Host editor
  submit / steer / queue / task actions, the leader machine and the
  plugin-editor Enter forward must never fire behind it. Host-RESERVED input
  keeps its owner: physical Esc (the interrupt/exit lifecycle seam), the
  effective exit key, the unstable raw-capture stage and the terminal protocol
  all keep their own policy. Host-classified protocol chunks (SGR/legacy mouse
  reports, terminal focus reports, Kitty key release/repeat) are additionally
  stopped from ever being DELIVERED to a tenant. `protocolSinkFence` is the
  LAST input listener on every screen — for fullscreen it is registered AFTER
  the alt screen's viewport listener, so FOCUS_OUT still runs that listener's
  selection cleanup and every mouse event the viewport recognizes stays with it
  — and it re-validates the subject FIRST (a stale record is retired and the
  live owner re-projected even when the chunk never reaches the key ladder,
  whose mouse / focus-report branches return earlier) and then guards on the
  PHYSICAL focus fact, so a stale-but-still-focused record can never collect a
  raw chunk either. It is completely inert otherwise (the pre-existing editor /
  overlay / viewport routing is unchanged). Bracketed PASTE is user text, not
  protocol input, and still reaches the focused component. The ordinary-key
  path re-validates the subject too, so a parked, finalized or stale tenant
  receives nothing.
- **One narrow exception, owned by the History tenant.** While the
  History tenant is ACTIVE, current and physically focused, physical Escape and
  `Ctrl+C` are consumed as ITS cancel (close the seat, leave the draft/cursor/
  input mode untouched) in a dedicated branch that runs BEFORE the Host
  physical-Escape/interrupt seam and the global exit admission — closing History
  must never interrupt the agent or quit the TUI. Every other Host-reserved input
  keeps its owner: a REMAPPED `app.exit.request` still runs the Host admission
  (only the physical `Ctrl+C` is the History cancel), the blocking owners above
  still outrank the tenant, and terminal protocol chunks are still stopped by the
  sink fence. Escape is bound per-surface, never remapped globally.
- **The History tenant's own surface contract.** The panel is a full-width,
  border-free seat occupant: the Transcript keeps rendering above it and the
  ordinary footer below it (no overlay, no second screen, no
  `overlayGraphState()` node). Its row grant comes from the LIVE terminal
  geometry and the measured non-seat chrome with one reserved transcript row; the
  header/query/footer are the mandatory rows, the results window is capped at
  eight rows and the wrapped Preview owns the remainder (heading and metadata
  yield before mandatory navigation). Pointer handling is **Transcript Fullscreen
  only**: the alt screen's EXISTING component dispatch delivers press/drag/wheel
  into `HistoryPanel.handleMouse`, which resolves everything against its LAST
  PAINTED frame (width/height, painted result identity, search generation) and
  copies exact original source offsets for a Preview drag. The regular main
  screen installs no mouse capability at all: `handleMouse` refuses while the
  pointer capability is disabled, no SGR/mouse mode is written, and native
  terminal selection/scrollback stays untouched. A result click only SELECTS;
  the explicit `[Use selected]` / `[Copy all]` actions (and Enter / `Alt+C`)
  accept or copy, and a button pressed for one entry never acts on whatever moved
  into its painted cells.
- **Approval seat mount fence.** `ApprovalRuntime.showNext()` commits `active =
  pending` BEFORE the park / save cancellation / seat projection, and re-reads
  that same stage identity (`ownsStage`) after EVERY mount-phase hook that can run
  a callback: after the park hook (a caller cleanup that settles THIS prompt and
  opens a newer Save Location must not have that prompt cancelled by this tail),
  after the Save cancellation (the prompt's disposal can settle or replace this
  prompt), and after the host projected the sheet frame: a losing mount disposes
  only the frame it created and never publishes over the newer prompt.
  `TuiApp.mountApprovalSeat` suspends the visible managed roots, installs the
  frame as the seat occupant and focuses it only while Approval is still the
  derived live seat occupant: a Question/Save presented by a callback keeps the
  seat/focus, and a NEWER focus/capturing mount wins over this mount's late
  focus. The approval frame stays projected and re-takes the keyboard through
  the live seat derivation when the newer owner leaves. On settle, the sheet is
  unprojected and disposed BEFORE the suspended roots are resumed; the queue
  successor decision (`showNext`) runs first, so a mounted A→B successor owns the
  suspension and receives the handles WITHOUT a transient reveal/focus between
  prompts. A FAILED presentation — a throwing park hook OR a throwing seat mount —
  takes one shared identity-fenced path: this prompt is latched settled, its abort
  binding is released, its active ownership is cleared only while it is still the
  active one, its OWN promise is rejected with exactly the value that path throws
  (a prompt mounted from another prompt's settle tail has already returned from
  its executor, so nothing else could ever settle its caller), the released frame
  is disposed, the host re-projects the live seat owner and runs the same
  successor-then-resume/transfer order, and the queue advance runs as an
  independent step; the LAST-blocker notification runs once no approval is active
  and the queue drained — a PARKED but still-current tenant comes back instead of
  staying parked behind a presentation that never happened.
  Managed-overlay mounts themselves still use the ONE overlay mount funnel
  (`showOverlayOnHost`), which fails closed on BOTH mount stages, and decides
  which stage it reached from THIS call's own progress — never from `node.raw`,
  which a re-entrant fullscreen swap legitimately clears again for an
  already-registered remountable node (`OverlayBroker.detachPhysical`) and would
  make a registered node look unregistered. The raw-handle-returned fact is
  recorded at the fork call, and the mounting SCREEN is captured for the cleanup:
  the fork pushes its overlay-stack entry and performs terminal IO BEFORE it
  returns a raw handle, so a throw before that handle exists releases that
  projection POSITIONALLY on the screen that mounted it (`hideOverlay()`, and only
  then: `initialFocus:false` runs no callback in that window, so the pop can only
  remove the entry this mount pushed) — a re-entrant swap must not make the unwind
  pop an entry belonging to the NEW screen, e.g. the projection of a surviving
  root that was just re-mounted there. A throw after the handle was returned
  unwinds the broker node by identity instead. Either way a mount whose caller
  never received a handle can never survive as a ghost modal, a half-committed,
  keyboard-owning suppressor, or a cleanup that removes somebody else's entry.
  The SYMMETRIC window (no throw) is the same mount interleaved with a fullscreen
  swap that a plugin callback started. It is closed STRUCTURALLY: the remount
  callback is registered BEFORE the fork's physical mount — `showOverlayOnHost`
  takes it as an ownership capability and publishes it from `prepareMount`'s
  stable logical handle — so the swap's own back→front remount pass already
  re-creates that node's projection, in the CURRENT logical order, and the mount
  ends visible, focused and answerable instead of as an invisible active owner.
  Recovering after the fact is NOT equivalent: `showOverlay` can only APPEND a
  physical entry, so a projection created later sits above the overlays that are
  logically above it and the broker's logical z-order diverges from the paint and
  pointer-hit order. `registerOverlayRemount` is the ONE authority every
  remountable registration goes through (the three Advanced/unstable plugin
  leases, the history search overlay and the model picker); the Approval sheet is
  a seat frame, not a managed node, so it needs no remount pass and must never
  register a fake overlay. `restoreFocusAfterSwap()` then
  re-applies the pre-swap keyboard owner only while no NEWER owner holds the
  keyboard at that moment: a newer explicit `focus()`, or a capturing overlay a
  callback mounted, wins and keeps the keyboard.
- **Final disposal.** `TuiApp.dispose()` pre-retires the optional identity and
  rides the caller's `close()` as the FIRST independent step of the `tui
  dispose` batch, so a throwing tenant cleanup neither skips the
  approval/question/save/holder teardown nor is swallowed — both failures
  surface as `AggregateError.errors` in batch order.
- **By-design boundaries.** Question/Save/Approval are blocking editor-seat
  owners: they fence the physical seat through the one seat derivation, so a
  plugin recompile may only update the HIDDEN holder state while the blocker
  stays painted and keeps the keyboard. An Approval is fullscreen-mouse capable
  on its own painted cells only; Regular remains keyboard-only. `stop()`/`start()`
  and the external-editor round-trip are NOT disposal: the logical record
  survives them. History IS a real optional tenant; its Session currentness and
  physical retirement are the contract in §11.1 below, which extends — never
  replaces — this seam.

Evidence: `test/domain/editor-seat-optional-tenant.test.ts` (B-01…B-60: activation and
real key delivery, the REFUSE gate, PARK/restore across Question, Save Location
and Approval including both FIFOs with a REAL suspended overlay root, the
host-classified protocol fence on both screens for CURRENT and STALE subjects, a
capturing overlay opened from a restore callback, a completion-abort that
cancels the superseding flow, an ACTIVE stale subject at the input and at both
screen-swap entries, replacement and re-entrant-close identity, a plugin editor
HMR while parked, regular↔fullscreen, resize cycles, final disposal,
throwing-cleanup aggregation, a cleanup that preempts the presentation and opens
a NEWER same-type modal, the failed state's released abort binding, a cancelled
Save presentation that mounts no frame and hides no root, the Approval A→B
handover refusing a fresh opener, a callback-created root handed back, the
rollback's independent repaint and seat publish with identity-preserving
aggregation, Save preemption by a Question and by an Approval, an Approval +
Question overlap, a capturing-overlay handoff, the PARKED History tenant, the
`↓ view` affordance withheld while an ACTIVE tenant owns the seat, a broker
release that must not resurrect a just-retired tenant, a failed presentation that
advances a QUEUED successor (Question handover and approval `showNext`), a
DOUBLY-failing approval park that still presents its queued successor, a throwing
handover step that cannot clear the successor it installed, a failed
presentation that cannot dequeue over the newer successor that preempted it, a
successor that takes its own initial suspension, an auto-focused overlay that
keeps the keyboard against the seat fallback, a successor superseded INSIDE its
own initial suspension (the inherited roots stay hidden and the live frame keeps
the keyboard), a settled approval that never cancels the Save Location its own
cleanup opened, a throwing seat projection that releases the failed approval and
keeps the queue and the optional seat usable, the flat identity/order contract of
multiple rollback failures, a real Advanced blur/reconciliation chain that
escapes the mount (the registered node unwound, the surviving root intact and the
healthy tenant restored afterwards), a QUEUED approval whose mount fails rejecting
its own promise instead of waiting forever, a re-entrant fullscreen swap inside the
failed mount (the failed Approval unwound on the swapped screen while the
re-mounted surviving root is never popped as a ghost), a swap interleaved with the
Approval seat projection itself (the sheet stays projected, focused and answerable
on the new screen while the suppressed root stays suppressed), a callback's NEWER
focus (and a capturing overlay it mounted) inside that swap window keeping the
keyboard against the pre-swap snapshot, an Advanced lease whose OWN mount
interleaved a swap being re-projected in logical order through the one
registration authority, a newer capturing overlay mounted inside the Approval
seat window staying suspended under the blocking sheet and taking the keyboard
when the sheet releases it, a newer owner that leaves inside the window still
handing the keyboard to the live Approval, and input routing).

### 11.1 Session currentness and publication retirement

The optional History tenant's Session identity is closed without adding a
second authority:

- **One capture, one predicate.** At `Ctrl+R` the application composition calls
  the runtime's single `SessionScopeAuthority.capture()` ONCE and hands the TUI
  only `{ sessionId, isCurrent }` (`HistoryOpenScope`). `TuiApp` stores that pair
  and it is the ONE Session-currentness predicate behind the optional record and
  the panel's every acting entry (accept, copy, async search commit, pointer).
  The old History-only `historySearchSessionId` getter and the mixed
  `TuiApp.generation` check are gone: a same-id reopen, an A→B→A switch, a
  same-owner generation bump and a sessionless→first-session publication all
  fail the exact-owner/generation fence. No History epoch, no shadow counter.
- **Publication retirement.** `SurfaceRuntime.retireStaleHistorySeat()` (a
  PRIVATE instance port — never part of `SurfaceDisplaySeam` or any TSP/Host
  API) delegates to `TuiApp.retireStaleHistorySeat()`, which reuses the ONE
  existing `revalidateOptionalSeat()`. The runner calls it from the three
  `publishOwner` seams immediately after `beginInputHistoryScope` (ordinary
  switch, fork adoption, first-session creation), before any post-commit await;
  the ownership core's single `resetForGeneration` hook calls it too, covering a
  same-owner generation bump (including one a pre-publication failure already
  produced). The call is synchronous, state-only and strictly non-throwing: a
  tenant cleanup failure is routed to the owned-failure reporting channel and can
  never roll back or mask the already-published Session. The logical fence is the
  owner commit itself; this port only performs the physical close.
- **Accept reentrancy.** `openHistorySearch`'s `onAccept` closes its OWN lease,
  then re-reads the captured scope (not the now-closed panel instance) and the
  live blocker / newer-optional-tenant / focused-capturing-overlay facts before
  `setEditorText`; a newer owner that took the seat during the close keeps the
  keyboard and the current editor.

Evidence: `test/app/history-seat-lifecycle.test.ts` (H3B-01…H3B-12: the real
`SessionScopeAuthority` + ownership core + `bindSessionRuntime` publication over
a real `TuiApp`/`VirtualTerminal`, Question/Approval FIFO park/restore, A→B→A
and same-id re-owner refusal, the failed/pre-commit switch, a deferred
search/copy settling after a switch, and the reentrant accept), plus the
existing `test/client/ctrl-r.test.ts`, `test/client/history-panel.test.ts`,
`test/client/history-seat-mouse.test.ts` and `test/domain/editor-seat-optional-tenant.test.ts`
suites.

## 12. The on-demand Task Quick accessory

Task Quick is a first-party private pinned decoration, not an overlay. Its
behavior is owned by [surface-behavior.md](./surface-behavior.md#task-quick);
this section records only the seat/geometry mechanics:

- It is mounted on both roots in the same physical band as the public
  `input.widget.below` zone. The public slot keeps its registration, ordering,
  visible-text contract and lifecycle untouched.
- It is `Focusable` and keyboard-driven through the normal focus transition:
  entering is a `setFocus(taskQuick)` from the keymap-admitted
  `app.tasks.open`; leaving restores the CURRENT seat occupant. `focused` is
  the ONE visibility authority.
- Every blocking owner terminates it at its own composition commit — before the
  new owner takes focus — and an active projection that empties exits through
  the component's `onEmpty` (guarded to the real focused component, so a hidden
  empty commit never re-enters the host lifecycle).
- The band paints one top separator and at most five rows; a zero grant
  renders `[]` with no blank band and no hit geometry.
- Pointer support exists only where the application already has pointer input
  (the alt screen's component dispatch inside Transcript Fullscreen). A wheel
  moves only the accessory's own window, resolved against the LAST PAINTED
  frame; it never focuses, opens or acknowledges anything. The regular main
  screen remains keyboard-only.
- Rows are published by the surface Task Runtime through a private `TuiApp`
  sink on every row/attention commit. The accessory keeps no catalog, timer or
  subscription; a session-generation reset clears it with the other Task Center
  mirrors.

Evidence: `test/app/task-quick-interaction.test.ts`,
`test/app/task-quick-accessory.test.ts`, `test/app/fullscreen-widget-parity.test.ts`,
`test/app/surface-lifecycle-closure.test.ts`.
