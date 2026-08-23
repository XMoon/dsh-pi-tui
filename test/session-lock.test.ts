/**
 * Headless tests for the open-time session lock: atomic acquire, held
 * detection with a live owner, stale takeover (dead/zombie/reused-pid/
 * mismatched-owner), unverifiable owners, same-process re-open, takeover
 * races, idempotent release, and unavailable deployments.
 * @module @xmoon76/dsh-pi-tui/session-lock.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acquireSessionLock,
  lockPathOf,
  parseLockInfo,
  serializeLockInfo,
  TAKEOVER_RETRIES,
  type SessionLockFs,
  type SessionLockInfo,
  type SessionLockProc,
} from '../src/session-lock.ts'

const SESSION = { id: 'session-abc', header: { cwd: '/work' } }
const ARTIFACT = { kind: 'jsonl', path: '/sessions/--work--/session-abc/session.jsonl.zstd' }
const LOCK = lockPathOf(ARTIFACT.path)

/** A scripted /proc probe: return a fixed verdict per call, or per owner. */
function scriptedProc(
  verdicts: Array<{ kind: 'alive' } | { kind: 'stale' } | { kind: 'unknown' }>,
): SessionLockProc & { calls: number } {
  const state = { calls: 0 }
  return {
    get calls() {
      return state.calls
    },
    probe: () => {
      const verdict = verdicts[Math.min(state.calls, verdicts.length - 1)]
      state.calls += 1
      return verdict
    },
  }
}

/** An in-memory fs surface: files on a map, EEXIST/ENOENT semantics. */
function memFs(initial: Record<string, string> = {}): SessionLockFs & {
  files: Map<string, string>
  writes: string[]
  flags: Array<string | undefined>
  unlinks: string[]
  failNextWrite: Error | undefined
} {
  const files = new Map<string, string>(Object.entries(initial))
  const writes: string[] = []
  const flags: Array<string | undefined> = []
  const unlinks: string[] = []
  const state = { failNextWrite: undefined as Error | undefined }
  return {
    get files() {
      return files
    },
    get writes() {
      return writes
    },
    get flags() {
      return flags
    },
    get unlinks() {
      return unlinks
    },
    get failNextWrite() {
      return state.failNextWrite
    },
    set failNextWrite(value) {
      state.failNextWrite = value
    },
    readFileSync: (path) => {
      const content = files.get(path)
      if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return content
    },
    writeFileSync: (path, content, options) => {
      if (state.failNextWrite !== undefined) {
        const error = state.failNextWrite
        state.failNextWrite = undefined
        throw error
      }
      // Honour the exclusive-create flag exactly like the real fs: without
      // `wx` a plain write would silently overwrite — the memFs must NOT
      // emulate that overwrite, because the lock module must always pass wx.
      const flag = options?.flag ?? 'w'
      flags.push(flag)
      if (flag === 'wx' && files.has(path)) {
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
      }
      files.set(path, content)
      writes.push(path)
    },
    unlinkSync: (path) => {
      if (!files.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      files.delete(path)
      unlinks.push(path)
    },
  }
}

const SELF: SessionLockInfo = { pid: 100, starttime: 42, startedAt: 1_700_000_000_000, profile: 'pi-tui-dev' }
const OTHER: SessionLockInfo = { pid: 200, starttime: 43, startedAt: 1_700_000_000_000, profile: 'pi-tui' }

function deps(fs: SessionLockFs, proc: SessionLockProc) {
  return {
    persistence: { locate: () => ARTIFACT },
    fs,
    proc,
  }
}

test('acquire: no lock file — atomic create wins and release is idempotent', () => {
  const fs = memFs()
  const outcome = acquireSessionLock(deps(fs, scriptedProc([])), SESSION, SELF)
  assert.equal(outcome.kind, 'acquired')
  const content = fs.files.get(LOCK)
  assert.ok(content !== undefined)
  assert.deepEqual(parseLockInfo(content!), SELF)
  // Release removes the file; a second release is a no-op.
  const release = (outcome as { kind: 'acquired'; release: () => void }).release
  release()
  assert.equal(fs.files.has(LOCK), false)
  assert.equal(fs.unlinks.length, 1)
  release()
  assert.equal(fs.unlinks.length, 1)
})

test('acquire: every lock creation uses the exclusive wx flag', () => {
  const fs = memFs()
  const outcome = acquireSessionLock(deps(fs, scriptedProc([])), SESSION, SELF)
  assert.equal(outcome.kind, 'acquired')
  // The very first create and every takeover create must be exclusive: a
  // plain `w` write would silently overwrite a live owner's lock.
  assert.ok(fs.flags.every(flag => flag === 'wx'), `all creates exclusive, got ${JSON.stringify(fs.flags)}`)
})

test('acquire: a live matching owner is held', () => {
  const fs = memFs({ [LOCK]: serializeLockInfo(OTHER) })
  const proc = scriptedProc([{ kind: 'alive' }])
  const outcome = acquireSessionLock(deps(fs, proc), SESSION, SELF)
  assert.equal(outcome.kind, 'held')
  assert.deepEqual((outcome as { kind: 'held'; owner: SessionLockInfo }).owner, OTHER)
  assert.equal(proc.calls, 1)
  // The held lock file is untouched.
  assert.ok(fs.files.has(LOCK))
})

test('acquire: same process re-opening its own session is allowed', () => {
  const fs = memFs({ [LOCK]: serializeLockInfo(SELF) })
  const proc = scriptedProc([])
  const outcome = acquireSessionLock(deps(fs, proc), SESSION, SELF)
  assert.equal(outcome.kind, 'acquired')
  // No probe needed, no write attempted (the existing file is ours).
  assert.equal(proc.calls, 0)
  assert.equal(fs.writes.length, 0)
})

test('acquire: a dead owner is taken over (probe stale)', () => {
  const fs = memFs({ [LOCK]: serializeLockInfo(OTHER) })
  const proc = scriptedProc([{ kind: 'stale' }])
  const outcome = acquireSessionLock(deps(fs, proc), SESSION, SELF)
  assert.equal(outcome.kind, 'taken-over-stale')
  const release = (outcome as { kind: 'taken-over-stale'; release: () => void }).release
  assert.equal(fs.files.has(LOCK), true)
  assert.deepEqual(parseLockInfo(fs.files.get(LOCK)!), SELF)
  release()
  assert.equal(fs.files.has(LOCK), false)
})

test('acquire: a zombie owner is stale (probe verdict independent of reason)', () => {
  const fs = memFs({ [LOCK]: serializeLockInfo(OTHER) })
  const proc = scriptedProc([{ kind: 'stale' }])
  const outcome = acquireSessionLock(deps(fs, proc), SESSION, SELF)
  assert.equal(outcome.kind, 'taken-over-stale')
})

test('acquire: an unverifiable owner refuses (never take over a lock we cannot inspect)', () => {
  const fs = memFs({ [LOCK]: serializeLockInfo(OTHER) })
  const proc = scriptedProc([{ kind: 'unknown' }])
  const outcome = acquireSessionLock(deps(fs, proc), SESSION, SELF)
  assert.equal(outcome.kind, 'unverifiable')
  assert.deepEqual((outcome as { kind: 'unverifiable'; owner: SessionLockInfo }).owner, OTHER)
  // The lock is untouched.
  assert.ok(fs.files.has(LOCK))
})

test('acquire: an unreadable lock file is unverifiable, never destroyed', () => {
  const fs = memFs({ [LOCK]: serializeLockInfo(OTHER) })
  fs.readFileSync = () => {
    throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
  }
  const proc = scriptedProc([])
  const outcome = acquireSessionLock(deps(fs, proc), SESSION, SELF)
  assert.equal(outcome.kind, 'unverifiable')
  assert.ok(fs.files.has(LOCK))
})

test('acquire: a malformed lock file is unverifiable, never guessed', () => {
  const fs = memFs({ [LOCK]: 'not json' })
  const proc = scriptedProc([])
  const outcome = acquireSessionLock(deps(fs, proc), SESSION, SELF)
  assert.equal(outcome.kind, 'unverifiable')
})

test('acquire: a takeover race retries, then refuses as held when the lock keeps reappearing', () => {
  // Every probe says stale, and every unlink fails (a concurrent taker owns
  // the file between our read and unlink, or the fs is wedged) — the retry
  // budget is consumed and the acquire refuses as held instead of looping
  // forever.
  const fs = memFs({ [LOCK]: serializeLockInfo(OTHER) })
  fs.unlinkSync = () => {
    throw Object.assign(new Error('EIO'), { code: 'EIO' })
  }
  const proc = scriptedProc([{ kind: 'stale' }])
  const outcome = acquireSessionLock(deps(fs, proc), SESSION, SELF)
  assert.equal(outcome.kind, 'held')
  // The retry budget was consumed: 1 probe for the first read + retries.
  assert.equal(proc.calls, 1 + TAKEOVER_RETRIES)
})

test('acquire: no persistence surface is unavailable, not blocked', () => {
  const fs = memFs()
  const outcome = acquireSessionLock({ persistence: undefined, fs, proc: scriptedProc([]) }, SESSION, SELF)
  assert.equal(outcome.kind, 'unavailable')
  assert.equal((outcome as { kind: 'unavailable'; reason: string }).reason, 'no-persistence')
})

test('acquire: no artifact is unavailable, not blocked', () => {
  const fs = memFs()
  const outcome = acquireSessionLock(
    { persistence: { locate: () => undefined }, fs, proc: scriptedProc([]) },
    SESSION,
    SELF,
  )
  assert.equal(outcome.kind, 'unavailable')
  assert.equal((outcome as { kind: 'unavailable'; reason: string }).reason, 'no-artifact')
})

test('acquire: a write error on the create is unavailable, not blocked', () => {
  const fs = memFs()
  fs.failNextWrite = Object.assign(new Error('EACCES'), { code: 'EACCES' })
  const outcome = acquireSessionLock(deps(fs, scriptedProc([])), SESSION, SELF)
  assert.equal(outcome.kind, 'unavailable')
  // EACCES on an existing directory is a write-error, not a missing dir.
  assert.equal((outcome as { kind: 'unavailable'; reason: string }).reason, 'write-error')
})

test('acquire: an ENOENT write (missing session dir) is unavailable as no-lock-dir', () => {
  const fs = memFs()
  fs.failNextWrite = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  const outcome = acquireSessionLock(deps(fs, scriptedProc([])), SESSION, SELF)
  assert.equal(outcome.kind, 'unavailable')
  assert.equal((outcome as { kind: 'unavailable'; reason: string }).reason, 'no-lock-dir')
})

test('acquire: every lock creation passes the 0600 mode', () => {
  const fs = memFs()
  // The memFs records the mode via a spy: patch writeFileSync to capture it.
  const modes: Array<number | undefined> = []
  const originalWrite = fs.writeFileSync.bind(fs)
  fs.writeFileSync = ((path: string, content: string, options?: { flag?: string; mode?: number }) => {
    modes.push(options?.mode)
    return originalWrite(path, content, options)
  }) as never
  const outcome = acquireSessionLock(deps(fs, scriptedProc([])), SESSION, SELF)
  assert.equal(outcome.kind, 'acquired')
  assert.ok(modes.length >= 1)
  assert.ok(modes.every(mode => mode === 0o600), `all creates mode 0600, got ${JSON.stringify(modes)}`)
})

test('release: does not delete a lock another process took over', () => {
  const fs = memFs()
  const outcome = acquireSessionLock(deps(fs, scriptedProc([])), SESSION, SELF)
  assert.equal(outcome.kind, 'acquired')
  const release = (outcome as { kind: 'acquired'; release: () => void }).release
  // Ownership lost: another process replaced our lock with its own.
  fs.files.set(LOCK, serializeLockInfo(OTHER))
  release()
  // The new owner's lock survives our release.
  assert.deepEqual(parseLockInfo(fs.files.get(LOCK)!), OTHER)
})

test('acquire: a lock that vanishes between create-EEXIST and read retries the create', () => {
  // First create fails (file exists), then the read finds it gone (a
  // concurrent taker removed it) — the acquire must retry, not refuse.
  const fs = memFs({ [LOCK]: serializeLockInfo(OTHER) })
  const originalRead = fs.readFileSync.bind(fs)
  let reads = 0
  fs.readFileSync = ((path: string) => {
    reads += 1
    if (reads === 1) {
      // The file exists at create time (EEXIST) but is gone by read time:
      // simulate the concurrent taker's removal, then let the retry create
      // succeed.
      fs.files.delete(path)
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    return originalRead(path)
  }) as never
  const proc = scriptedProc([])
  const outcome = acquireSessionLock(deps(fs, proc), SESSION, SELF)
  // The retry create succeeds once the file is gone.
  assert.equal(outcome.kind, 'acquired')
  assert.deepEqual(parseLockInfo(fs.files.get(LOCK)!), SELF)
})

test('lockPathOf derives the lock path from the artifact path', () => {
  assert.equal(lockPathOf('/a/b/session.jsonl.zstd'), '/a/b/session.jsonl.zstd.owner.lock')
  assert.equal(lockPathOf('/a/b/session.jsonl'), '/a/b/session.jsonl.owner.lock')
})

test('serialize/parse round-trips and rejects malformed records', () => {
  const info: SessionLockInfo = { pid: 1, starttime: 2, startedAt: 3, profile: 'p', tty: '/dev/pts/0' }
  assert.deepEqual(parseLockInfo(serializeLockInfo(info)), info)
  assert.equal(parseLockInfo(''), undefined)
  assert.equal(parseLockInfo('{"pid":1}'), undefined)
  assert.equal(parseLockInfo('{"pid":"x","starttime":1,"startedAt":1}'), undefined)
  assert.equal(parseLockInfo('{"pid":1.5,"starttime":1,"startedAt":1}'), undefined)
})

test('acquire: a stale owner replaced by another taker is never unlinked', () => {
  // We probe owner A (stale), but between the read and the compare-and-delete
  // another process takes the lock over (the file now holds owner B, alive).
  // The takeover must NOT unlink B's fresh lock; the acquire gives up as held.
  const fs = memFs({ [LOCK]: serializeLockInfo(OTHER) })
  const ownerB = { pid: 300, starttime: 44, startedAt: 0 }
  let reads = 0
  const originalRead = fs.readFileSync.bind(fs)
  const originalUnlink = fs.unlinkSync.bind(fs)
  fs.readFileSync = ((path: string) => {
    reads += 1
    if (reads === 1) return originalRead(path) // first read: OTHER (stale)
    // A concurrent taker replaced the lock on disk before our compare read.
    fs.files.set(path, serializeLockInfo(ownerB))
    return serializeLockInfo(ownerB)
  }) as never
  let unlinked = 0
  fs.unlinkSync = ((path: string) => {
    unlinked += 1
    return originalUnlink(path)
  }) as never
  // The first probe sees OTHER (stale); every later probe sees the new owner
  // which is ALIVE — so the takeover must stop at the compare-and-delete.
  const proc = scriptedProc([{ kind: 'stale' }, { kind: 'alive' }])
  const outcome = acquireSessionLock(deps(fs, proc), SESSION, SELF)
  // The fresh owner's lock is never removed; the acquire gives up as held.
  assert.equal(unlinked, 0)
  assert.equal(outcome.kind, 'held')
  // The on-disk lock is B's, untouched by our failed takeover.
  assert.deepEqual(parseLockInfo(fs.files.get(LOCK)!), ownerB)
})

test('acquire: a flapping lock (repeated read-ENOENT) is bounded, never infinite', () => {
  // Every create fails (file exists) and every read finds the file gone (a
  // concurrent taker ping-pongs): the retry budget must stop the loop.
  const fs = memFs({ [LOCK]: serializeLockInfo(OTHER) })
  fs.readFileSync = (() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }) as never
  const outcome = acquireSessionLock(deps(fs, scriptedProc([])), SESSION, SELF)
  assert.equal(outcome.kind, 'unverifiable')
})
