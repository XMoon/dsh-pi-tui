#!/usr/bin/env node
/**
 * pi-vendor-diff gate: verify the vendored fork's src/ against the PINNED
 * upstream baseline (packages/pi-tui/UPSTREAM.json) and the machine-readable
 * structured divergence ledger (packages/pi-tui/vendor-divergences.json).
 *
 * The gate exists because "docs says only a few divergences" is not the same
 * as "actual source diff": every re-vendor must prove that every local change
 * is accounted for in the ledger, and that the source-active ledger is not
 * stale. Schema-v2 historical records remain in the ledger for audit evidence
 * but do not count as source coverage unless their status is source-active.
 *
 * Rules:
 *   1. FAIL — a local src file whose blob differs from the pinned upstream
 *      blob (or that does not exist upstream) is not covered by any manifest
 *      entry. This is an UNACCOUNTED divergence: the ledger must be updated
 *      (or the change reverted) before the migration can be called settled.
 *   2. WARN — a manifest entry whose src files ALL match upstream. The
 *      divergence may have been absorbed upstream or accidentally reverted;
 *      the ledger entry is stale. (--strict promotes this to a failure.)
 *   3. WARN — a source-active manifest entry listing a src file that no
 *      longer exists locally. (--strict promotes this to a failure.)
 *   4. Historical records are retained for audit evidence but are excluded
 *      from file-level source coverage; several share files with active
 *      divergences, so file-level comparison cannot prove their old hunk is
 *      present or absent. The structured ledger gate owns their status rules.
 *
 * Upstream resolution (first hit wins):
 *   - $PI_UPSTREAM_REPO — a checkout of the upstream repository
 *     (earendil-works/pi) containing the pinned commit;
 *   - ~/project/pi — the known local checkout;
 *   - GitHub codeload tarball of the pinned commit (network fallback).
 *
 * Usage: node scripts/pi-vendor-diff-gate.mjs [--strict]
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FORK_SRC = path.join(ROOT, 'packages', 'pi-tui', 'src')
const UPSTREAM_JSON_PATH = path.join(ROOT, 'packages', 'pi-tui', 'UPSTREAM.json')
const MANIFEST_PATH = process.env.PI_VENDOR_MANIFEST
  ? path.resolve(process.env.PI_VENDOR_MANIFEST)
  : path.join(ROOT, 'packages', 'pi-tui', 'vendor-divergences.json')

const STRICT = process.argv.includes('--strict')
const SOURCE_ACTIVE_STATUSES = new Set(['ACTIVE', 'RETIREMENT_CANDIDATE', 'REDUNDANT_SHIM'])
const SCHEMA_V2_STATUSES = new Set([
  ...SOURCE_ACTIVE_STATUSES,
  'ABSORBED_UPSTREAM',
  'MOVED_TO_HOST',
  'SUPERSEDED',
  'REMOVED_UNUSED',
])

/** Read both the schema-v2 ledger and the legacy flat shape while a checkout
 * is being migrated. The committed manifest is schema v2; accepting the old
 * shape here keeps the diff gate useful for a partial local re-vendor and
 * gives a clearer failure from the dedicated ledger gate. */
function manifestEntries(manifest) {
  if (manifest?.schemaVersion === 2) {
    if (manifest.divergences === null || typeof manifest.divergences !== 'object' || Array.isArray(manifest.divergences)) {
      throw new Error(`manifest ${path.relative(ROOT, MANIFEST_PATH)} has no schema-v2 divergences object`)
    }
    return Object.entries(manifest.divergences).map(([id, entry]) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || !Array.isArray(entry.files) || entry.files.length === 0 || !entry.files.every((file) => typeof file === 'string' && file.trim().length > 0)) {
        throw new Error(`manifest entry ${id} must contain a non-empty files array`)
      }
      if (typeof entry.status !== 'string' || !SCHEMA_V2_STATUSES.has(entry.status)) {
        throw new Error(`manifest entry ${id} must contain a supported schema-v2 status`)
      }
      return [id, entry.files, entry.status]
    })
  }
  return Object.entries(manifest ?? {})
    .filter(([id]) => !id.startsWith('_'))
    .map(([id, files]) => [id, files, 'ACTIVE'])
}

function sourceActive(status) {
  return SOURCE_ACTIVE_STATUSES.has(status)
}

/** Recursively list *.ts files under a directory, relative to it. */
function listTsFiles(dir) {
  const out = []
  const walk = (current, prefix) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name)
      if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`)
      else if (name.endsWith('.ts')) out.push(`${prefix}${name}`)
    }
  }
  walk(dir, '')
  return out.sort()
}

/** Read the upstream blob for one src file at the pinned commit. A git
 * checkout is read via `git show` (the checkout may sit at another
 * commit); a tarball-fallback upstream is a plain extracted tree, so the
 * file is read directly. */
function upstreamBlob(repo, packageDir, commit, file, isGit) {
  if (isGit) {
    try {
      return execFileSync('git', ['show', `${commit}:${packageDir}/src/${file}`], {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      return undefined // file does not exist upstream (local-only)
    }
  }
  const direct = path.join(repo, packageDir, 'src', file)
  if (!existsSync(direct)) return undefined // file does not exist upstream (local-only)
  return readFileSync(direct, 'utf8')
}

/** Resolve the upstream src directory; returns { repo, packageDir, commit } or throws. */
function resolveUpstream() {
  const upstream = JSON.parse(readFileSync(UPSTREAM_JSON_PATH, 'utf8'))
  const { repository, package: packageDir, commit } = upstream
  if (typeof repository !== 'string' || typeof packageDir !== 'string' || !/^[0-9a-f]{40}$/u.test(commit ?? '')) {
    throw new Error(`malformed ${path.relative(ROOT, UPSTREAM_JSON_PATH)}: need repository/package and a full 40-character commit SHA`)
  }
  const candidates = []
  if (process.env.PI_UPSTREAM_REPO) candidates.push(process.env.PI_UPSTREAM_REPO)
  candidates.push(path.join(process.env.HOME ?? '', 'project', 'pi'))
  for (const repo of candidates) {
    if (!existsSync(path.join(repo, '.git'))) continue
    try {
      execFileSync('git', ['cat-file', '-t', commit], { cwd: repo, stdio: 'ignore' })
      return { repo, packageDir, commit, source: repo, isGit: true }
    } catch {
      // checkout exists but the pinned commit is not present
    }
  }
  // Tarball fallback: codeload tarball of the pinned commit. A local
  // tarball (PI_UPSTREAM_TARBALL) is honored first so the extraction
  // path is testable hermetically (no network).
  const tmp = mkdtempSync(path.join(tmpdir(), 'pi-vendor-diff-'))
  let tarball
  let source
  if (process.env.PI_UPSTREAM_TARBALL) {
    try {
      tarball = readFileSync(process.env.PI_UPSTREAM_TARBALL)
    } catch (error) {
      rmSync(tmp, { recursive: true, force: true })
      throw new Error(`cannot read PI_UPSTREAM_TARBALL: ${error instanceof Error ? error.message : String(error)}`)
    }
    source = process.env.PI_UPSTREAM_TARBALL
  } else {
    const url = `https://codeload.github.com/${repository}/tar.gz/${commit}`
    // NO encoding: the tarball is gzip BINARY — UTF-8 decoding corrupts
    // it and tar fails to extract. maxBuffer must cover the repo tarball
    // (the default 1 MiB would truncate it). PI_UPSTREAM_CURL overrides
    // the curl binary (hermetic tests inject a fake curl).
    const curlBin = process.env.PI_UPSTREAM_CURL ?? 'curl'
    const curl = spawnSync(curlBin, ['-fsSL', url], { maxBuffer: 128 * 1024 * 1024 })
    if (curl.status !== 0) {
      rmSync(tmp, { recursive: true, force: true })
      throw new Error(
        `cannot resolve upstream ${repository}@${commit}: set PI_UPSTREAM_REPO to a checkout containing the pinned commit ` +
          `(or make curl available for the tarball fallback)`,
      )
    }
    tarball = curl.stdout
    source = `codeload ${url}`
  }
  const tar = spawnSync('tar', ['-xz', '-C', tmp, '--strip-components=1'], { input: tarball })
  if (tar.status !== 0) {
    rmSync(tmp, { recursive: true, force: true })
    throw new Error(`failed to extract upstream tarball: ${tar.stderr?.toString() ?? 'tar error'}`)
  }
  // The extracted checkout is OURS: the caller must remove it when done
  // (a local checkout has no cleanup).
  return {
    repo: tmp,
    packageDir,
    commit,
    source,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}

function main() {
  const upstream = resolveUpstream()
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    const entries = manifestEntries(manifest)
    if (entries.length === 0) throw new Error(`manifest ${path.relative(ROOT, MANIFEST_PATH)} has no entries`)
    const sourceEntries = entries.filter(([, , status]) => sourceActive(status))

    // Reverse index: src file -> source-active divergence ids that cover it.
    // Manifest paths carry the `src/` prefix (matching DIVERGENCES.md); the
    // local walk yields paths relative to the fork's src/ root, so normalize.
    const normalize = (file) => (file.startsWith('src/') ? file.slice(4) : file)
    const coveredBy = new Map()
    for (const [id, files] of sourceEntries) {
      for (const file of files) {
        if (!file.startsWith('src/')) continue // non-src paths are not gated
        const list = coveredBy.get(normalize(file)) ?? []
        list.push(id)
        coveredBy.set(normalize(file), list)
      }
    }

    const localFiles = listTsFiles(FORK_SRC)
    const changed = []
    const unchanged = []
    for (const file of localFiles) {
      const local = readFileSync(path.join(FORK_SRC, file), 'utf8')
      const upstreamContent = upstreamBlob(upstream.repo, upstream.packageDir, upstream.commit, file, upstream.isGit)
      if (upstreamContent === undefined || upstreamContent !== local) changed.push(file)
      else unchanged.push(file)
    }

    const failures = []
    const warnings = []
    const unaccounted = changed.filter((file) => !coveredBy.has(file))
    for (const file of unaccounted) {
      failures.push(`UNACCOUNTED divergence: ${file} differs from upstream ${upstream.commit} but no manifest entry covers it`)
    }

    for (const [id, files] of sourceEntries) {
      const srcFiles = files.filter((file) => file.startsWith('src/')).map(normalize)
      if (srcFiles.length === 0) continue
      const allMatch = srcFiles.every((file) => !changed.includes(file))
      if (allMatch) {
        warnings.push(`STALE ledger: ${id} lists ${srcFiles.join(', ')} but every file matches upstream — absorbed or reverted?`)
      }
      for (const file of srcFiles) {
        if (!localFiles.includes(file)) {
          warnings.push(`STALE ledger: ${id} lists ${file} which no longer exists locally`)
        }
      }
    }

    const lines = []
    lines.push(`pi-vendor-diff gate (upstream: ${upstream.source})`)
    lines.push(`  compared ${localFiles.length} local src files against ${upstream.commit}`)
    lines.push(`  changed: ${changed.length}  unchanged: ${unchanged.length}  manifest entries: ${entries.length}`)
    if (failures.length > 0) {
      lines.push('')
      lines.push('FAIL:')
      for (const f of failures) lines.push(`  - ${f}`)
    }
    if (warnings.length > 0) {
      lines.push('')
      lines.push(`WARN${STRICT ? ' (strict: failing)' : ''}:`)
      for (const w of warnings) lines.push(`  - ${w}`)
    }
    if (failures.length === 0 && warnings.length === 0) {
      lines.push('  OK: every local change is covered by the divergence manifest; no stale entries.')
    }
    console.log(lines.join('\n'))

    if (failures.length > 0 || (STRICT && warnings.length > 0)) process.exitCode = 1
  } finally {
    // A tarball-fallback upstream is an extracted temp checkout: remove
    // it on EVERY exit path (success, gate failure, throw).
    upstream.cleanup?.()
  }
}

try {
  main()
} catch (error) {
  console.error(`pi-vendor-diff gate: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
