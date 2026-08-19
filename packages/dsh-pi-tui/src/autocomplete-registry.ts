/**
 * The autocomplete registry (M5, plan §10 item 3): plugins register
 * AutocompleteProviders that participate in the editor's suggestion chain.
 * The host's MentionProvider (slash commands + `@` files + paths) stays the
 * FIRST provider; plugin providers are consulted AFTER it returns null, in
 * registration order (deterministic, never load-order-dependent).
 *
 * Contract (plan M5 gates):
 * - async cancellation: a plugin provider that resolves AFTER the editor
 *   moved on is dropped (the editor's AbortSignal handles the in-flight
 *   abort; the registry additionally drops results that arrive after a
 *   newer keystroke — latest-only commit);
 * - unload removes the provider (fiber-bound);
 * - a throwing provider is isolated: its error is recorded and the chain
 *   continues to the next provider (never a crash);
 * - providers receive only the editor's cursor state — never the terminal,
 *   never the TuiApp, never the session.
 * @module @xmoon76/dsh-pi-tui/autocomplete-registry
 */

import type { AutocompleteHandle, AutocompleteProviderContribution, TuiAutocompleteProvider, TuiAutocompleteQuery, TuiAutocompleteSuggestions } from './extension/public-types.ts'





/** Internal registration record. */
interface ProviderRecord {
  readonly id: string
  readonly provider: TuiAutocompleteProvider
  readonly description: string | undefined
  readonly owner: string
  disposed: boolean
}

/**
 * The autocomplete registry. One instance backs the runner; the extension
 * service exposes registration; the runner asks {@link suggest} when the
 * host's own provider returns null.
 */
export class AutocompleteRegistry {
  private readonly records = new Map<string, ProviderRecord>()
  /** The latest suggestion request's epoch (latest-only commit). */
  private epoch = 0
  private readonly onInvalidate: () => void

  constructor(onInvalidate: () => void = () => {}) {
    this.onInvalidate = onInvalidate
  }

  /**
   * Register one provider. A duplicate id is an error.
   * @param contribution - the provider.
   * @param owner - the Cordis fiber name.
   * @returns a handle to remove the provider.
   */
  register(contribution: AutocompleteProviderContribution, owner: string): AutocompleteHandle {
    if (this.records.has(contribution.id)) {
      throw new Error(`duplicate autocomplete provider id "${contribution.id}"`)
    }
    this.records.set(contribution.id, {
      id: contribution.id,
      provider: contribution.provider,
      description: contribution.description,
      owner,
      disposed: false,
    })
    this.revision += 1
    this.onInvalidate()
    return {
      id: contribution.id,
      dispose: () => this.dispose(contribution.id),
    }
  }

  private revision = 0

  /** Remove one provider by id (idempotent). */
  dispose(id: string): void {
    const record = this.records.get(id)
    if (record === undefined || record.disposed) return
    record.disposed = true
    this.records.delete(id)
    this.revision += 1
    this.onInvalidate()
  }

  /** Dispose every provider owned by one fiber (owner unload). */
  disposeOwner(owner: string): void {
    for (const [id, record] of [...this.records]) {
      if (record.owner === owner) this.dispose(id)
    }
  }

  /**
   * Ask the plugin providers for suggestions, in registration order. The
   * FIRST non-null result wins (deterministic; the host's own provider
   * runs before this). Cancellation + latest-only commit: each call bumps
   * the epoch; a provider that resolves after a NEWER call has started is
   * dropped (its suggestions would be stale for the current cursor).
   * @param lines - the editor lines.
   * @param cursorLine - the cursor line.
   * @param cursorCol - the cursor column.
   * @param options - signal + force.
   * @param onError - records a provider failure (the chain continues).
   * @returns the first non-null suggestions, or null.
   */
  async suggest(
    query: TuiAutocompleteQuery,
    onError?: (id: string, error: unknown) => void,
  ): Promise<TuiAutocompleteSuggestions | null> {
    this.epoch += 1
    const requestEpoch = this.epoch
    const records = [...this.records.values()].filter(record => !record.disposed)
    for (const record of records) {
      try {
        const result = await record.provider.getSuggestions(query)
        // Latest-only commit: a result that arrives after a newer request
        // is stale for the current cursor — drop it.
        if (requestEpoch !== this.epoch) return null
        if (result !== null) return result
      } catch (error) {
        // Per-provider isolation: a throwing provider never aborts the
        // chain. The error is recorded (health) and the next provider runs.
        onError?.(record.id, error)
      }
    }
    return null
  }

  /** Whether any provider is live (health /status). */
  hasAny(): boolean {
    for (const record of this.records.values()) {
      if (!record.disposed) return true
    }
    return false
  }

  /** An immutable snapshot (diagnostics + /status). */
  snapshot(): { providers: readonly AutocompleteProviderContribution[]; revision: number } {
    const providers = [...this.records.values()]
      .filter(record => !record.disposed)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(record => ({
        id: record.id,
        provider: record.provider,
        description: record.description,
        owner: record.owner,
      }))
    return { providers, revision: this.revision }
  }
}
