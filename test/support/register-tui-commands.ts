/**
 * Test wrapper for {@link registerTuiCommands}: supplies the REAL Direct
 * global-catalog seam derived from the runner's Host registry, so a
 * Direct-shaped test fake gets the production `commands.list(undefined)`
 * global-layer read without every fake carrying the capability.
 * @module @xmoon76/dsh-pi-tui/test/support/register-tui-commands
 */

import { commandSummaryOf } from '../../src/domain/catalog/surface.ts'
import { registerTuiCommands, type InitialCommandCatalog, type TuiCommandRunner } from '../../src/commands.ts'
import { listGlobalCommands } from '../../src/runtime/direct/surface-catalog.ts'

export function registerTuiCommandsWithDirectSeams(
  runner: TuiCommandRunner,
  initial?: InitialCommandCatalog,
): ReturnType<typeof registerTuiCommands> {
  return registerTuiCommands(runner, initial, {
    listGlobalCommands: () => runner.commandRegistry === undefined
      ? []
      : listGlobalCommands(runner.commandRegistry).map(commandSummaryOf),
  })
}
