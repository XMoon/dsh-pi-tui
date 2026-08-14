/**
 * Transcript folding: session events → renderable message list. Pure and
 * deterministic so the headless tests can drive it without a dsh tree.
 * Renders the HUMAN transcript (append-origin events), not the model-visible
 * surface: replacement copies shadowed by compaction stay out.
 *
 * Thinking (`reasoning-delta` chunks) and tool calls fold into collapsible
 * entries carrying their owning turn, so the view can expand only the most
 * recent turns (pi's Ctrl+O semantics).
 *
 * `TranscriptFolder` is the stateful engine: call `apply` with appended
 * events and read the message list; `foldTranscript` is the one-shot
 * wrapper. Both support an optional display window (`maxTurns`): turns older
 * than the window collapse into one summary entry, bounding the rendered
 * component tree on long sessions.
 * @module @dsh-pi-tui/tui-app/transcript
 */
/** Text of a message's content blocks, joined; empty when there is no text. */
function textOf(blocks) {
    return blocks
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');
}
/** Key identifying one step's model output (turn + step). */
function stepKey(turn, step) {
    return `${turn}/${step}`;
}
/**
 * The turn threshold at or above which entries survive a display window.
 * Zero means every turn fits.
 * @param messages - the folded transcript.
 * @param maxTurns - window size in turns.
 * @returns the oldest surviving turn number, or 0 when nothing is windowed.
 */
function turnBoundary(messages, maxTurns) {
    const turns = new Set();
    for (const message of messages) {
        if ('turn' in message)
            turns.add(message.turn);
    }
    const sorted = [...turns].sort((a, b) => b - a);
    if (sorted.length <= maxTurns)
        return 0;
    return sorted[maxTurns - 1] ?? 0;
}
/**
 * Collapse turns older than the display window into one leading summary
 * entry with aggregate counts. Entries at/after the boundary survive; the
 * result is a fresh array when anything collapses.
 * @param messages - the folded transcript.
 * @param maxTurns - window size in turns; entries of older turns collapse.
 * @returns the windowed transcript.
 */
export function windowMessages(messages, maxTurns) {
    if (maxTurns <= 0)
        return [...messages];
    const boundary = turnBoundary(messages, maxTurns);
    if (boundary === 0)
        return [...messages];
    const oldTurns = new Set();
    const kept = [];
    let oldTools = 0;
    let oldCount = 0;
    for (const message of messages) {
        if ('turn' in message && message.turn < boundary) {
            oldCount += 1;
            if (message.kind === 'tool')
                oldTools += 1;
            oldTurns.add(message.turn);
            continue;
        }
        kept.push(message);
    }
    if (oldCount === 0)
        return [...messages];
    const turnsText = `${oldTurns.size} earlier turn${oldTurns.size === 1 ? '' : 's'}`;
    const toolsText = `${oldTools} tool call${oldTools === 1 ? '' : 's'}`;
    kept.unshift({ kind: 'summary', text: `… ${turnsText} · ${toolsText} — window ${maxTurns} turns` });
    return kept;
}
/**
 * Merge consecutive completed `read` tool cards into one card ("N files").
 * A single read stays untouched; groups break on any other kind or status.
 * @param messages - the folded transcript.
 * @returns a new list with grouped read cards (same object references).
 */
export function groupConsecutiveReads(messages) {
    const out = [];
    let group;
    let count = 0;
    for (const message of messages) {
        if (message.kind === 'tool' && message.name === 'read' && message.status === 'ok') {
            if (group !== undefined) {
                count += 1;
                group.args = `${count} files`;
                group.result = group.result === '' ? message.result : `${group.result}\n\n${message.result}`;
                group.turn = Math.max(group.turn, message.turn);
                continue;
            }
            group = { ...message };
            count = 1;
            out.push(group);
            continue;
        }
        group = undefined;
        out.push(message);
    }
    return out;
}
/**
 * Stateful transcript folding: apply appended events incrementally and read
 * the message list. Objects are mutated in place across applies, so a caller
 * that rebuilds its view from `messages()` stays consistent at every step.
 */
export class TranscriptFolder {
    items = [];
    /** Streaming text per (turn, step); an assistant message for that step is the same slot. */
    stepText = new Map();
    /** Streaming reasoning per (turn, step), folded into one thinking entry. */
    stepReasoning = new Map();
    /** The assistant message object per (turn, step), for in-place text updates. */
    assistantEntries = new Map();
    /** The thinking entry object per (turn, step), for in-place text updates. */
    thinkingEntries = new Map();
    /** Tool calls awaiting their result, keyed by callId with their running card. */
    pendingCalls = new Map();
    /** Tool names by callId, for result pairing. */
    callNames = new Map();
    /** Command names by commandId, from command/run events. */
    commandNames = new Map();
    /** Workflow run cards by runId, for member/run settlement. */
    workflowRuns = new Map();
    /** Workflow member cards by `${runId}/${seq}`, for agent-end settlement. */
    workflowMembers = new Map();
    /** The turn most recently opened by turn/start. */
    currentTurn = 0;
    /**
     * Apply appended events in log order. Safe to call repeatedly with new
     * suffixes of the log.
     * @param events - the appended session events.
     */
    apply(events) {
        for (const event of events)
            this.applyEvent(event);
    }
    /**
     * The folded messages. Without options this is the full transcript; with
     * `maxTurns` older turns collapse into one summary entry (fresh array).
     * @param options - optional display window.
     * @returns the renderable message list.
     */
    messages(options) {
        const grouped = groupConsecutiveReads(this.items);
        const maxTurns = options?.maxTurns;
        if (maxTurns === undefined || maxTurns <= 0)
            return grouped;
        return windowMessages(grouped, maxTurns);
    }
    /** The thinking entry object for one (turn, step), created on first reasoning. */
    thinkingEntry(turn, step) {
        const key = stepKey(turn, step);
        let entry = this.thinkingEntries.get(key);
        if (entry === undefined) {
            entry = { kind: 'thinking', turn, text: '' };
            this.thinkingEntries.set(key, entry);
            this.items.push(entry);
        }
        return entry;
    }
    applyEvent(event) {
        switch (event.type) {
            case 'turn/start': {
                this.currentTurn = event.data.turn;
                break;
            }
            case 'user/message': {
                const text = textOf(event.data.content);
                if (text === '')
                    break;
                // Only direct human prompts are user messages; plugin-injected
                // context (system reminders, skill content) folds into a collapsible
                // system entry.
                if (event.data.source.kind === 'user') {
                    this.items.push({ kind: 'user', turn: this.currentTurn, text });
                }
                else {
                    this.items.push({ kind: 'system', turn: this.currentTurn, text });
                }
                break;
            }
            case 'assistant/chunk': {
                const { chunk } = event.data;
                const key = stepKey(event.data.turn, event.data.step);
                if (chunk.type === 'text-delta') {
                    const accumulated = this.stepText.get(key) ?? '';
                    const next = accumulated + chunk.text;
                    this.stepText.set(key, next);
                    let entry = this.assistantEntries.get(key);
                    if (entry === undefined) {
                        entry = { kind: 'assistant', turn: event.data.turn, text: next };
                        this.assistantEntries.set(key, entry);
                        this.items.push(entry);
                    }
                    else {
                        entry.text = next;
                    }
                }
                else if (chunk.type === 'reasoning-delta') {
                    const accumulated = this.stepReasoning.get(key) ?? '';
                    const next = accumulated + chunk.text;
                    this.stepReasoning.set(key, next);
                    const entry = this.thinkingEntry(event.data.turn, event.data.step);
                    entry.text = next;
                }
                break;
            }
            case 'assistant/message': {
                const key = stepKey(event.data.turn, event.data.step);
                const text = textOf(event.data.message.content);
                this.stepText.set(key, text);
                const entry = this.assistantEntries.get(key);
                if (entry !== undefined) {
                    entry.text = text;
                }
                else if (text !== '') {
                    const created = { kind: 'assistant', turn: event.data.turn, text };
                    this.assistantEntries.set(key, created);
                    this.items.push(created);
                }
                break;
            }
            case 'tool/call': {
                const key = event.data.callId;
                this.callNames.set(key, event.data.name);
                const card = {
                    kind: 'tool',
                    turn: this.currentTurn,
                    name: event.data.name,
                    args: event.data.arguments,
                    result: '',
                    status: 'running',
                };
                this.pendingCalls.set(key, {
                    name: event.data.name,
                    args: event.data.arguments,
                    turn: this.currentTurn,
                    card,
                });
                this.items.push(card);
                break;
            }
            case 'tool/result': {
                const block = event.data.message.content[0];
                const key = block?.toolCallId;
                const pending = key !== undefined ? this.pendingCalls.get(key) : undefined;
                const name = key === undefined ? 'tool' : (this.callNames.get(key) ?? 'tool');
                const text = textOf(block?.content ?? []);
                const status = event.data.error !== undefined || block?.isError === true ? 'error' : 'ok';
                const turn = pending?.turn ?? this.currentTurn;
                this.pendingCalls.delete(key ?? '');
                if (pending !== undefined) {
                    // The call's own running card: parallel same-name calls pair
                    // correctly because the card is keyed by callId, not by name.
                    const card = pending.card;
                    card.status = status;
                    card.result = text;
                    card.args = pending.args;
                    card.turn = turn;
                }
                else {
                    // Unknown call (e.g. post-compaction): fall back to the last
                    // running card with this name, or append a completed one.
                    const running = this.items.findLast(message => message.kind === 'tool' && message.name === name && message.status === 'running');
                    if (running !== undefined && running.kind === 'tool') {
                        running.status = status;
                        running.result = text;
                        running.args = '';
                        running.turn = turn;
                    }
                    else {
                        this.items.push({ kind: 'tool', turn, name, args: '', result: text, status });
                    }
                }
                break;
            }
            case 'turn/end': {
                if (event.data.reason.kind === 'error') {
                    const error = event.data.reason.error;
                    this.items.push({ kind: 'tool', turn: this.currentTurn, name: 'error', args: '', result: `${error.code}: ${error.message}`, status: 'error' });
                }
                else if (event.data.reason.kind === 'aborted') {
                    this.items.push({ kind: 'tool', turn: this.currentTurn, name: 'interrupted', args: '', result: 'cancelled by user', status: 'error' });
                }
                else if (event.data.reason.kind === 'max-tokens') {
                    this.items.push({ kind: 'system', turn: this.currentTurn, text: 'max tokens reached — output truncated' });
                }
                break;
            }
            case 'tool-workflow/run-start': {
                const card = {
                    kind: 'tool',
                    turn: this.currentTurn,
                    name: 'workflow',
                    args: event.data.name,
                    result: '',
                    status: 'running',
                };
                this.workflowRuns.set(event.data.runId, card);
                this.items.push(card);
                break;
            }
            case 'tool-workflow/agent-start': {
                const { runId, seq, label, phase } = event.data;
                const card = {
                    kind: 'tool',
                    turn: this.currentTurn,
                    name: 'workflow-member',
                    args: label,
                    result: phase ?? '',
                    status: 'running',
                };
                this.workflowMembers.set(`${runId}/${seq}`, card);
                this.items.push(card);
                break;
            }
            case 'tool-workflow/agent-end': {
                const card = this.workflowMembers.get(`${event.data.runId}/${event.data.seq}`);
                const outcome = event.data.outcome;
                if (card !== undefined) {
                    card.status = outcome === 'completed' ? 'ok' : 'error';
                    card.result = outcome === 'completed' ? 'completed' : `outcome: ${outcome}`;
                }
                break;
            }
            case 'tool-workflow/run-end': {
                const card = this.workflowRuns.get(event.data.runId);
                if (card !== undefined) {
                    card.status = event.data.stopReason === 'completed' ? 'ok' : 'error';
                    card.result = `stop: ${event.data.stopReason}`;
                }
                break;
            }
            case 'llm/retry': {
                const { retry, delayMs, failure } = event.data;
                const maxRetries = 'maxRetries' in event.data ? event.data.maxRetries : undefined;
                const label = maxRetries === undefined
                    ? `llm retry ${retry} in ${Math.round(delayMs / 1000)}s`
                    : `llm retry ${retry + 1}/${maxRetries} in ${Math.round(delayMs / 1000)}s`;
                this.items.push({ kind: 'system', turn: this.currentTurn, text: `${label} — ${failure.code}: ${failure.message}` });
                break;
            }
            case 'command/run': {
                this.commandNames.set(event.data.commandId, event.data.name);
                break;
            }
            case 'command/done': {
                const name = this.commandNames.get(event.data.commandId) ?? 'command';
                // Success text (e.g. "title set: x") carries the command's settlement
                // message; errors prefix it with the failure marker.
                const outcome = event.data.kind === 'error'
                    ? ` — error: ${event.data.text ?? 'failed'}`
                    : event.data.text === undefined || event.data.text === ''
                        ? ''
                        : ` — ${event.data.text}`;
                this.items.push({ kind: 'tool', turn: this.currentTurn, name: `/${name}`, args: '', result: `executed${outcome}`, status: event.data.kind === 'error' ? 'error' : 'ok' });
                break;
            }
            case 'subagent/descriptor': {
                // Durable delegation record: one card per subagent launch.
                const { label, mode, provider } = event.data;
                const model = 'agentModel' in event.data ? event.data.agentModel : undefined;
                const result = [
                    mode !== undefined ? `mode: ${mode}` : '',
                    provider !== undefined ? `provider: ${provider}` : '',
                    model !== undefined ? `model: ${model}` : '',
                ].filter(part => part !== '').join(' · ');
                this.items.push({
                    kind: 'tool',
                    turn: this.currentTurn,
                    name: 'subagent',
                    args: label ?? 'subagent',
                    result,
                    status: 'ok',
                });
                break;
            }
            default:
                break;
        }
    }
}
/**
 * Fold a session event log into the transcript messages, in log order.
 * `assistant/chunk` text deltas accumulate into the assistant message of
 * their own (turn, step); `reasoning-delta` chunks accumulate into a
 * thinking entry. A tool call and its result merge into one card; an
 * unanswered call stays `running`.
 * @param events - the session log.
 * @param options - optional display window (older turns collapse).
 * @returns ordered renderable messages.
 */
export function foldTranscript(events, options) {
    const folder = new TranscriptFolder();
    folder.apply(events);
    return folder.messages(options);
}
/**
 * Render the transcript as one Markdown document for the TUI's Markdown view.
 * Collapsible entries render in their folded form (preview lines + hint);
 * use the component view for expandable rendering.
 * @param messages - the folded transcript.
 * @param expandedTurns - turns whose collapsible entries render expanded.
 * @returns the markdown document.
 */
export function renderTranscript(messages, expandedTurns = 0) {
    const lines = [];
    for (const message of messages) {
        if (message.kind === 'user') {
            lines.push(`**You:** ${message.text}`, '');
        }
        else if (message.kind === 'assistant') {
            lines.push(message.text, '');
        }
        else if (message.kind === 'thinking') {
            const expanded = message.turn >= currentTurnBoundary(messages, expandedTurns);
            if (expanded) {
                lines.push(`> _thinking:_ ${message.text}`, '');
            }
            else {
                lines.push(`> _thinking…_ (ctrl+o to expand)`, '');
            }
        }
        else if (message.kind === 'system') {
            const expanded = message.turn >= currentTurnBoundary(messages, expandedTurns);
            if (expanded) {
                lines.push(`> _system:_ ${message.text}`, '');
            }
            else {
                lines.push(`> _system…_ (ctrl+o to expand)`, '');
            }
        }
        else if (message.kind === 'summary') {
            lines.push(`> _${message.text}_`, '');
        }
        else {
            const mark = message.status === 'ok' ? '✓' : message.status === 'error' ? '✗' : '…';
            const expanded = message.turn >= currentTurnBoundary(messages, expandedTurns);
            if (expanded) {
                lines.push(`> \`${mark} ${message.name}\` ${message.result === '' ? '' : '— ' + message.result}`, '');
            }
            else {
                lines.push(`> \`${mark} ${message.name}\``, '');
            }
        }
    }
    return lines.join('\n');
}
/** The turn threshold for expansion: the `expandedTurns` most recent turns. */
function currentTurnBoundary(messages, expandedTurns) {
    if (expandedTurns <= 0)
        return Number.POSITIVE_INFINITY;
    const turns = new Set();
    for (const message of messages) {
        if (message.kind === 'thinking' || message.kind === 'system' || message.kind === 'tool')
            turns.add(message.turn);
    }
    const sorted = [...turns].sort((a, b) => b - a);
    if (sorted.length <= expandedTurns)
        return 0;
    return sorted[expandedTurns - 1] ?? 0;
}
