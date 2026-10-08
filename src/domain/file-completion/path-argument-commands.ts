/**
 * The EXPLICIT file-argument command set (TS8-A): the ONE neutral owner of
 * "this command's argument position is a file path". Shared by command
 * registration (`src/commands.ts`) and the TUI file-completion context
 * classifier (`tui/file-completion/context.ts`) — never derived from
 * `getArgumentCompletions !== undefined`.
 *
 * Neutral product policy, not TUI policy: a command whose argument is a path
 * must be added here (and get the matching completion wiring) exactly once.
 * @module @xmoon76/dsh-pi-tui/domain/file-completion/path-argument-commands
 */

/** The command names whose argument position completes a local file path.
 * `attach` and `image` today; a new path-argument command must be added here
 * AND get the matching `getArgumentCompletions` wiring. */
export const FILE_ARGUMENT_COMMANDS: ReadonlySet<string> = new Set(['attach', 'image'])
