#!/usr/bin/env node
/**
 * Ordered shutdown of the direct ChildProcesses a Tern driver spawned itself.
 *
 * The question this module answers is NARROW: **when did a ChildProcess that
 * this driver spawned itself actually terminate?** `child.kill()` is a REQUEST
 * to deliver a signal and says nothing about the process state afterwards; the
 * ChildProcess `close` event is the direct child's termination (it has exited
 * AND its stdio streams are closed), and that is the fact a teardown has to
 * wait for before it drops a resource the child may still be using.
 *
 * It does NOT answer "is this process TREE gone": a grandchild is not this
 * module's child node, and `close` says nothing about descendants. Nor is it a
 * replacement for a process-group owner. The two Tern drivers are its only
 * consumers; it is not a general subprocess manager.
 *
 * @module scripts/lib/owned-child-shutdown
 */

/**
 * How long a direct child may take to reach `close` after its stop request.
 *
 * MEASURED: a SIGKILLed direct child reaches `close` within a few milliseconds
 * on this platform, so this is a FAILURE BOUND, not a settle budget: it exists
 * so a wedged child is reported instead of hanging the driver forever.
 */
export const OWNED_CHILD_CLOSE_DEADLINE_MS = 5_000

/**
 * Observe one direct ChildProcess from the moment it exists.
 *
 * The listeners are attached HERE, synchronously, and never after a `kill()`:
 * a `close` that arrives between the spawn and the observation would otherwise
 * be missed, and the shutdown would wait for an event that already happened.
 *
 * @param {import('node:child_process').ChildProcess} child the process just spawned.
 * @param {{kind: string}} options the child's role, used in diagnostics.
 */
export function ownChild(child, { kind }) {
  // A child that never received a PID was never spawned: it has no later OS
  // state to wait for, so its spawn failure IS its terminal state. A child
  // that DID spawn is only settled by `close` — `error` also reports a failed
  // KILL, which proves nothing about whether the process is still running.
  const spawnFailed = child.pid === undefined
  const record = { kind, pid: child.pid, closed: false, exitCode: null, signal: null, error: undefined, stopSignal: undefined }
  let settle
  const settled = new Promise((resolve) => { settle = resolve })
  const finish = () => {
    if (record.closed) return
    record.closed = true
    settle(handle)
  }
  child.once('close', (exitCode, signal) => {
    record.exitCode = exitCode
    record.signal = signal
    finish()
  })
  child.once('error', (error) => {
    record.error = error
    if (spawnFailed) finish()
  })
  const handle = {
    kind,
    settled,
    /** The PID as it was at spawn time (undefined for a failed spawn). */
    get pid() { return record.pid },
    /** TRUE only once the child's terminal state is known. */
    get closed() { return record.closed },
    get exitCode() { return record.exitCode },
    get signal() { return record.signal },
    get error() { return record.error },
    /**
     * Request the child's stop ONCE.
     *
     * The first request wins: every shutdown entry (a signal, the normal
     * `finally`, the synchronous `exit` fallback) reuses the same one-shot
     * teardown, and a second entry must not send a second signal. The request
     * is not evidence of termination — only `closed` is.
     *
     * @param {NodeJS.Signals} signal defaults to SIGKILL, the strongest request.
     * @returns {boolean} whether the signal was delivered to the OS.
     */
    stop(signal = 'SIGKILL') {
      if (record.closed || record.stopSignal !== undefined) return false
      record.stopSignal = signal
      try {
        return child.kill(signal) === true
      } catch {
        // The child may have exited between the observation and this request;
        // its `close` still settles the handle, so this is not a failure to
        // report by itself.
        return false
      }
    },
  }
  return handle
}

const ALL_CLOSED = Symbol('all-closed')
const DEADLINE_EXPIRED = Symbol('deadline-expired')

/**
 * Stop every owned child, then wait — bounded — until ALL of them have
 * settled.
 *
 * The result resolves only after every child's `close` (or its terminal spawn
 * failure). If the deadline expires first, the survivors are returned by name
 * so the caller reports WHICH child did not settle instead of pretending the
 * teardown finished: a SIGKILL that has not been acknowledged by the OS is not
 * a cleanup.
 *
 * @param {ReturnType<typeof ownChild>[]} handles the direct children this owner spawned.
 * @param {{deadlineMs?: number}} [options] the failure bound, defaulting to the measured bound.
 */
export async function stopOwnedChildren(handles, { deadlineMs = OWNED_CHILD_CLOSE_DEADLINE_MS } = {}) {
  for (const handle of handles) handle.stop()
  let timer
  // reason: a bounded deadline around the OS `close` delivery. The contract is
  // "the direct child has terminated", so there is no separate settle window:
  // the only alternative to the event is a child that never finishes at all.
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(DEADLINE_EXPIRED), deadlineMs) })
  const outcome = await Promise.race([
    Promise.all(handles.map((handle) => handle.settled)).then(() => ALL_CLOSED),
    deadline,
  ])
  // The timer must not keep the event loop alive after a timely teardown.
  clearTimeout(timer)
  return {
    timedOut: outcome === DEADLINE_EXPIRED,
    settled: handles.filter((handle) => handle.closed),
    survivors: handles.filter((handle) => !handle.closed),
  }
}
