/**
 * The Direct subagent adapter (M1.2) — the in-process implementation of
 * `SubagentPort` over the dsh `ctx.subagents` official control surface.
 * This is the ONLY module in the subagent prompt path that touches `ctx`;
 * the runner depends on the port, and a Remote adapter will implement the
 * same interface (a 1:1 mapping of the official `subagent.prompt` remote)
 * in a later milestone.
 *
 * The service is read lazily per call (never at construction), so a
 * session switch / teardown between calls is observed at send time. The
 * requestId is minted here — one UUID per human submit, before the call —
 * reusing the bundle's standard `randomUUID` identity vocabulary so a
 * future Remote backend can mint the same ids client-side.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/subagent-direct
 */

import { randomUUID } from 'node:crypto'
import { submitSubagentPrompt, type SubagentPromptService } from '../../subagent-viewer-submit.ts'
import type { SubagentPromptContext, SubagentPort } from '../subagent-port.ts'
import type { SubagentPromptOutcome } from '../../subagent-viewer-submit.ts'
import type { SubagentViewerSubmitRequest } from '../../subagent-viewer-submit.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the service resolves from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
}

/** The Direct backend's subagent port: the official
 * `ctx.subagents.prompt(...)` behind the semantic `SubagentPort`
 * interface. */
export class DirectSubagentPort implements SubagentPort {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  prompt(
    request: SubagentViewerSubmitRequest,
    context: SubagentPromptContext,
  ): Promise<SubagentPromptOutcome> {
    return submitSubagentPrompt(request, {
      // Lazy per-call read: the continuation runtime may appear/disappear
      // between calls (draining / activation disposal).
      subagents: () => this.ctx.get('subagents') as SubagentPromptService | undefined,
      makeSignal: context.makeSignal,
      // One fresh caller-minted identity per human submit, minted before
      // the call (a retry that represents a NEW submit mints a new id).
      mintRequestId: () => randomUUID(),
      canonicalizeText: context.canonicalizeText,
    })
  }
}
