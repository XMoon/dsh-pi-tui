import type { PreparedFile } from '../prepared-prompt.ts'

export interface UploadedPromptFile {
  readonly receiptId: string
  readonly file: {
    readonly attachmentId: string
    readonly name: string
    readonly bytes: number
  }
}

type AuthenticatedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>
type StreamingRequestInit = RequestInit & { readonly duplex: 'half' }

export class RemoteFileUploadError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RemoteFileUploadError'
    this.code = code
  }
}

/**
 * Start the Client source BEFORE the carrier request: the streamer's open-time
 * fingerprint/fstat checks run on this first pull, so a source that is already
 * deleted/replaced/changed fails locally with its actionable error and the
 * Host never receives a partial upload. At most ONE bounded source chunk is
 * held here; everything after it streams directly.
 */
async function prepareSource(
  file: PreparedFile,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  if (file.source.kind !== 'client-stream') {
    throw new RemoteFileUploadError('session/prompt-file-unsupported', 'recalled files cannot be re-uploaded by this Client')
  }
  const iterator = file.source.open(signal)[Symbol.asyncIterator]()
  const first = await iterator.next()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.done === true) controller.close()
      else controller.enqueue(first.value)
    },
    async pull(controller) {
      signal.throwIfAborted()
      const next = await iterator.next()
      signal.throwIfAborted()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel(reason) {
      await iterator.return?.(reason)
    },
  })
}

function objectOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RemoteFileUploadError('session/prompt-upload-invalid-response', 'file upload returned an invalid response')
  }
  return value as Record<string, unknown>
}

/** Client-local streaming adapter for DSH's authenticated raw file upload route. */
export interface RemoteFileReceiptUploader {
  upload(sessionId: string, prepared: PreparedFile, signal: AbortSignal): Promise<UploadedPromptFile>
}

export function createRemoteFileReceiptUploader(fetch: AuthenticatedFetch): RemoteFileReceiptUploader {
  return {
    async upload(sessionId, prepared, signal) {
      signal.throwIfAborted()
      // Local source identity is proven BEFORE the Host sees a request.
      const body = await prepareSource(prepared, signal)
      signal.throwIfAborted()
      const query = new URLSearchParams({ sessionId, name: prepared.name })
      const response = await fetch(`/api/session/uploadFileBinary?${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body,
        duplex: 'half',
        signal,
      } as StreamingRequestInit)
      signal.throwIfAborted()
      if (!response.ok) {
        throw new RemoteFileUploadError(
          'session/prompt-upload-http-failed',
          `file upload failed with HTTP ${response.status}`,
        )
      }

      let payload: Record<string, unknown>
      try {
        payload = objectOf(await response.json())
      } catch (error) {
        if (error instanceof RemoteFileUploadError) throw error
        throw new RemoteFileUploadError(
          'session/prompt-upload-invalid-response',
          'file upload returned invalid JSON',
        )
      }
      signal.throwIfAborted()
      if (payload.ok !== true) {
        const failure = objectOf(payload.error)
        if (typeof failure.code !== 'string' || failure.code === ''
          || typeof failure.message !== 'string' || failure.message === '') {
          throw new RemoteFileUploadError(
            'session/prompt-upload-invalid-response',
            'file upload returned an invalid business error',
          )
        }
        throw new RemoteFileUploadError(failure.code, failure.message)
      }

      const value = objectOf(payload.value)
      const file = objectOf(value.file)
      if (typeof value.receiptId !== 'string' || value.receiptId === ''
        || typeof file.attachmentId !== 'string' || file.attachmentId === ''
        || typeof file.name !== 'string' || file.name === ''
        || typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
        throw new RemoteFileUploadError(
          'session/prompt-upload-invalid-response',
          'file upload returned invalid receipt metadata',
        )
      }
      return {
        receiptId: value.receiptId,
        file: {
          attachmentId: file.attachmentId,
          name: file.name,
          bytes: file.bytes,
        },
      }
    },
  }
}
