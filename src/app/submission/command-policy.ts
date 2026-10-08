/**
 * The application/submission-facing command policy (TS8-F3): which parsed
 * lines refuse staged images and how one agent-facing line is delivered while
 * the agent runs.
 *
 * These consume ACTUAL submission/composer facts — the Client draft store, the
 * parsed line, the live running state and the composer gesture — so they stay
 * application ownership; they must not move into the neutral command domain,
 * which would drag Client draft state or presentation vocabulary into it. The
 * pure line classification they build on lives in `domain/command/policy.ts`.
 * @module @xmoon76/dsh-pi-tui/app/submission/command-policy
 */

import { resolveComposerDelivery, type SubmitDelivery } from '../../commands.ts'
import type { ComposerSubmitGesture } from '../../tui-app.ts'
import { draftHasImages } from '../../client/media/draft-attachments.ts'
import { LOCAL_COMMANDS } from '../../domain/command/policy.ts'

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
  store: import('../../client/media/image/types.ts').DraftImageStoreLike,
  isLocal: boolean,
): boolean {
  return parsed !== undefined && isLocal && draftHasImages(text, store)
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
 * @param isTuiLocalLine - whether the line is a TUI-LOCAL command line by
 *   the §D3 line authority ({@link isLocalCommandLine}'s order: a
 *   HOST-RESOLVED name — claimed or merely resolved — is never local). The
 *   caller derives it once and shares it with every gate, so an argued
 *   `/export foo` of an execute-kind Host command follows the ORDINARY
 *   queue/steer busy policy instead of a local-command placeholder.
 *   Absent = fall back to the legacy LOCAL_COMMANDS set (callers that have
 *   no host view yet, e.g. the pre-parse echo path).
 */
export function resolveSubmitDelivery(
  parsed: { name: string; rawInput?: string } | undefined,
  running: boolean,
  gesture: ComposerSubmitGesture,
  busyEnter: string | undefined,
  isTuiLocalLine?: boolean,
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
    if (isTuiLocalLine ?? LOCAL_COMMANDS.has(parsed.name)) return 'queue'
  }
  return resolveComposerDelivery(running, gesture, busyEnter)
}
