/** Display-safe formatting for durable provider failures. */
export interface DisplayFailure {
  readonly code?: string
  readonly message: string
}

/**
 * Remove sensitive provider text from AUTH failures while preserving the
 * stable code for diagnostics and generic UI labeling.
 */
export function displayFailure(failure: { code?: string; message?: string } | undefined): DisplayFailure {
  if (failure?.code === 'AUTH') return { code: 'AUTH', message: '' }
  return {
    ...(failure?.code === undefined ? {} : { code: failure.code }),
    message: failure?.message ?? '',
  }
}

/** Format a durable failure for a user-facing TUI row. */
export function displayFailureText(failure: { code?: string; message?: string } | undefined): string {
  const display = displayFailure(failure)
  if (display.code === 'AUTH') return 'authentication failed'
  if (display.code === undefined) return display.message === '' ? 'error' : display.message
  return display.message === '' ? display.code : `${display.code}: ${display.message}`
}
