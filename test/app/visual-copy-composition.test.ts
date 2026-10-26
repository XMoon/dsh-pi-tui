/**
 * The Direct display `/copy` end-to-end composition:
 *
 * ```text
 * real applyRunner bootstrap -> real CommandRuntime/Surface -> real Direct
 * presentation bridge (official latest assistant/message + same-Session Folder
 * settlement + PR1 publications + shared placement) -> real /copy handler ->
 * real Client clipboard policy -> terminal OSC 52 bytes
 * ```
 *
 * The Session/Agent and the command registry are TEST PREREQUISITES (the same
 * harness family as `export-command.test.ts`): the model is scripted and the
 * Host services are structural fakes. Everything between the official event
 * log and the terminal-bound clipboard bytes is the production composition.
 * NOT covered: a physical terminal's clipboard ACK (OSC 52 has none) or a real
 * model run.
 * @module @xmoon76/dsh-pi-tui/app/visual-copy-composition.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { ProcessTerminal } from '@xmoon76/pi-tui'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { installVirtualProcessTerminal } from '../support/runner-harness.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { apply as applyRunner, Config as TuiConfigSchema } from '../../src/index.ts'
import { TUI_STARTUP_SERVICE } from '../../src/startup.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { chartContentBlocks, chartFactFromArgs, type ChartArgs } from '../../src/domain/visual/chart.ts'
import { visualReference, visualReferenceLine } from '../../src/domain/visual/reference.ts'
import { VISUAL_PUBLISHED_PREFIX } from '../../src/domain/transcript/visual-text.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

const SESSION_ID = 'session-copy-composition'
const CHART: ChartArgs = {
  kind: 'bars',
  title: 'Request latency',
  unit: 'ms',
  series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
}
const ANSWER_BEFORE = 'BEFORE-COPY'
const ANSWER_AFTER = 'AFTER-COPY'

/** The official committed log: generate, publish, then the final answer. */
function officialLog(): { events: SessionEvent[]; markerRef: string } {
  const events: SessionEvent[] = []
  const push = (type: string, data: unknown, surfaceOp?: 'append'): void => {
    const seq = events.length
    events.push({ type, seq: SessionSeq(seq), time: 1_700_000_000_000 + seq, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) } as SessionEvent)
  }
  push('turn/start', { turn: 1 })
  push('step/start', { turn: 1, step: 0 })
  push('assistant/message', {
    turn: 1,
    step: 0,
    message: {
      id: MessageId('assistant-0'),
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'chart-call', name: 'dsh_pi_tui_chart', arguments: JSON.stringify(CHART) }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    stream: [],
    usage: { inputTokens: 1, outputTokens: 1 },
  }, 'append')
  push('tool/call', { turn: 1, step: 0, callId: 'chart-call', name: 'dsh_pi_tui_chart', arguments: JSON.stringify(CHART) })
  const ref = visualReference({ sessionId: SESSION_ID, turn: 1, stepStartSeq: 1, callId: 'chart-call' })
  const chartBlocks = chartContentBlocks(chartFactFromArgs(CHART))
  push('tool/result', {
    turn: 1,
    step: 0,
    message: {
      toolCallId: 'chart-call',
      isError: false,
      content: [
        ...chartBlocks.slice(0, -1),
        { type: 'text', text: visualReferenceLine(ref) },
        chartBlocks[chartBlocks.length - 1] as ContentBlock,
      ],
    },
  })
  push('step/end', { turn: 1, step: 0 })
  push('step/start', { turn: 1, step: 1 })
  push('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: MessageId('assistant-1'),
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'present-call', name: 'present_visual', arguments: JSON.stringify({ visuals: [{ ref }] }) }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    stream: [],
    usage: { inputTokens: 1, outputTokens: 1 },
  }, 'append')
  push('tool/call', {
    turn: 1, step: 1, callId: 'present-call', name: 'present_visual', arguments: JSON.stringify({ visuals: [{ ref }] }),
  })
  push('tool/result', {
    turn: 1,
    step: 1,
    message: {
      toolCallId: 'present-call',
      isError: false,
      content: [
        { type: 'text', text: 'Selected 1 visual for presentation.' },
        {
          type: 'text',
          text: `${VISUAL_PUBLISHED_PREFIX}${JSON.stringify({ version: 1, published: [{ ref }] })}`,
        },
      ],
    },
  })
  push('step/end', { turn: 1, step: 1 })
  push('step/start', { turn: 1, step: 2 })
  push('assistant/message', {
    turn: 1,
    step: 2,
    message: {
      id: MessageId('assistant-2'),
      role: 'assistant',
      content: [{ type: 'text', text: `${ANSWER_BEFORE}\n\n[dsh-visual-${ref}]: <#>\n\n${ANSWER_AFTER}` }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    stream: [],
    usage: { inputTokens: 1, outputTokens: 1 },
  }, 'append')
  push('step/end', { turn: 1, step: 2 })
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return { events, markerRef: ref }
}

/** The minimal Host-service stand-ins the real runner composition consumes. */
function makeHarness(home: string, events: readonly SessionEvent[]) {
  const header = { id: SESSION_ID, cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION }
  const session = {
    id: SESSION_ID,
    header,
    seq: events.length,
    snapshotEvents: () => events,
    eventAt: (seq: number) => events[Number(seq)],
    requestHeader: () => header,
    append: () => ({ seq: SessionSeq(events.length) }),
  }
  const live = new Map<string, Agent>()
  const makeHandle = (): { agent: Agent; dispose: () => Promise<void> } => {
    const agent = {
      session,
      ctx: { get: () => undefined, on: () => () => {} },
      options: { provider: 'p', model: 'm', cwd: home },
      status: 'idle',
      inbox: { nextTurn: [], nextStep: [] },
      whenIdle: async () => {},
      cancel: () => {},
    } as unknown as Agent
    live.set(SESSION_ID, agent)
    return { agent, dispose: async () => { live.delete(SESSION_ID) } }
  }
  const persistence = {
    list: async () => [header],
    inspect: async () => ({ meta: header, events }),
  }
  const sessionQuery = {
    listSessions: async () => [{ header, live: live.has(SESSION_ID) }],
    observeSession: async () => ({ header, events, [Symbol.dispose]: () => {} }),
  }
  const agents = {
    resume: async () => makeHandle(),
    create: async () => makeHandle(),
    get: (id: string) => live.get(id),
  }
  const sessions = {
    flush: async () => {},
    get: (id: string) => live.get(id)?.session,
  }
  const defaultModel = {
    currentSelection: () => ({ provider: 'p', model: 'm' }),
    saveSelection: async () => {},
  }
  const llm = {
    listProviders: () => [{ id: 'p', name: 'provider p' }],
    listModels: async () => [{ id: 'm1' }, { id: 'm2' }],
    resolveModelInfo: async () => ({}),
    discoverModels: async () => [],
    listConfigurableProviders: () => [],
  }
  const definitions = new Map<string, { name: string; description: string; definitionId?: string; handler?: (...args: never[]) => unknown }>()
  const commands = {
    register: (definition: { name: string; description: string; definitionId?: string; handler?: (...args: never[]) => unknown }) => {
      definitions.set(definition.name, definition)
      return () => {
        if (definitions.get(definition.name) === definition) definitions.delete(definition.name)
      }
    },
    list: () => [...definitions.values()].map(({ name, description, definitionId }) => ({
      name, description, ...(definitionId === undefined ? {} : { definitionId }),
    })),
    execute: async () => ({ result: { kind: 'success' as const } }),
    handler: (name: string) => definitions.get(name)?.handler,
  }
  return { persistence, sessionQuery, agents, sessions, defaultModel, llm, commands, live }
}

/** Drain the composition's microtask chain to its current quiescent point.
 *  This is NOT a fixed wait: no timer is armed and no wall clock is spent. */
async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 80; index += 1) await Promise.resolve()
}

/** Record every TuiApp the production runner creates (the export-test probe). */
function installAppProbe(): { apps: TuiApp[]; restore: () => void } {
  const apps: TuiApp[] = []
  const originalStart = TuiApp.prototype.start
  TuiApp.prototype.start = function (this: TuiApp) {
    apps.push(this)
    return originalStart.apply(this)
  }
  return {
    apps,
    restore: () => { TuiApp.prototype.start = originalStart },
  }
}

async function disposeContext(ctx: Context): Promise<void> {
  for (const runtime of [...ctx.registry.values()]) {
    for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
  }
}

async function mountRunner(
  life: TestLifecycle,
  home: string,
  harness: ReturnType<typeof makeHarness>,
): Promise<{ vt: VirtualTerminal; app: TuiApp; commands: ReturnType<typeof makeHarness>['commands'] }> {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installAppProbe()
  life.defer(probe.restore)
  const vt = new VirtualTerminal(100, 30)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const ctx = new Context()
  life.defer(() => { void disposeContext(ctx) })
  ctx.provide('appExit', () => {})
  ctx.provide(TUI_STARTUP_SERVICE, { sessionId: SESSION_ID, shippedPresetRoot: home })
  ctx.provide('sessionPersistence', harness.persistence as never)
  ctx.provide('sessionQuery', harness.sessionQuery as never)
  ctx.provide('agents', harness.agents as never)
  ctx.provide('sessions', harness.sessions as never)
  ctx.provide('agentDefaultModel', harness.defaultModel as never)
  ctx.provide('llm', harness.llm as never)
  ctx.provide('commands', harness.commands as never)
  ctx.provide('loader', { await: async () => {} } as never)
  const fiber = ctx.plugin((pluginCtx) => applyRunner(pluginCtx, TuiConfigSchema({ sessionId: SESSION_ID, fullscreen: 'off' } as never)))
  await fiber
  await drainMicrotasks()
  life.defer(() => fiber.dispose())
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  startedApps.add(app)
  return { vt, app, commands: harness.commands }
}

/** Wait for the real painted frame to carry the hydrated answer. */
async function waitForAnswer(vt: VirtualTerminal): Promise<string> {
  for (let round = 0; round < 80; round += 1) {
    await drainMicrotasks()
    const view = vt.getViewport().join('\n')
    if (view.includes(ANSWER_BEFORE)) return view
    // Yield ONE macrotask so the fork's scheduled frame can run; no delay.
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.fail(`the hydrated answer never painted:\n${vt.getViewport().join('\n')}`)
}

/** Decode the FIRST terminal-client OSC 52 clipboard payload from raw writes. */
function osc52Payload(writes: readonly string[]): string | undefined {
  const match = /\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/u.exec(writes.join(''))
  return match?.[1] === undefined ? undefined : Buffer.from(match[1], 'base64').toString('utf8')
}

test('the real /copy command copies the display body through the production bridge and clipboard policy', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-copy-composition-')
  const { events } = officialLog()
  const harness = makeHarness(home, events)
  const { vt, commands } = await mountRunner(life, home, harness)
  await waitForAnswer(vt)
  for (let round = 0; round < 40 && commands.handler('copy') === undefined; round += 1) await drainMicrotasks()
  const handler = commands.handler('copy')
  assert.ok(handler !== undefined, 'the real /copy command was registered by the live-session composition')

  // The production clipboard policy writes through process.stdout (the OSC 52
  // terminal-client leg); capture that real sink for this invocation.
  const writes: string[] = []
  const originalWrite = process.stdout.write
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stdout.write
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  try {
    const result = await handler({ rawInput: '' } as never)
    assert.deepEqual(result, { kind: 'success', text: 'copied last assistant message' })
  } finally {
    process.stdout.write = originalWrite
    if (originalIsTTY === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY
    else Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
  }
  assert.equal(
    osc52Payload(writes),
    `${ANSWER_BEFORE}\n\n\n\n${ANSWER_AFTER}`,
    'the terminal payload is the display body: only the consumed marker span is gone',
  )
  assert.notEqual(osc52Payload(writes), `${ANSWER_BEFORE}\n\n[dsh-visual-`, 'the raw marker line is never copied')
})
