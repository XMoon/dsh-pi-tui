/**
 * The application adaptation of one semantic pending-input occurrence to the
 * queue-pane presentation projection (TS8-E): the submission/controller owner
 * consumes this, so the queue mirror never reintroduces backend-specific
 * fields.
 * @module @xmoon76/dsh-pi-tui/app/submission/pending-input
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PendingInputItem } from '../../runtime/pending-input-reader-port.ts'

/** One semantic pending-input item as the queue mirror sees it. */
export interface QueueInboxMessage {
  readonly id: string
  readonly content: readonly ContentBlock[]
}

/** Adapt one semantic pending-input item to the queue pane's presentation
 * projection without reintroducing backend-specific fields. */
export function queueInboxMessageOf(item: PendingInputItem): QueueInboxMessage {
  return {
    id: item.id,
    content: item.content as readonly ContentBlock[],
  }
}
