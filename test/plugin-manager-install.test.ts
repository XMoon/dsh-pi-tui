/**
 * Install-lifecycle integration tests (P1-A3) over a fake Host: request-id
 * correlation of the official install events, unrelated events excluded, the
 * bounded presentation log, and the close→reopen invariant that must never
 * increment the `installBundle()` call count.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-install.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { PluginManagerController } from '../src/plugin-manager/controller.ts'
import { createDiag } from '../src/diag.ts'
import type {
  PluginChangeFact,
  PluginInstallEvent,
  PluginManagerPort,
  PluginManagerSnapshot,
} from '../src/runtime/plugin-manager-port.ts'

function emptySnapshot(): PluginManagerSnapshot {
  return {
    bundles: [],
    plugins: [],
    registries: { registry: null, fallbackRegistries: [], resolved: null },
    exemptions: [],
    exemptionWarnings: [],
  }
}

function change(overrides: Partial<PluginChangeFact> = {}): PluginChangeFact {
  return { changed: true, application: 'applied', stage: 'install', target: 'pkg', ...overrides }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

async function tick(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

function harness(): { controller: PluginManagerController; installCalls: unknown[]; emit: (event: PluginInstallEvent) => void; gate: ReturnType<typeof deferred<PluginChangeFact>> } {
  const listeners = new Set<(event: PluginInstallEvent) => void>()
  const installCalls: unknown[] = []
  const gate = deferred<PluginChangeFact>()
  const port: PluginManagerPort = {
    snapshot: async () => emptySnapshot(),
    inspect: async () => ({ status: 'accepted', kind: 'registry', name: 'pkg', version: '1', bundle: true, registry: null }),
    setBundleEnabled: async () => change({ stage: 'enable' }),
    setPluginEnabled: async () => change({ stage: 'enable' }),
    removeBundle: async () => change({ stage: 'remove' }),
    startInstall: async (request) => { installCalls.push(request); return gate.promise },
    waitForInstall: async () => null,
    cancelInstall: async () => ({ status: 'not-running' }),
    subscribeInstall: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  const controller = new PluginManagerController(port, {
    requestRender: () => {},
    requestClose: () => {},
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })
  return { controller, installCalls, emit: event => { for (const listener of listeners) listener(event) }, gate }
}

test('install events are correlated by request id and unrelated events are ignored', async () => {
  const { controller, installCalls, emit, gate } = harness()
  controller.openInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  const requestId = (installCalls[0] as { requestId: string }).requestId

  emit({ kind: 'phase', phase: { requestId: 'someone-else', phase: 'installing' } })
  assert.equal(controller.installView()?.phase, 'starting')

  emit({ kind: 'log', log: { requestId: 'someone-else', jobId: 'j', stream: 'stdout', text: 'foreign' } })
  assert.deepEqual([...controller.installView()!.log], [])

  emit({ kind: 'phase', phase: { requestId, phase: 'installing', attempt: { registry: 'https://r', index: 1, total: 2 } } })
  assert.equal(controller.installView()?.phase, 'installing')
  assert.match(controller.installView()?.message ?? '', /1\/2/)

  emit({ kind: 'log', log: { requestId, jobId: 'job-a', stream: 'stdout', text: 'line one\n' } })
  emit({ kind: 'log', log: { requestId, jobId: 'job-b', stream: 'stderr', text: 'line two' } })
  assert.deepEqual([...controller.installView()!.log], ['line one', '! line two'])

  gate.resolve(change({ application: 'restart-required' }))
  await tick()
  assert.equal(controller.installView()?.phase, 'done')
})

test('the presentation log is bounded', async () => {
  const { controller, installCalls, emit, gate } = harness()
  controller.openInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  const requestId = (installCalls[0] as { requestId: string }).requestId
  emit({ kind: 'phase', phase: { requestId, phase: 'installing' } })
  for (let i = 0; i < 200; i += 1) {
    emit({ kind: 'log', log: { requestId, jobId: 'j', stream: 'stdout', text: `line ${i}` } })
  }
  const log = controller.installView()!.log
  assert.ok(log.length <= 40, `bounded tail, got ${log.length}`)
  assert.equal(log[log.length - 1], 'line 199')
  gate.resolve(change())
  await tick()
})

test('close then reopen never dispatches a second installBundle call', async () => {
  const { controller, installCalls, gate } = harness()
  controller.openInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  assert.equal(installCalls.length, 1)
  controller.closeInstall()
  controller.openInstall()
  controller.closeInstall()
  controller.openInstall()
  await tick()
  assert.equal(installCalls.length, 1)
  assert.equal(controller.installView()?.requestId, (installCalls[0] as { requestId: string }).requestId)
  gate.resolve(change())
  await tick()
})
