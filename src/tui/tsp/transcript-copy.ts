/** Pure raw-text copy projection for native transcript rows. */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { TranscriptMessage } from '../../domain/transcript/types.ts'
import { assistantVisualPresentation } from '../../domain/visual/presentation.ts'
import { planVisualPlacement } from '../../domain/visual/placement.ts'

export const TRANSCRIPT_COPY_ACTION = 'dsh-transcript-copy'

function textBlocks(blocks: readonly ContentBlock[]): string {
  let text = ''
  for (const block of blocks) if (block.type === 'text') text += block.text
  return text
}

export function transcriptCopyPayload(message: TranscriptMessage): string | undefined {
  if (message.kind === 'user') {
    const text = message.content === undefined ? message.text : textBlocks(message.content)
    return text === '' ? undefined : text
  }
  if (message.kind !== 'assistant' || message.displayBlocks !== undefined) return undefined

  const publications = assistantVisualPresentation(message)?.publications ?? []
  if (publications.length > 0) {
    const plan = planVisualPlacement({
      text: message.text,
      ...(message.content === undefined ? {} : { content: message.content }),
      publications,
    })
    let text = ''
    for (const piece of plan.pieces) if (piece.kind === 'text') text += piece.source
    return text === '' ? undefined : text
  }

  const text = message.content === undefined ? message.text : textBlocks(message.content)
  return text === '' ? undefined : text
}
