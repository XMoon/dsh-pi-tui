/** Internal generation fence for one Native Client's continued Questions. */
export interface NativeContinuedGenerationDelivery {
  readonly sessionId: string
  readonly callId: string
  readonly generation: object | undefined
  readonly controller: AbortController
}

export interface NativeContinuedGenerationSource {
  subscribe(listener: () => void): () => void
}

/**
 * Revoke every no-longer-current continued delivery synchronously when the
 * authoritative connection generation changes, then let the owner re-offer
 * from its retained current projection.
 */
export function guardNativeContinuedGeneration<Delivery extends NativeContinuedGenerationDelivery>(
  source: NativeContinuedGenerationSource,
  deliveries: Map<string, Delivery>,
  isCurrent: (delivery: Delivery) => boolean,
  onRollover: () => void,
): () => void {
  return source.subscribe(() => {
    for (const [key, delivery] of deliveries) {
      if (isCurrent(delivery)) continue
      delivery.controller.abort(new Error('native-client: continued Question generation revoked'))
      deliveries.delete(key)
    }
    onRollover()
  })
}
