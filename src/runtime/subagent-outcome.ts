/**
 * Backend-neutral outcome/error classification for one subagent viewer prompt
 * (TS8-F4): the stable refusal taxonomy shared by the Direct and Remote
 * adapters. Pure and never throwing — it reads structural `code` values only,
 * so the subagent package stays resolvable from the dsh installation and is
 * never imported here.
 * @module @xmoon76/dsh-pi-tui/runtime/subagent-outcome
 */

import { isRemoteBusinessRefusalCode } from './write-outcome.ts'
import type { SubagentPromptReject } from './subagent-port.ts'

/** A failed viewer prompt: a PROVEN refusal vs an ambiguous post-dispatch
 * outcome that may already have committed. */
export type SubagentPromptSettlement =
  | { readonly kind: 'rejected'; readonly reason: SubagentPromptReject }
  | { readonly kind: 'indeterminate'; readonly message: string }

/**
 * Settle a failed viewer prompt. A caller cancellation and every PROVEN refusal
 * code are rejected (a domain `subagent/*` admission refusal, `gateway/bad-request`,
 * or a pre-invocation Gateway infrastructure code); only a carrier/internal/
 * post-invocation failure (`gateway/internal`, `gateway/result-invalid`, an
 * unknown `gateway/*` code) or a code-less throw settles `indeterminate`.
 */
export function classifySubagentPromptSettlement(error: unknown): SubagentPromptSettlement {
  const reason = classifySubagentPromptError(error)
  if (reason.kind !== 'error') return { kind: 'rejected', reason }
  // `error` is the catch-all reason kind: it covers both proven refusals with
  // no dedicated category (invalid attachment/zone, bad request, a legacy
  // code) and genuinely unidentified failures. Only a code that proves refusal
  // is rejected; an unclassified/absent code stays ambiguous.
  if (isRemoteBusinessRefusalCode(remoteErrorCode(error))) return { kind: 'rejected', reason }
  return { kind: 'indeterminate', message: reason.message }
}

/**
 * Classify an official prompt failure into the stable reason set. The Direct
 * adapter reads the official RemoteError vocabulary structurally (the `code`
 * string; the subagent package stays resolvable from the dsh installation,
 * never an import here).
 */
export function classifySubagentPromptError(error: unknown): SubagentPromptReject {
  if (isAbortError(error)) return { kind: 'cancelled' }
  const code = remoteErrorCode(error)
  if (code === 'gateway/cancelled') return { kind: 'cancelled' }
  if (code === 'subagent/parent-unavailable') return { kind: 'parent-unavailable' }
  // A missing or descriptor-damaged addressed child cannot take a
  // continuation, exactly like the official not-resumable case.
  if (code === 'subagent/not-resumable'
    || code === 'subagent/not-found'
    || code === 'subagent/catalog-diagnostic') return { kind: 'stale-child' }
  if (code === 'subagent/unauthorized') return { kind: 'unauthorized' }
  if (code === 'subagent/delivery-unavailable'
    || code === 'subagent/projections-unavailable') return { kind: 'unavailable' }
  return { kind: 'error', message: safeSubagentErrorMessage(error) }
}

/** The stable failure code of a structural official failure, if any. */
function remoteErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' && code !== '' ? code : undefined
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { name?: unknown }).name === 'AbortError'
}

/** One-line safe error text (never throws on hostile values). Shared with the
 * Direct adapter's pre-dispatch catch so both settle the same wording. */
export function safeSubagentErrorMessage(error: unknown): string {
  if (error === undefined || error === null) return 'unknown error'
  if (typeof error === 'string') return error
  if (error instanceof Error) {
    const message = error.message
    return message === '' ? error.name : message
  }
  // The official Client carrier rebuilds a failure as a plain
  // `{code, message, details}` object across the wire, not necessarily an
  // `Error`; prefer its structural message over `String(object)`.
  if (typeof error === 'object') {
    const message = (error as { readonly message?: unknown }).message
    if (typeof message === 'string' && message !== '') return message
  }
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}
