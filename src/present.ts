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
  // The model-facing skill loader is a read-class tool (its presentCall
  // reports kind: 'read'); the static fallback must agree so a replay
  // without the live registry renders the same row family (plan §7.3).
  skill: 'read',
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
  // The skill loader's human title (its presentCall says `Load skill
  // <name>`; the fallback must say the same — plan §7.3/§9.2).
  skill: 'Load skill',
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
  // The goal tools have no presentResult either; their cards name the
  // action (the same "read/create/update" vocabulary as the tool-side
  // presentCall titles) instead of the generic "Tool call" row.
  get_goal: 'Read Goal',
  create_goal: 'Create Goal',
  update_goal: 'Update Goal',
}

/** The goal tool family (all three share the `{"goal":…}` result shape). */
export const GOAL_TOOL_NAMES: ReadonlySet<string> = new Set(['get_goal', 'create_goal', 'update_goal'])

/**
 * Tools whose folded result preview must never leak the raw result JSON
 * (web parity: the web's folded row shows only the args summary, never the
 * result). The TUI keeps its result-preview row but shows a parsed summary
 * instead — and nothing at all when the result cannot be parsed.
 *
 * `ralph`'s render already leads with a friendly line ("Ralph worker
 * reported completion after N rounds.") before the JSON report, so its
 * summary IS that first line. The agent-team family is deliberately NOT in
 * the set: it is experimental (not in the production bundle) and two of its
 * tools (`send_message`, `interrupt_agent`) share names with subagent tools
 * whose render text is friendly — a name-keyed set cannot tell them apart.
 */
export const FOLDED_JSON_RESULT_TOOLS: ReadonlySet<string> = new Set([
  'ralph',
  'schedule_create',
  'schedule_list',
  'schedule_delete',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'cordis_inspect_self',
])

/** Parse a result text as JSON, tolerating a friendly prefix line before
 * the JSON document (e.g. ralph's "…\nFinal report:\n{…}"). */
function parseJsonValue(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // Fall through to the prefix-tolerant scan.
  }
  const brace = text.indexOf('{')
  const bracket = text.indexOf('[')
  const start = bracket !== -1 && (brace === -1 || bracket < brace) ? bracket : brace
  if (start > 0) {
    try {
      return JSON.parse(text.slice(start))
    } catch {
      return undefined
    }
  }
  return undefined
}

/** A non-empty string field, or undefined. */
function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The folded preview summary for one of {@link FOLDED_JSON_RESULT_TOOLS}:
 * a short human phrase derived from the parsed result JSON. Returns
 * undefined when nothing useful can be derived — the caller then shows NO
 * folded result preview (web parity), never the raw JSON.
 * @param name - the tool name.
 * @param text - the settled result text.
 */
export function foldedResultSummaryFor(name: string, text: string): string | undefined {
  if (name === 'ralph') {
    // The render text leads with a friendly line before the JSON report;
    // that line is the best folded summary. A bare-JSON result (e.g. a
    // replay without the render prefix) falls back to status/rounds.
    const line = firstLine(text)
    if (line !== '' && !line.startsWith('{')) return line
    const parsed = parseJsonValue(text)
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      const status = stringField(record.status)
      const rounds = typeof record.roundsStarted === 'number' ? String(record.roundsStarted) : undefined
      const parts = [status, rounds === undefined ? undefined : `${rounds} rounds`].filter((part): part is string => part !== undefined)
      return parts.length === 0 ? undefined : parts.join(' · ')
    }
    return undefined
  }
  const parsed = parseJsonValue(text)
  if (name === 'schedule_list') {
    if (Array.isArray(parsed)) return parsed.length === 0 ? 'no scheduled jobs' : `${parsed.length} scheduled`
    if (typeof parsed === 'object' && parsed !== null) return stringField((parsed as Record<string, unknown>).code)
    return undefined
  }
  if (name === 'schedule_create') {
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    const kind = stringField(record.kind)
    const state = stringField(record.state)
    const parts = [kind, state].filter((part): part is string => part !== undefined)
    return parts.length === 0 ? undefined : parts.join(' · ')
  }
  if (name === 'schedule_delete') {
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    if (record.deleted === true) return 'deleted'
    if (record.deleted === false) return 'not found'
    return stringField(record.code)
  }
  if (name === 'cordis_inspect_list') {
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const providers = (parsed as Record<string, unknown>).providers
    if (Array.isArray(providers)) return providers.length === 0 ? 'no providers' : `${providers.length} providers`
    return undefined
  }
  if (name === 'cordis_inspect_query') {
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    const parts = [stringField(record.platform), stringField(record.provider), stringField(record.method)]
      .filter((part): part is string => part !== undefined)
    return parts.length === 0 ? undefined : parts.join(' · ')
  }
  if (name === 'cordis_inspect_self') {
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const mode = stringField((parsed as Record<string, unknown>).mode)
    return mode === undefined ? undefined : `mode ${mode}`
  }
  return undefined
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
  if (name === 'create_goal') {
    // The objective is the goal's one-line identity (a raw args dump would
    // leak the whole JSON object).
    const objective = args.objective
    return typeof objective === 'string' && objective !== '' ? firstLine(objective) : undefined
  }
  if (name === 'update_goal') {
    // The action names the update (`edit` / `pause` / `resume` / …); the
    // goal_id and revision are bookkeeping, not identity.
    const action = args.action
    return typeof action === 'string' && action !== '' ? action : undefined
  }
  if (name === 'get_goal') {
    // Empty args: an empty summary keeps the header to the title alone
    // instead of leaking the raw `{}`.
    return ''
  }
  if (name === 'skill') {
    // The skill name is the call's one-line identity (the fallback header
    // reads `Load skill · <name>` — plan §7.3).
    const skillName = args.name
    return typeof skillName === 'string' && skillName !== '' ? firstLine(skillName) : undefined
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
 * Parse the write tool's XML confirmation envelope (`<path>…</path> <type>
 * …</type> <content>Created file</content>` — no file content is echoed).
 * The verb + path are the only material the envelope carries. A malformed
 * envelope — including a blank `<path>` — yields undefined, never a
 * partial parse (a whitespace path would surface as an invalid card row).
 * @param result - the tool result text.
 * @returns the envelope's verb and path, or undefined when the result is
 * not a well-formed write envelope.
 */
export function parseWriteEnvelope(result: string): { verb: 'Created' | 'Updated'; path: string } | undefined {
  const match = /<path>([\s\S]*?)<\/path>\s*<type>[^<]*<\/type>\s*<content>([\s\S]*?)<\/content>/.exec(result)
  if (match === null) return undefined
  const verb = /^\s*(Created|Updated)\s+file\s*$/.exec(match[2] ?? '')?.[1]
  if (verb !== 'Created' && verb !== 'Updated') return undefined
  const path = (match[1] ?? '').trim()
  if (path === '') return undefined
  return { verb, path }
}

/**
 * The folded preview suffix for a write card: ` — Created` / ` — Updated`
 * when the result is the tool's XML confirmation envelope, empty otherwise.
 * The folded row must NEVER dump the raw envelope (the read-card no-XML
 * rule; a malformed envelope yields no preview at all, not the raw text).
 * @param result - the tool result text.
 * @returns the verb suffix, or '' when the result is not a write envelope.
 */
export function writeFoldedPreview(result: string): string {
  const envelope = parseWriteEnvelope(result)
  return envelope === undefined ? '' : ` — ${envelope.verb}`
}

/**
 * Parse the skill tool's XML instruction envelope (`<skill_content
 * name="…"> <skill_resources>…</skill_resources> <skill_instructions>…
 * </skill_instructions> </skill_content>`). The name attribute is XML-
 * escaped by the producer (escapeAttr: `&amp;`/`&quot;`/`&lt;`) and is
 * decoded here; the instructions body is embedded VERBATIM by the producer
 * (skills are trusted local content), so it is returned unmodified.
 *
 * The boundaries are OUTER-envelope-aware: the opener is the first
 * `<skill_content name="…">`, the instructions opener the first
 * `<skill_instructions>` after it, and the closers the last
 * `</skill_instructions>` / `</skill_content>` — so a body that itself
 * documents envelope-shaped XML (a complete nested block, or an unclosed
 * tag) never truncates the outer body. A MALFORMED first envelope never
 * borrows a later envelope's boundaries: a second `<skill_content name="…">`
 * opener between the first opener and its instructions opener means the
 * first envelope is incomplete, and the selected instructions body must
 * close every `<skill_content name="…">` opener it contains (unmatched
 * closing tags are tolerated) — without those guards, a first envelope
 * whose own boundaries are unclosed would cross-pair with a later
 * envelope's. An unclosed `<skill_content name="…">` example inside a body
 * is indistinguishable from such a malformed concatenation and degrades to
 * a header-only card, never raw tags.
 * @param result - the tool result text.
 * @returns the envelope's name and instruction body, or undefined when the
 * result is not a well-formed skill envelope (a blank name is malformed).
 */
export function parseSkillEnvelope(result: string): { name: string; instructions: string } | undefined {
  const open = result.indexOf('<skill_content name="')
  if (open < 0) return undefined
  const nameStart = open + '<skill_content name="'.length
  const nameEnd = result.indexOf('"', nameStart)
  if (nameEnd < 0) return undefined
  const instrOpen = result.indexOf('<skill_instructions>', nameEnd)
  if (instrOpen < 0) return undefined
  // A content opener BEFORE the instructions opener belongs to a later
  // envelope: the first envelope is malformed and must be rejected, never
  // cross-paired with the later envelope's boundaries.
  const nestedOpen = result.indexOf('<skill_content name="', nameEnd)
  if (nestedOpen >= 0 && nestedOpen < instrOpen) return undefined
  const outerClose = result.lastIndexOf('</skill_content>')
  if (outerClose < instrOpen) return undefined
  const instrClose = result.lastIndexOf('</skill_instructions>', outerClose)
  if (instrClose <= instrOpen) return undefined
  // The selected body must have no UNMATCHED content opener: every
  // `<skill_content name="…">` opener inside it must be closed inside it.
  // An opener without a matching close means the first envelope's
  // instructions are not independently closed and the selected boundaries
  // would cross into a later envelope (the same shape as an unclosed nested
  // example — the malformed envelope wins and the result degrades, never
  // leaks). Unmatched closing tags are ignored: they cannot cross-pair and
  // a body documenting `</skill_content>` stays verbatim.
  const bodyRegion = result.slice(instrOpen, instrClose)
  let contentDepth = 0
  for (const token of bodyRegion.matchAll(/<skill_content name="|<\/skill_content>/g)) {
    if (token[0] === '<skill_content name="') contentDepth += 1
    else contentDepth = Math.max(0, contentDepth - 1)
  }
  if (contentDepth > 0) return undefined
  const rawName = result.slice(nameStart, nameEnd).trim()
  if (rawName === '') return undefined
  // Decode the producer's attribute escaping (&quot; → ", &lt; → <, &amp;
  // → & — in that order, so an originally-escaped literal like &amp;quot;
  // round-trips to &quot; instead of being double-decoded).
  const name = rawName
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
  let body = result.slice(instrOpen + '<skill_instructions>'.length, instrClose)
  if (body.startsWith('\n')) body = body.slice(1)
  if (body.endsWith('\n')) body = body.slice(0, -1)
  return { name, instructions: body }
}

/**
 * The folded preview suffix for a skill card: ` — N lines` (the instruction
 * body's line count — the header already carries `skill · <name>`), empty
 * otherwise. The folded row never dumps the raw `<skill_content>` block.
 * @param result - the tool result text.
 * @returns the line-count suffix, or '' when the result is not a skill
 * envelope.
 */
export function skillFoldedPreview(result: string): string {
  const envelope = parseSkillEnvelope(result)
  if (envelope === undefined) return ''
  const lines = envelope.instructions.split('\n').filter(line => line !== '').length
  return lines === 0 ? '' : ` — ${lines} lines of instructions`
}

/**
 * The human-facing body lines of one injected context row, derived from the
 * model-facing text so the expanded row never leaks the envelope's raw XML
 * (the same no-XML rule as the read/write/skill tool cards):
 *
 * - a well-formed skill envelope (`<skill_content …>` — the skill loader
 *   tool result and the user-explicit invocation injection share this
 *   shape) renders its instructions body;
 * - a `<system-reminder>`-wrapped producer (the skill catalog, workspace
 *   instructions — both bake their complete frame into the content,
 *   harness caller-owned framing) renders its content with the wrapper tag
 *   lines stripped; `<available_skills>` markers are stripped only when the
 *   pair is present, so a lone marker inside real content survives;
 * - any OTHER text returns undefined and the caller keeps its raw-body
 *   behavior (plain context rows are unchanged).
 *
 * A malformed skill envelope yields an EMPTY body, never the raw tags: the
 * header still names the producer, and the model-facing bytes are untouched
 * (presentation only).
 * @param text - the injected context message text, exactly as logged.
 * @returns the body lines to render, or undefined when no envelope shape
 * applies.
 */
export function systemContextBody(text: string): string[] | undefined {
  const skill = parseSkillEnvelope(text)
  if (skill !== undefined) return skill.instructions.split('\n')
  if (text.trimStart().startsWith('<skill_content')) return []
  const lines = text.split('\n')
  const first = lines[0]?.trim()
  const last = lines[lines.length - 1]?.trim()
  if (first !== '<system-reminder>' || last !== '</system-reminder>') return undefined
  const body = lines.slice(1, -1)
  const hasSkillsPair = body.some(line => line.trim() === '<available_skills>')
    && body.some(line => line.trim() === '</available_skills>')
  if (!hasSkillsPair) return body
  return body.filter(line => line.trim() !== '<available_skills>' && line.trim() !== '</available_skills>')
}

/**
 * Parse the read_image tool's XML confirmation envelope (`<path>…</path>
 * <type>image</type> <content>PNG image, 800x600 px, … bytes</content>`).
 * @param result - the tool result text.
 * @returns the envelope's path and the content summary line, or undefined
 * when the result is not a well-formed image envelope (blank path or blank
 * summary are malformed).
 */
export function parseImageEnvelope(result: string): { path: string; summary: string } | undefined {
  const match = /<path>([\s\S]*?)<\/path>\s*<type>image<\/type>\s*<content>\s*\n?\s*([\s\S]*?)\s*\n?\s*<\/content>/.exec(result)
  if (match === null) return undefined
  const path = (match[1] ?? '').trim()
  const summary = (match[2] ?? '').trim()
  if (path === '' || summary === '') return undefined
  return { path, summary }
}

/**
 * The folded preview suffix for a read_image card: ` — <summary>` (e.g.
 * `PNG image · 800x600 px`), empty otherwise. The folded row never dumps
 * the raw envelope (the read-card no-XML rule).
 * @param result - the tool result text.
 * @returns the summary suffix, or '' when the result is not an image
 * envelope.
 */
export function imageFoldedPreview(result: string): string {
  const envelope = parseImageEnvelope(result)
  return envelope === undefined ? '' : ` — ${firstLine(envelope.summary)}`
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
    // An image block carries base64 payload: never dump it into the
    // transcript as pretty JSON (read_image cards render their envelope
    // summary instead). Other non-text blocks keep the JSON projection.
    else if (block.type === 'image') lines.push('[image]')
    else lines.push(JSON.stringify(block, null, 2))
  }
  if (lines.length === 0 && error !== undefined) lines.push(`${error.name}: ${error.code}`)
  return lines
}

/** One normalized answer entry, shared by the summary and the display lines
 * so the count always matches the rendered rows (the review-fix-loop P2
 * finding: malformed entries must not be counted but skipped from lines). */
interface NormalizedAnswerEntry {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom: string
}

/**
 * Parse and normalize the tool's `{"answers":[…]}` render text. A
 * malformed entry (non-object) invalidates the WHOLE text — the Web's
 * `answeredSummary` checks `answers.every(isAnswer)` the same way, and a
 * half-valid set would make the count and the rendered rows disagree.
 * Non-string `selected` members are dropped; missing id/custom normalize
 * to empty.
 * @param text - the settled result text.
 * @returns the normalized entries, or undefined when unparseable/malformed.
 */
function parseAnswerEntries(text: string): NormalizedAnswerEntry[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const answers = (parsed as { answers?: unknown }).answers
  if (!Array.isArray(answers)) return undefined
  if (!answers.every(entry => typeof entry === 'object' && entry !== null)) return undefined
  return answers.map(entry => {
    const candidate = entry as { id?: unknown; selected?: unknown; custom?: unknown }
    return {
      id: typeof candidate.id === 'string' ? candidate.id : '',
      selected: Array.isArray(candidate.selected)
        ? candidate.selected.filter((item): item is string => typeof item === 'string')
        : [],
      custom: typeof candidate.custom === 'string' ? candidate.custom : '',
    }
  })
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
  const entries = parseAnswerEntries(text)
  if (entries === undefined) return undefined
  const answered = entries.filter(entry => entry.selected.length > 0 || entry.custom !== '').length
  return `${answered}/${entries.length} answered`
}

/** One display line of a settled `ask_user_question` result, pre-colored. */
export interface AskAnswerLine {
  /** The rendered line: `● <id> → <answers>` or `○ <id> — skipped`. */
  readonly text: string
  /** Whether the question was skipped (dimmed rendering). */
  readonly skipped: boolean
}

/**
 * The per-question display lines for a settled `ask_user_question` result
 * (the expanded card's body, complementing {@link askAnswersSummary}'s
 * count). Parses the tool's `{"answers":[…]}` render text and renders one
 * line per entry: `● <id> → <selected, custom>` for an answered question,
 * `○ <id> — skipped` when neither is present. Shares the normalization with
 * {@link askAnswersSummary}, so the rendered rows and the count always
 * agree; an unparseable/malformed text returns undefined.
 * @param text - the settled result text.
 * @returns the display lines, or undefined when unparseable/malformed.
 */
export function askAnswersLines(text: string): AskAnswerLine[] | undefined {
  const entries = parseAnswerEntries(text)
  if (entries === undefined) return undefined
  return entries.map(entry => {
    if (entry.selected.length > 0) return { text: `● ${entry.id} → ${entry.selected.join(', ')}`, skipped: false }
    if (entry.custom !== '') return { text: `● ${entry.id} → ${entry.custom}`, skipped: false }
    return { text: `○ ${entry.id} — skipped`, skipped: true }
  })
}

/** The parsed `{"goal":…}` result shape the three goal tools share. */
interface GoalResultValue {
  readonly goal: null | {
    readonly id?: unknown
    readonly revision?: unknown
    readonly objective?: unknown
    readonly phase?: unknown
    readonly roundsStarted?: unknown
    readonly maxGoalRounds?: unknown
    readonly blockedReason?: { code?: unknown; message?: unknown }
  }
  readonly activation?: unknown
}

/** Parse a settled goal-tool result text, or undefined when it is not the
 * expected `{"goal":…}` JSON (the caller then falls back to the generic
 * presentation). */
function parseGoalResult(text: string): GoalResultValue | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const value = parsed as Record<string, unknown>
  if (value.goal === null) return { goal: null }
  if (typeof value.goal !== 'object' || value.goal === null) return undefined
  const goal = value.goal as Record<string, unknown>
  const blocked = typeof goal.blockedReason === 'object' && goal.blockedReason !== null
    ? goal.blockedReason as Record<string, unknown>
    : undefined
  return {
    goal: {
      ...typeof goal.id === 'string' ? { id: goal.id } : {},
      ...typeof goal.revision === 'number' ? { revision: goal.revision } : {},
      ...typeof goal.objective === 'string' ? { objective: goal.objective } : {},
      ...typeof goal.phase === 'string' ? { phase: goal.phase } : {},
      ...typeof goal.roundsStarted === 'number' ? { roundsStarted: goal.roundsStarted } : {},
      ...typeof goal.maxGoalRounds === 'number' ? { maxGoalRounds: goal.maxGoalRounds } : {},
      ...(blocked !== undefined)
        ? {
          blockedReason: {
            ...typeof blocked.code === 'string' ? { code: blocked.code } : {},
            ...typeof blocked.message === 'string' ? { message: blocked.message } : {},
          },
        }
        : {},
    },
    ...typeof value.activation === 'string' ? { activation: value.activation } : {},
  }
}

/**
 * The one-line folded summary for a settled goal-tool result: `phase … ·
 * revision N · N/M rounds`, or `no goal set` for `{"goal":null}`.
 * Returns undefined when the text is not the expected result JSON (the
 * caller then falls back to the generic preview instead of inventing one).
 * @param text - the settled result text.
 */
export function goalResultSummary(text: string): string | undefined {
  const value = parseGoalResult(text)
  if (value === undefined) return undefined
  const goal = value.goal
  if (goal === null) return 'no goal set'
  const parts: string[] = []
  if (goal.phase !== undefined) parts.push(`phase ${goal.phase}`)
  if (goal.revision !== undefined) parts.push(`revision ${goal.revision}`)
  if (goal.roundsStarted !== undefined) {
    parts.push(goal.maxGoalRounds === undefined
      ? `${goal.roundsStarted} rounds`
      : `${goal.roundsStarted}/${goal.maxGoalRounds} rounds`)
  }
  return parts.length === 0 ? 'goal' : parts.join(' · ')
}

/**
 * The expanded-card display lines for a settled goal-tool result: one field
 * per line (`● objective: …`, `● phase: … · revision N`, `● rounds: N/M`,
 * `● activation: …`, `● blocked: code — message`), or a single `no goal
 * set` line for `{"goal":null}`. Returns undefined when the text is not the
 * expected result JSON (the caller falls back to the generic presentation).
 * @param text - the settled result text.
 */
export function goalResultLines(text: string): string[] | undefined {
  const value = parseGoalResult(text)
  if (value === undefined) return undefined
  const goal = value.goal
  if (goal === null) return ['no goal set']
  const lines: string[] = []
  if (goal.objective !== undefined && goal.objective !== '') {
    lines.push(`● objective: ${goal.objective}`)
  }
  const identity: string[] = []
  if (typeof goal.phase === 'string' && goal.phase !== '') identity.push(goal.phase)
  if (goal.revision !== undefined) identity.push(`revision ${goal.revision}`)
  if (identity.length > 0) lines.push(`● ${identity.join(' · ')}`)
  if (goal.roundsStarted !== undefined) {
    lines.push(goal.maxGoalRounds === undefined
      ? `● rounds: ${goal.roundsStarted}`
      : `● rounds: ${goal.roundsStarted}/${goal.maxGoalRounds}`)
  }
  const blocked = goal.blockedReason
  if (blocked !== undefined && (blocked.code !== undefined || blocked.message !== undefined)) {
    const detail = [blocked.code, blocked.message]
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .join(' — ')
    lines.push(`● blocked: ${detail}`)
  }
  if (value.activation !== undefined) lines.push(`● activation: ${value.activation}`)
  return lines
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
 * The Focus compact Tool line for one raw tool call: presenter-first,
 * static fallback second (plan §9.1/§9.4). The tool-owned presentCall
 * view wins when the live registry has one; otherwise the Web row-model
 * header (toolCardHeader) renders the same semantic. The fold stores the
 * RAW call facts — this helper is the ONLY place the compact line is
 * formatted, so the TranscriptFolder never bakes presentation strings.
 * @param tool - the raw call facts (name + raw arguments JSON).
 * @param options - the live presenter bridge and the workspace root for
 *   path relativization (both optional — replay degrades to the fallback).
 * @returns the one-line display, e.g. `Load skill session-review`,
 *   `Read src/index.ts`, `vendor_probe cache-01`.
 */
export function focusToolDisplay(
  tool: { name: string; args: string },
  options: { presenter?: ToolPresenter; cwd?: string } = {},
): string {
  const owned = options.presenter?.call(tool.name, tool.args)
  if (owned !== undefined) return formatOwnedCallForCompactFocus(owned)
  return focusToolFallbackDisplay(tool.name, tool.args, options.cwd)
}

/** The compact line from a tool-owned presentCall view: the title, plus
 * the rawInput when it is a string the title does not already carry (the
 * skill tool's title is `Load skill <name>` — appending its rawInput
 * again would duplicate). */
function formatOwnedCallForCompactFocus(view: ToolCallView): string {
  if (view.card === 'terminal') return view.title
  if (view.card === 'diff') {
    const path = view.diffs[0]?.path
    return path === undefined ? view.title : `${view.title} ${path}`
  }
  const raw = typeof view.rawInput === 'string' ? view.rawInput.trim() : undefined
  if (raw === undefined || raw === '') return view.title
  return view.title.endsWith(raw) ? view.title : `${view.title} ${firstLine(raw)}`
}

/** The compact line from the static Web row-model header (replay /
 * registry-unavailable fallback). An unknown tool's header title is the
 * generic "Tool call" — the compact line names the actual tool instead
 * (plan §9.3: an unknown custom tool is still a Tool). */
function focusToolFallbackDisplay(name: string, argsRaw: string, cwd?: string): string {
  const header = toolCardHeader(name, argsRaw, cwd)
  const known = classifyTool(name) !== 'others'
    || TOOL_TITLES[name] !== undefined
    || TUI_TOOL_TITLES[name] !== undefined
  if (!known) {
    // The others-summary already leads with the raw name (`vendor_probe ·
    // cache-01`); drop the generic title and the separator.
    return header.summary === '' ? name : header.summary.replace(' · ', ' ')
  }
  return header.summary === '' ? header.title : `${header.title} ${header.summary}`
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
