/**
 * The application composition root's Host event-subscription installation
 * (TS2 §10).
 *
 * This module owns ONLY the INSTALLATION of the six application-level Host
 * subscriptions and their thin delegation into the already-owned surface
 * routing methods:
 *
 * ```text
 * session/event
 * subagent/start
 * subagent/end
 * agent/status
 * llm/adapters-updated
 * settings/document-updated
 * ```
 *
 * It does not implement event semantics, does not own mutable state, does not
 * read Cordis application services, and does not import the composition facade
 * (`src/app/bootstrap.ts`). The composition root keeps every `ctx.get(...)`
 * service resolution and passes the subscription surface + the owning routing
 * facade in.
 *
 * Branch split (unchanged from the inline wiring): the durable `session/event`
 * firehose and the subagent/agent runtime channels are Direct-only — the Remote
 * branch receives durable events through its own official eventSource ingress,
 * never both. The provider/credential refresh subscriptions are capability-
 * optional and installed on both branches.
 *
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/event-wiring
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * The surface-owned routing entry points the six subscriptions delegate to. A
 * structural seam (not the SurfaceRuntime type) so this helper depends only on
 * the methods it calls.
 *
 * `event: unknown` is the deliberate structural widening that keeps the durable
 * event type at the call site: the ctx.on augmentation types the handler's
 * event as `SessionEvent`, and method-parameter bivariance lets the real
 * surface (`event: SessionEvent`) satisfy this seam without importing a Host
 * package into this module.
 */
export interface ApplicationEventSurface {
  routeSessionEvent(session: { readonly id: string }, event: unknown): void
  routeSubagentLifecycle(): void
  routeAgentStatus(agentId: string, status: string): void
  routeProviderRefresh(): void
  routeSettingsRefresh(namespace: string): void
}

/** The narrow inputs of the application event-wiring install; one lifetime. */
export interface ApplicationEventWiringDeps {
  /** The Cordis context, used ONLY as the literal-event subscription surface. */
  readonly ctx: Context
  /** True on the Direct branch (`remoteSources === undefined`). */
  readonly direct: boolean
  /** The surface routing facade the handlers delegate to. */
  readonly surface: ApplicationEventSurface
}

/**
 * Install the six application-level Host subscriptions exactly once, delegating
 * each event into the surface-owned routing method. No event semantics live
 * here: the handlers forward and return.
 */
export function installApplicationEventWiring(deps: ApplicationEventWiringDeps): void {
  const { ctx, direct, surface } = deps
  // Direct branch: the Host firehose registration (Remote durable events
  // arrive through the eventSource ingress instead — never both).
  if (direct) {
    ctx.on('session/event', (session, event) => surface.routeSessionEvent(session, event))
  }
  // Subagent lifecycle events drive the continuable-children half of the dock
  // badge (they never register jobs). The events are scoped by the delegating
  // parent, but an UNTAGGED listener (this runner) receives every agent-scoped
  // event — including nested descendants' — so no reachability caveat applies;
  // the tool/call fallback stays as a redundant safety net. These are CATALOG
  // events: membership/tree may have changed, so they re-list (A4-7 surface
  // routing).
  //
  // M3-5 PR2: these are DIRECT Host runtime channels. The Remote Task Center's
  // invalidation is observable-driven through the official Client model
  // (`sessions.list` + `jobs.state`, wired at `attachTasks`), so a Host event
  // must never double as the Remote authority.
  if (direct) {
    ctx.on('subagent/start', () => surface.routeSubagentLifecycle())
    ctx.on('subagent/end', () => surface.routeSubagentLifecycle())
    // `agent/status` is the LIVE runtime channel: a child's driver transition
    // (running ↔ idle) repaints the task browser and the badge WITHOUT a
    // re-listing — membership changes come only from the lifecycle events, and
    // `listDescendants().activity` is store-presence, never execution state).
    // The MAIN agent's transitions feed the completion-notification controller
    // (the authoritative settled boundary — running → idle on the SAME live
    // agent; children never notify). A4-7: the membership gate, the
    // completion-controller feed and the pending-input microtasks are
    // surface-owned (`surface.routeAgentStatus`); the completion-identity
    // provider stays in the composition root.
    ctx.on('agent/status', ({ agent, status }) => surface.routeAgentStatus(agent.id, status))
  }
  // Provider-topology and credential events refresh the footer model row and
  // the welcome card: a /login /logout /add-provider (or an external
  // settings.yaml / .credentials.yaml edit) changes the live provider / model
  // surface, and the status line must not keep showing a stale selection. Both
  // events are capability-optional: an absent llm / settings service never
  // mounts them, and a throwing listener is contained by the event bus (the
  // refresh is best-effort). A4-7: the refresh routing (the cleanup fence, the
  // namespace filter and the refresh coordination) is surface-owned; the
  // registrations and the credential subscription disposal stay runner-owned.
  ctx.on('llm/adapters-updated', () => surface.routeProviderRefresh())
  ctx.on('settings/document-updated', (ns) => surface.routeSettingsRefresh(ns))
}
