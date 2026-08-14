/**
 * The `agent-preset/selected` session event, declared locally.
 *
 * The official package declares this augmentation in its `session.ts`, but
 * the published `@deepseek-ai/dsh-agent-presets` exports map does not expose
 * that subpath, so the TUI cannot import it. Interface merging makes this
 * declaration compatible with the official one whenever both are in scope.
 * @module @dsh-pi-tui/tui-app/preset-events
 */
export {};
