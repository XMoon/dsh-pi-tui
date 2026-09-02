/**
 * Notification preference parsing (plan: notification mode/method). The
 * persisted TUI settings document carries the raw strings; these pure
 * parsers are the single authority on the semantic values, failing safe
 * to the defaults on any missing/invalid input.
 *
 * The mode is a THREE-VALUE policy — `off` / `unfocused` / `always` —
 * deliberately NOT an `enabled` boolean plus a condition (that would
 * admit the meaningless `enabled=false + condition=always` combination).
 * The default is `unfocused`: the capability is ON, but a notification
 * fires only while the terminal is not focused.
 * @module @xmoon76/dsh-pi-tui/notification-settings
 */

/** When a settled main agent triggers a completion notification. */
export type NotificationMode = 'unfocused' | 'always' | 'off'

/** How the completion notification is delivered to the terminal. */
export type NotificationMethod = 'auto' | 'osc9' | 'osc777' | 'bell'

/** The default mode: notify only while the terminal is unfocused. */
export const DEFAULT_NOTIFICATION_MODE: NotificationMode = 'unfocused'

/** The default method: resolve from the terminal environment. */
export const DEFAULT_NOTIFICATION_METHOD: NotificationMethod = 'auto'

/** Parse a persisted mode string; anything invalid falls back to the
 * default (`unfocused`) — a corrupt document must never disable the
 * capability silently. */
export function parseNotificationMode(value: string | undefined): NotificationMode {
  if (value === 'always' || value === 'off') return value
  return DEFAULT_NOTIFICATION_MODE
}

/** Parse a persisted method string; anything invalid falls back to the
 * default (`auto`). */
export function parseNotificationMethod(value: string | undefined): NotificationMethod {
  if (value === 'osc9' || value === 'osc777' || value === 'bell') return value
  return DEFAULT_NOTIFICATION_METHOD
}
