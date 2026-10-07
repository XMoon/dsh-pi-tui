/**
 * The transport/UI-neutral command-line policy (plan §27 / TS8-F3): which slash
 * lines the TUI owns locally, which need no session, which lines are local for
 * attachment purposes, and the ONE semantic line classification every dispatch
 * gate consumes.
 *
 * Pure and Host-free (structural inputs plus DSH's own `parseCommand`), so the
 * dispatch gates are testable headless and the presentation/submission paths
 * share ONE classification. The application/submission-facing half (the
 * image-rejection gate and the delivery resolver) lives in
 * `app/submission/command-policy.ts`; the destructive-shell predicate lives in
 * `domain/shell/danger.ts`.
 *
 * The AUTHORITATIVE Host-name fact stays an explicit input
 * ({@link CommandLineClassificationFacts.hostOriginClaim}); this domain never
 * derives Host authority from the effective claim union (which also carries the
 * Client's own TUI registrations).
 * @module @xmoon76/dsh-pi-tui/domain/command/policy
 */

import { parseCommand } from '@deepseek-ai/dsh-commands'
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
  // `/quit` is `/exit`'s canonical command alias (the runner registers
  // /exit → /quit); before a session exists both must exit WITHOUT creating
  // one — the alias must not silently drift out of the sessionless set
  // (PR5 supplement §6: sessionless alias parity, locked by the policy
  // guard test).
  'quit',
  // `/statusline` is the approved alias of `/footer` (same configurator,
  // other-agent muscle memory) — it rides the same ownership sets, so it
  // executes locally, never steers, and works before any session exists.
  'statusline',
])

/**
 * The LOCAL-execute command set (PR5 v2 §1C-6 narrows its semantic role):
 * TUI-owned UI/control names AND core control names the TUI dispatches but
 * does not register (/kill). It remains the STATIC policy surface —
 * reserved-name validation, the extension collision catalog
 * (HOST_COMMAND_CATALOG), and the fallback term of the line classifier
 * when no LIVE Client-registry test was supplied. It is NOT by itself an
 * answer to "who owns this production line": ownership comes from the
 * live sources (the genuine Host-origin descriptors, the Client registry,
 * the extension registry, the skill-wrapper state) through
 * {@link classifyCommandLine}.
 *
 * `/kill` is the explicit example of the rule and its DISPOSITION is
 * deliberate: it has NO live Client registration (and no handler anywhere in
 * this surface), so it is NOT a TUI-owned line and this set must never be
 * consulted to decide ownership. What actually happens to a typed `/kill ...`
 * follows the ordinary precedence, in this order: a genuine Host claim decides
 * per that descriptor; a genuine Host NAME that resolves while its exact line
 * is NOT claimed makes the line an ordinary submission; and only a name
 * nothing owns keeps the command plane's resolution chance (the final,
 * session-scoped catalog may still provide it). It stays in this set for
 * reserved-name validation and the extension collision catalog only.
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
 * PR5 v2 §1C-5: ONE semantic classification of a parsed slash line. Every
 * sibling consumer (busy delivery, early echo, attachment policy, the
 * command-plane route, the Host-vs-Client collision decision) consumes THIS
 * result instead of independently re-inferring authority from registry
 * membership, claim unions or static name lists.
 */
export type CommandLineClassification =
  | { readonly kind: 'host-command'; readonly attachments: boolean }
  | { readonly kind: 'client-command'; readonly source: 'tui' | 'extension' }
  | { readonly kind: 'skill-invocation' }
  | { readonly kind: 'ordinary-submission'; readonly hostNameReserved: boolean }

/** The Host-origin claim of one exact line as this neutral domain sees it:
 * `undefined` = no genuine Host command owns the name; `claimed:false` = Host
 * owns the name but not this line. The stable root's `HostCommandClaim` is
 * structurally identical, so callers pass it without a cast. */
export type CommandLineHostClaim =
  | { readonly claimed: true; readonly attachments: boolean }
  | { readonly claimed: false }

/** The classifier input facts (each one a LIVE source observation — never a
 *  reconstructed name-list guess). */
export interface CommandLineClassificationFacts {
  /** The genuine Host-origin claim of this exact line (§1C-4
   *  `hostOriginClaimOf`): `undefined` = no genuine Host command owns the
   *  name; `claimed:false` = Host owns the name but not this line. */
  readonly hostOriginClaim: CommandLineHostClaim | undefined
  /** Whether a LIVE TUI-owned Client command registration owns the name
   *  (the Client registry itself — a bare-line invocation shape). */
  readonly tuiCommand: boolean
  /** The extension contribution of a BARE line, when one is live. */
  readonly extensionCommand: boolean
  /** Whether this line is an agent-facing skill invocation: `/skill <name>`
   *  with arguments, or a live dynamic skill wrapper (`/<skill-name> ...`). */
  readonly skillInvocation: boolean
}

/**
 * Classify ONE parsed slash line (PR5 v2 §1C-5). Precedence:
 *
 *   1. genuine Host-origin name exists
 *        claimed line   -> host-command (the HOST descriptor's attachments)
 *        unclaimed line -> ordinary-submission (hostNameReserved: a
 *                          same-name Client registration never takes the
 *                          argued line of a genuine Host command)
 *   2. no genuine Host-origin name
 *        TUI Client registration (bare shape) -> client-command (tui)
 *        extension contribution (bare shape)  -> client-command (extension)
 *        skill invocation                     -> skill-invocation
 *        otherwise                            -> ordinary-submission
 *
 * `skillInvocation` must already encode the split semantics: the BARE
 * `/skill` picker is NOT a skill invocation (it classifies through
 * `tuiCommand`), while `/skill <name>` and dynamic wrappers are.
 */
export function classifyCommandLine(facts: CommandLineClassificationFacts): CommandLineClassification {
  const claim = facts.hostOriginClaim
  if (claim !== undefined) {
    return claim.claimed
      ? { kind: 'host-command', attachments: claim.attachments === true }
      : { kind: 'ordinary-submission', hostNameReserved: true }
  }
  if (facts.tuiCommand) return { kind: 'client-command', source: 'tui' }
  if (facts.extensionCommand) return { kind: 'client-command', source: 'extension' }
  if (facts.skillInvocation) return { kind: 'skill-invocation' }
  return { kind: 'ordinary-submission', hostNameReserved: false }
}

/**
 * The TUI-local classification the attachment gate uses: a TUI/core local
 * command or a live client command contribution is LOCAL (its line is a UI
 * control — attachments are refused), while a LIVE skill wrapper is
 * AGENT-FACING input (multimodal) even when a client contribution shares its
 * name: the wrapper route outranks the contribution everywhere.
 * @param name - the slash name.
 * @param isSkillWrapper - the live skill-wrapper test (absent = none).
 * @param isDynamicLocal - the live client-contribution test (absent = none).
 * @param hostResolvesName - whether the AUTHORITATIVE HOST CATALOG resolves
 *   the NAME (PR5 supplement: derived from `hostCatalogResolves`, NEVER from
 *   the effective line claim — the claim-set union also carries this
 *   Client's own TUI registrations, so a self-claim must not disqualify the
 *   TUI's own local commands). A Host-resolved name is never a client-local
 *   line: when the catalog claims the line the host's own
 *   `input.attachments` declaration decides, and when it does not (an argued
 *   line of an execute-kind command) the line is an ordinary submission —
 *   never a same-named client contribution's.
 */
export function isLocalCommandLine(
  name: string,
  isSkillWrapper: ((name: string) => boolean) | undefined,
  isDynamicLocal: ((name: string) => boolean) | undefined,
  hostResolvesName: boolean,
): boolean {
  // §D3 line authority (review round 2) + the PR5 supplement authority
  // correction: a HOST-RESOLVED name is never TUI-local — not when the
  // catalog CLAIMS the line (a Host command invocation) and not when it
  // resolves the name without claiming THIS line (an argued `/export foo`
  // of an execute-kind Host command is an ORDINARY submission, matching the
  // dispatch's commandPlaneOwnsLine order). Only a name the AUTHORITATIVE
  // host catalog does not resolve falls through to the Client-owned terms —
  // the discriminator is NAME authority (`hostCatalogResolves`), never the
  // effective line claim (a TUI built-in's own Client registration appears
  // in the claim-set union and must not read as Host territory).
  if (hostResolvesName) return false
  if (LOCAL_COMMANDS.has(name)) return true
  if (isSkillWrapper?.(name) === true) return false
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
 * @param hostResolvesName - whether the AUTHORITATIVE HOST CATALOG resolves
 *   the name (`hostCatalogResolves` — PR5 supplement: never derived from the
 *   effective line claim, whose union carries the Client's own TUI
 *   registrations).
 * @returns whether the line is a local command line.
 */
export function commandIsLocalForAttachments(
  parsed: { name: string; rawInput?: string } | undefined,
  isSkillWrapper: ((name: string) => boolean) | undefined,
  isDynamicLocal: ((name: string) => boolean) | undefined,
  hostResolvesName: boolean,
): boolean {
  if (parsed === undefined) return false
  // `/skill <name> ...` is agent-facing (loadSkill owns it) even though the
  // bare `/skill` picker is a TUI-local command.
  if (parsed.name === 'skill' && (parsed.rawInput?.trim() ?? '') !== '') return false
  // The host catalog's NAME authority outranks a same-named client
  // contribution, exactly like the dispatch's namespace order; the
  // contribution term itself is asked for a BARE line alone (DSH `matchEnter`).
  return isLocalCommandLine(
    parsed.name,
    isSkillWrapper,
    isBareCommandLine(parsed) ? isDynamicLocal : undefined,
    hostResolvesName,
  )
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
