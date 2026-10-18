/**
 * S2/PR-B §B1 / S2-16 — the rc.2 external catalog leaf on the REAL Task Center
 * path (L6), produced by the OFFICIAL subagent runtime.
 *
 * SOURCE → DECISION → SINK: a REAL parent-delivery activation
 * (`ctx.subagents.startActivation({ delivery: 'parent' })` with a registered
 * external provider) makes the official manager append the parent-owned
 * `subagent/catalog` fact (`mode: 'external'`); the official
 * `ctx.subagents.listDescendants` reads it back through the registered
 * `subagentCatalog` projection, and the REAL Task Center paints the row with
 * its durable classification and NEVER opens a viewer, offers Stop/Continue, or
 * presents a local child it does not have.
 *
 * EVIDENCE BOUNDARY: the row and its Detail are asserted on the PAINTED frame
 * at all three sizes; the action bar advertises no `s stop` for that row (and
 * `s` latches nothing); Enter's refusal is asserted on the production notice
 * slot while the panel is open and on the PAINTED frame right after the user
 * closes it (the panel paints over the notice row while it is open).
 *
 * FIXTURE (real): the official agent-loop testkit, the official JSONL
 * persistence, the real session-query engine, the official subagent runtime,
 * the real runner and the real `/tasks` path. The ONLY stand-in is the external
 * provider BACKEND (S2 owns no external subagent backend) — the hand-off, the
 * catalog fact, the projection, the traversal and the row are production code.
 * No LLM adapter is registered, so the parent-delivery NOTIFICATION's model turn
 * ends in the official `NO_ADAPTER` error on the transcript: that is the
 * documented parent-delivery contract, not part of the catalog/row evidence.
 *
 * @module @xmoon76/dsh-pi-tui/task-center-external-leaf.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { NO_START_CAPABILITIES, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { visibleWidth } from '@xmoon76/pi-tui'
import { apply as applyRunner, Config as TuiConfigSchema } from '../src/index.ts'
import { TUI_STARTUP_SERVICE } from '../src/startup.ts'
import {
  disposeContext,
  installVirtualProcessTerminal,
  makeHarness,
  settle,
} from './support/runner-harness.ts'
import { installProbe } from './support/runner-session-fixtures.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const SESSION = SessionId('session-external-parent')
/** The provider-minted external run identity (no local child Session exists). */
const EXTERNAL_RUN = SessionId('fixture-external-run')
const LABEL = 'external run'
/** The one refusal the external row's Enter states. */
const REFUSAL = 'external subagent: no local session to open'

const SIZES = [[120, 40], [80, 10], [44, 20]] as const

for (const [columns, rows] of SIZES) test(`the REAL Task Center external leaf from the OFFICIAL parent-delivery activation at ${columns}x${rows}`, async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-pi-tui-external-leaf-')
  const home = life.tempDir('dsh-pi-tui-external-leaf-home-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(columns, rows)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)

  // ── Boot 1: the real parent Session artifact ──
  const first = new Context()
  life.defer(() => disposeContext(first))
  await mountAgentLoopTestDependencies(first, { workingDirectory: true })
  await first.plugin(JsonlSessionPersistence, { root })
  const createPersistence = first.get('sessionPersistence') as unknown as {
    create(init: Record<string, unknown>): Promise<{ flush(): Promise<void>; close(): Promise<void> }>
  }
  const parentArtifact = await createPersistence.create({
    id: SESSION,
    createdAt: 1_700_000_000_000,
    version: SESSION_FORMAT_VERSION,
    cwd: home,
    isSeeded: false,
    delegationDepth: 0,
  })
  await parentArtifact.flush()
  await parentArtifact.close()
  await first.fiber.dispose()

  // ── Boot 2: the real stack + the OFFICIAL subagent runtime ──
  const context = new Context()
  life.defer(() => disposeContext(context))
  await mountAgentLoopTestDependencies(context, { workingDirectory: true })
  await context.plugin(JsonlSessionPersistence, { root })
  await context.inject(SqliteSessionQueryEngine.inject, queryCtx => {
    new SqliteSessionQueryEngine(queryCtx, { path: ':memory:', openAt: 'first-search' })
  })
  // The official producer under test: it registers the `subagentCatalog`
  // projection and owns the activation/monitor path the TUI consumes.
  await context.plugin(SubagentRuntime)
  context.provide('appExit', () => {})
  context.provide(TUI_STARTUP_SERVICE, { sessionId: String(SESSION), shippedPresetRoot: home } as never)
  await context.plugin(CommandRuntime)
  const peripherals = makeHarness(home, [], { provider: 'p', model: 'm' })
  context.provide('loader', { await: async () => {} } as never)
  await mountAgentLoopTestHarness(context)
  context.provide('agentDefaultModel', peripherals.defaultModel as never)
  const fiber = await context.plugin(pluginCtx => applyRunner(pluginCtx, TuiConfigSchema({ sessionId: String(SESSION) } as never)))
  life.defer(() => fiber.dispose())
  const view = (): string => vt.getViewport().map(line => line.replace(/\u001b\[[0-9;]*m/g, '')).join('\n')
  for (let attempt = 0; attempt < 80 && !view().includes('dsh-pi-tui'); attempt += 1) {
    await settle()
    await new Promise(resolve => setTimeout(resolve, 25))
    await vt.waitForRender()
  }
  assert.match(view(), /dsh-pi-tui/u, `the real runner painted:\n${view()}`)

  // ── The OFFICIAL producer: one parent-delivery external activation ──
  const agents = context.get('agents') as unknown as { get(id: unknown): unknown }
  const parent = agents.get(SESSION)
  assert.ok(parent !== undefined, 'the resumed parent Session has an exact live agent')
  const subagents = context.get('subagents') as unknown as {
    registerProvider(provider: unknown): () => void
    startActivation(spec: unknown): Promise<{ readonly childId: unknown; dispose(): Promise<void> }>
    listDescendants(id: unknown, signal?: AbortSignal): Promise<readonly { readonly id: unknown; readonly label?: string; readonly mode?: string }[]>
  }
  life.defer(subagents.registerProvider({
    name: 'fixture-external',
    capabilities: NO_START_CAPABILITIES,
    inheritsParentContext: false,
    // The only stand-in: S2 owns no external backend. Everything after this
    // hand-off (catalog fact, projection, traversal, row) is production code.
    start: async () => ({
      id: EXTERNAL_RUN,
      result: Promise.resolve({ output: [], stopReason: 'completed' as const }),
      dispose: async () => {},
    }),
  }))
  const activation = await subagents.startActivation({
    provider: 'fixture-external',
    label: LABEL,
    request: { parent, prompt: [{ type: 'text', text: 'run the external task' }] },
    signal: new AbortController().signal,
    delivery: 'parent',
  })
  life.defer(() => activation.dispose())
  assert.equal(String(activation.childId), String(EXTERNAL_RUN), 'the provider owns the external identity')

  // The official traversal publishes the parent-owned external entry — no local
  // child Session exists for it.
  const descendants = await subagents.listDescendants(SESSION)
  assert.ok(descendants.some(entry => entry.mode === 'external' && entry.label === LABEL),
    `the official catalog carries the external entry: ${JSON.stringify(descendants)}`)
  assert.ok(!(context.get('sessions') as unknown as { get(id: unknown): unknown }).get(EXTERNAL_RUN),
    'the external execution has no local child Session')

  // ── The real Task Center over that official catalog ──
  vt.sendInput('/tasks')
  await settle()
  await vt.waitForRender()
  vt.sendInput('\r')
  await settle()
  await vt.waitForRender()
  for (let attempt = 0; attempt < 40 && !view().includes(LABEL); attempt += 1) {
    await settle()
    await new Promise(resolve => setTimeout(resolve, 25))
    await vt.waitForRender()
  }
  const frame = view()
  for (const line of vt.getViewport()) {
    assert.ok(visibleWidth(line) <= columns, `no frame row overflows ${columns} cells: ${JSON.stringify(line)}`)
  }
  // The roster FACT is the same at every size: the official catalog entry is
  // known to the Task Center (narrow grants paint fewer rows, never fewer
  // facts). The row itself and its durable classification stay DISCERNIBLE at
  // the frozen narrow sizes (the label truncates, `external`/`External` do not).
  assert.match(frame, /1\/1 shown/u, `the Task Center knows the external entry:\n${frame}`)
  assert.ok(frame.includes(LABEL) || frame.includes('exte'),
    `the external row is painted at ${columns} columns:\n${frame}`)
  assert.match(frame, /External/u, `the classification word is painted at ${columns} columns:\n${frame}`)
  if (columns >= 120) {
    assert.match(frame, /external · external run/u, `the external leaf is listed with its classification:\n${frame}`)
    assert.match(frame, /mode\s+external/u, `the Detail states the mode:\n${frame}`)
    assert.match(frame, /activity\s+External/u, 'the Detail states the activity word')
  }

  // The action bar advertises the SELECTED row's capability: the external leaf
  // cannot be stopped (`canStop === false`), so no Stop hint may be painted and
  // pressing `s` must never latch the stop confirmation.
  assert.ok(!/\bs stop\b/u.test(frame), `the non-stoppable external row advertises no Stop hint:\n${frame}`)
  vt.sendInput('s')
  await settle()
  await new Promise(resolve => setTimeout(resolve, 30))
  await vt.waitForRender()
  assert.doesNotMatch(view(), /Y confirm stop/u, `pressing s on the external row latches nothing:\n${view()}`)

  // Enter: the external leaf is not openable and mounts nothing. The refusal is
  // a NOTICE; it shares the frame with the capturing Task Center panel (the
  // panel paints over the notice row while it is open — a pre-existing layout
  // fact of two independent surfaces), so the PAINTED witness below is read
  // right after the user closes the panel: that is what this assertion records.
  // While the panel is open the notice is only in the production slot (asserted
  // here, never presented as a painted fact).
  const viewersBefore = probe.apps.length
  vt.sendInput('\r')
  await settle()
  await new Promise(resolve => setTimeout(resolve, 40))
  await vt.waitForRender()
  const noticeText = (probe.apps.at(-1) as unknown as {
    currentNotice?: () => { readonly text: string } | undefined
  }).currentNotice?.()?.text
  assert.equal(noticeText, REFUSAL, `Enter states why nothing opened at ${columns}x${rows}`)
  assert.equal(probe.apps.length, viewersBefore, 'no second surface was mounted')
  vt.sendInput('\x1b')
  await settle()
  await new Promise(resolve => setTimeout(resolve, 60))
  await vt.waitForRender()
  const after = view()
  for (const line of vt.getViewport()) {
    assert.ok(visibleWidth(line) <= columns, `no refused frame row overflows ${columns} cells: ${JSON.stringify(line)}`)
  }
  const painted = after.split('\n').map(line => line.trim())
  // The refusal REASON must be readable, not just its prefix: the measured
  // 44-column frame wraps it into `external subagent: no local session to` /
  // `open`, so the asserted fragment is the part every size keeps on screen.
  assert.ok(painted.some(line => line.includes('no local session')),
    `the painted refusal states its reason at ${columns} columns:\n${after}`)
  if (columns >= 120) {
    assert.ok(after.includes(REFUSAL), `the wide notice line paints the whole refusal:\n${after}`)
  }
})
