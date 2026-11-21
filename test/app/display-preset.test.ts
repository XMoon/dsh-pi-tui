/** Pure tests for the canonical PR2 display preset model. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiApp } from '../../src/tui-app.ts'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../../src/transcript.ts'
import { FOCUS_MODE_PROMPT } from '../../src/domain/communication/focus.ts'
import { installFocusPrompt, type SystemPromptLike } from '../../src/app/direct/system-prompt.ts'
import { StatusStore } from '../../src/domain/status/store.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import {
  isDisplayPreset,
  isDisplayPresetAvailable,
  isFocusDisplayPreset,
  resolveDisplayPreset,
  type DisplayState,
} from '../../src/domain/display/preset.ts'
import { displayPolicyFor } from '../../src/tui/transcript/display-policy.ts'

test('recognizes the complete display vocabulary and exposes every preset', () => {
  assert.equal(isDisplayPreset('focus'), true)
  assert.equal(isDisplayPreset('compact'), true)
  assert.equal(isDisplayPreset('full'), true)
  assert.equal(isDisplayPreset('other'), false)
  assert.equal(isDisplayPresetAvailable('focus'), true)
  assert.equal(isDisplayPresetAvailable('full'), true)
  assert.equal(isDisplayPresetAvailable('compact'), true)
  assert.equal(isFocusDisplayPreset('focus'), true)
  assert.equal(isFocusDisplayPreset('full'), false)
  assert.equal(isFocusDisplayPreset('compact'), false)
})

test('returns each preset disclosure policy', () => {
  assert.deepEqual(displayPolicyFor('focus'), {
    turnLayer: 'collapsed',
    processLayer: 'collapsed',
    focusBehavior: true,
  })
  assert.deepEqual(displayPolicyFor('full'), {
    turnLayer: 'open',
    processLayer: 'expanded',
    focusBehavior: false,
  })
  assert.deepEqual(displayPolicyFor('compact'), {
    turnLayer: 'open',
    processLayer: 'collapsed',
    focusBehavior: false,
  })
})

test('canonical persistence wins over legacy Focus for every recognized preset', () => {
  assert.deepEqual(resolveDisplayPreset({ displayPreset: 'focus', focusMode: 'off' }), {
    preset: 'focus', canonicalize: false, source: 'canonical',
  })
  assert.deepEqual(resolveDisplayPreset({ displayPreset: 'full', focusMode: 'on' }), {
    preset: 'full', canonicalize: false, source: 'canonical',
  })
  assert.deepEqual(resolveDisplayPreset({ displayPreset: 'compact', focusMode: 'on' }), {
    preset: 'compact', canonicalize: false, source: 'canonical',
  })
  assert.deepEqual(resolveDisplayPreset({ displayPreset: 'garbage', focusMode: 'on' }), {
    preset: 'full', canonicalize: true, source: 'invalid-canonical',
  })
})

test('legacy Focus migration maps on to Focus and everything else to Full', () => {
  assert.deepEqual(resolveDisplayPreset({ focusMode: 'on' }), {
    preset: 'focus', canonicalize: true, source: 'legacy-focus',
  })
  for (const focusMode of ['off', '', 'ON', 'yes', undefined]) {
    assert.deepEqual(resolveDisplayPreset({ focusMode }), {
      preset: 'full', canonicalize: true, source: 'legacy-full',
    })
  }
})

test('one shared DisplayState drives the Focus prompt, TuiApp, and status projection', () => {
  const displayState: DisplayState = { preset: 'full' }
  const statusStore = new StatusStore()
  const sections: Array<{ text: string | (() => string) }> = []
  const systemPrompt = {
    section: (section: { text: string | (() => string) }) => { sections.push(section); return () => {} },
  } as unknown as SystemPromptLike
  const disposePrompt = installFocusPrompt(systemPrompt, displayState)
  assert.ok(disposePrompt !== undefined)
  const app = new TuiApp(new VirtualTerminal(80, 24), {
    onSubmit: () => {},
    onExit: () => {},
  }, { displayState, statusStore })
  const promptText = () => {
    const text = sections[0]?.text
    return typeof text === 'function' ? text() : text ?? ''
  }
  assert.equal(promptText(), '')
  assert.equal(statusStore.snapshot().interaction.displayPreset, 'full')
  assert.deepEqual(app.setDisplayPreset('focus'), { kind: 'applied', preset: 'focus' })
  assert.equal(promptText(), FOCUS_MODE_PROMPT)
  assert.equal(statusStore.snapshot().interaction.displayPreset, 'focus')
  assert.equal(sections.length, 1, 'the shared prompt must not be re-registered')
  assert.deepEqual(app.setDisplayPreset('full'), { kind: 'applied', preset: 'full' })
  assert.equal(promptText(), '')
  assert.equal(statusStore.snapshot().interaction.displayPreset, 'full')
  disposePrompt()
  app.dispose()
})

test('TuiApp shares the canonical state and applies Compact without Focus behavior', async () => {
  const displayState: DisplayState = { preset: 'full' }
  const statusStore = new StatusStore()
  let notifications = 0
  const unsubscribe = statusStore.subscribe(() => { notifications += 1 })
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
  }, {
    displayState,
    statusStore,
  })
  app.start()
  await vt.waitForRender()
  assert.equal(statusStore.snapshot().interaction.displayPreset, 'full')
  assert.deepEqual(app.setDisplayPreset('focus'), { kind: 'applied', preset: 'focus' })
  assert.equal(displayState.preset, 'focus')
  assert.equal(app.isFocusModeEnabled(), true)
  assert.equal(statusStore.snapshot().interaction.displayPreset, 'focus')
  await vt.waitForRender()
  const beforeCompactRevision = statusStore.revision()
  const beforeCompactNotifications = notifications
  assert.deepEqual(app.setDisplayPreset('compact'), { kind: 'applied', preset: 'compact' })
  assert.equal(displayState.preset, 'compact')
  assert.equal(app.isFocusModeEnabled(), false, 'Compact must not enable the Focus behavioral policy')
  assert.equal(statusStore.snapshot().interaction.displayPreset, 'compact')
  assert.ok(statusStore.revision() > beforeCompactRevision, 'Compact must update the status projection')
  assert.ok(notifications > beforeCompactNotifications, 'Compact must notify the footer')
  await vt.waitForRender()
  assert.deepEqual(app.setDisplayPreset('compact'), { kind: 'unchanged', preset: 'compact' })
  assert.equal(displayState.preset, 'compact', 're-applying the live preset is unchanged, not a reset')
  unsubscribe()
  app.dispose()
})


function presetEvent(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent
}

/** One real window whose relay carries durable same-turn delivery evidence. */
function relayWindow(): TranscriptFolder {
  const relayMessage = {
    id: MessageId('preset-relay'), role: 'user',
    content: [{ type: 'text', text: 'PRESET_RELAY_PAYLOAD' }],
    source: { kind: 'agent-message', form: 'relay', senderSessionId: 'session-preset-child' },
  }
  const folder = new TranscriptFolder()
  folder.apply([
    presetEvent('turn/start', { turn: 0 }, 0),
    presetEvent('tool/call', { turn: 0, step: 0, callId: 'preset-c1', name: 'read', arguments: '{}' }, 1),
    presetEvent('tool/result', {
      turn: 0, step: 0,
      message: { id: MessageId('preset-r1'), role: 'tool', toolCallId: 'preset-c1', content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: 'preset-c1' } },
    }, 2),
    presetEvent('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [relayMessage] }, 3),
    presetEvent('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }, 4),
    presetEvent('user/message', relayMessage, 5),
    presetEvent('tool/call', { turn: 0, step: 1, callId: 'preset-c2', name: 'bash', arguments: '{}' }, 6),
    presetEvent('tool/result', {
      turn: 0, step: 1,
      message: { id: MessageId('preset-r2'), role: 'tool', toolCallId: 'preset-c2', content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: 'preset-c2' } },
    }, 7),
    presetEvent('assistant/message', {
      turn: 0, step: 2,
      message: { id: MessageId('preset-final'), role: 'assistant', content: [{ type: 'text', text: 'PRESET_FINAL_ANSWER' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 8),
    presetEvent('turn/end', { turn: 0, reason: { kind: 'completed' } }, 9),
  ])
  return folder
}

test('Compact and Focus fold the SAME proven relay while Full keeps the complete raw order', async () => {
  const folder = relayWindow()
  const before = folder.messages().map(message => message.kind)
  const render = async (preset: DisplayState['preset']): Promise<{ view: string; vt: VirtualTerminal; app: TuiApp }> => {
    const vt = new VirtualTerminal(120, 40)
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { displayState: { preset } })
    app.start()
    app.setTranscript(folder.messages(), folder.turnActivities())
    await vt.waitForRender()
    return {
      vt,
      app,
      view: vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n'),
    }
  }

  const compact = await render('compact')
  try {
    assert.ok(!compact.view.includes('PRESET_RELAY_PAYLOAD'),
      `Compact folds the proven relay under the Work:\n${compact.view}`)
    compact.vt.sendInput('\x0f') // Ctrl+O: the regular transcript disclosure master
    await compact.vt.waitForRender()
    const expanded = compact.vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
    assert.ok(expanded.includes('PRESET_RELAY_PAYLOAD'), `opening the Work restores the relay:\n${expanded}`)
    assert.ok(expanded.indexOf('PRESET_RELAY_PAYLOAD') < expanded.indexOf('PRESET_FINAL_ANSWER'),
      'the restored relay keeps its raw chronology before the final answer')
  } finally {
    compact.app.dispose()
  }

  const focus = await render('focus')
  try {
    assert.ok(!focus.view.includes('PRESET_RELAY_PAYLOAD'),
      `Focus hides the proven relay inside the Thought:\n${focus.view}`)
    assert.ok(/\d+ actions/.test(focus.view),
      `the collapsed Thought header is the visible owner:\n${focus.view}`)
    focus.vt.sendInput('\x0f')
    await focus.vt.waitForRender()
    const expanded = focus.vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
    assert.ok(expanded.includes('PRESET_RELAY_PAYLOAD'), `opening the Thought restores the relay:\n${expanded}`)
    assert.ok(expanded.indexOf('PRESET_RELAY_PAYLOAD') < expanded.indexOf('PRESET_FINAL_ANSWER'),
      'the restored relay keeps its raw chronology before the final answer')
  } finally {
    focus.app.dispose()
  }

  const full = await render('full')
  try {
    assert.ok(full.view.includes('PRESET_RELAY_PAYLOAD'), `Full keeps the relay card visible:\n${full.view}`)
    assert.ok(full.view.includes('PRESET_FINAL_ANSWER'))
    assert.ok(full.view.indexOf('PRESET_RELAY_PAYLOAD') < full.view.indexOf('PRESET_FINAL_ANSWER'),
      'Full keeps the raw chronology')
  } finally {
    full.app.dispose()
  }

  assert.deepEqual(folder.messages().map(message => message.kind), before,
    'the three presets consume the same untouched raw window')
})

/** One real window that carries a proven same-turn Agent relay AND a proven
 * same-turn subagent settlement inside a single Work. */
function mixedA2AWindow(): TranscriptFolder {
  const relayMessage = {
    id: MessageId('preset-mixed-relay'), role: 'user',
    content: [{ type: 'text', text: 'PRESET_MIXED_RELAY_PAYLOAD' }],
    source: { kind: 'agent-message', form: 'relay', senderSessionId: 'session-preset-child' },
  }
  const settledMessage = {
    id: MessageId('preset-mixed-settled'), role: 'user',
    content: [{ type: 'text', text: 'PRESET_MIXED_SETTLED_PAYLOAD' }],
    source: { kind: 'subagent-settled', form: 'notice', summary: 'PRESET_MIXED_SETTLED_SUMMARY', senderSessionId: 'session-preset-child' },
  }
  const folder = new TranscriptFolder()
  folder.apply([
    presetEvent('turn/start', { turn: 0 }, 0),
    presetEvent('tool/call', { turn: 0, step: 0, callId: 'preset-mixed-c1', name: 'read', arguments: '{}' }, 1),
    presetEvent('tool/result', {
      turn: 0, step: 0,
      message: { id: MessageId('preset-mixed-r1'), role: 'tool', toolCallId: 'preset-mixed-c1', content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: 'preset-mixed-c1' } },
    }, 2),
    presetEvent('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [relayMessage] }, 3),
    presetEvent('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }, 4),
    presetEvent('user/message', relayMessage, 5),
    presetEvent('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [settledMessage] }, 6),
    presetEvent('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }, 7),
    presetEvent('user/message', settledMessage, 8),
    presetEvent('tool/call', { turn: 0, step: 1, callId: 'preset-mixed-c2', name: 'bash', arguments: '{}' }, 9),
    presetEvent('tool/result', {
      turn: 0, step: 1,
      message: { id: MessageId('preset-mixed-r2'), role: 'tool', toolCallId: 'preset-mixed-c2', content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: 'preset-mixed-c2' } },
    }, 10),
    presetEvent('assistant/message', {
      turn: 0, step: 2,
      message: { id: MessageId('preset-mixed-final'), role: 'assistant', content: [{ type: 'text', text: 'PRESET_MIXED_FINAL_ANSWER' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 11),
    presetEvent('turn/end', { turn: 0, reason: { kind: 'completed' } }, 12),
  ])
  return folder
}

test('Compact and Focus fold the proven relay AND settlement while Full keeps every raw Context row', async () => {
  const folder = mixedA2AWindow()
  const relay = folder.messages().find(message => message.kind === 'system' && message.text === 'PRESET_MIXED_RELAY_PAYLOAD')
  const settled = folder.messages().find(message => message.kind === 'system' && message.text === 'PRESET_MIXED_SETTLED_PAYLOAD')
  assert.ok(relay !== undefined && relay.kind === 'system')
  assert.ok(settled !== undefined && settled.kind === 'system')
  assert.equal(relay.contextPresentation?.sameTurnNextStep, true, 'fixture: proven Working relay')
  assert.equal(settled.contextPresentation?.sameTurnNextStep, true, 'fixture: proven Working settlement')
  const before = folder.messages().map(message => message.kind)
  const render = async (preset: DisplayState['preset']): Promise<{ view: string; vt: VirtualTerminal; app: TuiApp }> => {
    const vt = new VirtualTerminal(120, 40)
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { displayState: { preset } })
    app.start()
    app.setTranscript(folder.messages(), folder.turnActivities())
    await vt.waitForRender()
    return {
      vt,
      app,
      view: vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n'),
    }
  }

  const compact = await render('compact')
  try {
    assert.ok(!compact.view.includes('PRESET_MIXED_RELAY_PAYLOAD'), `Compact folds the proven relay:\n${compact.view}`)
    assert.ok(!compact.view.includes('PRESET_MIXED_SETTLED_PAYLOAD'), `Compact folds the proven settlement:\n${compact.view}`)
    compact.vt.sendInput('\x0f') // Ctrl+O
    await compact.vt.waitForRender()
    const expanded = compact.vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
    assert.ok(expanded.includes('PRESET_MIXED_RELAY_PAYLOAD'), `opening the Work restores the relay:\n${expanded}`)
    assert.ok(expanded.includes('PRESET_MIXED_SETTLED_PAYLOAD'), `opening the Work restores the settlement:\n${expanded}`)
    assert.ok(expanded.indexOf('PRESET_MIXED_RELAY_PAYLOAD') < expanded.indexOf('PRESET_MIXED_SETTLED_PAYLOAD'),
      'both carried Context rows keep their raw chronology')
  } finally {
    compact.app.dispose()
  }

  const focus = await render('focus')
  try {
    assert.ok(!focus.view.includes('PRESET_MIXED_RELAY_PAYLOAD'), `Focus hides the proven relay:\n${focus.view}`)
    assert.ok(!focus.view.includes('PRESET_MIXED_SETTLED_PAYLOAD'), `Focus hides the proven settlement:\n${focus.view}`)
    focus.vt.sendInput('\x0f')
    await focus.vt.waitForRender()
    const expanded = focus.vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
    assert.ok(expanded.includes('PRESET_MIXED_RELAY_PAYLOAD'), `opening the Thought restores the relay:\n${expanded}`)
    assert.ok(expanded.includes('PRESET_MIXED_SETTLED_PAYLOAD'), `opening the Thought restores the settlement:\n${expanded}`)
    assert.ok(expanded.indexOf('PRESET_MIXED_RELAY_PAYLOAD') < expanded.indexOf('PRESET_MIXED_SETTLED_PAYLOAD'))
    assert.ok(expanded.indexOf('PRESET_MIXED_SETTLED_PAYLOAD') < expanded.indexOf('PRESET_MIXED_FINAL_ANSWER'))
  } finally {
    focus.app.dispose()
  }

  const full = await render('full')
  try {
    assert.ok(full.view.includes('PRESET_MIXED_RELAY_PAYLOAD'), `Full keeps the relay card:\n${full.view}`)
    // Full keeps the settlement CARD in raw order; its body stays behind the
    // card's own ordinary disclosure (the same as any standalone Notice).
    assert.ok(full.view.includes('PRESET_MIXED_SETTLED_SUMMARY'), `Full keeps the settlement card:\n${full.view}`)
    assert.ok(!full.view.includes('PRESET_MIXED_SETTLED_PAYLOAD'))
    assert.ok(full.view.indexOf('PRESET_MIXED_RELAY_PAYLOAD') < full.view.indexOf('PRESET_MIXED_SETTLED_SUMMARY'))
    assert.ok(full.view.indexOf('PRESET_MIXED_SETTLED_SUMMARY') < full.view.indexOf('PRESET_MIXED_FINAL_ANSWER'))
  } finally {
    full.app.dispose()
  }

  assert.deepEqual(folder.messages().map(message => message.kind), before,
    'the three presets consume the same untouched raw window')
})
