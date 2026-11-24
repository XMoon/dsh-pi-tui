/**
 * Pure ACP command routing/catalog/result semantics.
 *
 * These cases protect the decisions that must not drift when the Host or wire
 * changes: official leading-command precedence, the exact supported variants,
 * the stable catalog projection and the committed-versus-cancelled compact
 * taxonomy. The real services and lifecycle are covered by the View owner
 * tests and the packed `acp.command-invocation` case.
 *
 * @module @xmoon76/dsh-pi-tui/local-acp-commands.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isAcpCompactAbort,
  catalogUpdate,
  classifyCompactOutcome,
  classifyStandaloneOutcome,
  readLeadingCommand,
  routeLeadingCommand,
  sameCatalogRows,
  type AcpCommandCatalogRead,
  type AcpCompactObservedFacts,
} from '../../src/app/remote-process/local-acp-commands.ts'

function parse(line: string): { readonly name: string; readonly rawInput: string } | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)
  return match === null ? undefined : { name: match[1] as string, rawInput: line.slice(match[0].length) }
}

function catalog(overrides: Partial<AcpCommandCatalogRead> = {}): AcpCommandCatalogRead {
  return {
    effectiveNames: [],
    feedback: 'missing',
    compact: 'missing',
    rows: [],
    ...overrides,
  }
}

function facts(overrides: Partial<AcpCompactObservedFacts> = {}): AcpCompactObservedFacts {
  return { checkpointSeen: false, conflict: false, ...overrides }
}

test('the leading command is read only from the first raw text wire block', () => {
  assert.deepEqual(readLeadingCommand([{ type: 'text', text: '/feedback hello' }], parse), {
    line: '/feedback hello', name: 'feedback', rawInput: ' hello',
  })
  assert.deepEqual(readLeadingCommand([{ type: 'text', text: '/com' }, { type: 'text', text: 'pact' }], parse), {
    line: '/com', name: 'com', rawInput: '',
  })
  assert.deepEqual(routeLeadingCommand(
    { line: '/com', name: 'com', rawInput: '' }, catalog(), new Set(), 2,
  ), { kind: 'prose' })
  assert.equal(readLeadingCommand([{ type: 'text', text: 'ordinary prose' }], parse), undefined)
  assert.equal(readLeadingCommand([{ type: 'image', data: 'AA==', mimeType: 'image/png' }], parse), undefined)
})

test('Host command precedence, approved misses and delivered Skill intent are exact', () => {
  const delivered = new Set(['deploy'])
  assert.deepEqual(routeLeadingCommand(
    { line: '/feedback hi', name: 'feedback', rawInput: ' hi' },
    catalog({ effectiveNames: ['feedback'], feedback: 'available' }),
    delivered,
    1,
  ), { kind: 'standalone', line: '/feedback hi' })
  assert.deepEqual(routeLeadingCommand(
    { line: '/compact', name: 'compact', rawInput: '' },
    catalog({ effectiveNames: ['compact'], compact: 'available' }),
    delivered,
    1,
  ), { kind: 'compact' })
  assert.deepEqual(routeLeadingCommand(
    { line: '/compact why', name: 'compact', rawInput: ' why' },
    catalog({ effectiveNames: ['compact'], compact: 'available' }),
    delivered,
    1,
  ), { kind: 'error', code: 'LOCAL_ACP_COMMAND_INVALID_INPUT', message: '/compact accepts no arguments' })
  assert.deepEqual(routeLeadingCommand(
    { line: '/compact', name: 'compact', rawInput: '' },
    catalog({ effectiveNames: ['compact'], compact: 'unavailable' }),
    delivered,
    1,
  ), { kind: 'error', code: 'LOCAL_ACP_COMMAND_UNAVAILABLE', message: 'the approved /compact Host service is unavailable' })
  assert.deepEqual(routeLeadingCommand(
    { line: '/plan hi', name: 'plan', rawInput: ' hi' },
    catalog({ effectiveNames: ['plan'] }),
    delivered,
    1,
  ), { kind: 'error', code: 'LOCAL_ACP_COMMAND_UNSUPPORTED', message: 'this Host command is not supported by the ACP command contract' })
  assert.deepEqual(routeLeadingCommand(
    { line: '/deploy', name: 'deploy', rawInput: '' },
    catalog({ effectiveNames: ['deploy'] }),
    delivered,
    1,
  ), { kind: 'error', code: 'LOCAL_ACP_COMMAND_UNSUPPORTED', message: 'this Host command is not supported by the ACP command contract' })
  assert.deepEqual(routeLeadingCommand(
    { line: '/deploy', name: 'deploy', rawInput: '' },
    catalog(),
    delivered,
    1,
  ), { kind: 'skill', name: 'deploy' })
  assert.deepEqual(routeLeadingCommand(
    { line: '/unknown', name: 'unknown', rawInput: '' },
    catalog(),
    delivered,
    1,
  ), { kind: 'prose' })
  assert.deepEqual(routeLeadingCommand(
    { line: '/feedback hi', name: 'feedback', rawInput: ' hi' },
    catalog({ effectiveNames: ['feedback'], feedback: 'available' }),
    delivered,
    2,
  ), { kind: 'error', code: 'LOCAL_ACP_COMMAND_INVALID_INPUT', message: 'an approved command accepts exactly one text block' })
})

test('the catalog is a complete name-sorted wire replacement and dedups only visible fields', () => {
  const update = catalogUpdate([
    { kind: 'skill', name: 'deploy', description: 'Deploy.' },
    { kind: 'command', name: 'feedback', description: 'Feedback.', inputHint: 'Details' },
    { kind: 'command', name: 'compact', description: 'Compact.' },
  ])
  assert.deepEqual(update, {
    sessionUpdate: 'available_commands_update',
    availableCommands: [
      { name: 'compact', description: 'Compact.' },
      { name: 'deploy', description: 'Deploy.', input: { hint: 'Optional instructions' } },
      { name: 'feedback', description: 'Feedback.', input: { hint: 'Details' } },
    ],
  })
  const rows = [
    { kind: 'command' as const, name: 'compact', description: 'Compact.' },
    { kind: 'skill' as const, name: 'deploy', description: 'Deploy.' },
  ]
  assert.equal(sameCatalogRows(rows, [...rows]), true)
  assert.equal(sameCatalogRows(rows, [{ ...rows[0] }, { ...rows[1], description: 'Changed.' }]), false)
  assert.equal(sameCatalogRows(rows, [rows[0]]), false)
})

test('the original standalone settlement distinguishes success, business error and unknown', () => {
  assert.deepEqual(classifyStandaloneOutcome({ kind: 'resolved', value: { result: { kind: 'success', text: 'ok' } } }),
    { kind: 'success', text: 'ok' })
  assert.deepEqual(classifyStandaloneOutcome({ kind: 'resolved', value: { result: { kind: 'error', text: 'bad args' } } }),
    { kind: 'failure', code: 'LOCAL_ACP_COMMAND_FAILED', message: 'bad args', text: 'bad args' })
  assert.deepEqual(classifyStandaloneOutcome({ kind: 'resolved', value: undefined }),
    { kind: 'failure', code: 'LOCAL_ACP_COMMAND_UNAVAILABLE', message: 'the command is no longer present on the exact live Agent' })
  assert.deepEqual(classifyStandaloneOutcome({ kind: 'rejected', error: new Error('x') }),
    { kind: 'failure', code: 'LOCAL_ACP_COMMAND_INDETERMINATE', message: 'the command outcome could not be confirmed; it was not retried' })
})

test('compact success requires the exact operation identity, and partial facts are indeterminate', () => {
  const result = { compactionId: 'c1', startSeq: 3, summarySeq: 4, endSeq: 6, shadowedSeqs: [1, 2], shadowedTokenCount: 12 }
  assert.deepEqual(classifyCompactOutcome({ kind: 'resolved', value: result },
    facts({ compactionId: 'c1', startSeq: 3, summarySeq: 4, endSeq: 6 }), false), {
    kind: 'success', text: 'Compacted 2 history items (~12 tokens).',
  })
  assert.equal(classifyCompactOutcome({ kind: 'resolved', value: null }, facts(), false).kind, 'no-op')
  assert.equal(classifyCompactOutcome({ kind: 'resolved', value: { ...result, summarySeq: 99 } },
    facts({ compactionId: 'c1', startSeq: 3, summarySeq: 4, endSeq: 6 }), false).kind, 'failure')
  assert.equal(classifyCompactOutcome({ kind: 'resolved', value: result },
    facts({ compactionId: 'c1', startSeq: 3, summarySeq: 4 }), false).kind, 'failure')
  assert.equal(classifyCompactOutcome({ kind: 'resolved', value: null }, facts({ startSeq: 3 }), false).kind, 'failure')
})

test('compact cancellation wins only before the summary; committed results never become cancelled', () => {
  const cancelReason = Object.freeze({ acp: true })
  const aborted = new AbortController()
  aborted.abort(cancelReason)
  assert.equal(aborted.signal.reason === cancelReason, true)
  // A precommit start + matching FAILED end + no summary/checkpoint is the
  // client's one truthful cancelled class.
  assert.deepEqual(classifyCompactOutcome({ kind: 'rejected', error: new Error('aborted') },
    facts({ compactionId: 'c1', startSeq: 3, endSeq: 5, endError: 'cancelled' }), true), { kind: 'cancelled' })
  // A post-dispatch abort without the exact own transaction proof is
  // INDETERMINATE, never a fabricated cancellation.
  assert.equal(classifyCompactOutcome({ kind: 'rejected', error: new Error('aborted') },
    facts(), true).kind, 'failure')
  assert.equal(classifyCompactOutcome({ kind: 'rejected', error: new Error('aborted') },
    facts({ compactionId: 'c1', startSeq: 3 }), true).kind, 'failure')
  assert.equal(classifyCompactOutcome({ kind: 'rejected', error: new Error('aborted') },
    facts({ compactionId: 'c1', startSeq: 3, endSeq: 5 }), true).kind, 'failure')
  assert.equal(classifyCompactOutcome({ kind: 'rejected', error: new Error('aborted') },
    facts({ compactionId: 'c1', startSeq: 3, endSeq: 5, endError: 'cancelled', checkpointSeen: true }), true).kind, 'failure')
  // A summary already committed: the abort race cannot rewrite it as cancelled.
  const committed = classifyCompactOutcome({ kind: 'rejected', error: { name: 'ManualCompactionError', code: 'cancelled' } },
    facts({ compactionId: 'c1', startSeq: 3, summarySeq: 4, endSeq: 6 }), true)
  assert.equal(committed.kind, 'failure')
  assert.equal(committed.kind === 'failure' ? committed.code : '', 'LOCAL_ACP_COMMAND_COMMITTED_WITH_ERROR')
  // An independent Host cancellation is a Host failure, never ACP cancelled.
  const independent = classifyCompactOutcome({ kind: 'rejected', error: { name: 'ManualCompactionError', code: 'cancelled' } },
    facts(), false)
  assert.equal(independent.kind === 'failure' ? independent.code : '', 'LOCAL_ACP_COMMAND_FAILED')
  const busy = classifyCompactOutcome({ kind: 'rejected', error: { name: 'ManualCompactionError', code: 'busy' } },
    facts(), true)
  assert.equal(busy.kind === 'failure' ? busy.code : '', 'LOCAL_ACP_COMMAND_BUSY')
  // A summary followed by a failed end is a partial/unknown replacement.
  assert.equal(classifyCompactOutcome({ kind: 'rejected', error: { name: 'ManualCompactionError', code: 'commit' } },
    facts({ compactionId: 'c1', startSeq: 3, summarySeq: 4, endSeq: 5, endError: 'commit failed' }), false).kind,
  'failure')
  const summaryFailed = classifyCompactOutcome({ kind: 'rejected', error: { name: 'ManualCompactionError', code: 'commit' } },
    facts({ compactionId: 'c1', startSeq: 3, summarySeq: 4, endSeq: 5, endError: 'commit failed' }), false)
  assert.equal(summaryFailed.kind === 'failure' ? summaryFailed.code : '', 'LOCAL_ACP_COMMAND_INDETERMINATE')
  // The exact ACP abort reason must be in the original rejection chain.
  const firstReason = new Error('local-acp-compact-cancel')
  const secondReason = new Error('local-acp-compact-cancel')
  const stock = new AbortController()
  stock.abort(firstReason)
  assert.equal(isAcpCompactAbort({ kind: 'rejected', error: firstReason }, stock.signal, firstReason), true)
  assert.equal(isAcpCompactAbort({ kind: 'rejected', error: secondReason }, stock.signal, firstReason), false,
    'a stale/foreign operation reason can never prove THIS cancellation')
  assert.equal(isAcpCompactAbort({ kind: 'rejected', error: firstReason }, stock.signal, secondReason), false)
  assert.equal(isAcpCompactAbort({
    kind: 'rejected',
    error: { name: 'ManualCompactionError', code: 'cancelled', cause: { kind: 'user' } },
  }, stock.signal, firstReason), false, 'an independent Host cancellation never becomes ACP cancelled')
  assert.equal(isAcpCompactAbort({
    kind: 'rejected',
    error: { name: 'ManualCompactionError', code: 'cancelled', cause: new Error('other') },
  }, stock.signal, firstReason), false)
})
