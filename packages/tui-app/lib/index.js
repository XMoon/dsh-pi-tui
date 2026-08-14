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
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets';
import { effectiveApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
// The commands service merge: ctx.commands typing for execute()/register().
import { parseCommand } from '@deepseek-ai/dsh-commands';
// The settings service merge for persisting TUI preferences.
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
// The plan-mode fold for the header badge.
import { foldPlanMode } from '@deepseek-ai/dsh-plan-mode';
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title';
import { TUI_STARTUP_SERVICE } from "./startup.js";
import { toolPresenterFrom } from "./present.js";
import { textOf, TranscriptFolder } from "./transcript.js";
import { formatStats, StatsFolder } from "./stats.js";
import { color, loadCustomTheme, resolveCustomTheme } from "./theme.js";
import { startProcessTui } from "./tui-app.js";
import { registerTuiCommands } from "./commands.js";
import { customThemeNames } from "./theme.js";
/** Stable Cordis plugin name. */
export const name = 'tui-runner';
/** Core services required before the TUI can mount. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', TUI_STARTUP_SERVICE];
export const Config = z.object({
    sessionId: z.string(),
});
/** Display window in turns; older turns collapse into a summary entry. */
const WINDOW_TURNS = 15;
/** Coalesced repaint interval for streaming events, in ms. */
const REPAINT_FLUSH_MS = 50;
/**
 * The installed dsh version (e.g. `0.1.0-rc.6`), resolved from the launcher's
 * real path: `process.argv[1]` is the `dsh` bin, whose realpath walks up to
 * the `@deepseek-ai/dsh/package.json` that owns it. The version the welcome
 * card shows is the harness the TUI runs on, not this bundle's own patch
 * level. Undefined when the launcher path is unreadable.
 * @returns the installed dsh version string, or undefined.
 */
function dshVersion() {
    const bin = process.argv[1];
    if (bin === undefined)
        return undefined;
    try {
        let dir = dirname(realpathSync(bin));
        for (let depth = 0; depth < 8; depth += 1) {
            try {
                const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
                if (pkg.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string')
                    return pkg.version;
            }
            catch {
                // Not a manifest directory; keep walking up.
            }
            const parent = dirname(dir);
            if (parent === dir)
                return undefined;
            dir = parent;
        }
    }
    catch {
        // Unreadable launcher path: fall back to the bundle version.
    }
    return undefined;
}
/**
 * The bundle's own version, read from package.json at runtime so the welcome
 * card never drifts from the shipped version. The DISPLAYED version prefers
 * the installed dsh version (`dshVersion`), falling back to this one.
 * @returns the version string, or a fallback when the file is unreadable.
 */
function packageVersion() {
    try {
        const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
        return dshVersion() ?? pkg.version ?? '0.0.0';
    }
    catch {
        return dshVersion() ?? '0.0.0';
    }
}
/**
 * Repaint the transcript from a folder's windowed message list.
 * @param app - the TUI surface.
 * @param folder - the incremental fold state for the live session.
 */
function repaint(app, folder) {
    app.setTranscript(folder.messages({ maxTurns: WINDOW_TURNS }));
}
/** Current git branch from the nearest .git/HEAD, or empty outside a checkout. */
function gitBranch(cwd) {
    let dir = cwd;
    for (let depth = 0; depth < 10; depth += 1) {
        try {
            const head = readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim();
            if (!head.startsWith('ref: refs/heads/'))
                return '';
            return head.slice('ref: refs/heads/'.length);
        }
        catch {
            const parent = join(dir, '..');
            if (parent === dir)
                return '';
            dir = parent;
        }
    }
    return '';
}
/** Short cwd for the footer: last two path segments. */
function shortCwd(cwd) {
    const parts = cwd.split('/').filter(Boolean);
    return parts.slice(-2).join('/') || cwd;
}
/**
 * Write raw bytes to a file descriptor, bypassing the cordis-wrapped
 * `process.stderr` (whose `writeSync` is missing). Startup diagnostics go to
 * fd 2 so they never corrupt the TUI frame on stdout.
 * @param fd - the file descriptor (2 for stderr).
 * @param text - the bytes to write.
 */
function writeFd2(fd, text) {
    try {
        writeFileSync(fd, text);
    }
    catch {
        // Diagnostics are best-effort: a closed descriptor must not take the
        // fallback path down.
    }
}
/** Shell commands the approval dialog flags as dangerous (kimi-inspired). */
const DANGER_PATTERNS = [
    /\bmkfs(\.\w+)?\b/,
    /\bdd\s+if=.*of=\/dev\//,
    /^:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/,
    /\bchmod\s+-R\s+777\s+\//,
    /\bgit\s+push\b[^\n|;]*(--force\b|\s-f\b)/,
    /\b(shutdown|reboot|poweroff|init\s+0)\b/,
    />+\s*\/dev\/sd/,
    /\bcurl\b[^\n|]*\|\s*(ba)?sh\b/,
];
/**
 * Whether a shell command matches a destructive pattern. `rm` is treated
 * specially: any spelling of recursive + force flags (`rm -rf`, `rm -r -f`,
 * `rm -rf /`) is dangerous; the remaining patterns are verbatim matches.
 */
export function dangerCommand(command) {
    // Slice the flags from the WORD-BOUNDED rm match itself: slicing from the
    // first "rm" substring (e.g. inside "alarm") would read flags from the
    // wrong offset and both miss and misfire depending on what follows.
    const rm = /\brm\b/i.exec(command);
    if (rm !== null) {
        const flags = command.slice(rm.index + rm[0].length);
        const combined = flags.match(/-\w+/g)?.join('') ?? '';
        if (combined.includes('r') && combined.includes('f'))
            return true;
    }
    return DANGER_PATTERNS.some(pattern => pattern.test(command));
}
/**
 * The active goal badge text from the session log, or undefined. The latest
 * `goal/change` wins; a clear or completed goal hides the badge.
 * @param events - the session log.
 * @returns e.g. `goal ● fix the build`, or undefined.
 */
/**
 * Whether the agent is busy from a session log: the newest turn-boundary
 * event decides. A resumed session can be persisted mid-turn, so the scan
 * cannot assume the log ends idle.
 * @param events - the session log.
 * @returns whether the newest turn is still open.
 */
function workingFromLog(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.type === 'turn/start')
            return true;
        if (event.type === 'turn/end')
            return false;
    }
    return false;
}
function foldGoal(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === undefined || event.type !== 'goal/change')
            continue;
        if (event.data.operation === 'clear')
            return undefined;
        const goal = event.data.goal;
        if (goal.phase === 'complete')
            return undefined;
        const mark = goal.phase === 'active' ? '●' : goal.phase === 'paused' ? '‖' : '◌';
        const objective = goal.objective.length > 24 ? `${goal.objective.slice(0, 24)}…` : goal.objective;
        return `goal ${mark} ${objective}`;
    }
    return undefined;
}
/** A balanced completed-turn prefix for forking: the log up to (and including)
 * the last `turn/end`. Undefined when no turn has completed yet.
 * @param events - the session log.
 * @returns the fork seed events, or undefined.
 */
export { forkSeed } from "./commands.js";
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
export async function composeAgent(ctx, selected, presetId) {
    const presets = ctx.get('agentPresets');
    if (presets === undefined) {
        return {
            setup: (agentCtx) => {
                installModelSelection(agentCtx, selected);
            },
        };
    }
    const resolvedId = (await presets.resolve(presetId)).id;
    return {
        agentPreset: resolvedId,
        setup: async (agentCtx) => {
            installModelSelection(agentCtx, selected);
            await presets.mount(agentCtx, resolvedId);
        },
    };
}
/**
 * The preset a persisted session actually runs, from its log (newest
 * selection winning), or undefined when persistence is absent, the session is
 * unknown, or its log predates the roster.
 * @param ctx - the runner context.
 * @param sessionId - the persisted session id.
 * @returns the recorded preset id, or undefined to compose the default.
 */
export async function recordedPreset(ctx, sessionId) {
    const persistence = ctx.get('sessionPersistence');
    if (persistence === undefined)
        return undefined;
    let header;
    try {
        header = (await persistence.list()).find(candidate => candidate.id === sessionId);
    }
    catch {
        return undefined;
    }
    if (header === undefined)
        return undefined;
    let events = [];
    try {
        events = (await persistence.inspect(SessionId(sessionId))).events;
    }
    catch {
        // Header-only fallback: an unreadable log still resumes under the
        // creation-time preset rather than the deployment default.
    }
    return resolveSessionPreset({ header, events });
}
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
export async function recomposeBlank(ctx, agent, id) {
    const presets = ctx.get('agentPresets');
    if (presets === undefined)
        throw new Error('agent presets unavailable in this deployment');
    if (agent.session.events.some(event => event.type === 'turn/start'))
        return { kind: 'locked' };
    const preset = await presets.recompose(agent.ctx, id);
    agent.session.append('agent-preset/selected', { agentPreset: preset.id });
    return { kind: 'switched', preset: preset.id };
}
/** Set the terminal window title (OSC 0); a no-op without a TTY. */
function setTerminalTitle(title) {
    if (process.stdout.isTTY === true)
        process.stdout.write(`\x1b]0;${title}\x07`);
}
/**
 * Mount the TUI: resolve the model selection, create or resume the agent,
 * wire the surface to the agent, and subscribe to the session firehose.
 * @param ctx - plugin context carrying core services.
 * @param config - validated config with the optional resumed session id.
 */
export function apply(ctx, config) {
    // Read through the global service store, not the property proxy: appExit is
    // an optional host value, never an injected dependency.
    const exit = ctx.get('appExit');
    if (exit === undefined) {
        throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts');
    }
    const startup = ctx.get(TUI_STARTUP_SERVICE);
    if (startup === undefined)
        return;
    // The patch row carries a static config; the real session id comes from the
    // startup service (no `!!js` expression, so loader hot-reloads cannot race
    // the service's availability while evaluating the row).
    const sessionId = config.sessionId !== undefined && config.sessionId !== '' ? config.sessionId : startup.sessionId;
    void (async () => {
        // Loader siblings mount concurrently. Await the complete application before
        // creating an Agent so its scoped tools and adapters are not half-composed.
        await ctx.get('loader')?.await();
        const agents = ctx.get('agents');
        const defaultModel = ctx.get('agentDefaultModel');
        const sessions = ctx.get('sessions');
        // Early process shutdown can dispose the tree while settlement is pending.
        if (agents === undefined || defaultModel === undefined || sessions === undefined)
            return;
        const selection = defaultModel.currentSelection();
        const agentOptions = { provider: selection.provider, model: selection.model };
        // P6: compose one preset per session when the roster is mounted; with no
        // roster this is exactly the headless shape (model-facing rows in the
        // host plane). The `selected` ref stays process-wide like before.
        const selected = { current: selection, assembled: undefined };
        const compose = (presetId) => composeAgent(ctx, selected, presetId);
        const withPresetMeta = (composition) => composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset };
        // Launch-time preset entry: `--preset` wins over $DSH_PI_TUI_PRESET, and
        // both fall back to the saved default (settings `agent-presets.default`,
        // then the roster config) when absent. A fresh session starts on it; a
        // resumed BLANK session may still be re-composed onto it; a resumed
        // started session keeps its recorded preset (warned, never overridden).
        const launchPreset = startup.presetId ?? (process.env.DSH_PI_TUI_PRESET?.trim() || undefined);
        /** Resolve the launch composition, falling back to the default on an unknown id. */
        const launchComposition = async () => {
            try {
                return { composition: await compose(launchPreset) };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                ctx.logger.warn(`tui-runner: launch preset unavailable: ${message}`);
                return {
                    composition: await compose(),
                    failure: `preset "${launchPreset}" unavailable; started with the default`,
                };
            }
        };
        // A stale --session id must not kill the TUI: resume falls back to a
        // fresh session and the failure is surfaced as a notify line.
        let resumeFailure;
        let handle;
        if (sessionId !== undefined) {
            try {
                // The stored session's recorded preset wins (resolved from the log,
                // not the header): a session that switched while blank ran every turn
                // under the newer composition, and rebuilding it differently would
                // replay tool calls the model can no longer make.
                const recorded = await recordedPreset(ctx, sessionId);
                const composition = await compose(recorded);
                handle = await agents.resume({
                    resumeSessionId: SessionId(sessionId),
                    agentOptions,
                    setup: composition.setup,
                });
                // A launch-time preset may still apply while the session is blank;
                // the blank check lives inside recomposeBlank (shared with /preset).
                if (launchPreset !== undefined && launchPreset !== recorded) {
                    try {
                        const outcome = await recomposeBlank(ctx, handle.agent, launchPreset);
                        if (outcome.kind === 'locked') {
                            ctx.logger.warn(`tui-runner: session ${sessionId} has started; its agent preset ${recorded} is fixed, ignoring --preset ${launchPreset}`);
                        }
                    }
                    catch (error) {
                        ctx.logger.warn(`tui-runner: --preset ${launchPreset} not applied on resume: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
            }
            catch (error) {
                ctx.logger.warn(`tui-runner: resume ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
                writeFd2(2, `[tui] resume ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}\n`);
                resumeFailure = `session ${sessionId} could not be resumed; started a fresh session`;
                const launched = await launchComposition();
                if (launched.failure !== undefined)
                    resumeFailure = launched.failure;
                handle = await agents.create({
                    sessionId: SessionId(`session-${randomUUID()}`),
                    meta: { cwd: process.cwd(), ...withPresetMeta(launched.composition) },
                    agentOptions,
                    setup: launched.composition.setup,
                });
            }
        }
        else {
            const launched = await launchComposition();
            if (launched.failure !== undefined)
                resumeFailure = launched.failure;
            try {
                handle = await agents.create({
                    sessionId: SessionId(`session-${randomUUID()}`),
                    meta: { cwd: process.cwd(), ...withPresetMeta(launched.composition) },
                    agentOptions,
                    setup: launched.composition.setup,
                });
            }
            catch (error) {
                // A preset that resolves but fails to MOUNT (e.g. a row waiting for a
                // host service) rejects inside the agent-factory setup. Surface it and
                // fall back to the default rather than killing the TUI.
                ctx.logger.warn(`tui-runner: failed to start with preset "${launchPreset ?? 'default'}": ${error instanceof Error ? error.message : String(error)}`);
                resumeFailure = `failed to start with preset "${launchPreset ?? 'default'}": ${error instanceof Error ? error.message : String(error)}`;
                const fallback = await compose();
                handle = await agents.create({
                    sessionId: SessionId(`session-${randomUUID()}`),
                    meta: { cwd: process.cwd(), ...withPresetMeta(fallback) },
                    agentOptions,
                    setup: fallback.setup,
                });
            }
        }
        let liveHandle = handle;
        let liveAgent = handle.agent;
        await liveAgent.whenIdle();
        /** The preset the live agent runs on, when the deployment composes one. */
        const currentPreset = () => ctx.get('agentPresets')?.composedPreset(liveAgent.ctx) ?? resolveSessionPreset(liveAgent.session);
        // Stop the TUI when this fiber is disposed (a loader hot-reload unloads
        // the row; the reloaded row starts its own instance in the same process).
        ctx.effect(function* () {
            yield () => {
                app?.stop();
            };
        });
        // Incremental fold state for the live session's log; reset on switch.
        let folder = new TranscriptFolder();
        folder.apply(liveAgent.session.events);
        // Incremental stats + goal badge: applied per event so the footer stays
        // O(1) per refresh instead of re-scanning the whole log.
        let statsFolder = new StatsFolder();
        statsFolder.apply(liveAgent.session.events);
        let goalText = foldGoal(liveAgent.session.events);
        /** Repaint the welcome card from the live agent's current facts. Re-read
         * on every call so a still-blank session's preset switch shows up. */
        const updateWelcomeCard = () => {
            app.setWelcomeCard({
                cwd,
                sessionId: liveAgent.session.id,
                model: `${liveAgent.options.provider}/${liveAgent.options.model}`,
                version: packageVersion(),
                ...currentPreset() === undefined ? {} : { preset: currentPreset() },
            });
        };
        /** Swap the live agent to a new handle, repainting for its session. */
        const swapTo = async (next) => {
            try {
                await sessions.flush(liveAgent.session);
                await liveHandle.dispose();
                liveHandle = next;
                liveAgent = next.agent;
                await liveAgent.whenIdle();
            }
            catch (error) {
                process.stderr.write(`[tui] swap failed: ${error instanceof Error ? error.message : String(error)}\n`);
                return `swap failed: ${error instanceof Error ? error.message : String(error)}`;
            }
            folder = new TranscriptFolder();
            folder.apply(liveAgent.session.events);
            statsFolder = new StatsFolder();
            statsFolder.apply(liveAgent.session.events);
            goalText = foldGoal(liveAgent.session.events);
            app.setWorking(workingFromLog(liveAgent.session.events));
            app.setSessionTitle(foldSessionTitle(liveAgent.session.events)?.title);
            app.clearLocalMessages();
            repaint(app, folder);
            refreshStatus();
            setTerminalTitle(`dsh-pi-tui · ${shortCwd(cwd)} · ${liveAgent.session.id}`);
            updateWelcomeCard();
            return undefined;
        };
        /** Hand the TUI over to another persisted session. Never throws: every
         * failure (unknown session, broken log, preset mount) returns an error
         * string so callers' `.then(error => ...)` need no rejection path. */
        const switchSession = async (sessionId) => {
            try {
                // The target session's recorded preset, exactly like the resume path.
                const composition = await compose(await recordedPreset(ctx, sessionId));
                const next = await agents.resume({
                    resumeSessionId: SessionId(sessionId),
                    agentOptions: { provider: liveAgent.options.provider, model: liveAgent.options.model },
                    setup: composition.setup,
                });
                return swapTo(next);
            }
            catch (error) {
                ctx.logger.warn(`tui-runner: switch to ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
                return `switch failed: ${error instanceof Error ? error.message : String(error)}`;
            }
        };
        // Footer state: model label, cwd, git branch, turn/step counters, and
        // the stats line (LLM timing, tokens, context pressure).
        const cwd = process.cwd();
        /** The footer model label: the live selection (with effort) when one exists. */
        const modelLabel = () => {
            const selection = selected.current;
            if (selection === undefined)
                return `${liveAgent.options.provider}/${liveAgent.options.model}`;
            return selection.reasoningEffort === undefined
                ? `${selection.provider}/${selection.model}`
                : `${selection.provider}/${selection.model} @${selection.reasoningEffort}`;
        };
        const refreshStatus = () => {
            const stats = statsFolder.snapshot();
            let contextTokens;
            const meter = ctx.get('tokenMeter');
            if (meter !== undefined) {
                try {
                    contextTokens = meter.measure(liveAgent.session).totalTokens;
                }
                catch {
                    // Measurement is best-effort; the footer falls back to no context.
                }
            }
            app.setStatus({
                model: modelLabel(),
                cwd: shortCwd(cwd),
                branch: gitBranch(cwd),
                goal: goalText,
                turns: stats.turns,
                steps: stats.steps,
                statsLine: formatStats(stats),
                ...contextTokens !== undefined ? { contextTokens, contextWindow: stats.contextWindow } : {},
            });
        };
        let app;
        // Tool-card presentation bridge: the Web's render intents resolved from
        // the LIVE tool registry as the agent sees it (scoped lookup), so the
        // rendered card matches the definition that actually executed. The
        // registry is read through ctx.get: property access (ctx.tools) trips
        // cordis's inject guard, and an absent registry must degrade to generic
        // cards rather than fail the render.
        const tools = ctx.get('tools');
        const present = toolPresenterFrom(name => tools?.get(name, liveAgent.ctx));
        // Aborts an in-flight command execution when the TUI quits.
        const signal = new AbortController().signal;
        // Abort handle for the currently running `!` shell command.
        let localShellController;
        /** Run a `!` command locally; the output renders as a local card. */
        const runLocalShell = (text) => {
            // `!!` includes the command in the model context; `!` stays local.
            const includeInContext = text.startsWith('!!');
            const command = text.replace(/^!+/, '').trim();
            if (command === '')
                return;
            if (includeInContext) {
                liveAgent.followup(createUserMessage({
                    content: [{ type: 'text', text: command }],
                    source: { kind: 'user' },
                }));
                return;
            }
            localShellController?.abort();
            localShellController = new AbortController();
            const localSignal = localShellController.signal;
            // The card reference this run owns: settling by identity keeps a
            // settled old run from overwriting a newer run's card (updateLastLocal
            // Message would hit whatever card is newest at settle time).
            const card = app.pushLocalMessage({
                kind: 'tool',
                turn: Number.POSITIVE_INFINITY,
                name: 'shell',
                args: command,
                result: '',
                status: 'running',
            });
            /** Release the controller only when it still guards THIS run. */
            const releaseController = () => {
                if (localShellController?.signal === localSignal)
                    localShellController = undefined;
            };
            const settle = (result, status) => {
                app.updateLocalMessage(card, {
                    kind: 'tool',
                    turn: Number.POSITIVE_INFINITY,
                    name: 'shell',
                    args: command,
                    result,
                    status,
                });
            };
            const shell = ctx.get('shell');
            if (shell !== undefined) {
                // The dsh shell capability (sandbox policy + DSH env) when the
                // composition provides it; completion-based like the spawn fallback.
                const spec = shell.resolve({ command, workdir: cwd, signal: localSignal });
                void shell.run(spec).then((result) => {
                    releaseController();
                    if (localSignal.aborted) {
                        settle('aborted', 'error');
                        return;
                    }
                    const output = [result.stdout.text.trim(), result.stderr.text.trim()].filter(Boolean).join('\n');
                    const exit = result.exitCode !== null ? `exit ${result.exitCode}` : `signal ${result.signal ?? '?'}`;
                    settle(output === '' ? exit : `${output}\n[${exit}]`, result.exitCode === 0 ? 'ok' : 'error');
                }).catch((error) => {
                    releaseController();
                    settle(`failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
                });
                return;
            }
            const child = spawn(command, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
            child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
            localSignal.addEventListener('abort', () => child.kill(), { once: true });
            child.on('error', (error) => {
                releaseController();
                settle(`failed: ${error.message}`, 'error');
            });
            child.on('close', (code, childSignal) => {
                releaseController();
                if (localSignal.aborted) {
                    settle('aborted', 'error');
                    return;
                }
                const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
                const exit = code !== null ? `exit ${code}` : `signal ${childSignal ?? '?'}`;
                settle(output === '' ? exit : `${output}\n[${exit}]`, code === 0 ? 'ok' : 'error');
            });
        };
        // Coalesced repaint: streaming events fold into the folder immediately
        // (cheap) but the view rebuild flushes at most every REPAINT_FLUSH_MS,
        // and immediately on turn/end.
        let repaintTimer;
        // P7d: subagent viewer — while set, the transcript shows another live
        // session's log read-only and Esc returns to the parent session.
        let viewing;
        const activeFolder = () => viewing?.folder ?? folder;
        const paintNow = () => {
            if (repaintTimer !== undefined) {
                clearTimeout(repaintTimer);
                repaintTimer = undefined;
            }
            repaint(app, activeFolder());
        };
        const schedulePaint = () => {
            if (repaintTimer !== undefined)
                return;
            repaintTimer = setTimeout(() => {
                repaintTimer = undefined;
                repaint(app, activeFolder());
            }, REPAINT_FLUSH_MS);
        };
        // Tool-call arguments by callId, for the approval-preview dialog.
        const callArgs = new Map();
        // Transcript-search state (see the onSearch* events below).
        let searchMatches = [];
        let searchCurrent = -1;
        const jumpToSearchMatch = () => {
            const match = searchMatches[searchCurrent];
            if (match === undefined)
                return;
            const turn = 'turn' in match ? match.turn : undefined;
            app.setTranscript(activeFolder().messages({
                maxTurns: WINDOW_TURNS,
                ...turn === undefined ? {} : { endTurn: turn },
            }));
            app.setSearchResult(searchCurrent + 1, searchMatches.length);
        };
        /** Enter the read-only subagent viewer for one session (live or persisted). */
        const enterView = async (childId, label) => {
            const childFolder = new TranscriptFolder();
            const child = sessions.get(childId);
            if (child !== undefined) {
                childFolder.apply(child.events);
            }
            else {
                // An inactive child is no longer in the live store; load its log.
                const persistence = ctx.get('sessionPersistence');
                if (persistence !== undefined) {
                    try {
                        childFolder.apply((await persistence.inspect(childId)).events);
                    }
                    catch {
                        // No persisted log either: the view stays empty.
                    }
                }
            }
            viewing = { id: childId, folder: childFolder };
            repaint(app, childFolder);
            app.notify(`viewing subagent ${label ?? childId} — Esc returns`);
        };
        /** Leave the subagent viewer (single Esc). Returns whether it exited. */
        const exitView = () => {
            if (viewing === undefined)
                return false;
            viewing = undefined;
            app.clearLocalMessages();
            repaint(app, folder);
            refreshStatus();
            return true;
        };
        app = startProcessTui({
            onSubmit: (text) => {
                // Persist the (newest-first) input history for this cwd; the editor
                // already recorded the line through TuiApp's submit hook.
                const history = app.getInputHistory();
                if (history.length > 0) {
                    void tuiSettings?.replace({ ...tuiSettings.get(), history: { ...tuiSettings.get().history, [cwd]: history } });
                }
                // `!` commands run locally through the shell (or into context for `!!`)
                // without a model turn; everything else dispatches as before.
                if (text.startsWith('!')) {
                    runLocalShell(text);
                    return;
                }
                // A registered slash command dispatches without a model turn; anything
                // else is a follow-up prompt. The command lifecycle lands in the
                // session log (command/run + command/done) and re-folds into the
                // transcript through the session/event listener below.
                const commands = ctx.get('commands');
                if (commands !== undefined) {
                    // Bare `/plan` toggles: when plan mode is already active it exits
                    // instead of re-entering (the official command needs `/plan off`).
                    const parsed = parseCommand(text);
                    const toggled = parsed?.name === 'plan' && parsed.rawInput.trim() === ''
                        && foldPlanMode(liveAgent.session.events)
                        ? '/plan off'
                        : text;
                    void commands.execute(liveAgent, toggled, signal).then((execution) => {
                        if (execution === undefined) {
                            liveAgent.followup(createUserMessage({
                                content: [{ type: 'text', text }],
                                source: { kind: 'user' },
                            }));
                        }
                    }).catch((error) => {
                        ctx.logger.error(`tui-runner: command execution failed: ${error instanceof Error ? error.message : String(error)}`);
                        app.notify(error instanceof Error ? error.message : String(error));
                    });
                    return;
                }
                liveAgent.followup(createUserMessage({
                    content: [{ type: 'text', text }],
                    source: { kind: 'user' },
                }));
            },
            onExit: () => {
                void (async () => {
                    await sessions.flush(liveAgent.session);
                    app.stop();
                    exit(0);
                })();
            },
            onCancel: () => {
                // Double-Esc: abort a running `!` shell command, then the live turn.
                localShellController?.abort();
                liveAgent.cancel({ kind: 'user' });
            },
            onSteer: (text) => {
                // Ctrl+S: inject the draft into the running turn; an idle agent
                // just starts a regular turn with it.
                const message = createUserMessage({
                    content: [{ type: 'text', text }],
                    source: { kind: 'user' },
                });
                if (liveAgent.status === 'running') {
                    liveAgent.steer(message);
                }
                else {
                    liveAgent.followup(message);
                }
            },
            openExternalEditor: async (draft) => {
                const editor = process.env.VISUAL ?? process.env.EDITOR ?? 'vi';
                const file = join(tmpdir(), `dsh-pi-tui-${process.pid}-${randomUUID()}.md`);
                writeFileSync(file, draft);
                try {
                    await new Promise((resolve, reject) => {
                        const child = spawn(editor, [file], { stdio: 'inherit' });
                        child.on('error', reject);
                        child.on('close', () => resolve());
                    });
                    return readFileSync(file, 'utf8');
                }
                finally {
                    rmSync(file, { force: true });
                }
            },
            // Persist the Ctrl+F toggle (the settings panel writes the same field
            // itself); `tuiSettings` is declared later, so the closure reads it
            // lazily at toggle time.
            onFullscreenChange: (fullscreen) => {
                void tuiSettings?.replace({ ...tuiSettings.get(), fullscreen: fullscreen ? 'on' : 'off' });
            },
            // Transcript search (Ctrl+Shift+F): matches run over the FULL folded
            // transcript; each jump re-windows the view so the matched turn is
            // visible (older turns collapse above it into the summary entry).
            onSearchQuery: (query) => {
                const needle = query.trim().toLowerCase();
                const searchable = (message) => message.kind === 'tool' ? `${message.name} ${message.args} ${message.result}` : message.text;
                const full = folder.messages();
                searchMatches = needle === '' ? [] : full.filter(message => searchable(message).toLowerCase().includes(needle));
                searchCurrent = searchMatches.length > 0 ? 0 : -1;
                app.setSearchResult(searchCurrent + 1, searchMatches.length);
                if (searchCurrent >= 0)
                    jumpToSearchMatch();
            },
            onSearchNext: () => {
                if (searchMatches.length === 0)
                    return;
                searchCurrent = (searchCurrent + 1) % searchMatches.length;
                jumpToSearchMatch();
            },
            onSearchPrev: () => {
                if (searchMatches.length === 0)
                    return;
                searchCurrent = (searchCurrent - 1 + searchMatches.length) % searchMatches.length;
                jumpToSearchMatch();
            },
            onSearchClose: () => {
                searchMatches = [];
                searchCurrent = -1;
                repaint(app, activeFolder());
            },
            // P7d: a single Esc with no overlay up exits the subagent viewer
            // instead of arming the double-Esc cancel.
            onSingleEscape: () => exitView(),
        }, {
            present,
            workspaceRoot: cwd,
        });
        paintNow();
        setTerminalTitle(`dsh-pi-tui · ${shortCwd(cwd)} · ${liveAgent.session.id}`);
        updateWelcomeCard();
        if (resumeFailure !== undefined)
            app.notify(resumeFailure);
        // Persisted TUI preferences: register the namespace and restore the
        // theme + footer preset. `history` holds per-cwd input history for ↑/↓
        // recall across restarts. Theme values: auto | dark | light | custom:<name>.
        const tuiSettings = ctx.get('settings')?.register(settingsNamespace('dsh-pi-tui'), z.object({
            theme: z.string(),
            footer: z.string(),
            fullscreen: z.string(),
            history: z.dict(z.array(z.string())),
        }), { base: { theme: 'auto', footer: 'full', fullscreen: 'off', history: {} } });
        const storedTheme = tuiSettings?.get().theme;
        if (storedTheme === 'auto') {
            // Follow the terminal: query once at boot, then track scheme reports.
            void app.autoDetectTheme();
            app.onTerminalThemeChange((theme) => {
                if (tuiSettings?.get().theme === 'auto')
                    app.applyTheme(theme);
            });
        }
        else if (storedTheme === 'dark' || storedTheme === 'light') {
            app.applyTheme(storedTheme);
        }
        else if (storedTheme?.startsWith('custom:')) {
            const palette = loadCustomTheme(storedTheme.slice('custom:'.length));
            if (palette !== undefined)
                app.applyPalette(palette);
        }
        const storedFooter = tuiSettings?.get().footer;
        if (storedFooter === 'compact')
            app.setFooterPreset('compact');
        // Fullscreen is a persisted preference like the theme and the footer:
        // boot applies it, the settings panel and Ctrl+F both write through it.
        if (tuiSettings?.get().fullscreen === 'on')
            app.setFullscreen(true);
        const storedHistory = tuiSettings?.get().history[cwd];
        if (storedHistory !== undefined && storedHistory.length > 0) {
            app.seedInputHistory(storedHistory);
        }
        // The TUI-owned slash commands (/exit /settings /sessions /skill /model
        // /new /tasks /preset /subagents /search /title /copy /export /fork
        // /status /login /logout /help) are registered from commands.ts; this
        // runner surface re-reads the live agent/settings on every access, so a
        // session swap mid-flight is always reflected.
        if (ctx.get('commands') !== undefined) {
            registerTuiCommands({
                ctx,
                app,
                get liveAgent() { return liveAgent; },
                get selected() { return selected; },
                get tuiSettings() { return tuiSettings; },
                agents: agents,
                sessions: { flush: (session) => sessions.flush(session) },
                cwd,
                signal,
                compose,
                switchSession,
                swapTo: (next) => swapTo(next),
                currentPreset,
                recomposeBlank: (id) => recomposeBlank(ctx, liveAgent, id),
                refreshStatus,
                updateWelcomeCard,
                enterView,
                exit,
            });
        }
        refreshStatus();
        ctx.on('session/event', (session, event) => {
            // The subagent viewer follows its own session's events; everything
            // else routes to the live agent's folder as before.
            if (viewing !== undefined) {
                if (session.id !== viewing.id)
                    return;
                viewing.folder.apply([event]);
                schedulePaint();
                if (event.type === 'turn/end')
                    paintNow();
                return;
            }
            if (session.id !== liveAgent.session.id)
                return;
            // Pair approval previews: remember each tool call's arguments by callId.
            if (event.type === 'tool/call') {
                callArgs.set(event.data.callId, typeof event.data.arguments === 'string'
                    ? event.data.arguments
                    : JSON.stringify(event.data.arguments));
            }
            else if (event.type === 'tool/result') {
                callArgs.delete(event.data.message.content[0]?.toolCallId ?? '');
            }
            folder.apply([event]);
            statsFolder.apply([event]);
            // The goal badge folds incrementally: the newest goal/change event
            // decides, so one event is enough (clear/completed hide the badge).
            if (event.type === 'goal/change')
                goalText = foldGoal([event]);
            schedulePaint();
            if (event.type === 'todo/write')
                app.setTodoSummary(event.data.todos);
            if (event.type === 'plan/mode')
                app.setPlanMode(event.data.active);
            if (event.type === 'session/title')
                app.setSessionTitle(foldSessionTitle([event])?.title);
            // Persist each completed turn so a crash loses at most the live turn.
            // The busy indicator follows turn boundaries: on from the moment a
            // turn starts (model wait + tool calls), off when it ends.
            if (event.type === 'turn/start') {
                app.setWorking(true);
            }
            else if (event.type === 'turn/end') {
                app.setWorking(false);
                paintNow();
                refreshStatus();
                void sessions.flush(liveAgent.session);
            }
            else if (event.type === 'step/start') {
                refreshStatus();
            }
        });
        // Initial plan badge, busy indicator, and auto title from the log (a
        // resumed session may be persisted mid-turn).
        app.setPlanMode(foldPlanMode(liveAgent.session.events));
        app.setWorking(workingFromLog(liveAgent.session.events));
        app.setSessionTitle(foldSessionTitle(liveAgent.session.events)?.title);
        // Initial todo state: the last todo/write snapshot in the log.
        for (let index = liveAgent.session.events.length - 1; index >= 0; index -= 1) {
            const event = liveAgent.session.events[index];
            if (event.type === 'todo/write') {
                app.setTodoSummary(event.data.todos);
                break;
            }
        }
        // The interactive answerer: every approval ask becomes a dialog. An
        // already-aborted request settles cancelled synchronously; otherwise the
        // prompt's own abort signal withdraws it (turn cancel). P7c: the dialog
        // previews the paired tool call's arguments and flags dangerous commands.
        ctx.on('approval/request', (req, next) => {
            if (req.signal?.aborted === true)
                return Promise.resolve('cancelled');
            const args = req.callId === undefined ? undefined : callArgs.get(req.callId);
            return app.showApprovalPrompt({
                toolName: req.toolName,
                reason: req.reason,
                signal: req.signal,
                ...args === undefined ? {} : { arguments: args },
                ...args !== undefined && req.toolName === 'bash' && dangerCommand(args) ? { danger: true } : {},
            });
        });
        // The interactive question answerer: ask_user_question tool calls become
        // dialog flows; the tool receives the structured answers.
        const userQuestions = ctx.get('userQuestions');
        if (userQuestions !== undefined) {
            userQuestions.registerProvider({
                ask: async (request) => {
                    const answers = await app.askQuestions(request.questions.map(question => ({
                        id: question.id,
                        question: question.question,
                        ...question.header !== undefined ? { header: question.header } : {},
                        ...question.options !== undefined ? { options: question.options } : {},
                        ...question.multiSelect !== undefined ? { multiSelect: question.multiSelect } : {},
                    })), request.signal);
                    return {
                        answers: answers.map(answer => ({
                            id: answer.id,
                            selected: answer.selected,
                            ...answer.custom !== undefined ? { custom: answer.custom } : {},
                        })),
                    };
                },
            });
        }
    })().catch((error) => {
        ctx.logger.error(`tui-runner: ${error instanceof Error ? error.message : String(error)}`);
        exit(1);
    });
}
