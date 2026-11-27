/**
 * The Split/Daemon Client process's ONE bounded input-recall memory (Feature
 * History PR2-C).
 *
 * ONE instance is created by `startSurfaceLocalClient` OUTSIDE its surface
 * revision loop and injected BY IDENTITY into every revision's PiTui and TSP
 * renderer, so a same-PID HMR replacement re-projects the SAME store. It is the
 * single recall owner of the Client root, now scoped to the authenticated
 * carrier identity plus the current Session id (or the explicit sessionless
 * scope), and it merges two legitimate sources:
 *
 * - local occurrences the renderer actually ACCEPTED in this scope (each may
 *   carry the official request correlation the Host stamped);
 * - the Host accepted-history seed of the exact current Session, read through
 *   the existing private Remote after the Session hydrate.
 *
 * It is deliberately NOT a persistence, Session, cwd or acceptance owner, and
 * it is not a Host mirror: a reconnect/different carrier or Session clears it
 * (local-only recall may be lost), and no Client file or durable cache exists.
 * The official Session log/index remains the Host authority.
 *
 * The bounded candidate window keeps up to {@link INPUT_RECALL_LIMIT} recent
 * occurrences with their identity before any display compression. The visible
 * snapshot trims, drops empty input, collapses only CONSECUTIVE equal text
 * (a non-consecutive repeat is legal history), stays newest-first and remains
 * capped. Identity is never derived from the text: a local occurrence is
 * matched to a Host seed row only by its exact official rpcId, including when
 * adjacent display text has already coalesced before a later seed arrives.
 *
 * @module @xmoon76/dsh-pi-tui/client/history/memory-recall
 */

import { INPUT_RECALL_LIMIT } from './recall-scope.ts'

/**
 * The exact recall scope of this Client root: the authenticated carrier
 * identity (Connection generation + exact binding object, or both undefined
 * while sessionless/offline) plus the published Session id. Same values are
 * the SAME scope; any difference is a different scope and clears the list.
 */
export interface InputRecallScope {
  readonly carrier: {
    readonly connection: unknown
    readonly binding: unknown
  }
  readonly sessionId: string | undefined
}

/** One Host accepted occurrence of the current Session. */
export interface InputRecallSeedItem {
  readonly messageId: string
  /** Optional official request correlation of the first admission. */
  readonly rpcId?: string
  readonly text: string
}

/** The ONE process-lifetime recall capability injected into each renderer. */
export interface InputMemoryRecall {
  /** Newest-first defensive snapshot; callers cannot mutate the store. */
  snapshot(): readonly string[]
  /**
   * Record one already-admitted local input of the CURRENT scope. The optional
   * official request id replaces the matching Host seed row (local text wins).
   */
  remember(text: string, officialRequestId?: string): void
  /** Bind the exact carrier+Session scope; a different scope clears the list.
   *  Returns true only when the scope actually changed (the caller must then
   *  retire the renderer's disposable projection). */
  bindScope(scope: InputRecallScope): boolean
  /**
   * Commit the Host seed of the CURRENT Session: local occurrences stay first,
   * Host rows already represented by a local rpcId are dropped, and the
   * remaining Host rows follow in Host order.
   */
  applySeed(items: readonly InputRecallSeedItem[], sessionId: string): void
}

/** One stored occurrence with enough provenance for the single-scope merge. */
interface RecallRow {
  readonly text: string
  readonly source: 'local' | 'host'
  readonly rpcId?: string
  readonly messageId?: string
}

const EMPTY_CARRIER = { connection: undefined, binding: undefined } as const

/**
 * The bounded candidate window (newest first). Normalization here is ONLY
 * trim/drop-blank/cap: adjacent display compression must NOT erase the identity
 * a later seed still has to correlate by official rpcId.
 */
function candidateRows(rows: readonly RecallRow[]): RecallRow[] {
  const out: RecallRow[] = []
  for (const row of rows) {
    const text = row.text.trim()
    if (text === '') continue
    out.push(text === row.text ? row : { ...row, text })
    if (out.length >= INPUT_RECALL_LIMIT) break
  }
  return out
}

/** The visible newest-first projection: adjacent equal text collapses only at
 *  this display boundary; non-adjacent repeats survive. */
function visibleTexts(rows: readonly RecallRow[]): string[] {
  const out: string[] = []
  for (const row of rows) {
    if (out.length > 0 && out[out.length - 1] === row.text) continue
    out.push(row.text)
    if (out.length >= INPUT_RECALL_LIMIT) break
  }
  return out
}

/** Create ONE process-lifetime recall memory. */
export function createInputMemoryRecall(): InputMemoryRecall {
  /** Newest first — the projection each renderer mirrors or reads. */
  let entries: RecallRow[] = []
  let scope: InputRecallScope = { carrier: EMPTY_CARRIER, sessionId: undefined }

  return {
    snapshot: () => visibleTexts(entries),
    remember: (text: string, officialRequestId?: string): void => {
      const trimmed = text.trim()
      if (trimmed === '') return
      // The Host may have projected the accepted occurrence already. Only an
      // EXACT official correlation identifies it; the local original text wins.
      const withoutSameIdentity = officialRequestId === undefined
        ? entries
        : entries.filter(row => row.rpcId !== officialRequestId)
      entries = candidateRows([
        {
          text: trimmed,
          source: 'local',
          ...(officialRequestId === undefined ? {} : { rpcId: officialRequestId }),
        },
        ...withoutSameIdentity,
      ])
    },
    bindScope: (next: InputRecallScope): boolean => {
      const same = scope.sessionId === next.sessionId
        && Object.is(scope.carrier.connection, next.carrier.connection)
        && Object.is(scope.carrier.binding, next.carrier.binding)
      if (same) return false
      scope = next
      // A different Session or a different authenticated carrier must never
      // expose the outgoing list: a new Host identity is not inferred from an
      // equal Session id string.
      entries = []
      return true
    },
    applySeed: (items: readonly InputRecallSeedItem[], sessionId: string): void => {
      if (scope.sessionId !== sessionId) return
      const local = entries.filter(row => row.source === 'local')
      const localRpcIds = new Set<string>()
      for (const row of local) {
        if (row.rpcId !== undefined) localRpcIds.add(row.rpcId)
      }
      const host = items
        .filter(item => item.rpcId === undefined || !localRpcIds.has(item.rpcId))
        .map((item): RecallRow => ({
          text: item.text,
          source: 'host',
          ...(item.rpcId === undefined ? {} : { rpcId: item.rpcId }),
          messageId: item.messageId,
        }))
      // The previous seed rows are REPLACED, never appended again; a same-scope
      // duplicate seed therefore cannot duplicate Host history. Keep the whole
      // bounded candidate window here; only the snapshot compresses adjacent
      // text for display.
      entries = candidateRows([...local, ...host])
    },
  }
}
