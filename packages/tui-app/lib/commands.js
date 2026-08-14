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
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets';
import { effectiveApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { SettingsList } from '@dsh-pi-tui/pi-tui';
import { color, loadCustomTheme, settingsListTheme } from "./theme.js";
import { ModelSubmenu } from "./model-menu.js";
import { computeStats, formatStats } from "./stats.js";
import { renderTranscriptMarkdown } from "./transcript.js";
import { MAX_PICKER_SESSIONS, headerToPickerRow, loadSessionTitles, sessionPickerItem, } from "./sessions.js";
import { customThemeNames } from "./theme.js";
/** A balanced completed-turn prefix for forking: the log up to (and including)
 * the last `turn/end`. Undefined when no turn has completed yet.
 * @param events - the session log.
 * @returns the fork seed events, or undefined.
 */
export function forkSeed(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index]?.type === 'turn/end')
            return events.slice(0, index + 1);
    }
    return undefined;
}
/** Shorten a session id for read-only display rows, capped at 28 characters. */
function displaySessionId(id) {
    return id.length > 28 ? `${id.slice(0, 28)}…` : id;
}
/** Session meta for a fresh/forked session: the cwd plus the preset id when composed. */
function metaOf(cwd, presetId) {
    return presetId === undefined ? { cwd } : { cwd, agentPreset: presetId };
}
/**
 * Register the TUI-owned slash commands on the commands service. The
 * completion list is refreshed after every registration so TUI-owned
 * commands appear in the editor's tab list.
 * @param runner - the live runner surface.
 */
export function registerTuiCommands(runner) {
    const { ctx, app } = runner;
    const cwd = runner.cwd;
    const signal = runner.signal;
    const commands = ctx.get('commands');
    if (commands === undefined)
        return;
    // Refresh completions after every registration below so TUI-owned
    // commands (/exit /settings /skill /model) appear in the tab list.
    const refreshCompletions = () => {
        app.setCommandCompletions(commands.list(runner.liveAgent).map(command => ({
            name: command.name,
            description: command.description,
            argumentHint: command.input?.hint,
        })), cwd);
    };
    refreshCompletions();
    commands.register({
        name: 'exit',
        description: 'Quit the terminal UI (flush and exit)',
        handler: () => {
            const liveAgent = runner.liveAgent;
            app.stop();
            void runner.sessions.flush(liveAgent.session).then(() => runner.exit(0));
            return { kind: 'success' };
        },
    });
    commands.register({
        name: 'settings',
        description: 'Open the TUI settings panel',
        handler: () => {
            const liveAgent = runner.liveAgent;
            const tuiSettings = runner.tuiSettings;
            const theme = tuiSettings?.get().theme ?? 'auto';
            const themeValue = theme.startsWith('custom:') ? theme.slice('custom:'.length) : theme;
            app.openSettings([
                {
                    id: 'approval',
                    label: 'Approval policy',
                    description: 'How tool approvals are handled in this session',
                    currentValue: effectiveApprovalPolicy(liveAgent.session.events) ?? 'ask',
                    values: ['ask', 'never'],
                },
                {
                    id: 'theme',
                    label: 'Theme',
                    description: 'Palette: auto follows the terminal; custom from ~/.dsh-pi-tui/themes',
                    currentValue: themeValue,
                    values: ['auto', 'dark', 'light', ...customThemeNames()],
                },
                {
                    id: 'expand',
                    label: 'Tool output',
                    description: 'Whether thinking/tool entries start expanded',
                    currentValue: app.isToolOutputExpanded() ? 'expanded' : 'collapsed',
                    values: ['collapsed', 'expanded'],
                },
                {
                    id: 'thinking',
                    label: 'Thinking blocks',
                    description: 'Whether reasoning entries render at all',
                    currentValue: app.isThinkingHidden() ? 'hidden' : 'shown',
                    values: ['shown', 'hidden'],
                },
                {
                    id: 'footer',
                    label: 'Status line',
                    description: 'Footer density: full keeps the stats line',
                    currentValue: app.getFooterPreset(),
                    values: ['full', 'compact'],
                },
                {
                    id: 'fullscreen',
                    label: 'Fullscreen',
                    description: 'Alt-screen mode: off keeps the terminal scrollback',
                    currentValue: app.isFullscreen() ? 'on' : 'off',
                    values: ['off', 'on'],
                },
                // ── read-only session facts ─────────────────────────────
                {
                    id: 'separator',
                    label: color.border('─'.repeat(34)),
                    currentValue: '',
                },
                {
                    id: 'session',
                    label: color.textDim('Session'),
                    description: color.textDim(liveAgent.session.id),
                    currentValue: color.textDim(displaySessionId(liveAgent.session.id)),
                },
                {
                    id: 'model',
                    label: color.textDim('Model'),
                    description: color.textDim('Provider and model routing this session'),
                    currentValue: color.textDim(`${liveAgent.options.provider}/${liveAgent.options.model}`),
                },
                {
                    id: 'preset',
                    label: color.textDim('Agent preset'),
                    description: color.textDim('Composition this session runs on (see /preset)'),
                    currentValue: color.textDim(runner.currentPreset() ?? 'none'),
                },
                {
                    id: 'cwd',
                    label: color.textDim('Working directory'),
                    description: color.textDim('Where this session runs'),
                    currentValue: color.textDim(cwd),
                },
            ], (id, value) => {
                if (id === 'approval') {
                    if (value === 'ask' || value === 'never')
                        ctx.get('approval')?.setPolicy(liveAgent, value);
                }
                else if (id === 'theme') {
                    if (value === 'auto' || value === 'dark' || value === 'light' || customThemeNames().includes(value)) {
                        if (value === 'auto') {
                            void app.autoDetectTheme();
                        }
                        else if (value === 'dark' || value === 'light') {
                            app.applyTheme(value);
                        }
                        else {
                            const palette = loadCustomTheme(value);
                            if (palette !== undefined) {
                                app.applyPalette(palette);
                            }
                            else {
                                app.notify(`theme ${value} not found`);
                                return;
                            }
                        }
                        // Spread the current doc: a replace is wholesale, so the
                        // persisted input history must ride along.
                        void tuiSettings?.replace({ ...tuiSettings.get(), theme: value === 'auto' || value === 'dark' || value === 'light' ? value : `custom:${value}` });
                    }
                }
                else if (id === 'expand') {
                    app.setToolOutputExpanded(value === 'expanded');
                }
                else if (id === 'thinking') {
                    if ((value === 'shown') === app.isThinkingHidden())
                        app.toggleThinkingHidden();
                }
                else if (id === 'footer') {
                    if (value === 'full' || value === 'compact') {
                        app.setFooterPreset(value);
                        void tuiSettings?.replace({ ...tuiSettings.get(), footer: value });
                    }
                }
                else if (id === 'fullscreen') {
                    if (value === 'off' || value === 'on') {
                        app.setFullscreen(value === 'on');
                        // setFullscreen reports through onFullscreenChange, which
                        // persists the same field (this branch is the panel write).
                    }
                }
            }, () => { });
            return { kind: 'success' };
        },
    });
    commands.register({
        name: 'sessions',
        description: 'List, search, and switch persisted sessions',
        input: { hint: '[query]' },
        handler: async (invocation) => {
            const liveAgent = runner.liveAgent;
            const persistence = ctx.get('sessionPersistence');
            if (persistence === undefined)
                return { kind: 'error', text: 'session persistence unavailable' };
            // Live-preferred listing (sessionQuery) marks sessions currently
            // loaded in the store; the persistence fallback is the plain list.
            // The engine is read structurally off the context (no package
            // import): `dsh-base` mounts it in every profile.
            const query = ctx.get('sessionQuery');
            let rows;
            if (query !== undefined) {
                rows = (await query.listSessions()).map(record => headerToPickerRow(record.header, record.live));
            }
            else {
                rows = (await persistence.list()).map(header => headerToPickerRow(header, header.id === liveAgent.session.id));
            }
            rows.sort((a, b) => b.createdAt - a.createdAt);
            if (rows.length === 0)
                return { kind: 'error', text: 'no persisted sessions' };
            // The picker opens instantly on the headers; titles land in the
            // background below. The cap keeps the title read bounded.
            const shown = rows.slice(0, MAX_PICKER_SESSIONS);
            const picker = app.openPicker(shown.map(row => sessionPickerItem(row, liveAgent.session.id)), (id) => {
                if (id === liveAgent.session.id)
                    return;
                void runner.switchSession(id).then(error => {
                    if (error !== undefined)
                        app.notify(error);
                });
            }, () => { }, {
                enableSearch: true,
                header: 'sessions',
                noMatchText: '  no matching sessions',
                initialQuery: invocation.rawInput.trim(),
                width: 76,
                maxHeight: 26,
                showHint: true,
            });
            // Enrich rows with titles as they load; the active search query is
            // re-applied by the picker, and the current marker is re-read so a
            // session switch mid-load does not mislabel.
            void loadSessionTitles(query, persistence, shown.map(row => row.id), signal)
                .then(titles => {
                if (titles.size === 0)
                    return;
                picker.setItems(shown.map(row => sessionPickerItem({ ...row, title: titles.get(row.id) }, liveAgent.session.id)));
            })
                .catch(() => {
                // Cancellation (TUI quit) or an unexpected batch failure only
                // loses the titles, never the picker.
            });
            return { kind: 'success' };
        },
    });
    commands.register({
        name: 'skill',
        description: 'Load a skill into the session context',
        input: { hint: '<name>' },
        handler: async (invocation) => {
            const liveAgent = runner.liveAgent;
            const skills = ctx.get('skills');
            if (skills === undefined)
                return { kind: 'error', text: 'skill service unavailable' };
            const load = async (name) => {
                const skill = await skills.get(name, { cwd });
                if (skill === undefined)
                    return { kind: 'error', text: `unknown skill "${name}"` };
                liveAgent.inject(createUserMessage({
                    content: [{ type: 'text', text: `Skill loaded by the user: **${skill.name}**\n\n${skill.content ?? skill.description}` }],
                    source: { kind: 'plugin', plugin: 'tui-skill' },
                }));
                return { kind: 'success', text: `skill ${name} loaded` };
            };
            const name = invocation.rawInput.trim();
            if (name !== '')
                return load(name);
            // No argument: pick from the catalog.
            const catalog = await skills.list({ cwd });
            if (catalog.length === 0)
                return { kind: 'error', text: 'no skills available' };
            // SettingsList rows: Enter cycles the `✓` value, which fires onChange.
            app.openSettings(catalog.map(skill => ({
                id: skill.name,
                label: skill.name,
                description: skill.description,
                currentValue: '',
                values: ['✓'],
            })), (id) => {
                void load(id).then(result => { if (result.kind === 'error')
                    app.notify(result.text); });
            }, () => { });
            return { kind: 'success' };
        },
    });
    commands.register({
        name: 'model',
        description: 'Switch the model (and reasoning effort) for this session',
        handler: async () => {
            const selected = runner.selected;
            const llm = ctx.get('llm');
            const defaultModel = ctx.get('agentDefaultModel');
            if (llm === undefined || defaultModel === undefined)
                return { kind: 'error', text: 'model service unavailable' };
            const providers = llm.listProviders();
            const current = defaultModel.currentSelection();
            /** Commit a selection (model, optional effort) and refresh the footer. */
            const apply = (next) => {
                void defaultModel.saveSelection(next);
                selected.current = next;
                runner.refreshStatus();
            };
            // The model and effort levels render INSIDE the provider list's
            // submenu slot (ModelSubmenu/EffortSubmenu): selecting applies
            // immediately and Esc walks back one level. A nested openSettings
            // would mount a second overlay and leave the first one hanging
            // (the ghost-overlay trap the /subagents flow documents).
            app.openSettings(providers.map(provider => ({
                id: provider.id,
                label: provider.name,
                currentValue: current.provider === provider.id ? current.model : '',
                submenu: (value, done) => new ModelSubmenu(provider.id, current.model, selected.current?.reasoningEffort, {
                    listModels: (id) => llm.listModels(id),
                    resolveModelInfo: (id, modelId) => llm.resolveModelInfo(id, modelId),
                    apply,
                    requestRender: () => app.requestRender(),
                    done,
                }),
            })), () => { }, () => { });
            return { kind: 'success' };
        },
    });
    commands.register({
        name: 'new',
        description: 'Start a fresh session in this workspace',
        handler: async () => {
            const liveAgent = runner.liveAgent;
            const composition = await runner.compose();
            const presetId = composition.agentPreset;
            const next = await runner.agents.create({
                sessionId: SessionId(`session-${randomUUID()}`),
                meta: metaOf(cwd, presetId),
                agentOptions: { provider: liveAgent.options.provider, model: liveAgent.options.model },
                setup: composition.setup,
            });
            const error = await runner.swapTo(next);
            if (error !== undefined)
                app.notify(error);
            return { kind: 'success', text: 'started a fresh session' };
        },
    });
    commands.register({
        name: 'tasks',
        description: 'List background jobs for this session',
        handler: () => {
            const liveAgent = runner.liveAgent;
            const jobs = ctx.get('jobs');
            if (jobs === undefined)
                return { kind: 'error', text: 'jobs service unavailable' };
            const snapshots = jobs.list(liveAgent);
            if (snapshots.length === 0)
                return { kind: 'error', text: 'no background jobs' };
            const now = Date.now();
            app.openPicker(snapshots.map(job => ({
                value: job.id,
                label: `${job.kind} · ${job.label}`,
                description: `${job.status}${job.detail === undefined ? '' : ` — ${job.detail}`} · ${Math.max(0, Math.floor((now - job.startedAt) / 1000))}s`,
            })), () => { }, () => { });
            return { kind: 'success' };
        },
    });
    // `/permission` is NOT registered here: dsh-permission-presets in the
    // base layer already registers it (text form: `/permission` shows the
    // current preset, `/permission <name>` switches). Registering it again
    // would throw "command already registered" and kill the TUI.
    // `/preset` IS TUI-owned: the base composes no roster and registers no
    // preset command, so this cannot collide (P5.7 lesson, positive case).
    commands.register({
        name: 'preset',
        description: 'Show or switch the session agent preset',
        input: { hint: '[status|<id>|default [<id>]]' },
        handler: async (invocation) => {
            const liveAgent = runner.liveAgent;
            const presets = ctx.get('agentPresets');
            if (presets === undefined) {
                return { kind: 'error', text: 'agent presets unavailable in this deployment' };
            }
            const current = presets.composedPreset(liveAgent.ctx) ?? resolveSessionPreset(liveAgent.session);
            const matched = invocation.rawInput.trim().match(/^(\S+)(?:\s+(.*))?$/);
            const verb = matched?.[1] ?? '';
            const rest = matched?.[2]?.trim() ?? '';
            if (verb === 'status') {
                return { kind: 'success', text: `preset: ${current ?? 'none'} · default: ${presets.defaultId}` };
            }
            if (verb === 'default') {
                const settings = ctx.get('settings');
                if (settings === undefined)
                    return { kind: 'error', text: 'settings service unavailable' };
                const ns = settingsNamespace('agent-presets');
                if (rest === '') {
                    const doc = settings.get(ns);
                    return { kind: 'success', text: `default preset: ${doc?.default ?? presets.defaultId}` };
                }
                await settings.mutate(ns, [{ op: 'set', path: ['default'], value: rest }]);
                return { kind: 'success', text: `default preset set: ${rest}` };
            }
            if (verb !== '') {
                // Selecting swaps the composition; only a blank session (no turn
                // has run yet) may do so — a started conversation's history was
                // produced under its preset's tools. Same rule as the official
                // `agentPreset.select` RPC and the launch-time --preset path.
                try {
                    const outcome = await runner.recomposeBlank(verb);
                    if (outcome.kind === 'locked') {
                        return {
                            kind: 'error',
                            text: `session "${liveAgent.session.id}" has already started; its agent preset is fixed`,
                        };
                    }
                    refreshCompletions();
                    // A still-blank session's welcome card shows the preset: repaint it
                    // so the switch is visible before any conversation starts.
                    runner.updateWelcomeCard();
                    return { kind: 'success', text: `session preset switched to ${outcome.preset}` };
                }
                catch (error) {
                    return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
                }
            }
            const roster = await presets.list();
            if (roster.length === 0)
                return { kind: 'success', text: 'no agent presets configured' };
            app.openSettings(roster.map(preset => ({
                id: preset.id,
                label: preset.name === undefined ? preset.id : `${preset.name} (${preset.id})`,
                description: [
                    preset.trust === 'system' ? 'system' : 'user',
                    preset.id === presets.defaultId ? 'default' : undefined,
                    preset.id === current ? '← current' : undefined,
                    preset.broken,
                ].filter(Boolean).join(' · '),
                currentValue: '',
            })), () => { }, () => { });
            return { kind: 'success' };
        },
    });
    commands.register({
        name: 'subagents',
        description: 'List child agents; view a transcript or interrupt one',
        handler: async () => {
            const liveAgent = runner.liveAgent;
            const subagents = ctx.get('subagents');
            if (subagents === undefined)
                return { kind: 'error', text: 'subagent service unavailable' };
            const children = (await subagents.listChildren(liveAgent.session.id))
                .filter(child => child.kind === 'child');
            if (children.length === 0)
                return { kind: 'success', text: 'no subagents for this session' };
            const labelOf = (child) => child.label ?? child.id;
            app.openSettings(children.map(child => ({
                id: child.id,
                label: labelOf(child),
                description: `${child.mode} · ${child.activity}${child.hasChildren ? ' · has children' : ''}`,
                currentValue: '',
                // The submenu is rendered INSIDE the list (SettingsList mounts
                // the returned component in place); picking an action reports
                // it through the list's onChange. Opening a second panel here
                // would leave this list mounted as a ghost overlay that eats
                // every later Esc.
                submenu: (value, done) => new SettingsList([
                    { id: 'view', label: 'View transcript', description: 'Watch this session read-only (Esc to return)', currentValue: '', values: ['✓'] },
                    { id: 'interrupt', label: 'Interrupt', description: 'Cancel the child agent', currentValue: '', values: ['✓'] },
                ], 6, settingsListTheme, 
                // The action is the row ID; the cycled value is a checkmark.
                (id) => done(id), () => done(), {}),
            })), (childId, action) => {
                const child = children.find(candidate => candidate.id === childId);
                if (child === undefined)
                    return;
                if (action === 'view') {
                    void runner.enterView(child.id, labelOf(child));
                }
                else if (action === 'interrupt') {
                    subagents.interrupt(child.id, { kind: 'user', parentSessionId: liveAgent.session.id });
                    app.notify(`interrupting ${labelOf(child)}`);
                }
            }, () => { });
            return { kind: 'success' };
        },
    });
    commands.register({
        name: 'search',
        description: 'Search persisted sessions for text and switch to a hit',
        input: { hint: '<query>' },
        handler: async (invocation) => {
            const liveAgent = runner.liveAgent;
            const persistence = ctx.get('sessionPersistence');
            if (persistence === undefined)
                return { kind: 'error', text: 'session persistence unavailable' };
            const query = invocation.rawInput.trim();
            if (query === '')
                return { kind: 'error', text: 'search needs a query' };
            const needle = query.toLowerCase();
            const headers = (await persistence.list())
                .sort((a, b) => b.createdAt - a.createdAt)
                .slice(0, 100);
            const hits = [];
            for (const header of headers) {
                let raw;
                try {
                    raw = await persistence.readRaw(header.id);
                }
                catch {
                    continue;
                }
                if (raw === undefined)
                    continue;
                const index = raw.content.toLowerCase().indexOf(needle);
                if (index === -1)
                    continue;
                const start = Math.max(0, index - 40);
                const snippet = raw.content.slice(start, index + query.length + 40).replace(/\s+/g, ' ').trim();
                hits.push({ id: header.id, createdAt: header.createdAt, snippet });
                if (hits.length >= 20)
                    break;
            }
            if (hits.length === 0)
                return { kind: 'success', text: `no persisted session contains "${query}"` };
            const now = Date.now();
            app.openPicker(hits.map(hit => ({
                value: hit.id,
                label: hit.id.length > 26 ? `${hit.id.slice(0, 26)}…` : hit.id,
                description: `${Math.max(0, Math.floor((now - hit.createdAt) / 60000))}m ago · …${hit.snippet}…`,
            })), (id) => {
                if (id === liveAgent.session.id)
                    return;
                void runner.switchSession(id).then(error => {
                    if (error !== undefined)
                        app.notify(error);
                });
            }, () => { });
            return { kind: 'success' };
        },
    });
    commands.register({
        name: 'title',
        description: 'Set or show the session title',
        input: { hint: '<title>' },
        handler: (invocation) => {
            const liveAgent = runner.liveAgent;
            const titles = ctx.get('sessionTitle');
            if (titles === undefined)
                return { kind: 'error', text: 'session title service unavailable' };
            const name = invocation.rawInput.trim();
            if (name === '') {
                const current = titles.get(liveAgent.session);
                return { kind: 'success', text: current === undefined ? 'no title set' : `title: ${current.title}` };
            }
            titles.rename(liveAgent.session, name);
            return { kind: 'success', text: `title set: ${name}` };
        },
    });
    commands.register({
        name: 'copy',
        description: 'Copy the last assistant message (OSC 52 clipboard)',
        handler: () => {
            const liveAgent = runner.liveAgent;
            const last = liveAgent.session.events.findLast((event) => event.type === 'assistant/message');
            if (last === undefined)
                return { kind: 'error', text: 'no assistant message yet' };
            const text = last.data.message.content
                .filter(block => block.type === 'text')
                .map(block => block.text)
                .join('');
            if (text === '')
                return { kind: 'error', text: 'last assistant message has no text' };
            if (process.stdout.isTTY !== true)
                return { kind: 'error', text: 'clipboard needs a TTY (OSC 52)' };
            process.stdout.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
            return { kind: 'success', text: 'copied last assistant message' };
        },
    });
    commands.register({
        name: 'export',
        description: 'Export this session log (JSONL by default, `md` for a readable transcript)',
        input: { hint: '[md|<path>]' },
        handler: async (invocation) => {
            const liveAgent = runner.liveAgent;
            const persistence = ctx.get('sessionPersistence');
            if (persistence === undefined)
                return { kind: 'error', text: 'session persistence unavailable' };
            const arg = invocation.rawInput.trim();
            const shortId = liveAgent.session.id.replace(/^session-/, '').slice(0, 8);
            const markdown = arg === 'md';
            const target = arg !== '' && !markdown
                ? arg
                : join(cwd, markdown ? `dsh-session-${shortId}.md` : `dsh-session-${shortId}.jsonl`);
            try {
                if (markdown) {
                    writeFileSync(target, renderTranscriptMarkdown(liveAgent.session));
                    return { kind: 'success', text: `exported markdown transcript to ${target}` };
                }
                // The raw artifact is the backend's verbatim JSONL (decoded from
                // its physical encoding) — a faithful, portable session log.
                const raw = await persistence.readRaw(liveAgent.session.id);
                if (raw === undefined)
                    return { kind: 'error', text: 'no materialized session log to export' };
                writeFileSync(target, raw.content);
                return { kind: 'success', text: `exported ${raw.filename} to ${target}` };
            }
            catch (error) {
                return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
            }
        },
    });
    commands.register({
        name: 'fork',
        description: 'Fork this session at the last completed turn',
        handler: async () => {
            const liveAgent = runner.liveAgent;
            const seed = forkSeed(liveAgent.session.events);
            if (seed === undefined)
                return { kind: 'error', text: 'no completed turn to fork from' };
            // The child inherits the parent's recorded preset (official fork
            // semantics: forkComposition = composeAgent(resolveSessionPreset(source))).
            const composition = await runner.compose(resolveSessionPreset(liveAgent.session));
            const presetId = composition.agentPreset;
            const next = await runner.agents.create({
                sessionId: SessionId(`session-${randomUUID()}`),
                meta: { ...metaOf(cwd, presetId), parentSession: liveAgent.session.id, seedLength: seed.length },
                agentOptions: { provider: liveAgent.options.provider, model: liveAgent.options.model },
                setup: composition.setup,
                seed,
            });
            const error = await runner.swapTo(next);
            if (error !== undefined)
                app.notify(error);
            return { kind: 'success', text: `forked as ${next.agent.session.id}` };
        },
    });
    commands.register({
        name: 'status',
        description: 'Show session stats and identity',
        handler: () => {
            const liveAgent = runner.liveAgent;
            const stats = computeStats(liveAgent.session.events);
            let contextTokens;
            const meter = ctx.get('tokenMeter');
            if (meter !== undefined) {
                try {
                    contextTokens = meter.measure(liveAgent.session).totalTokens;
                }
                catch {
                    // Measurement is best-effort; the panel falls back to unmeasured.
                }
            }
            app.openSettings([
                {
                    id: 'session-id',
                    label: color.textDim('Session'),
                    description: color.textDim(liveAgent.session.id),
                    currentValue: color.textDim(displaySessionId(liveAgent.session.id)),
                },
                { id: 'session-stats', label: 'Stats', description: formatStats(stats), currentValue: '' },
                {
                    id: 'session-context',
                    label: 'Context',
                    description: contextTokens === undefined ? 'unmeasured' : `${Math.round(contextTokens / 1000)}k tokens in window`,
                    currentValue: '',
                },
            ], () => { }, () => { });
            return { kind: 'success' };
        },
    });
    commands.register({
        name: 'login',
        description: 'Set an API key credential for a provider (default DEEPSEEK_API_KEY)',
        input: { hint: '[<env-var>]' },
        handler: async (invocation) => {
            const credentials = ctx.get('credentials');
            if (credentials === undefined)
                return { kind: 'error', text: 'credentials service unavailable' };
            const ref = (invocation.rawInput.trim() || 'DEEPSEEK_API_KEY').toUpperCase();
            try {
                const answers = await app.askQuestions([
                    { id: 'key', question: `Paste the API key for ${ref}:` },
                ]);
                const key = answers[0]?.custom ?? '';
                if (key === '')
                    return { kind: 'error', text: 'empty key; nothing set' };
                await credentials.set(ref, key);
                return { kind: 'success', text: `${ref} set` };
            }
            catch {
                return { kind: 'error', text: 'login cancelled' };
            }
        },
    });
    commands.register({
        name: 'logout',
        description: 'Clear a stored API key credential (default DEEPSEEK_API_KEY)',
        input: { hint: '[<env-var>]' },
        handler: async (invocation) => {
            const credentials = ctx.get('credentials');
            if (credentials === undefined)
                return { kind: 'error', text: 'credentials service unavailable' };
            const ref = (invocation.rawInput.trim() || 'DEEPSEEK_API_KEY').toUpperCase();
            await credentials.unset(ref);
            return { kind: 'success', text: `${ref} cleared` };
        },
    });
    commands.register({
        name: 'help',
        description: 'Show keybindings and available commands',
        handler: () => {
            const rows = [{ id: 'k-enter', label: 'Enter', description: 'Submit (slash commands dispatch without a model turn)', currentValue: '' },
                { id: 'k-exit', label: 'Ctrl+C / Ctrl+D', description: 'Quit the TUI (flushes the session)', currentValue: '' },
                { id: 'k-cancel', label: 'Double-Esc', description: 'Cancel the active turn / tool / shell command', currentValue: '' },
                { id: 'k-fold', label: 'Ctrl+O', description: 'Expand/collapse recent tool output and thinking', currentValue: '' },
                { id: 'k-todo', label: 'Ctrl+T', description: 'Toggle the todo panel', currentValue: '' },
                { id: 'k-think', label: 'Alt+T', description: 'Hide/show thinking blocks', currentValue: '' },
                { id: 'k-steer', label: 'Ctrl+S', description: 'Steer the running turn with the draft', currentValue: '' },
                { id: 'k-editor', label: 'Ctrl+G', description: 'Edit the draft in $VISUAL/$EDITOR', currentValue: '' },
                { id: 'k-full', label: 'Ctrl+F', description: 'Toggle fullscreen (alt screen)', currentValue: '' },
                { id: 'k-tab', label: 'Tab', description: 'Autocomplete slash commands and file paths', currentValue: '' },
                { id: 'k-hist', label: '↑/↓', description: 'Recall input history on an empty line', currentValue: '' },
                { id: 'k-bang', label: '! cmd', description: 'Run a shell command locally; !! sends it to the model', currentValue: '' },
                { id: 'sep-help', label: color.border('─'.repeat(34)), currentValue: '' },
                ...commands.list(runner.liveAgent).map(command => ({
                    id: `cmd-${command.name}`,
                    label: `/${command.name}`,
                    description: command.description,
                    currentValue: '',
                })),
            ];
            app.openSettings(rows, () => { }, () => { });
            return { kind: 'success' };
        },
    });
    // All TUI commands are registered now; include them in completion.
    refreshCompletions();
}
