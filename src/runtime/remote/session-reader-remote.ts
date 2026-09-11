/**
 * Read-only Remote implementation of the semantic SessionReader port.
 *
 * The input faces deliberately mirror the official DSH Client contracts without
 * importing the Host packages into the runtime bundle. Production remains on
 * Direct; this adapter is consumed by the diagnostic/integration shadow only.
 * The official Client owns transport recovery, list projection, search policy,
 * and Session activation. This module only maps those detached read facts.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/session-reader-remote
 */

import { cancellationError } from '../../detached.ts'
import type {
  SessionContentSearchPage,
  SessionProjectionSummary,
  SessionReader,
  SessionSummary,
} from '../session-reader-port.ts'

/** The public generation identity exposed by the official Connection client. */
export interface RemoteConnectionGeneration {
  readonly id: string | number
}

/** The official Connection generation read/subscription face. */
export interface RemoteConnectionGenerationSource {
  getSnapshot(): RemoteConnectionGeneration | undefined
  subscribe(listener: () => void): () => void
}

/** The detached projection values retained on an official Client list row. */
export interface RemoteProjectionValues {
  readonly title?: unknown
  readonly agentPreset?: unknown
}

/** The official Client Session list row subset consumed by this adapter. */
export interface RemoteSessionListRow {
  readonly id: string
  readonly cwd?: string
  readonly parentId?: string
  readonly origin?: 'subagent'
  readonly running: boolean
  readonly updatedAt: number
  readonly projectionValues?: RemoteProjectionValues
}

/** The official Client Session list snapshot subset consumed by this adapter. */
export interface RemoteSessionListState {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, RemoteSessionListRow>>
  readonly phase: 'pending' | 'ready'
}

/** Observable list snapshot face from the official Session Controller client. */
export interface RemoteSessionListSnapshot {
  getSnapshot(): RemoteSessionListState
  subscribe(listener: () => void): () => void
}

/** The official Client Session projection face subset used for a fallback read. */
export interface RemoteSessionProjectionFace {
  getSnapshot(): unknown
}

/** The official Client Session binding projection subset used by this adapter. */
export interface RemoteSessionBinding {
  readonly session: {
    readonly projections: {
      faceOf(key: string): RemoteSessionProjectionFace
    }
  }
}

/** The official Client search result subset. */
export interface RemoteSessionSearchPage {
  readonly items: readonly {
    readonly sessionId: string
    readonly snippet: string
  }[]
  readonly hasMore: boolean
}

/** Structural form of the official RemoteResult. */
export type RemoteReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown }

/** The official Client Session service read face. */
export interface RemoteSessionsReadSource {
  readonly list: RemoteSessionListSnapshot
  refresh(): Promise<void>
  search(query: string, signal: AbortSignal): Promise<RemoteReadResult<RemoteSessionSearchPage>>
  binding(id: string): RemoteSessionBinding | undefined
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function isSearchDisabled(error: unknown): boolean {
  if (errorCodeOf(error) === 'SESSION_QUERY_SEARCH_DISABLED') return true
  // rc1 reports an unmounted dsh-session-query through the generic gateway
  // error code; only the official capability-unavailable message is mapped,
  // never every gateway/internal failure.
  if (errorCodeOf(error) !== 'gateway/internal') return false
  const message = (error as { readonly message?: unknown }).message
  return typeof message === 'string' && message.startsWith('session search is unavailable:')
}

function isRemoteAbort(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true
  const code = errorCodeOf(error)
  return code === 'ABORT_ERR' || code === 'gateway/cancelled' || code === 'SESSION_QUERY_ABORTED'
}

function projectionValue(
  values: RemoteProjectionValues | undefined,
  key: 'title' | 'agentPreset',
): unknown {
  return key === 'title' ? values?.title : values?.agentPreset
}

function stringProjection(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Maps the official DSH Client Session list/projection/search faces to the
 * existing TUI semantic read contract. A generation is required so a lost
 * Connection never becomes an authoritative empty list.
 */
export class RemoteSessionReader implements SessionReader {
  private readonly sessions: RemoteSessionsReadSource
  private readonly generation: RemoteConnectionGenerationSource

  constructor(sessions: RemoteSessionsReadSource, generation: RemoteConnectionGenerationSource) {
    this.sessions = sessions
    this.generation = generation
  }

  async list(currentSessionId: string | undefined, signal?: AbortSignal): Promise<SessionSummary[] | undefined> {
    void currentSessionId
    signal?.throwIfAborted()
    const capturedGeneration = this.generation.getSnapshot()
    if (capturedGeneration === undefined) return undefined

    // The official Client owns refresh single-flight and its failure state. A
    // resolved refresh does not itself promise a new baseline; the snapshot's
    // phase is the only list-arrival fact this adapter consumes.
    await this.sessions.refresh()
    signal?.throwIfAborted()
    if (!Object.is(capturedGeneration, this.generation.getSnapshot())) return undefined

    const snapshot = this.sessions.list.getSnapshot()
    if (snapshot.phase !== 'ready') return undefined
    return snapshot.ids.map(id => {
      const row = snapshot.byId[id]
      return {
        // `ids` is the official ordered membership/identity authority; the
        // keyed row only supplies detached metadata for this id.
        id,
        updatedAt: row.updatedAt,
        cwd: row.cwd,
        ...(row.parentId === undefined ? {} : { parentSession: row.parentId }),
        ...(row.origin === undefined ? {} : { origin: row.origin }),
        // The Client row's `running` bit is not the Direct reader's attached
        // Session-store bit. Keep Remote rows conservatively detached and let
        // shadow parity mark the field non-comparable.
        live: false,
      }
    })
  }

  async projectionBatch(rows: readonly SessionSummary[], signal?: AbortSignal): Promise<Map<string, SessionProjectionSummary>> {
    signal?.throwIfAborted()
    const capturedGeneration = this.generation.getSnapshot()
    if (capturedGeneration === undefined) return new Map()

    const snapshot = this.sessions.list.getSnapshot()
    const result = new Map<string, SessionProjectionSummary>()
    for (const row of rows) {
      signal?.throwIfAborted()
      const listed = snapshot.byId[row.id]
      if (listed === undefined) continue

      let title = stringProjection(projectionValue(listed.projectionValues, 'title'))
      let preset = stringProjection(projectionValue(listed.projectionValues, 'agentPreset'))
      if (title === undefined || preset === undefined) {
        const binding = this.sessions.binding(row.id)
        if (binding !== undefined) {
          if (title === undefined) {
            title = stringProjection(binding.session.projections.faceOf('title').getSnapshot())
          }
          if (preset === undefined) {
            preset = stringProjection(binding.session.projections.faceOf('agentPreset').getSnapshot())
          }
        }
      }
      if (title !== undefined || preset !== undefined) {
        result.set(row.id, {
          ...(title === undefined ? {} : { title }),
          ...(preset === undefined ? {} : { preset }),
        })
      }
    }
    signal?.throwIfAborted()
    if (!Object.is(capturedGeneration, this.generation.getSnapshot())) return new Map()
    return result
  }

  async search(query: string, signal?: AbortSignal): Promise<SessionContentSearchPage | undefined> {
    signal?.throwIfAborted()
    const capturedGeneration = this.generation.getSnapshot()
    if (capturedGeneration === undefined) return undefined
    const requestSignal = signal ?? new AbortController().signal

    let result: RemoteReadResult<RemoteSessionSearchPage>
    try {
      result = await this.sessions.search(query, requestSignal)
      requestSignal.throwIfAborted()
    } catch (error) {
      requestSignal.throwIfAborted()
      if (isSearchDisabled(error)) return undefined
      if (isRemoteAbort(error)) throw cancellationError('remote session search was aborted')
      throw error
    }
    if (!Object.is(capturedGeneration, this.generation.getSnapshot())) return undefined
    if (!result.ok) {
      if (isSearchDisabled(result.error)) return undefined
      if (isRemoteAbort(result.error)) throw cancellationError('remote session search was aborted')
      throw result.error
    }
    return {
      items: result.value.items.map(item => ({ sessionId: item.sessionId, snippet: item.snippet })),
      hasMore: result.value.hasMore,
    }
  }

  measureContext(_sessionId: string): undefined {
    return undefined
  }
}
