/**
 * The Client-derived tool presenter (M3-4 PR4 §5/§D8): the Remote branch's
 * presentation bridge, derived ENTIRELY from raw call args + result
 * content/meta/error facts. It never consults a Host tool registry
 * (`ctx.tools.get`), never invokes `presentCall`/`presentResult`, and never
 * ships a callback over the wire.
 *
 * Coverage (plan §5.3 — adapt the EXISTING pure helpers, never duplicate
 * formatting):
 * - edit/write/apply_patch-style diff cards — the `DiffCallView` is derived
 *   from the call arguments (an edit's old/new strings; a create's oldText
 *   is null), exactly the contract the Host-side presenter declares;
 * - bash/pwsh/terminal execute cards — `TerminalCallView` from the command
 *   and optional description/cwd arguments;
 * - everything else stays with the existing Client-side generic fallbacks
 *   (toolCardHeader/compactToolPresentation/read-envelope parsers), which
 *   the render layer already consults when the presenter returns
 *   `undefined` — the SAME precedence the plan freezes:
 *   extension renderer -> Client specialized -> static known -> generic.
 *
 * @module @xmoon76/dsh-pi-tui/tui/transcript/client-tool-presenter
 */

import type {
  DiffCallView,
  FileDiff,
  ReadFileLine,
  TerminalCallView,
  ToolCallView,
  ToolResultView,
} from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolPresenter } from './tool-presentation.ts'

/** Parse one tool-call args JSON payload (undefined when malformed). */
function parseArgs(argsRaw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

const stringOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** The edit-family diff view derived from old/new string arguments. */
function editDiffView(name: string, args: Record<string, unknown>): DiffCallView | undefined {
  const path = stringOf(args.path) ?? stringOf(args.file_path) ?? stringOf(args.fileName)
  if (path === undefined) return undefined
  const newText = stringOf(args.new_string) ?? stringOf(args.content) ?? stringOf(args.newText)
  if (newText === undefined) return undefined
  // An edit carries the prior text; a write/create has none (null), exactly
  // the Host contract's distinction.
  const old = stringOf(args.old_string) ?? stringOf(args.oldText)
  return {
    card: 'diff',
    title: `${name === 'write' ? 'Write' : 'Edit'} ${path}`,
    diffs: [{ path, oldText: old ?? null, newText }],
    locations: [{ path }],
  }
}

/** The apply-patch style multi-file diff view (a patch text argument). */
function patchDiffView(args: Record<string, unknown>): DiffCallView | undefined {
  const patch = stringOf(args.patch)
  if (patch === undefined) return undefined
  // A bounded path extraction from unified-diff headers (the card needs one
  // entry per file the patch touches; the diff body itself stays in newText).
  const paths = [...patch.matchAll(/^--- a\/(\S+)$/gm)].map(match => match[1]!)
  if (paths.length === 0) return undefined
  return {
    card: 'diff',
    title: `Apply patch (${paths.length} ${paths.length === 1 ? 'file' : 'files'})`,
    diffs: paths.map(path => ({ path, oldText: null, newText: patch })),
    locations: paths.map(path => ({ path })),
  }
}

/** The terminal execute view derived from the command arguments. */
function terminalView(args: Record<string, unknown>): TerminalCallView | undefined {
  const command = stringOf(args.command) ?? stringOf(args.cmd)
  if (command === undefined) return undefined
  return {
    card: 'terminal',
    title: command,
    ...stringOf(args.description) === undefined ? {} : { description: stringOf(args.description) },
    ...stringOf(args.cwd) === undefined ? {} : { cwd: stringOf(args.cwd) },
  }
}

/** One read line, narrowed the way `dsh-tool-fs`'s own `isFileTextLine` does. */
function isFileTextLine(value: unknown): value is ReadFileLine {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { number, text } = value as { number?: unknown; text?: unknown }
  return typeof number === 'number' && Number.isInteger(number) && number >= 1 && typeof text === 'string'
}

/**
 * Narrow the read metadata EXACTLY as the fs tool's own `readMetaFromMeta`
 * does: integer window bounds, line numbers strictly increasing from the
 * offset and inside the file, and a string-or-absent language hint. A shape
 * the tool would reject must not become a view here.
 */
function readMetaOf(record: Record<string, unknown>): { path: string; offset: number; lines: ReadFileLine[]; totalLines: number; lang?: string } | undefined {
  const { path, offset, lines, totalLines, lang } = record
  if (typeof path !== 'string' || typeof offset !== 'number' || typeof totalLines !== 'number') return undefined
  if (!Number.isInteger(offset) || offset < 1) return undefined
  if (!Number.isInteger(totalLines) || totalLines < 0) return undefined
  if (!Array.isArray(lines) || !lines.every(isFileTextLine)) return undefined
  if (lang !== undefined && typeof lang !== 'string') return undefined
  let previous = offset - 1
  for (const { number } of lines) {
    if (number <= previous || number > totalLines) return undefined
    previous = number
  }
  return { path, offset, lines, totalLines, ...lang === undefined ? {} : { lang } }
}

/**
 * Narrow the diff metadata EXACTLY as the fs tool's own `diffsFromMeta` does:
 * a NON-EMPTY array whose every entry is a whole `FileDiff`. An empty or
 * malformed list is "no diffs", which each tool then handles its own way.
 */
function diffsOf(record: Record<string, unknown>): FileDiff[] | undefined {
  const diffs = record['diffs']
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined
  const narrowed: FileDiff[] = []
  for (const diff of diffs) {
    if (typeof diff !== 'object' || diff === null || Array.isArray(diff)) return undefined
    const entry = diff as { path?: unknown; oldText?: unknown; newText?: unknown }
    if (typeof entry.path !== 'string') return undefined
    if (entry.oldText !== null && typeof entry.oldText !== 'string') return undefined
    if (typeof entry.newText !== 'string') return undefined
    narrowed.push({ path: entry.path, oldText: entry.oldText, newText: entry.newText })
  }
  return narrowed
}

/**
 * The create-time diff a WRITE-shaped metadata record implies, or undefined.
 *
 * Unlike the other branches, this one does not REPORT what the metadata says —
 * it FABRICATES a `newText` from the call arguments. So it must demand the
 * tool's own write contract rather than a mere field collision: the projected
 * `operation` must be one of the two values `dsh-tool-fs` defines — NOT a
 * narrower `create`, because an empty list has TWO origins: a create (no
 * before-image) and an overwrite that wrote the identical content. Its `diffs`
 * must be the empty list, and the call must carry the string `content` the
 * diff is built from. A third-party tool that happens to send `operation` +
 * `path` + `content` matches none of that and gets no view.
 */
function writeCreateDiffs(
  record: Record<string, unknown>,
  args: Record<string, unknown> | undefined,
): FileDiff[] | undefined {
  // The write projection defines exactly these two values. An empty list can
  // come from EITHER: a create has no before-image, and an overwrite that
  // wrote the identical content produces no hunks. Anything else (another
  // tool's marker, a `delete`) is refused here rather than interpreted.
  const operation = record['operation']
  if (operation !== 'create' && operation !== 'update') return undefined
  const diffs = record['diffs']
  if (!Array.isArray(diffs) || diffs.length !== 0) return undefined
  const content = args?.['content']
  if (typeof content !== 'string') return undefined
  return [{ path: record['path'] as string, oldText: null, newText: content }]
}

/**
 * The settled-result view derived from the TOOL-AUTHORED result metadata,
 * mirroring the two Host `presentResult` implementations the Client cannot
 * call:
 *
 * - the DIFF shape mirrors the mutation tools. `dsh-tool-fs` records
 *   `{ operation, path, diffs }` for a write and `{ path, diffs }` for an
 *   edit, and deliberately emits `diffs: []` when the write CREATED the file
 *   (`before === null`). Its write presenter then falls back to a diff built
 *   from the call arguments, while its edit presenter declines. The fallback
 *   is keyed on the tool-authored `operation` field — NOT on the tool name,
 *   which a plugin can shadow.
 * - the READ shape mirrors the read tool: the metadata must survive the same
 *   window validation, and the result content must be exactly one
 *   `<type>file</type>` envelope. The envelope body comes back as `content`,
 *   the degradation path the SDK documents for a UI without a rich read card.
 *
 * A shape the Host presenter would reject must not become a view here either:
 * both branches have to agree, and the settled card renders whichever view
 * comes first.
 */
function metaPathView(
  meta: unknown,
  content: readonly ContentBlock[],
  isError: boolean,
  args: Record<string, unknown> | undefined,
): ToolResultView | undefined {
  // The tool's own Host `presentResult` returns no view for a FAILED call.
  if (isError) return undefined
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const record = meta as Record<string, unknown>
  const path = record['path']
  if (typeof path !== 'string' || path === '') return undefined

  // The result content must be the ONE text block the view describes.
  const only = content.length === 1 ? content[0] : undefined
  if (only === undefined || only.type !== 'text') return undefined
  const text = only.text

  const diffs = diffsOf(record)
  if (diffs !== undefined) {
    // The diff view describes the files the call CHANGED; the result content
    // must be the one block those changes are reported in.
    if (text.trim() === '') return undefined
    return { card: 'diff', diffs }
  }
  // A write that CREATED the file records `diffs: []`. The tool's own write
  // presenter rebuilds the diff from its arguments.
  const created = writeCreateDiffs(record, args)
  if (created !== undefined) return { card: 'diff', diffs: created }

  const readMeta = readMetaOf(record)
  if (readMeta === undefined) return undefined
  const envelope = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(text)
  if (envelope === null) return undefined
  return {
    card: 'read',
    path: readMeta.path,
    offset: readMeta.offset,
    lines: readMeta.lines,
    totalLines: readMeta.totalLines,
    ...readMeta.lang === undefined ? {} : { lang: readMeta.lang },
    content: [{ type: 'text', text: envelope[1] ?? '' }],
  }
}

/**
 * Build the Client-derived presenter (Remote branch). The `result` half reads
 * ONLY the tool-authored result metadata, so a Remote read row can reach the
 * same path semantics as a Direct one without a Host field and without
 * inferring by tool name. Every other settled-result rendering the TUI needs
 * already has a Client-side derivation (read envelopes, result text lines,
 * the compact summaries), so a Host result view is never required — an
 * absent, foreign or inconsistent metadata yields `undefined` and keeps
 * those paths authoritative.
 */
export function createClientToolPresenter(): ToolPresenter {
  return {
    // This bridge NEVER consults a registry: its call views are DERIVED from
    // the tool name and the raw arguments, so they repeat a name-keyed guess
    // and prove nothing about what the string IS. A plugin may also register
    // its own tool under a built-in name, so the name cannot even identify
    // the built-in. A consumer that needs a PROVEN kind must not read these
    // views as proof.
    callViewIsToolAuthored: false,
    call(name: string, argsRaw: string): ToolCallView | undefined {
      const args = parseArgs(argsRaw)
      if (args === undefined) return undefined
      if (name === 'edit' || name === 'write') return editDiffView(name, args)
      if (name === 'apply_patch') return patchDiffView(args)
      if (name === 'bash' || name === 'pwsh') return terminalView(args)
      return undefined
    },
    result(_name: string, argsRaw: string, result: { readonly content: readonly ContentBlock[]; readonly isError: boolean; readonly meta?: unknown }): ToolResultView | undefined {
      // The Direct bridge parses the args JSON BEFORE consulting the tool, so
      // a row whose args are not a JSON object (a merged read group's literal
      // `'2 files'`) never reaches a Host `presentResult` at all. The Client
      // derivation must apply the SAME gate, or the two branches would produce
      // different views for the same row. The parsed args are also what a
      // write's create-fallback diff is rebuilt from.
      const args = parseArgs(argsRaw)
      if (args === undefined) return undefined
      return metaPathView(result.meta, result.content, result.isError, args)
    },
  }
}
