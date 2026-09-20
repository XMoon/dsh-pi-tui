# Overlay & focus contract

The managed-overlay system (Question / Save Location modals, the Task Center
and Job viewer, pickers, `/model`, history search, the approval dialog, and
plugin overlays from the extension tiers) is a state machine whose hardest
failures are **synchronous reentrancy** bugs: a focus callback runs in the
middle of another operation and the outer operation then overwrites the newer
fact. This document records the model and the rules that keep it closed. Use it
as a **regression checklist** when you touch `/model`, add a modal, change a
plugin UI tier, or work on the fullscreen lifecycle — it exists so the next
change does not have to rediscover the same hard-won edge cases.

Implementation: `src/overlay-broker.ts` (logical authority), `src/tui-app.ts`
(host mount / seats / fullscreen), `packages/pi-tui/src/tui.ts` (physical focus
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
| Question/Save suspend | suspension ownership + per-root intent | `focusSeatOwner()` | hide only the roots the suspension still owns |
| Question/Save resume | `newerOwner` from roots detached from the suspension | `reveal()` — one focus | none |
| approval rebuild | the approval is a normal remountable node | rebind | dispose the replaced frame |
| fullscreen detach | close non-remountables; snapshot the prior physical owner | seat release/handoff (bounded, so the fork's per-hide fallback cannot fire) | derive the owner from LOGICAL intent (`frontmostFocusable`, with the prior owner as a fallback only while it still requests focus and is not explicit-hidden), then detach the raws |
| fullscreen rebind / restore | the logical graph survives; rebind with `initialFocus:false` | rebind / one restore focus | none |
| session switch / final teardown | close the Job viewer before its parent browser; clear refs | — | none |
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
2. fixed Question/Approval response keys owned by the component;
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

Approval keyboard inspection uses the same semantic allowlist. Approval mouse
inspection is not enabled because the current managed overlay does not expose
authoritative last-painted visible-dialog bounds; this is an implementation
limitation, not the product interaction contract. The contract does not invent
a second dialog hit map. Existing fullscreen selection/copy and ordinary OSC8
link behavior remain available without a modal-specific URL prohibition.

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
  overwritten by the outer `setFocus(editor)`).
- **Approval**: it is a remountable logical node; the overlays it suppresses
  must never flash or receive focus through a rebuild; replaced frames are
  disposed.
- **Session / teardown**: a child overlay (Job viewer) closes before its parent
  (Task Browser); callbacks capture the owning session identity.
- **Assertions to add**: `assertOverlayForestForTest()` after reentrant
  operations; focus/blur counts around internal restores; the logical
  `remountOrder` front after a reentrant mount; no shadow state (`wasFocused`,
  `desiredFocus`, ordinals, `previouslyFocused`) may reappear.

## 8. By-design boundaries

- A non-remountable overlay does **not** survive a fullscreen swap (its raw and
  its callbacks die with the screen); this matches the baseline behavior.
- A Question / Save Location settle restores **visibility only** for the roots
  it directly suspended; the graph below them is preserved, never flattened.
  The keyboard owner it focuses may instead be a newer root that a callback
  detached from the suspension (the explicit-operation override below).
- An explicit `show()` / `focus()` during a modal is an ownership override the
  caller is responsible for; the modal does not silently re-hide it.
