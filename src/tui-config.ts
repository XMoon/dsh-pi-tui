/**
 * The TUI plugin's Cordis config contract (plan §28): the resumed session id
 * plus the DSH 0.1.7 profile-owned live TUI preferences. Every preference
 * field is a schemastery `.volatile()` reference (PR A): the `tui-app`
 * plugin's Config is the ONE runtime authority, Loader commits live updates
 * into the references without remounting, and the Settings service projects
 * these fields into editable forms keyed by the `tui-app` profile entry.
 *
 * The package entry re-exports `Config` unchanged, so the published root
 * surface is preserved while the composition root consumes the same contract.
 * @module @xmoon76/dsh-pi-tui/tui-config
 */

import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
/** Plugin config: the session to resume, resolved from the startup service,
 * plus the DSH 0.1.7 profile-owned live TUI preferences. Every preference
 * field is a schemastery `.volatile()` reference (PR A): the `tui-app`
 * plugin's Config is the ONE runtime authority, Loader commits live updates
 * into the references without remounting, and the Settings service projects
 * these fields into editable forms keyed by the `tui-app` profile entry. */
export interface Config {
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
  /** Theme values: auto | dark | light | custom:<name>. */
  readonly theme: Volatile<string>
  readonly iconStyle: Volatile<string>
  readonly footer: Volatile<string>
  /** The user's LAST NATIVE footer mode ('default' | 'compact' | 'custom'):
   * persisted separately because `footer` itself is overwritten by
   * 'command' when the command surface arms — the command surface's failure
   * fallback resolves from THIS, so a compact user's fallback survives a
   * restart. */
  readonly footerFallbackMode: Volatile<string>
  /** The M2 versioned custom footer layout (a nested object, never a JSON
   * string). No schema default: parseFooterLayout is the authority on the
   * persisted value and resolves absence to the builtin default layout. */
  readonly footerLayout: Volatile<unknown>
  /** PR C: the Custom Text/Command definition collection, retained as raw
   * data — the fail-soft parser (footer/custom-items.ts) owns validation. */
  readonly footerCustomItems: Volatile<unknown>
  /** M5: the trusted command status-line config (armed ONLY while the USER
   * profile layer owns it — see resolveTrustedFooterCommand). */
  readonly footerCommand: Volatile<unknown>
  readonly fullscreen: Volatile<string>
  /** Busy-Enter delivery for plain Enter while the agent runs: 'queue'
   * (default) or 'steer'. */
  readonly busyEnter: Volatile<string>
  /** Local-shell sandbox for user-typed `!`/`!!` commands: 'bypass'
   * (default) runs them outside the dsh sandbox, 'sandbox' routes them
   * through the dsh shell capability's policy. */
  readonly localShellSandbox: Volatile<string>
  /** Home/End navigation behavior (issue #9): 'input' (default) moves
   * within the input, 'viewport' keeps Home/End scrolling. */
  readonly homeEndKeys: Volatile<string>
  /** Canonical transcript display preset (focus | compact | full). */
  readonly displayPreset: Volatile<string>
  /** Mid-turn progress-update cadence (off | milestones | frequent). */
  readonly progressUpdates: Volatile<string>
  /** Visible-answer density guidance (default | concise | explanatory). */
  readonly responseStyle: Volatile<string>
  /** Completion-notification mode ('unfocused' | 'always' | 'off'). */
  readonly notificationMode: Volatile<string>
  /** Completion-notification method ('auto' | 'osc9' | 'osc777' | 'bell'). */
  readonly notificationMethod: Volatile<string>
  /** Fullscreen mouse-wheel step ('1' | '2' | '3' | '5' | '8'). */
  readonly wheelScrollLines: Volatile<string>
  /** The user keybinding overrides as a whole-value RAW field. The
   * keybindings parser (src/keybindings/config.ts) is the only
   * validation/parsing authority — the keybinding business schema
   * deliberately stays out of the plugin Config. */
  readonly keybindings: Volatile<unknown>
  /** Internal one-shot legacy-migration marker (PR A §8.3): never a
   * product row, never a behavior switch — it only keeps the retired
   * settings.yaml(.imported) from re-overwriting newer user values. */
  readonly legacySettingsMigrationVersion: Volatile<number>
}

// The cast bridges schemastery's structural volatile inference to the
// declared Config interface (the declared type is what the public .d.mts
// carries; the runtime object is the schema itself).
export const Config: z<Config> = z.object({
  sessionId: z.string(),
  theme: z.string().default('auto').volatile(),
  iconStyle: z.string().default('emoji').volatile(),
  footer: z.string().default('full').volatile(),
  footerFallbackMode: z.string().default('default').volatile(),
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
      })),
      right: z.array(z.object({
        id: z.string(),
        format: z.string(),
        tone: z.string(),
        prefix: z.string(),
        suffix: z.string(),
        importance: z.number(),
      })),
      separator: z.object({
        text: z.string(),
        tone: z.string(),
      }),
    })),
  }).volatile(),
  footerCustomItems: z.any().volatile(),
  footerCommand: z.object({
    schemaVersion: z.const(1),
    command: z.string(),
    timeoutMs: z.number(),
    refreshIntervalMs: z.number(),
    maxRows: z.number(),
  }).volatile(),
  fullscreen: z.string().default('on').volatile(),
  busyEnter: z.string().default('queue').volatile(),
  localShellSandbox: z.string().default('bypass').volatile(),
  homeEndKeys: z.string().default('input').volatile(),
  displayPreset: z.string().default('full').volatile(),
  progressUpdates: z.string().default('milestones').volatile(),
  responseStyle: z.string().default('default').volatile(),
  notificationMode: z.string().default('unfocused').volatile(),
  notificationMethod: z.string().default('auto').volatile(),
  wheelScrollLines: z.string().default('1').volatile(),
  keybindings: z.any().volatile(),
  legacySettingsMigrationVersion: z.number().default(0).volatile(),
}) as unknown as z<Config>
