/**
 * Client-local presentation helpers for finalized ContentBlocks.
 *
 * These functions consume only durable metadata. They never resolve attachment
 * bytes or paths, and unknown finalized blocks stay explicit and bounded.
 * @module @xmoon76/dsh-pi-tui/content-block-presentation
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { formatBytes } from './image/errors.ts'

/** Match the Web JsonBlock serialized-payload bound. */
export const FINALIZED_BLOCK_PAYLOAD_MAX_CHARS = 20_000

/** The durable metadata needed for a file's human-facing summary. */
export interface FileAttachmentPresentationRef {
  readonly name: string
  readonly bytes: number
}

/** Render a FileBlock attachment without exposing its opaque storage id. */
export function fileAttachmentSummary(attachment: FileAttachmentPresentationRef): string {
  return `📄 ${attachment.name} · ${formatBytes(attachment.bytes)}`
}

/** The flat marker for one known attachment occurrence. */
function attachmentMarker(block: ContentBlock): string | undefined {
  if (block.type === 'image') return `🖼️ ${block.attachment.name ?? 'image'}`
  if (block.type === 'file') return `📄 ${block.attachment.name}`
  return undefined
}

/**
 * Build the lightweight ordered text projection used by user transcript
 * search and loader-less rendering. Known attachments retain their positions;
 * other non-text blocks remain in their structured content only.
 */
export function textWithAttachmentMarkers(blocks: readonly ContentBlock[]): string {
  let text = ''
  let boundary = false
  for (const block of blocks) {
    if (block.type === 'text') {
      if (boundary && text !== '' && !/\s$/.test(text) && !/^\s/.test(block.text)) text += ' '
      boundary = false
      text += block.text
      continue
    }
    const marker = attachmentMarker(block)
    if (marker === undefined) continue
    if (text !== '' && !/\s$/.test(text)) text += ' '
    text += marker
    boundary = true
  }
  return text
}

/** Sanitize and bound a provider-supplied block type for a heading. */
function safeBlockTypeLabel(type: unknown): string {
  if (typeof type !== 'string') return 'unknown'
  const safeType = type.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
  if (safeType === '') return 'unknown'
  return safeType.length <= 120 ? safeType : `${safeType.slice(0, 119)}…`
}

/** Read and bound the type tag for the explicit unknown-block heading. */
function blockType(block: unknown): string {
  if (typeof block !== 'object' || block === null) return 'unknown'
  return safeBlockTypeLabel((block as { readonly type?: unknown }).type)
}

/** Serialize one finalized block and keep its payload bounded. */
function boundedSerializedBlock(block: unknown): string {
  const serialized = JSON.stringify(block, null, 2) ?? String(block)
  if (serialized.length <= FINALIZED_BLOCK_PAYLOAD_MAX_CHARS) return serialized
  return `${serialized.slice(0, FINALIZED_BLOCK_PAYLOAD_MAX_CHARS)}\n… block payload truncated (${serialized.length} characters)`
}

/**
 * Explicit bounded fallback for a finalized block that has no first-class
 * renderer. Callers should route known text/image/file/reasoning/tool-call
 * blocks through their existing semantics before using this fallback.
 */
export function finalizedBlockFallbackText(block: unknown): string {
  return `Unknown block: ${blockType(block)}\n${boundedSerializedBlock(block)}`
}

/** Render an open opaque block without inventing an unfinished payload. */
export function openOpaqueBlockFallbackText(blockType: string): string {
  return `Unknown block: ${safeBlockTypeLabel(blockType)}\nnull`
}

/** Whether a user message contains content the transcript should retain. */
export function userBlocksVisibleNow(blocks: readonly ContentBlock[]): boolean {
  return blocks.some(block => block.type !== 'text' || block.text.trim() !== '')
}
