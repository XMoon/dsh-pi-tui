/**
 * Admit generic file drafts into the DSH attachment service (Stage C2).
 *
 * The application-owned Host sink: the source BYTES come from the Client-local
 * streamer (`client/media/attachment/file-stream.ts`); this module only
 * delegates each draft to the injected Direct Host `saveFileStream`. Recalled
 * drafts are already durable and are reused without a stream.
 * @module @xmoon76/dsh-pi-tui/attachment/file-admission
 */

import { streamDraftFile } from '../client/media/attachment/file-stream.ts'
import type { DraftFile } from '../client/media/attachment/file-draft.ts'
import type { FileAttachmentRefLike } from '../domain/media/types.ts'

/** Structural subset of DSH's streamed file-admission service. */
export interface FileAttachmentStoreLike {
  saveFileStream(input: {
    readonly data: AsyncIterable<Uint8Array>
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<FileAttachmentRefLike>
}

/** Admit local and recalled file drafts in their original file order. */
export async function admitDraftFiles(
  files: readonly DraftFile[],
  attachments: FileAttachmentStoreLike,
  signal?: AbortSignal,
): Promise<readonly FileAttachmentRefLike[]> {
  const refs: FileAttachmentRefLike[] = []
  for (const file of files) {
    if (file.source.type === 'recalled') {
      refs.push(file.source.ref)
      continue
    }
    refs.push(await attachments.saveFileStream({
      data: streamDraftFile(file, signal),
      ...(signal === undefined ? {} : { signal }),
      name: file.name,
    }))
  }
  return refs
}
