/**
 * The display-only projection of one approval request's raw tool arguments.
 *
 * The Host's `tool/call` bytes (paired by `callId` into the approval request)
 * are the sole input authority. This module turns them into labelled, readable
 * sections for the Approval sheet: it never classifies danger, never resolves
 * or answers the approval, never reads the filesystem and never mutates the
 * received bytes or the Copy source. Unknown fields are preserved verbatim
 * (serialized as indented JSON under `Other arguments`), and any input that is
 * not a JSON object (or whose known-tool schema does not match) falls back to
 * the original text instead of inventing a semantic view.
 *
 * The TOP-LEVEL key order is captured from the received text: `JSON.parse`
 * cannot expose it for integer-like keys (ECMAScript enumerates those
 * numerically). The parsed object remains the value authority; nested values
 * keep the plan-prescribed indented `JSON.stringify` projection.
 *
 * @module @xmoon76/dsh-pi-tui/tui/presentation/approval-arguments
 */

/** One labelled block of the approval body. `text` preserves the source LF. */
export interface ApprovalArgumentSection {
  readonly heading: string
  readonly text: string
}

const ARGUMENTS = 'Arguments'
const OTHER_ARGUMENTS = 'Other arguments'

/** The raw-text fallback: the exact received display text, never re-parsed. */
function rawSections(raw: string): readonly ApprovalArgumentSection[] {
  return [{ heading: ARGUMENTS, text: raw }]
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Decode one already-validated JSON string slice (quotes included). */
function decodeJsonKey(text: string): string | undefined {
  let out = ''
  for (let index = 1; index < text.length - 1; index += 1) {
    const char = text[index]!
    if (char !== '\\') {
      out += char
      continue
    }
    index += 1
    const escape = text[index]
    switch (escape) {
      case '"': out += '"'; break
      case '\\': out += '\\'; break
      case '/': out += '/'; break
      case 'b': out += '\b'; break
      case 'f': out += '\f'; break
      case 'n': out += '\n'; break
      case 'r': out += '\r'; break
      case 't': out += '\t'; break
      case 'u': {
        const code = Number.parseInt(text.slice(index + 1, index + 5), 16)
        if (Number.isNaN(code)) return undefined
        out += String.fromCharCode(code)
        index += 4
        break
      }
      default: return undefined
    }
  }
  return out
}

/**
 * Capture the top-level key order of the ORIGINAL object text. `JSON.parse`
 * cannot expose it: ECMAScript enumerates integer-like own keys numerically.
 * The scan only walks the already-validated top-level object, skipping string
 * contents and nested containers; a malformed/mismatched shape returns
 * `undefined` so the caller falls back to the parsed enumeration (never losing
 * a field).
 */
function topLevelKeyOrder(raw: string): readonly string[] | undefined {
  let index = 0
  const length = raw.length
  const skipWhitespace = (): void => {
    while (index < length) {
      const code = raw.charCodeAt(index)
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return
      index += 1
    }
  }
  /** Advance past one JSON string at `index` (which must be `"`). */
  const skipString = (): boolean => {
    index += 1
    while (index < length) {
      const code = raw.charCodeAt(index)
      if (code === 0x5c) {
        index += 2
        continue
      }
      if (code === 0x22) {
        index += 1
        return true
      }
      index += 1
    }
    return false
  }
  /** Read and decode one top-level key string. */
  const readKey = (): string | undefined => {
    const start = index
    if (!skipString()) return undefined
    return decodeJsonKey(raw.slice(start, index))
  }
  /** Skip one JSON value starting at `index`. */
  const skipValue = (): boolean => {
    if (index >= length) return false
    const first = raw[index]
    if (first === '"') return skipString()
    if (first === '{' || first === '[') {
      const opening = first
      const closing = opening === '{' ? '}' : ']'
      let depth = 0
      while (index < length) {
        const char = raw[index]
        if (char === '"') {
          if (!skipString()) return false
          continue
        }
        if (char === opening) {
          depth += 1
          index += 1
          continue
        }
        if (char === closing) {
          depth -= 1
          index += 1
          if (depth === 0) return true
          continue
        }
        index += 1
      }
      return false
    }
    // number / true / false / null
    while (index < length) {
      const char = raw[index]
      if (char === ',' || char === '}' || char === ']') return true
      index += 1
    }
    return true
  }
  skipWhitespace()
  if (raw[index] !== '{') return undefined
  index += 1
  const order: string[] = []
  skipWhitespace()
  if (raw[index] === '}') return order
  while (index < length) {
    skipWhitespace()
    if (raw[index] !== '"') return undefined
    const key = readKey()
    if (key === undefined) return undefined
    order.push(key)
    skipWhitespace()
    if (raw[index] !== ':') return undefined
    index += 1
    skipWhitespace()
    if (!skipValue()) return undefined
    skipWhitespace()
    if (raw[index] === ',') {
      index += 1
      continue
    }
    if (raw[index] === '}') {
      index += 1
      return order
    }
    return undefined
  }
  return undefined
}

/** The source-ordered own keys; unknown/missed keys are appended so no field
 * can be lost. Duplicate raw keys keep the first display position. */
function orderedKeys(
  record: Record<string, unknown>,
  sourceOrder: readonly string[] | undefined,
): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const key of sourceOrder ?? Object.keys(record)) {
    if (seen.has(key) || !Object.prototype.hasOwnProperty.call(record, key)) continue
    seen.add(key)
    keys.push(key)
  }
  for (const key of Object.keys(record)) {
    if (seen.has(key)) continue
    seen.add(key)
    keys.push(key)
  }
  return keys
}

/**
 * The unknown-field projection. A null-prototype accumulator keeps an
 * untrusted `__proto__` key an ordinary own property, so it cannot mutate the
 * accumulator or disappear from the display.
 */
function otherSections(
  record: Record<string, unknown>,
  consumed: ReadonlySet<string>,
  sourceOrder: readonly string[] | undefined,
): readonly ApprovalArgumentSection[] {
  const keys = orderedKeys(record, sourceOrder).filter(key => !consumed.has(key))
  if (keys.length === 0) return []
  const lines = ['{']
  keys.forEach((key, keyIndex) => {
    const valueLines = JSON.stringify(record[key], null, 2).split('\n')
    lines.push(`  ${JSON.stringify(key)}: ${valueLines[0]}`)
    for (let lineIndex = 1; lineIndex < valueLines.length; lineIndex += 1) {
      lines.push(`  ${valueLines[lineIndex]}`)
    }
    if (keyIndex < keys.length - 1) lines[lines.length - 1] += ','
  })
  lines.push('}')
  return [{ heading: OTHER_ARGUMENTS, text: lines.join('\n') }]
}

/**
 * The generic JSON-object view: one readable `key: value` line per field,
 * nested objects/arrays serialized with two-space indentation. Scalars keep
 * their JSON spelling (including `false`, `0`, `null` and the empty string);
 * an empty object is stated as such instead of painting an empty body.
 */
function genericSections(
  record: Record<string, unknown>,
  sourceOrder: readonly string[] | undefined,
): readonly ApprovalArgumentSection[] {
  const keys = orderedKeys(record, sourceOrder)
  if (keys.length === 0) return [{ heading: ARGUMENTS, text: '(empty object)' }]
  const lines: string[] = []
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') {
      lines.push(`${key}: ${value}`)
    } else if (value !== null && typeof value === 'object') {
      lines.push(`${key}: ${JSON.stringify(value, null, 2)}`)
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`)
    }
  }
  return [{ heading: ARGUMENTS, text: lines.join('\n') }]
}

interface Draft {
  readonly sections: ApprovalArgumentSection[]
  readonly consumed: Set<string>
}

/** `edit`: replace `old_string` with `new_string` in `file_path`. */
function editDraft(record: Record<string, unknown>): Draft | undefined {
  const filePath = record.file_path
  const oldString = record.old_string
  const newString = record.new_string
  const replaceAll = record.replace_all
  if (typeof filePath !== 'string' || typeof oldString !== 'string' || typeof newString !== 'string') return undefined
  if (replaceAll !== undefined && typeof replaceAll !== 'boolean') return undefined
  const sections: ApprovalArgumentSection[] = [
    { heading: 'Action', text: 'Replace text' },
    { heading: 'Target', text: filePath },
    { heading: 'Before', text: oldString },
    { heading: 'After', text: newString },
  ]
  if (typeof replaceAll === 'boolean') {
    sections.push({ heading: 'Replace all', text: replaceAll ? 'Yes' : 'No' })
  }
  return { sections, consumed: new Set(['file_path', 'old_string', 'new_string', 'replace_all']) }
}

/** `str_replace_editor`: the four official commands, each with its own fields. */
function strReplaceEditorDraft(record: Record<string, unknown>): Draft | undefined {
  const command = record.command
  const path = record.path
  if (typeof command !== 'string' || typeof path !== 'string') return undefined
  if (command === 'view') {
    return {
      sections: [
        { heading: 'Action', text: 'View file' },
        { heading: 'Target', text: path },
      ],
      consumed: new Set(['command', 'path']),
    }
  }
  if (command === 'create') {
    if (typeof record.file_text !== 'string') return undefined
    return {
      sections: [
        { heading: 'Action', text: 'Create file' },
        { heading: 'Target', text: path },
        { heading: 'New content', text: record.file_text },
      ],
      consumed: new Set(['command', 'path', 'file_text']),
    }
  }
  if (command === 'str_replace') {
    if (typeof record.old_str !== 'string' || record.old_str === '') return undefined
    const newString = record.new_str
    if (newString !== undefined && typeof newString !== 'string') return undefined
    return {
      sections: [
        { heading: 'Action', text: 'Replace text' },
        { heading: 'Target', text: path },
        { heading: 'Before', text: record.old_str },
        { heading: 'After', text: newString ?? '' },
      ],
      consumed: new Set(['command', 'path', 'old_str', 'new_str']),
    }
  }
  if (command === 'insert') {
    const insertLine = record.insert_line
    if (!Number.isInteger(insertLine) || typeof record.new_str !== 'string') return undefined
    return {
      sections: [
        { heading: 'Action', text: `Insert after line ${String(insertLine)}` },
        { heading: 'Target', text: path },
        { heading: 'Inserted text', text: record.new_str },
      ],
      consumed: new Set(['command', 'path', 'insert_line', 'new_str']),
    }
  }
  return undefined
}

/** `write`: write `content` to `file_path` (never claims a new file). */
function writeDraft(record: Record<string, unknown>): Draft | undefined {
  if (typeof record.file_path !== 'string' || typeof record.content !== 'string') return undefined
  return {
    sections: [
      { heading: 'Action', text: 'Write file' },
      { heading: 'Target', text: record.file_path },
      { heading: 'New content', text: record.content },
    ],
    consumed: new Set(['file_path', 'content']),
  }
}

/** `bash` / `pwsh`: run the full (multiline) command string. */
function shellDraft(record: Record<string, unknown>): Draft | undefined {
  if (typeof record.command !== 'string') return undefined
  return {
    sections: [
      { heading: 'Action', text: 'Run command' },
      { heading: 'Command', text: record.command },
    ],
    consumed: new Set(['command']),
  }
}

/**
 * Project the raw approval arguments into display sections.
 * @param toolName - the official tool identity from the approval request.
 * @param rawArguments - the exact received argument bytes/text.
 * @returns ordered display sections; never the approval outcome or danger fact.
 */
export function approvalArgumentSections(
  toolName: string,
  rawArguments: string,
): readonly ApprovalArgumentSection[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    // Only the external input parser is guarded: malformed/absent JSON is a
    // legitimate raw display, not a renderer failure to hide.
    return rawSections(rawArguments)
  }
  if (!isJsonObject(parsed)) return rawSections(rawArguments)
  const record = parsed
  const sourceOrder = topLevelKeyOrder(rawArguments)
  let draft: Draft | undefined
  switch (toolName) {
    case 'edit': draft = editDraft(record); break
    case 'str_replace_editor': draft = strReplaceEditorDraft(record); break
    case 'write': draft = writeDraft(record); break
    case 'bash':
    case 'pwsh': draft = shellDraft(record); break
    default: break
  }
  if (draft === undefined) return genericSections(record, sourceOrder)
  return [...draft.sections, ...otherSections(record, draft.consumed, sourceOrder)]
}
