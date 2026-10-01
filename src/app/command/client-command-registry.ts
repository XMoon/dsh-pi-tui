/**
 * The Client-owned command execution registry (M3-4 PR4, plan §D2/§12.1):
 * TUI built-in definitions and dynamic skill-wrapper definitions register
 * HERE, never into the Host `ctx.commands` service on the Remote branch.
 *
 * Ownership (the frozen §3.3 split):
 * - registration: Client-local static built-ins + dynamic skill wrappers;
 * - lookup/execute: the Client handler runs in the Client Context;
 * - execution identity: a Client-generated `commandId` used ONLY for local
 *   correlation (draft disposition, health reporting, settlement identity) —
 *   never exposed as a Host command id;
 * - result normalization: the handler's `CommandResult` is normalized to the
 *   SAME shape `commands.execute()` returns, so the submission owner keeps
 *   one settlement vocabulary.
 *
 * It is NOT a wire API. It never calls `ctx.commands`, never publishes a
 * callback over Remote, never owns a Host descriptor, never owns an extension
 * contribution (the extension `CommandBridge` keeps its own callbacks), and
 * never invents a Host command id.
 *
 * The registry deliberately MIRRORS the official executor's observable
 * execution contract where the submission owner depends on it: the official
 * `commands.execute()` appends a `command/run` durable event before the
 * handler and a `command/done` event after settlement, and mints the
 * lifecycle pairing id. The Client registry keeps the same event discipline
 * ONLY where the TUI already owns the surface: it does NOT append its own
 * lifecycle events (that would write Client-forged rows into the Host log);
 * it keeps the pairing-id + normalized-result discipline so draft
 * dispositions, health records and settlement sinks correlate exactly like
 * the Direct path.
 * @module @xmoon76/dsh-pi-tui/app/command/client-command-registry
 */

import { randomUUID } from 'node:crypto'
import { CommandId } from '@deepseek-ai/dsh-commands'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

/** One Client-owned command execution result, normalized like the official
 * `CommandExecution` the submission owner already consumes. */
export interface ClientCommandExecution {
  readonly commandId: string
  readonly result: CommandResult
}

/** The definition shape a Client-owned command registers. */
export type ClientCommandDefinition = CommandDefinition

/** The invocation a Client handler receives: the official shape minus the
 *  Direct `agent` member (a Client-owned callback never receives an Agent —
 *  `undefined` by type, exactly like the sessionless local path). */
export type ClientCommandInvocation = Omit<CommandInvocation, 'agent'>

/** The minimal registry capability the runner/registration path consumes. */
export interface ClientCommandRegistry {
  /** Register one Client-owned definition; returns its disposer. */
  register(definition: ClientCommandDefinition): () => void
  /** Look one definition up by name (bare token, no slash). */
  get(name: string): ClientCommandDefinition | undefined
  /** List the registered descriptors (name-sorted, like `commands.list`). */
  list(): readonly ClientCommandDefinition[]
  /** Execute one Client-owned command line in the Client Context. Resolves
   *  `undefined` when the registry does not resolve the name or the line is
   *  not an invocation — the SAME admission vocabulary the official executor
   *  uses, so a miss falls through to the existing submission semantics. */
  execute(request: {
    readonly line: string
    readonly signal: AbortSignal
  }): Promise<ClientCommandExecution | undefined>
}

/**
 * Create the Client command registry. The `parse` input is the official
 * `parseCommand` (injected so this module keeps zero Host-package imports
 * beyond the structural definition types).
 */
export function createClientCommandRegistry(parse: (line: string) => { name: string; rawInput: string } | undefined): ClientCommandRegistry {
  const definitions = new Map<string, ClientCommandDefinition>()
  return {
    register(definition) {
      definitions.set(definition.name, definition)
      return () => {
        if (definitions.get(definition.name) === definition) definitions.delete(definition.name)
      }
    },
    get(name) {
      return definitions.get(name)
    },
    list() {
      return [...definitions.values()].sort((left, right) => left.name < right.name ? -1 : 1)
    },
    async execute({ line, signal }) {
      const parsed = parse(line)
      if (parsed === undefined) return undefined
      const definition = definitions.get(parsed.name)
      if (definition === undefined) return undefined
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('client command aborted')
      const commandId = CommandId(`cmd-client-${randomUUID()}`)
      const invocation: ClientCommandInvocation = {
        commandId,
        rawInput: parsed.rawInput,
        attachments: [],
        signal,
      }
      const result = await definition.handler(invocation as unknown as CommandInvocation)
      return { commandId, result }
    },
  }
}
