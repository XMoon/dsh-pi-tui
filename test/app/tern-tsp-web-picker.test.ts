/**
 * The native TSP `/web` presentation (M5-W PR-C) over the REAL SDK pane.
 *
 * The scripted pane, the SDK connect and `mountTspRenderer` are real; the
 * command-side `WebAccessRequest` is a spy (the command/Host wiring is the
 * subject of `web-access-command.test.ts`). Every assertion reads the REAL
 * reconciled wire tree — the picker's own props, the actions bar, the Details
 * overlay's text and node ids — so a renderer-local field can never satisfy one.
 *
 * This is NOT real-Tern-GUI evidence: the pane is a scripted headless client, so
 * the plan's `CLIENT_INTERACTIVE`/GUI rows stay NOT_RUN here (recorded in the PR
 * evidence, never claimed by this suite).
 *
 * @module @xmoon76/dsh-pi-tui/test/app/tern-tsp-web-picker
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { connect } from '@stencil-hq/tern'
import { mountTspRenderer } from '../../src/tui/tsp/session.ts'
import { runOwned } from '../../src/runtime/process/tasks.ts'
import type {
  WebAccessActionId,
  WebAccessMenuHandle,
  WebAccessReadOutcome,
  WebAccessRequest,
} from '../../src/app/command/web-access-presentation.ts'
import type { WebAccessStatus } from '../../src/runtime/web-access-port.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { settle, waitUntil } from '../support/tsp-runner-harness.ts'
import {
  WEB_LAYER_PREFIX as W,
  clickLayerNode,
  layerNodes,
  pickerActionByBase,
  pickerNode,
  pickerProps,
  sendActivate,
  sendAction,
  sendPickerAction,
  sendResize,
  sendSelect,
  type WireNode,
} from '../support/tsp-picker-wire.ts'

const props = (pane: TspPane): Record<string, unknown> => pickerProps(pane, W)
const picker = (pane: TspPane): WireNode | undefined => pickerNode(pane, W)
const items = (pane: TspPane): Array<Record<string, unknown>> =>
  (props(pane).items ?? []) as Array<Record<string, unknown>>
const actionIds = (pane: TspPane): string[] =>
  ((props(pane).actions ?? []) as Array<Record<string, unknown>>).map(entry => String(entry.id))

/** One action's BASE id (the frame token is rendered into the wire id). */
const actionBase = (pane: TspPane, base: string): string | undefined => {
  const entry = pickerActionByBase(pane, base, W)
  return entry === undefined ? undefined : String(entry.id)
}

/** One node's own visible text (properties only — never renderer state). */
function nodeText(entry: WireNode): string {
  if (typeof entry.p.text === 'string') return entry.p.text
  const spans = entry.p.spans
  if (!Array.isArray(spans)) return ''
  return spans.map((part) => typeof part === 'string'
    ? part
    : String((part as { t?: unknown }).t ?? '')).join('')
}

/** The Details Reading's visible text, from the committed layer only. */
function layerText(pane: TspPane): string {
  return layerNodes(pane, W).map(nodeText).join(' | ')
}

const silentDiag = { debug() {}, info() {}, warn() {}, error() {}, dispose() {} }

/** The frame revision the CURRENT footer actions were rendered at (-1: none). */
function actionRevision(pane: TspPane): number {
  const actions = props(pane).actions
  if (!Array.isArray(actions) || actions.length === 0) return -1
  const id = String((actions[0] as { readonly id?: unknown }).id ?? '')
  return Number(id.split('#')[1] ?? -1)
}

/** One mounted renderer over the scripted pane, with command-side spies. */
async function mounted(
  t: { after(fn: () => unknown): void },
  options: {
    readonly paneOptions?: Parameters<typeof installTspPane>[0]
  } = {},
) {
  const pane = installTspPane(options.paneOptions ?? { webPicker: true })
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session)
  const renderer = mountTspRenderer(session, {
    copyVisual: async () => false,
    requestExit() {},
    onFatal: (error) => assert.fail(String(error)),
  })
  t.after(() => renderer.dispose())
  renderer.bindInput({
    exit() {},
    cancel() {},
    submit: () => assert.fail('the picker must capture Enter'),
    steer() {},
    pasteMedia: () => {},
    pastedPath: () => {},
    admitPastedPathDelivery: () => true, shouldRememberInput: () => true,
    noteUserInput() {},
    listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false,
    openModelPicker() {}, openModelQuick() {}, openSessionBrowser() {}, sessionBrowserAvailable: () => true, openTasksBrowserUi() {}, tasksBrowserUiAvailable: () => true,
  })
  const actions: Array<WebAccessActionId | 'details'> = []
  const notices: Array<{ text: string; kind?: 'info' | 'error' }> = []
  /** The captured-subject fence: a case can revoke the request. */
  let current = true
  const open = (status: WebAccessStatus): WebAccessMenuHandle => {
    assert.ok(renderer.webPresentation, 'the web pane must expose the native /web presenter')
    return renderer.webPresentation.open({
      isCurrent: () => current,
      readStatus: async (): Promise<WebAccessReadOutcome> => ({ kind: 'status', status }),
      act: (action) => { actions.push(action) },
      runOwned: (label, task, runOptions) =>
        runOwned(label, task, { ...runOptions, diag: silentDiag }),
    })
  }
  return {
    pane,
    renderer,
    actions,
    notices,
    open,
    revoke: () => { current = false },
    ready: async (
      handle: WebAccessMenuHandle,
      status: WebAccessStatus,
      notice?: { readonly message: string; readonly kind: 'info' | 'error' },
    ) => {
      await waitUntil('web picker ready', () => props(pane).state === 'ready')
      const revisionBefore = actionRevision(pane)
      handle.setStatus({ kind: 'status', status }, notice)
      // The reprojection is a NEW frame: wait for the action id of a newer
      // revision (or the new state fact) instead of a blind sleep.
      await waitUntil('web picker reprojected', () =>
        actionRevision(pane) !== revisionBefore || items(pane)[0]?.label === `Status: ${status.state}`)
    },
  }
}

test('the native /web picker paints the disabled fact row and the ONE Enable action', async t => {
  const h = await mounted(t)
  const handle = h.open({ state: 'disabled' })
  await h.ready(handle, { state: 'disabled' })
  const propsNow = props(h.pane)
  assert.equal(propsNow.title, 'Web frontend')
  assert.equal(propsNow.state, 'ready')
  const rows = items(h.pane)
  assert.equal(rows.length, 2, 'one status fact row + the Details entry')
  assert.equal(rows[0]?.id, 'web-status')
  assert.equal(rows[0]?.label, 'Status: disabled')
  assert.equal(rows[0]?.disabled, true, 'the status row is a fact, never an operation')
  assert.equal(rows[1]?.id, 'web-details')
  assert.deepEqual(actionIds(h.pane).map(id => id.replace(/#.*$/u, '')), ['enable'])
  assert.deepEqual(h.actions, [], 'reading the status writes nothing')
})

test('the enabled state exposes Open Browser, Copy Link and Disable Web — and no writes before an action', async t => {
  const h = await mounted(t)
  const handle = h.open({ state: 'disabled' })
  await h.ready(handle, { state: 'enabled' })
  assert.equal(items(h.pane)[0]?.label, 'Status: enabled')
  assert.deepEqual(
    actionIds(h.pane).map(id => id.replace(/#.*$/u, '')),
    ['open-browser', 'copy-link', 'disable'],
  )
  assert.deepEqual(h.actions, [], 'painting the actions performs no write')
})

test('one native action forwards exactly the ONE command intent', async t => {
  const h = await mounted(t)
  const handle = h.open({ state: 'disabled' })
  await h.ready(handle, { state: 'enabled' })
  sendPickerAction(h.pane, 'copy-link', W)
  await waitUntil('copy-link forwarded', () => h.actions.length === 1)
  assert.deepEqual(h.actions, ['copy-link'])
  sendPickerAction(h.pane, 'disable', W)
  await waitUntil('disable forwarded', () => h.actions.length === 2)
  assert.deepEqual(h.actions, ['copy-link', 'disable'])
})

test('a stale action id from a previous frame is refused', async t => {
  const h = await mounted(t)
  const handle = h.open({ state: 'disabled' })
  await h.ready(handle, { state: 'disabled' })
  const stale = actionBase(h.pane, 'enable')
  assert.ok(stale !== undefined)
  // The command reprojects the menu: the new frame carries a NEW action token.
  handle.setStatus({ kind: 'status', status: { state: 'disabled' } })
  await waitUntil('web picker reprojected', () => actionBase(h.pane, 'enable') !== stale)
  const fresh = actionBase(h.pane, 'enable')
  assert.ok(fresh !== undefined)
  assert.notEqual(stale, fresh, 'the action token is frame-scoped')
  sendAction(h.pane, stale, undefined, picker(h.pane)!.id)
  sendPickerAction(h.pane, 'enable', W)
  // The CURRENT frame's action is the positive control: exactly ONE intent
  // reached the command, so the stale id was refused.
  await waitUntil('current web action forwarded', () => h.actions.length === 1)
  assert.deepEqual(h.actions, ['enable'], 'an action from a retired frame never reaches the command')
})

test('a changing host offers only the dismissal', async t => {
  const h = await mounted(t)
  const handle = h.open({ state: 'disabled' })
  await h.ready(handle, { state: 'changing' })
  assert.equal(items(h.pane)[0]?.label, 'Status: changing')
  assert.deepEqual(actionIds(h.pane), ['close'], 'no concurrent write is offered while a mutation runs')
})

test('an unavailable host states the fact and offers only the dismissal', async t => {
  const h = await mounted(t)
  const handle = h.open({ state: 'disabled' })
  await h.ready(handle, { state: 'unavailable', reason: 'rows partially enabled' })
  assert.match(String(items(h.pane)[0]?.label), /Status: unavailable/u)
  assert.deepEqual(actionIds(h.pane), ['close'])
})

test('Details replaces the picker with the read-only Reading and Esc returns', async t => {
  const h = await mounted(t)
  const handle = h.open({ state: 'enabled' })
  await h.ready(handle, { state: 'enabled' })
  // Select the Details row (a plain pointer select is browse only) and activate it.
  sendSelect(h.pane, 'web-details', picker(h.pane)!.id)
  await waitUntil('details row highlighted', () => props(h.pane).selected === 'web-details')
  assert.deepEqual(h.actions, [], 'browsing writes nothing')
  sendActivate(h.pane, 'web-details', picker(h.pane)!.id)
  await waitUntil('web details reading', () => layerText(h.pane).includes('Back to Web'))
  assert.equal(pickerNode(h.pane, W), undefined, 'the Reading REPLACES the picker (never stacks)')
  const text = layerText(h.pane)
  assert.match(text, /127\.0\.0\.1/u, 'the Host fact is stated')
  assert.match(text, /The Auto-start preference applies on the next Host launch/u)
  assert.match(text, /Opens the Web home page; choose a session there/u)
  assert.doesNotMatch(text, /token=|SECRET/u, 'no launch URL/token enters the Reading')
  assert.deepEqual(h.actions, [], 'opening the Reading writes nothing')

  // Esc: back to the menu, not closed.
  h.pane.key('\u001b')
  await waitUntil('web picker back', () => props(h.pane).title === 'Web frontend')
  assert.equal(layerText(h.pane).includes('Back to Web'), false)
  // Esc again: the picker closes with no write.
  h.pane.key('\u001b')
  await waitUntil('web picker closed', () => pickerNode(h.pane, W) === undefined)
  assert.equal(pickerNode(h.pane, W), undefined, 'the second Esc closes the picker')
  assert.deepEqual(h.actions, [])
})

test('the Back navigation row is equivalent to Esc', async t => {
  const h = await mounted(t)
  const handle = h.open({ state: 'enabled' })
  await h.ready(handle, { state: 'enabled' })
  sendActivate(h.pane, 'web-details', picker(h.pane)!.id)
  await waitUntil('web details reading', () => layerText(h.pane).includes('Back to Web'))
  clickLayerNode(h.pane, 'web-details-back', W)
  await waitUntil('web picker back', () => props(h.pane).title === 'Web frontend')
  assert.deepEqual(h.actions, [], 'the Back row is navigation, never a write')
})

test('a narrow pane keeps the fact, the Details row and every native action', async t => {
  const h = await mounted(t)
  const handle = h.open({ state: 'enabled' })
  await h.ready(handle, { state: 'enabled' })
  sendResize(h.pane, 40)
  await waitUntil('web picker resized', () => props(h.pane).selected === undefined || picker(h.pane) !== undefined)
  assert.equal(items(h.pane)[0]?.label, 'Status: enabled')
  assert.deepEqual(
    actionIds(h.pane).map(id => id.replace(/#.*$/u, '')),
    ['open-browser', 'copy-link', 'disable'],
    'a narrow split keeps every business action (no dropped "More" menu)',
  )
  assert.ok(picker(h.pane) !== undefined)
})

test('a revoked request closes the layer and refuses further events', async t => {
  const h = await mounted(t)
  const handle = h.open({ state: 'enabled' })
  await h.ready(handle, { state: 'enabled' })
  h.revoke()
  // The request re-check retires the panel: no key or pointer event can reach
  // the command afterwards, and the frame clears on this mount's next commit.
  h.pane.key('\u001b')
  // reason: a REFUSED event emits no frame, so this bounded window is the only
  // observation that the revoked request produced no command intent.
  await settle()
  sendPickerAction(h.pane, 'disable', W)
  // reason: the same bounded observation window as above — a refused event emits no frame.
  await settle()
  assert.deepEqual(h.actions, [], 'a superseded request never reaches a writer')
})

test('a settled action result is painted INSIDE the native picker', async t => {
  const h = await mounted(t)
  const handle = h.open({ state: 'enabled' })
  await h.ready(handle, { state: 'enabled' }, { message: 'Link copied', kind: 'info' })
  const rows = items(h.pane)
  const notice = rows.find(row => row.id === 'web-notice')
  assert.equal(notice?.label, 'Link copied', 'the copy result is a visible fact row')
  assert.equal(notice?.disabled, true, 'the result is never an operation')
  // A new admitted action clears the previous result line.
  handle.setPending('Disabling Web…')
  await waitUntil('web picker pending', () => props(h.pane).state === 'ready'
    && items(h.pane).every(row => row.id !== 'web-notice'))
  assert.equal(items(h.pane).some(row => row.id === 'web-notice'), false)
})
