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
  // A legal EMPTY new text (a write of `''`, or an edit that deletes by
  // replacing with `''`) is a real value, not an absent one: accept `''` here
  // (unlike `stringOf`, which rejects it) so an empty-file write or a delete
  // edit still forms its diff. The `new_string ?? content ?? newText` priority
  // is unchanged; only the empty-string acceptance differs. The path and old
  // text keep the `stringOf` rules (an empty path/old is still absent).
  const newText = typeof args.new_string === 'string' ? args.new_string
    : typeof args.content === 'string' ? args.content
    : typeof args.newText === 'string' ? args.newText
    : undefined
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

/** The FIRST markdown heading of a plan body (the official exit tool's own
 * title rule), or undefined when the body has none. */
function planHeading(plan: string): string | undefined {
  return /^#{1,6}\s+(.+?)\s*$/m.exec(plan)?.[1]
}

/**
 * The Client-local presentation-only view of an official `exit_plan_mode`
 * call (the Remote branch's parity with the Host `presentCall`): the plan
 * body rides the generic card's content blocks exactly the way the official
 * presenter emits them. The MINIMUM legitimate shape is the official tool's
 * own argument contract — `args` a JSON object whose `plan` is a non-empty
 * string starting with a `#` heading; anything else keeps the generic tool
 * card (never a guessed plan body). This mirrors presentation ONLY: it is
 * not an approval authority and never reads or writes plan mode.
 */
function planReviewView(args: Record<string, unknown>): ToolCallView | undefined {
  const plan = stringOf(args.plan)
  if (plan === undefined) return undefined
  if (!/^#\s+\S/.test(plan.trim())) return undefined
  return {
    card: 'generic',
    title: planHeading(plan) ?? 'Plan',
    kind: 'other',
    content: [{ type: 'text', text: plan }],
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
 * The settled-result view derived from the call NAME plus the tool-authored
 * result metadata, mirroring the dsh-web Client tool cards (R11 Web parity).
 * This is NAME-SCOPED Web-like card recognition + a generic applied diff — it
 * is NOT tool-author identity authentication. A wire name selects the card the
 * way dsh-web's keyed `renderSlot('tool.call.toolview', …, { entryKey: toolName,
 * fallback: GenericToolCard })` does; it never proves which Host Tool Definition
 * actually ran (a plugin may register a tool under a built-in name). The
 * recognized shapes, in the fixed precedence dsh-web applies:
 *
 * - a generic APPLIED DIFF: ANY tool name whose result metadata carries a valid
 *   NON-EMPTY `diffs` list renders those recorded hunks — dsh-web's
 *   `GenericToolCard` calls `diffCardModel` the same way. There is NO
 *   text-content gate: an applied diff is REPORTED by the metadata, so empty or
 *   non-text result content still shows the recorded hunks (the earlier single
 *   non-empty text requirement was a divergence from Web, now removed).
 * - a WRITE-with-result-path diff (branch B): ONLY `name === 'write'`, when its
 *   SUCCESS result declares a non-empty `meta.path` and carries no valid
 *   non-empty `diffs`, rebuilds the diff from the call `content` with its PATH
 *   taken from the RESULT metadata — the official `write.presentResult`
 *   fallback. Because the path is a tool-authored result fact, it may prove
 *   `targetKind:path`. A write with NO result path yields NO Result View (the
 *   args-derived diff is shown by the `call()` fallback), so an unproven
 *   `args.file_path` never becomes a synthetic result path. Keyed on the write
 *   contract by NAME (non-empty `file_path`, string `content`, `''` allowed),
 *   never on a metadata `operation` marker; `edit` gets no such fabrication.
 * - a READ card: ONLY `name === 'read'` with a valid read CALL (a non-empty
 *   `file_path`, optional `offset`/`limit` as positive integers — dsh-web's
 *   `validReadCall`), a valid read window metadata, and exactly one
 *   `<type>file</type>` envelope (dsh-web's `read-card-model`).
 *
 * A FAILED call yields no view (the tool's own `presentResult` returns none).
 * Anything unrecognized is `undefined`, keeping the existing generic result
 * renderers authoritative and preserving the raw result/error. This reader
 * decodes by NAME + shape and never consults a Host registry. A third-party
 * tool that shadows the `read`/`write` name can still match these rows — the
 * accepted name-based bound, not a source-identity claim.
 */
function metaPathView(
  name: string,
  meta: unknown,
  content: readonly ContentBlock[],
  isError: boolean,
  args: Record<string, unknown> | undefined,
): ToolResultView | undefined {
  // The tool's own Host `presentResult` returns no view for a FAILED call.
  if (isError) return undefined
  const record = typeof meta === 'object' && meta !== null && !Array.isArray(meta)
    ? meta as Record<string, unknown>
    : undefined

  // A generic applied diff (ANY tool name): a valid NON-EMPTY `diffs` list in
  // the result metadata, exactly as the tool's own `diffsFromMeta` narrows it.
  // The hunks are reported by the metadata, so no text-content gate applies
  // (Web `diffCardModel` parity).
  const diffs = record === undefined ? undefined : diffsOf(record)
  if (diffs !== undefined) return { card: 'diff', diffs }

  // Branch B — "write with result path": a SUCCESS `write` whose RESULT
  // declares a non-empty `meta.path` rebuilds its diff from the call `content`
  // but takes its PATH from the RESULT metadata (a tool-authored fact, so it
  // may prove `targetKind:path` via the exact/relativized match). This is the
  // official `write.presentResult` fallback, keyed on the write contract by
  // NAME (a non-empty `file_path` and a string `content` argument, `''`
  // allowed), never on a metadata `operation`/`diffs` marker a foreign tool
  // could emit. A write with NO result path yields NO Result View here — the
  // args-derived diff is shown by the `call()`/renderToolBody fallback instead,
  // so an unproven `args.file_path` never becomes a synthetic result path. The
  // result path wins over a different `args.file_path` (`pathFromMeta(meta)`).
  if (name === 'write') {
    const filePath = args?.['file_path']
    const written = args?.['content']
    const metaPath = record?.['path']
    if (typeof filePath === 'string' && filePath.trim() !== ''
        && typeof written === 'string'
        && typeof metaPath === 'string' && metaPath !== '') {
      return { card: 'diff', diffs: [{ path: metaPath, oldText: null, newText: written }] }
    }
  }

  // The read card (ONLY `read`): a valid read CALL first (dsh-web
  // `validReadCall`), then the read window metadata, then exactly one file
  // envelope. A merged read group's literal `'2 files'` args never parse to an
  // object, so it is refused upstream; a `read` with a missing/blank
  // `file_path` or a non-positive `offset`/`limit` is refused here.
  if (name === 'read') {
    const filePath = args?.['file_path']
    if (typeof filePath !== 'string' || filePath.trim() === '') return undefined
    const offset = args?.['offset']
    if (offset !== undefined && (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 1)) return undefined
    const limit = args?.['limit']
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) return undefined
    const readMeta = record === undefined ? undefined : readMetaOf(record)
    if (readMeta === undefined) return undefined
    // The result content must be the ONE text block the read tool writes.
    const only = content.length === 1 ? content[0] : undefined
    if (only === undefined || only.type !== 'text') return undefined
    const envelope = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(only.text)
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

  return undefined
}

/**
 * Build the Client-derived presenter (Remote branch). The `result` half reads
 * the wire NAME plus the tool-authored result metadata — a bounded, name-scoped
 * projection that lets a Remote `read`/`write` row reach the same card a Direct
 * one shows, without a Host field and without a Host registry lookup. This is
 * Web-like card RECOGNITION (dsh-web keys its Client slots by wire name too),
 * not tool-author authentication: a plugin that shadows `read`/`write` can
 * still match. Every other settled-result rendering the TUI needs already has
 * a Client-side derivation (read envelopes, result text lines, the compact
 * summaries), so a Host result view is never required — an absent, foreign or
 * inconsistent metadata yields `undefined` and keeps those paths authoritative.
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
      if (name === 'exit_plan_mode') return planReviewView(args)
      return undefined
    },
    result(name: string, argsRaw: string, result: { readonly content: readonly ContentBlock[]; readonly isError: boolean; readonly meta?: unknown }): ToolResultView | undefined {
      // The Direct bridge parses the args JSON BEFORE consulting the tool, so
      // a row whose args are not a JSON object (a merged read group's literal
      // `'2 files'`) never reaches a Host `presentResult` at all. The Client
      // derivation must apply the SAME gate, or the two branches would produce
      // different views for the same row. The parsed args are also what a
      // write's fallback diff is rebuilt from and what a read's `validReadCall`
      // checks.
      const args = parseArgs(argsRaw)
      if (args === undefined) return undefined
      return metaPathView(name, result.meta, result.content, result.isError, args)
    },
  }
}
