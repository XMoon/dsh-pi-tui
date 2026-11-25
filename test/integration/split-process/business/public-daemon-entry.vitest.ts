/**
 * Split-process public-entry business anchor.
 *
 * The ONLY evidence here is the REAL installed `dsh --profile …` CLI under a
 * native PTY, the product's own foreground Client, the detached public Host it
 * authenticates, the durable Session records and the public daemon management
 * commands. Nothing pre-starts a Host, injects an internal Client role or
 * reaches a private record sink: a public Client legitimately has none.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { expect, test } from 'vitest'

import {
  createSplitProcessScene,
  type PublicDaemonLaunch,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'

const linuxOnly = process.platform === 'linux'

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

test.skipIf(!linuxOnly)('keeps the default Direct launch independent of the split backend', async () => {
  const scene = await createSplitProcessScene()
  let launch: PublicDaemonLaunch | undefined
  let testError: unknown
  try {
    launch = await scene.startPublicDaemon({ label: 'direct-default', cols: 120, rows: 36 })
    expect(launch.ready, 'the default Direct launch reached a usable surface').toBe(true)
    expect(launch.host, 'a Direct launch owns no split Host').toBeNull()
    expect(launch.client, 'a Direct launch owns no split Client').toBeNull()
    expect(existsSync(join(scene.scopeDir, 'instance.json')),
      'a Direct launch published no split Host registry').toBe(false)
    await launch.type('direct default')
    await waitForFrame(launch, 'direct default', 'default Direct composer accepts input')
    await launch.press('Ctrl+U')
    await launch.submit('/exit')
    const exit = await launch.waitForExit(60_000)
    expect(exit.code, 'the default Direct CLI exit code').toBe(0)
    expect(exit.signal).toBe(null)
    await launch.close()
  } catch (error) {
    testError = error
    throw error
  } finally {
    const teardown: Error[] = []
    if (launch !== undefined) {
      try {
        if (!launch.closed) await launch.reclaim()
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
          'the default Direct test failed and its Scene cleanup also failed')
      }
      throw new AggregateError(teardown, 'the default Direct test cleanup failed')
    }
  }
})

test.skipIf(!linuxOnly)('starts one real public daemon Client and Host from the installed CLI', async () => {
  const scene = await createSplitProcessScene()
  let launch: PublicDaemonLaunch | undefined
  let testError: unknown
  try {
    launch = await scene.startPublicDaemon({
      label: 'cold',
      backend: 'daemon',
      cols: 140,
      rows: 40,
      loaderDump: true,
    })
    expect(launch.ready, 'the public daemon launch reached a usable surface').toBe(true)
    expect(launch.refused).toBe(false)
    expect(launch.cli, 'the real public CLI identity').not.toBeNull()
    expect(launch.client, 'the real foreground Client identity').not.toBeNull()
    expect(launch.host, 'the detached public Host identity').not.toBeNull()
    await waitForFrame(launch, '❯', 'public daemon composer')

    const rows = launch.loaderRows
    expect(rows, 'the parent daemon Loader dump').not.toBeNull()
    const byId = new Map((rows ?? []).map(row => [row.id, row]))
    const rowOf = (id: string) => byId.get(`include:${id}`) ?? byId.get(id)
    for (const id of [
      'session', 'session-persistence-jsonl', 'storage-json', 'jobs', 'typert-gateway',
      'remote-access', 'deepseek-account', 'authorization', 'credentials', 'workspace',
      'job-controller', 'webserver', 'pi-tui-extension-host', 'pi-tui-builtins',
      'pi-tui-performance-host', 'workspace-files', 'tui-app', 'workspace-controller',
      'directory-picker', 'pi-tui-schedule', 'pi-tui-direct-connection',
      'pi-tui-direct-file-upload', 'pi-tui-direct-session-controller',
    ]) {
      const row = rowOf(id)
      expect(row, `the real parent Loader row ${id} (actual ids: ${[...byId.keys()].join(',')})`).toBeDefined()
      expect(row?.disabled, `the second Host authority row ${id} is disabled`).toBe(true)
    }
    for (const id of ['timer', 'llm', 'tools']) {
      const row = rowOf(id)
      if (row !== undefined) expect(row.disabled, `the stateless Loader row ${id} is not disabled`).not.toBe(true)
    }
    expect(new Set(rows?.map(row => row.id)).size, 'the Loader dump has unique row ids').toBe(rows?.length)

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
        if (!launch.closed) await launch.reclaim()
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

test.skipIf(!linuxOnly || !ownershipRefusalProbe)(
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
