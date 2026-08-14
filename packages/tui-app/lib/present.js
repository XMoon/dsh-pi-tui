/**
 * Web-parity tool-card presentation for the TUI. The card header is the same
 * row model the Web derives in @deepseek-ai/dsh-client-ui-tool's tool-call
 * model (design titles per tool variant, SUMMARY_KEYS summaries, workspace-
 * relative paths), and the card body follows the tool-owned render intents
 * (presentCall/presentResult) exactly as the host apiproxy invokes them, so
 * a TUI card renders from the same source as a Web card. All pure: the
 * real tool registry is injected by the runner through toolPresenterFrom.
 * @module @dsh-pi-tui/tui-app/present
 */
/** Figma row titles per variant (design literals, not translatable copy). */
const VARIANT_TITLES = {
    search: 'Search',
    read: 'Read',
    bash: 'Bash',
    write: 'Write',
    edit: 'Edit',
    code: 'Code',
    others: 'Tool call',
};
/**
 * Known tool name -> variant (the Web's TOOL_VARIANTS; cordis_define is
 * deliberately absent there too - a keyed toolview replaces the generic row).
 */
const TOOL_VARIANTS = {
    bash: 'bash',
    pwsh: 'bash',
    read: 'read',
    web_fetch: 'read',
    web_search: 'search',
    grep: 'search',
    glob: 'search',
    write: 'write',
    edit: 'edit',
    run_code: 'code',
    cordis_package_inspect: 'read',
    cordis_runtime_inspect: 'read',
    cordis_run: 'others',
    cordis_stop: 'others',
    cordis_undefine: 'others',
};
/** Tool-owned titles that refine a generic row variant without replacing it. */
const TOOL_TITLES = {
    cordis_package_inspect: 'Inspect',
    cordis_runtime_inspect: 'Inspect',
    cordis_run: 'Run Cordis Plugin',
    cordis_stop: 'Stop Cordis Plugin',
    cordis_undefine: 'Remove Cordis Plugin',
    pwsh: 'Pwsh',
};
/**
 * TUI-local titles for synthetic cards the session log produces without a
 * registry definition (local `!` shell runs, workflow bookkeeping, failure
 * lines). Same refinement mechanism as TOOL_TITLES; without these the cards
 * would fall into the generic Tool call title and lose their identity.
 */
const TUI_TOOL_TITLES = {
    shell: 'Shell',
    subagent: 'Subagent',
    workflow: 'Workflow',
    'workflow-member': 'Workflow Agent',
    error: 'Error',
    interrupted: 'Interrupted',
};
/** Summary key preference per variant (args-derived). */
const SUMMARY_KEYS = {
    bash: ['description', 'command'],
    read: ['path', 'file_path', 'url'],
    search: ['query', 'pattern', 'url'],
    write: ['path', 'file_path'],
    edit: ['path', 'file_path'],
    code: ['description'],
    others: [],
};
/** The first line of a text (the Web's ReasoningRow summary for settled rows). */
export function firstLine(text) {
    const newline = text.indexOf('\n');
    return newline === -1 ? text : text.slice(0, newline);
}
/** The last line of a text (the Web's running-reasoning summary). */
export function latestLine(text) {
    const visible = text.trimEnd();
    const newline = visible.lastIndexOf('\n');
    return newline === -1 ? visible : visible.slice(newline + 1);
}
/**
 * Strip the workspace root from a workspace-rooted absolute path (display
 * only), exactly like the Web's relativizeToCwd: only the workspace-root
 * prefix is peeled, both `/` and `\` separators are handled, and a path
 * outside the root is returned unchanged.
 * @param text - the path to shorten.
 * @param cwd - session workspace root; absent or empty leaves the path unchanged.
 * @returns the path relative to the workspace root, or unchanged when it is not rooted there.
 */
export function relativizeToCwd(text, cwd) {
    if (cwd === undefined || cwd === '')
        return text;
    const root = cwd.replace(/[/\\]+$/, '');
    if (text.startsWith(root + '/') || text.startsWith(root + '\\'))
        return text.slice(root.length + 1);
    return text;
}
function parseArgs(argsRaw) {
    try {
        return JSON.parse(argsRaw);
    }
    catch {
        return undefined;
    }
}
function pickString(args, keys) {
    for (const key of keys) {
        const value = args[key];
        if (typeof value === 'string' && value !== '')
            return value;
    }
    return undefined;
}
/** The summary key preference for one row variant, falling back to the first
 * string arg value, then to the raw args text (Web deriveSummary). */
function deriveSummary(variant, argsRaw) {
    const parsed = parseArgs(argsRaw);
    if (typeof parsed !== 'object' || parsed === null)
        return firstLine(argsRaw);
    const args = parsed;
    const picked = pickString(args, SUMMARY_KEYS[variant] ?? []);
    if (picked !== undefined)
        return firstLine(picked);
    for (const value of Object.values(args)) {
        if (typeof value === 'string' && value !== '')
            return firstLine(value);
    }
    return firstLine(argsRaw);
}
/** Classify a tool name into its row variant; unknown names are `others`. */
export function classifyTool(name) {
    return TOOL_VARIANTS[name] ?? 'others';
}
/**
 * The Web row-model header for one tool card: title = tool-owned title or the
 * variant design title; summary = SUMMARY_KEYS-derived args summary relativized
 * to the workspace root. Unknown variants carry the tool name alongside the
 * summary (the Web's `toolName · base` rule), with the separator dropped when
 * there is no summary text. Slash-command names render without their slash.
 * @param name - the tool name.
 * @param argsRaw - the raw arguments JSON string ('' when absent).
 * @param cwd - workspace root for relativization; optional.
 */
export function toolCardHeader(name, argsRaw, cwd) {
    const variant = classifyTool(name);
    const toolTitle = TOOL_TITLES[name] ?? TUI_TOOL_TITLES[name];
    const base = argsRaw === '' ? '' : relativizeToCwd(deriveSummary(variant, argsRaw), cwd);
    const summary = variant === 'others' && toolTitle === undefined
        ? base === '' ? '' : name + ' · ' + base
        : base;
    const title = toolTitle ?? (name.startsWith('/') ? name.slice(1) : VARIANT_TITLES[variant]);
    return { title, summary };
}
/**
 * Build the presentation bridge over a tool-definition lookup (the runner
 * passes a scoped registry read, e.g. `ctx.get('tools')?.get(name, scope)`).
 * Mirrors the host apiproxy's presenter invocations: args are JSON-parsed and
 * the callbacks are guarded so a throwing tool presenter degrades to the
 * generic card. An absent registry yields no views, so the cards fall back to
 * the generic presentation instead of failing.
 * @param get - resolve one tool definition by name (scope already applied).
 */
export function toolPresenterFrom(get) {
    return {
        call(name, argsRaw) {
            const definition = get(name);
            if (definition?.presentCall === undefined)
                return undefined;
            const parsed = parseArgs(argsRaw);
            if (parsed === undefined)
                return undefined;
            try {
                return definition.presentCall(parsed);
            }
            catch {
                return undefined;
            }
        },
        result(name, argsRaw, result) {
            const definition = get(name);
            if (definition?.presentResult === undefined)
                return undefined;
            const parsed = parseArgs(argsRaw);
            if (parsed === undefined)
                return undefined;
            try {
                return definition.presentResult(parsed, {
                    content: [...result.content],
                    isError: result.isError,
                    ...result.meta === undefined ? {} : { meta: result.meta },
                });
            }
            catch {
                return undefined;
            }
        },
    };
}
