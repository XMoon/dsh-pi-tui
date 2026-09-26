/**
 * The TUI's command-line policy (plan §27): which slash lines the TUI
 * owns locally, which need no session, how one agent-facing line is
 * delivered while the agent runs, which lines refuse staged images, and
 * the destructive-shell-command predicate the approval dialog uses.
 *
 * Pure and Host-free (structural inputs plus DSH's own parseCommand), so
 * the dispatch gates are testable headless and the presentation/submission
 * paths share ONE classification.
 * @module @xmoon76/dsh-pi-tui/command-policy
 */

import { parseCommand } from '@deepseek-ai/dsh-commands'
import { resolveComposerDelivery, type HostCommandClaim, type SubmitDelivery } from './commands.ts'
import { draftHasImages } from './image/submit.ts'
import type { ComposerSubmitGesture } from './tui-app.ts'
/**
 * Slash commands that need no session: before the first user message
 * (deferred start) they run locally without creating one. Everything else
 * dispatches through `commands.execute`, which creates the session lazily
 * (the command line IS the first user input). Commands in this set must
 * tolerate `liveAgent === undefined` in their handlers.
 *
 * Exported for the headless suite: the gate is exactly where a sessionless
 * command silently starts creating sessions again.
 */
export const SESSIONLESS_COMMANDS = new Set([
  'display', 'exit', 'focus', 'footer', 'settings', 'help', 'attach', 'image', 'login', 'logout', 'model', 'reload',
  'sessions', 'resume', 'search', 'new', 'fork', 'rewind', 'preset', 'keybindings', 'plugins',
  // `/statusline` is the approved alias of `/footer` (same configurator,
  // other-agent muscle memory) — it rides the same ownership sets, so it
  // executes locally, never steers, and works before any session exists.
  'statusline',
])

/**
 * The LOCAL-execute command set: TUI-owned UI/control commands AND core
 * control commands the TUI does not itself register (e.g. /kill) that
 * must ALWAYS run locally through the commands service, never steered,
 * regardless of the busyEnter preference. Everything NOT in this set —
 * plain prompts AND non-local commands (the per-skill slash commands like
 * /grilling or /matrix-cli) — flows through the busy-Enter submission
 * policy while the agent is running: web parity, where a skill invocation
 * is a plain `session.prompt` whose leading `/name` line the host's
 * pre-step listener (dsh-tool-skill) resolves into the injected skill
 * body — there is no command-execution wire for skills.
 */
export const LOCAL_COMMANDS = new Set([
  'copy', 'display', 'exit', 'export', 'focus', 'footer', 'fork', 'help', 'attach', 'image', 'keybindings', 'kill', 'login', 'logout',
  'model', 'new', 'preset', 'plugins', 'quit', 'reload', 'rename', 'resume', 'rewind',
  'search', 'sessions', 'settings', 'skill', 'status', 'subagents', 'tasks',
  'title', 'transcript', 'yolo',
  // `/statusline` — the approved alias of `/footer` (see its registration
  // comment: the near-synonym rule stays, this pairing is an explicit
  // alias, and `/status` keeps priority matching).
  'statusline',
])

/**
 * Command semantics matrix (plan §19.3/M12): a LOCAL command line carrying a
 * staged image placeholder is REJECTED — local commands are pure UI
 * controls, never LLM prompts. AGENT-FACING input (plain prompts AND
 * per-skill slash invocations like `/grilling`) SUPPORTS images: the skill
 * wrapper builds its message through the same prepared-input path, so an
 * image-bearing skill line is a real multimodal prompt (review finding 4).
 * There is never a silent drop.
 * @param parsed - the parsed slash command, undefined for a plain prompt.
 * @param text - the submission text.
 * @param store - the live draft store.
 * @param isLocal - whether THIS LINE is a LOCAL (TUI-owned/UI) command; skill
 *   names answer false. Never derived from the name alone: a host command's
 *   input KIND decides which line it claims (see
 *   {@link commandIsLocalForAttachments}).
 */
export function commandRejectsImages(
  parsed: { name: string; rawInput?: string } | undefined,
  text: string,
  store: import('./image/types.ts').DraftImageStoreLike,
  isLocal: boolean,
): boolean {
  return parsed !== undefined && isLocal && draftHasImages(text, store)
}

/**
 * The STATIC host-owned command catalog (P1-04): the ownership sets
 * (LOCAL_COMMANDS and SESSIONLESS_COMMANDS — the TUI's own local/UI command
 * names, including the ones `registerTuiCommands` registers, plus core
 * commands such as /kill that the TUI does not register but dispatches
 * locally) and `/plan`. A plugin command contribution is validated against
 * this fixed catalog at register time: an exact or near-synonym collision is
 * rejected loudly, so a plugin can never shadow a built-in command. Names
 * that only the CURRENT host catalog owns (session-scoped or dynamically
 * registered commands) are not in this set — those collisions surface at
 * candidate synthesis time instead.
 */
export const HOST_COMMAND_CATALOG: ReadonlySet<string> = new Set([
  ...LOCAL_COMMANDS,
  ...SESSIONLESS_COMMANDS,
  // `/plan` is handled specially by the runner (bare form toggles plan mode)
  // and must remain host-owned even though it is not registered by the TUI
  // command list.
  'plan',
])

/**
 * The TUI-local classification the attachment gate uses: a TUI/core local
 * command or a live client command contribution is LOCAL (its line is a UI
 * control — attachments are refused), while a LIVE skill wrapper is
 * AGENT-FACING input (multimodal) even when a client contribution shares its
 * name: the wrapper route outranks the contribution everywhere.
 * @param name - the slash name.
 * @param isSkillWrapper - the live skill-wrapper test (absent = none).
 * @param isDynamicLocal - the live client-contribution test (absent = none).
 * @param hostView - the host catalog's view of THIS LINE (`undefined` = the
 *   catalog does not resolve the name at all; see {@link HostCommandClaim}).
 *   A name the catalog RESOLVES is never a client-local line: when the
 *   catalog claims the line the host's own `input.attachments` declaration
 *   decides, and when it does not (an argued line of an execute-kind
 *   command) the line is an ordinary submission — never a same-named client
 *   contribution's.
 */
export function isLocalCommandLine(
  name: string,
  isSkillWrapper: ((name: string) => boolean) | undefined,
  isDynamicLocal: ((name: string) => boolean) | undefined,
  hostView?: HostCommandClaim | undefined,
): boolean {
  // A TUI-owned name is local no matter what the host catalog holds: the
  // dispatch excludes LOCAL_COMMANDS from the host route, so the
  // classification must not claim a host authority the route never grants.
  if (LOCAL_COMMANDS.has(name)) return true
  if (isSkillWrapper?.(name) === true) return false
  if (hostView !== undefined) return false
  return isDynamicLocal?.(name) ?? false
}

/**
 * Whether one parsed line is the BARE slash token (DSH `matchEnter`'s `bare`:
 * no input follows the name — trailing whitespace is not input). It is the
 * whole difference between a command invocation and an ordinary submission
 * for the NAME-keyed client routes: a client command contribution claims the
 * bare token only, exactly like an execute-kind host command.
 * @param parsed - the parsed slash command.
 * @returns whether the line carries no input after the command name.
 */
export function isBareCommandLine(parsed: { name: string; rawInput?: string }): boolean {
  return (parsed.rawInput?.trim() ?? '') === ''
}

/**
 * The attachment gate's local-command classification for ONE parsed line —
 * the SINGLE classification the dispatch and its regression tests share, and
 * the DSH client namespace order applied to a LINE:
 * - a TUI/core local command is local;
 * - `/skill <name> ...` and a LIVE skill wrapper are agent-facing
 *   (multimodal) even when a client contribution shares the name;
 * - a name the HOST catalog RESOLVES is never local: when the catalog claims
 *   the line, the claiming descriptor's `input.attachments` declaration
 *   decides (`/goal <objective>` is claimed), and when it does not (an argued
 *   line of an execute-kind command, `/compact extra`) the line is an
 *   ordinary submission — never a command and never a same-named client
 *   contribution's;
 * - everything else follows the live client contribution of that name — for
 *   the BARE token only: a contribution claims `/name`, so an argued line
 *   (`/deploy explain`) is an ordinary multimodal submission that keeps its
 *   attachments.
 * @param parsed - the parsed slash command (undefined = plain prompt).
 * @param isSkillWrapper - the live skill-wrapper test (absent = none).
 * @param isDynamicLocal - the live client-contribution test (absent = none).
 * @param hostClaim - the live HOST-catalog view of THIS LINE (absent = none).
 * @returns whether the line is a local command line.
 */
export function commandIsLocalForAttachments(
  parsed: { name: string; rawInput?: string } | undefined,
  isSkillWrapper: ((name: string) => boolean) | undefined,
  isDynamicLocal: ((name: string) => boolean) | undefined,
  hostClaim?: ((parsed: { name: string; rawInput?: string }) => HostCommandClaim | undefined) | undefined,
): boolean {
  if (parsed === undefined) return false
  // `/skill <name> ...` is agent-facing (loadSkill owns it) even though the
  // bare `/skill` picker is a TUI-local command.
  if (parsed.name === 'skill' && (parsed.rawInput?.trim() ?? '') !== '') return false
  // The host catalog's view of THIS LINE outranks a same-named client
  // contribution, exactly like the dispatch's namespace order; the
  // contribution term itself is asked for a BARE line alone (DSH `matchEnter`).
  return isLocalCommandLine(
    parsed.name,
    isSkillWrapper,
    isBareCommandLine(parsed) ? isDynamicLocal : undefined,
    hostClaim?.(parsed),
  )
}

/**
 * The TUI dispatch boundary's delivery resolution: the WEB composer policy
 * ({@link resolveComposerDelivery}) applied to agent-facing input, with the
 * TUI's own ownership terms on top. Pure so the dispatch gate (inside the
 * runner closure) is testable headless.
 * @param parsed - the parsed slash command, undefined for a plain prompt.
 * @param running - whether the live agent reports running.
 * @param gesture - the composer gesture that raised the submission.
 * @param busyEnter - the persisted preference value (''/undefined = queue).
 */
export function resolveSubmitDelivery(
  parsed: { name: string; rawInput?: string } | undefined,
  running: boolean,
  gesture: ComposerSubmitGesture,
  busyEnter: string | undefined,
): SubmitDelivery {
  if (parsed !== undefined) {
    // `/skill <name> [args...]` is an AGENT-facing invocation (loadSkill),
    // NOT the local picker: it follows the busy policy like any other
    // prompt. Only the bare `/skill` picker counts as local (review finding
    // — same classification as the image-rejection gate).
    if (parsed.name === 'skill' && (parsed.rawInput?.trim() ?? '') !== '') return resolveComposerDelivery(running, gesture, busyEnter)
    // A TUI-owned local command executes through its own surface and never
    // steers; its delivery value is only ever a placeholder for the (never
    // taken) skill-delivery binding. Client contributions never reach this
    // resolver at all (the namespace dispatch routes them first).
    if (LOCAL_COMMANDS.has(parsed.name)) return 'queue'
  }
  return resolveComposerDelivery(running, gesture, busyEnter)
}

/**
 * Normalize an explicit `/skill <name> <args>` invocation to the skill's
 * own slash line `/<name> <args>` (review finding 2). The harness's
 * explicit skill gesture scans for `/<skill-name>` — it would extract
 * `skill` from a raw `/skill grilling ...` line and never inject the
 * grilling body. The command handler already performs this conversion
 * (`loadSkill` builds `'/' + skill.name + ' ' + args`); the busy-Enter
 * steer path must use the SAME normalized line so the body injects and
 * any image placeholders ride along.
 * @param text - the submitted line.
 * @returns the normalized `/<name> <args>` line, or undefined when the
 *   line is not an explicit skill invocation (plain prompt, other
 *   commands, or the bare `/skill` picker).
 */
export function normalizeSkillInvocation(text: string): string | undefined {
  const parsed = parseCommand(text)
  if (parsed?.name !== 'skill') return undefined
  // Only the SEPARATOR whitespace is trimmed (the rawInput starts after
  // the command name): the argument text — INCLUDING its trailing
  // whitespace — travels verbatim (the skill-invocation contract).
  const raw = parsed.rawInput.trimStart()
  if (raw === '') return undefined
  const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/.exec(raw)
  if (match === null) return undefined
  const name = match[1]!
  const args = match[2]
  return args === undefined || args.trim() === '' ? `/${name}` : `/${name} ${args.trimStart()}`
}

/**
 * The advertised-claim miss decision (pure, exported for the headless
 * suite): a slash input whose name was advertised by the completion list at
 * submit time but that the REAL session's catalog lacks is CONSUMED with an
 * explicit error — never sent to the model as a plain user message. An
 * unadvertised miss keeps the existing plain-input fallback (the user may
 * deliberately send slash text to the model).
 * @param execution - the settled `commands.execute` outcome.
 * @param wasAdvertised - whether the submission was an advertised command
 *   INVOCATION: the submit-time name claim AND the command plane's final
 *   ownership of the line (an argued line of an execute-kind command never
 *   reached the plane, so it is an ordinary submission).
 * @returns whether the miss must be consumed as an advertised miss.
 */
export function shouldConsumeAdvertisedMiss(
  execution: { readonly result: unknown } | undefined,
  wasAdvertised: boolean,
): boolean {
  return execution === undefined && wasAdvertised
}
/**
 * Whether a plain submitted draft is the quit word: exactly `exit` (trimmed,
 * lowercase). The runner intercepts this BEFORE any session creation or
 * submission (shell muscle memory); anything else — `exit!`, `Exit`, or a
 * draft with a recalled entry still in it — is an ordinary message.
 * @param text - the submitted draft.
 */
export function isPlainExitPrompt(text: string): boolean {
  return text.trim() === 'exit'
}
/** Shell commands the approval dialog flags as dangerous (kimi-inspired). */
const DANGER_PATTERNS: readonly RegExp[] = [
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+if=.*of=\/dev\//,
  /^:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/,
  /\bchmod\s+-R\s+777\s+\//,
  /\bgit\s+push\b[^\n|;]*(--force\b|\s-f\b)/,
  /\b(shutdown|reboot|poweroff|init\s+0)\b/,
  />+\s*\/dev\/sd/,
  /\bcurl\b[^\n|]*\|\s*(ba)?sh\b/,
]

/**
 * Whether a shell command matches a destructive pattern. `rm` is treated
 * specially: any spelling of recursive + force flags (`rm -rf`, `rm -r -f`,
 * `rm -rf /`) is dangerous; the remaining patterns are verbatim matches.
 */
export function dangerCommand(command: string): boolean {
  // Slice the flags from the WORD-BOUNDED rm match itself: slicing from the
  // first "rm" substring (e.g. inside "alarm") would read flags from the
  // wrong offset and both miss and misfire depending on what follows.
  const rm = /\brm\b/i.exec(command)
  if (rm !== null) {
    const flags = command.slice(rm.index + rm[0].length)
    const combined = flags.match(/-\w+/g)?.join('') ?? ''
    if (combined.includes('r') && combined.includes('f')) return true
  }
  return DANGER_PATTERNS.some(pattern => pattern.test(command))
}
