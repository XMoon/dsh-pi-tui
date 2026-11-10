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
 * on the Host and is rebuilt from the Watch's initial snapshot when the page is
 * reopened.
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
import type { AccountObservation, AccountObservationLease, AccountProfile, AccountView, AccountWallet, AccountWatchInvalidationReason } from '../../runtime/config-port.ts'
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

type SignOutTaskCheck =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'known'; readonly running: boolean }
  | { readonly kind: 'unavailable'; readonly reason: string }

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
  private observationLease: AccountObservationLease | undefined
  private stateFailure: string | undefined
  private profile: QueryState<import('../../runtime/config-port.ts').AccountProfile> = { kind: 'idle' }
  private balance: QueryState<{ readonly value: readonly AccountWallet[]; readonly bonusWallets: readonly AccountWallet[] }> = { kind: 'idle' }
  private signOutConfirm = false
  private signOutIdentity: string | undefined
  private taskCheck: SignOutTaskCheck = { kind: 'idle' }
  private signOutConfirmationSerial = 0
  private runningTaskCheckSerial = 0
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
  /** A height change since the last painted frame: every body key is
   *  fail-closed until that frame repaints the new grant. */
  private bodyHeightStale = false
  /** The last painted frame could not fit its complete Action rows. */
  private fallbackActive = false
  private initializing = true
  private watcherStarted = false
  private watchController: AbortController | undefined
  /** Latest-read serials: an older profile/balance read can never overwrite a
   *  newer one (and a signed-out view invalidates both). */
  private profileSerial = 0
  private balanceSerial = 0
  /** Latest AccountView identity: an older derived read must never overwrite a
   *  newer committed Watch snapshot. */
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

  private currentObservationLease(): AccountObservationLease | undefined {
    const lease = this.observationLease
    return lease !== undefined && this.watcherStarted && this.source.isObservationCurrent(lease)
      ? lease
      : undefined
  }

  private hasCurrentObservation(): boolean {
    return this.currentObservationLease() !== undefined
  }

  private stopWatch(): void {
    const controller = this.watchController
    if (controller === undefined) return
    this.watchController = undefined
    this.watcherStarted = false
    this.observationLease = undefined
    this.stateSerial += 1
    this.profileSerial += 1
    this.balanceSerial += 1
    this.runningTaskCheckSerial += 1
    this.taskCheck = { kind: 'idle' }
    controller.abort()
  }

  private start(): boolean {
    if (this.disposed || this.watcherStarted) return false
    if (!this.source.available()) {
      this.observationLease = undefined
      this.stateFailure = 'the Host Account service is unavailable on this connection'
      this.initializing = false
      return false
    }
    this.stateFailure = undefined
    this.initializing = this.view === undefined
    const controller = new AbortController()
    const signal = AbortSignal.any([this.pageController.signal, controller.signal])
    this.watchController = controller
    this.watcherStarted = true
    this.source.run('account watch', async () => {
      try {
        for await (const event of this.source.watch(signal)) {
          if (signal.aborted || this.disposed || this.watchController !== controller) return
          if (event.kind === 'invalidated') {
            this.invalidateObservation(event.reason)
            continue
          }
          this.commitObservation(event.observation)
        }
      } catch {
        if (!signal.aborted && !this.disposed && this.watchController === controller) {
          this.invalidateObservation('watch-failed')
        }
      } finally {
        if (this.watchController === controller) {
          this.watchController = undefined
          this.watcherStarted = false
        }
      }
    })
    return true
  }

  private invalidateObservation(reason: AccountWatchInvalidationReason): void {
    this.observationLease = undefined
    this.stateSerial += 1
    this.profileSerial += 1
    this.balanceSerial += 1
    this.runningTaskCheckSerial += 1
    this.taskCheck = { kind: 'idle' }
    if (this.signOutConfirm) {
      this.closeSignOutConfirmation()
      this.notice = 'the Host Account observation changed — sign-out confirmation cleared'
    }
    const stateFailure = reason === 'service-unavailable'
      ? 'the Host Account service is unavailable on this connection'
      : reason === 'service-changed'
        ? 'the Host Account service changed; Refresh to read current state'
        : reason === 'connection-changed'
          ? 'the Host Account connection changed; Refresh to read current state'
          : reason === 'watch-failed'
            ? 'the Host Account watch stopped; Refresh to read current state'
            : 'the Host Account watch ended; Refresh to read current state'
    this.settle(() => {
      this.stateFailure = stateFailure
      this.initializing = false
    })
  }

  private refresh(): void {
    if (this.disposed || this.busy !== undefined) return
    this.stopWatch()
    this.stateFailure = undefined
    this.initializing = this.view === undefined
    if (this.view !== undefined) this.notice = 'Refreshing Host account state…'
    if (!this.start()) this.notice = undefined
    this.revision += 1
    this.requestRender()
  }

  /** One committed Watch snapshot is the page's only AccountView write. */
  private commitObservation(observation: AccountObservation): void {
    if (!this.source.isObservationCurrent(observation.lease)) return
    this.stateSerial += 1
    this.observationLease = observation.lease
    this.applyView(observation.view, observation.lease)
  }

  /** A settled mutation makes the prior Watch projection last-known. The next
   *  complete Watch snapshot (or explicit Refresh) restores current decisions. */
  private retireViewAfterMutation(): void {
    this.observationLease = undefined
    this.stateSerial += 1
    this.profileSerial += 1
    this.balanceSerial += 1
    this.runningTaskCheckSerial += 1
    this.taskCheck = { kind: 'idle' }
    this.initializing = false
  }

  private closeSignOutConfirmation(): void {
    if (!this.signOutConfirm) return
    this.signOutConfirm = false
    this.signOutIdentity = undefined
    this.signOutConfirmationSerial += 1
    this.runningTaskCheckSerial += 1
    this.taskCheck = { kind: 'idle' }
    this.cursor = 0
  }

  private invalidateSignOutConfirmation(reason: string): void {
    if (!this.signOutConfirm) return
    this.closeSignOutConfirmation()
    this.notice = reason
  }

  private runningTaskCheckIsCurrent(
    serial: number,
    stateSerial: number,
    confirmationSerial: number,
    view: AccountView,
    lease: AccountObservationLease,
  ): boolean {
    return !this.disposed
      && serial === this.runningTaskCheckSerial
      && stateSerial === this.stateSerial
      && confirmationSerial === this.signOutConfirmationSerial
      && this.observationLease === lease
      && this.source.isObservationCurrent(lease)
      && this.view === view
      && view.status === 'credential-stored'
  }

  private expireObservationIfStale(lease: AccountObservationLease): boolean {
    if (this.observationLease !== lease || this.source.isObservationCurrent(lease)) return false
    this.invalidateObservation('connection-changed')
    return true
  }

  /** Read the Host risk fact for one exact current Account observation. */
  private checkRunningTaskFact(view: AccountView, lease: AccountObservationLease): void {
    const serial = ++this.runningTaskCheckSerial
    const stateSerial = this.stateSerial
    const confirmationSerial = this.signOutConfirmationSerial
    this.taskCheck = { kind: 'checking' }
    this.source.run('account running-task check', async () => {
      let running: boolean
      try {
        running = await this.source.hasRunningAccountTasks(lease)
      } catch (error) {
        if (!this.runningTaskCheckIsCurrent(serial, stateSerial, confirmationSerial, view, lease)) {
          this.expireObservationIfStale(lease)
          return
        }
        this.settle(() => {
          this.taskCheck = { kind: 'unavailable', reason: errorText(error) }
        })
        return
      }
      if (!this.runningTaskCheckIsCurrent(serial, stateSerial, confirmationSerial, view, lease)) {
        this.expireObservationIfStale(lease)
        return
      }
      this.settle(() => { this.taskCheck = { kind: 'known', running } })
    })
  }

  /** Apply one committed Watch AccountView. The Host owns credential/attempt
   *  semantics; the page only projects this snapshot and its derived reads. */
  private applyView(
    view: AccountView,
    lease: AccountObservationLease,
    readDetails = true,
  ): void {
    this.settle(() => {
      if (!this.source.isObservationCurrent(lease)) return
      const previous = this.view?.status
      this.view = view
      this.observationLease = lease
      if (this.notice === 'Refreshing Host account state…') this.notice = undefined
      this.stateFailure = undefined
      this.initializing = false
      if (view.status === 'credential-stored') {
        if (previous !== undefined && this.signOutConfirm) {
          this.invalidateSignOutConfirmation('the Host account changed — confirm sign-out again')
        }
        this.checkRunningTaskFact(view, lease)
        if (readDetails) {
          this.readProfile(lease)
          this.readBalance(lease)
        }
      } else {
        if (this.signOutConfirm) {
          const signingOut = this.busy === 'signout'
          const accountChanged = previous === 'credential-stored'
          this.closeSignOutConfirmation()
          if (!signingOut) {
            this.notice = accountChanged
              ? 'the Host account changed — sign-out confirmation cleared'
              : 'Nothing to sign out — no stored DeepSeek Account credential.'
          }
        } else if (previous !== undefined) {
          this.invalidateSignOutConfirmation('the Host account changed — sign-out confirmation cleared')
        }
        this.runningTaskCheckSerial += 1
        this.taskCheck = { kind: 'idle' }
        this.profileSerial += 1
        this.balanceSerial += 1
        this.profile = { kind: 'signed-out' }
        this.balance = { kind: 'signed-out' }
      }
    })
  }

  private canCommitAccountDetails(lease: AccountObservationLease, detailSerial: number, stateSerial: number, domain: 'profile' | 'balance'): boolean {
    const currentDomainSerial = domain === 'profile' ? this.profileSerial : this.balanceSerial
    return !this.disposed
      && this.stateSerial === stateSerial
      && currentDomainSerial === detailSerial
      && this.observationLease === lease
      && this.currentObservationLease() === lease
  }

  private readProfile(lease: AccountObservationLease): void {
    if (this.disposed) return
    const serial = ++this.profileSerial
    const stateSerial = this.stateSerial
    this.profile = { kind: 'pending' }
    this.source.run('account profile read', async () => {
      let outcome: AccountQueryOutcome<AccountProfile>
      try {
        outcome = await this.source.getProfile(lease)
      } catch (error) {
        if (this.observationLease !== lease) return
        if (!this.source.isObservationCurrent(lease)) {
          this.invalidateObservation('connection-changed')
          return
        }
        if (!this.canCommitAccountDetails(lease, serial, stateSerial, 'profile')) return
        this.settle(() => {
          if (!this.canCommitAccountDetails(lease, serial, stateSerial, 'profile')) return
          this.profile = { kind: 'failed', reason: errorText(error) }
        })
        return
      }
      if (!this.canCommitAccountDetails(lease, serial, stateSerial, 'profile')) {
        if (this.observationLease === lease && !this.source.isObservationCurrent(lease)) this.invalidateObservation('connection-changed')
        return
      }
      this.settle(() => {
        if (!this.canCommitAccountDetails(lease, serial, stateSerial, 'profile')) return
        const state = queryStateOf(outcome)
        if (state === undefined) return
        this.profile = state
      })
    })
  }

  private readBalance(lease: AccountObservationLease): void {
    if (this.disposed) return
    const serial = ++this.balanceSerial
    const stateSerial = this.stateSerial
    this.balance = { kind: 'pending' }
    this.source.run('account balance read', async () => {
      let outcome: AccountQueryOutcome<{ readonly value: readonly AccountWallet[]; readonly bonusWallets: readonly AccountWallet[] }>
      try {
        outcome = await this.source.getBalance(lease)
      } catch (error) {
        if (this.observationLease !== lease) return
        if (!this.source.isObservationCurrent(lease)) {
          this.invalidateObservation('connection-changed')
          return
        }
        if (!this.canCommitAccountDetails(lease, serial, stateSerial, 'balance')) return
        this.settle(() => {
          if (!this.canCommitAccountDetails(lease, serial, stateSerial, 'balance')) return
          this.balance = { kind: 'failed', reason: errorText(error) }
        })
        return
      }
      if (!this.canCommitAccountDetails(lease, serial, stateSerial, 'balance')) {
        if (this.observationLease === lease && !this.source.isObservationCurrent(lease)) this.invalidateObservation('connection-changed')
        return
      }
      this.settle(() => {
        if (!this.canCommitAccountDetails(lease, serial, stateSerial, 'balance')) return
        const state = queryStateOf(outcome)
        if (state === undefined) return
        this.balance = state
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
    if (!this.hasCurrentObservation()) return undefined
    const attempt = this.view?.attempt
    return attempt !== null && attempt !== undefined && ACTIVE_PHASES.has(attempt.phase) ? attempt : undefined
  }

  private canStartSignIn(): boolean {
    return !this.disposed
      && this.busy === undefined
      && this.stateFailure === undefined
      && this.currentObservationLease() !== undefined
      && this.view?.status === 'signed-out'
      && this.activeAttempt() === undefined
      && this.source.callbackOrigin() !== undefined
  }

  private canCancelAttempt(): boolean {
    return !this.disposed
      && this.busy === undefined
      && this.stateFailure === undefined
      && this.currentObservationLease() !== undefined
      && this.activeAttempt() !== undefined
  }

  private canBeginSignOut(): boolean {
    return !this.disposed
      && this.busy === undefined
      && this.stateFailure === undefined
      && this.currentObservationLease() !== undefined
      && this.view?.status === 'credential-stored'
  }

  private signIn(): void {
    if (!this.canStartSignIn()) return
    const lease = this.currentObservationLease()
    if (lease === undefined) return
    this.stateSerial += 1
    const mutationSerial = this.stateSerial
    this.busy = 'signin'
    this.notice = undefined
    this.revision += 1
    this.requestRender()
    this.source.run('account sign in', async () => {
      try {
        await this.source.startSignIn(lease)
        this.settle(() => {
          this.busy = undefined
          if (this.stateSerial === mutationSerial) this.retireViewAfterMutation()
        })
      } catch (error) {
        this.settle(() => {
          this.busy = undefined
          this.notice = `sign-in result not confirmed: ${errorText(error)} — Refresh to re-read Host state`
          if (this.stateSerial === mutationSerial) this.retireViewAfterMutation()
        })
      }
    })
  }

  private cancelAttempt(): void {
    const attempt = this.activeAttempt()
    if (attempt === undefined || !this.canCancelAttempt()) return
    const lease = this.currentObservationLease()
    if (lease === undefined) return
    this.stateSerial += 1
    const mutationSerial = this.stateSerial
    this.busy = 'cancel'
    this.notice = undefined
    this.revision += 1
    this.requestRender()
    this.source.run('account cancel sign in', async () => {
      try {
        await this.source.cancelSignIn(attempt.id, lease)
        this.settle(() => {
          this.busy = undefined
          if (this.stateSerial === mutationSerial) this.retireViewAfterMutation()
        })
      } catch (error) {
        this.settle(() => {
          this.busy = undefined
          this.notice = `cancel result not confirmed: ${errorText(error)} — Refresh to re-read Host state`
          if (this.stateSerial === mutationSerial) this.retireViewAfterMutation()
        })
      }
    })
  }

  private confirmSignOut(): void {
    if (!this.canBeginSignOut()) return
    const view = this.view!
    const lease = this.currentObservationLease()!
    this.signOutConfirm = true
    this.signOutConfirmationSerial += 1
    this.taskCheck = { kind: 'checking' }
    this.revision += 1
    this.signOutIdentity = this.profile.kind === 'ready'
      ? this.profile.value.name ?? this.profile.value.id ?? 'the stored DeepSeek Account'
      : 'the stored DeepSeek Account'
    this.cursor = 0
    this.requestRender()
    this.checkRunningTaskFact(view, lease)
  }

  private canCommitSignOut(): boolean {
    return this.canBeginSignOut()
      && this.signOutConfirm
      && this.taskCheck.kind === 'known'
  }

  private canRetryTaskCheck(): boolean {
    return this.canBeginSignOut()
      && this.signOutConfirm
      && this.taskCheck.kind === 'unavailable'
  }

  private signOut(): void {
    const view = this.view
    const lease = this.currentObservationLease()
    const confirmationSerial = this.signOutConfirmationSerial
    const taskCheckSerial = this.runningTaskCheckSerial
    if (view === undefined || lease === undefined || !this.canCommitSignOut()) return
    if (this.observationLease !== lease
      || this.view !== view
      || this.signOutConfirmationSerial !== confirmationSerial
      || this.runningTaskCheckSerial !== taskCheckSerial
      || !this.source.isObservationCurrent(lease)) return
    this.stateSerial += 1
    const mutationSerial = this.stateSerial
    this.busy = 'signout'
    this.notice = undefined
    this.revision += 1
    this.requestRender()
    this.source.run('account sign out', async () => {
      try {
        await this.source.signOut(lease)
        this.settle(() => {
          this.closeSignOutConfirmation()
          this.busy = undefined
          if (this.stateSerial === mutationSerial) this.retireViewAfterMutation()
        })
      } catch (error) {
        this.settle(() => {
          // The Host owns the outcome; never replay the destructive mutation.
          this.closeSignOutConfirmation()
          this.busy = undefined
          this.notice = `sign-out result not confirmed: ${errorText(error)} — Refresh to re-read Host state`
          if (this.stateSerial === mutationSerial) this.retireViewAfterMutation()
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
    const next = Math.max(1, rows)
    if (next === this.bodyHeight) return
    this.bodyHeight = next
    // A resize invalidates the OLD frame's action authorization before the new
    // frame paints: a straddling Enter must not dispatch an action the new
    // height no longer displays.
    if (this.lastHeight > 0) this.bodyHeightStale = true
    this.paintedActionIds.clear()
    this.paintedTargets = []
    this.paintedRowOrder = []
    this.paintedCopy = false
  }

  render(width: number): string[] {
    if (this.disposed) return []
    this.lastWidth = width
    this.lastHeight = this.bodyHeight
    this.bodyHeightStale = false
    const height = Math.max(1, this.bodyHeight)
    const projection = this.project(width)
    const rowOrder = this.rowOrder.slice()
    if (projection.actions.length >= height) {
      this.fallbackActive = true
      this.paintedActionIds.clear()
      this.paintedCopy = false
      this.paintedTargets = []
      this.paintedRowOrder = []
      // The page actions do not fit: the warning keeps the body (when there is
      // one) and the truthful Esc action stays the physical last row.
      const bodyRows = Math.max(0, height - 1)
      const out = bodyRows >= 1
        ? [fit(color.warning('Resize the terminal to show the page actions.'), width)]
        : []
      while (out.length < bodyRows) out.push(fit('', width))
      // The fallback names the same real Esc effect as the normal bar.
      out.push(color.textMuted(renderActionBarRow([{ text: this.escHint(), priority: 8 }], width)))
      return out.slice(0, height)
    }
    this.fallbackActive = false
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

  /** The real Esc effect in the current state: a pending Host operation only
   *  reports its in-flight state, an open sign-out confirmation cancels, and an
   *  idle page backs out. */
  private escHint(): string {
    if (this.busy !== undefined) return 'Esc wait'
    if (this.signOutConfirm) return 'Esc cancel'
    return 'Esc back'
  }

  private actionBar(width: number, actions: readonly ActionLine[]): string {
    const segments: ActionBarSegment[] = []
    if (this.copyValue !== undefined) segments.push({ text: 'c copy', priority: 3 })
    if (actions.length > 0) segments.push({ text: 'Up/Down select', priority: 5 }, { text: 'Enter select', priority: 6 })
    segments.push({ text: 'r refresh', priority: 2 })
    segments.push({ text: this.escHint(), priority: 8 })
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
    const compactStatus = width <= 30 || this.bodyHeight <= 8
    const content: string[] = compactStatus
      ? [color.textStrong('DeepSeek Account')]
      : [color.textStrong('DeepSeek Account'), '']
    const observationCurrent = this.hasCurrentObservation()
    const status = compactStatus
      ? view === undefined
        ? this.initializing ? 'reading Host state' : 'unavailable'
        : observationCurrent
          ? view.status === 'credential-stored' ? 'credential stored' : 'signed out'
          : view.status === 'credential-stored' ? 'stale: signed in' : 'stale: signed out'
      : view === undefined
        ? this.initializing ? 'Reading Host account state…' : 'Unavailable'
        : observationCurrent
          ? view.status === 'credential-stored' ? 'Signed in (stored credential)' : 'Signed out / no stored credential'
          : view.status === 'credential-stored' ? 'Last known: signed in · Host state not current' : 'Last known: signed out · Host state not current'
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
    const viewDerivedActionsCurrent = observationCurrent
    const profileText = this.profileText()
    const balanceText = this.balanceText()
    content.push(...this.fact('Profile', viewDerivedActionsCurrent ? profileText : `last known · not current · ${profileText}`, width))
    content.push(...this.fact('Balance', viewDerivedActionsCurrent ? balanceText : `last known · not current · ${balanceText}`, width))
    const callbackOrigin = viewDerivedActionsCurrent ? this.source.callbackOrigin() : undefined
    content.push(...this.fact('Callback', callbackOrigin ?? 'unavailable — the Host account observation is not current', width))
    const url = viewDerivedActionsCurrent ? attempt?.authorizeUrl : undefined
    if (url !== undefined) {
      content.push('', color.textStrong('Browser authorization'))
      content.push(...this.wrapText(url, width))
      const host = viewDerivedActionsCurrent ? this.callbackHost() : undefined
      const port = viewDerivedActionsCurrent ? this.callbackPort() : undefined
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
      if (!observationCurrent) {
        content.push(color.error('The Host Account state is not current. Refresh before signing out.'))
      } else if (this.taskCheck.kind === 'checking' || this.taskCheck.kind === 'idle') {
        content.push(color.textDim('Checking running account tasks…'))
      } else if (this.taskCheck.kind === 'known' && this.taskCheck.running) {
        content.push(color.error('A running agent is using a deepseek-account model. Signing out lets the Host cancel that matching account task.'))
      } else if (this.taskCheck.kind === 'known') {
        content.push(color.textDim('No running account task is using this account.'))
      } else {
        content.push(color.error('Could not verify whether running account tasks will be cancelled.'))
      }
      content.push(color.textDim('The provider revokes the grant in the background; a remote failure never restores the local credential.'))
    }
    content.push(color.textDim('The Account token is never shown. Profile and balance are independent Host queries; a failure is stated on its own line.'))
    if (this.notice !== undefined) content.push('', color.warning(sanitizedPhysicalLine(this.notice)))
    if (this.busy !== undefined) content.push('', color.textMuted(`${this.busy} — the Host has not confirmed yet`))
    const actions: ActionLine[] = []
    if (this.signOutConfirm) {
      actions.push({ id: 'account:signout-confirm', label: 'Sign out', enabled: this.canCommitSignOut() })
      if (this.taskCheck.kind === 'unavailable') {
        actions.push({ id: 'account:signout-retry', label: 'Retry task check', enabled: this.canRetryTaskCheck() })
      }
      actions.push({ id: 'account:signout-cancel', label: 'Cancel', enabled: true })
    } else {
      if (view?.status !== 'credential-stored' && attempt === undefined) {
        actions.push({ id: 'account:signin', label: 'Sign in', enabled: this.canStartSignIn() })
      }
      if (attempt !== undefined) actions.push({ id: 'account:cancel', label: 'Cancel current attempt', enabled: this.canCancelAttempt() })
      if (url !== undefined) {
        actions.push({ id: 'account:open', label: 'Open browser', enabled: true })
        actions.push({ id: 'account:copy-url', label: 'Copy link', enabled: true })
        if (viewDerivedActionsCurrent && this.callbackPort() !== undefined) actions.push({ id: 'account:copy-ssh', label: 'Copy SSH template', enabled: true })
      }
      if (view !== undefined) {
        actions.push({ id: 'account:usage', label: 'Usage ↗', enabled: viewDerivedActionsCurrent })
        actions.push({ id: 'account:topup', label: 'Top up ↗', enabled: viewDerivedActionsCurrent })
      }
      if (view?.status === 'credential-stored') {
        actions.push({
          id: 'account:signout',
          label: 'Sign out…',
          enabled: this.canBeginSignOut(),
        })
      }
      actions.push({ id: 'account:refresh', label: 'Refresh', enabled: this.busy === undefined })
    }
    actions.push({ id: 'account:back', label: '← Settings', enabled: true })
    this.copyValue = observationCurrent ? url ?? view?.links.usageUrl : undefined
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
    // The last painted frame either has not adopted this height yet or showed
    // only the Esc fallback. No other key may run an invisible body action.
    if ((this.bodyHeightStale || this.fallbackActive) && !matchesKey(data, 'escape')) return 'handled'
    if (matchesKey(data, 'escape') || matchesKey(data, 'backspace')) {
      if (this.busy !== undefined) {
        this.notice = 'an account operation is still in flight — wait for the Host outcome'
        this.requestRender()
        return 'handled'
      }
      if (this.signOutConfirm) {
        this.closeSignOutConfirmation()
        this.revision += 1
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
      if (this.paintedCopy && this.copyValue !== undefined
        && this.hasCurrentObservation()) this.copy(this.copyValue)
      return 'handled'
    }
    if (data === 'o' || data === 'O') {
      if (this.hasCurrentObservation()) {
        const url = this.activeAttempt()?.authorizeUrl
        if (url !== undefined) this.openUrl(url)
      }
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
      case 'account:signout-retry': {
        const lease = this.currentObservationLease()
        if (lease === undefined || !this.canRetryTaskCheck() || this.view === undefined) return 'handled'
        this.checkRunningTaskFact(this.view, lease)
        this.revision += 1
        this.requestRender()
        return 'handled'
      }
      case 'account:signout-cancel':
        this.closeSignOutConfirmation()
        this.revision += 1
        this.requestRender()
        return 'handled'
      case 'account:open':
        if (this.hasCurrentObservation() && attempt?.authorizeUrl !== undefined) this.openUrl(attempt.authorizeUrl)
        return 'handled'
      case 'account:copy-url':
        if (this.hasCurrentObservation() && attempt?.authorizeUrl !== undefined) this.copy(attempt.authorizeUrl)
        return 'handled'
      case 'account:copy-ssh': {
        if (!this.hasCurrentObservation()) return 'handled'
        const template = this.sshTemplate()
        if (template !== undefined) this.copy(template)
        return 'handled'
      }
      case 'account:usage':
        if (this.hasCurrentObservation() && view !== undefined) this.openUrl(view.links.usageUrl)
        return 'handled'
      case 'account:topup':
        if (this.hasCurrentObservation() && view !== undefined) this.openUrl(view.links.topUpUrl)
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

  /**
   * Whether a bare Left may yield from the page ROOT to the Settings
   * categories. It is a pure query: it reads no Host fact and changes no
   * business state. A pending sign-in/sign-out and the sign-out confirmation
   * keep the Left for the page.
   */
  canYieldFocusToNavigation(): boolean {
    return !this.signOutConfirm && this.busy === undefined
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

function queryStateOf<T>(outcome: AccountQueryOutcome<T>): QueryState<T> | undefined {
  if (outcome.status === 'superseded') return undefined
  if (outcome.status === 'ready') return { kind: 'ready', value: outcome.value }
  if (outcome.status === 'failed') return { kind: 'failed', reason: outcome.reason }
  return { kind: 'signed-out' }
}
