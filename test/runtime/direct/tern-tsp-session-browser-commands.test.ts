/** Real command registration → native Session Browser → guarded switch → Direct Reader reread. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectSessionReader } from '../../../src/runtime/direct/session-direct.ts'
import type { SessionContentSearchPage, SessionSummary } from '../../../src/runtime/session-reader-port.ts'
import { createDirectTspFixture, directSettle, waitFor, waitForInputDelivery, type DirectTspFixture } from '../../support/direct-tsp-fixture.ts'
import { pickerActionByBase, pickerNode, pickerProps, sendActivate, sendPickerAction, sendSelect, wireNodes } from '../../support/tsp-picker-wire.ts'

const BROWSER = 'session-browser-'

function browserItems(pane: Parameters<typeof pickerProps>[0]): Array<{ readonly id?: string }> {
  return (pickerProps(pane, BROWSER).items ?? []) as Array<{ readonly id?: string }>
}

function currentContains(pane: Parameters<typeof pickerProps>[0], sessionId: string): boolean {
  if (pickerNode(pane, BROWSER) === undefined) return false
  const current = pickerProps(pane, BROWSER).current
  return Array.isArray(current) && current.includes(`session:${sessionId}`)
}

function composerText(pane: Parameters<typeof wireNodes>[0]): string | undefined {
  const composer = wireNodes(pane).find((node) => node.id === 'dock.composer')
  return typeof composer?.p.text === 'string' ? composer.p.text : undefined
}

async function submitInput(
  pane: Parameters<typeof pickerProps>[0],
  command: string,
): Promise<void> {
  pane.input.type(command)
  await waitFor(`composer receives ${command}`, () => composerText(pane) === command)
  await directSettle()
  pane.input.type('\r')
}

/**
 * The live Host Agents this Direct surface owns, by Session id.
 *
 * AUTHORITY: the real Host `agents` registry — the runner resumes/creates an
 * Agent there and retires it there. The retired Dock welcome line only DISPLAYED
 * an id the registry already owned, so "the current Agent" is now read at its
 * owner instead of through the renderer: it answers `[]` for a sessionless
 * surface (a positive sessionless fact, which the old line proved only by its
 * absence) and it answers with the id a switch really published.
 */
function liveAgentIds(fixture: DirectTspFixture): string[] {
  const agents = fixture.ctx.get('agents') as unknown as { list(): readonly { session: { id: string } }[] }
  return agents.list().map(agent => agent.session.id)
}

/** The authoritative persisted Session headers (the official persistence seam). */
async function sessionHeaders(fixture: DirectTspFixture): Promise<Array<{ id: string }>> {
  const persistence = fixture.ctx.get('sessionPersistence') as unknown as {
    list(): Promise<readonly { header: { id: string } }[]>
  }
  return (await persistence.list()).map(row => ({ id: row.header.id }))
}

/**
 * Wait until the REAL Session store holds exactly one NEW row beyond `known` and
 * return its id. This is the id authority for "the turn created this Session":
 * the store row IS the Session, where the retired Dock line was a display of it.
 */
async function waitForNewSessionId(
  fixture: DirectTspFixture,
  label: string,
  known: readonly string[],
  timeoutMs = 25_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const fresh = (await sessionHeaders(fixture)).filter(row => !known.includes(row.id))
    if (fresh.length === 1) return fresh[0]!.id
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} (got ${JSON.stringify(fresh)})`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** Whether Main currently presents the TSP-7 Welcome D empty state: a
 *  sessionless or blank main subject. NEVER a Session identity witness. */
function welcomeMainPresented(pane: Parameters<typeof wireNodes>[0]): boolean {
  return wireNodes(pane).some(node => node.id.startsWith('main.welcome-'))
}

/**
 * The projection scope identity the renderer is currently showing (`s3`), or
 * `undefined` while it sits BETWEEN scopes — the Loading state, in which the
 * transcript carries no scoped row at all.
 */
function projectionScopeId(pane: Parameters<typeof wireNodes>[0]): string | undefined {
  for (const node of wireNodes(pane)) {
    const match = /main\.(s\d+)-/u.exec(node.id)
    if (match !== null) return match[1]
  }
  return undefined
}

/**
 * Wait until a NEW projection scope has committed.
 *
 * The renderer fences the composer input between a session switch's
 * `beginSessionHydration()` and the new subject's first committed frame: a
 * key typed in that window is DROPPED, not held, so no later wait can
 * recover it. The fence lifts exactly when the new scope commits
 * (`src/tui/tsp/session.ts`: `hydrating = false` and `scopeEpoch += 1` are
 * the same commit), so "a new scope is on the wire" IS "the composer
 * accepts input again".
 *
 * The Browser's DISAPPEARANCE is not that signal: the switch retires the
 * Browser first and only then starts the hydration, so a test that types as
 * soon as the Browser is gone can land inside the fence and lose the input.
 */
async function waitForNewProjectionScope(
  pane: Parameters<typeof wireNodes>[0],
  previous: string | undefined,
): Promise<string> {
  let committed: string | undefined
  await waitFor('the new projection scope commits', () => {
    const current = projectionScopeId(pane)
    if (current === undefined || current === previous) return false
    committed = current
    return true
  })
  return committed!
}

test('sessionless resume, UI A→B, and typed resume follow the production lifecycle', async (t) => {
  const { testLifecycle } = await import('../../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const workRoot = life.tempDir('dsh-b1b-session-store-')
  const listCalls: Array<{
    readonly reader: DirectSessionReader
    readonly currentSessionId: string | undefined
    readonly rows: SessionSummary[] | undefined
  }> = []
  const originalList = DirectSessionReader.prototype.list
  DirectSessionReader.prototype.list = async function (currentSessionId, signal) {
    const rows = await originalList.call(this, currentSessionId, signal)
    listCalls.push({ reader: this, currentSessionId, rows })
    return rows
  }
  life.defer(() => { DirectSessionReader.prototype.list = originalList })
  const searchCalls: Array<{
    readonly reader: DirectSessionReader
    readonly query: string
    readonly page: SessionContentSearchPage | undefined
  }> = []
  const originalSearch = DirectSessionReader.prototype.search
  DirectSessionReader.prototype.search = async function (query, signal) {
    const page = await originalSearch.call(this, query, signal)
    searchCalls.push({ reader: this, query, page })
    return page
  }
  life.defer(() => { DirectSessionReader.prototype.search = originalSearch })

  const seedA = await createDirectTspFixture(life, { workRoot })
  let sourceId: string | undefined
  try {
    await waitForInputDelivery(seedA.pane)
    await submitInput(seedA.pane, 'seed session A')
    await waitFor('the first real Agent completes its seed turn', () => seedA.modelCalls() === 1)
    // The seed turn's Session id is the store's new row (the durable fact), not
    // a line the renderer used to paint.
    sourceId = await waitForNewSessionId(seedA, 'the seed A Session in the real store', [])
    assert.ok(sourceId)
  } finally {
    await seedA.settle()
  }
  assert.ok(sourceId)

  const seedB = await createDirectTspFixture(life, { workRoot })
  let targetId: string | undefined
  try {
    await waitForInputDelivery(seedB.pane)
    await directSettle(4_000)
    // "Does not resume A implicitly" is now TWO positive facts: the Host
    // registry owns no Agent at all, and Main presents the sessionless Welcome D
    // empty state — while A stays exactly one durable row in the shared store.
    assert.deepEqual(liveAgentIds(seedB), [], 'a fresh sessionless runner owns no live Agent')
    assert.ok(welcomeMainPresented(seedB.pane), 'a fresh runner presents the sessionless Welcome empty state')
    assert.deepEqual((await sessionHeaders(seedB)).map(row => row.id), [sourceId],
      'the shared store holds A and nothing else')
    await submitInput(seedB.pane, 'seed session B')
    await waitFor('the second real Agent completes its seed turn', () => seedB.modelCalls() === 1)
    targetId = await waitForNewSessionId(seedB, 'the seed B Session in the real store', [sourceId])
    assert.ok(targetId)
    assert.notEqual(targetId, sourceId)
  } finally {
    await seedB.settle()
  }
  assert.ok(targetId)

  const fixture = await createDirectTspFixture(life, { sessionBrowser: true, workRoot })
  const lifecycleTrace: Array<{
    readonly kind: 'flush' | 'open'
    readonly sessionId: string
    readonly outcome: 'starting' | 'opened' | 'flushed' | 'not-flushed' | 'rejected'
  }> = []
  const sessions = fixture.ctx.get('sessions') as unknown as { flush(session: unknown): Promise<boolean> }
  const agents = fixture.ctx.get('agents') as unknown as { resume(options: unknown): Promise<unknown> }
  const originalFlush = sessions.flush
  const originalResume = agents.resume
  let failNextFlushFor: string | undefined
  let rejectNextOpenFor: string | undefined
  sessions.flush = async function (this: typeof sessions, session: unknown): Promise<boolean> {
    const sessionId = String((session as { readonly id: unknown }).id)
    try {
      if (sessionId === failNextFlushFor) {
        failNextFlushFor = undefined
        throw new Error('controlled Direct flush refusal')
      }
      const flushed = await originalFlush.call(this, session)
      lifecycleTrace.push({ kind: 'flush', sessionId, outcome: flushed ? 'flushed' : 'not-flushed' })
      return flushed
    } catch (error) {
      lifecycleTrace.push({ kind: 'flush', sessionId, outcome: 'rejected' })
      throw error
    }
  }
  agents.resume = async function (this: typeof agents, options: unknown): Promise<unknown> {
    const sessionId = String((options as { readonly resumeSessionId: unknown }).resumeSessionId)
    lifecycleTrace.push({ kind: 'open', sessionId, outcome: 'starting' })
    try {
      if (sessionId === rejectNextOpenFor) {
        rejectNextOpenFor = undefined
        throw new Error('controlled Direct open refusal')
      }
      const handle = await originalResume.call(this, options)
      lifecycleTrace.push({ kind: 'open', sessionId, outcome: 'opened' })
      return handle
    } catch (error) {
      lifecycleTrace.push({ kind: 'open', sessionId, outcome: 'rejected' })
      throw error
    }
  }
  const assertOldFlushBeforeOpen = (start: number, oldSessionId: string, nextSessionId: string): void => {
    const events = lifecycleTrace.slice(start)
    const openIndex = events.findIndex((event) => event.kind === 'open'
      && event.sessionId === nextSessionId && event.outcome === 'starting')
    assert.ok(openIndex >= 0, `Direct SessionLifecycle.open(${nextSessionId}) reached agents.resume`)
    const prior = events.slice(0, openIndex)
    assert.ok(prior.some((event) => event.kind === 'flush'
      && event.sessionId === oldSessionId && event.outcome === 'flushed'),
    `the old session ${oldSessionId} flushes before open(${nextSessionId}): ${JSON.stringify(prior)}`)
    assert.equal(prior.some((event) => event.kind === 'flush'
      && event.sessionId === oldSessionId && event.outcome === 'rejected'), false)
  }
  try {
    await waitForInputDelivery(fixture.pane)
    await directSettle(4_000)
    // "No current Agent" is the Host registry's own fact, plus the sessionless
    // Welcome D in Main; the retired Dock line was only a display of the same.
    assert.deepEqual(liveAgentIds(fixture), [], 'the Browser fixture starts without a current Agent')
    assert.ok(welcomeMainPresented(fixture.pane), 'the Browser fixture presents the sessionless Welcome empty state')
    const initialList = listCalls.length
    await submitInput(fixture.pane, '/sessions')
    await waitFor('the registered /sessions command opens the native Browser', () => pickerNode(fixture.pane, BROWSER) !== undefined)
    await waitFor('the sessionless Reader lists persisted A and B', () => listCalls.length > initialList, 5_000)
    await waitFor('both persisted sessions appear in the Browser', () => [sourceId, targetId].every((id) =>
      browserItems(fixture.pane).some((item) => item.id === `session:${id}`)), 5_000)
    assert.deepEqual(pickerProps(fixture.pane, BROWSER).current, [], 'the sessionless Browser has no current row')
    assert.equal(listCalls.length, initialList + 1)
    assert.equal(listCalls[initialList]?.currentSessionId, undefined)
    assert.deepEqual(listCalls[initialList]?.rows?.map((row) => row.id).sort(), [sourceId, targetId].sort())
    assert.equal(fixture.modelCalls(), 0, 'opening the Browser creates no blank Agent or model turn')

    const firstPicker = pickerNode(fixture.pane, BROWSER)!.id
    sendSelect(fixture.pane, `session:${targetId}`, firstPicker)
    await waitFor('the sessionless target is selected', () => pickerProps(fixture.pane, BROWSER).selected === `session:${targetId}`)
    const sessionlessTraceStart = lifecycleTrace.length
    const scopeBeforeSessionlessResume = projectionScopeId(fixture.pane)
    fixture.pane.key('\r')
    await waitFor('the captured Browser retires after sessionless resume', () => pickerNode(fixture.pane, BROWSER) === undefined)
    // The Browser's retirement is NOT the end of the switch: the composer input
    // stays fenced until B's own projection scope commits.
    await waitForNewProjectionScope(fixture.pane, scopeBeforeSessionlessResume)
    assert.equal(lifecycleTrace.slice(sessionlessTraceStart).filter((event) => event.kind === 'open'
      && event.sessionId === targetId && event.outcome === 'starting').length, 1,
    'one Enter emits one Direct open from a sessionless Browser')

    const bReadStart = listCalls.length
    await submitInput(fixture.pane, '/sessions')
    await waitFor('B is current in the reopened Browser', () => currentContains(fixture.pane, targetId))
    await waitFor('the production Reader rereads the sessionless resume', () => listCalls.length > bReadStart)
    assert.equal(listCalls.length, bReadStart + 1)
    const bRead = listCalls[bReadStart]!
    assert.equal(bRead.currentSessionId, targetId)
    assert.ok(bRead.rows?.some((row) => row.id === targetId && row.live))
    assert.ok(bRead.rows?.some((row) => row.id === sourceId && !row.live))
    assert.equal(bRead.reader, listCalls[initialList]?.reader)
    sendPickerAction(fixture.pane, 'close', BROWSER)
    await waitFor('the Browser closes before the next command', () => pickerNode(fixture.pane, BROWSER) === undefined)

    const sessionsQueryStart = listCalls.length
    const sessionsContentSearchStart = searchCalls.length
    await submitInput(fixture.pane, '/sessions needle')
    await waitFor('/sessions query opens the Browser', () => pickerNode(fixture.pane, BROWSER) !== undefined)
    await waitFor('/sessions applies its initial query', () => pickerProps(fixture.pane, BROWSER).query === 'needle')
    await waitFor('/sessions query uses one authoritative list', () => listCalls.length > sessionsQueryStart)
    await waitFor('/sessions query reaches the official Direct content search', () => searchCalls.length > sessionsContentSearchStart)
    assert.equal(listCalls.length, sessionsQueryStart + 1)
    assert.equal(searchCalls.length, sessionsContentSearchStart + 1)
    assert.equal(searchCalls[sessionsContentSearchStart]?.query, 'needle')
    assert.equal(searchCalls[sessionsContentSearchStart]?.reader, listCalls[sessionsQueryStart]?.reader)
    sendPickerAction(fixture.pane, 'close', BROWSER)
    await waitFor('the /sessions query Browser closes', () => pickerNode(fixture.pane, BROWSER) === undefined)

    const searchStart = listCalls.length
    const contentSearchStart = searchCalls.length
    await submitInput(fixture.pane, '/search seed')
    await waitFor('/search opens the same Browser', () => pickerNode(fixture.pane, BROWSER) !== undefined)
    await waitFor('/search applies its initial query', () => pickerProps(fixture.pane, BROWSER).query === 'seed')
    await waitFor('/search reaches the official Direct content search', () => searchCalls.length > contentSearchStart)
    assert.equal(listCalls.length, searchStart + 1, 'the query rides the shared one-list Browser lifecycle')
    assert.equal(searchCalls.length, contentSearchStart + 1, 'one initial query emits one Direct content search')
    const directSearch = searchCalls[contentSearchStart]!
    assert.equal(directSearch.reader, listCalls[searchStart]?.reader)
    assert.equal(directSearch.query, 'seed')
    assert.ok(directSearch.page?.items.some((item) => item.sessionId === sourceId || item.sessionId === targetId),
      'the real Direct content-search result contains one of the seeded persisted Sessions')
    await waitFor('/search paints a Host content hit as a Card', () =>
      browserItems(fixture.pane).some((item) => item.id === `session:${sourceId}` || item.id === `session:${targetId}`))
    sendPickerAction(fixture.pane, 'close', BROWSER)
    await waitFor('the search Browser closes', () => pickerNode(fixture.pane, BROWSER) === undefined)

    const resumeAliasStart = listCalls.length
    await submitInput(fixture.pane, '/resume')
    await waitFor('bare /resume opens the shared Browser', () => pickerNode(fixture.pane, BROWSER) !== undefined)
    await waitFor('bare /resume lists once with B current', () => listCalls.length > resumeAliasStart
      && currentContains(fixture.pane, targetId))
    assert.equal(listCalls.length, resumeAliasStart + 1)
    assert.equal(pickerProps(fixture.pane, BROWSER).query, '')
    sendPickerAction(fixture.pane, 'close', BROWSER)
    await waitFor('the bare /resume Browser closes', () => pickerNode(fixture.pane, BROWSER) === undefined)

    const failureListStart = listCalls.length
    await submitInput(fixture.pane, '/sessions')
    await waitFor('the Browser opens under B before the refusal probe', () => currentContains(fixture.pane, targetId))
    await waitFor('the refusal probe uses one authoritative B listing', () => listCalls.length > failureListStart)
    assert.equal(listCalls.length, failureListStart + 1)
    const failurePicker = pickerNode(fixture.pane, BROWSER)!.id
    sendSelect(fixture.pane, `session:${sourceId}`, failurePicker)
    await waitFor('A is selected as the retryable Footer target', () => pickerProps(fixture.pane, BROWSER).selected === `session:${sourceId}`)
    assert.equal(pickerActionByBase(fixture.pane, 'resume', BROWSER)?.disabled, undefined)

    const noticesBeforeFlushFailure = new Set(wireNodes(fixture.pane)
      .filter((node) => node.id.startsWith('dock.notice-'))
      .map((node) => node.id))
    failNextFlushFor = targetId
    const flushFailureTraceStart = lifecycleTrace.length
    sendPickerAction(fixture.pane, 'resume', BROWSER)
    await waitFor('a refused old-session flush is visible and releases pending', () => {
      const notice = wireNodes(fixture.pane).find((node) => node.id.startsWith('dock.notice-')
        && !noticesBeforeFlushFailure.has(node.id))
      return notice !== undefined
        && String(notice.p.text).includes('controlled Direct flush refusal')
        && pickerNode(fixture.pane, BROWSER) !== undefined
        && pickerActionByBase(fixture.pane, 'resume', BROWSER)?.disabled === undefined
    })
    const flushNotice = wireNodes(fixture.pane).find((node) => node.id.startsWith('dock.notice-')
      && !noticesBeforeFlushFailure.has(node.id))
    assert.ok(flushNotice)
    assert.match(String(flushNotice.p.text), /controlled Direct flush refusal/u)
    const flushFailureEvents = lifecycleTrace.slice(flushFailureTraceStart)
    assert.equal(flushFailureEvents.filter((event) => event.kind === 'flush'
      && event.sessionId === targetId && event.outcome === 'rejected').length, 1)
    assert.equal(flushFailureEvents.some((event) => event.kind === 'open' && event.sessionId === sourceId), false,
      'a rejected old-session flush never reaches lifecycle.open')
    // The refused switch left B as the ONLY Agent the Host registry owns: A never
    // reached `agents.resume`, so this is the currentness fact itself, read at the
    // owner rather than from the Dock line that used to display it.
    assert.deepEqual(liveAgentIds(fixture), [targetId], 'a rejected flush leaves B current')
    assert.equal(currentContains(fixture.pane, targetId), true)
    assert.equal(pickerProps(fixture.pane, BROWSER).selected, `session:${sourceId}`)

    const priorNoticeIds = new Set(wireNodes(fixture.pane)
      .filter((node) => node.id.startsWith('dock.notice-'))
      .map((node) => node.id))
    rejectNextOpenFor = sourceId
    const refusalTraceStart = lifecycleTrace.length
    sendPickerAction(fixture.pane, 'resume', BROWSER)
    await waitFor('a refused Footer resume is visible and releases pending', () => {
      const notice = wireNodes(fixture.pane).find((node) => node.id.startsWith('dock.notice-')
        && !priorNoticeIds.has(node.id))
      return notice !== undefined
        && String(notice.p.text).includes('controlled Direct open refusal')
        && pickerNode(fixture.pane, BROWSER) !== undefined
        && pickerActionByBase(fixture.pane, 'resume', BROWSER)?.disabled === undefined
    })
    const refusalNotice = wireNodes(fixture.pane).find((node) => node.id.startsWith('dock.notice-')
      && !priorNoticeIds.has(node.id))
    assert.ok(refusalNotice)
    assert.match(String(refusalNotice.p.text), /controlled Direct open refusal/u)
    assertOldFlushBeforeOpen(refusalTraceStart, targetId, sourceId)
    assert.ok(lifecycleTrace.slice(refusalTraceStart).some((event) => event.kind === 'open'
      && event.sessionId === sourceId && event.outcome === 'rejected'))
    assert.equal(lifecycleTrace.slice(refusalTraceStart).filter((event) => event.kind === 'open'
      && event.sessionId === sourceId && event.outcome === 'starting').length, 1,
    'one failed Footer attempt reaches the Direct open boundary')
    assert.deepEqual(liveAgentIds(fixture), [targetId],
      'the refused open leaves B as the only live owner Agent')
    assert.equal(currentContains(fixture.pane, targetId), true, 'the original Browser scope remains current')
    assert.equal(pickerProps(fixture.pane, BROWSER).selected, `session:${sourceId}`)
    assert.equal(pickerActionByBase(fixture.pane, 'resume', BROWSER)?.disabled, undefined,
      'the failed transition releases pending so the user can retry')

    const retryTraceStart = lifecycleTrace.length
    const scopeBeforeRetryResume = projectionScopeId(fixture.pane)
    sendPickerAction(fixture.pane, 'resume', BROWSER)
    await waitFor('retrying Footer Resume switches to A', () => pickerNode(fixture.pane, BROWSER) === undefined
      && liveAgentIds(fixture).includes(sourceId))
    // The Browser's retirement is NOT the end of the switch: the composer input
    // stays fenced until A's own projection scope commits.
    await waitForNewProjectionScope(fixture.pane, scopeBeforeRetryResume)
    assertOldFlushBeforeOpen(retryTraceStart, targetId, sourceId)
    assert.equal(lifecycleTrace.slice(retryTraceStart).filter((event) => event.kind === 'open'
      && event.sessionId === sourceId && event.outcome === 'starting').length, 1,
    'the retry emits exactly one Direct open')

    const sourceListStart = listCalls.length
    await submitInput(fixture.pane, '/sessions')
    await waitFor('the Browser opens under source A', () => currentContains(fixture.pane, sourceId))
    await waitFor('the source Browser list settles', () => listCalls.length > sourceListStart)
    assert.equal(listCalls.length, sourceListStart + 1)
    assert.equal(listCalls[sourceListStart]?.currentSessionId, sourceId)
    assert.ok(listCalls[sourceListStart]?.rows?.some((row) => row.id === targetId && !row.live))
    const sourcePicker = pickerNode(fixture.pane, BROWSER)!.id
    sendSelect(fixture.pane, `session:${targetId}`, sourcePicker)
    await waitFor('the target B row is selected from A', () => pickerProps(fixture.pane, BROWSER).selected === `session:${targetId}`)
    const uiTraceStart = lifecycleTrace.length
    const scopeBeforeAtoB = projectionScopeId(fixture.pane)
    fixture.pane.key('\r')
    await waitFor('the A→B Enter transition retires the captured Browser', () => pickerNode(fixture.pane, BROWSER) === undefined)
    // The Browser's retirement is NOT the end of the switch: the composer input
    // stays fenced until B's own projection scope commits. A key typed before
    // that is DROPPED (not held), so the wait below is the only thing that
    // keeps the next command from being lost.
    await waitForNewProjectionScope(fixture.pane, scopeBeforeAtoB)

    const finalRereadStart = listCalls.length
    await submitInput(fixture.pane, '/sessions')
    await waitFor('B is current after A→B', () => currentContains(fixture.pane, targetId))
    await waitFor('the post-commit Reader rereads B authoritatively', () => listCalls.length > finalRereadStart)
    assert.equal(listCalls.length, finalRereadStart + 1)
    const finalRead = listCalls[finalRereadStart]!
    assert.equal(finalRead.currentSessionId, targetId)
    assert.ok(finalRead.rows?.some((row) => row.id === targetId && row.live), 'B is live in the production Reader result')
    assert.ok(finalRead.rows?.some((row) => row.id === sourceId && !row.live), 'A is retired before the authoritative reread')
    assertOldFlushBeforeOpen(uiTraceStart, sourceId, targetId)
    assert.equal(lifecycleTrace.slice(uiTraceStart).filter((event) => event.kind === 'open'
      && event.sessionId === targetId && event.outcome === 'starting').length, 1,
    'one list Enter emits one Direct open')
    assert.equal(finalRead.reader, listCalls[initialList]?.reader, 'the application keeps one SessionReader instance')
    sendPickerAction(fixture.pane, 'close', BROWSER)
    await waitFor('the final Browser closes cleanly', () => pickerNode(fixture.pane, BROWSER) === undefined)

    const directTraceStart = lifecycleTrace.length
    const directResumeStart = listCalls.length
    const scopeBeforeTypedResume = projectionScopeId(fixture.pane)
    await submitInput(fixture.pane, `/resume ${sourceId}`)
    await waitFor('typed /resume directly switches from B to A', () => listCalls.length > directResumeStart
      && pickerNode(fixture.pane, BROWSER) === undefined)
    // The Browser's retirement is NOT the end of the switch: the composer input
    // stays fenced until A's own projection scope commits.
    await waitForNewProjectionScope(fixture.pane, scopeBeforeTypedResume)
    assert.equal(listCalls.length, directResumeStart + 1, 'typed direct resume performs one shared listing')
    assert.equal(listCalls[directResumeStart]?.currentSessionId, targetId)
    assert.ok(listCalls[directResumeStart]?.rows?.some((row) => row.id === sourceId))
    await waitFor('typed direct resume publishes A', () => liveAgentIds(fixture).includes(sourceId))
    assertOldFlushBeforeOpen(directTraceStart, targetId, sourceId)
    assert.equal(lifecycleTrace.slice(directTraceStart).filter((event) => event.kind === 'open'
      && event.sessionId === sourceId && event.outcome === 'starting').length, 1,
    'typed /resume emits one Direct open')

    const directRereadStart = listCalls.length
    await submitInput(fixture.pane, '/sessions')
    await waitFor('the Browser reopens under the typed-resume owner A', () => currentContains(fixture.pane, sourceId))
    await waitFor('the typed-resume owner is authoritatively reread', () => listCalls.length > directRereadStart)
    assert.equal(listCalls.length, directRereadStart + 1)
    const directRead = listCalls[directRereadStart]!
    assert.equal(directRead.currentSessionId, sourceId)
    assert.ok(directRead.rows?.some((row) => row.id === sourceId && row.live))
    assert.ok(directRead.rows?.some((row) => row.id === targetId && !row.live))
    assert.equal(directRead.reader, listCalls[initialList]?.reader)
    sendPickerAction(fixture.pane, 'close', BROWSER)
    await waitFor('the typed-resume reread closes', () => pickerNode(fixture.pane, BROWSER) === undefined)

    const activateListStart = listCalls.length
    await submitInput(fixture.pane, '/sessions')
    await waitFor('the activate probe opens under A', () => currentContains(fixture.pane, sourceId))
    await waitFor('the activate probe lists once', () => listCalls.length > activateListStart)
    assert.equal(listCalls.length, activateListStart + 1)
    const activatePicker = pickerNode(fixture.pane, BROWSER)!.id
    sendSelect(fixture.pane, `session:${targetId}`, activatePicker)
    await waitFor('B is selected before native row activation', () => pickerProps(fixture.pane, BROWSER).selected === `session:${targetId}`)
    const activateTraceStart = lifecycleTrace.length
    const scopeBeforeNativeActivate = projectionScopeId(fixture.pane)
    sendActivate(fixture.pane, `session:${targetId}`, activatePicker)
    await waitFor('native row activate switches A→B', () => pickerNode(fixture.pane, BROWSER) === undefined
      && liveAgentIds(fixture).includes(targetId))
    // The Browser's retirement is NOT the end of the switch: the composer input
    // stays fenced until B's own projection scope commits.
    await waitForNewProjectionScope(fixture.pane, scopeBeforeNativeActivate)
    assertOldFlushBeforeOpen(activateTraceStart, sourceId, targetId)
    assert.equal(lifecycleTrace.slice(activateTraceStart).filter((event) => event.kind === 'open'
      && event.sessionId === targetId && event.outcome === 'starting').length, 1,
    'one activate emits one Direct open')

    const activateRereadStart = listCalls.length
    await submitInput(fixture.pane, '/sessions')
    await waitFor('the activate owner is authoritatively reread as B', () => currentContains(fixture.pane, targetId))
    await waitFor('the activate reread completes', () => listCalls.length > activateRereadStart)
    assert.equal(listCalls.length, activateRereadStart + 1)
    const activateRead = listCalls[activateRereadStart]!
    assert.equal(activateRead.currentSessionId, targetId)
    assert.ok(activateRead.rows?.some((row) => row.id === targetId && row.live))
    assert.ok(activateRead.rows?.some((row) => row.id === sourceId && !row.live))
    sendPickerAction(fixture.pane, 'close', BROWSER)
    await waitFor('the final activate reread closes', () => pickerNode(fixture.pane, BROWSER) === undefined)

    // AUTHORITY for "the current Session did not change": the PRODUCTION Direct
    // session writer settled this very prompt on B (`sessionId` is the Agent the
    // writer itself resolved), which the retired Dock line only displayed. The
    // one-to-one recorder comes from the fixture, so the recorded count is the
    // settled write count.
    const ordinaryWrites: Array<{ readonly sessionId: string }> = []
    const ordinaryPromptRecorder = fixture.recordPrompts(call => ordinaryWrites.push({ sessionId: call.sessionId }))
    const ordinaryPromptStart = fixture.modelCalls()
    await submitInput(fixture.pane, '/not-a-session-browser-command ordinary prompt')
    await waitFor('an unknown slash line remains an ordinary model submission', () =>
      fixture.modelCalls() > ordinaryPromptStart)
    assert.equal(fixture.modelCalls(), ordinaryPromptStart + 1)
    await waitFor('the ordinary prompt write to settle on the production writer', () =>
      ordinaryPromptRecorder.calls() === 1)
    ordinaryPromptRecorder.detach()
    assert.deepEqual(ordinaryWrites, [{ sessionId: targetId }],
      'the ordinary prompt does not change the current Session')
    assert.ok(liveAgentIds(fixture).includes(targetId),
      'the ordinary prompt leaves B as a live owner Agent')
    assert.equal(pickerNode(fixture.pane, BROWSER), undefined,
      'an ordinary slash prompt does not open the Browser')

    const blankSearchListStart = listCalls.length
    await submitInput(fixture.pane, '/search')
    await waitFor('blank /search reports its required query', () => fixture.pane.output.text().includes('search needs a query'))
    assert.equal(pickerNode(fixture.pane, BROWSER), undefined, 'blank /search does not open the Browser')
    assert.equal(listCalls.length, blankSearchListStart, 'blank /search does not list sessions')
  } finally {
    try {
      await fixture.settle()
    } finally {
      sessions.flush = originalFlush
      agents.resume = originalResume
    }
  }
})
