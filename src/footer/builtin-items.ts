/**
 * The builtin footer items (plan §7.1/§13.3): the semantic items the
 * default/compact presets compose. Every render callback is pure,
 * synchronous, I/O-free and reads only the StatusSnapshot + the host
 * surface context.
 *
 * M1 parity rules (plan §10.1/§13.6): the default preset reproduces the
 * legacy footer EXACTLY — including the viewer identity block (the legacy
 * viewer footer had no model/permission/plan/task/context/branch/extension
 * parts, so those items are view-conditional: they render only on the main
 * subject, and the data-source items (cwd/turns-steps/stats-line) follow
 * the display subject's section values).
 * @module @xmoon76/dsh-pi-tui/footer/builtin-items
 */

import type { StatusSnapshot } from '../status/types.ts'
import {
  formatContextFull,
  formatStatsLine,
  formatTurnsSteps,
  shortCwd,
} from './formatters.ts'
import type { FooterItemDefinition } from './types.ts'
import { FooterItemRegistry } from './item-registry.ts'

/** The legacy permission badge mapping (M1 parity — the plan's §14.4 tone
 * refinements apply to M2 custom layouts, never the default preset). */
const permissionPresetItem: FooterItemDefinition = {
  id: 'permission-preset',
  label: 'Permission preset',
  description: 'The effective permission preset badge ([yolo]/[read-only]/[workspace-write]/[custom]).',
  defaultZone: 'left',
  defaultImportance: 110,
  formats: ['badge'],
  defaultFormat: 'badge',
  render(snapshot: StatusSnapshot) {
    if (snapshot.view.subject.kind !== 'main') return null
    switch (snapshot.access.permissionPreset?.id) {
      case 'danger-full-access': return { spans: [{ text: '[yolo]', tone: 'warning' }] }
      case 'read-only': return { spans: [{ text: '[read-only]', tone: 'textMuted' }] }
      case 'workspace-write': return { spans: [{ text: '[workspace-write]', tone: 'text' }] }
      case 'custom': return { spans: [{ text: '[custom]', tone: 'warning' }] }
      default: return null
    }
  },
}

/** The plan badge: `[plan]` while plan mode is effective. */
const planStateItem: FooterItemDefinition = {
  id: 'plan-state',
  label: 'Plan state',
  description: 'The plan-mode badge ([plan] while effective).',
  defaultZone: 'left',
  defaultImportance: 115,
  formats: ['badge'],
  defaultFormat: 'badge',
  render(snapshot: StatusSnapshot) {
    if (snapshot.view.subject.kind !== 'main') return null
    if (!snapshot.collaboration.plan.effective) return null
    return { spans: [{ text: '[plan]', tone: 'warning' }] }
  },
}

/** The model badge: `[provider/model @effort]` (legacy label form). */
const modelItem: FooterItemDefinition = {
  id: 'model',
  label: 'Model',
  description: 'The provider/model badge with the reasoning effort.',
  defaultZone: 'left',
  defaultImportance: 100,
  formats: ['badge'],
  defaultFormat: 'badge',
  render(snapshot: StatusSnapshot) {
    if (snapshot.view.subject.kind !== 'main') return null
    const model = snapshot.composition.model
    if (model === undefined) return null
    const label = `${model.provider === undefined ? '' : `${model.provider}/`}${model.id}`
      + (model.reasoningEffort === undefined ? '' : ` @${model.reasoningEffort}`)
    return { spans: [{ text: `[${label}]` }] }
  },
}

/** The combined task/agent badge (legacy form): `[N tasks running · M
 * agents · ↓ view]` — the ↓ hint advertises the task browser on an empty
 * editor (the host-owned surface context, never business state). */
const tasksItem: FooterItemDefinition = {
  id: 'tasks',
  label: 'Tasks',
  description: 'The combined background-task/subagent badge with the ↓ view hint.',
  defaultZone: 'left',
  defaultImportance: 85,
  formats: ['badge'],
  defaultFormat: 'badge',
  render(snapshot: StatusSnapshot, _ref, _density, context) {
    if (snapshot.view.subject.kind !== 'main') return null
    const parts: string[] = []
    const tasks = snapshot.activity.taskCount
    const agents = snapshot.activity.childAgentCount
    if (tasks > 0) parts.push(`${tasks} task${tasks === 1 ? '' : 's'} running`)
    if (agents > 0) parts.push(`${agents} agent${agents === 1 ? '' : 's'}`)
    if (parts.length === 0) return null
    const hint = context.editorEmpty ? ' · ↓ view' : ''
    return { spans: [{ text: `[${parts.join(' · ')}${hint}]`, tone: 'primary' }] }
  },
}

/** The working directory (shortened for display). */
const cwdItem: FooterItemDefinition = {
  id: 'cwd',
  label: 'Working directory',
  description: 'The display subject\'s workspace, shortened to the last two segments.',
  defaultZone: 'left',
  defaultImportance: 80,
  formats: ['short'],
  defaultFormat: 'short',
  render(snapshot: StatusSnapshot) {
    const cwd = snapshot.workspace.cwd
    if (cwd === '') return null
    return { spans: [{ text: shortCwd(cwd) }] }
  },
}

/** The git branch. */
const gitBranchItem: FooterItemDefinition = {
  id: 'git-branch',
  label: 'Git branch',
  description: 'The display subject\'s git branch.',
  defaultZone: 'left',
  defaultImportance: 70,
  formats: ['plain'],
  defaultFormat: 'plain',
  render(snapshot: StatusSnapshot) {
    if (snapshot.view.subject.kind !== 'main') return null
    const branch = snapshot.workspace.branch
    if (branch === undefined || branch === '') return null
    return { spans: [{ text: branch }] }
  },
}

/** The context pressure bar (legacy form) or the full `used/window (pct)`
 * formatter. */
const contextItem: FooterItemDefinition = {
  id: 'context',
  label: 'Context',
  description: 'Context pressure: the progress bar (bar) or used/window (full).',
  defaultZone: 'left',
  defaultImportance: 100,
  formats: ['bar', 'full'],
  defaultFormat: 'bar',
  render(snapshot: StatusSnapshot, ref) {
    if (snapshot.view.subject.kind !== 'main') return null
    const context = snapshot.usage.context
    if (context === undefined || context.windowTokens === undefined || context.windowTokens <= 0) return null
    const used = context.usedTokens ?? 0
    const window = context.windowTokens
    const format = ref.format ?? 'bar'
    if (format === 'full') {
      const percent = context.percent ?? Math.min(100, Math.max(0, Math.ceil((used * 100) / window)))
      return { spans: [{ text: formatContextFull(used, window, percent), tone: 'primary' }] }
    }
    // The legacy bar: 12 cells, rounded fill, ceiling percent. The bar is
    // primary; the percent rides OUTSIDE the color (the legacy string
    // concatenation — the outer dim pass colors it).
    const ratio = Math.min(1, Math.max(0, used / window))
    const filled = Math.round(ratio * CONTEXT_BAR_WIDTH)
    const pct = Math.min(100, Math.max(0, Math.ceil(ratio * 100)))
    const bar = '█'.repeat(filled) + '░'.repeat(CONTEXT_BAR_WIDTH - filled)
    return { spans: [{ text: `[${bar}]`, tone: 'primary' }, { text: ` ${pct}%` }] }
  },
}

/** The legacy bar width (moved from tui-app.ts). */
const CONTEXT_BAR_WIDTH = 12

/** The turn/step counters: `t3/s7` (host-native since M1 — the first-party
 * builtin extension segment was removed; the host core state no longer
 * depends on plugin loading). */
const turnsStepsItem: FooterItemDefinition = {
  id: 'turns-steps',
  label: 'Turns/steps',
  description: 'The completed turn/step counters.',
  defaultZone: 'left',
  defaultImportance: 45,
  formats: ['plain'],
  defaultFormat: 'plain',
  render(snapshot: StatusSnapshot) {
    return { spans: [{ text: formatTurnsSteps(snapshot.usage.turns, snapshot.usage.steps) }] }
  },
}

/** The pi-vocabulary stats line (the legacy line-2), derived from the
 * STRUCTURED usage facts. */
const statsLineItem: FooterItemDefinition = {
  id: 'stats-line',
  label: 'Stats line',
  description: 'The pi-vocabulary usage line (tokens, cache, LLM timing, throughput).',
  defaultZone: 'left',
  defaultImportance: 10,
  formats: ['pi'],
  defaultFormat: 'pi',
  render(snapshot: StatusSnapshot) {
    return { spans: [{ text: formatStatsLine(snapshot.usage) }] }
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
}

/** A fresh registry with every builtin item registered. */
export function createBuiltinFooterRegistry(): FooterItemRegistry {
  const registry = new FooterItemRegistry()
  registerBuiltinFooterItems(registry)
  return registry
}
