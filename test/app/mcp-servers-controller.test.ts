/**
 * FR3 — the per-open MCP controller's currentness and lifecycle fences.
 *
 * Evidence level: unit/lifecycle (L2). These are the discriminating negatives
 * the page alone cannot see: a late Probe/Restart result is discarded AND its
 * page-local operation is ended (never a permanent "running" latch); a result
 * for a name the SAME generation removed (or removed and re-listed) is never
 * attributed to the replacement; and a settings source read from another Host
 * generation can never be combined with this roster.
 *
 * @module @xmoon76/dsh-pi-tui/app/command/mcp-servers.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  McpServersController,
  RESTART_LOST_NOTE,
  type McpServersSnapshot,
} from '../../src/app/command/mcp-servers.ts'
import type {
  McpServerPort,
  McpServerProbeOutcome,
  McpServerRestartOutcome,
  McpServerView,
  McpServerWatchEvent,
} from '../../src/runtime/mcp-server-port.ts'
import type { McpServerSources, McpServerSourcesConfig } from '../../src/runtime/config-port.ts'

const GENERATION_1 = Object.freeze({ id: 'g1' })
const GENERATION_2 = Object.freeze({ id: 'g2' })

/** A controllable port with a real async watch and deferred operations. */
class FakePort implements McpServerPort {
  private readonly queue: McpServerWatchEvent[] = []
  private waiters: Array<() => void> = []
  readonly probes: string[] = []
  readonly restarts: string[] = []
  private readonly probeWaiters: Array<(outcome: McpServerProbeOutcome) => void> = []
  private readonly restartWaiters: Array<(outcome: McpServerRestartOutcome) => void> = []

  emit(event: McpServerWatchEvent): void {
    this.queue.push(event)
    const wake = this.waiters
    this.waiters = []
    for (const resolve of wake) resolve()
  }

  roster(servers: McpServerView[], generation: object): void {
    this.emit({ kind: 'current', roster: { generation, servers } })
  }

  async *watch(signal: AbortSignal): AsyncIterable<McpServerWatchEvent> {
    while (!signal.aborted) {
      if (this.queue.length === 0) {
        await new Promise<void>(resolve => {
          this.waiters.push(resolve)
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        continue
      }
      const event = this.queue.shift()
      if (event !== undefined) yield event
    }
  }

  probe(name: string, _signal: AbortSignal): Promise<McpServerProbeOutcome> {
    this.probes.push(name)
    return new Promise(resolve => { this.probeWaiters.push(resolve) })
  }

  restart(name: string, _signal: AbortSignal): Promise<McpServerRestartOutcome> {
    this.restarts.push(name)
    return new Promise(resolve => { this.restartWaiters.push(resolve) })
  }

  resolveProbe(outcome: McpServerProbeOutcome, index = 0): void {
    const resolve = this.probeWaiters[index]
    assert.ok(resolve !== undefined, `no probe #${String(index)} was in flight`)
    resolve(outcome)
  }

  resolveRestart(outcome: McpServerRestartOutcome, index = 0): void {
    const resolve = this.restartWaiters[index]
    assert.ok(resolve !== undefined, `no restart #${String(index)} was in flight`)
    resolve(outcome)
  }
}

/** A controllable configuration-source read. */
class FakeSources implements McpServerSourcesConfig {
  value: McpServerSources = { kind: 'unavailable', reason: 'not read' }
  /** A settings commit that becomes visible on the NEXT refresh (models the
   *  non-atomic settings/manifest window). */
  nextValue: McpServerSources | undefined
  /** When set, one refresh waits on it (models a settings read still in flight). */
  gate: Promise<void> | undefined
  async refresh(): Promise<void> {
    if (this.gate !== undefined) await this.gate
    await Promise.resolve()
    if (this.nextValue !== undefined) {
      this.value = this.nextValue
      this.nextValue = undefined
    }
  }
  read(): McpServerSources { return this.value }
}

function view(name: string, configured = true, state: 'connected' | 'disabled' = 'connected'): McpServerView {
  return Object.freeze({
    name,
    configured,
    status: state === 'connected'
      ? Object.freeze({ state: 'connected' as const, toolCount: 1, connectedAt: 1 })
      : Object.freeze({ state: 'disabled' as const }),
  })
}

interface Harness {
  readonly controller: McpServersController
  readonly port: FakePort
  readonly sources: FakeSources
  flush(): Promise<void>
}

function harness(): Harness {
  const port = new FakePort()
  const sources = new FakeSources()
  const tasks: Array<Promise<void>> = []
  const controller = new McpServersController({
    port,
    sources,
    requestRender: () => {},
    runOwned: (label, task) => {
      // Long-lived operations (the watch and a held Probe/Restart) run
      // detached; only the finite source reads are awaited by `flush`.
      if (label.includes('watch') || label.includes('probe') || label.includes('restart')) {
        void task().catch(() => {})
        return
      }
      tasks.push(task())
    },
  })
  const flush = async (): Promise<void> => {
    for (let round = 0; round < 6; round += 1) {
      const batch = tasks.splice(0)
      for (const task of batch) await task.catch(() => {})
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
  controller.start()
  return { controller, port, sources, flush }
}

function probeOutcome(generation: object): McpServerProbeOutcome {
  return {
    kind: 'settled',
    generation,
    value: { ok: true, toolNames: ['echo'], truncated: false, durationMs: 1, closeConfirmed: true },
  }
}

function snapshot(h: Harness): McpServersSnapshot {
  return h.controller.snapshot()
}

test('a probe that settles after a generation change is discarded AND ends its operation', async () => {
  const h = harness()
  h.sources.value = { kind: 'ready', configuredNames: ['alpha'], generation: GENERATION_1 }
  h.port.roster([view('alpha'), view('beta')], GENERATION_1)
  await h.flush()
  assert.equal(h.controller.canOperateSelected(), true)
  h.controller.probe()
  assert.equal(snapshot(h).operation?.phase, 'running')
  assert.equal(h.controller.canOperateSelected(), false, 'an in-flight probe owns the page')
  // The manager is replaced while the probe is in flight.
  h.port.roster([view('alpha'), view('beta')], GENERATION_2)
  await h.flush()
  h.port.resolveProbe(probeOutcome(GENERATION_1))
  await h.flush()
  // The previous Host's probe report/feedback is not a fact of this roster.
  assert.equal(snapshot(h).operation, undefined, 'the previous Host probe feedback is cleared')
  assert.equal(snapshot(h).lastProbe, undefined, 'no fact from another generation is retained')
  assert.equal(h.controller.canOperateSelected(), true, 'the page can operate again')
})

test('a late probe for a name the SAME generation removed is discarded and ends the operation', async () => {
  const h = harness()
  h.sources.value = { kind: 'ready', configuredNames: ['alpha'], generation: GENERATION_1 }
  h.port.roster([view('alpha'), view('beta')], GENERATION_1)
  await h.flush()
  h.controller.move(0, ['alpha', 'beta'])
  h.controller.probe()
  // Same generation: the roster now removes the probed server.
  h.port.roster([view('beta')], GENERATION_1)
  await h.flush()
  h.port.resolveProbe(probeOutcome(GENERATION_1))
  await h.flush()
  assert.equal(snapshot(h).operation?.phase, 'failed')
  assert.equal(snapshot(h).lastProbe, undefined)
})

test('a removed and re-listed name is a NEW entry: its late probe is discarded', async () => {
  const h = harness()
  h.sources.value = { kind: 'ready', configuredNames: ['alpha'], generation: GENERATION_1 }
  h.port.roster([view('alpha')], GENERATION_1)
  await h.flush()
  h.controller.probe()
  // Remove, then re-list the SAME name within one generation.
  h.port.roster([], GENERATION_1)
  await h.flush()
  h.port.roster([view('alpha')], GENERATION_1)
  await h.flush()
  h.port.resolveProbe(probeOutcome(GENERATION_1))
  await h.flush()
  assert.equal(h.controller.snapshot().lastProbe, undefined,
    'a late result for the previous entry is never attributed to the replacement')
  assert.equal(h.controller.snapshot().operation?.phase, 'failed')
})

test('a dispatched restart that loses its settlement is never reported as "could not be dispatched"', async () => {
  const h = harness()
  h.sources.value = { kind: 'ready', configuredNames: ['alpha'], generation: GENERATION_1 }
  h.port.roster([view('alpha')], GENERATION_1)
  await h.flush()
  h.controller.beginRestart()
  assert.equal(h.controller.snapshot().confirmingName, 'alpha')
  h.controller.answerRestart(true)
  assert.equal(h.port.restarts.length, 1, 'exactly one dispatch')
  // The management authority is replaced after the dispatch.
  h.port.roster([view('alpha')], GENERATION_2)
  await h.flush()
  h.port.resolveRestart({ kind: 'failed', generation: GENERATION_1, failure: { kind: 'superseded', reason: 'manager changed' } })
  await h.flush()
  const notice = h.controller.snapshot().notice
  assert.equal(notice?.text, RESTART_LOST_NOTE)
  assert.doesNotMatch(notice?.text ?? '', /could not be dispatched/u)
  assert.equal(h.port.restarts.length, 1, 'never retried')
})

test('a restart invalidated by the observation reports an unconfirmed outcome, not a cancel', async () => {
  const h = harness()
  h.sources.value = { kind: 'ready', configuredNames: ['alpha'], generation: GENERATION_1 }
  h.port.roster([view('alpha')], GENERATION_1)
  await h.flush()
  h.controller.beginRestart()
  h.controller.answerRestart(true)
  h.port.emit({ kind: 'invalidated', reason: 'connection-changed' })
  await h.flush()
  assert.equal(h.controller.snapshot().operation?.phase, 'failed')
  assert.equal(h.controller.snapshot().notice?.text, RESTART_LOST_NOTE)
})

test('a settings source read from another generation is Unknown, never Configured/Plugin-owned', async () => {
  const h = harness()
  // A cross-generation key set: it must not classify this roster.
  h.sources.value = { kind: 'ready', configuredNames: ['alpha'], generation: GENERATION_2 }
  h.port.roster([view('alpha'), view('beta')], GENERATION_1)
  await h.flush()
  const rows = h.controller.snapshot().rows
  assert.deepEqual(rows.map(row => row.source), ['Unknown', 'Unknown'])

  // The SAME generation, confirmed by two consecutive current reads, classifies:
  // `alpha` is configured, the live `beta` is plugin-owned.
  h.sources.value = { kind: 'ready', configuredNames: ['alpha'], generation: GENERATION_1 }
  h.port.roster([view('alpha'), view('beta')], GENERATION_1)
  await h.flush()
  h.port.roster([view('alpha'), view('beta')], GENERATION_1)
  await h.flush()
  const classified = h.controller.snapshot().rows
  assert.deepEqual(classified.map(row => [row.name, row.source]), [['alpha', 'Configured'], ['beta', 'Plugin-owned']])
})

test('a restart confirmation bound to Host A can never restart Host B', async () => {
  const h = harness()
  h.sources.value = { kind: 'ready', configuredNames: ['alpha'], generation: GENERATION_1 }
  h.port.roster([view('alpha')], GENERATION_1)
  await h.flush()
  h.controller.beginRestart()
  assert.equal(h.controller.snapshot().confirmingName, 'alpha')
  // Host A is replaced (directly, without an invalidated frame this time).
  h.port.roster([view('alpha')], GENERATION_2)
  await h.flush()
  assert.equal(h.controller.snapshot().confirmingName, undefined, 'the old confirmation is retired')
  h.controller.answerRestart(true)
  await h.flush()
  assert.equal(h.port.restarts.length, 0, 'the Host A confirmation must not restart Host B')
})

test('a late Probe #1 cannot overwrite the newer Probe #2 operation slot', async () => {
  const h = harness()
  h.sources.value = { kind: 'ready', configuredNames: ['alpha'], generation: GENERATION_1 }
  h.port.roster([view('alpha')], GENERATION_1)
  await h.flush()
  h.controller.probe()
  assert.equal(h.port.probes.length, 1)
  h.port.emit({ kind: 'invalidated', reason: 'connection-changed' })
  await h.flush()
  h.port.roster([view('alpha')], GENERATION_2)
  await h.flush()
  h.controller.probe()
  assert.equal(h.port.probes.length, 2)
  assert.equal(h.controller.snapshot().operation?.phase, 'running')
  // Probe #1's late reply must not touch Probe #2's slot.
  h.port.resolveProbe(probeOutcome(GENERATION_1), 0)
  await h.flush()
  assert.equal(h.controller.snapshot().operation?.phase, 'running', 'the stale reply must not touch the new operation')
  h.port.resolveProbe(probeOutcome(GENERATION_2), 1)
  await h.flush()
  assert.equal(h.controller.snapshot().operation?.phase, 'settled')
  assert.equal(h.controller.snapshot().lastProbe?.kind, 'passed')
})

test('a probe report from Host A is not shown for the same-named Host B server', async () => {
  const h = harness()
  h.sources.value = { kind: 'ready', configuredNames: ['alpha'], generation: GENERATION_1 }
  h.port.roster([view('alpha')], GENERATION_1)
  await h.flush()
  h.controller.probe()
  h.port.resolveProbe(probeOutcome(GENERATION_1))
  await h.flush()
  assert.equal(h.controller.snapshot().lastProbe?.name, 'alpha')
  // Host B offers the same name: the Host A report must disappear.
  h.port.roster([view('alpha')], GENERATION_2)
  await h.flush()
  assert.equal(h.controller.snapshot().lastProbe, undefined, 'a Host A probe report is not a Host B fact')
  assert.equal(h.controller.snapshot().operation, undefined)
})

test('a retained cleanup record cannot be probed or restart-confirmed', async () => {
  const h = harness()
  h.sources.value = { kind: 'ready', configuredNames: [], generation: GENERATION_1 }
  h.port.roster([{ name: 'gone', configured: false, status: { state: 'failed', reason: 'cleanup', result: { closeConfirmed: false } } }], GENERATION_1)
  await h.flush()
  assert.equal(h.controller.canOperateSelected(), false, 'a retained record offers no operation')
  h.controller.probe()
  h.controller.beginRestart()
  await h.flush()
  assert.equal(h.port.probes.length, 0)
  assert.equal(h.controller.snapshot().confirmingName, undefined)
  // A disabled LIVE entry stays operable.
  h.port.roster([{ name: 'off', configured: true, status: { state: 'disabled' } }], GENERATION_1)
  await h.flush()
  h.controller.move(0, ['off'])
  assert.equal(h.controller.canOperateSelected(), true)
})

test('a roster update marks the source evidence non-current until a fresh read lands', async () => {
  const h = harness()
  h.sources.value = { kind: 'ready', configuredNames: [], generation: GENERATION_1 }
  h.port.roster([], GENERATION_1)
  await h.flush()
  // Settings commit + Manager reconcile arrive as a new roster frame while the
  // settings read is still the OLD key set.
  h.sources.nextValue = { kind: 'ready', configuredNames: ['alpha'], generation: GENERATION_1 }
  let releaseRefresh!: () => void
  h.sources.gate = new Promise<void>(resolve => { releaseRefresh = resolve })
  h.port.roster([view('alpha', true, 'connected'), view('beta', true, 'disabled')], GENERATION_1)
  // Let the watch frame be processed, but keep the settings read in flight.
  for (let tick = 0; tick < 12 && h.controller.snapshot().rows.length !== 2; tick += 1) await Promise.resolve()
  // BEFORE the fresh read lands, the source must be Unknown, never the old
  // empty key set (which would wrongly say Plugin-owned).
  assert.deepEqual(h.controller.snapshot().rows.map(row => row.source), ['Unknown', 'Unknown'])
  releaseRefresh()
  await h.flush()
  assert.deepEqual(h.controller.snapshot().rows.map(row => [row.name, row.source]),
    [['alpha', 'Configured'], ['beta', 'Plugin-owned']])
})

test('a settled probe result is published as the page probe report', async () => {
  const h = harness()
  h.sources.value = { kind: 'ready', configuredNames: ['alpha'], generation: GENERATION_1 }
  h.port.roster([view('alpha')], GENERATION_1)
  await h.flush()
  h.controller.probe()
  h.port.resolveProbe(probeOutcome(GENERATION_1))
  await h.flush()
  assert.equal(h.controller.snapshot().operation?.phase, 'settled')
  assert.equal(h.controller.snapshot().lastProbe?.kind, 'passed')
})
