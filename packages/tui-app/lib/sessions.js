/**
 * Session-picker support for `/sessions`: pure row assembly and title
 * loading. The row model mirrors the kimicode web session rail — a short id,
 * a relative age, an optional title, and a workspace group — rendered as one
 * line per session in the TUI picker.
 * @module @dsh-pi-tui/tui-app/sessions
 */
import { SessionId } from '@deepseek-ai/dsh-session';
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title';
/** How many most-recent sessions the picker shows at once (older rows still
 * appear, but only this many get background title reads). */
export const MAX_PICKER_SESSIONS = 200;
/** Strip the `session-` prefix and keep the first 8 characters, like the
 * kimicode card's short id. */
export function shortSessionId(id) {
    return id.replace(/^session[-_]/i, '').slice(0, 8);
}
/** kimicode-style workspace key: the last two path segments, or a placeholder. */
export function workspaceKey(cwd) {
    if (cwd === undefined || cwd === '')
        return '(no workspace)';
    return cwd.split('/').slice(-2).join('/');
}
/** Compact relative age of a session ("now", "2m", "3h", "5d", "3mo", "1y"). */
export function formatSessionAge(createdAt, now = Date.now()) {
    const diff = now - createdAt;
    if (diff < 0)
        return 'now';
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60)
        return 'now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 30)
        return `${days}d`;
    const months = Math.floor(days / 30);
    if (months < 12)
        return `${months}mo`;
    return `${Math.floor(months / 12)}y`;
}
/** Assemble one session row for the picker, marking the current session. */
export function sessionPickerItem(row, currentId) {
    const marker = row.id === currentId ? '● ' : '';
    const meta = [shortSessionId(row.id), formatSessionAge(row.createdAt)];
    if (row.origin === 'subagent')
        meta.push('sub');
    if (row.parentSession !== undefined)
        meta.push('fork');
    if (row.preset !== undefined)
        meta.push(`preset:${row.preset}`);
    if (row.live)
        meta.push('live');
    return {
        value: row.id,
        label: `${marker}${row.title ?? shortSessionId(row.id)}`,
        description: meta.join(' · '),
        group: workspaceKey(row.cwd),
    };
}
/** Map a persistence header onto the picker row shape. */
export function headerToPickerRow(header, live) {
    return {
        id: header.id,
        createdAt: header.createdAt,
        cwd: header.cwd,
        preset: header.agentPreset,
        parentSession: header.parentSession,
        origin: header.origin,
        live,
    };
}
/**
 * Load the latest titles for a batch of sessions, newest-first order
 * preserved. Prefers the session-query engine's batch observation (one
 * cancellable corpus read, failures isolated per session); falls back to
 * bounded sequential persistence inspections folded with `foldSessionTitle`
 * when the engine is absent. Never throws for per-session failures.
 * @param query - the mounted session-query engine, when present.
 * @param persistence - the persistence backend for the fallback path.
 * @param ids - session ids to title, in display order.
 * @param signal - optional cancellation for the whole batch.
 * @returns title text by session id; absent ids simply have no entry.
 */
export async function loadSessionTitles(query, persistence, ids, signal) {
    const titles = new Map();
    if (query !== undefined) {
        const results = await query.readTitleSnapshots(ids.map(id => SessionId(id)), signal);
        for (const result of results) {
            if (result.status === 'fulfilled' && result.value.title !== undefined) {
                titles.set(result.sessionId, result.value.title.title);
            }
        }
        return titles;
    }
    if (persistence === undefined)
        return titles;
    // Fallback: sequential bounded inspections; one failing session must not
    // starve the rest, so every worker catches per-session failures.
    const queue = [...ids];
    const workers = Array.from({ length: 4 }, async () => {
        for (;;) {
            const id = queue.shift();
            if (id === undefined)
                return;
            try {
                const inspection = await persistence.inspect(SessionId(id), signal);
                const title = foldSessionTitle(inspection.events);
                if (title !== undefined)
                    titles.set(id, title.title);
            }
            catch {
                // Isolated failure: the row stays untitled.
            }
        }
    });
    await Promise.all(workers);
    return titles;
}
