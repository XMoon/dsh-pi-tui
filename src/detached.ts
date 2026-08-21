/**
 * The unified entry point for fire-and-forget async work in the runner.
 * Every detached task gets: rejection capture (zero unhandled rejections),
 * cancellation classification (abort/cancel → debug-level only), a
 * user-notification hook for recoverable failures, and diagnostics that
 * name the task and the live session — never the payload.
 *
 * Two entries cover the whole rule surface (AGENTS.md):
 * - {@link runDetached} — detached work with NO result consumer (settings
 *   writes, theme autodetect, skill refresh): the success side is nobody's
 *   business, only rejections are classified;
 * - {@link runOwned} — result-consuming main flows (submit/steer dispatch,
 *   local commands, shell settle, session switch, question flows): the
 *   result drives user-visible state, so the caller gets onResult plus
 *   per-task onCancel/onError side effects.
 *
 * Both take a TASK FACTORY (never a pre-created promise) that is invoked
 * SYNCHRONOUSLY before the helper returns — an ownership action inside the
 * factory (e.g. Ctrl+G's `stop()`) takes effect immediately, with no
 * microtask window — and a synchronous throw is converted into a rejected
 * promise, so it is classified exactly like a rejection. Every boundary —
 * factory throw, task rejection, async onResult failure, a throwing
 * onCancel/onError — lands in the same terminal chain, and observing any
 * thrown value is sync-TOTAL (a hostile Proxy/getter/coercion can never
 * make the chain reject; see `error-boundary.ts` for the exact contract —
 * an observer spawning its OWN detached async work is outside it). A bare
 * `void somePromise()` is never allowed for either.
 * @module @xmoon76/dsh-pi-tui/detached
 */

import type { Diag } from './diag.ts'
import { safeErrorMessage } from './error-boundary.ts'

/** A lazily-created task: invoked synchronously inside the helper. */
export type DetachedTask = () => unknown | Promise<unknown>

export interface DetachedTaskOptions {
  /** The runner's diagnostics channel (stderr + log file). */
  diag: Diag
  /** Surface a user-recoverable failure (e.g. settings persistence). */
  notify?: (message: string) => void
  /** The live session id, re-read at settle time (for diagnostics). */
  sessionId?: () => string | undefined
  /** Classify a failure as user-recoverable (default: false → warn only). */
  recoverable?: (error: unknown) => boolean
}

/**
 * Whether an error represents an abort/cancel rather than a real failure.
 * TOTAL over the whole `unknown` domain: every probe (prototype-chain
 * walk, `name`/`code` getters) is inside the protection, and a hostile
 * value that throws while being observed simply classifies as NOT a
 * cancellation — recognizing a cancellation must never mint a new primary
 * error.
 */
export function isCancellation(error: unknown): boolean {
  try {
    if (!(error instanceof Error)) return false
    return error.name === 'AbortError' || (error as { code?: string }).code === 'ABORT_ERR'
  } catch {
    return false
  }
}

/** Build a cancellation-shaped error the classifier recognizes (a plain
 * `new Error('...')` would route through the failure path). */
export function cancellationError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  ;(error as Error & { code?: string }).code = 'ABORT_ERR'
  return error
}

/** Read the live session id for diagnostics WITHOUT ever throwing: a
 * throwing `sessionId()` callback degrades to `undefined` (diagnostics
 * must not crash classification or the final sink). */
function safeSessionId(options: { sessionId?: () => string | undefined }): string | undefined {
  try {
    return options.sessionId?.()
  } catch {
    return undefined
  }
}

/**
 * Invoke the task factory SYNCHRONOUSLY (an ownership action inside the
 * factory — a stop, a latch, a spawn — must take effect before the helper
 * returns, so two calls in one input batch cannot both start), and convert
 * a synchronous throw into a rejected promise so it classifies exactly like
 * a rejection.
 */
function invokeTask<T>(task: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(task())
  } catch (error) {
    return Promise.reject(error)
  }
}

/**
 * Attach rejection handling to a fire-and-forget task. The factory is
 * invoked synchronously (a synchronous throw is a rejection like any
 * other); every rejection is caught and classified:
 * - cancellation → debug diagnostics only (never a user error);
 * - recoverable (per the options hook) → notify + warn;
 * - anything else → warn.
 * The log line carries the task label and the live session id — never the
 * task payload (no API keys, prompt bodies, or shell output). A throwing
 * notify/diag/sessionId path cannot escape: it lands in the handler-failure
 * sink, which is itself total over the `unknown` domain.
 */
export function runDetached(label: string, task: DetachedTask, options: DetachedTaskOptions): void {
  void invokeTask(task)
    .catch((error: unknown) => {
      if (isCancellation(error)) {
        options.diag.debug(label, { session: safeSessionId(options), cancelled: true })
        return
      }
      const message = safeErrorMessage(error)
      // The primary diagnostic is recorded BEFORE the per-task notify: a
      // throwing notify must not erase the failure line (it lands in the
      // handler-failure sink on its own).
      options.diag.warn(label, { session: safeSessionId(options), error: message })
      if (options.recoverable?.(error) === true) {
        options.notify?.(`${label}: ${message}`)
      }
    })
    .catch(handlerFailure(label, options))
}

/** A lazily-created owned task: invoked synchronously inside {@link runOwned}
 * (ownership before the helper returns), with sync throws converted to
 * rejections. */
export type OwnedTask<T> = () => T | Promise<T>

/** Options for {@link runOwned}: a result-consuming main flow. */
export interface OwnedTaskOptions<T> {
  /** The runner's diagnostics channel (stderr + log file). */
  diag: Diag
  /** The live session id, re-read at settle time (for diagnostics). */
  sessionId?: () => string | undefined
  /**
   * Task-local cancellation classifier, consulted BEFORE the diagnostics
   * are written and ONLY for the TASK phase (factory throw / task
   * rejection). Error shape alone cannot see a task's own state — an
   * aborted signal, a disposed latch, a bumped generation — so a task that
   * knows it was cancelled (e.g. `() => localSignal.aborted`) routes a
   * plain-Error rejection to onCancel/debug instead of a false ERROR line.
   * It is NEVER consulted for an onResult failure: the task already
   * settled, so its state cannot excuse a result-consumer bug. Must be
   * cheap; a throw here lands in the handler-failure sink.
   */
  isCancellation?: (error: unknown) => boolean
  /**
   * Consume the task's result (settle UI cards, mutate the queue, notify).
   * May be async; a sync or async failure here is a PRIMARY failure —
   * classified as ERROR + onError regardless of error shape (even an
   * AbortError) and task-local state, since the task already settled — and
   * never escapes.
   */
  onResult?: (result: T) => void | Promise<void>
  /**
   * Cancellation side effects (settle a card as aborted, restore UI state).
   * The cancellation is ALWAYS recorded as debug diagnostics BEFORE this
   * callback runs, so every cancellation is visible in the log; a sync or
   * async throw here lands in the handler-failure sink.
   */
  onCancel?: (error: unknown) => void | Promise<void>
  /**
   * Failure side effects (notify, restore the draft). The failure is ALWAYS
   * recorded as error diagnostics BEFORE this callback runs; a sync or
   * async throw here lands in the handler-failure sink.
   */
  onError?: (error: unknown) => void | Promise<void>
}

/**
 * The owned-workflow counterpart of {@link runDetached}: a fire-and-forget
 * task whose RESULT drives user-visible state (a settled card, a restored
 * draft, a queue mutation, a notification). The factory starts
 * SYNCHRONOUSLY; the TASK phase (factory throw / task rejection) classifies
 * with the error shape plus the task-local predicate; the onResult phase is
 * classified as a PRIMARY failure — ERROR + onError, never a cancellation,
 * regardless of error shape or task-local state; a terminal side-effect
 * handler's (onCancel/onError/classifier) own sync/async throw is wrapped
 * in a {@link HandlerFailure} and lands in the `${label} handler failed`
 * sink exactly once, without mutating the thrown value. Never a bare
 * `void somePromise()`: every owned flow goes through this entry
 * (AGENTS.md).
 */
export function runOwned<T>(label: string, task: OwnedTask<T>, options: OwnedTaskOptions<T>): void {
  void invokeTask(task)
    .then(
      (result) => options.onResult?.(result),
      (error: unknown) => {
        // TASK phase: cancellation classification (error shape + the
        // task-local predicate) applies — the task knows whether its OWN
        // failure is really a cancellation.
        return classify(label, options, error, true)
      },
    )
    .catch((error: unknown) => {
      // onResult phase (or a wrapped handler/classifier failure): the task
      // already settled, so nothing about this failure is a cancellation —
      // neither the error shape nor the task-local predicate is consulted.
      if (isHandlerFailure(error)) throw error
      return classify(label, options, error, false)
    })
    .catch(handlerFailure(label, options))
}

/**
 * Classify one failure and record the classification diagnostics, then run
 * the matching per-task callback. `allowCancellation` gates ALL cancellation
 * classification: the task phase may treat an AbortError or a task-local
 * state as a cancellation; the onResult phase may not (a result-consumer
 * failure is a failure). A terminal side-effect handler's own sync/async
 * failure is wrapped in {@link HandlerFailure} and propagated to the
 * handler-failure sink — never re-classified, never repeated, never
 * escaped. All diagnostics go through the never-throw helpers, so a
 * hostile thrown value or a throwing sessionId/diag can never mint a new
 * primary error.
 */
function classify<T>(
  label: string,
  options: OwnedTaskOptions<T>,
  error: unknown,
  allowCancellation: boolean,
): void | Promise<void> {
  const cancelled = allowCancellation && (isCancellation(error) || taskLocalCancellation(options, error))
  if (cancelled) {
    options.diag.debug(label, { session: safeSessionId(options), cancelled: true })
    if (options.onCancel !== undefined) return guardHandler(() => options.onCancel!(error))
    return
  }
  options.diag.error(label, { session: safeSessionId(options), error: safeErrorMessage(error) })
  if (options.onError !== undefined) return guardHandler(() => options.onError!(error))
}

/** The task-local predicate (cancellation classification is already gated
 * by the caller). A throwing predicate is wrapped as a handler failure — it
 * never re-routes the original error into the wrong classification and is
 * never itself re-classified. */
function taskLocalCancellation<T>(options: OwnedTaskOptions<T>, error: unknown): boolean {
  if (options.isCancellation === undefined) return false
  try {
    return options.isCancellation(error) === true
  } catch (classifierError) {
    throw new HandlerFailure(classifierError)
  }
}

/**
 * Immutable wrapper for a terminal side-effect handler's own failure. The
 * thrown value is NEVER mutated (a primitive, null, or a frozen/non-
 * extensible error must survive intact); the wrapper carries the original
 * cause to the handler-failure sink, and the middle classification catch
 * recognizes it and forwards it unchanged — so `onError`/`onCancel` run
 * exactly once even when they throw.
 */
class HandlerFailure {
  readonly cause: unknown
  constructor(cause: unknown) {
    this.cause = cause
    handlerFailures.add(this)
  }
}

/** Identity registry for the internal wrappers: `WeakSet.has` compares by
 * identity and never walks the argument's prototype chain, so a hostile
 * thrown value (a Proxy with a throwing `getPrototypeOf` trap) can be
 * tested safely — `instanceof HandlerFailure` on an untrusted value could
 * itself throw. */
const handlerFailures = new WeakSet<object>()

/** Whether a value is one of OUR wrapper instances (identity only; total
 * over the whole `unknown` domain). */
function isHandlerFailure(value: unknown): value is HandlerFailure {
  return typeof value === 'object' && value !== null && handlerFailures.has(value)
}

/** Run a per-task terminal callback; a sync or async failure is wrapped in
 * {@link HandlerFailure} so the chain forwards it to the handler-failure
 * sink instead of re-classifying it (and never repeats the callback). */
function guardHandler(invoke: () => void | Promise<void>): void | Promise<void> {
  try {
    const outcome = invoke()
    if (outcome !== undefined) {
      return outcome.catch((error: unknown) => {
        throw new HandlerFailure(error)
      })
    }
    return undefined
  } catch (error) {
    throw new HandlerFailure(error)
  }
}

/**
 * The final sink of both helpers: a terminal side-effect handler
 * (onResult's own invocation aside — see {@link runOwned}), a task-local
 * classifier, or the diagnostics channel itself threw. The ENTIRE body is
 * protected — wrapper unwrapping, error description, the session read and
 * the diag call all live inside the try, and the fallback is a fixed
 * constant that never touches the hostile value again — so the sink is a
 * total function over the `unknown` domain: it can NEVER reject, and there
 * is no lower sink to leak into.
 */
function handlerFailure(
  label: string,
  options: { diag: Diag; sessionId?: () => string | undefined },
): (error: unknown) => void {
  return (error: unknown) => {
    try {
      const cause = isHandlerFailure(error) ? error.cause : error
      options.diag.error(`${label} handler failed`, {
        session: safeSessionId(options),
        error: safeErrorMessage(cause),
      })
    } catch {
      // There is no lower sink. Never throw from this callback.
    }
  }
}
