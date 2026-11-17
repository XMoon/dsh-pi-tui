/**
 * REAL Darwin kernel-seat qualification (MAC-02C).
 *
 * The `O_EXLOCK` seat is a kernel fact, so the decisive cases use REAL
 * independent OS processes (never two opens in this process): the winner is
 * the only holder, the loser reports the purpose's stable conflict code, a
 * close/SIGKILL frees the seat, and two profiles plus the three seat purposes
 * never conflict.
 *
 * The holder runs from the production module; its seat file is replaced,
 * linked, re-permissioned and moved underneath it to prove the currentness
 * check (`assertCurrent()`) refuses to keep claiming an ownership the kernel
 * no longer backs. The seat FD is close-on-exec: a child spawned with default
 * stdio does not see it, and an explicitly inherited FD keeps the lock alive —
 * so production code must never pass the seat FD through stdio.
 *
 * Non-Darwin hosts skip the suite with an explicit reason.
 *
 * @module @xmoon76/dsh-pi-tui/darwin-kernel-seat.test
 */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  bindDarwinKernelSeat,
  LocalScopeError,
  processSeatPath,
  type ProcessSeatKind,
} from '../../src/app/remote-process/local-scope.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const DARWIN_ONLY = process.platform !== 'darwin' ? 'Darwin kernel seats require macOS' : false
const WORKER_SOURCE = fileURLToPath(new URL('../fixtures/darwin-seat/seat-worker.mjs', import.meta.url))
const MODULE_URL = pathToFileURL(fileURLToPath(new URL('../../src/app/remote-process/local-scope.ts', import.meta.url))).href
const CHILD_EVENT_TIMEOUT_MS = 15_000

/** A deterministic scope id (the production value is a sha256 hex string). */
function scopeId(char: string): string {
  return char.repeat(64)
}

/** Line-delimited JSON from one worker stdout. */
class LineChannel {
  private readonly lines: string[] = []
  private readonly waiters: Array<(line: string) => void> = []

  constructor(stream: NodeJS.ReadableStream) {
    let buffer = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      buffer += chunk
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line === '') continue
        const waiter = this.waiters.shift()
        if (waiter !== undefined) waiter(line)
        else this.lines.push(line)
      }
    })
  }

  next(label: string): Promise<Record<string, unknown>> {
    const line = this.lines.shift()
    if (line !== undefined) return Promise.resolve(JSON.parse(line) as Record<string, unknown>)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), CHILD_EVENT_TIMEOUT_MS)
      this.waiters.push(raw => {
        clearTimeout(timer)
        resolve(JSON.parse(raw) as Record<string, unknown>)
      })
    })
  }
}

interface SeatWorker {
  readonly child: ChildProcess
  next(label: string): Promise<Record<string, unknown>>
  send(line: string): void
  exit(): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>
}

function startWorker(t: TestContext, dir: string, id: string, kind: ProcessSeatKind): SeatWorker {
  const child = spawn(process.execPath, [WORKER_SOURCE, MODULE_URL, dir, id, kind], {
    // stdin: commands; stdout: JSON events; stderr: inherited diagnostics.
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  assert.ok(child.pid !== undefined, 'the seat worker must spawn')
  const channel = new LineChannel(child.stdout!)
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  })
  return {
    child,
    next: (label: string) => channel.next(label),
    send: (line: string) => { child.stdin!.write(`${line}\n`) },
    exit: () => exited,
  }
}

/** Hold one seat in an independent process; the event proves it was claimed. */
async function holdSeat(t: TestContext, dir: string, id: string, kind: ProcessSeatKind): Promise<SeatWorker & { readonly fd: number }> {
  const worker = startWorker(t, dir, id, kind)
  const event = await worker.next(`${kind} held`)
  assert.equal(event['event'], 'held', `the ${kind} holder must claim the seat: ${JSON.stringify(event)}`)
  assert.equal(typeof event['fd'], 'number', 'the test worker must observe the claimed seat fd')
  return Object.assign(worker, { fd: event['fd'] as number })
}

/** One independent contender process: the event is either `held` or the
 * stable conflict error; a successful contender releases its seat immediately. */
async function contend(t: TestContext, dir: string, id: string, kind: ProcessSeatKind): Promise<Record<string, unknown>> {
  const worker = startWorker(t, dir, id, kind)
  const event = await worker.next(`${kind} contender`)
  if (event['event'] === 'held') {
    worker.send('close')
    const closed = await worker.next('contender close')
    assert.equal(closed['event'], 'closed')
  }
  const result = await worker.exit()
  if (event['event'] === 'held') assert.equal(result.code, 0)
  return event
}

async function expectConflict(t: TestContext, dir: string, id: string, kind: ProcessSeatKind, code: string): Promise<void> {
  const event = await contend(t, dir, id, kind)
  assert.equal(event['event'], 'error', `the contender must be refused: ${JSON.stringify(event)}`)
  assert.equal(event['code'], code)
}

function closeHolder(worker: SeatWorker): Promise<Record<string, unknown>> {
  worker.send('close')
  return worker.next('holder close')
}

function assertHolderCurrent(worker: SeatWorker): Promise<Record<string, unknown>> {
  worker.send('assert')
  return worker.next('holder currentness')
}

function assertRejected(promise: Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(promise, (error: unknown) => error instanceof LocalScopeError && error.code === code)
}

test('two independent processes race one seat: one wins, close and SIGKILL release it', { skip: DARWIN_ONLY, timeout: 60_000 }, async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('darwin-seat-race-')
  const id = scopeId('a')
  const first = await holdSeat(t, dir, id, 'host')
  await expectConflict(t, dir, id, 'host', 'HOST_ALREADY_OWNED')

  assert.equal((await closeHolder(first)).event, 'closed')
  assert.equal((await first.exit()).code, 0)
  // The close releases the kernel claim for the next independent process.
  const afterClose = await contend(t, dir, id, 'host')
  assert.equal(afterClose['event'], 'held', `a released seat must be claimable again: ${JSON.stringify(afterClose)}`)

  // A SIGKILLed holder stops being an owner: the kernel drops the lock.
  const killed = await holdSeat(t, dir, id, 'host')
  killed.child.kill('SIGKILL')
  const killedExit = await killed.exit()
  assert.equal(killedExit.signal, 'SIGKILL')
  const afterKill = await contend(t, dir, id, 'host')
  assert.equal(afterKill['event'], 'held', `a SIGKILLed holder must not block the next owner: ${JSON.stringify(afterKill)}`)
})

test('the three seat purposes and two profiles never conflict', { skip: DARWIN_ONLY, timeout: 60_000 }, async (t) => {
  const life = testLifecycle(t)
  const firstDir = life.tempDir('darwin-seat-profile-a-')
  const secondDir = life.tempDir('darwin-seat-profile-b-')
  const id = scopeId('b')
  const host = await holdSeat(t, firstDir, id, 'host')
  const qualification = await holdSeat(t, firstDir, id, 'qualification-client')
  const admin = await holdSeat(t, firstDir, id, 'admin')
  // A DIFFERENT profile scope is independent: both Host seats are held.
  const otherProfile = await holdSeat(t, secondDir, scopeId('c'), 'host')
  assert.notEqual(processSeatPath(firstDir, id, 'host'), processSeatPath(firstDir, id, 'qualification-client'))
  assert.notEqual(processSeatPath(firstDir, id, 'host'), processSeatPath(firstDir, id, 'admin'))
  assert.notEqual(processSeatPath(firstDir, id, 'host'), processSeatPath(secondDir, scopeId('c'), 'host'))
  for (const worker of [host, qualification, admin, otherProfile]) {
    assert.equal((await closeHolder(worker)).event, 'closed')
    assert.equal((await worker.exit()).code, 0)
  }
})

test('existing unsafe seat files and directories are refused, never repaired', { skip: DARWIN_ONLY, timeout: 30_000 }, async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('darwin-seat-unsafe-')
  const id = scopeId('d')
  const path = processSeatPath(dir, id, 'host')

  const reset = (): void => {
    if (existsSync(path)) unlinkSync(path)
  }

  // A pre-existing symlink is never followed.
  const target = join(dir, 'symlink-target')
  writeFileSync(target, '', { mode: 0o600 })
  symlinkSync(target, path)
  await assertRejected(bindDarwinKernelSeat(dir, id, 'host', 'HOST_ALREADY_OWNED'), 'SCOPE_DIRECTORY_UNSAFE')

  // Over-permissive mode is refused (the open must not chmod an existing file).
  reset()
  writeFileSync(path, '', { mode: 0o600 })
  chmodSync(path, 0o644)
  await assertRejected(bindDarwinKernelSeat(dir, id, 'host', 'HOST_ALREADY_OWNED'), 'SCOPE_DIRECTORY_UNSAFE')

  // A hardlinked seat file (nlink > 1) is a foreign alias, not ownership.
  reset()
  const shared = join(dir, 'shared-file')
  writeFileSync(shared, '', { mode: 0o600 })
  linkSync(shared, path)
  await assertRejected(bindDarwinKernelSeat(dir, id, 'host', 'HOST_ALREADY_OWNED'), 'SCOPE_DIRECTORY_UNSAFE')
  reset()

  // The directory itself must stay private 0700 and a real directory.
  chmodSync(dir, 0o755)
  await assertRejected(bindDarwinKernelSeat(dir, id, 'host', 'HOST_ALREADY_OWNED'), 'SCOPE_DIRECTORY_UNSAFE')
  chmodSync(dir, 0o700)
  const linked = join(life.tempDir('darwin-seat-link-'), 'linked-scope')
  symlinkSync(dir, linked)
  await assertRejected(bindDarwinKernelSeat(linked, id, 'host', 'HOST_ALREADY_OWNED'), 'SCOPE_DIRECTORY_UNSAFE')
  await assertRejected(bindDarwinKernelSeat(join(dir, 'missing'), id, 'host', 'HOST_ALREADY_OWNED'), 'SCOPE_DIRECTORY_UNSAFE')
})

test('the holder refuses a path whose inode was replaced (no double-owner Ready)', { skip: DARWIN_ONLY, timeout: 60_000 }, async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('darwin-seat-inode-')
  const id = scopeId('e')
  const path = processSeatPath(dir, id, 'host')
  const holder = await holdSeat(t, dir, id, 'host')
  assert.equal((await assertHolderCurrent(holder)).event, 'current')

  // Replace the seat path: unlink+create (or rename) yields a DIFFERENT inode
  // that the old holder does not own. Q0 proved this creates a second, live
  // owner; the old holder must therefore stop instead of continuing to Ready.
  renameSync(path, `${path}.moved`)
  writeFileSync(path, '', { mode: 0o600 })
  chmodSync(path, 0o600)
  const refused = await assertHolderCurrent(holder)
  assert.equal(refused['event'], 'assert-error', `the replaced inode must be refused: ${JSON.stringify(refused)}`)
  assert.equal(refused['code'], 'HOST_IDENTITY_MISMATCH')

  // A new process can claim the NEW inode; only the old holder's refusal keeps
  // the two owners from both publishing.
  const replacement = await contend(t, dir, id, 'host')
  assert.equal(replacement['event'], 'held', `the replacement inode is a new, independent claim: ${JSON.stringify(replacement)}`)
  holder.child.kill('SIGKILL')
  await holder.exit()
})

test('the holder refuses a replaced scope directory', { skip: DARWIN_ONLY, timeout: 60_000 }, async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('darwin-seat-dirswap-')
  const id = scopeId('f')
  const holder = await holdSeat(t, dir, id, 'host')
  const moved = `${dir}-moved`
  renameSync(dir, moved)
  mkdirSync(dir, { mode: 0o700 })
  const refused = await assertHolderCurrent(holder)
  assert.equal(refused['event'], 'assert-error', `the replaced directory must be refused: ${JSON.stringify(refused)}`)
  assert.equal(refused['code'], 'SCOPE_DIRECTORY_UNSAFE')
  holder.child.kill('SIGKILL')
  await holder.exit()
})

test('close is idempotent, never unlinks the seat file, and the FD is close-on-exec', { skip: DARWIN_ONLY, timeout: 60_000 }, async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('darwin-seat-close-')
  const id = scopeId('g')
  const path = processSeatPath(dir, id, 'host')
  const holder = await holdSeat(t, dir, id, 'host')

  // Default stdio: the seat FD is close-on-exec, so a spawned child cannot see
  // it (a short-lived child must never hold or release the Host's claim).
  holder.send('spawn default')
  const defaultProbe = await holder.next('default stdio probe')
  assert.equal(defaultProbe['event'], 'probe', JSON.stringify(defaultProbe))
  assert.equal(defaultProbe['value'], 'absent', 'the seat FD must be close-on-exec')

  // Explicitly passing the FD through stdio WOULD inherit it: the production
  // code must never do that. The child exits; the holder keeps the claim.
  holder.send('spawn inherit')
  const inheritedProbe = await holder.next('inherited stdio probe')
  assert.equal(inheritedProbe['event'], 'probe', JSON.stringify(inheritedProbe))
  assert.equal(inheritedProbe['value'], 'present', 'an explicit stdio entry inherits the FD (the forbidden shape)')
  assert.equal((await assertHolderCurrent(holder)).event, 'current', 'a short-lived inherited child must not release the claim')
  await expectConflict(t, dir, id, 'host', 'HOST_ALREADY_OWNED')

  assert.equal((await closeHolder(holder)).event, 'closed')
  assert.equal((await holder.exit()).code, 0)
  // Close releases the claim but NEVER unlinks the file: the next owner reuses
  // the same inode, and a second close is a harmless no-op.
  assert.equal(existsSync(path), true, 'close must not unlink the seat file')
  const info = lstatSync(path)
  assert.equal(info.isFile(), true)
  assert.equal(info.nlink, 1)
  const acquired = await contend(t, dir, id, 'host')
  assert.equal(acquired['event'], 'held', `the released seat must be claimable: ${JSON.stringify(acquired)}`)

  // The in-process claim proves the same close contract and the currentness
  // latch after close.
  const seat = await bindDarwinKernelSeat(dir, id, 'host', 'HOST_ALREADY_OWNED')
  seat.assertCurrent()
  await seat.close()
  await seat.close()
  assert.throws(() => seat.assertCurrent(), (error: unknown) => error instanceof LocalScopeError && error.code === 'HOST_IDENTITY_MISMATCH')
  assert.equal(readFileSync(path, 'utf8'), '', 'the seat file stays an empty ownership marker')
})
