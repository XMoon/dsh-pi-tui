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
import { AccountWorkspacePage, type AccountInitialView } from '../../src/tui/panels/account-workspace-page.ts'
import type { AccountWorkspaceSource } from '../../src/app/command/account-workflow.ts'
import { accountClientMetadata } from '../../src/app/command/account-workflow.ts'
import type { AccountView } from '../../src/runtime/config-port.ts'

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

test('Account page fits 105/80/60/40/30 columns in signed-out, attempt and stored states (MA12)', async () => {
  for (const [width, height] of [[105, 40], [80, 24], [60, 22], [40, 16], [30, 8]] as const) {
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

test('disposing the Account page aborts its Host watch subscription (MA13 watcher closure)', async () => {
  const state: SourceState = { view: signedOut(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  let aborted = false
  const source = makeSource(state)
  source.watch = async function* (signal) {
    yield state.view
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
  source.signOut = () => new Promise<AccountView>(resolve => {
    state.calls.push('signOut')
    release = () => { state.view = signedOut(); resolve(state.view) }
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
  source.startSignIn = async () => {
    state.calls.push('signIn')
    state.view = waitingAttempt()
    return state.view
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
    yield state.view
    while (true) {
      const next = await new Promise<AccountView>(resolve => { pushWatch = resolve })
      yield next
    }
  }
  source.getProfile = async () => ({ status: 'ready', value: { id: identity, name: identity, contact: 'm***@example.com' } })
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
  source.startSignIn = () => new Promise<AccountView>(resolve => {
    state.calls.push('signIn')
    resolveStart = resolve
  })
  let pushWatch: ((view: AccountView) => void) | undefined
  source.watch = async function* () {
    yield state.view
    while (true) {
      const next = await new Promise<AccountView>(resolve => { pushWatch = resolve })
      yield next
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

test('refresh is refused while an Account operation is busy (RFL-012)', async () => {
  const state: SourceState = { view: signedOut(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  const source = makeSource(state)
  let resolveStart: ((view: AccountView) => void) | undefined
  let stateReads = 0
  source.startSignIn = () => new Promise<AccountView>(resolve => {
    state.calls.push('signIn')
    resolveStart = resolve
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
  const { page, state } = open({ view: 'signout' })
  state.view = stored()
  await flush()
  assert.match(text(page), /Sign out confirmation/u)
  assert.equal(page.canYieldFocusToNavigation(), false,
    'the sign-out confirmation keeps the Left: it must not be bypassed')
})

test('a pending Account operation keeps the Left inside the Account page', async () => {
  const state: SourceState = { view: stored(), profileFails: false, balanceFails: false, runningTasks: false, calls: [] }
  let release: (() => void) | undefined
  const source = makeSource(state)
  source.signOut = () => new Promise<AccountView>(resolve => {
    state.calls.push('signOut')
    release = () => { state.view = signedOut(); resolve(state.view) }
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
