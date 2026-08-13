/**
 * The TUI mode's command-line provider: parses the `dsh --profile pi-tui` flag
 * family and provides the parsed values as {@link TUI_STARTUP_SERVICE}.
 * Mirrors the web bundle's startup shape: an ordinary plugin injecting
 * `cmdlineArgs`, providing a service that flag-configured rows inject.
 * @module @dsh-pi-tui/tui-app/startup
 */
import type { Context } from '@deepseek-ai/cordis';
/** Stable Cordis plugin name. */
export declare const name = "tui-startup";
/** Services required before the flags can be resolved. */
export declare const inject: string[];
/** Service provided by this plugin and injected by the TUI runner row. */
export declare const TUI_STARTUP_SERVICE = "tuiStartup";
/** What the runner row reads from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
    /** `--session`, absent when the invocation did not name one. */
    sessionId?: string;
}
/**
 * Parse and provide the TUI invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named; on `--help`
 * nothing is provided, so no TUI row mounts.
 * @param ctx - plugin context carrying the command line.
 */
export declare function apply(ctx: Context): void;
