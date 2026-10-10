/**
 * M3-5 PR2 L6 qualification (plan §11 reachability map, §14 L6, §5 Must 22):
 * the REAL Remote application composition driving the REAL Task Center →
 * child row → REAL Remote child viewer over the same rc.2 Host/Client graph
 * the M3-4 presentation L6 harness (`test/runner-remote-presentation.test.ts`,
 * imported here — never a second graph) already proves.
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 * - the ordinary rc.2 Host base services required by Session/Subagent/
 *   Jobs/attachments (the shared `remote-application-fixture`), plus the
 *   whole-log projection rows the presentation harness mounts
 * - the real `@deepseek-ai/dsh-subagent` Host service, whose plugin
 *   registration is what makes the official `subagentCatalog` /
 *   `subagent` (identity) Session projections readable over the wire
 * - REAL durable parent/child catalog facts: parent Sessions carrying
 *   `subagent/catalog` SessionEvents, child Sessions carrying their own
 *   `subagent/descriptor` and `subagent/catalog` (the nested grandchild)
 * - the official Client/Gateway path over the real in-process carrier and
 *   the REAL runner composition root (`app/bootstrap.ts`) through the
 *   production selection seam (a pre-selected aggregate)
 *
 * TEST STAND-INS / SUBSTITUTIONS
 * - `HoldingAdapter`: a scripted real `LlmAdapter` whose `stream` can be held
 *   open — the Host emits REAL `agent/status` transitions, the wire forwards
 *   them, and the Client Session list gains the running fact from them
 * - the shared fixture's prompt serializer (unsupported): no proof here
 *   submits a Remote prompt
 * - the virtual terminal (UI bytes are observed but are not the subject)
 *
 * DELIBERATELY ABSENT
 * - a public Remote selector
 * - PR3 Job detail/Stop surface (Remote Job rows stay status rows)
 *
 * USER-REACHABLE SURFACES EXERCISED: `/tasks` full Task Center (rows, tree
 * disclosure), the interactive direct continuable child viewer, the read-only
 * one-shot and nested viewers, Esc return, the child's own pending-input
 * subject, a viewer follow-up through the official child inbox, the durable
 * image row inside the child transcript (its bytes read through the CHILD
 * Session), and PageUp history extension inside the child viewer.
 *
 * REGRESSION LOCK (this was an observed divergence, now fixed in `src/**`):
 * the rendered Task-Center row activity and the dock/agents badge follow the
 * official Session-LIST `running` fact for UNRETAINED children. The Remote
 * `activityOf` reads `sessions.list.getSnapshot().byId[id].running`, and the
 * bootstrap delegates to it, so listing still retains nothing while the row
 * and `StatusStore.activity.childAgentCount` converge. The mutation-teeth test
 * stubs the OLD binding-requiring fact (which resolved `undefined` for an
 * unretained child) and proves the rendered-`running` assertion actually fails
 * without the fix.
 *
 * REGRESSION LOCKS for the F1/F7 viewer-lifecycle fixes (also `src/**`): the
 * image loader captures the ASKING display subject synchronously at `load()`,
 * so a same-tick viewer exit cannot re-route a child-only image to the parent;
 * and the ended viewer cancels a still-pending child open and releases the
 * mounted viewer's `tuiChildView` Client generation at surface teardown.
 *
 * NEGATIVE CONTROLS (§14 step 14 + cross-subject residue): a main-Session
 * switch started while a child open is still pending commits nothing into the
 * replacement surface and releases the swapped-out child generation; the child
 * viewer never falls back to parent facts its own Session lacks; and child A →
 * child B (and back) leaves no transcript/workspace/subject/generation residue.
 *
 * @module @xmoon76/dsh-pi-tui/runner-remote-task-center.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { MessageId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { RemoteTransportLifetime } from '../src/app/application-runtime.ts'
import { mountRemotePresentationHost, mountRemoteRunner } from './runner-remote-presentation.test.ts'
import { waitFor } from './support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

/** The one fixture preset id. */
const PRESET_ID = 'm3-5-pr2-task-center'
const PARENT_ID = 'm3-5-pr2-parent'
const CHILD_A_ID = 'm3-5-pr2-child-a'
const CHILD_B_ID = 'm3-5-pr2-child-b'
const CHILD_C_ID = 'm3-5-pr2-child-c'
/** Distinct workspace directories, so a rendered cwd discriminates subjects. */
const CHILD_A_DIR = 'a-ws'
const CHILD_B_DIR = 'b-ws'
const CHILD_C_DIR = 'c-ws'

/** Labels that CARRY the durable child id, so a rendered row proves the exact
 *  Remote descendant identity (the panel renders `subagent · <label>`). */
const LABEL_A = `child A ${CHILD_A_ID}`
const LABEL_B = `child B ${CHILD_B_ID}`
const LABEL_C = `child C ${CHILD_C_ID}`

/** The LLM endpoint stand-in whose turn can be HELD open: the Host agent
 *  enters its official `running` status and stays there until released. */
class HoldingAdapter extends LlmAdapter {
  private gate: Promise<void> | undefined
  private openGate: (() => void) | undefined

  /** Hold every subsequent turn open; returns the release (idempotent). */
  hold(): () => void {
    this.gate = new Promise<void>(resolve => { this.openGate = resolve })
    return () => {
      const open = this.openGate
      this.gate = undefined
      this.openGate = undefined
      open?.()
    }
  }

  override listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>> {
    return Promise.resolve([{ provider, id: 'smoke', name: 'Smoke Model' }])
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const gate = this.gate
    if (gate !== undefined) await gate
    options.signal?.throwIfAborted()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'held reply' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'held reply' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

type Append = (type: string, data: unknown, options?: { surfaceOp?: 'append' }) => void

/** The real Host Session appender (the same primitive the fixture suites use). */
function appenderOf(ctx: Context, sessionId: string): Append {
  const session = ctx.sessions.get(SessionId(sessionId)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  return (type, data, options) => session.append(type, data, options)
}

/** Seed N completed durable turns on one real Host Session log. */
function seedTurns(append: Append, from: number, to: number, label: string): void {
  for (let turn = from; turn <= to; turn++) {
    append('turn/start', { turn })
    append('step/start', { turn, step: 1 })
    append('user/message', {
      id: `u-${label}-${turn}`, role: 'user', content: [{ type: 'text', text: `${label} prompt ${turn}` }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    append('assistant/message', {
      turn, step: 1,
      message: { id: `a-${label}-${turn}`, role: 'assistant', content: [{ type: 'text', text: `${label} answer ${turn}` }], source: { kind: 'model', provider: 'smoke', model: 'smoke' } },
      stream: [], usage: { inputTokens: 1, outputTokens: 1 },
    }, { surfaceOp: 'append' })
    append('step/end', { turn, step: 1 })
    append('turn/end', { turn, reason: { kind: 'completed' } })
  }
}

/** The structural faces this suite drives on the mounted TuiApp / Client. */
interface MountedApp {
  setDraft(text: string): void
  getDraft(): string
  submitDraft(): void
  getViewerGeneration(): number
  pendingInputForTest(): { queued: ReadonlyArray<{ text?: string }>; tail: ReadonlyArray<{ row?: { text?: string } }> }
  setFullscreen(on: boolean): void
  scrollToTop(options?: { disableFollow?: boolean }): void
  /** The private presentation-scope provider (read through the structural escape
   *  hatch; the same value a child thumbnail would be stamped with). */
  readonly imageScope?: () => unknown
  statusStore: {
    snapshot(): {
      view?: { subject?: { kind?: string; id?: string; label?: string; mode?: string; activity?: string } }
      workspace?: { cwd?: string; project?: string }
      activity?: { childAgentCount?: number; todoCount?: number }
      usage?: { turns?: number; steps?: number }
    }
  }
  /** The viewer subject bar's rendered rows (the child-identity chrome). */
  viewerSubjectBarRenderRowsForTest(): readonly string[]
}

interface ChildBinding {
  readonly session: {
    beginSubmission(input: { mode: 'queue' | 'steer'; text: string; attachments: readonly unknown[] }): { requestId: unknown }
    getSnapshot(): { readonly pendingSubmissions: ReadonlyArray<{ readonly text: string }>; readonly running: boolean }
  }
}

interface ClientSessions {
  binding(id: unknown): ChildBinding | undefined
  list: { getSnapshot(): { byId: Readonly<Record<string, { running?: boolean } | undefined>> } }
}

interface TaskCenterFixture {
  readonly host: Awaited<ReturnType<typeof mountRemotePresentationHost>>
  readonly fixture: Awaited<ReturnType<typeof mountRemoteRunner>>
  readonly app: MountedApp
  readonly sessions: ClientSessions
  /** The mounted viewport text joined (the user-visible surface). */
  viewport(): string
}

/**
 * Build the L6 fixture: the real Remote graph (presentation harness) over a
 * parent Session with two direct children (continuable A, one-shot B) and one
 * nested grandchild C under A, all carrying REAL durable catalog facts.
 */
async function mountTaskCenterFixture(
  life: TestLifecycle,
  options: { readonly adapter?: HoldingAdapter } = {},
): Promise<TaskCenterFixture> {
  const host = await mountRemotePresentationHost(life, PRESET_ID, options.adapter === undefined
    ? {}
    : { llmAdapter: options.adapter })
  // The REAL Host subagent service: its plugin registration is the authority
  // that makes the `subagentCatalog` / `subagent` projections readable over
  // the official wire (the same row the production base patch mounts).
  const SubagentRuntime = (await import('@deepseek-ai/dsh-subagent')).default
  await host.ctx.plugin(SubagentRuntime as never, { maxDepth: 3 } as never)
  const { snapshotSubagentDescriptor } = await import('@deepseek-ai/dsh-subagent')

  const parentCwd = host.anchorDir
  const childCwd = (dir: string): string => {
    const path = join(host.anchorDir, dir)
    mkdirSync(path, { recursive: true })
    return path
  }
  const aCwd = childCwd(CHILD_A_DIR)
  const bCwd = childCwd(CHILD_B_DIR)
  const cCwd = childCwd(CHILD_C_DIR)
  // A child Session header carries the durable subagent lineage the official
  // Session controller requires to route a child by its direct-parent address
  // (`origin: 'subagent'` + `parentSession`).
  const childMeta = (parentSessionId: string, cwd: string) =>
    ({ cwd, parentSession: SessionId(parentSessionId), origin: 'subagent' }) as never

  await host.harness.create(SessionId(PARENT_ID), { provider: 'smoke', model: 'smoke' } as never, { cwd: parentCwd })
  await host.harness.create(SessionId(CHILD_A_ID), { provider: 'smoke', model: 'smoke' } as never, childMeta(PARENT_ID, aCwd))
  await host.harness.create(SessionId(CHILD_B_ID), { provider: 'smoke', model: 'smoke' } as never, childMeta(PARENT_ID, bCwd))
  await host.harness.create(SessionId(CHILD_C_ID), { provider: 'smoke', model: 'smoke' } as never, childMeta(CHILD_A_ID, cCwd))

  const parentAppend = appenderOf(host.ctx, PARENT_ID)
  const aAppend = appenderOf(host.ctx, CHILD_A_ID)
  // The child's durable identity/classification (the official descriptor the
  // establishing provider appends). A child without it cannot be classified.
  aAppend('subagent/descriptor', snapshotSubagentDescriptor({ mode: 'continuable', provider: 'fixture', label: LABEL_A }))
  appenderOf(host.ctx, CHILD_B_ID)('subagent/descriptor', snapshotSubagentDescriptor({ mode: 'one-shot', provider: 'fixture', label: LABEL_B }))
  appenderOf(host.ctx, CHILD_C_ID)('subagent/descriptor', snapshotSubagentDescriptor({ mode: 'continuable', provider: 'fixture', label: LABEL_C }))
  seedTurns(parentAppend, 1, 2, 'parent')
  // Child A carries enough turns that the official opening window truncates
  // (the child-viewer paging proof needs a real older page).
  seedTurns(aAppend, 1, 30, 'childa')
  seedTurns(appenderOf(host.ctx, CHILD_B_ID), 1, 2, 'childb')
  seedTurns(appenderOf(host.ctx, CHILD_C_ID), 1, 2, 'childc')
  // The parent-owned discovery facts: direct children A and B on the parent,
  // the nested C on child A (the recursive-walk input).
  parentAppend('subagent/catalog', { version: 1, childId: CHILD_A_ID, childCreatedAt: 4_001, mode: 'continuable', label: LABEL_A })
  parentAppend('subagent/catalog', { version: 1, childId: CHILD_B_ID, childCreatedAt: 4_002, mode: 'one-shot', label: LABEL_B })
  aAppend('subagent/catalog', { version: 1, childId: CHILD_C_ID, childCreatedAt: 4_003, mode: 'continuable', label: LABEL_C })

  const fixture = await mountRemoteRunner(life, { presetId: PRESET_ID, resumeSessionId: PARENT_ID, host })
  await waitFor('the parent transcript hydrated', () => fixture.vt.getViewport().join('').includes('parent answer 2'), 20_000)
  const app = fixture.runnerApp() as unknown as MountedApp
  assert.ok(app !== undefined, 'the production runner must create a TuiApp')
  return {
    host,
    fixture,
    app,
    sessions: fixture.aggregate.wire.client.sessions as unknown as ClientSessions,
    viewport: () => fixture.vt.getViewport().join('\n'),
  }
}

/** Submit one line through the REAL mounted surface (the production gesture). */
function submit(app: MountedApp, line: string): void {
  app.setDraft(line)
  app.submitDraft()
}

/** The line index containing one needle, or -1 (DFS pre-order from the view). */
function lineIndexOf(view: string, needle: string): number {
  return view.split('\n').findIndex(line => line.includes(needle))
}

/** The text of every pending row: queued rows carry `text`, transcript-tail
 *  rows carry `row.text` (the shared pending-presentation projection). */
function pendingTexts(pending: { queued: ReadonlyArray<{ text?: string }>; tail: ReadonlyArray<{ row?: { text?: string } }> }): string[] {
  return [
    ...pending.queued.map(row => row.text),
    ...pending.tail.map(row => row.row?.text),
  ].filter((text): text is string => typeof text === 'string')
}

/** Flatten a rendered terminal viewport: the editor/status bars wrap at the
 *  terminal width, so a wording assertion must not depend on the wrap column. */
function flat(view: string): string {
  return view.replace(/\s+/gu, ' ')
}

test('L6 §11/§14.4-5-6: `/tasks` renders the REAL Remote descendant tree and the child row opens the REAL child viewer', async (t) => {
  const life = testLifecycle(t)
  const { host, fixture, app, sessions, viewport } = await mountTaskCenterFixture(life)
  // A parent-session pending echo: while the MAIN surface owns the queue it is
  // visible; inside the child viewer it must NOT be (the child subject wins).
  const parentBinding = sessions.binding(SessionId(PARENT_ID))
  assert.ok(parentBinding !== undefined, 'the retained main session serves the official echo source')
  parentBinding.session.beginSubmission({ mode: 'queue', text: 'parent pending echo', attachments: [] })

  // ── §14.4 `/tasks` through the real application surface.
  const generationBefore = app.getViewerGeneration()
  submit(app, '/tasks')
  await waitFor('the full Task Center rendered the tree', () => viewport().includes(LABEL_A), 20_000)
  // Every direct child is a rendered `subagent · <label>` row with the durable
  // mode as its non-truncatable suffix; the nested C is disclosed under A.
  const collapsed = viewport()
  assert.match(collapsed, /subagent · child A m3-5-pr2-child-a · continuable/u,
    `the direct continuable child A row must render:\n${collapsed}`)
  assert.match(collapsed, /subagent · child B m3-5-pr2-child-b · one-shot/u,
    `the direct one-shot child B row must render:\n${collapsed}`)
  assert.equal(collapsed.includes(LABEL_C), false,
    'the nested child C is behind the parent row disclosure until A is expanded')
  // Expand A: the nested row appears BETWEEN A and B (stable DFS pre-order).
  fixture.vt.sendInput('\x1b[C')
  await waitFor('the nested child disclosed', () => viewport().includes(LABEL_C), 10_000)
  const expanded = viewport()
  const indexA = lineIndexOf(expanded, LABEL_A)
  const indexC = lineIndexOf(expanded, LABEL_C)
  const indexB = lineIndexOf(expanded, LABEL_B)
  assert.ok(indexA >= 0 && indexC >= 0 && indexB >= 0, `all three rows must render:\n${expanded}`)
  assert.ok(indexA < indexC && indexC < indexB,
    `the rendered tree must keep stable DFS pre-order A, C, B (got ${indexA}, ${indexC}, ${indexB}):\n${expanded}`)
  // The nested row is indented one level deeper than its direct-parent row.
  const cLine = expanded.split('\n')[indexC]!
  const aLine = expanded.split('\n')[indexA]!
  assert.ok(cLine.indexOf('└─') > aLine.indexOf('├─'),
    `the nested row must render one tree level deeper:\n${expanded}`)

  // The SEMANTIC Remote Task read the surface consumes carries the exact
  // identities/edges/modes (read at a quiet point: no surface traversal is
  // in flight, so this read cannot supersede one).
  const snapshot = await fixture.aggregate.presentation.task.readDescendants(PARENT_ID)
  assert.ok(snapshot !== undefined, 'the Remote Task read must settle a snapshot')
  assert.equal(snapshot.parentSessionId, PARENT_ID)
  assert.equal(snapshot.parentAvailable, true)
  assert.deepEqual(snapshot.descendants.map(entry => entry.id), [CHILD_A_ID, CHILD_C_ID, CHILD_B_ID],
    'the full descendant catalog in stable DFS pre-order')
  assert.deepEqual(snapshot.descendants.map(entry => entry.kind === 'child'
    ? { id: entry.id, mode: entry.mode, parentId: entry.parentId, depth: entry.depth }
    : { id: entry.id, diagnostic: entry.reason }), [
    { id: CHILD_A_ID, mode: 'continuable', parentId: PARENT_ID, depth: 1 },
    { id: CHILD_C_ID, mode: 'continuable', parentId: CHILD_A_ID, depth: 2 },
    { id: CHILD_B_ID, mode: 'one-shot', parentId: PARENT_ID, depth: 1 },
  ], 'exact durable parent + depth + catalog mode for every descendant')

  // ── §14.6 open child A from the actual Task row.
  fixture.vt.sendInput('\r')
  await waitFor('the real child A viewer mounted', () => app.getViewerGeneration() > generationBefore, 20_000)
  await waitFor('the CHILD transcript hydrated', () => viewport().includes('childa answer 30'), 20_000)
  const childView = viewport()
  assert.equal(childView.includes('childa answer 30'), true, 'the child A transcript renders')
  assert.equal(childView.includes('parent answer 2'), false,
    `the parent transcript must never render as the child viewer:\n${childView}`)
  // Display-subject facts are the CHILD's own: the subject bar identity + the
  // committed StatusStore subject and workspace. The bar is read from its own
  // component (a REGULAR surface can scroll the bar out of the captured
  // viewport; the retired `[subagent · …]` footer badge no longer exists).
  const barA = app.viewerSubjectBarRenderRowsForTest().join('\n')
  assert.ok(barA.includes('‹ back'), `the subject bar must render the navigation affordance:\n${barA}`)
  assert.ok(barA.includes('child A m3-5-pr2-child-a'),
    `the subject bar must render the child identity:\n${barA}`)
  assert.ok(!barA.includes('[subagent · continuable]'), `the retired badge must not render:\n${barA}`)
  const childStatus = app.statusStore.snapshot()
  assert.deepEqual(childStatus.view?.subject, {
    kind: 'subagent', id: CHILD_A_ID, label: LABEL_A, mode: 'continuable', activity: 'inactive',
  })
  assert.equal(childStatus.workspace?.cwd, join(host.anchorDir, CHILD_A_DIR),
    'the committed workspace is the CHILD Session cwd, never the parent anchor')
  assert.match(childView, /a-ws/u, `the child cwd must render:\n${childView}`)
  assert.equal(childView.includes('parent pending echo'), false,
    'the parent pending echo must not follow into the child viewer')
  // …and the CHILD's pending-input subject is active: a real official echo on
  // the child binding surfaces in the viewer's pending pane.
  const childBinding = sessions.binding(SessionId(CHILD_A_ID))
  assert.ok(childBinding !== undefined, 'the viewer retains the exact child generation')
  childBinding.session.beginSubmission({ mode: 'queue', text: 'child A pending echo', attachments: [] })
  await waitFor('the child pending echo joined the pending pane', () =>
    pendingTexts(app.pendingInputForTest()).includes('child A pending echo'), 15_000)
  assert.equal(childBinding.session.getSnapshot().pendingSubmissions.some(echo => echo.text === 'child A pending echo'), true,
    'the child binding itself carries the official pending echo (the subject is real, not a fabricated row)')
  assert.equal(pendingTexts(app.pendingInputForTest()).includes('parent pending echo'), false,
    'the parent pending echo is NOT in the child viewer pending pane')

  // ── Optional plan §14.11: PageUp extends the CHILD window, not the main one.
  const reader = fixture.aggregate.presentation.presentationReader
  const beforeChild = await reader.read(CHILD_A_ID)
  const beforeMain = await reader.read(PARENT_ID)
  assert.ok(beforeChild !== undefined && beforeMain !== undefined)
  assert.equal(beforeChild.hasMore, true,
    'the fixture must provide a truncating child window for the paging proof')
  const beforeMainFirst = beforeMain.durableEvents[0]!.seq
  const beforeMainCount = beforeMain.durableEvents.length
  app.setFullscreen(true)
  await new Promise(resolve => setTimeout(resolve, 50))
  const pageStarted = Date.now()
  for (;;) {
    const now = await reader.read(CHILD_A_ID)
    if (now !== undefined && now.durableEvents.length > beforeChild.durableEvents.length) break
    if (Date.now() - pageStarted > 15_000) throw new Error('PageUp inside the viewer never extended the CHILD window')
    app.scrollToTop({ disableFollow: true })
    await new Promise(resolve => setTimeout(resolve, 30))
    fixture.vt.sendInput('\x1b[57421u') // PageUp at the loaded floor
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  const afterChild = await reader.read(CHILD_A_ID)
  const afterMain = await reader.read(PARENT_ID)
  assert.ok(afterChild !== undefined && afterMain !== undefined)
  assert.equal(afterChild.sessionId, CHILD_A_ID, 'the viewed subject is unchanged')
  assert.equal(afterChild.durableEvents[0]!.seq < beforeChild.durableEvents[0]!.seq, true,
    'the CHILD window front extended toward older history')
  assert.equal(afterMain.durableEvents[0]!.seq, beforeMainFirst,
    'the MAIN session window must NOT be paged while the child viewer is open')
  assert.equal(afterMain.durableEvents.length, beforeMainCount,
    'the MAIN session window length must be unchanged while the child viewer is open')
  await waitFor('the viewer visibly scrolled into the child history', () => viewport().includes('↓ Latest'), 10_000)

  // ── §14.12 Esc restores the main transcript/status/queue anchor.
  fixture.vt.sendInput('\x1b')
  await waitFor('the main transcript restored', () => viewport().includes('parent answer 2'), 20_000)
  const restored = viewport()
  assert.equal(restored.includes('childa answer 30'), false,
    `the child transcript must retire on Esc:\n${restored}`)
  assert.equal(restored.includes(LABEL_A), false, 'the child viewer badge must clear')
  assert.match(restored, /\/anchor/u, `the parent workspace must return:\n${restored}`)
  assert.equal(restored.includes('a-ws'), false, 'the child workspace must clear')
  await waitFor('the parent pending subject restored', () =>
    pendingTexts(app.pendingInputForTest()).includes('parent pending echo'), 15_000)
  assert.equal(pendingTexts(app.pendingInputForTest()).includes('child A pending echo'), false,
    'the child pending echo must not leak onto the restored main surface')
})

test('L6 §14.9: the RENDERED /tasks row and badge follow the official Client Session running fact for an UNRETAINED child, with no Direct Host read', async (t) => {
  const life = testLifecycle(t)
  const adapter = new HoldingAdapter()
  const { host, fixture, app, sessions, viewport } = await mountTaskCenterFixture(life, { adapter })

  const childAgent = (host.ctx.agents as unknown as {
    get(id: unknown): { followup(message: unknown): void } | undefined
  }).get(SessionId(CHILD_A_ID))
  assert.ok(childAgent !== undefined, 'the real Host child agent must exist')
  // The running fact is FALSE before the transition, so the post-release
  // observation is not vacuous.
  assert.equal(sessions.list.getSnapshot().byId[CHILD_A_ID]?.running, false,
    'the child must be inactive before the transition')
  const release = adapter.hold()
  life.defer(() => release())
  childAgent.followup({
    id: MessageId('m3-5-pr2-child-a-turn'), role: 'user',
    content: [{ type: 'text', text: 'hold the child turn open' }], source: { kind: 'user' },
  })
  // The transition is observed through the OFFICIAL Client Session list — the
  // same fact the Remote Task `activityOf` reads — never a process-local Agent
  // registry read.
  await waitFor('the official Client list reports the child running', () =>
    sessions.list.getSnapshot().byId[CHILD_A_ID]?.running === true, 15_000)
  // The listing retains NO descendant generation; the rendered row must still
  // show the child running (the pre-fix binding-requiring fact could not).
  assert.equal(sessions.binding(SessionId(CHILD_A_ID)), undefined,
    'the Task listing must not retain the child generation (plan §6.6)')

  submit(app, '/tasks')
  await waitFor('the rendered child A row shows running', () =>
    /child A m3-5-pr2-child-a · mode\s+continuable · activity\s+running/u.test(viewport()), 20_000)
  const runningView = viewport()
  assert.match(runningView, /subagent · child A m3-5-pr2-child-a · continuable\s+running/u,
    `the row's own status tail must read running:\n${runningView}`)
  // The dock/agents badge (the StatusStore activity projection) arms from the
  // same projected activity.
  assert.equal(app.statusStore.snapshot().activity?.childAgentCount, 1,
    'the agents badge must count the running child')
  // The semantic read agrees (asserted only after the rendered commit settled,
  // so this read cannot supersede an in-flight surface traversal).
  const running = await fixture.aggregate.presentation.task.readDescendants(PARENT_ID)
  const childRunning = running?.descendants.find(entry => entry.id === CHILD_A_ID)
  assert.equal(childRunning?.kind === 'child' && childRunning.activity, 'running',
    'the Remote Task read reports the child running from the official Client Session fact')

  // Flip the official fact to idle. The convergence below is observed purely
  // through the observable-driven surface refresh: the test performs NO read
  // and NO re-open between the release and the rendered `inactive` paint, so a
  // row that stayed `running` would fail here.
  release()
  await waitFor('the official Client list reports the child idle', () =>
    sessions.list.getSnapshot().byId[CHILD_A_ID]?.running === false, 15_000)
  await waitFor('the rendered child A row converges to inactive', () =>
    /child A m3-5-pr2-child-a · mode\s+continuable · activity\s+inactive/u.test(viewport()), 20_000)
  assert.equal(app.statusStore.snapshot().activity?.childAgentCount, 0,
    'the agents badge must converge back to zero')
  const idle = await fixture.aggregate.presentation.task.readDescendants(PARENT_ID)
  const childIdle = idle?.descendants.find(entry => entry.id === CHILD_A_ID)
  assert.equal(childIdle?.kind === 'child' && childIdle.activity, 'inactive',
    'the Remote Task read converges the child activity back to inactive from the official fact')
})

test('L6 §14.9 mutation teeth: the OLD binding-requiring activity fact cannot render the running child', async (t) => {
  const life = testLifecycle(t)
  const adapter = new HoldingAdapter()
  const { host, fixture, app, sessions, viewport } = await mountTaskCenterFixture(life, { adapter })

  const childAgent = (host.ctx.agents as unknown as {
    get(id: unknown): { followup(message: unknown): void } | undefined
  }).get(SessionId(CHILD_A_ID))
  assert.ok(childAgent !== undefined, 'the real Host child agent must exist')
  const release = adapter.hold()
  life.defer(() => release())
  childAgent.followup({
    id: MessageId('m3-5-pr2-child-a-mutation-turn'), role: 'user',
    content: [{ type: 'text', text: 'hold the child turn open' }], source: { kind: 'user' },
  })
  await waitFor('the official Client list reports the child running', () =>
    sessions.list.getSnapshot().byId[CHILD_A_ID]?.running === true, 15_000)
  // Faithful pre-fix mutation: the surface used `sessionFacts.running(childId)`,
  // which resolves `undefined` for an unretained child, and
  // `projectSubagentActivity` maps that to `inactive`. The bootstrap closure
  // reads this member late-bound, so the stub is the pre-fix observable.
  const taskSource = fixture.aggregate.presentation.task as unknown as {
    activityOf(childSessionId: string): 'running' | 'inactive' | undefined
  }
  const originalActivityOf = taskSource.activityOf
  let stubbedCalls = 0
  taskSource.activityOf = () => { stubbedCalls += 1; return undefined }
  life.defer(() => { taskSource.activityOf = originalActivityOf })

  submit(app, '/tasks')
  await waitFor('the task center rendered the child row', () => viewport().includes(LABEL_A), 20_000)
  await new Promise(resolve => setTimeout(resolve, 800))
  assert.ok(stubbedCalls > 0, 'the pre-fix activity stub must actually be consulted by the render path')
  const mutantView = viewport()
  assert.doesNotMatch(mutantView, /activity\s+running/u,
    `the pre-fix activity fact must NOT render the child running (mutation teeth):\n${mutantView}`)
  assert.match(mutantView, /activity\s+inactive/u,
    `the pre-fix activity fact resolves the row to inactive:\n${mutantView}`)
  assert.equal(app.statusStore.snapshot().activity?.childAgentCount, 0,
    'the pre-fix activity fact must not arm the agents badge')
  // The semantic read is unaffected (it never used the surface projection), so
  // only the rendered surface changes under the mutation.
  const read = await fixture.aggregate.presentation.task.readDescendants(PARENT_ID)
  const mutantReadChild = read?.descendants.find(entry => entry.id === CHILD_A_ID)
  assert.equal(mutantReadChild?.kind === 'child' && mutantReadChild.activity, 'running',
    'the mutation targets only the surface projection; the semantic read still reports running')
})

test('L6 §11/§14.13: one-shot B and nested C are READ-ONLY from the root surface (no interactive editor, no child queue subject)', async (t) => {
  const life = testLifecycle(t)
  const { fixture, app, sessions, viewport } = await mountTaskCenterFixture(life)

  const openReadOnly = async (rowLabel: string, expectedBar: RegExp, childId: string, pendingText: string): Promise<void> => {
    const before = app.getViewerGeneration()
    submit(app, '/tasks')
    await waitFor('the task browser rendered', () => viewport().includes(rowLabel), 20_000)
    // Select the row explicitly, then Enter (the real browser gesture).
    const targetIndex = lineIndexOf(viewport(), rowLabel)
    const firstIndex = lineIndexOf(viewport(), LABEL_A)
    for (let i = firstIndex; i < targetIndex; i += 1) {
      fixture.vt.sendInput('\x1b[B')
      await new Promise(resolve => setTimeout(resolve, 60))
    }
    fixture.vt.sendInput('\r')
    await waitFor('the read-only viewer mounted', () => viewport().includes('viewing subagent:'), 20_000)
    assert.ok(app.getViewerGeneration() > before, 'the viewer generation must advance')
    assert.match(flat(viewport()), expectedBar, `the read-only editor bar must render:\n${viewport()}`)
    assert.equal(viewport().includes('Message '), false,
      `a read-only viewer must not render the interactive message placeholder:\n${viewport()}`)
    // A REAL pending echo exists on the retained child binding, yet the viewer
    // exposes NO child queue subject, so it must never surface.
    const binding = sessions.binding(SessionId(childId))
    assert.ok(binding !== undefined, 'the read-only viewer still retains the exact child generation')
    binding.session.beginSubmission({ mode: 'queue', text: pendingText, attachments: [] })
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(binding.session.getSnapshot().pendingSubmissions.some(echo => echo.text === pendingText), true,
      'the child binding really carries the official pending echo')
    assert.equal(pendingTexts(app.pendingInputForTest()).includes(pendingText), false,
      'a read-only viewer must expose no child queue subject for its pending echo')
    fixture.vt.sendInput('\x1b')
    await new Promise(resolve => setTimeout(resolve, 200))
  }

  await openReadOnly(LABEL_B, /viewing subagent: child B m3-5-pr2-child-b — one-shot · read-only · Esc returns/u, CHILD_B_ID, 'child B pending echo')
  // The nested C needs A expanded first (the same disclosure gesture).
  submit(app, '/tasks')
  await waitFor('the task browser rendered again', () => viewport().includes(LABEL_A), 20_000)
  fixture.vt.sendInput('\x1b[C')
  await waitFor('the nested row disclosed', () => viewport().includes(LABEL_C), 10_000)
  fixture.vt.sendInput('\x1b[B')
  await new Promise(resolve => setTimeout(resolve, 60))
  await waitFor('the nested row selected', () => /child C m3-5-pr2-child-c · mode\s+continuable/u.test(viewport()), 5_000)
  fixture.vt.sendInput('\r')
  await waitFor('the nested viewer mounted', () => viewport().includes('viewing subagent:'), 20_000)
  assert.match(flat(viewport()), /viewing subagent: child C m3-5-pr2-child-c — continuable · nested · read-only from this parent · Esc returns/u,
    `the nested read-only bar must render:\n${viewport()}`)
  assert.equal(viewport().includes('Message '), false,
    `a nested viewer must not render the interactive message placeholder:\n${viewport()}`)
  const nestedBinding = sessions.binding(SessionId(CHILD_C_ID))
  assert.ok(nestedBinding !== undefined, 'the nested viewer retains the exact child generation')
  nestedBinding.session.beginSubmission({ mode: 'queue', text: 'child C pending echo', attachments: [] })
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(nestedBinding.session.getSnapshot().pendingSubmissions.some(echo => echo.text === 'child C pending echo'), true)
  assert.equal(pendingTexts(app.pendingInputForTest()).includes('child C pending echo'), false,
    'a nested continuable viewer must expose no child queue subject')
  fixture.vt.sendInput('\x1b')
  await new Promise(resolve => setTimeout(resolve, 200))
})

test('L6 negative control §14: no Remote Task/child path reads the process-local subagents authority', async (t) => {
  const life = testLifecycle(t)
  const { host, fixture, app, viewport } = await mountTaskCenterFixture(life)
  // The Direct Task adapter's business authority is
  // `ctx.subagents.listDescendants`. The Remote Task read must reach the
  // descendant facts through the official Session projections instead, so this
  // process-local entry must never be entered by the Remote surface path.
  const subagents = host.ctx.get('subagents') as unknown as {
    listDescendants(...args: never[]): unknown
  }
  assert.ok(subagents !== undefined, 'the real Host subagents service must be mounted')
  const original = subagents.listDescendants.bind(subagents)
  let directAuthorityReads = 0
  subagents.listDescendants = (...args: never[]) => {
    directAuthorityReads += 1
    return original(...args)
  }
  life.defer(() => { subagents.listDescendants = original })
  // Witness wiring: the spy must actually intercept THIS exact method, or the
  // zero-call assertion below would be vacuous.
  await subagents.listDescendants(SessionId(PARENT_ID) as never)
  assert.equal(directAuthorityReads, 1, 'the spy intercepts the Direct Task authority method')
  directAuthorityReads = 0

  submit(app, '/tasks')
  await waitFor('the task center rendered', () => viewport().includes(LABEL_A), 20_000)
  fixture.vt.sendInput('\r')
  await waitFor('the child viewer mounted', () => viewport().includes('childa answer 30'), 20_000)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(directAuthorityReads, 0,
    'the Remote Task listing and child viewer must never consult ctx.subagents.listDescendants (the Direct authority)')
  // Narrow source fence (complementing the behavioral spy): the ONE Remote Task
  // read, the child-view source and the Remote presentation bundle contain no
  // process-local Host business read at all.
  for (const relative of [
    '../src/runtime/remote/task-read-remote.ts',
    '../src/app/remote/child-view.ts',
    '../src/app/remote/presentation-source.ts',
  ]) {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\bctx\.(subagents|agents|jobs|attachments)\b/u,
      `${relative} must not read a process-local Host service as its business authority`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// §14 step 8 / §5 Must 17: the REAL continuation follow-up.
//
// This test deliberately does NOT fabricate the child catalog/descriptor. The
// child below is established by the REAL `ctx.subagents.startContinuable`
// delegation over the official `spawn` provider (an existing devDependency
// row — no base-owned Host service is duplicated). That distinction IS the
// proof: a fabricated child is a plain live Host Agent, so a viewer follow-up
// finds no Activation and the official `subagents.prompt` route must
// cold-resume it; `AgentLoop.resumeWith`
// (packages/core/agent-loop/src/index.ts:842) takes session write ownership
// first and that live handle already holds the claim, so the failure surfaces
// as `subagent/not-resumable`
// (packages/subagent/subagent/src/continuation.ts:453 wraps that non-SubagentError).
// Only a REAL delegation produced by the continuation manager can be delivered
// to or cold-resumed by it.
// ─────────────────────────────────────────────────────────────────────────────

/** One durable Host Session log as this suite reads it. */
interface HostSessionFace {
  append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  snapshotEvents(): ReadonlyArray<{ readonly type: string; readonly data: unknown; readonly seq: number }>
}

/** The model-visible text of one user/assistant message event (both the Host's
 *  durable `SessionEvent` and the viewer's detached presentation envelope carry
 *  the payload under `data`). */
function eventText(event: unknown): string {
  const data = (event as { readonly data?: unknown }).data as {
    content?: ReadonlyArray<{ type: string; text?: string }>
    message?: { content?: ReadonlyArray<{ type: string; text?: string }> }
  } | undefined
  const blocks = data?.content ?? data?.message?.content ?? []
  return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

/** A stable content signature of one durable Host log (event type + message text). */
function logSignature(events: ReadonlyArray<{ readonly type: string; readonly data: unknown }>): string[] {
  return events.map(event => event.type === 'user/message' || event.type === 'assistant/message'
    ? `${event.type}:${eventText(event)}`
    : event.type)
}

/** The REAL delegation's reserved durable child identity, label, and prompts. */
const REAL_CHILD_ID = 'm3-5-pr2-real-child'
const REAL_LABEL = `real child ${REAL_CHILD_ID}`
const REAL_INITIAL_PROMPT = 'initial delegation prompt'
const REAL_FOLLOW_UP = 'follow-up from the child viewer'

/** The official Host session-query face (the durable, live-preferred read). */
interface SessionQueryFace {
  observeSession(id: unknown): Promise<{
    readonly events: ReadonlyArray<{ readonly type: string }>
    [Symbol.dispose](): void
  }>
}

/**
 * Wait until the CHILD's own durable log proves its initial turn completed.
 *
 * A live-only `ctx.sessions.get(child)` predicate races the delegated child's
 * own settlement: the Activation disposes and the Session detaches within
 * milliseconds of the turn's last event, after which the live snapshot is gone
 * forever and the predicate can never become true again. The official Session
 * observation is live-preferred and falls back to persistence, so it observes
 * the turn either way. The bounded deadline covers the cumulative load of this
 * nine-fixture file, and the failure names the last read error so a genuinely
 * absent child log still fails loud.
 */
async function awaitChildInitialTurn(
  host: Awaited<ReturnType<typeof mountRemotePresentationHost>>,
  childId: string,
): Promise<void> {
  const query = host.ctx.get('sessionQuery') as SessionQueryFace | undefined
  assert.ok(query !== undefined, 'the Host session query must be mounted for the durable child read')
  const deadline = Date.now() + 60_000
  let lastError: unknown
  for (;;) {
    let events: ReadonlyArray<{ readonly type: string }> | undefined
    try {
      const observation = await query.observeSession(SessionId(childId))
      try {
        events = observation.events
      } finally {
        observation[Symbol.dispose]()
      }
    } catch (error: unknown) {
      lastError = error
    }
    if (events?.some(event => event.type === 'assistant/message') === true) return
    if (Date.now() > deadline) {
      throw new Error('the delegated child never completed its initial turn: its durable log has no '
        + `assistant/message (last durable read error: ${String(lastError)})`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

test('L6 §14 step 8 / §5 Must 17: a REAL delegated continuable child receives the viewer follow-up through the official child inbox, and the authoritative child event lands in the SAME viewer', async (t) => {
  const life = testLifecycle(t)
  const adapter = new HoldingAdapter()
  const host = await mountRemotePresentationHost(life, PRESET_ID, { llmAdapter: adapter })
  // The REAL Host subagent authority plus the REAL official continuable
  // creation provider (`spawn`): the continuation manager itself owns the
  // child, so this duplicates no base-owned Host service.
  const SubagentRuntime = (await import('@deepseek-ai/dsh-subagent')).default
  await host.ctx.plugin(SubagentRuntime as never, { maxDepth: 3 } as never)
  const SpawnProvider = await import('@deepseek-ai/dsh-subagent-spawn-in-process')
  await host.ctx.plugin(SpawnProvider as never, { providerName: 'spawn' } as never)
  const subagents = host.ctx.get('subagents') as unknown as {
    startContinuable(spec: unknown): Promise<{ readonly childId: string; readonly messageId: string }>
  }
  const sessionOf = (id: string): HostSessionFace | undefined =>
    host.ctx.sessions.get(SessionId(id)) as unknown as HostSessionFace | undefined
  const agents = host.ctx.agents as unknown as { get(id: unknown): unknown }
  const childEvents = (): ReturnType<HostSessionFace['snapshotEvents']> =>
    sessionOf(REAL_CHILD_ID)?.snapshotEvents() ?? []

  // ── The REAL delegation from the live parent Agent. The manager reserves the
  // identity, appends the v3 `subagent/descriptor` inside the child's creation
  // window and the parent-owned `subagent/catalog` row — the durable facts the
  // Remote Task read and the child viewer consume.
  await host.harness.create(SessionId(PARENT_ID), { provider: 'smoke', model: 'smoke' } as never, { cwd: host.anchorDir })
  const parentSession = sessionOf(PARENT_ID)
  assert.ok(parentSession !== undefined, 'the live parent Host Session must exist')
  seedTurns(appenderOf(host.ctx, PARENT_ID), 1, 2, 'parent')
  const started = await subagents.startContinuable({
    provider: 'spawn',
    label: REAL_LABEL,
    childId: SessionId(REAL_CHILD_ID),
    request: {
      prompt: [{ type: 'text', text: REAL_INITIAL_PROMPT }],
      parent: agents.get(SessionId(PARENT_ID)),
    },
    signal: new AbortController().signal,
  })
  assert.equal(started.childId, REAL_CHILD_ID,
    'the continuation manager must establish the reserved durable child identity')
  // The delegated child settles and DETACHES within milliseconds of finishing
  // its first turn, so a live-session predicate races its own observation window
  // and has been observed to miss the turn entirely (a permanent hang, NOT a slow
  // run: a 60 s bound did not help). The completion is therefore read through the
  // official durable Session observation — live-preferred, then persistence —
  // with a bound that absorbs this nine-fixture file's cumulative load.
  await awaitChildInitialTurn(host, REAL_CHILD_ID)
  // The REAL delegation then settles and releases its Activation exactly like a
  // finished real continuable child: the Session stops being live. The follow-up
  // below therefore MUST cold-resume it — the exact path that rejected a
  // fabricated child with `subagent/not-resumable`.
  await waitFor('the delegated child released its activation (no live Agent or Session)', () =>
    agents.get(SessionId(REAL_CHILD_ID)) === undefined && sessionOf(REAL_CHILD_ID) === undefined, 20_000)

  const fixture = await mountRemoteRunner(life, { presetId: PRESET_ID, resumeSessionId: PARENT_ID, host })
  await waitFor('the parent transcript hydrated', () =>
    fixture.vt.getViewport().join('').includes('parent answer 2'), 20_000)
  const app = fixture.runnerApp() as unknown as MountedApp
  const viewport = (): string => fixture.vt.getViewport().join('\n')

  // The Remote Task read carries the REAL delegation facts, never a fabricated row.
  const descendants = await fixture.aggregate.presentation.task.readDescendants(PARENT_ID)
  assert.deepEqual(descendants?.descendants.map(entry => entry.kind === 'child'
    ? { id: entry.id, label: entry.label, mode: entry.mode, parentId: entry.parentId, depth: entry.depth }
    : { id: entry.id, diagnostic: entry.reason }), [
    { id: REAL_CHILD_ID, label: REAL_LABEL, mode: 'continuable', parentId: PARENT_ID, depth: 1 },
  ], 'the Remote Task read must carry the REAL delegated child catalog fact')

  // ── Open the REAL child from the actual `/tasks` row.
  const generationBefore = app.getViewerGeneration()
  submit(app, '/tasks')
  await waitFor('the task center rendered the real child row', () => viewport().includes(REAL_LABEL), 20_000)
  fixture.vt.sendInput('\r')
  await waitFor('the real child viewer mounted', () => app.getViewerGeneration() > generationBefore, 20_000)
  await waitFor('the child transcript hydrated', () => viewport().includes(REAL_INITIAL_PROMPT), 20_000)
  assert.equal(viewport().includes('Message '), true,
    `the direct continuable child viewer must expose the interactive editor:\n${viewport()}`)
  // The viewer owns the child's Client generation WITHOUT materializing a Host
  // Agent: the child is still cold immediately before the follow-up.
  assert.equal(sessionOf(REAL_CHILD_ID), undefined,
    'opening the child viewer must not materialize a Host child Session')
  assert.equal(agents.get(SessionId(REAL_CHILD_ID)), undefined,
    'opening the child viewer must not materialize a Host child Agent')

  // ── The viewer follow-up. The model endpoint is held open only so the
  // resumed child stays live long enough to observe the Host-side fact; the
  // Host state asserted below is real, not the stand-in's.
  const release = adapter.hold()
  life.defer(() => release())
  const parentBefore = logSignature(parentSession.snapshotEvents())
  assert.equal(parentBefore.some(line => line.endsWith(REAL_FOLLOW_UP)), false,
    'the parent log must not already carry the viewer follow-up')
  submit(app, REAL_FOLLOW_UP)

  // HOST-SIDE RECEPTION (never a UI echo): the detached child Session is
  // materialized again by the Host and its log accepts the viewer's message
  // with the official browser-prompt provenance the Remote adapter mints.
  await waitFor('the Host cold-resumed the delegated child Session', () =>
    sessionOf(REAL_CHILD_ID) !== undefined, 20_000)
  await waitFor('the child Session log accepted the viewer follow-up', () =>
    childEvents().some(event => event.type === 'user/message' && eventText(event) === REAL_FOLLOW_UP), 20_000)
  const accepted = childEvents().find(event => event.type === 'user/message' && eventText(event) === REAL_FOLLOW_UP)!
  const source = (accepted.data as { readonly source?: { readonly kind?: string; readonly rpcId?: unknown } }).source
  assert.equal(source?.kind, 'user',
    'the accepted child message must carry the official human-prompt provenance')
  assert.equal(typeof source?.rpcId, 'string',
    'the official `subagents.prompt` request id must be persisted on the accepted child message')

  // ── The authoritative child event appears in the SAME viewer. TWO independent
  // halves: the viewer's own durable child read carries the accepted event, and
  // the mounted viewer renders it as a TRANSCRIPT row — not merely the child's
  // pending-pane echo, which is the one separated by a panel rule.
  const viewerRead = await fixture.aggregate.presentation.presentationReader.read(REAL_CHILD_ID)
  assert.ok(viewerRead !== undefined, 'the viewer must own a durable child window')
  assert.equal(viewerRead.durableEvents.some(event =>
    event.type === 'user/message' && eventText(event) === REAL_FOLLOW_UP), true,
    'the viewer\'s own durable child read must carry the accepted follow-up event')
  const rowPattern = new RegExp(`^\\s*❯\\s+${REAL_FOLLOW_UP}\\s*$`, 'u')
  const isRule = (line: string): boolean => /^\s*─+\s*$/u.test(line)
  await waitFor('the follow-up rendered as a child viewer transcript row', () => {
    const lines = viewport().split('\n')
    return lines.some((line, index) =>
      rowPattern.test(line) && (index === 0 || !isRule(lines[index - 1]!)))
  }, 20_000)
  assert.equal(app.getDraft(), '',
    'the sent text must live in the CHILD transcript, never as a lingering editor draft')
  assert.equal(app.statusStore.snapshot().view?.subject?.id, REAL_CHILD_ID,
    'the same child viewer must still be the committed display subject')

  // ── The parent transcript is untouched: no event of any kind, and never the
  // follow-up text rendered as the parent surface.
  assert.deepEqual(logSignature(parentSession.snapshotEvents()), parentBefore,
    'the viewer follow-up must never append to the parent Session log')
  assert.equal(viewport().includes('parent answer 2'), false,
    `the parent transcript must not render inside the child viewer:\n${viewport()}`)
  release()
})

// ─────────────────────────────────────────────────────────────────────────────
// M3-5 PR2 Step 9/10 evidence: the REAL durable-image route at the mounted
// child viewer (plan §14 L6 step 10, §5 Must 20) plus the F1/F7 viewer-lifecycle
// locks over the official Client child generation.
// ─────────────────────────────────────────────────────────────────────────────

/** One REAL PNG's exact bytes. The real attachment backend strictly verifies
 *  format and CRC, so the bytes are sharp-generated through that backend's own
 *  dependency — the same recipe `test/runner-remote-submission.test.ts` uses. */
async function realPng(background: string, size: number): Promise<Uint8Array> {
  const require = createRequire(import.meta.url)
  const storeDir = dirname(require.resolve('@deepseek-ai/dsh-attachment-local/package.json'))
  const sharp = require(require.resolve('sharp', { paths: [storeDir] })) as (
    input: unknown,
  ) => { png(): { toBuffer(): Promise<Buffer> } }
  return new Uint8Array(await sharp({ create: { width: size, height: size, channels: 3, background } }).png().toBuffer())
}

/** The real Host attachment service face used to admit a fixture image. */
interface FixtureAttachments {
  saveImages(inputs: readonly { readonly data: Uint8Array; readonly mediaType: string; readonly name?: string }[]):
    Promise<readonly {
      readonly attachmentId: string
      readonly mediaType: string
      readonly bytes: number
      readonly width: number
      readonly height: number
      readonly name?: string
    }[]>
}

/** The official Client retain bookkeeping for one Session. */
interface RetainFacts {
  readonly referenceCount: number
  readonly retainedBy: Readonly<Record<string, number>>
}

interface RetainFace {
  retainInfo(id: unknown): { getSnapshot(): RetainFacts }
  retain(target: unknown, options: unknown): unknown
}

/** One presentation's IMMUTABLE image scope token (the bootstrap provider's
 *  memoized `{key, sessionId}` lifetime object). */
interface ImageScopeToken {
  readonly key: string
  readonly sessionId: string
  /** The captured transport lifetime (Connection generation + exact binding);
   *  absent only when the Remote facts are not composed. */
  readonly transportToken?: RemoteTransportLifetime
}

/** The mounted TuiApp's production image loader (the bootstrap-wired one). Every
 *  read-state access carries the caller's scope: bytes, failures and subscribers
 *  are keyed by `(scope, attachmentId)`. */
interface MountedImageLoader {
  readonly imageLoader: {
    load(ref: unknown, scope?: unknown): void
    get(ref: unknown, scope?: unknown): {
      readonly state: 'idle' | 'loading' | 'ready' | 'error'
      readonly error?: Error
    }
    isReady(ref: unknown, scope?: unknown): boolean
    subscribe(attachmentId: string, listener: () => void, scope?: unknown): () => void
    cacheSize(scope?: unknown): number
  }
}

/** The CURRENT presentation scope token the mounted app would stamp on a
 *  thumbnail constructed right now (the private provider field). */
function currentImageScope(app: MountedApp): ImageScopeToken {
  const provider = (app as unknown as { readonly imageScope?: () => unknown }).imageScope
  assert.ok(provider !== undefined, 'the mounted app must expose the image scope provider')
  const token = provider()
  assert.ok(token !== null && typeof token === 'object', 'a live image scope token must exist')
  const candidate = token as { readonly key?: unknown; readonly sessionId?: unknown }
  assert.equal(typeof candidate.key, 'string', 'the scope token must carry its lifetime key')
  assert.equal(typeof candidate.sessionId, 'string', 'the scope token must carry its Session id')
  return candidate as ImageScopeToken
}

/** One durable-image read attempt, resolved once it settles. */
interface DurableReadCall {
  readonly sessionId: string
  readonly attachmentId: string
  readonly expectedLifetime: unknown
  outcome?: 'ok' | 'failed'
  error?: unknown
}

interface DurableReadSpy {
  /** Every read in call order: the Session address, the ref, the captured
   *  presentation lifetime the caller supplied (undefined for an unscoped ask),
   *  and that read's own outcome once it settles. */
  readonly routed: DurableReadCall[]
  /** The `(sessionId, attachmentId)` addresses in call order, optionally filtered
   *  to one ref; the lifetime is asserted separately where it matters. */
  addresses(attachmentId?: string): Array<{ readonly sessionId: string; readonly attachmentId: string }>
  /** The bytes served per `sessionId\u0000attachmentId` address. */
  readonly served: Map<string, Uint8Array>
  /** Each ADDRESS's settle outcome, keyed `sessionId\u0000attachmentId`
   *  (independent of the loader's scope caches). */
  readonly settled: Map<string, {
    readonly sessionId: string
    readonly outcome: 'ok' | 'failed'
    readonly error?: unknown
  }>
  /** The most recent settle per attachment id (convenience for single-ask refs). */
  readonly settledByAttachment: Map<string, {
    readonly sessionId: string
    readonly outcome: 'ok' | 'failed'
    readonly error?: unknown
  }>
  restore(): void
}

/** Install the read-routing spy over the production durable-image source. */
function spyDurableImageReads(fixture: { readonly aggregate: { readonly presentation: unknown } }): DurableReadSpy {
  const source = (fixture.aggregate.presentation as { attachments: DurableImageFace }).attachments
  const original = source.readDurableImage
  const routed: DurableReadCall[] = []
  const served = new Map<string, Uint8Array>()
  const settled = new Map<string, { sessionId: string; outcome: 'ok' | 'failed'; error?: unknown }>()
  const settledByAttachment = new Map<string, { sessionId: string; outcome: 'ok' | 'failed'; error?: unknown }>()
  source.readDurableImage = async (sessionId, attachmentId, expectedLifetime) => {
    // The new lifetime argument MUST be forwarded: dropping it would let a stale
    // presentation borrow a successor binding for the same Session id.
    const call: DurableReadCall = { sessionId, attachmentId, expectedLifetime }
    routed.push(call)
    try {
      const result = await original(sessionId, attachmentId, expectedLifetime)
      served.set(`${sessionId}\u0000${attachmentId}`, result.data)
      call.outcome = 'ok'
      const record = { sessionId, outcome: 'ok' as const }
      settled.set(`${sessionId}\u0000${attachmentId}`, record)
      settledByAttachment.set(attachmentId, record)
      return result
    } catch (error: unknown) {
      call.outcome = 'failed'
      call.error = error
      const record = { sessionId, outcome: 'failed' as const, error }
      settled.set(`${sessionId}\u0000${attachmentId}`, record)
      settledByAttachment.set(attachmentId, record)
      throw error
    }
  }
  return {
    routed,
    served,
    settled,
    settledByAttachment,
    addresses: (attachmentId?: string) => routed
      .filter(entry => attachmentId === undefined || entry.attachmentId === attachmentId)
      .map(entry => ({ sessionId: entry.sessionId, attachmentId: entry.attachmentId })),
    restore: () => { source.readDurableImage = original },
  }
}

/** The Remote durable-image source the mounted surface's loader reads through. */
interface DurableImageFace {
  readDurableImage(
    sessionId: string,
    attachmentId: string,
    expectedLifetime: RemoteTransportLifetime,
  ): Promise<{ ref: unknown; data: Uint8Array }>
}

/* The captured presentation lifetime is the PRODUCTION type
 * (`RemoteTransportLifetime`, Connection generation + the EXACT binding). */

/** A retained Client binding face with the official Session attachment read. */
interface ReadAttachmentFace {
  session: { readAttachment(id: unknown): Promise<unknown> }
}

/** The official local retain facts of one Session id. `retainedBy` is handed
 *  out with a NULL prototype, so it is copied onto a plain object for
 *  `deepEqual` comparisons. */
function retainFacts(sessions: unknown, id: string): RetainFacts {
  const snapshot = (sessions as RetainFace).retainInfo(SessionId(id)).getSnapshot()
  return { referenceCount: snapshot.referenceCount, retainedBy: { ...snapshot.retainedBy } }
}

/** Seed one well-formed CHILD turn whose user message carries a durable image. */
function seedImageTurn(append: Append, turn: number, text: string, attachment: unknown): void {
  append('turn/start', { turn })
  append('step/start', { turn, step: 1 })
  append('user/message', {
    id: `u-image-${turn}`, role: 'user',
    content: [{ type: 'text', text }, { type: 'image', attachment }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  append('assistant/message', {
    turn, step: 1,
    message: {
      id: `a-image-${turn}`, role: 'assistant',
      content: [{ type: 'text', text: `${text} — seen` }],
      source: { kind: 'model', provider: 'smoke', model: 'smoke' },
    },
    stream: [], usage: { inputTokens: 1, outputTokens: 1 },
  }, { surfaceOp: 'append' })
  append('step/end', { turn, step: 1 })
  append('turn/end', { turn, reason: { kind: 'completed' } })
}

test('L6 §14 step 10 + F7: the mounted child viewer routes the durable child image through the CHILD Session readAttachment, and load() captures the asking subject', async (t) => {
  const life = testLifecycle(t)
  // The REAL inline-image render path fires the loader only when the terminal
  // reports image support (`ImageThumbnail.renderLines`); this is the
  // established test override and is restored for the rest of the file.
  const piTui = await import('@xmoon76/pi-tui') as unknown as {
    resetCapabilitiesCache(): void
    setCapabilities(caps: { images: 'kitty' | 'iterm2' | null; trueColor: boolean; hyperlinks: boolean }): void
  }
  piTui.resetCapabilitiesCache()
  piTui.setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  life.defer(() => { piTui.resetCapabilitiesCache() })

  const { host, fixture, app, sessions, viewport } = await mountTaskCenterFixture(life)
  const clientSessions = fixture.aggregate.wire.client.sessions
  assert.equal(retainFacts(clientSessions, CHILD_A_ID).referenceCount, 0,
    'the Task listing itself must retain no child generation')

  // ── A REAL durable image in the CHILD Session. The exact official seam: the
  // real `LocalAttachmentStore.saveImages` admits the PNG, and the returned ref
  // rides a durable child message block — the same `{type:'image', attachment}`
  // shape `src/app/submission/direct-image-admission.ts` produces for a submitted image.
  const attachments = host.ctx.get('attachments') as unknown as FixtureAttachments
  const png = await realPng('#c0ffee', 2)
  const image = (await attachments.saveImages([{ data: png, mediaType: 'image/png', name: 'child-a-shot.png' }]))[0]!
  seedImageTurn(appenderOf(host.ctx, CHILD_A_ID), 31, 'childa image prompt', image)

  // The read-routing spy over the production object the bootstrap loader closure
  // reads: which Session address the mounted surface asks for bytes.
  const readerSpy = spyDurableImageReads(fixture)
  life.defer(readerSpy.restore)
  const { routed, served, settledByAttachment } = readerSpy
  // The MAIN presentation's scope token, captured BEFORE the viewer opens (the
  // provider memoizes it by lifetime key, so the same object survives the viewer
  // round trip — asserted below).
  const mainScope = currentImageScope(app)
  const presentation = fixture.aggregate.presentation as unknown as { attachments: DurableImageFace }

  const parentBinding = sessions.binding(SessionId(PARENT_ID)) as unknown as ReadAttachmentFace
  const parentReads: string[] = []
  const originalParentRead = parentBinding.session.readAttachment
  parentBinding.session.readAttachment = async (id: unknown) => {
    parentReads.push(String(id))
    return originalParentRead.call(parentBinding.session, id)
  }
  life.defer(() => { parentBinding.session.readAttachment = originalParentRead })

  // ── Open the REAL child viewer from the Task row; its transcript renders the
  // durable image row and fires the production loader for that ref.
  submit(app, '/tasks')
  await waitFor('the Task Center rendered the child row', () => viewport().includes(LABEL_A), 20_000)
  fixture.vt.sendInput('\r')
  const childBinding = sessions.binding(SessionId(CHILD_A_ID)) as unknown as ReadAttachmentFace | undefined
  assert.ok(childBinding !== undefined,
    'the child viewer must retain the exact child generation synchronously on open')
  const childReads: string[] = []
  const originalChildRead = childBinding.session.readAttachment
  childBinding.session.readAttachment = async (id: unknown) => {
    childReads.push(String(id))
    return originalChildRead.call(childBinding.session, id)
  }
  life.defer(() => { childBinding.session.readAttachment = originalChildRead })

  await waitFor('the child transcript rendered the durable image row', () =>
    viewport().includes('🖼️ child-a-shot.png'), 20_000)
  const imageKey = `${CHILD_A_ID}\u0000${image.attachmentId}`
  await waitFor('the child Session served the durable image bytes', () =>
    served.has(imageKey), 20_000)

  // The loader caches per captured CONTEXT (the `src/client/media/image/loader.ts` scope
  // model), so one ref may legitimately be read once per scope; what must hold
  // is the ROUTING — every read of the child's image addresses the CHILD.
  const imageReads = routed.filter(entry => entry.attachmentId === image.attachmentId)
  assert.ok(imageReads.length >= 1, 'the rendered child image must be read at least once')
  assert.equal(imageReads.every(entry => entry.sessionId === CHILD_A_ID), true,
    `every rendered child image read must address the CHILD Session (got ${JSON.stringify(readerSpy.addresses(image.attachmentId))})`)
  assert.equal(childReads.includes(image.attachmentId), true,
    "the bytes must traverse the CHILD binding's official readAttachment")
  assert.deepEqual(served.get(imageKey), png,
    'the admitted PNG bytes must come back through the CHILD Session read')
  assert.equal(parentReads.includes(image.attachmentId), false,
    'the parent Session binding must never be asked for the child image')
  assert.equal(retainFacts(clientSessions, CHILD_A_ID).retainedBy['tuiChildView'], 1,
    'the mounted child viewer owns exactly one child generation')

  // ── F7 negative: a `load()` of a ref that is NOT in the transcript, stamped
  // with the CHILD presentation's IMMUTABLE scope token (the exact object a child
  // thumbnail constructed right now would be stamped with), followed by a viewer
  // exit in the SAME turn. The scope travels with the ref, so the deferred read
  // can never be re-routed to whichever presentation is current by then.
  const png2 = await realPng('#ff00ff', 3)
  const orphan = (await attachments.saveImages([{ data: png2, mediaType: 'image/png', name: 'child-only.png' }]))[0]!
  assert.notEqual(orphan.attachmentId, image.attachmentId,
    'the two images must be distinct durable objects (the store is content-addressed)')
  const childScope = currentImageScope(app)
  assert.match(childScope.key, /^child:/u, 'a mounted child viewer must own the child lifetime scope')
  assert.equal(childScope.sessionId, CHILD_A_ID)
  assert.notEqual(childScope, mainScope, 'the child and main presentations own distinct scopes')
  routed.length = 0
  const loader = (app as unknown as MountedImageLoader).imageLoader
  const parentReadsBeforeF7 = parentReads.length
  // Give the parent presentation's scope a KNOWN state before the child's ask, so
  // the "untouched" assertion below is not vacuous.
  const parentProbe = (await attachments.saveImages([{
    data: await realPng('#00ffff', 5), mediaType: 'image/png', name: 'parent-probe.png',
  }]))[0]!
  loader.load(parentProbe, mainScope)
  await waitFor('the parent-scope probe settled', () => settledByAttachment.has(parentProbe.attachmentId), 20_000)
  const parentProbeStateBefore = loader.get(parentProbe, mainScope)
  assert.equal(parentProbeStateBefore.state, 'error',
    'the parent scope refuses an image its own Session does not reference')
  const parentCacheBeforeF7 = loader.cacheSize(mainScope)
  const generationAtLoad = app.getViewerGeneration()
  loader.load(orphan, childScope)
  fixture.vt.sendInput('\x1b')
  assert.ok(app.getViewerGeneration() > generationAtLoad,
    'the viewer must have exited BEFORE the deferred read runs — otherwise this proof is vacuous')
  // The settle is observed through the READ SPY, not `loader.get`: the child's
  // scope is no longer the CURRENT one after the exit (`get` answers for the live
  // presentation), but the read's own outcome is scope-independent.
  await waitFor('the deferred child read settled', () => settledByAttachment.has(orphan.attachmentId), 20_000)
  const orphanReads = routed.filter(entry => entry.attachmentId === orphan.attachmentId)
  assert.ok(orphanReads.length >= 1, 'the scoped ask must have produced a real read')
  assert.equal(orphanReads.every(entry => entry.sessionId === CHILD_A_ID), true,
    `EVERY read of the child-stamped ref must address the CHILD (got ${JSON.stringify(readerSpy.addresses(orphan.attachmentId))})`)
  assert.equal(routed.some(entry => entry.sessionId === PARENT_ID && entry.attachmentId === orphan.attachmentId), false,
    `ZERO parent-addressed reads may exist for the child-stamped ref (got ${JSON.stringify(readerSpy.addresses())})`)
  assert.equal(parentReads.slice(parentReadsBeforeF7).includes(orphan.attachmentId), false,
    'the parent Session binding must never be asked for the child-only image')
  const orphanSettle = settledByAttachment.get(orphan.attachmentId)!
  assert.equal(orphanSettle.sessionId, CHILD_A_ID, 'the settle itself is attributed to the CHILD scope')
  if (orphanSettle.outcome === 'ok') {
    assert.equal(childReads.includes(orphan.attachmentId), true,
      'a served outcome must have come from the CHILD binding')
    assert.deepEqual(served.get(`${CHILD_A_ID}\u0000${orphan.attachmentId}`), png2,
      'the served bytes must be the child-only image bytes')
  } else {
    assert.match(String(orphanSettle.error), new RegExp(CHILD_A_ID),
      'a fail-closed outcome must name the CHILD subject, never the parent')
  }
  // The parent presentation's own loader state is untouched by the child's ask.
  assert.equal(loader.get(orphan, mainScope).state, 'idle',
    "the child's scoped ask must not create parent-scope state for that ref")
  assert.equal(loader.isReady(orphan, mainScope), false)
  assert.equal(loader.get(parentProbe, mainScope).state, 'error',
    "the child's scoped ask must not disturb the parent scope's own recorded state")
  assert.equal(loader.get(parentProbe, mainScope).error, parentProbeStateBefore.error,
    "the parent scope's recorded failure must be the very same object")
  assert.equal(loader.cacheSize(mainScope), parentCacheBeforeF7,
    "the child's scoped ask must not change the parent scope's cache")
  // The provider carries the SAME main lifetime key after the viewer exits AND
  // must hand back the VERY SAME token object for it: the loader keys object
  // scopes by identity, so re-minting the main token after a child visit would
  // silently drop the main presentation's cached bytes/failures/subscribers (and
  // re-read every main image) on each viewer round trip.
  const mainScopeAfterExit = currentImageScope(app)
  assert.equal(mainScopeAfterExit.key, mainScope.key,
    'the main lifetime key must be stable across a child viewer visit')
  assert.equal(mainScopeAfterExit, mainScope,
    'the same lifetime MUST yield the same scope object after a child visit')
  assert.equal(loader.get(parentProbe, mainScopeAfterExit).error, parentProbeStateBefore.error,
    "the post-visit main scope is the SAME scope: its recorded failure survives")
  // Mutation witness: the wrong subject is NOT a silent no-op. Asking the parent
  // Session for this child-only attachment is refused by the Host, so the pre-fix
  // late resolution would have failed the child image with a wrong-subject error
  // instead of serving it.
  const parentLifetime = currentImageScope(app).transportToken
  assert.ok(parentLifetime !== undefined, 'the parent presentation must carry a transport lifetime')
  await assert.rejects(
    () => presentation.attachments.readDurableImage(PARENT_ID, orphan.attachmentId, parentLifetime),
    (error: unknown) => /not referenced by this session/u.test(String(error)),
    'the parent route is refused by the Host — the defect would have surfaced here')

  // Witness wiring (non-vacuity): with NO viewer mounted, the SAME seam asks the
  // PARENT Session — so the child-route assertions above cannot be satisfied by a
  // hardcoded address.
  const parentImage = (await attachments.saveImages([{
    data: await realPng('#00ff00', 4), mediaType: 'image/png', name: 'parent-only.png',
  }]))[0]!
  routed.length = 0
  const mainScopeAtControl = currentImageScope(app)
  assert.match(mainScopeAtControl.key, /^main:/u, 'no mounted viewer means the main lifetime scope')
  assert.equal(mainScopeAtControl.sessionId, PARENT_ID)
  loader.load(parentImage, mainScopeAtControl)
  await waitFor('the main-surface image read settled', () => settledByAttachment.has(parentImage.attachmentId), 20_000)
  assert.deepEqual(readerSpy.addresses(), [{ sessionId: PARENT_ID, attachmentId: parentImage.attachmentId }],
    'with no viewer mounted the same seam asks the PARENT Session — the routing spy is not vacuous')
  assert.equal(settledByAttachment.get(parentImage.attachmentId)?.sessionId, PARENT_ID)
})

test('L6 F1: ending the viewer aborts a STILL-PENDING child open and releases its retained child generation without committing', async (t) => {
  const life = testLifecycle(t)
  const { fixture, app, viewport } = await mountTaskCenterFixture(life)
  const clientSessions = fixture.aggregate.wire.client.sessions
  const retainFace = clientSessions as unknown as RetainFace
  const realRetain = retainFace.retain
  const openSignals: Array<{ source: string; signal?: AbortSignal }> = []
  retainFace.retain = function (target: unknown, options: unknown) {
    const opts = options as { readonly source?: string; readonly signal?: AbortSignal }
    openSignals.push({ source: String(opts.source), ...(opts.signal === undefined ? {} : { signal: opts.signal }) })
    return realRetain.call(clientSessions, target, options)
  }
  life.defer(() => { retainFace.retain = realRetain })

  submit(app, '/tasks')
  await waitFor('the Task Center rendered the child row', () => viewport().includes(LABEL_A), 20_000)
  const generationBefore = app.getViewerGeneration()
  fixture.vt.sendInput('\r')
  // The open retains its child generation SYNCHRONOUSLY, before it ever settles.
  assert.deepEqual(retainFacts(clientSessions, CHILD_A_ID).retainedBy, { tuiChildView: 1 },
    'a pending child open holds exactly one child generation')
  assert.equal(openSignals.at(-1)?.source, 'tuiChildView',
    'the last retain must be the viewer open')
  const openSignal = openSignals.at(-1)?.signal
  assert.equal(openSignal?.aborted, false, 'the open is still pending at this point')
  // End the viewer in the SAME turn: the open has NOT settled.
  fixture.vt.sendInput('\x1b')
  assert.equal(openSignal?.aborted, true,
    'ending the viewer must abort the still-pending open — the retained generation has no other owner')
  await waitFor('the cancelled open released its retained child generation', () =>
    retainFacts(clientSessions, CHILD_A_ID).referenceCount === 0, 10_000)
  assert.equal(app.getViewerGeneration(), generationBefore,
    'the superseded open must never commit a viewer')
  assert.equal(viewport().includes('childa answer 30'), false,
    `the superseded open must never paint the child transcript:\n${viewport()}`)
})

test('L6 F2: the runner teardown releases the MOUNTED child viewer child generation exactly once', async (t) => {
  const life = testLifecycle(t)
  const { fixture, app, viewport } = await mountTaskCenterFixture(life)
  const clientSessions = fixture.aggregate.wire.client.sessions
  assert.deepEqual(retainFacts(clientSessions, PARENT_ID).retainedBy, { tuiMainView: 1 },
    'the running runner holds exactly one main-view generation')
  assert.equal(retainFacts(clientSessions, CHILD_A_ID).referenceCount, 0,
    'the Task listing retains no child generation')

  submit(app, '/tasks')
  await waitFor('the Task Center rendered the child row', () => viewport().includes(LABEL_A), 20_000)
  fixture.vt.sendInput('\r')
  await waitFor('the child viewer mounted', () => viewport().includes('childa answer 30'), 20_000)
  assert.deepEqual(retainFacts(clientSessions, CHILD_A_ID).retainedBy, { tuiChildView: 1 },
    'the MOUNTED child viewer owns exactly one child generation')

  await fixture.dispose()
  await waitFor('the disposed surface released the mounted child generation', () =>
    retainFacts(clientSessions, CHILD_A_ID).referenceCount === 0, 10_000)
  assert.deepEqual(retainFacts(clientSessions, CHILD_A_ID).retainedBy, {},
    'no other owner may keep holding the child generation after teardown')
  assert.equal(retainFacts(clientSessions, PARENT_ID).referenceCount, 0,
    'the surface releases its main-view generation with the same teardown')
})

// ─────────────────────────────────────────────────────────────────────────────
// M3-6 PR2 §14.5: the open Task Center + child viewer recover IN PLACE across
// a normal Connection reconnect (same retained binding objects, no viewer
// generation bump, no draft clear, no second retain, B-side truth converges).
// ─────────────────────────────────────────────────────────────────────────────

test('L6 M3-6 PR2 §14.5: the OPEN Task Center + child viewer survive a normal reconnect in place — same bindings, no viewer bump, draft kept, B truth converges, one retain release', async (t) => {
  const life = testLifecycle(t)
  const { host, fixture, app, sessions, viewport } = await mountTaskCenterFixture(life)
  const clientSessions = fixture.aggregate.wire.client.sessions
  const aAppend = appenderOf(host.ctx, CHILD_A_ID)

  // ── Open the Task Center and a real continuable child viewer.
  submit(app, '/tasks')
  await waitFor('the Task Center rendered the child row', () => viewport().includes(LABEL_A), 20_000)
  fixture.vt.sendInput('\r')
  await waitFor('the child viewer mounted', () => viewport().includes('childa answer 30'), 20_000)
  const viewerGenerationBefore = app.getViewerGeneration()

  // Capture the exact identity/state the reconnect must preserve.
  const mainBindingBefore = sessions.binding(SessionId(PARENT_ID))
  const childBindingBefore = sessions.binding(SessionId(CHILD_A_ID))
  assert.ok(mainBindingBefore !== undefined && childBindingBefore !== undefined,
    'both the main and the child binding are retained before the reconnect')
  app.setDraft('child draft kept across reconnect')
  assert.equal(app.getDraft(), 'child draft kept across reconnect',
    'the draft text is present before the reconnect')

  // ── The OFFICIAL reconnect (the same carrier the presentation suite
  // uses): A -> undefined -> B, with the child Host truth changing while
  // the old generation is gone (only the NEW generation can deliver it).
  const connection = fixture.aggregate.wire.client.connection as unknown as {
    generation: { getSnapshot(): { readonly id: number } | undefined }
    reconnect(): void
  }
  const generationBefore = connection.generation.getSnapshot()?.id
  connection.reconnect()
  seedTurns(aAppend, 40, 40, 'offline')
  await waitFor('a NEW DEFINED Connection generation is established', () => {
    const current = connection.generation.getSnapshot()?.id
    return current !== undefined && current !== generationBefore
  }, 20_000)

  // 1-2. The EXACT retained binding objects survive (normal reconnect is
  // NOT a Session release/re-materialization).
  assert.equal(sessions.binding(SessionId(PARENT_ID)), mainBindingBefore,
    'the main exact binding object is unchanged across the reconnect')
  assert.equal(sessions.binding(SessionId(CHILD_A_ID)), childBindingBefore,
    'the child exact binding object is unchanged across the reconnect')

  // 3. The transport reconnect does NOT bump the app viewer generation.
  assert.equal(app.getViewerGeneration(), viewerGenerationBefore,
    'a normal reconnect is not a viewer replacement')

  // 4-5. The viewer stays on the same child and the draft is preserved.
  assert.equal(viewport().includes('childa answer 30'), true,
    'the child viewer keeps showing its own subject')
  assert.equal(app.getDraft(), 'child draft kept across reconnect',
    'the user draft is not cleared by the transport reconnect')

  // 6. The B generation rehydrates the offline child truth.
  await waitFor('the B-side offline child turn rehydrated into the viewer', () =>
    viewport().includes('offline answer 40'), 20_000)

  // 7. No second child retain/reference was created.
  assert.deepEqual(retainFacts(clientSessions, CHILD_A_ID).retainedBy, { tuiChildView: 1 },
    'still exactly ONE viewer-owned child generation (no reconnect re-retain)')

  // 8. Closing the viewer after the reconnect releases the one retained
  // child reference exactly once.
  fixture.vt.sendInput('\x1b')
  await waitFor('the closed viewer released its child generation', () =>
    retainFacts(clientSessions, CHILD_A_ID).referenceCount === 0, 10_000)
  assert.deepEqual(retainFacts(clientSessions, CHILD_A_ID).retainedBy, {},
    'the reconnect added no hidden child owner')
  await waitFor('the main transcript restored', () => viewport().includes('parent answer 2'), 20_000)

  // ── Return to the Task Center and prove a B-side Task/descendant change
  // appears WITHOUT restarting the runner: a NEW grandchild under A.
  const { snapshotSubagentDescriptor } = await import('@deepseek-ai/dsh-subagent')
  const CHILD_D_ID = 'm3-6-pr2-child-d'
  const childDwd = join(host.anchorDir, 'd-ws')
  mkdirSync(childDwd, { recursive: true })
  await host.harness.create(
    SessionId(CHILD_D_ID),
    { provider: 'smoke', model: 'smoke' } as never,
    { cwd: childDwd, parentSession: SessionId(CHILD_A_ID), origin: 'subagent' } as never,
  )
  appenderOf(host.ctx, CHILD_D_ID)('subagent/descriptor',
    snapshotSubagentDescriptor({ mode: 'one-shot', provider: 'fixture', label: `child D ${CHILD_D_ID}` }))
  aAppend('subagent/catalog', { version: 1, childId: CHILD_D_ID, childCreatedAt: 5_000, mode: 'one-shot', label: `child D ${CHILD_D_ID}` })
  const LABEL_D = `child D ${CHILD_D_ID}`
  submit(app, '/tasks')
  await waitFor('the Task Center rendered again over the B generation', () =>
    viewport().includes(LABEL_A), 20_000)
  // The nested B-side row is behind the parent row disclosure: expand A
  // (the same real right-arrow gesture the first tree proof uses).
  fixture.vt.sendInput('\x1b[C')
  await waitFor('the B-side new descendant row appeared', () =>
    viewport().includes(LABEL_D), 20_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// §14 step 14 (main-Session switch fencing) and the two cross-subject negative
// controls: absent child facts and child A → child B residue.
// ─────────────────────────────────────────────────────────────────────────────

/** The replacement main Session this suite switches to. */
const MAIN_B_ID = 'm3-5-pr2-main-b'
const MAIN_B_DIR = 'b-main-ws'

/** Select one Task-Center row by its label and press Enter — the real gesture
 *  (the row walk the existing read-only proof also uses). */
async function openTaskRow(
  fixture: { readonly vt: { sendInput(data: string): void } },
  app: MountedApp,
  viewport: () => string,
  rowLabel: string,
): Promise<void> {
  submit(app, '/tasks')
  await waitFor(`the Task Center rendered ${rowLabel}`, () => viewport().includes(rowLabel), 20_000)
  const selected = (): boolean => viewport().split('\n')
    .some(line => line.includes('→') && line.includes(rowLabel))
  for (let step = 0; step <= 8; step += 1) {
    if (selected()) {
      fixture.vt.sendInput('\r')
      return
    }
    fixture.vt.sendInput('\x1b[B')
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  throw new Error(`the Task Center never selected ${rowLabel}`)
}

test('L6 §14 step 14: a main-Session switch fences the in-flight child open — no stale child operation reaches the replacement surface', async (t) => {
  const life = testLifecycle(t)
  const { host, fixture, app, viewport } = await mountTaskCenterFixture(life)
  const clientSessions = fixture.aggregate.wire.client.sessions
  // The in-flight open's OWN cancellation channel: the signal the viewer hands
  // to the official `retain` when its first child open starts.
  const retainFace = clientSessions as unknown as RetainFace
  const realRetain = retainFace.retain
  const openSignals: Array<{ source: string; signal?: AbortSignal }> = []
  retainFace.retain = function (target: unknown, options: unknown) {
    const opts = options as { readonly source?: string; readonly signal?: AbortSignal }
    openSignals.push({ source: String(opts.source), ...(opts.signal === undefined ? {} : { signal: opts.signal }) })
    return realRetain.call(clientSessions, target, options)
  }
  life.defer(() => { retainFace.retain = realRetain })
  const openSignal = (): AbortSignal | undefined =>
    openSignals.filter(entry => entry.source === 'tuiChildView').at(-1)?.signal
  // The replacement main Session: its own workspace and its own transcript.
  const bCwd = join(host.anchorDir, MAIN_B_DIR)
  mkdirSync(bCwd, { recursive: true })
  await host.harness.create(SessionId(MAIN_B_ID), { provider: 'smoke', model: 'smoke' } as never, { cwd: bCwd })
  seedTurns(appenderOf(host.ctx, MAIN_B_ID), 1, 1, 'mainb')

  // ── Start the child open, then switch in the SAME turn while it is pending.
  submit(app, '/tasks')
  await waitFor('the Task Center rendered the child row', () => viewport().includes(LABEL_A), 20_000)
  const generationBefore = app.getViewerGeneration()
  fixture.vt.sendInput('\r')
  // ── THE PENDING GATE: the first open has retained its child generation, has
  // NOT committed a viewer, and its own cancellation channel is not yet aborted.
  assert.equal(openSignal()?.aborted, false,
    'the first child open must be genuinely still pending at the gate')
  assert.deepEqual(retainFacts(clientSessions, CHILD_A_ID).retainedBy, { tuiChildView: 1 },
    'the pending child open must already hold its child generation')
  assert.equal(app.getViewerGeneration(), generationBefore,
    'the pending open must not have committed a viewer yet')
  // RACE SCOPE (measured, not assumed). The first child open commits in
  // ~76-91 ms; a real `/resume` main-Session switch commits in ~93-178 ms; and
  // the switch's own reset clears the Task Center rows ~20 ms after the submit.
  // So the swap always lands AFTER this open has committed — it runs the
  // MOUNTED-viewer teardown (whose `openingAbort` the commit already cleared),
  // and a delayed Enter has no row left to select. The pending-open abort branch
  // of the swap path is therefore NOT reachable through the real surface in this
  // fixture; the pending-gate ABORT itself is locked by the F1 test (Esc with a
  // still-pending open: signal aborted, retained generation retired). What THIS
  // test locks is the swap fence: the gate state asserted above, the retirement
  // of the swapped-out generation, and that nothing stale ever paints or
  // re-retains on the replacement surface.
  submit(app, `/resume ${MAIN_B_ID}`)
  assert.equal(retainFacts(clientSessions, CHILD_A_ID).retainedBy['tuiChildView'], 1,
    'issuing the switch must not release the still-held child generation on its own')
  await waitFor('the replacement main session hydrated', () => viewport().includes('mainb answer 1'), 20_000)
  await waitFor('the swapped-out child generation was released', () =>
    retainFacts(clientSessions, CHILD_A_ID).referenceCount === 0, 10_000)

  // The replacement surface is the NEW main Session — never the child.
  const mainStatus = app.statusStore.snapshot()
  assert.equal(mainStatus.view?.subject?.kind, 'main',
    'the replacement surface must be a main subject, never the superseded child')
  assert.equal(mainStatus.workspace?.project, MAIN_B_DIR,
    'the replacement workspace is the new main Session cwd')
  assert.equal(viewport().includes('childa answer 30'), false,
    `the superseded child transcript must not paint into the replacement surface:\n${viewport()}`)
  assert.equal(viewport().includes('a-ws'), false,
    'the superseded child workspace must not appear on the replacement surface')
  assert.ok(app.getViewerGeneration() > generationBefore, 'the switch itself re-initialized the surface')

  // A child event arriving AFTER the swap must never paint: the old subject's
  // ingress is gone, not merely hidden.
  seedTurns(appenderOf(host.ctx, CHILD_A_ID), 32, 32, 'childa-late')
  await new Promise(resolve => setTimeout(resolve, 600))
  assert.equal(viewport().includes('childa-late answer 32'), false,
    'a late child event must not repaint the replacement main surface')
  assert.equal(retainFacts(clientSessions, CHILD_A_ID).referenceCount, 0,
    'nothing may re-retain the swapped-out child generation')

  // Witness that the late child event is REAL — the absence above is a fence,
  // not a lost event: switching back and opening the child paints it.
  submit(app, `/resume ${PARENT_ID}`)
  await waitFor('the original main session restored', () => viewport().includes('parent answer 2'), 20_000)
  await openTaskRow(fixture, app, viewport, LABEL_A)
  await waitFor('the late child turn hydrates in the child viewer', () =>
    viewport().includes('childa-late answer 32'), 20_000)
})

test('L6 negative control: the child viewer never falls back to the parent facts for a fact its own Session lacks', async (t) => {
  const life = testLifecycle(t)
  const { host, fixture, app, viewport } = await mountTaskCenterFixture(life)
  // The parent carries a durable fact its children do NOT have: one todo entry
  // (the real `todo/write` snapshot folded by the official todo projection).
  appenderOf(host.ctx, PARENT_ID)('todo/write', { todos: [{ content: 'parent-only todo', status: 'pending' }] })
  await waitFor('the parent todo projection landed', () =>
    app.statusStore.snapshot().activity?.todoCount === 1, 10_000)
  const mainStatus = app.statusStore.snapshot()
  assert.equal(mainStatus.workspace?.project, 'anchor', 'the main subject owns the parent workspace')
  assert.equal(mainStatus.activity?.todoCount, 1, 'the parent todo fact is real before the child opens')

  await openTaskRow(fixture, app, viewport, LABEL_A)
  await waitFor('the child A viewer hydrated', () => viewport().includes('childa answer 30'), 20_000)
  const childStatus = app.statusStore.snapshot()
  // The subject is the CHILD, and its facts are the CHILD's own — never a parent fallback.
  assert.equal(childStatus.view?.subject?.kind, 'subagent')
  assert.equal(childStatus.view?.subject?.id, CHILD_A_ID)
  assert.equal(childStatus.workspace?.project, CHILD_A_DIR,
    'the child viewer commits the CHILD workspace, never the parent project')
  assert.notEqual(childStatus.workspace?.project, mainStatus.workspace?.project)
  assert.ok((childStatus.usage?.turns ?? 0) > (mainStatus.usage?.turns ?? 0),
    'the child usage fold is the CHILD log, never the parent Session usage')
  // The fact the child's OWN Session lacks stays ABSENT: the parent's todo must
  // neither be reported for the child nor rendered on the child surface.
  assert.equal(childStatus.activity?.todoCount, 0,
    "the parent's todo must not be reported for the viewed child")
  assert.equal(viewport().includes('parent-only todo'), false,
    `the parent todo must not render inside the child viewer:\n${viewport()}`)
  assert.equal(viewport().includes('parent answer 2'), false,
    `the parent transcript must not render inside the child viewer:\n${viewport()}`)
  // Control: the fact is still there for the PARENT — the absence above is the
  // child's own missing fact, not a vanished projection.
  fixture.vt.sendInput('\x1b')
  await waitFor('the parent surface restored', () => viewport().includes('parent answer 2'), 20_000)
  assert.equal(app.statusStore.snapshot().activity?.todoCount, 1,
    'the parent todo fact survives the child viewer round trip')
})

test('L6 negative control: child A → child B leaves no cross-child residue (transcript, workspace, subject, retained generation)', async (t) => {
  const life = testLifecycle(t)
  const { fixture, app, viewport } = await mountTaskCenterFixture(life)
  const clientSessions = fixture.aggregate.wire.client.sessions
  const status = (): ReturnType<MountedApp['statusStore']['snapshot']> => app.statusStore.snapshot()
  assert.equal(status().view?.subject?.kind, 'main', 'the fixture starts on the main subject')

  // ── child A.
  await openTaskRow(fixture, app, viewport, LABEL_A)
  await waitFor('the child A viewer hydrated', () => viewport().includes('childa answer 30'), 20_000)
  const aStatus = status()
  assert.equal(aStatus.view?.subject?.id, CHILD_A_ID)
  assert.equal(aStatus.workspace?.project, CHILD_A_DIR)
  assert.deepEqual(retainFacts(clientSessions, CHILD_A_ID).retainedBy, { tuiChildView: 1 })
  assert.equal(retainFacts(clientSessions, CHILD_B_ID).referenceCount, 0,
    'child B owns no generation while child A is viewed')
  fixture.vt.sendInput('\x1b')
  await waitFor('child A released its generation on exit', () =>
    retainFacts(clientSessions, CHILD_A_ID).referenceCount === 0, 10_000)

  // ── child B from the same root Task Center: NO A residue.
  await openTaskRow(fixture, app, viewport, LABEL_B)
  await waitFor('the child B viewer mounted', () => viewport().includes('viewing subagent:'), 20_000)
  await new Promise(resolve => setTimeout(resolve, 300))
  const bStatus = status()
  const bView = viewport()
  assert.equal(bStatus.view?.subject?.id, CHILD_B_ID)
  assert.equal(bStatus.workspace?.project, CHILD_B_DIR)
  assert.equal(bView.includes('childa answer 30'), false,
    `child A transcript text must not survive into child B:\n${bView}`)
  assert.equal(bView.includes(CHILD_A_DIR), false, 'child A workspace must not survive')
  assert.equal(bView.includes(LABEL_A), false, 'child A identity must not survive')
  assert.equal(bView.includes('child A pending echo'), false, 'no child A pending subject may survive')
  assert.equal(retainFacts(clientSessions, CHILD_A_ID).referenceCount, 0,
    'child A must hold no generation while child B is viewed')
  assert.deepEqual(retainFacts(clientSessions, CHILD_B_ID).retainedBy, { tuiChildView: 1 })
  fixture.vt.sendInput('\x1b')
  await waitFor('child B released its generation on exit', () =>
    retainFacts(clientSessions, CHILD_B_ID).referenceCount === 0, 10_000)

  // ── and back to child A: no B residue either.
  await openTaskRow(fixture, app, viewport, LABEL_A)
  await waitFor('the child A viewer re-hydrated', () => viewport().includes('childa answer 30'), 20_000)
  const backStatus = status()
  const backView = viewport()
  assert.equal(backStatus.view?.subject?.id, CHILD_A_ID)
  assert.equal(backStatus.workspace?.project, CHILD_A_DIR)
  assert.equal(backView.includes('childb answer 2'), false,
    `child B transcript text must not survive into child A:\n${backView}`)
  assert.equal(backView.includes(CHILD_B_DIR), false, 'child B workspace must not survive')
  assert.equal(backView.includes(LABEL_B), false, 'child B identity must not survive')
  assert.equal(retainFacts(clientSessions, CHILD_B_ID).referenceCount, 0)
  assert.deepEqual(retainFacts(clientSessions, CHILD_A_ID).retainedBy, { tuiChildView: 1 })
})
test('L6 P2 sink: the MOUNTED Remote child viewer converges its committed subject and footer on the official Client Session running flip alone', async (t) => {
  const life = testLifecycle(t)
  const adapter = new HoldingAdapter()
  const { host, fixture, app, sessions, viewport } = await mountTaskCenterFixture(life, { adapter })
  const childAgent = (host.ctx.agents as unknown as {
    get(id: unknown): { followup(message: unknown): void } | undefined
  }).get(SessionId(CHILD_A_ID))
  assert.ok(childAgent !== undefined, 'the real Host child agent must exist')

  // ── CHANNEL ISOLATION (declared substitution). The viewed child's durable
  // events normally re-derive the display subject too (`routeSessionEvent` calls
  // `beginTurn`/`endTurn` + `refreshFooter`), which would mask the snapshot
  // channel. Suppressing ONLY the child's durable-event sink leaves exactly the
  // official Session-snapshot sink (`onSessionSnapshotChanged`) as the one path
  // that can update the viewer's internal activity, so the convergence below is
  // attributable to it. `suppressedDurableEvents` is the witness that the
  // suppression really ran (a no-op wrapper would make the proof vacuous).
  // Every OTHER status-commit path for this child is suppressed with a witness:
  // durable events (`routeSessionEvent` → `beginTurn`/`endTurn` + `refreshFooter`),
  // coalesced projection events (`onProjectionsChanged` → `refreshStatus`), and
  // the window sinks (`rehydrateViewedChild` → `target.activity` + `refreshStatus`).
  // The Direct Host firehose that also feeds `routeSessionEvent` is registered ONLY
  // when `remoteSources` is absent (bootstrap.ts), and Remote events arrive through
  // this ingress alone. Hence `viewing.activity` has exactly two writers — the open
  // commit (already done) and `onSessionSnapshotChanged` — so the committed subject
  // can follow this flip ONLY because that sink re-derives it via
  // `deps.refreshStatus()`; with that one line removed the subject and the rendered
  // footer would keep the stale activity.
  let suppressedDurableEvents = 0
  let suppressedProjectionEvents = 0
  // The window sinks drive `rehydrateViewedChild`, which ALSO re-derives the
  // subject status (`deps.refreshStatus()` + `target.activity` from the binding).
  // They are suppressed and counted too: if they ever fired inside the measured
  // window the causality claim below would be false, so a non-zero count fails
  // loudly instead of silently weakening the proof.
  let suppressedWindowReplaced = 0
  let suppressedWindowPrepended = 0
  const ingress = fixture.aggregate.presentation.liveIngress as unknown as {
    subscribe(
      sessionId: string,
      sinks: Record<string, unknown>,
      hydrateRevision?: number,
    ): { dispose(): void } | undefined
  }
  const realSubscribe = ingress.subscribe
  ingress.subscribe = function (sessionId, sinks, hydrateRevision) {
    if (sessionId !== CHILD_A_ID) return realSubscribe.call(ingress, sessionId, sinks, hydrateRevision)
    return realSubscribe.call(ingress, sessionId, {
      ...sinks,
      onDurableEvent: () => { suppressedDurableEvents += 1 },
      onProjectionsChanged: () => { suppressedProjectionEvents += 1 },
      onWindowReplaced: () => { suppressedWindowReplaced += 1 },
      onWindowPrepended: () => { suppressedWindowPrepended += 1 },
    }, hydrateRevision)
  }
  life.defer(() => { ingress.subscribe = realSubscribe })

  // The display-subject identity bar renders the committed activity
  // (`● running` / `inactive`) — the exact line P2 left stale. Read from the
  // bar component: this is a REGULAR surface, so the bar can scroll out of
  // the captured viewport.
  const subjectLine = (): string => app.viewerSubjectBarRenderRowsForTest().join('\n')
  const subjectActivity = (): string | undefined => app.statusStore.snapshot().view?.subject?.activity
  const clientRunning = (): boolean | undefined => sessions.list.getSnapshot().byId[CHILD_A_ID]?.running
  // The PUBLISHED extension surface facts of the mounted app (the real
  // SurfaceHost the runner attached): `activity.working` and `session.busy` are
  // the LIVE/Main session's, so a CHILD activity flip must not move either.
  const extensionState = (): { readonly working: boolean; readonly busy: boolean } => {
    const host = (app as unknown as {
      extensionHost?: { state(): { activity: { working: boolean }; session: { busy: boolean } } }
    }).extensionHost
    assert.ok(host !== undefined, 'the mounted Remote app must carry the real extension SurfaceHost')
    const state = host.state()
    return { working: state.activity.working, busy: state.session.busy }
  }
  const extensionBefore = extensionState()

  // ── (1) The child is RUNNING through the official Client fact before the
  // viewer opens, so the initial committed state is not vacuous.
  const releaseHeld = adapter.hold()
  life.defer(() => releaseHeld())
  childAgent.followup({
    id: MessageId('m3-5-pr2-p2-running'), role: 'user',
    content: [{ type: 'text', text: 'hold the child turn open' }], source: { kind: 'user' },
  })
  await waitFor('the official Client list reports the child running', () => clientRunning() === true, 15_000)

  // ── (2) Mount the viewer on that running child and assert the initial commit.
  await openTaskRow(fixture, app, viewport, LABEL_A)
  await waitFor('the child viewer hydrated on the running child', () => subjectActivity() === 'running', 20_000)
  assert.deepEqual(app.statusStore.snapshot().view?.subject, {
    kind: 'subagent', id: CHILD_A_ID, label: LABEL_A, mode: 'continuable', activity: 'running',
  }, 'the mounted viewer must commit the CHILD subject as running')
  await waitFor('the subject bar renders the running activity', () =>
    subjectLine().includes('● running'), 10_000)

  // ── (3) The official Session-snapshot flip to `running: false` (the held turn
  // completing), with NO durable event delivered to the viewed child, no
  // projection poke and no reopen — the test only observes.
  releaseHeld()
  await waitFor('the official Client list reports the child idle', () => clientRunning() === false, 15_000)
  await waitFor('the committed subject converges to inactive on the snapshot channel alone', () =>
    subjectActivity() === 'inactive', 15_000)
  assert.ok(suppressedDurableEvents > 0,
    'the isolation witness must have suppressed real durable events, or this proof is vacuous')
  assert.ok(suppressedProjectionEvents > 0,
    'the projection witness must have suppressed real projection events for the child')
  assert.equal(suppressedWindowReplaced, 0,
    'a window replacement would independently re-derive the subject status in this window')
  assert.equal(suppressedWindowPrepended, 0,
    'a window prepend would independently re-derive the subject status in this window')
  assert.equal(subjectActivity(), 'inactive',
    'the committed display subject must follow the official running flip')
  await waitFor('the subject bar converges to the inactive activity', () =>
    subjectLine().includes('inactive') && !subjectLine().includes('● running'), 15_000)
  assert.equal(subjectLine().includes('inactive'), true,
    `the rendered subject bar must show the converged activity:\n${subjectLine()}`)
  assert.equal(subjectLine().includes('● running'), false,
    `the stale running line must leave the subject bar:\n${subjectLine()}`)
  // UX-1 (§7 E2): the SAME snapshot-only flip drives the visible working row —
  // the committed display subject is the row's only selector, so the inactive
  // flip clears it without any durable event or viewer reopen.
  await waitFor('the working row follows the inactive flip', () =>
    !viewport().includes('Working...'), 15_000)
  // The PUBLIC extension facts stay the LIVE/Main session's: the child's
  // activity flip (and the visible child row) must not move them.
  const extensionAfterFlip = extensionState()
  assert.equal(extensionAfterFlip.working, extensionBefore.working,
    'the extension activity.working is the LIVE/Main fact, never the displayed child activity')
  assert.equal(extensionAfterFlip.busy, extensionBefore.busy,
    'the extension session.busy is the Main machine fact, never the displayed child activity')

  // ── (4) The reverse flip through the same isolated channel.
  const suppressedBefore = suppressedDurableEvents
  const suppressedProjectionsBefore = suppressedProjectionEvents
  const releaseSecond = adapter.hold()
  life.defer(() => releaseSecond())
  childAgent.followup({
    id: MessageId('m3-5-pr2-p2-running-again'), role: 'user',
    content: [{ type: 'text', text: 'hold the child turn open again' }], source: { kind: 'user' },
  })
  await waitFor('the official Client list reports the child running again', () => clientRunning() === true, 15_000)
  await waitFor('the committed subject converges back to running', () => subjectActivity() === 'running', 15_000)
  await waitFor('the subject bar converges back to the running activity', () =>
    subjectLine().includes('● running'), 15_000)
  assert.ok(suppressedDurableEvents > suppressedBefore,
    'the reverse flip must also be observed with the durable sink suppressed')
  assert.ok(suppressedProjectionEvents > suppressedProjectionsBefore,
    'the reverse flip must also be observed with the projection sink suppressed')
  assert.equal(suppressedWindowReplaced, 0, 'no window replacement may fire on the reverse flip either')
  assert.equal(suppressedWindowPrepended, 0, 'no window prepend may fire on the reverse flip either')
  assert.equal(subjectActivity(), 'running', 'the reverse flip must converge as well')
  assert.equal(subjectLine().includes('● running'), true,
    `the rendered subject bar must show running again:\n${subjectLine()}`)
  await waitFor('the working row re-arms on the running flip', () =>
    viewport().includes('Working...'), 15_000)
  const extensionAfterReverse = extensionState()
  assert.equal(extensionAfterReverse.working, extensionBefore.working,
    'the reverse child flip must not move the LIVE/Main activity.working either')
  assert.equal(extensionAfterReverse.busy, extensionBefore.busy,
    'the reverse child flip must not move the Main session.busy either')

  // ── UX-3 E6 on the REAL Remote viewer: a fullscreen `‹ back` glyph click runs
  // the production exit route and releases the official Client generation the
  // viewer retained (the ingress/reference sink, NOT inherited from the Esc
  // suites — this is the CLICK route).
  const clientSessions = fixture.aggregate.wire.client.sessions
  const retainedBeforeExit = retainFacts(clientSessions, CHILD_A_ID).referenceCount
  assert.ok(retainedBeforeExit > 0, 'precondition: the mounted viewer holds the child generation')
  app.setFullscreen(true)
  await waitFor('the fullscreen subject bar painted', () => viewport().includes('‹ back'), 15_000)
  const exitBarRow = viewport().split('\n').findIndex(row => row.includes('‹ back'))
  assert.ok(exitBarRow >= 0, `the bar must be painted:\n${viewport()}`)
  fixture.vt.sendInput(`\x1b[<0;2;${exitBarRow + 1}M`) // press the `‹` glyph cell
  fixture.vt.sendInput(`\x1b[<0;2;${exitBarRow + 1}m`) // release on the same cell
  await waitFor('the glyph click exits the viewer', () => !viewport().includes('‹ back'), 15_000)
  assert.equal(app.statusStore.snapshot().view?.subject?.kind, 'main',
    'the glyph click must run the production viewer exit')
  await waitFor('the official Client generation is released by the click exit', () =>
    retainFacts(clientSessions, CHILD_A_ID).referenceCount === 0, 15_000)
  assert.equal(retainFacts(clientSessions, CHILD_A_ID).referenceCount, 0,
    'the click exit must release the child generation exactly like the Esc route')
  releaseSecond()
})

test('L6 P1 dual-subject: the SAME attachment id loaded under the parent and child scopes keeps independent state and subscribers', async (t) => {
  const life = testLifecycle(t)
  const piTui = await import('@xmoon76/pi-tui') as unknown as {
    resetCapabilitiesCache(): void
    setCapabilities(caps: { images: 'kitty' | 'iterm2' | null; trueColor: boolean; hyperlinks: boolean }): void
  }
  piTui.resetCapabilitiesCache()
  piTui.setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  life.defer(() => { piTui.resetCapabilitiesCache() })

  const { host, fixture, app, viewport } = await mountTaskCenterFixture(life)
  const readerSpy = spyDurableImageReads(fixture)
  life.defer(readerSpy.restore)
  const { routed, served, settled } = readerSpy
  const loader = (app as unknown as MountedImageLoader).imageLoader
  const attachments = host.ctx.get('attachments') as unknown as FixtureAttachments

  // X is a REAL durable image that the parent asks for BEFORE any viewer exists
  // (so the parent lifetime scope owns its failure) and that the CHILD then asks
  // for under its own scope. It is referenced only by the child Session.
  const pngX = await realPng('#c0ffee', 2)
  const X = (await attachments.saveImages([{ data: pngX, mediaType: 'image/png', name: 'dual-subject.png' }]))[0]!
  const parentScope = currentImageScope(app)
  assert.match(parentScope.key, /^main:/u, 'the parent lifetime scope is captured before any viewer')
  const parentWakes: string[] = []
  const childWakes: string[] = []
  const stopParent = loader.subscribe(X.attachmentId, () => { parentWakes.push('wake') }, parentScope)
  life.defer(stopParent)
  const parentAddress = `${PARENT_ID}\u0000${X.attachmentId}`

  // ── Mount the child viewer FIRST so BOTH scopes and BOTH subscribers exist
  // before either settle: a cross-scope wake would then be observable, never a
  // vacuous zero.
  submit(app, '/tasks')
  await waitFor('the Task Center rendered the child row', () => viewport().includes(LABEL_A), 20_000)
  fixture.vt.sendInput('\r')
  await waitFor('the child viewer hydrated', () => viewport().includes('childa answer 30'), 20_000)
  const childScope = currentImageScope(app)
  assert.match(childScope.key, /^child:/u, 'the mounted viewer owns the child lifetime scope')
  assert.equal(childScope.sessionId, CHILD_A_ID)
  assert.notEqual(childScope, parentScope)
  const childAddress = `${CHILD_A_ID}\u0000${X.attachmentId}`
  const stopChild = loader.subscribe(X.attachmentId, () => { childWakes.push('wake') }, childScope)
  life.defer(stopChild)

  // ── The PARENT scope's own ask: the Host refuses an image the parent Session
  // does not reference, and that failure belongs to the parent scope alone.
  loader.load(X, parentScope)
  await waitFor('the parent-scoped ask settled', () => settled.has(parentAddress), 20_000)
  assert.deepEqual(readerSpy.addresses(X.attachmentId),
    [{ sessionId: PARENT_ID, attachmentId: X.attachmentId }],
    'the first ask of X is addressed to the PARENT Session')
  assert.equal(settled.get(parentAddress)?.outcome, 'failed',
    'the parent Session does not reference X, so its read fails closed')
  assert.equal(parentWakes.length, 1, "the parent scope's own settle wakes its subscriber")
  assert.equal(childWakes.length, 0,
    "the parent scope's settle must NOT wake the child scope's subscriber")
  assert.equal(loader.get(X, childScope).state, 'idle',
    "the parent scope's failure must not create child-scope state for the same id")

  // ── The CHILD scope's ask of the SAME id is authorized only after X is
  // referenced by the child Session; the production render may also load it, so
  // the claim is the isolation, never a trigger count.
  seedImageTurn(appenderOf(host.ctx, CHILD_A_ID), 31, 'childa dual image', X)
  loader.load(X, childScope)
  await waitFor('the child-scoped ask served X', () => served.has(childAddress), 20_000)
  assert.deepEqual(readerSpy.addresses(X.attachmentId), [
    { sessionId: PARENT_ID, attachmentId: X.attachmentId },
    { sessionId: CHILD_A_ID, attachmentId: X.attachmentId },
  ], 'the same id was asked once per presentation scope')
  assert.equal(settled.get(childAddress)?.outcome, 'ok',
    'the child Session references X, so its read is served')
  assert.deepEqual(served.get(childAddress), pngX, 'the child scope owns the real bytes')
  assert.ok(childWakes.length >= 1, "the child scope's own settle wakes its subscriber")

  // ── Isolation, both directions: neither scope's settle woke the other's
  // subscriber, and neither scope's state changed the other's.
  assert.equal(parentWakes.length, 1,
    "the child scope's settle must NOT wake the parent scope's subscriber")
  assert.equal(loader.get(X, childScope).state, 'ready',
    'the child scope keeps its own ready state')
  assert.equal(loader.get(X, parentScope).state, 'error',
    'the parent scope keeps its own failure state')
  assert.equal(settled.get(parentAddress)?.outcome, 'failed',
    "the parent scope's recorded outcome is unchanged by the child settle")
  assert.equal(loader.isReady(X, parentScope), false,
    "the parent scope's cache must not gain the child-authorized bytes")
})

test('L6 P1 reincarnation: a read stamped with the OLD child lifetime fails closed and never reaches the reopened binding', async (t) => {
  const life = testLifecycle(t)
  const piTui = await import('@xmoon76/pi-tui') as unknown as {
    resetCapabilitiesCache(): void
    setCapabilities(caps: { images: 'kitty' | 'iterm2' | null; trueColor: boolean; hyperlinks: boolean }): void
  }
  piTui.resetCapabilitiesCache()
  piTui.setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  life.defer(() => { piTui.resetCapabilitiesCache() })

  const { host, fixture, app, sessions, viewport } = await mountTaskCenterFixture(life)
  const readerSpy = spyDurableImageReads(fixture)
  life.defer(readerSpy.restore)
  const loader = (app as unknown as MountedImageLoader).imageLoader
  const attachments = host.ctx.get('attachments') as unknown as FixtureAttachments
  const orphan = (await attachments.saveImages([{
    data: await realPng('#ff00ff', 3), mediaType: 'image/png', name: 'reincarnation.png',
  }]))[0]!
  const address = `${CHILD_A_ID}\u0000${orphan.attachmentId}`

  // ── OPEN child A (lifetime 1) and capture its scope token + exact binding.
  submit(app, '/tasks')
  await waitFor('the Task Center rendered the child row', () => viewport().includes(LABEL_A), 20_000)
  fixture.vt.sendInput('\r')
  await waitFor('the child viewer A hydrated', () => viewport().includes('childa answer 30'), 20_000)
  const generation1 = app.getViewerGeneration()
  const scope1 = currentImageScope(app)
  assert.match(scope1.key, /^child:1:/u, 'the first child viewer owns the child:1 lifetime key')
  assert.equal(scope1.sessionId, CHILD_A_ID)
  const binding1 = sessions.binding(SessionId(CHILD_A_ID))
  assert.ok(binding1 !== undefined, 'lifetime 1 owns its exact binding')

  // ── The STALE ask: stamped with lifetime 1, then the viewer exits in the SAME
  // turn (binding 1 released) before the deferred read can touch any Session.
  readerSpy.routed.length = 0
  loader.load(orphan, scope1)
  fixture.vt.sendInput('\x1b')
  await waitFor('the stale lifetime read settled', () => readerSpy.settledByAttachment.has(orphan.attachmentId), 20_000)
  const staleCall = readerSpy.routed.find(call => call.attachmentId === orphan.attachmentId)!
  assert.equal(staleCall.sessionId, CHILD_A_ID, 'the stale read was addressed to the CHILD Session')
  assert.equal(staleCall.expectedLifetime, scope1.transportToken,
    'the stale read carried the captured lifetime 1 transport token')
  assert.equal((staleCall.expectedLifetime as RemoteTransportLifetime).binding, binding1,
    'that token pins the RETIRED binding object')
  assert.equal(staleCall.outcome, 'failed', 'a retired child lifetime must fail closed')
  assert.match(String(staleCall.error), new RegExp(CHILD_A_ID), 'the failure must name the CHILD Session')
  // The fence reaches the missing-binding branch first once Esc has released the
  // lifetime's binding; it is still a PRE-dispatch refusal (no Session was called).
  assert.match(String(staleCall.error), /no retained Session binding/u,
    'the stale ask is refused by the pre-dispatch lifetime fence')
  assert.equal(loader.get(orphan, scope1).state, 'error', 'the OLD scope records its own failure')
  assert.equal(readerSpy.served.has(address), false, 'nothing may be served for the stale ask')

  // ── REOPEN the SAME child A: a NEW viewer generation, a NEW scope token and a
  // NEW binding object for the same Session id.
  submit(app, '/tasks')
  await waitFor('the Task Center rendered the child row again', () => viewport().includes(LABEL_A), 20_000)
  fixture.vt.sendInput('\r')
  await waitFor('the child viewer A re-hydrated', () => viewport().includes('childa answer 30'), 20_000)
  const scope2 = currentImageScope(app)
  const binding2 = sessions.binding(SessionId(CHILD_A_ID)) as unknown as ReadAttachmentFace | undefined
  assert.ok(binding2 !== undefined, 'the reincarnated viewer retains its own binding')
  assert.notEqual(binding2, binding1, 'the reopened viewer must own a NEW binding object')
  assert.notEqual(app.getViewerGeneration(), generation1, 'the reopened viewer is a new generation')
  assert.match(scope2.key, /^child:\d+:/u, 'the reopened viewer keys a child lifetime')
  assert.notEqual(scope2.key, scope1.key, 'the reincarnated scope key differs from the retired one')
  const lifetimeOf = (key: string): number => Number(/^child:(\d+):/u.exec(key)?.[1])
  assert.ok(lifetimeOf(scope2.key) > lifetimeOf(scope1.key),
    `the reopened viewer must be a LATER lifetime (${scope1.key} -> ${scope2.key})`)
  assert.notEqual(scope2, scope1, 'the reincarnated scope token is a distinct object')
  assert.equal(scope2.sessionId, CHILD_A_ID, 'both lifetimes address the same child Session id')
  assert.notEqual(scope2.transportToken, scope1.transportToken)
  assert.equal((scope2.transportToken as RemoteTransportLifetime).binding, binding2,
    'lifetime 2 pins the SUCCESSOR binding object')

  // (c) ARM the successor binding spy BEFORE any further ask: everything the
  // loader does from here on is observed by THIS spy instance.
  const successorReads: string[] = []
  const originalSuccessor = binding2.session.readAttachment
  binding2.session.readAttachment = async (id: unknown) => {
    successorReads.push(String(id))
    return originalSuccessor.call(binding2.session, id)
  }
  life.defer(() => { binding2.session.readAttachment = originalSuccessor })

  const calls = (): DurableReadCall[] =>
    readerSpy.routed.filter(call => call.attachmentId === orphan.attachmentId)
  // Await that call's REAL settle (not merely its presence), so every assertion
  // below is about an outcome rather than a dispatched count.
  const settledCall = async (index: number): Promise<DurableReadCall> => {
    await waitFor(`read #${index + 1} of the ref settled`, () => calls()[index]?.outcome !== undefined, 20_000)
    return calls()[index]!
  }

  // (d) The OLD scope legitimately RETRIES after its error (the loader only
  // blocks on a cached/in-flight entry, never on a recorded failure). The retry
  // is still stamped with the retired lifetime, so it must be refused by the
  // binding-identity fence BEFORE any Session call — the successor binding must
  // never see it.
  loader.load(orphan, scope1)
  const retiredRetry = await settledCall(1)
  assert.equal(retiredRetry.expectedLifetime, scope1.transportToken,
    'the retry still carries the RETIRED lifetime token')
  assert.equal(retiredRetry.outcome, 'failed', 'the retired lifetime must keep failing closed')
  assert.match(String(retiredRetry.error), new RegExp(CHILD_A_ID), 'the refusal names the CHILD Session')
  assert.match(String(retiredRetry.error), /retired/u, 'the refusal is the retired-binding fence')
  assert.equal(successorReads.length, 0,
    'ZERO successor-binding calls for the retired lifetime (the spy is armed and proven below)')

  // (e) The NEW scope's own ask is NOT blocked by the old scope's failure. The
  // ref is referenced by no Session, so the Host's bounded refusal is the honest
  // positive control — asserted as an outcome plus loader state, never a faked
  // served success.
  loader.load(orphan, scope2)
  const successorAsk = await settledCall(2)
  assert.equal(successorAsk.expectedLifetime, scope2.transportToken,
    'the new ask carries the SUCCESSOR lifetime token')
  assert.notEqual(successorAsk.expectedLifetime, retiredRetry.expectedLifetime)
  assert.equal(successorAsk.outcome, 'failed',
    'an unreferenced ref is refused by the Host, never served')
  assert.match(String(successorAsk.error), /not referenced by this session/u,
    'the successor ask reached the Session and got the Host reference refusal')
  assert.doesNotMatch(String(successorAsk.error), /retired|no retained Session binding/u,
    'the successor lifetime must NOT hit the lifetime fence')
  assert.equal(loader.get(orphan, scope2).state, 'error', 'lifetime 2 records its own refusal')
  assert.equal(loader.get(orphan, scope1).state, 'error', 'lifetime 1 keeps its own retired failure')
  assert.equal(successorReads.filter(id => id === orphan.attachmentId).length, 1,
    'ARMING PROOF: this very spy observed the new scope\'s call, so the zero-call assertion in (d) is not vacuous')
  assert.equal(readerSpy.served.has(address), false, 'the refused ref is never served in either scope')
})

test('L6 M3-6 PR2 §14.10: a durable image read under the STILL-OWNED presentation survives a same-binding reconnect; a different binding fails closed', async (t) => {
  // The frozen lifetime rule: a presentation captured under generation A +
  // binding X keeps its authority across a NORMAL reconnect (generation B +
  // the SAME binding X — the official adoption). A NEW image read started
  // under that presentation must be allowed and commits when B + X remain
  // current through the settle; only a DIFFERENT binding X2 retires it.
  const life = testLifecycle(t)
  const piTui = await import('@xmoon76/pi-tui') as unknown as {
    resetCapabilitiesCache(): void
    setCapabilities(caps: { images: 'kitty' | 'iterm2' | null; trueColor: boolean; hyperlinks: boolean }): void
  }
  piTui.resetCapabilitiesCache()
  piTui.setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  life.defer(() => { piTui.resetCapabilitiesCache() })

  const { host, fixture, app, sessions, viewport } = await mountTaskCenterFixture(life)
  const readerSpy = spyDurableImageReads(fixture)
  life.defer(readerSpy.restore)
  const loader = (app as unknown as MountedImageLoader).imageLoader
  const attachments = host.ctx.get('attachments') as unknown as FixtureAttachments

  // ── Open the child viewer: its presentation owns the child:1 lifetime and
  // the EXACT retained child binding.
  submit(app, '/tasks')
  await waitFor('the Task Center rendered the child row', () => viewport().includes(LABEL_A), 20_000)
  fixture.vt.sendInput('\r')
  await waitFor('the child viewer hydrated', () => viewport().includes('childa answer 30'), 20_000)
  const scope = currentImageScope(app)
  const bindingBefore = sessions.binding(SessionId(CHILD_A_ID))
  assert.ok(bindingBefore !== undefined, 'the presentation owns its exact binding before the reconnect')

  // ── A REAL durable image in the CHILD Session (referenced by a durable
  // child message, so the Session read can genuinely serve it).
  const png = await realPng('#0f0f0f', 3)
  const image = (await attachments.saveImages([{ data: png, mediaType: 'image/png', name: 'pr2-reconnect.png' }]))[0]!
  seedImageTurn(appenderOf(host.ctx, CHILD_A_ID), 50, 'reconnect image prompt', image)

  // ── The OFFICIAL reconnect (A -> B) with the SAME retained binding.
  const connection = fixture.aggregate.wire.client.connection as unknown as {
    generation: { getSnapshot(): { readonly id: number } | undefined }
    reconnect(): void
  }
  const generationBefore = connection.generation.getSnapshot()?.id
  connection.reconnect()
  await waitFor('a NEW DEFINED Connection generation is established', () => {
    const current = connection.generation.getSnapshot()?.id
    return current !== undefined && current !== generationBefore
  }, 20_000)
  assert.equal(sessions.binding(SessionId(CHILD_A_ID)), bindingBefore,
    'the retained child binding object survived the reconnect (the adoption)')

  // ── The post-reconnect read under the still-owned presentation: ALLOWED.
  // The read captures generation B for its own async fence and the bytes
  // commit because B + the same binding remain current through the settle.
  // (No `routed` clearing: the reconnect-triggered rehydrate may fire the
  // loader before this point; the attachmentId filter selects this image.)
  await waitFor('the reconnect image turn hydrated', () =>
    viewport().includes('reconnect image prompt'), 20_000)
  const imageKey = `${CHILD_A_ID}\u0000${image.attachmentId}`
  await waitFor('the still-owned presentation served the new image', () =>
    readerSpy.served.has(imageKey), 20_000)
  assert.deepEqual(readerSpy.served.get(imageKey), png,
    'the bytes committed under generation B + the SAME binding')
  const adoptedRead = readerSpy.routed.find(call => call.attachmentId === image.attachmentId)
  assert.ok(adoptedRead !== undefined, 'the post-reconnect read was issued')
  assert.equal(adoptedRead.sessionId, CHILD_A_ID, 'the read addressed the CHILD Session')
  assert.equal((adoptedRead.expectedLifetime as RemoteTransportLifetime).binding, bindingBefore,
    'the read carried the still-owned binding (never re-resolved)')

  // ── Negative control: the SAME session id under a DIFFERENT binding (the
  // real release/re-materialization) fails closed BEFORE the Session is
  // touched — the reincarnation shape this regression guards.
  const staleScope: ImageScopeToken = {
    ...scope,
    transportToken: {
      generation: connection.generation.getSnapshot(),
      binding: { other: true },
    } as unknown as RemoteTransportLifetime,
  }
  readerSpy.routed.length = 0
  loader.load({ ...image, attachmentId: `${image.attachmentId}-stale` }, staleScope)
  await waitFor('the stale-binding read settled', () => {
    const call = readerSpy.routed.find(entry => entry.attachmentId === `${image.attachmentId}-stale`)
    return call?.outcome !== undefined
  }, 20_000)
  const staleCall = readerSpy.routed.find(entry => entry.attachmentId === `${image.attachmentId}-stale`)!
  assert.equal(staleCall.outcome, 'failed',
    'a different binding fails closed')
  assert.match(String(staleCall.error), /retired/u,
    'the refusal is the retired-binding fence (a same-id rollover is NOT adoption)')
})
