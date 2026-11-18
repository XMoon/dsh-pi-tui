/**
 * The Remote CUA access adapter (PR-5 / MAC-09 v2).
 *
 * It consumes the official generated `@deepseek-ai/dsh-cua/remote` namespace,
 * mounted by the Split Client's existing connection composition, and returns
 * the same semantic results as the Direct adapter. The Host remains the only
 * permission/application authority; this adapter owns no cache and no fallback.
 *
 * Currentness is the ONE policy here: the Connection generation is captured
 * before dispatch and compared afterwards, so a reply carried by a superseded
 * generation is a superseded read, never the new generation's definite state.
 * A side-effecting request is never replayed.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/cua-access-remote
 */

import {
  CuaAccessUnavailableError,
  type CuaAccessPort,
  type CuaApplicationId,
  type CuaApplicationState,
  type CuaPermission,
  type CuaPtcConfiguration,
  type CuaSystemStatus,
} from '../cua-access-port.ts'
import { SupersededReadError } from '../read-error.ts'
import type { RemoteConnectionGenerationSource } from './session-reader-remote.ts'
import type { RemoteResultLike } from './session-writer-remote.ts'

/** The official generated `cuaAccess` namespace slice the contribution mounts. */
export interface RemoteCuaAccessNamespace {
  systemStatus(): Promise<RemoteResultLike<CuaSystemStatus>>
  applications(): Promise<RemoteResultLike<CuaApplicationState>>
  applicationIcons(): Promise<RemoteResultLike<Record<string, string>>>
  ptcConfiguration(): Promise<RemoteResultLike<CuaPtcConfiguration>>
  requestPermission(permission: CuaPermission, locale: string): Promise<RemoteResultLike<CuaSystemStatus>>
  openSettings(permission: CuaPermission, locale: string): Promise<RemoteResultLike<void>>
  enablePersistentPtc(): Promise<RemoteResultLike<void>>
  revoke(id: CuaApplicationId): Promise<RemoteResultLike<void>>
  retryApproval(id: CuaApplicationId): Promise<RemoteResultLike<void>>
}

/** One official result's business value, or its refusal thrown. */
function unwrap<T>(result: RemoteResultLike<T>): T {
  if (!result.ok) throw result.error
  return result.value
}

/** The semantic CUA access port over the official generated Client namespace. */
export class RemoteCuaAccessPort implements CuaAccessPort {
  private readonly namespace: RemoteCuaAccessNamespace | undefined
  private readonly generation: RemoteConnectionGenerationSource

  constructor(
    namespace: RemoteCuaAccessNamespace | undefined,
    generation: RemoteConnectionGenerationSource,
  ) {
    this.namespace = namespace
    this.generation = generation
  }

  async readSystemStatus(): Promise<CuaSystemStatus> {
    return await this.fenced('system status', namespace => namespace.systemStatus())
  }

  async readApplications(): Promise<CuaApplicationState> {
    return await this.fenced('applications', namespace => namespace.applications())
  }

  async readApplicationIcons(): Promise<Readonly<Record<string, string>>> {
    return await this.fenced('application icons', namespace => namespace.applicationIcons())
  }

  async readPtcConfiguration(): Promise<CuaPtcConfiguration> {
    return await this.fenced('PTC configuration', namespace => namespace.ptcConfiguration())
  }

  async requestPermission(permission: CuaPermission, locale: string): Promise<CuaSystemStatus> {
    return await this.fenced('request permission', namespace => namespace.requestPermission(permission, locale))
  }

  async openSettings(permission: CuaPermission, locale: string): Promise<void> {
    await this.fenced('open settings', namespace => namespace.openSettings(permission, locale))
  }

  async enablePersistentPtc(): Promise<void> {
    await this.fenced('enable persistent PTC', namespace => namespace.enablePersistentPtc())
  }

  async revoke(id: CuaApplicationId): Promise<void> {
    await this.fenced('revoke application', namespace => namespace.revoke(id))
  }

  async retryApproval(id: CuaApplicationId): Promise<void> {
    await this.fenced('retry application approval', namespace => namespace.retryApproval(id))
  }

  /**
   * One Remote call fenced to the Connection generation captured BEFORE
   * dispatch. The namespace is mounted by the official Client contribution; a
   * Host/connection without it is a definite unavailable, never a Direct
   * fallback.
   */
  private async fenced<T>(
    operation: string,
    call: (namespace: RemoteCuaAccessNamespace) => Promise<RemoteResultLike<T>>,
  ): Promise<T> {
    const namespace = this.namespace
    if (namespace === undefined) {
      throw new CuaAccessUnavailableError('the official Computer Use Remote namespace is not mounted on this Client')
    }
    const captured = this.generation.getSnapshot()
    if (captured === undefined) {
      throw new CuaAccessUnavailableError('the Client is not connected to a Host')
    }
    const stillCurrent = (): boolean => Object.is(captured, this.generation.getSnapshot())
    let value: T
    try {
      value = unwrap(await call(namespace))
    } catch (error) {
      if (!stillCurrent()) throw new SupersededReadError(`computer use ${operation} superseded`)
      throw error
    }
    if (!stillCurrent()) throw new SupersededReadError(`computer use ${operation} superseded`)
    return value
  }
}
