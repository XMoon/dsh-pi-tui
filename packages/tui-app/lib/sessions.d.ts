/**
 * Session-picker support for `/sessions`: pure row assembly and title
 * loading. The row model mirrors the kimicode web session rail — a short id,
 * a relative age, an optional title, and a workspace group — rendered as one
 * line per session in the TUI picker.
 * @module @dsh-pi-tui/tui-app/sessions
 */
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
/** How many most-recent sessions the picker shows at once (older rows still
 * appear, but only this many get background title reads). */
export declare const MAX_PICKER_SESSIONS = 200;
/**
 * The narrow session-query surface the picker uses. Declared structurally
 * instead of imported from `@deepseek-ai/dsh-session-query`: the dev-loop
 * symlink for that package resolves from the dsh install's own node_modules,
 * and pulling its type graph into the program introduces a second physical
 * copy of `dsh-session` that shadows the `session/title` event-map
 * augmentation. The service itself is read off the live context at runtime,
 * so no import is needed for types either.
 */
export interface SessionQueryLike {
    listSessions(signal?: AbortSignal): Promise<Array<{
        header: SessionHeader;
        live: boolean;
    }>>;
    readTitleSnapshots(ids: readonly SessionId[], signal?: AbortSignal): Promise<Array<SessionTitleObservationResultLike>>;
}
/** One per-session result of a batch title observation (discriminated on
 * `status`, mirroring the real engine's result union). */
export type SessionTitleObservationResultLike = {
    sessionId: string;
    status: 'fulfilled';
    value: {
        session?: unknown;
        title?: {
            title: string;
        };
    };
} | {
    sessionId: string;
    status: 'rejected';
    reason?: unknown;
};
/** The persistence surface the fallback title path needs. */
export interface SessionPickerPersistence {
    inspect(id: SessionId, signal?: AbortSignal): Promise<{
        events: readonly SessionEvent[];
    }>;
}
/** Strip the `session-` prefix and keep the first 8 characters, like the
 * kimicode card's short id. */
export declare function shortSessionId(id: string): string;
/** kimicode-style workspace key: the last two path segments, or a placeholder. */
export declare function workspaceKey(cwd: string | undefined): string;
/** Compact relative age of a session ("now", "2m", "3h", "5d", "3mo", "1y"). */
export declare function formatSessionAge(createdAt: number, now?: number): string;
/** One session as the picker renders it. */
export interface SessionPickerRow {
    /** Full session id (the picker's value). */
    id: string;
    /** Creation epoch-ms, for the relative age. */
    createdAt: number;
    /** Latest session title, absent until the background title read lands. */
    title?: string;
    /** Absolute working directory, for the workspace group. */
    cwd?: string;
    /** Agent preset id the session runs on, when the deployment composes one. */
    preset?: string;
    /** The session this one was forked from, when it has lineage. */
    parentSession?: string;
    /** Subagent children carry the `sub` marker. */
    origin?: 'subagent';
    /** Whether the session is currently loaded in the session store. */
    live: boolean;
}
/** One picker row: value is the session id, group drives the workspace headers. */
export interface SessionPickerItem {
    value: string;
    label: string;
    description: string;
    group: string;
}
/** Assemble one session row for the picker, marking the current session. */
export declare function sessionPickerItem(row: SessionPickerRow, currentId: string): SessionPickerItem;
/** Map a persistence header onto the picker row shape. */
export declare function headerToPickerRow(header: SessionHeader, live: boolean): SessionPickerRow;
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
export declare function loadSessionTitles(query: SessionQueryLike | undefined, persistence: SessionPickerPersistence | undefined, ids: readonly string[], signal?: AbortSignal): Promise<Map<string, string>>;
