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

/**
 * The read-family result view derived from the TOOL-AUTHORED result metadata.
 *
 * The `tool/result` event carries the tool's own `presentationMeta` — a JSON
 * payload the TOOL wrote about ITS OWN call (`dsh-tool-fs` declares
 * `{ path, offset, lines, totalLines }`; its write/edit declare
 * `{ path, diffs }`). Unlike the raw args, that payload is not a guess: it is
 * the tool's own statement about what it operated on, and it reaches the
 * Client over the existing session event — no new Host field, no wire
 * change.
 *
 * This is what lets the Remote branch reach the SAME path semantics as the
 * Direct branch WITHOUT inferring by tool name. Inferring by name is unsafe:
 * a plugin may register its own tool under a built-in's name, and the
 * registry lets a scoped registration SHADOW a global one — so a name-keyed
 * guess would read a plugin's `url` parameter as a path.
 *
 * The Client derivation must stay in STEP with the tool's own Host
 * `presentResult`, which is the authority for the same view. That presenter
 * guards TWO things beyond the metadata itself:
 *
 * - the RESULT CONTENT must be the single block the view describes (a merged
 *   read group carries TWO envelopes and INHERITS the first read's metadata,
 *   so a metadata-only derivation would describe one file while the card shows
 *   two); and
 * - every field the view exposes must be narrowed, never cast (a malformed
 *   `diffs` entry would otherwise reach the diff renderer unvalidated).
 *
 * A view the Host presenter would NOT produce must not be produced here
 * either: the two branches have to agree, and the settled card is rendered
 * from whichever view comes first.
 */
function metaPathView(meta: unknown, content: readonly ContentBlock[], isError: boolean): ToolResultView | undefined {
  // The tool's own Host `presentResult` returns no view for a FAILED call; the
  // Client derivation must agree, or the two branches would render a failed
  // call differently.
  if (isError) return undefined
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const record = meta as Record<string, unknown>
  const path = record['path']
  if (typeof path !== 'string' || path === '') return undefined

  // The result content must be the ONE text block the view describes.
  const only = content.length === 1 ? content[0] : undefined
  if (only === undefined || only.type !== 'text') return undefined
  const text = only.text

  const diffs = record['diffs']
  if (Array.isArray(diffs)) {
    // Narrow EVERY entry the way the tool's own `diffsFromMeta` does: a path
    // alone is not a `FileDiff` (it also carries `oldText` and `newText`),
    // and an unvalidated entry would crash the diff renderer.
    if (diffs.length === 0) return undefined
    const narrowed: FileDiff[] = []
    for (const diff of diffs) {
      if (typeof diff !== 'object' || diff === null || Array.isArray(diff)) return undefined
      const entry = diff as { path?: unknown; oldText?: unknown; newText?: unknown }
      if (typeof entry.path !== 'string') return undefined
      if (entry.oldText !== null && typeof entry.oldText !== 'string') return undefined
      if (typeof entry.newText !== 'string') return undefined
      narrowed.push({ path: entry.path, oldText: entry.oldText, newText: entry.newText })
    }
    // The diff view describes the files the call CHANGED; the result content
    // must be the one block those changes are reported in.
    if (text.trim() === '') return undefined
    return { card: 'diff', diffs: narrowed }
  }

  // The read shape: the tool states the path it read and the window it took.
  // The result content must be EXACTLY ONE read envelope for that path, in the
  // SAME shape the tool's own Host `presentResult` accepts. A merged group
  // (two envelopes, inherited metadata) does not qualify, and the card falls
  // back to the existing envelope rendering.
  const envelope = /^<path>([^\n]*)<\/path>\n<type>[^<]*<\/type>\n<content>([\s\S]*)\n<\/content>$/u.exec(text)
  if (envelope === null) return undefined
  if (envelope[1] !== path) return undefined

  const offset = record['offset']
  const totalLines = record['totalLines']
  if (typeof offset !== 'number' || typeof totalLines !== 'number') return undefined
  const lines = record['lines']
  if (!Array.isArray(lines)) return undefined
  const readLines: ReadFileLine[] = []
  for (const line of lines) {
    if (typeof line !== 'object' || line === null) return undefined
    const entry = line as { number?: unknown; text?: unknown }
    if (typeof entry.number !== 'number' || typeof entry.text !== 'string') return undefined
    readLines.push({ number: entry.number, text: entry.text })
  }
  const lang = record['lang']
  return {
    card: 'read',
    path,
    offset,
    lines: readLines,
    totalLines,
    ...(typeof lang === 'string' ? { lang } : {}),
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
      // different views for the same row.
      if (parseArgs(argsRaw) === undefined) return undefined
      return metaPathView(result.meta, result.content, result.isError)
    },
  }
}
