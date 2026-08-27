/**
 * Presentation-only model for the Keyboard Shortcuts Editor.
 *
 * The effective keymap remains owned by HostKeybindingManager. This module
 * combines that runtime projection with the raw parsed user declaration so a
 * UI can distinguish defaults, overrides, disabled actions, and conflicts
 * without guessing from effective keys alone.
 */

import { APP_KEYBINDINGS } from '../keybindings/definitions.ts'
import { formatKeyId, formatLeaderSequence } from '../keybindings/hints.ts'
import type { HostKeybindingManager } from '../keybindings/manager.ts'
import type { ParsedUserKeybindings } from '../keybindings/config.ts'
import type { KeyId } from '@xmoon76/pi-tui'
import type { AppKeybindingDefinition, AppKeybindingId, KeybindingSource } from '../keybindings/types.ts'

export type KeybindingEditorBindingKind = 'direct' | 'leader'

export interface KeybindingEditorBinding {
  readonly kind: KeybindingEditorBindingKind
  readonly key: KeyId
}

export type KeybindingEditorRowStatus = 'default' | 'customized' | 'disabled' | 'conflict' | 'fixed' | 'reserved' | 'safe-mode' | 'unbound'

export interface KeybindingEditorRow {
  readonly id: AppKeybindingId
  readonly label: string
  readonly description: string
  readonly category: string
  readonly scope: AppKeybindingDefinition['scope']
  readonly configurable: boolean
  readonly fixed: boolean
  readonly reserved: boolean
  readonly customized: boolean
  readonly disabled: boolean
  readonly safeMode: boolean
  readonly conflict: boolean
  readonly status: KeybindingEditorRowStatus
  readonly source: KeybindingSource
  /** Parsed user declarations, kept separate from effective defaults so the
   * editor never treats an untouched builtin as a removable override. */
  readonly configured: readonly KeybindingEditorBinding[]
  readonly effective: readonly KeybindingEditorBinding[]
  readonly defaults: readonly KeybindingEditorBinding[]
  readonly diagnostics: readonly string[]
  /** Search fields retain their semantic origin so tests and future UI can
   * explain why a row matched without re-parsing its display text. */
  readonly searchFields: Readonly<{
    readonly label: string
    readonly description: string
    readonly action: string
    readonly category: string
    readonly effective: string
    readonly defaults: string
  }>
}

export interface KeybindingEditorSection {
  readonly category: string
  readonly rows: readonly KeybindingEditorRow[]
}

export interface KeybindingEditorLeader {
  readonly key: KeyId | undefined
  readonly customized: boolean
  readonly safeMode: boolean
}

export interface KeybindingEditorModel {
  readonly available: true
  readonly rows: readonly KeybindingEditorRow[]
  readonly sections: readonly KeybindingEditorSection[]
  readonly leader: KeybindingEditorLeader
  readonly diagnostics: readonly string[]
  readonly customizedCount: number
  readonly disabledCount: number
  readonly conflictCount: number
  readonly summary: string
}

const LABELS: Readonly<Partial<Record<AppKeybindingId, string>>> = {
  'app.input.submit': 'Submit draft',
  'app.input.steer': 'Steer running turn',
  'app.input.queue': 'Queue draft while busy',
  'app.input.dequeue': 'Pull queued draft back',
  'app.agent.interrupt': 'Interrupt active turn',
  'app.exit.request': 'Quit the TUI',
  'app.transcript.search': 'Search transcript',
  'app.transcript.search.next': 'Next search match',
  'app.transcript.search.previous': 'Previous search match',
  'app.transcript.search.close': 'Close transcript search',
  'app.transcript.toggleExpand': 'Expand or collapse recent output',
  'app.transcript.toggleThinking': 'Show or hide thinking blocks',
  'app.transcript.toggleFullscreen': 'Toggle fullscreen mode',
  'app.editor.external': 'Edit draft in external editor',
  'app.clipboard.pasteMedia': 'Paste media from clipboard',
  'app.permission.cycle': 'Cycle permission preset',
  'app.todo.toggle': 'Toggle todo panel',
  'app.tasks.open': 'Open task browser',
  'app.history.search': 'Search input history',
  'app.shell.dismissSettled': 'Dismiss settled shell cards',
  'app.model.open': 'Open model picker',
  'question.confirm': 'Confirm question',
  'question.cancel': 'Cancel question',
  'question.cursorUp': 'Move question selection up',
  'question.cursorDown': 'Move question selection down',
  'question.pageUp': 'Page question list up',
  'question.pageDown': 'Page question list down',
  'question.toggleExpand': 'Expand question details',
  'tasks.confirm': 'Confirm selected task',
  'tasks.cancel': 'Close task browser',
  'tasks.cursorUp': 'Move task selection up',
  'tasks.cursorDown': 'Move task selection down',
  'tasks.pageUp': 'Page task list up',
  'tasks.pageDown': 'Page task list down',
  'tasks.cycleType': 'Cycle task type filter',
  'tasks.interrupt': 'Interrupt selected task',
}

function labelFor(definition: AppKeybindingDefinition): string {
  return LABELS[definition.id] ?? definition.id
}

function owns<T extends object>(object: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function directBindings(value: unknown): KeybindingEditorBinding[] {
  if (value === false || value === undefined) return []
  const values = Array.isArray(value) ? value : [value]
  return values
    .filter((value): value is KeyId => typeof value === 'string')
    .map(key => ({ kind: 'direct' as const, key }))
}

function sourceFor(
  definition: AppKeybindingDefinition,
  snapshot: ReturnType<HostKeybindingManager['snapshot']>,
  effective: readonly KeybindingEditorBinding[],
  customized: boolean,
): KeybindingSource {
  const snapshotBinding = snapshot.bindings.find(binding => binding.action === definition.id)
  if (snapshotBinding !== undefined) return snapshotBinding.source
  if (effective.some(binding => binding.kind === 'leader') || customized) return 'user'
  return 'builtin'
}

function displayBindings(bindings: readonly KeybindingEditorBinding[]): string {
  return bindings
    .map(binding => binding.kind === 'leader' ? formatLeaderSequence(binding.key) : formatKeyId(binding.key))
    .join(' / ')
}

function searchValue(bindings: readonly KeybindingEditorBinding[]): string {
  return bindings
    .flatMap(binding => [binding.key, binding.kind, binding.kind === 'leader' ? formatLeaderSequence(binding.key) : formatKeyId(binding.key)])
    .join(' ')
}

function conflictFor(
  action: AppKeybindingId,
  snapshot: ReturnType<HostKeybindingManager['snapshot']>,
  diagnostics: readonly string[],
): boolean {
  if (snapshot.conflicts.some(conflict => conflict.actions.some(entry => entry.action === action))) return true
  return diagnostics.some(message => message.includes(action) && (message.includes('conflict') || message.includes('ambiguous')))
}

function sectionize(rows: readonly KeybindingEditorRow[]): KeybindingEditorSection[] {
  const sections: KeybindingEditorSection[] = []
  const byCategory = new Map<string, KeybindingEditorRow[]>()
  for (const row of rows) {
    const existing = byCategory.get(row.category)
    if (existing === undefined) {
      const next: KeybindingEditorRow[] = [row]
      byCategory.set(row.category, next)
      sections.push({ category: row.category, rows: next })
    } else {
      existing.push(row)
    }
  }
  return sections
}

export function formatEditorBindings(bindings: readonly KeybindingEditorBinding[]): string {
  return displayBindings(bindings) || 'Unbound'
}

export function buildKeybindingEditorModel(
  manager: HostKeybindingManager,
  parsed: ParsedUserKeybindings,
): KeybindingEditorModel {
  const snapshot = manager.snapshot()
  const safeMode = manager.isSafeMode()
  const rows: KeybindingEditorRow[] = []

  for (const definition of Object.values(APP_KEYBINDINGS)) {
    const userValue = parsed.bindings[definition.id]
    const customized = owns(parsed.bindings, definition.id)
    const disabled = !safeMode && userValue === false
    const direct = manager.keysFor(definition.id)
    const leader = manager.leaderKeysFor(definition.id)
    const effective: KeybindingEditorBinding[] = [
      ...direct.map(key => ({ kind: 'direct' as const, key })),
      ...leader.map(key => ({ kind: 'leader' as const, key })),
    ]
    const configured = directBindings(userValue).concat(
      parsed.leaderBindings
        .filter(binding => binding.action === definition.id)
        .map(binding => ({ kind: 'leader' as const, key: binding.key })),
    )
    // Capturing-scope fixed actions are deliberately absent from the Host
    // keymap. Their defaults remain their effective fixed triggers.
    if (!disabled && !definition.configurable && effective.length === 0) {
      effective.push(...definition.defaultKeys.map(key => ({ kind: 'direct' as const, key })))
    }
    const defaults = definition.defaultKeys.map(key => ({ kind: 'direct' as const, key }))
    const diagnostics = manager.diagnosticsList().filter(message => message.includes(definition.id))
    const conflict = conflictFor(definition.id, snapshot, diagnostics)
    const reserved = definition.availability === 'reserved'
    const status: KeybindingEditorRowStatus = safeMode && customized
      ? 'safe-mode'
      : disabled
        ? 'disabled'
        : conflict
          ? 'conflict'
          : reserved
            ? 'reserved'
            : !definition.configurable
              ? 'fixed'
              : configured.length === 0 && definition.defaultKeys.length === 0
                ? 'unbound'
                : customized
                  ? 'customized'
                  : 'default'
    const effectiveText = searchValue(effective)
    const defaultText = searchValue(defaults)
    rows.push({
      id: definition.id,
      label: labelFor(definition),
      description: definition.description,
      category: definition.category,
      scope: definition.scope,
      configurable: definition.configurable,
      fixed: !definition.configurable,
      reserved,
      customized,
      disabled,
      safeMode,
      conflict,
      status,
      source: sourceFor(definition, snapshot, effective, customized),
      configured,
      effective,
      defaults,
      diagnostics,
      searchFields: {
        label: labelFor(definition),
        description: definition.description,
        action: definition.id,
        category: definition.category,
        effective: effectiveText,
        defaults: defaultText,
      },
    })
  }

  const leader: KeybindingEditorLeader = {
    // Safe mode intentionally ignores the persisted leader together with all
    // other user bindings; exposing it as current would invite an edit that
    // cannot affect runtime dispatch.
    key: safeMode ? undefined : parsed.leader?.key,
    customized: parsed.leader !== undefined,
    safeMode,
  }
  const sections = sectionize(rows)
  const customizedCount = rows.filter(row => row.customized).length
  const disabledCount = rows.filter(row => row.disabled).length
  const conflictCount = rows.filter(row => row.conflict).length
  const summaryParts: string[] = []
  if (customizedCount > 0) summaryParts.push(`${customizedCount} customized`)
  if (disabledCount > 0) summaryParts.push(`${disabledCount} disabled`)
  if (conflictCount > 0) summaryParts.push(`${conflictCount} conflict${conflictCount === 1 ? '' : 's'}`)
  const summary = summaryParts.length > 0 ? summaryParts.join(' · ') : 'Defaults'

  return {
    available: true,
    rows,
    sections,
    leader,
    diagnostics: [...parsed.diagnostics, ...manager.diagnosticsList()],
    customizedCount,
    disabledCount,
    conflictCount,
    summary,
  }
}

export interface KeybindingSearchMatch {
  readonly row: KeybindingEditorRow
  readonly fields: readonly string[]
}

/** Search labels, descriptions, action IDs, categories, effective keys, and
 * defaults. All terms must match, while the original definition order stays
 * stable. */
export function searchKeybindingRows(
  rows: readonly KeybindingEditorRow[],
  query: string,
): readonly KeybindingSearchMatch[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return rows.map(row => ({ row, fields: [] }))
  const fieldsFor = (row: KeybindingEditorRow): Readonly<Record<string, string>> => ({
    label: row.searchFields.label,
    description: row.searchFields.description,
    action: row.searchFields.action,
    category: row.searchFields.category,
    effective: row.searchFields.effective,
    defaults: row.searchFields.defaults,
  })
  const matches: KeybindingSearchMatch[] = []
  for (const row of rows) {
    const fields = fieldsFor(row)
    const matchedFields = Object.entries(fields)
      .filter(([, value]) => terms.some(term => value.toLowerCase().includes(term)))
      .map(([name]) => name)
    const matchesAllTerms = terms.every(term => Object.values(fields).some(value => value.toLowerCase().includes(term)))
    if (matchesAllTerms) matches.push({ row, fields: matchedFields })
  }
  return matches
}

export function searchMatchesLeader(
  leader: KeybindingEditorLeader,
  query: string,
): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const text = ['leader', 'leader key', leader.key === undefined ? 'unbound' : leader.key, leader.key === undefined ? '' : formatKeyId(leader.key)].join(' ').toLowerCase()
  return terms.every(term => text.includes(term))
}

export function editorBindingsFor(
  action: AppKeybindingId,
  parsed: ParsedUserKeybindings,
): readonly KeybindingEditorBinding[] {
  const direct = directBindings(parsed.bindings[action])
  const leader = parsed.leaderBindings
    .filter(binding => binding.action === action)
    .map(binding => ({ kind: 'leader' as const, key: binding.key }))
  return [...direct, ...leader]
}
