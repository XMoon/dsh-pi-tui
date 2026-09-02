#!/usr/bin/env node
/**
 * pi-vendor-diff gate: verify the vendored fork's src/ against the PINNED
 * upstream baseline (packages/pi-tui/UPSTREAM.json) and the machine-readable
 * divergence manifest (packages/pi-tui/vendor-divergences.json).
 *
 * The gate exists because "docs says only a few divergences" is not the same
 * as "actual source diff": every re-vendor must prove that every local change
 * is accounted for in the ledger, and that the ledger is not stale.
 *
 * Rules:
 *   1. FAIL — a local src file whose blob differs from the pinned upstream
 *      blob (or that does not exist upstream) is not covered by any manifest
 *      entry. This is an UNACCOUNTED divergence: the ledger must be updated
 *      (or the change reverted) before the migration can be called settled.
 *   2. WARN — a manifest entry whose src files ALL match upstream. The
 *      divergence may have been absorbed upstream or accidentally reverted;
 *      the ledger entry is stale. (--strict promotes this to a failure.)
 *   3. WARN — a manifest entry listing a src file that no longer exists
 *      locally. (--strict promotes this to a failure.)
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
const MANIFEST_PATH = path.join(ROOT, 'packages', 'pi-tui', 'vendor-divergences.json')

const STRICT = process.argv.includes('--strict')

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

/** Read the upstream blob for one src file at the pinned commit. */
function upstreamBlob(repo, packageDir, commit, file) {
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

/** Resolve the upstream src directory; returns { repo, packageDir, commit } or throws. */
function resolveUpstream() {
  const upstream = JSON.parse(readFileSync(UPSTREAM_JSON_PATH, 'utf8'))
  const { repository, package: packageDir, commit } = upstream
  if (typeof repository !== 'string' || typeof packageDir !== 'string' || typeof commit !== 'string') {
    throw new Error(`malformed ${path.relative(ROOT, UPSTREAM_JSON_PATH)}: need repository/package/commit`)
  }
  const candidates = []
  if (process.env.PI_UPSTREAM_REPO) candidates.push(process.env.PI_UPSTREAM_REPO)
  candidates.push(path.join(process.env.HOME ?? '', 'project', 'pi'))
  for (const repo of candidates) {
    if (!existsSync(path.join(repo, '.git'))) continue
    try {
      execFileSync('git', ['cat-file', '-t', commit], { cwd: repo, stdio: 'ignore' })
      return { repo, packageDir, commit, source: repo }
    } catch {
      // checkout exists but the pinned commit is not present
    }
  }
  // Network fallback: codeload tarball of the pinned commit.
  const tmp = mkdtempSync(path.join(tmpdir(), 'pi-vendor-diff-'))
  const url = `https://codeload.github.com/${repository}/tar.gz/${commit}`
  const curl = spawnSync('curl', ['-fsSL', url], { encoding: 'utf8' })
  if (curl.status !== 0) {
    rmSync(tmp, { recursive: true, force: true })
    throw new Error(
      `cannot resolve upstream ${repository}@${commit}: set PI_UPSTREAM_REPO to a checkout containing the pinned commit ` +
        `(or make curl available for the tarball fallback)`,
    )
  }
  const tar = spawnSync('tar', ['-xz', '-C', tmp, '--strip-components=1'], { input: curl.stdout })
  if (tar.status !== 0) {
    rmSync(tmp, { recursive: true, force: true })
    throw new Error(`failed to extract upstream tarball: ${tar.stderr?.toString() ?? 'tar error'}`)
  }
  return { repo: tmp, packageDir, commit, source: `codeload ${url}` }
}

function main() {
  const upstream = resolveUpstream()
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  const entries = Object.entries(manifest).filter(([id]) => !id.startsWith('_'))
  if (entries.length === 0) throw new Error(`manifest ${path.relative(ROOT, MANIFEST_PATH)} has no entries`)

  // Reverse index: src file -> divergence ids that cover it. Manifest
  // paths carry the `src/` prefix (matching DIVERGENCES.md); the local
  // walk yields paths relative to the fork's src/ root, so normalize.
  const normalize = (file) => (file.startsWith('src/') ? file.slice(4) : file)
  const coveredBy = new Map()
  for (const [id, files] of entries) {
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
    const upstreamContent = upstreamBlob(upstream.repo, upstream.packageDir, upstream.commit, file)
    if (upstreamContent === undefined || upstreamContent !== local) changed.push(file)
    else unchanged.push(file)
  }

  const failures = []
  const warnings = []
  const unaccounted = changed.filter((file) => !coveredBy.has(file))
  for (const file of unaccounted) {
    failures.push(`UNACCOUNTED divergence: ${file} differs from upstream ${upstream.commit} but no manifest entry covers it`)
  }

  for (const [id, files] of entries) {
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
}

try {
  main()
} catch (error) {
  console.error(`pi-vendor-diff gate: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
