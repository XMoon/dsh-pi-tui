/**
 * Split-process public-entry business anchor.
 *
 * The ONLY evidence here is the REAL installed `dsh --profile …` CLI under a
 * native PTY, the product's own foreground Client, the detached public Host it
 * authenticates, the durable Session records and the public daemon management
 * commands. Nothing pre-starts a Host, injects an internal Client role or
 * reaches a private record sink: a public Client legitimately has none.
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { expect, test } from 'vitest'

import {
  createSplitProcessScene,
  type PublicDaemonLaunch,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'

async function frameText(launch: PublicDaemonLaunch): Promise<string> {
  return await launch.text()
}

async function waitForFrame(
  launch: PublicDaemonLaunch,
  text: string,
  label: string,
  timeoutMs = 120_000,
): Promise<string> {
  const started = Date.now()
  for (;;) {
    const frame = await frameText(launch).catch(() => '')
    if (frame.includes(text)) return frame
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: the current frame never showed ${JSON.stringify(text)}; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(50)
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

async function exitPublicLaunch(launch: PublicDaemonLaunch, label: string): Promise<void> {
  await launch.submit('/exit')
  const exit = await launch.waitForExit(120_000)
  expect(exit.code, `${label}: the public CLI exit code`).toBe(0)
  expect(exit.signal, `${label}: the public CLI exit signal`).toBe(null)
  expect(exit.text, `${label}: the daemon detach line`).toContain('Disconnected from dsh-pi-tui (daemon client).')
  await launch.close()
}

test('starts one real public daemon Client and Host from the installed CLI', async () => {
  const scene = await createSplitProcessScene()
  let launch: PublicDaemonLaunch | undefined
  let testError: unknown
  try {
    launch = await scene.startPublicDaemon({
      label: 'cold',
      backend: 'daemon',
      cols: 140,
      rows: 40,
    })
    expect(launch.ready, 'the public daemon launch reached a usable surface').toBe(true)
    expect(launch.refused).toBe(false)
    expect(launch.cli, 'the real public CLI identity').not.toBeNull()
    expect(launch.client, 'the real foreground Client identity').not.toBeNull()
    expect(launch.host, 'the detached public Host identity').not.toBeNull()
    await waitForFrame(launch, '❯', 'public daemon composer')

    const status = await launch.daemonStatus()
    expect(status.exit.code, 'public daemon status exit code').toBe(0)
    expect(status.exit.signal).toBe(null)
    expect(status.fields.host, `public daemon status host (${JSON.stringify(status.fields)})`).toBe('ready')
    expect(status.fields.manager).toBe('process')
    expect(status.fields.unit).toBe('none')

    const before = new Set(await scene.sessionIds())
    await launch.submit('public cold start')
    const sessionId = await scene.waitForNewSessionId(before, 'public cold Session')
    const header = await scene.waitForHostSessionHeader(sessionId, 'public cold Session header')
    expect(header.type, 'the durable Session header').toBe('session')
    await scene.waitForSessionEvent(sessionId, 0,
      event => event.type === 'user/message' && JSON.stringify(event.data ?? {}).includes('public cold start'),
      'public cold user prompt')
    await scene.waitForSessionEvent(sessionId, 0,
      event => event.type === 'assistant/message' && JSON.stringify(event.data ?? {}).includes('stub answer'),
      'public cold assistant answer')
    await waitForFrame(launch, 'stub answer', 'public cold painted answer')

    const stillRunning = await launch.daemonStatus()
    expect(stillRunning.fields.host, 'the Host survives the Client /exit').toBe('ready')

    await exitPublicLaunch(launch, 'public cold launch')
    await launch.stopHost()
    const stopped = await launch.daemonStatus()
    expect(stopped.fields.host, `public daemon host after stop (${JSON.stringify(stopped.fields)})`).toBe('stopped')
  } catch (error) {
    testError = error
    throw error
  } finally {
    const teardown: Error[] = []
    if (launch !== undefined) {
      try {
        if (!launch.closed) await launch.close()
      } catch (error) {
        teardown.push(asError(error))
      }
    }
    try {
      await scene.dispose()
    } catch (error) {
      teardown.push(asError(error))
    }
    if (teardown.length > 0) {
      if (testError !== undefined) {
        throw new AggregateError([testError, ...teardown],
          'the public daemon business test failed and its Scene cleanup also failed')
      }
      throw new AggregateError(teardown, 'the public daemon business test cleanup failed')
    }
  }
})

const ownershipRefusalProbe = process.env.SPLIT_VITEST_PROCESS_PROBE_POINT === 'public-daemon-ownership-refused'

test.skipIf(!ownershipRefusalProbe)(
  'refuses an unproven public Host ownership signal and compensates truthfully',
  async () => {
    const scene = await createSplitProcessScene()
    const launch = await scene.startPublicDaemon({
      label: 'ownership-refusal',
      backend: 'daemon',
    })
    expect(launch.ready).toBe(true)
    expect(launch.host).not.toBeNull()
    await scene.report('public-daemon-ownership-refused-ready', {
      workerPid: process.pid,
      launchId: launch.launchId,
      hostPid: launch.host?.pid,
      hostBirth: launch.host?.birth,
      instanceId: launch.host?.instanceId,
      cliPid: launch.cli?.pid,
      clientPid: launch.client?.pid,
    })
    // The external probe kills this Worker after it observed the live public
    // launch. Reaching this timer without a kill means the probe failed.
    await new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('public-daemon-ownership-refused: no external Worker kill arrived')), 180_000)
    })
  },
)
