/**
 * Headless tests for the StatusStore (plan §12.3): synchronous snapshots,
 * section-level patch merging, same-value no-notify discipline, revision
 * monotonicity, and listener error isolation.
 * @module @xmoon76/dsh-pi-tui/status-store.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { StatusStore } from '../src/status/store.ts'
import { emptyStatusSnapshot, type StatusSnapshot } from '../src/status/types.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/process-tui-slot.ts). */
interface DisposableApp { isDisposed(): boolean; dispose(): void }
const startedApps = new Set<DisposableApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function snapshotWith(overrides: Partial<StatusSnapshot>): StatusSnapshot {
  return { ...emptyStatusSnapshot(), ...overrides }
}

test('store starts from the empty snapshot and reports revision 0', () => {
  const store = new StatusStore()
  assert.equal(store.revision(), 0)
  assert.deepEqual(store.snapshot(), emptyStatusSnapshot())
})

test('update merges sections and keeps untouched sections by identity', () => {
  const store = new StatusStore()
  const workspace = { cwd: '/a/b', branch: 'main' }
  store.update({ workspace })
  const first = store.snapshot()
  assert.equal(first.workspace, workspace)
  assert.equal(store.revision(), 1)
  // A second update touching a DIFFERENT section keeps the workspace
  // reference (the footer cache can rely on section identity).
  store.update({ interaction: { focusMode: true } })
  const second = store.snapshot()
  assert.equal(second.workspace, workspace)
  assert.equal(second.interaction.focusMode, true)
  assert.equal(store.revision(), 2)
})

test('same-value updates do not notify (no render storm)', () => {
  const store = new StatusStore()
  let notified = 0
  store.subscribe(() => { notified += 1 })
  const workspace = { cwd: '/a/b' }
  store.update({ workspace })
  assert.equal(notified, 1)
  // Same section object again: no change.
  store.update({ workspace })
  assert.equal(notified, 1)
  // A NEW object with equal CONTENT is also no change: the runner's
  // derives and the app's projections mint fresh objects on every call,
  // so an identical refresh must never churn the revision nor wake
  // listeners/command refreshes (structural no-notify contract).
  store.update({ workspace: { cwd: '/a/b' } })
  assert.equal(notified, 1)
  assert.equal(store.revision(), 1)
  // A genuinely different value IS a change.
  store.update({ workspace: { cwd: '/x' } })
  assert.equal(notified, 2)
  assert.equal(store.revision(), 2)
})

test('replace swaps the whole snapshot and notifies once', () => {
  const store = new StatusStore()
  let notified = 0
  store.subscribe(() => { notified += 1 })
  const next = snapshotWith({ interaction: { focusMode: true } })
  store.replace(next)
  assert.equal(store.snapshot(), next)
  assert.equal(notified, 1)
})

test('subscribe returns a disposer; a throwing listener is isolated', () => {
  const store = new StatusStore()
  const seen: number[] = []
  const boom = (): void => { throw new Error('listener boom') }
  store.subscribe(boom)
  store.subscribe(() => { seen.push(store.revision()) })
  store.update({ interaction: { focusMode: true } })
  assert.deepEqual(seen, [1])
  const dispose = store.subscribe(() => { seen.push(99) })
  dispose()
  store.update({ interaction: { focusMode: false } })
  assert.deepEqual(seen, [1, 2])
})

test('undefined patch values are skipped', () => {
  const store = new StatusStore()
  store.update({ workspace: undefined, interaction: { focusMode: true } })
  assert.equal(store.snapshot().interaction.focusMode, true)
  assert.equal(store.revision(), 1)
})

test('replace with an identical snapshot does not notify (same identity discipline as update)', () => {
  const store = new StatusStore()
  let notified = 0
  store.subscribe(() => { notified += 1 })
  const next = snapshotWith({ interaction: { focusMode: true } })
  store.replace(next)
  assert.equal(notified, 1)
  // The SAME snapshot object again: no change.
  store.replace(next)
  assert.equal(notified, 1)
  // A NEW object with a changed section notifies.
  store.replace(snapshotWith({ interaction: { focusMode: false } }))
  assert.equal(notified, 2)
})

test('the TuiApp setStatus projection MERGES into the current sections (runner-derived facts survive)', async () => {
  // Drive the projection through the app's setStatus: the legacy fields
  // only own model/permission/cwd/branch — the runner-derived facts must
  // survive a legacy update.
  const { TuiApp } = await import('../src/tui-app.ts')
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  // Seed the store with runner-derived facts (what refreshStatus projects).
  app.getFooterItemRegistry() // touch nothing
  const store = (app as unknown as { statusStore: StatusStore }).statusStore
  store.update({
    composition: {
      agentPreset: { id: 'code', label: 'PTC mode' },
      model: { provider: 'deepseek', id: 'flash', displayName: 'flash' },
    },
    access: {
      permissionPreset: { id: 'workspace-write', label: 'workspace-write', matched: true },
      sandbox: { mode: 'workspace-write' },
      approval: { policy: 'ask' },
    },
    workspace: { cwd: '/home/x/space4', project: 'space4', branch: 'main' },
  })
  // A legacy setStatus update arrives (the runner's setStatus call — the
  // legacy cwd is the SHORT form; the derived project is consistent).
  app.setStatus({ model: 'deepseek/flash', cwd: '/home/x/space4', branch: 'main' })
  const snapshot = store.snapshot()
  assert.deepEqual(snapshot.composition.agentPreset, { id: 'code', label: 'PTC mode' }, 'agentPreset must survive')
  assert.equal(snapshot.access.sandbox?.mode, 'workspace-write', 'sandbox must survive')
  assert.equal(snapshot.access.approval?.policy, 'ask', 'approval must survive')
  assert.equal(snapshot.workspace.project, 'space4', 'workspace project must survive')
  app.stop()
})

test('setStatus clears stale owned facts: a gone model, a changed cwd re-derives project, an emptied branch clears', async () => {
  const { TuiApp } = await import('../src/tui-app.ts')
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const store = (app as unknown as { statusStore: StatusStore }).statusStore
  app.setStatus({ model: 'deepseek/flash', cwd: '/a/b', branch: 'main' })
  // The model disappears (the legacy label becomes the empty/'no model'
  // placeholder): the old model must be CLEARED, not kept.
  app.setStatus({ model: '', cwd: '/a/b', branch: 'main' })
  assert.equal(store.snapshot().composition.model, undefined, 'a gone model must be cleared')
  // The cwd changes: the derived project follows the new cwd.
  app.setStatus({ model: 'm', cwd: '/x/y/z', branch: 'main' })
  assert.equal(store.snapshot().workspace.project, 'z', 'the project must follow the cwd')
  // The branch empties: the old branch must be cleared.
  app.setStatus({ model: 'm', cwd: '/x/y/z', branch: '' })
  assert.equal(store.snapshot().workspace.branch, undefined, 'an emptied branch must be cleared')
  // A permission set then cleared: the old preset must be cleared (the
  // owned-fields contract — a disappearing permission must not leave a
  // stale [yolo]/[workspace-write] badge behind).
  app.setStatus({ model: 'm', cwd: '/x/y/z', permission: 'danger-full-access' })
  assert.equal(store.snapshot().access.permissionPreset?.id, 'danger-full-access')
  app.setStatus({ model: 'm', cwd: '/x/y/z', permission: undefined })
  assert.equal(store.snapshot().access.permissionPreset, undefined, 'a gone permission must be cleared')
  app.stop()
})

test('a same-value setStatus does not bump the store revision', async () => {
  const { TuiApp } = await import('../src/tui-app.ts')
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const store = (app as unknown as { statusStore: StatusStore }).statusStore
  app.setStatus({ model: 'deepseek/flash', cwd: '/a/b', branch: 'main', turns: 1, steps: 2 })
  const revision = store.revision()
  // The SAME values again: no section content changed — no revision bump.
  app.setStatus({ model: 'deepseek/flash', cwd: '/a/b', branch: 'main', turns: 1, steps: 2 })
  assert.equal(store.revision(), revision, 'a same-value setStatus must not bump the revision')
  app.stop()
})

test('deriveRunnerPermission degrades when the permission service throws', async () => {
  const { deriveRunnerPermission } = await import('../src/status/derive-permission.ts')
  const agent = { session: { events: [] } }
  const exploding = { current: () => { throw new Error('boom') } }
  assert.equal(deriveRunnerPermission(exploding, agent as never), undefined,
    'a throwing permission service must degrade to the clear signal, never throw')
})
