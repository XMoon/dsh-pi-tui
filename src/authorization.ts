/**
 * The rc.1 authorization bridge: the TUI's half of the
 * `@deepseek-ai/dsh-authorization` seam. The seam owns the protocol and the
 * lifecycle (OAuth, device-code, provider-native flows are llm-pi-ai's
 * business, never this file's); this module only
 *
 *   1. turns upstream flow descriptors into typed /login targets,
 *   2. merges them with the CredentialRef targets (the two key spaces stay
 *      distinct — a route with an explicit `apiKeyEnv` profile keeps the
 *      reference path even when the same route has an authorization flow),
 *   3. renders notices through the host's durable output panel (a device-
 *      code URL must stay visible while the user opens the browser), and
 *   4. maps prompts (text/secret/select) onto the host question/picker
 *      surfaces, converting a user decline into `AuthorizationDeclinedError`
 *      and keeping a prompt-level signal withdrawal distinct from a decline.
 *
 * Nothing here knows a provider: it renders whatever the seam reports.
 *
 * @module @xmoon76/dsh-pi-tui/authorization
 */

import {
  AuthorizationDeclinedError,
  type AuthorizationEntry,
  type AuthorizationInteraction,
  type AuthorizationNotice,
  type AuthorizationPrompt,
} from '@deepseek-ai/dsh-authorization'
import {
  credentialKeyId,
  credentialKeyScope,
  type CredentialKey,
} from '@deepseek-ai/dsh-credentials'
import { cancellationError } from './detached.ts'
import type { ProviderOption } from './provider-catalog.ts'
import type { TuiApp } from './tui-app.ts'

/** The record scope every llm-pi-ai provider flow writes under (matches
 * `@deepseek-ai/dsh-llm-pi-ai`'s RECORD_SCOPE — the TUI addresses flows by
 * route through it). */
export const LLM_PI_AI_SCOPE = 'llm-pi-ai'

/** One authorization flow as the /login surface sees it. */
export interface AuthorizationTarget {
  kind: 'authorization'
  /** The provider route the flow authenticates, when the key's scope maps
   *  one (llm-pi-ai flows are keyed `llm-pi-ai/<route>`); undefined for
   *  flows owned by other plugins that no route profile addresses. */
  route?: string
  /** The credential record this flow writes. */
  key: CredentialKey
  /** User-facing label of what is being authorized. */
  label: string
  /** The offered sign-in methods, most preferred first. */
  methods: readonly { id: string; label: string }[]
  /** Whether an attempt is running for this key right now. */
  inFlight: boolean
}

/** One /login or /logout target: either a CredentialRef to set, or an
 *  authorization flow to run. The two address spaces stay typed apart. */
export type LoginTarget =
  | {
      kind: 'reference'
      route: string
      label: string
      ref: string
      configured: boolean
      declared: boolean
      namesCredential: boolean
    }
  | AuthorizationTarget

/** The structural authorization service surface the commands read. */
export interface AuthorizationServiceLike {
  list(): readonly AuthorizationEntry[]
  describe(key: CredentialKey): AuthorizationEntry | undefined
  begin(request: {
    key: CredentialKey
    method?: string
    interaction: AuthorizationInteraction
    signal?: AbortSignal
  }): Promise<{ status: 'authorized' | 'cancelled' }>
  cancel(key: CredentialKey): void
}

/** Map the seam's entries to /login targets, deriving the route from the
 *  key's scope (llm-pi-ai flows address the provider route). */
export function authorizationTargets(entries: readonly AuthorizationEntry[]): AuthorizationTarget[] {
  return entries.map(entry => ({
    kind: 'authorization',
    route: credentialKeyScope(entry.key) === LLM_PI_AI_SCOPE ? credentialKeyId(entry.key) : undefined,
    key: entry.key,
    label: entry.label,
    methods: entry.methods,
    inFlight: entry.inFlight,
  }))
}

/** The flow target for a provider route, when one is registered. */
export function flowForRoute(targets: readonly AuthorizationTarget[], route: string): AuthorizationTarget | undefined {
  return targets.find(target => target.route === route)
}

/**
 * Merge the reference targets and the authorization flows into the /login
 * picker set, applying the rc.1 dedup rule per route:
 *
 * - explicit `apiKeyEnv` profile → the reference target wins (the flow is
 *   NOT offered as a second default entry for the same route — requests
 *   resolve the reference first and a "successful" flow login would leave
 *   the reference unset, failing the next request);
 * - keyless route with a flow → the authorization target wins (no derived
 *   `<ROUTE>_API_KEY` entry is offered as a default);
 * - keyless route without a flow → the derived reference fallback.
 *
 * Flows whose key maps no option route (foreign scopes, or catalog routes
 * the llm directory does not expose) are appended as standalone targets.
 */
export function mergeLoginTargets(
  options: readonly ProviderOption[],
  targets: readonly AuthorizationTarget[],
): LoginTarget[] {
  const flowByRoute = new Map<string, AuthorizationTarget>()
  const standalone: AuthorizationTarget[] = []
  for (const target of targets) {
    if (target.route !== undefined) flowByRoute.set(target.route, target)
    else standalone.push(target)
  }
  const merged: LoginTarget[] = []
  const covered = new Set<string>()
  for (const option of options) {
    const flow = flowByRoute.get(option.route)
    merged.push(option.namesCredential || flow === undefined
      ? {
          kind: 'reference',
          route: option.route,
          label: option.label,
          ref: option.ref,
          configured: option.configured,
          declared: option.declared,
          namesCredential: option.namesCredential,
        }
      : flow)
    covered.add(option.route)
  }
  for (const target of targets) {
    if (target.route === undefined || !covered.has(target.route)) merged.push(target)
  }
  return merged
}

/**
 * The one user-facing notice body: the message first, then the page to open
 * and the code to enter, each on its own line. Never truncated — the
 * output panel wraps, so the URL stays copyable. Notices never carry
 * secrets.
 */
export function formatAuthorizationNotice(notice: AuthorizationNotice): string {
  const lines = [notice.message]
  if (notice.url !== undefined && notice.url !== '') {
    lines.push('', 'Open this page to continue:', notice.url)
  }
  if (notice.code !== undefined && notice.code !== '') {
    lines.push('', `Code: ${notice.code}`)
  }
  return lines.join('\n')
}

/** The render surface an interaction needs — a slice of {@link TuiApp}
 *  the headless tests can fake. */
export interface AuthorizationSurface {
  /** Show a durable text panel; returns a closer. */
  openOutputViewer(options: {
    title: string
    initial: string
    refresh: () => string
    onClose?: () => void
  }): () => void
  askQuestions(
    questions: readonly {
      id: string
      question: string
      placeholder?: string
      masked?: boolean
    }[],
    signal?: AbortSignal,
  ): Promise<readonly { id: string; selected: string[]; custom?: string }[]>
  openPicker(
    items: readonly { value: string; label?: string; description?: string }[],
    onSelect: (value: string) => void,
    onCancel: () => void,
    options?: { header?: string; enableSearch?: boolean },
  ): { close?: () => void }
}

/**
 * Build the interaction half of one authorization attempt. One instance per
 * attempt: the notice panel is reused across progress notices, and
 * `close()` hides it when the attempt settles (the caller's finally).
 *
 * Prompt mapping:
 * - `text` and `secret` go through the question flow's free-text row;
 *   `secret` is rendered masked (the real value never leaves the input's
 *   memory and is never logged, put in history, or shown anywhere else);
 * - `select` goes through the picker and returns the chosen option's `id`,
 *   never its label;
 * - the user closing the question is a decline → `AuthorizationDeclinedError`;
 * - the prompt's OWN signal withdrawing it is NOT a decline: the rejection
 *   is passed through as-is so the flow can tell a refusal from a race.
 */
export function createAuthorizationInteraction(app: AuthorizationSurface): {
  interaction: AuthorizationInteraction
  close: () => void
} {
  let noticeHandle: (() => void) | undefined
  let noticeBody = ''
  const showNotice = (notice: AuthorizationNotice): void => {
    noticeBody = formatAuthorizationNotice(notice)
    if (noticeHandle === undefined) {
      noticeHandle = app.openOutputViewer({
        title: 'Sign in',
        initial: noticeBody,
        refresh: () => noticeBody,
        onClose: () => { noticeHandle = undefined },
      })
    }
  }
  const close = (): void => {
    noticeHandle?.()
    noticeHandle = undefined
  }
  const interaction: AuthorizationInteraction = {
    notify: (notice) => { showNotice(notice) },
    prompt: async (prompt: AuthorizationPrompt) => {
      if (prompt.kind === 'select') {
        // The picker is a plain promise with no built-in abort: race it
        // against the prompt's own signal so a withdrawn prompt closes the
        // picker and rejects with a NON-decline cancellation (the flow
        // decides what to do next — a user closing the picker is the only
        // decline).
        const signal = prompt.signal
        const picked = await new Promise<string>((resolve, reject) => {
          if (signal?.aborted === true) {
            reject(cancellationError('authorization prompt withdrawn'))
            return
          }
          let settled = false
          let handle: { close?: () => void } | undefined
          const cleanup = (): void => {
            if (signal !== undefined) signal.removeEventListener('abort', onAbort)
          }
          const onAbort = (): void => {
            if (settled) return
            settled = true
            cleanup()
            handle?.close?.()
            reject(cancellationError('authorization prompt withdrawn'))
          }
          if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
          handle = app.openPicker(
            prompt.options.map(option => ({
              value: option.id,
              label: option.label,
              ...(option.description !== undefined && option.description !== ''
                ? { description: option.description }
                : {}),
            })),
            (value) => {
              if (settled) return
              settled = true
              cleanup()
              resolve(value)
            },
            () => {
              if (settled) return
              settled = true
              cleanup()
              reject(new AuthorizationDeclinedError())
            },
            { header: prompt.message, enableSearch: true },
          )
          // The signal may have fired SYNCHRONOUSLY while openPicker ran
          // (before `handle` was assigned) — settle already happened, so
          // close the now-known handle here instead of in onAbort.
          if (settled) handle?.close?.()
        })
        return picked
      }
      try {
        const answers = await app.askQuestions(
          [{
            id: 'answer',
            question: prompt.message,
            ...(prompt.placeholder !== undefined && prompt.placeholder !== ''
              ? { placeholder: prompt.placeholder }
              : {}),
            ...(prompt.kind === 'secret' ? { masked: true } : {}),
          }],
          prompt.signal,
        )
        const text = answers[0]?.custom ?? ''
        // An empty typed answer counts as skipped (Web semantics) — for an
        // authorization prompt that IS a decline.
        if (text === '') throw new AuthorizationDeclinedError()
        return text
      } catch (error) {
        // The prompt's own signal withdrew it: NOT a decline. askQuestions
        // closes the question on abort; the flow decides what to do next.
        if (prompt.signal?.aborted === true) throw error
        throw new AuthorizationDeclinedError()
      }
    },
  }
  return { interaction, close }
}

/** The user-facing text for one authorization attempt failure, mapping the
 *  seam's stable error taxonomy to copy (plan §15). `unknownErrorText` is
 *  the safe fallback for provider/network errors (already passed through
 *  safeErrorMessage by the caller). */
export function authorizationFailureText(error: unknown, unknownErrorText: string): string {
  const code = (error as { code?: unknown } | null)?.code
  switch (code) {
    case 'NO_FLOW':
      return 'login method is no longer available'
    case 'UNKNOWN_METHOD':
      return 'selected login method is no longer available'
    case 'ALREADY_IN_FLIGHT':
      return 'sign-in already in progress'
    case 'NOT_COMMITTED':
      return 'sign-in finished without storing a credential'
    case 'DECLINED':
      return 'login cancelled'
    default:
      return `sign-in failed: ${unknownErrorText}`
  }
}
