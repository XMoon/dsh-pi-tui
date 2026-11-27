/**
 * The one transport-neutral description of the local ACP endpoint name.
 *
 * POSIX keeps the existing pathname Unix socket contract (Linux/Darwin derive
 * it in the listener module). Native Windows uses one profile-scoped Named
 * Pipe address derived from the existing canonical scope id: this module owns
 * only the pure shape/validation and performs no IO, so the listener, the
 * daemon-control reader and the standalone stdio entry share exactly one
 * definition without pulling Host or SDK side effects into the byte relay.
 *
 * @module app/remote-process/local-acp-endpoint
 */

/** The exact local Windows Named Pipe prefix of this product. */
export const ACP_PIPE_PREFIX = '\\\\.\\pipe\\dsh-pi-tui-acp-'

const SCOPE_ID = /^[0-9a-f]{64}$/u
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u

/** The canonical local Named Pipe address of one existing profile scope. */
export function acpPipeAddress(scopeId: string): string {
  if (!SCOPE_ID.test(scopeId)) {
    throw new Error('local acp: the canonical profile scope id is not a 64-character lowercase SHA-256 hex string')
  }
  return `${ACP_PIPE_PREFIX}${scopeId}`
}

/** Whether one string is EXACTLY this product's local Named Pipe address. */
export function isAcpPipeAddress(value: string): boolean {
  if (!value.startsWith(ACP_PIPE_PREFIX)) return false
  const suffix = value.slice(ACP_PIPE_PREFIX.length)
  return SCOPE_ID.test(suffix)
}

/**
 * The one target-shape admission used by the stdio relay and its tests. On
 * Windows only the exact local product pipe is accepted (never a remote UNC
 * path or an arbitrary path); POSIX keeps the existing absolute/no-control
 * path rule.
 */
export function isSafeLocalAcpEndpoint(value: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return isAcpPipeAddress(value)
  return value.startsWith('/') && !CONTROL_CHARS.test(value)
}
