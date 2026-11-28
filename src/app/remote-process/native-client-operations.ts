import { observeSettled } from '../../runtime/process/tasks.ts'

/** Await one owned operation under a caller lifetime without orphaning it. */
export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    observeSettled(operation, () => {})
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      cleanup()
      reject(signal.reason)
    }
    const cleanup = (): void => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    operation.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) },
    )
  })
}
