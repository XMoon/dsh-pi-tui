/**
 * Transcript folding: session events → renderable message list. Pure and
 * deterministic so the headless tests can drive it without a dsh tree.
 * Renders the HUMAN transcript (append-origin events), not the model-visible
 * surface: replacement copies shadowed by compaction stay out.
 *
 * Thinking (`reasoning-delta` chunks) and tool calls fold into collapsible
 * entries carrying their owning turn, so the view can expand only the most
 * recent turns (pi's Ctrl+O semantics).
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
 * Fold a session event log into the transcript messages, in log order.
 * `assistant/chunk` text deltas accumulate into the assistant message of
 * their own (turn, step); `reasoning-delta` chunks accumulate into a
 * thinking entry. A tool call and its result merge into one card; an
 * unanswered call stays `running`.
 * @param events - the session log.
 * @returns ordered renderable messages.
 */
export function foldTranscript(events) {
    const messages = [];
    /** Streaming text per (turn, step); an assistant message for that step is the same slot. */
    const stepText = new Map();
    /** Streaming reasoning per (turn, step), folded into one thinking entry. */
    const stepReasoning = new Map();
    const seenReasoning = new Set();
    const seenSteps = new Set();
    /** Tool calls awaiting their result, keyed by callId. */
    const pendingCalls = new Map();
    /** Tool names by callId, for result pairing. */
    const callNames = new Map();
    /** Command names by commandId, from command/run events. */
    const commandNames = new Map();
    /** The turn most recently opened by turn/start. */
    let currentTurn = 0;
    /** The thinking entry for one (turn, step), created on first reasoning. */
    const thinkingEntry = (turn, step) => {
        const key = stepKey(turn, step);
        if (!seenReasoning.has(key)) {
            seenReasoning.add(key);
            const entry = { kind: 'thinking', turn, text: '' };
            messages.push(entry);
            return entry;
        }
        return messages.findLast(message => message.kind === 'thinking');
    };
    for (const event of events) {
        switch (event.type) {
            case 'turn/start': {
                currentTurn = event.data.turn;
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
                    messages.push({ kind: 'user', text });
                }
                else {
                    messages.push({ kind: 'system', turn: currentTurn, text });
                }
                break;
            }
            case 'assistant/chunk': {
                const { chunk } = event.data;
                const key = stepKey(event.data.turn, event.data.step);
                if (chunk.type === 'text-delta') {
                    const accumulated = stepText.get(key) ?? '';
                    const next = accumulated + chunk.text;
                    stepText.set(key, next);
                    if (!seenSteps.has(key)) {
                        seenSteps.add(key);
                        messages.push({ kind: 'assistant', text: next });
                    }
                    else {
                        const last = messages.at(-1);
                        if (last?.kind === 'assistant')
                            last.text = next;
                    }
                }
                else if (chunk.type === 'reasoning-delta') {
                    const accumulated = stepReasoning.get(key) ?? '';
                    const next = accumulated + chunk.text;
                    stepReasoning.set(key, next);
                    const entry = thinkingEntry(event.data.turn, event.data.step);
                    if (entry !== undefined)
                        entry.text = next;
                }
                break;
            }
            case 'assistant/message': {
                const key = stepKey(event.data.turn, event.data.step);
                const text = textOf(event.data.message.content);
                stepText.set(key, text);
                const last = messages.at(-1);
                if (last?.kind === 'assistant' && seenSteps.has(key)) {
                    last.text = text;
                }
                else {
                    seenSteps.add(key);
                    if (text !== '')
                        messages.push({ kind: 'assistant', text });
                }
                break;
            }
            case 'tool/call': {
                const key = event.data.callId;
                callNames.set(key, event.data.name);
                pendingCalls.set(key, {
                    name: event.data.name,
                    args: event.data.arguments,
                    turn: currentTurn,
                });
                messages.push({
                    kind: 'tool',
                    turn: currentTurn,
                    name: event.data.name,
                    args: event.data.arguments,
                    result: '',
                    status: 'running',
                });
                break;
            }
            case 'tool/result': {
                const key = event.data.message.content[0]?.toolCallId;
                const pending = key !== undefined ? pendingCalls.get(key) : undefined;
                const name = key === undefined ? 'tool' : (callNames.get(key) ?? 'tool');
                const text = textOf(event.data.message.content[0]?.content ?? []);
                const status = event.data.error !== undefined ? 'error' : 'ok';
                const turn = pending?.turn ?? currentTurn;
                pendingCalls.delete(key ?? '');
                // Replace the running entry for this call, or append a completed one.
                const running = messages.findLast(message => message.kind === 'tool' && message.name === name && message.status === 'running');
                if (running !== undefined && running.kind === 'tool') {
                    running.status = status;
                    running.result = text;
                    running.args = pending?.args ?? '';
                    running.turn = turn;
                }
                else {
                    messages.push({ kind: 'tool', turn, name, args: pending?.args ?? '', result: text, status });
                }
                break;
            }
            case 'turn/end': {
                if (event.data.reason.kind === 'error') {
                    const error = event.data.reason.error;
                    messages.push({ kind: 'tool', turn: currentTurn, name: 'error', args: '', result: `${error.code}: ${error.message}`, status: 'error' });
                }
                else if (event.data.reason.kind === 'aborted') {
                    messages.push({ kind: 'tool', turn: currentTurn, name: 'interrupted', args: '', result: 'cancelled by user', status: 'error' });
                }
                break;
            }
            case 'command/run': {
                commandNames.set(event.data.commandId, event.data.name);
                break;
            }
            case 'command/done': {
                const name = commandNames.get(event.data.commandId) ?? 'command';
                const outcome = event.data.kind === 'error' ? ` — error: ${event.data.text ?? 'failed'}` : '';
                messages.push({ kind: 'tool', turn: currentTurn, name: `/${name}`, args: '', result: `executed${outcome}`, status: event.data.kind === 'error' ? 'error' : 'ok' });
                break;
            }
            default:
                break;
        }
    }
    return messages;
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
