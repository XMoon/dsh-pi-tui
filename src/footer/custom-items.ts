/**
 * User-owned custom footer item definitions (PR C). Custom definitions are
 * persisted separately from FooterLayoutV1: the layout stores only the
 * canonical `user:*` reference, while this catalog stores what that item is.
 *
 * The compiler deliberately produces the same synchronous, pure
 * FooterItemDefinition used by builtin and extension items. It never reads a
 * snapshot, performs I/O, or executes a command.
 * @module @xmoon76/dsh-pi-tui/footer/custom-items
 */

import type { FooterItemExternalSource } from './item-registry.ts'
import type { FooterItemDefinition, FooterTone } from './types.ts'

/** The namespace reserved for user-created definitions. */
export const CUSTOM_FOOTER_ITEM_PREFIX = 'user:'
/** Maximum display name length (measured in Unicode code points). */
export const MAX_CUSTOM_ITEM_NAME_LENGTH = 64
/** Maximum custom text length (measured in Unicode code points). */
export const MAX_CUSTOM_ITEM_TEXT_LENGTH = 256

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/u
const TONES: ReadonlySet<string> = new Set([
  'primary', 'accent', 'text', 'textStrong', 'textDim', 'textMuted',
  'border', 'success', 'warning', 'error', 'roleUser', 'shellMode',
])

/** The PR C v1 definition union. PR D can add another discriminant here
 * without changing FooterItemRef or the layout schema. */
export type FooterCustomItemSettings = {
  readonly schemaVersion: 1
  readonly id: string
  readonly kind: 'text'
  readonly text: string
  readonly tone?: FooterTone | 'auto'
}

/** A parser result that also lets the caller report invalid entries once
 * without preventing valid user definitions from loading. */
export interface FooterCustomItemsParseResult {
  readonly items: readonly FooterCustomItemSettings[]
  readonly invalidCount: number
}

function codePointLength(text: string): number {
  return [...text].length
}

/** Normalize the name typed by the user and return undefined for a name that
 * cannot form a stable user namespace id. Colons are reserved so a user name
 * cannot impersonate another canonical namespace such as `ext:*`. */
export function normalizeCustomItemName(input: string): string | undefined {
  const name = input.trim()
  if (name === '' || CONTROL_CHARS.test(name)) return undefined
  if (name.includes(':')) return undefined
  if (codePointLength(name) > MAX_CUSTOM_ITEM_NAME_LENGTH) return undefined
  return name
}

/** Convert a user-facing name to the deterministic persisted id. */
export function customItemId(name: string): string | undefined {
  const normalized = normalizeCustomItemName(name)
  return normalized === undefined ? undefined : `${CUSTOM_FOOTER_ITEM_PREFIX}${normalized}`
}

/** Return the user-facing part of a canonical id. */
export function customItemName(id: string): string {
  return id.startsWith(CUSTOM_FOOTER_ITEM_PREFIX)
    ? id.slice(CUSTOM_FOOTER_ITEM_PREFIX.length)
    : id
}

function isTone(value: unknown): value is FooterTone | 'auto' {
  return value === 'auto' || (typeof value === 'string' && TONES.has(value))
}

/** Parse one persisted definition. Invalid definitions are rejected at this
 * boundary; callers can keep the rest of the collection. */
export function parseFooterCustomItem(input: unknown): FooterCustomItemSettings | undefined {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
    const raw = input as Record<string, unknown>
    if (raw.schemaVersion !== 1 || raw.kind !== 'text') return undefined
    if (typeof raw.id !== 'string' || customItemId(customItemName(raw.id)) !== raw.id) return undefined
    if (typeof raw.text !== 'string' || raw.text.trim() === '' || CONTROL_CHARS.test(raw.text)) return undefined
    if (codePointLength(raw.text) > MAX_CUSTOM_ITEM_TEXT_LENGTH) return undefined
    if (raw.tone !== undefined && !isTone(raw.tone)) return undefined
    // Preserve an explicit `auto` token for settings round-trips. Compilation
    // treats it like an absent tone, but silently dropping a valid user field
    // would make an unrelated get→replace cycle lossy.
    const tone = raw.tone === undefined ? undefined : raw.tone
    return {
      schemaVersion: 1,
      id: raw.id,
      kind: 'text',
      text: raw.text,
      ...(tone === undefined ? {} : { tone }),
    }
  } catch {
    // Settings are untrusted; a hostile getter/proxy is one invalid entry,
    // not a reason to abort startup or discard the valid remainder.
    return undefined
  }
}

/** Parse the collection without letting one malformed or duplicate entry
 * break startup. The first definition for an id wins deterministically. */
export function parseFooterCustomItems(input: unknown): FooterCustomItemsParseResult {
  if (input === undefined) return { items: [], invalidCount: 0 }
  if (!Array.isArray(input)) return { items: [], invalidCount: 1 }
  const items: FooterCustomItemSettings[] = []
  const ids = new Set<string>()
  let invalidCount = 0
  for (const candidate of input) {
    const item = parseFooterCustomItem(candidate)
    if (item === undefined || ids.has(item.id)) {
      invalidCount += 1
      continue
    }
    ids.add(item.id)
    items.push(item)
  }
  return { items, invalidCount }
}

/** Compile one validated custom definition into the ordinary footer item
 * contract. */
export function compileCustomTextItem(settings: FooterCustomItemSettings): FooterItemDefinition {
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

/** The mutable, local catalog used by the app and by an unsaved configurator
 * draft. Its source is attached to FooterItemRegistry, so the composer never
 * needs a custom-item branch. */
export class FooterCustomItemCatalog implements FooterItemExternalSource {
  private items: FooterCustomItemSettings[] = []
  private definitions = new Map<string, FooterItemDefinition>()

  constructor(initial: unknown = undefined) {
    this.replace(initial)
  }

  /** Replace the catalog from persisted/raw data and return the number of
   * skipped invalid or duplicate entries. */
  replace(input: unknown): number {
    const parsed = parseFooterCustomItems(input)
    this.items = parsed.items.map(item => ({ ...item }))
    this.definitions = new Map(this.items.map(item => [item.id, compileCustomTextItem(item)]))
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
    this.definitions.set(parsed.id, compileCustomTextItem(parsed))
    return { item: { ...parsed } }
  }

  updateText(id: string, text: string): { ok: boolean; error?: string } {
    const current = this.items.find(item => item.id === id)
    if (current === undefined) return { ok: false, error: 'Footer item no longer exists.' }
    const parsed = parseFooterCustomItem({ ...current, text })
    if (parsed === undefined) return { ok: false, error: 'Text must be non-empty, visible, and at most 256 characters.' }
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
    this.definitions.set(nextId, compileCustomTextItem(parsed))
    return { newId: nextId }
  }

  remove(id: string): boolean {
    const index = this.items.findIndex(item => item.id === id)
    if (index < 0) return false
    this.items.splice(index, 1)
    this.definitions.delete(id)
    return true
  }

  private replaceItem(item: FooterCustomItemSettings): void {
    const index = this.items.findIndex(candidate => candidate.id === item.id)
    if (index < 0) return
    this.items[index] = item
    this.definitions.set(item.id, compileCustomTextItem(item))
  }
}
