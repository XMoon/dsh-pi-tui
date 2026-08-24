/**
 * The Direct subagent adapter (M1.2) — the in-process implementation of
 * `SubagentPort` over the dsh `ctx.subagents` service. This is the ONLY
 * module in the subagent follow-up path that touches `ctx`; the runner
 * depends on the port, and a Remote adapter will implement the same
 * interface in a later milestone.
 *
 * The service is read lazily per call (never at construction), so a
 * session switch / teardown between calls is observed at send time — the
 * same semantics the runner's inline wiring had.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/subagent-direct
 */

import { submitSubagentFollowup, type SubagentFollowupService } from '../../subagent-viewer-submit.ts'
import type { SubagentFollowupContext, SubagentPort } from '../subagent-port.ts'
import type { SubagentViewerSubmitRequest } from '../../subagent-viewer-submit.ts'
import type { SubagentFollowupOutcome } from '../../subagent-viewer-submit.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the service resolves from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
}

/** The Direct backend's subagent port: `ctx.subagents.followup(...)` behind
 * the semantic `SubagentPort` interface. */
export class DirectSubagentPort implements SubagentPort {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  followup(
    request: SubagentViewerSubmitRequest,
    context: SubagentFollowupContext,
  ): Promise<SubagentFollowupOutcome> {
    return submitSubagentFollowup(request, {
      currentParent: context.currentParent,
      // Lazy per-call read: the continuation runtime may appear/disappear
      // between calls (draining / activation disposal).
      subagents: () => this.ctx.get('subagents') as SubagentFollowupService | undefined,
      makeSignal: context.makeSignal,
      makeSource: context.makeSource,
      canonicalizeText: context.canonicalizeText,
    })
  }
}
