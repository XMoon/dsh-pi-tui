/**
 * The `/settings` Web Search / Fetch credential submenu (S2/PR-B §3.3).
 *
 * It is an ordinary `SettingsList` submenu component: it owns only its
 * interaction, never a write policy. The credential panel only ASKS the caller
 * to start the existing `/login` / `/logout` command path — it never touches a
 * credential itself and never renders a value.
 *
 * Late settles are fenced: a closed/disposed panel never repaints, never calls
 * `done` twice, and never re-opens anything.
 *
 * The rc.1 single-endpoint editor (`WebEndpointPanel`) was retired with rc.2's
 * schema: `web-deepseek-api.baseURL` is no longer a valid field, the YAML-only
 * advanced overrides are read-only facts (see `web-settings-page.ts`), and the
 * only writable API fields are the two official billing enums.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/web-provider-panels
 */

import { matchesKey, truncateToWidth, type Component } from '@xmoon76/pi-tui'
import { color } from '../theme/runtime.ts'

/**
 * One settled-but-not-verified write outcome (§4A.2's frozen vocabulary): the
 * caller that performed the Host mutation decides the WORD, the UI only paints
 * it. `not-saved` = the authority refused or kept another value;
 * `outcome-unknown` = the mutation's result could not be observed.
 */
export class WebWriteVerdictError extends Error {
  readonly verdict: 'not-saved' | 'outcome-unknown'

  constructor(verdict: 'not-saved' | 'outcome-unknown', message: string) {
    super(message)
    this.name = 'WebWriteVerdictError'
    this.verdict = verdict
  }
}

/**
 * The panels never start a promise themselves: every asynchronous operation
 * goes through the caller's owned task entry (the `/settings` command's
 * `detach`), so a failure is owned and reported through the repository's task
 * model instead of a bare fire-and-forget discard.
 */
export type WebPanelTaskRunner = (label: string, task: () => Promise<void>) => void

/** One row of a short fixed panel, rendered without wrapping. */
function row(text: string, width: number): string {
  return truncateToWidth(text, Math.max(1, width))
}

/** One explicit action of the credential panel. */
export interface WebCredentialAction {
  readonly label: string
  readonly description: string
  /** Whether the action is offered right now (e.g. Clear without a value). */
  readonly enabled: boolean
  /** Run after the settings overlay is closed (the /login or /logout path). */
  readonly run: () => void
}

/**
 * The DeepSeek API key panel: presence/source of the official credential
 * reference (NEVER its value) plus the two explicit actions. The state is read
 * fresh when the row opens, so a `/logout` is visible on the next open.
 */
export class WebCredentialPanel implements Component {
  focused = false

  private readonly done: (selected?: string) => void
  private readonly actions: readonly WebCredentialAction[]
  private readonly read: () => Promise<{ configured: boolean; source?: string }>
  private readonly requestRender: () => void
  private readonly runTask: WebPanelTaskRunner
  private readonly reference: string
  private state:
    | { readonly kind: 'reading' }
    | { readonly kind: 'ready'; readonly configured: boolean; readonly source?: string }
    | { readonly kind: 'error'; readonly message: string }
    = { kind: 'reading' }
  private focusedAction = 0
  private settled = false

  constructor(
    done: (selected?: string) => void,
    options: {
      /** The exact credential reference the row configures (shown as text). */
      readonly reference: string
      readonly read: () => Promise<{ configured: boolean; source?: string }>
      readonly actions: readonly WebCredentialAction[]
      readonly requestRender: () => void
      /** The caller's owned task entry (never a bare promise). */
      readonly run: WebPanelTaskRunner
    },
  ) {
    this.done = done
    this.reference = options.reference
    this.read = options.read
    this.actions = options.actions
    this.requestRender = options.requestRender
    this.runTask = options.run
    this.runTask('web credential state read', () => this.refresh())
  }

  private async refresh(): Promise<void> {
    try {
      const info = await this.read()
      if (this.settled) return
      this.state = {
        kind: 'ready',
        configured: info.configured === true,
        ...(typeof info.source === 'string' && info.source !== '' ? { source: info.source } : {}),
      }
    } catch (error) {
      if (this.settled) return
      this.state = { kind: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    this.requestRender()
  }

  private close(): void {
    if (this.settled) return
    this.settled = true
    this.done(undefined)
  }

  private move(delta: number): void {
    const candidates = this.actions.filter(action => action.enabled)
    if (candidates.length === 0) return
    this.focusedAction = (this.focusedAction + delta + candidates.length) % candidates.length
  }

  handleInput(data: string): void {
    if (this.settled) return
    if (matchesKey(data, 'escape')) {
      this.close()
      return
    }
    if (matchesKey(data, 'up')) {
      this.move(-1)
      return
    }
    if (matchesKey(data, 'down')) {
      this.move(1)
      return
    }
    if (matchesKey(data, 'enter')) {
      const action = this.actions.filter(candidate => candidate.enabled)[this.focusedAction]
      if (action === undefined) return
      // Logical intent first: the submenu is closed BEFORE the action runs, so
      // the caller's overlay close + command delegation starts from a settled
      // presentation state (never a Question under the settings overlay).
      this.close()
      action.run()
    }
  }

  dispose(): void {
    this.settled = true
  }

  invalidate(): void {}

  render(width: number): string[] {
    const enabled = this.actions.filter(action => action.enabled)
    const lines = [
      row(color.textStrong('DeepSeek API Key'), width),
      row(this.stateLine(), width),
      row(color.textDim(`Stored as the official credential reference "${this.reference}" (the value is never shown).`), width),
      row(color.textDim('Set it with the existing masked /login input; the key is never written into a settings file.'), width),
      row('', width),
      ...enabled.map((action, index) => row(
        `${index === this.focusedAction ? color.primary('› ') : '  '}${index === this.focusedAction ? color.textStrong(action.label) : action.label} — ${color.textDim(action.description)}`,
        width,
      )),
      row('', width),
      row(color.textDim('↑/↓: choose · Enter: run · Esc: back'), width),
    ]
    return lines
  }

  private stateLine(): string {
    if (this.state.kind === 'reading') return color.textDim('Loading…')
    if (this.state.kind === 'error') return `${color.textDim('Unavailable')}${color.textDim(` · ${this.state.message}`)}`
    if (!this.state.configured) {
      return `${color.textDim('Not configured')} ${color.warning('[unavailable]')}${color.textDim(' · the DeepSeek Search / Fetch APIs cannot authenticate yet')}`
    }
    return `${color.text('Configured')}${this.state.source === undefined ? '' : color.textDim(` · source: ${this.state.source}`)}`
  }
}
