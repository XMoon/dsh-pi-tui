/**
 * Phase 3C / C2-MA — the Account page and its workflow bridge.
 *
 * The page is driven through its public render/input seam; the source is a
 * detached fake (the real PlatformAccount + WebServer callback path lives in
 * the Direct integration suite). The tests prove the independent profile /
 * balance states, the exact attempt-id cancellation, the explicit sign-out
 * confirmation and the absence of any token in the rendered surface.
 *
 * @module @xmoon76/dsh-pi-tui/account-workspace.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { currentPalette, setTheme } from '../../src/tui/theme/runtime.ts'
import { darkColors, lightColors } from '../../src/domain/display/theme.ts'
import { AccountWorkspacePage, type AccountInitialView } from '../../src/tui/panels/account-workspace-page.ts'
import type { AccountWorkspaceSource, AccountQueryOutcome } from '../../src/app/command/account-workflow.ts'
import { accountClientMetadata, AccountWorkflow } from '../../src/app/command/account-workflow.ts'
import type { AccountObservation, AccountObservationLease, AccountProfile, AccountView, AccountWallet, AccountWatchEvent } from '../../src/runtime/config-port.ts'
import { SupersededReadError } from '../../src/runtime/read-error.ts'

const LINKS = { usageUrl: 'https://platform.example/usage', topUpUrl: 'https://platform.example/topup' }

function signedOut(): AccountView {
  return { status: 'signed-out', links: LINKS, attempt: null }
}

function waitingAttempt(): AccountView {
  return {
    status: 'signed-out',
    links: LINKS,
    attempt: {
      id: 'attempt-1',
      phase: 'waiting-browser',
      authorizeUrl: 'https://platform.example/dsh/authorize?state=abc&code_challenge=def',
      expiresAt: Date.now() + 60_000,
    },
  }
}

function stored(): AccountView {
  return { status: 'credential-stored', links: LINKS, attempt: null }
}

interface SourceState {
  view: AccountView
  profileFails: boolean
  balanceFails: boolean
  runningTasks: boolean
  readonly calls: string[]
  available?: boolean
  taskCheckCalls?: number
  watchStarts?: number
  watchActive?: number
  watchListeners?: Set<() => void>
  watchFailures?: Set<(error: Error) => void>
  currentLeases?: Set<AccountObservationLease>
}

function issueObservation(state: SourceState, view = state.view, lease = {} as AccountObservationLease): AccountObservation {
  state.currentLeases!.add(lease)
  return { view, lease }
}

function watchEvent(state: SourceState, view = state.view, lease = {} as AccountObservationLease): AccountWatchEvent {
  return { kind: 'current', observation: issueObservation(state, view, lease) }
}

function makeSource(state: SourceState): AccountWorkspaceSource {
  state.watchListeners ??= new Set()
  state.watchFailures ??= new Set()
  state.currentLeases ??= new Set()
  state.watchStarts ??= 0
  state.watchActive ??= 0
  return {
    available: () => state.available ?? true,
    callbackOrigin: () => 'http://127.0.0.1:43121',
    isObservationCurrent: lease => state.currentLeases!.has(lease),
    getState: async () => issueObservation(state),
    watch: async function* (signal) {
      const lease = {} as AccountObservationLease
      state.watchStarts = (state.watchStarts ?? 0) + 1
      state.watchActive = (state.watchActive ?? 0) + 1
      try {
        yield watchEvent(state, state.view, lease)
        while (true) {
          const next = await new Promise<AccountView | undefined>((resolve, reject) => {
            const listeners = state.watchListeners!
            const failures = state.watchFailures!
            const cleanup = (): void => {
              listeners.delete(changed)
              failures.delete(failed)
              signal.removeEventListener('abort', aborted)
            }
            const changed = (): void => { cleanup(); resolve(state.view) }
            const failed = (error: Error): void => {
              cleanup()
              state.currentLeases!.delete(lease)
              reject(error)
            }
            const aborted = (): void => { cleanup(); resolve(undefined) }
            listeners.add(changed)
            failures.add(failed)
            signal.addEventListener('abort', aborted, { once: true })
            if (signal.aborted) aborted()
          })
          if (next === undefined) return
          yield watchEvent(state, next, lease)
        }
      } finally {
        state.currentLeases!.delete(lease)
        state.watchActive = (state.watchActive ?? 1) - 1
      }
    },
    getProfile: async (_lease) => state.profileFails
      ? { status: 'failed', reason: 'profile endpoint unavailable' }
      : { status: 'ready', value: { id: 'acct-1', name: 'Moon', contact: 'm***@example.com' } },
    getBalance: async (_lease) => state.balanceFails
      ? { status: 'failed', reason: 'balance endpoint unavailable' }
      : { status: 'ready', value: { value: [{ currency: 'CNY', balance: '12.50' }], bonusWallets: [{ currency: 'CNY', balance: '3.00' }] } },
    startSignIn: async lease => {
      state.calls.push('signIn')
      state.view = waitingAttempt()
      return issueObservation(state, state.view, lease)
    },
    cancelSignIn: async (id, lease) => {
      state.calls.push(`cancel:${id}`)
      state.view = signedOut()
      return issueObservation(state, state.view, lease)
    },
    signOut: async lease => {
      state.calls.push('signOut')
      state.view = signedOut()
      return issueObservation(state, state.view, lease)
    },
    hasRunningAccountTasks: async () => {
      state.taskCheckCalls = (state.taskCheckCalls ?? 0) + 1
      return state.runningTasks
    },
    openUrl: url => { state.calls.push(`open:${url}`) },
    copy: text => { state.calls.push(`copy:${text}`) },
    run: (_label, task) => { void task() },
  }
}

function flush(times = 10): Promise<void> {
  return (async () => {
    for (let index = 0; index < times; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
  })()
}

function text(page: AccountWorkspacePage, width = 100): string {
  return page.render(width).map(stripTerminalSequences).join('\n')
}

function focusAction(page: AccountWorkspacePage, label: string, width = 100): void {
  for (let index = 0; index < 40; index += 1) {
    const painted = text(page, width)
    if (painted.split('\n').some(line => line.includes(`> ${label}`))) return
    page.handleInput('\u001b[B')
  }
  assert.fail(`the painted Account page did not select ${JSON.stringify(label)}:\n${text(page, width)}`)
}

function clickPaintedAction(page: AccountWorkspacePage, label: string, width = 100): void {
  const lines = text(page, width).split('\n')
  const row = lines.findIndex(line => line.trim() === label || line.trim() === `> ${label}`)
  assert.ok(row >= 0, `the Account page did not paint ${JSON.stringify(label)}:\n${lines.join('\n')}`)
  page.onCellPress(2, row)
  page.onCellClick(2, row)
}

function open(initial: AccountInitialView = { view: 'page' }): { page: AccountWorkspacePage; state: SourceState } {
  const state: SourceState = { view: signedOut(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const page = new AccountWorkspacePage(makeSource(state), () => {}, initial)
  page.setBodyHeight(26)
  return { page, state }
}

test('the account metadata samples the live timezone offset and the UI locale', () => {
  const metadata = accountClientMetadata('0.5.3')
  assert.equal(metadata.version, '0.5.3')
  assert.equal(metadata.timezoneOffsetSeconds, -new Date().getTimezoneOffset() * 60)
  assert.equal(metadata.locale.length > 0, true)
})

test('superseded Host profile and balance reads do not become current UI failures', async () => {
  const stale = new SupersededReadError('remote Account generation changed')
  const lease = {} as AccountObservationLease
  const observation: AccountObservation = { view: stored(), lease }
  const account = {
    available: () => true,
    isObservationCurrent: (_lease: AccountObservationLease) => true,
    getState: async () => observation,
    getProfile: async (_client: unknown, _lease: AccountObservationLease) => { throw stale },
    getBalance: async (_client: unknown, _lease: AccountObservationLease) => { throw stale },
    watch: async function* (signal: AbortSignal) {
      yield { kind: 'current' as const, observation }
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    },
    getCallbackOrigin: () => 'http://127.0.0.1:43121',
    startSignIn: async (_client: unknown, _lease: AccountObservationLease) => observation,
    cancelSignIn: async (_id: string, _lease: AccountObservationLease) => observation,
    signOut: async (_client: unknown, _lease: AccountObservationLease) => observation,
    hasRunningAccountTasks: async (_lease: AccountObservationLease) => false,
  }
  const workflow = new AccountWorkflow({
    account,
    version: '0.5.6',
    openUrl: () => {},
    copy: () => {},
    run: (_label, task) => { void task() },
    diag: { warn: () => {} },
  })
  assert.deepEqual(await workflow.getProfile(lease), { status: 'superseded' })
  assert.deepEqual(await workflow.getBalance(lease), { status: 'superseded' })
  const page = new AccountWorkspacePage(workflow, () => {}, { view: 'page' })
  page.setBodyHeight(26)
  await flush()
  const painted = text(page)
  assert.match(painted, /Signed in \(stored credential\)/u)
  assert.doesNotMatch(painted, /Profile\s+failed|Balance\s+failed/u)
  page.dispose()
})

test('signed out: the page offers Sign in and the exact callback origin, never a token', async () => {
  const { page } = open()
  await flush()
  const painted = text(page)
  assert.match(painted, /DeepSeek Account/u)
  assert.match(painted, /Signed out/u)
  assert.match(painted, /http:\/\/127\.0\.0\.1:43121/u)
  assert.match(painted, /Sign in/u)
  assert.doesNotMatch(painted, /access_token|refresh_token|Bearer\s/u)
})

test('Sign in starts the Host attempt and paints the authorize URL; Cancel uses the exact attempt id', async () => {
  const { page, state } = open()
  await flush()
  text(page) // paint the initial actions
  page.handleInput('\r') // Sign in
  await flush()
  let painted = text(page)
  assert.ok(state.calls.includes('signIn'), state.calls.join(','))
  assert.match(painted, /waiting-browser/u)
  assert.match(painted, /https:\/\/platform\.example\/dsh\/authorize/u)
  assert.match(painted, /ssh -N -L '127\.0\.0\.1:43121:127\.0\.0\.1:43121'/u)
  // Actions: Cancel current attempt, Open browser, Copy link,
  // Copy SSH template, Usage, Top up, Refresh, ← Settings.
  page.handleInput('\r')
  await flush()
  assert.ok(state.calls.includes('cancel:attempt-1'), state.calls.join(','))
  painted = text(page)
  assert.match(painted, /Signed out/u)
})

test('pressing o / c opens and copies the current attempt URL through the Client ports', async () => {
  const { page, state } = open()
  await flush()
  text(page)
  page.handleInput('\r')
  await flush()
  text(page)
  page.handleInput('o')
  page.handleInput('c')
  assert.ok(state.calls.includes('open:https://platform.example/dsh/authorize?state=abc&code_challenge=def'), state.calls.join(','))
  assert.ok(state.calls.some(call => call.startsWith('copy:https://platform.example/')), state.calls.join(','))
})

test('stored credential: profile and balance settle independently and keep the decimal strings', async () => {
  const { page, state } = open()
  await flush()
  state.view = stored()
  state.balanceFails = true
  page.handleInput('r')
  await flush()
  let painted = text(page)
  assert.match(painted, /Signed in \(stored credential\)/u)
  assert.match(painted, /Moon/u)
  assert.match(painted, /Balance\s+failed · balance endpoint unavailable/u)
  state.profileFails = true
  state.balanceFails = false
  page.handleInput('r')
  await flush()
  painted = text(page)
  assert.match(painted, /Profile\s+failed · profile endpoint unavailable/u)
  assert.match(painted, /12\.50 CNY/u)
  assert.match(painted, /3\.00 CNY/u)
})

test('Sign out waits for the Host task fact and warns before cancelling a running account task', async () => {
  const { page, state } = open()
  await flush()
  state.view = stored()
  state.runningTasks = true
  state.profileFails = true
  page.handleInput('r')
  await flush()
  text(page)
  // Actions: Usage, Top up, Sign out…, Refresh, ← Settings.
  page.handleInput('\u001b[B')
  page.handleInput('\u001b[B')
  page.handleInput('\r')
  await flush()
  const confirm = text(page)
  assert.match(confirm, /Sign out confirmation/u)
  assert.match(confirm, /running agent is using a deepseek-account model/u)
  assert.match(confirm, /deepseek-account/u)
  page.handleInput('\r')
  await flush()
  assert.ok(state.calls.includes('signOut'), state.calls.join(','))
  assert.match(text(page), /Signed out/u)
})

test('the sign-out task-check status keeps semantic ink and fits a real 80x24 VirtualTerminal frame', async t => {
  const originalPalette = currentPalette
  t.after(() => setTheme('custom', originalPalette))
  const themes = [
    { mode: 'dark' as const, palette: darkColors },
    { mode: 'light' as const, palette: lightColors },
    { mode: 'custom' as const, palette: { ...darkColors, error: '#12ab34', textDim: '#345678' } },
  ]
  const rgb = (value: string): number => Number.parseInt(value.replace(/^#/u, ''), 16)
  for (const theme of themes) {
    setTheme(theme.mode, theme.palette)
    const state: SourceState = { view: stored(), profileFails: false, balanceFails: false, runningTasks: true, calls: [] }
    let resolveTaskCheck!: (running: boolean) => void
    const source = makeSource(state)
    source.hasRunningAccountTasks = () => new Promise(resolve => { resolveTaskCheck = resolve })
    const page = new AccountWorkspacePage(source, () => {}, { view: 'signout' })
    page.setBodyHeight(24)
    await flush()
    const pendingRows = page.render(80)
    const pendingText = pendingRows.map(stripTerminalSequences).join('\n')
    assert.match(pendingText, /Checking running account tasks…/u)
    const vt = new VirtualTerminal(80, 24)
    vt.write(pendingRows.join('\r\n'))
    const pendingFrame = await vt.flushAndGetViewport()
    assert.equal(pendingFrame.length, 24)
    assert.ok(pendingFrame.every(row => visibleWidth(row) <= 80), `${theme.mode} pending frame overflowed`)
    const pendingLine = pendingFrame.findIndex(row => row.includes('Checking running account tasks'))
    const pendingCol = pendingFrame[pendingLine]!.indexOf('Checking running account tasks')
    assert.equal(vt.getCellFgRgb(pendingLine, pendingCol), rgb(theme.palette.textDim),
      `${theme.mode} checking status must use the semantic dim token`)

    resolveTaskCheck(true)
    await flush()
    const warningRows = page.render(80)
    const warningText = warningRows.map(stripTerminalSequences).join('\n')
    assert.match(warningText, /A running agent is using a deepseek-account model/u)
    const warningVt = new VirtualTerminal(80, 24)
    warningVt.write(warningRows.join('\r\n'))
    const warningFrame = await warningVt.flushAndGetViewport()
    assert.equal(warningFrame.length, 24)
    assert.ok(warningFrame.every(row => visibleWidth(row) <= 80), `${theme.mode} warning frame overflowed`)
    const warningLine = warningFrame.findIndex(row => row.includes('A running agent is using a deepseek-account model'))
    const warningCol = warningFrame[warningLine]!.indexOf('A running agent is using a deepseek-account model')
    const staleFailure = [...state.watchFailures!][0]
    staleFailure!(new Error('the Account observation ended'))
    await flush()
    const staleRows = page.render(80)
    const staleText = staleRows.map(stripTerminalSequences).join('\n')
    assert.match(staleText, /Last known: signed in · Host state not current/u)
    assert.doesNotMatch(staleText, /Sign out confirmation/u,
      'a watch invalidation closes a previously opened SignOut confirmation')
    const staleVt = new VirtualTerminal(80, 24)
    staleVt.write(staleRows.join('\r\n'))
    const staleFrame = await staleVt.flushAndGetViewport()
    assert.equal(staleFrame.length, 24)
    assert.ok(staleFrame.every(row => visibleWidth(row) <= 80), `${theme.mode} stale Account frame overflowed`)
    page.dispose()
  }
})

test('a late false task check cannot replace the newer confirmed running-task fact', async () => {
  const state: SourceState = { view: stored(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const source = makeSource(state)
  const answers: Array<(running: boolean) => void> = []
  source.hasRunningAccountTasks = () => new Promise(resolve => { answers.push(resolve) })
  const page = new AccountWorkspacePage(source, () => {}, { view: 'page' })
  page.setBodyHeight(30)
  await flush()
  assert.equal(answers.length, 1, 'the initial AccountView starts one Host task check')
  text(page)
  page.handleInput('\u001b[B')
  page.handleInput('\u001b[B')
  page.handleInput('\r')
  await flush()
  assert.equal(answers.length, 2, 'opening Sign out starts a fresh Host task check')
  assert.match(text(page), /Checking running account tasks/u)
  page.handleInput('\r')
  assert.equal(state.calls.includes('signOut'), false, 'a pending Host fact must not dispatch signOut')

  answers[1]!(true)
  await flush()
  assert.match(text(page), /running agent is using a deepseek-account model/u)
  answers[0]!(false)
  await flush()
  assert.match(text(page), /running agent is using a deepseek-account model/u,
    'the older false result must not replace the newer true fact')

  page.handleInput('\r')
  await flush()
  assert.equal(state.calls.filter(call => call === 'signOut').length, 1)
})

test('/logout deep link with no stored credential reports signed out without checking running tasks', async () => {
  const { page, state } = open({ view: 'signout' })
  await flush()
  const painted = text(page)
  assert.match(painted, /Signed out \/ no stored credential/u)
  assert.match(painted, /Nothing to sign out/u)
  assert.match(painted, /Sign in/u)
  assert.doesNotMatch(painted, /Sign out confirmation|Checking running account tasks|Could not verify/u)
  assert.equal(state.taskCheckCalls ?? 0, 0, 'the Host task predicate is irrelevant without a stored credential')
  assert.equal(state.calls.includes('signOut'), false)
  page.dispose()
})

test('an unavailable Host task check disables Sign out until Retry returns a known fact', async () => {
  const state: SourceState = { view: stored(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const source = makeSource(state)
  let taskReads = 0
  source.hasRunningAccountTasks = async () => {
    taskReads += 1
    if (taskReads === 1) throw new Error('the Host is disconnected')
    return false
  }
  const page = new AccountWorkspacePage(source, () => {}, { view: 'signout' })
  page.setBodyHeight(30)
  await flush()
  let painted = text(page)
  assert.match(painted, /Could not verify whether running account tasks will be cancelled/u)
  assert.match(painted, /Retry task check/u)
  page.handleInput('\r')
  assert.equal(state.calls.includes('signOut'), false, 'unknown is not the safe false state')

  page.handleInput('\u001b[B')
  text(page)
  page.handleInput('\r')
  await flush()
  assert.equal(taskReads, 2)
  painted = text(page)
  assert.match(painted, /No running account task is using this account/u)
  assert.doesNotMatch(painted, /Could not verify whether running account tasks/u)
  page.handleInput('\u001b[A')
  text(page)
  page.handleInput('\r')
  await flush()
  assert.equal(state.calls.filter(call => call === 'signOut').length, 1)
})

test('/logout deep link with a stored credential opens the asynchronous task check', async () => {
  const state: SourceState = { view: stored(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const page = new AccountWorkspacePage(makeSource(state), () => {}, { view: 'signout' })
  page.setBodyHeight(30)
  await flush()
  const painted = text(page)
  assert.match(painted, /Sign out confirmation/u)
  assert.match(painted, /No running account task is using this account/u)
  assert.equal(state.taskCheckCalls, 1)
  page.dispose()
})

test('an unknown SignOut ACK fences already-running Profile and Balance results until Host readback', async () => {
  const state: SourceState = { view: stored(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const source = makeSource(state)
  const profileReads: Array<(outcome: AccountQueryOutcome<AccountProfile>) => void> = []
  const balanceReads: Array<(outcome: AccountQueryOutcome<{ readonly value: readonly AccountWallet[]; readonly bonusWallets: readonly AccountWallet[] }>) => void> = []
  const readbacks: Array<(view: AccountView) => void> = []
  source.getProfile = () => new Promise(resolve => { profileReads.push(resolve) })
  source.getBalance = () => new Promise(resolve => { balanceReads.push(resolve) })
  source.getState = () => new Promise<AccountObservation>(resolve => {
    readbacks.push(view => resolve(issueObservation(state, view)))
  })
  source.signOut = async (_lease) => {
    state.calls.push('signOut')
    throw new Error('local credential removal failed')
  }
  const page = new AccountWorkspacePage(source, () => {}, { view: 'signout' })
  page.setBodyHeight(30)
  await flush()
  assert.equal(profileReads.length, 1)
  assert.equal(balanceReads.length, 1)
  focusAction(page, 'Sign out')
  page.handleInput('\r')
  await flush()
  assert.match(text(page), /sign-out failed: local credential removal failed/u)
  assert.equal(readbacks.length, 1)

  profileReads[0]!({ status: 'ready', value: { id: 'old-account', name: 'Old Account', contact: null } })
  balanceReads[0]!({ status: 'ready', value: { value: [{ currency: 'CNY', balance: '1.11' }], bonusWallets: [] } })
  await flush()
  const unresolved = text(page)
  assert.doesNotMatch(unresolved, /Old Account|old-account|1\.11 CNY/u,
    'the pre-mutation Profile/Balance responses cannot commit as current while ACK reconciliation is pending')
  assert.match(unresolved, /last known · not current/u)

  state.view = stored()
  readbacks[0]!(stored())
  await flush()
  assert.equal(profileReads.length, 2, 'successful Host readback starts a fresh current-account Profile read')
  assert.equal(balanceReads.length, 2, 'successful Host readback starts a fresh current-account Balance read')
  profileReads[1]!({ status: 'ready', value: { id: 'new-account', name: 'New Account', contact: null } })
  balanceReads[1]!({ status: 'ready', value: { value: [{ currency: 'CNY', balance: '2.22' }], bonusWallets: [] } })
  await flush()
  assert.match(text(page), /New Account/u)
  assert.match(text(page), /2\.22 CNY/u)
  assert.doesNotMatch(text(page), /Old Account|old-account|1\.11 CNY/u)
  assert.equal(state.calls.filter(call => call === 'signOut').length, 1, 'the unknown mutation is never replayed')
  page.dispose()
})

test('an older Account getState cannot overwrite a newer watch snapshot (RFL-002)', async () => {
  const state: SourceState = { view: signedOut(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  let pushWatch: ((view: AccountView) => void) | undefined
  let held: ((view: AccountView) => void) | undefined
  const source = makeSource(state)
  source.watch = async function* () {
    const lease = {} as AccountObservationLease
    yield watchEvent(state, state.view, lease)
    for (;;) {
      const next = await new Promise<AccountView>(resolve => { pushWatch = resolve })
      yield watchEvent(state, next, lease)
    }
  }
  source.getState = () => new Promise<AccountObservation>(resolve => {
    held = view => resolve(issueObservation(state, view))
  })
  const page = new AccountWorkspacePage(source, () => {}, { view: 'page' })
  page.setBodyHeight(26)
  await flush()
  page.render(100)
  // The watch supplies the initial state. The held getState read begins only
  // on the manual refresh below, then loses to the newer watch snapshot.
  page.handleInput('r') // starts the old read
  await flush()
  state.view = stored()
  pushWatch?.(state.view)
  await flush()
  assert.match(text(page), /Signed in \(stored credential\)/u)
  held?.(signedOut())
  await flush()
  assert.match(text(page), /Signed in \(stored credential\)/u, 'the older read must be dropped')
})

test('offline Account refresh and an ended watch each restore one live subscription', async () => {
  const state: SourceState = {
    view: signedOut(), profileFails: false, balanceFails: false, runningTasks: false, calls: [], available: false,
  }
  const page = new AccountWorkspacePage(makeSource(state), () => {}, { view: 'page' })
  page.setBodyHeight(26)
  await flush()
  assert.match(text(page), /Host Account service is unavailable/u)
  assert.equal(state.watchStarts, 0, 'offline page cannot create a live Host watch')

  state.available = true
  page.handleInput('r')
  await flush()
  assert.match(text(page), /Signed out \/ no stored credential/u)
  assert.equal(state.watchStarts, 1, 'Refresh starts one complete Host watch after reconnection')
  assert.equal(state.watchActive, 1)

  const fail = [...state.watchFailures!][0]
  fail!(new Error('transport closed'))
  await flush()
  assert.match(text(page), /Host Account watch stopped; Refresh to read current state/u)
  assert.equal(state.watchActive, 0, 'the failed stream releases its old subscription')

  page.handleInput('r')
  await flush()
  assert.equal(state.watchStarts, 2, 'manual refresh restarts the failed watch exactly once')
  assert.equal(state.watchActive, 1, 'only the replacement watch remains live')
  state.view = stored()
  for (const publish of [...state.watchListeners!]) publish()
  await flush()
  assert.match(text(page), /Signed in \(stored credential\)/u,
    'a later Host update from the replacement stream reaches the still-open page')
  page.dispose()
  await flush()
  assert.equal(state.watchActive, 0, 'page disposal retires the one replacement stream')
})

test('a watch retry keeps a last-known credential fail-closed until its initial Host frame arrives', async () => {
  const state: SourceState = { view: stored(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const source = makeSource(state)
  let watchStarts = 0
  let releaseReplacement!: (view: AccountView) => void
  source.watch = async function* (signal) {
    watchStarts += 1
    state.watchStarts = watchStarts
    state.watchActive = (state.watchActive ?? 0) + 1
    const lease = {} as AccountObservationLease
    try {
      if (watchStarts === 1) {
        yield watchEvent(state, state.view, lease)
        await new Promise<void>((_resolve, reject) => {
          const failed = (error: Error): void => {
            state.watchFailures!.delete(failed)
            state.currentLeases!.delete(lease)
            signal.removeEventListener('abort', aborted)
            reject(error)
          }
          const aborted = (): void => {
            state.watchFailures!.delete(failed)
            reject(signal.reason)
          }
          state.watchFailures!.add(failed)
          signal.addEventListener('abort', aborted, { once: true })
        })
      }
      const snapshot = await new Promise<AccountView>(resolve => { releaseReplacement = resolve })
      yield watchEvent(state, snapshot, lease)
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    } finally {
      state.watchActive = (state.watchActive ?? 1) - 1
    }
  }
  const page = new AccountWorkspacePage(source, () => {}, { view: 'page' })
  page.setBodyHeight(30)
  await flush()
  assert.equal(watchStarts, 1)
  assert.match(text(page), /Signed in \(stored credential\)/u)
  focusAction(page, 'Sign out…')
  const firstFailure = [...state.watchFailures!][0]
  firstFailure!(new Error('carrier ended'))
  await flush()
  assert.match(text(page), /Host Account watch stopped; Refresh to read current state/u)
  assert.equal(state.watchActive, 0)
  page.handleInput('\r')
  await flush()
  assert.doesNotMatch(text(page), /Sign out confirmation/u,
    'a stale stored AccountView cannot start the SignOut confirmation/task-risk query')
  assert.equal(state.calls.includes('signOut'), false)

  page.handleInput('r')
  await flush()
  assert.equal(state.watchStarts, 2)
  assert.equal(state.watchActive, 1)
  assert.match(text(page), /Refreshing Host account state/u)
  assert.match(text(page), /Last known: signed in · Host state not current/u, 'the old snapshot remains explicitly last-known')
  page.render(100)
  for (let index = 0; index < 7; index += 1) page.handleInput('\u001b[B')
  page.render(100)
  page.handleInput('\r')
  assert.equal(state.calls.includes('signOut'), false, 'a stale last-known view cannot authorize SignOut during watch restart')

  state.view = signedOut()
  releaseReplacement(state.view)
  await flush()
  assert.match(text(page), /Signed out \/ no stored credential/u)
  assert.doesNotMatch(text(page), /Refreshing Host account state/u)
  page.dispose()
  await flush()
  assert.equal(state.watchActive, 0)
})

test('SignIn is unavailable until the initial Host watch snapshot confirms signed-out', async () => {
  const state: SourceState = { view: signedOut(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const source = makeSource(state)
  let releaseInitial!: (view: AccountView) => void
  source.watch = async function* (signal) {
    state.watchStarts = (state.watchStarts ?? 0) + 1
    state.watchActive = (state.watchActive ?? 0) + 1
    const lease = {} as AccountObservationLease
    try {
      const first = await new Promise<AccountView>(resolve => { releaseInitial = resolve })
      yield watchEvent(state, first, lease)
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    } finally {
      state.watchActive = (state.watchActive ?? 1) - 1
    }
  }
  const page = new AccountWorkspacePage(source, () => {}, { view: 'page' })
  page.setBodyHeight(30)
  await flush()
  assert.match(text(page), /Reading Host account state/u)
  assert.equal(state.watchStarts, 1)
  clickPaintedAction(page, 'Sign in')
  await flush()
  assert.equal(state.calls.includes('signIn'), false,
    'the painted SignIn action cannot dispatch while no trusted AccountView exists')

  releaseInitial(signedOut())
  await flush()
  focusAction(page, 'Sign in')
  page.handleInput('\r')
  await flush()
  assert.deepEqual(state.calls, ['signIn'], 'a fresh signed-out Host snapshot admits the explicit SignIn')
  assert.match(text(page), /waiting-browser/u)
  page.dispose()
  await flush()
})

test('a current signed-out Host view with a terminal attempt still admits a fresh SignIn', async () => {
  const terminal: AccountView = {
    ...signedOut(),
    attempt: { id: 'attempt-previous', phase: 'cancelled' },
  }
  const state: SourceState = { view: terminal, profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const page = new AccountWorkspacePage(makeSource(state), () => {}, { view: 'page' })
  page.setBodyHeight(30)
  await flush()
  assert.match(text(page), /Last attemptcancelled/u)
  focusAction(page, 'Sign in')
  page.handleInput('\r')
  await flush()
  assert.deepEqual(state.calls, ['signIn'])
  assert.match(text(page), /waiting-browser/u)
  page.dispose()
})

test('SignOut deep link waits for its first current Host observation', async () => {
  const state: SourceState = { view: stored(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const source = makeSource(state)
  let releaseInitial!: (view: AccountView) => void
  source.watch = async function* (signal) {
    const lease = {} as AccountObservationLease
    const first = await new Promise<AccountView>(resolve => { releaseInitial = resolve })
    yield watchEvent(state, first, lease)
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  }
  const page = new AccountWorkspacePage(source, () => {}, { view: 'signout' })
  page.setBodyHeight(30)
  await flush()
  assert.match(text(page), /Reading Host account state/u)
  assert.equal(state.taskCheckCalls ?? 0, 0, 'no task-risk read is authorized before the first Host frame')
  page.handleInput('\r')
  await flush()
  assert.equal(state.calls.includes('signOut'), false,
    'the /logout confirmation cannot dispatch from an absent Account observation')

  releaseInitial(signedOut())
  await flush()
  assert.match(text(page), /Nothing to sign out/u)
  assert.equal(state.calls.includes('signOut'), false)
  page.dispose()
})

test('a stored Account view loses mutation authority immediately when its adapter lease expires', async () => {
  const state: SourceState = { view: stored(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const source = makeSource(state)
  const page = new AccountWorkspacePage(source, () => {}, { view: 'page' })
  page.setBodyHeight(30)
  await flush()
  assert.match(text(page), /Signed in \(stored credential\)/u)
  assert.equal(state.taskCheckCalls, 1)
  focusAction(page, 'Sign out…')

  state.currentLeases!.clear()
  assert.equal(source.available(), true, 'the Account service can remain present while its old observation is stale')
  assert.match(text(page), /Last known: signed in · Host state not current/u)
  assert.match(text(page), /last known · not current/u)
  page.handleInput('\r')
  await flush()
  assert.doesNotMatch(text(page), /Sign out confirmation/u)
  assert.equal(state.taskCheckCalls, 1, 'the stale Host view cannot start a new task-risk read')
  assert.equal(state.calls.includes('signOut'), false, 'the stale Host grant cannot dispatch SignOut')
  page.dispose()
})

test('late Profile and Balance results from an invalidated Account lease cannot paint for its replacement', async () => {
  const state: SourceState = { view: stored(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const source = makeSource(state)
  const profileReads: Array<(value: Awaited<ReturnType<AccountWorkspaceSource['getProfile']>>) => void> = []
  const balanceReads: Array<(value: Awaited<ReturnType<AccountWorkspaceSource['getBalance']>>) => void> = []
  source.getProfile = () => new Promise(resolve => { profileReads.push(resolve) })
  source.getBalance = () => new Promise(resolve => { balanceReads.push(resolve) })
  const page = new AccountWorkspacePage(source, () => {}, { view: 'page' })
  page.setBodyHeight(30)
  await flush()
  assert.equal(profileReads.length, 1)
  assert.equal(balanceReads.length, 1)

  const fail = [...state.watchFailures!][0]
  fail!(new Error('Host generation replaced'))
  await flush()
  state.view = stored()
  page.handleInput('r')
  await flush()
  assert.equal(state.watchStarts, 2)
  assert.equal(profileReads.length, 2)
  assert.equal(balanceReads.length, 2)

  const oldProfile: AccountProfile = { id: 'old-account', name: 'Old Account', contact: null }
  profileReads[0]!({ status: 'ready', value: oldProfile })
  balanceReads[0]!({ status: 'ready', value: { value: [{ currency: 'CNY', balance: '1.00' }], bonusWallets: [] } })
  await flush()
  assert.doesNotMatch(text(page), /Old Account|1\.00 CNY/u,
    'the old generation detail responses cannot repaint beside the replacement Host state')

  profileReads[1]!({ status: 'ready', value: { id: 'new-account', name: 'New Account', contact: null } })
  balanceReads[1]!({ status: 'ready', value: { value: [{ currency: 'CNY', balance: '2.00' }], bonusWallets: [] } })
  await flush()
  assert.match(text(page), /New Account/u)
  assert.match(text(page), /2\.00 CNY/u)
  page.dispose()
})

test('a terminal signed-out watch failure blocks SignIn until Refresh restores its Host snapshot', async () => {
  const state: SourceState = { view: signedOut(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const page = new AccountWorkspacePage(makeSource(state), () => {}, { view: 'page' })
  page.setBodyHeight(30)
  await flush()
  await flush()
  focusAction(page, 'Sign in')
  const fail = [...state.watchFailures!][0]
  fail!(new Error('Host watch unavailable'))
  await flush()
  assert.match(text(page), /Host Account watch stopped; Refresh to read current state/u)
  page.handleInput('\r')
  await flush()
  assert.equal(state.calls.includes('signIn'), false,
    'Enter after a terminal watch failure cannot dispatch from the previously painted enabled SignIn')
  assert.equal(state.watchActive, 0)

  page.handleInput('r')
  await flush()
  assert.equal(state.watchStarts, 2)
  assert.match(text(page), /Signed out \/ no stored credential/u)
  focusAction(page, 'Sign in')
  page.handleInput('\r')
  await flush()
  assert.equal(state.calls.filter(call => call === 'signIn').length, 1,
    'Refresh restores a trusted signed-out frame before admitting a new SignIn')
  assert.match(text(page), /waiting-browser/u)
  page.dispose()
})

test('a terminal Account watch failure disables Cancel and hides its stale authorization URL', async () => {
  const state: SourceState = { view: waitingAttempt(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const page = new AccountWorkspacePage(makeSource(state), () => {}, { view: 'page' })
  page.setBodyHeight(30)
  await flush()
  assert.match(text(page), /waiting-browser/u)
  focusAction(page, 'Cancel current attempt')
  const fail = [...state.watchFailures!][0]
  fail!(new Error('Host watch unavailable'))
  await flush()
  assert.match(text(page), /Host Account watch stopped; Refresh to read current state/u)
  assert.match(text(page), /Last known: signed out · Host state not current/u)
  assert.doesNotMatch(text(page), /https:\/\/platform\.example\/dsh\/authorize/u,
    'a stale authorize URL is not presented after its Host observation is invalidated')
  assert.doesNotMatch(text(page), /Open browser/u)
  page.handleInput('\r')
  await flush()
  assert.equal(state.calls.some(call => call.startsWith('cancel:')), false,
    'Enter after a terminal watch failure cannot dispatch using its last-known attempt ID')
  assert.equal(state.watchActive, 0)
  page.dispose()
})

test('closing the page ends only its watcher; a fresh page rebuilds the completed Host state (MA10)', async () => {
  const state: SourceState = { view: waitingAttempt(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const source = makeSource(state)
  const first = new AccountWorkspacePage(source, () => {}, { view: 'page' })
  first.setBodyHeight(24)
  await flush()
  assert.match(text(first), /waiting-browser/u)
  first.dispose()
  // The Host attempt completes after the page is gone; the source (Host) now
  // reports a stored credential. A new page must read that state, not a local
  // cache and not a resurrected old page.
  state.view = stored()
  const second = new AccountWorkspacePage(source, () => {}, { view: 'page' })
  second.setBodyHeight(24)
  await flush()
  assert.match(text(second), /Signed in \(stored credential\)/u)
  assert.match(text(second), /Moon/u, 'the fresh page reads the independent profile too')
  assert.equal(state.calls.some(call => call.startsWith('cancel:')), false, 'closing the page does not cancel the browser attempt')
})

test('the Account page fits signed-out, attempt and stored states across its frozen workspace size matrix', async () => {
  for (const [width, height] of [
    [200, 50], [120, 40], [100, 40], [80, 24], [80, 10], [72, 24], [44, 20],
    [105, 40], [60, 22], [40, 16], [30, 8],
  ] as const) {
    for (const view of [signedOut(), waitingAttempt(), stored()]) {
      const state: SourceState = { view, profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
      const page = new AccountWorkspacePage(makeSource(state), () => {}, { view: 'page' })
      page.setBodyHeight(height)
      await flush(3)
      const lines = page.render(width)
      assert.equal(lines.length, height)
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width, `${width}x${height} paints ${visibleWidth(line)} cells: ${JSON.stringify(stripTerminalSequences(line))}`)
      }
    }
  }
})

test('stale Account currentness remains readable across frozen sizes and dark/light/custom themes', async t => {
  const originalPalette = currentPalette
  t.after(() => setTheme('custom', originalPalette))
  const themes = [
    { mode: 'dark' as const, palette: darkColors },
    { mode: 'light' as const, palette: lightColors },
    { mode: 'custom' as const, palette: { ...darkColors, text: '#345678', textDim: '#456789' } },
  ]
  const rgb = (value: string): number => Number.parseInt(value.replace(/^#/u, ''), 16)
  for (const theme of themes) {
    setTheme(theme.mode, theme.palette)
    for (const [width, height] of [[100, 40], [80, 24], [44, 20], [30, 8]] as const) {
      const state: SourceState = { view: stored(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
      const page = new AccountWorkspacePage(makeSource(state), () => {}, { view: 'page' })
      page.setBodyHeight(height)
      await flush()
      state.currentLeases!.clear()
      const rows = page.render(width)
      const frame = rows.map(stripTerminalSequences).join('\n')
      if (width <= 30 || height <= 8) {
        assert.match(frame, /stale: signed in/u, `${theme.mode} ${width}x${height} must keep the compact stale Account state visible`)
      } else {
        assert.match(frame, /Last known: signed in/u, `${theme.mode} ${width}x${height} must distinguish stale from current stored state`)
        assert.match(frame, /state not current/u, `${theme.mode} ${width}x${height} must name the missing currentness fact`)
      }
      assert.equal(rows.length, height)
      assert.ok(rows.every(row => visibleWidth(row) <= width), `${theme.mode} ${width}x${height} stale frame must remain inside its viewport`)
      if (width === 30 && height === 8) {
        const terminal = new VirtualTerminal(width, height)
        terminal.write(rows.join('\r\n'))
        const physical = await terminal.flushAndGetViewport()
        assert.match(physical.join('\n'), /stale: signed in/u,
          `${theme.mode} real renderer frame keeps the stale distinction on-screen at 30x8`)
        const statusRow = physical.findIndex(row => row.includes('stale: signed in'))
        const statusCol = physical[statusRow]!.indexOf('stale: signed in')
        assert.equal(terminal.getCellFgRgb(statusRow, statusCol), rgb(theme.palette.text),
          `${theme.mode} stale Status uses the normal-text semantic token`)
        assert.ok(physical.every(row => visibleWidth(row) <= width))
      }
      page.dispose()
    }
  }
})

test('disposing the Account page aborts its Host watch subscription (MA13 watcher closure)', async () => {
  const state: SourceState = { view: signedOut(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  let aborted = false
  const source = makeSource(state)
  source.watch = async function* (signal) {
    const lease = {} as AccountObservationLease
    yield watchEvent(state, state.view, lease)
    await new Promise<void>(resolve => {
      signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true })
    })
  }
  const page = new AccountWorkspacePage(source, () => {}, { view: 'page' })
  page.setBodyHeight(24)
  await flush()
  assert.equal(aborted, false)
  page.dispose()
  await flush()
  assert.equal(aborted, true, 'the page must end its own watch signal on teardown')
})

test('a pending sign-out owns the page: pendingMutation is true and Esc cannot exit (P1)', async () => {
  const state: SourceState = { view: stored(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  let release: (() => void) | undefined
  const source = makeSource(state)
  source.signOut = (lease) => new Promise<AccountObservation>(resolve => {
    state.calls.push('signOut')
    release = () => { state.view = signedOut(); resolve(issueObservation(state, state.view, lease)) }
  })
  const page = new AccountWorkspacePage(source, () => {}, { view: 'signout' })
  page.setBodyHeight(26)
  await flush()
  text(page)
  page.handleInput('\r') // confirm sign out
  await flush()
  assert.equal(page.pendingMutation(), true)
  assert.equal(page.handleInput('\u001b'), 'handled')
  await flush()
  assert.match(text(page), /Sign out/u)
  assert.match(text(page), /in flight/u)
  release?.()
  await flush()
  assert.equal(page.pendingMutation(), false)
})

test('an IPv6 loopback callback origin produces a matching SSH tunnel template (F8)', async () => {
  const state: SourceState = { view: waitingAttempt(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const source = makeSource(state)
  source.callbackOrigin = () => 'http://[::1]:43121'
  source.startSignIn = async lease => {
    state.calls.push('signIn')
    state.view = waitingAttempt()
    return issueObservation(state, state.view, lease)
  }
  const page = new AccountWorkspacePage(source, () => {}, { view: 'page' })
  page.setBodyHeight(30)
  await flush()
  const painted = text(page)
  assert.match(painted, /\[::1\]:43121/u)
  assert.match(painted, /ssh -N -L '\[::1\]:43121:\[::1\]:43121'/u)
})

test('a same-status Host grant replacement invalidates the open sign-out confirmation (P1)', async () => {
  const state: SourceState = { view: stored(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  let identity = 'Account A'
  const source = makeSource(state)
  let pushWatch: ((view: AccountView) => void) | undefined
  source.watch = async function* () {
    const lease = {} as AccountObservationLease
    yield watchEvent(state, state.view, lease)
    while (true) {
      const next = await new Promise<AccountView>(resolve => { pushWatch = resolve })
      yield watchEvent(state, next, lease)
    }
  }
  source.getProfile = async (_lease) => ({ status: 'ready', value: { id: identity, name: identity, contact: 'm***@example.com' } })
  const page = new AccountWorkspacePage(source, () => {}, { view: 'page' })
  page.setBodyHeight(30)
  await flush()
  text(page)
  // Actions: Usage, Top up, Sign out, Refresh, ← Settings.
  page.handleInput('\u001b[B')
  page.handleInput('\u001b[B')
  page.handleInput('\r')
  await flush()
  assert.match(text(page), /Sign out confirmation/u)
  assert.match(text(page), /Account A/u)

  identity = 'Account B'
  state.view = stored() // same status, different grant
  pushWatch?.(state.view)
  await flush()
  const after = text(page)
  assert.doesNotMatch(after, /Sign out confirmation/u)
  assert.match(after, /Account B/u)
  assert.match(after, /confirm sign-out again/u)
})

test('a stale startSignIn snapshot cannot overwrite a newer watch state (P2)', async () => {
  const state: SourceState = { view: signedOut(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const source = makeSource(state)
  let resolveStart: ((view: AccountView) => void) | undefined
  source.startSignIn = lease => new Promise<AccountObservation>(resolve => {
    state.calls.push('signIn')
    resolveStart = view => resolve(issueObservation(state, view, lease))
  })
  let pushWatch: ((view: AccountView) => void) | undefined
  source.watch = async function* () {
    const lease = {} as AccountObservationLease
    yield watchEvent(state, state.view, lease)
    while (true) {
      const next = await new Promise<AccountView>(resolve => { pushWatch = resolve })
      yield watchEvent(state, next, lease)
    }
  }
  const page = new AccountWorkspacePage(source, () => {}, { view: 'page' })
  page.setBodyHeight(30)
  await flush()
  text(page)
  page.handleInput('\r') // start sign-in; its snapshot is held
  await flush()
  state.view = stored()
  pushWatch?.(state.view) // newer watch: authorization already completed
  await flush()
  resolveStart?.(waitingAttempt()) // old snapshot arrives late
  await flush()
  const painted = text(page)
  assert.match(painted, /Signed in \(stored credential\)/u)
  assert.doesNotMatch(painted, /waiting-browser/u)
  assert.equal(page.pendingMutation(), false)
})

test('an unknown SignIn acknowledgement waits for a Host reread before another attempt', async () => {
  const state: SourceState = { view: signedOut(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const source = makeSource(state)
  let starts = 0
  let releaseState: ((view: AccountView) => void) | undefined
  source.startSignIn = async lease => {
    starts += 1
    state.calls.push('signIn')
    if (starts === 1) throw new Error('the Host acknowledgement was lost')
    state.view = waitingAttempt()
    return issueObservation(state, state.view, lease)
  }
  source.getState = () => new Promise<AccountObservation>(resolve => {
    releaseState = view => resolve(issueObservation(state, view))
  })
  const page = new AccountWorkspacePage(source, () => {}, { view: 'page' })
  page.setBodyHeight(30)
  await flush()
  text(page)
  page.handleInput('\r')
  await flush()
  assert.equal(starts, 1)
  assert.match(text(page), /sign-in could not start: the Host acknowledgement was lost/u)
  page.handleInput('\r')
  assert.equal(starts, 1, 'an unknown acknowledgement does not admit another SignIn dispatch')
  state.view = stored()
  for (const publish of [...state.watchListeners!]) publish()
  await flush()
  page.handleInput('\r')
  assert.equal(starts, 1, 'a Watch frame cannot replay the unknown SignIn mutation')
  releaseState?.(signedOut())
  await flush()
  assert.match(text(page), /Signed out \/ no stored credential/u)
  focusAction(page, 'Sign in')
  page.handleInput('\r')
  await flush()
  assert.equal(starts, 2, 'one explicit retry is admitted after the Host readback proves signed-out')
  assert.match(text(page), /waiting-browser/u)
})

test('an unknown mutation ACK cannot be reconciled by a Watch frame ahead of getState', async () => {
  const state: SourceState = { view: signedOut(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const source = makeSource(state)
  let starts = 0
  const releases: Array<(view: AccountView) => void> = []
  source.startSignIn = async lease => {
    starts += 1
    state.calls.push('signIn')
    if (starts === 1) throw new Error('the Host acknowledgement was lost')
    state.view = waitingAttempt()
    return issueObservation(state, state.view, lease)
  }
  source.getState = () => new Promise<AccountObservation>(resolve => {
    releases.push(view => resolve(issueObservation(state, view)))
  })
  const page = new AccountWorkspacePage(source, () => {}, { view: 'page' })
  page.setBodyHeight(30)
  await flush()
  text(page)
  page.handleInput('\r')
  await flush()
  assert.equal(starts, 1)
  assert.equal(releases.length, 1, 'the unknown ACK starts one Host readback')

  state.view = signedOut()
  for (const publish of [...state.watchListeners!]) publish()
  await flush()
  assert.match(text(page), /Last known: signed out · Host state not current/u,
    'the Watch fact is shown as last-known during reconciliation')
  assert.equal(starts, 1,
    'a Watch frame concurrent with the pending readback cannot reopen mutation admission')
  state.view = stored()
  releases[0]!(stored())
  await flush()
  assert.match(text(page), /Signed in \(stored credential\)/u)
  assert.equal(releases.length, 1,
    'the causally later Host readback satisfies the barrier even if a newer Watch frame rendered')
  assert.doesNotMatch(text(page), /Sign in\s/u)
  focusAction(page, 'Sign out…')
  page.handleInput('\r')
  await flush()
  assert.match(text(page), /Sign out confirmation/u)
  page.dispose()
  page.dispose()
})

test('a superseded unknown-ACK readback that fails restarts the Host readback before admission', async () => {
  const state: SourceState = { view: signedOut(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const source = makeSource(state)
  let starts = 0
  const readbacks: Array<{ resolve(view: AccountView): void; reject(error: Error): void }> = []
  source.startSignIn = async lease => {
    starts += 1
    state.calls.push('signIn')
    if (starts === 1) throw new Error('the Host acknowledgement was lost')
    state.view = waitingAttempt()
    return issueObservation(state, state.view, lease)
  }
  source.getState = () => new Promise<AccountObservation>((resolve, reject) => {
    readbacks.push({
      resolve: view => resolve(issueObservation(state, view)),
      reject,
    })
  })
  const page = new AccountWorkspacePage(source, () => {}, { view: 'page' })
  page.setBodyHeight(30)
  await flush()
  text(page)
  page.handleInput('\r')
  await flush()
  assert.equal(starts, 1)
  assert.equal(readbacks.length, 1, 'the unknown ACK starts one causal Host readback')

  state.view = signedOut()
  for (const publish of [...state.watchListeners!]) publish()
  await flush()
  assert.equal(readbacks.length, 1, 'the newer Watch frame cannot duplicate the in-flight readback')

  readbacks[0]!.reject(new Error('transient Host read failure'))
  await flush()
  assert.equal(readbacks.length, 2,
    'a readback superseded by a newer Watch frame retries against that current observation')
  assert.match(text(page), /Last known: signed out · Host state not current/u)
  page.handleInput('\r')
  assert.equal(starts, 1, 'the automatic readback retry never replays the mutation')

  readbacks[1]!.resolve(signedOut())
  await flush()
  assert.match(text(page), /Signed out \/ no stored credential/u)
  focusAction(page, 'Sign in')
  page.handleInput('\r')
  await flush()
  assert.equal(starts, 2, 'only the successful causal readback restores explicit SignIn admission')
  assert.match(text(page), /waiting-browser/u)
  page.dispose()
})

test('a current unknown-ACK readback failure stays fenced and only explicit Refresh retries', async () => {
  const state: SourceState = { view: signedOut(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const source = makeSource(state)
  let starts = 0
  const readbacks: Array<{ resolve(view: AccountView): void; reject(error: Error): void }> = []
  source.startSignIn = async lease => {
    starts += 1
    state.calls.push('signIn')
    if (starts === 1) throw new Error('the Host acknowledgement was lost')
    state.view = waitingAttempt()
    return issueObservation(state, state.view, lease)
  }
  source.getState = () => new Promise<AccountObservation>((resolve, reject) => {
    readbacks.push({
      resolve: view => resolve(issueObservation(state, view)),
      reject,
    })
  })
  const page = new AccountWorkspacePage(source, () => {}, { view: 'page' })
  page.setBodyHeight(30)
  await flush()
  text(page)
  page.handleInput('\r')
  await flush()
  assert.equal(readbacks.length, 1)

  state.view = signedOut()
  for (const publish of [...state.watchListeners!]) publish()
  await flush()
  readbacks[0]!.reject(new Error('transient Host read failure'))
  await flush()
  assert.equal(readbacks.length, 2, 'the superseded readback restarts once against the newer Watch frame')

  readbacks[1]!.reject(new Error('another transient Host read failure'))
  await flush()
  assert.equal(readbacks.length, 2, 'a current readback failure never starts an unbounded automatic retry loop')
  assert.match(text(page), /another transient Host read failure/u)
  assert.match(text(page), /Last known: signed out · Host state not current/u)
  page.handleInput('\r')
  await flush()
  assert.equal(starts, 1, 'the mutation barrier remains closed after the failed causal readback')

  page.handleInput('r')
  await flush()
  assert.equal(readbacks.length, 3, 'explicit Refresh makes exactly one fresh causal readback')
  readbacks[2]!.resolve(signedOut())
  await flush()
  assert.match(text(page), /Signed out \/ no stored credential/u)
  focusAction(page, 'Sign in')
  page.handleInput('\r')
  await flush()
  assert.equal(starts, 2, 'successful explicit recovery restores SignIn admission')
  page.dispose()
})

test('an unknown Cancel acknowledgement stays fenced through Watch and out-of-order readback frames', async () => {
  const state: SourceState = { view: waitingAttempt(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const source = makeSource(state)
  let cancels = 0
  const readbacks: Array<(view: AccountView) => void> = []
  source.cancelSignIn = async (id, lease) => {
    cancels += 1
    state.calls.push(`cancel:${id}`)
    if (cancels === 1) throw new Error('the Cancel acknowledgement was lost')
    state.view = { ...signedOut(), attempt: { id, phase: 'cancelled' } }
    return issueObservation(state, state.view, lease)
  }
  source.getState = () => new Promise<AccountObservation>(resolve => {
    readbacks.push(view => resolve(issueObservation(state, view)))
  })
  const page = new AccountWorkspacePage(source, () => {}, { view: 'page' })
  page.setBodyHeight(30)
  await flush()
  focusAction(page, 'Cancel current attempt')
  page.handleInput('\r')
  await flush()
  assert.deepEqual(state.calls, ['cancel:attempt-1'])
  assert.equal(readbacks.length, 1)
  const oldAuthorizeUrl = waitingAttempt().attempt!.authorizeUrl!
  const whileReconciling = text(page)
  assert.equal(whileReconciling.includes(oldAuthorizeUrl), false,
    'unknown Cancel ACK makes its old authorization URL non-current before readback')
  assert.doesNotMatch(whileReconciling, /Open browser|Copy link|Copy SSH template/u,
    'attempt URL actions are absent while the mutation result is unknown')
  assert.doesNotMatch(whileReconciling, />\s*(Usage ↗|Top up ↗)/u,
    'stored Account destinations are disabled while the mutation result is unknown')
  page.handleInput('o')
  page.handleInput('c')
  assert.equal(state.calls.some(call => call.startsWith('open:')), false,
    'the o shortcut cannot open the pre-Cancel authorization URL during reconciliation')
  assert.equal(state.calls.some(call => call.startsWith('copy:')), false,
    'the c shortcut cannot copy the cached pre-Cancel URL or account link during reconciliation')

  state.view = waitingAttempt()
  for (const publish of [...state.watchListeners!]) publish()
  await flush()
  page.handleInput('\r')
  assert.deepEqual(state.calls, ['cancel:attempt-1'],
    'the same Watch attempt snapshot cannot authorize a second Cancel')
  readbacks[0]!(waitingAttempt())
  await flush()
  assert.equal(readbacks.length, 1, 'the Watch frame did not duplicate the in-flight Host readback')
  focusAction(page, 'Cancel current attempt')
  page.handleInput('\r')
  await flush()
  assert.deepEqual(state.calls, ['cancel:attempt-1', 'cancel:attempt-1'],
    'one explicit retry of the exact current attempt is admitted after successful readback')
  assert.match(text(page), /Last attemptcancelled/u)
  page.dispose()
})

test('refresh is refused while an Account operation is busy (RFL-012)', async () => {
  const state: SourceState = { view: signedOut(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const source = makeSource(state)
  let resolveStart: ((view: AccountView) => void) | undefined
  let stateReads = 0
  source.startSignIn = lease => new Promise<AccountObservation>(resolve => {
    state.calls.push('signIn')
    resolveStart = view => resolve(issueObservation(state, view, lease))
  })
  source.getState = async () => {
    stateReads += 1
    throw new Error('refresh must not run while busy')
  }
  const page = new AccountWorkspacePage(source, () => {}, { view: 'page' })
  page.setBodyHeight(30)
  await flush()
  text(page)
  page.handleInput('\r') // start sign-in, held
  await flush()
  page.handleInput('r') // advertised refresh shortcut during busy
  await flush()
  assert.equal(stateReads, 0, 'refresh must not advance the generation or read state while busy')
  resolveStart?.(waitingAttempt())
  await flush()
  assert.match(text(page), /waiting-browser/u)
  assert.equal(page.pendingMutation(), false)
})

// ── Phase 3C / C2-A: the Left the Settings root may claim ─────────────────
//
// The Settings root may take a bare Left from the page ROOT back to the
// category rail. The page answers ONE question — "may the root claim this
// Left?" — and never reads the Host or changes business state to answer it.

test('a plain Account page may yield the focus to the Settings category rail', async () => {
  const { page } = open()
  await flush()
  assert.equal(page.canYieldFocusToNavigation(), true,
    'a plain Account page yields a bare Left to the root')
})

test('the sign-out confirmation keeps the Left inside the Account page', async () => {
  const state: SourceState = { view: stored(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const page = new AccountWorkspacePage(makeSource(state), () => {}, { view: 'signout' })
  page.setBodyHeight(30)
  await flush()
  assert.match(text(page), /Sign out confirmation/u)
  assert.equal(page.canYieldFocusToNavigation(), false,
    'the sign-out confirmation keeps the Left: it must not be bypassed')
})

test('a pending Account operation keeps the Left inside the Account page', async () => {
  const state: SourceState = { view: stored(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  let release: (() => void) | undefined
  const source = makeSource(state)
  source.signOut = (lease) => new Promise<AccountObservation>(resolve => {
    state.calls.push('signOut')
    release = () => { state.view = signedOut(); resolve(issueObservation(state, state.view, lease)) }
  })
  const page = new AccountWorkspacePage(source, () => {}, { view: 'signout' })
  page.setBodyHeight(26)
  await flush()
  text(page)
  page.handleInput('\r') // confirm the sign out
  await flush()
  assert.equal(page.pendingMutation(), true, 'the sign-out is in flight')
  assert.equal(page.canYieldFocusToNavigation(), false,
    'a pending Host operation keeps the Left inside the page')
  release?.()
  await flush()
  assert.equal(page.pendingMutation(), false, 'the Host settled')
  assert.equal(page.canYieldFocusToNavigation(), true,
    'a settled page yields the bare Left to the root again')
})

test('the page-actions fallback keeps the truthful Esc bar on the physical last row', () => {
  const { page } = open()
  page.setBodyHeight(3)
  const rows = text(page).split('\n')
  assert.equal(rows.length, 3)
  assert.match(rows[0]!, /Resize the terminal to show the page actions/u, 'the warning keeps the body row')
  assert.match(rows.at(-1)!, /Esc back/u, 'the truthful Esc action is the last physical row')
  assert.doesNotMatch(rows.at(-1)!, /Resize/u, 'the bar is not pushed above a blank row')

  page.setBodyHeight(1)
  const one = text(page).split('\n')
  assert.equal(one.length, 1)
  assert.match(one[0]!, /^Esc back/u, 'a one-row page paints only its real Esc action')
  assert.doesNotMatch(one[0]!, /Resize|Enter/u, 'no hidden business action is advertised')
})


test('the zero-body fallback names the real Esc cancel of the open sign-out confirmation', async () => {
  const state: SourceState = { view: stored(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const page = new AccountWorkspacePage(makeSource(state), () => {}, { view: 'signout' })
  page.setBodyHeight(30)
  await flush()
  text(page) // paint the confirmation and its real action rows
  page.setBodyHeight(2)
  const rows = text(page).split('\n')
  assert.equal(rows.length, 2)
  assert.match(rows.at(-1)!, /Esc cancel/u, 'Esc cancels the confirmation, so the last row must say cancel')
})
