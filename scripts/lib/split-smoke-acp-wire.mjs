/**
 * The shared ACP stdout wire assertion used by the real `acp stdio` smoke
 * drivers. The public bridge is a PURE byte relay: every stdout byte belongs to
 * the external client's JSON-RPC stream, so a driver that spawns the public
 * command must be able to prove that no human CLI text leaked into it.
 *
 * @module split-process/acp-wire
 */

/** A complete JSON-RPC 2.0 frame: one object with the exact version member. */
export function validJsonRpcLine(line) {
  try {
    const value = JSON.parse(line)
    return value !== null && typeof value === 'object' && !Array.isArray(value) && value.jsonrpc === '2.0'
  } catch {
    return false
  }
}

/** Validate the complete stdout byte stream as NDJSON JSON-RPC. */
export function protocolOnly(raw) {
  if (raw.length === 0) return { valid: true, frames: 0 }
  const text = raw.toString('utf8')
  if (!text.endsWith('\n')) return { valid: false, frames: 0 }
  const lines = text.slice(0, -1).split('\n')
  return { valid: lines.every(validJsonRpcLine), frames: lines.length }
}
