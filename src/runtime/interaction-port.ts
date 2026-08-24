/**
 * The interaction domain port (M1.6) — the semantic contract between the
 * TUI and Host-side approval/question authority (approval requests, the
 * interactive question provider, approval policy), implemented by
 * `src/runtime/direct/` (Direct) today and by a Remote adapter in a later
 * milestone. The port owns the REGISTRATION channels (subscribe to
 * approval requests, register the question provider, set the approval
 * policy); the listeners/providers stay runner-owned (they render through
 * TuiApp), so the port is the boundary — never a callback serializer.
 *
 * The contracts use the OFFICIAL dsh types (type-only imports from the
 * declared peers — the port is the Host boundary, the shapes are Host
 * shapes). Plan review rides the same channels; no separate method.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/interaction-port
 */

import type { ApprovalPolicy, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { UserQuestionProvider } from '@deepseek-ai/dsh-user-questions'

/** The approval request listener (the TUI answers through its prompt). */
export type ApprovalRequestListener = (
  request: ApprovalRequest,
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
  /** Set the approval policy for a live agent. `false` = the approval
   * service is absent. */
  setApprovalPolicy(agent: unknown, policy: ApprovalPolicy): boolean
}