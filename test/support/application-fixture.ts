/**
 * S4-D3 application fixture (S4-D3 §6): mount the REAL PiTui runner on the
 * SAME real rc.2 Host composition the S4-D2 optional-bundle fixture boots, so
 * one test can follow an official Bundle → Host Service/Tool/Session →
 * existing Direct reader/port → mounted `TuiApp` sink.
 *
 * `PRODUCTION PREREQUISITES REPRODUCED`: the published rc.2 Optional bundle
 * packages and base family, the official profile/patch reader and boot Loader,
 * the real Agent/Session/ToolRuntime/Job/permission services, the production
 * TUI runner entry (`src/index.ts::apply`) and its real Direct application
 * composition.
 * `TEST STAND-INS`: the temporary profile/installation/home roots, the
 * deterministic VirtualTerminal (the physical process terminal is routed into
 * it), and a scripted LLM/tool transport inside the test that owns one.
 * `DELIBERATELY ABSENT`: the user's real DSH_HOME/credentials, network
 * installs inside tests, a physical terminal/OSC reader and any TUI screen row
 * that this fixture does not mount itself.
 *
 * The fixture adds NO Host service, no second Agent/Session registry and no
 * fake adapter into the verified path: it only mounts the production runner on
 * the already-booted Context.
 * @module @xmoon76/dsh-pi-tui/test/support/application-fixture
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Config as TuiConfig, apply as applyTui } from '../../src/index.ts'
import { TUI_STARTUP_SERVICE } from '../../src/startup.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { installVirtualProcessTerminal } from './runner-harness.ts'
import {
  startS4D2Host,
  type OptionalBundleHost,
  type OptionalBundleHostOptions,
} from './optional-bundle-fixture.ts'
import { testLifecycle } from './temp-lifecycle.ts'

export interface S4D3ApplicationOptions extends OptionalBundleHostOptions {
  /** The Session id the production runner RESUMES; omit to start a draft. */
  readonly sessionId?: string
  /** The preset the runner starts the session with (an official preset id). */
  readonly presetId?: string
  readonly columns?: number
  readonly rows?: number
  /** Extra production TUI config (never a capability stand-in). */
  readonly config?: Record<string, unknown>
  /** The process launch directory the production runner reads as its cwd.
   *  Defaults to the fixture's `sessionCwd` (or `<root>/work`). */
  readonly launchCwd?: string
  /** Seeds real Host state (agents/sessions/jobs) BEFORE the runner mounts,
   *  through the same Host services the test verifies. */
  readonly prepareHost?: (host: OptionalBundleHost) => void | Promise<void>
}

export interface S4D3Application {
  readonly host: OptionalBundleHost
  readonly vt: VirtualTerminal
  /** The live Agent the production runner owns, once a Session exists. */
  readonly agent: () => Agent | undefined
  view(): string
  viewport(): readonly string[]
  settle(rounds?: number): Promise<void>
  waitFor(predicate: () => boolean, label: string, timeoutMs?: number): Promise<void>
  /** Submit the first draft prompt and wait for the REAL Session the runner
   *  creates through `ctx.agents.create` (the production draft path). */
  submitFirstPrompt(text: string): Promise<Agent>
  /** The live Agent, loudly absent when the Session was never created. */
  requireAgent(): Agent
  /** Dispose the current Host composition and mount a FRESH production runner
   *  on the SAME profile root and VirtualTerminal (the disable+restart proof).
   *  `prepare` runs on the restarted Context (e.g. re-register the scripted
   *  LLM adapter, which the new Context does not retain). */
  restart(prepare?: (host: OptionalBundleHost) => void | Promise<void>): Promise<S4D3Application>
}

/** Mount the real TUI runner on the real Host Context. A `sessionId` resumes
 *  it; without one the runner paints the production draft surface and the
 *  first submitted prompt creates the Session. */
export async function startS4D3Application(
  t: TestContext,
  options: S4D3ApplicationOptions,
): Promise<S4D3Application> {
  const { sessionId, presetId, columns = 120, rows = 40, config = {}, launchCwd, prepareHost, ...hostOptions } = options
  // One module instance for every Host package: the official settings write
  // path depends on the boot/ConfigEditor identity.
  const host = await startS4D2Host(t, { ...hostOptions, installationBoot: hostOptions.installationBoot ?? true })
  const life = testLifecycle(t)
  // The production runner reads the LAUNCH directory as the new Session cwd
  // (`process.cwd()` in `src/app/bootstrap.ts`); stand in for `dsh` being
  // started from the fixture project.
  await prepareHost?.(host)
  const launch = launchCwd ?? hostOptions.sessionCwd ?? join(host.root, 'work')
  mkdirSync(launch, { recursive: true })
  const previousCwd = process.cwd()
  process.chdir(launch)
  life.defer(() => { process.chdir(previousCwd) })
  const vt = new VirtualTerminal(columns, rows)
  life.defer(installVirtualProcessTerminal(vt))
  return mountApplication(t, host, vt, { sessionId, presetId, config, launch })
}

async function mountApplication(
  t: TestContext,
  host: OptionalBundleHost,
  vt: VirtualTerminal,
  options: { readonly sessionId?: string; readonly presetId?: string; readonly config: Record<string, unknown>; readonly launch: string },
): Promise<S4D3Application> {
  const { sessionId, presetId, config, launch } = options
  // The runner owns exactly the Agent it creates/resumes; a fixture-seeded
  // live Agent is never mistaken for it.
  const seededAgentIds = new Set(host.ctx.agents.list().map(candidate => String(candidate.session.id)))
  process.chdir(launch)
  host.ctx.provide('appExit', () => {})
  host.ctx.provide(TUI_STARTUP_SERVICE, {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(presetId === undefined ? {} : { presetId }),
    shippedPresetRoot: join(host.root, 'home'),
  } as never)
  const fiber = host.ctx.plugin(pluginCtx => applyTui(
    pluginCtx,
    TuiConfig({ fullscreen: 'off', ...(sessionId === undefined ? {} : { sessionId }), ...config } as never),
  ))
  await fiber
  const runnerAgents = (): Agent[] => host.ctx.agents.list()
    .filter(candidate => !seededAgentIds.has(String(candidate.session.id))) as unknown as Agent[]
  // The TUI paints the CURRENT Session id in its welcome/identity card. Prefer
  // that fact over the roster's order: a `/new` transition retires the previous
  // owner but its live entry may still be listed for one turn.
  const paintedSessionId = (): string | undefined =>
    /session\s+(session-[0-9a-f-]+)/u.exec(
      vt.getViewport().map(line => line.replace(/\u001b\[[0-9;]*m/gu, '')).join('\n'),
    )?.[1]
  const liveAgent = (): Agent | undefined => {
    const painted = paintedSessionId()
    if (painted !== undefined) {
      const match = runnerAgents().find(candidate => String(candidate.session.id) === painted)
      if (match !== undefined) return match
    }
    return runnerAgents().at(-1)
  }
  const app: S4D3Application = {
    host,
    vt,
    agent: liveAgent,
    view: () => vt.getViewport().map(line => line.replace(/\u001b\[[0-9;]*m/gu, '')).join('\n'),
    viewport: () => vt.getViewport(),
    async settle(rounds = 12): Promise<void> {
      for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
      await vt.waitForRender()
    },
    async waitFor(predicate, label, timeoutMs = 60_000): Promise<void> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise<void>(resolve => setTimeout(resolve, 10))
        await vt.waitForRender()
      }
      throw new Error(`timed out waiting for ${label}:\n${app.view()}`)
    },
    async submitFirstPrompt(text: string): Promise<Agent> {
      for (const character of text) vt.sendInput(character)
      await app.settle()
      vt.sendInput('\r')
      await app.waitFor(() => liveAgent() !== undefined, 'the production runner creates the live Agent')
      await app.settle()
      return liveAgent() as Agent
    },
    requireAgent(): Agent {
      const agent = liveAgent()
      if (agent === undefined) throw new Error('the Session has not been created yet')
      return agent
    },
    async restart(prepare?: (host: OptionalBundleHost) => void | Promise<void>): Promise<S4D3Application> {
      // A fresh boot of the SAME profile root; the old Context (and its TUI
      // rows) is disposed by the official fixture's `restart()`.
      const restarted = await host.restart()
      await prepare?.(restarted)
      return mountApplication(t, restarted, vt, { ...options, sessionId: undefined })
    },
  }
  await app.settle()
  return app
}
