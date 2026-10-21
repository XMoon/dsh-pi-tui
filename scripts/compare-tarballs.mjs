#!/usr/bin/env node
/**
 * The PACK EQUIVALENCE PROOF: two tarballs carry the same artifact.
 *
 * A CI-only fast pack — one that skips the `prepack` lifecycle because the
 * tests already ran in separate shard jobs — is only acceptable if the
 * package it produces is the SAME package the ordinary `pnpm pack` produces.
 *
 * "The same" does not mean the same bytes: a tarball embeds timestamps and
 * the gzip level, so two honest packs of the same tree differ byte for
 * byte. What must be equal is the CONTENT:
 *
 *   - the list of tar entries (the same paths, no more and no fewer);
 *   - the digest of every extracted file (the same bytes);
 *   - the manifest metadata a consumer can observe: the version, the
 *     exports map, the peers, the types entry and the bundled files.
 *
 * The comparison is therefore over the UNPACKED content, and the report
 * says so, so nobody can read a byte difference as a content difference.
 *
 * Usage:
 *   node scripts/compare-tarballs.mjs --a first.tgz --b second.tgz [--out report.json]
 * @module @xmoon76/dsh-pi-tui/scripts/compare-tarballs
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The digest of one file's bytes. */
function digestOf(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * The content of one tarball: its entry list and the digest of every
 * extracted file.
 *
 * The tarball is unpacked into a disposable directory, so the comparison
 * is over the real files a consumer would install — not over the archive
 * metadata, which legitimately varies between two honest packs.
 */
function unpack(tarball) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-tarball-'))
  execFileSync('tar', ['-xzf', tarball, '-C', root], { stdio: 'pipe' })
  const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .sort()
  return { root, entries }
}

/** The observable manifest fields of an unpacked package. */
function manifestOf(root) {
  const manifestPath = join(root, 'package', 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  return {
    name: manifest.name,
    version: manifest.version,
    exports: manifest.exports,
    types: manifest.types,
    peerDependencies: manifest.peerDependencies,
    dependencies: manifest.dependencies,
    bin: manifest.bin,
    files: manifest.files,
    engines: manifest.engines,
  }
}

/** The digest of every file under the unpacked package. */
function fileDigests(root) {
  const out = new Map()
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(absolute, relative)
      else out.set(relative, digestOf(absolute))
    }
  }
  walk(root, '')
  return out
}

function main() {
  const args = process.argv.slice(2)
  const aIndex = args.indexOf('--a')
  const bIndex = args.indexOf('--b')
  const outIndex = args.indexOf('--out')
  if (aIndex === -1 || bIndex === -1) {
    console.error('usage: node scripts/compare-tarballs.mjs --a <tarball> --b <tarball> [--out <file>]')
    process.exit(2)
  }
  const tarballA = resolve(args[aIndex + 1])
  const tarballB = resolve(args[bIndex + 1])

  const a = unpack(tarballA)
  const b = unpack(tarballB)
  try {
    const digestsA = fileDigests(a.root)
    const digestsB = fileDigests(b.root)

    const onlyA = [...digestsA.keys()].filter(name => !digestsB.has(name)).sort()
    const onlyB = [...digestsB.keys()].filter(name => !digestsA.has(name)).sort()
    const differing = [...digestsA.keys()]
      .filter(name => digestsB.has(name) && digestsA.get(name) !== digestsB.get(name))
      .sort()

    const manifestA = manifestOf(a.root)
    const manifestB = manifestOf(b.root)
    const manifestDifferences = Object.keys(manifestA).filter(
      key => JSON.stringify(manifestA[key]) !== JSON.stringify(manifestB[key]),
    )

    const report = {
      tarballA,
      tarballB,
      entryCountA: a.entries.length,
      entryCountB: b.entries.length,
      entriesEqual: JSON.stringify(a.entries) === JSON.stringify(b.entries),
      fileCountA: digestsA.size,
      fileCountB: digestsB.size,
      onlyInA: onlyA,
      onlyInB: onlyB,
      differingFiles: differing,
      manifestDifferences,
      equivalent: onlyA.length === 0
        && onlyB.length === 0
        && differing.length === 0
        && manifestDifferences.length === 0
        && JSON.stringify(a.entries) === JSON.stringify(b.entries),
    }

    if (outIndex !== -1) {
      writeFileSync(args[outIndex + 1], `${JSON.stringify(report, null, 2)}\n`)
    }
    console.log(`tarball A        ${tarballA}`)
    console.log(`tarball B        ${tarballB}`)
    console.log(`entries          ${report.entryCountA} / ${report.entryCountB} (equal: ${report.entriesEqual})`)
    console.log(`files            ${report.fileCountA} / ${report.fileCountB}`)
    console.log(`only in A        ${onlyA.length}`)
    console.log(`only in B        ${onlyB.length}`)
    console.log(`differing files  ${differing.length}`)
    console.log(`manifest diffs   ${manifestDifferences.length}${manifestDifferences.length === 0 ? '' : ` (${manifestDifferences.join(', ')})`}`)
    for (const name of onlyA.slice(0, 10)) console.log(`  - only in A: ${name}`)
    for (const name of onlyB.slice(0, 10)) console.log(`  - only in B: ${name}`)
    for (const name of differing.slice(0, 10)) console.log(`  - differs:   ${name}`)

    if (!report.equivalent) {
      console.error('\nthe two tarballs are NOT equivalent')
      process.exit(1)
    }
    console.log('\nthe two tarballs carry the same content')
  } finally {
    rmSync(a.root, { recursive: true, force: true })
    rmSync(b.root, { recursive: true, force: true })
  }
}

main()
