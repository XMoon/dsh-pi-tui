/**
 * Pure presentation identity for the two Agent-authored Context cards.
 *
 * `agent-message`/`relay` and `subagent-settled`/`notice` rows carry the DSH
 * `senderSessionId` of the Agent whose Session produced them (the ONE durable
 * sender authority). This module owns ONLY the display consequences: which
 * exact source/form pairs qualify, which already-proven name to show (a
 * Session title or descendant Catalog label resolved by the application
 * enrichment), the safe short-id fallback, and the two frozen card prefixes.
 *
 * It never performs IO, never parses the DSH body text, never stores state and
 * never rewrites the message. The raw DSH payload (`Agent <id> sent a
 * message: …`, the settlement summary and the expanded body) stays byte for
 * byte; only the one-line card header is affected.
 * @module @xmoon76/dsh-pi-tui/tui/components/transcript/agent-context-title
 */

import { isSurfacedContext } from '../../../domain/transcript/semantics.ts'
import type { TranscriptMessage } from '../../../domain/transcript/types.ts'
import { shortSessionId } from '../../pickers/sessions.ts'
import { sanitizedPhysicalLine } from '../../presentation/lines.ts'

/** The already-proven display names of the senders currently on screen
 * (`senderSessionId` → name). A missing entry is NOT an error: the card falls
 * back to the short Session id it always could show. */
export type SenderLabelLookup = ReadonlyMap<string, string>

/** The two Agent Context cards this identity presentation owns. */
export type AgentContextHeaderKind = 'relay' | 'settled'

/** The frozen English card prefixes (the repository's user-facing language). */
const HEADER_PREFIX: Readonly<Record<AgentContextHeaderKind, string>> = {
  relay: 'Agent message',
  settled: 'Subagent settled',
}

/**
 * Which Agent Context card, if any, one transcript row is.
 *
 * Qualification is the EXACT producer-declared pair: `agent-message` +
 * `relay`, or `subagent-settled` + `notice`. A foreign kind with a relay form
 * (or the reverse) is not an Agent identity row and keeps its original
 * presentation; `subagent-settled` never turns into a generic notice name.
 * @param message - one transcript row.
 */
export function agentContextHeaderKind(message: TranscriptMessage): AgentContextHeaderKind | undefined {
  if (!isSurfacedContext(message)) return undefined
  const presentation = message.contextPresentation
  if (presentation === undefined) return undefined
  if (presentation.sourceKind === 'agent-message' && presentation.form === 'relay') return 'relay'
  if (presentation.sourceKind === 'subagent-settled' && presentation.form === 'notice') return 'settled'
  return undefined
}

/**
 * The display name for one Agent Context card.
 *
 * The caller supplies only names it has already proven (the app/surface
 * enrichment resolves the official Session title first and the descendant
 * Catalog label second). Without one, the established {@link shortSessionId}
 * abbreviation is used — never the full raw UUID as the card identity. Every
 * candidate is sanitized at this presentation boundary; a value that cannot
 * produce any readable name leaves the card's original title in place.
 * @param message - one transcript row.
 * @param labels - the proven sender names for the current presentation subject.
 */
export function agentContextSenderName(
  message: TranscriptMessage,
  labels: SenderLabelLookup,
): string | undefined {
  if (!isSurfacedContext(message)) return undefined
  if (agentContextHeaderKind(message) === undefined) return undefined
  const sender = message.contextPresentation?.senderSessionId
  if (sender === undefined || sender === '') return undefined
  const labelled = labels.get(sender)
  if (labelled !== undefined) {
    const proven = sanitizedPhysicalLine(labelled).trim()
    if (proven !== '') return proven
  }
  const short = sanitizedPhysicalLine(shortSessionId(sender)).trim()
  if (short !== '') return short
  const readable = sanitizedPhysicalLine(sender).trim()
  return readable === '' ? undefined : readable
}

/**
 * The one-line card header for an Agent Context row:
 * `Agent message · <name>` / `Subagent settled · <name>`. The prefix is owned
 * here so the pure title policy and the row components cannot drift.
 * @param kind - the exact Agent Context card kind.
 * @param senderDisplayName - an already-sanitized display name.
 */
export function agentContextHeader(kind: AgentContextHeaderKind, senderDisplayName: string): string {
  return `${HEADER_PREFIX[kind]} · ${senderDisplayName}`
}
