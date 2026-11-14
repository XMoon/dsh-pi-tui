/**
 * FR4 — the PURE renderer/field model of the MCP server configuration form.
 *
 * It owns no authority: every fact comes from the controller's
 * {@link McpEditorSnapshot}, every intent goes back to the controller. It never
 * reads the Host, never writes, never opens an overlay and keeps no second
 * queue — splitting it out only keeps the page's paint path readable.
 *
 * The fixed grouping is Identity (name/transport/enabled) → Connection
 * (command/cwd or url) → Parameters (args rows / env or header key-value rows)
 * → Status (the captured revision and the current write state).
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/mcp-server-config-form
 */

import { truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import type { McpEditorSnapshot } from '../../app/command/mcp-servers.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color } from '../theme/runtime.ts'

/** The fixed form groups, in paint order. */
export type McpFormGroup = 'Identity' | 'Connection' | 'Parameters' | 'Status'

/** What activating one row does. */
export type McpFormAction =
  | { readonly kind: 'edit-name' }
  | { readonly kind: 'cycle-transport' }
  | { readonly kind: 'toggle-enabled' }
  | { readonly kind: 'edit-text'; readonly field: 'command' | 'cwd' | 'url' }
  | { readonly kind: 'edit-arg'; readonly index: number }
  | { readonly kind: 'edit-dict-key'; readonly field: 'env' | 'headers'; readonly key: string }
  | { readonly kind: 'edit-dict-value'; readonly field: 'env' | 'headers'; readonly key: string }
  | { readonly kind: 'add-arg' }
  | { readonly kind: 'add-dict-row'; readonly field: 'env' | 'headers' }

/** One focusable form row. */
export interface McpFormRow {
  /** Stable identity within one draft (used for focus retention). */
  readonly id: string
  readonly group: McpFormGroup
  readonly label: string
  readonly value: string
  readonly action: McpFormAction
  /** Rows a `backspace` may remove (arg / dict key rows). */
  readonly removable?: boolean
}

/** Whether one string is a stored `${credential:REF}` reference. */
function isCredentialReference(value: string): boolean {
  return /^\$\{credential:[A-Za-z_][A-Za-z0-9_]*\}$/u.test(value)
}

/** The display value of one stored dict value: a reference is shown verbatim
 *  (it is not a secret), a plain literal is only reported as `Set (hidden)` —
 *  the form never re-displays a stored secret-ish value it did not just type. */
function dictValueText(value: string): string {
  if (value === '') return '(empty)'
  return isCredentialReference(value) ? value : 'Set (hidden)'
}

/** Build the form's field list from one editor snapshot (deterministic). */
export function mcpFormRows(editor: McpEditorSnapshot): readonly McpFormRow[] {
  const rows: McpFormRow[] = []
  if (editor.nameEditable) {
    rows.push({ id: 'name', group: 'Identity', label: 'Name', value: editor.name === '' ? '(required)' : editor.name, action: { kind: 'edit-name' } })
  } else {
    rows.push({ id: 'name', group: 'Identity', label: 'Name', value: `${editor.name} (fixed)`, action: { kind: 'edit-name' } })
  }
  rows.push({
    id: 'transport',
    group: 'Identity',
    label: 'Transport',
    value: `${editor.transport} (Enter to switch)`,
    action: { kind: 'cycle-transport' },
  })
  rows.push({
    id: 'enabled',
    group: 'Identity',
    label: 'Enabled',
    value: editor.enabled ? 'yes' : 'no',
    action: { kind: 'toggle-enabled' },
  })
  if (editor.transport === 'stdio') {
    rows.push({
      id: 'command',
      group: 'Connection',
      label: 'Command',
      value: editor.command === '' ? '(required)' : editor.command,
      action: { kind: 'edit-text', field: 'command' },
    })
    rows.push({
      id: 'cwd',
      group: 'Connection',
      label: 'Working dir',
      value: editor.cwd === '' ? '(none)' : editor.cwd,
      action: { kind: 'edit-text', field: 'cwd' },
    })
    rows.push({ id: 'arg-add', group: 'Parameters', label: 'Arguments', value: `+ Add argument (${String(editor.args.length)})`, action: { kind: 'add-arg' } })
    for (const [index, arg] of editor.args.entries()) {
      rows.push({
        id: `arg:${String(index)}`,
        group: 'Parameters',
        label: `Arg ${String(index + 1)}`,
        value: arg === '' ? '(empty)' : arg,
        action: { kind: 'edit-arg', index },
        removable: true,
      })
    }
    rows.push({ id: 'env-add', group: 'Parameters', label: 'Env', value: '+ Add env var', action: { kind: 'add-dict-row', field: 'env' } })
    for (const entry of editor.env) {
      rows.push({
        id: `env-key:${entry.key}`,
        group: 'Parameters',
        label: 'Env key',
        value: entry.key,
        action: { kind: 'edit-dict-key', field: 'env', key: entry.key },
        removable: true,
      })
      rows.push({
        id: `env-value:${entry.key}`,
        group: 'Parameters',
        label: `Env ${entry.key}`,
        value: dictValueText(entry.value),
        action: { kind: 'edit-dict-value', field: 'env', key: entry.key },
      })
    }
  } else {
    rows.push({
      id: 'url',
      group: 'Connection',
      label: 'URL',
      value: editor.url === '' ? '(required)' : editor.url,
      action: { kind: 'edit-text', field: 'url' },
    })
    rows.push({ id: 'header-add', group: 'Parameters', label: 'Headers', value: '+ Add header', action: { kind: 'add-dict-row', field: 'headers' } })
    for (const entry of editor.headers) {
      rows.push({
        id: `header-key:${entry.key}`,
        group: 'Parameters',
        label: 'Header key',
        value: entry.key,
        action: { kind: 'edit-dict-key', field: 'headers', key: entry.key },
        removable: true,
      })
      rows.push({
        id: `header-value:${entry.key}`,
        group: 'Parameters',
        label: `Header ${entry.key}`,
        value: dictValueText(entry.value),
        action: { kind: 'edit-dict-value', field: 'headers', key: entry.key },
      })
    }
  }
  return rows
}

/** Pad/truncate one painted line to exactly `width` cells. */
function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const clamped = truncateToWidth(text, width, '…', false)
  const padding = width - visibleWidth(clamped)
  return padding > 0 ? clamped + ' '.repeat(padding) : clamped
}

/** One painted form row with its page-local line index (the hit target). */
export interface McpFormPaintedRow {
  readonly row: McpFormRow
  readonly line: number
}

/** Render the form body (no Action Bar) at one width/row grant. */
export function renderMcpConfigForm(
  editor: McpEditorSnapshot,
  width: number,
  rows: number,
  focusIndex: number,
  offset: number,
): { readonly lines: string[]; readonly painted: readonly McpFormPaintedRow[]; readonly maxOffset: number } {
  const formRows = mcpFormRows(editor)
  const content: { readonly text: string; readonly row?: McpFormRow; readonly group?: McpFormGroup }[] = []
  let lastGroup: McpFormGroup | undefined
  for (const row of formRows) {
    if (row.group !== lastGroup) {
      lastGroup = row.group
      content.push({ text: color.textMuted(row.group), group: row.group })
    }
    const focused = formRows[focusIndex]?.id === row.id
    const marker = focused ? color.textStrong('▸ ', 'primary') : '  '
    const label = color.textDim(`${row.label}: `)
    const value = focused ? color.textStrong(row.value, 'primary') : color.text(row.value)
    content.push({ text: marker + label + value, row })
  }
  const viewport = Math.max(1, rows)
  const maxOffset = Math.max(0, content.length - viewport)
  const clamped = Math.min(Math.max(0, offset), maxOffset)
  const lines: string[] = []
  const painted: McpFormPaintedRow[] = []
  for (let index = 0; index < viewport; index += 1) {
    const entry = content[clamped + index]
    if (entry === undefined) {
      lines.push(fit('', width))
      continue
    }
    lines.push(fit(truncateToWidth(sanitizedPhysicalLine(entry.text), width, '…', false), width))
    if (entry.row !== undefined) painted.push({ row: entry.row, line: index })
  }
  return { lines, painted, maxOffset }
}

/** The one-line form status sentence (never a secret). */
export function mcpFormStatusText(editor: McpEditorSnapshot, statusText: string | undefined): string {
  if (statusText !== undefined) return statusText
  if (editor.issues.length > 0) return editor.issues[0]?.message ?? 'invalid draft'
  return editor.dirty ? 'Unsaved changes' : 'No changes'
}
