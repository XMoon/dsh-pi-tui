/**
 * The public agent-composition helper's Direct implementation (plan §27):
 * resolve the preset an agent will be composed from and build the setup that
 * installs it — the Agent-scoped model selection, the preset mount, and the
 * TUI prompt sections.
 *
 * Direct-only by construction (the Host preset registry, `installModelSelection`),
 * so it lives under `app/direct`; the package entry keeps the public overloads
 * and delegates here, which keeps the entry point one-way (index -> bootstrap
 * -> app/direct).
 * @module @xmoon76/dsh-pi-tui/app/direct/composition
 */

import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { installProgressUpdatesPrompt, installResponseStylePrompt, type ProgressUpdatesState, type ResponseStyleState } from '../../communication-policy.ts'
import { installFocusPrompt, type SystemPromptLike } from '../../focus.ts'
import type { DisplayState } from '../../display-preset.ts'
import type { Diag } from '../../diag.ts'
import { recordedSessionPreset } from '../../runtime/direct/session-preset-direct.ts'

/** One agent's preset composition: the id to record and the setup that installs it. */
export interface DirectAgentComposition {
  /** Preset id for the session header, absent when the deployment composes no roster. */
  agentPreset?: string
  /** Agent-factory setup: model selection, then the preset mount when composed. */
  setup: (agentCtx: Context, agent: Agent) => Promise<void> | void
}

/**
 * Source-compatible composition returned for standalone callers that provide
 * their own ModelSelectionRef instead of an Agent-local installer.
 */
interface DirectLegacyAgentComposition {
  /** Preset id for the session header, absent when the deployment composes no roster. */
  agentPreset?: string
  /** Standalone setup installs the caller-owned model selection ref. */
  setup: (agentCtx: Context) => Promise<void> | void
}
export async function composeDirectAgent(
  ctx: Context,
  installSelection: ModelSelectionRef | ((agentCtx: Context, agent: Agent) => void),
  presetId?: string,
  displayState?: DisplayState,
  diag?: Diag,
  progressUpdatesState?: ProgressUpdatesState,
  responseStyleState?: ResponseStyleState,
): Promise<DirectLegacyAgentComposition | DirectAgentComposition> {
  const installTuiPrompts = (agentCtx: Context): void => {
    if (progressUpdatesState !== undefined || responseStyleState !== undefined) {
      const systemPrompt = agentCtx.get('systemPrompt') as SystemPromptLike | undefined
      if (systemPrompt !== undefined) {
        // The progress section's effective text reads the live display state
        // (Focus suppresses it), so it needs both live states.
        if (progressUpdatesState !== undefined && displayState !== undefined) {
          installProgressUpdatesPrompt(systemPrompt, displayState, progressUpdatesState)
        } else if (progressUpdatesState !== undefined) {
          diag?.warn('progress updates prompt unavailable', { reason: 'display state missing' })
        }
        if (responseStyleState !== undefined) installResponseStylePrompt(systemPrompt, responseStyleState)
      } else {
        diag?.warn('communication policy prompt unavailable', { reason: 'systemPrompt service missing' })
      }
    }
    if (displayState !== undefined) installFocusPrompt(agentCtx, displayState, diag)
  }
  const presets = ctx.get('agentPresets')
  if (presets === undefined) {
    if (typeof installSelection === 'function') {
      return {
        setup: (agentCtx: Context, agent: Agent): void => {
          installSelection(agentCtx, agent)
          installTuiPrompts(agentCtx)
        },
      }
    }
    return {
      setup: (agentCtx: Context): void => {
        installModelSelection(agentCtx, installSelection)
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
  if (typeof installSelection === 'function') {
    return {
      agentPreset: resolved.id,
      setup: async (agentCtx: Context, agent: Agent): Promise<void> => {
        installSelection(agentCtx, agent)
        await finishSetup(agentCtx)
      },
    }
  }
  return {
    agentPreset: resolved.id,
    setup: async (agentCtx: Context): Promise<void> => {
      installModelSelection(agentCtx, installSelection)
      await finishSetup(agentCtx)
    },
  }
}

export async function recordedDirectPreset(ctx: Context, sessionId: string): Promise<string | undefined> {
  return recordedSessionPreset(ctx, sessionId)
}
