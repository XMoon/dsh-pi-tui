/**
 * The one physical PTY Owner of a terminal-owner-loss Client.
 *
 * The Supervisor forks this helper with ordinary IPC/stdio only. The helper is
 * the ONLY process that creates the tui-test terminal (and therefore the only
 * process that owns the Client's PTY master); the parent never receives the
 * terminal object and never calls close/interrupt/signal on the Client. This is
 * a one-off test holder, not a second Supervisor, Runner or Registry.
 *
 * It imports the repository's actual `createSplitTerminal` through the pinned
 * Node type-stripping loader. It creates exactly one terminal, runs exactly one
 * Client command, and exposes only bounded text/state/cleanup operations.
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { createSplitTerminal } = await import(
  pathToFileURL(join(HERE, 'split-process-client.ts')).href
)

let split
let created = false
let ran = false
let closeRequested = false
let queue = Promise.resolve()

function reply(requestId, ok, payload = {}) {
  if (process.connected !== true) return
  process.send({ type: 'owner-response', requestId, ok, ...payload })
}

function fail(requestId, error) {
  const message = error instanceof Error ? error.message : String(error)
  if (process.connected === true) process.send({ type: 'owner-error', requestId, message })
}

async function handle(message) {
  const requestId = message?.requestId
  if (typeof requestId !== 'string' || requestId === '') throw new Error('owner request needs a requestId')
  if (message.op === 'create') {
    if (created) throw new Error('the Owner already created its terminal')
    if (typeof message.traceDirectory !== 'string' || typeof message.artifactsDirectory !== 'string') {
      throw new Error('create needs traceDirectory and artifactsDirectory')
    }
    split = createSplitTerminal({
      prefix: typeof message.prefix === 'string' && message.prefix !== '' ? message.prefix : 'split-process-owner',
      traceDirectory: message.traceDirectory,
      artifactsDirectory: message.artifactsDirectory,
    })
    created = true
    reply(requestId, true, { sessionId: split.sessionId })
    return
  }
  if (message.op === 'run') {
    if (!created) throw new Error('run before create')
    if (ran) throw new Error('the Owner already ran its one Client command')
    if (typeof message.entry !== 'string' || typeof message.cwd !== 'string'
      || message.env === null || typeof message.env !== 'object') {
      throw new Error('run needs entry, cwd and env')
    }
    ran = true
    const opened = await split.terminal.run(process.execPath, [message.entry], {
      cwd: message.cwd,
      cols: Number.isInteger(message.cols) ? message.cols : 140,
      rows: Number.isInteger(message.rows) ? message.rows : 40,
      waitReady: false,
      env: message.env,
    })
    reply(requestId, true, { sessionId: split.sessionId, shellPid: opened.shell_pid })
    return
  }
  if (message.op === 'text') {
    if (split === undefined) throw new Error('text before create')
    const text = await split.terminal.text({ full: false })
    reply(requestId, true, { text })
    return
  }
  if (message.op === 'state') {
    if (split === undefined) throw new Error('state before create')
    const state = await split.terminal.state()
    reply(requestId, true, { state })
    return
  }
  if (message.op === 'close') {
    if (closeRequested) {
      reply(requestId, true, { alreadyClosed: true })
      return
    }
    closeRequested = true
    if (split !== undefined) await split.terminal.closeQuiet()
    reply(requestId, true, { closed: true })
    // A closed holder has no remaining capability; exit so the parent can reap
    // the exact child identity instead of leaving a live one-shot helper.
    setTimeout(() => process.exit(0), 10)
    return
  }
  throw new Error(`unknown Owner operation ${JSON.stringify(message.op)}`)
}

process.on('message', message => {
  queue = queue.then(async () => {
    const requestId = typeof message?.requestId === 'string' ? message.requestId : ''
    try {
      await handle(message)
    } catch (error) {
      fail(requestId, error)
    }
  }).catch(error => {
    if (process.connected === true) process.send({ type: 'owner-fatal', message: error instanceof Error ? error.message : String(error) })
    process.exit(1)
  })
})

async function shutdown() {
  try {
    if (split !== undefined) await split.terminal.closeQuiet()
  } catch {
    // The parent death is the cleanup owner's trigger; never hang the holder.
  }
  process.exit(0)
}

process.on('disconnect', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
