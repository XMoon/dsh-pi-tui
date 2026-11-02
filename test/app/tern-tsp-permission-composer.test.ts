/**
 * TSP-7 PR-E: the Quiet Composer Permission menu end-to-end at the renderer
 * seam. Every case mounts the PRODUCTION `mountTspRenderer` over the scripted
 * Tern pane and reads the REAL reconciled wire nodes; the writer is a narrow
 * handler recorder, never a second StatusRuntime.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-permission-composer.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { connect } from '@stencil-hq/tern'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import { emptyStatusSnapshot, type StatusSnapshot, type StatusSnapshotReader } from '../../src/domain/status/types.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { settle, waitUntil } from '../support/tsp-runner-harness.ts'
import { wireNodes, type WireNode } from '../support/tsp-picker-wire.ts'

interface Calls {
  selects: string[]
  cancels: number
  modelEntries: string[]
  quickEntries: string[]
  permissionOptions: string[]
}
interface Mounted {
  readonly pane: TspPane
  readonly renderer: TspRenderer
  readonly calls: Calls
  commitStatus(snapshot: StatusSnapshot): Promise<void>
  dispose(): Promise<void>
}

function permissionSnapshot(id: string, label = id, matched = true): StatusSnapshot {
  const base = emptyStatusSnapshot()
  return { ...base, access: { permissionPreset: { id, label, matched } } } as StatusSnapshot
}

async function mountPermissionComposer(options: {
  readonly roster?: readonly string[]
  /** TSP-7 PR-G: advertise the kinds the composer's combined Model·Effort
   *  quick menu needs, so the two composer menus can be exercised together. */
  readonly modelQuick?: boolean
} = {}): Promise<Mounted> {
  const pane = installTspPane({
    composerActions: true,
    ...(options.modelQuick === true ? { modelPicker: true, modelQuick: true } : {}),
  })
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session)
  const renderer = mountTspRenderer(session, {
    copyVisual: async () => false,
    requestExit() {},
    onFatal: (error) => assert.fail(String(error)),
  })
  const calls: Calls = {
    selects: [],
    cancels: 0,
    modelEntries: [],
    quickEntries: [],
    permissionOptions: [],
  }
  const roster = options.roster ?? ['read-only', 'workspace-write', 'danger-full-access']
  renderer.bindInput({
    exit() {},
    cancel: () => { calls.cancels += 1 },
    submit() {},
    steer() {},
    pasteMedia() {},
    noteUserInput() {},
    listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false,
    openModelPicker: entry => { calls.modelEntries.push(entry) },
    openModelQuick: () => { calls.quickEntries.push('quick') },
    permissionOptions: () => { calls.permissionOptions.push('read'); return roster },
    selectPermission: id => { calls.selects.push(id) },
  })
  let current = permissionSnapshot('workspace-write', 'Workspace Write')
  const reader: StatusSnapshotReader = { snapshot: () => current }
  renderer.bindStatusReader(reader)
  const mounted: Mounted = {
    pane,
    renderer,
    calls,
    async commitStatus(snapshot) {
      const before = pane.frameCount()
      current = snapshot
      renderer.display.commitDisplaySubject({}, {}, undefined)
      await waitUntil('the status committed', () => pane.frameCount() > before)
      await settle(80)
    },
    dispose: () => renderer.dispose(),
  }
  await mounted.commitStatus(current)
  return mounted
}

function buttonsOfKind(pane: TspPane, fragment: string): WireNode[] {
  return wireNodes(pane).filter(node => node.k === 'el' && String(node.id).includes(fragment))
}

function permissionTrigger(pane: TspPane): WireNode {
  const node = buttonsOfKind(pane, '.composer-permission-s').find(candidate => !String(candidate.id).includes('option'))
  assert.ok(node, 'the permission trigger is on the wire')
  return node
}

function permissionOptions(pane: TspPane, epoch?: number): WireNode[] {
  return buttonsOfKind(pane, '.composer-permission-option-')
    .filter(node => epoch === undefined || String(node.id).includes(`-${epoch}-`))
}

function click(pane: TspPane, node: WireNode): void {
  pane.event({ ev: 'action', sf: pane.frames().at(-1)!.sf, id: node.id, act: 'click' })
}

function textOf(pane: TspPane, node: WireNode | undefined): string {
  if (node === undefined) return ''
  const nodes = wireNodes(pane)
  const live = nodes.find(candidate => candidate.id === node.id) ?? node
  const text = live.p['text']
  if (typeof text === 'string') return text
  return (live.c ?? []).map(child => {
    const liveChild = nodes.find(candidate => candidate.id === child.id) ?? child
    return String(liveChild.p['text'] ?? '')
  }).join('')
}

test('permission menu: the trigger reads the committed label and the menu offers the three standard presets in order', async (t) => {
  const m = await mountPermissionComposer()
  t.after(() => { void m.dispose() })
  const { pane } = m
  assert.ok(textOf(pane, permissionTrigger(pane)).includes('Workspace Write'), textOf(pane, permissionTrigger(pane)))
  click(pane, permissionTrigger(pane))
  await settle(80)
  const options = permissionOptions(pane)
  assert.deepEqual(options.map(node => textOf(pane, node)), ['Read Only', 'Workspace Write ✓', 'Full Access'], 'the fixed three-row order with the current preselected')
  const current = options.filter(node => (node.p['attrs'] as Record<string, unknown> | undefined)?.['data-current'] === 'true')
  assert.equal(current.length, 1)
  assert.equal(textOf(pane, current[0]), 'Workspace Write ✓')
  const highlighted = options.filter(node => (node.p['attrs'] as Record<string, unknown> | undefined)?.['data-highlight'] === 'true')
  assert.equal(highlighted.length, 1)
  assert.equal(textOf(pane, highlighted[0]), 'Workspace Write ✓',
    'the keyboard highlight starts on the current preset and is a separate visual layer from the ✓')
  // Selecting the already-current preset closes the menu and never writes.
  click(pane, current[0]!)
  await settle(80)
  assert.deepEqual(m.calls.selects, [])
  assert.equal(permissionOptions(pane).length, 0)
})

test('the default footer yields its permission placement to the Quiet Composer control', async (t) => {
  const m = await mountPermissionComposer()
  t.after(() => { void m.dispose() })
  const { pane } = m
  const segKeys = wireNodes(pane).filter(node => node.k === 'seg').map(node => String(node.p['key'] ?? ''))
  assert.ok(!segKeys.includes('status-r1-permission'),
    'the capable Quiet Composer permission control replaces the footer placement by the PR-F default')
})

test('permission select: another preset closes first, dispatches exactly once, and never optimistically rewrites the label', async (t) => {
  const m = await mountPermissionComposer()
  t.after(() => { void m.dispose() })
  const { pane } = m
  click(pane, permissionTrigger(pane))
  await settle(80)
  const full = permissionOptions(pane).find(node => textOf(pane, node).startsWith('Full Access'))
  assert.ok(full)
  click(pane, full!)
  await waitUntil('one permission select', () => m.calls.selects.length === 1)
  assert.deepEqual(m.calls.selects, ['danger-full-access'], 'the exact catalog id is dispatched, never the GUI label')
  await settle(80)
  assert.equal(permissionOptions(pane).length, 0, 'the menu closed before the writer call')
  assert.ok(textOf(pane, permissionTrigger(pane)).includes('Workspace Write'), 'the trigger still shows the committed projection')
})

test('permission menu: only catalog-present standard presets render; an empty roster paints a read-only trigger', async (t) => {
  const m = await mountPermissionComposer({ roster: ['read-only', 'danger-full-access'] })
  t.after(() => { void m.dispose() })
  const { pane } = m
  click(pane, permissionTrigger(pane))
  await settle(80)
  assert.deepEqual(permissionOptions(pane).map(node => textOf(pane, node)), ['Read Only', 'Full Access'], 'absent catalog ids are never fabricated')
  click(pane, permissionTrigger(pane))
  await settle(60)

  const empty = await mountPermissionComposer({ roster: [] })
  t.after(() => { void empty.dispose() })
  const emptyTrigger = permissionTrigger(empty.pane)
  assert.equal((emptyTrigger.p['attrs'] as Record<string, unknown> | undefined)?.['aria-disabled'], 'true',
    'no catalog options => the trigger is the documented read-only state')
  click(empty.pane, emptyTrigger)
  await settle(80)
  assert.equal(permissionOptions(empty.pane).length, 0, 'an empty catalog never opens an active menu')
  assert.deepEqual(empty.calls.selects, [])
})

test('permission menu: an old expansion identity can never dispatch after close/reopen', async (t) => {
  const m = await mountPermissionComposer()
  t.after(() => { void m.dispose() })
  const { pane } = m
  click(pane, permissionTrigger(pane))
  await settle(80)
  const oldOption = permissionOptions(pane).find(node => textOf(pane, node).startsWith('Full Access'))
  assert.ok(oldOption)
  click(pane, permissionTrigger(pane)) // close
  await settle(60)
  click(pane, permissionTrigger(pane)) // reopen => a NEW menuEpoch
  await settle(80)
  assert.equal(permissionOptions(pane).length, 3)
  click(pane, oldOption!) // a stale node id from the previous expansion
  await settle(80)
  assert.deepEqual(m.calls.selects, [], 'the old expansion id cannot dispatch a write')
  assert.equal(permissionOptions(pane).length, 3, 'the current menu stays open')
})

test('permission menu: hydration closes it, and a stale option then cannot act', async (t) => {
  const m = await mountPermissionComposer()
  t.after(() => { void m.dispose() })
  const { pane } = m
  click(pane, permissionTrigger(pane))
  await settle(80)
  const staleOption = permissionOptions(pane).find(node => textOf(pane, node).startsWith('Read Only'))
  assert.ok(staleOption)
  m.renderer.display.beginSessionHydration()
  await settle(80)
  assert.equal(permissionOptions(pane).length, 0, 'the outgoing subject closes its menu')
  click(pane, staleOption!)
  await settle(80)
  assert.deepEqual(m.calls.selects, [])
})

test('permission menu keyboard: Esc closes only the menu; Down+Enter chooses; Ctrl+C stays the cancel owner', async (t) => {
  const m = await mountPermissionComposer()
  t.after(() => { void m.dispose() })
  const { pane } = m
  click(pane, permissionTrigger(pane))
  await settle(80)
  pane.key('\u001b') // Esc
  await settle(80)
  assert.equal(permissionOptions(pane).length, 0, 'Esc closes the menu')
  assert.equal(m.calls.cancels, 0, 'Esc never cancels the agent while the menu was open')

  click(pane, permissionTrigger(pane))
  await settle(80)
  pane.key('\u001b[B') // Down: the highlight starts on the current preset; move to Full Access
  await settle(80)
  const afterDown = permissionOptions(pane)
  const highlightedAfterDown = afterDown.filter(node => (node.p['attrs'] as Record<string, unknown> | undefined)?.['data-highlight'] === 'true')
  assert.equal(highlightedAfterDown.length, 1)
  assert.equal(textOf(pane, highlightedAfterDown[0]), 'Full Access',
    'Down moves the visible keyboard highlight to Full Access')
  assert.ok(afterDown.some(node => (node.p['attrs'] as Record<string, unknown> | undefined)?.['data-current'] === 'true'
    && textOf(pane, node) === 'Workspace Write ✓'), 'the committed current ✓ stays independent')
  pane.key('\r')
  await waitUntil('Down+Enter chooses the next standard preset', () => m.calls.selects.length === 1)
  assert.deepEqual(m.calls.selects, ['danger-full-access'])
  assert.equal(m.calls.cancels, 0, 'Enter never cancels')

  click(pane, permissionTrigger(pane))
  await settle(80)
  pane.key('\u0003') // Ctrl+C
  await settle(80)
  assert.equal(permissionOptions(pane).length, 0, 'Ctrl+C closes the local menu')
  assert.equal(m.calls.cancels, 1, 'Ctrl+C still reaches the original cancel owner')
})

test('permission menu: a disposed renderer never dispatches a late option click', async (t) => {
  const m = await mountPermissionComposer()
  const { pane } = m
  click(pane, permissionTrigger(pane))
  await settle(80)
  const option = permissionOptions(pane).find(node => textOf(pane, node).startsWith('Full Access'))
  assert.ok(option)
  await m.dispose()
  pane.event({ ev: 'action', sf: pane.frames().at(-1)!.sf, id: option!.id, act: 'click' })
  await settle(80)
  assert.deepEqual(m.calls.selects, [])
})

// TSP-7 PR-G: the two composer menus are mutually exclusive, and the quick
// menu's keys never leak into the Permission menu's keyboard route.
test('permission menu and the model quick menu are never both expanded', async (t) => {
  const m = await mountPermissionComposer({ modelQuick: true })
  t.after(() => { void m.dispose() })
  const { pane, calls } = m

  // Open the model quick menu through the renderer's own presentation seam —
  // the same call the registered `/model` command makes for a live subject.
  const presentation = m.renderer.modelPresentation
  assert.ok(presentation?.openQuick, 'the pane negotiated the quick presentation')
  presentation!.openQuick!({
    subject: { sessionless: false },
    entry: 'models',
    isCurrent: () => true,
    retry() {},
    apply: () => 'committed',
    runOwned: (_label, task, ownedOptions) => {
      void Promise.resolve().then(task).then(ownedOptions.onResult, ownedOptions.onError)
    },
  })
  await waitUntil('the quick menu mounted', () => buttonsOfKind(pane, '.composer-quick-menu').length > 0)
  // Opening Permission revokes it in the same synchronous step.
  click(pane, permissionTrigger(pane))
  await waitUntil('the permission menu opened', () => permissionOptions(pane).length === 3)
  assert.equal(buttonsOfKind(pane, '.composer-quick-menu').length, 0,
    'the quick menu is retired before the permission frame paints')
  // Escape closes only the open Permission menu; the Agent is never cancelled.
  pane.key('\u001b')
  await settle(80)
  assert.equal(permissionOptions(pane).length, 0, 'the permission menu closed')
  assert.equal(m.calls.cancels, 0, 'closing a composer menu is never an Agent cancel')
  // Ctrl+C still reaches its original owner exactly once.
  pane.key('\u0003')
  await settle(80)
  assert.equal(m.calls.cancels, 1, 'Ctrl+C reached the cancel owner')
  assert.deepEqual(calls.selects, [], 'no permission write was dispatched by the menu keys')
})
