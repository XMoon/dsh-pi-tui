import type { RemoteWriteFailure } from '../../runtime/remote/write-failure.ts'
import type { NativePromptResult, NativeResult } from './native-client.ts'

type NativeFailureResult = Extract<NativeResult<never>, { readonly kind: 'unknown' | 'rejected' }>

function unknownFailure(code: string, message: string): NativeFailureResult {
  return { kind: 'unknown', code, message }
}

/**
 * Native's public result taxonomy deliberately does not reuse the shared TUI
 * classifier's `cancelled => not-dispatched` shortcut. Native operations fence
 * genuinely pre-dispatch cancellation themselves; a cancellation reported by
 * the official service has already entered the call path.
 */
export function nativeWriteFailure(failure: RemoteWriteFailure): NativeFailureResult {
  if (failure.kind === 'rejected') {
    return { kind: 'rejected', code: failure.error.code, message: failure.error.message }
  }
  if (failure.kind === 'cancelled') {
    return unknownFailure('NATIVE_OPERATION_CANCELLED_AFTER_DISPATCH', 'The official call was cancelled after it entered the dispatch path.')
  }
  return unknownFailure(failure.error.code, failure.error.message)
}

export function nativePromptWriteFailure(failure: RemoteWriteFailure, requestId: string): NativePromptResult {
  if (failure.kind === 'rejected') {
    return { kind: 'rejected', code: failure.error.code, message: failure.error.message }
  }
  if (failure.kind === 'cancelled') {
    return { kind: 'unknown', code: 'NATIVE_OPERATION_CANCELLED_AFTER_DISPATCH', message: 'The official prompt call was cancelled after it entered the dispatch path.', requestId }
  }
  return { kind: 'unknown', code: failure.error.code, message: failure.error.message, requestId }
}
