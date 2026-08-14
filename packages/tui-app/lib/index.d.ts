/**
 * @dsh-pi-tui/tui-app — the bundle's runner plugin. Waits for the startup
 * service (the parsed `dsh --profile pi-tui` flags) and Loader settlement,
 * creates or resumes an Agent through the core registry, renders its session
 * log into the TUI transcript, and routes editor submissions back through
 * `agent.followup`. Streaming arrives through the `session/event` firehose;
 * a persistent `TranscriptFolder` folds appended events incrementally and a
 * coalesced repaint flushes the windowed transcript (older turns collapse
 * into a summary), so long sessions never re-scan the whole log per event.
 * @module @dsh-pi-tui/tui-app
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
/** Stable Cordis plugin name. */
export declare const name = "tui-runner";
/** Core services required before the TUI can mount. */
export declare const inject: string[];
/** Plugin config: the session to resume, resolved from the startup service. */
export interface Config {
    /** Resumed session id; a fresh session is created when absent. */
    sessionId?: string;
}
export declare const Config: z<Config>;
/** One agent's preset composition: the id to record and the setup that installs it. */
export interface AgentComposition {
    /** Preset id for the session header, absent when the deployment composes no roster. */
    agentPreset?: string;
    /** Agent-factory setup: model selection, then the preset mount when composed. */
    setup: (agentCtx: Context) => Promise<void> | void;
}
/**
 * Resolve the preset an agent will be composed from, and the setup that
 * installs it.
 *
 * The id is resolved BEFORE the session exists because the session boundary
 * snapshots `meta` before asynchronous setup begins — a preset discovered
 * during setup could never reach the header. Mounting still happens in setup,
 * where a failure rolls the whole creation back rather than leaving a
 * published session whose capabilities are half-installed.
 *
 * A deployment with no roster composes nothing and every session shares the
 * host composition, which is the behavior before presets existed.
 * @param ctx - the runner context (services read through `ctx.get`).
 * @param selected - the mutable model selection every setup installs.
 * @param presetId - the requested preset, or `undefined` for the default.
 * @returns the id to record on the header (absent without a roster) and the setup callback.
 * @throws when the roster supplies no such preset.
 */
export declare function composeAgent(ctx: Context, selected: ModelSelectionRef, presetId?: string): Promise<AgentComposition>;
/**
 * The preset a persisted session actually runs, from its log (newest
 * selection winning), or undefined when persistence is absent, the session is
 * unknown, or its log predates the roster.
 * @param ctx - the runner context.
 * @param sessionId - the persisted session id.
 * @returns the recorded preset id, or undefined to compose the default.
 */
export declare function recordedPreset(ctx: Context, sessionId: string): Promise<string | undefined>;
/** The session surface {@link recomposeBlank} needs: its log and the append seam. */
export interface RecomposableSession {
    readonly id: string;
    readonly events: readonly SessionEvent[];
    append(type: 'agent-preset/selected', data: {
        agentPreset: string;
    }): unknown;
}
/** Outcome of {@link recomposeBlank}: the swap committed, or the session is locked. */
export type RecomposeOutcome = {
    kind: 'switched';
    preset: string;
} | {
    kind: 'locked';
};
/**
 * Re-compose one agent onto another preset while its session is still blank.
 *
 * A started conversation's history was produced under its preset's tools, so
 * only a session with no `turn/start` event may swap — the same rule as the
 * official `agentPreset.select` RPC. The selection is appended to the log only
 * after the swap committed (a rejected mount leaves the old composition).
 * @param ctx - the runner context.
 * @param agent - the live agent whose composition to swap.
 * @param id - the target preset id.
 * @returns `switched` with the committed preset id, or `locked` when a turn has run.
 * @throws when the roster supplies no such preset or its composition is unusable.
 */
export declare function recomposeBlank(ctx: Context, agent: {
    ctx: Context;
    session: RecomposableSession;
}, id: string): Promise<RecomposeOutcome>;
/**
 * Mount the TUI: resolve the model selection, create or resume the agent,
 * wire the surface to the agent, and subscribe to the session firehose.
 * @param ctx - plugin context carrying core services.
 * @param config - validated config with the optional resumed session id.
 */
export declare function apply(ctx: Context, config: Config): void;
