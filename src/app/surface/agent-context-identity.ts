/**
 * The current display subject's short-lived Agent Context identity enrichment.
 *
 * The two Agent-authored Context cards (`agent-message`/`relay` and
 * `subagent-settled`/`notice`) expose a durable `senderSessionId`. This owner
 * turns that ONE identity into a readable display name for the CURRENT
 * presentation subject (main Session or mounted child viewer):
 *
 * 1. already-materialized official Session titles (`SessionReader.sessionStatus`)
 *    are read synchronously — zero IO, no history replay;
 * 2. the GLOBAL descendant catalog of the Task Center supplies exact
 *    `childId → label` facts (the catalog stays the authority; this module
 *    never keeps a second roster);
 * 3. only for senders still without a title, ONE `SessionReader.list()` per
 *    demand round plus ONE `projectionBatch()` over the already-listed rows.
 *
 * The result is a read-only `senderSessionId → name` map published into the
 * PiTui renderer. It is presentation state, never a Session fact: switching
 * the subject (a different `sourceIdentity`, viewer enter/exit, a same-id
 * folder replacement) aborts the pending read, drops every name of the old
 * subject and empties the renderer's map before the new subject's frame.
 * Failures keep the truthful fallback (catalog label, then the card's short
 * session id) and are recorded through the runner diagnostics — a failed
 * lookup is never published as a confirmed empty title.
 * @module @xmoon76/dsh-pi-tui/app/surface/agent-context-identity
 */

import { isSurfacedContext } from '../../domain/transcript/semantics.ts'
import type { TranscriptMessage } from '../../domain/transcript/types.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { runOwned } from '../../runtime/process/tasks.ts'
import type { SessionReader } from '../../runtime/session-reader-port.ts'

/** The exact presentation subject one enrichment pass describes. The opaque
 * `sourceIdentity` is the surface's per-Folder token: a same-id Folder
 * replacement (cold rehydrate, session commit) is a DIFFERENT subject. */
export interface AgentContextIdentitySubject {
  readonly subjectKind: 'main' | 'viewed-child'
  readonly subjectId: string | undefined
  /** The surface's per-projection-source identity token (`===` only). */
  readonly sourceIdentity: object
}

/** The dependencies of one surface's identity enrichment. */
export interface AgentContextIdentityDeps {
  /** The existing semantic Session read port (no new Host/Direct coupling). */
  readonly reader: SessionReader
  /** The exact `childId → label` fact from the Task Center's GLOBAL descendant
   * rows, or undefined when the catalog does not carry that exact child. */
  readonly catalogChildLabel: (childId: string) => string | undefined
  /** Publish the CURRENT subject's proven names into the mounted renderer
   * (a no-op while no PiTui renderer exists). */
  readonly publish: (labels: ReadonlyMap<string, string>) => void
  /** Whether the capture is still the live display subject (the surface
   * re-captures its subject + source token at settle time). */
  readonly isCurrentSubject: (subject: AgentContextIdentitySubject) => boolean
  /** The runner diagnostics channel (never-swallowed failures). */
  readonly diag: Diag
  /** The live session id for diagnostics. */
  readonly sessionId: () => string | undefined
  /** The runner cleanup latch. */
  readonly isCleanedUp: () => boolean
}

/** The surface-owned enrichment lifetime. */
export interface AgentContextIdentity {
  /** Observe one committed projection (called from `repaintTarget`): resolves
   * the proven names synchronously, publishes only real changes and starts the
   * ONE pending title batch for senders that still need one. */
  observe(messages: readonly TranscriptMessage[], subject: AgentContextIdentitySubject): void
  /** A Task catalog commit landed: re-resolve the SAME observed frame from the
   * updated catalog facts (never a second catalog and never a Session read). */
  catalogChanged(): void
  /** Dispose the owner: cancel the pending batch and drop every mapping. */
  dispose(): void
}

/** The distinct Agent senders of one projected frame: only surfaced Context
 * rows that carry the complete producer-declared identity. */
function senderIdsOf(messages: readonly TranscriptMessage[]): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    if (!isSurfacedContext(message)) continue
    const presentation = message.contextPresentation
    if (presentation === undefined) continue
    if (presentation.sourceKind === undefined || presentation.form === undefined) continue
    const sender = presentation.senderSessionId
    if (sender === undefined || sender === '') continue
    if (seen.has(sender)) continue
    seen.add(sender)
    ids.push(sender)
  }
  return ids
}

/** A non-blank official title, trimmed at the presentation boundary. */
function provenTitle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const title = value.trim()
  return title === '' ? undefined : title
}

/** Whether two name maps are the same resolved mapping. */
function sameLabels(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left.size !== right.size) return false
  for (const [id, name] of left) {
    if (right.get(id) !== name) return false
  }
  return true
}

/**
 * Create one surface's Agent Context identity enrichment.
 * @param deps - the existing read port, the catalog fact source and the
 *   renderer publication seam.
 */
export function createAgentContextIdentity(deps: AgentContextIdentityDeps): AgentContextIdentity {
  let subject: AgentContextIdentitySubject | undefined
  let observedMessages: readonly TranscriptMessage[] = []
  /** Proven official titles for the CURRENT subject. */
  let titles = new Map<string, string>()
  /** The committed catalog label of each sender seen in the CURRENT subject.
   * It is refreshed ONLY when the catalog commits or a new sender appears —
   * a paint never scans the Task Center's row array. */
  let catalogLabels = new Map<string, string>()
  /** Whether the Task Center committed new rows since the last catalog read. */
  let catalogDirty = true
  /** The senders already resolved in this subject (for new-id detection). */
  const seen = new Set<string>()
  /** The names last published into the renderer (title, else catalog label). */
  let published: ReadonlyMap<string, string> = new Map()
  /** Sender ids already demanded in this subject: one round, never a poll. */
  const demanded = new Set<string>()
  let inflight: AbortController | undefined
  /** Subject generation: every reset aborts the older batch's results. */
  let epoch = 0
  let disposed = false

  const publish = (next: ReadonlyMap<string, string>): void => {
    if (disposed || deps.isCleanedUp()) return
    if (sameLabels(published, next)) return
    published = next
    deps.publish(next)
  }

  const reset = (next: AgentContextIdentitySubject): void => {
    epoch += 1
    inflight?.abort()
    inflight = undefined
    titles = new Map()
    catalogLabels = new Map()
    catalogDirty = true
    seen.clear()
    demanded.clear()
    subject = next
    observedMessages = []
    publish(new Map())
  }

  /** Refresh the committed catalog labels for the CURRENT senders. Only a
   * catalog commit or a newly appearing sender reaches this scan. */
  const refreshCatalog = (ids: readonly string[]): void => {
    for (const id of ids) {
      const label = deps.catalogChildLabel(id)
      if (label === undefined || label.trim() === '') catalogLabels.delete(id)
      else catalogLabels.set(id, label)
    }
    catalogDirty = false
  }

  /** Resolve the observed frame's names from the two proven sources. */
  const resolve = (): void => {
    if (disposed || deps.isCleanedUp() || subject === undefined) return
    const current = subject
    const ids = senderIdsOf(observedMessages)
    const newIds: string[] = []
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      newIds.push(id)
    }
    // A catalog commit can also relabel a sender that is currently outside the
    // window, so a dirty catalog refreshes EVERY sender this subject has seen.
    if (catalogDirty) refreshCatalog([...seen])
    else if (newIds.length > 0) refreshCatalog(newIds)
    const next = new Map<string, string>()
    const demand: string[] = []
    for (const id of ids) {
      // Already-materialized official title (live/retained Session snapshot):
      // the highest authority, read synchronously and never replayed.
      let title = titles.get(id)
      if (title === undefined) {
        title = provenTitle(deps.reader.sessionStatus(id)?.title)
        if (title !== undefined) titles.set(id, title)
      }
      if (title !== undefined) {
        next.set(id, title)
        continue
      }
      const label = catalogLabels.get(id)
      if (label !== undefined) next.set(id, label)
      if (!demanded.has(id)) demand.push(id)
    }
    publish(next)
    if (demand.length === 0 || inflight !== undefined) return
    // ONE demand round per subject: a cold cache miss is an UNKNOWN title, not
    // a licence to replay a session or to poll. A later subject/catalog change
    // is the only new trigger.
    const controller = new AbortController()
    inflight = controller
    const batchEpoch = epoch
    const batchSubject = current
    const batchIds = demand
    for (const id of batchIds) demanded.add(id)
    runOwned('agent context identity', async () => {
      const rows = await deps.reader.list(batchSubject.subjectId, controller.signal)
      controller.signal.throwIfAborted()
      if (rows === undefined || rows.length === 0) return new Map<string, string>()
      const wanted = new Set(batchIds)
      const listed = rows.filter(row => wanted.has(row.id))
      if (listed.length === 0) return new Map<string, string>()
      const projections = await deps.reader.projectionBatch(listed, controller.signal)
      controller.signal.throwIfAborted()
      const resolved = new Map<string, string>()
      for (const row of listed) {
        const title = provenTitle(projections.get(row.id)?.title)
        if (title !== undefined) resolved.set(row.id, title)
      }
      return resolved
    }, {
      diag: deps.diag,
      sessionId: deps.sessionId,
      isCancellation: () => controller.signal.aborted,
      onResult: (resolved) => {
        if (inflight === controller) inflight = undefined
        if (disposed || deps.isCleanedUp()) return
        if (epoch !== batchEpoch || !deps.isCurrentSubject(batchSubject)) return
        for (const [id, title] of resolved) {
          // A title already read synchronously from the live projection is
          // NEWER than this batch (started before it became materialized).
          if (!titles.has(id)) titles.set(id, title)
        }
        // A sender that appeared while this batch was in flight still needs
        // its own ONE demand round; already-demanded ids are never re-read.
        resolve()
      },
      onCancel: () => {
        if (inflight === controller) inflight = undefined
      },
      onError: () => {
        if (inflight === controller) inflight = undefined
      },
    })
  }

  return {
    observe(messages, next) {
      if (disposed || deps.isCleanedUp()) return
      if (subject === undefined
        || subject.subjectKind !== next.subjectKind
        || subject.subjectId !== next.subjectId
        || subject.sourceIdentity !== next.sourceIdentity) {
        reset(next)
      }
      observedMessages = messages
      resolve()
    },
    catalogChanged() {
      if (disposed || deps.isCleanedUp() || subject === undefined) return
      catalogDirty = true
      resolve()
    },
    dispose() {
      if (disposed) return
      disposed = true
      epoch += 1
      inflight?.abort()
      inflight = undefined
      subject = undefined
      observedMessages = []
      titles = new Map()
      demanded.clear()
      published = new Map()
    },
  }
}
