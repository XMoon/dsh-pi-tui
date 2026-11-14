/**
 * M6-2A Loader branch: the `cordis.patch.yml` contract that separates the
 * Direct / Host-only graphs from the daemon supervisor.
 *
 * Evidence level: STATIC config contract (L2). It proves the shipped patch
 * declares the daemon Coordinator row and the exact `!!js` disable conditions
 * that keep the short-lived supervisor PID from owning Host business or
 * tripping a required-entry startup failure. It is NOT the packed Loader mount
 * audit (L5) — that runs against a real installed candidate.
 * @module @xmoon76/dsh-pi-tui/m6-2a-loader-branch.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const patch = readFileSync(fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url)), 'utf8')

/** The exact daemon-supervisor disable expression (PoC-proven mechanism). */
const DAEMON_DISABLED = `disabled: !!js "ctx.get('tuiDaemonStartup') !== undefined"`

/** Extract the block of one `- id: <id>` row (until the next top-level row). */
function rowBlock(id: string): string {
  const lines = patch.split('\n')
  const start = lines.findIndex(line => line.trim() === `- id: ${id}`)
  assert.notEqual(start, -1, `row ${id} must exist`)
  let end = start + 1
  while (end < lines.length) {
    const trimmed = lines[end].trim()
    if (trimmed.startsWith('- id:') || trimmed === '- insert:') break
    end += 1
  }
  return lines.slice(start, end).join('\n')
}

test('the daemon Coordinator row injects tuiDaemonStartup and nothing else', () => {
  const block = rowBlock('pi-tui-daemon-launcher')
  assert.match(block, /name: '@xmoon76\/dsh-pi-tui\/daemon-launcher'/u)
  assert.match(block, /inject: \[tuiDaemonStartup\]/u)
})

test('webserver is conditionally disabled under the daemon supervisor', () => {
  const block = rowBlock('webserver')
  // It stays gated on tuiStartup for Direct/Host-only, and is disabled only
  // when the daemon service is published (a required entry left pending would
  // otherwise fail startup).
  assert.match(block, /inject: \[tuiStartup\]/u)
  assert.ok(block.includes(DAEMON_DISABLED), 'webserver carries the daemon disable condition')
})

for (const id of ['pi-tui-visual-tools', 'job-controller', 'workspace', 'file-reference-local', 'deliverable-file-references']) {
  test(`${id} is conditionally disabled under the daemon supervisor`, () => {
    const block = rowBlock(id)
    assert.ok(block.includes(DAEMON_DISABLED), `${id} must not mount in the daemon supervisor`)
  })
}

test('the web-preferences schema row is NOT disabled (it only projects Config)', () => {
  const block = rowBlock('pi-tui-web-preferences')
  assert.ok(!block.includes('disabled:'), 'the schema-only row stays mounted for Profile Config projection')
})

test('the Direct tui-app row still gates on tuiStartup', () => {
  const block = rowBlock('tui-app')
  assert.match(block, /inject: \[tuiStartup,/u)
})

test('the daemon supervisor disables every second-Host-business authority row', () => {
  // These official dsh-base rows are the Session/Storage/Jobs/Gateway/Account/
  // Attachment authorities. Under the daemon backend the CLI is a SHORT-LIVED
  // supervisor; the real Host is the detached local-host.mjs. Leaving any of
  // these enabled would be a SECOND Host business authority in the supervisor.
  for (const id of ['session', 'session-persistence-jsonl', 'session-query-sqlite', 'storage', 'storage-json', 'storage-domain', 'session-projection', 'jobs', 'typert-gateway', 'remote-access', 'deepseek-account', 'credentials', 'authorization']) {
    const block = rowBlock(id)
    assert.ok(block.includes(DAEMON_DISABLED), `${id} must be daemon-disabled so the supervisor owns no second Host authority`)
  }
})
