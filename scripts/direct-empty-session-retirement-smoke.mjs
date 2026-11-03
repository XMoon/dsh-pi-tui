#!/usr/bin/env node
/**
 * Direct empty-session retirement smoke: prove, against a REAL isolated
 * `dsh --profile pi-tui` install (official dsh + dsh-base + the candidate
 * tarball only), that session transitions and exits never flush an already
 * closing JSONL handle and that a freshly committed empty `/new` session is
 * really durable.
 *
 * Scenarios (all model-free, event-driven):
 *   A. start → /new → /exit          : no closed-handle retirement error; the
 *      empty session is resumable through the official reader (`--session`).
 *   B. resume → /exit                : the resumed session exits clean again.
 *   C. start → /new → /new → /exit   : the first /new's old-owner transition
 *      flush still runs; no writer error on either retirement.
 *   D. start → /exit (no session)    : nothing created, nothing flushed.
 *
 * Usage: node scripts/direct-empty-session-retirement-smoke.mjs <candidate.tgz>
 *        pnpm smoke:direct-empty-retirement -- <candidate.tgz>
 *
 * The tarball argument is REQUIRED: falling back to the published package
 * would test the wrong artifact. Set DSH_EMPTY_RETIREMENT_KEEP=1 to preserve
 * the isolated environment for debugging.
 * @module direct-empty-session-retirement-smoke
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  candidateArgument,
  dshInvocation,
  installPlugin,
  isolatedEnvironment,
  requireExactVersion,
  resolveTarball,
  run,
  runDsh,
  runPnpmInstall,
  validateCandidateTarball,
} from './pi2dsh-compat-smoke.mjs'
import { loadDshDistribution, npmDshVersion } from './lib/dsh-distribution.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..')
const BOOT_TIMEOUT_MS = 120_000
const STEP_TIMEOUT_MS = 60_000
/** The negative diagnostics the retirement must never produce. */
const FORBIDDEN_DIAGNOSTICS = [
  'retire phase failed',
  'SessionHandleClosedError',
  'flush on a closed handle',
  'UnhandledPromiseRejection',
]

function fail(phase, message) {
  throw Object.assign(new Error(message), { phase })
}

function commandOutput(result) {
  return [result.stdout, result.stderr, result.error?.message]
    .filter(value => typeof value === 'string' && value.length > 0)
    .join('\n')
    .trim()
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readOptionalJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

async function waitUntil(label, timeoutMs, probe, phase) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await probe()
    if (last) return last
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  }
  fail(phase, `${label} timed out after ${timeoutMs}ms (last: ${String(last).slice(0, 400)})`)
}

function dirname(path) {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

/** All pi-tui diagnostic logs under the isolated $DSH_HOME/logs. */
function piTuiLogs(dshHome) {
  const logsDir = join(dshHome, 'logs')
  if (!existsSync(logsDir)) return []
  return readdirSync(logsDir)
    .filter(name => name.startsWith('pi-tui-') && name.endsWith('.log'))
    .map(name => ({ name, text: readFileSync(join(logsDir, name), 'utf8') }))
}

/** The machine-checkable facts the smoke must record up front. */
function environmentFacts(tarball, harnessDir, env, targetDshVersion) {
  const family = {}
  const packagesDir = join(harnessDir, 'node_modules', '@deepseek-ai')
  if (existsSync(packagesDir)) {
    for (const name of readdirSync(packagesDir)) {
      const manifest = readOptionalJson(join(packagesDir, name, 'package.json'))
      if (manifest?.version !== undefined) family[name] = manifest.version
    }
  }
  return {
    uname: commandOutput(run('uname', ['-a'], { env })),
    node: process.version,
    dsh: targetDshVersion,
    installedFamily: family,
    candidateTarball: basename(tarball),
    candidateSha256: sha256(tarball),
  }
}

/** The exactly-two expected profile bundles (plan §5): the official base layer
 * plus the candidate. Anything else means this is not the isolated profile the
 * smoke claims to test. */
const EXPECTED_BUNDLES = ['@deepseek-ai/dsh-base', '@xmoon76/dsh-pi-tui']

/**
 * Verify the profile composition the smoke tests (plan §5's machine-checkable
 * preconditions) and return it as recorded evidence:
 *   - `dsh.profile.bundles` is EXACTLY [dsh-base, candidate];
 *   - the USER patch layer (`profiles/<name>/cordis.patch.yml`) carries no
 *     user patch: its only entry is the candidate's own shipped `tui-app`
 *     row (no other id, no insert/disable/override);
 *   - the installed candidate's own bundle patch is byte-identical to the
 *     tarball's, so the package layer is the SHIPPED one;
 *   - the invocation passes no `--patch` overlay.
 * Everything is asserted here, not merely printed: a wrong composition would
 * otherwise produce a smoke PASS against the wrong profile.
 */
function assertProfileComposition({ profileDir, tarball, invocation, env }) {
  const profilePackage = readOptionalJson(join(profileDir, 'package.json'))
  const bundles = profilePackage?.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || bundles.length !== EXPECTED_BUNDLES.length
    || EXPECTED_BUNDLES.some(name => !bundles.includes(name))) {
    fail('INFRA_INSTALL_FAILURE', `profile bundles must be exactly ${JSON.stringify(EXPECTED_BUNDLES)}, got ${JSON.stringify(bundles)}`)
  }

  // The user patch layer: a POSITIVE allowlist, never an enumeration of the
  // patch operations we happen to remember. The only acceptable layer is the
  // empty list or the candidate's own shipped `tui-app` config row, so every
  // other row form (insert / disabled / override / name / group / intercept /
  // isolate) and any unknown row key fails.
  const userPatchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(userPatchPath)) {
    fail('INFRA_INSTALL_FAILURE', `profile user patch layer is missing: ${userPatchPath}`)
  }
  const violations = userPatchViolations(readFileSync(userPatchPath, 'utf8'))
  if (violations.length > 0) {
    fail('INFRA_INSTALL_FAILURE', `the profile user patch layer carries a user patch (${JSON.stringify(violations)})`)
  }

  // The package layer: the installed bundle patch must be the SHIPPED one.
  const installedPatchPath = join(profileDir, 'node_modules', '@xmoon76', 'dsh-pi-tui', 'cordis.patch.yml')
  if (!existsSync(installedPatchPath)) {
    fail('INFRA_INSTALL_FAILURE', `installed candidate bundle patch is missing: ${installedPatchPath}`)
  }
  const packed = run('tar', ['-xOf', tarball, 'package/cordis.patch.yml'], { env, timeout: 60_000 })
  if (packed.status !== 0) {
    fail('INFRA_INSTALL_FAILURE', `the candidate tarball's bundle patch could not be read:\n${commandOutput(packed)}`)
  }
  if (sha256OfText(readFileSync(installedPatchPath, 'utf8')) !== sha256OfText(packed.stdout)) {
    fail('INFRA_INSTALL_FAILURE', 'the installed candidate bundle patch DIFFERS from the tarball (the package layer was modified)')
  }

  if (invocation.includes('--patch')) {
    fail('INFRA_INSTALL_FAILURE', `the smoke invocation must pass no --patch overlay: ${JSON.stringify(invocation)}`)
  }

  return {
    profileBundles: bundles,
    userPatchLayer: {
      path: userPatchPath,
      // The accepted (allowlisted) row lines, recorded as evidence.
      rows: readFileSync(userPatchPath, 'utf8').split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#')),
    },
    packagePatchMatchesTarball: true,
    patchOverlays: [],
  }
}

function sha256OfText(text) {
  return createHash('sha256').update(text).digest('hex')
}

function writeLauncher(path, invocation, env, exitCodeFile) {
  const lines = [
    '#!/bin/sh',
    // NOTE: no `set -e` — a non-zero DSH exit must be CAPTURED, not shortcut.
    'set -u',
    `export HOME=${shellQuote(env.HOME)}`,
    `export DSH_HOME=${shellQuote(env.DSH_HOME)}`,
    'export TERM="${TERM:-xterm-256color}"',
    // --profile is a LAUNCHER flag: it must come FIRST, because everything
    // after the first unrecognized token is handed to the booted app verbatim.
    `${invocation.map(shellQuote).join(' ')}`,
    'code=$?',
    // The tmux/script layer cannot report the TUI's own status back to us, so
    // the launcher records it: a session disappears the same way for a clean
    // exit and for a crash, and the smoke must never treat "the pane is gone"
    // as success.
    `printf '%s' "$code" > ${shellQuote(exitCodeFile)}`,
    'exit "$code"',
    '',
  ]
  writeFileSync(path, lines.join('\n'), { encoding: 'utf8', mode: 0o700 })
}

/** Require the recorded DSH process status to be a clean zero. */
function assertCleanDshExit(exitCodeText, label) {
  const code = String(exitCodeText).trim()
  if (!/^\d+$/u.test(code)) {
    fail(`${label.toUpperCase()}_EXIT_CODE_FAILURE`, `${label}: the DSH exit status was not recorded (got ${JSON.stringify(code)})`)
  }
  if (Number(code) !== 0) {
    fail(`${label.toUpperCase()}_EXIT_CODE_FAILURE`, `${label}: the DSH process exited with status ${code}`)
  }
}

/** One driven TUI run in its own tmux session; `steps` receives the driver. */
async function driveTuiRun(label, options) {
  // Every tmux call targets the run's OWN server socket inside the one-shot
  // work dir (`-S <path>`, an explicit socket path; `-L` would take a NAME):
  // the smoke must never attach to, collide with, or kill a session on the
  // developer's default tmux server.
  const { socket, session, launcher, tuiLog, exitCodeFile, env } = options
  const tmuxArgs = (args) => run('tmux', ['-S', socket, ...args], { env })
  const started = tmuxArgs([
    'new-session', '-d', '-s', session, '-x', '100', '-y', '30',
    `script -qefc ${shellQuote(launcher)} ${shellQuote(tuiLog)}`,
  ])
  if (started.status !== 0) fail(`${label.toUpperCase()}_BOOT_FAILURE`, `TUI could not start:\n${commandOutput(started)}`)
  const tmux = {
    // Include recent scrollback: a transient command notice can scroll out of
    // the visible pane when the next frame repaints.
    capture: () => commandOutput(tmuxArgs(['capture-pane', '-p', '-S', '-500', '-t', session])),
    has: () => tmuxArgs(['has-session', '-t', session]).status === 0,
    send: (text) => { tmuxArgs(['send-keys', '-t', session, text]) },
    stop: () => { tmuxArgs(['kill-session', '-t', session]) },
  }
  try {
    await waitUntil(`${label} first frame`, BOOT_TIMEOUT_MS, () => tmux.has() && tmux.capture().includes('❯'), `${label.toUpperCase()}_BOOT_FAILURE`)
    await options.steps(tmux)
    // The process exit is the barrier that all log producers stopped.
    await waitUntil(`${label} exit`, STEP_TIMEOUT_MS, () => !tmux.has(), `${label.toUpperCase()}_EXIT_FAILURE`)
    // "The pane is gone" is not success: require the recorded DSH status.
    const exitCodeText = existsSync(exitCodeFile) ? readFileSync(exitCodeFile, 'utf8') : ''
    assertCleanDshExit(exitCodeText, label)
    return readFileSync(tuiLog, 'utf8')
  } finally {
    tmux.stop()
  }
}

/** Assert the negative diagnostics are absent from every produced log. */
function assertNoRetirementErrors(label, texts) {
  for (const { name, text } of texts) {
    for (const diagnostic of FORBIDDEN_DIAGNOSTICS) {
      if (text.includes(diagnostic)) {
        fail(`${label.toUpperCase()}_RETIREMENT_FAILURE`, `${label}: forbidden diagnostic "${diagnostic}" present in ${name}`)
      }
    }
  }
}

/** The session ids the TUI exit banner offered for resume, newest last. */
function committedSessionIdsFromLog(logText) {
  const ids = []
  for (const match of logText.matchAll(/--session (session-[0-9a-f-]{8,})/gu)) {
    ids.push(match[1])
  }
  return ids
}

/**
 * The profile user patch layer must be EXACTLY the empty list.
 *
 * This check runs on the freshly generated profile BEFORE the first TUI boot,
 * so the only acceptable layer is `[]` (comments and blank lines allowed).
 * Any row — insert, disabled, override (top-level or nested), a foreign or even
 * the candidate's own config row, an unknown key — proves something wrote a
 * user patch, which is outside the smoke's declared composition. Comparing the
 * normalized content against the expected `[]` is stricter than enumerating
 * patch operations, and it does not claim to tolerate shapes it never saw.
 * @param text - the raw cordis.patch.yml content.
 * @returns the offending lines (empty = the layer is the expected empty list).
 */
function userPatchViolations(text) {
  const lines = text
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
  return lines.filter(line => line !== '[]')
}

/** Find the durable JSONL artifact of one session under $DSH_HOME/sessions.
 * The official persistence layout is one directory per session id (nested
 * under an encoded-cwd directory); the durable log is a NON-EMPTY
 * `session.v4.jsonl.zstd` file inside it. A directory without a materialized
 * log is not durable evidence. */
function findSessionArtifact(sessionsRoot, sessionId) {
  if (!existsSync(sessionsRoot)) return undefined
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const sessionDir = join(sessionsRoot, entry.name, sessionId)
    if (!existsSync(sessionDir)) continue
    const files = readdirSync(sessionDir)
    const durable = files.find(name => /^session\.v\d+\.jsonl(\.zstd)?$/u.test(name))
    if (durable === undefined) continue
    const stat = statSync(join(sessionDir, durable))
    if (stat.size > 0) return join(sessionDir, durable)
  }
  return undefined
}

/** Count every durable session artifact under the sessions root. */
function countSessionArtifacts(sessionsRoot) {
  if (!existsSync(sessionsRoot)) return 0
  let count = 0
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const sessionEntry of readdirSync(join(sessionsRoot, entry.name), { withFileTypes: true })) {
      if (!sessionEntry.isDirectory()) continue
      const files = readdirSync(join(sessionsRoot, entry.name, sessionEntry.name))
      if (files.some(name => /^session\.v\d+\.jsonl(\.zstd)?$/u.test(name))) count += 1
    }
  }
  return count
}

/** Strip ANSI escapes so pane text can be matched with plain regexes. */
function stripAnsi(text) {
  return text.replace(/\[[0-9;?]*[a-zA-Z]/gu, '').replace(/\][^\\]*\\/gu, '')
}

async function main() {
  const args = process.argv.slice(2)
  const explicit = candidateArgument(args)
  if (explicit === undefined) {
    fail('INFRA_INSTALL_FAILURE', 'the candidate tarball path is a required argument (no published-package fallback)')
  }
  const tarball = resolveTarball(explicit)
  validateCandidateTarball(tarball)
  const targetDshVersion = npmDshVersion()
  const workDir = mkdtempSync(join(PACKAGE_ROOT, 'temp', 'direct-empty-retirement-'))
  const home = join(workDir, 'home')
  const dshHome = join(workDir, 'dsh-home')
  const harnessDir = join(workDir, 'harness')
  for (const dir of [home, dshHome, harnessDir]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(workDir, 'npmrc'), 'registry=https://registry.npmjs.org\n', 'utf8')
  const env = isolatedEnvironment(workDir, home, dshHome, join(workDir, 'compat-evidence.json'))

  let completed = false
  try {
    writeFileSync(join(harnessDir, 'package.json'), JSON.stringify({
      name: 'dsh-empty-retirement-harness',
      private: true,
      type: 'module',
      dependencies: { '@deepseek-ai/dsh': targetDshVersion },
    }, null, 2) + '\n', 'utf8')
    runPnpmInstall(harnessDir, env, loadDshDistribution({ mode: 'npm', version: targetDshVersion }))
    const dsh = dshInvocation(harnessDir)
    const version = runDsh(dsh, ['--version'], harnessDir, env)
    if (version.status !== 0) fail('INFRA_INSTALL_FAILURE', `installed DSH --version failed:\n${commandOutput(version)}`)
    requireExactVersion('DSH', commandOutput(version).split(/\r?\n/u).find(line => line.trim() !== '')?.trim(), targetDshVersion)

    installPlugin(dsh, tarball, harnessDir, env, false)
    // The official profile requires the base bundle; the candidate tarball is
    // the ONLY other plugin (no probes, no business plugins, no model mock).
    const bundles = runDsh(dsh, ['plugin', '--profile', 'pi-tui', 'list'], harnessDir, env)
    if (bundles.status !== 0) fail('INFRA_INSTALL_FAILURE', `plugin list failed:\n${commandOutput(bundles)}`)
    const bundleLines = commandOutput(bundles).split(/\r?\n/u).filter(line => line.trim() !== '')

    const profileDir = join(dshHome, 'profiles', 'pi-tui')
    const facts = environmentFacts(tarball, harnessDir, env, targetDshVersion)
    // The composition is ASSERTED, not just printed: a wrong profile (extra
    // bundle, user patch, modified package patch, --patch overlay) would
    // otherwise produce a PASS against a profile this smoke never claims.
    const composition = assertProfileComposition({ profileDir, tarball, invocation: dsh, env })
    console.log(JSON.stringify({
      ...facts,
      pluginList: bundleLines,
      composition,
      dshHome: env.DSH_HOME,
      tuiLogsDir: join(dshHome, 'logs'),
    }, null, 2))

    // ONE isolated tmux server socket inside the one-shot work dir; removed
    // with it. All four scenarios share the server, each in its own session.
    const socket = join(workDir, 'tmux.sock')
    const sessionPrefix = `empty-retire-${process.pid}`
    const makeRun = (name, extraArgs = []) => {
      // No `--patch` overlay may join ANY run (plan §5): the two composed
      // layers must be the shipped ones only.
      if (extraArgs.includes('--patch')) {
        fail('INFRA_INSTALL_FAILURE', `run ${name} must not pass a --patch overlay: ${JSON.stringify(extraArgs)}`)
      }
      const launcher = join(workDir, `run-${name}.sh`)
      const exitCodeFile = join(workDir, `${name}.exit-code`)
      // --profile first (a launcher flag); extra args (like --session <id>)
      // follow as the booted app's inner arguments.
      writeLauncher(launcher, [...dsh, '--profile', 'pi-tui', ...extraArgs], env, exitCodeFile)
      return { launcher, tuiLog: join(workDir, `${name}.tui.log`), exitCodeFile }
    }

    // --- Scenario A: start → /new → /exit -------------------------------
    const runA = makeRun('a-new-exit')
    let logA
    try {
      logA = await driveTuiRun('a', {
        socket,
        session: `${sessionPrefix}-a`,
        launcher: runA.launcher,
        tuiLog: runA.tuiLog,
        exitCodeFile: runA.exitCodeFile,
        env,
        steps: async (tmux) => {
          tmux.send('/new')
          tmux.send('Enter')
          await waitUntil('/new committed', STEP_TIMEOUT_MS, () => tmux.capture().match(/session\s+session-[0-9a-f-]{8,}/u) !== null, 'A_NEW_FAILURE')
          tmux.send('/exit')
          tmux.send('Enter')
        },
      })
    } finally { /* logs stay until the evidence check below */ }
    assertNoRetirementErrors('a', [{ name: basename(runA.tuiLog), text: logA }, ...piTuiLogs(dshHome)])

    // The committed empty session id, cross-checked against the OFFICIAL
    // persistence artifacts (one session directory + a non-empty durable
    // log file under $DSH_HOME/sessions) before the resume proof.
    const idsA = committedSessionIdsFromLog(logA)
    const emptySessionId = idsA.at(-1)
    if (emptySessionId === undefined) {
      fail('A_DURABILITY_FAILURE', `no committed session id found in the TUI log:\n${logA.slice(-2000)}`)
    }
    const sessionsRoot = join(dshHome, 'sessions')
    const sessionArtifact = findSessionArtifact(sessionsRoot, emptySessionId)
    if (sessionArtifact === undefined) {
      fail('A_DURABILITY_FAILURE', `no durable session artifact for the committed empty session ${emptySessionId} under ${sessionsRoot}`)
    }

    // --- Scenario B: resume the empty session through the official reader ---
    // The resume must SUCCEED (the TUI boots with the SAME session id in its
    // status card): that is the official reader accepting the artifact.
    const runB = makeRun('b-resume-exit', ['--session', emptySessionId])
    let logB
    try {
      logB = await driveTuiRun('b', {
        socket,
        session: `${sessionPrefix}-b`,
        launcher: runB.launcher,
        tuiLog: runB.tuiLog,
        exitCodeFile: runB.exitCodeFile,
        env,
        steps: async (tmux) => {
          await waitUntil('resumed session id visible', STEP_TIMEOUT_MS, () => {
            const pane = stripAnsi(tmux.capture())
            const match = pane.match(/session\s+(session-[0-9a-f-]{8,})/u)
            return match?.[1] === emptySessionId
          }, 'B_RESUME_FAILURE')
          tmux.send('/exit')
          tmux.send('Enter')
        },
      })
    } finally { /* evidence checked immediately */ }
    assertNoRetirementErrors('b', [{ name: basename(runB.tuiLog), text: logB }, ...piTuiLogs(dshHome)])
    if (!stripAnsi(logB).includes(emptySessionId)) {
      fail('B_RESUME_FAILURE', `the resumed TUI never displayed the empty session id ${emptySessionId}`)
    }

    // --- Scenario C: start → /new → /new → /exit -------------------------
    const artifactsBeforeC = countSessionArtifacts(sessionsRoot)
    const runC = makeRun('c-new-new-exit')
    let logC
    try {
      logC = await driveTuiRun('c', {
        socket,
        session: `${sessionPrefix}-c`,
        launcher: runC.launcher,
        tuiLog: runC.tuiLog,
        exitCodeFile: runC.exitCodeFile,
        env,
        steps: async (tmux) => {
          const currentSessionId = (pane) => stripAnsi(pane).match(/session\s+(session-[0-9a-f-]{8,})/u)?.[1]
          tmux.send('/new')
          tmux.send('Enter')
          await waitUntil('first /new committed', STEP_TIMEOUT_MS, () => currentSessionId(tmux.capture()) !== undefined, 'C_NEW_FAILURE')
          // The FIRST id is captured on the committed frame itself, BEFORE the
          // second command is sent: reading it afterwards could observe the
          // second /new already committed and then wait forever for a change.
          const first = currentSessionId(tmux.capture())
          if (first === undefined) fail('C_NEW_FAILURE', 'the first /new did not expose its committed session id')
          tmux.send('/new')
          tmux.send('Enter')
          await waitUntil('second /new committed', STEP_TIMEOUT_MS, () => {
            const next = currentSessionId(tmux.capture())
            return next !== undefined && next !== first
          }, 'C_NEW_FAILURE')
          tmux.send('/exit')
          tmux.send('Enter')
        },
      })
    } finally { /* evidence checked immediately */ }
    assertNoRetirementErrors('c', [{ name: basename(runC.tuiLog), text: logC }, ...piTuiLogs(dshHome)])
    // Both /new commits of this run are durable: the run created exactly TWO
    // new session artifacts (the exit banner names only the LAST one).
    const artifactsAfterC = countSessionArtifacts(sessionsRoot)
    if (artifactsAfterC - artifactsBeforeC !== 2) {
      fail('C_TRANSITION_FAILURE', `expected two new durable sessions from /new → /new, saw ${artifactsAfterC - artifactsBeforeC} (before ${artifactsBeforeC}, after ${artifactsAfterC})`)
    }
    const idsC = committedSessionIdsFromLog(logC)
    if (idsC.length < 1) {
      fail('C_TRANSITION_FAILURE', `the /new → /new exit banner named no session: ${JSON.stringify(idsC)}`)
    }
    for (const id of idsC) {
      if (findSessionArtifact(sessionsRoot, id) === undefined) {
        fail('C_TRANSITION_FAILURE', `no durable session artifact for ${id} after /new → /new → /exit`)
      }
    }

    // --- Scenario D: start → /exit with no session (negative control) ----
    // A sessionless exit must not materialize any NEW session artifact.
    const sessionsBefore = countSessionArtifacts(sessionsRoot)
    const runD = makeRun('d-exit-only')
    let logD
    try {
      logD = await driveTuiRun('d', {
        socket,
        session: `${sessionPrefix}-d`,
        launcher: runD.launcher,
        tuiLog: runD.tuiLog,
        exitCodeFile: runD.exitCodeFile,
        env,
        steps: async (tmux) => { tmux.send('/exit'); tmux.send('Enter') },
      })
    } finally { /* evidence checked immediately */ }
    assertNoRetirementErrors('d', [{ name: basename(runD.tuiLog), text: logD }, ...piTuiLogs(dshHome)])
    const sessionsAfter = countSessionArtifacts(sessionsRoot)
    if (sessionsAfter === sessionsBefore) {
      // No new artifact: nothing was created by the no-session exit.
      console.log(`Direct empty-session retirement smoke passed — ${basename(tarball)} × DSH ${targetDshVersion}`)
      completed = true
      return
    }
    fail('D_NEGATIVE_CONTROL_FAILURE', `a no-session exit changed the session artifact count: ${sessionsBefore} -> ${sessionsAfter}`)
  } finally {
    if (process.env.DSH_EMPTY_RETIREMENT_KEEP !== '1') {
      if (completed || process.env.DSH_EMPTY_RETIREMENT_KEEP !== 'debug') rmSync(workDir, { recursive: true, force: true })
      else console.error(`preserved isolated environment for debugging: ${workDir}`)
    } else {
      console.error(`preserved isolated environment: ${workDir}`)
    }
  }
}

export { assertCleanDshExit, assertProfileComposition, countSessionArtifacts, EXPECTED_BUNDLES, userPatchViolations, writeLauncher }

if (process.argv[1] !== undefined && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch(error => {
    console.error(`DSH_EMPTY_RETIREMENT_FAILURE[${error?.phase ?? 'UNKNOWN'}]: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
