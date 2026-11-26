/**
 * The Client-local OSC 7577 sender.
 *
 * ONE reporter per mounted PiTUI surface. It owns the process-private token,
 * the last offered target and the small amount of state needed to avoid
 * duplicate reports. It is NOT a Session authority: the composition reads the
 * committed owner and passes the exact id.
 *
 * The reporter is synchronous and never throws into the business path. A failed
 * write is retried only by the next legitimate commit or terminal regain; there
 * is no timer, poll, queue or background resource.
 *
 * A synchronous sink throw and the guarded writer's write-completion failure
 * are both observable here and never become a clear. A late failure from an
 * older offer cannot dirty a newer offer or a closed reporter. Neither is an
 * ACK: the terminal has not confirmed that it accepted the record.
 *
 * @module @xmoon76/dsh-pi-tui/client/program-resume/reporter
 */

import type { Diag } from '../../runtime/process/diagnostics.ts'
import { encodeProgramResumeClear, encodeProgramResumeReport } from './codec.ts'
import { programResumeTarget, type ProgramResumeCapability } from './target.ts'

/** The small lifecycle surface the composition owns. */
export interface ProgramResumeReporter {
  /** Begin observation at the real mounted-surface boundary. */
  install(): void
  /** The committed main-owner Session changed (or a generation-only invalidation fired). */
  observe(): void
  /** The physical terminal was released (e.g. external editor). */
  suspend(): void
  /** The physical terminal was regained: sample the current target exactly once. */
  resume(): void
  /** The user committed to leaving: clear once, then stop all publication. */
  humanExit(): void
  /** An accepted Client reload targets a build without the v1 handoff. */
  unsupportedReloadAccepted(): void
  /** Generic disposal/signal/HMR: unsubscribe and never clear. */
  dispose(): void
}

/** Build one reporter from an already-admitted capability. */
export function createProgramResumeReporter(input: {
  readonly capability: ProgramResumeCapability
  readonly currentSessionId: () => string | undefined
  readonly canWrite: () => boolean
  readonly write: (frame: string, callback?: (error?: Error | null) => void) => void
  readonly diag: Diag
}): ProgramResumeReporter {
  let installed = false
  let closed = false
  let suspended = false
  /** `undefined` means no frame was offered yet; `'clear'` means a clear is current. */
  let lastKind: 'report' | 'clear' | undefined
  /** The last successfully offered canonical Session id (only for reports). */
  let lastSessionId: string | undefined
  /** The Session id whose clean clear was caused by an unencodable report. */
  let lastCleanClearSessionId: string | undefined
  /** A failed write keeps the intent dirty so the next legitimate event retries. */
  let dirty = false
  /**
   * Every emission owns one epoch. A synchronous callback inside the write may
   * emit a newer target; the outer emission must then NOT commit its stale
   * state over that newer observation.
   */
  let emissionEpoch = 0
  const beginEmission = (): number => (emissionEpoch += 1)
  const isCurrentEmission = (epoch: number): boolean => emissionEpoch === epoch

  const now = (): number => Math.floor(Date.now() / 1000)

  /** Fixed diagnostics categories; never raw errors, argv or the token. */
  const warn = (reason: string): void => {
    try { input.diag.warn(`program resume: ${reason}`, { reason }) } catch { /* no lower sink */ }
  }

  /**
   * Write one frame and report only THIS emission's observable failure. The
   * callback is asynchronous on a real Writable; a late callback from an older
   * emission cannot pollute a newer offer or a closed reporter.
   */
  const writeFrame = (frame: string, epoch: number, reason: string): boolean => {
    let failed = false
    let warned = false
    const fail = (): void => {
      failed = true
      if (isCurrentEmission(epoch) && !closed) dirty = true
      if (!warned) {
        warned = true
        warn(reason)
      }
    }
    try {
      input.write(frame, error => {
        if (error === undefined || error === null) return
        if (!isCurrentEmission(epoch) || closed) return
        fail()
      })
    } catch {
      if (isCurrentEmission(epoch) && !closed) dirty = true
      if (!warned) warn(reason)
      return false
    }
    if (!isCurrentEmission(epoch)) return false
    return !failed
  }

  const emitClear = (epoch: number, reason: string): boolean => {
    let frame: string
    try {
      frame = encodeProgramResumeClear({
        token: input.capability.token,
        pid: input.capability.facts.ownerPid,
        time: now(),
      })
    } catch {
      warn(reason)
      return false
    }
    return writeFrame(frame, epoch, reason)
  }

  const emit = (force: boolean): void => {
    if (!installed || closed || suspended) return
    if (!input.canWrite()) return
    // Capture the committed id ONCE. The write below is a callback boundary; a
    // synchronous re-entrant owner change must not make the state record a
    // newer target than the one actually offered.
    const sessionId = input.currentSessionId()
    const target = programResumeTarget(input.capability, sessionId)
    if (target === undefined) {
      // A clean clear is a no-op; an unoffered/dirty clear must be retried by
      // the next legitimate event (including a failed initial mount clear).
      if (!force && !dirty && (lastKind === 'clear' || lastKind === undefined)) return
      const epoch = beginEmission()
      if (!emitClear(epoch, 'clear-write-failed')) return
      if (!isCurrentEmission(epoch)) return
      lastKind = 'clear'
      lastSessionId = undefined
      lastCleanClearSessionId = undefined
      dirty = false
      return
    }
    // A clean clear for this exact unencodable target is already current.
    if (!dirty && lastKind === 'clear' && lastCleanClearSessionId === sessionId) return
    if (!force && !dirty && lastKind === 'report' && lastSessionId === sessionId) return
    const epoch = beginEmission()
    let frame: string
    try {
      // PURE encode: an unrepresentable/over-budget target has no legal report.
      frame = encodeProgramResumeReport({
        token: target.token,
        pid: target.ownerPid,
        time: now(),
        argv: target.argv,
        cwd: target.cwd,
      })
    } catch {
      // An over-budget or otherwise unencodable command must not leave the old
      // target in place. A clear is the protocol's only legal substitute.
      if (!emitClear(epoch, 'report-unencodable-clear-write-failed')) return
      if (!isCurrentEmission(epoch)) return
      lastKind = 'clear'
      lastSessionId = undefined
      lastCleanClearSessionId = sessionId
      dirty = false
      return
    }
    // A sink failure is NOT an unrepresentable target: preserve the last
    // record and retry only on the next legitimate owner event/regain.
    if (!writeFrame(frame, epoch, 'report-write-failed')) return
    if (!isCurrentEmission(epoch)) return
    lastKind = 'report'
    lastSessionId = sessionId
    lastCleanClearSessionId = undefined
    dirty = false
  }

  return {
    install: () => {
      if (installed || closed) return
      installed = true
      emit(true)
    },
    observe: () => { emit(false) },
    suspend: () => { suspended = true },
    resume: () => {
      if (!installed || closed) return
      suspended = false
      emit(true)
    },
    humanExit: () => {
      if (closed) return
      // The same physical grant as report: installed, not suspended, and the
      // application owns the tty. A pre-mount/editor exit writes nothing. A
      // dirty previous clear still needs one best-effort withdrawal.
      const shouldClear = (lastKind !== 'clear' || dirty) && installed && !suspended && input.canWrite()
      closed = true
      installed = false
      if (!shouldClear) return
      const epoch = beginEmission()
      if (emitClear(epoch, 'human-exit-clear-write-failed') && isCurrentEmission(epoch)) lastKind = 'clear'
    },
    unsupportedReloadAccepted: () => {
      if (closed) return
      const shouldClear = (lastKind !== 'clear' || dirty) && installed && !suspended && input.canWrite()
      closed = true
      installed = false
      if (!shouldClear) return
      const epoch = beginEmission()
      if (emitClear(epoch, 'unsupported-reload-clear-write-failed') && isCurrentEmission(epoch)) lastKind = 'clear'
    },
    dispose: () => {
      closed = true
      installed = false
    },
  }
}
