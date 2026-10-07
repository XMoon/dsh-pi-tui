/**
 * StatusRuntime (A5b-2, plan §A5b-2): the ONE owner of the surface status
 * derivation and the session context-measurement cache.
 *
 * Ownership:
 *
 * - the footer/status derivation (composition/workspace/host sections, the
 *   model label, the display-subject projection) and the cheap commit into the
 *   surface status store;
 * - the session-bound context-measurement coordinator: the cached value, the
 *   dirty classification, the explicit force and the deferred initial measure
 *   with its generation/session fence;
 * - the session workspace read (`sessionCwd`), the terminal-title write, the
 *   welcome card and the session goal text.
 *
 * The module is deliberately neutral: it imports no Host session/agent package
 * and performs no Host lookup. The official DSH facts it derives from arrive
 * through narrow injected capabilities (the live-agent read, the session
 * reader port, the official derivation-helper inputs, the session-title fold),
 * so the Direct adapter stays the only place that maps official semantics onto
 * the in-process implementation.
 * @module @xmoon76/dsh-pi-tui/app/surface/status-runtime
 */

import { runOwned } from '../../runtime/process/tasks.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import { bundleVersion, dshVersion } from '../../client/launcher/version.ts'
import { versionDisplay } from './version-display.ts'
import { gitBranch } from '../../client/git/branch.ts'
import type { ModelSelectionValue } from '../../domain/session/model-selection.ts'
import { contextPressureOccupancy } from '../../runtime/session-reader-port.ts'
import { StatsFolder } from '../../domain/status/stats.ts'
import { ContextMeasurementCoordinator, deferInitialContextMeasure, type ContextMeasureReason } from '../../domain/status/context-measurement.ts'
import { deriveAccessStatus, type AccessDeriveDeps } from '../../domain/status/derive-access.ts'
import { foldGoal, goalTextOf } from '../../domain/status/derive-goal.ts'
import { derivePlanStatus, deriveRemotePlanStatus, type PlanModeLike, type PlanProjectionLike } from '../../domain/status/derive-plan.ts'
import { deriveRunnerPermission } from '../../domain/status/derive-permission.ts'
import { usageFromStats } from '../../domain/status/derive-usage.ts'
import { plainSectionEqual } from '../../domain/status/equal.ts'
import { resolveDisplaySubject } from '../../domain/status/resolve-subject.ts'
import type { CompositionStatus, HostStatus, StatusPatch, StatusSnapshot, ViewStatus, WorkspaceStatus } from '../../domain/status/types.ts'
import { setTerminalTitle, terminalTitleOf } from '../../terminal-title.ts'
import type { StatusData, TuiApp } from '../../tui-app.ts'

/** The live-agent facts the status derivation reads. */
export interface StatusLiveAgent {
  readonly session: {
    readonly id: string
    readonly header: { readonly cwd?: string }
  }
  readonly options: { readonly provider?: string; readonly model?: string }
}

/** The official Host service values the derivation helpers consume; the
 *  composition root performs the lookups and injects them here. */
export interface StatusHostFacts extends AccessDeriveDeps {
  readonly planMode: PlanModeLike | undefined
  readonly sessionProjections: PlanProjectionLike | undefined
}

/** The semantic apply outcome of one permission-cycle write (§6.3; the
 *  semantic port type re-exported for the authority bundle consumers). */
export type PermissionCycleApplyOutcome = import('../../runtime/config-port.ts').PermissionPresetApplyOutcome

/**
 * The genuinely Remote-only official Session facts (M3-4 PR2): when the
 * selected runtime is Remote there is no live Direct Agent, so the owner
 * reads the transport-specific projections through this bundle instead.
 * Every read is `undefined`-total — an unavailable projection stays absent,
 * never a guessed value and never another session's fact.
 *
 * The SessionStatus projection is deliberately NOT here: it is one semantic
 * read shared by both branches (`StatusRuntimeDeps.sessionStatus`, bound to
 * `SessionReader.sessionStatus`).
 */
export interface StatusRemoteFacts {
  /** The official `plan` projection wire view of THIS session. */
  readonly plan: (sessionId: string | undefined) => { readonly active: boolean; readonly pending: boolean } | undefined
}

/** The narrow surface capabilities the status owner needs. */
export interface StatusSurface {
  readonly app: TuiApp
  readonly status: { snapshot(): StatusSnapshot }
  /** ONE atomic display-subject commit (M3-5 PR1 §9.7): the store patch
   *  (including `view`), the legacy display fields and the presentation
   *  projection describe the SAME subject. */
  commitStatus(
    patch: StatusPatch,
    /** The LIVE session's legacy display fields (always the live owner's —
     *  never the display subject's when a child is displayed). */
    legacyFacts: Partial<StatusData>,
    presentation: import('../../tui-app.ts').DisplaySubjectPresentation | undefined,
  ): void
}

/** The narrow capabilities the status owner consumes. Nothing here is a Host
 *  lookup: the composition root maps each one onto the current in-process
 *  owner. */
export interface StatusRuntimeDeps {
  /** The mounted surface owner (status store + commit coordination + app). */
  readonly surface: StatusSurface
  /** True once the runner is disposing: no refresh may commit. */
  readonly isCleanedUp: () => boolean
  /** The live agent of the current owner, or undefined. */
  readonly liveAgent: () => StatusLiveAgent | undefined
  /** The current ownership generation (the deferred-measure fence). */
  readonly generation: () => number
  /** The current owner session id (the deferred-measure fence). */
  readonly currentSessionId: () => string | undefined
  /** The semantic session reader port (context measurement). */
  readonly measureContext: (sessionId: string) => number | undefined
  /**
   * The ONE Session-scoped status read (M3-5 PR1): the official detached
   * Session facts of the EXPLICIT subject session, on both branches. The
   * caller owns subject SELECTION (main vs viewed child); this capability
   * only answers for the id it is given — `undefined` is "unavailable",
   * never "infer the subject from global state".
   */
  readonly sessionStatus: (sessionId: string) => import('../../runtime/session-reader-port.ts').SessionStatusProjection | undefined
  /** The model-selection facts (the command/model owner replaces this). */
  readonly model: {
    readonly selection: () => ModelSelectionValue | undefined
    readonly currentOf: (agent: StatusLiveAgent) => ModelSelectionValue | undefined
    readonly defaultSelection: () => ModelSelectionValue | undefined
    readonly marker: () => { readonly selection: ModelSelectionValue; readonly status: 'pending' | 'unresolved' } | undefined
    readonly preset: () => string | undefined
  }
  /** The official Host service values for the derivation helpers. */
  readonly host: () => StatusHostFacts
  /**
   * The Remote-branch official Session facts (M3-4 PR2): absent on Direct.
   * When present, the owner prefers these projection reads for the
   * Agent-shaped facts (cwd/model/preset/plan) — never `agent.options`.
   */
  readonly remote?: StatusRemoteFacts
  /** The live-session presentation owner (the legacy stats facts). */
  readonly presentation: {
    readonly mainStats: () => StatsFolder
    /** PR5 (plan §3.2): whether the main fold's RECENT-performance figures
     *  are authoritative (Direct full log, or a proven Remote window). When
     *  `false` the usage section OMITS the two recent metrics — never a
     *  numeric `0s · 0 tok/s` stand-in for unknown evidence. */
    readonly mainRecentPerformanceAvailable?: () => boolean
  }
  /** The viewer owner: the viewed child's IDENTITY + presentation facts, or
   *  `undefined` when no child viewer is mounted. Only the display-subject
   *  SELECTOR reads this — the Session-owned facts come from
   *  `sessionStatus(viewed.id)`. */
  readonly viewer: {
    readonly read: () => {
      readonly id: string
      readonly label: string
      readonly mode: 'one-shot' | 'continuable'
      readonly activity: 'running' | 'inactive'
      readonly cwd: string
      readonly stats: StatsFolder
    } | undefined
  }
  /** The diagnostics channel for OWNED async operations (the permission
   *  cycle's runOwned settlement; see docs/failure-model.md). */
  readonly diag: Diag
  /** The resolved CLIENT working directory (a composition prerequisite). */
  readonly clientCwd: string
  /**
   * The permission-cycle authority (M3-4 PR4 §6.2/§6.3): the current value
   * is the SESSION STATUS PROJECTION's permission field (projection-
   * authoritative); the options come from the ConfigPort preset catalog;
   * the write goes through ConfigPort.permissions.applyPermissionPreset.
   * Absent = the cycle capability is unavailable on this composition.
   */
  readonly permissionCycle?: {
    /** The captured live scope (the ownership fence for the write). */
    captureLiveScope(): import('../session/scope.ts').LiveSessionScope | undefined
    isScopeCurrent(scope: import('../session/scope.ts').LiveSessionScope): boolean
    /** Capture the Remote transport identity (Connection generation + exact
     *  binding) at gesture admission. `undefined` = the Direct branch (no
     *  transport fence; the scope fence above is the whole owner check). */
    captureTransportToken(): unknown
    /** Whether the captured transport identity is still live (a same-id
     *  binding rollover without a TUI owner commit reads stale). Always
     *  `true` when no token was captured (Direct). */
    isTransportTokenCurrent(token: unknown): boolean
    /** The projection-authoritative current permission of the CURRENT
     *  session (absent = unavailable — never guessed). */
    currentPermission(): string | undefined
    /** The advertised preset names, in cycle order. */
    presetNames(): readonly string[]
    /** The semantic write (ConfigPort → the official Host command path). An
     *  `indeterminate` outcome means the write was DISPATCHED but its settle
     *  is unobservable (e.g. a post-dispatch transport cancellation) — it is
     *  never silently downgraded to `unavailable`, never retried. */
    apply(sessionId: string, presetId: string, signal?: AbortSignal): Promise<PermissionCycleApplyOutcome>
  }
}

/** The status owner as the rest of the application consumes it. */
export interface StatusRuntime {
  /** Repaint the welcome card from the live agent's current facts. */
  updateWelcomeCard(): void
  /** The LIVE session's workspace (header cwd, else the client cwd). */
  sessionCwd(): string
  /** Derive + write the terminal window title. */
  refreshTerminalTitle(): void
  /**
   * Derive + forward the terminal-LOCAL cwd (OSC 7, plan §4.3): the eligible
   * Direct Session header cwd, else the Direct launch cwd. A Remote Host cwd
   * is never forwarded — the pane belongs to the Client machine. The TUI owns
   * the actual terminal write.
   */
  refreshTerminalCwd(): void
  /** The cheap footer/status refresh (never measures context). */
  refresh(): void
  /**
   * Cycle the live session's permission preset (Shift+Tab / the semantic
   *  `cycle-permission` action). M3-4 PR4 §6.3: an OWNED async operation —
   *  capture the scope, read the projection-authoritative current value,
   *  read the ConfigPort catalog, compute next, write through
   *  ConfigPort.permissions.applyPermissionPreset; after the await a stale
   *  owner repaints NOTHING for the replacement session, an unavailable
   *  outcome surfaces truthfully, and an applied outcome does NOT install
   *  the next value locally (the pushed `permissions` projection repaints
   *  the footer). No automatic retry after an ambiguous outcome.
   */
  cyclePermission(): void
  /** Mark the cached context measurement dirty (model-visible events only). */
  markContextDirty(): void
  /** Measure through the semantic reader and repaint cheaply. */
  refreshContextMeasurement(reason: ContextMeasureReason): void
  /** The explicit /status force; returns the measured value. */
  forceContextMeasurement(): number | undefined
  /** Schedule the deferred initial/post-switch measurement for one session. */
  scheduleInitialMeasurement(sessionId: string): void
  /** Cancel a pending deferred measurement (disposal). */
  cancelDeferred(): void
  /** Set the session goal text (presentation hydration). */
  setGoal(text: string | undefined): void
  /** Fold one `goal/change` event into the session goal text. */
  applyGoalChange(event: { readonly type: string; readonly data: unknown }): void
}

/** The model label vocabulary (one formatting rule for main and child). */
function modelLabelOf(selection: {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}): string {
  const base = `${selection.provider ?? ''}/${selection.model ?? ''}`
  return selection.reasoningEffort === undefined ? base : `${base} @${selection.reasoningEffort}`
}

/** The one detached Session-status DTO the display-subject derivation reads. */
type DisplaySessionStatus = import('../../runtime/session-reader-port.ts').SessionStatusProjection

/** The child display subject's composition section: the child SessionStatus'
 *  own model/preset ONLY. An absent child fact stays ABSENT — never the
 *  parent's model, never the sessionless default and never the child Agent's
 *  options (M3-5 PR1 §9.4). */
function childCompositionStatus(status: DisplaySessionStatus | undefined): CompositionStatus {
  if (status === undefined) return {}
  const model = status.model
  return {
    ...model === undefined ? {} : {
      model: {
        provider: model.provider,
        id: model.model,
        displayName: model.model,
        ...model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort },
      },
    },
    ...status.preset === undefined ? {} : { agentPreset: { id: status.preset, label: status.preset } },
  }
}

/** The child display subject's access section: the projection-authoritative
 *  permission preset ONLY. The parent's sandbox/approval/permission state must
 *  never ride a child surface; an absent child permission is OMITTED. */
function childAccessStatus(status: DisplaySessionStatus | undefined): {
  permissionPreset?: { id: string; label: string; matched: boolean }
} {
  const permission = status?.permission
  return permission === undefined
    ? {}
    : { permissionPreset: { id: permission, label: permission, matched: true } }
}

/** The child display subject's goal badge text: an absent projection and the
 *  legal `null` (no goal) both render no badge — never the parent's goal. */
function childGoalText(status: DisplaySessionStatus | undefined): string | undefined {
  if (status === undefined || !('goal' in status)) return undefined
  const goal = status.goal
  return goal === undefined || goal === null ? undefined : goalTextOf(goal)
}

/** Create the status owner (plan §A5b-2). */
export function createStatusRuntime(deps: StatusRuntimeDeps): StatusRuntime {
  /**
   * The opening-session JOURNAL (A2 seam; the concrete state is A4 surface
   * ownership — `surface.openingJournal`). Presentation-only: it fences which
   * pre-commit events belong to the target being opened, and `initLiveSession`
   * merges its cut into the cold hydration. The mutable event array stays
   * PRIVATE behind the surface module's API; callers only ever hold the opaque
   * identity token, and read events through `cut`.
   */
   
  let goalText: string | undefined

  /** Repaint the welcome card from the live agent's current facts. Re-read
   * on every call so a still-blank session's preset switch shows up. */
  
  /** The MAIN subject's shared Session-status read (the Remote branch's
   *  Agent-less session; a sessionless surface answers `undefined`). */
  const mainSessionStatus = (): import('../../runtime/session-reader-port.ts').SessionStatusProjection | undefined => {
    const sessionId = deps.currentSessionId()
    return sessionId === undefined ? undefined : deps.sessionStatus(sessionId)
  }

  const updateWelcomeCard = (): void => {
    const agent = deps.liveAgent()
    if (agent === undefined) {
      // A Remote-branch live session still owns the welcome card: its facts
      // come from the official Session-scoped projections (never a parent
      // fallback, never guessed defaults).
      const facts = deps.remote === undefined ? undefined : mainSessionStatus()
      if (facts === undefined) {
        deps.surface.app.setWelcomeIdle(true)
        return
      }
      deps.surface.app.setWelcomeCard({
        cwd: facts.cwd ?? '',
        sessionId: facts.sessionId,
        // F2/PR5 truthfulness: an ABSENT `model` projection fact is
        // UNAVAILABLE, never an authoritative "unconfigured" business value —
        // the fact is omitted and the card renders no model line.
        ...facts.model === undefined
          ? {}
          : { model: `${facts.model.provider}/${facts.model.model}` },
        version: versionDisplay(),
        ...facts.preset === undefined ? {} : { preset: facts.preset },
      })
      return
    }
    const current = deps.model.selection()
    const provider = current?.provider ?? agent.options.provider
    const model = current?.model ?? agent.options.model
    deps.surface.app.setWelcomeCard({
      cwd: sessionCwd(),
      sessionId: agent.session.id,
      model: `${provider}/${model}`,
      version: versionDisplay(),
      ...deps.model.preset() === undefined ? {} : { preset: deps.model.preset() },
    })
  }

  /**
   * The LIVE session's workspace: each session carries its own header cwd
   * (fixed at creation, e.g. a session birthed by the web in another
   * directory). The footer/welcome/completions AND `!`/`!!` shell runs
   * follow THIS cwd, so a session switch moves the whole surface with the
   * session (pi parity: `executeBash` runs in the session cwd) and a
   * shell command executes where the completions suggest files; `cwd`
   * (the process cwd) stays for launch-relative concerns (/export paths).
   */
  
  /**
   * The OFFICIAL cwd fact of the live session (Remote branch: the list-row
   * cwd). `undefined` when a LIVE session's official row carries none —
   * the status presentation then OMITS the cwd fact rather than copying the
   * Client cwd (Host/Client cwd equivalence is forbidden). Never consumed
   * by execution paths (the shell/history owners keep their own fallback).
   */
  const sessionCwdFact = (): string | undefined => {
    const agent = deps.liveAgent()
    if (agent !== undefined) return agent.session.header.cwd
    if (deps.remote !== undefined) {
      const sessionId = deps.currentSessionId()
      if (sessionId === undefined) return deps.clientCwd
      return deps.sessionStatus(sessionId)?.cwd
    }
    return deps.clientCwd
  }

  /**
   * The EXECUTION cwd (shell runs, history scoping): the official session
   * cwd when known, else the CLIENT cwd — a Client-local execution fallback,
   * never presented as the session's own workspace fact.
   */
  const sessionCwd = (): string => sessionCwdFact() ?? deps.clientCwd

  /**
   * Derive + write the terminal window title from the CURRENT surface
   * identity (the title policy in terminal-title.ts): session
   * presentation title first, the session (or launch) short cwd as the
   * fallback — never the full session UUID / model / preset. Called at
   * every identity change: fresh startup, session create/resume/switch,
   * and session/title events (the session title event lands in the
   * header through setSessionTitle; the OSC title follows).
   */
  
  const refreshTerminalTitle = (): void => {
    const title = terminalTitleOf({
      sessionTitle: deps.surface.app.getSessionTitle(),
      // The OFFICIAL fact (a live session whose row carries no cwd yields
      // the plain 'dsh' title — the client cwd never impersonates the
      // session's Host workspace).
      cwd: sessionCwdFact(),
    })
    setTerminalTitle(title)
  }

  /**
   * The terminal-LOCAL cwd fact (plan §4.3): what the TUI may publish through
   * OSC 7. `sessionCwdFact()` is the display/execution fact and
   * `sessionCwd()` adds a Client-local execution fallback; NEITHER is
   * automatically terminal metadata, because Tern may use the pane cwd for
   * local pane/split behavior. Therefore:
   *
   * - Direct live Session → the official Session header cwd;
   * - Direct sessionless surface → the Client launch cwd (the process really
   *   runs there);
   * - DSH Remote backend → `undefined`, fail closed: the Host cwd is a
   *   DIFFERENT machine from the terminal that owns the pane, and no
   *   co-location is proven.
   *
   * A live header WITHOUT a cwd falls back to the launch cwd on the Direct
   * branch (the pane still sits on this machine), which is why this fact is
   * not `sessionCwdFact()`.
   */
  const terminalCwdFact = (): string | undefined => {
    if (deps.remote !== undefined) return undefined
    const agent = deps.liveAgent()
    return agent?.session.header.cwd ?? deps.clientCwd
  }

  /** Forward the terminal-local cwd to the mounted TUI (it owns the write and
   *  the terminal-ownership lifecycle; see TuiApp.setTerminalCwd). */
  const refreshTerminalCwd = (): void => {
    deps.surface.app.setTerminalCwd(terminalCwdFact())
  }

  /** The footer model label: the live selection (with effort) when one exists,
   *  plus the in-flight selection while a semantic write settles. The
   *  authoritative current value stays visible; the pending one is explicit
   *  and never painted as committed. */
  
  const modelLabel = (): string => {
    const labelOf = (selection: ModelSelectionValue): string => modelLabelOf(selection)
    // The base is the AUTHORITATIVE current selection: for a sessionless
    // surface that is the persisted Host default, NOT the optimistic intent
    // (which is shown only by the marker below). Otherwise a pending
    // sessionless save would paint m1 as both base and pending.
    const agent = deps.liveAgent()
    // The AUTHORITATIVE base, per branch:
    // - Remote (no live Agent): the official `modelSelection` projection
    //   (`next ?? lastUsed`) of THIS session when it exists — it OUTRANKS the
    //   sessionless default (a session-specific selection must never be
    //   masked by the global default) and never falls back to `agent.options`.
    //   Only a SESSIONLESS Remote surface reads the default; a live session
    //   whose fact is unavailable reads UNKNOWN.
    // - Direct: the live Agent's selection, else the persisted default.
    // The in-flight marker below applies to EVERY branch — including the
    // sessionless Remote surface (a `/model` write must show `selecting…`/
    // `unconfirmed` there too, never the bare stale default).
    let base: string
    if (agent === undefined && deps.remote !== undefined) {
      const remoteFact = mainSessionStatus()?.model
      if (remoteFact !== undefined) {
        base = labelOf({
          provider: remoteFact.provider,
          model: remoteFact.model,
          ...remoteFact.reasoningEffort === undefined ? {} : { reasoningEffort: remoteFact.reasoningEffort },
        })
      } else if (deps.currentSessionId() !== undefined) {
        base = 'no model'
      } else {
        const fallback = deps.model.defaultSelection() as ModelSelectionValue | undefined
        base = fallback === undefined ? 'no model' : labelOf(fallback)
      }
    } else {
      const selection = agent === undefined
        ? (deps.model.defaultSelection() as ModelSelectionValue | undefined)
        : deps.model.currentOf(agent)
      base = selection !== undefined
        ? labelOf(selection)
        : agent === undefined ? 'no model' : `${agent.options.provider}/${agent.options.model}`
    }
    const marker = deps.model.marker()
    if (marker === undefined) return base
    const pendingLabel = labelOf(marker.selection)
    // An ambiguous write keeps an EXPLICIT unresolved marker until a Host
    // read/reconnect establishes truth (v2 §0.3.2) — never "committed".
    if (marker.status === 'unresolved') {
      return pendingLabel === base ? `${base} (unconfirmed)` : `${base} → ${pendingLabel} (unconfirmed)`
    }
    // A sessionless intent is also the optimistic base, so avoid the
    // redundant `m1 → m1`; still mark it as in flight.
    return pendingLabel === base ? `${base} (selecting…)` : `${base} → ${pendingLabel} (selecting…)`
  }

  /** M0: the composition section (how the agent is composed — NOT
   * permission, NOT plan). */
  
  const deriveCompositionStatus = (): CompositionStatus => {
    const agent = deps.liveAgent()
    // Remote branch (no live Agent): the model/preset facts come from the
    // official Session-scoped projections of THIS session — they OUTRANK the
    // sessionless selection (a session-specific selection must never be
    // masked by the global intent/default).
    if (agent === undefined && deps.remote !== undefined) {
      const facts = mainSessionStatus()
      return {
        ...facts?.model === undefined ? {} : {
          model: {
            provider: facts.model.provider,
            id: facts.model.model,
            displayName: facts.model.model,
            ...facts.model.reasoningEffort === undefined ? {} : { reasoningEffort: facts.model.reasoningEffort },
          },
        },
        ...facts?.preset === undefined ? {} : { agentPreset: { id: facts.preset, label: facts.preset } },
      }
    }
    const selection = deps.model.selection()
    const model = selection !== undefined
      ? {
          provider: selection.provider,
          id: selection.model,
          displayName: selection.model,
          ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
        }
      : agent === undefined || agent.options.provider === undefined || agent.options.model === undefined
        ? undefined
        : {
            provider: agent.options.provider,
            id: agent.options.model,
            displayName: agent.options.model,
          }
    const preset = deps.model.preset()
    return {
      ...model === undefined ? {} : { model },
      ...preset === undefined ? {} : { agentPreset: { id: preset, label: preset } },
    }
  }

  /** M0: the workspace section (cwd/project/branch — project and cwd are
   * deliberately separate facts). `branchAllowed` is the LOCALITY gate: the
   * local `gitBranch(cwd)` derivation may only speak for a cwd on THIS
   * process's own filesystem. A Remote child's Host cwd is not a Client
   * path, so its branch is omitted rather than inferred (M3-5 PR1 §9.4). */
  
  const deriveWorkspaceStatus = (cwd: string, branchAllowed = true): WorkspaceStatus => {
    const parts = cwd.split('/').filter(Boolean)
    const branch = branchAllowed ? gitBranch(cwd) : ''
    return {
      cwd,
      ...parts.length === 0 ? {} : { project: parts[parts.length - 1]! },
      ...branch === '' ? {} : { branch },
    }
  }

  /** M0: the host section (dsh + bundle versions). tuiVersion is the
   * BUNDLE's own version (bundleVersion), never the dsh version — the
   * welcome-card helper prefers dsh for display, which would show the
   * harness version under `version(format=tui)` (review finding). */
  
  const deriveHostStatus = (): HostStatus => ({
    ...dshVersion() === undefined ? {} : { dshVersion: dshVersion() },
    tuiVersion: bundleVersion(),
  })

  // PR D2: the session-bound context-measurement cache. The coordinator
  // owns the value/dirty/session identity; the runner owns the event
  // classification (which events mark dirty, which only repaint cheaply).
  
  const contextMeasurement = new ContextMeasurementCoordinator()

  const markContextDirty = (): void => { contextMeasurement.markDirty() }

  // PR D2: the cheap status refresh NEVER measures context. UI-only
  // events (theme, keybinding, permission, focus, resize, search,
  // credential/llm surface changes, …) read the CACHED measurement; the
  // only measuring path is refreshContextMeasurement below, driven by
  // model-visible lifecycle events through the semantic SessionReader
  // port (never a direct token-meter service read — the Direct adapter owns
  // that coupling).
  
  const refreshStatusCheap = (): void => {
    if (deps.isCleanedUp()) return
    const stats = deps.presentation.mainStats().snapshot()
    // The CACHED context pressure of the live session (the only measured
    // subject — never a fresh measurement here). While the subagent
    // viewer is open, the usage PROJECTION below still refuses to ride
    // the parent's measurement on the child's stats (same rule as before
    // the split); the legacy setStatus field keeps carrying the parent's
    // cached value exactly like the old path.
    const contextTokens = contextMeasurement.valueFor(
      deps.liveAgent()?.session.id ?? (deps.remote !== undefined ? deps.currentSessionId() : undefined),
    )
    // The footer's [yolo]/[workspace-write]/[read-only]/[custom] mode badge
    // rides the effective preset (derived from the sandbox+approval knob
    // folds).
    const permission = deps.host().permissionPresets
    // The workspace section carries the OFFICIAL session cwd fact; an
    // unknown live-session cwd renders EMPTY (the footer cwd item omits
    // itself for an empty value) — the client cwd never impersonates the
    // session's Host workspace here.
    const liveCwd = sessionCwdFact() ?? (deps.currentSessionId() !== undefined && deps.remote !== undefined ? '' : deps.clientCwd)
    // M3-5 PR1 §9.3: the ONE display-subject selector. It answers only
    // "which Session's status is being displayed?" — the current main
    // Session, or the viewed child Session (the viewer's own read model
    // supplies the child IDENTITY facts, never the Session facts). It
    // decides no writer authority and no child activity.
    const viewed = deps.viewer.read()
    // ONE SessionStatus cut for the viewed child, taken in the SAME
    // synchronous step as the identity above: no later re-read can name a
    // different subject than the one whose facts are committed below. The
    // MAIN subject keeps its existing Agent/projection reads untouched (a
    // cheap refresh must not add a projection batch to the main hot path).
    const childStatus = viewed === undefined ? undefined : deps.sessionStatus(viewed.id)
    const displayView: ViewStatus = viewed === undefined
      ? { subject: { kind: 'main' } }
      : resolveDisplaySubject({
          childSessionId: viewed.id,
          label: viewed.label,
          mode: viewed.mode,
          activity: viewed.activity,
        })
    // The derivations mint fresh objects every call: only sections whose
    // CONTENT actually changed are committed — an identical refresh must
    // not churn the store's revision (the store compares by identity) nor
    // wake the command runner's refresh on every streaming event.
    const current = deps.surface.status.snapshot()
    const composition = viewed === undefined
      ? deriveCompositionStatus()
      : childCompositionStatus(childStatus)
    // The access section (permission preset / sandbox mode / approval
    // override) is derived from the in-process Host services, which are the
    // LIVE-AGENT subject's facts. On the Remote branch (no live Agent) the
    // plan's §6.6 rule applies: an unsupported capability stays unsupported —
    // the section is OMITTED rather than showing a Host deployment default
    // (e.g. `sandboxPolicy.resolve(undefined)` answers without a session).
    // The projection-driven Remote replacement (`permissions.currentValue` +
    // the preset catalog) is the command/action PR's ownership.
    // PR4 §6.4: the Remote branch renders the permission preset FROM THE
    // PROJECTION ONLY and omits the approval override + the sandbox mode
    // (no public rc.2 carrier — §6.6's truthful-unavailable rows). Direct
    // keeps the in-process service derivation.
    let access: ReturnType<typeof deriveAccessStatus> | {}
    if (viewed !== undefined) {
      // M3-5 PR1 §9.4: the CHILD's access is the projection-authoritative
      // permission preset only — the parent's service-derived sandbox /
      // approval / permission never rides the child surface, and an absent
      // child fact is omitted (never the parent's).
      access = childAccessStatus(childStatus)
    } else if (deps.remote === undefined) {
      access = deriveAccessStatus(
          {
            permissionPresets: permission,
            sandboxPolicy: deps.host().sandboxPolicy,
            approval: deps.host().approval,
          },
          deps.liveAgent()?.session,
        )
    } else {
      // §6.4: the preset row comes from the projection ONLY. When the
      // projection cannot answer — the session status itself is unavailable,
      // or the permissions projection has not carried a value yet (a
      // binding-baseline window) — the section KEEPS its last value instead
      // of flapping to empty: an unavailable projection is not "no
      // permission" (§6.6's truthful-unavailable rule, applied to the row).
      // SUBJECT-SCOPED retention (M3-5 PR1): the last value may only be kept
      // while the PREVIOUS committed snapshot described the SAME (main)
      // subject — after a child viewer exits, the child's permission must
      // never become the main session's retained value.
      const status = mainSessionStatus()
      const currentPreset = status?.permission
      access = currentPreset === undefined
        ? (current.view.subject.kind === 'main' ? (current.access ?? {}) as typeof access : {})
        : { permissionPreset: { id: currentPreset, label: currentPreset, matched: true } }
    }
    const collaboration = viewed === undefined
      ? {
          plan: deps.remote !== undefined && deps.liveAgent() === undefined
            ? deriveRemotePlanStatus(deps.remote.plan(deps.currentSessionId()))
            : derivePlanStatus(deps.host().planMode, deps.liveAgent(), deps.host().sessionProjections, deps.liveAgent()?.session),
        }
      : { plan: { effective: false } }
    // The display subject's workspace: the child SessionStatus' OWN cwd
    // (absent = '', never the parent's workspace). The local `gitBranch`
    // derivation may speak only for a cwd on THIS process's filesystem — a
    // Remote child's Host cwd is not one, so its branch is omitted.
    const displayCwd = viewed === undefined ? liveCwd : (childStatus?.cwd ?? '')
    const workspace = deriveWorkspaceStatus(displayCwd, viewed === undefined || deps.remote === undefined)
    // The Remote branch's event window is BOUNDED: its fold cannot count the
    // session's lifetime tokens, so the official `tokenUsage` projection (and
    // the route's context capacity) own them there. Direct keeps the fold.
    const remoteUsageFacts = viewed === undefined && deps.liveAgent() === undefined && deps.remote !== undefined
      ? (() => {
          const status = mainSessionStatus()
          // ALWAYS the override object on the Remote branch, even when a
          // projection cannot answer: an empty override means "unknown", which
          // omits the facts. Returning undefined here would silently present
          // the bounded window's partial fold as a session total.
          return {
            ...status?.usage === undefined ? {} : { tokens: status.usage },
            ...status?.context?.contextWindow === undefined ? {} : { contextWindow: status.context.contextWindow },
          }
        })()
      : undefined
    // The child's turns/steps and recent-performance figures stay the
    // viewer-local StatsFolder's own (presentation-local); its CUMULATIVE
    // tokens/context are the official SessionStatus facts ONLY — an always-
    // present override object keeps the bounded fold from ever standing in
    // for a session total (M3-5 PR1 §9.5).
    const subjectStats = viewed === undefined ? stats : viewed.stats.snapshot()
    const childContextTokens = childStatus?.context === undefined
      ? undefined
      : contextPressureOccupancy(childStatus.context)
    const usage = viewed === undefined
      ? usageFromStats(
          subjectStats,
          contextTokens,
          remoteUsageFacts,
          // PR5 (plan §3.2): an unproven recent window omits the recent
          // metrics. A viewer CHILD keeps the numeric figures (its own fold is
          // its whole subject; the availability authority is the MAIN
          // presentation's).
          deps.presentation.mainRecentPerformanceAvailable?.() === false
            ? { recentPerformanceAvailable: false }
            : undefined,
        )
      : usageFromStats(
          subjectStats,
          childContextTokens,
          {
            ...childStatus?.usage === undefined ? {} : { tokens: childStatus.usage },
            ...childStatus?.context?.contextWindow === undefined
              ? {}
              : { contextWindow: childStatus.context.contextWindow },
          },
        )
    const host = deriveHostStatus()
    const patch: {
      view?: ViewStatus
      composition?: typeof composition
      access?: ReturnType<typeof deriveAccessStatus> | {}
      collaboration?: typeof collaboration
      workspace?: typeof workspace
      usage?: typeof usage
      host?: typeof host
    } = {}
    if (!plainSectionEqual(current.view, displayView)) patch.view = displayView
    if (!plainSectionEqual(current.composition, composition)) patch.composition = composition
    if (!plainSectionEqual(current.access, access)) patch.access = access
    if (!plainSectionEqual(current.collaboration, collaboration)) patch.collaboration = collaboration
    if (!plainSectionEqual(current.workspace, workspace)) patch.workspace = workspace
    if (!plainSectionEqual(current.usage, usage)) patch.usage = usage
    if (!plainSectionEqual(current.host, host)) patch.host = host
    // M3-5 PR1 §9.6: the display-subject PRESENTATION projection. The durable
    // MAIN presentation state (the todo list, the session title, the session
    // identity) stays untouched behind this projection; while a child is
    // displayed its Session-owned facts replace them for every consumer (todo
    // summary/panel, extension snapshot, /status). An absent child fact is
    // UNKNOWN here, never the parent's value. It travels in the SAME atomic
    // commit as the store patch below.
    const presentation = viewed === undefined
      ? undefined
      : {
          // The child IDENTITY is the Viewer/Subagent authority's fact (D2),
          // not a SessionStatus fact.
          sessionId: viewed.id,
          workspaceRoot: workspace.cwd,
          // An absent child title is UNKNOWN (''), never the parent's title.
          title: childStatus?.title ?? '',
          // The legal `todos` null (no write yet) and an unavailable
          // projection both read "nothing known" — the parent's list is never
          // a stand-in.
          todos: childStatus?.todos ?? [],
          // The goal badge is a display-subject presentation fact (the legacy
          // `goalText` slot stays the LIVE session's).
          goal: childGoalText(childStatus),
        }
    // The LIVE session's legacy display facts (M3-5 PR1 contract decision):
    // `StatusData` — and therefore the extension's v2 live-session snapshot —
    // always describes the LIVE session owner. They are passed for BOTH
    // subjects: on the main subject they also feed the legacy store projection,
    // while on a child subject the surface merges them into the live slot
    // WITHOUT re-projecting the store (the child's own sections came from the
    // patch above). A viewer transition must never re-point them, and a viewer
    // must never freeze them either.
    const liveLegacy: Partial<StatusData> = {
        model: modelLabel(),
        // The FULL cwd lands in the structured workspace section (the
        // footer cwd ITEM shortens for display itself); the legacy
        // display value (tail segments) is derived from it.
        cwd: liveCwd,
        branch: gitBranch(liveCwd),
        goal: goalText,
        turns: stats.turns,
        steps: stats.steps,
        // EXPLICITLY clear the permission when the service/agent is
        // unavailable: the legacy merge keeps the old value otherwise,
        // and syncExtensionState would publish a STALE permission to the
        // extension snapshot (a state transition where the permission
        // preset service or the live agent is momentarily gone).
        permission: deriveRunnerPermission(permission, deps.liveAgent()),
        // EXPLICITLY CLEAR the legacy context fields when unmeasured: the
        // TuiApp merge keeps old fields otherwise, and the session
        // switch / cold-resume window before the deferred measurement
        // would show the PREVIOUS session's context pressure — exactly the
        // permission policy above (P1 finding: the previous conditional
        // spread skipped the fields, leaving session A's measurement on
        // session B's first frames, indefinitely when B's measurement
        // fails).
        contextTokens,
        contextWindow: contextTokens === undefined ? undefined : stats.contextWindow,
    }
    // A4-4 (plan §13.1): the semantic derivation stays here; the surface owns
    // the commit coordination. The three parts are ONE atomic display-subject
    // commit (M3-5 PR1 §9.7).
    deps.surface.commitStatus(patch, liveLegacy, presentation)
  }

  /**
   * Shift+Tab / the semantic `cycle-permission` action: cycle the live
   * session's permission preset through the composed table (read-only →
   * workspace-write → danger-full-access). The switch goes through the official
   * service (sandbox + approval + preset log in one call, no transcript card),
   * with a red warning only on the no-approval preset (plain switches notify in
   * the dim info style) and an immediate footer refresh.
   */
  const cyclePermission = (): void => {
    // §6.3: the cycle is an owned async operation over the PR4 authority
    // bundle when the composition provides it; the Direct-only legacy path
    // (the in-process service pair) remains for compositions without the
    // bundle (never on the Remote branch, whose ConfigPort is the only
    // write carrier).
    if (deps.permissionCycle !== undefined) {
      const authority = deps.permissionCycle
      // SYNC admission: the scope must be current BEFORE any read/write. The
      // transport token is captured in the SAME synchronous step (§6.3): a
      // same-id binding rollover during the apply must read stale, so the
      // old gesture never notifies/repaints the replacement surface.
      const scope = authority.captureLiveScope()
      if (scope === undefined) return
      const transportToken = authority.captureTransportToken()
      const names = authority.presetNames()
      if (names.length === 0) return
      const current = authority.currentPermission()
      const index = current === undefined ? -1 : names.indexOf(current)
      const next = names[(index + 1) % names.length] ?? names[0]
      if (next === undefined || next === current) return
      // The gesture is an OWNED async operation (docs/failure-model.md): one
      // runOwned settlement, never a bare discard. Every terminal branch
      // re-checks BOTH owner identities after the await: the scope (a TUI
      // owner commit) AND the transport token (a Connection/binding
      // rollover WITHOUT a TUI owner commit).
      runOwned('permission cycle', async () => {
        const outcome = await authority.apply(scope.sessionId, next)
        if (deps.isCleanedUp()) return
        // A stale owner repaints NOTHING for the replacement session
        // (§15.6): the write may have committed on the OLD session.
        if (!authority.isScopeCurrent(scope)) return
        if (!authority.isTransportTokenCurrent(transportToken)) return
        if (outcome.kind === 'unavailable') {
          deps.surface.app.notify(outcome.cause === 'commands'
            ? 'permission switch unavailable (commands service)'
            : 'permission switch unavailable (presets not composed)', 'error')
          return
        }
        if (outcome.kind === 'indeterminate') {
          // §6.3/§15.6: the write was dispatched but its settle is
          // unobservable — report it truthfully, never as a known failure,
          // and NEVER retry automatically (an ambiguous dispatch must not
          // duplicate). The pushed projection repaints the committed value
          // if the switch landed.
          deps.surface.app.notify(
            `permission switch to ${next} was dispatched but the result is unknown — check the footer before relying on it`,
            'error',
          )
          return
        }
        // APPLIED: do NOT install next as committed locally — the pushed
        // permissions projection repaints the footer (§D7). The notice is
        // the gesture's own feedback, never a committed-value claim.
        deps.surface.app.notify(next === 'danger-full-access'
          ? `⚠ ${next} — no approvals`
          : `permission: ${next}`,
        next === 'danger-full-access' ? 'error' : 'info')
      }, {
        diag: deps.diag,
        sessionId: () => scope.sessionId,
        // A rejected apply is reported truthfully and never retried
        // automatically (§6.3 — an ambiguous dispatch must not duplicate).
        onError: (error) => {
          if (deps.isCleanedUp()) return
          if (!authority.isScopeCurrent(scope)) return
          if (!authority.isTransportTokenCurrent(transportToken)) return
          deps.surface.app.notify(`permission switch failed: ${safeErrorMessage(error)}`, 'error')
        },
      })
      return
    }
    // Direct-only legacy path (no PR4 bundle on this composition).
    const agent = deps.liveAgent()
    if (agent === undefined) return
    const permission = deps.host().permissionPresets
    if (permission?.names === undefined || permission.set === undefined) return
    const names = permission.names
    if (names.length === 0) return
    const current = permission.current(agent.session)
    const index = names.indexOf(current)
    const next = names[(index + 1) % names.length] ?? names[0]
    if (next === undefined || next === current) return
    permission.set(agent.session, next)
    deps.surface.app.notify(next === 'danger-full-access'
      ? `⚠ ${next} — no approvals`
      : `permission: ${next}`,
    next === 'danger-full-access' ? 'error' : 'info')
    refreshStatusCheap()
  }

  // PR D2: the explicit, event-driven context measurement path. Call
  // sites FIRST mark the cache dirty (markContextDirty — only
  // model-visible lifecycle events may), then this function measures
  // through the semantic SessionReader port and repaints cheaply. A
  // clean cache skips the reader (same-sync-chain dedupe); a failed or
  // unavailable measurement keeps the last-good value and the footer
  // falls back — never a dialog, never a stale foreign session value
  // (the coordinator is session-bound).
  
  const refreshContextMeasurement = (_reason: ContextMeasureReason): void => {
    const session = deps.liveAgent()?.session
    // Remote branch: the CURRENT session id owns the measurement fence (the
    // coordinator is session-bound; the semantic reader maps the official
    // contextPressure projection of the exact retained binding).
    const sessionId = session?.id ?? (deps.remote !== undefined ? deps.currentSessionId() : undefined)
    if (sessionId === undefined) return
    contextMeasurement.bind(sessionId)
    contextMeasurement.measure(sessionId, (id) => deps.measureContext(id))
    refreshStatusCheap()
  }

  // The /status explicit force: a user asking for status expects the
  // FRESH context (plan §15.1 — explicit-status may force). Measures now
  // through the coordinator so the panel AND the cached footer value
  // agree (round-8 finding: a direct sessionReader read from the command
  // surface bypassed the cache and could duplicate the deferred initial
  // measurement).
  
  const forceContextMeasurement = (): number | undefined => {
    const session = deps.liveAgent()?.session
    const sessionId = session?.id ?? (deps.remote !== undefined ? deps.currentSessionId() : undefined)
    if (sessionId === undefined) return undefined
    contextMeasurement.bind(sessionId)
    contextMeasurement.markDirty()
    const value = contextMeasurement.measure(sessionId, (id) => deps.measureContext(id))
    refreshStatusCheap()
    return value
  }

  // The initial/post-switch measurement is deferred one event-loop turn
  // past the first usable paint: cold resume must never block the first
  // frame on a long-session context scan (plan §16.2 — setImmediate, not
  // a microtask). The fence captures the session generation + id: a
  // switch,/new, viewer swap or dispose before the callback runs makes it
  // a no-op (a stale deferred measurement can never commit).
  
  let cancelDeferredContextMeasure: (() => void) | undefined

  const scheduleInitialContextMeasure = (sessionId: string): void => {
    const generation = deps.generation()
    cancelDeferredContextMeasure?.()
    cancelDeferredContextMeasure = deferInitialContextMeasure(
      (callback) => setImmediate(callback),
      () => generation === deps.generation() && deps.currentSessionId() === sessionId,
      () => {
        // Bind the captured session BEFORE the dirty guard: on a cold
        // resume the coordinator is still UNBOUND (reads as not dirty),
        // and on a switch it is still bound to the PREVIOUS session —
        // guarding before the bind would turn the deferred initial
        // measure into a permanent no-op (round-10 finding). Binding a
        // new identity clears the old value and arms a fresh measure;
        // binding the same session is a no-op, so an earlier successful
        // force/lifecycle measurement (dirty cleared) still makes this
        // deferral redundant (round-9 finding), while a FAILED earlier
        // attempt (dirty stays) is retried here.
        contextMeasurement.bind(sessionId)
        if (!contextMeasurement.isDirty()) return
        markContextDirty()
        refreshContextMeasurement('initial')
      },
    )
  }


  const setGoal = (text: string | undefined): void => { goalText = text }
  const cancelDeferred = (): void => {
    cancelDeferredContextMeasure?.()
    cancelDeferredContextMeasure = undefined
  }

  return {
    updateWelcomeCard,
    sessionCwd,
    refreshTerminalTitle,
    refreshTerminalCwd,
    refresh: refreshStatusCheap,
    cyclePermission,
    markContextDirty,
    refreshContextMeasurement,
    forceContextMeasurement,
    scheduleInitialMeasurement: scheduleInitialContextMeasure,
    cancelDeferred,
    setGoal,
    applyGoalChange: (event) => { goalText = foldGoal([event]) },
  }
}
