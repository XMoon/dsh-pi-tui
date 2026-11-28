/** Internal generation fence and single-delivery owner for continued Questions. */
export interface NativeContinuedGenerationSource {
  getSnapshot(): object | undefined
  subscribe(listener: () => void): () => void
}

export interface NativeContinuedGenerationDelivery {
  readonly sessionId: string
  readonly binding: object
  readonly callId: string
  readonly generation: object | undefined
  readonly controller: AbortController
}

export interface NativeContinuedQuestionHandle {
  readonly sessionId: string
  readonly isClosed: boolean
  bindingIdentity(): object
  isCurrentBinding(): boolean
  observeUserQuestions(listener: (value: unknown) => void): () => void
}

export interface NativeContinuedQuestionCall {
  readonly callId: string
  readonly questions: unknown
  readonly state: 'open' | 'continued'
}

export interface NativeContinuedQuestionProjection {
  readonly active: readonly NativeContinuedQuestionCall[]
}

export interface NativeContinuedQuestionReceiverOptions {
  readonly generation: NativeContinuedGenerationSource
  readonly handles: Set<NativeContinuedQuestionHandle>
  readonly handlesBySession: Map<string, Set<NativeContinuedQuestionHandle>>
  readonly handleListeners: Set<() => void>
  readonly isClosed: () => boolean
  readonly parseProjection: (value: unknown) => NativeContinuedQuestionProjection
  readonly onInvalidProjection: (error: unknown) => void
  readonly onOffer: (
    sessionId: string,
    binding: object,
    call: NativeContinuedQuestionCall,
  ) => NativeContinuedGenerationDelivery | undefined
}

export interface NativeContinuedQuestionReceiver {
  reconcile(): void
  dispose(): void
}

/**
 * Revoke every no-longer-current continued delivery synchronously when the
 * authoritative connection generation changes, then let the owner re-offer
 * from its retained current projection.
 */
function guardNativeContinuedGeneration<Delivery extends NativeContinuedGenerationDelivery>(
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

/** The one Client-owned continued Question receiver shared by all handles. */
export function createNativeContinuedQuestionReceiver(
  options: NativeContinuedQuestionReceiverOptions,
): NativeContinuedQuestionReceiver {
  let disposed = false
  const projectionByHandle = new Map<NativeContinuedQuestionHandle, { value: unknown; release: () => void }>()
  const continuedByCall = new Map<string, NativeContinuedGenerationDelivery>()
  const keyOf = (sessionId: string, callId: string): string => `${sessionId}\u0000${callId}`
  const currentBindingHandle = (sessionId: string, binding: object): NativeContinuedQuestionHandle | undefined =>
    [...(options.handlesBySession.get(sessionId) ?? [])]
      .find(handle => !handle.isClosed && handle.bindingIdentity() === binding && handle.isCurrentBinding())

  const offerContinued = (
    sessionId: string,
    binding: object,
    call: NativeContinuedQuestionCall,
  ): void => {
    if (disposed || options.isClosed() || call.state !== 'continued') return
    const key = keyOf(sessionId, call.callId)
    if (continuedByCall.has(key)) return
    const generation = options.generation.getSnapshot()
    if (generation === undefined || currentBindingHandle(sessionId, binding) === undefined) return
    const delivery = options.onOffer(sessionId, binding, call)
    if (delivery === undefined) return
    continuedByCall.set(key, delivery)
  }

  const reconcileProjection = (sessionId: string, binding: object, value: unknown): void => {
    if (disposed || options.isClosed() || value === undefined) return
    let projection: NativeContinuedQuestionProjection
    try {
      projection = options.parseProjection(value)
    } catch (error) {
      options.onInvalidProjection(error)
      return
    }
    for (const call of projection.active) offerContinued(sessionId, binding, call)
  }

  const revokeInvalidContinued = (): void => {
    for (const [key, delivery] of continuedByCall) {
      if (!options.isClosed() && Object.is(delivery.generation, options.generation.getSnapshot())
        && currentBindingHandle(delivery.sessionId, delivery.binding) !== undefined) continue
      delivery.controller.abort(new Error('native-client: continued Question ownership revoked'))
      continuedByCall.delete(key)
    }
  }

  const reconcileAllContinued = (): void => {
    revokeInvalidContinued()
    for (const [handle, entry] of projectionByHandle) {
      if (!handle.isClosed) reconcileProjection(handle.sessionId, handle.bindingIdentity(), entry.value)
    }
  }

  const watchHandle = (handle: NativeContinuedQuestionHandle): void => {
    if (projectionByHandle.has(handle)) return
    const entry = { value: undefined as unknown, release: () => {} }
    projectionByHandle.set(handle, entry)
    entry.release = handle.observeUserQuestions(value => {
      entry.value = value
      if (!handle.isClosed) reconcileProjection(handle.sessionId, handle.bindingIdentity(), value)
    })
  }

  const syncHandles = (): void => {
    for (const [handle, entry] of projectionByHandle) {
      if (!handle.isClosed) continue
      entry.release()
      projectionByHandle.delete(handle)
    }
    for (const handle of options.handles) watchHandle(handle)
    reconcileAllContinued()
  }

  const offGeneration = guardNativeContinuedGeneration(
    options.generation,
    continuedByCall,
    delivery => !options.isClosed() && Object.is(delivery.generation, options.generation.getSnapshot())
      && currentBindingHandle(delivery.sessionId, delivery.binding) !== undefined,
    reconcileAllContinued,
  )
  options.handleListeners.add(syncHandles)
  syncHandles()

  return {
    reconcile(): void {
      if (!disposed) reconcileAllContinued()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      offGeneration()
      options.handleListeners.delete(syncHandles)
      for (const entry of projectionByHandle.values()) entry.release()
      projectionByHandle.clear()
      for (const delivery of continuedByCall.values()) {
        delivery.controller.abort(new Error('native-client: interaction receivers disposed'))
      }
      continuedByCall.clear()
    },
  }
}
