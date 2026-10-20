/**
 * The Settings → Account page (Phase 3C / C2-MA): the ONE in-place surface for
 * DeepSeek Account browser sign-in, live state, profile, wallet balances,
 * cancellation and sign-out. It renders the Host's own `AccountView` phases
 * (the official `succeeded` phase is shown as Authorized) and never shows a
 * token, grant payload or PKCE value.
 *
 * The page lives INSIDE the existing Settings workspace lease. It owns only
 * view state; every Host operation is an intent on {@link AccountWorkspaceSource}
 * (the app/command workflow over the `AccountConfig` port). Closing the page
 * only ends the watch subscription — an in-flight BROWSER attempt keeps running
 * on the Host and is rebuilt from `getState` when the page is reopened.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/account-workspace-page
 */

import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@xmoon76/pi-tui'
import { renderActionBarRow, type ActionBarSegment } from '../presentation/action-bar.ts'
import { color } from '../theme/runtime.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import type { AccountView, AccountWallet } from '../../runtime/config-port.ts'
import type { AccountQueryOutcome, AccountWorkspaceSource } from '../../app/command/account-workflow.ts'

/** How the page was opened by a command deep link. */
export interface AccountInitialView {
  readonly view: 'page' | 'signout'
}

type QueryState<T> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'ready'; readonly value: T }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'signed-out' }

interface ActionLine {
  readonly id: string
  readonly label: string
  readonly enabled: boolean
}

interface Projection {
  readonly content: string[]
  readonly actions: readonly ActionLine[]
}

interface HitTarget {
  readonly id: string
  readonly row: number
  readonly startCol: number
  readonly endCol: number
}

const LABEL_WIDTH = 12
const ACTIVE_PHASES = new Set(['initializing', 'waiting-browser', 'exchanging', 'committing'])

function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const clamped = truncateToWidth(text, width, '…', false)
  const padding = width - visibleWidth(clamped)
  return padding > 0 ? clamped + ' '.repeat(padding) : clamped
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One wallet row's exact decimal string plus its currency. */
function walletText(wallet: AccountWallet): string {
  return `${wallet.balance} ${wallet.currency}`
}

/** The user-facing attempt phase: the official `succeeded` is Authorized. */
function phaseLabel(phase: string): string {
  return phase === 'succeeded' ? 'authorized' : phase
}

/** The page component. Constructed per workspace open. */
export class AccountWorkspacePage implements Component {
  private readonly source: AccountWorkspaceSource
  private requestRender: () => void
  private view: AccountView | undefined
  private stateFailure: string | undefined
  private profile: QueryState<import('../../runtime/config-port.ts').AccountProfile> = { kind: 'idle' }
  private balance: QueryState<{ readonly value: readonly AccountWallet[]; readonly bonusWallets: readonly AccountWallet[] }> = { kind: 'idle' }
  private signOutConfirm = false
  private signOutIdentity: string | undefined
  private runningTasks = false
  private notice: string | undefined
  private busy: 'signin' | 'signout' | 'cancel' | undefined
  private cursor = 0
  private scroll = 0
  private copyValue: string | undefined
  private paintedCopy = false
  private readonly pageController = new AbortController()
  private disposed = false
  private revision = 0
  private paintedTargets: readonly HitTarget[] = []
  private pressed: { readonly target: HitTarget; readonly revision: number; readonly width: number; readonly height: number } | undefined
  private lastWidth = 0
  private lastHeight = 0
  private bodyHeight = 1
  private initializing = true
  private watcherStarted = false
  /** Latest-read serials: an older profile/balance read can never overwrite a
   *  newer one (and a signed-out view invalidates both). */
  private profileSerial = 0
  private balanceSerial = 0
  /** Latest AccountView read/operation identity: an older getState must never
   *  overwrite a newer watch snapshot. */
  private stateSerial = 0

  constructor(
    source: AccountWorkspaceSource,
    requestRender: () => void,
    initial: AccountInitialView,
  ) {
    this.source = source
    this.requestRender = requestRender
    this.signOutConfirm = initial.view === 'signout'
    this.start()
  }

  private start(): void {
    if (!this.source.available()) {
      this.stateFailure = 'DeepSeek Account is not supported on this backend'
      this.initializing = false
      return
    }
    if (this.watcherStarted) return
    this.watcherStarted = true
    // The official watch subscription yields a COMPLETE initial state. That
    // initial snapshot is the page's first read: a separate getState would be
    // a second, unordered snapshot that could land after a newer watch event.
    this.source.run('account watch', async () => {
      try {
        for await (const view of this.source.watch(this.pageController.signal)) {
          this.commitView(view)
        }
      } catch (error) {
        if (this.disposed || this.pageController.signal.aborted) return
        this.settle(() => { this.stateFailure = `the account watch stopped: ${errorText(error)}` })
      }
    })
  }

  private refresh(): void {
    if (this.disposed) return
    const serial = ++this.stateSerial
    this.revision += 1
    this.source.run('account state read', async () => {
      let view: AccountView
      try {
        view = await this.source.getState()
      } catch (error) {
        this.settle(() => {
          if (serial !== this.stateSerial) return
          this.stateFailure = errorText(error)
          this.initializing = false
        })
        return
      }
      if (this.disposed || serial !== this.stateSerial) return
      this.applyView(view, false)
      if (view.status === 'credential-stored') {
        this.readProfile()
        this.readBalance()
      }
    })
  }

  /** Commit one Host-observed view and invalidate older in-flight reads. */
  private commitView(view: AccountView): void {
    this.stateSerial += 1
    this.applyView(view)
  }

  /** Apply one Host AccountView. A credential transition starts the independent
   * profile/balance reads; a signed-out state clears them. */
  private applyView(view: AccountView, readDetails = true): void {
    this.settle(() => {
      const previous = this.view?.status
      this.view = view
      this.stateFailure = undefined
      this.initializing = false
      if (view.status === 'credential-stored') {
        this.runningTasks = this.source.hasRunningAccountTasks()
        if (readDetails && (previous !== 'credential-stored' || this.profile.kind === 'idle' || this.profile.kind === 'signed-out')) {
          this.readProfile()
          this.readBalance()
        }
      } else {
        this.profileSerial += 1
        this.balanceSerial += 1
        this.profile = { kind: 'signed-out' }
        this.balance = { kind: 'signed-out' }
        this.runningTasks = false
      }
    })
  }

  private readProfile(): void {
    if (this.disposed) return
    const serial = ++this.profileSerial
    this.profile = { kind: 'pending' }
    this.source.run('account profile read', async () => {
      const outcome = await this.source.getProfile()
      this.settle(() => {
        if (serial !== this.profileSerial) return
        this.profile = queryStateOf(outcome)
      })
    })
  }

  private readBalance(): void {
    if (this.disposed) return
    const serial = ++this.balanceSerial
    this.balance = { kind: 'pending' }
    this.source.run('account balance read', async () => {
      const outcome = await this.source.getBalance()
      this.settle(() => {
        if (serial !== this.balanceSerial) return
        this.balance = queryStateOf(outcome)
      })
    })
  }

  private settle(apply: () => void): void {
    if (this.disposed) return
    apply()
    this.revision += 1
    this.requestRender()
  }

  private activeAttempt(): NonNullable<AccountView['attempt']> | undefined {
    const attempt = this.view?.attempt
    return attempt !== null && attempt !== undefined && ACTIVE_PHASES.has(attempt.phase) ? attempt : undefined
  }

  private signIn(): void {
    if (this.busy !== undefined) return
    if (this.source.callbackOrigin() === undefined) {
      this.notice = 'the Host browser callback listener is unavailable — browser sign-in cannot complete'
      this.requestRender()
      return
    }
    this.busy = 'signin'
    this.notice = undefined
    this.revision += 1
    this.requestRender()
    this.source.run('account sign in', async () => {
      try {
        const view = await this.source.startSignIn()
        this.commitView(view)
        this.settle(() => { this.busy = undefined })
      } catch (error) {
        this.settle(() => {
          this.busy = undefined
          this.notice = `sign-in could not start: ${errorText(error)}`
        })
      }
    })
  }

  private cancelAttempt(): void {
    const attempt = this.activeAttempt()
    if (attempt === undefined || this.busy !== undefined) return
    this.busy = 'cancel'
    this.revision += 1
    this.requestRender()
    this.source.run('account cancel sign in', async () => {
      try {
        const view = await this.source.cancelSignIn(attempt.id)
        this.commitView(view)
        this.settle(() => { this.busy = undefined })
      } catch (error) {
        this.settle(() => {
          this.busy = undefined
          this.notice = `cancel failed: ${errorText(error)}`
        })
      }
    })
  }

  private confirmSignOut(): void {
    if (this.busy !== undefined) return
    const view = this.view
    if (view === undefined || view.status !== 'credential-stored') return
    this.signOutConfirm = true
    this.revision += 1
    this.signOutIdentity = this.profile.kind === 'ready'
      ? this.profile.value.name ?? this.profile.value.id ?? 'the stored DeepSeek Account'
      : 'the stored DeepSeek Account'
    this.runningTasks = this.source.hasRunningAccountTasks()
    this.cursor = 0
    this.requestRender()
  }

  private signOut(): void {
    if (this.busy !== undefined) return
    this.busy = 'signout'
    this.revision += 1
    this.requestRender()
    this.source.run('account sign out', async () => {
      try {
        const view = await this.source.signOut()
        this.settle(() => {
          this.signOutConfirm = false
          this.signOutIdentity = undefined
          this.busy = undefined
          this.commitView(view)
        })
      } catch (error) {
        this.settle(() => {
          // A failed local removal does NOT resurrect a local credential state:
          // the page keeps showing whatever the Host last reported.
          this.busy = undefined
          this.notice = `sign-out failed: ${errorText(error)}`
        })
      }
    })
  }

  private copy(text: string): void {
    this.source.copy(text)
  }

  private openUrl(url: string): void {
    this.source.openUrl(url)
  }

  // ── rendering ────────────────────────────────────────────────────────────

  setBodyHeight(rows: number): void {
    this.bodyHeight = Math.max(1, rows)
  }

  render(width: number): string[] {
    if (this.disposed) return []
    this.lastWidth = width
    this.lastHeight = this.bodyHeight
    const height = Math.max(1, this.bodyHeight)
    const projection = this.project(width)
    const rowOrder = this.rowOrder.slice()
    if (projection.actions.length >= height) {
      this.paintedActionIds.clear()
      this.paintedCopy = false
      this.paintedTargets = []
      this.paintedRowOrder = []
      const out = [fit(color.warning('Resize the terminal to show the page actions.'), width)]
      while (out.length < height) out.push(fit('', width))
      return out.slice(0, height)
    }
    this.paintedActionIds.clear()
    const actionLines = projection.actions.map((action, index) => this.paintAction(action, rowOrder.length + index))
    const contentRows = Math.max(0, height - 1 - actionLines.length)
    this.scroll = Math.min(this.scroll, Math.max(0, projection.content.length - contentRows))
    const lines: string[] = []
    const targets: HitTarget[] = []
    for (let index = 0; index < contentRows; index += 1) {
      const lineIndex = this.scroll + index
      const content = projection.content[lineIndex]
      if (content === undefined) break
      lines.push(fit(content, width))
      const id = this.rowIds.get(lineIndex)
      if (id !== undefined) targets.push({ id, row: lines.length - 1, startCol: 0, endCol: width })
    }
    while (lines.length < height - 1 - actionLines.length) lines.push(fit('', width))
    lines.push(...actionLines.map(line => fit(line, width)))
    for (const [index, action] of projection.actions.entries()) {
      targets.push({ id: action.id, row: height - 1 - actionLines.length + index, startCol: 0, endCol: width })
      if (action.enabled) this.paintedActionIds.add(action.id)
    }
    this.paintedTargets = targets
    this.paintedRowOrder = rowOrder
    const out = [...lines, color.textMuted(this.actionBar(width, projection.actions))]
    while (out.length < height) out.push(fit('', width))
    return out.slice(0, height)
  }

  private paintAction(action: ActionLine, index: number): string {
    const selected = index === this.cursor
    if (!action.enabled) return `  ${color.textMuted(action.label)}`
    return `${selected ? color.primary('> ') : '  '}${selected ? color.textStrong(action.label) : color.text(action.label)}`
  }

  private actionBar(width: number, actions: readonly ActionLine[]): string {
    const segments: ActionBarSegment[] = []
    if (this.copyValue !== undefined) segments.push({ text: 'c copy', priority: 3 })
    if (actions.length > 0) segments.push({ text: 'Up/Down select', priority: 5 }, { text: 'Enter select', priority: 6 })
    segments.push({ text: 'r refresh', priority: 2 })
    segments.push({ text: 'Esc back', priority: 8 })
    const rendered = renderActionBarRow(segments, width)
    this.paintedCopy = rendered.includes('c copy')
    return rendered
  }

  private rowIds = new Map<number, string>()
  private readonly rowOrder: string[] = []
  private paintedRowOrder: readonly string[] = []
  private readonly paintedActionIds = new Set<string>()

  private addRow(content: string[], text: string, id: string): void {
    const row = content.length
    content.push(text)
    this.rowIds.set(row, id)
    this.rowOrder.push(id)
  }

  private project(width: number): Projection {
    this.rowIds.clear()
    this.rowOrder.length = 0
    this.copyValue = undefined
    if (this.stateFailure !== undefined && this.view === undefined) {
      return {
        content: [
          color.textStrong('DeepSeek Account'),
          '',
          color.error(this.stateFailure),
          '',
          color.textDim('The Host account service and its browser callback listener are required for sign-in.'),
        ],
        actions: [
          { id: 'account:refresh', label: 'Refresh', enabled: this.source.available() },
          { id: 'account:back', label: '← Settings', enabled: true },
        ],
      }
    }
    const view = this.view
    const content: string[] = [color.textStrong('DeepSeek Account'), '']
    const status = view === undefined
      ? this.initializing ? 'Reading Host account state…' : 'Unavailable'
      : view.status === 'credential-stored' ? 'Signed in (stored credential)' : 'Signed out / no stored credential'
    content.push(...this.fact('Status', status, width))
    if (this.stateFailure !== undefined) content.push(...this.fact('Error', this.stateFailure, width))
    const attempt = this.activeAttempt()
    if (attempt !== undefined) {
      content.push(...this.fact('Attempt', `${phaseLabel(attempt.phase)}${attempt.id === undefined ? '' : ` · ${attempt.id}`}`, width))
      if (attempt.expiresAt !== undefined) content.push(...this.fact('Expires', new Date(attempt.expiresAt).toISOString(), width))
      if (attempt.errorCode !== undefined) content.push(...this.fact('Error code', attempt.errorCode, width))
    } else if (view?.attempt !== null && view?.attempt !== undefined) {
      content.push(...this.fact('Last attempt', phaseLabel(view.attempt.phase), width))
      if (view.attempt.errorCode !== undefined) content.push(...this.fact('Error code', view.attempt.errorCode, width))
    }
    content.push(...this.fact('Profile', this.profileText(), width))
    content.push(...this.fact('Balance', this.balanceText(), width))
    content.push(...this.fact('Callback', this.source.callbackOrigin() ?? 'unavailable — the Host listener is not bound', width))
    const url = attempt?.authorizeUrl
    if (url !== undefined) {
      content.push('', color.textStrong('Browser authorization'))
      content.push(...this.wrapText(url, width))
      const host = this.callbackHost()
      const port = this.callbackPort()
      if (host !== undefined && port !== undefined) {
        const target = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
        content.push('', color.textDim(`Remote/SSH: the callback listener is bound to ${target}:${port} on the Host.`))
        const template = this.sshTemplate()
        if (template !== undefined) content.push(...this.wrapText(template, width))
        content.push(color.textDim('Create that tunnel from your local machine, then open the authorization URL locally. The port is random per process; re-read it after a restart.'))
      }
    } else {
      content.push('', color.textDim('The browser is authorized on the Host; no token or grant is shown here.'))
    }
    if (this.signOutConfirm) {
      content.push('', color.textStrong('Sign out confirmation'))
      content.push(color.warning(sanitizedPhysicalLine(`This removes the locally stored DeepSeek Account credential for ${this.signOutIdentity ?? 'the current account'}. API keys stay stored; the current model is not switched.`)))
      if (this.runningTasks) {
        content.push(color.error('A running agent is using a deepseek-account model. Signing out lets the Host cancel that matching account task.'))
      }
      content.push(color.textDim('The provider revokes the grant in the background; a remote failure never restores the local credential.'))
    }
    content.push(color.textDim('The Account token is never shown. Profile and balance are independent Host queries; a failure is stated on its own line.'))
    if (this.notice !== undefined) content.push('', color.warning(sanitizedPhysicalLine(this.notice)))
    if (this.busy !== undefined) content.push('', color.textMuted(`${this.busy} — the Host has not confirmed yet`))
    const actions: ActionLine[] = []
    if (this.signOutConfirm) {
      const canSignOut = view?.status === 'credential-stored' && this.busy === undefined
      actions.push({ id: 'account:signout-confirm', label: canSignOut ? 'Sign out' : 'Nothing to sign out', enabled: canSignOut })
      actions.push({ id: 'account:signout-cancel', label: 'Cancel', enabled: true })
    } else {
      if (view?.status !== 'credential-stored' && attempt === undefined) {
        actions.push({ id: 'account:signin', label: 'Sign in', enabled: this.busy === undefined && this.source.callbackOrigin() !== undefined })
      }
      if (attempt !== undefined) actions.push({ id: 'account:cancel', label: 'Cancel current attempt', enabled: this.busy === undefined })
      if (url !== undefined) {
        actions.push({ id: 'account:open', label: 'Open browser', enabled: true })
        actions.push({ id: 'account:copy-url', label: 'Copy link', enabled: true })
        if (this.callbackPort() !== undefined) actions.push({ id: 'account:copy-ssh', label: 'Copy SSH template', enabled: true })
      }
      if (view !== undefined) {
        actions.push({ id: 'account:usage', label: 'Usage ↗', enabled: true })
        actions.push({ id: 'account:topup', label: 'Top up ↗', enabled: true })
      }
      if (view?.status === 'credential-stored') actions.push({ id: 'account:signout', label: 'Sign out…', enabled: this.busy === undefined })
      actions.push({ id: 'account:refresh', label: 'Refresh', enabled: this.busy === undefined })
    }
    actions.push({ id: 'account:back', label: '← Settings', enabled: true })
    this.copyValue = url ?? view?.links.usageUrl
    return { content, actions }
  }

  private fact(label: string, value: string, width: number): string[] {
    const bodyWidth = Math.max(1, width - LABEL_WIDTH)
    const wrapped = wrapTextWithAnsi(sanitizedPhysicalLine(value), bodyWidth)
    const parts = wrapped.length === 0 ? [''] : wrapped
    return [
      `${fit(color.textDim(sanitizedPhysicalLine(label)), LABEL_WIDTH)}${color.text(parts[0]!)}`,
      ...parts.slice(1).map(extra => `${' '.repeat(LABEL_WIDTH)}${color.text(extra)}`),
    ]
  }

  private wrapText(value: string, width: number): string[] {
    return wrapTextWithAnsi(sanitizedPhysicalLine(value), Math.max(1, width)).map(line => color.text(line))
  }

  private profileText(): string {
    const profile = this.profile
    if (profile.kind === 'idle') return 'not read yet'
    if (profile.kind === 'pending') return 'Loading…'
    if (profile.kind === 'signed-out') return 'not available while signed out'
    if (profile.kind === 'failed') return `failed · ${profile.reason}`
    const value = profile.value
    return `${value.name ?? 'unnamed'}${value.id === null ? '' : ` · ${value.id}`}${value.contact === null ? '' : ` · ${value.contact}`}`
  }

  private balanceText(): string {
    const balance = this.balance
    if (balance.kind === 'idle') return 'not read yet'
    if (balance.kind === 'pending') return 'Loading…'
    if (balance.kind === 'signed-out') return 'not available while signed out'
    if (balance.kind === 'failed') return `failed · ${balance.reason}`
    const recharge = balance.value.value.length === 0 ? 'none' : balance.value.value.map(walletText).join(' · ')
    const bonus = balance.value.bonusWallets.length === 0 ? 'none' : balance.value.bonusWallets.map(walletText).join(' · ')
    return `Recharge: ${recharge} · Bonus: ${bonus}`
  }

  private callbackHost(): string | undefined {
    const origin = this.source.callbackOrigin()
    if (origin === undefined) return undefined
    try {
      return new URL(origin).hostname
    } catch {
      return undefined
    }
  }

  private callbackPort(): number | undefined {
    const origin = this.source.callbackOrigin()
    if (origin === undefined) return undefined
    try {
      return new URL(origin).port === '' ? undefined : Number(new URL(origin).port)
    } catch {
      return undefined
    }
  }

  private sshTemplate(): string | undefined {
    const host = this.callbackHost()
    const port = this.callbackPort()
    if (host === undefined || port === undefined) return undefined
    const target = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    // The browser follows the Host's redirect_uri on the SAME loopback address
    // family, so the local tunnel bind must use the callback host too.
    // Quote the forwarding argument: bracketed IPv6 addresses are globs in zsh.
    return `ssh -N -L '${target}:${port}:${target}:${port}' <SSH_TARGET>`
  }

  // ── input ────────────────────────────────────────────────────────────────

  handleInput(data: string): 'handled' | 'exit' {
    if (this.disposed) return 'handled'
    if (matchesKey(data, 'escape') || matchesKey(data, 'backspace')) {
      if (this.busy !== undefined) {
        this.notice = 'an account operation is still in flight — wait for the Host outcome'
        this.requestRender()
        return 'handled'
      }
      if (this.signOutConfirm) {
        this.signOutConfirm = false
        this.cursor = 0
        this.requestRender()
        return 'handled'
      }
      return 'exit'
    }
    if (matchesKey(data, 'up')) return this.move(-1)
    if (matchesKey(data, 'down')) return this.move(1)
    if (matchesKey(data, 'pageUp')) return this.page(-1)
    if (matchesKey(data, 'pageDown')) return this.page(1)
    if (matchesKey(data, 'home')) return this.jump(-1)
    if (matchesKey(data, 'end')) return this.jump(1)
    if (matchesKey(data, 'enter')) return this.confirm()
    if (data === 'r' || data === 'R') {
      this.refresh()
      return 'handled'
    }
    if (matchesKey(data, 'c') || matchesKey(data, Key.shift('c'))) {
      if (this.paintedCopy && this.copyValue !== undefined) this.copy(this.copyValue)
      return 'handled'
    }
    if (data === 'o' || data === 'O') {
      const url = this.activeAttempt()?.authorizeUrl
      if (url !== undefined) this.openUrl(url)
      return 'handled'
    }
    return 'handled'
  }

  private move(delta: number): 'handled' {
    const projection = this.project(this.lastWidth)
    const count = this.rowOrder.length + projection.actions.length
    this.cursor = Math.min(Math.max(0, this.cursor + delta), Math.max(0, count - 1))
    this.revision += 1
    this.requestRender()
    return 'handled'
  }

  private page(direction: -1 | 1): 'handled' {
    this.scroll = Math.max(0, this.scroll + direction * Math.max(1, this.lastHeight - 3))
    this.revision += 1
    this.requestRender()
    return 'handled'
  }

  private jump(direction: 1 | -1): 'handled' {
    const projection = this.project(this.lastWidth)
    this.cursor = direction < 0 ? 0 : Math.max(0, this.rowOrder.length + projection.actions.length - 1)
    this.revision += 1
    this.requestRender()
    return 'handled'
  }

  private confirm(): 'handled' | 'exit' {
    const projection = this.project(this.lastWidth)
    if (this.cursor < this.rowOrder.length) return 'handled'
    const action = projection.actions[this.cursor - this.rowOrder.length]
    if (action === undefined || !action.enabled || !this.paintedActionIds.has(action.id)) return 'handled'
    return this.activate(action.id)
  }

  private activate(id: string): 'handled' | 'exit' {
    const view = this.view
    const attempt = this.activeAttempt()
    switch (id) {
      case 'account:signin': this.signIn(); return 'handled'
      case 'account:cancel': this.cancelAttempt(); return 'handled'
      case 'account:signout': this.confirmSignOut(); return 'handled'
      case 'account:signout-confirm': this.signOut(); return 'handled'
      case 'account:signout-cancel': this.signOutConfirm = false; this.cursor = 0; this.revision += 1; this.requestRender(); return 'handled'
      case 'account:open':
        if (attempt?.authorizeUrl !== undefined) this.openUrl(attempt.authorizeUrl)
        return 'handled'
      case 'account:copy-url':
        if (attempt?.authorizeUrl !== undefined) this.copy(attempt.authorizeUrl)
        return 'handled'
      case 'account:copy-ssh': {
        const template = this.sshTemplate()
        if (template !== undefined) this.copy(template)
        return 'handled'
      }
      case 'account:usage':
        if (view !== undefined) this.openUrl(view.links.usageUrl)
        return 'handled'
      case 'account:topup':
        if (view !== undefined) this.openUrl(view.links.topUpUrl)
        return 'handled'
      case 'account:refresh':
        this.refresh()
        return 'handled'
      case 'account:back':
        return 'exit'
      default:
        return 'handled'
    }
  }

  // ── mouse ────────────────────────────────────────────────────────────────

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed || event.type !== 'wheel') return undefined
    const delta = event.wheelDelta ?? 0
    if (delta === 0) return undefined
    this.scroll = Math.max(0, this.scroll + delta)
    this.revision += 1
    this.requestRender()
    return { handled: true }
  }

  onCellPress(x: number, y: number): void {
    if (this.disposed) return
    const target = this.paintedTargets.find(candidate => candidate.row === y && x >= candidate.startCol && x < candidate.endCol)
    this.pressed = target === undefined ? undefined : { target, revision: this.revision, width: this.lastWidth, height: this.lastHeight }
  }

  onCellClick(x: number, y: number): 'handled' | 'exit' {
    if (this.disposed) return 'handled'
    const pressed = this.pressed
    this.pressed = undefined
    const target = this.paintedTargets.find(candidate => candidate.row === y && x >= candidate.startCol && x < candidate.endCol)
    if (pressed === undefined || target === undefined) return 'handled'
    if (pressed.revision !== this.revision
      || pressed.width !== this.lastWidth
      || pressed.height !== this.lastHeight
      || target.id !== pressed.target.id
      || target.row !== pressed.target.row) return 'handled'
    if (!this.paintedActionIds.has(target.id)) return 'handled'
    const rowIndex = this.paintedRowOrder.indexOf(target.id)
    if (rowIndex >= 0) {
      this.cursor = rowIndex
    } else {
      const projection = this.project(this.lastWidth)
      const action = projection.actions.find(candidate => candidate.id === target.id)
      if (action === undefined || !action.enabled) return 'handled'
      this.cursor = this.paintedRowOrder.length + projection.actions.indexOf(action)
    }
    return this.activate(target.id)
  }

  private actionIndexOf(id: string): number {
    const projection = this.project(this.lastWidth)
    const index = projection.actions.findIndex(action => action.id === id)
    return index < 0 ? 0 : index
  }

  invalidate(): void {
    // No child editor state to invalidate: the page re-renders from its view
    // state on every frame.
  }

  /** Revoke the press state when another owner claims the gesture. */
  cancelPointer(): void {
    this.pressed = undefined
  }

  pendingMutation(): boolean {
    return this.busy !== undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pageController.abort()
    this.paintedTargets = []
    this.pressed = undefined
    this.requestRender = () => {}
  }
}

function queryStateOf<T>(outcome: AccountQueryOutcome<T>): QueryState<T> {
  if (outcome.status === 'ready') return { kind: 'ready', value: outcome.value }
  if (outcome.status === 'failed') return { kind: 'failed', reason: outcome.reason }
  return { kind: 'signed-out' }
}
