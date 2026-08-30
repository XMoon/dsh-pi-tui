/**
 * The single source of truth for the HOST action definitions (plan §5).
 * Every default key here MUST match the pre-migration behavior — M0's
 * gate is "no production behavior change" (plan §20 M0). When a new host
 * shortcut lands, extend THIS table in the same commit (and the
 * RESERVED_HOST_KEYS plugin-registration guard in keybinding-registry.ts
 * if plugins must not claim the new default — that list is NOT the
 * runtime authority; the effective keymap and the action-driven
 * hostResolves reservation are).
 *
 * Scope semantics (plan §4): the static context contract used for conflict
 * detection and diagnostics. The resolver additionally honors per-rule
 * predicates (e.g. the empty-editor ↓ affordance).
 * @module @xmoon76/dsh-pi-tui/keybindings/definitions
 */

import type { AppKeybindingDefinition, AppKeybindingId } from './types.ts'

/**
 * The full action table. `configurable: false` marks actions whose keys
 * are Host-owned overlay/component contracts for the first version (the
 * plan's phased opening: M3 opens Host global actions, focused component
 * actions open later — plan §3.3). They are still routed through the
 * keymap so the UI never hard-codes their keys.
 */
export const APP_KEYBINDINGS: Record<AppKeybindingId, AppKeybindingDefinition> = {
  // ── Input / Agent ──────────────────────────────────────────────────────
  'app.input.submit': {
    id: 'app.input.submit',
    defaultKeys: ['enter'],
    description: 'Submit input',
    category: 'Input',
    scope: 'editor',
    configurable: true,
    // The submit key stays with the FORK editor's submit path (paste-burst
    // and backslash-newline semantics live there — plan §8 resolver
    // priority 5); the host ladder NEVER consumes it. A user remap /
    // `false` is synced into the fork editor's `tui.input.submit` binding
    // by the runner (onEditorSubmitSync), so Enter REALLY moves / gets
    // disabled — not just the hints (PR review finding).
    hostResolved: false,
  },
  'app.input.queue': {
    id: 'app.input.queue',
    defaultKeys: ['ctrl+enter'],
    description: 'Queue input (the busy-Enter opposite chord)',
    category: 'Input',
    scope: 'editor',
    configurable: true,
  },
  'app.input.steer': {
    id: 'app.input.steer',
    defaultKeys: ['ctrl+s'],
    description: 'Steer the running agent with the draft',
    category: 'Input',
    scope: 'agent-running',
    configurable: true,
  },
  'app.input.dequeue': {
    id: 'app.input.dequeue',
    defaultKeys: ['alt+up'],
    description: 'Recall queued input into the editor',
    category: 'Input',
    scope: 'editor',
    configurable: true,
  },
  'app.agent.interrupt': {
    id: 'app.agent.interrupt',
    defaultKeys: ['escape'],
    // Action-neutral on purpose: the description shows in /keybindings
    // and must not hard-code the physical Escape chord — the action is
    // user-configurable, so a remap must not make the copy a lie
    // (convergence §14 copy convention).
    description: 'Interrupt the current activity (once while busy; twice while idle)',
    category: 'Agent',
    scope: 'agent-running',
    configurable: true,
  },
  'app.exit.request': {
    id: 'app.exit.request',
    defaultKeys: ['ctrl+c', 'ctrl+d'],
    // Key-neutral on purpose: the description shows in /keybindings and
    // must not hard-code a physical chord (a remap must not make it a
    // lie — see the copy-convention in docs/keybinding-architecture.md).
    description: 'Quit the TUI (the default chord clears the draft first; a second press exits)',
    category: 'Agent',
    scope: 'global',
    configurable: true,
  },

  // ── Transcript ─────────────────────────────────────────────────────────
  'app.transcript.search': {
    id: 'app.transcript.search',
    defaultKeys: ['ctrl+f', 'ctrl+shift+f'],
    description: 'Search the transcript',
    category: 'Transcript',
    scope: 'global',
    configurable: true,
  },
  'app.transcript.jumpLatest': {
    id: 'app.transcript.jumpLatest',
    defaultKeys: ['ctrl+end'],
    description: 'Jump to the latest transcript output',
    category: 'Transcript',
    scope: 'global',
    configurable: true,
  },
  'app.transcript.search.next': {
    id: 'app.transcript.search.next',
    defaultKeys: ['enter'],
    description: 'Jump to the next search match',
    category: 'Transcript',
    scope: 'search',
    configurable: false,
  },
  'app.transcript.search.previous': {
    id: 'app.transcript.search.previous',
    defaultKeys: ['shift+enter'],
    description: 'Jump to the previous search match',
    category: 'Transcript',
    scope: 'search',
    configurable: false,
  },
  'app.transcript.search.close': {
    id: 'app.transcript.search.close',
    defaultKeys: ['escape'],
    description: 'Close transcript search',
    category: 'Transcript',
    scope: 'search',
    configurable: false,
  },
  'app.transcript.toggleExpand': {
    id: 'app.transcript.toggleExpand',
    defaultKeys: ['ctrl+o'],
    description: 'Expand/collapse recent tool output and thinking',
    category: 'Transcript',
    scope: 'global',
    configurable: true,
  },
  'app.transcript.toggleThinking': {
    id: 'app.transcript.toggleThinking',
    defaultKeys: ['alt+t'],
    description: 'Hide/show thinking blocks',
    category: 'Transcript',
    scope: 'global',
    configurable: true,
  },
  'app.transcript.toggleFullscreen': {
    id: 'app.transcript.toggleFullscreen',
    // No default key in the current TUI (fullscreen is a settings/plugin
    // surface); registered so the user may bind it (plan §3.2).
    defaultKeys: [],
    description: 'Toggle fullscreen mode',
    category: 'Transcript',
    scope: 'global',
    configurable: true,
  },

  // ── Editor / Clipboard ───────────────────────────────────────────────
  'app.editor.external': {
    id: 'app.editor.external',
    defaultKeys: ['ctrl+g'],
    description: 'Edit the draft in $VISUAL/$EDITOR',
    category: 'Editor',
    scope: 'editor',
    configurable: true,
  },
  'app.clipboard.pasteMedia': {
    id: 'app.clipboard.pasteMedia',
    defaultKeys: ['ctrl+v'],
    description: 'Paste media from the clipboard',
    category: 'Editor',
    scope: 'editor',
    configurable: true,
  },

  // ── Permissions / Panels ───────────────────────────────────────────────
  'app.permission.cycle': {
    id: 'app.permission.cycle',
    defaultKeys: ['shift+tab'],
    description: 'Cycle the permission preset',
    category: 'Permission',
    scope: 'editor',
    configurable: true,
  },
  'app.todo.toggle': {
    id: 'app.todo.toggle',
    defaultKeys: ['ctrl+t'],
    description: 'Toggle the todo panel',
    category: 'Panels',
    scope: 'global',
    configurable: true,
  },
  'app.tasks.open': {
    id: 'app.tasks.open',
    // The main path is the CONDITIONAL affordance (↓ + empty editor +
    // active tasks — plan §5); no plain default key. Never reintroduce
    // Ctrl+J (legacy terminals send it as LF — plan §5 note).
    defaultKeys: [],
    description: 'Open the task browser',
    category: 'Panels',
    scope: 'editor',
    configurable: true,
  },
  'app.history.search': {
    id: 'app.history.search',
    defaultKeys: ['ctrl+r'],
    description: 'Search input history',
    category: 'Editor',
    scope: 'editor',
    configurable: true,
  },
  'app.shell.dismissSettled': {
    id: 'app.shell.dismissSettled',
    defaultKeys: ['alt+k'],
    description: 'Dismiss settled local shell cards',
    category: 'Panels',
    scope: 'global',
    configurable: true,
  },

  // ── Session / Model (RESERVED for later unification — plan §3.2) ──────
  // These are NOT implemented in this version: the dispatcher has no
  // host behavior for them. `configurable: false` + `availability:
  // 'reserved'` means the parser rejects any user binding with a
  // diagnostic — they are never bindable no-op keys (convergence §7: a
  // user-configurable action must actually DO something).
  'app.session.open': {
    id: 'app.session.open',
    defaultKeys: [],
    description: 'Open a session (reserved — not implemented in this version)',
    category: 'Session',
    scope: 'global',
    configurable: false,
    availability: 'reserved',
  },
  'app.session.new': {
    id: 'app.session.new',
    defaultKeys: [],
    description: 'Start a new session (reserved — not implemented in this version)',
    category: 'Session',
    scope: 'global',
    configurable: false,
    availability: 'reserved',
  },
  'app.session.resume': {
    id: 'app.session.resume',
    defaultKeys: [],
    description: 'Resume a session (reserved — not implemented in this version)',
    category: 'Session',
    scope: 'global',
    configurable: false,
    availability: 'reserved',
  },
  'app.model.open': {
    id: 'app.model.open',
    defaultKeys: [],
    description: 'Open the model picker (reserved — not implemented in this version)',
    category: 'Session',
    scope: 'global',
    configurable: false,
    availability: 'reserved',
  },

  // ── Focused component: user-questions flow (plan §3.3) ────────────────
  'question.confirm': {
    id: 'question.confirm',
    defaultKeys: ['enter'],
    description: 'Confirm the current question',
    category: 'Question',
    scope: 'question',
    configurable: false,
  },
  'question.cancel': {
    id: 'question.cancel',
    defaultKeys: ['escape'],
    description: 'Cancel the question flow',
    category: 'Question',
    scope: 'question',
    configurable: false,
  },
  'question.previous': {
    id: 'question.previous',
    defaultKeys: ['left'],
    description: 'Go to the previous question',
    category: 'Question',
    scope: 'question',
    configurable: false,
  },
  'question.next': {
    id: 'question.next',
    defaultKeys: ['right'],
    description: 'Go to the next question',
    category: 'Question',
    scope: 'question',
    configurable: false,
  },
  'question.cursorUp': {
    id: 'question.cursorUp',
    defaultKeys: ['up'],
    description: 'Move the selection up',
    category: 'Question',
    scope: 'question',
    configurable: false,
  },
  'question.cursorDown': {
    id: 'question.cursorDown',
    defaultKeys: ['down'],
    description: 'Move the selection down',
    category: 'Question',
    scope: 'question',
    configurable: false,
  },
  'question.pageUp': {
    id: 'question.pageUp',
    defaultKeys: ['pageUp'],
    description: 'Scroll the question body up',
    category: 'Question',
    scope: 'question',
    configurable: false,
  },
  'question.pageDown': {
    id: 'question.pageDown',
    defaultKeys: ['pageDown'],
    description: 'Scroll the question body down',
    category: 'Question',
    scope: 'question',
    configurable: false,
  },
  'question.toggleExpand': {
    id: 'question.toggleExpand',
    defaultKeys: ['e'],
    description: 'Expand/collapse the question frame',
    category: 'Question',
    scope: 'question',
    configurable: false,
  },

  // ── Focused component: task browser (plan §3.3) ────────────────────────
  'tasks.confirm': {
    id: 'tasks.confirm',
    defaultKeys: ['enter'],
    description: 'Confirm the selected task',
    category: 'Tasks',
    scope: 'tasks',
    configurable: false,
  },
  'tasks.cancel': {
    id: 'tasks.cancel',
    defaultKeys: ['escape'],
    description: 'Close the task browser',
    category: 'Tasks',
    scope: 'tasks',
    configurable: false,
  },
  'tasks.cursorUp': {
    id: 'tasks.cursorUp',
    defaultKeys: ['up'],
    description: 'Move the selection up',
    category: 'Tasks',
    scope: 'tasks',
    configurable: false,
  },
  'tasks.cursorDown': {
    id: 'tasks.cursorDown',
    defaultKeys: ['down'],
    description: 'Move the selection down',
    category: 'Tasks',
    scope: 'tasks',
    configurable: false,
  },
  'tasks.pageUp': {
    id: 'tasks.pageUp',
    defaultKeys: ['pageUp'],
    description: 'Page the task list up',
    category: 'Tasks',
    scope: 'tasks',
    configurable: false,
  },
  'tasks.pageDown': {
    id: 'tasks.pageDown',
    defaultKeys: ['pageDown'],
    description: 'Page the task list down',
    category: 'Tasks',
    scope: 'tasks',
    configurable: false,
  },
  'tasks.cycleType': {
    id: 'tasks.cycleType',
    defaultKeys: ['tab'],
    description: 'Cycle the task type filter',
    category: 'Tasks',
    scope: 'tasks',
    configurable: false,
  },
  'tasks.interrupt': {
    id: 'tasks.interrupt',
    defaultKeys: ['i'],
    description: 'Interrupt the selected task',
    category: 'Tasks',
    scope: 'tasks',
    configurable: false,
  },
}

/** The actions a plugin may never override or preempt (plan §10): the
 * Host safety-critical set. Users MAY rebind these (that is the point of
 * the feature); plugins may not claim their keys or handlers. */
export const PROTECTED_HOST_ACTIONS: ReadonlySet<AppKeybindingId> = new Set([
  'app.exit.request',
  'app.agent.interrupt',
  'app.input.submit',
])

/** The parent-session actions the continuable subagent viewer blocks
 * (plan §1.2 / M1): inside the viewer the CHILD is the only input target,
 * so any key that resolves to one of these actions is inert there. This is
 * the ACTION-based replacement of the old physical-key blacklist — a user
 * remap automatically stays blocked. */
export const VIEWER_BLOCKED_PARENT_ACTIONS: ReadonlySet<AppKeybindingId> = new Set([
  'app.input.steer',
  'app.input.queue',
  'app.input.dequeue',
  'app.permission.cycle',
  'app.transcript.search',
  'app.exit.request',
  'app.editor.external',
  'app.todo.toggle',
  'app.transcript.toggleThinking',
  'app.clipboard.pasteMedia',
  'app.tasks.open',
  // Interrupting the PARENT agent from inside a subagent viewer would
  // cancel the very session the child is part of — meaningless and
  // destructive. The viewer's OWN exit is the fixed Esc lifecycle key,
  // independent of the user-configurable interrupt (PR review finding).
  'app.agent.interrupt',
])

/** The actions whose keys are Host-owned overlay contracts for the first
 * version (configurable: false). Kept as a set for the config validator
 * and the /keybindings diagnostics. */
export const NON_CONFIGURABLE_ACTIONS: ReadonlySet<AppKeybindingId> = new Set(
  Object.values(APP_KEYBINDINGS)
    .filter(definition => !definition.configurable)
    .map(definition => definition.id),
)
