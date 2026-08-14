/**
 * Web-parity tool-card presentation for the TUI. The card header is the same
 * row model the Web derives in @deepseek-ai/dsh-client-ui-tool's tool-call
 * model (design titles per tool variant, SUMMARY_KEYS summaries, workspace-
 * relative paths), and the card body follows the tool-owned render intents
 * (presentCall/presentResult) exactly as the host apiproxy invokes them, so
 * a TUI card renders from the same source as a Web card. All pure: the
 * real tool registry is injected by the runner through toolPresenterFrom.
 * @module @xmoon76/dsh-pi-tui/present
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { ToolCallView, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'

/** Figma row titles per variant (design literals, not translatable copy). */
const VARIANT_TITLES = {
  search: 'Search',
  read: 'Read',
  bash: 'Bash',
  write: 'Write',
  edit: 'Edit',
  code: 'Code',
  others: 'Tool call',
} as const

/** One row variant in the Web's vocabulary. */
export type ToolVariant = keyof typeof VARIANT_TITLES

/**
 * Known tool name -> variant (the Web's TOOL_VARIANTS; cordis_define is
 * deliberately absent there too - a keyed toolview replaces the generic row).
 */
const TOOL_VARIANTS: Record<string, ToolVariant> = {
  bash: 'bash',
  pwsh: 'bash',
  read: 'read',
  web_fetch: 'read',
  web_search: 'search',
  grep: 'search',
  glob: 'search',
  write: 'write',
  edit: 'edit',
  run_code: 'code',
  cordis_package_inspect: 'read',
  cordis_runtime_inspect: 'read',
  cordis_run: 'others',
  cordis_stop: 'others',
  cordis_undefine: 'others',
}

/** Tool-owned titles that refine a generic row variant without replacing it. */
const TOOL_TITLES: Record<string, string> = {
  cordis_package_inspect: 'Inspect',
  cordis_runtime_inspect: 'Inspect',
  cordis_run: 'Run Cordis Plugin',
  cordis_stop: 'Stop Cordis Plugin',
  cordis_undefine: 'Remove Cordis Plugin',
  pwsh: 'Pwsh',
}

/**
 * TUI-local titles for synthetic cards the session log produces without a
 * registry definition (local `!` shell runs, workflow bookkeeping, failure
 * lines). Same refinement mechanism as TOOL_TITLES; without these the cards
 * would fall into the generic Tool call title and lose their identity.
 */
const TUI_TOOL_TITLES: Record<string, string> = {
  shell: 'Shell',
  subagent: 'Subagent',
  workflow: 'Workflow',
  'workflow-member': 'Workflow Agent',
  error: 'Error',
  interrupted: 'Interrupted',
}

/** Summary key preference per variant (args-derived). */
const SUMMARY_KEYS: Record<string, string[]> = {
  bash: ['description', 'command'],
  read: ['path', 'file_path', 'url'],
  search: ['query', 'pattern', 'url'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  code: ['description'],
  others: [],
}

/** The first line of a text (the Web's ReasoningRow summary for settled rows). */
export function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/** The last line of a text (the Web's running-reasoning summary). */
export function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

/**
 * Strip the workspace root from a workspace-rooted absolute path (display
 * only), exactly like the Web's relativizeToCwd: only the workspace-root
 * prefix is peeled, both `/` and `\` separators are handled, and a path
 * outside the root is returned unchanged.
 * @param text - the path to shorten.
 * @param cwd - session workspace root; absent or empty leaves the path unchanged.
 * @returns the path relative to the workspace root, or unchanged when it is not rooted there.
 */
export function relativizeToCwd(text: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return text
  const root = cwd.replace(/[/\\]+$/, '')
  if (text.startsWith(root + '/') || text.startsWith(root + '\\')) return text.slice(root.length + 1)
  return text
}

function parseArgs(argsRaw: string): unknown {
  try {
    return JSON.parse(argsRaw)
  } catch {
    return undefined
  }
}

function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** The summary key preference for one row variant, falling back to the first
 * string arg value, then to the raw args text (Web deriveSummary). */
function deriveSummary(variant: ToolVariant, argsRaw: string): string {
  const parsed = parseArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null) return firstLine(argsRaw)
  const args = parsed as Record<string, unknown>
  const picked = pickString(args, SUMMARY_KEYS[variant] ?? [])
  if (picked !== undefined) return firstLine(picked)
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value !== '') return firstLine(value)
  }
  return firstLine(argsRaw)
}

/** Classify a tool name into its row variant; unknown names are `others`. */
export function classifyTool(name: string): ToolVariant {
  return TOOL_VARIANTS[name] ?? 'others'
}

/** Emoji per exact tool name, for synthetic cards without a registry entry. */
const TOOL_EMOJIS: Record<string, string> = {
  shell: '🖥️',
  subagent: '🤖',
  workflow: '🧵',
  'workflow-member': '🤖',
  error: '❌',
  interrupted: '⏹️',
}

/** Emoji per row variant, applied to every registered tool of that class. */
const VARIANT_EMOJIS: Record<ToolVariant, string> = {
  read: '📖',
  search: '🔍',
  bash: '🖥️',
  write: '📝',
  edit: '✏️',
  code: '⚙️',
  others: '🛠️',
}

/**
 * The card header's leading emoji: exact-name entries first (synthetic
 * cards), then slash commands (a control action, not a tool), then the
 * tool's row-variant icon, then the generic wrench.
 * @param name - the tool name.
 */
export function toolEmoji(name: string): string {
  const exact = TOOL_EMOJIS[name]
  if (exact !== undefined) return exact
  if (name.startsWith('/')) return '🎛️'
  return VARIANT_EMOJIS[classifyTool(name)]
}

/** The rendered card header: design title plus the relativized args summary. */
export interface ToolCardHeader {
  /** Design title (e.g. Read, Search, Bash, a tool-owned title). */
  title: string
  /** The args-derived summary, workspace-relative; empty when there are no args. */
  summary: string
}

/** One parsed read envelope: the read tool's model-facing file shape. */
export interface ReadEnvelope {
  /** The path the read reported. */
  path: string
  /** Numbered content lines inside the `<content>` body. */
  lines: { number: number; text: string }[]
  /** Total file lines, when the envelope footer reports them. */
  totalLines?: number
}

/**
 * Parse the read tool's model-facing envelopes from a result: one
 * `<path>…</path> <type>…</type> <content>…numbered lines…</content>` block
 * per file read. A merged group card (groupConsecutiveReads) carries several
 * consecutive envelopes, hence the plural form; the single-envelope helper
 * below is the common-case convenience.
 * @param result - the tool result text.
 * @returns every parsed envelope; empty when the result is not a read envelope.
 */
export function parseReadEnvelopes(result: string): ReadEnvelope[] {
  const out: ReadEnvelope[] = []
  const block = /<path>([\s\S]*?)<\/path>\s*<type>[^<]*<\/type>\s*<content>([\s\S]*?)<\/content>/g
  let match: RegExpExecArray | null
  while ((match = block.exec(result)) !== null) {
    const path = match[1] ?? ''
    const body = match[2] ?? ''
    const lines: { number: number; text: string }[] = []
    let totalLines: number | undefined
    for (const raw of body.split('\n')) {
      const numbered = /^(\d+): (.*)$/.exec(raw)
      if (numbered !== null) {
        lines.push({ number: Number(numbered[1]), text: numbered[2] ?? '' })
        continue
      }
      const end = /^\(End of file - total (\d+) lines\)$/.exec(raw)
      if (end !== null) {
        totalLines = Number(end[1])
        continue
      }
      const showing = /^\(Showing lines \d+-\d+ of (\d+) lines/.exec(raw)
      if (showing !== null) totalLines = Number(showing[1])
    }
    out.push({ path, lines, ...(totalLines === undefined ? {} : { totalLines }) })
  }
  return out
}

/** Parse the FIRST read envelope of a result, or undefined when none exists. */
export function parseReadEnvelope(result: string): ReadEnvelope | undefined {
  return parseReadEnvelopes(result)[0]
}

/**
 * The folded preview suffix for a read card: `— {N} lines` when the envelope
 * reports a total (or a line count), empty otherwise. A merged group card
 * (multiple envelopes) yields nothing — its head already carries "N files".
 */
export function readFoldedPreview(result: string): string {
  const envelopes = parseReadEnvelopes(result)
  if (envelopes.length !== 1) return ''
  const envelope = envelopes[0] as ReadEnvelope
  const total = envelope.totalLines ?? (envelope.lines.length > 0 ? envelope.lines.length : undefined)
  return total === undefined ? '' : ` — ${total} lines`
}

/**
 * The Web row-model header for one tool card: title = tool-owned title or the
 * variant design title; summary = SUMMARY_KEYS-derived args summary relativized
 * to the workspace root. Unknown variants carry the tool name alongside the
 * summary (the Web's `toolName · base` rule), with the separator dropped when
 * there is no summary text. Slash-command names render without their slash.
 * @param name - the tool name.
 * @param argsRaw - the raw arguments JSON string ('' when absent).
 * @param cwd - workspace root for relativization; optional.
 */
export function toolCardHeader(name: string, argsRaw: string, cwd?: string): ToolCardHeader {
  const variant = classifyTool(name)
  const toolTitle = TOOL_TITLES[name] ?? TUI_TOOL_TITLES[name]
  const base = argsRaw === '' ? '' : relativizeToCwd(deriveSummary(variant, argsRaw), cwd)
  const summary = variant === 'others' && toolTitle === undefined
    ? base === '' ? '' : name + ' · ' + base
    : base
  const title = toolTitle ?? (name.startsWith('/') ? name.slice(1) : VARIANT_TITLES[variant])
  return { title, summary }
}

/** The completed-result input handed to ToolPresenter.result. */
export interface ToolResultInput {
  /** The final model-facing content blocks. */
  content: readonly ContentBlock[]
  /** Whether the call failed. */
  isError: boolean
  /** The tool-private presentation payload, when the tool attached one. */
  meta?: JsonValue
}

/**
 * The presentation bridge the render layer consults: tool-owned render
 * intents (presentCall/presentResult), or undefined for the generic card.
 * Wired by the runner to the live tool registry; pure and replay-safe.
 */
export interface ToolPresenter {
  /** The pending-call view for one tool call, or undefined. */
  call(name: string, argsRaw: string): ToolCallView | undefined
  /** The completed-call view for one tool result, or undefined. */
  result(name: string, argsRaw: string, result: ToolResultInput): ToolResultView | undefined
}

/**
 * The tool-definition surface a presenter needs (presentCall/presentResult).
 * Structural, so the runner can hand over a registry read without importing
 * the full ToolDefinition type graph.
 */
export interface ToolDefinitionLike {
  presentCall?(args: unknown): ToolCallView | undefined
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
}

/**
 * Build the presentation bridge over a tool-definition lookup (the runner
 * passes a scoped registry read, e.g. `ctx.get('tools')?.get(name, scope)`).
 * Mirrors the host apiproxy's presenter invocations: args are JSON-parsed and
 * the callbacks are guarded so a throwing tool presenter degrades to the
 * generic card. An absent registry yields no views, so the cards fall back to
 * the generic presentation instead of failing.
 * @param get - resolve one tool definition by name (scope already applied).
 */
export function toolPresenterFrom(get: (name: string) => ToolDefinitionLike | undefined): ToolPresenter {
  return {
    call(name, argsRaw) {
      const definition = get(name)
      if (definition?.presentCall === undefined) return undefined
      const parsed = parseArgs(argsRaw)
      if (parsed === undefined) return undefined
      try {
        return definition.presentCall(parsed)
      } catch {
        return undefined
      }
    },
    result(name, argsRaw, result) {
      const definition = get(name)
      if (definition?.presentResult === undefined) return undefined
      const parsed = parseArgs(argsRaw)
      if (parsed === undefined) return undefined
      try {
        return definition.presentResult(parsed, {
          content: [...result.content],
          isError: result.isError,
          ...result.meta === undefined ? {} : { meta: result.meta },
        })
      } catch {
        return undefined
      }
    },
  }
}