/**
 * The truthful-unavailable {@link WebAccessPort} for `TuiCommandRunner` fakes.
 *
 * A runner fake is not a Web frontend: it serves the same missing capability a
 * Direct backend serves, so a `/web` handler driven through it observes the
 * unsupported path instead of a fabricated status. Tests that exercise the
 * Remote `/web` flow supply their own explicit port.
 *
 * @module test/support/web-access-fake
 */

import type { WebAccessPort } from '../../src/runtime/web-access-port.ts'
import type { AcpAccessPort } from '../../src/runtime/acp-access-port.ts'

/** One unavailable Web access port (status/toggle answer, URL refuses). */
export function unavailableWebAccess(): WebAccessPort {
  const reason = 'test: the Web frontend controls are unavailable'
  return {
    getStatus: async () => ({ state: 'unavailable', reason }),
    setEnabled: async () => ({ state: 'unavailable', reason }),
    getAuthenticatedUrl: async () => {
      throw new Error(reason)
    },
  }
}

/**
 * The truthful-unavailable {@link AcpAccessPort} for `TuiCommandRunner` fakes.
 *
 * A runner fake is not a Split Host: it serves the same missing capability a
 * Direct backend serves, so the Settings `ACP Server` row driven through it
 * observes the unsupported path instead of a fabricated listener state. Tests
 * that exercise the Remote toggle supply their own explicit port.
 */
export function unavailableAcpAccess(): AcpAccessPort {
  const reason = 'test: the local ACP listener controls are unavailable'
  return {
    getStatus: async () => ({ state: 'unavailable', reason }),
    setEnabled: async () => ({ state: 'unavailable', reason }),
    currentGeneration: () => undefined,
    subscribeGeneration: () => () => {},
  }
}

/** The truthful "no Host MCP manager port" runner seam: a fixture composition
 *  that owns no MCP server management capability. */
export function unavailableMcpServers(): import('../../src/runtime/mcp-server-port.ts').McpServerPort {
  return {
    watch: async function* () {
      yield { kind: 'invalidated' as const, reason: 'unavailable' as const }
    },
    probe: async (_name: string, _signal: AbortSignal) => ({
      kind: 'failed' as const,
      generation: {},
      failure: { kind: 'unavailable' as const, reason: 'test: no Host MCP manager' },
    }),
    restart: async (_name: string, _signal: AbortSignal) => ({
      kind: 'failed' as const,
      generation: {},
      failure: { kind: 'unavailable' as const, reason: 'test: no Host MCP manager' },
    }),
  }
}
