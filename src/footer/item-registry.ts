/**
 * The builtin footer item registry (plan §7): the HOST-INTERNAL catalog of
 * semantic footer items. Items are pure render callbacks over the
 * StatusSnapshot (+ the host-owned surface context); the registry is
 * deterministic (id-keyed) and rejects duplicate ids.
 * @module @xmoon76/dsh-pi-tui/footer/item-registry
 */

import type { FooterItemDefinition } from './types.ts'

/** A live external item source (M4: the extension host's configurable
 * footer items — resolved on demand so replace()/dispose() show up on the
 * next compose). */
export interface FooterItemExternalSource {
  ids(): string[]
  definition(id: string): FooterItemDefinition | undefined
}

/** The builtin item registry. */
export class FooterItemRegistry {
  private readonly items = new Map<string, FooterItemDefinition>()
  private external: FooterItemExternalSource | undefined

  /** Register one builtin item; a duplicate id is an explicit error. */
  register(definition: FooterItemDefinition): void {
    if (this.items.has(definition.id)) {
      throw new Error(`duplicate footer item id "${definition.id}"`)
    }
    this.items.set(definition.id, definition)
  }

  /** M4: attach the live external source (extension footer items). The
   * source's ids join the catalog; its definitions resolve on demand. */
  setExternalSource(source: FooterItemExternalSource | undefined): void {
    this.external = source
  }

  /** Look up one item by id; undefined for unknown ids. */
  get(id: string): FooterItemDefinition | undefined {
    return this.items.get(id) ?? this.external?.definition(id)
  }

  /** Every registered id (builtin + live external), in registration order. */
  ids(): string[] {
    return [...this.items.keys(), ...(this.external?.ids() ?? [])]
  }
}
