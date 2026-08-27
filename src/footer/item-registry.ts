/**
 * The builtin footer item registry (plan §7): the HOST-INTERNAL catalog of
 * semantic footer items. Items are pure render callbacks over the
 * StatusSnapshot (+ the host-owned surface context); the registry is
 * deterministic (id-keyed) and rejects duplicate ids.
 * @module @xmoon76/dsh-pi-tui/footer/item-registry
 */

import type { FooterItemDefinition } from './types.ts'

const USER_ITEM_PREFIX = 'user:'

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
  private custom: FooterItemExternalSource | undefined
  private readonly base: FooterItemRegistry | undefined

  /** Create a registry optionally layered over another registry. A layered
   * registry is used by the unsaved footer editor: it sees the live builtin /
   * extension catalog while keeping its custom-definition draft isolated from
   * the active footer. */
  constructor(base?: FooterItemRegistry) {
    this.base = base
  }

  /** Register one builtin item; a duplicate id is an explicit error. */
  register(definition: FooterItemDefinition): void {
    if (definition.id.startsWith(USER_ITEM_PREFIX)) {
      throw new Error(`footer item id "${definition.id}" is reserved for custom items`)
    }
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

  /** Attach user-owned definitions as a separate live source. This keeps
   * custom definitions in the ordinary registry/composer path without
   * exposing their settings model to extension consumers. */
  setCustomSource(source: FooterItemExternalSource | undefined): void {
    this.custom = source
  }

  /** Look up one item by id; undefined for unknown ids. Local draft sources
   * take precedence over the base registry so an editor can safely preview a
   * renamed or edited custom definition. */
  get(id: string): FooterItemDefinition | undefined {
    const local = this.items.get(id)
    if (local !== undefined) return local
    // The user namespace is reserved for custom definitions. A malformed or
    // future external source must not be allowed to shadow a non-custom item
    // in that namespace, so non-custom layers win this one collision case.
    if (id.startsWith(USER_ITEM_PREFIX) && this.hasNonCustomDefinition(id)) {
      return this.nonCustomDefinition(id)
    }
    // `user:*` is the reserved custom-definition namespace. Once a draft
    // catalog is attached, an absent id in that catalog is a deliberate
    // deletion, not a reason to fall through to the active base catalog.
    // Without this tombstone rule, deleting a saved custom item in an
    // unsaved editor would still render the base definition.
    if (this.custom !== undefined && id.startsWith(USER_ITEM_PREFIX)) return this.custom.definition(id)
    return this.custom?.definition(id)
      ?? this.external?.definition(id)
      ?? this.base?.get(id)
  }

  /** Every registered id (builtin + live external + custom), in stable
   * catalog order. Layered registries de-duplicate ids exposed by the base. */
  ids(): string[] {
    const baseIds = this.base?.ids() ?? []
    const visibleBaseIds = this.custom === undefined
      ? baseIds
      : baseIds.filter(id => !id.startsWith(USER_ITEM_PREFIX) || this.hasNonCustomDefinition(id))
    const customIds = (this.custom?.ids() ?? [])
      .filter(id => !this.hasNonCustomDefinition(id))
    const ids = [
      ...this.items.keys(),
      ...(this.external?.ids() ?? []),
      ...customIds,
      ...visibleBaseIds,
    ]
    return [...new Set(ids)]
  }

  /** Resolve only builtin/extension layers, skipping every custom source. */
  private nonCustomDefinition(id: string): FooterItemDefinition | undefined {
    const local = this.items.get(id)
    if (local !== undefined) return local
    return this.external?.definition(id) ?? this.base?.nonCustomDefinition(id)
  }

  /** Whether a non-custom layer claims this id. IDs are used rather than
   * calling definition() so a live source that is temporarily unavailable
   * still cannot be shadowed by a custom source. */
  private hasNonCustomDefinition(id: string): boolean {
    if (this.items.has(id)) return true
    if (this.external?.ids().includes(id) === true) return true
    return this.base?.hasNonCustomDefinition(id) ?? false
  }
}
