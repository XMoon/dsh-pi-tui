/**
 * Install-lifecycle integration tests (P1-A3) over a fake Host: request-id
 * correlation of the official install events, unrelated events excluded, the
 * bounded presentation log, and the close→reopen invariant that must never
 * increment the `installBundle()` call count.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-install.test
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { symbols } from '@deepseek-ai/cordis'
import { parse as parseYaml } from 'yaml'
import { PluginManagerController } from '../src/app/plugin-manager/controller.ts'
import { PluginManagerWorkspacePanel } from '../src/tui/plugin-manager/workspace.ts'
import { DirectPluginManagerPort } from '../src/runtime/direct/plugin-manager-direct.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
import type {
  PluginChangeFact,
  PluginInstallEvent,
  PluginManagerPort,
  PluginManagerSnapshot,
} from '../src/runtime/plugin-manager-port.ts'
import { startLocalNpmRegistry, packFixturePackage } from './support/local-npm-registry.ts'
import { createRemoteApplicationHostFixture } from './support/remote-application-fixture.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

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
    subscribeInvalidation: () => () => {},
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

function installPage(controller: PluginManagerController): PluginManagerWorkspacePanel {
  return new PluginManagerWorkspacePanel(controller, {
    rows: () => 40,
    columns: () => 120,
    requestRender: () => {},
    notice: () => undefined,
    onCopy: () => {},
  })
}

test('install events are correlated by request id and unrelated events are ignored', async () => {
  const { controller, installCalls, emit, gate } = harness()
  controller.beginManualInstall()
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
  controller.beginManualInstall()
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
  controller.beginManualInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  assert.equal(installCalls.length, 1)
  controller.hideInstall()
  controller.beginManualInstall()
  controller.hideInstall()
  controller.beginManualInstall()
  await tick()
  assert.equal(installCalls.length, 1)
  assert.equal(controller.installView()?.requestId, (installCalls[0] as { requestId: string }).requestId)
  gate.resolve(change())
  await tick()
})

// ── interrupted-operation recovery (rc.2 P1-B, plan §14) ────────────────────

/** One install lifecycle over a scripted dispatch/recovery Host. */
function recoveryHarness(options: {
  startInstall: () => Promise<PluginChangeFact>
  waitForInstall?: (requestId: string) => Promise<PluginChangeFact | null>
}): {
  controller: PluginManagerController
  installCalls: unknown[]
  waitCalls: string[]
  cancelCalls: string[]
  counters: { snapshotCalls: number }
} {
  const installCalls: unknown[] = []
  const waitCalls: string[] = []
  const cancelCalls: string[] = []
  const counters = { snapshotCalls: 0 }
  const port: PluginManagerPort = {
    snapshot: async () => { counters.snapshotCalls += 1; return emptySnapshot() },
    inspect: async () => ({ status: 'accepted', kind: 'registry', name: 'pkg', version: '1', bundle: true, registry: null }),
    setBundleEnabled: async () => change({ stage: 'enable' }),
    setPluginEnabled: async () => change({ stage: 'enable' }),
    removeBundle: async () => change({ stage: 'remove' }),
    startInstall: async (request) => { installCalls.push(request); return options.startInstall() },
    waitForInstall: async (requestId) => {
      waitCalls.push(String(requestId))
      return options.waitForInstall === undefined ? null : options.waitForInstall(String(requestId))
    },
    cancelInstall: async (requestId) => { cancelCalls.push(String(requestId)); return { status: 'cancelled' } },
    subscribeInstall: () => () => {},
    subscribeInvalidation: () => () => {},
  }
  const controller = new PluginManagerController(port, {
    requestRender: () => {},
    requestClose: () => {},
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })
  return { controller, installCalls, waitCalls, cancelCalls, counters }
}

test('an interrupted install recovers through the official waitForInstall and never re-dispatches', async () => {
  const harness = recoveryHarness({
    startInstall: async () => { throw new Error('carrier lost') },
    waitForInstall: async () => change({ application: 'restart-required' }),
  })
  harness.controller.beginManualInstall()
  harness.controller.inspect('pkg', null)
  await tick()
  harness.controller.confirmInstall()
  await tick()
  assert.equal(harness.installCalls.length, 1, 'exactly one startInstall for one request id')
  assert.equal(harness.waitCalls.length, 1, 'the indeterminate dispatch recovers through the official waitForInstall')
  const view = harness.controller.installView()
  assert.equal(view?.phase, 'done')
  assert.equal(view?.outcome?.application, 'restart-required', 'the recovered official outcome is presented')
})

test('an interrupted install with no recoverable run reports unknown, refreshes inventory, and never retries', async () => {
  const harness = recoveryHarness({
    startInstall: async () => { throw new Error('carrier lost') },
    waitForInstall: async () => null,
  })
  harness.controller.beginManualInstall()
  harness.controller.inspect('pkg', null)
  await tick()
  harness.controller.confirmInstall()
  await tick()
  assert.equal(harness.installCalls.length, 1, 'recovery must never auto-retry installBundle')
  assert.equal(harness.waitCalls.length, 1)
  const view = harness.controller.installView()
  assert.equal(view?.phase, 'unknown')
  assert.match(view?.message ?? '', /not retried automatically/)
  assert.ok(harness.counters.snapshotCalls >= 1, 'the inventory is re-read authoritatively')
})

test('cancel delegates to the official cancelInstall for the active request id', async () => {
  const gate = deferred<PluginChangeFact>()
  const harness = recoveryHarness({ startInstall: () => gate.promise })
  harness.controller.beginManualInstall()
  harness.controller.inspect('pkg', null)
  await tick()
  harness.controller.confirmInstall()
  await tick()
  const requestId = String((harness.installCalls[0] as { requestId: unknown }).requestId)
  harness.controller.cancelInstall()
  await tick()
  assert.deepEqual(harness.cancelCalls, [requestId], 'cancel forwards the exact active request id')
  assert.equal(harness.controller.installView()?.phase, 'done')
  gate.resolve(change())
  await tick()
})

test('a whole-panel teardown then reopen preserves the in-flight install and never re-dispatches', async () => {
  const gate = deferred<PluginChangeFact>()
  const harness = recoveryHarness({ startInstall: () => gate.promise })
  // The first surface: open the install dialog, inspect and dispatch.
  const firstPanel = new PluginManagerWorkspacePanel(harness.controller, { rows: () => 24, columns: () => 80, requestRender: () => {}, notice: () => undefined, onCopy: () => {} }, {})
  harness.controller.beginManualInstall()
  harness.controller.inspect('pkg', null)
  await tick()
  harness.controller.confirmInstall()
  await tick()
  const requestId = String((harness.installCalls[0] as { requestId: unknown }).requestId)
  assert.equal(harness.controller.installView()?.phase, 'starting', 'the dispatch is in flight')

  // The WHOLE panel surface is torn down (e.g. the Settings parent overlay is
  // hidden): the panel releases its owner exactly once while the controller —
  // and therefore the official operation — survives.
  const released: number[] = []
  const ownedPanel = new PluginManagerWorkspacePanel(harness.controller, { rows: () => 24, columns: () => 80, requestRender: () => {}, notice: () => undefined, onCopy: () => {} }, { onDispose: () => released.push(1) })
  firstPanel.dispose()
  ownedPanel.dispose()
  assert.deepEqual(released, [1], 'the panel teardown releases its surface owner exactly once')

  // Reopen the surface through the panel-open entry: a NEW panel over the SAME
  // controller resumes the dispatched install with the same request id.
  harness.controller.open('direct-command')
  const reopened = new PluginManagerWorkspacePanel(harness.controller, { rows: () => 24, columns: () => 80, requestRender: () => {}, notice: () => undefined, onCopy: () => {} }, {})
  await tick()
  assert.equal(harness.installCalls.length, 1, 'reopening the surface must not dispatch a second installBundle')
  assert.equal(harness.controller.installView()?.requestId, requestId, 'the same request id is preserved')
  assert.equal(harness.controller.installView()?.phase, 'starting',
    'a dispatched install reopens as the same install view, never a fresh dialog')
  assert.ok(reopened.render(60).length > 0, 'the reopened panel renders the resumed install view')
  reopened.dispose()
  gate.resolve(change())
  await tick()
})

test('a settled install triggers an authoritative inventory refresh', async () => {
  const harness = recoveryHarness({ startInstall: async () => change() })
  harness.controller.beginManualInstall()
  harness.controller.inspect('pkg', null)
  await tick()
  const before = harness.counters.snapshotCalls
  harness.controller.confirmInstall()
  await tick()
  assert.ok(harness.counters.snapshotCalls > before, 'settlement re-reads the official inventory')
})

test('install inspection metadata and progress rows fold hostile values onto ONE physical row', async () => {
  const hostile = 'First\nSecond\r\nThird\tTabbed\u001b]52;c;YXR0YWNr\u0007tail'
  const collapsed = 'First Second Third   Tabbedtail'
  const listeners = new Set<(event: PluginInstallEvent) => void>()
  const installCalls: unknown[] = []
  const gate = deferred<PluginChangeFact>()
  const port: PluginManagerPort = {
    snapshot: async () => emptySnapshot(),
    inspect: async () => ({
      status: 'accepted',
      kind: hostile,
      name: hostile,
      version: hostile,
      description: hostile,
      bundle: true,
      registry: hostile,
      host: hostile,
    }),
    setBundleEnabled: async () => change({ stage: 'enable' }),
    setPluginEnabled: async () => change({ stage: 'enable' }),
    removeBundle: async () => change({ stage: 'remove' }),
    startInstall: async (request) => { installCalls.push(request); return gate.promise },
    waitForInstall: async () => null,
    cancelInstall: async () => ({ status: 'not-running' }),
    subscribeInstall: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    subscribeInvalidation: () => () => {},
  }
  const controller = new PluginManagerController(port, {
    requestRender: () => {},
    requestClose: () => {},
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })
  const panel = new PluginManagerWorkspacePanel(controller, {
    rows: () => 40,
    columns: () => 160,
    requestRender: () => {},
    notice: () => undefined,
    onCopy: () => {},
  })
  const assertPhysicalRows = (rendered: readonly string[], where: string): string => {
    const text = rendered.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
    for (const line of rendered) {
      assert.ok(!line.includes('\n') && !line.includes('\r'),
        `${where}: a rendered row carries an embedded line break: ${JSON.stringify(line)}`)
      assert.ok(!line.includes('YXR0YWNr'), `${where}: the OSC payload reaches a row`)
      assert.ok(!line.includes('\u001b]52') && !line.includes('\u009b'), `${where}: a raw control introducer reaches a row`)
    }
    return text
  }

  panel.handleInput('i')
  controller.inspect('pkg', null)
  await tick()
  assert.equal(controller.installView()?.phase, 'confirm')
  const confirmText = assertPhysicalRows(panel.render(160), 'confirm')
  assert.ok(confirmText.includes(collapsed), `the collapsed inspection metadata survives:\n${confirmText}`)

  controller.confirmInstall()
  await tick()
  const requestId = String((installCalls[0] as { requestId: unknown }).requestId)
  const emit = (event: PluginInstallEvent): void => { for (const listener of listeners) listener(event) }
  emit({ kind: 'phase', phase: { requestId, phase: 'installing', attempt: { registry: hostile, index: 1, total: 2 } } })
  emit({ kind: 'log', log: { requestId, jobId: 'j', stream: 'stdout', text: `progress\r\n\t${hostile}` } })
  const runningText = assertPhysicalRows(panel.render(160), 'running')
  // The phase message carries the attempt registry on ONE row; the log is
  // line-oriented (the controller splits LF), so its own hostile TAB/OSC/C1
  // element must also stay on one row.
  assert.ok(runningText.includes(`installing from ${collapsed} (1/2)`),
    `the collapsed progress message survives:\n${runningText}`)
  assert.ok(runningText.includes('Third   Tabbedtail'), `the collapsed log row survives:\n${runningText}`)

  gate.resolve(change())
  await tick()
  panel.dispose()
})


test('a failed install reopens with the same request id and New install is explicit', async () => {
  const { controller, installCalls, gate } = harness()
  controller.beginManualInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  const requestId = (installCalls[0] as { requestId: string }).requestId
  gate.resolve(change({ application: 'failed', pendingBuilds: ['evil-pkg'] }))
  await tick()
  assert.equal(controller.installView()?.phase, 'failed')
  assert.equal(controller.installView()?.requestId, requestId)

  const page = installPage(controller)
  assert.equal(page.currentView(), 'install', 'a new page restores the failed attempt')
  const failedFrame = page.render(120).join('\n')
  assert.match(failedFrame, /Approve and retry evil-pkg/)
  assert.match(failedFrame, /New install/, 'the explicit new-install action is visible')

  const short = new PluginManagerWorkspacePanel(controller, {
    rows: () => 10,
    columns: () => 80,
    requestRender: () => {},
    notice: () => undefined,
    onCopy: () => {},
  })
  const shortFrame = short.render(80).join('\n')
  assert.match(shortFrame, /Build scripts blocked/, 'the risk names remain visible at 80x10')
  assert.doesNotMatch(shortFrame, /Approve/, 'approval is not offered when its risk cannot be fully shown')
  short.handleInput('\r')
  await tick()
  assert.equal(installCalls.length, 1, 'Enter on the short frame cannot approve a hidden risk')
  short.dispose()

  const tall = new PluginManagerWorkspacePanel(controller, {
    rows: () => 24,
    columns: () => 80,
    requestRender: () => {},
    notice: () => undefined,
    onCopy: () => {},
  })
  const tallFrame = tall.render(80).join('\n')
  assert.match(tallFrame, /Approve and retry evil-pkg/)
  assert.match(tallFrame, /execute scripts with your user privileges/, 'both risk facts and approval are visible at 80x24')
  tall.dispose()

  // Another official card's Install action must not bypass recovery and replace
  // this terminal record; New install is the explicit replacement path.
  assert.equal(controller.beginOfficialInstall('another-official-card'), false)
  assert.equal(controller.installView()?.requestId, requestId)
  assert.match(controller.notice() ?? '', /install result is still open/)

  page.handleInput('\x1b') // hide the install view
  await tick()
  assert.equal(page.currentView(), 'list')
  page.handleInput('i') // reopen, never replace
  await tick()
  assert.equal(page.currentView(), 'install')
  assert.equal(controller.installView()?.requestId, requestId, 'i preserves the original request id')
  assert.equal(controller.installView()?.phase, 'failed')

  page.handleInput('n') // explicit new
  await tick()
  assert.equal(page.currentView(), 'install')
  assert.equal(controller.installView()?.phase, 'editing')
  assert.notEqual(controller.installView()?.requestId, requestId, 'n creates a genuinely new request')
  page.dispose()
})

test('a recently completed install also reopens without a new request', async () => {
  const { controller, installCalls, gate } = harness()
  controller.beginManualInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  const requestId = (installCalls[0] as { requestId: string }).requestId
  gate.resolve(change({ application: 'applied' }))
  await tick()
  assert.equal(controller.installView()?.phase, 'done')

  const page = installPage(controller)
  assert.equal(page.currentView(), 'install')
  page.handleInput('\x1b')
  page.handleInput('i')
  await tick()
  assert.equal(page.currentView(), 'install')
  assert.equal(controller.installView()?.requestId, requestId)
  page.dispose()
})

test('every pending package name must be fully visible before Approve is admitted', async () => {
  const pending = ['@vendor/' + 'a'.repeat(40), '@other/' + 'b'.repeat(40)]
  const { controller, installCalls, gate } = harness()
  controller.beginManualInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  gate.resolve(change({ application: 'failed', pendingBuilds: pending }))
  await tick()

  const tall = new PluginManagerWorkspacePanel(controller, {
    rows: () => 24,
    columns: () => 80,
    requestRender: () => {},
    notice: () => undefined,
    onCopy: () => {},
  })
  const tallFrame = tall.render(80).join('\n')
  for (const name of pending) {
    assert.ok(tallFrame.includes(`- ${name}`), `the full pending name is visible: ${name}`)
  }
  assert.match(tallFrame, /execute scripts with your user privileges/)
  assert.match(tallFrame, /Approve and retry/)
  tall.dispose()

  const short = new PluginManagerWorkspacePanel(controller, {
    rows: () => 10,
    columns: () => 80,
    requestRender: () => {},
    notice: () => undefined,
    onCopy: () => {},
  })
  const shortFrame = short.render(80).join('\n')
  assert.doesNotMatch(shortFrame, /Approve/, 'a truncated package list removes Approve')
  short.handleInput('\r')
  await tick()
  assert.equal(installCalls.length, 1, 'the short frame cannot authorize hidden package scripts')
  short.dispose()
})

test('an unknown install reopens with its request id and reconciliation action', async () => {
  const rejected = new PluginManagerController({
    snapshot: async () => emptySnapshot(),
    inspect: async () => ({ status: 'accepted', kind: 'registry', name: 'pkg', version: '1', bundle: true, registry: null }),
    setBundleEnabled: async () => change({ stage: 'enable' }),
    setPluginEnabled: async () => change({ stage: 'enable' }),
    removeBundle: async () => change({ stage: 'remove' }),
    startInstall: async () => { throw new Error('host lost') },
    waitForInstall: async () => null,
    cancelInstall: async () => ({ status: 'not-running' }),
    subscribeInstall: () => () => {},
    subscribeInvalidation: () => () => {},
  }, {
    requestRender: () => {},
    requestClose: () => {},
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })
  rejected.beginManualInstall()
  rejected.inspect('pkg', null)
  await tick()
  rejected.confirmInstall()
  await tick()
  const unknownId = rejected.installView()?.requestId
  assert.equal(rejected.installView()?.phase, 'unknown')
  const page = installPage(rejected)
  assert.equal(page.currentView(), 'install')
  const unknownFrame = page.render(120).join('\n')
  assert.match(unknownFrame, /Check installation status/)
  assert.doesNotMatch(unknownFrame, /New install/, 'unknown must not offer a replacement request')
  page.handleInput('\x1b')
  page.handleInput('i')
  await tick()
  assert.equal(rejected.installView()?.requestId, unknownId)
  assert.equal(rejected.installView()?.phase, 'unknown')
  page.handleInput('n')
  await tick()
  assert.equal(rejected.installView()?.requestId, unknownId, 'n cannot replace an unknown request')
  assert.equal(rejected.beginManualInstall(), false)
  assert.equal(rejected.beginOfficialInstall('another-official-card'), false)
  assert.equal(rejected.installView()?.requestId, unknownId)
  page.dispose()
  rejected.dispose()
})

test('a zero-row body revokes build-script approval until an explicit re-selection', async () => {
  const { controller, installCalls, gate } = harness()
  controller.beginManualInstall()
  controller.inspect('pkg', null)
  await tick()
  controller.confirmInstall()
  await tick()
  gate.resolve(change({ application: 'failed', pendingBuilds: ['evil-pkg'] }))
  await tick()
  assert.equal(controller.installView()?.phase, 'failed')

  let rows = 24
  const page = new PluginManagerWorkspacePanel(controller, {
    rows: () => rows,
    columns: () => 80,
    requestRender: () => {},
    notice: () => undefined,
    onCopy: () => {},
  })
  assert.match(page.render(80).join('\n'), /Approve and retry evil-pkg/)
  rows = 2
  page.render(80)
  page.handleInput('\r')
  await tick()
  assert.equal(installCalls.length, 1, 'Enter on a zero-row install frame cannot approve')
  assert.equal(controller.installView()?.phase, 'failed')

  rows = 24
  const restored = page.render(80).join('\n').replace(/\x1b\[[0-9;]*m/g, '')
  assert.match(restored, /Approve and retry evil-pkg/)
  assert.match(restored, /^> Back\s*$/mu, 'the restored selection is the safe last action, not Approve')
  assert.equal(installCalls.length, 1)
  page.handleInput('\x1b[A') // Back -> New install
  page.handleInput('\x1b[A') // New install -> Check installation status
  page.handleInput('\x1b[A') // Check -> Approve
  page.render(80)
  page.handleInput('\r')
  await tick()
  assert.equal(installCalls.length, 2, 'only the explicit re-selection approves')
  page.dispose()
})

// ── S5 / PR-E: real official Host install lifecycle (A09 / A10) ─────────────
//
// PRODUCTION PREREQUISITES REPRODUCED
//   The real `@deepseek-ai/dsh-plugin-manager` Host service over the official
//   base-owned `profileContext` + Loader, driven through the production
//   `DirectPluginManagerPort`, `PluginManagerController` and workspace panel.
//   The package source is a loopback npm registry; pnpm is the real binary and
//   writes a real profile.
// TEST STAND-INS
//   The loopback registry and the tiny audit package/tarball created under the
//   test lifecycle root.
// DELIBERATELY ABSENT
//   The public npm registry, the developer's real HOME/DSH_HOME/credential
//   store, unknown third-party code, and any paid/native provider.

/** The profile files the official Host may rewrite/restore. */
const PROFILE_OWNED_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml'] as const

function profileFiles(dir: string): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {}
  for (const name of PROFILE_OWNED_FILES) {
    const path = join(dir, name)
    snapshot[name] = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  }
  return snapshot
}

function plainFrame(lines: readonly string[]): string {
  return lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
}

async function waitForState(label: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise<void>(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Unwrap a Cordis traceable service proxy to the implementation that owns the
 *  method (the proxy refuses property writes). */
function serviceImplementation<T>(value: unknown): T {
  const original = (value as Record<symbol, unknown>)[symbols.original]
  return (original ?? value) as T
}

interface RealHostInstallFixture {
  readonly host: Awaited<ReturnType<typeof createRemoteApplicationHostFixture>>
  readonly controller: PluginManagerController
  readonly profileDir: string
  /** A new panel over the SAME controller (the surface is disposable; the
   *  controller/install request outlives it). */
  panelAt(rows: number, width?: number, t?: import('node:test').TestContext): PluginManagerWorkspacePanel
}

/** Boot the real Host + the production controller/panel over an isolated,
 *  empty managed profile. */
async function startRealInstallFixture(
  t: import('node:test').TestContext,
  presetId: string,
  options: {
    /** Optional test seam over the REAL Direct adapter (e.g. to delay one
     *  presentation event while the Host already advanced). */
    readonly portFactory?: (host: Awaited<ReturnType<typeof createRemoteApplicationHostFixture>>) => PluginManagerPort
  } = {},
): Promise<RealHostInstallFixture> {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, presetId, {
    pluginManagerProfile: { emptyProfile: true },
    isolateHome: true,
  })
  assert.ok(host.pluginManager !== undefined)
  const port = options.portFactory?.(host) ?? new DirectPluginManagerPort(host.ctx)
  const controller = new PluginManagerController(port, {
    requestRender: () => {},
    requestClose: () => {},
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })
  life.defer(() => controller.dispose())
  controller.open('direct-command')
  await waitForState('the real Host inventory', () => controller.status().state === 'ready')
  return {
    host,
    controller,
    profileDir: host.pluginManager.profileDir,
    panelAt(rows: number, width = 80, testContext?: import('node:test').TestContext): PluginManagerWorkspacePanel {
      const panel = new PluginManagerWorkspacePanel(controller, {
        rows: () => rows,
        columns: () => width,
        requestRender: () => {},
        notice: () => undefined,
        onCopy: () => {},
      })
      if (testContext !== undefined) testContext.after(() => panel.dispose())
      return panel
    },
  }
}

test('A09: the real Host cancel terminates the real pnpm install, restores the profile, and reopens one request', async (t) => {
  // The fixture must neutralize an ambient package-manager user config, not
  // just HOME/XDG. Plant a sentinel that would break resolution if inherited.
  const sentinel = join(tmpdir(), `s5-npmrc-sentinel-${process.pid}-${Date.now()}`)
  writeFileSync(sentinel, 'registry=http://127.0.0.1:1\n')
  const hadLower = process.env.npm_config_userconfig
  const hadUpper = process.env.NPM_CONFIG_USERCONFIG
  process.env.npm_config_userconfig = sentinel
  process.env.NPM_CONFIG_USERCONFIG = sentinel
  const fixture = await startRealInstallFixture(t, 's5-pr-e-a09')
  // Registered AFTER the fixture lifecycle, so the fixture's own restore runs
  // first and this one restores the process's original values last.
  t.after(() => {
    if (hadLower === undefined) delete process.env.npm_config_userconfig
    else process.env.npm_config_userconfig = hadLower
    if (hadUpper === undefined) delete process.env.NPM_CONFIG_USERCONFIG
    else process.env.NPM_CONFIG_USERCONFIG = hadUpper
    rmSync(sentinel, { force: true })
  })
  const { host, controller, profileDir } = fixture
  const port = new DirectPluginManagerPort(host.ctx)
  const isolatedHome = join(host.workRoot, 'home')
  assert.equal(process.env.npm_config_userconfig, join(isolatedHome, '.npmrc'),
    'the explicit npm user config is the test-owned file, never the ambient sentinel')
  assert.equal(process.env.NPM_CONFIG_USERCONFIG, join(isolatedHome, '.npmrc'))
  assert.equal(process.env.NPM_CONFIG_GLOBALCONFIG, join(isolatedHome, '.npmrc.global'))
  assert.match(process.env.npm_config_cache ?? '', /dsh-m3-4-pr1-/)
  assert.equal(process.env.npm_config_registry, undefined, 'the registry is selected by the explicit install option, not ambient env')
  const profileBefore = profileFiles(profileDir)

  // Count real Host dispatches through the unwrapped service implementation:
  // a cancel must never cause a second install.
  const hostService = serviceImplementation<{
    installBundle(spec: string, options?: unknown): Promise<unknown>
  }>(host.ctx.get('pluginManager'))
  const originalInstall = hostService.installBundle
  let dispatches = 0
  hostService.installBundle = function patchedInstall(this: unknown, spec: string, options?: unknown): Promise<unknown> {
    dispatches += 1
    return originalInstall.call(this, spec, options)
  }
  t.after(() => { hostService.installBundle = originalInstall })

  const manifest = { name: '@s5-fixture/slow-cancel', version: '0.0.1', dsh: { bundle: { patch: [] } } }
  const packed = packFixturePackage(join(host.workRoot, 'a09-package'), {
    name: manifest.name,
    version: manifest.version,
    manifest,
  })
  const registry = await startLocalNpmRegistry(packed, { slowTarball: true, manifest })
  t.after(() => registry.close())

  const phases: Array<{ requestId: string; phase: string }> = []
  const off = (host.ctx as unknown as {
    on(name: string, listener: (payload: { requestId: string; phase: string }) => void): () => void
  }).on('plugin-manager/install-state', payload => phases.push({ requestId: String(payload.requestId), phase: payload.phase }))
  t.after(off)

  controller.beginManualInstall()
  // The panel opens on the SAME controller's install view (a real user opens
  // the dialog after starting it).
  const panel = fixture.panelAt(24, 80, t)
  panel.render(80)
  panel.handleInput('i') // the real list key opens the install dialog
  controller.inspect(manifest.name, registry.url)
  await waitForState('the accepted inspection', () => controller.installView()?.phase === 'confirm')
  panel.render(80)
  panel.handleInput('\r')
  await waitForState('the real install to start', () => controller.installView()?.phase === 'installing')
  const requestId = controller.installView()!.requestId!
  assert.ok(requestId !== undefined && requestId !== '')

  // The real pnpm child is now blocked in the slow tarball read.
  await registry.waitForTarballRequest()
  const running = plainFrame(panel.render(80))
  assert.match(running, /Stop installation/, 'the running frame paints the official Stop action')

  // Real user Stop key on the painted frame.
  panel.handleInput('s')
  await waitForState('the official cancellation to settle', () => controller.installView()?.phase === 'done')
  assert.match(controller.installView()?.message ?? '', /cancelled/)
  registry.releaseTarball()
  await waitForState('the settled request to leave the Host installs map', async () => (await port.waitForInstall(requestId)) === null)

  // Host final state: exactly one dispatch, no installed dependency, and the
  // profile files are the restored originals.
  assert.equal(dispatches, 1, 'one cancelled request never dispatches a second installBundle')
  const profile = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  assert.equal(profile.dependencies?.[manifest.name], undefined, 'the cancelled install never lands in the profile manifest')
  assert.equal(existsSync(join(profileDir, 'node_modules', '@s5-fixture', 'slow-cancel')), false,
    'the cancelled install never lands in the profile node_modules')
  assert.deepEqual(profileFiles(profileDir), profileBefore,
    'the cancelled install restores every profile-owned file the Host may rewrite')

  const requestPhases = phases.filter(event => event.requestId === requestId).map(event => event.phase)
  assert.ok(requestPhases.includes('installing'), `the real Host announced installing: ${JSON.stringify(requestPhases)}`)
  assert.ok(requestPhases.includes('cancelling'), `the real Host announced cancelling: ${JSON.stringify(requestPhases)}`)

  // Re-entering the surface resumes the SAME request id; only an explicit
  // New install may replace it.
  const reopened = new PluginManagerWorkspacePanel(controller, {
    rows: () => 24,
    columns: () => 80,
    requestRender: () => {},
    notice: () => undefined,
    onCopy: () => {},
  })
  t.after(() => reopened.dispose())
  assert.equal(reopened.currentView(), 'install')
  assert.equal(controller.installView()?.requestId, requestId)
  assert.equal(controller.installView()?.phase, 'done')
})

test('A09 (too-late): the controller renders the real Host too-late response and the one install settles', async (t) => {
  // Deterministic race window: the Host advances to `applying` and emits the
  // official phase event, but this test-local PORT WRAPPER withholds that ONE
  // presentation event until the user's Stop has already been dispatched. The
  // wrapper delegates every operation to the real Direct adapter/Host; it is
  // not a fake Host and it fabricates no result.
  let inner: DirectPluginManagerPort | undefined
  let releaseApplying!: () => void
  const applyingGate = new Promise<void>(resolve => { releaseApplying = resolve })
  let markApplyingSeen!: () => void
  const applyingSeen = new Promise<void>(resolve => { markApplyingSeen = resolve })
  const fixture = await startRealInstallFixture(t, 's5-pr-e-a09-too-late', {
    portFactory: (host) => {
      const direct = new DirectPluginManagerPort(host.ctx)
      inner = direct
      const wrapper: PluginManagerPort = {
        snapshot: () => direct.snapshot(),
        inspect: (spec, registry, signal) => direct.inspect(spec, registry, signal),
        setBundleEnabled: (name, enabled) => direct.setBundleEnabled(name, enabled),
        setPluginEnabled: (id, enabled) => direct.setPluginEnabled(id, enabled),
        removeBundle: (name) => direct.removeBundle(name),
        startInstall: (request) => direct.startInstall(request),
        waitForInstall: (requestId) => direct.waitForInstall(requestId),
        cancelInstall: (requestId) => direct.cancelInstall(requestId),
        subscribeInstall: (listener) => direct.subscribeInstall(event => {
          if (event.kind === 'phase' && event.phase.phase === 'applying') {
            markApplyingSeen()
            void applyingGate.then(() => listener(event))
            return
          }
          listener(event)
        }),
        subscribeInvalidation: (listener) => direct.subscribeInvalidation(listener),
      }
      return wrapper
    },
  })
  const { host, controller, profileDir } = fixture
  assert.ok(inner !== undefined)
  const hostService = serviceImplementation<{
    installBundle(spec: string, options?: unknown): Promise<unknown>
    publishAndReload(ids?: unknown): Promise<unknown>
  }>(host.ctx.get('pluginManager'))
  const originalInstall = hostService.installBundle
  let dispatches = 0
  hostService.installBundle = function patchedInstall(this: unknown, spec: string, options?: unknown): Promise<unknown> {
    dispatches += 1
    return originalInstall.call(this, spec, options)
  }
  t.after(() => { hostService.installBundle = originalInstall })

  // Hold the official apply step AFTER the Host announced `applying`, so the
  // window is stable until the controller has handled the real too-late reply.
  const originalPublish = hostService.publishAndReload
  let releaseApply!: () => void
  const applyGate = new Promise<void>(resolve => { releaseApply = resolve })
  hostService.publishAndReload = async function patchedPublish(this: unknown, ids?: unknown): Promise<unknown> {
    await applyGate
    return originalPublish.call(this, ids)
  }
  t.after(() => { hostService.publishAndReload = originalPublish })

  const manifest = { name: '@s5-fixture/too-late', version: '0.0.1', dsh: { bundle: { patch: [] } } }
  const packed = packFixturePackage(join(host.workRoot, 'a09-too-late-package'), {
    name: manifest.name,
    version: manifest.version,
    manifest,
  })
  const registry = await startLocalNpmRegistry(packed, { manifest })
  t.after(() => registry.close())

  controller.beginManualInstall()
  const panel = fixture.panelAt(24, 80, t)
  panel.render(80)
  panel.handleInput('i')
  controller.inspect(manifest.name, registry.url)
  await waitForState('the accepted inspection', () => controller.installView()?.phase === 'confirm')
  controller.confirmInstall()
  // The Host reached applying, but the controller still sees `installing`
  // because the presentation event is deliberately withheld.
  await applyingSeen
  assert.equal(controller.installView()?.phase, 'installing',
    'the controller has not yet observed the applying event')
  panel.render(80)
  panel.handleInput('s') // the real user Stop path: controller.cancelInstall()
  await waitForState('the controller renders the real Host too-late response', () => {
    const view = controller.installView()
    return view?.phase === 'applying' && /too late/.test(view.message ?? '')
  })
  assert.equal(controller.installView()?.phase, 'applying', 'too-late never fabricates a cancelled view')
  assert.match(controller.installView()?.message ?? '', /too late/)
  releaseApplying()
  releaseApply()
  await waitForState('the one install settles', () => controller.installView()?.phase === 'done', 60_000)
  const outcome = controller.installView()?.outcome
  assert.notEqual(outcome?.application, 'cancelled', 'the Host final outcome is observed, never faked')
  assert.notEqual(outcome?.application, 'failed')
  assert.equal(dispatches, 1, 'the too-late attempt never starts a second install')
  const profile = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  assert.ok(profile.dependencies?.[manifest.name] !== undefined, 'the applied install lands in the profile manifest')
  assert.ok(profile.dsh?.profile?.bundles?.includes(manifest.name), 'the applied bundle is selected')
  const requestId = controller.installView()!.requestId!
  await waitForState('the settled request leaves the installs map', async () => (await inner!.waitForInstall(requestId)) === null)
})

test('A10: real pnpm blocked builds become pendingBuilds; only an explicit approval runs the harmless marker script', async (t) => {
  const fixture = await startRealInstallFixture(t, 's5-pr-e-a10')
  const { host, controller, profileDir } = fixture

  const hostService = serviceImplementation<{
    installBundle(spec: string, options?: unknown): Promise<unknown>
  }>(host.ctx.get('pluginManager'))
  const originalInstall = hostService.installBundle
  let dispatches = 0
  hostService.installBundle = function patchedInstall(this: unknown, spec: string, options?: unknown): Promise<unknown> {
    dispatches += 1
    return originalInstall.call(this, spec, options)
  }
  t.after(() => { hostService.installBundle = originalInstall })

  const packageName = '@s5-fixture/build-consent'
  const manifest = {
    name: packageName,
    version: '0.0.1',
    dsh: { bundle: { patch: [] } },
    scripts: {
      postinstall: "node -e \"require('fs').writeFileSync('approved.marker','approved-by-explicit-user-action')\"",
    },
  }
  const packed = packFixturePackage(join(host.workRoot, 'a10-package'), {
    name: manifest.name,
    version: manifest.version,
    manifest,
  })
  const registry = await startLocalNpmRegistry(packed, { manifest })
  t.after(() => registry.close())

  controller.beginManualInstall()
  controller.inspect(packageName, registry.url)
  await waitForState('the accepted inspection', () => controller.installView()?.phase === 'confirm')
  controller.confirmInstall()
  await waitForState('the real blocked-build failure', () => controller.installView()?.phase === 'failed', 120_000)

  const outcome = controller.installView()?.outcome
  assert.equal(outcome?.application, 'failed')
  assert.deepEqual([...outcome?.pendingBuilds ?? []], [`${packageName}@0.0.1`],
    'the official Host reports the exact pending package from the real pnpm run')
  assert.equal(dispatches, 1)
  const marker = join(profileDir, 'node_modules', '@s5-fixture', 'build-consent', 'approved.marker')
  assert.equal(existsSync(marker), false, 'a blocked build never runs its script')
  const panel = fixture.panelAt(24, 80, t)

  // The short/zero-body frames never admit the approval action: Enter on a
  // frame that does not paint the full risk writes nothing to the Host.
  const sizes = [
    { rows: 10, width: 80, label: '80x10', approvalExpected: false },
    { rows: 20, width: 44, label: '44x20', approvalExpected: true },
    { rows: 2, width: 80, label: '80x2', approvalExpected: false },
  ] as const
  for (const size of sizes) {
    // Re-create the panel at the requested live height for this frame.
    const sized = new PluginManagerWorkspacePanel(controller, {
      rows: () => size.rows,
      columns: () => size.width,
      requestRender: () => {},
      notice: () => undefined,
      onCopy: () => {},
    })
    const frame = plainFrame(sized.render(size.width))
    const riskFullyVisible = /execute scripts with your[\s\S]*user privileges/.test(frame)
    if (!size.approvalExpected) {
      // The gate admits approval ONLY together with its fully painted risk.
      assert.equal(riskFullyVisible, false, `${size.label}: the frame cannot show the full risk`)
      assert.doesNotMatch(frame, /Approve and retry/, `${size.label}: no Approve without the full risk`)
      sized.handleInput('\r')
      await new Promise<void>(resolve => setTimeout(resolve, 60))
      assert.equal(dispatches, 1, `${size.label}: Enter on an unsafe frame dispatches no install`)
    } else {
      // A taller narrow frame may legitimately admit approval — but only when
      // both risk facts are painted in the same frame.
      assert.match(frame, /Approve and retry/)
      assert.equal(riskFullyVisible, true, `${size.label}: approval requires the fully painted risk`)
    }
    sized.dispose()
  }

  // The 80x24 frame shows BOTH risk facts and the explicit approval action.
  const tall = plainFrame(panel.render(80))
  assert.match(tall, /Approve and retry @s5-fixture\/build-consent@0\.0\.1/)
  assert.match(tall, /execute scripts with your user privileges/)
  assert.doesNotMatch(tall, /already-approved marker/)
  panel.handleInput('\r')
  await waitForState('the approved second install to settle', () => controller.installView()?.phase === 'done', 120_000)

  assert.equal(dispatches, 2, 'the approval dispatches exactly one new Host attempt')
  assert.equal(existsSync(marker), true, 'the approved build script wrote its harmless marker')
  assert.equal(readFileSync(marker, 'utf8'), 'approved-by-explicit-user-action')

  const profile = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  assert.match(profile.dependencies?.[packageName] ?? '', /^\^?0\.0\.1$/, 'the approved install lands in the profile manifest')
  assert.ok(profile.dsh?.profile?.bundles?.includes(packageName), 'the installed bundle is selected')
  const workspace = parseYaml(readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')) as {
    allowBuilds?: Record<string, unknown>
  }
  assert.deepEqual(workspace.allowBuilds, { [`${packageName}@0.0.1`]: true },
    'the official approval persisted exactly the pending build permission')
})
