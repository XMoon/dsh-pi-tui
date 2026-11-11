/**
 * M6-1 F6: Host-owned standing Skills with automatic hot invalidation on TWO
 * real Sessionless TUIs.
 *
 * ONE real candidate Host + two genuine PiTUI Surface Clients on independent
 * PTYs, with NO Agent/Session/Turn anywhere in the case:
 *   - Client A launches in Host workspace W1 (`f6-alpha`);
 *   - Client B launches in a Client-local directory with a same-named
 *     `f6-alpha`, then switches to Host workspace W2 (`f6-beta`) through the
 *     REAL Session Workspace `Add directory` + `Use directory` entries;
 *   - the slash completion list is the UI sink: A shows only W1's skills, B
 *     only W2's after the switch, and the same-named Client-local skill never
 *     survives the Workspace transition;
 *   - editing W1's SKILL.md description, adding a skill and deleting the
 *     original must update A's visible list without `/reload` or a restart;
 *   - the Host stays Sessionless (no durable Session log appears) and B never
 *     sees W1's skill.
 *
 * The discriminator: with the private standing read or the private
 * invalidation stream removed, the completion list cannot show Host skills at
 * all (standing) or cannot change after the file edit (hot), so this case
 * fails loudly instead of passing on a cached/Client-local list.
 *
 * @module split-process/skills
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { lastSurfaceStatus, waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

const HOME = '\x1b[H'
const TAB = '\t'

/** Host project skill file (the standard `.agents/skills/<name>/SKILL.md`). */
function writeSkill(root, name, description, body) {
  const dir = join(root, '.agents', 'skills', name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    body,
    '',
  ].join('\n'))
}

/** Recursive count of durable Host Session logs (the zero-Session witness). */
function durableSessionLogs(dshHome) {
  const root = join(dshHome, 'sessions')
  if (!existsSync(root)) return 0
  let count = 0
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.jsonl.zstd')) count += 1
  }
  return count
}

/** Whether the composer region carries no document text (the editor is empty). */
const composerDraftEmpty = composer => composer !== undefined
  && composer.split('\n').every(line => line
    .replace(/[│┌┐└┘─]/gu, ' ')
    .replace(/❯/gu, ' ')
    .trim() === '')

/**
 * Submit one line from a proven-ready editor seat. A keystroke the transition
 * or a closing completion list drops is lost for good, so a harmless marker is
 * observed first and the real line then travels with its Enter in ONE write.
 */
async function submit(client, text, label) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const marker = `f6-ready-${String(attempt + 1)}`
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
      if (composerDraftEmpty(await client.composerText())) {
        client.send(`${text}\r`)
        return
      }
      await sleep(100)
    }
  }
  throw new SplitSmokeAssertionError(`${label}: the editor seat never accepted the submitted line`)
}

/** Clear the current completion/draft so the next query starts from empty. */
async function clearComposer(client, label) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    client.send('\x1b')
    client.send('\x15')
    if (composerDraftEmpty(await client.composerText())) return
    await sleep(100)
  }
  throw new SplitSmokeAssertionError(`${label}: the composer never cleared`)
}

/** Read the real painted completion frame for one typed query. */
async function completionFrame(client, query, label) {
  await clearComposer(client, label)
  client.send(query)
  await sleep(150)
  return (await client.viewport()).join('\n')
}

/** Poll the painted completion frame until `needle` appears. */
async function waitForCompletion(client, query, needle, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let frame = ''
  while (Date.now() < deadline) {
    frame = await completionFrame(client, query, label)
    if (frame.includes(needle)) return frame
    await sleep(200)
  }
  throw new SplitSmokeAssertionError(`${label}: the completion never painted ${JSON.stringify(needle)}\n${frame}`)
}

/** Poll the painted completion frame until `needle` is GONE (bounded witness). */
async function waitForCompletionGone(client, query, needle, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let frame = ''
  while (Date.now() < deadline) {
    frame = await completionFrame(client, query, label)
    if (!frame.includes(needle)) return frame
    await sleep(200)
  }
  throw new SplitSmokeAssertionError(`${label}: the completion still paints ${JSON.stringify(needle)}\n${frame}`)
}

/** Run the F6 Sessionless standing + hot-invalidation qualification. */
export async function runSessionlessSkillsHot(context) {
  const { dshHome, workDir, trace } = context
  const scene = createC1Scene(context)
  const root = join(workDir, 'f6-skills')
  const w1 = join(root, 'f6-w1')
  const w2 = join(root, 'f6-w2')
  const clientLocal = join(root, 'f6-client-local')
  const alphaDescription = 'F6 ALPHA WORKSPACE W1'
  const updatedDescription = 'F6 ALPHA UPDATED BY THE HOST WATCHER'
  const betaDescription = 'F6 BETA WORKSPACE W2'
  const addedDescription = 'F6 ADDED SKILL FROM THE HOST WATCHER'
  const localDescription = 'F6 ALPHA CLIENT LOCAL MUST NEVER SURVIVE THE SWITCH'
  const bodyMarker = 'F6-SKILL-BODY-MUST-NEVER-BE-PAINTED'
  writeSkill(w1, 'f6-alpha', alphaDescription, `# ${bodyMarker}`)
  writeSkill(w2, 'f6-beta', betaDescription, `# ${bodyMarker}`)
  writeSkill(clientLocal, 'f6-alpha', localDescription, `# ${bodyMarker}`)
  const sessionsBefore = durableSessionLogs(dshHome)

  try {
    const { host, ready } = await scene.startC1Host('skills-standing', 'F6 skills')
    const hostFacts = await scene.hostIdentityFacts(host)
    assert(ready.sessionOpen === false, 'F6 the Host ready record already owns a Session')
    const { client: clientA } = await scene.startC1Client('F6 skills A', {}, { cwd: w1 })
    const { client: clientB } = await scene.startC1Client('F6 skills B', {}, { cwd: clientLocal })
    const sessionless = record => record.transport === 'connected'
      && record.surfaceMounted === true
      && record.sessionOpen === false
    await waitForSurfaceStatus(clientA, sessionless, 'F6 A sessionless surface', 120_000)
    await waitForSurfaceStatus(clientB, sessionless, 'F6 B sessionless surface', 120_000)
    assert(lastSurfaceStatus(clientA)?.openSessionId === undefined, 'F6 Client A opened a Session')
    assert(lastSurfaceStatus(clientB)?.openSessionId === undefined, 'F6 Client B opened a Session')

    // ── A: the launch Workspace was Host-confirmed and its skills stand ─────
    const aFrame = await waitForCompletion(clientA, '/f6-alpha', alphaDescription, 'F6 A standing W1')
    assert(!aFrame.includes(betaDescription),
      `F6 Client A painted Workspace W2's skill while its Workspace is W1:\n${aFrame}`)
    assert(!aFrame.includes(bodyMarker), `F6 the Skill body crossed into the UI:\n${aFrame}`)
    trace('f6-standing-w1', {
      hostPid: hostFacts.hostPid,
      workspace: basename(w1),
      skill: 'f6-alpha',
      painted: true,
    })

    // ── B: Client-local launch Workspace → real Add/Use of Host W2 ─────────
    await submit(clientB, '/sessions', 'F6 B open the Session Workspace')
    await clientB.waitForScreen('Workspace: ', 'F6 B Session Workspace', 60_000)
    clientB.send(TAB)
    await sleep(150)
    clientB.send('\r')
    await clientB.waitForScreen('Add Host directory', 'F6 B Add directory entry', 30_000)
    clientB.send(w2)
    clientB.send('\r')
    await clientB.waitForScreen('Directory added', 'F6 B Host directory registered', 60_000)
    clientB.send(HOME)
    await sleep(150)
    clientB.send('\r')
    await sleep(150)
    clientB.send(TAB)
    await sleep(150)
    clientB.send('\r')
    await clientB.waitForScreenGone('Workspace: ', 'F6 B Use directory closed the workspace', 60_000)
    await waitForSurfaceStatus(clientB, sessionless, 'F6 B still sessionless after Use directory', 60_000)

    const bFrame = await waitForCompletion(clientB, '/f6-beta', betaDescription, 'F6 B standing W2')
    assert(!bFrame.includes(alphaDescription), `F6 Client B still paints W1's skill after switching to W2:\n${bFrame}`)
    assert(!bFrame.includes(localDescription),
      `F6 Client B still paints the previous launch Workspace skill after the switch:\n${bFrame}`)
    assert(!bFrame.includes(updatedDescription), `F6 Client B painted another Workspace's hot update:\n${bFrame}`)
    trace('f6-standing-w2-switch', {
      hostPid: hostFacts.hostPid,
      workspace: basename(w2),
      skill: 'f6-beta',
      oldWorkspaceSkillGone: true,
    })

    // ── A: modify the frontmatter description → hot UI update, no /reload ──
    writeSkill(w1, 'f6-alpha', updatedDescription, `# ${bodyMarker}`)
    const updatedFrame = await waitForCompletion(clientA, '/f6-alpha', updatedDescription, 'F6 A hot description')
    assert(!updatedFrame.includes(alphaDescription),
      `F6 Client A painted the stale description after the Host watcher fired:\n${updatedFrame}`)
    const bAfterUpdate = await completionFrame(clientB, '/f6-beta', 'F6 B isolation after W1 hot update')
    assert(!bAfterUpdate.includes(updatedDescription),
      `F6 Client B received another Workspace's skill update:\n${bAfterUpdate}`)

    // ── A: add a Project Skill → the visible list gains it ─────────────────
    writeSkill(w1, 'f6-added', addedDescription, `# ${bodyMarker}`)
    await waitForCompletion(clientA, '/f6-added', addedDescription, 'F6 A hot addition')

    // ── A: delete the original Project Skill → the visible list loses it ───
    rmSync(join(w1, '.agents', 'skills', 'f6-alpha'), { recursive: true, force: true })
    await waitForCompletionGone(clientA, '/f6-alpha', updatedDescription, 'F6 A hot deletion')
    const bAfterDelete = await completionFrame(clientB, '/f6-beta', 'F6 B isolation after W1 deletion')
    assert(bAfterDelete.includes(betaDescription),
      `F6 Client B lost its own Workspace skill after W1's deletion:\n${bAfterDelete}`)
    trace('f6-hot-invalidation', {
      hostPid: hostFacts.hostPid,
      modified: true,
      added: true,
      deleted: true,
      twoClientsIndependent: true,
    })

    // ── Zero Session/Agent/Turn across the whole journey ───────────────────
    assert(lastSurfaceStatus(clientA)?.sessionOpen === false, 'F6 Client A created a Session')
    assert(lastSurfaceStatus(clientB)?.sessionOpen === false, 'F6 Client B created a Session')
    assert(durableSessionLogs(dshHome) === sessionsBefore,
      `F6 the Sessionless journey materialized a durable Session log (${String(durableSessionLogs(dshHome))} > ${String(sessionsBefore)})`)

    await scene.exitC1Client(clientA, 'F6 Client A')
    await scene.exitC1Client(clientB, 'F6 Client B')
    const hostAfter = await scene.hostIdentityFacts(host)
    assert(hostAfter.hostPid === hostFacts.hostPid, 'F6 a Client exit replaced the Host')
    trace('f6-sessionless-close', { hostPid: hostFacts.hostPid, sessionLogs: sessionsBefore })
  } finally {
    await scene.dispose()
  }
}
