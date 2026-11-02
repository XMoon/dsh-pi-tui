/**
 * The `/reload-client` request owner (M4 PR4): the ONE place the Client-local
 * safety facts are merged and the process-owned reexec request is invoked.
 *
 * The factory exists so the composition root keeps a LIVE fact read (every
 * getter runs at gesture time, never cached at registration) while the same
 * merge/sink order is directly testable against the real owners. It performs
 * no IO and owns no state: `facts` are the owning live sources, `request` is
 * the process entry's ONE synchronous request.
 *
 * The decision and the request MUST stay in one synchronous call stack: an
 * `await` here would admit new local input after the gate passed.
 *
 * @module @xmoon76/dsh-pi-tui/app/command/client-reload
 */

import type { ClientReloadRequestResult } from '../application-runtime.ts'
import { clientReloadRefusal } from '../remote-process/client-reload-safety.ts'
import type { ClientReloadCommandResult } from '../../commands.ts'

/** The live Client-local facts of ONE reload decision, read at gesture time. */
export interface ClientReloadCommandFacts {
  /** A real split-Client process composition with the reexec capability. */
  capable(): boolean
  /** The application surface itself is still alive (not disposed/stopping). */
  ready(): boolean
  /** The exact current Composer text (untrimmed). */
  draftText(): string
  /** The real staged image draft count (pinned/unreferenced included). */
  stagedImageCount(): number
  /** The real staged file draft count. */
  stagedFileCount(): number
  /**
   * An accepted user write is unsettled: a submission/steer/shell/queue
   * lifetime OR a persisted configuration write the config port registered.
   */
  hasUnsettledUserWrite(): boolean
  /** Client-local Question/Approval input is live. */
  hasUnsettledInteraction(): boolean
  /** A Session navigation/transition/Fork is in flight. */
  hasUnsettledTransition(): boolean
}

/** The ONE process request and the live facts it is gated by. */
export interface ClientReloadCommandOptions {
  readonly facts: ClientReloadCommandFacts
  readonly request: () => ClientReloadRequestResult
}

/**
 * Build the synchronous `/reload-client` command entry. A refusal returns its
 * fixed reason without touching the process; only a fully safe Client reaches
 * `request`.
 * @param options - the live fact getters and the process-owned request.
 * @returns the command-facing synchronous request.
 */
export function createClientReloadCommandRequest(
  options: ClientReloadCommandOptions,
): () => ClientReloadCommandResult {
  return () => {
    const reason = clientReloadRefusal({
      capable: options.facts.capable(),
      ready: options.facts.ready(),
      draftText: options.facts.draftText(),
      stagedImageCount: options.facts.stagedImageCount(),
      stagedFileCount: options.facts.stagedFileCount(),
      unsettledUserWrite: options.facts.hasUnsettledUserWrite(),
      unsettledInteraction: options.facts.hasUnsettledInteraction(),
      unsettledTransition: options.facts.hasUnsettledTransition(),
    })
    if (reason !== undefined) return { kind: 'refused', reason }
    return options.request()
  }
}
