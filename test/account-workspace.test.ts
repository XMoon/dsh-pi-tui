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
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { AccountWorkspacePage, type AccountInitialView } from '../src/tui/panels/account-workspace-page.ts'
import type { AccountWorkspaceSource } from '../src/app/command/account-workflow.ts'
import { accountClientMetadata } from '../src/app/command/account-workflow.ts'
import type { AccountView } from '../src/runtime/config-port.ts'

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
}

function makeSource(state: SourceState): AccountWorkspaceSource {
  return {
    available: () => true,
    callbackOrigin: () => 'http://127.0.0.1:43121',
    getState: async () => state.view,
    watch: async function* () {
      // The official watch yields a complete initial state; the page also
      // reads getState on open, so an empty stream is a valid test stand-in.
      yield state.view
      await new Promise<void>(() => {})
    },
    getProfile: async () => state.profileFails
      ? { status: 'failed', reason: 'profile endpoint unavailable' }
      : { status: 'ready', value: { id: 'acct-1', name: 'Moon', contact: 'm***@example.com' } },
    getBalance: async () => state.balanceFails
      ? { status: 'failed', reason: 'balance endpoint unavailable' }
      : { status: 'ready', value: { value: [{ currency: 'CNY', balance: '12.50' }], bonusWallets: [{ currency: 'CNY', balance: '3.00' }] } },
    startSignIn: async () => {
      state.calls.push('signIn')
      state.view = waitingAttempt()
      return state.view
    },
    cancelSignIn: async id => {
      state.calls.push(`cancel:${id}`)
      state.view = signedOut()
      return state.view
    },
    signOut: async () => {
      state.calls.push('signOut')
      state.view = signedOut()
      return state.view
    },
    hasRunningAccountTasks: () => state.runningTasks,
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
  assert.match(painted, /ssh -N -L 127\.0\.0\.1:43121:127\.0\.0\.1:43121/u)
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

test('sign out requires confirmation, warns about running account tasks and never restores a local grant on failure', async () => {
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

test('/logout deep link opens the Sign out confirmation directly', async () => {
  const { page, state } = open({ view: 'signout' })
  state.view = stored()
  await flush()
  assert.match(text(page), /Sign out confirmation/u)
})

test('a failed sign-out keeps the Host-reported state and reports the failure', async () => {
  const state: SourceState = { view: stored(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const source = makeSource(state)
  source.signOut = async () => {
    state.calls.push('signOut')
    throw new Error('local credential removal failed')
  }
  const page = new AccountWorkspacePage(source, () => {}, { view: 'signout' })
  page.setBodyHeight(24)
  await flush()
  text(page)
  page.handleInput('\r')
  await flush()
  const painted = text(page)
  assert.match(painted, /sign-out failed: local credential removal failed/u)
  assert.match(painted, /Signed in \(stored credential\)/u)
})

test('an older Account getState cannot overwrite a newer watch snapshot (RFL-002)', async () => {
  const state: SourceState = { view: signedOut(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  let pushWatch: ((view: AccountView) => void) | undefined
  let held: ((view: AccountView) => void) | undefined
  const source = makeSource(state)
  source.watch = async function* () {
    yield state.view
    for (;;) {
      const next = await new Promise<AccountView>(resolve => { pushWatch = resolve })
      yield next
    }
  }
  source.getState = () => new Promise<AccountView>(resolve => { held = resolve })
  const page = new AccountWorkspacePage(source, () => {}, { view: 'page' })
  page.setBodyHeight(26)
  await flush()
  page.render(100)
  // The initial watch paint comes from the real getState? No: the held override
  // starts on the manual refresh below; seed the initial state explicitly.
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
