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
import type {
  FileDiff, ToolCallView, ToolResult, ToolResultView, WebFetchResultView, WebSearchResultView,
} from '@deepseek-ai/dsh-tools'

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
  // The ask_user_question tool carries no tool-owned presentation; its card
  // names the interaction (Web AskQuestionRow parity) instead of the generic
  // "Tool call" row.
  ask_user_question: 'Question',
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

/**
 * Tool-specific args summaries for tools whose natural one-line identity is
 * not a raw arg value (Web TodoRow/AskQuestionRow parity): `todo_write`
 * reads `done/total done` plus the first active item, `ask_user_question`
 * reads the first question text. Returns undefined for every other tool,
 * letting the generic derivation own the summary.
 * @param name - the tool name.
 * @param argsRaw - the raw arguments JSON.
 * @returns the tool-specific summary, or undefined when none applies.
 */
function summarizeToolArgs(name: string, argsRaw: string): string | undefined {
  const parsed = parseArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const args = parsed as Record<string, unknown>
  if (name === 'ask_user_question') {
    const questions = args.questions
    if (!Array.isArray(questions) || questions.length === 0) return undefined
    const first = questions[0]
    if (typeof first !== 'object' || first === null) return undefined
    const question = (first as Record<string, unknown>).question
    if (typeof question !== 'string' || question === '') return undefined
    return firstLine(question)
  }
  if (name !== 'todo_write') return undefined
  const todos = args.todos
  if (!Array.isArray(todos)) return undefined
  const done = todos.filter(todo =>
    typeof todo === 'object' && todo !== null && (todo as Record<string, unknown>).status === 'completed',
  ).length
  const active = todos.find(todo =>
    typeof todo === 'object' && todo !== null && (todo as Record<string, unknown>).status !== 'completed',
  )
  const content = active === undefined ? '' : String((active as Record<string, unknown>).content ?? '')
  return `${done}/${todos.length} done${content === '' ? '' : ` · ${firstLine(content)}`}`
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
  ask_user_question: '❓',
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
 * Folded-card call preview derived from raw args alone (no tool registry
 * needed): bash/pwsh expose the command actually run (kimi ShellExecution
 * parity — the header only names the action), edit/write expose their
 * call-time old→new diff so a collapsed card already shows what changed.
 * Nothing for every other tool: their folded row keeps the single-line
 * header + result preview.
 */
export type CallPreview =
  | { kind: 'bash'; command: string; workdir?: string }
  | { kind: 'diff'; diffs: readonly FileDiff[] }
  | undefined

/** Derive the folded preview from a tool name and its raw args JSON. */
export function parseCallPreview(name: string, argsRaw: string): CallPreview {
  const parsed = parseArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const args = parsed as Record<string, unknown>
  if (name === 'bash' || name === 'pwsh') {
    const command = args.command
    if (typeof command !== 'string' || command === '') return undefined
    const workdir = args.workdir
    return {
      kind: 'bash',
      command,
      ...(typeof workdir === 'string' && workdir !== '' ? { workdir } : {}),
    }
  }
  if (name === 'edit') {
    const oldText = args.old_string
    const newText = args.new_string
    if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined
    const path = typeof args.file_path === 'string' && args.file_path !== '' ? args.file_path : args.path
    return { kind: 'diff', diffs: [{ path: typeof path === 'string' ? path : '', oldText, newText }] }
  }
  if (name === 'write') {
    const content = args.content
    if (typeof content !== 'string' || content === '') return undefined
    const path = typeof args.file_path === 'string' && args.file_path !== '' ? args.file_path : args.path
    return { kind: 'diff', diffs: [{ path: typeof path === 'string' ? path : '', oldText: null, newText: content }] }
  }
  return undefined
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
  // Tool-specific summaries replace the args-derived base before the
  // generic derivation (Web TodoRow parity: `todo_write` reads
  // `2/3 done` instead of a raw args dump).
  const toolSummary = summarizeToolArgs(name, argsRaw)
  const base = argsRaw === '' ? '' : toolSummary ?? relativizeToCwd(deriveSummary(variant, argsRaw), cwd)
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
 * Render a completed web retrieval as display lines (Web WebBlock parity):
 * a `search` shows the provider answer and the source list (title — url,
 * snippet under each), a `fetch` shows the URL and HTTP status. Truncation
 * is marked in the same place the Web marks it: under the list/status.
 * Colors are the caller's (the render layer owns the palette).
 * @param view - the web result view from presentResult.
 * @returns the display lines; empty when the view carries nothing to show.
 */
export function webCardLines(view: WebSearchResultView | WebFetchResultView): string[] {
  if (view.kind === 'search') {
    const lines: string[] = []
    if (view.answer !== undefined && view.answer !== '') lines.push(view.answer)
    for (const source of view.sources) {
      const head = source.title === undefined || source.title === ''
        ? source.url
        : `${source.title} — ${source.url}`
      lines.push(`• ${head}`)
      if (source.snippet !== undefined && source.snippet !== '') lines.push(`  ${source.snippet}`)
    }
    if (view.truncated) lines.push('… truncated — more sources omitted')
    return lines
  }
  const lines = [`${view.url} — HTTP ${view.statusCode}`]
  if (view.truncated) lines.push('… truncated — content capped')
  return lines
}

/**
 * Render a generic card's rawInput as display lines, structured per tool
 * where the payload has a natural one-line shape (web TodoRow parity for
 * `todo_write`, a session/terminal target line for the rest). Unknown
 * object payloads fall back to pretty JSON — the same fallback the Web's
 * generic body uses. A string rawInput renders verbatim.
 * @param name - the tool name.
 * @param rawInput - the presenter's salient raw input.
 * @returns the display lines.
 */
/** Checklist display lines for a todo list: `●` in progress, `○` pending,
 * `✓` completed (Web TodoRow parity). Malformed items are skipped. */
function todoChecklistLines(todos: readonly unknown[]): string[] {
  const lines: string[] = []
  for (const todo of todos) {
    if (typeof todo !== 'object' || todo === null) continue
    const item = todo as Record<string, unknown>
    const content = typeof item.content === 'string' ? item.content : String(item.content ?? '')
    const mark = item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '●' : '○'
    lines.push(`${mark} ${content}`)
  }
  return lines
}

export function genericRawInputLines(name: string, rawInput: unknown): string[] {
  if (typeof rawInput === 'string') return rawInput === '' ? [] : [rawInput]
  if (typeof rawInput !== 'object' || rawInput === null) {
    return rawInput === undefined ? [] : [String(rawInput)]
  }
  // The todo_write presenter ships the todos ARRAY itself (`rawInput:
  // args.todos`); a wrapped `{ todos }` object is accepted defensively.
  if (name === 'todo_write' && Array.isArray(rawInput)) return todoChecklistLines(rawInput)
  const args = rawInput as Record<string, unknown>
  if (name === 'todo_write') {
    const todos = args.todos
    if (Array.isArray(todos)) return todoChecklistLines(todos)
  }
  if ((name === 'terminal_read' || name === 'terminal_signal' || name === 'terminal_send') && typeof args.sessionId === 'string') {
    const line = `session ${args.sessionId}`
    return name === 'terminal_send' && typeof args.text === 'string' ? [`${line}: ${args.text}`] : [line]
  }
  if (
    (name === 'session_event_trace' || name === 'session_event_read' || name === 'session_trace')
    && (args.seq !== undefined || args.session_id !== undefined)
  ) {
    const parts: string[] = []
    if (args.session_id !== undefined) parts.push(String(args.session_id))
    if (args.seq !== undefined) parts.push(`seq ${String(args.seq)}`)
    return [parts.join(' · ')]
  }
  return JSON.stringify(rawInput, null, 2).split('\n')
}

/**
 * Flatten a settled result's content blocks to display lines, with the Web's
 * `resultText` semantics: text blocks verbatim, other block shapes as pretty
 * JSON. Empty content on a failed call falls back to the structured error's
 * `name: code` line (the Web's error summary).
 * @param blocks - the result content blocks.
 * @param error - the structured error, when the call failed.
 * @returns the display lines (may be empty).
 */
export function resultTextLines(blocks: readonly ContentBlock[], error?: { name: string; code: string }): string[] {
  const lines: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') lines.push(...block.text.split('\n'))
    else lines.push(JSON.stringify(block, null, 2))
  }
  if (lines.length === 0 && error !== undefined) lines.push(`${error.name}: ${error.code}`)
  return lines
}

/**
 * The answered-count summary for a settled `ask_user_question` result
 * (Web AskQuestionRow parity): parses the tool's `{"answers":[…]}` render
 * text and counts the entries that actually carry an answer — a non-empty
 * `selected` list or a non-empty `custom` string (a skipped question has
 * neither and stays out of the count). Returns `N/M answered`, or undefined
 * when the text is not the expected answer JSON (the caller then falls back
 * to the generic presentation instead of inventing a count).
 * @param text - the settled result text.
 * @returns the answered-count summary, or undefined when unparseable.
 */
export function askAnswersSummary(text: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const answers = (parsed as { answers?: unknown }).answers
  if (!Array.isArray(answers)) return undefined
  const total = answers.length
  const answered = answers.filter((entry): boolean => {
    if (typeof entry !== 'object' || entry === null) return false
    const candidate = entry as { selected?: unknown; custom?: unknown }
    return (Array.isArray(candidate.selected) && candidate.selected.length > 0)
      || (typeof candidate.custom === 'string' && candidate.custom !== '')
  }).length
  return `${answered}/${total} answered`
}

/**
 * The folded-card call preview for tools whose args carry a one-line
 * identity (Web TodoRow/WebRow folded parity): `todo_write` summarizes
 * `done/total` plus the first active item, `web_search`/`web_fetch` show
 * the query/URL. Empty for every other tool (their folded row keeps the
 * header + result preview).
 * @param name - the tool name.
 * @param argsRaw - the raw arguments JSON.
 * @returns the preview line, or '' when the tool has none.
 */
export function foldedCallPreview(name: string, argsRaw: string): string {
  const parsed = parseArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null) return ''
  const args = parsed as Record<string, unknown>
  if (name === 'todo_write') {
    // The header already carries the tool-specific count; the folded row
    // only repeats it when the header lacks one (defensive: same derivation).
    const summary = summarizeToolArgs(name, argsRaw)
    return summary === undefined ? '' : ` — ${summary}`
  }
  if (name === 'web_search') {
    const query = args.query
    return typeof query === 'string' && query !== '' ? ` — ${firstLine(query)}` : ''
  }
  if (name === 'web_fetch') {
    const url = args.url
    return typeof url === 'string' && url !== '' ? ` — ${firstLine(url)}` : ''
  }
  if (name === 'skill') {
    const skill = args.name
    return typeof skill === 'string' && skill !== '' ? ` — ${firstLine(skill)}` : ''
  }
  return ''
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
/**
 * Subagent-family tool names whose call args may carry an explicit
 * model/provider override. Matched by REGISTERED name; unknown names are
 * ignored so third-party subagent-like tools keep their default rendering.
 */
const SUBAGENT_TOOL_NAMES = new Set([
  'subagent',
  'subagent_route',
  'subagent_router',
  'subagent_fork',
])

/**
 * Extract the model · provider display line for a subagent-family tool call.
 *
 * COMPATIBILITY CONTRACT: the line renders ONLY when the call args actually
 * carry a model/provider — the top-level `model`/`provider` shape
 * (subagent_route / subagent_router) or the `agentOptions.model/provider`
 * shape. Every other call returns `undefined` and the card renders exactly
 * as before; unknown tool names and unparseable args are ignored. The
 * official `subagent` tool's model lives in deployment config (never in
 * the call args), so it naturally renders nothing.
 * @param name - the tool's registered name.
 * @param argsRaw - the raw tool-call arguments JSON ('' or malformed → none).
 * @returns `model · provider` (either part alone when only one is present),
 *   or undefined when the call carries no model/provider.
 */
export function subagentModelDisplay(name: string, argsRaw: string): string | undefined {
  if (!SUBAGENT_TOOL_NAMES.has(name)) return undefined
  const parsed = parseArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const args = parsed as Record<string, unknown>
  const opts = typeof args.agentOptions === 'object' && args.agentOptions !== null
    ? args.agentOptions as Record<string, unknown>
    : undefined
  const model = typeof args.model === 'string' && args.model !== ''
    ? args.model
    : typeof opts?.model === 'string' && opts.model !== ''
      ? opts.model
      : undefined
  const provider = typeof args.provider === 'string' && args.provider !== ''
    ? args.provider
    : typeof opts?.provider === 'string' && opts.provider !== ''
      ? opts.provider
      : undefined
  const parts = [model, provider].filter((part): part is string => part !== undefined)
  return parts.length === 0 ? undefined : parts.join(' · ')
}
