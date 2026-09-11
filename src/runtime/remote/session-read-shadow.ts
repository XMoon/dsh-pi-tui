/**
 * Generation-fenced Direct-vs-Remote Session read diagnostics.
 *
 * This is intentionally a coordinator, not a Backend or UI store. Direct stays
 * authoritative; a Remote result is compared only while the same official
 * Connection generation and operation epoch remain current. Connection retry,
 * event replay, and Session history ownership stay in the official DSH Client.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/session-read-shadow
 */

import type {
  RemoteConnectionGeneration,
  RemoteConnectionGenerationSource,
} from './session-reader-remote.ts'
import type {
  SessionContentSearchPage,
  SessionProjectionSummary,
  SessionReader,
  SessionSummary,
} from '../session-reader-port.ts'

/** Fields that can be compared without exposing a Host object. */
export type SessionReadMismatchField =
  | 'ids'
  | 'order'
  | 'updatedAt'
  | 'cwd'
  | 'parentSession'
  | 'origin'
  | 'projection.title'
  | 'projection.agentPreset'
  | 'search'
  | 'search.ids'
  | 'search.order'
  | 'search.snippets'
  | 'search.hasMore'

/** One bounded, machine-readable parity mismatch. */
export interface SessionReadMismatch {
  readonly field: SessionReadMismatchField
  readonly sessionId?: string
  readonly expected: unknown
  readonly actual: unknown
}

/** One field deliberately omitted from parity because the official Remote face has no equivalent. */
export interface SessionReadSkippedField {
  readonly field: 'createdAt' | 'live' | 'measureContext'
  readonly reason: string
}

/** A successful comparison report for one Connection generation. */
export interface SessionReadParityReport {
  readonly generation: string
  /** True when every comparable field matched; skipped fields do not make this false. */
  readonly comparable: boolean
  readonly mismatches: readonly SessionReadMismatch[]
  readonly skipped: readonly SessionReadSkippedField[]
}

/** Why a shadow operation did not produce a current comparison. */
export type SessionReadShadowUnavailableReason =
  | 'disconnected'
  | 'reader-unavailable'

/** Result of one shadow operation. */
export type SessionReadShadowOutcome =
  | {
    readonly status: 'compared'
    readonly report: SessionReadParityReport
  }
  | {
    readonly status: 'unavailable'
    readonly generation?: string
    readonly reason: SessionReadShadowUnavailableReason
  }
  | {
    readonly status: 'discarded'
    readonly generation?: string
    readonly reason: 'stale-generation' | 'superseded' | 'disposed'
  }
  | {
    readonly status: 'cancelled'
    readonly generation: string
  }
  | {
    readonly status: 'error'
    readonly generation: string
    readonly error: unknown
  }

/** One read comparison request. */
export interface SessionReadShadowOptions {
  readonly currentSessionId?: string
  /** Omit to compare list/projection only. */
  readonly searchQuery?: string
  readonly signal?: AbortSignal
}

interface CapturedOperation {
  readonly generation: RemoteConnectionGeneration
  readonly sessionId: string | undefined
  readonly epoch: number
  readonly controller: AbortController
  readonly signal: AbortSignal
}

const SKIPPED_FIELDS: readonly SessionReadSkippedField[] = [
  { field: 'createdAt', reason: 'the official Remote Session list has no creation timestamp' },
  { field: 'live', reason: 'the official running bit is not the Direct attached-session bit' },
  { field: 'measureContext', reason: 'the official Client read face has no equivalent context-pressure contract' },
]
const MAX_DIAGNOSTIC_ITEMS = 64
const MAX_DIAGNOSTIC_TEXT = 512
const MAX_DIAGNOSTIC_MISMATCHES = 256

function boundedText(value: string): string {
  return value.length <= MAX_DIAGNOSTIC_TEXT ? value : `${value.slice(0, MAX_DIAGNOSTIC_TEXT - 1)}…`
}

/** Keep parity output detached and finite even for a large Session corpus. */
function boundedDiagnostic(value: unknown): unknown {
  if (typeof value === 'string') return boundedText(value)
  if (value === undefined || value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (!Array.isArray(value)) return '[non-scalar diagnostic value]'
  const values = value.slice(0, MAX_DIAGNOSTIC_ITEMS).map(item => boundedDiagnostic(item))
  return value.length <= MAX_DIAGNOSTIC_ITEMS
    ? values
    : { total: value.length, values, truncated: true }
}

function pushMismatch(mismatches: SessionReadMismatch[], mismatch: Omit<SessionReadMismatch, 'expected' | 'actual'> & {
  readonly expected: unknown
  readonly actual: unknown
}): void {
  if (mismatches.length >= MAX_DIAGNOSTIC_MISMATCHES) return
  mismatches.push({
    ...mismatch,
    expected: boundedDiagnostic(mismatch.expected),
    actual: boundedDiagnostic(mismatch.actual),
  })
}

function generationLabel(generation: RemoteConnectionGeneration): string {
  return boundedText(String(generation.id))
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every(value => rightSet.has(value))
}

function pushFieldMismatch(
  mismatches: SessionReadMismatch[],
  field: SessionReadMismatchField,
  sessionId: string | undefined,
  expected: unknown,
  actual: unknown,
): void {
  if (Object.is(expected, actual)) return
  pushMismatch(mismatches, {
    field,
    ...(sessionId === undefined ? {} : { sessionId: boundedText(sessionId) }),
    expected,
    actual,
  })
}

function projectionValue(
  projection: SessionProjectionSummary | undefined,
  field: 'title' | 'preset',
): string | undefined {
  return field === 'title' ? projection?.title : projection?.preset
}

function compareSearch(
  mismatches: SessionReadMismatch[],
  direct: SessionContentSearchPage | undefined,
  remote: SessionContentSearchPage | undefined,
): void {
  if (direct === undefined || remote === undefined) {
    pushFieldMismatch(
      mismatches,
      'search',
      undefined,
      direct === undefined ? 'unavailable' : 'available',
      remote === undefined ? 'unavailable' : 'available',
    )
    return
  }
  const directIds = direct.items.map(item => item.sessionId)
  const remoteIds = remote.items.map(item => item.sessionId)
  if (!sameStrings(directIds, remoteIds)) {
    pushMismatch(mismatches, {
      field: sameSet(directIds, remoteIds) ? 'search.order' : 'search.ids',
      expected: directIds,
      actual: remoteIds,
    })
  }
  const directSnippets = direct.items.map(item => item.snippet)
  const remoteSnippets = remote.items.map(item => item.snippet)
  if (!sameStrings(directSnippets, remoteSnippets)) {
    pushMismatch(mismatches, { field: 'search.snippets', expected: directSnippets, actual: remoteSnippets })
  }
  pushFieldMismatch(mismatches, 'search.hasMore', undefined, direct.hasMore, remote.hasMore)
}

function compareRows(
  directRows: readonly SessionSummary[],
  remoteRows: readonly SessionSummary[],
  directProjections: ReadonlyMap<string, SessionProjectionSummary>,
  remoteProjections: ReadonlyMap<string, SessionProjectionSummary>,
): SessionReadMismatch[] {
  const mismatches: SessionReadMismatch[] = []
  const directIds = directRows.map(row => row.id)
  const remoteIds = remoteRows.map(row => row.id)
  if (!sameStrings(directIds, remoteIds)) {
    pushMismatch(mismatches, {
      field: sameSet(directIds, remoteIds) ? 'order' : 'ids',
      expected: directIds,
      actual: remoteIds,
    })
  }

  const remoteById = new Map(remoteRows.map(row => [row.id, row]))
  for (const directRow of directRows) {
    const remoteRow = remoteById.get(directRow.id)
    if (remoteRow === undefined) continue
    pushFieldMismatch(mismatches, 'updatedAt', directRow.id, directRow.updatedAt, remoteRow.updatedAt)
    pushFieldMismatch(mismatches, 'cwd', directRow.id, directRow.cwd, remoteRow.cwd)
    pushFieldMismatch(mismatches, 'parentSession', directRow.id, directRow.parentSession, remoteRow.parentSession)
    pushFieldMismatch(mismatches, 'origin', directRow.id, directRow.origin, remoteRow.origin)

    const directProjection = directProjections.get(directRow.id)
    const remoteProjection = remoteProjections.get(directRow.id)
    pushFieldMismatch(
      mismatches,
      'projection.title',
      directRow.id,
      projectionValue(directProjection, 'title'),
      projectionValue(remoteProjection, 'title'),
    )
    pushFieldMismatch(
      mismatches,
      'projection.agentPreset',
      directRow.id,
      projectionValue(directProjection, 'preset'),
      projectionValue(remoteProjection, 'preset'),
    )
  }
  return mismatches
}

/**
 * Compares the Direct and official-Client Remote Session read faces without
 * changing production state. A later compare, Connection reset, or dispose
 * invalidates an earlier operation; stale successes and stale failures alike
 * return `discarded` rather than being reported as a match or current error.
 */
export class RemoteSessionReadShadow {
  private readonly direct: SessionReader
  private readonly remote: SessionReader
  private readonly generation: RemoteConnectionGenerationSource
  private operationEpoch = 0
  private disposed = false
  private active: CapturedOperation | undefined
  private readonly unsubscribeGeneration: () => void

  constructor(
    direct: SessionReader,
    remote: SessionReader,
    generation: RemoteConnectionGenerationSource,
  ) {
    this.direct = direct
    this.remote = remote
    this.generation = generation
    this.unsubscribeGeneration = generation.subscribe(() => {
      this.operationEpoch += 1
      this.active?.controller.abort()
    })
  }

  async compare(options: SessionReadShadowOptions = {}): Promise<SessionReadShadowOutcome> {
    if (this.disposed) return { status: 'discarded', reason: 'disposed' }
    const capturedGeneration = this.generation.getSnapshot()
    if (capturedGeneration === undefined) return { status: 'unavailable', reason: 'disconnected' }

    const operation = this.beginOperation(capturedGeneration, options.currentSessionId, options.signal)
    try {
      const [directRows, remoteRows, directSearch, remoteSearch] = await Promise.all([
        this.direct.list(options.currentSessionId, operation.signal),
        this.remote.list(options.currentSessionId, operation.signal),
        options.searchQuery === undefined
          ? Promise.resolve<SessionContentSearchPage | undefined>(undefined)
          : this.direct.search(options.searchQuery, operation.signal),
        options.searchQuery === undefined
          ? Promise.resolve<SessionContentSearchPage | undefined>(undefined)
          : this.remote.search(options.searchQuery, operation.signal),
      ])
      if (!this.isCurrent(operation)) return this.discarded(operation)
      operation.signal.throwIfAborted()
      if (directRows === undefined || remoteRows === undefined) {
        return {
          status: 'unavailable',
          generation: generationLabel(operation.generation),
          reason: 'reader-unavailable',
        }
      }

      const [directProjections, remoteProjections] = await Promise.all([
        this.direct.projectionBatch(directRows, operation.signal),
        this.remote.projectionBatch(remoteRows, operation.signal),
      ])
      if (!this.isCurrent(operation)) return this.discarded(operation)
      operation.signal.throwIfAborted()

      const mismatches = compareRows(directRows, remoteRows, directProjections, remoteProjections)
      if (options.searchQuery !== undefined) compareSearch(mismatches, directSearch, remoteSearch)
      if (!this.isCurrent(operation)) return this.discarded(operation)
      operation.signal.throwIfAborted()
      return {
        status: 'compared',
        report: {
          generation: generationLabel(operation.generation),
          comparable: mismatches.length === 0,
          mismatches,
          skipped: SKIPPED_FIELDS,
        },
      }
    } catch (error) {
      if (!this.isCurrent(operation)) return this.discarded(operation)
      if (options.signal?.aborted === true) {
        return { status: 'cancelled', generation: generationLabel(operation.generation) }
      }
      return {
        status: 'error',
        generation: generationLabel(operation.generation),
        error,
      }
    } finally {
      if (this.active === operation) this.active = undefined
    }
  }

  /** Stop observing Connection generations and cancel the owned operation. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.operationEpoch += 1
    this.active?.controller.abort()
    this.active = undefined
    this.unsubscribeGeneration()
  }

  private beginOperation(
    generation: RemoteConnectionGeneration,
    sessionId: string | undefined,
    externalSignal: AbortSignal | undefined,
  ): CapturedOperation {
    this.active?.controller.abort()
    const controller = new AbortController()
    const signal = externalSignal === undefined
      ? controller.signal
      : AbortSignal.any([externalSignal, controller.signal])
    const operation = {
      generation,
      sessionId,
      epoch: ++this.operationEpoch,
      controller,
      signal,
    }
    this.active = operation
    return operation
  }

  private isCurrent(operation: CapturedOperation): boolean {
    return !this.disposed
      && this.active === operation
      && this.operationEpoch === operation.epoch
      && Object.is(this.generation.getSnapshot(), operation.generation)
  }

  private discarded(operation: CapturedOperation): SessionReadShadowOutcome {
    const current = this.generation.getSnapshot()
    return {
      status: 'discarded',
      generation: generationLabel(operation.generation),
      reason: this.disposed
        ? 'disposed'
        : current === undefined || !Object.is(current, operation.generation)
          ? 'stale-generation'
          : 'superseded',
    }
  }
}
