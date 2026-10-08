/**
 * The Remote Host user-shell adapter (shell amendment, M3-4 PR3): the
 * truthful-unavailable deployment. At the frozen rc.2 target the only Host
 * user-shell Remote carrier (`dsh-api-terminal-controller`) is a retained
 * interactive PTY — screen-stream output, no deterministic per-command start,
 * no authoritative per-command exit status, no one-shot cancel, no sandbox
 * variant — so the carrier qualification concludes CARRIER_GAP (U11a/U11b,
 * docs/client-server-migration.md "User `!` / `!!` shell under a wire
 * backend").
 *
 * This adapter therefore executes NOTHING: `availability.supported` is false
 * and every admission returns `unavailable` with the same carrier-gap
 * message. Zero Client spawn, zero Host `ctx.shell` escape, zero fake
 * success card, zero Session write.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/host-user-shell-remote
 */

import type {
  HostUserShellAdmission,
  HostUserShellPort,
  HostUserShellRequest,
} from '../host-user-shell-port.ts'

/** The one truthful message every Remote admission returns. */
const CARRIER_GAP_MESSAGE =
  'Host user-shell execution is unavailable in this Remote composition — nothing was executed'

/** The Remote backend's Host user-shell port: truthful, inert, fail-closed. */
export class RemoteHostUserShellPort implements HostUserShellPort {
  readonly availability = {
    supported: false,
    policies: [] as const,
  } as const

  async execute(_request: HostUserShellRequest): Promise<HostUserShellAdmission> {
    void _request
    return {
      kind: 'unavailable',
      reason: { reason: 'carrier-gap', message: CARRIER_GAP_MESSAGE },
    }
  }
}
