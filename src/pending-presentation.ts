/**
 * The pending-input presentation join (D2.2): the ONE authoritative place that
 * turns the Host-owned pending-input projection plus the client-local
 * submission echoes into the queue-pane and steering-lane rows the TUI renders.
 *
 * The join is identity-only: an authoritative occurrence suppresses a local
 * echo when their `rpcId`/`requestId` match. Text is never a correlation key,
 * so two same-text submissions stay distinct. Authoritative rows always precede
 * client-local echoes, and `context` occurrences never enter the pending USER
 * surface.
 *
 * The runner supplies the content text formatter, so this module stays
 * Host-free and transport-free while the single join rule remains shared by the
 * Direct production path and the experimental Remote path.
 *
 * @module @xmoon76/dsh-pi-tui/pending-presentation
 */

import { pendingSubmissionsNotReplaced } from './pending-submission.ts'
import type { SubmissionPresentationItem } from './submission-presentation.ts'
import type { PendingInputSnapshot } from './runtime/pending-input-reader-port.ts'
import type { PendingUserRow, QueueItem } from './tui-app.ts'

/** The joined pending-input rows for one subject. */
export interface PendingPresentationRows {
  /** Authoritative `queued` occurrences plus client-local queued echoes. */
  readonly queued: readonly QueueItem[]
  /** Authoritative `steering` occurrences plus local user echoes. */
  readonly steering: readonly PendingUserRow[]
  /** Activity of the subject (drives the queue-pane steer hint). */
  readonly running: boolean
}

/** Inputs of one join. */
export interface PendingPresentationInput {
  /** The Host-owned projection, or `undefined` when the subject is unavailable. */
  readonly pending: PendingInputSnapshot | undefined
  /** The client-local optimistic echoes for the subject, insertion-ordered. */
  readonly submissions: readonly SubmissionPresentationItem[]
  /** Render one occurrence's detached content as the pane's single-line text. */
  textOf(content: readonly unknown[]): string
}

/**
 * Join authoritative pending-input occurrences with client-local submission
 * echoes. `context` is deliberately excluded: this surface owns pending USER
 * input only.
 */
export function buildPendingPresentation(input: PendingPresentationInput): PendingPresentationRows {
  const queued: QueueItem[] = []
  const steering: PendingUserRow[] = []
  const running = input.pending?.running ?? false
  if (input.pending !== undefined) {
    for (const item of input.pending.items) {
      if (item.placement === 'queued') {
        queued.push({
          id: item.id,
          ...(item.rpcId === undefined ? {} : { rpcId: item.rpcId }),
          text: input.textOf(item.content),
          mode: 'followup',
        })
      } else if (item.placement === 'steering') {
        steering.push({
          id: item.id,
          ...(item.rpcId === undefined ? {} : { rpcId: item.rpcId }),
          text: input.textOf(item.content),
          status: 'steering',
        })
      }
    }
  }
  // Suppress a local echo only while an authoritative occurrence with the same
  // rpc id is visible. The echo is never deleted here: the Host may claim its
  // pending occurrence before the durable user/message lands, so the echo is
  // re-presented in that window by the caller's next join.
  const authoritativeRpcIds = new Set<string>()
  for (const row of [...queued, ...steering]) {
    if (row.rpcId !== undefined) authoritativeRpcIds.add(row.rpcId)
  }
  for (const echo of pendingSubmissionsNotReplaced(input.submissions, authoritativeRpcIds)) {
    const text = echoText(echo)
    if (echo.placement === 'queued') {
      queued.push({
        id: echo.requestId,
        rpcId: echo.requestId,
        text,
        mode: 'followup',
        local: true,
      })
    } else {
      steering.push({
        id: echo.requestId,
        rpcId: echo.requestId,
        text,
        local: true,
        status: echo.placement === 'transcript' ? 'sending' : 'steering',
      })
    }
  }
  return { queued, steering, running }
}

/**
 * Render one local echo's display text. The Direct ledger carries attachment
 * markers inside `text`; the official Remote pending submission does not, so
 * its structured attachments are appended here — an image-only echo must never
 * render as an empty row.
 */
function echoText(echo: SubmissionPresentationItem): string {
  if (echo.attachments.length === 0) return echo.text
  const markers = echo.attachments.map(attachment =>
    attachment.kind === 'image' ? `[Image: ${attachment.label}]` : `[File: ${attachment.label}]`)
  return [echo.text, ...markers].filter(part => part !== '').join(' ')
}
