/**
 * The TUI plugin's Cordis config contract: the resumed session id plus the
 * DSH 0.1.7 profile-owned live TUI preferences. Every preference field is a
 * schemastery `.volatile()` reference.
 *
 * `PREFERENCE_FIELDS` is the ONE field table: the published `Config` (Direct's
 * `tui-app` row, kept for compatibility and as a legacy migration source) and
 * the canonical `PreferencesConfig` (`pi-tui-preferences`) are both derived
 * from it, so the two rows can never drift apart.
 *
 * Authority note: the `tui-app` row is no longer the runtime preference
 * authority; the canonical `pi-tui-preferences` row and its `piTuiPreferences`
 * service are. `tui-app` keeps its schema (and the `sessionId` launch input)
 * only so installed profiles and the published API keep working, and so the
 * Host-owned migration can read the old USER values once.
 *
 * @module @xmoon76/dsh-pi-tui/app/config/schema
 */

import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'

/** The 20 durable TUI preferences every backend shares. The names are the
 * persisted profile keys; the schema keeps the historical defaults, validators
 * and shapes. */
export const PREFERENCE_FIELDS: Readonly<Record<string, z>> = {
  /** Theme values: auto | dark | light | custom:<name>. */
  theme: z.string().default('auto').volatile(),
  iconStyle: z.string().default('emoji').volatile(),
  footer: z.string().default('full').volatile(),
  /** The user's LAST NATIVE footer mode ('default' | 'compact' | 'custom'):
   * persisted separately because `footer` itself is overwritten by
   * 'command' when the command surface arms — the command surface's failure
   * fallback resolves from THIS, so a compact user's fallback survives a
   * restart. */
  footerFallbackMode: z.string().default('default').volatile(),
  /** The M2 versioned custom footer layout (a nested object, never a JSON
   * string). No schema default: parseFooterLayout is the authority on the
   * persisted value and resolves absence to the builtin default layout. */
  footerLayout: z.object({
    schemaVersion: z.const(1),
    rows: z.array(z.object({
      left: z.array(z.object({
        id: z.string(),
        format: z.string(),
        tone: z.string(),
        prefix: z.string(),
        suffix: z.string(),
        importance: z.number(),
        hideInTsp: z.boolean(),
      })),
      right: z.array(z.object({
        id: z.string(),
        format: z.string(),
        tone: z.string(),
        prefix: z.string(),
        suffix: z.string(),
        importance: z.number(),
        hideInTsp: z.boolean(),
      })),
      separator: z.object({
        text: z.string(),
        tone: z.string(),
      }),
    })),
  }).volatile(),
  /** PR C: the Custom Text/Command definition collection, retained as raw
   * data — the fail-soft parser (footer/custom-items.ts) owns validation. */
  footerCustomItems: z.any().volatile(),
  /** M5: the trusted command status-line config (armed ONLY while the USER
   * profile layer owns it — see resolveTrustedFooterCommand). */
  footerCommand: z.object({
    schemaVersion: z.const(1),
    command: z.string(),
    timeoutMs: z.number(),
    refreshIntervalMs: z.number(),
    maxRows: z.number(),
  }).volatile(),
  fullscreen: z.string().default('on').volatile(),
  /** Busy-Enter delivery for plain Enter while the agent runs: 'queue'
   * (default) or 'steer'. */
  busyEnter: z.string().default('queue').volatile(),
  /** User-shell sandbox policy for user-typed `!`/`!!` commands: 'bypass'
   * (default) runs them outside the dsh sandbox, 'sandbox' routes them
   * through the dsh shell capability's policy. */
  localShellSandbox: z.string().default('bypass').volatile(),
  /** Home/End navigation behavior (issue #9): 'input' (default) moves
   * within the input, 'viewport' keeps Home/End scrolling. */
  homeEndKeys: z.string().default('input').volatile(),
  /** Canonical transcript display preset (focus | compact | full). */
  displayPreset: z.string().default('full').volatile(),
  /** Mid-turn progress-update cadence (off | milestones | frequent). */
  progressUpdates: z.string().default('milestones').volatile(),
  /** Git attribution guidance mode (off | product | product-model). */
  gitAttribution: z.string().default('off').volatile(),
  /** Visible-answer density guidance (default | concise | explanatory). */
  responseStyle: z.string().default('default').volatile(),
  /** Completion-notification mode ('unfocused' | 'always' | 'off'). */
  notificationMode: z.string().default('unfocused').volatile(),
  /** Completion-notification method ('auto' | 'osc9' | 'osc777' | 'bell'). */
  notificationMethod: z.string().default('auto').volatile(),
  /** Terminal-progress protocol selection ('off' | '9;4' | '7501' |
   * '9;4+7501'): which native terminal status protocols the TUI reports.
   * Defaults to the dual protocol. */
  terminalProgress: z.string().default('9;4+7501').volatile(),
  /** Fullscreen mouse-wheel step ('1' | '2' | '3' | '5' | '8'). */
  wheelScrollLines: z.string().default('1').volatile(),
  /** The user keybinding overrides as a whole-value RAW field. The
   * keybindings parser (src/tui/keybindings/config.ts) is the only
   * validation/parsing authority — the keybinding business schema
   * deliberately stays out of the plugin Config. */
  keybindings: z.any().volatile(),
}

/** The 20 persisted preference field names, in schema order. */
export const PREFERENCE_FIELD_NAMES: readonly string[] = Object.keys(PREFERENCE_FIELDS)

/** The canonical `pi-tui-preferences` Config: the 20 shared preferences plus
 * the Host-owned migration marker (`legacySettingsMigrationVersion`, default
 * 0, completion value 2). */
export interface PreferencesConfig {
  readonly theme: Volatile<string>
  readonly iconStyle: Volatile<string>
  readonly footer: Volatile<string>
  readonly footerFallbackMode: Volatile<string>
  readonly footerLayout: Volatile<unknown>
  readonly footerCustomItems: Volatile<unknown>
  readonly footerCommand: Volatile<unknown>
  readonly fullscreen: Volatile<string>
  readonly busyEnter: Volatile<string>
  readonly localShellSandbox: Volatile<string>
  readonly homeEndKeys: Volatile<string>
  readonly displayPreset: Volatile<string>
  readonly progressUpdates: Volatile<string>
  readonly gitAttribution: Volatile<string>
  readonly responseStyle: Volatile<string>
  readonly notificationMode: Volatile<string>
  readonly notificationMethod: Volatile<string>
  readonly terminalProgress: Volatile<string>
  readonly wheelScrollLines: Volatile<string>
  readonly keybindings: Volatile<unknown>
  /** Internal one-shot Host migration marker: NEVER a product row, never a
   * behavior switch — it only keeps an already-migrated profile from
   * re-applying old sources over newer user values. */
  readonly legacySettingsMigrationVersion: Volatile<number>
}

// The cast bridges schemastery's structural volatile inference to the
// declared interface (the declared type is what the public .d.mts carries;
// the runtime object is the schema itself).
export const PreferencesConfig: z<PreferencesConfig> = z.object({
  ...PREFERENCE_FIELDS,
  legacySettingsMigrationVersion: z.number().default(0).volatile(),
}) as unknown as z<PreferencesConfig>

/** The published root Config: the resumed session id, the internal test-only
 * status sink, the 20 preferences and the marker. `tui-app` declares it; the
 * canonical preferences row declares only {@link PreferencesConfig}. */
export interface Config extends PreferencesConfig {
  /** Resumed session id; a fresh session is created when absent. */
  sessionId?: string
  /** Test seam: the pre-mount status output (defaults to process.stdout,
   * TTY-gated). Injectable so the runner tests capture the status writes
   * without patching the global stdout (which would fight the test
   * reporter's own writes). STRUCTURAL on purpose: the public Config type
   * must not reference the internal startup-status module (the public
   * .d.mts leak gate). */
  startupStatusOutput?: {
    readonly isTTY?: boolean
    write(text: string): unknown
  }
}

export const Config: z<Config> = z.object({
  sessionId: z.string(),
  ...PREFERENCE_FIELDS,
  legacySettingsMigrationVersion: z.number().default(0).volatile(),
}) as unknown as z<Config>
