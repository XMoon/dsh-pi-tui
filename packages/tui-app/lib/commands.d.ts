/**
 * The TUI-owned slash commands (/exit /settings /sessions /skill /model
 * /new /tasks /preset /subagents /search /title /copy /export /fork
 * /status /login /logout /help), extracted from the runner's monolithic
 * apply() so the registration surface is testable and the runner closure
 * shrinks. Every command reads the live runner state through the
 * {@link TuiCommandRunner} interface, whose accessors re-read the current
 * agent/settings on every access (sessions can swap the live agent).
 * @module @dsh-pi-tui/tui-app/commands
 */
import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { Agent, AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import type { TuiApp } from './tui-app.ts';
/** A balanced completed-turn prefix for forking: the log up to (and including)
 * the last `turn/end`. Undefined when no turn has completed yet.
 * @param events - the session log.
 * @returns the fork seed events, or undefined.
 */
export declare function forkSeed(events: readonly SessionEvent[]): readonly SessionEvent[] | undefined;
/** The TUI settings document surface (theme/footer/fullscreen/history). */
export interface TuiSettingsLike {
    get(): {
        theme: string;
        footer: string;
        fullscreen: string;
        history: Record<string, string[]>;
    };
    replace(doc: {
        theme: string;
        footer: string;
        fullscreen: string;
        history: Record<string, string[]>;
    }): unknown;
}
/** The agents-service surface /new and /fork create sessions through. */
export interface AgentsLike {
    create(options: {
        sessionId: SessionId;
        meta: Record<string, unknown>;
        agentOptions: {
            provider?: string;
            model?: string;
        };
        setup: (agentCtx: Context) => Promise<void> | void;
        seed?: readonly SessionEvent[];
    }): Promise<AgentHandle>;
}
/** Everything the TUI-owned commands read from the runner. */
export interface TuiCommandRunner {
    ctx: Context;
    app: TuiApp;
    /** The live agent handle; re-read on every access (swaps on switch). */
    readonly liveAgent: Agent;
    /** The process-wide mutable model selection (footer + /model). */
    readonly selected: ModelSelectionRef;
    /** The TUI settings document, when the settings service is present. */
    readonly tuiSettings: TuiSettingsLike | undefined;
    /** The agents service, for /new and /fork. */
    readonly agents: AgentsLike;
    /** The sessions service, for the /exit flush. */
    readonly sessions: {
        flush(session: Session): Promise<unknown>;
    };
    cwd: string;
    signal: AbortSignal;
    compose(presetId?: string): Promise<{
        agentPreset?: string;
        setup: (agentCtx: Context) => Promise<void> | void;
    }>;
    switchSession(sessionId: string): Promise<string | undefined>;
    swapTo(next: AgentHandle): Promise<string | undefined>;
    /** The preset the live agent runs on, when the deployment composes one. */
    currentPreset(): string | undefined;
    /** Re-compose a still-blank session onto another preset (see recomposeBlank). */
    recomposeBlank(presetId: string): Promise<{
        kind: 'switched';
        preset: string;
    } | {
        kind: 'locked';
    }>;
    refreshStatus(): void;
    enterView(childId: SessionId, label?: string): Promise<void>;
    exit(code: number): void;
}
/**
 * Register the TUI-owned slash commands on the commands service. The
 * completion list is refreshed after every registration so TUI-owned
 * commands appear in the editor's tab list.
 * @param runner - the live runner surface.
 */
export declare function registerTuiCommands(runner: TuiCommandRunner): void;
