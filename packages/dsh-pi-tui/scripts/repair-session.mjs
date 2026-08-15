#!/usr/bin/env node
/**
 * @xmoon76/dsh-pi-tui/scripts/repair-session — repair a corrupted dsh
 * session log.
 *
 * dsh persists sessions under `$DSH_HOME/sessions/<workspace>/<id>/` as
 * `session.jsonl.zstd` (concatenated Zstandard frames of JSONL). A session
 * written concurrently by two dsh processes can end up with duplicate or
 * missing seq numbers and become unreadable (`corrupt session log: seq gap
 * in committed region`); a crash mid-flush can leave a torn (truncated)
 * Zstandard tail that most readers silently ignore. This script repairs the
 * artifact and verifies the result with the same storage-format scan the
 * reader performs. A torn tail is truncated at the last COMPLETE frame
 * boundary — the salvaged prefix is re-framed, and the loss count is
 * reported as unknown (the torn frame's content is unknowable).
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
 *   ids (one line each, `CORRUPT <id>: <reason>`). A torn (truncated)
 *   Zstandard tail is reported with its byte accounting instead of being
 *   silently treated as healthy.
 *
 * Dependencies: resolves `decodeStorageRecord`/`packChunkRuns` from the
 * installed dsh (`@deepseek-ai/dsh-session`). Resolution order:
 * `--dsh-dir`, then the `dsh` launcher on PATH (its realpath walks up to
 * the owning package), then `$DSH_HOME`/`DSH_DIR`.
 */

import { copyFileSync, existsSync, openSync, fsyncSync, closeSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { compressLog, decompressFrames, encodeLog, frameLineRanges, repairEvents, scanEvents, scanFrameLayout } from './repair-core.mjs'

const USAGE = `usage:
  node repair-session.mjs <session-id> [--yes] [--duplicate-reference first|last|segment] [--dsh-dir <path>] [--dsh-home <path>]
  node repair-session.mjs --scan [--dsh-dir <path>] [--dsh-home <path>]

repair one session log (dry run by default; --yes applies with a backup),
or --scan all persisted sessions read-only and list damaged ids.

--duplicate-reference resolves references to a duplicated seq (a seq that
appears more than once because two writers collided): first = the earlier
event, last = the later event, segment = an event in the same flush frame
when one exists. Without it, an ambiguous log is refused, never rewritten.`

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

/**
 * Read one artifact into decompressed text plus the full frame-layout
 * diagnosis. Only COMPLETE frames contribute to the text, so a torn tail is
 * inherently excluded from the salvageable prefix; the layout result carries
 * the byte accounting (`tornStart`/`garbageStart`, `totalBytes`,
 * `completeBytes`) for reporting.
 */
function readArtifact(path, compression) {
  if (compression === 'none') {
    return {
      text: readFileSync(path, 'utf8'),
      layout: { status: 'healthy', frames: [], totalBytes: 0, completeBytes: 0 },
      lineRanges: undefined,
    }
  }
  const buffer = readFileSync(path)
  const layout = scanFrameLayout(buffer, zstdDecompressSync)
  // Only complete frames contribute; a frame-less prefix (torn from byte 0)
  // yields an empty salvageable text and is refused by the caller.
  return {
    text: layout.frames.length === 0 ? '' : decompressFrames(buffer, zstdDecompressSync).text,
    layout,
    // Per-frame JSONL line ranges: writer segments for duplicate-seq
    // reference resolution (--duplicate-reference=segment).
    lineRanges: frameLineRanges(buffer, zstdDecompressSync),
  }
}

/**
 * Write one artifact back: backup first (durable — fsynced before the
 * original is touched), then atomic tmp+rename (0600 like the harness).
 */
function writeArtifact(path, compression, text) {
  const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    copyFileSync(path, backup)
    // The backup must be durable BEFORE the original is replaced: fsync the
    // copied bytes so a crash cannot lose both copies.
    const fd = openSync(backup, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
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

/** A one-line damage report for --scan output. */
function damageLine(layout, lastEvent) {
  if (layout.status === 'torn-tail') {
    const at = layout.tornStart ?? layout.garbageStart
    const last = lastEvent === undefined
      ? 'no decodable event in the complete prefix'
      : `last decodable event: ${lastEvent.seq}:${lastEvent.type}`
    return `torn tail — damage starts at byte ${at} of ${layout.totalBytes} (${layout.completeBytes} complete bytes; ${last})`
  }
  return layout.issue
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
          const { text, layout, lineRanges } = readArtifact(path, compression)
          const { issue, events } = scanEvents(text, decodeStorageRecord, lineRanges)
          if (layout.status !== 'healthy' || issue !== undefined) {
            const lastEvent = events.length === 0 ? undefined : events[events.length - 1]
            damaged.push({
              id,
              path,
              layout,
              lastEvent,
              issue: {
                kind: layout.status !== 'healthy' ? layout.status : issue.kind,
                message: layout.status !== 'healthy' ? damageLine(layout, lastEvent) : issue.message,
              },
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
const flags = { scan: false, yes: false, duplicateReference: undefined, dshDir: undefined }
const positional = []
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--scan') flags.scan = true
  else if (arg === '--yes') flags.yes = true
  else if (arg === '--duplicate-reference') flags.duplicateReference = args[++i]
  else if (arg === '--dsh-dir') flags.dshDir = args[++i]
  else if (arg === '--dsh-home') process.env.DSH_HOME = args[++i]
  else if (arg === '--help' || arg === '-h') {
    console.log(USAGE)
    process.exit(0)
  } else positional.push(arg)
}

/** Print the ambiguity report for a refused duplicate-seq repair. */
function printAmbiguity(id, plan, events) {
  console.log(`session ${id}: ${plan.message}`)
  for (const entry of plan.ambiguous) {
    const frame = entry.frame >= 0 ? `, frame ${entry.frame}` : ''
    console.log(`  seq ${entry.seq} referenced via ${entry.key} by event ${entry.eventIndex} (line ${entry.line}${frame})`)
    console.log(`    candidates: ${entry.candidates.map(index => `event ${index} (seq ${events[index].seq})`).join(', ')}`)
  }
  console.log('  strategies (--duplicate-reference): first = bind to the first occurrence; last = bind to the last;')
  console.log('  segment = bind to an occurrence in the same flush frame, else first. Risk: a wrong binding')
  console.log('  rewrites cross-references to the other writer\'s event — review the candidates before choosing.')
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

  const { text, layout, lineRanges } = readArtifact(artifact.path, artifact.compression)
  // Frame line ranges feed duplicate-seq reference resolution (writer segments).
  const { header, events, issue } = scanEvents(text, decodeStorageRecord, lineRanges)
  if (layout.status === 'healthy' && issue === undefined) {
    console.log(`session ${id}: log is contiguous (${events.length} events) and the frame layout is valid; nothing to repair`)
    process.exit(0)
  }
  // A torn tail with zero salvageable bytes (damage at byte 0) cannot be
  // repaired by truncation: the complete prefix holds nothing to keep.
  if (layout.status === 'torn-tail' && layout.completeBytes === 0) {
    console.error(`session ${id}: ${layout.issue}; no salvageable prefix — nothing to repair, original left untouched`)
    process.exit(1)
  }
  // Content repair (renumber/truncate) applies when the event stream is
  // damaged; a layout-damaged log (e.g. whole-log single frame) is re-framed;
  // a torn tail is dropped by construction (the text only holds complete
  // frames) and re-framed together with the rest.
  const plan = issue === undefined ? undefined : repairEvents(events, issue, {
    duplicateReference: flags.duplicateReference,
  })
  if (plan !== undefined && plan.action === 'refuse') {
    printAmbiguity(id, plan, events)
    console.log('  no write was performed; re-run with a strategy or inspect the log manually')
    process.exit(1)
  }
  if (layout.status !== 'healthy') console.log(`session ${id}: ${damageLine(layout, events.length === 0 ? undefined : events[events.length - 1])}`)
  if (issue !== undefined) console.log(`session ${id}: ${issue.message}`)
  console.log(`  file: ${artifact.path}`)
  const storageRows = text.split('\n').filter(line => line !== '').length - 1
  if (layout.status === 'torn-tail') {
    console.log(`  plan: truncate the torn tail — keep ${layout.completeBytes} of ${layout.totalBytes} bytes (${storageRows} storage row(s), ${events.length} expanded event(s)); events lost in the torn tail: unknown`)
  } else if (layout.status !== 'healthy') {
    console.log('  plan: re-frame the log (dsh requires the header line alone in the first frame, one frame per flush batch)')
  }
  if (plan !== undefined) {
    if (plan.action === 'renumber') {
      const resolved = plan.resolvedStrategy === undefined ? '' : `, ${plan.ambiguous.length} ambiguous reference(s) resolved as ${plan.resolvedStrategy}`
      console.log(`  plan: renumber ${plan.changed} event(s) from seq ${issue.got} by +${plan.delta} (${plan.refsChanged} reference(s) remapped${resolved})`)
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
  if (verifyArtifact.layout.status !== 'healthy' || verifyEvents.issue !== undefined) {
    console.error(`  VERIFY FAILED: ${verifyArtifact.layout.status !== 'healthy' ? verifyArtifact.layout.issue : verifyEvents.issue.message} — original preserved in ${backup}`)
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
