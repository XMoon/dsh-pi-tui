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
import { projectMcpServerEntry } from '../../src/domain/mcp/server-config.ts'
import type {
  McpConfigWriteOutcome,
  McpServerConfiguration,
  McpServerConfigurationConfig,
  McpServerSources,
  McpServerSourcesConfig,
} from '../../src/runtime/config-port.ts'

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

/** A controllable FR4 configuration read/write. */
class FakeConfiguration implements McpServerConfigurationConfig {
  value: McpServerConfiguration = { kind: 'unavailable', reason: 'not read' }
  readonly mutations: Array<{ ops: readonly { readonly op: 'set' | 'unset'; readonly path: readonly string[]; readonly value?: unknown }[]; revision: number; generation: object }> = []
  outcome: (ops: readonly { readonly op: 'set' | 'unset'; readonly path: readonly string[]; readonly value?: unknown }[], revision: number, generation: object) => McpConfigWriteOutcome = () => ({ kind: 'saved', revision: 2 })
  async refresh(): Promise<void> {}
  read(): McpServerConfiguration { return this.value }
  async mutate(ops: readonly { readonly op: 'set' | 'unset'; readonly path: readonly string[]; readonly value?: unknown }[], revision: number, generation: object): Promise<McpConfigWriteOutcome> {
    this.mutations.push({ ops, revision, generation })
    return this.outcome(ops, revision, generation)
  }
}

interface Harness {
  readonly controller: McpServersController
  readonly port: FakePort
  readonly sources: FakeSources
  readonly configuration: FakeConfiguration
  flush(): Promise<void>
}

function harness(): Harness {
  const port = new FakePort()
  const sources = new FakeSources()
  const configuration = new FakeConfiguration()
  const tasks: Array<Promise<void>> = []
  const controller = new McpServersController({
    port,
    sources,
    configuration,
    requestRender: () => {},
    runOwned: (label, task) => {
      // Long-lived operations (the watch and a held Probe/Restart) run
      // detached; only the finite source reads are awaited by `flush`.
      if (label.includes('watch') || label.includes('probe') || label.includes('restart') || label.includes('write')) {
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
  return { controller, port, sources, configuration, flush }
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

/* ------------------------------------------------------------------------- *
 * FR4: configuration CRUD.
 * ------------------------------------------------------------------------- */

/** A configuration read for the given generation with the given entries. The
 *  raw entry value is projected EXACTLY like the adapters do. */
function configOf(
  generation: object,
  revision: number,
  entries: readonly { name: string; provenance: 'user-added' | 'inherited' | 'overridden'; effective: Record<string, unknown> }[],
): McpServerConfiguration {
  return {
    kind: 'ready',
    generation,
    revision,
    entries: entries.map(entry => {
      const effective = projectMcpServerEntry(entry.effective)
      assert.ok(effective !== undefined, `the test entry ${entry.name} must project`)
      return { name: entry.name, provenance: entry.provenance, effective }
    }),
  }
}

function stdioEffective(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { transport: 'stdio', command: '/bin/echo', args: [], cwd: '', enabled: true, ...overrides }
}

/** Ready roster + configuration of the same generation. */
async function readyHarness(configEntries: Parameters<typeof configOf>[2], revision = 3): Promise<Harness> {
  const h = harness()
  h.sources.value = { kind: 'ready', configuredNames: configEntries.map(entry => entry.name), generation: GENERATION_1 }
  h.port.roster(configEntries.map(entry => view(entry.name)), GENERATION_1)
  h.configuration.value = configOf(GENERATION_1, revision, configEntries)
  await h.flush()
  return h
}

test('a configured roster entry without a config descriptor entry offers NO edit intent', async () => {
  const h = await readyHarness([{ name: 'mine', provenance: 'user-added', effective: stdioEffective() }])
  // The roster also lists a plugin-registered server that the settings
  // descriptor never holds: `configured: true` is NOT config ownership.
  h.port.roster([view('mine'), view('plugin')], GENERATION_1)
  await h.flush()
  h.controller.select('plugin', ['mine', 'plugin'])
  assert.equal(h.controller.snapshot().selectedConfig, undefined)
  assert.equal(h.controller.canBeginEdit(), false, 'a non-config-owned row has no Edit')
  h.controller.beginDelete()
  h.controller.beginToggle()
  h.controller.beginReset()
  await h.flush()
  assert.equal(h.controller.snapshot().configConfirm, undefined, 'no CRUD confirmation may open')
})

test('a retained cleanup record offers no configuration action', async () => {
  const h = await readyHarness([])
  h.port.roster([{ name: 'gone', configured: false, status: { state: 'failed', reason: 'cleanup', result: { closeConfirmed: false } } }], GENERATION_1)
  await h.flush()
  assert.equal(h.controller.snapshot().selectedConfig, undefined)
  assert.equal(h.controller.canBeginEdit(), false)
})

test('Add requires a CURRENT descriptor and refuses a taken name', async () => {
  const h = harness()
  h.port.roster([view('mine')], GENERATION_1)
  await h.flush()
  // The configuration read never landed: no revision to pin, no Add.
  assert.equal(h.controller.canBeginAdd(), false)

  const ready = await readyHarness([{ name: 'mine', provenance: 'user-added', effective: stdioEffective() }])
  assert.equal(ready.controller.canBeginAdd(), true)
  ready.controller.beginAdd()
  const editor = ready.controller.snapshot().editor
  assert.equal(editor?.mode, 'add')
  assert.equal(editor?.nameEditable, true)
  ready.controller.setEditorField('name', 'mine')
  ready.controller.setEditorField('command', '/bin/true')
  ready.controller.saveEditor()
  await ready.flush()
  assert.equal(ready.configuration.mutations.length, 0, 'a taken name never dispatches a write')
  assert.equal(ready.controller.snapshot().configStatus?.kind, 'rejected')
  assert.equal(ready.controller.snapshot().editor?.name, 'mine', 'the draft survives a refusal')
})

test('an Add dispatches ONE pinned mutation, closes the draft and claims Saved (never Connected)', async () => {
  const h = await readyHarness([], 5)
  h.controller.beginAdd()
  h.controller.setEditorField('name', 'added')
  h.controller.setEditorField('command', '/bin/true')
  h.controller.addEditorArg()
  h.controller.setEditorArg(0, '--flag')
  h.controller.setEditorEnabled(false)
  assert.equal(h.controller.editorDirty(), true)
  h.controller.saveEditor()
  await h.flush()
  assert.equal(h.configuration.mutations.length, 1)
  const mutation = h.configuration.mutations[0]
  assert.equal(mutation?.revision, 5, 'the revision captured when the form opened')
  assert.equal(mutation?.generation, GENERATION_1)
  assert.deepEqual(mutation?.ops, [{
    op: 'set',
    path: ['servers', 'added'],
    value: { transport: 'stdio', enabled: false, command: '/bin/true', args: ['--flag'], cwd: '' },
  }])
  assert.equal(h.controller.snapshot().editor, undefined, 'a saved draft closes its form')
  assert.equal(h.controller.snapshot().configStatus?.kind, 'saved')
  assert.match(h.controller.snapshot().configStatus?.text ?? '', /waiting for Host reconcile/u)
  assert.doesNotMatch(h.controller.snapshot().configStatus?.text ?? '', /Connected/u)
})

test('an Edit patches only dirty fields and keeps a conflicted draft open', async () => {
  const h = await readyHarness([{ name: 'mine', provenance: 'user-added', effective: stdioEffective({ env: { KEEP: 'same', DROP: 'x' } }) }])
  h.configuration.outcome = () => ({ kind: 'failed', failure: { kind: 'conflict', reason: 'changed' } })
  h.controller.beginEdit()
  assert.equal(h.controller.snapshot().editor?.nameEditable, false, 'Edit keeps the name fixed')
  h.controller.setEditorDictValue('env', 'KEEP', 'same')
  h.controller.addEditorDictKey('env')
  // The inserted row starts with a unique placeholder key the user renames.
  const placeholder = h.controller.snapshot().editor?.env.find(entry => entry.key.startsWith('KEY_'))?.key
  assert.ok(placeholder !== undefined, 'the inserted row is painted')
  h.controller.renameEditorDictKey('env', placeholder, 'NEW')
  h.controller.setEditorDictValue('env', 'NEW', 'v')
  h.controller.removeEditorDictKey('env', 'DROP')
  h.controller.saveEditor()
  await h.flush()
  assert.equal(h.configuration.mutations.length, 1)
  assert.deepEqual(h.configuration.mutations[0]?.ops, [
    { op: 'set', path: ['servers', 'mine', 'env', 'NEW'], value: 'v' },
    { op: 'unset', path: ['servers', 'mine', 'env', 'DROP'] },
  ])
  assert.equal(h.controller.snapshot().configStatus?.kind, 'conflict')
  assert.equal(h.controller.snapshot().editor?.name, 'mine', 'the draft is preserved on a conflict')
})

test('Delete is user-added only; Reset is overridden only; both are ONE unset', async () => {
  const h = await readyHarness([
    { name: 'mine', provenance: 'user-added', effective: stdioEffective() },
    { name: 'inherited', provenance: 'inherited', effective: stdioEffective() },
    { name: 'both', provenance: 'overridden', effective: stdioEffective({ enabled: false }) },
  ])
  h.controller.select('inherited', ['mine', 'inherited', 'both'])
  h.controller.beginDelete()
  assert.equal(h.controller.snapshot().configConfirm, undefined, 'an inherited entry has no Delete')
  h.controller.beginReset()
  assert.equal(h.controller.snapshot().configConfirm, undefined, 'an unmodified inherited entry has no Reset')

  h.controller.select('mine', ['mine', 'inherited', 'both'])
  h.controller.beginDelete()
  assert.equal(h.controller.snapshot().configConfirm?.kind, 'delete')
  h.controller.answerConfigConfirm(false)
  assert.equal(h.configuration.mutations.length, 0, 'Esc cancels with zero writes')
  h.controller.beginDelete()
  h.controller.answerConfigConfirm(true)
  await h.flush()
  assert.deepEqual(h.configuration.mutations[0]?.ops, [{ op: 'unset', path: ['servers', 'mine'] }])

  h.controller.select('both', ['mine', 'inherited', 'both'])
  h.controller.beginReset()
  assert.equal(h.controller.snapshot().configConfirm?.kind, 'reset')
  h.controller.answerConfigConfirm(true)
  await h.flush()
  assert.deepEqual(h.configuration.mutations[1]?.ops, [{ op: 'unset', path: ['servers', 'both'] }])
  assert.equal(h.controller.snapshot().configStatus?.kind, 'saved')
})

test('a confirmation bound to Host A never writes against Host B', async () => {
  const h = await readyHarness([{ name: 'mine', provenance: 'user-added', effective: stdioEffective() }])
  h.controller.beginDelete()
  assert.equal(h.controller.snapshot().configConfirm?.kind, 'delete')
  // The Host is replaced (a new roster + a new configuration read).
  h.port.roster([view('mine')], GENERATION_2)
  await h.flush()
  assert.equal(h.controller.snapshot().configConfirm, undefined, 'the old confirmation is retired')
  h.controller.answerConfigConfirm(true)
  await h.flush()
  assert.equal(h.configuration.mutations.length, 0)
})

test('an open draft is retired by a Host replacement and cannot dispatch', async () => {
  const h = await readyHarness([{ name: 'mine', provenance: 'user-added', effective: stdioEffective() }])
  h.controller.beginEdit()
  h.controller.setEditorField('command', '/bin/true')
  h.port.roster([view('mine')], GENERATION_2)
  await h.flush()
  assert.equal(h.controller.snapshot().editor, undefined, 'a draft bound to Host A dies with it')
  h.controller.saveEditor()
  await h.flush()
  assert.equal(h.configuration.mutations.length, 0)
})

test('a Save whose captured revision moved is refused by the official CAS', async () => {
  const h = await readyHarness([{ name: 'mine', provenance: 'user-added', effective: stdioEffective() }], 2)
  h.controller.beginEdit()
  h.controller.setEditorField('command', '/bin/true')
  // A concurrent editor moved the namespace before Save; the adapter reports
  // the official conflict at the pinned revision.
  h.configuration.outcome = (ops, revision) => revision === 2
    ? { kind: 'failed', failure: { kind: 'conflict', reason: 'changed since it was read' } }
    : { kind: 'saved', revision: 4 }
  h.controller.saveEditor()
  await h.flush()
  assert.equal(h.configuration.mutations.length, 1)
  assert.equal(h.configuration.mutations[0]?.revision, 2, 'the pinned revision is submitted verbatim')
  assert.equal(h.controller.snapshot().configStatus?.kind, 'conflict')
})

test('a second Save while a write is in flight dispatches nothing', async () => {
  const h = await readyHarness([{ name: 'mine', provenance: 'user-added', effective: stdioEffective() }])
  let release!: (outcome: McpConfigWriteOutcome) => void
  h.configuration.outcome = () => new Promise<McpConfigWriteOutcome>(resolve => { release = resolve }) as never
  h.controller.beginEdit()
  h.controller.setEditorField('command', '/bin/true')
  h.controller.saveEditor()
  assert.equal(h.controller.snapshot().configStatus?.kind, 'saving')
  h.controller.saveEditor()
  await h.flush()
  assert.equal(h.configuration.mutations.length, 1, 'one write at a time')
  release({ kind: 'saved', revision: 4 })
  await h.flush()
  assert.equal(h.controller.snapshot().configStatus?.kind, 'saved')
})

test('an unconfirmed write is never replayed and never reported as saved', async () => {
  const h = await readyHarness([{ name: 'mine', provenance: 'user-added', effective: stdioEffective() }])
  h.configuration.outcome = () => ({ kind: 'failed', failure: { kind: 'outcome-unconfirmed', reason: 'ack lost' } })
  h.controller.beginToggle()
  assert.equal(h.controller.snapshot().configConfirm?.nextEnabled, false, 'enabled true -> the toggle writes false')
  h.controller.answerConfigConfirm(true)
  await h.flush()
  assert.equal(h.configuration.mutations.length, 1)
  assert.equal(h.controller.snapshot().configStatus?.kind, 'unconfirmed')
  assert.match(h.controller.snapshot().configStatus?.text ?? '', /Outcome unconfirmed/u)
  assert.doesNotMatch(h.controller.snapshot().configStatus?.text ?? '', /Saved/u)
})

test('an invalid draft is refused before any dispatch', async () => {
  const h = await readyHarness([], 1)
  h.controller.beginAdd()
  h.controller.setEditorField('name', 'bad name')
  h.controller.setEditorField('command', '')
  h.controller.saveEditor()
  await h.flush()
  assert.equal(h.configuration.mutations.length, 0)
  assert.equal(h.controller.snapshot().configStatus?.kind, 'rejected')
  assert.equal(h.controller.snapshot().editor?.issues.length, 2, 'name + command issues are both reported')
})

test('a discarded draft performs zero writes and leaves no editor', async () => {
  const h = await readyHarness([{ name: 'mine', provenance: 'user-added', effective: stdioEffective() }])
  h.controller.beginEdit()
  h.controller.setEditorField('command', '/bin/true')
  assert.equal(h.controller.editorDirty(), true)
  h.controller.discardEditor()
  assert.equal(h.controller.snapshot().editor, undefined)
  await h.flush()
  assert.equal(h.configuration.mutations.length, 0)
})

test('a dispatched write settles into the page even after the roster stays current', async () => {
  const h = await readyHarness([{ name: 'mine', provenance: 'user-added', effective: stdioEffective() }])
  h.controller.beginToggle()
  h.controller.answerConfigConfirm(true)
  await h.flush()
  // Saved is a CONFIG fact; the FR3 status of the roster is untouched.
  assert.equal(h.controller.snapshot().configStatus?.kind, 'saved')
  assert.equal(h.controller.snapshot().rows[0]?.status.state, 'connected')
})
