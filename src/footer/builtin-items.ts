/**
 * The builtin footer items (plan §7.1/§13.3): the semantic items the
 * default/compact presets and custom layouts compose. Every render
 * callback is pure, synchronous, I/O-free and reads only the
 * StatusSnapshot + the host surface context.
 *
 * Default-preset composition: the status row is view-conditional — the
 * main-only badges (model/permission/plan/task/context/branch/extension)
 * render only on the main subject, while the data-source items
 * (cwd/turns-steps and the stats-row placements: token-usage/cache-hit/
 * performance) follow the display subject's section values. The default
 * stats row composes semantic placements (token-usage:pi · cache-hit:pi ·
 * performance:latency · performance:speed — the RECENT performance
 * contract); `stats-line` stays registered as the legacy composite for
 * existing custom layouts, never in the default preset.
 * @module @xmoon76/dsh-pi-tui/footer/builtin-items
 */

import type { StatusSnapshot } from '../status/types.ts'
import { visibleWidth } from '@xmoon76/pi-tui'
import {
  formatCacheHit,
  formatCacheHitCompact,
  formatCacheHitPi,
  formatContextFull,
  formatContextPercent,
  formatGitBranch,
  formatModel,
  formatPerformanceCompact,
  formatPerformanceFull,
  formatPerformanceLatency,
  formatPerformanceLatencyCompact,
  formatPerformanceSpeed,
  formatPerformanceSpeedCompact,
  formatPermissionPreset,
  formatPlanState,
  formatRunPhaseCompact,
  formatSandboxModeCompact,
  formatStatsLine,
  formatStatsLineCompact,
  formatTokenUsageCompact,
  formatTokenUsageIo,
  formatTokenUsagePi,
  formatTokenUsagePiCompact,
  formatTokenUsageTotal,
  formatTurnsSteps,
  formatVersion,
  formatWorkingDirectory,
} from './formatters.ts'
import type { FooterItemDefinition } from './types.ts'
import { FooterItemRegistry } from './item-registry.ts'

/** The legacy permission badge mapping (M1 parity — the plan's §14.4 tone
 * refinements apply to M2 custom layouts, never the default preset). */
const permissionPresetItem: FooterItemDefinition = {
  id: 'permission-preset',
  label: 'Permission preset',
  description: 'The effective permission preset as a badge, plain label, or compact code.',
  defaultZone: 'left',
  defaultImportance: 110,
  formats: ['badge', 'plain', 'compact'],
  defaultFormat: 'badge',
  render(snapshot: StatusSnapshot, ref, density) {
    if (snapshot.view.subject.kind !== 'main') return null
    const preset = snapshot.access.permissionPreset
    if (preset === undefined) return null
    // Density compact reuses the persisted 'compact' style (ww/ro/yolo);
    // the user's own format choice is never written back.
    const format = density === 'compact' ? 'compact' : ref.format ?? 'badge'
    const text = formatPermissionPreset(preset.id, format)
    if (text === undefined) return null
    const tone = preset.id === 'danger-full-access' || preset.id === 'custom'
      ? 'warning'
      : preset.id === 'read-only' ? 'textMuted' : 'text'
    return { spans: [{ text, tone }] }
  },
}

/** The plan styles: a badge or a plain status label. Pending enter and
 * pending exit both keep the pending state visible (plan §4.3). */
const planStateItem: FooterItemDefinition = {
  id: 'plan-state',
  label: 'Plan state',
  description: 'The plan-mode badge or plain status label.',
  defaultZone: 'left',
  defaultImportance: 115,
  formats: ['badge', 'plain'],
  defaultFormat: 'badge',
  render(snapshot: StatusSnapshot, ref, density) {
    if (snapshot.view.subject.kind !== 'main') return null
    // Density compact drops the badge brackets (the plan's A-class
    // mapping); the user's own format choice is never written back.
    const format = density === 'compact' ? 'plain' : ref.format ?? 'badge'
    const text = formatPlanState(
      snapshot.collaboration.plan.effective,
      snapshot.collaboration.plan.pending,
      format,
    )
    return text === undefined ? null : { spans: [{ text, tone: 'warning' }] }
  },
}

/** The model styles: badge, provider/model plain text, or model id only. */
const modelItem: FooterItemDefinition = {
  id: 'model',
  label: 'Model',
  description: 'The provider/model identity as a badge, plain label, or model id.',
  defaultZone: 'left',
  defaultImportance: 100,
  formats: ['badge', 'plain', 'compact'],
  defaultFormat: 'badge',
  render(snapshot: StatusSnapshot, ref, density) {
    if (snapshot.view.subject.kind !== 'main') return null
    const model = snapshot.composition.model
    if (model === undefined) return null
    // Density compact reuses the persisted 'compact' style (model id
    // only); the user's own format choice is never written back.
    const format = density === 'compact' ? 'compact' : ref.format ?? 'badge'
    return { spans: [{ text: formatModel(model.provider, model.id, model.reasoningEffort, format) }] }
  },
}

/**
 * The Task Center badge. Legacy snapshots (which predate totals) retain the
 * old wording for embedders; the runtime-backed snapshot uses independent
 * running/total job and agent counts and a persistent failure marker.
 */
const tasksItem: FooterItemDefinition = {
  id: 'tasks',
  label: 'Tasks',
  description: 'The Task Center running/total badge with failure attention and the ↓ view hint.',
  defaultZone: 'left',
  defaultImportance: 85,
  formats: ['badge'],
  defaultFormat: 'badge',
  render(snapshot: StatusSnapshot, _ref, density, context) {
    if (snapshot.view.subject.kind !== 'main') return null
    const tasks = snapshot.activity.taskCount
    const agents = snapshot.activity.childAgentCount
    const failed = snapshot.activity.failedTaskCount ?? 0
    const rich = snapshot.activity.taskTotalCount !== undefined
      || snapshot.activity.childAgentTotalCount !== undefined
      || snapshot.activity.failedTaskCount !== undefined
    if (!rich) {
      if (tasks <= 0 && agents <= 0) return null
      // The old direct-setter contract remains available to non-runtime
      // embedders. Production Task Center snapshots always take the branch
      // below.
      const hint = context.taskBrowserAvailable ? ' · ↓ view' : ''
      if (density === 'compact') {
        const parts: string[] = []
        if (tasks > 0) parts.push(`${tasks}t`)
        if (agents > 0) parts.push(`${agents}a`)
        if (context.taskBrowserAvailable) parts.push('↓')
        return { spans: [{ text: `[${parts.join('·')}]`, tone: 'primary' }] }
      }
      const parts: string[] = []
      if (tasks > 0) parts.push(`${tasks} task${tasks === 1 ? '' : 's'} running`)
      if (agents > 0) parts.push(`${agents} agent${agents === 1 ? '' : 's'}`)
      return { spans: [{ text: `[${parts.join(' · ')}${hint}]`, tone: 'primary' }] }
    }
    const totalJobs = snapshot.activity.taskTotalCount ?? tasks
    const totalAgents = snapshot.activity.childAgentTotalCount ?? agents
    if (tasks <= 0 && agents <= 0 && failed <= 0) return null
    const hint = context.taskBrowserAvailable ? ' · ↓ view' : ''
    const tone = failed > 0 ? 'warning' : 'primary'
    if (density === 'compact') {
      const parts: string[] = []
      if (failed > 0) parts.push(`!${failed}`)
      if (tasks > 0 || agents > 0) {
        parts.push(`●${agents}/${totalAgents}a`)
        parts.push(`${tasks}/${totalJobs}j`)
      }
      if (context.taskBrowserAvailable) parts.push('↓')
      return { spans: [{ text: `[${parts.join('·')}]`, tone }] }
    }
    const parts: string[] = []
    if (failed > 0) parts.push(`! ${failed} failed`)
    if (tasks > 0 || agents > 0) {
      parts.push(`● ${agents}/${totalAgents} agents`)
      parts.push(`${tasks}/${totalJobs} jobs`)
    }
    return { spans: [{ text: `[${parts.join(' · ')}${hint}]`, tone }] }
  },
}

/** The working directory (short, basename, or full path). */
const cwdItem: FooterItemDefinition = {
  id: 'cwd',
  label: 'Working directory',
  description: 'The display subject\'s workspace in short, basename, or full form.',
  defaultZone: 'left',
  defaultImportance: 80,
  formats: ['short', 'basename', 'full'],
  defaultFormat: 'short',
  render(snapshot: StatusSnapshot, ref, density) {
    const cwd = snapshot.workspace.cwd
    if (cwd === '') return null
    // Density compact reuses the persisted 'basename' style; the user's
    // own format choice is never written back.
    const format = density === 'compact' ? 'basename' : ref.format ?? 'short'
    return { spans: [{ text: formatWorkingDirectory(cwd, format) }] }
  },
}

/** The git branch, either plainly or with a visible label. */
const gitBranchItem: FooterItemDefinition = {
  id: 'git-branch',
  label: 'Git branch',
  description: 'The display subject\'s git branch, plainly or with a label.',
  defaultZone: 'left',
  defaultImportance: 70,
  formats: ['plain', 'label'],
  defaultFormat: 'plain',
  render(snapshot: StatusSnapshot, ref, density) {
    if (snapshot.view.subject.kind !== 'main') return null
    const branch = snapshot.workspace.branch
    if (branch === undefined || branch === '') return null
    // Density compact reuses the persisted 'plain' style (a 'label' ref
    // loses its prefix under pressure); the user's own format choice is
    // never written back.
    const format = density === 'compact' ? 'plain' : ref.format ?? 'plain'
    return { spans: [{ text: formatGitBranch(branch, format) }] }
  },
}

/** The context pressure styles: legacy bar, percent, or full
 * used/window output. */
const contextItem: FooterItemDefinition = {
  id: 'context',
  label: 'Context',
  description: 'Context pressure: a progress bar, percent, or used/window value.',
  defaultZone: 'left',
  defaultImportance: 100,
  formats: ['bar', 'percent', 'full'],
  defaultFormat: 'bar',
  render(snapshot: StatusSnapshot, ref, density) {
    if (snapshot.view.subject.kind !== 'main') return null
    const context = snapshot.usage.context
    if (context === undefined || context.windowTokens === undefined || context.windowTokens <= 0) return null
    const used = context.usedTokens ?? 0
    const window = context.windowTokens
    const percent = context.percent ?? Math.min(100, Math.max(0, Math.ceil((used * 100) / window)))
    // Density compact always prefers the percent form (`ctx 72%`) — the
    // shortest context presentation — whatever the user's persisted style.
    if (density === 'compact') {
      return { spans: [{ text: formatContextPercent(percent), tone: 'primary' }] }
    }
    const format = ref.format ?? 'bar'
    if (format === 'full') {
      return { spans: [{ text: formatContextFull(used, window, percent), tone: 'primary' }] }
    }
    if (format === 'percent') {
      return { spans: [{ text: formatContextPercent(percent), tone: 'primary' }] }
    }
    // The legacy bar: 12 cells, rounded fill, ceiling percent. The bar is
    // primary; the percent rides OUTSIDE the color (the legacy string
    // concatenation — the outer dim pass colors it).
    const ratio = Math.min(1, Math.max(0, used / window))
    const filled = Math.round(ratio * CONTEXT_BAR_WIDTH)
    const barPercent = Math.min(100, Math.max(0, Math.ceil(ratio * 100)))
    const bar = '█'.repeat(filled) + '░'.repeat(CONTEXT_BAR_WIDTH - filled)
    return { spans: [{ text: `[${bar}]`, tone: 'primary' }, { text: ` ${barPercent}%` }] }
  },
}

/** The legacy bar width (moved from tui-app.ts). */
const CONTEXT_BAR_WIDTH = 12

/** The turn/step counters: both counters, turns only, or steps only
 * (host-native since M1 — the first-party builtin extension segment was
 * removed; the host core state no longer depends on plugin loading). */
const turnsStepsItem: FooterItemDefinition = {
  id: 'turns-steps',
  label: 'Turns/steps',
  description: 'The completed turn/step counters, together or separately.',
  defaultZone: 'left',
  defaultImportance: 45,
  formats: ['both', 'turns', 'steps'],
  defaultFormat: 'both',
  render(snapshot: StatusSnapshot, ref) {
    return { spans: [{ text: formatTurnsSteps(snapshot.usage.turns, snapshot.usage.steps, ref.format ?? 'both') }] }
  },
}

/** The pi-vocabulary stats line (the legacy line-2), derived from the
 * STRUCTURED usage facts. Kept registered for existing custom layouts;
 * the default preset composes its stats row from real semantic items. */
const statsLineItem: FooterItemDefinition = {
  id: 'stats-line',
  label: 'Stats line',
  description: 'The pi-vocabulary usage line (tokens, cache, recent TTFB, throughput).',
  defaultZone: 'left',
  defaultImportance: 10,
  formats: ['pi'],
  defaultFormat: 'pi',
  render(snapshot: StatusSnapshot, _ref, density) {
    // Density compact renders the pressure form (input/output + one time
    // indicator + throughput); the legacy full line stays the preferred
    // form (its source-consistency contract is untouched).
    const text = density === 'compact'
      ? formatStatsLineCompact(snapshot.usage)
      : formatStatsLine(snapshot.usage)
    return { spans: [{ text }] }
  },
}

/** The viewer identity block (legacy form): `[subagent · one-shot] label
 * ● running` — the badge, the child label and the activity ride as one
 * composite item so the default preset reproduces the legacy viewer footer
 * with a single item (custom layouts may split them later). */
const viewScopeItem: FooterItemDefinition = {
  id: 'view-scope',
  label: 'View scope',
  description: 'The subagent-viewer identity block (badge, label, activity).',
  defaultZone: 'left',
  defaultImportance: 115,
  formats: ['legacy'],
  defaultFormat: 'legacy',
  render(snapshot: StatusSnapshot) {
    const subject = snapshot.view.subject
    if (subject.kind !== 'subagent') return null
    const badge = subject.mode === 'one-shot' ? '[subagent · one-shot]' : '[subagent · continuable]'
    const spans: { text: string; tone?: 'accent' | 'primary' | 'textMuted' }[] = [{ text: badge, tone: 'accent' }]
    if (subject.label !== undefined && subject.label !== '') spans.push({ text: `  ${subject.label}` })
    if (subject.activity === 'running') spans.push({ text: '  ● running', tone: 'primary' })
    else if (subject.activity === 'inactive') spans.push({ text: '  inactive', tone: 'textMuted' })
    return { spans }
  },
}

/** The legacy extension-segment bridge: `ext:*` renders the extension
 * host's baked footer segments (the chrome.footer.status slot). */
const extensionItemsItem: FooterItemDefinition = {
  id: 'ext:*',
  label: 'Extension items',
  description: 'The legacy chrome.footer.status extension segments (synthetic bridge).',
  defaultZone: 'left',
  defaultImportance: 0,
  formats: ['bridge'],
  defaultFormat: 'bridge',
  render(snapshot: StatusSnapshot, _ref, _density, context) {
    if (snapshot.view.subject.kind !== 'main') return null
    if (context.extensionFooterText === '') return null
    return { spans: [{ text: context.extensionFooterText }] }
  },
}

/** Register every M1 builtin item on a registry. */
export function registerBuiltinFooterItems(registry: FooterItemRegistry): void {
  registry.register(permissionPresetItem)
  registry.register(planStateItem)
  registry.register(modelItem)
  registry.register(tasksItem)
  registry.register(cwdItem)
  registry.register(gitBranchItem)
  registry.register(contextItem)
  registry.register(turnsStepsItem)
  registry.register(statsLineItem)
  registry.register(viewScopeItem)
  registry.register(extensionItemsItem)
  // M2: the remaining first-batch items (plan §7.1/§18) — available to
  // custom layouts, never in the default preset.
  registry.register(agentPresetItem)
  registry.register(reasoningItem)
  registry.register(sandboxModeItem)
  registry.register(approvalPolicyItem)
  registry.register(focusModeItem)
  registry.register(focusedSeatItem)
  registry.register(projectItem)
  registry.register(runStateItem)
  registry.register(queueItem)
  registry.register(agentsItem)
  registry.register(todoItem)
  registry.register(cacheHitItem)
  registry.register(tokenUsageItem)
  registry.register(performanceItem)
  registry.register(versionItem)
}

/** The agent-preset badge: `[CM]`-style from the composition preset
 * (shortLabel when provided — the state layer never hardcodes it). */
const agentPresetItem: FooterItemDefinition = {
  id: 'agent-preset',
  label: 'Agent preset',
  description: 'The agent composition preset badge or compact short label.',
  defaultZone: 'left',
  defaultImportance: 90,
  formats: ['badge', 'compact'],
  defaultFormat: 'badge',
  render(snapshot: StatusSnapshot, ref, density) {
    if (snapshot.view.subject.kind !== 'main') return null
    const preset = snapshot.composition.agentPreset
    if (preset === undefined) return null
    // Density compact reuses the persisted 'compact' style (the short
    // label when the state layer provides one); the user's own format
    // choice is never written back.
    const compact = density === 'compact' || ref.format === 'compact'
    const text = compact && preset.shortLabel !== undefined
      ? preset.shortLabel
      : preset.label
    return { spans: [{ text: `[${text}]`, tone: 'accent' }] }
  },
}

/** The reasoning effort: `@high` (the model item already folds it in). */
const reasoningItem: FooterItemDefinition = {
  id: 'reasoning',
  label: 'Reasoning effort',
  description: 'The model reasoning effort.',
  defaultZone: 'left',
  defaultImportance: 50,
  formats: ['plain'],
  defaultFormat: 'plain',
  render(snapshot: StatusSnapshot) {
    if (snapshot.view.subject.kind !== 'main') return null
    const effort = snapshot.composition.model?.reasoningEffort
    if (effort === undefined) return null
    return { spans: [{ text: `@${effort}`, tone: 'textMuted' }] }
  },
}

/** The sandbox mode (independent of the preset name). */
const sandboxModeItem: FooterItemDefinition = {
  id: 'sandbox-mode',
  label: 'Sandbox mode',
  description: 'The effective sandbox mode.',
  defaultZone: 'left',
  defaultImportance: 80,
  formats: ['plain'],
  defaultFormat: 'plain',
  render(snapshot: StatusSnapshot, _ref, density) {
    if (snapshot.view.subject.kind !== 'main') return null
    const mode = snapshot.access.sandbox?.mode
    if (mode === undefined) return null
    const tone = mode === 'danger-full-access' ? 'warning' : mode === 'read-only' ? 'textMuted' : 'text'
    // Density compact uses the known codes (ro/ww/yolo); an unknown
    // future mode keeps its original value (fail-soft).
    const text = density === 'compact' ? formatSandboxModeCompact(mode) : mode
    return { spans: [{ text, tone }] }
  },
}

/** The approval policy. */
const approvalPolicyItem: FooterItemDefinition = {
  id: 'approval-policy',
  label: 'Approval policy',
  description: 'The effective approval policy.',
  defaultZone: 'left',
  defaultImportance: 70,
  formats: ['plain'],
  defaultFormat: 'plain',
  render(snapshot: StatusSnapshot) {
    if (snapshot.view.subject.kind !== 'main') return null
    const policy = snapshot.access.approval?.policy
    if (policy === undefined) return null
    return { spans: [{ text: policy, tone: policy === 'never' ? 'warning' : 'text' }] }
  },
}

/** Focus Mode (the TUI's own presentation policy — never the keyboard
 * focus). */
const focusModeItem: FooterItemDefinition = {
  id: 'focus-mode',
  label: 'Focus mode',
  description: 'The Focus Mode indicator.',
  defaultZone: 'right',
  defaultImportance: 120,
  formats: ['plain'],
  defaultFormat: 'plain',
  render(snapshot: StatusSnapshot) {
    if (!snapshot.interaction.focusMode) return null
    return { spans: [{ text: 'focus', tone: 'textMuted' }] }
  },
}

/** The UI keyboard focus seat (distinct from Focus Mode). */
const focusedSeatItem: FooterItemDefinition = {
  id: 'focused-seat',
  label: 'Focused seat',
  description: 'The UI keyboard focus seat.',
  defaultZone: 'right',
  defaultImportance: 30,
  formats: ['plain'],
  defaultFormat: 'plain',
  render(snapshot: StatusSnapshot) {
    return { spans: [{ text: snapshot.surface.focusedSeat, tone: 'textMuted' }] }
  },
}

/** The project directory name (distinct from the cwd item). */
const projectItem: FooterItemDefinition = {
  id: 'project',
  label: 'Project',
  description: 'The workspace project directory name.',
  defaultZone: 'left',
  defaultImportance: 80,
  formats: ['plain'],
  defaultFormat: 'plain',
  render(snapshot: StatusSnapshot) {
    const project = snapshot.workspace.project
    if (project === undefined || project === '') return null
    return { spans: [{ text: project, tone: 'primary' }] }
  },
}

/** The run phase (the pure derive's output — never re-derived here). */
const runStateItem: FooterItemDefinition = {
  id: 'run-state',
  label: 'Run state',
  description: 'The machine run phase.',
  defaultZone: 'right',
  defaultImportance: 95,
  formats: ['plain'],
  defaultFormat: 'plain',
  render(snapshot: StatusSnapshot, _ref, density) {
    if (snapshot.view.subject.kind !== 'main') return null
    const phase = snapshot.activity.phase
    if (phase === 'idle') return null
    const tone = phase === 'working' ? 'primary' : 'warning'
    // Density compact uses the phase codes (work/w-approval/…); an
    // unknown future phase keeps its original value (fail-soft).
    const text = density === 'compact' ? formatRunPhaseCompact(phase) : phase
    return { spans: [{ text, tone }] }
  },
}

/** The queued-input count. */
const queueItem: FooterItemDefinition = {
  id: 'queue',
  label: 'Queue',
  description: 'The queued-input count.',
  defaultZone: 'left',
  defaultImportance: 85,
  formats: ['plain'],
  defaultFormat: 'plain',
  render(snapshot: StatusSnapshot, _ref, density) {
    if (snapshot.view.subject.kind !== 'main') return null
    const count = snapshot.activity.queuedCount
    if (count <= 0) return null
    const text = density === 'compact' ? `q${count}` : `${count} queued`
    return { spans: [{ text, tone: 'textDim' }] }
  },
}

/** The live child-subagent count. */
const agentsItem: FooterItemDefinition = {
  id: 'agents',
  label: 'Agents',
  description: 'The live child-subagent count.',
  defaultZone: 'left',
  defaultImportance: 85,
  formats: ['plain'],
  defaultFormat: 'plain',
  render(snapshot: StatusSnapshot, _ref, density) {
    if (snapshot.view.subject.kind !== 'main') return null
    const count = snapshot.activity.childAgentCount
    if (count <= 0) return null
    const text = density === 'compact' ? `a${count}` : `${count} agents`
    return { spans: [{ text, tone: 'textDim' }] }
  },
}

/** The todo count. */
const todoItem: FooterItemDefinition = {
  id: 'todo',
  label: 'Todo',
  description: 'The active todo count.',
  defaultZone: 'left',
  defaultImportance: 60,
  formats: ['plain'],
  defaultFormat: 'plain',
  render(snapshot: StatusSnapshot, _ref, density) {
    if (snapshot.view.subject.kind !== 'main') return null
    const count = snapshot.activity.todoCount
    if (count <= 0) return null
    // `tdN` — deliberately NOT `tN`, which would collide with the
    // turns-steps counters.
    const text = density === 'compact' ? `td${count}` : `${count} todo`
    return { spans: [{ text, tone: 'textDim' }] }
  },
}

/** The cache-hit share: pi `CH91.9%`, full `C 91.9%`, or compact `91.9%`.
 * Absent cache facts (no billed input yet) render nothing — the composer
 * eliminates the leftover separator. */
const cacheHitItem: FooterItemDefinition = {
  id: 'cache-hit',
  label: 'Cache hit',
  description: 'The cache-hit share of billed input tokens, pi, full, or compact.',
  defaultZone: 'left',
  defaultImportance: 55,
  formats: ['pi', 'full', 'compact'],
  defaultFormat: 'full',
  render(snapshot: StatusSnapshot, ref, density) {
    const pct = snapshot.usage.cacheHitPct
    if (pct === undefined) return null
    if (ref.format === 'pi') {
      // The pi style's compact form drops the CH marker (the plan's
      // shorter density); the user's own format choice is never written
      // back.
      const text = density === 'compact' ? formatCacheHitCompact(pct) : formatCacheHitPi(pct)
      return { spans: [{ text, tone: 'success' }] }
    }
    // Density compact reuses the persisted 'compact' style (`91.9%`);
    // the user's own format choice is never written back.
    const compact = density === 'compact' || ref.format === 'compact'
    const text = compact ? formatCacheHitCompact(pct) : formatCacheHit(pct)
    return { spans: [{ text, tone: 'success' }] }
  },
}

/** The token usage: pi vocabulary, input/output, all billed tokens, or
 * compact total. */
const tokenUsageItem: FooterItemDefinition = {
  id: 'token-usage',
  label: 'Token usage',
  description: 'The pi input/output vocabulary, the io totals, billed total, or compact total.',
  defaultZone: 'left',
  defaultImportance: 50,
  formats: ['pi', 'io', 'total', 'compact'],
  defaultFormat: 'io',
  render(snapshot: StatusSnapshot, ref, density) {
    const tokens = snapshot.usage.tokens
    if (ref.format === 'pi') {
      // The pi style keeps the cumulative input/output pair under width
      // pressure and drops only the cache detail (`↑114M ↓54k`); the
      // user's own format choice is never written back.
      const text = density === 'compact'
        ? formatTokenUsagePiCompact(tokens.input, tokens.output)
        : formatTokenUsagePi(tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite)
      return { spans: [{ text, tone: 'success' }] }
    }
    const preferred = ref.format === 'total'
      ? formatTokenUsageTotal(tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite)
      : ref.format === 'compact'
        ? formatTokenUsageCompact(tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite)
        : formatTokenUsageIo(tokens.input, tokens.output)
    if (density !== 'compact') return { spans: [{ text: preferred, tone: 'success' }] }
    // Density compact reuses the persisted 'compact' style (`6.7k`).
    // When the user's persisted style is ALREADY shorter (a tiny io pair
    // beside a huge cache total), the compact form is the preferred form
    // itself — a legitimate no-op, never a wider compact.
    const compact = formatTokenUsageCompact(tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite)
    const text = visibleWidth(compact) < visibleWidth(preferred) ? compact : preferred
    return { spans: [{ text, tone: 'success' }] }
  },
}

/** The recent model performance: full `TTFB 2.6s · 51 tok/s`, speed-only
 * `51 tok/s`, or latency-only `TTFB 2.6s` — the RECENT average
 * time-to-first-token and the RECENT effective output throughput. The
 * definition may be PLACED TWICE (latency + speed) — the default preset
 * does exactly that. */
const performanceItem: FooterItemDefinition = {
  id: 'performance',
  label: 'Performance',
  description: 'Recent model performance: average TTFB and effective output throughput, full, speed, or latency.',
  defaultZone: 'left',
  defaultImportance: 40,
  formats: ['full', 'speed', 'latency'],
  defaultFormat: 'full',
  render(snapshot: StatusSnapshot, ref, density) {
    const performance = snapshot.usage.performance
    if (ref.format === 'speed') {
      const text = density === 'compact'
        ? formatPerformanceSpeedCompact(performance.tokensPerSec)
        : formatPerformanceSpeed(performance.tokensPerSec)
      return { spans: [{ text, tone: 'textMuted' }] }
    }
    if (ref.format === 'latency') {
      const text = density === 'compact'
        ? formatPerformanceLatencyCompact(performance.firstTokenMs)
        : formatPerformanceLatency(performance.firstTokenMs)
      return { spans: [{ text, tone: 'textMuted' }] }
    }
    const text = density === 'compact'
      ? formatPerformanceCompact(performance.firstTokenMs, performance.tokensPerSec)
      : formatPerformanceFull(performance.firstTokenMs, performance.tokensPerSec)
    return { spans: [{ text, tone: 'textMuted' }] }
  },
}

/** The host version: `v0.4.0-alpha.1` (tui), `dsh-0.1.2-alpha.2` (dsh), or both. */
const versionItem: FooterItemDefinition = {
  id: 'version',
  label: 'Version',
  description: 'The dsh/bundle versions.',
  defaultZone: 'left',
  defaultImportance: 10,
  formats: ['tui', 'dsh', 'both'],
  defaultFormat: 'tui',
  render(snapshot: StatusSnapshot, ref) {
    const text = formatVersion(snapshot.host.dshVersion, snapshot.host.tuiVersion, ref.format ?? 'tui')
    if (text === '') return null
    return { spans: [{ text, tone: 'textMuted' }] }
  },
}

/** A fresh registry with every builtin item registered. */
export function createBuiltinFooterRegistry(): FooterItemRegistry {
  const registry = new FooterItemRegistry()
  registerBuiltinFooterItems(registry)
  return registry
}

/** The builtin items with a REAL responsive compact density (the plan's
 * A + B classes): under width pressure the composer's compact pass
 * renders a strictly shorter form BEFORE any importance drop. A future
 * builtin must either join this list or the intentional no-op list —
 * there is no third "not handled" state. */
export const RESPONSIVE_COMPACT_ITEMS: readonly string[] = [
  'permission-preset',
  'plan-state',
  'model',
  'tasks',
  'cwd',
  'git-branch',
  'context',
  'stats-line',
  'agent-preset',
  'sandbox-mode',
  'run-state',
  'queue',
  'agents',
  'todo',
  'cache-hit',
  'token-usage',
  'performance',
]

/** The builtin items whose compact density INTENTIONALLY equals their
 * preferred form (the plan's C class): already short, identity-bearing,
 * or opaque extension text — an explicit decision, never a silent
 * "forgot to implement". */
export const INTENTIONALLY_STABLE_DENSITY_ITEMS: readonly string[] = [
  'turns-steps',
  'view-scope',
  'ext:*',
  'reasoning',
  'approval-policy',
  'focus-mode',
  'focused-seat',
  'project',
  'version',
]
