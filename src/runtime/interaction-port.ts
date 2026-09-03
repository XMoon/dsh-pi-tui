/**
 * The interaction domain port (M1.6, contract-reviewed round 4) — the
 * semantic contract between the TUI and Host-side approval/question
 * authority (approval requests, the interactive question provider, the
 * approval policy). Implemented by `src/runtime/direct/` (Direct) today
 * and by a Remote adapter in a later milestone. The port owns the
 * REGISTRATION channels; the listeners/providers stay runner-owned (they
 * render through TuiApp), so the port is the boundary — never a callback
 * serializer.
 *
 * The contract is TRANSPORT-NEUTRAL:
 *
 * - `setApprovalPolicy` addresses the session by id (a Remote adapter maps
 *   it to the official wire capability; the Direct adapter resolves the
 *   live Agent internally). Never a Host Agent object across the port.
 * - `ApprovalRequestLike` is the SUB-SET of the official ApprovalRequest
 *   the TUI actually consumes (signal / callId / toolName / reason) — the
 *   official type also carries a same-process `agent`, which a Remote
 *   backend would never have (its pending interaction is the
 *   identity-based PendingWait). The Direct adapter adapts the real
 *   ApprovalRequest onto this shape; the listener stays Host-free.
 * - `registerQuestionProvider` uses the official provider type — the
 *   question provider is a pure data-in/data-out contract.
 *
 * Plan review rides the same channels; no separate method.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/interaction-port
 */

import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'

/** The DSH 0.1.2 user-question waterfall provider contract. */
export type UserQuestionProvider = (
  request: AskUserQuestionRequestEvent,
  next: () => Promise<AskUserQuestionAnswer>,
) => Promise<AskUserQuestionAnswer>

/** The sub-set of the official approval request the TUI consumes — the
 * transport-neutral shape (no same-process Agent). A Remote backend maps
 * its PendingWait onto this; the Direct adapter maps the official
 * ApprovalRequest. */
export interface ApprovalRequestLike {
  signal?: AbortSignal
  callId?: string
  /** The tool asking for permission (the TUI renders the prompt for it). */
  toolName: string
  reason?: string
}

/** The approval request listener (the TUI answers through its prompt). */
export type ApprovalRequestListener = (
  request: ApprovalRequestLike,
  next: unknown,
) => unknown

/** The interaction domain port. */
export interface InteractionPort {
  /** Register the TUI as the interactive question provider. `false` = the
   * questions service is absent. */
  registerQuestionProvider(provider: UserQuestionProvider): boolean
  /** Subscribe to approval requests. The listener renders the approval
   * prompt and returns the outcome. */
  onApprovalRequest(listener: ApprovalRequestListener): void
  /** Set the approval policy for a SESSION (identity-based). `false` = the
   * approval service or the session is unavailable. The Direct adapter
   * resolves the live Agent internally. */
  setApprovalPolicy(sessionId: string, policy: ApprovalPolicy): boolean
}