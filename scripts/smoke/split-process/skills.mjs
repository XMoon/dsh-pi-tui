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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { alive, hostStatus, lastSurfaceStatus, waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'
import { createDualSurfaceSceneTools } from './dual-surface-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

const HOME = '\x1b[H'
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
    // Close the completion list FIRST (a separate Esc batch: an Esc and the
    // next key in one write would read as Alt+key), then delete the draft with
    // backspaces (the proven composer-clearing path; the completion list can
    // swallow Ctrl+U).
    client.send('\x1b')
    await sleep(120)
    client.send('\x7f'.repeat(120))
    await sleep(120)
    if (composerDraftEmpty(await client.composerText())) return
  }
  throw new SplitSmokeAssertionError(`${label}: the composer never cleared`)
}

/** Clear the draft WITHOUT Esc (a Busy Esc aborts the running Turn). */
async function clearComposerBusy(client, label) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    client.send('\x7f'.repeat(160))
    await sleep(120)
    if (composerDraftEmpty(await client.composerText())) return
  }
  throw new SplitSmokeAssertionError(`${label}: the composer never cleared (busy-safe)`)
}

/** Read the real painted completion frame for one typed query. */
async function completionFrame(client, query, label, busy = false) {
  if (busy) await clearComposerBusy(client, label)
  else await clearComposer(client, label)
  client.send(query)
  await sleep(150)
  return (await client.viewport()).join('\n')
}

/**
 * Poll until the painted frame shows EVERY `visible` needle and NONE of the
 * `absent` needles. The visible anchor makes an unpainted/empty list fail
 * instead of satisfying an absence-only assertion.
 */
async function waitForPaintedSkills(client, query, { visible, absent = [] }, label, timeoutMs = 120_000, busy = false) {
  const deadline = Date.now() + timeoutMs
  let frame = ''
  while (Date.now() < deadline) {
    frame = await completionFrame(client, query, label, busy)
    if (visible.every(needle => frame.includes(needle))
      && absent.every(needle => !frame.includes(needle))) return frame
    await sleep(200)
  }
  throw new SplitSmokeAssertionError(
    `${label}: the completion never reached the expected state (visible=${JSON.stringify(visible)}, absent=${JSON.stringify(absent)})\n${frame}`,
  )
}

/** The real painted frame of one Surface Client. */
const viewportText = async client => (await client.viewport()).join('\n')

/** Open the real /sessions Workspace tree (the frozen row header + the root
 *  Add-directory row are the anchors the tree paints when it is ready). */
async function openWorkspaceTree(client, label) {
  await submit(client, '/sessions', `${label} /sessions`)
  await client.waitForScreen('Sessions ·', `${label} Workspace tree`, 120_000)
  await client.waitForScreen('Add directory', `${label} Add directory row`, 60_000)
}

/**
 * Add one Host directory THROUGH the real inline editor: Home selects the root
 * `Add directory` row, Enter opens the `Host directory:` editor prefilled with
 * the Host HOME, the typed name gains the official `> name/` candidate, Tab
 * accepts it and Enter verifies it through the ONE existing Workspace resolve.
 */
async function addHostDirectory(client, name, label) {
  client.send(HOME)
  await sleep(200)
  client.send('\r')
  await client.waitForScreen('Host directory:', `${label} inline Host editor`, 60_000)
  client.send(name)
  await client.waitForScreen(`> ${name}/`, `${label} official Host candidate`, 60_000)
  client.send('\t')
  await client.waitForScreen(`${name}/`, `${label} accepted Host path`, 60_000)
  client.send('\r')
  await client.waitForScreen('Directory added:', `${label} registered directory fact`, 120_000)
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
  const root = join(workDir, 'f6-skills')
  // W1/W2 live under the isolated Host HOME: the Add-directory editor prefills
  // the Host HOME, so the real typed path is `HOME/f6-w1` / `HOME/f6-w2` (never
  // a Client fact). The ordinary Add's official Verify commits the next-create
  // intent, so ADDING a directory IS the sessionless workspace switch.
  const w1 = makeProjectRoot(join(context.installation.home, 'f6-w1'))
  const w2 = makeProjectRoot(join(context.installation.home, 'f6-w2'))
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
  const faultDir = join(root, 'f6-fault')
  mkdirSync(faultDir, { recursive: true, mode: 0o700 })

  try {
    const { host, ready } = await scene.startC1Host('skills-standing', 'F6 skills', {
      C1_SKILLS_FAULT_DIR: faultDir,
    })
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

    // ── Incomplete Host observation: the same-target last-good catalog stays
    // (never a blank replacement), then a complete observation recovers. ───
    const staleDescription = 'F6 ALPHA MUST NOT REPLACE LAST-GOOD WHILE INCOMPLETE'
    const recoveredDescription = 'F6 ALPHA RECOVERED AFTER THE COMPLETE OBSERVATION'
    const readsPath = join(faultDir, 'fault-reads.jsonl')
    const faultReads = () => existsSync(readsPath)
      ? readFileSync(readsPath, 'utf8').split('\n').filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)] } catch { return [] }
      })
      : []
    const phaseCount = phase => faultReads().filter(entry => entry.phase === phase).length
    const waitForFaultPhase = async (phase, after, label) => {
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        if (phaseCount(phase) > after) return
        await sleep(100)
      }
      throw new SplitSmokeAssertionError(`${label}: the Host never reached the ${phase} phase of a Skills read`)
    }
    const endsBeforeIncomplete = phaseCount('end')
    writeFileSync(join(faultDir, 'incomplete'), 'incomplete\n', { mode: 0o600 })
    writeSkill(w1, 'f6-alpha', staleDescription)
    await waitForFaultPhase('end', endsBeforeIncomplete, 'F6 the incomplete observation')
    const incompleteFrame = await completionFrame(clientA, '/f6-alpha', 'F6 A incomplete last-good')
    assert(incompleteFrame.includes(alphaDescription),
      `F6 the incomplete observation replaced the last-good catalog:\n${incompleteFrame}`)
    assert(!incompleteFrame.includes(staleDescription),
      `F6 an incomplete observation installed the new catalog instead of last-good:\n${incompleteFrame}`)
    const endsBeforeRecovery = phaseCount('end')
    rmSync(join(faultDir, 'incomplete'), { force: true })
    writeSkill(w1, 'f6-alpha', recoveredDescription)
    await waitForFaultPhase('end', endsBeforeRecovery, 'F6 the complete observation')
    await waitForPaintedSkills(clientA, '/f6-alpha', {
      visible: [recoveredDescription],
      absent: [staleDescription, alphaDescription],
    }, 'F6 A complete observation recovery')
    trace('f6-incomplete-recovery', { hostPid: hostFacts.hostPid, lastGoodKept: true, recovered: true })

    // ── B: Client-local launch Workspace → real Add/Use of Host W2 ─────────
    await openWorkspaceTree(clientB, 'F6 B Session Workspace')
    // The ordinary Add's official Verify commits the next-create intent: THIS
    // IS the sessionless switch (no separate Use gesture exists in the tree).
    await addHostDirectory(clientB, basename(w2), 'F6 B Add directory')
    clientB.send('\x1b')
    await clientB.waitForScreenGone('Sessions ·', 'F6 B Add directory closed the workspace', 60_000)
    await waitForSurfaceStatus(clientB, sessionless, 'F6 B still sessionless after the W2 switch', 60_000)

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

    // ── B switches W2 → W1 with the SAME preset: the OLD wrapper must be
    // visibly revalidating BEFORE the new Workspace catalog installs, then W1
    // installs and the W2 wrapper disappears. The Host fault provider's
    // qualification-only 1.5s read delay makes the transition frame
    // observable without changing production timing. ────────────────────────
    writeFileSync(join(faultDir, 'slow'), 'slow\n', { mode: 0o600 })
    // Invalidate the official registry's completed-catalog cache with a REAL
    // Host file change, and wait until the resulting discovery is PROVABLY in
    // flight. The same switch then cannot be served from the cache.
    const startsBeforeSwitch = phaseCount('start')
    writeSkill(w1, 'f6-invalidate', 'F6 INVALIDATION MARKER FOR THE SWITCH')
    await waitForFaultPhase('start', startsBeforeSwitch, 'F6 the pre-switch invalidation discovery')
    await openWorkspaceTree(clientB, 'F6 B Workspace for the switch back')
    // W1 is already registered: the editor Verify resolves the SAME official
    // Workspace id and commits the next-create intent back to W1.
    await addHostDirectory(clientB, basename(w1), 'F6 B switch back to W1')
    clientB.send('\x1b')
    await clientB.waitForScreenGone('Sessions ·', 'F6 B switch back closed the workspace', 60_000)
    // CAUSAL BARRIER: the pre-switch discovery is still held; wait for the
    // SECOND discovery (the W1 target-change read) to START, so the frame
    // below is observed strictly while the target-change read is in flight.
    await waitForFaultPhase('start', startsBeforeSwitch + 1, 'F6 the W1 target-change discovery')
    // POSITIVE panel evidence: the transition keeps the GLOBAL completion view
    // (the typed `/` query lists real global commands), and the OLD W2 scoped
    // suggestion/description is NOT part of it.
    const transitionFrame = await completionFrame(clientB, '/', 'F6 B transition frame')
    assert(transitionFrame.includes('attach') && transitionFrame.includes('copy'),
      `F6 the transition frame never painted the global completion rows:\n${transitionFrame}`)
    assert(!transitionFrame.includes('f6-beta') && !transitionFrame.includes(betaDescription),
      `F6 the old W2 scoped suggestion was still advertised during the Workspace transition:\n${transitionFrame}`)
    // Release the held W1 discovery and wait for the new catalog.
    writeFileSync(join(faultDir, 'release-slow'), 'release\n', { mode: 0o600 })
    await waitForFaultPhase('end', phaseCount('end'), 'F6 the released W1 discovery')
    rmSync(join(faultDir, 'release-slow'), { force: true })
    rmSync(join(faultDir, 'slow'), { force: true })
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

    // A visible completion query is still in each editor: clear it so the
    // real `/exit` line is a command, not an appended prompt.
    await clearComposer(clientA, 'F6 Client A before exit')
    await clearComposer(clientB, 'F6 Client B before exit')
    await scene.exitC1Client(clientA, 'F6 Client A')
    await scene.exitC1Client(clientB, 'F6 Client B')
    // Client teardown must release its Host invalidation subscription: the
    // authoritative Host-side count returns to its baseline (no watcher leak).
    {
      const deadline = Date.now() + 60_000
      let watches = Number.NaN
      while (Date.now() < deadline) {
        watches = (await hostStatus(host)).skillInvalidationWatches
        if (watches === 0) break
        await sleep(100)
      }
      assert(watches === 0,
        `F6 the Host kept ${String(watches)} Skills invalidation subscription(s) after both Clients exited`)
    }
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
  const releaseBarrier = join(workDir, 'f6-live-long-turn.release')
  try {
    const { host, hostBefore, clientA, clientB, sessionY } =
      await tools.startDualSurfaceScene('long-turn', 'F6 live skills', { C1_HOLD_LONG_TURN: releaseBarrier }, { openB: false })
    await tools.resumeSession(clientB, sessionY, 'F6 live Client B')
    await waitForSurfaceStatus(clientA, liveOn(sessionY), 'F6 live Client A', 60_000)
    await waitForSurfaceStatus(clientB, liveOn(sessionY), 'F6 live Client B', 60_000)
    assert(lastSurfaceStatus(clientA)?.openSessionId === sessionY, 'F6 live Client A is not on Session Y')
    assert(lastSurfaceStatus(clientB)?.openSessionId === sessionY, 'F6 live Client B is not on Session Y')

    await waitForPaintedSkills(clientA, '/f6-live', { visible: [liveDescription] }, 'F6 live A initial catalog')
    await waitForPaintedSkills(clientB, '/f6-live', { visible: [liveDescription] }, 'F6 live B initial catalog')

    // ── The two remaining Live human sinks: the `/skill` picker and the
    // inline `/name` lexicon both read the SAME installed human catalog. ─────
    await submit(clientA, '/skill', 'F6 live /skill picker')
    await clientA.waitForScreen('f6-live-keep', 'F6 live /skill picker rows', 60_000)
    // The picker's selected-row detail carries the SAME Host description.
    {
      const deadline = Date.now() + 30_000
      let frame = await viewportText(clientA)
      while (!frame.includes(keepDescription) && Date.now() < deadline) {
        clientA.send('\x1b[B')
        await sleep(120)
        frame = await viewportText(clientA)
      }
      assert(frame.includes(keepDescription),
        `F6 the /skill picker never painted the Host description:\n${frame}`)
    }
    clientA.send('\x1b')
    await sleep(200)
    clientA.send('\x1b')
    await sleep(200)
    await clearComposer(clientA, 'F6 live A after the picker')
    // A plain prompt token still gets the inline lexicon suggestion (not a
    // command invocation): the draft is not submitted.
    clientA.send('please /f6-live-keep')
    {
      const deadline = Date.now() + 30_000
      let frame = await viewportText(clientA)
      while (!frame.includes(keepDescription) && Date.now() < deadline) {
        await sleep(200)
        frame = await viewportText(clientA)
      }
      assert(frame.includes(keepDescription),
        `F6 the inline skill lexicon never suggested the live skill:\n${frame}`)
    }
    await clearComposer(clientA, 'F6 live A after the inline lexicon')
    trace('f6-live-human-sinks', { session: sessionY, picker: true, inlineLexicon: true })

    // ── RFL-001 negative: Add directory from a LIVE Session Workspace must
    // NOT switch the catalog to a sessionless standing target. ──────────────
    // The Add target lives under the isolated Host HOME: the inline editor
    // prefills the Host HOME, so the typed path is the real `HOME/f6-live-add`.
    const addTarget = makeProjectRoot(join(context.installation.home, 'f6-live-add'))
    await openWorkspaceTree(clientA, 'F6 live A Workspace')
    await addHostDirectory(clientA, basename(addTarget), 'F6 live A Add directory')
    clientA.send('\x1b')
    await clientA.waitForScreenGone('Sessions ·', 'F6 live A Workspace closed', 60_000)
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

    // ── A running Turn is NOT cancelled or rewritten by the invalidation. ──
    await submit(clientA, 'hold the turn while the catalog changes', 'F6 live held turn')
    await clientA.waitForScreen('long-turn started', 'F6 live held turn start', 120_000)
    await clientB.waitForScreen('long-turn started', 'F6 live B sees the held turn', 120_000)
    const runningDescription = 'F6 LIVE ANCHOR UPDATED WHILE THE TURN RUNS'
    writeSkill(sessionRoot, 'f6-live-keep', runningDescription)
    // Busy-safe queries only: an Esc while the Turn runs would abort it.
    await waitForPaintedSkills(clientA, '/f6-live-keep', {
      visible: [runningDescription],
      absent: [keepDescription],
    }, 'F6 live A hot update during the running Turn', 120_000, true)
    await waitForPaintedSkills(clientB, '/f6-live-keep', {
      visible: [runningDescription],
      absent: [keepDescription],
    }, 'F6 live B hot update during the running Turn', 120_000, true)
    assert((await viewportText(clientA)).includes('long-turn started'),
      'F6 the running Turn disappeared from A during the catalog invalidation')
    assert((await viewportText(clientB)).includes('long-turn started'),
      'F6 the running Turn disappeared from B during the catalog invalidation')
    writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
    await clientA.waitForScreen('long-turn answer', 'F6 the held Turn settled normally', 120_000)
    rmSync(releaseBarrier, { force: true })

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

    // ── Same-Client transport disconnect/reconnect: the qualification input
    // drops the REAL physical mux socket; the official Connection clears the
    // generation and replaces it. The re-armed private stream must refresh the
    // current Sessionless target on the NEW generation (no /reload). ─────────
    const beforeDrop = lastSurfaceStatus(first)
    assert(typeof beforeDrop?.generationId === 'number', 'F6 recovery never observed an official generation')
    const dropBoundary = first.records.length
    first.signalBusiness('SIGUSR1')
    await first.waitFor(
      record => first.records.indexOf(record) >= dropBoundary
        && record.m4b2s === 'surface-status'
        && record.transport !== 'connected'
        && record.generationId === undefined,
      'F6 recovery lost the official generation',
      60_000,
    )
    await first.waitFor(
      record => first.records.indexOf(record) >= dropBoundary
        && record.m4b2s === 'surface-status'
        && record.transport === 'connected'
        && typeof record.generationId === 'number'
        && record.generationId !== beforeDrop.generationId
        && record.sessionOpen === false
        && record.surfaceMounted === true,
      'F6 recovery reconnected on a new generation (Sessionless)',
      120_000,
    )
    await waitForPaintedSkills(first, '/f6-recovery', { visible: [description] },
      'F6 recovery standing after reconnect')
    const afterReconnectDescription = 'F6 RECOVERY SKILL UPDATED AFTER RECONNECT'
    writeSkill(root, 'f6-recovery', afterReconnectDescription)
    await waitForPaintedSkills(first, '/f6-recovery', {
      visible: [afterReconnectDescription],
      absent: [description],
    }, 'F6 recovery hot update after reconnect')
    trace('f6-recovery-reconnect', { hostPid: hostFacts.hostPid, newGeneration: true, hotUpdate: true })

    // ── Process replacement (the crash path): the first Client is killed; its
    // subscription dies with the process and the Host must stay alive with the
    // same identity. A surface Client's signal goes to the BUSINESS PID the
    // ready record published.
    const firstStatus = lastSurfaceStatus(first)
    assert(Number.isInteger(firstStatus?.pid), 'F6 the first Client published no business PID')
    process.kill(firstStatus.pid, 'SIGKILL')
    const firstExit = await first.waitForExit(60_000)
    // The `script(1)` wrapper reports an exec-style status for a SIGKILLed
    // child; either witness proves the first Client process terminated.
    assert(firstExit.signal === 'SIGKILL' || firstExit.code === 137,
      `F6 the first Client was not SIGKILLed: ${JSON.stringify(firstExit)}`)
    assert(alive(hostFacts.hostPid), 'F6 the Host died with the SIGKILLed Client')

    const { client: replacement } = await scene.startC1Client('F6 recovery replacement', {}, { cwd: root })
    await waitForSurfaceStatus(replacement, sessionless, 'F6 recovery replacement sessionless', 120_000)
    await waitForPaintedSkills(replacement, '/f6-recovery', { visible: [afterReconnectDescription] },
      'F6 recovery replacement standing read')

    // The replacement Client re-established observation: a new Host change is
    // still followed without `/reload`.
    writeSkill(root, 'f6-recovery', updatedDescription)
    await waitForPaintedSkills(replacement, '/f6-recovery', {
      visible: [updatedDescription],
      absent: [afterReconnectDescription],
    }, 'F6 recovery hot update after replacement')

    const replacementStatus = lastSurfaceStatus(replacement)
    assert(Number.isInteger(replacementStatus?.pid), 'F6 the replacement Client published no business PID')
    process.kill(replacementStatus.pid, 'SIGKILL')
    await replacement.waitForExit(60_000)
    {
      const deadline = Date.now() + 60_000
      let watches = Number.NaN
      while (Date.now() < deadline) {
        watches = (await hostStatus(host)).skillInvalidationWatches
        if (watches === 0) break
        await sleep(100)
      }
      assert(watches === 0,
        `F6 the Host kept ${String(watches)} Skills invalidation subscription(s) after the replacement Client died`)
    }
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
