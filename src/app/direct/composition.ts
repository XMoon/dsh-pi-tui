/**
 * The public agent-composition helper's Direct implementation (plan §27):
 * resolve the preset an agent will be composed from and build the setup that
 * installs it — the Agent-scoped runtime contributions, the preset mount, and
 * the TUI prompt sections.
 *
 * Direct-only by construction (the Host preset registry), so it lives under
 * `app/direct`; the package entry keeps the public signature and delegates
 * here, which keeps the entry point one-way (index -> bootstrap -> app/direct).
 * @module @xmoon76/dsh-pi-tui/app/direct/composition
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ProgressUpdatesState, ResponseStyleState } from '../../domain/communication/policy.ts'
import type { GitAttributionState } from '../../domain/communication/git-attribution.ts'
import { installDirectTuiSystemPromptSections } from './system-prompt.ts'
import type { DisplayState } from '../../domain/display/preset.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { recordedSessionPreset } from '../../runtime/direct/session-preset-direct.ts'

/** One agent's preset composition: the id to record and the setup that installs it. */
export interface DirectAgentComposition {
  /** Preset id for the session header, absent when the deployment composes no roster. */
  agentPreset?: string
  /** Agent-factory setup: model selection, then the preset mount when composed. */
  setup: (agentCtx: Context, agent: Agent) => Promise<void> | void
}

export async function composeDirectAgent(
  ctx: Context,
  installSelection: (agentCtx: Context, agent: Agent) => void,
  presetId?: string,
  displayState?: DisplayState,
  diag?: Diag,
  progressUpdatesState?: ProgressUpdatesState,
  responseStyleState?: ResponseStyleState,
  gitAttributionState?: GitAttributionState,
): Promise<DirectAgentComposition> {
  const installTuiPrompts = (agentCtx: Context): void => {
    installDirectTuiSystemPromptSections(agentCtx, {
      displayState,
      diag,
      progressUpdatesState,
      responseStyleState,
      gitAttributionState,
    })
  }
  const presets = ctx.get('agentPresets')
  if (presets === undefined) {
    return {
      setup: (agentCtx: Context, agent: Agent): void => {
        installSelection(agentCtx, agent)
        installTuiPrompts(agentCtx)
      },
    }
  }
  // The official registry owns identity resolution (unknown/broken ids are
  // refused by `resolve`); the TUI only maps the concrete id onto the new
  // Agent's composition. There is deliberately NO legacy alias here: a
  // requested id — `code` included — is an ordinary preset id.
  const resolved = await presets.resolve(presetId)
  const finishSetup = async (agentCtx: Context): Promise<void> => {
    await presets.mount(agentCtx, resolved.id)
    // Install after the preset mounts its services. Preset-only recomposition
    // preserves these outer-scoped sections; a new agent installs them anew.
    installTuiPrompts(agentCtx)
  }
  return {
    agentPreset: resolved.id,
    setup: async (agentCtx: Context, agent: Agent): Promise<void> => {
      installSelection(agentCtx, agent)
      await finishSetup(agentCtx)
    },
  }
}

export async function recordedDirectPreset(ctx: Context, sessionId: string): Promise<string | undefined> {
  return recordedSessionPreset(ctx, sessionId)
}
