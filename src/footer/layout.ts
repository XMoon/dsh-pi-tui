/**
 * FooterLayoutV1 parsing/validation (plan §14.3): a pure validator for the
 * persisted `footerLayout` settings value. Unknown items are SKIPPED at
 * render time (never deleted from the config — a plugin may reappear), an
 * invalid document fails soft with a warning and the default layout, and
 * the TUI always starts.
 * @module @xmoon76/dsh-pi-tui/footer/layout
 */

import type { FooterItemRef, FooterLayoutV1, FooterRowLayout, FooterTone } from './types.ts'

/** A validation failure (fail-soft: the caller warns once and falls back
 * to the default layout). */
export interface FooterLayoutError {
  readonly kind: 'error'
  readonly message: string
}

/** The semantic tone vocabulary a layout may reference. */
const TONES: ReadonlySet<string> = new Set([
  'primary', 'accent', 'text', 'textStrong', 'textDim', 'textMuted',
  'border', 'success', 'warning', 'error', 'roleUser', 'shellMode',
])

/** Hard bounds (plan §8/§14.3). */
const MAX_ROWS = 2
const MAX_ITEMS_PER_ROW = 32
const MAX_SEPARATOR_LENGTH = 8
const MAX_PREFIX_SUFFIX_LENGTH = 16
const MAX_IMPORTANCE = 1000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Terminal control characters (C0, DEL and C1): a layout is display
 * decoration — ESC/OSC/CSI sequences must never reach the terminal through
 * an id/prefix/suffix/separator (a project-supplied layout could otherwise
 * inject title/clipboard/cursor/screen sequences — including through the
 * configurator's unknown-id label fallback, which renders a raw id). */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/

/** The GLOBAL form, used only for stripping (a non-global replace removes
 * just the FIRST control character — the `.test()` callers above must
 * keep the non-global regex: a global one is stateful across calls). */
const CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f-\u009f]/g

/** Strip EVERY terminal control character from display text (the
 * configurator's unknown-item label fallback: a raw id must never carry
 * ESC/OSC/C0 into the panel — the parser already rejects such ids, this
 * is defense in depth for any other id source). */
export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS_GLOBAL, '')
}

/** Narrow a parse result onto the error arm (the ref type has no kind). */
function isError<T>(value: T | FooterLayoutError): value is FooterLayoutError {
  return (value as FooterLayoutError).kind === 'error'
}

function parseItemRef(input: unknown, index: number): FooterItemRef | FooterLayoutError {
  if (!isRecord(input)) return { kind: 'error', message: `item ${index}: expected an object` }
  const id = input.id
  if (typeof id !== 'string' || id.trim() === '') {
    return { kind: 'error', message: `item ${index}: id must be a non-empty string` }
  }
  // An id is DISPLAY TEXT too: an unknown item renders its id verbatim in
  // the configurator's item rows, so control characters in an id are the
  // same injection class as prefix/suffix/separator (OSC 52 clipboard, CSI
  // title/screen control).
  if (CONTROL_CHARS.test(id)) {
    return { kind: 'error', message: `item ${index}: id must not contain terminal control characters` }
  }
  const ref: {
    id: string
    format?: string
    tone?: string
    prefix?: string
    suffix?: string
    importance?: number
  } = { id }
  if (input.format !== undefined) {
    // An unknown format string is accepted (never a parse failure): the
    // parser is registry-agnostic (extension items declare their own
    // formats), and every item DEGRADES to its default formatter for an
    // unknown format at render time (probed: no item throws). A typo'd
    // format therefore shows the item's default rendering, never a crash.
    if (typeof input.format !== 'string') return { kind: 'error', message: `item ${index}: format must be a string` }
    ref.format = input.format
  }
  if (input.tone !== undefined) {
    if (typeof input.tone !== 'string' || (input.tone !== 'auto' && !TONES.has(input.tone))) {
      return { kind: 'error', message: `item ${index}: unknown tone "${String(input.tone)}"` }
    }
    ref.tone = input.tone
  }
  if (input.prefix !== undefined) {
    if (typeof input.prefix !== 'string' || input.prefix.length > MAX_PREFIX_SUFFIX_LENGTH) {
      return { kind: 'error', message: `item ${index}: prefix must be a string of at most ${MAX_PREFIX_SUFFIX_LENGTH} chars` }
    }
    if (CONTROL_CHARS.test(input.prefix)) {
      return { kind: 'error', message: `item ${index}: prefix must not contain terminal control characters` }
    }
    ref.prefix = input.prefix
  }
  if (input.suffix !== undefined) {
    if (typeof input.suffix !== 'string' || input.suffix.length > MAX_PREFIX_SUFFIX_LENGTH) {
      return { kind: 'error', message: `item ${index}: suffix must be a string of at most ${MAX_PREFIX_SUFFIX_LENGTH} chars` }
    }
    if (CONTROL_CHARS.test(input.suffix)) {
      return { kind: 'error', message: `item ${index}: suffix must not contain terminal control characters` }
    }
    ref.suffix = input.suffix
  }
  if (input.importance !== undefined) {
    if (typeof input.importance !== 'number' || !Number.isFinite(input.importance)
      || input.importance < 0 || input.importance > MAX_IMPORTANCE) {
      return { kind: 'error', message: `item ${index}: importance must be a number in 0..${MAX_IMPORTANCE}` }
    }
    ref.importance = input.importance
  }
  return ref as FooterItemRef
}

function parseRow(input: unknown, index: number): FooterRowLayout | FooterLayoutError {
  if (!isRecord(input)) return { kind: 'error', message: `row ${index}: expected an object` }
  // Only an ABSENT zone is omitted; an explicit null/non-array is a
  // malformed document (fail-soft, never silently coerced).
  const leftInput = input.left === undefined ? [] : input.left
  const rightInput = input.right === undefined ? [] : input.right
  if (!Array.isArray(leftInput) || !Array.isArray(rightInput)) {
    return { kind: 'error', message: `row ${index}: left/right must be arrays` }
  }
  if (leftInput.length + rightInput.length > MAX_ITEMS_PER_ROW) {
    return { kind: 'error', message: `row ${index}: more than ${MAX_ITEMS_PER_ROW} items` }
  }
  const left: FooterItemRef[] = []
  for (let i = 0; i < leftInput.length; i += 1) {
    const item = parseItemRef(leftInput[i], i)
    if (isError(item)) return item
    left.push(item)
  }
  const right: FooterItemRef[] = []
  for (let i = 0; i < rightInput.length; i += 1) {
    const item = parseItemRef(rightInput[i], i)
    if (isError(item)) return item
    right.push(item)
  }
  const row: {
    left: FooterItemRef[]
    right: FooterItemRef[]
    separator?: { text: string; tone?: FooterTone }
  } = { left, right }
  if (input.separator !== undefined) {
    if (!isRecord(input.separator)) return { kind: 'error', message: `row ${index}: separator must be an object` }
    const text = input.separator.text
    // A separator object WITHOUT a text string is treated as ABSENT: the
    // settings service coerces a missing optional object field to `{}`
    // (schemastery), so a persisted separator-less row comes back as
    // `separator: {}` — rejecting it would silently discard every
    // configurator-built layout without a separator on reload (§15.7).
    if (text === undefined) {
      // No separator — the row stays as built.
    } else if (typeof text !== 'string' || text.length > MAX_SEPARATOR_LENGTH) {
      return { kind: 'error', message: `row ${index}: separator text must be a string of at most ${MAX_SEPARATOR_LENGTH} chars` }
    } else {
      if (CONTROL_CHARS.test(text)) {
        return { kind: 'error', message: `row ${index}: separator text must not contain terminal control characters` }
      }
      row.separator = { text }
      if (input.separator.tone !== undefined) {
        if (typeof input.separator.tone !== 'string' || !TONES.has(input.separator.tone)) {
          return { kind: 'error', message: `row ${index}: unknown separator tone "${String(input.separator.tone)}"` }
        }
        row.separator.tone = input.separator.tone as FooterTone
      }
    }
  }
  return row as FooterRowLayout
}

/**
 * Parse and validate a persisted footerLayout value.
 * @param input - the raw settings value (unknown — never trusted).
 * @returns the validated layout or a fail-soft error.
 */
export function parseFooterLayout(input: unknown): FooterLayoutV1 | FooterLayoutError {
  if (!isRecord(input)) return { kind: 'error', message: 'footerLayout must be an object' }
  if (input.schemaVersion !== 1) {
    return { kind: 'error', message: `unsupported footerLayout schemaVersion ${String(input.schemaVersion)}` }
  }
  if (!Array.isArray(input.rows)) return { kind: 'error', message: 'footerLayout.rows must be an array' }
  if (input.rows.length < 1 || input.rows.length > MAX_ROWS) {
    return { kind: 'error', message: `footerLayout must have 1..${MAX_ROWS} rows` }
  }
  const rows: FooterRowLayout[] = []
  for (let i = 0; i < input.rows.length; i += 1) {
    const row = parseRow(input.rows[i], i)
    if (isError(row)) return row
    rows.push(row)
  }
  return { schemaVersion: 1, rows }
}

/** Whether a parsed value is a valid layout (not an error). */
export function isFooterLayout(value: FooterLayoutV1 | FooterLayoutError): value is FooterLayoutV1 {
  return !isError(value)
}

/** The native footer mode a command surface falls back to. `footer` is
 * OVERWRITTEN by 'command' when the command mode arms, so the user's
 * last native mode must be persisted SEPARATELY (footerFallbackMode) or
 * a compact user's fallback would silently become the full default on
 * the next restart (the review's P2). */
export type FooterFallbackMode = 'default' | 'compact' | 'custom'

/** The resolved fallback: the mode plus the persisted custom layout when
 * the mode is 'custom' and the layout parses. */
export interface FooterFallbackResolution {
  readonly mode: FooterFallbackMode
  readonly layout: FooterLayoutV1 | undefined
}

/** M5: resolve the command surface's native fallback from the PERSISTED
 * document. The resolution is explicit and restart-proof: 'compact' keeps
 * the compact preset; 'custom' uses the persisted custom layout (an
 * invalid one degrades to the builtin default); 'default' (or an absent
 * field — existing documents predate the field) keeps the current state.
 * Never reads in-memory state. */
export function resolveCommandFooterFallback(doc: { footerFallbackMode?: unknown; footerLayout?: unknown } | undefined): FooterFallbackResolution {
  if (doc?.footerFallbackMode === 'compact') return { mode: 'compact', layout: undefined }
  if (doc?.footerFallbackMode === 'custom') {
    const parsed = parseFooterLayout(doc.footerLayout)
    return { mode: 'custom', layout: isFooterLayout(parsed) ? parsed : undefined }
  }
  return { mode: 'default', layout: undefined }
}
