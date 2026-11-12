/**
 * The ONE production Web-only Loader roster (C8: a single static member table).
 *
 * These are the official Browser Web rows the Host-only overlay declares and
 * the private `piTuiWebAccess` Host service toggles at runtime. The row set is
 * the official Web composition of the installed DSH family: it must satisfy
 * every `dsh.client.inject` dependency the shipped official Client UIs declare,
 * so it is fixed by those manifests rather than by a local count.
 *
 * PURE DATA, NO HOST DEPENDENCY: `local-host-entry.ts` renders this table into
 * the Host-only overlay YAML, and `web-access.ts` verifies the LIVE Loader
 * against it. The hand-written expectations stay their own oracles and must
 * not be derived from this module: `WEB_ROWS` in
 * `test/app/remote-process-host-foundation.test.ts` (that test imports this
 * production table only to compare the toggle roster with the real overlay)
 * and `PR_A_WEB_ROWS` in `scripts/smoke/split-process/web-helpers.mjs`.
 *
 * @module @xmoon76/dsh-pi-tui/app/host/features/web-roster
 */

/**
 * The official Web-only Loader rows, in the overlay's canonical order, with the
 * exact official package each row loads. The set, never a count, is the
 * composition contract: every entry is the ONE owner of its published package.
 *
 * `inject` / `config` / `yaml` are the NARROW, row-local facts the official
 * rc.2 Web patch states for a row that cannot keep its own manifest defaults in
 * this Host-only profile:
 * - `inject` mirrors the official row's explicit dependency override
 *   (`mcp-manager` needs the already-mounted `credentials` provider);
 * - `config` carries a fixed official non-desktop value (`skill-office`
 *   `pythonEnvironment: user`: the Host-only profile mounts no
 *   `workspace-dependencies` runtime, so the user's Python stays the target);
 * - `yaml` carries the fixed official macro fragment for the ONE row whose
 *   value is produced by the official `!!js` scope (`office-kit` output under
 *   the Host's own DSH home). It is a literal fragment for this fixed row, not
 *   a general config AST.
 *
 * `workspace-dependencies` is deliberately absent: the official row is
 * desktop-only and conditioned on `DSH_PRIMARY_RUNTIME`, which this Host-only
 * profile does not provide. Activating it would invent a desktop runtime.
 */
export const PI_TUI_WEB_ACCESS_ROWS: ReadonlyArray<{
  readonly id: string
  readonly name: string
  readonly inject?: readonly string[]
  readonly config?: Readonly<Record<string, string | number | boolean>>
  readonly yaml?: readonly string[]
}> = [
  { id: 'web-runtime', name: '@deepseek-ai/dsh-web-app', inject: ['webServer'], config: { openBrowser: false, printUrl: false, surfaceContext: false } },
  { id: 'modules', name: '@deepseek-ai/dsh-client-modules' },
  { id: 'client-hmr', name: '@deepseek-ai/dsh-client-hmr' },
  { id: 'cordis-client-runner', name: '@deepseek-ai/dsh-cordis-client-runner' },
  // One shared MCP server fleet behind the official Host service; the
  // credential provider it resolves templates through is already mounted.
  { id: 'mcp-manager', name: '@deepseek-ai/dsh-mcp-manager', inject: ['credentials'] },
  // Browser file actions (download / clipboard) for the Session's own files.
  { id: 'ui-file-actions', name: '@deepseek-ai/dsh-client-ui-file-actions' },
  { id: 'ui-context-menu', name: '@deepseek-ai/dsh-client-ui-context-menu' },
  { id: 'ui-open-in-app', name: '@deepseek-ai/dsh-client-ui-open-in-app' },
  { id: 'ui-settings-account', name: '@deepseek-ai/dsh-client-ui-settings-account' },
  // The official Account notification surface injects (and therefore loads
  // after) the settings-account UI it appears beside.
  { id: 'ui-account-notifications', name: '@deepseek-ai/dsh-client-ui-account-notifications' },
  { id: 'ui-theme', name: '@deepseek-ai/dsh-client-ui-theme' },
  { id: 'locale', name: '@deepseek-ai/dsh-client-locale' },
  { id: 'shortcuts', name: '@deepseek-ai/dsh-client-shortcuts' },
  { id: 'ui-shortcuts', name: '@deepseek-ai/dsh-client-ui-shortcuts' },
  { id: 'ui-layout', name: '@deepseek-ai/dsh-client-ui-layout' },
  { id: 'ui-renderer', name: '@deepseek-ai/dsh-client-ui-renderer' },
  { id: 'ui-session', name: '@deepseek-ai/dsh-client-ui-session' },
  { id: 'resources', name: '@deepseek-ai/dsh-client-resources' },
  { id: 'ui-sidebar', name: '@deepseek-ai/dsh-client-ui-sidebar' },
  { id: 'ui-sidebar-right', name: '@deepseek-ai/dsh-client-ui-sidebar-right' },
  // Official Host Office conversion service for Browser document preview. Its
  // output directory is the official Host data location, never the Client cwd.
  {
    id: 'office-kit',
    name: '@deepseek-ai/dsh-office-kit',
    yaml: [
      '      config:',
      "        outputDirectory: !!js dshHomePath('office-kit', 'outputs')",
    ],
  },
  // Every profile uses the packaged Office skills; a Host-only non-desktop
  // profile selects the user's Python (no workspace-dependencies runtime).
  { id: 'skill-office', name: '@deepseek-ai/dsh-skill-office', config: { pythonEnvironment: 'user' } },
  { id: 'ui-sidebar-documentpreview', name: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview' },
  { id: 'ui-sidebar-terminal', name: '@deepseek-ai/dsh-client-ui-sidebar-terminal' },
  { id: 'ui-sidebar-files', name: '@deepseek-ai/dsh-client-ui-sidebar-files' },
  { id: 'ui-settings', name: '@deepseek-ai/dsh-client-ui-settings' },
  { id: 'ui-settings-general', name: '@deepseek-ai/dsh-client-ui-settings-general' },
  { id: 'ui-settings-models', name: '@deepseek-ai/dsh-client-ui-settings-models' },
  { id: 'ui-plugin-manager', name: '@deepseek-ai/dsh-client-ui-plugin-manager' },
  { id: 'ui-settings-plugin-inventory', name: '@deepseek-ai/dsh-client-ui-settings-plugin-inventory' },
  { id: 'ui-conversation', name: '@deepseek-ai/dsh-client-ui-conversation' },
  { id: 'ui-approval', name: '@deepseek-ai/dsh-client-ui-approval' },
  // Selection-to-quote over the current Session; writes only the composer draft.
  { id: 'message-quotes', name: '@deepseek-ai/dsh-message-quotes' },
  { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat' },
  { id: 'ui-brand-official', name: '@deepseek-ai/dsh-client-ui-brand-official' },
  { id: 'ui-attachment', name: '@deepseek-ai/dsh-client-ui-attachment' },
  { id: 'ui-file-drag', name: '@deepseek-ai/dsh-client-ui-file-drag' },
  { id: 'ui-tool', name: '@deepseek-ai/dsh-client-ui-tool' },
  { id: 'ui-cordis', name: '@deepseek-ai/dsh-client-ui-cordis' },
  // The Host recorder `ui-deliverables` injects; it MUST come before its
  // consumer because the toggle activates one row at a time and awaits it.
  { id: 'workspace-changes', name: '@deepseek-ai/dsh-workspace-changes' },
  { id: 'ui-deliverables', name: '@deepseek-ai/dsh-client-ui-deliverables' },
  { id: 'ui-workspace', name: '@deepseek-ai/dsh-client-ui-workspace' },
  { id: 'ui-workflow-run', name: '@deepseek-ai/dsh-client-ui-workflow-run' },
  { id: 'ui-input-trigger', name: '@deepseek-ai/dsh-client-ui-input-trigger' },
  { id: 'ui-commands', name: '@deepseek-ai/dsh-client-ui-commands' },
  { id: 'ui-skill', name: '@deepseek-ai/dsh-client-ui-skill' },
  // The Team client UI follows the always-active base agent-team providers.
  { id: 'ui-agent-team', name: '@deepseek-ai/dsh-client-ui-agent-team' },
  { id: 'ui-subagent', name: '@deepseek-ai/dsh-client-ui-subagent' },
  { id: 'ui-reference', name: '@deepseek-ai/dsh-client-ui-reference' },
  { id: 'ui-secret-mask', name: '@deepseek-ai/dsh-client-ui-secret-mask' },
  { id: 'ui-jobs', name: '@deepseek-ai/dsh-client-ui-jobs' },
  { id: 'ui-schedule', name: '@deepseek-ai/dsh-client-ui-schedule' },
  { id: 'ui-goal', name: '@deepseek-ai/dsh-client-ui-goal' },
  { id: 'ui-message-feedback', name: '@deepseek-ai/dsh-client-ui-message-feedback' },
  { id: 'ui-model-selection', name: '@deepseek-ai/dsh-client-ui-model-selection' },
  { id: 'ui-permission', name: '@deepseek-ai/dsh-client-ui-permission-presets' },
  { id: 'ui-agent-preset', name: '@deepseek-ai/dsh-client-ui-agent-preset' },
  { id: 'entry-customization', name: '@deepseek-ai/dsh-client-ui-entry-customization' },
  { id: 'ui-settings-session-log', name: '@deepseek-ai/dsh-client-ui-settings-session-log' },
  { id: 'ui-settings-plugins', name: '@deepseek-ai/dsh-client-ui-settings-plugins' },
  { id: 'ui-settings-shell', name: '@deepseek-ai/dsh-client-ui-settings-shell' },
  { id: 'ui-settings-agent-loop', name: '@deepseek-ai/dsh-client-ui-settings-agent-loop' },
  { id: 'ui-settings-subagent', name: '@deepseek-ai/dsh-client-ui-settings-subagent' },
  { id: 'ui-settings-web-search', name: '@deepseek-ai/dsh-client-ui-settings-web-search' },
  { id: 'ui-plan', name: '@deepseek-ai/dsh-client-ui-plan' },
  { id: 'ui-user-questions', name: '@deepseek-ai/dsh-client-ui-user-questions' },
  { id: 'ui-trajectory', name: '@deepseek-ai/dsh-client-ui-trajectory' },
  { id: 'terminal-controller', name: '@deepseek-ai/dsh-api-terminal-controller' },
]
