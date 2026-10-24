/**
 * B3-A3: the REAL production `/tasks` (`/subagents`) entry on the official
 * Direct composition.
 *
 * Every case boots `createDirectTspFixture` (real Host services + live Agents,
 * the real TUI runner/`SubmissionController`/`CommandSurface`/
 * `SurfaceRuntime`/`TaskRuntime`, the real registered command, the real TSP
 * renderer over the shipped SDK). Only the tty/pane, the model endpoint and the
 * persisted Session artifacts are stands-ins. Nothing here calls
 * `openTasksBrowser` directly, replaces the classifier, or fakes the Task
 * Runtime: a case is green only when the REAL editor input reached the REAL
 * business opener through the registered command.
 *
 * PRODUCTION TOPOLOGY (plan §6.2)
 * REPRODUCED: registered TUI builtin + alias; live classifier; SubmissionController
 *             + input composer; CommandSurface runner; SurfaceRuntime; TaskRuntime;
 *             real TaskCenterPresentationPort; TSP SDK session; base + Reader;
 *             official `dsh-subagent` runtime + its `subagentCatalog` projection
 *             (the Direct descendant half) and the official `jobs` registry;
 *             currentness from the existing selected source.
 * STAND-INS:  actual terminal transport via the existing TspPane fixture;
 *             isolates persisted Session artifacts (the official persistence
 *             seam, `create`/`flush`/`close`) as the durable Session facts;
 *             scripted model endpoint.
 * ABSENT:     independent physical GUI compositor, real remote network,
 *             new Job writer/Stop/Viewer, any second TaskRuntime/SDK Session.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-tasks-production-entry.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createDirectTspFixture, waitFor, waitForInputDelivery, type DirectTspFixture } from '../support/direct-tsp-fixture.ts'
import { pickerNode, pickerProps, surfaceNodes, surfaceTexts, wireNodes } from '../support/tsp-picker-wire.ts'

const HUB = 'work-hub-'
const PARENT = 'a3-parent-session'
const CHILD = 'a3-child-session'

/** The latest controlled editor text committed for `dock.composer`. */
function composerText(fixture: DirectTspFixture): string | undefined {
  const composer = wireNodes(fixture.pane).find(node => node.id === 'dock.composer')
  return typeof composer?.p.text === 'string' ? composer.p.text : undefined
}

/** The live DOCK notice lines (never the transcript card). */
function dockNotices(fixture: DirectTspFixture): string[] {
  return wireNodes(fixture.pane)
    .filter(node => node.id.startsWith('dock.notice-'))
    .map(node => (typeof node.p.text === 'string' ? node.p.text : ''))
}

/** The Session ids the dock welcome card currently carries (the hydration signal). */
function welcomeSessionIds(fixture: DirectTspFixture): string[] {
  const prefix = 'dock.welcome-'
  return wireNodes(fixture.pane).filter(node => node.id.startsWith(prefix)).map(node => node.id.slice(prefix.length))
}

/** Type one `/` line into the REAL composer and submit it with Enter. */
async function submitLine(fixture: DirectTspFixture, line: string): Promise<void> {
  await waitForInputDelivery(fixture.pane)
  fixture.pane.input.type(line)
  await waitFor(`the composer to hold ${JSON.stringify(line)}`, () => composerText(fixture) === line, 25_000)
  fixture.pane.input.type('\r')
}

/** How many surfaces the SDK opened in `screen` mode (the Reader count). */
function screens(fixture: DirectTspFixture): number {
  return fixture.pane.openSurfaces().filter(entry => entry.mode === 'screen').length
}

/** The Hub's current item ids from the SDK wire. */
function hubIds(fixture: DirectTspFixture): string[] {
  const items = (pickerProps(fixture.pane, HUB).items ?? []) as Array<{ readonly id: string }>
  return items.map(item => item.id)
}

/** The persisted parent Session's real log append (the durable catalog fact). */
type Append = (type: string, data: unknown, options?: { surfaceOp?: 'append' }) => void

/**
 * Wait until the runner has resumed the persisted Session as a LIVE Agent.
 * The official Job registry only admits an owner whose Agent is live, and the
 * Direct Task read is addressed by that same live Session — so this is the
 * real readiness fact, not a fixed settle.
 */
async function liveSession(fixture: DirectTspFixture, sessionId: string): Promise<void> {
  const agents = fixture.ctx.get('agents') as unknown as {
    get(id: unknown): { session?: { id: string } } | undefined
  }
  await waitFor(`the live Agent of ${sessionId}`, () => agents.get(SessionId(sessionId)) !== undefined, 25_000)
}

async function appenderOf(fixture: DirectTspFixture, sessionId: string): Promise<Append> {
  type LiveSession = { append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void }
  const read = (): LiveSession | undefined => {
    const sessions = fixture.ctx.get('sessions') as unknown as { get(id: string): LiveSession | undefined }
    return sessions.get(sessionId)
  }
  // The runner resumes the persisted Session as a REAL start-up step, so the
  // durable fact can only be appended once that Session is live in the store.
  await waitFor(`the persisted Session ${sessionId} to be loaded`, () => read() !== undefined, 25_000)
  const session = read()!
  return (type, data, options) => session.append(type, data, options)
}

/**
 * Materialize the REAL Task facts this suite reads:
 * - a durable `subagent/catalog` entry on the parent Session (the official
 *   provider fact the Direct descendant read folds), and
 * - one REAL background Job owned by the parent Session through the official
 *   `jobs` registry.
 *
 * The child Session header (parent/origin/depth) is created by the fixture
 * through the official persistence seam, so the identity is a real Session.
 */
async function seedTaskFacts(fixture: DirectTspFixture): Promise<{ readonly jobId: string }> {
  await liveSession(fixture, PARENT)
  const parent = await appenderOf(fixture, PARENT)
  parent('subagent/catalog', {
    version: 1,
    childId: SessionId(CHILD),
    childCreatedAt: Date.now(),
    mode: 'continuable',
    label: 'A3 nested review',
  })
  const jobs = fixture.ctx.get('jobs') as unknown as {
    start(spec: unknown): string
  }
  const jobId = jobs.start({
    kind: 'bash',
    label: 'A3 integration build',
    owner: SessionId(PARENT),
    run: () => ({
      cancel: () => {},
      done: Promise.resolve({ status: 'failed', detail: 'exit code 3' }),
    }),
  })
  return { jobId }
}

// ── E01: the registered `/tasks` really opens the Work Hub ──────────────────

test('E01: /tasks from the real editor reaches the ONE TaskRuntime and mounts the native Work Hub', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  // The capability opt-in advertises `picker`/`row`/`overlay`/`text` + `scroll`
  // in the fixture's own HELLO (`col` is base): the exact negotiated vocabulary
  // the Hub and its Reader need. The production gate is decided by this real
  // handshake, never a stubbed boolean. `subagentRuntime` reproduces the
  // shipped base row the Direct Task read composes.
  const fixture = await createDirectTspFixture(life, {
    sessionBrowser: true,
    workingDirectory: true,
    officialServices: { subagentRuntime: true },
    persistedBlankSession: { id: PARENT },
    persistedBlankSessions: [{ id: CHILD, parentSession: PARENT, origin: 'subagent', delegationDepth: 1 }],
    startup: { sessionId: PARENT },
  })
  try {
    const { jobId } = await seedTaskFacts(fixture)
    await submitLine(fixture, '/tasks')
    await waitFor('the native Work Hub to mount from the real /tasks entry',
      () => pickerNode(fixture.pane, HUB) !== undefined, 25_000)
    // The rows are the REAL Task Runtime projection of the facts above: one
    // descendant from the durable catalog and one Job from the official
    // registry. Nothing here injects a panel item.
    await waitFor('both real rows to reach the Hub', () =>
      hubIds(fixture).includes(`agent:${CHILD}`) && hubIds(fixture).includes(`job:${jobId}`), 25_000)
    // The OLD placeholder must never appear: this command reached the opener.
    assert.ok(!fixture.pane.output.text().includes('Work Hub is not available in this renderer yet.'),
      'the capable pane never shows the unavailable placeholder')
    assert.ok(!fixture.pane.output.text().includes('not available in TSP'),
      'the command was admitted by the real capability gate')
    assert.equal(screens(fixture), 0, 'opening the Hub acquires no Screen by itself')
  } finally {
    // reason: fixture teardown — waits for the real SDK to release the tty and
    // every mounted fiber to settle; it is not an observation window.
    await fixture.settle()
  }
})

// ── E02: the registered alias `/subagents` rides the SAME opener ────────────

test('E02: the registered /subagents alias opens the same Hub and no second browser', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    sessionBrowser: true,
    workingDirectory: true,
    officialServices: { subagentRuntime: true },
    persistedBlankSession: { id: PARENT },
    persistedBlankSessions: [{ id: CHILD, parentSession: PARENT, origin: 'subagent', delegationDepth: 1 }],
    startup: { sessionId: PARENT },
  })
  try {
    await seedTaskFacts(fixture)
    await submitLine(fixture, '/subagents')
    await waitFor('the native Work Hub to mount from the real /subagents alias',
      () => pickerNode(fixture.pane, HUB) !== undefined, 25_000)
    // Exactly ONE Hub instance is mounted (one picker layer, not a second one).
    const hubs = fixture.pane.frames()
      .flatMap(frame => frame.ops)
      .filter(op => op[0] === 'add')
      .map(op => String((op[4] as unknown as { p?: { key?: string } }).p?.key ?? ''))
      .filter(key => key.startsWith(HUB))
    assert.ok(hubs.length > 0, 'the alias mounted the Hub')
    assert.equal(new Set(hubs).size, 1, 'the alias mounted exactly ONE Hub instance')
    assert.equal(screens(fixture), 0, 'the alias opens no Screen by itself')
  } finally {
    // reason: fixture teardown — waits for the real SDK to release the tty and
    // every mounted fiber to settle; it is not an observation window.
    await fixture.settle()
  }
})

// ── E03: select a real row and read it, then return to the SAME Hub ────────

test('E03: Enter opens ONE Reader for the current row and Back returns to the same Hub', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    sessionBrowser: true,
    workingDirectory: true,
    officialServices: { subagentRuntime: true },
    persistedBlankSession: { id: PARENT },
    persistedBlankSessions: [{ id: CHILD, parentSession: PARENT, origin: 'subagent', delegationDepth: 1 }],
    startup: { sessionId: PARENT },
  })
  try {
    const { jobId } = await seedTaskFacts(fixture)
    await submitLine(fixture, '/tasks')
    await waitFor('the native Work Hub to mount', () => pickerNode(fixture.pane, HUB) !== undefined, 25_000)
    await waitFor('the real Job row reaches the Hub', () => hubIds(fixture).includes(`job:${jobId}`), 25_000)
    const target = `job:${jobId}`
    // Drive the SDK's own SELECT shape for the target row, then prove the Hub
    // really holds that selection before Enter (never an assumed default row).
    fixture.pane.event({
      ev: 'select',
      sf: fixture.pane.frames().at(-1)!.sf,
      id: pickerNode(fixture.pane, HUB)!.id,
      item: target,
    })
    await waitFor('the target row is selected', () => pickerProps(fixture.pane, HUB).selected === target, 25_000)

    fixture.pane.key('\r')
    await waitFor('exactly ONE Reader Screen', () => screens(fixture) === 1, 25_000)
    const reader = [...fixture.pane.openSurfaces()].reverse().find(entry => entry.mode === 'screen')!.id
    await waitFor('the Reader document is painted', () => surfaceNodes(fixture.pane, reader).length > 0, 25_000)
    const content = surfaceTexts(fixture.pane, reader)
    assert.equal(content[0], '← Work', 'the Reader carries the native Back row')
    assert.ok(content.includes(`Stable ID ${target}`), 'the Reader reads the SELECTED real row')

    fixture.pane.key('\u001b')
    await waitFor('the Reader Screen closes', () => fixture.pane.closedSurfaceIds().includes(reader), 25_000)
    await waitFor('the SAME Hub is current again',
      () => pickerProps(fixture.pane, HUB).selected === target, 25_000)
    assert.equal(screens(fixture), 1, 'reading acquired exactly ONE Screen over the run')
    assert.equal(pickerProps(fixture.pane, HUB).selected, target, 'the Hub kept its selection')
  } finally {
    // reason: fixture teardown — waits for the real SDK to release the tty and
    // every mounted fiber to settle; it is not an observation window.
    await fixture.settle()
  }
})

// ── E05: a pane without the capability refuses the command, draft restored ─

test('E05: a lean pane refuses /tasks, restores the draft, opens no Hub and no Screen', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  // The DEFAULT fixture HELLO has no `picker`/`row`/`text`/`scroll`: the real
  // negotiated capability is false, so the production admission must refuse.
  const fixture = await createDirectTspFixture(life, {})
  try {
    await submitLine(fixture, '/tasks')
    await waitFor('the capability refusal notice',
      () => fixture.pane.output.text().includes('not available in TSP'), 25_000)
    assert.equal(composerText(fixture), '/tasks', 'the original draft was restored')
    assert.equal(pickerNode(fixture.pane, HUB), undefined, 'no Work Hub was mounted')
    assert.equal(screens(fixture), 0, 'no Reader Screen was acquired')
    assert.ok(dockNotices(fixture).some(text => text.includes('not available in TSP')),
      'the refusal is a visible dock notice')
    assert.equal(fixture.modelCalls(), 0, 'the refused command never reached the model')
  } finally {
    // reason: fixture teardown — waits for the real SDK to release the tty and
    // every mounted fiber to settle; it is not an observation window.
    await fixture.settle()
  }
})

// ── E06: a genuine Host `/tasks` keeps its own sink (never captured) ───────

test('E06: a genuine Host command named tasks keeps its Host sink and never opens the Hub', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const calls: string[] = []
  const fixture = await createDirectTspFixture(life, {
    sessionBrowser: true,
    hostCommands: [{
      name: 'tasks',
      description: 'Host-owned tasks',
      definitionId: 'host-tasks-def',
      handler: (invocation) => { calls.push(invocation.rawInput); return { kind: 'success', text: 'host tasks ran' } },
    }],
  })
  try {
    await submitLine(fixture, '/tasks')
    await waitFor('the genuine Host /tasks sink', () => calls.length > 0, 25_000)
    assert.equal(calls.length, 1, 'the Host handler ran exactly once')
    assert.equal(pickerNode(fixture.pane, HUB), undefined,
      'the TUI Task Center never captured a Host-owned winner')
    assert.equal(screens(fixture), 0)
  } finally {
    // reason: fixture teardown — waits for the real SDK to release the tty and
    // every mounted fiber to settle; it is not an observation window.
    await fixture.settle()
  }
})

test('E06b: a genuine Host command named subagents keeps its Host sink on the alias spelling', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const calls: string[] = []
  const fixture = await createDirectTspFixture(life, {
    sessionBrowser: true,
    hostCommands: [{
      name: 'subagents',
      description: 'Host-owned subagents',
      definitionId: 'host-subagents-def',
      handler: (invocation) => { calls.push(invocation.rawInput); return { kind: 'success', text: 'host subagents ran' } },
    }],
  })
  try {
    await submitLine(fixture, '/subagents')
    await waitFor('the genuine Host /subagents sink', () => calls.length > 0, 25_000)
    assert.equal(calls.length, 1, 'the Host handler ran exactly once')
    assert.equal(pickerNode(fixture.pane, HUB), undefined,
      'the TUI Task Center never captured the Host alias winner')
  } finally {
    // reason: fixture teardown — waits for the real SDK to release the tty and
    // every mounted fiber to settle; it is not an observation window.
    await fixture.settle()
  }
})

// ── E04: partial feeds state only what the real source really has ──────────

test('E04: a Job-only roster shows the real Job and invents no descendant row', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  // The parent Session carries NO `subagent/catalog` entry: the descendant half
  // of the read is genuinely empty while the Job half is real.
  const fixture = await createDirectTspFixture(life, {
    sessionBrowser: true,
    workingDirectory: true,
    officialServices: { subagentRuntime: true },
    persistedBlankSession: { id: PARENT },
    startup: { sessionId: PARENT },
  })
  try {
    // The Job owner must be the LIVE Agent of the resumed Session, so the
    // durable Session has to be loaded before the registry admits the owner.
    await liveSession(fixture, PARENT)
    const jobs = fixture.ctx.get('jobs') as unknown as { start(spec: unknown): string }
    const jobId = jobs.start({
      kind: 'bash',
      label: 'A3 job only',
      owner: SessionId(PARENT),
      run: () => ({ cancel: () => {}, done: Promise.resolve({ status: 'running' }) }),
    })
    await submitLine(fixture, '/tasks')
    await waitFor('the real Job row reaches the Hub', () => hubIds(fixture).includes(`job:${jobId}`), 25_000)
    const ids = hubIds(fixture)
    assert.deepEqual(ids.filter(id => id.startsWith('agent:')), [],
      'no descendant row is invented when the catalog is empty')
    assert.ok(ids.includes(`job:${jobId}`), 'the real Job row is present')
  } finally {
    // reason: fixture teardown — waits for the real SDK to release the tty and
    // every mounted fiber to settle; it is not an observation window.
    await fixture.settle()
  }
})

test('E04b: an empty roster states the real empty Hub and invents no work item', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    sessionBrowser: true,
    workingDirectory: true,
    officialServices: { subagentRuntime: true },
    persistedBlankSession: { id: PARENT },
    startup: { sessionId: PARENT },
  })
  try {
    await submitLine(fixture, '/tasks')
    await waitFor('the Hub mounts', () => pickerNode(fixture.pane, HUB) !== undefined, 25_000)
    // The real read really completed (the Hub left its loading state), and the
    // roster is empty because there is nothing to list.
    await waitFor('the Hub left its loading state',
      () => pickerProps(fixture.pane, HUB).loading !== true, 25_000)
    assert.deepEqual(hubIds(fixture), [], 'an empty real roster projects no work item')
    // Still a usable surface: no fake completed entry, and the close action exists.
    const actions = (pickerProps(fixture.pane, HUB).actions ?? []) as Array<{ readonly id: string }>
    assert.ok(actions.some(action => action.id === 'close'), 'the empty Hub keeps its Close action')
  } finally {
    // reason: fixture teardown — waits for the real SDK to release the tty and
    // every mounted fiber to settle; it is not an observation window.
    await fixture.settle()
  }
})

// ── E12: the Work Hub is read-only over the REAL business sinks ────────────

test('E12: reading every real row never stops a Job, interrupts a subagent or calls onSelect', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    sessionBrowser: true,
    workingDirectory: true,
    officialServices: { subagentRuntime: true },
    persistedBlankSession: { id: PARENT },
    persistedBlankSessions: [{ id: CHILD, parentSession: PARENT, origin: 'subagent', delegationDepth: 1 }],
    startup: { sessionId: PARENT },
  })
  try {
    const { jobId } = await seedTaskFacts(fixture)
    // The REAL business sink: the official Job registry's own `kill`. A Stop
    // from the Hub would have to reach it (the Direct observation port calls
    // `registry.kill`); the recorder is the production method itself.
    const registry = fixture.ctx.get('jobs') as unknown as { kill(...args: unknown[]): string }
    const originalKill = registry.kill
    const kills: unknown[][] = []
    registry.kill = function (this: unknown, ...args: unknown[]): string {
      kills.push(args)
      return originalKill.apply(this, args)
    }
    try {
      await submitLine(fixture, '/tasks')
      await waitFor('both real rows reach the Hub', () =>
        hubIds(fixture).includes(`job:${jobId}`) && hubIds(fixture).includes(`agent:${CHILD}`), 25_000)

      // Read BOTH rows through the production Reader and return each time.
      for (const target of [`job:${jobId}`, `agent:${CHILD}`]) {
        fixture.pane.event({
          ev: 'select',
          sf: fixture.pane.frames().at(-1)!.sf,
          id: pickerNode(fixture.pane, HUB)!.id,
          item: target,
        })
        await waitFor(`the row ${target} is selected`, () => pickerProps(fixture.pane, HUB).selected === target, 25_000)
        const before = screens(fixture)
        fixture.pane.key('\r')
        await waitFor(`the Reader for ${target}`, () => screens(fixture) === before + 1, 25_000)
        const reader = [...fixture.pane.openSurfaces()].reverse().find(entry => entry.mode === 'screen')!.id
        await waitFor('the Reader painted', () => surfaceNodes(fixture.pane, reader).length > 0, 25_000)
        fixture.pane.key('\u001b')
        await waitFor('the Reader closed', () => fixture.pane.closedSurfaceIds().includes(reader), 25_000)
      }

      assert.deepEqual(kills, [], 'reading a Job never reaches the registry kill sink')
      const actionIds = ((pickerProps(fixture.pane, HUB).actions ?? []) as Array<{ readonly id: string }>).map(a => a.id)
      assert.ok(!actionIds.includes('stop'), 'the TSP Hub offers no Stop action at all')
      assert.ok(!actionIds.includes('interrupt'), 'the TSP Hub offers no Interrupt action at all')
      assert.ok(!actionIds.includes('answer'), 'the TSP Hub offers no Answer action at all')
      assert.ok(actionIds.includes('close'), 'the Hub keeps its Close action')
    } finally {
      registry.kill = originalKill
    }
  } finally {
    // reason: fixture teardown — waits for the real SDK to release the tty and
    // every mounted fiber to settle; it is not an observation window.
    await fixture.settle()
  }
})

// ── E07: a genuinely sessionless submission creates the Session it needs ────

test('E07: /tasks with NO Session follows the original ensureSession path and then opens the Hub', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  // NO persisted Session and NO `startup.sessionId`: the runner boots
  // sessionless (deferred start), which is exactly the state E07 describes.
  const fixture = await createDirectTspFixture(life, {
    sessionBrowser: true,
    workingDirectory: true,
    officialServices: { subagentRuntime: true },
  })
  const sessions = fixture.ctx.get('sessions') as unknown as { list(): readonly unknown[] }
  const agents = fixture.ctx.get('agents') as unknown as { list(): readonly unknown[] }
  try {
    assert.equal(sessions.list().length, 0, 'the composition really starts with NO Session')
    assert.equal(agents.list().length, 0, 'and therefore no live Agent')
    // The negative control is the state itself: with NO Session the Task
    // Runtime's opener returns before mounting anything (`browserSessionId ===
    // undefined`), so a Hub can only appear because the composed submission
    // created the Session first. Proving the Hub really appears below therefore
    // proves the deferred-start path — a no-session fallback would leave the
    // picker absent and fail here.
    await submitLine(fixture, '/tasks')
    // The composed path must create the Session and then open the Hub on it.
    await waitFor('the Hub opens on the Session the submission created',
      () => pickerNode(fixture.pane, HUB) !== undefined, 25_000)
    assert.equal(sessions.list().length, 1, 'exactly ONE Session was created by the submission path')
    assert.equal(agents.list().length, 1, 'and its live Agent exists')
    assert.ok(!fixture.pane.output.text().includes('not available in TSP'),
      'the capability gate admitted the command (no refusal was needed)')
    assert.equal(screens(fixture), 0, 'opening the Hub acquires no Reader')
    // The Hub is the REAL empty roster of the Session that was just created.
    assert.deepEqual(hubIds(fixture), [], 'the fresh Session has no work to list yet')
    const props = pickerProps(fixture.pane, HUB)
    assert.equal(props.loading, undefined, 'the real read settled (no stuck loading state)')
  } finally {
    // reason: fixture teardown — waits for the real SDK to release the tty and
    // every mounted fiber to settle; it is not an observation window.
    await fixture.settle()
  }
})

// ── An extension contribution cannot claim a TUI builtin's name at all ──────

test('E06c: the REAL extension service REFUSES a contribution named tasks, so no extension winner can exist', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  // The name conflict is rejected by the extension service itself (it returns a
  // `conflict` outcome and the registration throws), so an extension cannot
  // become the winner for an already-registered TUI builtin. That is why the
  // admission cannot "capture" an extension `/tasks`: the situation is
  // unrepresentable rather than merely unhandled.
  await assert.rejects(
    createDirectTspFixture(life, {
      sessionBrowser: true,
      extensionCommands: [{
        id: 'ext-tasks',
        name: 'tasks',
        description: 'Extension-owned tasks',
        handler: () => ({ kind: 'success', text: 'extension tasks ran' }),
      }],
    }),
    /command contribution "tasks" conflicts/,
    'the extension service refuses the conflicting registration',
  )
})

test('E06d: the same conflict rule covers the /subagents alias spelling', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  await assert.rejects(
    createDirectTspFixture(life, {
      sessionBrowser: true,
      extensionCommands: [{
        id: 'ext-subagents',
        name: 'subagents',
        description: 'Extension-owned subagents',
        handler: () => ({ kind: 'success', text: 'extension subagents ran' }),
      }],
    }),
    /command contribution "subagents" conflicts/,
    'the registered alias is equally protected from an extension takeover',
  )
})

test('E06e: with the conflicting registration refused, the builtin /tasks still opens the real Hub', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    sessionBrowser: true,
    workingDirectory: true,
    officialServices: { subagentRuntime: true },
    persistedBlankSession: { id: PARENT },
    startup: { sessionId: PARENT },
  })
  try {
    await liveSession(fixture, PARENT)
    await submitLine(fixture, '/tasks')
    await waitFor('the builtin /tasks still owns the name', () => pickerNode(fixture.pane, HUB) !== undefined, 25_000)
    assert.deepEqual(hubIds(fixture), [], 'the real empty roster of the resumed Session')
  } finally {
    // reason: fixture teardown — waits for the real SDK to release the tty and
    // every mounted fiber to settle; it is not an observation window.
    await fixture.settle()
  }
})

// ── E09: a real Session switch through the production Session Browser ───────

test('E09: switching Session A→B through the real Browser leaves B with only B rows', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const A = 'a3-switch-a'
  const B = 'a3-switch-b'
  const fixture = await createDirectTspFixture(life, {
    sessionBrowser: true,
    workingDirectory: true,
    officialServices: { subagentRuntime: true },
    persistedBlankSession: { id: A },
    persistedBlankSessions: [{ id: B }],
    startup: { sessionId: A },
  })
  try {
    await liveSession(fixture, A)
    // One real Job owned by A: A's roster must be non-empty BEFORE the switch.
    const jobs = fixture.ctx.get('jobs') as unknown as { start(spec: unknown): string }
    const jobA = jobs.start({
      kind: 'bash',
      label: 'A-only build',
      owner: SessionId(A),
      run: () => ({ cancel: () => {}, done: Promise.resolve({ status: 'running' }) }),
    })
    await submitLine(fixture, '/tasks')
    await waitFor('A\'s Hub shows A\'s real Job', () => hubIds(fixture).includes(`job:${jobA}`), 25_000)
    // Close the Hub so the composer is editable again, then switch through the
    // PRODUCTION Session Browser (`/sessions` → select B → Resume).
    fixture.pane.key('\u001b')
    await waitFor('the Hub closed', () => pickerNode(fixture.pane, HUB) === undefined, 25_000)
    await submitLine(fixture, '/sessions')
    const BROWSER = 'session-browser-'
    await waitFor('the real Session Browser opened', () => pickerNode(fixture.pane, BROWSER) !== undefined, 25_000)
    const rowId = (() => {
      const items = (pickerProps(fixture.pane, BROWSER).items ?? []) as Array<{ readonly id: string }>
      return items.find(item => item.id.includes(B))?.id
    })()
    assert.ok(rowId !== undefined, 'the real Browser lists Session B')
    fixture.pane.event({
      ev: 'select',
      sf: fixture.pane.frames().at(-1)!.sf,
      id: pickerNode(fixture.pane, BROWSER)!.id,
      item: rowId,
    })
    await waitFor('B is the Browser selection', () => pickerProps(fixture.pane, BROWSER).selected === rowId, 25_000)
    // A confirmed pointer/action Resume is the production switch intent.
    const resume = ((pickerProps(fixture.pane, BROWSER).actions ?? []) as Array<{ readonly id: string; readonly disabled?: boolean }>)
      .find(action => action.id.startsWith('resume'))
    assert.ok(resume !== undefined && resume.disabled !== true, 'Resume is offered for the persisted B')
    fixture.pane.event({ ev: 'action', sf: fixture.pane.frames().at(-1)!.sf, id: pickerNode(fixture.pane, BROWSER)!.id, act: String(resume!.id) })
    await waitFor('the Browser retired after the switch', () => pickerNode(fixture.pane, BROWSER) === undefined, 25_000)
    // The switch really moved the live owner to B.
    const agents = fixture.ctx.get('agents') as unknown as { get(id: unknown): { session: { id: string } } | undefined }
    await waitFor('B owns the live Agent', () => agents.get(SessionId(B)) !== undefined, 25_000)

    // Reopen /tasks. The renderer's hydration fence drops ordinary keys while
    // the new subject is applied, so the dock naming B is the authoritative
    // "B is live" gate for typing.
    await waitFor('the dock names the switched Session B',
      () => welcomeSessionIds(fixture).includes(B), 25_000)
    // Give B its OWN work BEFORE reopening: a roster that merely happens to be
    // empty cannot distinguish "read B" from "kept reading A's stale subject",
    // so the proof needs a positive B row AND the absence of A's row.
    const jobB = jobs.start({
      kind: 'bash',
      label: 'B-only build',
      owner: SessionId(B),
      run: () => ({ cancel: () => {}, done: Promise.resolve({ status: 'running' }) }),
    })
    await submitLine(fixture, '/tasks')
    await waitFor('B\'s OWN Job reaches the Hub', () => hubIds(fixture).includes(`job:${jobB}`), 25_000)
    const idsB = hubIds(fixture)
    assert.ok(idsB.includes(`job:${jobB}`), `B's own Job is listed (got ${idsB.join(',')})`)
    assert.ok(!idsB.includes(`job:${jobA}`), `A's Job never appears in B's Hub (got ${idsB.join(',')})`)
    assert.deepEqual(idsB, [`job:${jobB}`], 'B lists exactly B\'s own work')
    assert.equal(screens(fixture), 0, 'the switch left no Reader Screen behind')
  } finally {
    // reason: fixture teardown — waits for the real SDK to release the tty and
    // every mounted fiber to settle; it is not an observation window.
    await fixture.settle()
  }
})
