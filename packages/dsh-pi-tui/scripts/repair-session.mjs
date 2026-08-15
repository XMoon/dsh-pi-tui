#!/usr/bin/env node
/**
 * @xmoon76/dsh-pi-tui/scripts/repair-session — repair a corrupted dsh
 * session log.
 *
 * dsh persists sessions under `$DSH_HOME/sessions/<workspace>/<id>/` as
 * `session.jsonl.zstd` (concatenated Zstandard frames of JSONL). A session
 * written concurrently by two dsh processes can end up with duplicate or
 * missing seq numbers and become unreadable (`corrupt session log: seq gap
 * in committed region`). This script repairs the artifact and verifies the
 * result with the same storage-format scan the reader performs.
 *
 * Usage:
 *   node repair-session.mjs <session-id> [--yes] [--dsh-dir <path>] [--dsh-home <path>]
 *   node repair-session.mjs --scan [--dsh-dir <path>] [--dsh-home <path>]
 *
 * - Default is a dry run: reports the diagnosis and the repair plan without
 *   touching the file. Pass `--yes` to apply.
 * - Before writing, the original artifact is ALWAYS backed up to
 *   `<artifact>.bak-<timestamp>`; a failed backup aborts the write.
 * - `--scan` read-only scans every persisted session and lists the damaged
 *   ids (one line each, `CORRUPT <id>: <reason>`).
 *
 * Dependencies: resolves `decodeStorageRecord`/`packChunkRuns` from the
 * installed dsh (`@deepseek-ai/dsh-session`). Resolution order:
 * `--dsh-dir`, then the `dsh` launcher on PATH (its realpath walks up to
 * the owning package), then `$DSH_HOME`/`DSH_DIR`.
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { compressLog, decompressFrames, encodeLog, repairEvents, scanEvents, scanZstdLayout } from './repair-core.mjs'

const USAGE = `usage:
  node repair-session.mjs <session-id> [--yes] [--dsh-dir <path>] [--dsh-home <path>]
  node repair-session.mjs --scan [--dsh-dir <path>] [--dsh-home <path>]

repair one session log (dry run by default; --yes applies with a backup),
or --scan all persisted sessions read-only and list damaged ids.`

/** Locate the dsh package directory (the one whose manifest is @deepseek-ai/dsh). */
function findDshPackageDir(from) {
  let dir = from
  for (let depth = 0; depth < 12; depth += 1) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
        if (pkg.name === '@deepseek-ai/dsh') return dir
      } catch {
        // Not a readable manifest; keep walking up.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** Resolve the dsh package directory from --dsh-dir / PATH / env. */
function resolveDshDir(explicit) {
  if (explicit !== undefined) {
    const dir = findDshPackageDir(resolve(explicit))
    if (dir !== undefined) return dir
    throw new Error(`--dsh-dir ${explicit}: no @deepseek-ai/dsh package found under this path`)
  }
  const fromBin = spawnSync('which', ['dsh'], { encoding: 'utf8' }).stdout.trim()
  if (fromBin !== '') {
    const dir = findDshPackageDir(dirname(realpathSync(fromBin)))
    if (dir !== undefined) return dir
  }
  const env = process.env.DSH_DIR
  if (env !== undefined && env !== '') {
    const dir = findDshPackageDir(resolve(env))
    if (dir !== undefined) return dir
  }
  throw new Error('cannot locate the dsh installation; pass --dsh-dir <path-to-dsh-package>')
}

/** Load @deepseek-ai/dsh-session from the dsh install. */
function loadDshSession(dshDir) {
  const require = createRequire(join(dshDir, 'package.json'))
  return require('@deepseek-ai/dsh-session')
}

/** The dsh home: $DSH_HOME, else ~/.dsh. */
function dshHome() {
  const explicit = process.env.DSH_HOME
  if (explicit !== undefined && explicit !== '') return explicit
  return join(homedir(), '.dsh')
}

/** Find the artifact file for one session id (or undefined). */
function findSessionArtifact(home, id) {
  const roots = readdirSync(join(home, 'sessions'), { withFileTypes: true })
  for (const entry of roots) {
    if (!entry.isDirectory()) continue
    const dir = join(home, 'sessions', entry.name, id)
    if (!existsSync(dir)) continue
    for (const name of ['session.jsonl.zstd', 'session.jsonl']) {
      const path = join(dir, name)
      if (existsSync(path)) return { path, compression: name.endsWith('.zstd') ? 'zstd' : 'none' }
    }
  }
  return undefined
}

/** Read one artifact into decompressed text, validating the zstd frame layout. */
function readArtifact(path, compression) {
  if (compression === 'none') return { text: readFileSync(path, 'utf8'), layoutIssue: undefined }
  const buffer = readFileSync(path)
  const layout = scanZstdLayout(buffer, zstdDecompressSync)
  return { text: decompressFrames(buffer, zstdDecompressSync).text, layoutIssue: layout.ok ? undefined : layout.issue }
}

/** Write one artifact back: backup first, then atomic tmp+rename (0600 like the harness). */
function writeArtifact(path, compression, text) {
  const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    copyFileSync(path, backup)
  } catch (error) {
    throw new Error(`backup failed (${error instanceof Error ? error.message : String(error)}); refusing to write`)
  }
  const tmp = `${path}.repair-tmp-${process.pid}`
  const bytes = compression === 'none' ? Buffer.from(text, 'utf8') : compressLog(text, zstdCompressSync)
  try {
    writeFileSync(tmp, bytes, { mode: 0o600 })
    renameSync(tmp, path)
  } catch (error) {
    try {
      // Restore the backup so a failed write never leaves a half file.
      copyFileSync(backup, path)
    } catch {
      // Best effort.
    }
    throw error
  }
  return backup
}

/** Scan every persisted session read-only; returns damaged entries. */
function scanAll(home, decodeStorageRecord) {
  const damaged = []
  const roots = readdirSync(join(home, 'sessions'), { withFileTypes: true })
  for (const entry of roots) {
    if (!entry.isDirectory()) continue
    const workspaceDir = join(home, 'sessions', entry.name)
    for (const sessionEntry of readdirSync(workspaceDir, { withFileTypes: true })) {
      if (!sessionEntry.isDirectory()) continue
      const dir = join(workspaceDir, sessionEntry.name)
      for (const name of ['session.jsonl.zstd', 'session.jsonl']) {
        const path = join(dir, name)
        if (!existsSync(path)) continue
        const compression = name.endsWith('.zstd') ? 'zstd' : 'none'
        const id = basename(dir)
        try {
          const { text, layoutIssue } = readArtifact(path, compression)
          const { issue } = scanEvents(text, decodeStorageRecord)
          if (layoutIssue !== undefined || issue !== undefined) {
            damaged.push({
              id,
              path,
              issue: { kind: layoutIssue !== undefined ? 'layout' : issue.kind, message: layoutIssue ?? issue.message },
            })
          }
        } catch (error) {
          damaged.push({ id, path, issue: { kind: 'unreadable', message: error instanceof Error ? error.message : String(error) } })
        }
      }
    }
  }
  return damaged
}

const args = process.argv.slice(2)
const flags = { scan: false, yes: false, dshDir: undefined }
const positional = []
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--scan') flags.scan = true
  else if (arg === '--yes') flags.yes = true
  else if (arg === '--dsh-dir') flags.dshDir = args[++i]
  else if (arg === '--dsh-home') process.env.DSH_HOME = args[++i]
  else if (arg === '--help' || arg === '-h') {
    console.log(USAGE)
    process.exit(0)
  } else positional.push(arg)
}

function main() {
  const home = dshHome()
  const sessionsRoot = join(home, 'sessions')
  if (!existsSync(sessionsRoot)) {
    console.error(`no sessions directory at ${sessionsRoot}`)
    process.exit(2)
  }
  const dshDir = resolveDshDir(flags.dshDir)
  const { decodeStorageRecord } = loadDshSession(dshDir)

  if (flags.scan) {
    const damaged = scanAll(home, decodeStorageRecord)
    if (damaged.length === 0) {
      console.log('no damaged sessions found')
      process.exit(0)
    }
    for (const entry of damaged) {
      console.log(`CORRUPT ${entry.id}: ${entry.issue.message}`)
    }
    console.log(`\n${damaged.length} damaged session(s); repair one with: node repair-session.mjs <session-id> --yes`)
    process.exit(1)
  }

  if (positional.length !== 1) {
    console.error(USAGE)
    process.exit(2)
  }
  const id = positional[0]
  const artifact = findSessionArtifact(home, id)
  if (artifact === undefined) {
    console.error(`session ${id}: no artifact found under ${sessionsRoot}`)
    process.exit(2)
  }

  const { text, layoutIssue } = readArtifact(artifact.path, artifact.compression)
  const { header, events, issue } = scanEvents(text, decodeStorageRecord)
  if (layoutIssue === undefined && issue === undefined) {
    console.log(`session ${id}: log is contiguous (${events.length} events) and the frame layout is valid; nothing to repair`)
    process.exit(0)
  }
  // Content repair (renumber/truncate) applies when the event stream is
  // damaged; a layout-damaged log (e.g. whole-log single frame) is re-framed.
  const plan = issue === undefined ? undefined : repairEvents(events, issue)
  if (layoutIssue !== undefined) console.log(`session ${id}: ${layoutIssue}`)
  if (issue !== undefined) console.log(`session ${id}: ${issue.message}`)
  console.log(`  file: ${artifact.path}`)
  if (layoutIssue !== undefined) {
    console.log('  plan: re-frame the log (dsh requires the header line alone in the first frame, one frame per flush batch)')
  }
  if (plan !== undefined) {
    if (plan.action === 'renumber') {
      console.log(`  plan: renumber ${plan.changed} event(s) from seq ${issue.got} by +${plan.delta} (${plan.refsChanged} reference(s) remapped)`)
    } else if (plan.action === 'truncate') {
      console.log(`  plan: truncate ${plan.changed} trailing event(s) after index ${plan.fromIndex} (missing/undecodable events cannot be recreated)`)
    }
  }

  if (!flags.yes) {
    console.log('  dry run: nothing written; pass --yes to apply (a backup is created first)')
    process.exit(1)
  }

  const output = encodeLog(header, plan === undefined ? events : plan.events)
  const backup = writeArtifact(artifact.path, artifact.compression, output)
  console.log(`  backup: ${backup}`)
  console.log(`  wrote: ${artifact.path}`)

  // Verify with the same checks the reader performs: frame layout AND event contiguity.
  const verifyArtifact = readArtifact(artifact.path, artifact.compression)
  const verifyEvents = scanEvents(verifyArtifact.text, decodeStorageRecord)
  if (verifyArtifact.layoutIssue !== undefined || verifyEvents.issue !== undefined) {
    console.error(`  VERIFY FAILED: ${verifyArtifact.layoutIssue ?? verifyEvents.issue.message} — original preserved in ${backup}`)
    process.exit(1)
  }
  console.log(`  verify: valid frame layout, contiguous, ${verifyEvents.events.length} event(s)`)
}

try {
  main()
} catch (error) {
  console.error(`repair-session: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
