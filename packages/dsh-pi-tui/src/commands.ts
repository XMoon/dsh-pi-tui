/**
 * The TUI-owned slash commands (/exit /settings /sessions /skill /model
 * /new /tasks /preset /subagents /search /title /copy /export /fork
 * /status /login /logout /help), extracted from the runner's monolithic
 * apply() so the registration surface is testable and the runner closure
 * shrinks. Every command reads the live runner state through the
 * {@link TuiCommandRunner} interface, whose accessors re-read the current
 * agent/settings on every access (sessions can swap the live agent).
 * @module @xmoon76/dsh-pi-tui/commands
 */

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { effectiveApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { SettingsList, type SettingItem } from '@xmoon76/pi-tui'
import type { TuiApp } from './tui-app.ts'
import type { Diag } from './diag.ts'
import { isCancellation, runDetached } from './detached.ts'
import { color, loadCustomTheme, settingsListTheme } from './theme.ts'
import { ModelSubmenu } from './model-menu.ts'
import { computeStats, formatStats } from './stats.ts'
import { renderTranscriptMarkdown, textOf } from './transcript.ts'
import {
  MAX_PICKER_SESSIONS,
  findSessionMatch,
  headerToPickerRow,
  loadSessionTitles,
  sessionPickerItem,
  type SessionPickerRow,
  type SessionQueryLike,
} from './sessions.ts'
import { customThemeNames } from './theme.ts'

/** A balanced completed-turn prefix for forking: the log up to (and including)
 * the last `turn/end`. Undefined when no turn has completed yet.
 * @param events - the session log.
 * @returns the fork seed events, or undefined.
 */
export function forkSeed(events: readonly SessionEvent[]): readonly SessionEvent[] | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/end') return events.slice(0, index + 1)
  }
  return undefined
}

/** Shorten a session id for read-only display rows, capped at 28 characters. */
function displaySessionId(id: string): string {
  return id.length > 28 ? `${id.slice(0, 28)}…` : id
}

/** Session meta for a fresh/forked session: the cwd plus the preset id when composed. */
function metaOf(cwd: string, presetId: string | undefined): Record<string, unknown> {
  return presetId === undefined ? { cwd } : { cwd, agentPreset: presetId }
}

/** The TUI settings document surface (theme/footer/fullscreen/history). */
export interface TuiSettingsLike {
  get(): { theme: string; footer: string; fullscreen: string; history: Record<string, string[]> }
  replace(doc: { theme: string; footer: string; fullscreen: string; history: Record<string, string[]> }): unknown
}

/** The agents-service surface /new and /fork create sessions through. */
export interface AgentsLike {
  create(options: {
    sessionId: SessionId
    meta: Record<string, unknown>
    // AgentOptions' provider/model are optional; mirror that shape.
    agentOptions: { provider?: string; model?: string }
    setup: (agentCtx: Context) => Promise<void> | void
    seed?: readonly SessionEvent[]
  }): Promise<AgentHandle>
}

/** Everything the TUI-owned commands read from the runner. */
export interface TuiCommandRunner {
  ctx: Context
  app: TuiApp
  /** The runner's diagnostics channel (stderr + $DSH_HOME/logs). */
  diag: Diag
  /** The live agent handle; re-read on every access (swaps on switch).
   * `undefined` until the first user message creates the session (deferred
   * start) — sessionless commands must degrade, session commands call
   * {@link ensureSession} first. */
  readonly liveAgent: Agent | undefined
  /** Create the first session lazily when none exists (deferred start). */
  ensureSession(): Promise<void>
  /** The process-wide mutable model selection (footer + /model). */
  readonly selected: ModelSelectionRef
  /** The TUI settings document, when the settings service is present. */
  readonly tuiSettings: TuiSettingsLike | undefined
  /** The agents service, for /new and /fork. */
  readonly agents: AgentsLike
  /** The sessions service, for the /exit flush. */
  readonly sessions: { flush(session: Session): Promise<unknown> }
  /** The ONE exit orchestration (flush with a hard timeout, cleanup, warn,
   * resume hint, process exit) — shared by Ctrl+C/Ctrl+D, /exit and /quit.
   * Command handlers must NEVER stop the app, flush or exit themselves. */
  requestExit(): void
  cwd: string
  signal: AbortSignal
  /** The runner's monotonic session generation; bumped on every session
   * swap. Late async work must re-check it before committing state. */
  readonly sessionGeneration: number
  compose(presetId?: string): Promise<{ agentPreset?: string; setup: (agentCtx: Context) => Promise<void> | void }>
  switchSession(sessionId: string): Promise<string | undefined>
  swapTo(next: AgentHandle): Promise<string | undefined>
  /** The preset the live agent runs on, when the deployment composes one. */
  currentPreset(): string | undefined
  /** Re-compose a still-blank session onto another preset (see recomposeBlank). */
  recomposeBlank(presetId: string): Promise<{ kind: 'switched'; preset: string } | { kind: 'locked' }>
  refreshStatus(): void
  /** Repaint the welcome card from the live agent's current facts (e.g. after a preset switch). */
  updateWelcomeCard(): void
  enterView(childId: SessionId, label?: string): Promise<void>
  exit(code: number): void
}

/**
 * Register the TUI-owned slash commands on the commands service. The
 * completion list is refreshed after every registration so TUI-owned
 * commands appear in the editor's tab list. Registration is sessionless:
 * the commands service's global layer needs no agent, so the whole surface
 * is available before the first session exists (deferred start).
 * @param runner - the live runner surface.
 * @returns a hook that rebuilds the per-skill slash commands (a no-op until
 *   the first session exists, since the skill catalog scope is the agent).
 */
export function registerTuiCommands(runner: TuiCommandRunner): { refreshSkills(): Promise<number> } {
  const { ctx, app } = runner
  const cwd = runner.cwd
  const signal = runner.signal
  const commands = ctx.get('commands')
  // The commands service is part of the base layer; its absence means the
  // TUI commands cannot be registered at all — the caller surfaces this.
  if (commands === undefined) throw new Error('commands service unavailable')

  // Fire-and-forget with the runner's diag: cancellations debug-only,
  // recoverable (persistence) failures notify + warn, everything else
  // warns — never a bare `void somePromise()` (AGENTS.md hard rule).
  const detach = (label: string, task: Promise<unknown>, options: { notify?: boolean } = {}): void => {
    runDetached(label, task, {
      diag: runner.diag,
      // Diagnostics name the live session at settle time, never the payload.
      sessionId: () => runner.liveAgent?.session.id,
      notify: options.notify === true ? (message) => app.notify(message, 'error') : undefined,
      recoverable: options.notify === true ? () => true : undefined,
    })
  }
  /** Switch sessions with full rejection handling (the runner resolves an
   * error STRING for user-facing failures, but an unexpected rejection must
   * not become an unhandled rejection either). */
  const switchSession = (id: string): void => {
    void runner.switchSession(id).then(error => {
      if (error !== undefined) app.notify(error, 'error')
    }).catch((error: unknown) => {
      // Cancellation (TUI quit / lifecycle abort) is debug-only, never a
      // user error — the unified classification.
      if (isCancellation(error)) {
        runner.diag.debug('session switch cancelled', { session: id })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      runner.diag.error('session switch failed', { session: id, error: message })
      app.notify(`session switch failed: ${message}`, 'error')
    })
  }

  /**
   * Resolve the live agent for a session-backed command, creating the first
   * session lazily when the deferred start has not run yet. Throws when the
   * creation failed — the executor surfaces the error to the user.
   */
  const requireAgent = async (): Promise<Agent> => {
    await runner.ensureSession()
    const agent = runner.liveAgent
    if (agent === undefined) throw new Error('session could not be created')
    return agent
  }

  // Refresh completions after every registration below so TUI-owned
  // commands (/exit /settings /skill /model) appear in the tab list. The
  // agent may be undefined before the first session exists: in-process
  // `commands.list(undefined)` safely returns the global layer only (the
  // remote RPC path's lookup guard does not apply in-process).
  const refreshCompletions = (): void => {
    app.setCommandCompletions(
      commands.list(runner.liveAgent as unknown as Agent).map(command => ({
        name: command.name,
        description: command.description,
        argumentHint: command.input?.hint,
      })),
      cwd,
    )
  }
  refreshCompletions()

  // Shared by /exit and its /quit alias. The exit orchestration lives in
  // the runner (createExitController): flush with a hard timeout, idempotent
  // cleanup, warning, resume hint, process exit. Handlers never stop the app
  // or flush themselves — that kept /exit diverging from Ctrl+C/Ctrl+D (no
  // timeout, no catch, no warning) and could hang a stopped UI forever.
  const exitHandler = (): { kind: 'success' } => {
    runner.requestExit()
    return { kind: 'success' }
  }

  commands.register({
    name: 'exit',
    description: 'Quit the terminal UI (flush and exit)',
    handler: exitHandler,
  })

  commands.register({
    name: 'quit',
    description: 'Quit the terminal UI (flush and exit) — alias of /exit',
    handler: exitHandler,
  })

  commands.register({
    name: 'settings',
    description: 'Open the TUI settings panel',
    handler: () => {
      const liveAgent = runner.liveAgent
      const tuiSettings = runner.tuiSettings
      const theme = tuiSettings?.get().theme ?? 'auto'
      const themeValue = theme.startsWith('custom:') ? theme.slice('custom:'.length) : theme
      // The permission-presets service owns the composed preset table and the
      // persisted default for new sessions (settings namespace 'permission').
      // Both panel rows degrade gracefully when the service is absent.
      const settings = ctx.get('settings')
      const permission = ctx.get('permissionPresets')
      const permissionNames: string[] = [...(permission?.names ?? [])]
      let defaultPermission: string | undefined
      if (settings !== undefined) {
        try {
          const doc = settings.get(settingsNamespace('permission')) as { defaultPreset?: string } | undefined
          defaultPermission = doc?.defaultPreset
        } catch {
          // The namespace is absent until the presets service registers it.
        }
      }
      // Before the first session (deferred start) the session-scoped rows —
      // approval policy and the read-only session facts — do not exist yet;
      // everything process-wide stays available.
      app.openSettings(
        [
          ...liveAgent === undefined ? [] : [{
            id: 'approval',
            label: 'Approval policy (this session)',
            description: 'How tool approvals are handled in this session',
            currentValue: effectiveApprovalPolicy(liveAgent.session.events) ?? 'ask',
            values: ['ask', 'never'],
          }],
          ...permissionNames.length > 0 ? [{
            id: 'default-permission',
            label: 'Default permission',
            description: 'Preset new sessions start with (persisted; Shift+Tab cycles this session)',
            currentValue: defaultPermission ?? permissionNames[0] ?? '',
            values: permissionNames,
          }] : [],
          {
            id: 'theme',
            label: 'Theme',
            description: 'Palette: auto follows the terminal; custom from ~/.dsh-pi-tui/themes',
            currentValue: themeValue,
            values: ['auto', 'dark', 'light', ...customThemeNames()],
          },
          {
            id: 'expand',
            label: 'Tool output',
            description: 'Whether thinking/tool entries start expanded',
            currentValue: app.isToolOutputExpanded() ? 'expanded' : 'collapsed',
            values: ['collapsed', 'expanded'],
          },
          {
            id: 'thinking',
            label: 'Thinking blocks',
            description: 'Whether reasoning entries render at all',
            currentValue: app.isThinkingHidden() ? 'hidden' : 'shown',
            values: ['shown', 'hidden'],
          },
          {
            id: 'footer',
            label: 'Status line',
            description: 'Footer density: full keeps the stats line',
            currentValue: app.getFooterPreset(),
            values: ['full', 'compact'],
          },
          {
            id: 'fullscreen',
            label: 'Fullscreen',
            description: 'Alt-screen mode: off keeps the terminal scrollback',
            currentValue: app.isFullscreen() ? 'on' : 'off',
            values: ['off', 'on'],
          },
          // ── read-only session facts ─────────────────────────────
          {
            id: 'separator',
            label: color.border('─'.repeat(34)),
            currentValue: '',
          },
          ...liveAgent === undefined ? [] : [
            {
              id: 'session',
              label: color.textDim('Session'),
              description: color.textDim(liveAgent.session.id),
              currentValue: color.textDim(displaySessionId(liveAgent.session.id)),
            },
            {
              id: 'model',
              label: color.textDim('Model'),
              description: color.textDim('Provider and model routing this session'),
              currentValue: color.textDim(`${liveAgent.options.provider}/${liveAgent.options.model}`),
            },
            {
              id: 'preset',
              label: color.textDim('Agent preset'),
              description: color.textDim('Composition this session runs on (see /preset)'),
              currentValue: color.textDim(runner.currentPreset() ?? 'none'),
            },
          ],
          {
            id: 'cwd',
            label: color.textDim('Working directory'),
            description: color.textDim('Where this session runs'),
            currentValue: color.textDim(cwd),
          },
        ],
        (id, value) => {
          if (id === 'approval') {
            if ((value === 'ask' || value === 'never') && liveAgent !== undefined) {
              ctx.get('approval')?.setPolicy(liveAgent, value)
              // The footer's permission badge derives from the knob folds;
              // reflect the change immediately.
              runner.refreshStatus()
            }
          } else if (id === 'default-permission') {
            const settings = ctx.get('settings')
            if (settings !== undefined && permissionNames.includes(value)) {
              detach('permission default write', settings.mutate(settingsNamespace('permission'), [{ op: 'set', path: ['defaultPreset'], value }]) as Promise<unknown>, { notify: true })
            }
          } else if (id === 'theme') {
            if (value === 'auto' || value === 'dark' || value === 'light' || customThemeNames().includes(value)) {
              if (value === 'auto') {
                detach('theme autodetect', app.autoDetectTheme())
              } else if (value === 'dark' || value === 'light') {
                app.applyTheme(value)
              } else {
                const palette = loadCustomTheme(value)
                if (palette !== undefined) {
                  app.applyPalette(palette)
                } else {
                  app.notify(`theme ${value} not found`, 'error')
                  return
                }
              }
              // Spread the current doc: a replace is wholesale, so the
              // persisted input history must ride along.
              const settings = tuiSettings
              if (settings !== undefined) {
                detach('settings theme write', settings.replace({ ...settings.get(), theme: value === 'auto' || value === 'dark' || value === 'light' ? value : `custom:${value}` }) as Promise<unknown>, { notify: true })
              }
            }
          } else if (id === 'expand') {
            app.setToolOutputExpanded(value === 'expanded')
          } else if (id === 'thinking') {
            if ((value === 'shown') === app.isThinkingHidden()) app.toggleThinkingHidden()
          } else if (id === 'footer') {
            if (value === 'full' || value === 'compact') {
              app.setFooterPreset(value)
              const settings = tuiSettings
              if (settings !== undefined) {
                detach('settings footer write', settings.replace({ ...settings.get(), footer: value }) as Promise<unknown>, { notify: true })
              }
            }
          } else if (id === 'fullscreen') {
            if (value === 'off' || value === 'on') {
              app.setFullscreen(value === 'on')
              // setFullscreen reports through onFullscreenChange, which
              // persists the same field (this branch is the panel write).
            }
          }
        },
        () => {},
      )
      return { kind: 'success' }
    },
  })

  // Shared /sessions + /resume body: list persisted sessions newest-first,
  // open the picker, and enrich rows with titles in the background. The
  // header parameter lets the resume alias present itself under its own name.
  const openSessionPicker = async (invocation: { rawInput: string }, header: string): Promise<{ kind: 'success' } | { kind: 'error'; text: string }> => {
    // The current marker is the live session's id; before the first session
    // (deferred start) no row is marked current, and the picker can still
    // browse and switch to a persisted session without creating one.
    const currentId = runner.liveAgent?.session.id
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) return { kind: 'error', text: 'session persistence unavailable' }
    // Live-preferred listing (sessionQuery) marks sessions currently
    // loaded in the store; the persistence fallback is the plain list.
    // The engine is read structurally off the context (no package
    // import): `dsh-base` mounts it in every profile.
    const query = ctx.get('sessionQuery') as SessionQueryLike | undefined
    let rows: SessionPickerRow[]
    if (query !== undefined) {
      rows = (await query.listSessions()).map(record => headerToPickerRow(record.header, record.live))
    } else {
      rows = (await persistence.list()).map(header =>
        headerToPickerRow(header, header.id === currentId))
    }
    rows.sort((a, b) => b.createdAt - a.createdAt)
    if (rows.length === 0) return { kind: 'error', text: 'no persisted sessions' }
    // The picker opens instantly on the headers; titles land in the
    // background below. The cap keeps the title read bounded.
    const shown = rows.slice(0, MAX_PICKER_SESSIONS)
    const picker = app.openPicker(
      shown.map(row => sessionPickerItem(row, currentId ?? '')),
      (id) => {
        if (id === currentId) return
        switchSession(id)
      },
      () => {},
      {
        enableSearch: true,
        header,
        noMatchText: '  no matching sessions',
        initialQuery: invocation.rawInput.trim(),
        width: 76,
        maxHeight: 26,
        showHint: true,
      },
    )
    // Enrich rows with titles as they load; the active search query is
    // re-applied by the picker, and the current marker is re-read so a
    // session switch mid-load does not mislabel. Cancellations (TUI quit,
    // the abort signal) are debug-level through the unified entry; a real
    // batch failure lands in diagnostics instead of being swallowed.
    detach('session titles', loadSessionTitles(query, persistence, shown.map(row => row.id), signal)
      .then(titles => {
        if (titles.size === 0) return
        picker.setItems(shown.map(row => sessionPickerItem({ ...row, title: titles.get(row.id) }, runner.liveAgent?.session.id ?? '')))
      }))
    return { kind: 'success' }
  }

  commands.register({
    name: 'sessions',
    description: 'List, search, and switch persisted sessions',
    input: { hint: '[query]' },
    handler: (invocation) => openSessionPicker(invocation, 'sessions'),
  })

  commands.register({
    name: 'resume',
    description: 'Resume a session by id or pick from the list (alias of /sessions)',
    input: { hint: '[id|query]' },
    handler: async (invocation) => {
      const raw = invocation.rawInput.trim()
      if (raw !== '') {
        // Direct resume: exact id, a session- prefixed prefix, or the short
        // id prefix. Falls back to the picker when nothing matches.
        const currentId = runner.liveAgent?.session.id
        const persistence = ctx.get('sessionPersistence')
        if (persistence !== undefined) {
          const query = ctx.get('sessionQuery') as SessionQueryLike | undefined
          let rows: SessionPickerRow[]
          if (query !== undefined) {
            rows = (await query.listSessions()).map(record => headerToPickerRow(record.header, record.live))
          } else {
            rows = (await persistence.list()).map(header =>
              headerToPickerRow(header, header.id === currentId))
          }
          rows.sort((a, b) => b.createdAt - a.createdAt)
          const match = findSessionMatch(rows, raw)
          if (match !== undefined) {
            if (match.id === currentId) return { kind: 'error', text: 'already on this session' }
            switchSession(match.id)
            return { kind: 'success' }
          }
        }
      }
      return openSessionPicker(invocation, 'resume')
    },
  })

  // The skills registry the live agent actually sees: its preset's scoped
  // instance when the preset mounts one (the web surface's serviceFor path),
  // else the host registry. The scope passed to lookups is the AGENT itself,
  // exactly like the host apiproxy's presenterScopeFor — an agent context
  // object does not identity-match the preset's standing mount.
  const skillService = (agent: Agent): { list: (options: { cwd?: string; scope?: object }) => Promise<readonly { name: string; description: string }[]>; get: (name: string, options: { cwd?: string; scope?: object }) => Promise<{ name: string; content?: string; description: string } | undefined> } | undefined => {
    const presets = ctx.get('agentPresets')
    return presets?.serviceFor(agent, 'skills') ?? ctx.get('skills')
  }

  /** The workspace the live session runs in; fallback to the TUI's cwd. */
  const sessionCwd = (agent: Agent): string => agent.session.header.cwd ?? cwd

  // Load one skill into the live session; shared by /skill and the
  // per-skill slash commands.
  const loadSkill = async (agent: Agent, name: string): Promise<{ kind: 'success'; text: string } | { kind: 'error'; text: string }> => {
    const skills = skillService(agent)
    if (skills === undefined) return { kind: 'error', text: 'skill service unavailable' }
    const skill = await skills.get(name, { cwd: sessionCwd(agent), scope: agent })
    if (skill === undefined) return { kind: 'error', text: 'unknown skill "' + name + '"' }
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: 'Skill loaded by the user: **' + skill.name + '**\n\n' + (skill.content ?? skill.description) }],
      source: { kind: 'plugin', plugin: 'tui-skill' },
    }))
    return { kind: 'success', text: 'skill ' + name + ' loaded' }
  }

  // Per-skill slash commands (/glab, /find-skills, ...), pi-style: each
  // catalog skill is directly selectable from the editor autocomplete and
  // injects on Enter. The description carries a [skill] tag so skill rows
  // stand apart from built-in commands. Refreshed by /reload and whenever a
  // session becomes live (the catalog scope is the agent, so the commands
  // only exist once a session does).
  const skillDisposers = new Map<string, () => void>()
  const registerSkillCommands = async (): Promise<number> => {
    // The catalog fetch is async: capture the session generation so a
    // refresh issued for an OLD session (superseded by a switch while the
    // catalog was loading) cannot register commands into — or refresh the
    // completions of — the NEW session's surface.
    const generation = runner.sessionGeneration
    for (const dispose of skillDisposers.values()) dispose()
    skillDisposers.clear()
    const liveAgent = runner.liveAgent
    // No session yet (deferred start): the agent-scoped catalog is
    // unavailable, so the per-skill commands wait for the first session.
    if (liveAgent === undefined) return 0
    const skills = skillService(liveAgent)
    if (skills === undefined) return 0
    const taken = new Set(commands.list(liveAgent).map(command => command.name))
    const catalog = await skills.list({ cwd: sessionCwd(liveAgent), scope: liveAgent })
    // A newer session owns the surface now: this refresh's registrations
    // would clobber or duplicate the newer catalog — drop them silently
    // (the newer session's own refresh is in flight or already applied).
    if (generation !== runner.sessionGeneration) return 0
    for (const skill of catalog) {
      // A colliding name (a built-in or another plugin's command) skips the
      // slash command; the catalog picker still lists the skill.
      if (taken.has(skill.name)) continue
      try {
        const dispose = commands.register({
          name: skill.name,
          description: '[skill] ' + skill.description,
          handler: async () => {
            const agent = await requireAgent()
            return loadSkill(agent, skill.name)
          },
        })
        skillDisposers.set(skill.name, dispose)
      } catch {
        // Registration raced with another plugin; the picker still works.
      }
    }
    refreshCompletions()
    return catalog.length
  }
  // Initial catalog load: fire-and-forget through the unified entry — a
  // failure must land in diagnostics, never be silently swallowed or leak
  // as an unhandled rejection (/reload still awaits the same function).
  detach('skill catalog refresh', registerSkillCommands())

  commands.register({
    name: 'skill',
    description: 'Load a skill into the session context',
    input: { hint: '<name>' },
    handler: async (invocation) => {
      const liveAgent = await requireAgent()
      const skills = skillService(liveAgent)
      if (skills === undefined) return { kind: 'error', text: 'skill service unavailable' }
      const name = invocation.rawInput.trim()
      if (name !== '') return loadSkill(liveAgent, name)
      // No argument: pick from the catalog.
      const catalog = await skills.list({ cwd: sessionCwd(liveAgent), scope: liveAgent })
      if (catalog.length === 0) return { kind: 'error', text: 'no skills available' }
      // SettingsList rows: Enter cycles the value, which fires onChange.
      app.openSettings(
        catalog.map(skill => ({
          id: skill.name,
          label: skill.name,
          description: skill.description,
          currentValue: '',
          values: ['✓'],
        })),
        (id) => {
          detach('skill load', loadSkill(liveAgent, id).then(result => {
            if (result.kind === 'error') app.notify(result.text)
          }), { notify: true })
        },
        () => {},
      )
      return { kind: 'success' }
    },
  })



  commands.register({
    name: 'reload',
    description: 'Reload TUI settings and refresh skill commands',
    handler: async () => {
      // 1. Rebuild the per-skill slash commands from the live catalog.
      let skillCount = 0
      try {
        skillCount = await registerSkillCommands()
      } catch {
        // The catalog read is best-effort; the settings pass still runs.
      }
      // 2. Re-apply the persisted TUI settings (theme, footer, fullscreen),
      // the same policy the runner applies at boot.
      const settings = runner.tuiSettings
      if (settings !== undefined) {
        const doc = settings.get()
        if (doc.theme === 'auto') {
          detach('theme autodetect', app.autoDetectTheme())
        } else if (doc.theme === 'dark' || doc.theme === 'light') {
          app.applyTheme(doc.theme)
        } else if (doc.theme.startsWith('custom:')) {
          const palette = loadCustomTheme(doc.theme.slice('custom:'.length))
          if (palette !== undefined) app.applyPalette(palette)
        }
        app.setFooterPreset(doc.footer === 'compact' ? 'compact' : 'full')
        app.setFullscreen(doc.fullscreen === 'on')
      }
      app.notify(`reloaded — ${skillCount} skills \u00b7 settings reapplied`, 'info')
      return { kind: 'success' }
    },
  })

  commands.register({
    name: 'model',
    description: 'Switch the model (and reasoning effort) for this session',
    handler: async () => {
      const selected = runner.selected
      const llm = ctx.get('llm')
      const defaultModel = ctx.get('agentDefaultModel')
      if (llm === undefined || defaultModel === undefined) return { kind: 'error', text: 'model service unavailable' }
      const providers = llm.listProviders()
      const current = defaultModel.currentSelection()
      /** Commit a selection (model, optional effort) and refresh the footer. */
      const apply = (next: ModelSelection): void => {
        // Persist and reflect with LATEST-WINS semantics: saves run
        // concurrently, so a failure must only roll back when the current
        // selection is still the one THIS save was for — an older failed
        // save must never overwrite a newer successful selection (out-of-
        // order completion must not regress the persistent state either;
        // the UI at least never lies about what is current).
        const previous = selected.current
        runDetached('model selection save', defaultModel.saveSelection(next), {
          diag: runner.diag,
          notify: (message) => {
            if (selected.current === next) {
              selected.current = previous
              runner.refreshStatus()
            }
            app.notify(message, 'error')
          },
          recoverable: () => true,
        })
        selected.current = next
        runner.refreshStatus()
      }
      // The model and effort levels render INSIDE the provider list's
      // submenu slot (ModelSubmenu/EffortSubmenu): selecting applies
      // immediately and Esc walks back one level. A nested openSettings
      // would mount a second overlay and leave the first one hanging
      // (the ghost-overlay trap the /subagents flow documents).
      app.openSettings(
        providers.map(provider => ({
          id: provider.id,
          label: provider.name,
          currentValue: current.provider === provider.id ? current.model : '',
          submenu: (value, done) => new ModelSubmenu(provider.id, current.model, selected.current?.reasoningEffort, {
            listModels: (id) => llm.listModels(id),
            resolveModelInfo: (id, modelId) => llm.resolveModelInfo(id, modelId),
            apply,
            requestRender: () => app.requestRender(),
            done,
            // Late model-list/info rejections after the menu closed are
            // diagnostics, not user errors: the shared runner channel.
            logDebug: (message, fields) => runner.diag.debug(message, fields),
          }),
        })),
        () => {},
        () => {},
      )
      return { kind: 'success' }
    },
  })

  commands.register({
    name: 'new',
    description: 'Start a fresh session in this workspace',
    handler: async () => {
      const liveAgent = runner.liveAgent
      const composition = await runner.compose()
      const presetId = composition.agentPreset
      const next = await runner.agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: metaOf(cwd, presetId),
        // Before the first session the process-wide selection stands in.
        agentOptions: {
          provider: liveAgent?.options.provider ?? runner.selected.current?.provider,
          model: liveAgent?.options.model ?? runner.selected.current?.model,
        },
        setup: composition.setup,
      })
      const error = await runner.swapTo(next)
      if (error !== undefined) app.notify(error, 'error')
      return { kind: 'success', text: 'started a fresh session' }
    },
  })

  commands.register({
    name: 'queue',
    description: 'Manage queued input: edit, delete, steer, or insert',
    handler: async () => {
      const liveAgent = await requireAgent()
      const inbox = liveAgent.inbox
      // Each row remembers which pending list it lives in, so "Insert
      // before" can splice at the exact spot instead of prepending to the
      // head of the queue.
      const queued = [
        ...inbox.nextTurn.map((message, index) => ({ message, slot: `next ${index + 1}`, list: 'next-turn' as const })),
        ...inbox.nextStep.map((message, index) => ({ message, slot: `steer ${index + 1}`, list: 'next-step' as const })),
      ]
      if (queued.length === 0) return { kind: 'success', text: 'no queued input' }
      // The pane covers the fine-grained verbs; the queue strip above the
      // editor handles the at-a-glance view and Alt+↑ pulls everything back.
      app.openSettings(
        queued.map(({ message, slot }) => ({
          id: message.id,
          label: `[${slot}] ${textOf(message.content).replace(/\s+/g, ' ').trim().slice(0, 40)}`,
          description: message.id,
          currentValue: '',
          submenu: (value, done) => new SettingsList(
            [
              { id: 'edit', label: 'Edit', description: 'Rewrite this queued message', currentValue: '', values: ['✓'] },
              { id: 'delete', label: 'Delete', description: 'Remove it from the queue', currentValue: '', values: ['✓'] },
              { id: 'steer', label: 'Steer', description: 'Send it now: into the running turn, or start one when idle', currentValue: '', values: ['✓'] },
              { id: 'insert', label: 'Insert before', description: 'Queue a new message ahead of this one', currentValue: '', values: ['✓'] },
            ],
            6,
            settingsListTheme(),
            (action) => done(action),
            () => done(),
            {},
          ),
        })),
        (id, action) => {
          const target = queued.find(item => item.message.id === id)
          if (target === undefined) return
          const message = target.message
          if (action === 'delete') {
            inbox.remove(message.id)
            app.notify('queued message deleted', 'info')
          } else if (action === 'steer') {
            // Mirrors Ctrl+S on a single message: a running turn takes the
            // steer immediately; an idle agent starts a fresh turn with it.
            inbox.remove(message.id)
            if (liveAgent.status === 'running') {
              liveAgent.steer(message)
            } else {
              liveAgent.followup(message)
            }
            app.notify('steering queued message', 'info')
          } else if (action === 'edit' || action === 'insert') {
            // The free-text question flow collects the replacement/new text;
            // every mutation commits an inbox splice that refreshes the pane.
            void app.askQuestions([{ id: 'q', question: action === 'edit' ? 'Edit queued message:' : 'New message to insert:' }])
              .then(answers => {
                const text = answers[0]?.custom?.trim() ?? ''
                if (text === '') return
                const next = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
                if (action === 'edit') {
                  inbox.replace(message.id, next)
                  app.notify('queued message updated', 'info')
                } else {
                  // Insert at the selected message's CURRENT position: the
                  // queue may have shifted while the panel was open (a claim
                  // or another splice), so re-locate instead of trusting the
                  // snapshot index. A consumed message has nothing left to
                  // insert before.
                  const list = target.list === 'next-turn' ? inbox.nextTurn : inbox.nextStep
                  const position = list.findIndex(item => item.id === message.id)
                  if (position < 0) return
                  inbox.splice(target.list, position, 0, [next])
                  app.notify('message inserted before the selected one', 'info')
                }
              })
              .catch(() => {
                // The user cancelled the edit; the queue stays untouched.
              })
          }
        },
        () => {},
      )
      return { kind: 'success' }
    },
  })

  commands.register({
    name: 'tasks',
    description: 'List background jobs for this session',
    handler: async () => {
      const liveAgent = await requireAgent()
      const jobs = ctx.get('jobs')
      if (jobs === undefined) return { kind: 'error', text: 'jobs service unavailable' }
      const snapshots = jobs.list(liveAgent)
      if (snapshots.length === 0) return { kind: 'error', text: 'no background jobs' }
      const now = Date.now()
      app.openPicker(
        snapshots.map(job => ({
          value: job.id,
          label: `${job.kind} · ${job.label}`,
          description: `${job.status}${job.detail === undefined ? '' : ` — ${job.detail}`} · ${Math.max(0, Math.floor((now - job.startedAt) / 1000))}s`,
        })),
        () => {},
        () => {},
      )
      return { kind: 'success' }
    },
  })

  // `/permission` is NOT registered here: dsh-permission-presets in the
  // base layer already registers it (text form: `/permission` shows the
  // current preset, `/permission <name>` switches). Registering it again
  // would throw "command already registered" and kill the TUI.
  // `/yolo` IS a TUI-owned alias: it delegates to the official command line,
  // so the switch takes the exact official path (sandbox + live approval
  // writer + the injected policy-change model message + the preset log).
  commands.register({
    name: 'yolo',
    description: 'Switch to danger-full-access (alias of /permission danger-full-access)',
    handler: async () => {
      const liveAgent = await requireAgent()
      const commands = ctx.get('commands')
      if (commands === undefined) return { kind: 'error', text: 'commands service unavailable' }
      const execution = await commands.execute(liveAgent, '/permission danger-full-access', signal)
      if (execution === undefined) {
        return { kind: 'error', text: '/permission unavailable (permission presets not composed)' }
      }
      return { kind: 'success', text: 'danger-full-access — approvals off' }
    },
  })

  // `/preset` IS TUI-owned: the base composes no roster and registers no
  // preset command, so this cannot collide (P5.7 lesson, positive case).
  commands.register({
    name: 'preset',
    description: 'Show or switch the session agent preset',
    input: { hint: '[status|<id>|default [<id>]]' },
    handler: async (invocation) => {
      const liveAgent = await requireAgent()
      const presets = ctx.get('agentPresets')
      if (presets === undefined) {
        return { kind: 'error', text: 'agent presets unavailable in this deployment' }
      }
      const current = presets.composedPreset(liveAgent.ctx) ?? resolveSessionPreset(liveAgent.session)
      const matched = invocation.rawInput.trim().match(/^(\S+)(?:\s+(.*))?$/)
      const verb = matched?.[1] ?? ''
      const rest = matched?.[2]?.trim() ?? ''
      if (verb === 'status') {
        return { kind: 'success', text: `preset: ${current ?? 'none'} · default: ${presets.defaultId}` }
      }
      if (verb === 'default') {
        const settings = ctx.get('settings')
        if (settings === undefined) return { kind: 'error', text: 'settings service unavailable' }
        const ns = settingsNamespace('agent-presets')
        if (rest === '') {
          const doc = settings.get(ns) as { default?: string } | undefined
          return { kind: 'success', text: `default preset: ${doc?.default ?? presets.defaultId}` }
        }
        await settings.mutate(ns, [{ op: 'set', path: ['default'], value: rest }])
        return { kind: 'success', text: `default preset set: ${rest}` }
      }
      if (verb !== '') {
        // Selecting swaps the composition; only a blank session (no turn
        // has run yet) may do so — a started conversation's history was
        // produced under its preset's tools. Same rule as the official
        // `agentPreset.select` RPC and the launch-time --preset path.
        try {
          const outcome = await runner.recomposeBlank(verb)
          if (outcome.kind === 'locked') {
            return {
              kind: 'error',
              text: `session "${liveAgent.session.id}" has already started; its agent preset is fixed`,
            }
          }
          refreshCompletions()
          // A still-blank session's welcome card shows the preset: repaint it
          // so the switch is visible before any conversation starts.
          runner.updateWelcomeCard()
          return { kind: 'success', text: `session preset switched to ${outcome.preset}` }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      }
      const roster = await presets.list()
      if (roster.length === 0) return { kind: 'success', text: 'no agent presets configured' }
      app.openSettings(
        roster.map(preset => ({
          id: preset.id,
          label: preset.name === undefined ? preset.id : `${preset.name} (${preset.id})`,
          description: [
            preset.trust === 'system' ? 'system' : 'user',
            preset.id === presets.defaultId ? 'default' : undefined,
            preset.id === current ? '← current' : undefined,
            preset.broken,
          ].filter(Boolean).join(' · '),
          currentValue: '',
        })),
        () => {},
        () => {},
      )
      return { kind: 'success' }
    },
  })

  commands.register({
    name: 'subagents',
    description: 'List child agents; view a transcript or interrupt one',
    handler: async () => {
      const liveAgent = await requireAgent()
      const subagents = ctx.get('subagents')
      if (subagents === undefined) return { kind: 'error', text: 'subagent service unavailable' }
      const children = (await subagents.listChildren(liveAgent.session.id))
        .filter(child => child.kind === 'child')
      if (children.length === 0) return { kind: 'success', text: 'no subagents for this session' }
      const labelOf = (child: (typeof children)[number]): string => child.label ?? child.id
      app.openSettings(
        children.map(child => ({
          id: child.id,
          label: labelOf(child),
          description: `${child.mode} · ${child.activity}${child.hasChildren ? ' · has children' : ''}`,
          currentValue: '',
          // The submenu is rendered INSIDE the list (SettingsList mounts
          // the returned component in place); picking an action reports
          // it through the list's onChange. Opening a second panel here
          // would leave this list mounted as a ghost overlay that eats
          // every later Esc.
          submenu: (value, done) => new SettingsList(
            [
              { id: 'view', label: 'View transcript', description: 'Watch this session read-only (Esc to return)', currentValue: '', values: ['✓'] },
              { id: 'interrupt', label: 'Interrupt', description: 'Cancel the child agent', currentValue: '', values: ['✓'] },
            ],
            6,
            settingsListTheme(),
            // The action is the row ID; the cycled value is a checkmark.
            (id) => done(id),
            () => done(),
            {},
          ),
        })),
        (childId, action) => {
          const child = children.find(candidate => candidate.id === childId)
          if (child === undefined) return
          if (action === 'view') {
            detach('subagent view', runner.enterView(child.id, labelOf(child)), { notify: true })
          } else if (action === 'interrupt') {
            subagents.interrupt(child.id, { kind: 'user', parentSessionId: liveAgent.session.id })
            app.notify(`interrupting ${labelOf(child)}`, 'info')
          }
        },
        () => {},
      )
      return { kind: 'success' }
    },
  })

  commands.register({
    name: 'search',
    description: 'Search persisted sessions for text and switch to a hit',
    input: { hint: '<query>' },
    handler: async (invocation) => {
      const currentId = runner.liveAgent?.session.id
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) return { kind: 'error', text: 'session persistence unavailable' }
      const query = invocation.rawInput.trim()
      if (query === '') return { kind: 'error', text: 'search needs a query' }
      const needle = query.toLowerCase()
      const headers = (await persistence.list())
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 100)
      const hits: { id: string; createdAt: number; snippet: string }[] = []
      for (const header of headers) {
        let raw: { content: string } | undefined
        try {
          raw = await persistence.readRaw(header.id)
        } catch {
          continue
        }
        if (raw === undefined) continue
        const index = raw.content.toLowerCase().indexOf(needle)
        if (index === -1) continue
        const start = Math.max(0, index - 40)
        const snippet = raw.content.slice(start, index + query.length + 40).replace(/\s+/g, ' ').trim()
        hits.push({ id: header.id, createdAt: header.createdAt, snippet })
        if (hits.length >= 20) break
      }
      if (hits.length === 0) return { kind: 'success', text: `no persisted session contains "${query}"` }
      const now = Date.now()
      app.openPicker(
        hits.map(hit => ({
          value: hit.id,
          label: hit.id.length > 26 ? `${hit.id.slice(0, 26)}…` : hit.id,
          description: `${Math.max(0, Math.floor((now - hit.createdAt) / 60000))}m ago · …${hit.snippet}…`,
        })),
        (id) => {
          if (id === currentId) return
          switchSession(id)
        },
        () => {},
      )
      return { kind: 'success' }
    },
  })

  commands.register({
    name: 'title',
    description: 'Set or show the session title',
    input: { hint: '<title>' },
    handler: async (invocation) => {
      const liveAgent = await requireAgent()
      const titles = ctx.get('sessionTitle')
      if (titles === undefined) return { kind: 'error', text: 'session title service unavailable' }
      const name = invocation.rawInput.trim()
      if (name === '') {
        const current = titles.get(liveAgent.session)
        return { kind: 'success', text: current === undefined ? 'no title set' : `title: ${current.title}` }
      }
      titles.rename(liveAgent.session, name)
      return { kind: 'success', text: `title set: ${name}` }
    },
  })

  commands.register({
    name: 'copy',
    description: 'Copy the last assistant message (OSC 52 clipboard)',
    handler: async () => {
      const liveAgent = await requireAgent()
      const last = liveAgent.session.events.findLast((event): event is SessionEvent<'assistant/message'> =>
        event.type === 'assistant/message')
      if (last === undefined) return { kind: 'error', text: 'no assistant message yet' }
      const text = last.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (text === '') return { kind: 'error', text: 'last assistant message has no text' }
      if (process.stdout.isTTY !== true) return { kind: 'error', text: 'clipboard needs a TTY (OSC 52)' }
      process.stdout.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`)
      return { kind: 'success', text: 'copied last assistant message' }
    },
  })

  commands.register({
    name: 'export',
    description: 'Export this session log (JSONL by default, `md` for a readable transcript)',
    input: { hint: '[md|<path>]' },
    handler: async (invocation) => {
      const liveAgent = await requireAgent()
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) return { kind: 'error', text: 'session persistence unavailable' }
      const arg = invocation.rawInput.trim()
      const shortId = liveAgent.session.id.replace(/^session-/, '').slice(0, 8)
      const markdown = arg === 'md'
      const target = arg !== '' && !markdown
        ? arg
        : join(cwd, markdown ? `dsh-session-${shortId}.md` : `dsh-session-${shortId}.jsonl`)
      try {
        if (markdown) {
          writeFileSync(target, renderTranscriptMarkdown(liveAgent.session))
          return { kind: 'success', text: `exported markdown transcript to ${target}` }
        }
        // The raw artifact is the backend's verbatim JSONL (decoded from
        // its physical encoding) — a faithful, portable session log.
        const raw = await persistence.readRaw(liveAgent.session.id)
        if (raw === undefined) return { kind: 'error', text: 'no materialized session log to export' }
        writeFileSync(target, raw.content)
        return { kind: 'success', text: `exported ${raw.filename} to ${target}` }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  commands.register({
    name: 'fork',
    description: 'Fork this session at the last completed turn',
    handler: async () => {
      const liveAgent = runner.liveAgent
      const seed = liveAgent === undefined ? undefined : forkSeed(liveAgent.session.events)
      if (seed === undefined) return { kind: 'error', text: 'no completed turn to fork from' }
      // The child inherits the parent's recorded preset (official fork
      // semantics: forkComposition = composeAgent(resolveSessionPreset(source))).
      const composition = await runner.compose(resolveSessionPreset(liveAgent!.session))
      const presetId = composition.agentPreset
      const next = await runner.agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: { ...metaOf(cwd, presetId), parentSession: liveAgent!.session.id, seedLength: seed.length },
        agentOptions: { provider: liveAgent!.options.provider, model: liveAgent!.options.model },
        setup: composition.setup,
        seed,
      })
      const error = await runner.swapTo(next)
      if (error !== undefined) app.notify(error, 'error')
      return { kind: 'success', text: `forked as ${next.agent.session.id}` }
    },
  })

  commands.register({
    name: 'status',
    description: 'Show session stats and identity',
    handler: async () => {
      const liveAgent = await requireAgent()
      const stats = computeStats(liveAgent.session.events)
      let contextTokens: number | undefined
      const meter = ctx.get('tokenMeter')
      if (meter !== undefined) {
        try {
          contextTokens = meter.measure(liveAgent.session).totalTokens
        } catch {
          // Measurement is best-effort; the panel falls back to unmeasured.
        }
      }
      app.openSettings(
        [
          {
            id: 'session-id',
            label: color.textDim('Session'),
            description: color.textDim(liveAgent.session.id),
            currentValue: color.textDim(displaySessionId(liveAgent.session.id)),
          },
          { id: 'session-stats', label: 'Stats', description: formatStats(stats), currentValue: '' },
          {
            id: 'session-context',
            label: 'Context',
            description: contextTokens === undefined ? 'unmeasured' : `${Math.round(contextTokens / 1000)}k tokens in window`,
            currentValue: '',
          },
        ],
        () => {},
        () => {},
      )
      return { kind: 'success' }
    },
  })

  commands.register({
    name: 'login',
    description: 'Set an API key credential for a provider (default DEEPSEEK_API_KEY)',
    input: { hint: '[<env-var>]' },
    handler: async (invocation) => {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) return { kind: 'error', text: 'credentials service unavailable' }
      const ref = (invocation.rawInput.trim() || 'DEEPSEEK_API_KEY').toUpperCase()
      try {
        const answers = await app.askQuestions([
          { id: 'key', question: `Paste the API key for ${ref}:` },
        ])
        const key = answers[0]?.custom ?? ''
        if (key === '') return { kind: 'error', text: 'empty key; nothing set' }
        await credentials.set(ref as CredentialRef, key)
        return { kind: 'success', text: `${ref} set` }
      } catch {
        return { kind: 'error', text: 'login cancelled' }
      }
    },
  })

  commands.register({
    name: 'logout',
    description: 'Clear a stored API key credential (default DEEPSEEK_API_KEY)',
    input: { hint: '[<env-var>]' },
    handler: async (invocation) => {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) return { kind: 'error', text: 'credentials service unavailable' }
      const ref = (invocation.rawInput.trim() || 'DEEPSEEK_API_KEY').toUpperCase()
      await credentials.unset(ref as CredentialRef)
      return { kind: 'success', text: `${ref} cleared` }
    },
  })

  commands.register({
    name: 'help',
    description: 'Show keybindings and available commands',
    handler: () => {
      const rows: SettingItem[] = [        { id: 'k-enter', label: 'Enter', description: 'Submit (slash commands dispatch without a model turn)', currentValue: '' },
        { id: 'k-exit', label: 'Ctrl+C / Ctrl+D', description: 'Quit the TUI (flushes the session)', currentValue: '' },
        { id: 'k-cancel', label: 'Double-Esc', description: 'Cancel the active turn / tool / shell command', currentValue: '' },
        { id: 'k-fold', label: 'Ctrl+O', description: 'Expand/collapse recent tool output and thinking', currentValue: '' },
        { id: 'k-todo', label: 'Ctrl+T', description: 'Toggle the todo panel', currentValue: '' },
        { id: 'k-think', label: 'Alt+T', description: 'Hide/show thinking blocks', currentValue: '' },
        { id: 'k-steer', label: 'Ctrl+S', description: 'Steer the running turn with the draft', currentValue: '' },
        { id: 'k-editor', label: 'Ctrl+G', description: 'Edit the draft in $VISUAL/$EDITOR', currentValue: '' },
        { id: 'k-search', label: 'Ctrl+F', description: 'Search the transcript (Enter/Shift+Enter jump, Esc closes)', currentValue: '' },
        { id: 'k-tab', label: 'Tab', description: 'Autocomplete slash commands and file paths', currentValue: '' },
        { id: 'k-hist', label: '↑/↓', description: 'Recall input history on an empty line', currentValue: '' },
        { id: 'k-bang', label: '! cmd', description: 'Run a shell command locally; !! sends it to the model', currentValue: '' },
        { id: 'sep-help', label: color.border('─'.repeat(34)), currentValue: '' },
        ...commands.list(runner.liveAgent as unknown as Agent).map(command => ({
          id: `cmd-${command.name}`,
          label: `/${command.name}`,
          description: command.description,
          currentValue: '',
        })),
      ]
      app.openSettings(rows, () => {}, () => {})
      return { kind: 'success' }
    },
  })

  // All TUI commands are registered now; include them in completion.
  refreshCompletions()
  // The per-skill commands live on the agent-scoped catalog, so they can
  // only be built once a session exists; the runner calls this again after
  // the first session is created (see initLiveSession).
  return { refreshSkills: () => registerSkillCommands() }
}
