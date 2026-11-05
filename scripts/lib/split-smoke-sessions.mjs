/**
 * Durable Host Session readers for the split-process smoke lanes.
 *
 * These helpers read the real persisted Session log under an isolated
 * `DSH_HOME`; they never open a Host service, a Client or a transport. The
 * Host appends one independently compressed zstd frame per write, so a reader
 * must reconstruct the whole frame stream before it can see a complete tail.
 * Importing this module performs no I/O.
 *
 * @module split-smoke-sessions
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { SplitSmokeWaitError } from './split-smoke-diagnostics.mjs'

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

/**
 * Decode a session log file: the Host appends one independently compressed
 * zstd frame per write, and Node's one-shot decoder reads only the first frame.
 * Splitting at the frame magic (a torn final frame is skipped) reconstructs the
 * whole durable log.
 */
function decodeZstdFrames(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer.compare(magic, 0, 4, index, index + 4) === 0) offsets.push(index)
  }
  if (offsets.length === 0 || offsets[0] !== 0) throw new Error('session log is not a zstd frame stream')
  const parts = []
  for (let index = 0; index < offsets.length; index += 1) {
    const end = offsets[index + 1] ?? buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(offsets[index], end)))
    } catch (error) {
      if (index === offsets.length - 1) break // a torn append tail
      throw new Error(`session log frame ${String(index)} is corrupt: ${String(error)}`)
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

/** Locate one persisted Host Session log under the isolated DSH home. */
function findHostSessionLog(dshHome, sessionId) {
  const sessionsRoot = join(dshHome, 'sessions')
  if (!existsSync(sessionsRoot)) return undefined
  for (const dirent of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    const sessionDir = join(sessionsRoot, dirent.name, sessionId)
    if (!existsSync(sessionDir)) continue
    for (const file of readdirSync(sessionDir)) {
      if (file.endsWith('.jsonl.zstd')) return join(sessionDir, file)
    }
  }
  return undefined
}

/** The durable Host Session events of one Session (undefined before any log). */
export function hostSessionEvents(dshHome, sessionId) {
  const path = findHostSessionLog(dshHome, sessionId)
  if (path === undefined) return undefined
  return decodeZstdFrames(readFileSync(path)).split('\n').filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return undefined // a torn tail line while the Host appends
      }
    })
    .filter(event => event !== undefined)
}

/** The first persisted line (the durable Session header) of one Host Session. */
export function hostSessionHeader(dshHome, sessionId) {
  const events = hostSessionEvents(dshHome, sessionId)
  const header = events?.[0]
  return header !== undefined && header.type === 'session' ? header : undefined
}

/** The number of durable Host Session logs under the isolated home. */
export function hostSessionLogCount(dshHome) {
  const sessionsRoot = join(dshHome, 'sessions')
  if (!existsSync(sessionsRoot)) return 0
  let count = 0
  for (const dirent of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    const sessionDir = join(sessionsRoot, dirent.name)
    for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        for (const file of readdirSync(join(sessionDir, entry.name))) {
          if (file.endsWith('.jsonl.zstd')) count += 1
        }
      }
    }
  }
  return count
}

/** A bounded wait for one Session's durable header line (the Host writes it on
 *  the first accepted append, so a just-created Session may lag briefly). A
 *  read that lands on a torn/partial zstd frame is not a verdict: it just is not
 *  durable yet, so the wait retries until the classified deadline. */
export async function waitForHostSessionHeader(dshHome, sessionId, label, timeoutMs = 60_000) {
  const started = Date.now()
  const deadline = started + timeoutMs
  while (Date.now() < deadline) {
    try {
      const header = hostSessionHeader(dshHome, sessionId)
      if (header !== undefined) return header
    } catch {
      // The Host may be mid-append; a partial frame is not a durable header yet.
    }
    await sleep(100)
  }
  throw new SplitSmokeWaitError('WAIT_TIMEOUT', {
    code: 'HOST_SESSION_HEADER_TIMEOUT',
    waitLabel: label,
    processRole: 'host',
    elapsedMs: Date.now() - started,
  })
}

/** Bounded digest (the shape the WS-2 qualification records carry). */
export function sha16(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

/** Wait for one durable Host Session event matching the predicate. */
/**
 * Wait for one durable Host Session event that satisfies `predicate` AND appears
 * at or after the durable index `afterIndex` (a snapshot taken BEFORE the action
 * under test). A Session that already carries earlier turns needs this: a bare
 * `turn/end` wait would happily match history and report a fact the new write
 * never produced.
 */
export async function waitForHostSessionEventAfter(dshHome, sessionId, afterIndex, predicate, label, timeoutMs = 60_000) {
  const started = Date.now()
  const deadline = started + timeoutMs
  while (Date.now() < deadline) {
    const events = hostSessionEvents(dshHome, sessionId)
    const event = events === undefined ? undefined : events.slice(afterIndex).find(predicate)
    if (event !== undefined) return event
    await sleep(50)
  }
  throw new SplitSmokeWaitError('WAIT_TIMEOUT', {
    code: 'SESSION_EVENT_WAIT_TIMEOUT',
    waitLabel: label,
    elapsedMs: Date.now() - started,
  })
}

export async function waitForHostSessionEvent(dshHome, sessionId, predicate, label, timeoutMs = 60_000) {
  const started = Date.now()
  const deadline = started + timeoutMs
  while (Date.now() < deadline) {
    const events = hostSessionEvents(dshHome, sessionId)
    const event = events?.find(predicate)
    if (event !== undefined) return event
    await sleep(50)
  }
  throw new SplitSmokeWaitError('WAIT_TIMEOUT', {
    code: 'SESSION_EVENT_WAIT_TIMEOUT',
    waitLabel: label,
    elapsedMs: Date.now() - started,
  })
}
