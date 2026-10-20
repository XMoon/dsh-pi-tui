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
  AccountProfile,
  AccountProfileOutcome,
  AccountView,
  AccountWallet,
} from '../../runtime/config-port.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'

/** One independent profile/balance query outcome as the page paints it. A
 * port `null` is a signed-out / changed-grant answer, never an empty balance. */
export type AccountQueryOutcome<T> =
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'failed'; readonly reason: string }
  | { readonly status: 'signed-out' }

/** The page-facing source. All methods are intent-level; the Host objects and
 * DTO construction stay in the workflow. */
export interface AccountWorkspaceSource {
  available(): boolean
  callbackOrigin(): string | undefined
  getState(): Promise<AccountView>
  watch(signal: AbortSignal): AsyncIterable<AccountView>
  getProfile(): Promise<AccountQueryOutcome<AccountProfile>>
  getBalance(): Promise<AccountQueryOutcome<{ readonly value: readonly AccountWallet[]; readonly bonusWallets: readonly AccountWallet[] }>>
  startSignIn(): Promise<AccountView>
  cancelSignIn(id: string): Promise<AccountView>
  signOut(): Promise<AccountView>
  hasRunningAccountTasks(): boolean
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
  /** The TUI package version reported to Platform for this client. */
  readonly version: string
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
    return this.deps.account.available()
  }

  callbackOrigin(): string | undefined {
    return this.deps.account.getCallbackOrigin()
  }

  getState(): Promise<AccountView> {
    return this.deps.account.getState()
  }

  watch(signal: AbortSignal): AsyncIterable<AccountView> {
    return this.deps.account.watch(signal)
  }

  async getProfile(): Promise<AccountQueryOutcome<AccountProfile>> {
    let outcome: AccountProfileOutcome
    try {
      outcome = await this.deps.account.getProfile(accountClientMetadata(this.deps.version))
    } catch (error) {
      return { status: 'failed', reason: safeErrorMessage(error) }
    }
    if (outcome === null) return { status: 'signed-out' }
    if (outcome.status === 'failed') return { status: 'failed', reason: 'the Platform profile request failed' }
    return { status: 'ready', value: outcome.value }
  }

  async getBalance(): Promise<AccountQueryOutcome<{ readonly value: readonly AccountWallet[]; readonly bonusWallets: readonly AccountWallet[] }>> {
    let outcome: AccountBalanceOutcome
    try {
      outcome = await this.deps.account.getBalance(accountClientMetadata(this.deps.version))
    } catch (error) {
      return { status: 'failed', reason: safeErrorMessage(error) }
    }
    if (outcome === null) return { status: 'signed-out' }
    if (outcome.status === 'failed') return { status: 'failed', reason: 'the Platform balance request failed' }
    return { status: 'ready', value: { value: outcome.value, bonusWallets: outcome.bonusWallets } }
  }

  startSignIn(): Promise<AccountView> {
    return this.deps.account.startSignIn(accountClientMetadata(this.deps.version))
  }

  cancelSignIn(id: string): Promise<AccountView> {
    return this.deps.account.cancelSignIn(id)
  }

  signOut(): Promise<AccountView> {
    return this.deps.account.signOut(accountClientMetadata(this.deps.version))
  }

  hasRunningAccountTasks(): boolean {
    return this.deps.account.hasRunningAccountTasks()
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
