/**
 * Context-injection presentation for the TUI: the same provenance projection
 * the Web derives in @deepseek-ai/dsh-client-runtime's contextProvenance, so
 * an injected-context row names its producer the same way a Web row does
 * (AGENTS.md, @deepseek-ai/dsh-system-prompt, skill-catalog, ...). Pure and
 * tolerant: a source arrives as opaque JSON (MessageSource is merge-
 * extensible), so every unreadable shape degrades to `inject` with whatever
 * name the record still carries.
 * @module @xmoon76/dsh-pi-tui/context
 */

/** One durable source narrowed to the readable-record shape; null for anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** A record field read as a non-empty string, or null. */
function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Distinct non-empty `field` values of an array-valued source member, in first-seen order. */
function collect(source: Record<string, unknown>, member: string, field: string): string[] {
  const list = source[member]
  if (!Array.isArray(list)) return []
  const seen: string[] = []
  for (const entry of list) {
    const record = asRecord(entry)
    const value = record === null ? null : readString(record, field)
    if (value !== null && !seen.includes(value)) seen.push(value)
  }
  return seen
}

/** A collected name list rendered as one label; null when the list is empty. */
function joined(names: readonly string[]): string | null {
  return names.length > 0 ? names.join(', ') : null
}

/** The role and producer name to present for one logged context source. */
export interface ContextProvenance {
  /** recall for a cross-session reference; inject for everything else. */
  role: 'inject' | 'recall'
  /** The producer name (file path, plugin name, skill name); null when unreadable. */
  label: string | null
}

/**
 * Project one durable message source onto its transcript role and producer
 * name, exactly like the Web's contextProvenance: agent-instructions name
 * their changed file paths, plugins their plugin id, skill invocations their
 * skill name, session references their recalled labels; unknown kinds carry
 * the kind itself.
 * @param source - the logged user/message source, exactly as recorded.
 * @returns the role and producer name to present for this context.
 */
export function contextProvenance(source: unknown): ContextProvenance {
  const record = asRecord(source)
  const kind = record === null ? null : readString(record, 'kind')
  if (record === null || kind === null) return { role: 'inject', label: null }
  switch (kind) {
    case 'session-reference':
      return { role: 'recall', label: joined(collect(record, 'references', 'label')) ?? kind }
    case 'agent-instructions':
      return { role: 'inject', label: joined(collect(record, 'changes', 'path')) ?? kind }
    case 'plugin':
      return { role: 'inject', label: readString(record, 'plugin') ?? kind }
    case 'skill-invocation':
      return { role: 'inject', label: readString(record, 'name') ?? kind }
    default:
      return { role: 'inject', label: kind }
  }
}

/**
 * The card-header emoji for one context injection, keyed by source kind so a
 * reader can tell an instruction file from a skill catalog or a recalled
 * session at a glance (the Web renders one browse icon for all of them).
 * @param source - the logged user/message source.
 * @returns the emoji for this injection.
 */
export function contextEmoji(source: unknown): string {
  const record = asRecord(source)
  const kind = record === null ? null : readString(record, 'kind')
  switch (kind) {
    case 'agent-instructions': return '📄'
    case 'skill-invocation': return '📚'
    case 'plugin': {
      // A notice is a one-off account; everything else is payload.
      return readString(record ?? {}, 'form') === 'notice' ? '📌' : '📦'
    }
    case 'session-reference': return '🕘'
    default: return '📎'
  }
}

export function contextSummary(source: unknown): string | null {
  const record = asRecord(source)
  if (record === null) return null
  const summary = record['summary']
  return typeof summary === 'string' && summary !== '' ? summary : null
}