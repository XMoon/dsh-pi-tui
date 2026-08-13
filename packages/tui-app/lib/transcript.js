/**
 * Transcript folding: session events → renderable message list. Pure and
 * deterministic so the headless tests can drive it without a dsh tree.
 * Renders the HUMAN transcript (append-origin events), not the model-visible
 * surface: replacement copies shadowed by compaction stay out.
 * @module @dsh-pi-tui/tui-app/transcript
 */
/** Text of a message's content blocks, joined; empty when there is no text. */
function textOf(blocks) {
    return blocks
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');
}
/** Single-line summary of a tool result, capped for the transcript. */
function summarizeResult(text) {
    const single = text.replace(/\s+/g, ' ').trim();
    return single.length > 200 ? `${single.slice(0, 200)}…` : single;
}
/**
 * Fold a session event log into the transcript messages, in log order.
 * `assistant/chunk` text deltas accumulate into the message of their own
 * (turn, step); an `assistant/message` replaces the accumulated chunk text
 * for that step (identical content, now complete).
 * @param events - the session log.
 * @returns ordered renderable messages.
 */
export function foldTranscript(events) {
    const messages = [];
    /** Streaming text per (turn, step); an assistant message for that step is the same slot. */
    const stepText = new Map();
    /** Tool names by callId, from tool/call events. */
    const callNames = new Map();
    /** Command names by commandId, from command/run events. */
    const commandNames = new Map();
    const seenSteps = new Set();
    const stepKey = (turn, step) => `${turn}/${step}`;
    for (const event of events) {
        switch (event.type) {
            case 'user/message': {
                const text = textOf(event.data.content);
                if (text !== '')
                    messages.push({ kind: 'user', text });
                break;
            }
            case 'assistant/chunk': {
                if (event.data.chunk.type !== 'text-delta')
                    break;
                const key = stepKey(event.data.turn, event.data.step);
                const accumulated = stepText.get(key) ?? '';
                const next = accumulated + event.data.chunk.text;
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
                callNames.set(event.data.callId, event.data.name);
                break;
            }
            case 'tool/result': {
                const toolCallId = event.data.message.content[0]?.toolCallId;
                const name = toolCallId === undefined ? 'tool' : (callNames.get(toolCallId) ?? 'tool');
                const text = textOf(event.data.message.content[0]?.content ?? []);
                const summary = summarizeResult(text);
                messages.push({ kind: 'tool', name, text: summary === '' ? '(no text result)' : summary });
                break;
            }
            case 'turn/end': {
                if (event.data.reason.kind === 'error') {
                    const error = event.data.reason.error;
                    messages.push({ kind: 'tool', name: 'error', text: `${error.code}: ${error.message}` });
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
                messages.push({ kind: 'tool', name: `/${name}`, text: `executed${outcome}` });
                break;
            }
            default:
                break;
        }
    }
    return messages;
}
/** Render the transcript as one Markdown document for the TUI's Markdown view. */
export function renderTranscript(messages) {
    const lines = [];
    for (const message of messages) {
        if (message.kind === 'user') {
            lines.push(`**You:** ${message.text}`, '');
        }
        else if (message.kind === 'assistant') {
            lines.push(message.text, '');
        }
        else {
            lines.push(`> \`${message.name}\` — ${message.text}`, '');
        }
    }
    return lines.join('\n');
}
