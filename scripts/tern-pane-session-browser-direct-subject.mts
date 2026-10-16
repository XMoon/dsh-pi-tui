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
