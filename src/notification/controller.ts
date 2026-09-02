/**
 * The completion-notification controller (plan §7): the state machine
 * that decides WHEN the main agent's settlement deserves a terminal
 * notification. It consumes the authoritative DSH runtime fact
 * (`agent/status` — `running` ⇄ `idle` on the SAME live main agent) and
 * NEVER guesses settlement from `turn/end`, timers, debounces or event
 * recency: a turn can end into compaction, a queued continuation can
 * start a new turn, and an internal retry can keep the driver alive —
 * only the agent's own `running → idle` transition is the settled
 * boundary.
 *
 * Rules:
 * - identity-fenced: only the CURRENT live main agent's transitions
 *   count (a late idle from a switched-away session/agent is inert);
 * - `observed running → idle` is required — a resume of an already-idle
 *   session never notifies;
 * - mode `off` never notifies; `always` notifies on every settle;
 *   `unfocused` (default) notifies only while the terminal is
 *   unfocused;
 * - child/subagent transitions never notify (their agent id is not the
 *   live main agent's).
 *
 * The controller is pure state + a sink: the runner wires the sink to
 * the TerminalNotifier (with the current method) and feeds focus
 * reports, settings and live-agent identity changes in.
 * @module @xmoon76/dsh-pi-tui/notification-controller
 */

import type { NotificationMode, NotificationMethod } from './settings.ts'
import type { TerminalFocusState } from './terminal-focus.ts'

/** The agent lifecycle status the controller consumes. Structurally the
 * DSH public `AgentStatus` ('idle' | 'running') — declared locally so
 * this Client-side state machine never imports a Host package (the
 * client-boundary gate). */
export type AgentLifecycleStatus = 'idle' | 'running'

/** The notification sink: receives the effective method plus the fixed
 * v1 copy (title/body). The runner maps it to the terminal backend. */
export interface CompletionNotificationSink {
  (method: NotificationMethod, title: string, body: string): void
}

/** The fixed v1 copy (plan §6.2): no dynamic session title — fetching
 * one would add async/races/backend coupling, and a fixed string is the
 * safest OSC payload. */
export const NOTIFICATION_TITLE = 'DSH'
export const NOTIFICATION_BODY = 'Turn complete'

/**
 * The completion-notification state machine. One instance per runner
 * mount; reset on every live-agent identity commit.
 */
export class CompletionNotificationController {
  private liveAgentId: string | undefined
  private previousStatus: AgentLifecycleStatus | undefined
  private seenRunning = false
  private focus: TerminalFocusState = 'focused'
  private mode: NotificationMode = 'unfocused'
  private method: NotificationMethod = 'auto'
  private readonly sink: CompletionNotificationSink

  constructor(sink: CompletionNotificationSink) {
    this.sink = sink
  }

  /** Commit a live-agent identity change (startup resume, session
   * switch, new/fork/rewind): the whole completion state resets, so a
   * resumed idle session or a late event from the previous agent can
   * never notify. */
  setLiveAgent(agentId: string | undefined): void {
    this.liveAgentId = agentId
    this.previousStatus = undefined
    this.seenRunning = false
  }

  /** The terminal focus state (fed from the app's focus reports). */
  setFocus(state: TerminalFocusState): void {
    this.focus = state
  }

  /** The notification mode (fed from the persisted settings). */
  setMode(mode: NotificationMode): void {
    this.mode = mode
  }

  /** The notification method (fed from the persisted settings). */
  setMethod(method: NotificationMethod): void {
    this.method = method
  }

  /** One `agent/status` transition. Only the CURRENT live main agent's
   * `running → idle` forms a completion candidate. */
  onAgentStatus(agentId: string, status: AgentLifecycleStatus): void {
    if (agentId !== this.liveAgentId) return
    if (status === 'running') {
      this.previousStatus = 'running'
      this.seenRunning = true
      return
    }
    // idle: a candidate only when THIS agent was observed running.
    const settled = this.previousStatus === 'running' && this.seenRunning
    this.previousStatus = 'idle'
    if (!settled) return
    this.maybeNotify()
  }

  private maybeNotify(): void {
    if (this.mode === 'off') return
    if (this.mode === 'unfocused' && this.focus !== 'unfocused') return
    this.sink(this.method, NOTIFICATION_TITLE, NOTIFICATION_BODY)
  }
}
