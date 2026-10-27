/**
 * The delivered-file READ port (Delivered files PR2 / M9): the ONE semantic
 * boundary the preview consumes for a DECLARED file's Host metadata and text
 * pages.
 *
 * It is Host-owned and read-only by contract:
 *
 * ```text
 * stat(sessionId, path)              -> the Host's freshness token + byte size
 * read(sessionId, path, offset, limit) -> one decoded UTF-8 page of lines
 * ```
 *
 * Both Direct and Remote serve this SAME vocabulary; the Direct adapter reads
 * the official Host file service in-process and the Remote adapter calls the
 * official generated `workspaceFiles` namespace, but neither re-derives the
 * Session's workspace scope, the line window or the failure classification.
 *
 * The port never invents a second error system: the six codes below ARE the
 * preview's semantic failure vocabulary (they map the official
 * `workspace-file/*` refusals), a SUPERSEDED read throws the repository's
 * existing `SupersededReadError`, and an unrecognized failure is rethrown
 * unchanged so the UI can report "unknown" instead of guessing a state.
 * @module @xmoon76/dsh-pi-tui/runtime/deliverables-port
 */

/** Identity and freshness of one declared file, WITHOUT its content. */
export interface DeliveredFileStat {
  /** Opaque freshness token from the Host; never parsed. */
  readonly version: string
  /** Byte size when the Host backend reports it. */
  readonly bytes?: number
}

/** One decoded page of a declared text file. */
export interface DeliveredFilePage {
  /** The freshness token the Host reported for this page read. */
  readonly stat: DeliveredFileStat
  /** First line of the page, 1-based, as requested. */
  readonly offset: number
  /** The largest number of lines the page may hold, as requested. */
  readonly limit: number
  /** The page's lines joined by `\n` (no terminator after the last one). */
  readonly text: string
  /** How many lines the page holds; 0 when `offset` is past the last line. */
  readonly lines: number
  /** Whether the page includes the file's last line. */
  readonly eof: boolean
}

/** The preview's semantic failure vocabulary (one official refusal each). */
export const DELIVERED_FILE_READ_FAILURE_CODES = [
  'not-found',
  'not-text',
  'not-regular-file',
  'too-large',
  'session-unavailable',
  'service-unavailable',
] as const

export type DeliveredFileReadFailureCode = (typeof DELIVERED_FILE_READ_FAILURE_CODES)[number]

/** One DEFINITE read refusal the preview renders as a state (never a guess). */
export class DeliveredFileReadError extends Error {
  readonly code: DeliveredFileReadFailureCode

  constructor(code: DeliveredFileReadFailureCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.name = 'DeliveredFileReadError'
    this.code = code
  }
}

/**
 * The narrow READ capability the Details preview consumes, already BOUND to one
 * display subject's Session by the composition root. The panel therefore never
 * chooses a Session and never sees an id: it can only read the files of the
 * subject it was opened for.
 */
export interface DeliveredFilePreviewCapability {
  stat(path: string, signal: AbortSignal): Promise<DeliveredFileStat>
  /** The page size is the PORT's, never the caller's: one read is one bounded page. */
  read(path: string, offset: number, signal: AbortSignal): Promise<DeliveredFilePage>
}

/** One page of preview text: the port's fixed bound (plan §7.3). */
export const DELIVERED_FILE_PAGE_LINES = 120

/** The Host file read/preview capability for one Session's declared files. */
export interface DeliveredFileReadPort {
  /**
   * Read the Host metadata of one declared path. The path is the RAW declared
   * string (absolute, or relative to the Session's workspace root — resolution
   * belongs to the Host).
   */
  stat(sessionId: string, path: string, signal: AbortSignal): Promise<DeliveredFileStat>
  /**
   * Read ONE page of exactly `DELIVERED_FILE_PAGE_LINES` lines starting at
   * `offset` (1-based). The page size is the PORT's contract, not a caller
   * choice: the Host decodes UTF-8 and refuses non-text, and the port never
   * reads whole files.
   */
  read(
    sessionId: string,
    path: string,
    offset: number,
    signal: AbortSignal,
  ): Promise<DeliveredFilePage>
}

/**
 * The official refusal code → the preview's semantic code.
 *
 * `gateway/lookup-not-found` is the generated Remote's ASSEMBLY refusal when its
 * Session-derived `workspaceFileScope` lookup cannot resolve the identity (a
 * closed/unknown Session): the preview's `session-unavailable`, never a
 * fabricated "Host says the file is missing".
 */
const OFFICIAL_CODE_MAP: Readonly<Record<string, DeliveredFileReadFailureCode>> = {
  'workspace-file/not-found': 'not-found',
  'workspace-file/not-text': 'not-text',
  'workspace-file/not-regular-file': 'not-regular-file',
  'workspace-file/too-large': 'too-large',
  'gateway/lookup-not-found': 'session-unavailable',
}

/** Whether one value is a module/instance code carrier. */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Map ONE official failure onto the port's vocabulary.
 *
 * A recognized `workspace-file/*` refusal becomes a definite
 * {@link DeliveredFileReadError}; ANYTHING else is returned as-is so the caller
 * keeps its own honesty (the UI reports an unknown failure and its diagnostics
 * channel records the cause) instead of receiving a fabricated state.
 * @param error - the thrown/rejected Host value.
 * @returns the mapped refusal, or the original error when unrecognized.
 */
export function deliveredFileReadErrorFrom(error: unknown): unknown {
  const code = codeOf(error)
  if (code === undefined) return error
  const mapped = OFFICIAL_CODE_MAP[code]
  if (mapped === undefined) return error
  const message = error instanceof Error ? error.message : `${code}`
  return new DeliveredFileReadError(mapped, message, { cause: error })
}
