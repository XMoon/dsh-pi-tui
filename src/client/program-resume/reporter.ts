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
 * A synchronous sink throw is observable here and never becomes a clear. The
 * process-wide `guardedStreamWriter` owns asynchronous stream errors with no
 * per-write association, so this reporter makes no async-delivery or ACK claim.
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
  readonly write: (frame: string) => void
  readonly diag: Diag
}): ProgramResumeReporter {
  let installed = false
  let closed = false
  let suspended = false
  /** `undefined` means no frame was offered yet; `'clear'` means a clear is current. */
  let lastKind: 'report' | 'clear' | undefined
  /** The last successfully offered canonical Session id (only for reports). */
  let lastSessionId: string | undefined
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

  const emitClear = (): void => {
    const frame = encodeProgramResumeClear({
      token: input.capability.token,
      pid: input.capability.facts.ownerPid,
      time: now(),
    })
    input.write(frame)
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
      // A sessionless/unrepresentable owner withdraws the previous target once.
      if (!force && (lastKind === 'clear' || lastKind === undefined)) return
      if (lastKind === 'clear' && !dirty) return
      const epoch = beginEmission()
      try {
        emitClear()
      } catch {
        if (isCurrentEmission(epoch)) dirty = true
        try { input.diag.warn('program resume: clear write failed', { reason: 'clear-write-failed' }) } catch { /* no lower sink */ }
        return
      }
      if (!isCurrentEmission(epoch)) return
      lastKind = 'clear'
      lastSessionId = undefined
      dirty = false
      return
    }
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
      try {
        emitClear()
        if (!isCurrentEmission(epoch)) return
        lastKind = 'clear'
        lastSessionId = undefined
        dirty = false
      } catch {
        if (isCurrentEmission(epoch)) dirty = true
        try { input.diag.warn('program resume: report and clear write failed', { reason: 'report-unencodable-clear-write-failed' }) } catch { /* no lower sink */ }
      }
      return
    }
    try {
      input.write(frame)
    } catch {
      // A sink failure is NOT an unrepresentable target: preserve the last
      // record and retry only on the next legitimate owner event/regain.
      if (isCurrentEmission(epoch)) dirty = true
      try { input.diag.warn('program resume: report write failed', { reason: 'report-write-failed' }) } catch { /* no lower sink */ }
      return
    }
    if (!isCurrentEmission(epoch)) return
    lastKind = 'report'
    lastSessionId = sessionId
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
      // application owns the tty. A pre-mount/editor exit writes nothing.
      const shouldClear = lastKind !== 'clear' && installed && !suspended && input.canWrite()
      closed = true
      installed = false
      if (!shouldClear) return
      const epoch = beginEmission()
      try {
        emitClear()
        if (isCurrentEmission(epoch)) lastKind = 'clear'
      } catch {
        // Best-effort terminal offer: the business exit still proceeds, but
        // the failed write is recorded with a fixed category.
        try { input.diag.warn('program resume: human-exit clear failed', { reason: 'human-exit-clear-write-failed' }) } catch { /* no lower sink */ }
      }
    },
    unsupportedReloadAccepted: () => {
      if (closed) return
      const shouldClear = lastKind !== 'clear' && installed && !suspended && input.canWrite()
      closed = true
      installed = false
      if (!shouldClear) return
      const epoch = beginEmission()
      try {
        emitClear()
        if (isCurrentEmission(epoch)) lastKind = 'clear'
      } catch {
        // Reload acceptance must not fail on the terminal offer; record it.
        try { input.diag.warn('program resume: unsupported-reload clear failed', { reason: 'unsupported-reload-clear-write-failed' }) } catch { /* no lower sink */ }
      }
    },
    dispose: () => {
      closed = true
      installed = false
    },
  }
}
