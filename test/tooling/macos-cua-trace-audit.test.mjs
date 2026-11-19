/**
 * Discrimination replay for the MAC09-08 controlled-trace audit.
 *
 * The native lane can only observe whatever a model happens to emit, and until
 * rc.5 every real trace was a SINGLE segment — so the cross-segment, ordering
 * and result-identity rules added for RFL-014 were never exercised by anything
 * that would fail if they were wrong. This test replays the REAL audit function
 * (`auditControlledTrace`, imported from the lane itself, not a copy) against
 * synthetic traces: three positive shapes that must be admitted, and four
 * negative shapes that must be refused for the exact reason they are unsafe.
 *
 * It touches no OS, no Host and no tty: the two async facts the audit needs are
 * injected as plain functions.
 *
 * MUTATION CONTROLS actually run against this file (each rule reverted in turn):
 *   - drop the show-before-typeText ordering      -> the "typed BEFORE" case fails
 *   - drop the `trace[0] === 'getApp'` guard      -> the prefix case fails
 *   - drop the owned-window id check on `show`    -> the foreign-window case fails
 *   - take the handle from the FIRST getApp       -> the recovered-retry case fails
 * One rule is NOT independently observable and is therefore not claimed as
 * discriminating: binding the qualifying result to the final segment's own
 * typeText. The single-typeText rule already forces the first typeText to BE the
 * final one, so that binding is defence-in-depth, not the thing that catches a
 * failure. No test was manufactured to make it look otherwise.
 *
 * @module macos-cua-trace-audit.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { auditControlledTrace } from '../../scripts/smoke/macos-cua-parity.mjs'

const PID = 4242
const RUN_TOKEN = 'cua-blank-abc12345'
const MARKER = 'CUA-MARKER-TEST'
const OWNED_WINDOW = 101
const OTHER_WINDOW = 202

/**
 * Build one dispatch of a synthetic trace. Results are keyed by subCallId so a
 * single trace can carry several getApp handles and several windows.
 */
function dispatch(method, params, options = {}) {
  const subCallId = options.subCallId ?? `${method}-${String(options.index ?? 0)}`
  // The production event shape: the method/params live in `arguments`, which is
  // what dispatchArguments()/dispatchMethod() read on the real stream.
  return { arguments: { method, params }, subCallId, result: options.result }
}

function getApp(subCallId, selector = PID, appHandle = 'app-1') {
  return dispatch('getApp', { selector: String(selector) }, { subCallId, result: { appHandle } })
}

function listWindows(subCallId, appHandle, windows) {
  return dispatch('listWindows', { appHandle }, { subCallId, result: windows })
}

function show(subCallId, appHandle, windowId) {
  return dispatch('show', { appHandle, windowId }, { subCallId })
}

function activate(subCallId, appHandle) {
  return dispatch('activate', { appHandle }, { subCallId })
}

function typeText(subCallId, appHandle, text) {
  return dispatch('typeText', { appHandle, text }, { subCallId })
}

function getState(subCallId, appHandle) {
  return dispatch('getState', { appHandle }, { subCallId })
}

/** The owned window plus, optionally, a foreign document of the same app. */
function ownedWindows(extra = []) {
  return [
    { windowId: OWNED_WINDOW, title: `${RUN_TOKEN}.txt` },
    { windowId: OTHER_WINDOW, title: 'notes.txt' },
    ...extra,
  ]
}

/** Run the real audit with injected async facts. */
function audit(trace, { typeTextError } = {}) {
  return auditControlledTrace({
    trace,
    textEditPid: PID,
    runToken: RUN_TOKEN,
    marker: MARKER,
    resolveJson: d => d.result,
    resolveTypeTextResult: async d => ({ result: { isError: typeTextError !== undefined, content: [] } }),
  })
}

async function rejection(trace, pattern, options) {
  await assert.rejects(() => audit(trace, options), pattern)
}

// ── positive shapes that MUST be admitted ──────────────────────────────────

test('a single-segment chain is admitted', async () => {
  const admitted = await audit([
    getApp('g1'),
    listWindows('w1', 'app-1', ownedWindows()),
    show('s1', 'app-1', OWNED_WINDOW),
    activate('a1', 'app-1'),
    typeText('t1', 'app-1', MARKER),
    getState('e1', 'app-1'),
  ])
  assert.equal(admitted.inputSequence.join(','), 'getApp,listWindows,show,activate,typeText,getState')
  assert.equal(admitted.segmentStarts.length, 1)
  assert.equal(admitted.previews, 0)
  assert.equal(admitted.controlledHandle, 'app-1')
})

test('a bounded read-only preview before the input is admitted', async () => {
  const admitted = await audit([
    getApp('g1'),
    listWindows('w1', 'app-1', ownedWindows()),
    getState('p1', 'app-1'),
    show('s1', 'app-1', OWNED_WINDOW),
    activate('a1', 'app-1'),
    typeText('t1', 'app-1', MARKER),
    getState('e1', 'app-1'),
  ])
  assert.equal(admitted.previews, 1)
  assert.equal(admitted.attemptStateDispatch.subCallId, 'e1',
    'the observation is the LAST getState, never the preview')
})

test('a recovered retry whose final getApp returns a NEW handle is admitted', async () => {
  const admitted = await audit([
    // Earlier attempt: read-only, its own handle and its own owned window.
    getApp('g1', PID, 'app-1'),
    listWindows('w1', 'app-1', ownedWindows()),
    show('s1', 'app-1', OWNED_WINDOW),
    getState('e1', 'app-1'),
    // Final attempt: a NEW handle, and the whole chain follows it.
    getApp('g2', PID, 'app-2'),
    listWindows('w2', 'app-2', ownedWindows()),
    show('s2', 'app-2', OWNED_WINDOW),
    activate('a2', 'app-2'),
    typeText('t2', 'app-2', MARKER),
    getState('e2', 'app-2'),
  ])
  assert.equal(admitted.segmentStarts.length, 2)
  assert.equal(admitted.controlledHandle, 'app-2', 'the final segment owns the qualifying handle')
  assert.equal(admitted.listWindowsDispatch.subCallId, 'w2',
    'listWindows must come from the FINAL segment, never an earlier one')
  assert.equal(admitted.typeDispatch.subCallId, 't2')
})

// ── negative shapes that MUST be refused ───────────────────────────────────

test('a typeText in a NON-final segment is refused', async () => {
  await rejection([
    getApp('g1', PID, 'app-1'),
    listWindows('w1', 'app-1', ownedWindows()),
    show('s1', 'app-1', OWNED_WINDOW),
    typeText('t1', 'app-1', MARKER),
    getState('e1', 'app-1'),
    getApp('g2', PID, 'app-2'),
    listWindows('w2', 'app-2', ownedWindows()),
    show('s2', 'app-2', OWNED_WINDOW),
    typeText('t2', 'app-2', MARKER),
    getState('e2', 'app-2'),
  ], /typed 2 times; the scene claims ONE bounded input/u)
})

test('a show of a window that is NOT the owned one is refused', async () => {
  await rejection([
    getApp('g1'),
    listWindows('w1', 'app-1', ownedWindows()),
    show('s1', 'app-1', OTHER_WINDOW),
    typeText('t1', 'app-1', MARKER),
    getState('e1', 'app-1'),
  ], /selected a window that is not this run's owned cua-blank window/u)
})

test('typing BEFORE the owned-window show is refused even when the observation finds the marker', async () => {
  await rejection([
    getApp('g1'),
    listWindows('w1', 'app-1', ownedWindows()),
    typeText('t1', 'app-1', MARKER),
    show('s1', 'app-1', OWNED_WINDOW),
    getState('e1', 'app-1'),
  ], /typed BEFORE selecting the owned cua-blank window/u)
})

test('a FAILED final typeText is refused even when the trace is otherwise legal', async () => {
  // Exactly ONE typeText (so the single-input rule cannot be what fires): the
  // audit must read the FINAL segment's OWN result and reject its failure
  // instead of treating a dispatched-but-failed input as the claim.
  await rejection([
    getApp('g1', PID, 'app-1'),
    listWindows('w1', 'app-1', ownedWindows()),
    show('s1', 'app-1', OWNED_WINDOW),
    typeText('t1', 'app-1', MARKER),
    getState('e1', 'app-1'),
  ], /the controlled typeText failed/u, { typeTextError: 'INVALID_ARGUMENT' })
})

test('two typeTexts are refused as more than ONE bounded input', async () => {
  await rejection([
    getApp('g1', PID, 'app-1'),
    listWindows('w1', 'app-1', ownedWindows()),
    show('s1', 'app-1', OWNED_WINDOW),
    typeText('t1', 'app-1', MARKER),
    getState('e1', 'app-1'),
    getApp('g2', PID, 'app-2'),
    listWindows('w2', 'app-2', ownedWindows()),
    show('s2', 'app-2', OWNED_WINDOW),
    typeText('t2', 'app-2', MARKER),
    getState('e2', 'app-2'),
  ], /typed 2 times; the scene claims ONE bounded input/u)
})

test('a dispatch before the first getApp is refused', async () => {
  await rejection([
    show('s0', 'app-1', OWNED_WINDOW),
    getApp('g1'),
    listWindows('w1', 'app-1', ownedWindows()),
    show('s1', 'app-1', OWNED_WINDOW),
    typeText('t1', 'app-1', MARKER),
    getState('e1', 'app-1'),
  ], /dispatched before obtaining an app handle/u)
})

test('a method the scene does not audit is refused', async () => {
  await rejection([
    getApp('g1'),
    listWindows('w1', 'app-1', ownedWindows()),
    show('s1', 'app-1', OWNED_WINDOW),
    dispatch('click', { appHandle: 'app-1' }, { subCallId: 'c1' }),
    typeText('t1', 'app-1', MARKER),
    getState('e1', 'app-1'),
  ], /dispatched a method the scene does not audit: click/u)
})
