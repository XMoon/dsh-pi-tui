/**
 * M6-1 F7B: stored credential records in real Split Host/Clients.
 *
 * ONE real Host (the installed candidate package plus the qualification
 * fixture row) and TWO real authenticated TUI Clients prove:
 *
 *   1. the bare `/logout` Stored-credentials list shows the OFFICIAL store's
 *      metadata rows (exact key + kind) for the seeded grant, api-key and
 *      foreign-scope orphan records, and never the DeepSeek Account grant;
 *   2. the seeded token / api-key / env sentinels are absent from both TUI
 *      panes and from the Host qualification evidence (the wire only carries
 *      key+kind by construction);
 *   3. Client A clears ONE exact key through the existing confirmation; the
 *      official `credentials/record-updated` event fires and the other records
 *      survive;
 *   4. Client B re-reads the CURRENT Host through the SAME page (never an
 *      optimistic local patch) and sees A's record gone while the api-key and
 *      orphan rows keep their exact kinds;
 *   5. Client B clears the foreign-scope orphan record (an unregistered scope
 *      is still listed and deletable by exact key);
 *   6. `/logout deepseek-account` still opens the Account surface, not a
 *      generic record clear;
 *   7. both private services (`piTuiAuthorization`, `piTuiCredentialRecords`)
 *      are Ready on the SAME Host and every seeded record delete is a real
 *      official-store commit.
 *
 * Evidence scope: the missing-ACK fault and the non-owner/invalid-key
 * negatives are NOT reachable through a real TUI's confirmation flow (a
 * non-present record can never be confirmed, and a real Client always speaks
 * as the Owner). They are proven where their REAL seams exist: the private
 * Host bridge over the official store + real Gateway (`IN_PROCESS` L2) and
 * the real generated Client Remote with a one-shot carrier fault
 * (`REAL_WIRE` L5). This suite is the application-level L6 proof.
 *
 * @module split-process/provider-credential-records-f7b
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { hostStatus, waitForCondition } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

const GRANT_KEY = 'llm-pi-ai/f7b-grant'
const API_KEY_KEY = 'llm-pi-ai/f7b-api-key'
const ORPHAN_KEY = 'other-plugin/f7b-orphan'
const ACCOUNT_KEY = 'deepseek-account-platform/default'

/** The seeded secrets the wire / panes / evidence must never contain. */
const SECRET_SENTINELS = [
  'f7b-grant-token-sentinel-20261112',
  'f7b-api-key-value-sentinel-20261112',
  'f7b-env-value-sentinel-20261112',
  'f7b-orphan-token-sentinel-20261112',
  'f7b-account-token-sentinel-20261112',
]

async function waitForScreenText(client, text, label, timeoutMs = 60_000) {
  try {
    await waitForCondition(async () => (await client.viewport()).join('\n').includes(text), label, timeoutMs)
  } catch (error) {
    const frame = await client.viewport()
    const lines = frame.filter(line => /Stored|record|credential|Account|Clear|read|refresh/iu.test(line))
    throw new SplitSmokeAssertionError(`${label}: ${JSON.stringify({ wanted: text, diagnosticLines: lines.slice(-16) })}`, { cause: error })
  }
}

async function waitForScreenGone(client, text, label, timeoutMs = 60_000) {
  try {
    await waitForCondition(async () => !(await client.viewport()).join('\n').includes(text), label, timeoutMs)
  } catch (error) {
    const frame = await client.viewport()
    throw new SplitSmokeAssertionError(`${label}: ${JSON.stringify({ unwanted: text, frame: frame.slice(-16) })}`, { cause: error })
  }
}

/** Submit one slash command / line from a proven-empty editor seat. */
async function submitLine(client, line, label) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const marker = `f7b-ready-${String(attempt + 1)}`
    client.send(marker)
    try {
      await client.waitForComposerDraft(marker, 8_000)
    } catch {
      client.send('\x15')
      await sleep(300)
      continue
    }
    client.send('\x15')
    for (let poll = 0; poll < 60; poll += 1) {
      const composer = await client.composerText()
      const empty = composer === undefined
        || composer.split('\n').every(text => text.replace(/[│┌┐└┘─]/gu, ' ').replace(/❯/gu, ' ').trim() === '')
      if (empty) {
        client.send(`${line}\r`)
        return
      }
      await sleep(100)
    }
  }
  throw new SplitSmokeAssertionError(`${label}: the editor seat never accepted the submitted line`)
}

/** Leave the Models workspace page and prove the MAIN editor seat is live. */
async function exitModelsPage(client, label) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const probe = `f7b-exit-${String(attempt)}`
    client.send(probe)
    try {
      await client.waitForComposerDraft(probe, 1_500)
      client.send('\x15')
      return
    } catch {
      client.send('\x15')
      client.send('\x1b')
      await sleep(300)
    }
  }
  throw new SplitSmokeAssertionError(`${label}: the main editor never regained the seat`)
}

/** Move the painted list cursor onto the row carrying one exact key. */
async function selectStoredRow(client, key, label) {
  for (let step = 0; step < 12; step += 1) {
    const frame = await client.viewport()
    const selected = frame.find(line => line.trimStart().startsWith('> ') && line.includes(key))
    if (selected !== undefined) return
    client.send('\x1b[B')
    await sleep(150)
  }
  const frame = await client.viewport()
  throw new SplitSmokeAssertionError(`${label}: never selected ${key}: ${JSON.stringify(frame.slice(-16))}`)
}

/** Confirm the painted clear action and wait for the local-clear outcome. */
async function clearSelectedRecord(client, key, label) {
  await selectStoredRow(client, key, label)
  client.send('\r')
  await waitForScreenText(client, 'Clear stored credential', `${label} confirmation page`)
  // The warning text is painted only in the authoritative `ready+configured`
  // state: the confirmation cannot be dispatched before the Host read answers.
  await waitForScreenText(client, 'This clears the local stored credential', `${label} confirmation armed`)
  client.send('\r')
  await waitForScreenText(client, 'local stored credential cleared (not revoked at the issuer', `${label} local clear`)
}

/** Read the Host work-event log (one JSON object per line). */
function readEvents(root) {
  const path = join(root, 'events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

async function waitForEvent(root, predicate, label, timeoutMs = 60_000) {
  let found
  try {
    await waitForCondition(() => {
      found = readEvents(root).find(predicate)
      return found !== undefined
    }, label, timeoutMs)
  } catch (error) {
    const events = readEvents(root).slice(-24)
    throw new SplitSmokeAssertionError(`${label}: ${JSON.stringify(events)}`, { cause: error })
  }
  return found
}

/** One captured evidence corpus: both panes, the Host record stream, the events. */
function evidenceCorpus(root, clients, host) {
  const parts = [readFileSync(join(root, 'events.jsonl'), 'utf8')]
  for (const client of clients) parts.push(client.raw)
  parts.push(host.raw)
  return parts.join('\n')
}

/**
 * One case: `provider-credential-records.f7b`.
 */
export async function runF7BCredentialRecords(context) {
  const { trace } = context
  const scene = createC1Scene(context)
  const root = scene.c1WorkRoot('f7b-credential-records')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  let clientA
  let clientB
  let host

  try {
    const started = await scene.startC1Host('f7b-credential-records', 'F7B credential records Host', {}, root)
    host = started.host
    const seeded = await waitForEvent(root, event => event.kind === 'f7b-records-seeded', 'F7B official record seeds')
    assert(
      seeded.keys.includes(GRANT_KEY) && seeded.keys.includes(API_KEY_KEY)
        && seeded.keys.includes(ORPHAN_KEY) && seeded.keys.includes(ACCOUNT_KEY),
      `F7B: the official store must really contain the four seeded records: ${JSON.stringify(seeded)}`,
    )
    // The SAME Host publishes BOTH private services.
    const hostFacts = await hostStatus(host)
    assert(hostFacts.services?.piTuiAuthorization === true, 'F7B: the F7A authorization service must stay Ready on this Host')
    assert(hostFacts.services?.piTuiCredentialRecords === true, 'F7B: the credential-records service must be Ready on this Host')

    const a = await scene.startC1Client('F7B records Client A')
    const b = await scene.startC1Client('F7B records Client B')
    clientA = a.client
    clientB = b.client

    // ── Both Clients open the bare `/logout` stored-credentials list. ──────
    await submitLine(clientA, '/logout', 'F7B A /logout')
    await waitForScreenText(clientA, 'Stored credentials', 'F7B A stored credentials list')
    await waitForScreenText(clientA, GRANT_KEY, 'F7B A grant row')
    await waitForScreenText(clientA, API_KEY_KEY, 'F7B A api-key row')
    await waitForScreenText(clientA, ORPHAN_KEY, 'F7B A foreign orphan row')
    await waitForScreenText(clientA, 'stored record (api-key)', 'F7B A exact api-key kind')
    await waitForScreenText(clientA, 'stored record (grant)', 'F7B A exact grant kind')
    assert(!(await clientA.viewport()).join('\n').includes(ACCOUNT_KEY),
      'F7B: the DeepSeek Account grant must not appear in the generic records list')
    await submitLine(clientB, '/logout', 'F7B B /logout')
    await waitForScreenText(clientB, 'Stored credentials', 'F7B B stored credentials list')
    await waitForScreenText(clientB, GRANT_KEY, 'F7B B grant row before the delete')
    assert(!(await clientB.viewport()).join('\n').includes(ACCOUNT_KEY),
      'F7B: the DeepSeek Account grant must not appear in Client B either')
    for (const sentinel of SECRET_SENTINELS) {
      assert(!evidenceCorpus(root, [clientA, clientB], host).includes(sentinel),
        `F7B: the seeded secret ${JSON.stringify(sentinel)} must not appear in any pane or evidence record`)
    }
    trace('f7b.listed', { keys: [GRANT_KEY, API_KEY_KEY, ORPHAN_KEY], accountExcluded: true })

    // ── Client A clears ONE exact record. ──────────────────────────────────
    await clearSelectedRecord(clientA, GRANT_KEY, 'F7B A grant clear')
    const updatedGrant = await waitForEvent(root, event => event.kind === 'f7b-record-updated' && event.key === GRANT_KEY,
      'F7B official record-updated event for the deleted grant')
    assert(updatedGrant.key === GRANT_KEY, 'F7B: the commit event names the exact deleted key')
    await waitForScreenGone(clientA, GRANT_KEY, 'F7B A deleted grant row')
    await waitForScreenText(clientA, API_KEY_KEY, 'F7B A preserved api-key row')
    trace('f7b.deleted', { key: GRANT_KEY, hostEvent: true })

    // ── Client B re-reads the CURRENT Host (no optimistic patch). ──────────
    clientB.send('r')
    await waitForScreenGone(clientB, GRANT_KEY, 'F7B B sees the grant gone after its own refresh')
    await waitForScreenText(clientB, API_KEY_KEY, 'F7B B preserved api-key row')
    await waitForScreenText(clientB, ORPHAN_KEY, 'F7B B preserved foreign orphan row')
    await waitForScreenText(clientB, 'stored record (api-key)', 'F7B B preserved exact api-key kind')
    trace('f7b.second-client', { key: GRANT_KEY, observedGone: true })

    // ── Client B clears the foreign-scope orphan (valid other scope). ──────
    await clearSelectedRecord(clientB, ORPHAN_KEY, 'F7B B orphan clear')
    await waitForEvent(root, event => event.kind === 'f7b-record-updated' && event.key === ORPHAN_KEY,
      'F7B official record-updated event for the removed orphan')
    await waitForScreenGone(clientB, ORPHAN_KEY, 'F7B B deleted orphan row')
    await waitForScreenText(clientB, API_KEY_KEY, 'F7B B remaining api-key row after the orphan clear')
    trace('f7b.orphan-deleted', { key: ORPHAN_KEY })

    // ── Account sign-out routing is unchanged (never a generic record clear).─
    await exitModelsPage(clientA, 'F7B A leaves the Models page')
    await submitLine(clientA, '/logout deepseek-account', 'F7B A /logout deepseek-account')
    await waitForScreenText(clientA, 'DeepSeek Account', 'F7B A Account surface')
    assert(!(await clientA.viewport()).join('\n').includes('Clear stored credential'),
      'F7B: /logout deepseek-account must not open the generic record clear')

    // ── /login still reaches the F7A-backed Models list on this SAME Host. ─
    await exitModelsPage(clientA, 'F7B A leaves the Account page')
    await submitLine(clientA, '/login', 'F7B A /login after the record work')
    await waitForScreenText(clientA, 'Models & Credentials', 'F7B A Models list after the record work')
    assert(!evidenceCorpus(root, [clientA, clientB], host).includes('f7b-grant-token-sentinel-20261112'),
      'F7B: no seeded secret may appear after the full flow')

    trace('f7b.account-and-f7a', { accountSurface: true, f7aStillLive: true })
    return { status: 'PASS' }
  } finally {
    await scene.dispose()
  }
}
