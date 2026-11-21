/**
 * Local `!`/`!!` shell card identity.
 *
 * The card PRESENTATION is owned by the transcript renderer in `tui-app.ts`:
 * a folded card is a compact header, the `$ command` row and one settled
 * outcome row. This module deliberately owns only the strict identity
 * predicate, so the local card can never be confused with a real Session
 * `bash`/`pwsh` tool card.
 * @module @xmoon76/dsh-pi-tui/tui/components/transcript/local-shell-card
 */

import type { TranscriptMessage } from '../../../domain/transcript/types.ts'

/** Whether a message is a LOCAL `!`/`!!` shell card (the runner pushes
 * these with the unbounded turn marker; a session tool card never carries
 * it). Local cards are the ONLY message kind the shell display policy
 * applies to — session shell tools keep their own folding rules. */
export function isLocalShellCard(message: TranscriptMessage): boolean {
  return message.kind === 'tool' && message.name === 'shell' && message.turn === Number.POSITIVE_INFINITY
}
