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
  TerminalCallView,
  ToolCallView,
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
 * Build the Client-derived presenter (Remote branch). The `result` half is
 * intentionally `undefined`-returning: every settled-result rendering the
 * TUI needs already has a Client-side derivation (read envelopes, result
 * text lines, the compact summaries), so a Host result view is never
 * required — returning undefined keeps those existing paths authoritative.
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
    result(): undefined {
      return undefined
    },
  }
}
