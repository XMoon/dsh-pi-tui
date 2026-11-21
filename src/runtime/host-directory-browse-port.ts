/**
 * The Host directory-browse read port: ONE transport-neutral, read-only
 * capability for "what directory level does the Host currently report".
 *
 * The Host owns every fact this port returns: the home directory, the listed
 * path, the child rows, their hidden flags, the ancestry crumbs and the
 * truncation mark. Direct forwards to the in-process official
 * `directoryPickerController.list`; Remote forwards to the official generated
 * `directoryPicker.list` namespace. A caller never reads the Client
 * filesystem, never joins or normalizes a path itself, and never turns this
 * read into a Workspace registration or a Session create.
 *
 * `signal` is a CLIENT-LOCAL cancellation/currentness fence: an aborted or
 * superseded read REJECTS instead of producing an outcome, so a late Host
 * answer can never be presented as the current listing.
 *
 * Full contract: docs/architecture/host-client.md (Host Workspace
 * composition).
 * @module @xmoon76/dsh-pi-tui/runtime/host-directory-browse-port
 */

import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'

/** The official Host directory LIST result, classified by what it proves. */
export type HostDirectoryBrowseOutcome =
  /** The Host listed the level. Every field is the official fact, unchanged. */
  | { readonly kind: 'ready'; readonly listing: DirectoryListing }
  /**
   * The official browse surface could not answer (no controller/namespace, no
   * browse capability, disconnected transport, an official cancellation the
   * caller did not request). `code` is the official code when one exists; this
   * is NEVER an empty directory.
   */
  | { readonly kind: 'unavailable'; readonly reason: string; readonly code?: string }
  /**
   * The Host definitively refused the requested path
   * (`directory-picker/unreadable`: not fully qualified, missing or not
   * listable). The requested path is invalid/unreadable, not an empty level.
   */
  | { readonly kind: 'failed'; readonly reason: string; readonly code?: string }

/**
 * The Host directory-browse read capability. It answers exactly one question:
 * can the Host list this ONE directory level now, and what is the official
 * result? It never answers whether a Workspace is registered, whether a Session
 * may be created, or where the Client's own files are.
 */
export interface HostDirectoryBrowsePort {
  /**
   * List one Host directory level.
   * @param path - an absolute Host path, passed through VERBATIM; `undefined`
   *   lists the Host account's home directory.
   * @param signal - caller lifetime/currentness; aborting rejects the read.
   * @returns the official listing, or the truthful unavailable/refused outcome.
   */
  list(path: string | undefined, signal: AbortSignal): Promise<HostDirectoryBrowseOutcome>
}

/** The official code that proves the Host refused the requested path. */
const HOST_DIRECTORY_UNREADABLE_CODES: ReadonlySet<string> = new Set([
  // The seam's own code (a Direct call that reaches the primitive unchanged)
  // and the controller's wire projection of it.
  'directory-unreadable',
  'directory-picker/unreadable',
])

/**
 * The official codes that prove the browse SURFACE could not answer at all:
 * the composed picker is not the browse backend, the addressed Host endpoint
 * or service is not available, or the peer was retired. These are availability
 * facts, never a statement about the requested directory.
 *
 * `gateway/internal` is deliberately ABSENT: the official controller also uses
 * it for ANY unexpected handler failure (`browseFailure` folds a non-seam error
 * into `gateway/internal`), and the Client carrier folds a dropped transport
 * into the same code, so it is not an authoritative availability
 * discriminator. Such a failure stays observable instead of becoming a
 * fabricated `unavailable`.
 */
const HOST_DIRECTORY_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'directory-picker/unavailable',
  // The caller's own cancellation is handled before classification; an
  // official cancellation the caller did not request is an availability fact.
  'gateway/cancelled',
  'gateway/peer-disposed',
  'gateway/service-unavailable',
  'gateway/context-unavailable',
  'gateway/invocation-unavailable',
  'gateway/method-unavailable',
  'gateway/definition-unavailable',
  'gateway/lookup-unavailable',
])

/** Read a structural official failure code (never match on message text). */
function hostDirectoryBrowseCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' && code !== '' ? code : undefined
}

/** The display/diagnostic text of one official failure. */
function hostDirectoryBrowseReason(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const message = (error as { readonly message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}

/**
 * Classify one caught official browse failure into an outcome.
 *
 * Only the Host's own refusal and the browse surface's availability vocabulary
 * are mapped. Anything else (a programming or protocol fault) stays
 * observable: the caller rethrows it instead of receiving a fabricated
 * `unavailable` or an empty listing.
 */
export function hostDirectoryBrowseFailureOutcome(
  error: unknown,
): Extract<HostDirectoryBrowseOutcome, { readonly kind: 'failed' | 'unavailable' }> | undefined {
  const code = hostDirectoryBrowseCode(error)
  if (code === undefined) return undefined
  if (HOST_DIRECTORY_UNREADABLE_CODES.has(code)) {
    return { kind: 'failed', reason: hostDirectoryBrowseReason(error), code }
  }
  if (HOST_DIRECTORY_UNAVAILABLE_CODES.has(code)) {
    return { kind: 'unavailable', reason: hostDirectoryBrowseReason(error), code }
  }
  return undefined
}
