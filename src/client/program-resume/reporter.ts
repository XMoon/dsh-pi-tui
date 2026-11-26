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
    const target = programResumeTarget(input.capability, input.currentSessionId())
    if (target === undefined) {
      // A sessionless/unrepresentable owner withdraws the previous target once.
      if (!force && (lastKind === 'clear' || lastKind === undefined)) return
      if (lastKind === 'clear' && !dirty) return
      try {
        emitClear()
      } catch (error) {
        try { input.diag.warn('program resume: clear write failed', { error: error instanceof Error ? error.message : 'unknown' }) } catch { /* no lower sink */ }
        return
      }
      lastKind = 'clear'
      lastSessionId = undefined
      dirty = false
      return
    }
    if (!force && !dirty && lastKind === 'report' && lastSessionId === input.currentSessionId()) return
    try {
      const frame = encodeProgramResumeReport({
        token: target.token,
        pid: target.ownerPid,
        time: now(),
        argv: target.argv,
        cwd: target.cwd,
      })
      input.write(frame)
    } catch (error) {
      // An over-budget or otherwise unencodable command must not leave the old
      // target in place. A clear is the protocol's only legal substitute.
      try {
        emitClear()
        lastKind = 'clear'
        lastSessionId = undefined
        dirty = false
      } catch {
        dirty = true
        try { input.diag.warn('program resume: report and clear write failed', { error: error instanceof Error ? error.message : 'unknown' }) } catch { /* no lower sink */ }
      }
      return
    }
    lastKind = 'report'
    lastSessionId = input.currentSessionId()
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
      // Clear unless a clear is already the current state. An exit before the
      // first install (or in a same-process surface-revision window) must
      // still withdraw any record an earlier reporter left behind.
      const shouldClear = lastKind !== 'clear'
      closed = true
      installed = false
      if (!shouldClear || !input.canWrite()) return
      try {
        emitClear()
        lastKind = 'clear'
      } catch {
        // The exit path is not allowed to fail on a best-effort terminal offer.
      }
    },
    unsupportedReloadAccepted: () => {
      if (closed) return
      const shouldClear = lastKind !== 'clear'
      closed = true
      installed = false
      if (!shouldClear || !input.canWrite()) return
      try {
        emitClear()
        lastKind = 'clear'
      } catch {
        // Reload acceptance must not fail on the terminal offer.
      }
    },
    dispose: () => {
      closed = true
      installed = false
    },
  }
}
