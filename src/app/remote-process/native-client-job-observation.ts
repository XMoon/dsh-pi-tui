/** Internal currentness gate for one official Job roster stream frame. */
export interface NativeJobFrameGateInput {
  readonly openerGeneration: object | undefined
  readonly currentGeneration: object | undefined
  readonly openerSignalAborted: boolean
  readonly bindingCurrent: boolean
}

/** A frame is current only if its physical opener still owns the live generation. */
export function nativeJobFrameIsDeliverable(input: NativeJobFrameGateInput): boolean {
  return input.openerGeneration !== undefined
    && !input.openerSignalAborted
    && input.bindingCurrent
    && Object.is(input.openerGeneration, input.currentGeneration)
}
