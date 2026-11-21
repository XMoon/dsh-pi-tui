/**
 * The DeepSeek Account workflow: one page-lifetime bridge between the
 * `AccountConfig` semantic port and the Account page. It owns ONLY the
 * request/observation orchestration the page needs (state, watch, profile,
 * balance, sign-in/cancel/sign-out, client metadata). It never renders, never
 * stores a token/grant, and never cancels an attempt implicitly: ending the
 * watch subscription or closing the page leaves a browser attempt running on
 * the Host.
 *
 * @module @xmoon76/dsh-pi-tui/app/command/account-workflow
 */

import type {
  AccountBalanceOutcome,
  AccountClientMetadata,
  AccountConfig,
  AccountObservation,
  AccountObservationLease,
  AccountProfile,
  AccountProfileOutcome,
  AccountWatchEvent,
  AccountWallet,
} from '../../runtime/config-port.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import { SupersededReadError } from '../../runtime/read-error.ts'

/** One independent profile/balance query outcome as the page paints it. A
 * port `null` is a signed-out / changed-grant answer, never an empty balance. */
export type AccountQueryOutcome<T> =
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'failed'; readonly reason: string }
  | { readonly status: 'signed-out' }
  | { readonly status: 'superseded' }

/** The fixed, safe refusal shown when this Client cannot prove its installed
 * DSH runtime version. Account metadata must never be synthesized from the
 * TUI bundle version or a dev pin, so no Account request may be dispatched. */
export const ACCOUNT_DSH_VERSION_UNAVAILABLE_REASON = 'The installed DSH version is unavailable; Account requests are disabled.'

/** The page-facing source. All methods are intent-level; the Host objects and
 * DTO construction stay in the workflow. */
export interface AccountWorkspaceSource {
  available(): boolean
  /** A source-specific unavailable reason when it is known to be more precise
   * than the Host Account service being absent (Settings-internal only). */
  unavailableReason?(): string | undefined
  callbackOrigin(): string | undefined
  isObservationCurrent(lease: AccountObservationLease): boolean
  watch(signal: AbortSignal): AsyncIterable<AccountWatchEvent>
  getProfile(lease: AccountObservationLease): Promise<AccountQueryOutcome<AccountProfile>>
  getBalance(lease: AccountObservationLease): Promise<AccountQueryOutcome<{ readonly value: readonly AccountWallet[]; readonly bonusWallets: readonly AccountWallet[] }>>
  startSignIn(lease: AccountObservationLease): Promise<AccountObservation>
  cancelSignIn(id: string, lease: AccountObservationLease): Promise<AccountObservation>
  signOut(lease: AccountObservationLease): Promise<AccountObservation>
  hasRunningAccountTasks(lease: AccountObservationLease): Promise<boolean>
  /** Open one official AccountView link through the Client-local opener. */
  openUrl(url: string): void
  /** Copy a non-secret URL/instruction through the Client clipboard owner. */
  copy(text: string): void
  /** Run one page-owned async operation through the app's ownership entry. */
  run(label: string, task: () => Promise<void>): void
}

/** The workflow dependencies: the semantic port plus the Client-local side
 * effects and the Client identity source. */
export interface AccountWorkflowDeps {
  readonly account: AccountConfig
  /** The installed DSH runtime version carried in Platform `x-client-version`. */
  readonly version: string | undefined
  readonly openUrl: (url: string) => void
  readonly copy: (text: string) => void
  /** Run one page-owned async operation through the app's ownership entry. */
  readonly run: (label: string, task: () => Promise<void>) => void
  readonly diag: { warn(event: string, fields?: Record<string, unknown>): void }
}

/** Sample the request-scoped Client identity. The timezone offset is re-read
 * per Platform request (a DST change must not be reported stale). */
export function accountClientMetadata(version: string): AccountClientMetadata {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale
  return {
    version,
    locale: locale === '' ? 'en-US' : locale,
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

/** The Account page's ONE workflow instance (per Settings workspace open). */
export class AccountWorkflow implements AccountWorkspaceSource {
  private readonly deps: AccountWorkflowDeps

  constructor(deps: AccountWorkflowDeps) {
    this.deps = deps
  }

  available(): boolean {
    return this.deps.version !== undefined
      && this.deps.version !== ''
      && this.deps.account.available()
  }

  unavailableReason(): string | undefined {
    return this.deps.version === undefined || this.deps.version === ''
      ? ACCOUNT_DSH_VERSION_UNAVAILABLE_REASON
      : undefined
  }

  /** The ONE request-metadata guard shared by every metadata-bearing Account
   * RPC. The installed DSH version is mandatory; when it is unavailable the
   * request throws before any Account Port call and never fabricates a
   * version from the TUI bundle or a manifest pin. */
  private metadata(): AccountClientMetadata {
    const version = this.deps.version
    if (version === undefined || version === '') {
      throw new Error(ACCOUNT_DSH_VERSION_UNAVAILABLE_REASON)
    }
    return accountClientMetadata(version)
  }

  callbackOrigin(): string | undefined {
    return this.deps.account.getCallbackOrigin()
  }

  isObservationCurrent(lease: AccountObservationLease): boolean {
    return this.deps.account.isObservationCurrent(lease)
  }

  watch(signal: AbortSignal): AsyncIterable<AccountWatchEvent> {
    return this.deps.account.watch(signal)
  }

  async getProfile(lease: AccountObservationLease): Promise<AccountQueryOutcome<AccountProfile>> {
    let outcome: AccountProfileOutcome
    try {
      outcome = await this.deps.account.getProfile(this.metadata(), lease)
    } catch (error) {
      if (error instanceof SupersededReadError) return { status: 'superseded' }
      return { status: 'failed', reason: safeErrorMessage(error) }
    }
    if (outcome === null) return { status: 'signed-out' }
    if (outcome.status === 'failed') return { status: 'failed', reason: 'the Platform profile request failed' }
    return { status: 'ready', value: outcome.value }
  }

  async getBalance(lease: AccountObservationLease): Promise<AccountQueryOutcome<{ readonly value: readonly AccountWallet[]; readonly bonusWallets: readonly AccountWallet[] }>> {
    let outcome: AccountBalanceOutcome
    try {
      outcome = await this.deps.account.getBalance(this.metadata(), lease)
    } catch (error) {
      if (error instanceof SupersededReadError) return { status: 'superseded' }
      return { status: 'failed', reason: safeErrorMessage(error) }
    }
    if (outcome === null) return { status: 'signed-out' }
    if (outcome.status === 'failed') return { status: 'failed', reason: 'the Platform balance request failed' }
    return { status: 'ready', value: { value: outcome.value, bonusWallets: outcome.bonusWallets } }
  }

  startSignIn(lease: AccountObservationLease): Promise<AccountObservation> {
    return this.deps.account.startSignIn(this.metadata(), lease)
  }

  cancelSignIn(id: string, lease: AccountObservationLease): Promise<AccountObservation> {
    return this.deps.account.cancelSignIn(id, lease)
  }

  signOut(lease: AccountObservationLease): Promise<AccountObservation> {
    return this.deps.account.signOut(this.metadata(), lease)
  }

  hasRunningAccountTasks(lease: AccountObservationLease): Promise<boolean> {
    return this.deps.account.hasRunningAccountTasks(lease)
  }

  openUrl(url: string): void {
    try {
      this.deps.openUrl(url)
    } catch (error) {
      this.deps.diag.warn('account link', { error: safeErrorMessage(error) })
    }
  }

  copy(text: string): void {
    this.deps.copy(text)
  }

  run(label: string, task: () => Promise<void>): void {
    this.deps.run(label, task)
  }
}
