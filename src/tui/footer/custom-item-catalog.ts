/**
 * The compiled presentation catalog for user-owned custom footer items
 * (TS5 §13.3): the FooterItemDefinition compilation and the mutable local
 * catalog consumed by the app and by an unsaved configurator draft. The
 * persisted raw shapes and their validation live in
 * `domain/footer/custom-items.ts`.
 *
 * The compiler deliberately produces the same synchronous, pure
 * FooterItemDefinition used by builtin and extension items. It never reads a
 * snapshot, performs I/O, or executes a command: a `kind:'command'` item
 * renders ONLY the cached value committed by the async
 * FooterDynamicItemRuntime (PR D §8.2) — the render path is cache-only by
 * construction.
 * @module @xmoon76/dsh-pi-tui/tui/footer/custom-item-catalog
 */

import type { FooterItemDefinition, FooterTone } from './presentation-types.ts'
import {
  customItemId,
  customItemName,
  parseFooterCustomItem,
  parseFooterCustomItems,
  type FooterCustomCommandItemSettings,
  type FooterCustomItemSettings,
  type FooterCustomTextItemSettings,
} from '../../domain/footer/custom-items.ts'
import type { FooterItemExternalSource } from './item-registry.ts'

/** Compile one validated custom definition into the ordinary footer item
 * contract. */
export function compileCustomTextItem(settings: FooterCustomTextItemSettings): FooterItemDefinition {
  const tone = settings.tone === undefined || settings.tone === 'auto' ? undefined : settings.tone
  return {
    id: settings.id,
    label: customItemName(settings.id),
    description: 'A user-defined text value.',
    defaultZone: 'left',
    defaultImportance: 50,
    formats: ['plain'],
    defaultFormat: 'plain',
    render: () => ({
      spans: [{ text: settings.text, ...(tone === undefined ? {} : { tone }) }],
    }),
  }
}

/** The cached value a command item's render reads (PR D §8.2): the runtime
 * commits the first non-empty sanitized output line; the configurator's
 * draft source may substitute a preview placeholder. The render path is
 * SYNCHRONOUS and I/O-free by construction — it can only read this cache. */
export type FooterCommandItemValue =
  | { readonly kind: 'value'; readonly text: string }
  | { readonly kind: 'placeholder' }
  | undefined

/** The synchronous cache read a command item's render uses. This is a
 * Client-internal implementation detail — never a public extension API, it
 * does not enter ConfigPort and never crosses the Client/Server wire. */
export interface FooterCommandItemValueSource {
  value(id: string): FooterCommandItemValue
}

/** Compile one validated command definition. The render reads ONLY the
 * value source: no cache → null (item unavailable); a preview placeholder
 * → the dim `[command]` marker (the configurator's draft source); a cached
 * value → one span in the definition tone. */
export function compileCustomCommandItem(
  settings: FooterCustomCommandItemSettings,
  source: FooterCommandItemValueSource | undefined,
): FooterItemDefinition {
  const tone = settings.tone === undefined || settings.tone === 'auto' ? undefined : settings.tone
  return {
    id: settings.id,
    label: customItemName(settings.id),
    description: 'A user-defined command output.',
    defaultZone: 'left',
    defaultImportance: 50,
    formats: ['plain'],
    defaultFormat: 'plain',
    render: () => {
      const value = source?.value(settings.id)
      if (value === undefined) return null
      if (value.kind === 'placeholder') return { spans: [{ text: '[command]', tone: 'textDim' }] }
      if (value.text === '') return null
      return { spans: [{ text: value.text, ...(tone === undefined ? {} : { tone }) }] }
    },
  }
}

/** The mutable, local catalog used by the app and by an unsaved configurator
 * draft. Its source is attached to FooterItemRegistry, so the composer never
 * needs a custom-item branch. */
export class FooterCustomItemCatalog implements FooterItemExternalSource {
  private items: FooterCustomItemSettings[] = []
  private definitions = new Map<string, FooterItemDefinition>()
  private commandValueSource: FooterCommandItemValueSource | undefined

  constructor(initial: unknown = undefined) {
    this.replace(initial)
  }

  /** Attach the synchronous command cache read (the app's live cache, or a
   * draft source that gates on definition equality). Without a source,
   * command items render unavailable (null) — fail-soft. */
  setCommandValueSource(source: FooterCommandItemValueSource | undefined): void {
    this.commandValueSource = source
    for (const item of this.items) {
      if (item.kind === 'command') this.definitions.set(item.id, compileCustomCommandItem(item, source))
    }
  }

  /** Replace the catalog from persisted/raw data and return the number of
   * skipped invalid or duplicate entries. */
  replace(input: unknown): number {
    const parsed = parseFooterCustomItems(input)
    this.items = parsed.items.map(item => ({ ...item }))
    this.definitions = new Map(this.items.map(item => [item.id, this.compile(item)]))
    return parsed.invalidCount
  }

  /** Return a detached copy suitable for a settings document or a draft. */
  snapshot(): FooterCustomItemSettings[] {
    return this.items.map(item => ({ ...item }))
  }

  ids(): string[] {
    return this.items.map(item => item.id)
  }

  definition(id: string): FooterItemDefinition | undefined {
    return this.definitions.get(id)
  }

  /** Return one detached persisted definition for editor inspection. */
  get(id: string): FooterCustomItemSettings | undefined {
    const item = this.items.find(candidate => candidate.id === id)
    return item === undefined ? undefined : { ...item }
  }

  has(id: string): boolean {
    return this.definitions.has(id)
  }

  /** Create one definition from the three fields in the editor. */
  create(name: string, text: string, tone: FooterTone | 'auto'): { item?: FooterCustomItemSettings; error?: string } {
    const id = customItemId(name)
    if (id === undefined) return { error: 'Name must be non-empty, visible, and contain no colon.' }
    if (this.has(id)) return { error: `A footer item named "${customItemName(id)}" already exists.` }
    const parsed = parseFooterCustomItem({ schemaVersion: 1, id, kind: 'text', text, tone })
    if (parsed === undefined) return { error: 'Text must be non-empty, visible, and at most 256 characters.' }
    this.items.push(parsed)
    this.definitions.set(parsed.id, this.compile(parsed))
    return { item: { ...parsed } }
  }

  /** Create one command definition (PR D): the command string plus the
   * explicit refresh/timeout the user picked (the dirty comparator and the
   * runtime use the EFFECTIVE values, so an explicit default never reads as
   * a change). */
  createCommand(
    name: string,
    command: string,
    refreshIntervalMs: number,
    timeoutMs: number,
    tone: FooterTone | 'auto',
  ): { item?: FooterCustomItemSettings; error?: string } {
    const id = customItemId(name)
    if (id === undefined) return { error: 'Name must be non-empty, visible, and contain no colon.' }
    if (this.has(id)) return { error: `A footer item named "${customItemName(id)}" already exists.` }
    const parsed = parseFooterCustomItem({
      schemaVersion: 1,
      id,
      kind: 'command',
      command,
      refreshIntervalMs,
      timeoutMs,
      tone,
    })
    if (parsed === undefined) return { error: 'Command must be non-empty and contain no control characters.' }
    this.items.push(parsed)
    this.definitions.set(parsed.id, this.compile(parsed))
    return { item: { ...parsed } }
  }

  updateText(id: string, text: string): { ok: boolean; error?: string } {
    const current = this.items.find(item => item.id === id)
    if (current === undefined) return { ok: false, error: 'Footer item no longer exists.' }
    if (current.kind !== 'text') return { ok: false, error: 'Footer item is not a text item.' }
    const parsed = parseFooterCustomItem({ ...current, text })
    if (parsed === undefined) return { ok: false, error: 'Text must be non-empty, visible, and at most 256 characters.' }
    this.replaceItem(parsed)
    return { ok: true }
  }

  /** Replace a command definition's command string (PR D). */
  updateCommand(id: string, command: string): { ok: boolean; error?: string } {
    const current = this.items.find(item => item.id === id)
    if (current === undefined) return { ok: false, error: 'Footer item no longer exists.' }
    if (current.kind !== 'command') return { ok: false, error: 'Footer item is not a command.' }
    const parsed = parseFooterCustomItem({ ...current, command })
    if (parsed === undefined) return { ok: false, error: 'Command must be non-empty and contain no control characters.' }
    this.replaceItem(parsed)
    return { ok: true }
  }

  /** Replace a command definition's refresh interval (PR D). */
  updateRefresh(id: string, refreshIntervalMs: number): { ok: boolean; error?: string } {
    const current = this.items.find(item => item.id === id)
    if (current === undefined) return { ok: false, error: 'Footer item no longer exists.' }
    if (current.kind !== 'command') return { ok: false, error: 'Footer item is not a command.' }
    const parsed = parseFooterCustomItem({ ...current, refreshIntervalMs })
    if (parsed === undefined) return { ok: false, error: 'Refresh must be a finite number of milliseconds.' }
    this.replaceItem(parsed)
    return { ok: true }
  }

  /** Replace a command definition's timeout (PR D). */
  updateTimeout(id: string, timeoutMs: number): { ok: boolean; error?: string } {
    const current = this.items.find(item => item.id === id)
    if (current === undefined) return { ok: false, error: 'Footer item no longer exists.' }
    if (current.kind !== 'command') return { ok: false, error: 'Footer item is not a command.' }
    const parsed = parseFooterCustomItem({ ...current, timeoutMs })
    if (parsed === undefined) return { ok: false, error: 'Timeout must be a finite number of milliseconds.' }
    this.replaceItem(parsed)
    return { ok: true }
  }

  updateTone(id: string, tone: FooterTone | 'auto'): { ok: boolean; error?: string } {
    const current = this.items.find(item => item.id === id)
    if (current === undefined) return { ok: false, error: 'Footer item no longer exists.' }
    const parsed = parseFooterCustomItem({ ...current, tone })
    if (parsed === undefined) return { ok: false, error: 'The selected tone is invalid.' }
    this.replaceItem(parsed)
    return { ok: true }
  }

  rename(id: string, name: string): { newId?: string; error?: string } {
    const current = this.items.find(item => item.id === id)
    if (current === undefined) return { error: 'Footer item no longer exists.' }
    const nextId = customItemId(name)
    if (nextId === undefined) return { error: 'Name must be non-empty, visible, and contain no colon.' }
    if (nextId !== id && this.has(nextId)) return { error: `A footer item named "${customItemName(nextId)}" already exists.` }
    if (nextId === id) return { newId: id }
    const parsed = parseFooterCustomItem({ ...current, id: nextId })
    if (parsed === undefined) return { error: 'The new name is invalid.' }
    const index = this.items.findIndex(item => item.id === id)
    this.items[index] = parsed
    this.definitions.delete(id)
    this.definitions.set(nextId, this.compile(parsed))
    return { newId: nextId }
  }

  remove(id: string): boolean {
    const index = this.items.findIndex(item => item.id === id)
    if (index < 0) return false
    this.items.splice(index, 1)
    this.definitions.delete(id)
    return true
  }

  private compile(item: FooterCustomItemSettings): FooterItemDefinition {
    return item.kind === 'text'
      ? compileCustomTextItem(item)
      : compileCustomCommandItem(item, this.commandValueSource)
  }

  private replaceItem(item: FooterCustomItemSettings): void {
    const index = this.items.findIndex(candidate => candidate.id === item.id)
    if (index < 0) return
    this.items[index] = item
    this.definitions.set(item.id, this.compile(item))
  }
}
