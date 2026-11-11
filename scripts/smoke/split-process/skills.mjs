/**
 * M6-1 F6 (G11 + G12): Host-owned Skills in real Sessionless and Live TUIs.
 *
 * Three real-process cases on the candidate Host:
 *   - `skills.sessionless-hot` (Case B): two independent OS TUI Clients with
 *     no Session read their own Host Workspace skills (one via the launch
 *     directory, one via the real Session Workspace Add/Use directory), and a
 *     Host file edit/add/delete updates only the owning Client's visible slash
 *     completion without `/reload`.
 *   - `skills.live-hot` (Case A): two Clients on the SAME Live Session read the
 *     official `skills.list` catalog and both follow Host add/edit/delete.
 *   - `skills.recovery` (Case C, process half): a SIGKILLed Client is replaced
 *     by a new Client process on the same Host Workspace; the replacement
 *     re-establishes the standing read and keeps following Host changes while
 *     the Host identity is unchanged.
 *
 * The slash completion list is the UI sink: the typed query is always the
 * shared `/f6-` prefix (or a unique skill prefix whose description is the
 * asserted text), and every absence assertion is paired with a positive
 * anchor painted in the SAME frame, so an empty/unpainted frame cannot make a
 * negative pass vacuously.
 *
 * @module split-process/skills
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { alive, lastSurfaceStatus, waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'
import { createDualSurfaceSceneTools } from './dual-surface-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

const HOME = '\x1b[H'
const END = '\x1b[F'
const TAB = '\t'
const BODY_MARKER = 'F6-SKILL-BODY-MUST-NEVER-BE-PAINTED'

/** Host project skill file (the standard `.agents/skills/<name>/SKILL.md`). */
function writeSkill(root, name, description) {
  const dir = join(root, '.agents', 'skills', name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `# ${BODY_MARKER}`,
    '',
  ].join('\n'))
}

function deleteSkill(root, name) {
  rmSync(join(root, '.agents', 'skills', name), { recursive: true, force: true })
}

/** A real project root for the isolated Host watcher. */
function makeProjectRoot(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' })
  return root
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

/** Submit one line from a proven-ready editor seat (marker-then-clear). */
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

/**
 * Poll until the painted frame shows EVERY `visible` needle and NONE of the
 * `absent` needles. The visible anchor makes an unpainted/empty list fail
 * instead of satisfying an absence-only assertion.
 */
async function waitForPaintedSkills(client, query, { visible, absent = [] }, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let frame = ''
  while (Date.now() < deadline) {
    frame = await completionFrame(client, query, label)
    if (visible.every(needle => frame.includes(needle))
      && absent.every(needle => !frame.includes(needle))) return frame
    await sleep(200)
  }
  throw new SplitSmokeAssertionError(
    `${label}: the completion never reached the expected state (visible=${JSON.stringify(visible)}, absent=${JSON.stringify(absent)})\n${frame}`,
  )
}

/** The Sessionless surface record the cases require. */
const sessionless = record => record.transport === 'connected'
  && record.surfaceMounted === true
  && record.sessionOpen === false

/** The Live surface record the cases require. */
const liveOn = sessionId => record => record.transport === 'connected'
  && record.surfaceMounted === true
  && record.sessionOpen === true
  && record.openSessionId === sessionId

/** Case B: two Sessionless Clients on different Host Workspaces. */
export async function runSessionlessSkillsHot(context) {
  const { dshHome, workDir, trace } = context
  const scene = createC1Scene(context)
  const viewportText = async client => (await client.viewport()).join('\n')
  const root = join(workDir, 'f6-skills')
  const w1 = makeProjectRoot(join(root, 'f6-w1'))
  const w2 = makeProjectRoot(join(root, 'f6-w2'))
  const clientLocal = makeProjectRoot(join(root, 'f6-client-local'))
  const alphaDescription = 'F6 ALPHA WORKSPACE W1'
  const updatedDescription = 'F6 ALPHA UPDATED BY THE HOST WATCHER'
  const betaDescription = 'F6 BETA WORKSPACE W2'
  const addedDescription = 'F6 ADDED SKILL FROM THE HOST WATCHER'
  const localDescription = 'F6 ALPHA CLIENT LOCAL MUST NOT SURVIVE THE SWITCH'
  writeSkill(w1, 'f6-alpha', alphaDescription)
  writeSkill(w2, 'f6-beta', betaDescription)
  writeSkill(clientLocal, 'f6-alpha', localDescription)
  const sessionsBefore = durableSessionLogs(dshHome)

  try {
    const { host, ready } = await scene.startC1Host('skills-standing', 'F6 skills')
    const hostFacts = await scene.hostIdentityFacts(host)
    assert(ready.sessionOpen === false, 'F6 the Host ready record already owns a Session')
    const { client: clientA } = await scene.startC1Client('F6 skills A', {}, { cwd: w1 })
    const { client: clientB } = await scene.startC1Client('F6 skills B', {}, { cwd: clientLocal })
    await waitForSurfaceStatus(clientA, sessionless, 'F6 A sessionless surface', 120_000)
    await waitForSurfaceStatus(clientB, sessionless, 'F6 B sessionless surface', 120_000)
    assert(lastSurfaceStatus(clientA)?.openSessionId === undefined, 'F6 Client A opened a Session')
    assert(lastSurfaceStatus(clientB)?.openSessionId === undefined, 'F6 Client B opened a Session')

    // ── A: the launch Workspace was Host-confirmed and its skills stand ─────
    const aFrame = await waitForPaintedSkills(clientA, '/f6-alpha', {
      visible: [alphaDescription],
      absent: [betaDescription, localDescription, BODY_MARKER],
    }, 'F6 A standing W1')
    assert(!aFrame.includes(BODY_MARKER), 'F6 the Skill body crossed into the UI')
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
    // The official Workspace follow stream must paint the new folder BEFORE
    // Home selects row 0, or the Use action would adopt a different Workspace.
    {
      const deadline = Date.now() + 60_000
      let frame = await viewportText(clientB)
      while (!frame.includes(basename(w2)) && Date.now() < deadline) {
        await sleep(100)
        frame = await viewportText(clientB)
      }
      assert(frame.includes(basename(w2)),
        `F6 B never painted the newly added Workspace folder:\n${frame}`)
    }
    clientB.send(HOME)
    await sleep(150)
    clientB.send('\r')
    await sleep(150)
    clientB.send(TAB)
    await sleep(150)
    clientB.send('\r')
    await clientB.waitForScreenGone('Workspace: ', 'F6 B Use directory closed the workspace', 60_000)
    await waitForSurfaceStatus(clientB, sessionless, 'F6 B still sessionless after Use directory', 60_000)

    await waitForPaintedSkills(clientB, '/f6-', {
      visible: [betaDescription],
      absent: [alphaDescription, localDescription, updatedDescription, BODY_MARKER],
    }, 'F6 B standing W2 after the switch')
    trace('f6-standing-w2-switch', {
      hostPid: hostFacts.hostPid,
      workspace: basename(w2),
      skill: 'f6-beta',
      oldWorkspaceSkillGone: true,
    })

    // ── A: modify the frontmatter description → hot UI update, no /reload ──
    writeSkill(w1, 'f6-alpha', updatedDescription)
    await waitForPaintedSkills(clientA, '/f6-alpha', {
      visible: [updatedDescription],
      absent: [alphaDescription],
    }, 'F6 A hot description')
    const bAfterUpdate = await completionFrame(clientB, '/f6-', 'F6 B isolation after W1 hot update')
    assert(bAfterUpdate.includes(betaDescription),
      `F6 Client B lost its own Workspace skill after W1's update:\n${bAfterUpdate}`)
    assert(!bAfterUpdate.includes(updatedDescription),
      `F6 Client B received another Workspace's skill update:\n${bAfterUpdate}`)

    // ── A: add a Project Skill → the visible list gains it ─────────────────
    writeSkill(w1, 'f6-added', addedDescription)
    await waitForPaintedSkills(clientA, '/f6-added', { visible: [addedDescription] }, 'F6 A hot addition')

    // ── A: delete the original Project Skill → the list loses it while the
    // other skill stays visible in the SAME painted frame (positive anchor). ─
    deleteSkill(w1, 'f6-alpha')
    await waitForPaintedSkills(clientA, '/f6-', {
      visible: [addedDescription],
      absent: [updatedDescription],
    }, 'F6 A hot deletion')
    const bAfterDelete = await completionFrame(clientB, '/f6-', 'F6 B isolation after W1 deletion')
    assert(bAfterDelete.includes(betaDescription),
      `F6 Client B lost its own Workspace skill after W1's deletion:\n${bAfterDelete}`)
    trace('f6-hot-invalidation', {
      hostPid: hostFacts.hostPid,
      modified: true,
      added: true,
      deleted: true,
      twoClientsIndependent: true,
    })

    // ── B switches W2 → W1 with the SAME preset: the W2 wrapper must not
    // survive the target transition and W1's remaining skill must install. ──
    await submit(clientB, '/sessions', 'F6 B reopen the Session Workspace')
    await clientB.waitForScreen('Workspace: ', 'F6 B Workspace for the switch back', 60_000)
    clientB.send(END)
    await sleep(150)
    clientB.send('\r')
    await sleep(150)
    clientB.send(TAB)
    await sleep(150)
    clientB.send('\r')
    await clientB.waitForScreenGone('Workspace: ', 'F6 B Use directory W1 closed the workspace', 60_000)
    await waitForSurfaceStatus(clientB, sessionless, 'F6 B still sessionless after the W1 switch', 60_000)
    await waitForPaintedSkills(clientB, '/f6-', {
      visible: [addedDescription],
      absent: [betaDescription, updatedDescription],
    }, 'F6 B standing on W1 after the W2 switch')
    trace('f6-workspace-switch-back', {
      hostPid: hostFacts.hostPid,
      from: basename(w2),
      to: basename(w1),
      oldWrapperGone: true,
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

/** Case A: two Clients on ONE Live Session follow Host skill changes. */
export async function runLiveSkillsHot(context) {
  const { workDir, trace } = context
  const tools = createDualSurfaceSceneTools(context)
  // Client A's launch directory is the installed profile (`base.cwd`), which
  // the Host preflight confirms as the Session's Workspace: the Live project
  // skill root is `<profileDir>/.agents/skills`.
  const sessionRoot = context.installation.profileDir
  const liveDescription = 'F6 LIVE INITIAL MARKER'
  const updatedDescription = 'F6 LIVE UPDATED MARKER'
  const keepDescription = 'F6 LIVE ANCHOR MARKER'
  const addedDescription = 'F6 LIVE ADDED MARKER'
  writeSkill(sessionRoot, 'f6-live', liveDescription)
  writeSkill(sessionRoot, 'f6-live-keep', keepDescription)
  try {
    const { host, hostBefore, clientA, clientB, sessionY } =
      await tools.startDualSurfaceScene('skills-live', 'F6 live skills', {}, { openB: false })
    await tools.resumeSession(clientB, sessionY, 'F6 live Client B')
    await waitForSurfaceStatus(clientA, liveOn(sessionY), 'F6 live Client A', 60_000)
    await waitForSurfaceStatus(clientB, liveOn(sessionY), 'F6 live Client B', 60_000)
    assert(lastSurfaceStatus(clientA)?.openSessionId === sessionY, 'F6 live Client A is not on Session Y')
    assert(lastSurfaceStatus(clientB)?.openSessionId === sessionY, 'F6 live Client B is not on Session Y')

    await waitForPaintedSkills(clientA, '/f6-live', { visible: [liveDescription] }, 'F6 live A initial catalog')
    await waitForPaintedSkills(clientB, '/f6-live', { visible: [liveDescription] }, 'F6 live B initial catalog')

    // ── RFL-001 negative: Add directory from a LIVE Session Workspace must
    // NOT switch the catalog to a sessionless standing target. ──────────────
    const addTarget = makeProjectRoot(join(workDir, 'f6-live-add'))
    await submit(clientA, '/sessions', 'F6 live A open the Session Workspace')
    await clientA.waitForScreen('Workspace: ', 'F6 live A Workspace', 60_000)
    clientA.send(TAB)
    await sleep(150)
    clientA.send('\r')
    await clientA.waitForScreen('Add Host directory', 'F6 live A Add directory', 30_000)
    clientA.send(addTarget)
    clientA.send('\r')
    await clientA.waitForScreen('Directory added', 'F6 live A Host directory registered', 60_000)
    clientA.send('\x1b')
    await clientA.waitForScreenGone('Workspace: ', 'F6 live A Workspace closed', 60_000)
    await waitForPaintedSkills(clientA, '/f6-live', {
      visible: [liveDescription],
      absent: [BODY_MARKER],
    }, 'F6 live A catalog after the live Add directory')
    assert(lastSurfaceStatus(clientA)?.openSessionId === sessionY,
      'F6 Add directory replaced the live Session owner')
    trace('f6-live-add-kept-catalog', { session: sessionY, liveCatalogKept: true })

    // A NEW Host skill appears while both Clients stay Live (runtime addition).
    writeSkill(sessionRoot, 'f6-live-added', addedDescription)
    await waitForPaintedSkills(clientA, '/f6-live-added', { visible: [addedDescription] }, 'F6 live A runtime addition')
    await waitForPaintedSkills(clientB, '/f6-live-added', { visible: [addedDescription] }, 'F6 live B runtime addition')

    writeSkill(sessionRoot, 'f6-live', updatedDescription)
    await waitForPaintedSkills(clientA, '/f6-live', {
      visible: [updatedDescription],
      absent: [liveDescription],
    }, 'F6 live A hot description')
    await waitForPaintedSkills(clientB, '/f6-live', {
      visible: [updatedDescription],
      absent: [liveDescription],
    }, 'F6 live B hot description')

    deleteSkill(sessionRoot, 'f6-live')
    await waitForPaintedSkills(clientA, '/f6-live-', {
      visible: [keepDescription],
      absent: [updatedDescription],
    }, 'F6 live A hot deletion')
    await waitForPaintedSkills(clientB, '/f6-live-', {
      visible: [keepDescription],
      absent: [updatedDescription],
    }, 'F6 live B hot deletion')

    assert(lastSurfaceStatus(clientA)?.openSessionId === sessionY
      && lastSurfaceStatus(clientB)?.openSessionId === sessionY,
    'F6 a Live Session was replaced while the catalog was invalidating')
    const hostAfter = await tools.hostIdentityFacts(host)
    assert(hostAfter.hostPid === hostBefore.hostPid, 'F6 the Host identity changed during the Live case')
    trace('f6-live-hot', {
      hostPid: hostBefore.hostPid,
      session: sessionY,
      clients: 2,
      modified: true,
      deleted: true,
      sessionKept: true,
    })
    await tools.scene.dispose()
  } finally {
    await tools.scene.dispose()
  }
}

/** Case C (process half): a replacement Client re-establishes standing observation. */
export async function runSkillsRecovery(context) {
  const { dshHome, workDir, trace } = context
  const scene = createC1Scene(context)
  const root = makeProjectRoot(join(workDir, 'f6-recovery'))
  const description = 'F6 RECOVERY WORKSPACE SKILL'
  const updatedDescription = 'F6 RECOVERY SKILL UPDATED AFTER CLIENT REPLACEMENT'
  writeSkill(root, 'f6-recovery', description)
  const sessionsBefore = durableSessionLogs(dshHome)
  try {
    const { host } = await scene.startC1Host('skills-recovery', 'F6 recovery')
    const hostFacts = await scene.hostIdentityFacts(host)
    const { client: first } = await scene.startC1Client('F6 recovery first', {}, { cwd: root })
    await waitForSurfaceStatus(first, sessionless, 'F6 recovery first client sessionless', 120_000)
    await waitForPaintedSkills(first, '/f6-recovery', { visible: [description] }, 'F6 recovery first client')

    // The first Client is killed (its subscription dies with the process);
    // the Host must stay alive with the same identity.
    first.kill('SIGKILL')
    await sleep(500)
    assert(alive(hostFacts.hostPid), 'F6 the Host died with the SIGKILLed Client')

    const { client: replacement } = await scene.startC1Client('F6 recovery replacement', {}, { cwd: root })
    await waitForSurfaceStatus(replacement, sessionless, 'F6 recovery replacement sessionless', 120_000)
    await waitForPaintedSkills(replacement, '/f6-recovery', { visible: [description] }, 'F6 recovery replacement standing read')

    // The replacement Client re-established observation: a new Host change is
    // still followed without `/reload`.
    writeSkill(root, 'f6-recovery', updatedDescription)
    await waitForPaintedSkills(replacement, '/f6-recovery', {
      visible: [updatedDescription],
      absent: [description],
    }, 'F6 recovery hot update')

    const hostAfter = await scene.hostIdentityFacts(host)
    assert(hostAfter.hostPid === hostFacts.hostPid, 'F6 the Host identity changed across the Client replacement')
    assert(durableSessionLogs(dshHome) === sessionsBefore, 'F6 the recovery journey created a Session')
    trace('f6-recovery', {
      hostPid: hostFacts.hostPid,
      killedClientReplaced: true,
      hotUpdateAfterReplacement: true,
      sessionLogs: sessionsBefore,
    })
  } finally {
    await scene.dispose()
  }
}
