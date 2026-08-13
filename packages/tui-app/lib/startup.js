/**
 * The TUI mode's command-line provider: parses the `dsh --profile pi-tui` flag
 * family and provides the parsed values as {@link TUI_STARTUP_SERVICE}.
 * Mirrors the web bundle's startup shape: an ordinary plugin injecting
 * `cmdlineArgs`, providing a service that flag-configured rows inject.
 * @module @dsh-pi-tui/tui-app/startup
 */
import { Command } from 'commander';
import { parseCmdline } from '@deepseek-ai/dsh-cmdline';
/** Stable Cordis plugin name. */
export const name = 'tui-startup';
/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs'];
/** Service provided by this plugin and injected by the TUI runner row. */
export const TUI_STARTUP_SERVICE = 'tuiStartup';
/** This app's command: its flags, its description, and its help text. */
function tuiCommand() {
    return new Command()
        .name('dsh --profile pi-tui')
        .description('Run the DeepSeek Harness terminal UI.')
        .helpOption('-h, --help', 'show this help')
        .option('--session <id>', 'resume an existing session instead of creating one')
        .addHelpText('after', `
Examples:
  dsh --profile pi-tui                       start the terminal UI
  dsh --profile pi-tui --session <id>        resume an existing session
`);
}
/**
 * Parse and provide the TUI invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named; on `--help`
 * nothing is provided, so no TUI row mounts.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx) {
    const program = tuiCommand();
    program.action(() => {
        const options = program.opts();
        ctx.provide(TUI_STARTUP_SERVICE, {
            ...(options.session !== undefined ? { sessionId: options.session } : {}),
        });
    });
    parseCmdline(ctx, program);
}
