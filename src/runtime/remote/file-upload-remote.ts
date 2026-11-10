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

interface PreparedSource {
  readonly body: ReadableStream<Uint8Array>
  /**
   * Release the Client source iterator. Idempotent, and independent of the
   * stream's lock state: an early HTTP rejection can make the carrier stop
   * pulling while the request body is still locked, so closing through the
   * iterator (never only through `body.cancel`) is what runs the generator's
   * `finally` and closes its file descriptor.
   */
  close(): Promise<void>
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
): Promise<PreparedSource> {
  if (file.source.kind !== 'client-stream') {
    throw new RemoteFileUploadError('session/prompt-file-unsupported', 'recalled files cannot be re-uploaded by this Client')
  }
  const iterator = file.source.open(signal)[Symbol.asyncIterator]()
  const first = await iterator.next()
  /**
   * The ONE release of this source. Every caller (the upload's failure path
   * and a concurrent carrier cancel) shares the SAME promise, so none of them
   * reports completion before the iterator's `finally` has actually run; a
   * rejection is observed identically by all of them.
   */
  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> => {
    closePromise ??= (async (): Promise<void> => {
      await iterator.return?.()
    })()
    return closePromise
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.done === true) controller.close()
      else controller.enqueue(first.value)
    },
    async pull(controller) {
      if (closePromise !== undefined) {
        controller.close()
        return
      }
      signal.throwIfAborted()
      const next = await iterator.next()
      // A close raced this pull (early carrier refusal / abort): the stream is
      // already canceled, so no controller action is legal or needed.
      if (closePromise !== undefined) return
      signal.throwIfAborted()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel() {
      await close()
    },
  })
  return { body, close }
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
      const source = await prepareSource(prepared, signal)
      let primary: unknown
      try {
        signal.throwIfAborted()
        const query = new URLSearchParams({ sessionId, name: prepared.name })
        const response = await fetch(`/api/session/uploadFileBinary?${query}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: source.body,
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
      } catch (error) {
        primary = error
        throw error
      } finally {
        // The carrier can reject BEFORE consuming the request body (an early
        // HTTP refusal, a carrier failure or an abort). The Client source must
        // still be released on every exit path so the streamer's `finally`
        // closes its file descriptor; a completed stream closes as a no-op.
        try {
          await source.close()
        } catch (closeError) {
          if (primary !== undefined) {
            throw new AggregateError(
              [primary, closeError],
              'file upload failed and the Client file source could not be closed',
            )
          }
          throw closeError
        }
      }
    },
  }
}
