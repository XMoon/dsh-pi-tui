/**
 * The editor registry (M9, plan §14): single-winner editor contributions.
 *
 * - the host's default editor is the FALLBACK (never a competing
 *   registration — plan §5.3: host fallback does not enter the ledger);
 * - a plugin editor wins the seat by LOWEST priority; a priority TIE is
 *   an explicit error (never a registration-time guess);
 * - winner unload restores the next winner / the host default, PRESERVING
 *   the draft (plan §14.2);
 * - creation is atomic: `create()` runs BEFORE anything is transferred —
 *   a throw keeps the current editor working;
 * - the registry never touches the seat — the host performs the handoff.
 * @module @xmoon76/dsh-pi-tui/editor-registry
 */

import type { EditorContribution, EditorHandle, EditorHost } from './extension/public-types.ts'

/** Internal record. */
interface EditorRecord {
  readonly id: string
  readonly priority: number
  readonly description: string | undefined
  readonly owner: string
  readonly create: (host: EditorHost) => import('./extension/public-types.ts').ExtensionEditor
  disposed: boolean
}

interface EditorRegistrationHandle {
  readonly id: string
  readonly record: EditorRecord
}

/** The registry's observable snapshot. */
export interface EditorRegistrySnapshot {
  readonly editors: readonly {
    readonly id: string
    readonly priority: number
    readonly description: string | undefined
    readonly owner: string
  }[]
  readonly revision: number
}

/**
 * The editor registry (single-winner). The runner wires the winner into
 * the seat's atomic handoff; the host default is the fallback.
 */
export class EditorRegistry {
  private readonly records = new Map<string, EditorRecord>()
  private revision = 0
  private readonly onInvalidate: () => void

  constructor(onInvalidate: () => void = () => {}) {
    this.onInvalidate = onInvalidate
  }

  /**
   * Register one editor. A duplicate id OR a priority tie (two live
   * editors at the same priority) is an explicit error.
   * @param contribution - the editor.
   * @param owner - the Cordis fiber name.
   */
  register(contribution: EditorContribution, owner: string): EditorHandle {
    if (this.records.has(contribution.id)) {
      throw new Error(`duplicate editor contribution id "${contribution.id}"`)
    }
    for (const record of this.records.values()) {
      if (record.disposed) continue
      if (record.priority === (contribution.priority ?? 0)) {
        throw new Error(
          `editor priority tie: "${record.id}" and "${contribution.id}" both have priority ${contribution.priority ?? 0} — resolve the conflict before registering`,
        )
      }
    }
    const record: EditorRecord = {
      id: contribution.id,
      priority: contribution.priority ?? 0,
      description: contribution.description,
      owner,
      create: contribution.create,
      disposed: false,
    }
    this.records.set(contribution.id, record)
    this.revision += 1
    this.onInvalidate()
    const registration: EditorRegistrationHandle = { id: contribution.id, record }
    return { id: contribution.id, dispose: () => this.disposeHandle(registration) }
  }

  /** Remove one editor by id (used by owner unload). */
  dispose(id: string): void {
    const record = this.records.get(id)
    if (record === undefined) return
    this.disposeRecord(record)
  }

  private disposeHandle(handle: EditorRegistrationHandle): void {
    const record = this.records.get(handle.id)
    if (record !== handle.record) return
    this.disposeRecord(record)
  }

  private disposeRecord(record: EditorRecord): void {
    if (record.disposed) return
    record.disposed = true
    if (this.records.get(record.id) === record) this.records.delete(record.id)
    this.revision += 1
    this.onInvalidate()
  }

  /** Dispose every editor owned by one fiber (owner unload). */
  disposeOwner(owner: string): void {
    for (const [id, record] of [...this.records]) {
      if (record.owner === owner) this.dispose(id)
    }
  }

  /** The current winner (lowest priority), or undefined (host default). */
  winner(): EditorRecord | undefined {
    let best: EditorRecord | undefined
    for (const record of this.records.values()) {
      if (record.disposed) continue
      if (best === undefined || record.priority < best.priority) best = record
    }
    return best
  }

  /** Whether any editor is live (health /status). */
  hasAny(): boolean {
    for (const record of this.records.values()) {
      if (!record.disposed) return true
    }
    return false
  }

  /** An immutable snapshot (diagnostics + /status). */
  snapshot(): EditorRegistrySnapshot {
    const editors = [...this.records.values()]
      .filter(record => !record.disposed)
      .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
      .map(record => ({
        id: record.id,
        priority: record.priority,
        description: record.description,
        owner: record.owner,
      }))
    return { editors, revision: this.revision }
  }
}
