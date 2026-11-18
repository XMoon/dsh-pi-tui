/**
 * The Direct CUA access adapter (PR-5 / MAC-09 v2).
 *
 * It resolves the official `cuaAccess` Host service from the running Host
 * Context on EVERY call: the Computer Use bundle can be enabled or disabled
 * after the TUI started, so capturing the service once would pin a stale
 * generation (or a false unavailable). An absent service is a definite
 * {@link CuaAccessUnavailableError}, never a fake macOS denial.
 *
 * This adapter adds no native code, no TCC access and no second provider: it
 * forwards the official methods and returns their real results.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/direct/cua-access-direct
 */

import {
  CuaAccessUnavailableError,
  type CuaAccessObservation,
  type CuaAccessPort,
  type CuaApplicationId,
  type CuaApplicationState,
  type CuaPermission,
  type CuaPtcConfiguration,
  type CuaSystemStatus,
} from '../cua-access-port.ts'

/** The minimal Host Context the adapter reads (the runner's real Context). */
export interface DirectCuaAccessContextLike {
  get(name: string): unknown
}

/** The official Host `cuaAccess` service face this adapter forwards. */
interface CuaAccessServiceLike {
  systemStatus(): Promise<CuaSystemStatus>
  applications(): Promise<CuaApplicationState>
  applicationIcons(): Promise<Record<string, string>>
  ptcConfiguration(): CuaPtcConfiguration
  requestPermission(permission: CuaPermission, locale: string): Promise<CuaSystemStatus>
  openSettings(permission: CuaPermission, locale: string): Promise<void>
  enablePersistentPtc(): Promise<void>
  revoke(id: CuaApplicationId): Promise<void>
  retryApproval(id: CuaApplicationId): Promise<void>
}

/** The one statement of the Direct unavailability (presentation reads it). */
export const DIRECT_CUA_ACCESS_REASON = 'The official Computer Use bundle is not loaded on this Host.'

/** Forward the official Host service; resolve it lazily per call. */
export class DirectCuaAccessPort implements CuaAccessPort {
  private readonly ctx: DirectCuaAccessContextLike

  readonly observation: CuaAccessObservation = {
    // The Direct process sees the bundle service appear/disappear through the
    // same Context; a reload that keeps a service present is re-read on every
    // call. There is no cross-process generation to subscribe to here.
    readSnapshot: () => this.ctx.get('cuaAccess') === undefined ? 'absent' : 'present',
    subscribe: () => () => {},
  }

  constructor(ctx: DirectCuaAccessContextLike) {
    this.ctx = ctx
  }

  async readSystemStatus(): Promise<CuaSystemStatus> {
    return await this.service().systemStatus()
  }

  async readApplications(): Promise<CuaApplicationState> {
    return await this.service().applications()
  }

  async readApplicationIcons(): Promise<Readonly<Record<string, string>>> {
    return await this.service().applicationIcons()
  }

  async readPtcConfiguration(): Promise<CuaPtcConfiguration> {
    return await this.service().ptcConfiguration()
  }

  async requestPermission(permission: CuaPermission, locale: string): Promise<CuaSystemStatus> {
    return await this.service().requestPermission(permission, locale)
  }

  async openSettings(permission: CuaPermission, locale: string): Promise<void> {
    await this.service().openSettings(permission, locale)
  }

  async enablePersistentPtc(): Promise<void> {
    await this.service().enablePersistentPtc()
  }

  async revoke(id: CuaApplicationId): Promise<void> {
    await this.service().revoke(id)
  }

  async retryApproval(id: CuaApplicationId): Promise<void> {
    await this.service().retryApproval(id)
  }

  private service(): CuaAccessServiceLike {
    const service = this.ctx.get('cuaAccess')
    if (service === undefined || service === null) throw new CuaAccessUnavailableError(DIRECT_CUA_ACCESS_REASON)
    return service as CuaAccessServiceLike
  }
}
