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

/**
 * The unknown-field projection. A null-prototype accumulator keeps an
 * untrusted `__proto__` key an ordinary own property, so it cannot mutate the
 * accumulator or disappear from the display.
 */
function otherSections(
  record: Record<string, unknown>,
  consumed: ReadonlySet<string>,
): readonly ApprovalArgumentSection[] {
  const rest = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!consumed.has(key)) rest[key] = record[key]
  }
  if (Object.keys(rest).length === 0) return []
  return [{ heading: OTHER_ARGUMENTS, text: JSON.stringify(rest, null, 2) }]
}

/**
 * The generic JSON-object view: one readable `key: value` line per field,
 * nested objects/arrays serialized with two-space indentation. Scalars keep
 * their JSON spelling (including `false`, `0`, `null` and the empty string);
 * an empty object is stated as such instead of painting an empty body.
 */
function genericSections(record: Record<string, unknown>): readonly ApprovalArgumentSection[] {
  const keys = Object.keys(record)
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
  let draft: Draft | undefined
  switch (toolName) {
    case 'edit': draft = editDraft(record); break
    case 'str_replace_editor': draft = strReplaceEditorDraft(record); break
    case 'write': draft = writeDraft(record); break
    case 'bash':
    case 'pwsh': draft = shellDraft(record); break
    default: break
  }
  if (draft === undefined) return genericSections(record)
  return [...draft.sections, ...otherSections(record, draft.consumed)]
}
