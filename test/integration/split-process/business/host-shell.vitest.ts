/**
 * Split-process business anchor: Host user-shell execution, policy enforcement
 * and lifecycle isolation over the packed PTY Host/Client path.
 *
 * Case 1 runs one Scene with two sequential Host generations (`shell-execution`
 * bypass -> `shell-sandbox` sandbox) to qualify Host locality, raw Bash
 * semantics, `!` vs `!!`, live multiline Tab completion via bracketed paste,
 * bounded large-stream truncation, and positive/negative sandbox confinement
 * against the same non-temp outside target.
 *
 * Case 2 runs one `shell-lifecycle` Host with two seeded Sessions and two live
 * Clients to qualify captured-Session stale refusal, SIGUSR1 carrier drop
 * unknown-outcome non-replay, and concurrent Esc cancellation isolation using
 * real OS kernel identities.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { expect, test } from 'vitest'

import {
  readKernelProcess,
  sameKernelProcess,
  type KernelProcessIdentity,
} from '../../../../src/runtime/native-process/identity.ts'
import {
  createSplitProcessScene,
  type SessionEvent,
  type SplitProcessClient,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'

type WorkEvent = Record<string, any>

const { waitForC1WorkEvent } = await import(
  pathToFileURL(join(process.cwd(), 'scripts', 'lib', 'split-smoke-fixtures.mjs')).href
) as {
  waitForC1WorkEvent(
    root: string,
    predicate: (event: WorkEvent) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<WorkEvent>
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function splitFrame(frame: string): { composer: string; below: string } {
  const lines = frame.split('\n')
  const ruleIndices: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^─{10,}$/u.test(lines[index]!.trim())) ruleIndices.push(index)
  }
  if (ruleIndices.length < 2) return { composer: '', below: '' }
  const top = ruleIndices.at(-2)!
  const bottom = ruleIndices.at(-1)!
  return {
    composer: lines.slice(top + 1, bottom).join('\n'),
    below: lines.slice(bottom + 1).join('\n'),
  }
}

function composerRows(frame: string): string[] {
  return splitFrame(frame).composer
    .split('\n')
    .map(line => line.replace(/[│┌┐└┘─]/gu, ' ').trim())
    .filter(Boolean)
}

async function waitForFrame(
  client: SplitProcessClient,
  predicate: (frame: string) => boolean,
  label: string,
  timeoutMs = 120_000,
): Promise<string> {
  const started = Date.now()
  for (;;) {
    const frame = await client.text()
    if (predicate(frame)) return frame
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: condition not met within ${String(timeoutMs)}ms; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(50)
  }
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 60_000,
): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: condition not met within ${String(timeoutMs)}ms`)
    }
    await sleep(50)
  }
}

async function waitForEmptyMode(
  client: SplitProcessClient,
  mode: 'prompt' | '!' | '!!',
  label: string,
  timeoutMs = 60_000,
): Promise<void> {
  const glyph = mode === 'prompt' ? '❯' : mode
  await waitForFrame(client, frame => {
    const first = composerRows(frame)[0] ?? ''
    if (glyph === '!' && first.startsWith('!!')) return false
    if (!first.startsWith(glyph)) return false
    const body = first.slice(glyph.length).replace(/[\s.…·]+$/u, '').trim()
    return body === '' || /^[…·]+$/u.test(body)
  }, label, timeoutMs)
}

async function enterShellMode(
  client: SplitProcessClient,
  mode: '!' | '!!',
  label: string,
): Promise<void> {
  await waitForEmptyMode(client, 'prompt', `${label}: empty prompt`)
  await client.type('!')
  await waitForEmptyMode(client, '!', `${label}: painted ! mode`)
  if (mode === '!!') {
    await client.type('!')
    await waitForEmptyMode(client, '!!', `${label}: painted !! mode`)
  }
}

async function submitShellCommand(
  client: SplitProcessClient,
  mode: '!' | '!!',
  command: string,
  draftNeedle: string,
  label: string,
): Promise<void> {
  await enterShellMode(client, mode, label)
  await client.type(command)
  await waitForFrame(
    client,
    frame => splitFrame(frame).composer.includes(draftNeedle),
    `${label}: painted command draft`,
    30_000,
  )
  await client.press('Enter')
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((part: Record<string, any>) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: Record<string, any>) => String(part.text))
    .join('\n')
}

function userMessageText(event: SessionEvent): string | undefined {
  if (event.type !== 'user/message') return undefined
  const data = event.data as Record<string, any> | undefined
  if (data?.source?.kind !== 'user' || !Array.isArray(data.content)) return undefined
  return contentText(data.content)
}

function humanUserTexts(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => {
    const text = userMessageText(event)
    return text === undefined ? [] : [text]
  })
}

function markerInDurableUserSink(events: readonly SessionEvent[], marker: string): boolean {
  for (const event of events) {
    const data = event.data as Record<string, any> | undefined
    if (event.type === 'user/message' && contentText(data?.content).includes(marker)) return true
    if (event.type === 'agent/inbox/spliced' && Array.isArray(data?.inserted)) {
      if (data.inserted.some((msg: Record<string, any>) => contentText(msg?.content).includes(marker))) return true
    }
  }
  return false
}

async function waitForCompletedUserShellTurn(
  scene: SplitProcessScene,
  sessionId: string,
  afterIndex: number,
  marker: string,
  label: string,
): Promise<{ userEvent: SessionEvent; userText: string }> {
  const userEvent = await scene.waitForSessionEvent(
    sessionId,
    afterIndex,
    event => {
      const text = userMessageText(event)
      return text !== undefined && text.includes(marker)
    },
    `${label}: durable human shell user/message`,
  )
  const userSeq = userEvent.seq
  expect(userSeq, `${label}: durable user sequence`).toBeTypeOf('number')
  const eventsAtUser = scene.sessionEvents(sessionId) ?? []
  const turnStart = eventsAtUser
    .filter(event => event.type === 'turn/start'
      && typeof (event.data as Record<string, any>)?.turn === 'number'
      && typeof event.seq === 'number'
      && event.seq < userSeq!)
    .at(-1)
  expect(turnStart, `${label}: enclosing turn/start before user/message`).toBeDefined()
  const turn = (turnStart!.data as Record<string, any>).turn as number
  const endedBeforeUser = eventsAtUser.some(event => event.type === 'turn/end'
    && (event.data as Record<string, any>)?.turn === turn
    && typeof event.seq === 'number'
    && event.seq <= userSeq!)
  expect(endedBeforeUser, `${label}: enclosing turn ${String(turn)} was already ended before user/message`).toBe(false)
  const assistantEvent = await scene.waitForSessionEvent(
    sessionId,
    0,
    event => event.type === 'assistant/message'
      && (event.data as Record<string, any>)?.turn === turn
      && typeof event.seq === 'number'
      && event.seq > userSeq!,
    `${label}: assistant/message for turn ${String(turn)} after user/message`,
  )
  const assistantSeq = assistantEvent.seq!
  await scene.waitForSessionEvent(
    sessionId,
    0,
    event => event.type === 'turn/end'
      && (event.data as Record<string, any>)?.turn === turn
      && (event.data as Record<string, any>)?.reason?.kind === 'completed'
      && typeof event.seq === 'number'
      && event.seq > assistantSeq,
    `${label}: turn/end completed for turn ${String(turn)} after assistant/message`,
  )
  return { userEvent, userText: userMessageText(userEvent)! }
}

async function waitForLocalShellSettled(
  client: SplitProcessClient,
  uniqueMarker: string,
  expectedOutcome: string | RegExp,
  label: string,
  timeoutMs = 60_000,
): Promise<string> {
  return await waitForFrame(client, frame => {
    const lines = frame.split('\n')
    const indexes = lines.flatMap((line, index) => line.includes('Shell') && line.includes(uniqueMarker) ? [index] : [])
    return indexes.some(index => {
      if (lines[index + 1]?.includes('$ ') !== true) return false
      const bodyLines = lines.slice(index + 2, index + 5)
      return bodyLines.some(outcomeLine => typeof expectedOutcome === 'string'
        ? outcomeLine.includes(expectedOutcome)
        : expectedOutcome.test(outcomeLine))
    })
  }, `${label}: settled local Shell Card`, timeoutMs)
}

async function assertExpandedLocalShellFacts(
  client: SplitProcessClient,
  expectedFacts: readonly (string | RegExp)[],
  label: string,
): Promise<string> {
  await client.press('Ctrl+O')
  try {
    return await waitForFrame(
      client,
      frame => expectedFacts.every(fact => typeof fact === 'string' ? frame.includes(fact) : fact.test(frame)),
      `${label}: expanded Shell facts`,
      30_000,
    )
  } finally {
    await client.press('Ctrl+O')
  }
}

async function waitForKernelPidFile(
  pidPath: string,
  label: string,
): Promise<KernelProcessIdentity> {
  let identity: KernelProcessIdentity | undefined
  await waitForCondition(() => {
    if (!existsSync(pidPath)) return false
    const raw = readFileSync(pidPath, 'utf8').trim()
    const pid = Number(raw)
    if (!Number.isInteger(pid) || pid <= 0) return false
    const observation = readKernelProcess(pid)
    if (observation.kind !== 'alive') return false
    identity = observation.identity
    return true
  }, `${label}: live Host Bash kernel identity`, 30_000)
  return identity!
}

async function waitForKernelProcessTerminal(
  identity: KernelProcessIdentity,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  await waitForCondition(() => {
    const verdict = sameKernelProcess(identity, readKernelProcess(identity.pid))
    return verdict === 'gone' || verdict === 'different'
  }, `${label}: Host Bash process terminal`, timeoutMs)
}

async function disposeScene(scene: SplitProcessScene, primary: unknown): Promise<void> {
  try {
    await scene.dispose()
  } catch (cleanupError) {
    if (primary !== undefined) {
      throw new AggregateError([primary, cleanupError], 'host-shell failed and Scene cleanup also failed')
    }
    throw cleanupError
  }
}

test('executes Host shell modes and bounds results under the selected execution policy', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const hostHome = scene.installation.base.env.HOME
    expect(hostHome, 'Scene installation must expose isolated Host HOME').toBeTypeOf('string')
    const canonicalHostHome = realpathSync(hostHome!)

    const shellWorkspace = join(scene.workDir, 'shell-workspace')
    const outsideWorkspace = join(scene.workDir, 'outside-workspace')
    const clientHome = join(scene.workDir, 'shell-exec-client-home')
    const clientCwd = join(scene.workDir, 'shell-exec-client-cwd')
    for (const dir of [shellWorkspace, outsideWorkspace, clientHome, clientCwd]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const canonicalWorkspace = realpathSync(shellWorkspace)
    const canonicalOutside = realpathSync(outsideWorkspace)
    const canonicalClientHome = realpathSync(clientHome)
    const canonicalClientCwd = realpathSync(clientCwd)
    expect(canonicalClientHome).not.toBe(canonicalHostHome)
    expect(canonicalClientCwd).not.toBe(canonicalWorkspace)
    expect(relative(canonicalWorkspace, canonicalOutside).startsWith(`..${sep}`)).toBe(true)
    expect(relative(canonicalHostHome, canonicalOutside).startsWith(`..${sep}`)).toBe(true)

    const hostFileMarker = 'HOST_SHELL_SCOPE_FILE_MARKER'
    const clientPoisonMarker = 'CLIENT_SHELL_POISON_MARKER'
    writeFileSync(join(canonicalWorkspace, 'shell-scope-host.txt'), `${hostFileMarker}\n`, { mode: 0o600 })
    writeFileSync(join(canonicalClientCwd, 'shell-scope-host.txt'), `${clientPoisonMarker}\n`, { mode: 0o600 })
    writeFileSync(join(canonicalClientCwd, 'shell-scope-client.txt'), `${clientPoisonMarker}\n`, { mode: 0o600 })

    // ── A. Bypass generation & live Session locality ────────────────────────
    const bypassHost = await scene.startHost({ scenario: 'shell-execution' })
    expect(bypassHost.workloadRoot).toBeTypeOf('string')
    const bypassHostPid = bypassHost.ready.localHost?.hostPid
    const bypassHostInstanceId = bypassHost.ready.localHost?.instanceId

    const bypassSeed = await waitForC1WorkEvent(
      bypassHost.workloadRoot!,
      event => event.kind === 'f1-host-session-created' && event.sessionId === 'shell-execution-session',
      'bypass Host seeded Session',
    )
    expect(bypassSeed.cwd).toBe(canonicalWorkspace)
    const bypassSessionId = String(bypassSeed.sessionId)

    const clientA = await scene.startClient({
      label: 'shell-exec-bypass',
      cwd: clientCwd,
      home: clientHome,
      sessionId: bypassSessionId,
    })
    expect(clientA.ready.hostPid).toBe(bypassHostPid)
    expect(clientA.ready.instanceId).toBe(bypassHostInstanceId)
    expect(clientA.ready.businessPid).not.toBe(bypassHostPid)
    await clientA.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === bypassSessionId,
      'bypass Client mounted seeded Session',
    )

    // A2. `!` Host locality, raw Bash background exit, independent stderr & exit 7
    const execStdoutMarker = 'SHELL_EXEC_STDOUT_MARKER'
    const execStderrMarker = 'SHELL_EXEC_STDERR_MARKER'
    const beforeExec = (scene.sessionEvents(bypassSessionId) ?? []).length
    const execCmd = [
      `printf '${execStdoutMarker}\\n'`,
      `printf 'CWD=%s\\nHOME=%s\\nVAR=%s\\n' "$(pwd -P)" "$HOME" "$WORKSPACE_COMPLETION_HOST"`,
      'workspace-command-host',
      'cat shell-scope-host.txt',
      `printf '${execStderrMarker}\\n' >&2`,
      '(exit 7) & p=$!; wait "$p"; code=$?; printf "CHILD_EXIT=%s\\n" "$code"; exit "$code"',
    ].join('; ')
    await submitShellCommand(clientA, '!', execCmd, 'CHILD_EXIT=', 'bypass ! locality and raw Bash')
    const { userText: execResult } = await waitForCompletedUserShellTurn(
      scene,
      bypassSessionId,
      beforeExec,
      execStdoutMarker,
      'bypass ! locality and raw Bash',
    )
    const bypassPolicy = await waitForC1WorkEvent(
      bypassHost.workloadRoot!,
      event => event.kind === 'f1-host-effective-shell-policy' && event.agentId === bypassSessionId,
      'bypass effective shell policy',
    )
    expect(bypassPolicy.localShellSandbox).toBe('bypass')

    expect(humanUserTexts(scene.sessionEvents(bypassSessionId) ?? []).filter(t => t.includes(execStdoutMarker))).toHaveLength(1)
    expect(execResult).toContain(`CWD=${canonicalWorkspace}`)
    expect(execResult).toContain(`HOME=${canonicalHostHome}`)
    expect(execResult).toContain('VAR=host-fixture')
    expect(execResult).toContain('host-fixture-command')
    expect(execResult).toContain(hostFileMarker)
    expect(execResult).toContain('[stderr]')
    expect(execResult).toContain(execStderrMarker)
    expect(execResult).toContain('CHILD_EXIT=7')
    expect(execResult).toContain('[exit 7]')
    expect(execResult).not.toContain(clientPoisonMarker)
    expect(execResult).not.toContain(canonicalClientHome)
    expect(execResult).not.toContain(canonicalClientCwd)
    expect(execResult).not.toContain('client-fixture')

    // A3. `!!` Host signal outcome — card-only, no durable context, Host survives
    const signalMarker = 'SHELL_LOCAL_SIGTERM_MARKER'
    const humanCountBeforeSignal = humanUserTexts(scene.sessionEvents(bypassSessionId) ?? []).length
    const sessionsBeforeSignal = [...await scene.sessionIds()].sort()
    await submitShellCommand(
      clientA,
      '!!',
      `printf '${signalMarker}\\n'; pwd -P; kill -TERM "$$"`,
      'kill -TERM',
      'bypass !! signal outcome',
    )
    await waitForLocalShellSettled(clientA, signalMarker, '[signal SIGTERM]', 'bypass !! signal outcome')
    await assertExpandedLocalShellFacts(
      clientA,
      [signalMarker, canonicalWorkspace, '[signal SIGTERM]'],
      'bypass !! signal outcome',
    )
    await waitForLocalShellSettled(clientA, signalMarker, '[signal SIGTERM]', 'bypass !! folded restoration')
    const eventsAfterSignal = scene.sessionEvents(bypassSessionId) ?? []
    expect(humanUserTexts(eventsAfterSignal)).toHaveLength(humanCountBeforeSignal)
    expect(markerInDurableUserSink(eventsAfterSignal, signalMarker)).toBe(false)
    expect([...await scene.sessionIds()].sort()).toEqual(sessionsBeforeSignal)

    // A4. Live multiline Tab completion via bracketed paste (ENTRY_GATE fact 1)
    await enterShellMode(clientA, '!', 'live multiline completion')
    await clientA.paste('printf ready\ncat shell-scope-')
    const pastedFrame = await waitForFrame(
      clientA,
      frame => {
        const rows = composerRows(frame)
        return rows.some(row => row.includes('printf ready'))
          && rows.some(row => row.includes('cat shell-scope-'))
      },
      'live multiline pasted draft',
      30_000,
    )
    const pastedRows = composerRows(pastedFrame)
    const secondLine = pastedRows.find(row => row.includes('cat shell-scope-')) ?? ''
    expect(secondLine.startsWith('!')).toBe(false)
    const beforeTab = splitFrame(pastedFrame)
    expect(beforeTab.composer).not.toContain('shell-scope-host.txt')
    expect(beforeTab.below).not.toContain('shell-scope-host.txt')

    await clientA.press('Tab')
    let offeredKind: 'applied' | 'menu' | undefined
    let offeredParts = { composer: '', below: '' }
    await waitForCondition(async () => {
      const parts = splitFrame(await clientA.text())
      if (parts.composer.includes('shell-scope-host.txt')) {
        offeredKind = 'applied'
        offeredParts = parts
        return true
      }
      if (parts.below.includes('shell-scope-host.txt')) {
        offeredKind = 'menu'
        offeredParts = parts
        return true
      }
      return false
    }, 'live multiline Tab Host offer', 30_000)
    expect(offeredParts.composer).not.toContain('shell-scope-client.txt')
    expect(offeredParts.below).not.toContain('shell-scope-client.txt')
    if (offeredKind === 'menu') {
      const beforeAccept = offeredParts.composer
      await clientA.press('Tab')
      await waitForFrame(
        clientA,
        frame => {
          const parts = splitFrame(frame)
          return parts.composer !== beforeAccept && parts.composer.includes('shell-scope-host.txt')
        },
        'live multiline Tab accept',
        30_000,
      )
    }
    const afterMultilineAccept = splitFrame(await clientA.text())
    expect(afterMultilineAccept.composer).toContain('printf ready')
    expect(afterMultilineAccept.composer).toContain('shell-scope-host.txt')
    expect(afterMultilineAccept.composer).not.toContain('shell-scope-client.txt')
    await clientA.press('Ctrl+C')
    await waitForEmptyMode(clientA, 'prompt', 'live multiline draft cleared back to prompt')

    // A5. Bounded large output (>64KiB each stream)
    const largeBegin = 'SHELL_LARGE_BEGIN_MARKER'
    const largeStdoutTail = 'SHELL_LARGE_STDOUT_TAIL_MARKER'
    const largeStderrTail = 'SHELL_LARGE_STDERR_TAIL_MARKER'
    const beforeLarge = (scene.sessionEvents(bypassSessionId) ?? []).length
    const largeCmd = [
      "printf 'SHELL_LARGE_%s\\n' BEGIN_MARKER",
      "for ((i=0;i<400;i++)); do printf '%200s\\n' ''; done",
      "for ((i=0;i<400;i++)); do printf '%200s\\n' '' >&2; done",
      "printf 'SHELL_LARGE_%s\\n' STDOUT_TAIL_MARKER",
      "printf 'SHELL_LARGE_%s\\n' STDERR_TAIL_MARKER >&2",
    ].join('; ')
    await submitShellCommand(clientA, '!', largeCmd, 'STDERR_TAIL_MARKER', 'bypass ! large output')
    const { userText: largeResult } = await waitForCompletedUserShellTurn(
      scene,
      bypassSessionId,
      beforeLarge,
      largeStdoutTail,
      'bypass ! large output',
    )
    expect(humanUserTexts(scene.sessionEvents(bypassSessionId) ?? []).filter(t => t.includes(largeStdoutTail))).toHaveLength(1)
    expect(largeResult).toContain('stdout truncated')
    expect(largeResult).toContain('stderr truncated')
    expect(largeResult).toContain(largeStdoutTail)
    expect(largeResult).toContain(largeStderrTail)
    expect(largeResult).toContain('Host-local')
    expect(largeResult).not.toContain(largeBegin)
    expect(largeResult).toContain('[exit 0]')
    expect(Buffer.byteLength(largeResult, 'utf8')).toBeLessThan(200 * 1024)
    const spillMatches = [...largeResult.matchAll(/^(stdout|stderr) spill \(Host-local\): (.+)$/gmu)]
    const hostTmpRoot = realpathSync(scene.installation.base.env.TMPDIR ?? tmpdir())
    const expectedSpillPrefix = `dsh-subprocess-${String(bypassHostPid)}-`
    for (const match of spillMatches) {
      const stream = match[1]!
      const spillPath = match[2]!.trim()
      expect(existsSync(spillPath), `${stream} spill locator must exist: ${spillPath}`).toBe(true)
      const realSpill = realpathSync(spillPath)
      const spillStat = lstatSync(realSpill)
      expect(spillStat.isFile() && !spillStat.isSymbolicLink(), `${stream} spill must be a regular file`).toBe(true)
      if (typeof process.getuid === 'function') {
        expect(spillStat.uid, `${stream} spill must be owned by current user`).toBe(process.getuid())
      }
      const inScene = !relative(scene.workDir, realSpill).startsWith(`..${sep}`) && relative(scene.workDir, realSpill) !== '..'
      const inHostSubprocessTmp = !relative(hostTmpRoot, realSpill).startsWith(`..${sep}`)
        && basename(realSpill).startsWith(expectedSpillPrefix)
      expect(inScene || inHostSubprocessTmp, `${stream} spill must belong to this Host/Scene: ${realSpill}`).toBe(true)
      expect(relative(canonicalClientCwd, realSpill).startsWith(`..${sep}`)).toBe(true)
      expect(relative(canonicalClientHome, realSpill).startsWith(`..${sep}`)).toBe(true)
      const spillBody = readFileSync(realSpill, 'utf8')
      const expectedTail = stream === 'stdout' ? largeStdoutTail : largeStderrTail
      expect(spillBody).toContain(expectedTail)
    }

    // A6. Bypass outside-workspace positive control (ENTRY_GATE fact 2 prerequisite)
    const allowedByBypass = join(canonicalOutside, 'allowed-by-bypass')
    const deniedBySandbox = join(canonicalOutside, 'denied-by-sandbox')
    expect(existsSync(allowedByBypass)).toBe(false)
    expect(existsSync(deniedBySandbox)).toBe(false)
    const bypassOutsideMarker = 'SHELL_BYPASS_OUTSIDE_OK'
    const beforeOutside = (scene.sessionEvents(bypassSessionId) ?? []).length
    await submitShellCommand(
      clientA,
      '!',
      `printf '${bypassOutsideMarker}\\n' > ${shellQuote(allowedByBypass)}; printf '${bypassOutsideMarker}\\n'`,
      'allowed-by-bypass',
      'bypass ! outside write',
    )
    const { userText: outsideResult } = await waitForCompletedUserShellTurn(
      scene,
      bypassSessionId,
      beforeOutside,
      bypassOutsideMarker,
      'bypass ! outside write',
    )
    expect(outsideResult).toContain('[exit 0]')
    expect(readFileSync(allowedByBypass, 'utf8')).toBe(`${bypassOutsideMarker}\n`)

    await clientA.exitGracefully()
    const bypassStatusAfter = await scene.hostStatus(bypassHost)
    expect(bypassStatusAfter.localHost?.hostPid).toBe(bypassHostPid)
    expect(bypassStatusAfter.localHost?.instanceId).toBe(bypassHostInstanceId)
    await scene.stopHost(bypassHost)

    // ── B. Sandbox generation on the same Scene ─────────────────────────────
    const sandboxHost = await scene.startHost({ scenario: 'shell-sandbox' })
    expect(sandboxHost.workloadRoot).toBeTypeOf('string')
    const sandboxHostPid = sandboxHost.ready.localHost?.hostPid
    const sandboxHostInstanceId = sandboxHost.ready.localHost?.instanceId
    expect(sandboxHostInstanceId).not.toBe(bypassHostInstanceId)

    const sandboxSeed = await waitForC1WorkEvent(
      sandboxHost.workloadRoot!,
      event => event.kind === 'f1-host-session-created' && event.sessionId === 'shell-sandbox-session',
      'sandbox Host seeded Session',
    )
    expect(sandboxSeed.cwd).toBe(canonicalWorkspace)
    const sandboxSessionId = String(sandboxSeed.sessionId)

    const sandboxClient = await scene.startClient({
      label: 'shell-exec-sandbox',
      cwd: clientCwd,
      home: clientHome,
      sessionId: sandboxSessionId,
    })
    expect(sandboxClient.ready.hostPid).toBe(sandboxHostPid)
    expect(sandboxClient.ready.instanceId).toBe(sandboxHostInstanceId)
    await sandboxClient.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === sandboxSessionId,
      'sandbox Client mounted seeded Session',
    )

    // Trigger one ordinary prompt to prove effective sandbox policy via official agent/status
    const policyPromptMarker = 'sandbox-policy-check'
    const beforePolicyPrompt = (scene.sessionEvents(sandboxSessionId) ?? []).length
    await waitForEmptyMode(sandboxClient, 'prompt', 'sandbox policy check empty prompt')
    await sandboxClient.type(policyPromptMarker)
    await waitForFrame(sandboxClient, frame => splitFrame(frame).composer.includes(policyPromptMarker), 'sandbox policy prompt draft')
    await sandboxClient.press('Enter')
    await waitForCompletedUserShellTurn(scene, sandboxSessionId, beforePolicyPrompt, policyPromptMarker, 'sandbox policy check turn')
    const sandboxPolicy = await waitForC1WorkEvent(
      sandboxHost.workloadRoot!,
      event => event.kind === 'f1-host-effective-shell-policy' && event.agentId === sandboxSessionId,
      'sandbox effective shell policy',
    )
    expect(sandboxPolicy.localShellSandbox).toBe('sandbox')
    expect(existsSync(allowedByBypass)).toBe(true)
    expect(existsSync(deniedBySandbox)).toBe(false)

    // B2. `!!` sandbox allow inside Session workspace
    const sandboxAllowedFile = join(canonicalWorkspace, 'sandbox-allowed')
    const sandboxAllowMarker = 'SHELL_SANDBOX_ALLOW_MARKER'
    const humanCountBeforeSandboxShell = humanUserTexts(scene.sessionEvents(sandboxSessionId) ?? []).length
    await submitShellCommand(
      sandboxClient,
      '!!',
      `printf '${sandboxAllowMarker}\\n' > ${shellQuote(sandboxAllowedFile)}; cat ${shellQuote(sandboxAllowedFile)}`,
      'sandbox-allowed',
      'sandbox !! workspace allow',
    )
    await waitForLocalShellSettled(sandboxClient, sandboxAllowMarker, '[exit 0]', 'sandbox !! workspace allow')
    await assertExpandedLocalShellFacts(sandboxClient, [sandboxAllowMarker, '[exit 0]'], 'sandbox !! workspace allow')
    await waitForLocalShellSettled(sandboxClient, sandboxAllowMarker, '[exit 0]', 'sandbox !! allow folded')
    expect(readFileSync(sandboxAllowedFile, 'utf8')).toBe(`${sandboxAllowMarker}\n`)
    const eventsAfterAllow = scene.sessionEvents(sandboxSessionId) ?? []
    expect(humanUserTexts(eventsAfterAllow)).toHaveLength(humanCountBeforeSandboxShell)
    expect(markerInDurableUserSink(eventsAfterAllow, sandboxAllowMarker)).toBe(false)

    // B3. `!!` sandbox deny against positively writable outside sibling
    const sandboxDenyMarker = 'SHELL_SANDBOX_DENY_MARKER'
    await submitShellCommand(
      sandboxClient,
      '!!',
      `printf '${sandboxDenyMarker}\\n'; touch ${shellQuote(deniedBySandbox)}`,
      'denied-by-sandbox',
      'sandbox !! outside deny',
    )
    await waitForLocalShellSettled(sandboxClient, sandboxDenyMarker, /\[exit [1-9]\d*\]/u, 'sandbox !! outside deny')
    await assertExpandedLocalShellFacts(
      sandboxClient,
      [sandboxDenyMarker, 'sandbox denied', /\[exit [1-9]\d*\]/u],
      'sandbox !! outside deny',
    )
    await waitForLocalShellSettled(sandboxClient, sandboxDenyMarker, /\[exit [1-9]\d*\]/u, 'sandbox !! deny folded')
    expect(existsSync(deniedBySandbox)).toBe(false)
    expect(existsSync(sandboxAllowedFile)).toBe(true)
    expect(existsSync(allowedByBypass)).toBe(true)
    const eventsAfterDeny = scene.sessionEvents(sandboxSessionId) ?? []
    expect(humanUserTexts(eventsAfterDeny)).toHaveLength(humanCountBeforeSandboxShell)
    expect(markerInDurableUserSink(eventsAfterDeny, sandboxDenyMarker)).toBe(false)

    await sandboxClient.exitGracefully()
    const sandboxStatusAfter = await scene.hostStatus(sandboxHost)
    expect(sandboxStatusAfter.localHost?.hostPid).toBe(sandboxHostPid)
    expect(sandboxStatusAfter.localHost?.instanceId).toBe(sandboxHostInstanceId)
    await scene.stopHost(sandboxHost)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary)
  }
})

test('keeps Host shell cancellation, Session scope and carrier uncertainty isolated', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  const pendingReleases: string[] = []
  try {
    const shellWorkspace = join(scene.workDir, 'shell-workspace')
    const clientAHome = join(scene.workDir, 'shell-life-a-home')
    const clientACwd = join(scene.workDir, 'shell-life-a-cwd')
    const clientBHome = join(scene.workDir, 'shell-life-b-home')
    const clientBCwd = join(scene.workDir, 'shell-life-b-cwd')
    for (const dir of [shellWorkspace, clientAHome, clientACwd, clientBHome, clientBCwd]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const canonicalWorkspace = realpathSync(shellWorkspace)

    const host = await scene.startHost({ scenario: 'shell-lifecycle' })
    expect(host.workloadRoot).toBeTypeOf('string')
    const hostPid = host.ready.localHost?.hostPid
    const hostInstanceId = host.ready.localHost?.instanceId

    const sourceSeed = await waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'f1-host-session-created' && event.sessionId === 'shell-lifecycle-source',
      'lifecycle source Session',
    )
    const targetSeed = await waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'f1-host-other-session-created' && event.sessionId === 'shell-lifecycle-target',
      'lifecycle target Session',
    )
    const sourceSessionId = String(sourceSeed.sessionId)
    const targetSessionId = String(targetSeed.sessionId)

    const clientA = await scene.startClient({
      label: 'shell-life-a',
      cwd: clientACwd,
      home: clientAHome,
      sessionId: sourceSessionId,
    })
    const clientB = await scene.startClient({
      label: 'shell-life-b',
      cwd: clientBCwd,
      home: clientBHome,
      sessionId: sourceSessionId,
    })
    for (const client of [clientA, clientB]) {
      expect(client.ready.hostPid).toBe(hostPid)
      expect(client.ready.instanceId).toBe(hostInstanceId)
      await client.waitForSurfaceStatus(
        record => record.sessionOpen === true && record.openSessionId === sourceSessionId,
        `${client.label} mounted source Session`,
      )
    }
    expect(clientA.ready.businessPid).not.toBe(clientB.ready.businessPid)

    // ── 1. Captured Session stale refusal ───────────────────────────────────
    const staleStart = join(canonicalWorkspace, 'stale-started')
    const stalePid = join(canonicalWorkspace, 'stale-pid')
    const staleRelease = join(canonicalWorkspace, 'stale-release')
    const staleFinish = join(canonicalWorkspace, 'stale-finished')
    const staleFinishMarker = 'SHELL_STALE_FINISHED_MARKER'
    pendingReleases.push(staleRelease)
    const beforeStaleS = humanUserTexts(scene.sessionEvents(sourceSessionId) ?? []).length
    const beforeStaleT = humanUserTexts(scene.sessionEvents(targetSessionId) ?? []).length

    const staleCmd = [
      `printf '%s\\n' "$$" > ${shellQuote(stalePid)}`,
      `touch ${shellQuote(staleStart)}`,
      `end=$((SECONDS+120)); while [ ! -f ${shellQuote(staleRelease)} ] && [ "$SECONDS" -lt "$end" ]; do sleep 0.05; done; [ -f ${shellQuote(staleRelease)} ] || exit 124`,
      `printf '${staleFinishMarker}\\n'`,
      `touch ${shellQuote(staleFinish)}`,
    ].join('; ')
    await submitShellCommand(clientA, '!', staleCmd, 'stale-finished', 'stale ! held command')
    await waitForCondition(() => existsSync(staleStart), 'stale shell started', 30_000)
    const staleIdentity = await waitForKernelPidFile(stalePid, 'stale shell Bash')

    const statusBeforeSwitch = clientA.readRecords().filter(r => r.m4b2s === 'surface-status').length
    await waitForEmptyMode(clientA, 'prompt', 'stale prompt ready for /resume')
    await clientA.type(`/resume ${targetSessionId}`)
    await waitForFrame(clientA, frame => splitFrame(frame).composer.includes(`/resume ${targetSessionId}`), 'stale /resume draft')
    await clientA.press('Enter')
    await waitForCondition(
      () => clientA.readRecords().filter(r => r.m4b2s === 'surface-status').slice(statusBeforeSwitch)
        .some(r => r.sessionOpen === true && r.openSessionId === targetSessionId),
      'client A switched to target Session',
      60_000,
    )

    writeFileSync(staleRelease, 'release\n', { mode: 0o600 })
    await waitForCondition(() => existsSync(staleFinish), 'stale shell crossed release barrier', 30_000)
    await waitForKernelProcessTerminal(staleIdentity, 'stale shell Bash')
    await waitForFrame(
      clientA,
      frame => frame.includes('the session changed while the command ran — the output was not submitted'),
      'stale result refusal notice',
      30_000,
    )
    const sourceAfterStale = scene.sessionEvents(sourceSessionId) ?? []
    const targetAfterStale = scene.sessionEvents(targetSessionId) ?? []
    expect(humanUserTexts(sourceAfterStale)).toHaveLength(beforeStaleS)
    expect(humanUserTexts(targetAfterStale)).toHaveLength(beforeStaleT)
    expect(markerInDurableUserSink(sourceAfterStale, staleFinishMarker)).toBe(false)
    expect(markerInDurableUserSink(targetAfterStale, staleFinishMarker)).toBe(false)

    // Return Client A to source Session S and prove editor is live
    const statusBeforeReturn = clientA.readRecords().filter(r => r.m4b2s === 'surface-status').length
    await waitForEmptyMode(clientA, 'prompt', 'empty prompt before returning to source Session')
    await clientA.type(`/resume ${sourceSessionId}`)
    await waitForFrame(clientA, frame => splitFrame(frame).composer.includes(`/resume ${sourceSessionId}`), 'return /resume draft')
    await clientA.press('Enter')
    await waitForCondition(
      () => clientA.readRecords().filter(r => r.m4b2s === 'surface-status').slice(statusBeforeReturn)
        .some(r => r.sessionOpen === true && r.openSessionId === sourceSessionId),
      'client A returned to source Session',
      60_000,
    )
    await waitForEmptyMode(clientA, 'prompt', 'client A prompt ready after return')

    // ── 2. Carrier drop unknown-outcome & non-replay ────────────────────────
    const dropCounter = join(canonicalWorkspace, 'drop-counter')
    const dropPid = join(canonicalWorkspace, 'drop-pid')
    const dropRelease = join(canonicalWorkspace, 'drop-never-released')
    const dropFinish = join(canonicalWorkspace, 'drop-finished')
    const dropMarker = 'SHELL_CARRIER_DROP_MARKER'
    const dropGeneration = clientA.readRecords()
      .filter(r => r.m4b2s === 'surface-status')
      .at(-1)?.generationId as number | undefined
    expect(dropGeneration).toBeTypeOf('number')

    const dropCmd = [
      `printf '${dropMarker}\\n'`,
      `printf x >> ${shellQuote(dropCounter)}`,
      `printf '%s\\n' "$$" > ${shellQuote(dropPid)}`,
      `end=$((SECONDS+120)); while [ ! -f ${shellQuote(dropRelease)} ] && [ "$SECONDS" -lt "$end" ]; do sleep 0.05; done; [ -f ${shellQuote(dropRelease)} ] || exit 124`,
      `touch ${shellQuote(dropFinish)}`,
    ].join('; ')
    await submitShellCommand(clientA, '!!', dropCmd, 'drop-finished', 'carrier drop !! held command')
    await waitForCondition(
      () => existsSync(dropCounter) && readFileSync(dropCounter, 'utf8') === 'x',
      'carrier drop counter written',
      30_000,
    )
    const dropIdentity = await waitForKernelPidFile(dropPid, 'carrier drop Bash')

    await clientA.signal('SIGUSR1')
    await clientA.waitForSurfaceStatus(
      record => record.transport === 'connected'
        && typeof record.generationId === 'number'
        && record.generationId !== dropGeneration
        && record.sessionOpen === true
        && record.openSessionId === sourceSessionId,
      'client A authenticated reconnect after SIGUSR1',
    )
    await waitForLocalShellSettled(clientA, dropMarker, 'Host shell execution', 'carrier drop local card')
    await assertExpandedLocalShellFacts(
      clientA,
      ['The command may have executed — do not retry automatically'],
      'carrier drop unknown-outcome warning',
    )
    await waitForLocalShellSettled(clientA, dropMarker, 'Host shell execution', 'carrier drop card folded')
    await waitForKernelProcessTerminal(dropIdentity, 'carrier drop Bash')
    expect(readFileSync(dropCounter, 'utf8')).toBe('x')
    expect(existsSync(dropFinish)).toBe(false)
    expect(markerInDurableUserSink(scene.sessionEvents(sourceSessionId) ?? [], dropMarker)).toBe(false)
    expect(markerInDurableUserSink(scene.sessionEvents(targetSessionId) ?? [], dropMarker)).toBe(false)

    // ── 3. Concurrent cancellation isolation ────────────────────────────────
    const cancelAStart = join(canonicalWorkspace, 'cancel-a-start')
    const cancelAPid = join(canonicalWorkspace, 'cancel-a-pid')
    const cancelARelease = join(canonicalWorkspace, 'cancel-a-release')
    const cancelAFinish = join(canonicalWorkspace, 'cancel-a-finish')
    const cancelAMarker = 'SHELL_CANCEL_A_MARKER'
    const cancelAFinishMarker = 'SHELL_CANCEL_A_SHOULD_NOT_LAND'
    pendingReleases.push(cancelARelease)

    const cancelBStart = join(canonicalWorkspace, 'cancel-b-start')
    const cancelBPid = join(canonicalWorkspace, 'cancel-b-pid')
    const cancelBRelease = join(canonicalWorkspace, 'cancel-b-release')
    const cancelBFinish = join(canonicalWorkspace, 'cancel-b-finish')
    const cancelBMarker = 'SHELL_CANCEL_B_MARKER'
    const cancelBStdout = 'SHELL_CANCEL_B_SURVIVED_STDOUT'
    const cancelBStderr = 'SHELL_CANCEL_B_SURVIVED_STDERR'
    pendingReleases.push(cancelBRelease)

    const beforeCancelB = (scene.sessionEvents(sourceSessionId) ?? []).length
    const cancelACmd = [
      `printf '${cancelAMarker}\\n'`,
      `printf '%s\\n' "$$" > ${shellQuote(cancelAPid)}`,
      `touch ${shellQuote(cancelAStart)}`,
      `end=$((SECONDS+120)); while [ ! -f ${shellQuote(cancelARelease)} ] && [ "$SECONDS" -lt "$end" ]; do sleep 0.05; done; [ -f ${shellQuote(cancelARelease)} ] || exit 124`,
      `printf '${cancelAFinishMarker}\\n'`,
      `touch ${shellQuote(cancelAFinish)}`,
    ].join('; ')
    const cancelBCmd = [
      `printf '${cancelBMarker}\\n'`,
      `printf '%s\\n' "$$" > ${shellQuote(cancelBPid)}`,
      `touch ${shellQuote(cancelBStart)}`,
      `end=$((SECONDS+120)); while [ ! -f ${shellQuote(cancelBRelease)} ] && [ "$SECONDS" -lt "$end" ]; do sleep 0.05; done; [ -f ${shellQuote(cancelBRelease)} ] || exit 124`,
      `printf '${cancelBStdout}\\n'`,
      `printf '${cancelBStderr}\\n' >&2`,
      `touch ${shellQuote(cancelBFinish)}`,
    ].join('; ')

    await submitShellCommand(clientA, '!', cancelACmd, 'cancel-a-finish', 'client A concurrent held !')
    await submitShellCommand(clientB, '!', cancelBCmd, 'cancel-b-finish', 'client B concurrent held !')

    await waitForCondition(() => existsSync(cancelAStart) && existsSync(cancelBStart), 'both concurrent shells started', 30_000)
    const identityA = await waitForKernelPidFile(cancelAPid, 'client A Bash')
    const identityB = await waitForKernelPidFile(cancelBPid, 'client B Bash')

    await clientA.press('Escape')
    await waitForLocalShellSettled(clientA, cancelAMarker, 'aborted', 'client A aborted card')
    await waitForKernelProcessTerminal(identityA, 'client A Bash after Esc')
    expect(existsSync(cancelAFinish)).toBe(false)
    expect(markerInDurableUserSink(scene.sessionEvents(sourceSessionId) ?? [], cancelAMarker)).toBe(false)
    expect(markerInDurableUserSink(scene.sessionEvents(targetSessionId) ?? [], cancelAMarker)).toBe(false)

    // Client B's Bash must still be live after Client A's Esc cancellation
    expect(sameKernelProcess(identityB, readKernelProcess(identityB.pid))).toBe('same')

    writeFileSync(cancelBRelease, 'release\n', { mode: 0o600 })
    await waitForCondition(() => existsSync(cancelBFinish), 'client B shell finished after release', 30_000)
    await waitForKernelProcessTerminal(identityB, 'client B Bash after release')
    const { userText: clientBText } = await waitForCompletedUserShellTurn(
      scene,
      sourceSessionId,
      beforeCancelB,
      cancelBStdout,
      'client B survived ! result',
    )
    expect(humanUserTexts(scene.sessionEvents(sourceSessionId) ?? []).filter(t => t.includes(cancelBStdout))).toHaveLength(1)
    expect(clientBText).toContain('[stderr]')
    expect(clientBText).toContain(cancelBStderr)
    expect(clientBText).toContain('[exit 0]')

    // Final non-leak & non-replay assertions across both Sessions
    const finalSourceEvents = scene.sessionEvents(sourceSessionId) ?? []
    const finalTargetEvents = scene.sessionEvents(targetSessionId) ?? []
    for (const forbidden of [staleFinishMarker, dropMarker, cancelAMarker, cancelAFinishMarker]) {
      expect(markerInDurableUserSink(finalSourceEvents, forbidden), `source Session leaked ${forbidden}`).toBe(false)
      expect(markerInDurableUserSink(finalTargetEvents, forbidden), `target Session leaked ${forbidden}`).toBe(false)
    }
    expect(readFileSync(dropCounter, 'utf8')).toBe('x')

    await clientA.exitGracefully()
    await clientB.exitGracefully()
    const statusAfter = await scene.hostStatus(host)
    expect(statusAfter.localHost?.hostPid).toBe(hostPid)
    expect(statusAfter.localHost?.instanceId).toBe(hostInstanceId)
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    for (const releasePath of pendingReleases) {
      if (!existsSync(releasePath)) {
        try {
          writeFileSync(releasePath, 'cleanup\n', { mode: 0o600 })
        } catch {
          // Best-effort barrier release before Scene disposal.
        }
      }
    }
    await disposeScene(scene, primary)
  }
})
