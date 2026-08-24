/**
 * The builtin footer item registry (plan §7): the HOST-INTERNAL catalog of
 * semantic footer items. Items are pure render callbacks over the
 * StatusSnapshot (+ the host-owned surface context); the registry is
 * deterministic (id-keyed) and rejects duplicate ids.
 * @module @xmoon76/dsh-pi-tui/footer/item-registry
 */

import type { FooterItemDefinition } from './types.ts'

/** The builtin item registry. */
export class FooterItemRegistry {
  private readonly items = new Map<string, FooterItemDefinition>()

  /** Register one builtin item; a duplicate id is an explicit error. */
  register(definition: FooterItemDefinition): void {
    if (this.items.has(definition.id)) {
      throw new Error(`duplicate footer item id "${definition.id}"`)
    }
    this.items.set(definition.id, definition)
  }

  /** Look up one item by id; undefined for unknown ids. */
  get(id: string): FooterItemDefinition | undefined {
    return this.items.get(id)
  }

  /** Every registered id, in registration order. */
  ids(): string[] {
    return [...this.items.keys()]
  }
}
