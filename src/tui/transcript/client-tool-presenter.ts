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
 * The metadata is narrowed defensively: an absent, malformed or foreign
 * payload yields no view, and the row keeps the plain generic card.
 */
function metaPathView(meta: unknown): ToolResultView | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const record = meta as Record<string, unknown>
  const path = record['path']
  if (typeof path !== 'string' || path === '') return undefined
  const diffs = record['diffs']
  if (Array.isArray(diffs)) {
    const paths = diffs
      .filter((diff): diff is { path: string } =>
        typeof diff === 'object' && diff !== null
        && typeof (diff as { path?: unknown }).path === 'string')
      .map(diff => diff.path)
    if (paths.length === 0) return undefined
    return { card: 'diff', diffs: diffs as FileDiff[] }
  }
  // The read shape: the tool states the path it read and the window it took.
  const offset = record['offset']
  const totalLines = record['totalLines']
  if (typeof offset !== 'number' || typeof totalLines !== 'number') return undefined
  const lines = record['lines']
  const readLines = Array.isArray(lines)
    ? lines.filter((line): line is ReadFileLine =>
      typeof line === 'object' && line !== null
      && typeof (line as { number?: unknown }).number === 'number'
      && typeof (line as { text?: unknown }).text === 'string')
    : []
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
 * absent or foreign metadata yields `undefined` and keeps those paths
 * authoritative.
 */
export function createClientToolPresenter(): ToolPresenter {
  return {
    call(name: string, argsRaw: string): ToolCallView | undefined {
      const args = parseArgs(argsRaw)
      if (args === undefined) return undefined
      if (name === 'edit' || name === 'write') return editDiffView(name, args)
      if (name === 'apply_patch') return patchDiffView(args)
      if (name === 'bash' || name === 'pwsh') return terminalView(args)
      return undefined
    },
    result(_name: string, _argsRaw: string, result: { readonly meta?: unknown }): ToolResultView | undefined {
      return metaPathView(result.meta)
    },
  }
}
