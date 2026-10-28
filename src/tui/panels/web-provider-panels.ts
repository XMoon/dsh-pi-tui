/**
 * The `/settings` Web Search / Fetch submenus (S2/PR-B §3.3): the Search/Fetch
 * API endpoint editor and the DeepSeek API key action panel.
 *
 * Both are ordinary `SettingsList` submenu components: they own only their
 * interaction, never a write policy. The endpoint panel calls the injected
 * `save` (the ConfigPort write + authoritative read-back) and keeps the draft
 * OPEN with the exact failure message when the write or its verification
 * fails; the credential panel only ASKS the caller to start the existing
 * `/login` / `/logout` command path — it never touches a credential itself and
 * never renders a value.
 *
 * Late settles are fenced: a closed/disposed panel never repaints, never calls
 * `done` twice, and never re-opens anything.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/web-provider-panels
 */

import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from '@xmoon76/pi-tui'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color } from '../theme/runtime.ts'

/**
 * One settled-but-not-verified write outcome (§4A.2's frozen vocabulary): the
 * caller that performed the Host mutation decides the WORD, the panel only
 * paints it. `not-saved` = the authority refused or kept another value;
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

/** The word + ink of one unverified write outcome. */
function verdictWord(verdict: 'not-saved' | 'outcome-unknown'): string {
  return verdict === 'not-saved' ? color.error('Not saved') : color.warning('Outcome unknown')
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

/**
 * The Search/Fetch API endpoint editor: a single-field draft with an explicit
 * Enter confirmation and an Esc cancel. The credential is sent to whatever
 * endpoint is saved, so the panel states that risk on every frame.
 */
export class WebEndpointPanel implements Component {
  /** Focusable seam the nested list forwards to the open submenu. */
  focused = false

  private readonly input: Input
  private readonly done: (selected?: string) => void
  private readonly save: (url: string) => Promise<void>
  private readonly requestRender: () => void
  private readonly runTask: WebPanelTaskRunner
  /** The total line budget the HOST grants this panel (its semantic hint
   *  included). `undefined` = the legacy submenu grant: every line paints. */
  private maxRows: number | undefined
  /** Whether the LAST render painted the complete trust disclosure: only then
   *  may a Confirm be dispatched. */
  private confirmEnabled = false
  private state:
    | { readonly kind: 'hint' | 'saving' }
    | { readonly kind: 'error'; readonly verdict: 'not-saved' | 'outcome-unknown'; readonly message: string }
    = { kind: 'hint' }
  private settled = false

  constructor(
    done: (selected?: string) => void,
    options: {
      /** The current authoritative endpoint (the official base when unset). */
      readonly current: string
      /** Persist + verify the draft; rejects with the exact reason. */
      readonly save: (url: string) => Promise<void>
      readonly requestRender: () => void
      /** The caller's owned task entry (never a bare promise). */
      readonly run: WebPanelTaskRunner
    },
  ) {
    this.done = done
    this.save = options.save
    this.requestRender = options.requestRender
    this.runTask = options.run
    this.input = new Input({ placeholder: 'https://api.deepseek.com/v1/tools' })
    this.input.setValue(options.current)
    this.input.onSubmit = () => { this.runTask('web endpoint save', () => this.submit()) }
  }

  /** Close without a write (Esc, or the overlay tearing this panel down). */
  private cancel(): void {
    if (this.settled) return
    this.settled = true
    this.done(undefined)
  }

  /**
   * The host's row-budget seam: the granted lines INCLUDE this panel's own
   * semantic hint line, which is the last line of `render()`. The mandatory
   * facts (the draft input and the external-send warning) always survive; a
   * short grant drops the title, the official base and the status line instead
   * of painting half a sentence with a different meaning.
   */
  setMaxRows(rows: number): void {
    this.maxRows = Math.max(1, Math.floor(rows))
  }

  handleInput(data: string): void {
    if (this.settled) return
    if (matchesKey(data, 'escape')) {
      this.cancel()
      return
    }
    // A dispatched save is not cancellable: the settings mutation may already
    // have applied, so the panel refuses further edits until it settles.
    if (this.state.kind === 'saving') return
    this.input.focused = this.focused
    this.input.handleInput(data)
  }

  dispose(): void {
    this.settled = true
  }

  invalidate(): void {}

  /**
   * The complete trust disclosure. It is deliberately SHORT enough to wrap into
   * three whole lines at the 44-column floor while still stating all three
   * load-bearing facts: a trusted https base, the API key AND query are sent
   * there, and the URL shape is not a trust check. The page's read-only Detail
   * carries the longer explanation.
   */
  private static readonly TRUST_WARNING =
    'Only confirm a trusted https base: it receives the API key and the query. The URL shape is not a trust check.'

  render(width: number): string[] {
    const title = row(color.textStrong('Search / Fetch API Endpoint'), width)
    const draft = this.input.render(width).map(line => row(line, width))
    const savingLine = this.state.kind === 'saving' ? row(this.statusLine(width), width) : undefined
    const errorLine = this.state.kind === 'error' ? row(this.statusLine(width), width) : undefined
    const warning = wrapTextWithAnsi(WebEndpointPanel.TRUST_WARNING, Math.max(1, width - 2))
      .map(line => row(color.textDim(line), width))
    const base = wrapTextWithAnsi(
      `Official base: https://api.deepseek.com/v1/tools; /search and /fetch are appended.`,
      Math.max(1, width - 2),
    ).map(line => row(line.startsWith('Official base:')
      ? `${color.textDim('Official base: ')}${color.text(line.slice('Official base: '.length))}`
      : color.textDim(line), width))
    const hint = row(color.textDim('Enter confirm · Esc cancel'), width)
    if (this.maxRows === undefined) {
      // The legacy submenu grant is unbounded: keep the full presentation.
      this.confirmEnabled = true
      return [title, ...draft, row(this.statusLine(width), width), ...warning, ...base, hint]
    }
    const bodyBudget = Math.max(0, this.maxRows - 1)
    // The disclosure is MANDATORY: a Confirm may only exist while it is fully
    // painted. A dispatched write shows `Saving…` in the bar (it can never be
    // cancelled); an error keeps the confirm hint when its verdict fits in the
    // body, so the draft can be corrected and re-submitted.
    const mandatory = draft.length + warning.length
    this.confirmEnabled = mandatory <= bodyBudget
    const optional = new Set<string>()
    if (this.confirmEnabled) {
      let spare = bodyBudget - mandatory
      const take = (lines: readonly string[]): void => {
        if (spare <= 0) return
        for (const line of lines) {
          if (spare <= 0) return
          optional.add(line)
          spare -= 1
        }
      }
      // Display order is title → draft → warning → error → base → idle hint; the
      // PRIORITY order below only decides which optional lines survive.
      if (errorLine !== undefined) take([errorLine])
      take([title])
      take(base)
      if (savingLine === undefined && errorLine === undefined) take([row(this.statusLine(width), width)])
    }
    const body: string[] = []
    const pushOptional = (line: string): void => { if (optional.has(line)) body.push(line) }
    pushOptional(title)
    body.push(...draft, ...warning)
    if (errorLine !== undefined) pushOptional(errorLine)
    for (const line of base) pushOptional(line)
    const idleLine = savingLine === undefined && errorLine === undefined
      ? row(this.statusLine(width), width)
      : undefined
    if (idleLine !== undefined) pushOptional(idleLine)
    const bar = !this.confirmEnabled
      ? this.tooShortBar(width)
      : savingLine ?? (errorLine !== undefined && !optional.has(errorLine) ? errorLine : hint)
    return [...body.slice(0, bodyBudget), bar]
  }

  /**
   * The bar of a grant too short for the complete trust disclosure. It must not
   * read like a cancel affordance once a write is DISPATCHED (Esc only closes
   * this panel; the Host mutation keeps settling in the command owner), so the
   * live state word leads and only the idle draft says `Esc cancel`.
   */
  private tooShortBar(width: number): string {
    const enlarge = 'enlarge for the warning'
    if (this.state.kind === 'saving') return row(color.textDim(`Saving… · ${enlarge}`), width)
    if (this.state.kind === 'error') {
      return row(`${verdictWord(this.state.verdict)}${color.textDim(` · ${enlarge}`)}`, width)
    }
    return row(color.textDim(`Esc cancel · ${enlarge}`), width)
  }

  private statusLine(width: number): string {
    if (this.state.kind === 'saving') return color.textDim('Saving…')
    if (this.state.kind === 'error') {
      // The reason is HOST-origin: sanitize it at this display boundary so a
      // hostile error can never emit terminal-control instructions.
      return `${verdictWord(this.state.verdict)}${color.textDim(` · ${sanitizedPhysicalLine(this.state.message)}`)}`
    }
    // The idle hint drops WHOLE: a narrow grant keeps the actionable half
    // instead of painting a truncated sentence.
    const hint = ['Confirm only a trusted https URL: the saved endpoint receives the credential.',
      'Confirm only a trusted https URL.', 'Trusted https only.']
      .find(text => visibleWidth(text) <= width - 2) ?? ''
    return color.textDim(hint)
  }

  private async submit(): Promise<void> {
    // A Confirm whose mandatory trust disclosure is not fully painted is
    // refused (the bar states how to reveal it): the human never confirms an
    // external-send target blind.
    if (!this.confirmEnabled) return
    if (this.settled || this.state.kind === 'saving') return
    const url = this.input.getValue().trim()
    this.state = { kind: 'saving' }
    this.requestRender()
    try {
      await this.save(url)
    } catch (error) {
      // The failure stays in the panel: the draft is preserved for correction,
      // and nothing claims the value was saved.
      if (this.settled) return
      this.state = {
        kind: 'error',
        verdict: error instanceof WebWriteVerdictError ? error.verdict : 'not-saved',
        message: error instanceof Error ? error.message : String(error),
      }
      this.requestRender()
      return
    }
    if (this.settled) return
    this.settled = true
    // The saved value comes from the read-back the caller verified.
    this.done(url)
  }
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
