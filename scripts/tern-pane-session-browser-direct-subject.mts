import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const paneRoot = process.env.TERN_PANE_DIR
if (paneRoot === undefined) throw new Error('TERN_PANE_DIR is required by the real Tern subject')
const workRoot = join(paneRoot, 'dsh-home')
mkdirSync(workRoot, { recursive: true })
// Set isolation before dynamically importing the DSH Host composition.
process.env.DSH_HOME = workRoot

const eventsPath = join(paneRoot, 'events.jsonl')
const note = (event: Record<string, unknown>): void => {
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`)
}
const sourceId = 'session-source-a-b1b'
const targetId = 'session-target-b-b1b'
const reconnectPath = join(paneRoot, 'reconnect.json')
const reconnectConfig = existsSync(reconnectPath)
  ? JSON.parse(readFileSync(reconnectPath, 'utf8')) as { readonly sessionId: string }
  : undefined
const run = reconnectConfig === undefined ? 'initial' : 'reconnect'
const startupSessionId = reconnectConfig?.sessionId ?? sourceId
process.once('exit', (code) => note({ kind: 'process.exit', run, code }))
let resolveExit!: () => void
const exitRequested = new Promise<void>(resolve => { resolveExit = resolve })
process.once('SIGTERM', () => setImmediate(resolveExit))
process.once('SIGINT', () => setImmediate(resolveExit))
let setupCleanup: (() => unknown) | undefined

const life: import('../test/support/temp-lifecycle.ts').TestLifecycle = {
  tempDir: (prefix) => { throw new Error(`external Tern fixture requires explicit workRoot, got ${prefix}`) },
  defer: cleanup => { setupCleanup = cleanup },
}

const { createDirectTspFixture } = await import('../test/support/direct-tsp-fixture.ts')
const { DirectSessionReader } = await import('../src/runtime/direct/session-direct.ts')

const originalList = DirectSessionReader.prototype.list
DirectSessionReader.prototype.list = async function (currentSessionId, signal) {
  const rows = await originalList.call(this, currentSessionId, signal)
  note({
    kind: 'reader.list',
    run,
    currentSessionId,
    sessionIds: rows?.map(row => row.id) ?? [],
    liveIds: rows?.filter(row => row.live).map(row => row.id) ?? [],
  })
  return rows
}

let restoreAgentsResume: (() => void) | undefined
let restoreSessionsFlush: (() => void) | undefined
try {
  const fixture = await createDirectTspFixture(life, {
    externalTern: true,
    workRoot,
    startup: { sessionId: startupSessionId },
    ...(reconnectConfig === undefined ? { persistedBlankSessions: [{ id: sourceId }, { id: targetId }] } : {}),
    appExit: () => {
      note({ kind: 'app.exit', run })
      setImmediate(resolveExit)
    },
  })

  const sessions = fixture.ctx.get('sessions') as unknown as {
    flush(session: unknown): Promise<boolean>
  }
  const originalFlush = sessions.flush
  sessions.flush = async function (this: typeof sessions, session: unknown): Promise<boolean> {
    const sessionId = String((session as { readonly id: unknown }).id)
    note({ kind: 'sessions.flush.start', run, sessionId })
    try {
      const flushed = await originalFlush.call(this, session)
      note({ kind: 'sessions.flush.settled', run, sessionId, flushed })
      return flushed
    } catch (error) {
      note({ kind: 'sessions.flush.rejected', run, sessionId, error: String(error) })
      throw error
    }
  }
  restoreSessionsFlush = () => { sessions.flush = originalFlush }

  const agents = fixture.ctx.get('agents') as unknown as {
    resume(options: unknown): Promise<unknown>
  }
  const originalResume = agents.resume
  agents.resume = async function (this: typeof agents, options: unknown): Promise<unknown> {
    const sessionId = String((options as { readonly resumeSessionId: unknown }).resumeSessionId)
    note({ kind: 'agents.resume.start', run, sessionId })
    try {
      const result = await originalResume.call(this, options)
      note({ kind: 'agents.resume.settled', run, sessionId })
      return result
    } catch (error) {
      note({ kind: 'agents.resume.rejected', run, sessionId, error: String(error) })
      throw error
    }
  }
  restoreAgentsResume = () => { agents.resume = originalResume }

  // The production Workspace contract: the browser's folder tree comes from the
  // official `workspaceRegistry`. This fixture's blank persisted Sessions are
  // written after the registry's one-time history bootstrap, so they carry no
  // membership yet; register the fixture directory through the SAME official
  // registry API a real Host uses and attach the two persisted Sessions, so the
  // Browser sees one real official folder instead of an Unassigned bucket.
  const registry = fixture.ctx.get('workspaceRegistry') as unknown as {
    list(): ReadonlyArray<{
      readonly id: string
      readonly title: string
      readonly path: string
      readonly sessionIds: readonly string[]
      attachSession(sessionId: never): Promise<void>
    }>
    create(path: string, title?: string): Promise<{
      readonly id: string
      readonly title: string
      readonly path: string
      readonly sessionIds: readonly string[]
      attachSession(sessionId: never): Promise<void>
    }>
  }
  const existing = registry.list()[0]
  const workspace = existing ?? await registry.create(workRoot, 'Direct')
  for (const sessionId of [sourceId, targetId]) {
    if (!workspace.sessionIds.includes(sessionId)) await workspace.attachSession(sessionId as never)
  }
  note({
    kind: 'workspace.ready',
    run,
    workspaceId: String(workspace.id),
    title: workspace.title,
    path: workspace.path,
    sessionIds: workspace.sessionIds.map(String),
    created: existing === undefined,
  })

  note({ kind: 'fixture.ready', run, startupSessionId, sourceId, targetId, workRoot })
  await exitRequested
  await setupCleanup!()
  note({ kind: 'fixture.settled', run })
} finally {
  await setupCleanup?.()
  restoreAgentsResume?.()
  restoreSessionsFlush?.()
  DirectSessionReader.prototype.list = originalList
}
