/**
 * The application command layer's authorization bridge: the /login surface's
 * half of the config port's authorization contract. The Host seam owns the
 * protocol and the lifecycle (OAuth, device-code, provider-native flows are
 * llm-pi-ai's business, never this file's); the Direct adapter maps the Host
 * entries into the detached flow targets, and this module
 *
 *   1. merges those flow targets with the CredentialRef targets (the two key
 *      spaces stay distinct — a route with an explicit `apiKeyEnv` profile
 *      keeps the reference path even when the same route has an authorization
 *      flow),
 *   2. renders notices through the host's durable output panel (a device-
 *      code URL must stay visible while the user opens the browser), and
 *   3. maps prompts (text/secret/select) onto the host question/picker
 *      surfaces, converting a user decline into `AuthorizationDeclinedError`
 *      and keeping a prompt-level signal withdrawal distinct from a decline.
 *
 * Nothing here knows a provider: it renders whatever the port reports.
 *
 * @module @xmoon76/dsh-pi-tui/app/command/authorization
 */

import type { AuthorizationNotice } from '@deepseek-ai/dsh-authorization'
import type {
  AuthorizationConfig,
  AuthorizationFlowEvent,
  AuthorizationFlowTarget,
  AuthorizationNoticeEvent,
  AuthorizationPromptEvent,
  CredentialProviderOption,
} from '../../runtime/config-port.ts'

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
  | AuthorizationFlowTarget

/** The flow target for a provider route, when one is registered. */
export function flowForRoute(targets: readonly AuthorizationFlowTarget[], route: string): AuthorizationFlowTarget | undefined {
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
  options: readonly CredentialProviderOption[],
  targets: readonly AuthorizationFlowTarget[],
): LoginTarget[] {
  const flowByRoute = new Map<string, AuthorizationFlowTarget>()
  const standalone: AuthorizationFlowTarget[] = []
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

/** The render surface an interaction needs — the narrow slice of the mounted
 *  TUI surface (output viewer / question flow / picker) the headless tests can
 *  fake; declared structurally so this application owner never imports the TUI
 *  implementation. */
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
 * Build the client half of one authorization attempt. One instance per
 * attempt: it consumes the port's detached EVENTS and answers through
 * `respond`/`cancel` — the TUI never hands the Host a callback-bearing
 * interaction (transport rule; migration M1.9).
 *
 * The flow is ATTEMPT-SCOPED: `bind(attemptId)` (called after the runner's
 * `begin` returns) locks the flow to one attempt — events for ANY other
 * attempt are ignored, so two concurrent logins can never consume each
 * other's prompts or settlements. Events that arrive between the
 * subscription (registered BEFORE begin, so no early event is missed) and
 * the bind are buffered and replayed for the matching attempt only.
 *
 * Prompt mapping (client-local, unchanged from the interaction era):
 * - `text` and `secret` go through the question flow's free-text row;
 *   `secret` is rendered masked (the real value never leaves the input's
 *   memory and is never logged, put in history, or shown anywhere else);
 * - `select` goes through the picker and answers with the chosen option's
 *   `id`, never its label;
 * - the user closing the question is a decline (answered as `null`);
 * - a flow WITHDRAWING a prompt arrives as a `prompt-withdrawn` event:
 *   the open UI closes and the prompt is NOT answered (the adapter
 *   already rejected its pending bridge — a refusal, never a decline).
 * The open prompt UI is tracked PER PROMPT ID, so a withdrawal of one
 * prompt can never close another prompt's UI.
 */
export function createAuthorizationFlow(
  app: AuthorizationSurface,
  port: Pick<AuthorizationConfig, 'respond' | 'cancel'>,
): {
  /** Lock the flow to one attempt id (the runner calls it after begin).
   * Events received before the bind are buffered and replayed for the
   * matching attempt only; all other attempts' events are ignored. */
  bind(attemptId: string): void
  /** Feed one attempt event (the runner forwards the subscription). */
  onEvent(event: AuthorizationFlowEvent): void
  /** The attempt outcome, resolved on the `settled` event. */
  outcome: Promise<{ status: 'authorized' | 'cancelled' | 'failed'; code?: string; message?: string }>
  /** Close the notice panel and any open prompt UI (attempt settled). */
  close(): void
} {
  let noticeHandle: (() => void) | undefined
  let noticeBody = ''
  /** The prompt UI open per PROMPT id (a withdrawal closes exactly the
   * prompt it names; answers settle exactly the prompt they answer). */
  const openPrompts = new Map<string, { withdraw(): void }>()
  /** Events received before `bind`, keyed by ATTEMPT id (the subscription
   * starts before the attempt id is known — the runner subscribes before
   * begin). BOUNDED per attempt and total: the window is one microtask
   * turn in practice, but a wedged begin must never grow the buffer
   * without limit or retain a concurrent attempt's payloads past
   * close(). A pre-bind TERMINAL event of ANOTHER attempt must never
   * settle this flow (attempt isolation) — the terminal event is only
   * applied at bind() for the matching id. */
  const buffered = new Map<string, AuthorizationFlowEvent[]>()
  const BUFFER_LIMIT = 32
  let boundAttemptId: string | undefined
  let closed = false
  /** Resolve the attempt outcome when the `settled` event arrives. */
  let settle: (outcome: { status: 'authorized' | 'cancelled' | 'failed'; code?: string; message?: string }) => void
  const outcome = new Promise<{ status: 'authorized' | 'cancelled' | 'failed'; code?: string; message?: string }>((resolve) => {
    settle = resolve
  })
  const showNotice = (notice: AuthorizationNoticeEvent): void => {
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
    for (const open of openPrompts.values()) open.withdraw()
    openPrompts.clear()
    noticeHandle?.()
    noticeHandle = undefined
    buffered.clear()
    closed = true
  }
  /** Present one prompt event and answer it through the port. */
  const presentPrompt = (event: {
    attemptId: string
    promptId: string
    prompt: AuthorizationPromptEvent
  }): void => {
    const { attemptId, promptId, prompt } = event
    // A duplicate prompt event (same attempt + prompt id while a UI for
    // that prompt is ALREADY open) is IGNORED: presenting it again would
    // overwrite the open handle, and a late callback of the old UI could
    // answer or withdraw the NEW prompt (review finding). Prompt ids are
    // bridge-generated unique ids, but a wire backend must not be able to
    // corrupt the client's open-prompt map with duplicates.
    if (openPrompts.has(promptId)) return
    const finish = (answer: string | null): void => {
      const open = openPrompts.get(promptId)
      if (open === undefined) return // already withdrawn or settled
      openPrompts.delete(promptId)
      // The answer rides `respond` (null = the human declined); a
      // rejection is dropped — the attempt stays alive.
      port.respond(attemptId, promptId, answer).then(undefined, () => {})
    }
    if (prompt.kind === 'select') {
      const picker = new Promise<string | null>((resolve) => {
        let settled = false
        let handle: { close?: () => void } | undefined
        openPrompts.set(promptId, {
          withdraw: () => {
            if (settled) return
            settled = true
            handle?.close?.()
            resolve(null) // dropped: the withdrawn prompt is never answered
          },
        })
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
            resolve(value)
          },
          () => {
            if (settled) return
            settled = true
            resolve(null)
          },
          { header: prompt.message, enableSearch: true },
        )
        // The withdrawal may have fired SYNCHRONOUSLY while openPicker ran
        // (before `handle` was assigned) — settle already happened, so
        // close the now-known handle here instead of in the withdrawer.
        if (settled) handle?.close?.()
      })
      picker.then((picked) => finish(picked), () => {})
      return
    }
    // text / secret: the question flow's free-text row, closable through
    // an AbortController the withdrawal aborts.
    const controller = new AbortController()
    openPrompts.set(promptId, {
      withdraw: () => { controller.abort() },
    })
    app.askQuestions(
      [{
        id: 'answer',
        question: prompt.message,
        ...(prompt.placeholder !== undefined && prompt.placeholder !== ''
          ? { placeholder: prompt.placeholder }
          : {}),
        ...(prompt.kind === 'secret' ? { masked: true } : {}),
      }],
      controller.signal,
    ).then((answers) => {
      const text = answers[0]?.custom ?? ''
      // An empty typed answer counts as skipped (Web semantics) — for an
      // authorization prompt that IS a decline.
      finish(text === '' ? null : text)
    }, () => {
      // The question was closed (the user, or the withdrawal abort): a
      // user close is a decline; a withdrawal must NOT answer.
      if (controller.signal.aborted) return
      finish(null)
    })
  }
  /** Handle one event of the BOUND attempt (the switch). */
  const handle = (event: AuthorizationFlowEvent): void => {
    switch (event.kind) {
      case 'notice':
        showNotice(event.notice)
        break
      case 'prompt':
        presentPrompt(event)
        break
      case 'prompt-withdrawn': {
        // The flow withdrew this prompt: close ITS UI, never answer.
        const open = openPrompts.get(event.promptId)
        if (open !== undefined) {
          openPrompts.delete(event.promptId)
          open.withdraw()
        }
        break
      }
      case 'settled':
        settle({ status: event.status, code: event.code, message: event.message })
        close()
        break
    }
  }
  return {
    bind: (attemptId) => {
      // ONE-SHOT: a flow is created per attempt and must never be
      // retargeted — a second bind to a DIFFERENT attempt is a caller
      // bug (the isolation guarantee would silently break otherwise).
      if (boundAttemptId !== undefined) {
        if (boundAttemptId === attemptId) return
        throw new Error(`authorization flow already bound to ${boundAttemptId}, cannot rebind to ${attemptId}`)
      }
      boundAttemptId = attemptId
      // Replay the events that arrived before the attempt id was known
      // (the runner subscribes before begin so no early event is missed);
      // events of ANY other attempt are dropped. The pre-bind terminal
      // event is applied HERE — only for the bound attempt — so a
      // concurrent attempt's settled event can never settle this flow
      // (attempt isolation). Replay STOPS at the terminal event: the flow
      // is closed by settlement, and any events buffered after it (the
      // buffer keeps at most one terminal event) must never reopen UI.
      const pending = buffered.get(attemptId)
      if (pending !== undefined) {
        for (const event of pending) {
          handle(event)
          if (event.kind === 'settled') break
        }
      }
      buffered.clear()
    },
    onEvent: (event) => {
      if (closed) return
      if (boundAttemptId === undefined) {
        // Bounded PER ATTEMPT with TERMINAL-EVENT PRESERVATION: a wedged
        // begin must not grow the buffer without limit, but the bound
        // attempt's SETTLED event is never dropped — the outcome must
        // resolve even if the settlement lands beyond the buffer limit (a
        // silent drop would hang the login forever). At most ONE terminal
        // event per attempt is kept (a later one REPLACES the earlier —
        // the buffer stays bounded and replay stops at settlement).
        // Non-terminal overflow events are dropped (fail-closed).
        // Terminal events of OTHER attempts are kept only in the bounded
        // per-attempt slot and dropped at bind (never applied).
        const pending = buffered.get(event.attemptId) ?? []
        if (event.kind === 'settled') {
          const lastSettled = pending.findIndex(candidate => candidate.kind === 'settled')
          if (lastSettled === -1) {
            pending.push(event)
          } else {
            pending[lastSettled] = event
          }
        } else if (pending.length < BUFFER_LIMIT) {
          pending.push(event)
        }
        buffered.set(event.attemptId, pending)
        return
      }
      if (event.attemptId !== boundAttemptId) return
      handle(event)
    },
    outcome,
    close,
  }
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
