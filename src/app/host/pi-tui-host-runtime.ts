/**
 * The bundle's ONE built-in PiTui Host Runtime row:
 * `@xmoon76/dsh-pi-tui/host-runtime`.
 *
 * This is a HOST-plane Cordis plugin, not a TUI module and not a
 * user-configurable business plugin. A real Host Profile mounts it exactly
 * once to own the private business modules that belong to this package:
 *
 * ```text
 * the package's ONE private Typert contribution (all private descriptors)
 * the private `piTuiFileReferences` Host service
 * the private `piTuiTerminalProgress` Host service
 * the private `piTuiWebAccess` Host service (official Web frontend toggle)
 * the private `piTuiHostUserShell` Host service (one-shot Shell and completion)
 * the private `piTuiSkills` Host service (standing metadata and invalidation)
 * the private `piTuiAuthorization` Host service (provider-native sign-in)
 * ```
 *
 * The row publishes the data-free `piTuiHostReady` gate only after the
 * contribution and ALL service bindings are actually live, so a Host
 * readiness audit can depend on ordering instead of trusting a declared row.
 * It never mounts a second Connection/Gateway/Session stack, never registers
 * the official Session-serving services, and never owns a Host root: the
 * launching Profile Loader owns this fiber and its disposal.
 *
 * @module @xmoon76/dsh-pi-tui/app/host/pi-tui-host-runtime
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import { Config as TuiConfig, type Config as TuiConfigValue } from '../config/schema.ts'
import { PI_TUI_HOST_CONTRIBUTION } from '../../runtime/remote/pi-tui-remote-contribution.ts'
import { PI_TUI_FILE_REFERENCES_NAMESPACE } from '../../runtime/remote/pi-tui-file-reference-contract.ts'
import { PI_TUI_TERMINAL_PROGRESS_NAMESPACE } from '../../runtime/remote/pi-tui-terminal-progress-contract.ts'
import { PI_TUI_WEB_ACCESS_NAMESPACE } from '../../runtime/remote/pi-tui-web-access-contract.ts'
import { PI_TUI_HOST_USER_SHELL_NAMESPACE } from '../../runtime/remote/pi-tui-host-user-shell-contract.ts'
import { PI_TUI_SKILLS_NAMESPACE } from '../../runtime/remote/pi-tui-skills-contract.ts'
import { PI_TUI_AUTHORIZATION_NAMESPACE } from '../../runtime/remote/pi-tui-authorization-contract.ts'
import { createHostShellPathCompletionBridge } from '../../runtime/remote/pi-tui-host-user-shell-host-bridge.ts'
import { mergeCause } from '../remote/dispose-cause.ts'
import {
  PiTuiFileReferenceHostService,
  type FileReferencesServiceLike,
  type LiveAgentLike,
  type WorkspaceRegistryPort,
} from './features/file-reference.ts'
import {
  PiTuiTerminalProgressHostService,
  type LiveAgentLike as TerminalProgressLiveAgentLike,
} from './features/terminal-progress.ts'
import { PiTuiWebAccessHostService } from './features/web-access.ts'
import { PiTuiHostUserShellService } from './features/host-user-shell.ts'
import {
  PiTuiSkillsHostService,
  type AgentPresetRegistryLike,
  type SkillRegistryLike,
  type WorkspaceRegistryLike,
} from './features/skills.ts'
import {
  PiTuiAuthorizationHostService,
  type PiTuiAuthorizationHostDeps,
} from './features/authorization.ts'

/** Stable Cordis plugin name (the Loader row id in the Host-only overlay). */
export const name = 'pi-tui-host-runtime'

/** The Host-only row reuses the same TUI settings schema as the Direct row. */
export const Config = TuiConfig

/**
 * Explicit Host dependencies: the private Typert registry plus the two live
 * Host facts the business rows resolve per call. `tuiStartup` remains a Loader
 * row gate (see the Host-only overlay), not a plugin inject. The Web access row
 * resolves the Host's OWN Loader through the service on every call, so this
 * published row contract does not change: this row IS a Loader row, and a Host
 * without a Loader fails closed (`unavailable`) instead of pending forever.
 */
export const inject = [
  'typert', 'agents', 'fileReferences', 'workingDirectory', 'sessions',
  'sandboxPolicy', 'sandbox', 'subprocess', 'workspaceRegistry', 'skills', 'agentPresets',
]

/** Data-free readiness gate published after the whole built-in runtime is live. */
export const PI_TUI_HOST_READY_SERVICE = 'piTuiHostReady'

/** The narrow structural view of the authoritative Host Agent registry. */
interface AgentRegistryLike {
  get(sessionId: string): unknown
}

/**
 * Read the LIVE Agent of one Session through the authoritative Host registry
 * PER CALL: a replaced registry or Agent must be observed, never a
 * composition-time snapshot.
 */
function agentFor(ctx: Context, sessionId: string): unknown {
  const agents = ctx.reflect.get('agents') as AgentRegistryLike | undefined
  return agents?.get(sessionId)
}

/**
 * Assert one private Typert service is readable through its exact Cordis
 * service key and carries the expected wire namespace. A truthy service alone
 * is not proof: the Gateway dispatches on the binding, not the service object.
 */
function assertPrivateBinding(ctx: Context, serviceKey: string, namespace: string): void {
  const service = ctx.reflect.get(serviceKey) as
    { readonly typertRemote?: { readonly serviceKey?: unknown; readonly namespace?: unknown } } | undefined
  if (service === undefined) {
    throw new Error(`pi-tui-host-runtime: the "${serviceKey}" service is not readable`)
  }
  const binding = service.typertRemote
  if (binding === undefined) {
    throw new Error(`pi-tui-host-runtime: the "${serviceKey}" service has no Typert binding`)
  }
  if (binding.serviceKey !== serviceKey) {
    throw new Error(
      `pi-tui-host-runtime: the "${serviceKey}" Typert service key is ${JSON.stringify(binding.serviceKey)}`,
    )
  }
  if (binding.namespace !== namespace) {
    throw new Error(
      `pi-tui-host-runtime: the "${serviceKey}" Typert namespace is ${JSON.stringify(binding.namespace)}`,
    )
  }
}

/**
 * Mount the built-in PiTui Host Runtime on the launching Host Context.
 *
 * Startup order is fixed: register the package's ONE contribution, mount the
 * file-reference service, mount the terminal-progress service, mount the Web
 * access service, verify ALL live bindings, then publish the readiness gate.
 * Every child fiber is recorded BEFORE it is awaited; a partial rejection
 * disposes the recorded children in reverse order (contribution last) while
 * keeping the original error primary and attaching cleanup failures to its
 * cause chain.
 */
export async function apply(ctx: Context, config: TuiConfigValue): Promise<void> {
  const fibers: Fiber[] = []
  let disposeContribution: (() => Promise<void>) | undefined
  try {
    disposeContribution = ctx.effect(
      () => ctx.typert.register(PI_TUI_HOST_CONTRIBUTION),
      'pi-tui-private-remote-host',
    )
    const fileReferenceFiber = ctx.inject(PiTuiFileReferenceHostService.inject, pluginCtx => {
      new PiTuiFileReferenceHostService(pluginCtx, {
        agentFor: sessionId => agentFor(ctx, sessionId) as LiveAgentLike | undefined,
        official: () => ctx.reflect.get('fileReferences') as FileReferencesServiceLike | undefined,
        workspaces: () => ctx.reflect.get('workspaceRegistry') as WorkspaceRegistryPort | undefined,
      })
    })
    fibers.push(fileReferenceFiber)
    await fileReferenceFiber
    const terminalProgressFiber = ctx.inject(PiTuiTerminalProgressHostService.inject, pluginCtx => {
      new PiTuiTerminalProgressHostService(pluginCtx, {
        agentFor: sessionId => agentFor(ctx, sessionId) as TerminalProgressLiveAgentLike | undefined,
        onUnknownReason: kind => {
          ctx.logger('pi-tui-host-runtime').warn('terminal progress: unknown turn/end reason', { kind })
        },
      })
    })
    fibers.push(terminalProgressFiber)
    await terminalProgressFiber
    const webAccessFiber = ctx.inject(PiTuiWebAccessHostService.inject, pluginCtx => {
      new PiTuiWebAccessHostService(pluginCtx)
    })
    fibers.push(webAccessFiber)
    await webAccessFiber
    const hostUserShellFiber = ctx.inject(PiTuiHostUserShellService.inject, pluginCtx => {
      new PiTuiHostUserShellService(pluginCtx, {
        agentFor: sessionId => agentFor(ctx, sessionId) as import('./features/host-user-shell.ts').HostAgentLike | undefined,
        sessionFor: sessionId => (ctx.reflect.get('sessions') as AgentRegistryLike | undefined)?.get(sessionId) as import('./features/host-user-shell.ts').HostSessionLike | undefined,
        workingDirectory: () => ctx.reflect.get('workingDirectory') as import('./features/host-user-shell.ts').WorkingDirectoryLike | undefined,
        sandboxPolicy: () => ctx.reflect.get('sandboxPolicy') as import('./features/host-user-shell.ts').SandboxPolicyServiceLike | undefined,
        sandbox: () => ctx.reflect.get('sandbox') as import('./features/host-user-shell.ts').SandboxServiceLike | undefined,
        subprocess: () => ctx.reflect.get('subprocess') as import('./features/host-user-shell.ts').SubprocessServiceLike | undefined,
        pathCompletion: createHostShellPathCompletionBridge(),
        shellPolicy: () => config.localShellSandbox.get() === 'sandbox' ? 'sandbox' : 'bypass',
      })
    })
    fibers.push(hostUserShellFiber)
    await hostUserShellFiber
    const skillsFiber = ctx.inject(PiTuiSkillsHostService.inject, pluginCtx => {
      new PiTuiSkillsHostService(pluginCtx, {
        workspaces: () => ctx.reflect.get('workspaceRegistry') as WorkspaceRegistryLike | undefined,
        skills: () => ctx.reflect.get('skills') as SkillRegistryLike | undefined,
        agentPresets: () => ctx.reflect.get('agentPresets') as AgentPresetRegistryLike | undefined,
      })
    })
    fibers.push(skillsFiber)
    await skillsFiber
    // The provider-native sign-in bridge resolves the OFFICIAL authorization
    // service per call: a Host without that plugin is a truthful `unavailable`,
    // never a hard inject that would keep the whole Split Host from starting.
    const authorizationFiber = ctx.inject(PiTuiAuthorizationHostService.inject, pluginCtx => {
      new PiTuiAuthorizationHostService(pluginCtx, {
        authorization: () => ctx.reflect.get('authorization') as ReturnType<PiTuiAuthorizationHostDeps['authorization']>,
      })
    })
    fibers.push(authorizationFiber)
    await authorizationFiber
    assertPrivateBinding(ctx, 'piTuiFileReferences', PI_TUI_FILE_REFERENCES_NAMESPACE)
    assertPrivateBinding(ctx, 'piTuiTerminalProgress', PI_TUI_TERMINAL_PROGRESS_NAMESPACE)
    assertPrivateBinding(ctx, 'piTuiWebAccess', PI_TUI_WEB_ACCESS_NAMESPACE)
    assertPrivateBinding(ctx, 'piTuiHostUserShell', PI_TUI_HOST_USER_SHELL_NAMESPACE)
    assertPrivateBinding(ctx, 'piTuiSkills', PI_TUI_SKILLS_NAMESPACE)
    assertPrivateBinding(ctx, 'piTuiAuthorization', PI_TUI_AUTHORIZATION_NAMESPACE)
    ctx.provide(PI_TUI_HOST_READY_SERVICE, {})
  } catch (error) {
    const cleanupErrors: unknown[] = []
    for (let index = fibers.length - 1; index >= 0; index -= 1) {
      try {
        await fibers[index].dispose()
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    if (disposeContribution !== undefined) {
      try {
        await disposeContribution()
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    const primary = error instanceof Error ? error : new Error(String(error))
    if (cleanupErrors.length === 0) throw primary
    const secondary = cleanupErrors.length === 1
      ? cleanupErrors[0]
      : new AggregateError(cleanupErrors, 'pi-tui-host-runtime: child disposal failures')
    throw mergeCause(primary, secondary)
  }
}
