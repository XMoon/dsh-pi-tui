/**
 * @dsh-pi-tui/tui-app — the bundle's runner plugin. Waits for the startup
 * service (the parsed `dsh --profile pi-tui` flags) and Loader settlement,
 * creates or resumes an Agent through the core registry, renders its session
 * log into the TUI transcript, and routes editor submissions back through
 * `agent.followup`. Streaming arrives through the `session/event` firehose;
 * the transcript view re-folds the log per event (small logs keep this
 * simple and always consistent).
 * @module @dsh-pi-tui/tui-app
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { TUI_STARTUP_SERVICE } from "./startup.js";
import { foldTranscript } from "./transcript.js";
import { computeStats, formatStats } from "./stats.js";
import { startProcessTui } from "./tui-app.js";
/** Stable Cordis plugin name. */
export const name = 'tui-runner';
/** Core services required before the TUI can mount. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', TUI_STARTUP_SERVICE];
export const Config = z.object({
    sessionId: z.string(),
});
/**
 * Re-fold and repaint the transcript from the session log.
 * @param app - the TUI surface.
 * @param events - the session log snapshot.
 */
function repaint(app, events) {
    app.setTranscript(foldTranscript(events));
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
        // Same composition as dsh-headless: this bundle composes no preset roster,
        // so the model-facing rows sit in the host plane.
        const setup = (agentCtx) => {
            const selected = { current: selection, assembled: undefined };
            installModelSelection(agentCtx, selected);
        };
        const handle = config.sessionId !== undefined
            ? await agents.resume({ resumeSessionId: SessionId(config.sessionId), agentOptions, setup })
            : await agents.create({
                sessionId: SessionId(`session-${randomUUID()}`),
                meta: { cwd: process.cwd() },
                agentOptions,
                setup,
            });
        const { agent } = handle;
        await agent.whenIdle();
        // Footer state: model label, cwd, git branch, turn/step counters, and
        // the stats line (LLM timing, tokens, context pressure).
        const cwd = process.cwd();
        const refreshStatus = () => {
            const stats = computeStats(agent.session.events);
            let contextTokens;
            const meter = ctx.get('tokenMeter');
            if (meter !== undefined) {
                try {
                    contextTokens = meter.measure(agent.session).totalTokens;
                }
                catch {
                    // Measurement is best-effort; the footer falls back to no context.
                }
            }
            app.setStatus({
                model: `${agent.options.provider}/${agent.options.model}`,
                cwd: shortCwd(cwd),
                branch: gitBranch(cwd),
                turns: stats.turns,
                steps: stats.steps,
                statsLine: formatStats(stats, contextTokens),
                ...contextTokens !== undefined ? { contextTokens, contextWindow: stats.contextWindow } : {},
            });
        };
        let app;
        // Aborts an in-flight command execution when the TUI quits.
        const signal = new AbortController().signal;
        app = startProcessTui({
            onSubmit: (text) => {
                // A registered slash command dispatches without a model turn; anything
                // else is a follow-up prompt. The command lifecycle lands in the
                // session log (command/run + command/done) and re-folds into the
                // transcript through the session/event listener below.
                const commands = ctx.get('commands');
                if (commands !== undefined) {
                    void commands.execute(agent, text, signal).then((execution) => {
                        if (execution === undefined) {
                            agent.followup(createUserMessage({
                                content: [{ type: 'text', text }],
                                source: { kind: 'user' },
                            }));
                        }
                    });
                    return;
                }
                agent.followup(createUserMessage({
                    content: [{ type: 'text', text }],
                    source: { kind: 'user' },
                }));
            },
            onExit: () => {
                void (async () => {
                    await sessions.flush(agent.session);
                    app.stop();
                    exit(0);
                })();
            },
        });
        repaint(app, agent.session.events);
        const commands = ctx.get('commands');
        if (commands !== undefined) {
            // Slash-command autocompletion from the command registry.
            app.setCommandCompletions(commands.list(agent).map(command => ({
                name: command.name,
                description: command.description,
            })), cwd);
            commands.register({
                name: 'exit',
                description: 'Quit the terminal UI (flush and exit)',
                handler: () => {
                    app.stop();
                    void sessions.flush(agent.session).then(() => exit(0));
                    return { kind: 'success' };
                },
            });
            commands.register({
                name: 'settings',
                description: 'Open the TUI settings panel',
                handler: () => {
                    app.openSettings([
                        {
                            id: 'approval',
                            label: 'Approval policy',
                            description: 'How tool approvals are handled in this session',
                            currentValue: 'ask',
                            values: ['ask', 'never'],
                        },
                        {
                            id: 'theme',
                            label: 'Theme',
                            description: 'Color palette (applies immediately)',
                            currentValue: 'dark',
                            values: ['dark', 'light'],
                        },
                    ], (id, value) => {
                        if (id === 'approval') {
                            if (value === 'ask' || value === 'never')
                                ctx.approval?.setPolicy(agent, value);
                        }
                        else if (id === 'theme') {
                            if (value === 'dark' || value === 'light')
                                app.applyTheme(value);
                        }
                    }, () => { });
                    return { kind: 'success' };
                },
            });
        }
        refreshStatus();
        ctx.on('session/event', (session, event) => {
            if (session.id !== agent.session.id)
                return;
            repaint(app, agent.session.events);
            if (event.type === 'todo/write')
                app.setTodoSummary(event.data.todos);
            // Persist each completed turn so a crash loses at most the live turn.
            if (event.type === 'turn/end') {
                refreshStatus();
                void sessions.flush(agent.session);
            }
            else if (event.type === 'step/start') {
                refreshStatus();
            }
        });
        // Initial todo state: the last todo/write snapshot in the log.
        for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
            const event = agent.session.events[index];
            if (event.type === 'todo/write') {
                app.setTodoSummary(event.data.todos);
                break;
            }
        }
        // The interactive answerer: every approval ask becomes a dialog. An
        // already-aborted request settles cancelled synchronously; otherwise the
        // prompt's own abort signal withdraws it (turn cancel).
        ctx.on('approval/request', (req, next) => {
            if (req.signal?.aborted === true)
                return Promise.resolve('cancelled');
            return app.showApprovalPrompt({ toolName: req.toolName, reason: req.reason, signal: req.signal });
        });
    })().catch((error) => {
        ctx.logger.error(`tui-runner: ${error instanceof Error ? error.message : String(error)}`);
        exit(1);
    });
}
