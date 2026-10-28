#!/usr/bin/env node
/**
 * WHEN the pack-equivalence proof must run again.
 *
 * A lifecycle-free `pnpm pack` is only acceptable because its CONTENT equals
 * an ordinary `pnpm pack`'s. That equality is not a permanent property of the
 * repository: it depends on the packaging inputs. A change to the manifest's
 * `files`/`exports`, the pnpm version, the preset generator or the build
 * configuration can break it without breaking any test.
 *
 * The Owner's ruling is that the comparison is a GATED PROPERTY with a
 * re-qualification trigger — not a per-run cost. This script is that trigger:
 * it digests exactly the inputs the equality depends on, and a difference
 * means the proof is STALE and must be re-run.
 *
 * What is deliberately NOT here, and what replaced an earlier exclusion:
 *
 *   - the repository's source code. A source change that alters the built
 *     output does not change the RELATION between the two pack paths: both
 *     consume whatever `dist` the build produced. The relation depends on how
 *     the package is assembled, not on what happens to be inside it.
 *   - the lockfile is INCLUDED. It was excluded at first on the argument that
 *     it only changes a consumer's dependency versions — but the ordinary
 *     pack runs `prepack`, whose build toolchain comes from the lockfile, so
 *     a lockfile change can change the payload while the proof still claimed
 *     to cover it.
 *
 * Usage:
 *   node scripts/pack-equivalence-input.mjs --write <file>
 *   node scripts/pack-equivalence-input.mjs --check <file>
 * @module @xmoon76/dsh-pi-tui/scripts/pack-equivalence-input
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The packaging inputs the equality depends on.
 *
 * Each entry says WHY it belongs: a file that could change which files end up
 * in the tarball, or how the manifest is rewritten.
 */
const INPUTS = [
  // `files`, `exports`, `types`, `bin`, dependencies, the lifecycle scripts
  // and the pinned package manager all decide the package's shape.
  { path: 'package.json', why: 'the manifest decides what is packed and how it is rewritten' },
  // The bundle build decides `dist/**`, which IS the package's payload.
  { path: 'tsdown.config.ts', why: 'the bundle build decides the payload files' },
  // The generated presets are part of the payload.
  { path: 'scripts/generate-dsh-presets.mjs', why: 'the generated presets are part of the payload' },
  // An ignore file changes which files the packer includes, if present.
  { path: '.npmignore', why: 'an ignore file changes which files are packed', optional: true },
  // The lockfile pins not only a consumer's dependency versions but the
  // build TOOLCHAIN that produces the payload. Excluding it would let a
  // toolchain bump change what is built while the proof still claimed to
  // cover it.
  { path: 'pnpm-lock.yaml', why: 'the lockfile pins the build toolchain that produces the payload' },
  // Workspace layout decides how pnpm resolves and packs.
  { path: 'pnpm-workspace.yaml', why: 'the workspace layout decides how pnpm resolves and packs', optional: true },
  // The COMPARATOR decides what "equivalent" means. A changed comparator
  // could stop noticing a difference the old one caught.
  { path: 'scripts/compare-tarballs.mjs', why: 'the comparator defines what equivalent means' },
  // The PROTOCOL is the two commands being compared. A changed command is a
  // different comparison, so the recorded proof no longer describes it.
  { path: 'scripts/pack-equivalence-protocol.json', why: 'the protocol is the pair of commands being compared' },
]

/**
 * The digest of the current packaging inputs.
 *
 * @returns {{digest: string, inputs: Array<{path: string, present: boolean, sha256: string|null}>}} the identity.
 */
export function packagingInputDigest() {
  const hash = createHash('sha256')
  const inputs = []
  for (const input of INPUTS) {
    const absolute = join(ROOT, input.path)
    const present = existsSync(absolute)
    if (!present) {
      // An ABSENT optional input is part of the identity too: adding or
      // removing it changes how the packer behaves, so the digest must change
      // with its presence, not only with its bytes.
      hash.update(`${input.path}\u0000absent\n`)
      inputs.push({ path: input.path, present: false, sha256: null })
      continue
    }
    const sha256 = createHash('sha256').update(readFileSync(absolute)).digest('hex')
    hash.update(`${input.path}\u0000${sha256}\n`)
    inputs.push({ path: input.path, present, sha256 })
  }
  return { digest: hash.digest('hex'), inputs }
}

/**
 * The DSH SOURCE identity a Source Mode proof is bound to.
 *
 * A source proof must not be reusable when the pinned DSH distribution
 * changes, because the pack's build toolchain and payload can change with it.
 * The identity is read from the artifact `prepare-dsh-source` already
 * produced — this module never fetches or builds DSH to compute it.
 *
 * @param {string} directory - the materialized source distribution directory.
 * @returns {{sourceSha: string, version: string}} the verified identity.
 */
export function readSourceIdentity(directory) {
  const manifestPath = join(directory, 'dsh-source-distribution.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`${manifestPath} is missing; only a VERIFIED source distribution can be proved`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.schemaVersion !== 1) throw new Error('source distribution schemaVersion must be 1')
  if (manifest.mode !== 'source-pack') throw new Error('source distribution mode must be source-pack')
  if (manifest.dirty !== false || manifest.reproducible !== true) {
    throw new Error('source distribution must be clean and reproducible before it can be proved')
  }
  const sourceSha = manifest.sourceSha
  const version = manifest.version
  if (typeof sourceSha !== 'string' || !/^[0-9a-f]{40}$/u.test(sourceSha)) {
    throw new Error('source distribution sourceSha must be a full 40-character commit SHA')
  }
  if (manifest.sourceRef !== sourceSha) throw new Error('source distribution sourceRef must equal sourceSha')
  if (typeof version !== 'string' || version === '') throw new Error('source distribution version must be a string')
  return { sourceSha, version }
}

/** The repository identity a proof must carry, derived from `package.json` so
 * nobody has to hardcode an owner slug in two places. */
function repositorySlug() {
  const url = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).repository?.url
  const match = typeof url === 'string' ? url.match(/github\.com[/:]([^/]+)\/([^/.]+)/u) : null
  if (match === null) throw new Error('package.json repository.url must identify a GitHub repository')
  return `${match[1]}/${match[2]}`
}

/**
 * Whether a recorded proof is EVIDENCE or just a matching digest.
 *
 * Two different questions, and the weaker one must not answer the stronger:
 *
 *   - digest match: the record describes the CURRENT inputs.
 *   - evidence:      the record's numbers came from a real comparison run by CI
 *                    for this repository, so the numbers are not hand-typed.
 *
 * The second is what stops a developer (or an agent) from writing
 * `equivalent: true` by hand and skipping the proof forever. It checks the
 * PROVENANCE the workflow stamps onto every candidate: a run URL inside this
 * repository, a full commit SHA, the platform scope, and the exact fields a
 * real comparison produces. It cannot re-query the run: that would need a token
 * and network in a step whose job is to read a file. It therefore proves
 * provenance SHAPE, and the genuine guarantee stays structural - a candidate is
 * authored only from `packs/pack-equivalence.json`, and cannot be written by a
 * run whose comparison did not pass.
 *
 * @param {object|undefined} proof - the mode's proof.
 * @returns {{trusted: boolean, reason: string}} the verdict.
 */
export function proofEvidenceVerdict(proof) {
  if (proof === undefined || proof === null) return { trusted: false, reason: 'no proof' }
  if (proof.equivalent !== true) return { trusted: false, reason: 'the proof does not assert equivalence' }
  if (!Number.isInteger(proof.entryCount) || proof.entryCount <= 0) {
    return { trusted: false, reason: 'the proof records no entry count' }
  }
  for (const key of ['differingFiles', 'manifestDifferences']) {
    if (!Array.isArray(proof[key])) {
      return { trusted: false, reason: `the proof does not record ${key}, so it did not come from a comparison` }
    }
    if (proof[key].length > 0) return { trusted: false, reason: `the proof records a non-empty ${key}` }
  }
  const run = proof.run
  if (typeof run !== 'string' || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/u.test(run)) {
    return { trusted: false, reason: 'the proof carries no CI run URL' }
  }
  const slug = repositorySlug()
  if (!run.includes(`/${slug}/`)) {
    return { trusted: false, reason: `the proof's run URL is not a ${slug} workflow run` }
  }
  if (typeof proof.commit !== 'string' || !/^[0-9a-f]{40}$/u.test(proof.commit)) {
    return { trusted: false, reason: 'the proof carries no full commit SHA' }
  }
  return { trusted: true, reason: 'the proof carries CI provenance for this repository' }
}

/**
 * The identity a proof must be REPLAYED against for one mode.
 *
 * npm needs no extra binding: the lockfile and manifest is the toolchain. Source
 * additionally binds the pinned DSH commit and version, and the digest of the
 * pack protocol, so a protocol or source move invalidates only that mode's
 * record.
 *
 * @param {{mode?: string, sourceDirectory?: string}} options - the run's mode and source directory.
 * @returns {{mode: string, sourceSha?: string, sourceVersion?: string, protocolDigest: string}} the binding.
 */
export function proofBinding(options = {}) {
  const mode = options.mode ?? 'npm'
  if (mode !== 'npm' && mode !== 'source') throw new Error(`unknown pack-equivalence mode '${mode}'`)
  const protocol = readFileSync(join(ROOT, 'scripts', 'pack-equivalence-protocol.json'))
  const protocolDigest = createHash('sha256').update(protocol).digest('hex')
  if (mode === 'npm') return { mode, protocolDigest }
  if (options.sourceDirectory === undefined) {
    throw new Error('a source proof requires the verified source distribution directory')
  }
  const { sourceSha, version } = readSourceIdentity(options.sourceDirectory)
  return { mode, sourceSha, sourceVersion: version, protocolDigest }
}

/**
 * The mode's record: a baseline carries ONE proof per mode so an npm proof can
 * never be replayed for Source Mode (or the reverse), and a source change does
 * not invalidate the npm record.
 *
 * A legacy single-`proof` record is read as the npm record so an existing
 * committed baseline keeps working.
 *
 * @param {object|undefined} recorded - the parsed baseline.
 * @param {string} mode - the requested mode.
 * @returns {object|undefined} that mode's proof.
 */
export function proofForMode(recorded, mode) {
  if (recorded === undefined || recorded === null) return undefined
  if (recorded.proofs !== undefined) return recorded.proofs?.[mode]
  return mode === 'npm' ? recorded.proof : undefined
}


/**
 * A pack invocation reduced to a comparable form.
 *
 * The workflow writes `--pack-destination "$GITHUB_WORKSPACE"` where the
 * protocol names `<workspace>`, and flag ORDER is not meaningful. Normalising
 * both sides to a sorted token list is what lets a test compare the PROTOCOL
 * with the command the workflow actually runs — without that comparison the
 * protocol is a comment: changing the command would leave the digest
 * untouched and the proof would keep being skipped.
 *
 * @param {string} text - a command line, or the protocol's own string.
 * @returns {string[]} the comparable tokens.
 */
export function normalizePackInvocation(text) {
  return text
    .replace(/"\$GITHUB_WORKSPACE"/gu, '<workspace>')
    .replace(/\$GITHUB_WORKSPACE/gu, '<workspace>')
    .replace(/\s+/gu, ' ')
    .trim()
    .split(' ')
    .sort()
}

/**
 * The recorded proof: the digest, and per input BOTH its bytes' digest and
 * why it matters.
 *
 * Keeping the per-file digests is what makes a later mismatch diagnosable —
 * "the inputs differ" without saying which one is a report that cannot be
 * acted on.
 */
function describe() {
  const { digest, inputs } = packagingInputDigest()
  return {
    digest,
    inputs: inputs.map(entry => ({
      ...entry,
      why: INPUTS.find(input => input.path === entry.path)?.why ?? null,
    })),
  }
}

/**
 * The value of a `--flag <value>` pair.
 *
 * @param {string[]} args - the command line arguments.
 * @param {string} name - the flag.
 * @returns {string|undefined} the value.
 */
/**
 * Evaluate a recorded baseline against the CURRENT packaging inputs.
 *
 * Split out of the CLI so the workflow decision and the tests read the SAME
 * rule instead of restating it. A DIGEST is not a PROOF: matching bytes say the
 * inputs are the ones the file was taken at; they say nothing about whether the
 * comparison was ever run, or whether it PASSED. A record whose proof was
 * deleted, or whose proof says `equivalent: false`, must reopen the question.
 *
 * @param {object|undefined} recorded - the parsed baseline, or undefined when absent.
 * @param {{mode?: string, node?: string, platform?: string}} scope - this run's scope.
 * @returns {{valid: boolean, reason: string, changedInputs?: string[]}} the verdict.
 */
export function evaluateBaseline(recorded, scope = {}) {
  const current = packagingInputDigest()
  const mode = scope.mode ?? 'npm'
  const node = scope.node ?? String(process.versions.node.split('.')[0])
  const platform = scope.platform ?? process.platform
  if (recorded === undefined || recorded === null) {
    return { valid: false, reason: 'no recorded equivalence proof exists' }
  }
  const proof = proofForMode(recorded, mode)
  if (proof === undefined || proof === null) {
    // A proof for ANOTHER mode is not evidence for this one: an npm proof says
    // nothing about a source pack, and the reverse.
    return { valid: false, reason: `no recorded equivalence proof exists for mode '${mode}'` }
  }
  if (proof.equivalent !== true) {
    // The record exists for this mode but does not prove a passing comparison.
    return { valid: false, reason: `the record carries no PASSING equivalence proof for mode '${mode}'` }
  }
  // A matching digest is not evidence: a hand-written `equivalent: true` must
  // never be able to skip the proof permanently.
  const evidence = proofEvidenceVerdict(proof)
  if (!evidence.trusted) {
    return { valid: false, reason: `mode '${mode}' proof is not trustworthy evidence: ${evidence.reason}` }
  }
  // The proof's SCOPE is part of the gate. An npm proof says nothing about a
  // source run, and a Node 24 proof says nothing about another runtime.
  if (proof.mode !== mode) {
    return { valid: false, reason: `the recorded proof is for mode '${proof.mode}', not '${mode}'` }
  }
  if (proof.node !== node) {
    return { valid: false, reason: `the recorded proof is for Node ${proof.node}, not ${node}` }
  }
  // The PLATFORM is part of the scope: `pnpm pack` and the tar layout are
  // platform-dependent, so a Linux proof says nothing about a Windows run.
  if (proof.platform !== platform) {
    return { valid: false, reason: `the recorded proof is for platform '${proof.platform}', not '${platform}'` }
  }
  // The SOURCE identity is checked BEFORE the digest: a moved DSH commit is an
  // identity change, and reporting it as "the packaging inputs differ" would
  // point the reader at the wrong cause.
  if (mode === 'source') {
    if (scope.sourceDirectory === undefined) {
      return { valid: false, reason: 'a source run must supply the verified source distribution directory' }
    }
    let identity
    try {
      identity = readSourceIdentity(scope.sourceDirectory)
    } catch (error) {
      return { valid: false, reason: `the source distribution is not verifiable: ${error.message}` }
    }
    if (proof.sourceSha !== identity.sourceSha) {
      return {
        valid: false,
        reason: `the recorded proof is for DSH source ${proof.sourceSha ?? '(unrecorded)'}, not ${identity.sourceSha}`,
      }
    }
    if (proof.sourceVersion !== identity.version) {
      return {
        valid: false,
        reason: `the recorded proof is for DSH version ${proof.sourceVersion ?? '(unrecorded)'}, not ${identity.version}`,
      }
    }
  }
  // The DIGEST covers the packaging inputs AND the protocol.
  if (recorded.digest !== current.digest) {
    const changed = (recorded.inputs ?? [])
      .filter(input => {
        const now = current.inputs.find(entry => entry.path === input.path)
        return now === undefined || now.sha256 !== (input.sha256 ?? null)
      })
      .map(input => input.path)
    return {
      valid: false,
      reason: `the packaging inputs differ${changed.length > 0 ? ` (${changed.join(', ')})` : ''}`,
      changedInputs: changed,
    }
  }
  return { valid: true, reason: 'the recorded equivalence proof still covers these inputs' }
}

/**
 * The files whose change means "this PR touches packaging" and therefore owes a
 * fresh, REAL comparison even when the baseline happens to match.
 *
 * This is NOT the same question as the digest. The digest answers "do the
 * recorded inputs still describe this tree?"; this answers "is this PR allowed
 * to rely on someone else's proof?". A PR that edits a consumed packaging input
 * must produce its own evidence, so a matching baseline cannot excuse it.
 *
 * The set is derived from INPUTS plus the proof machinery itself: changing the
 * checker, the comparator, the protocol, the baseline, or this digest module
 * can change what "equivalent" MEANS, so none of them may ride an old proof.
 * The workflow is included because it decides whether the comparison runs.
 *
 * @param {string[]} changedPaths - repo-relative paths changed by the PR.
 * @returns {string[]} the changed paths that require a real re-production.
 */
export function packagingEvidenceSensitivePaths(changedPaths) {
  const fixed = [
    // The recorded proof and everything that defines what it proves.
    'scripts/pack-equivalence-baseline.json',
    'scripts/pack-equivalence-input.mjs',
    'scripts/pack-equivalence-protocol.json',
    'scripts/compare-tarballs.mjs',
    // The workflow decides whether the comparison runs at all.
    '.github/workflows/ci.yml',
    // The Source Mode identity. Switching a branch to Source Mode, or moving the
    // pinned DSH source, changes what a source proof must be bound to: without
    // these, the very change that needs a FIRST source proof looks like an
    // unrelated PR and would fail fast instead of producing one.
    'test/compat/dsh-mode.json',
    'test/compat/dsh-source.json',
  ]
  const watched = new Set([...INPUTS.map(input => input.path), ...fixed])
  return [...new Set(changedPaths.filter(path => watched.has(path)))].sort()
}

/**
 * The baseline a successful REAL comparison authorises, ready to be committed.
 *
 * Generated from the comparison report and this run's own inputs so a developer
 * never transcribes a hash: the proof can only be written by a job that
 * actually compared the two packages.
 *
 * @param {object} comparison - the `compare-tarballs.mjs` report.
 * @param {{designation: string, run: string, commit: string}} provenance - where the proof came from.
 * @returns {object} the baseline document.
 */
export function baselineFromComparison(comparison, provenance) {
  const recorded = provenance.recorded
  if (comparison?.equivalent !== true) {
    throw new Error('refusing to author a baseline: the comparison did not prove equivalence')
  }
  for (const key of ['differingFiles', 'manifestDifferences', 'onlyInA', 'onlyInB']) {
    if (!Array.isArray(comparison[key]) || comparison[key].length > 0) {
      throw new Error(`refusing to author a baseline: ${key} is not empty`)
    }
  }
  if (comparison.entryCountA !== comparison.entryCountB) {
    throw new Error('refusing to author a baseline: the two packs do not have the same entry count')
  }
  const current = packagingInputDigest()
  const mode = provenance.mode ?? 'npm'
  const binding = proofBinding({ mode, sourceDirectory: provenance.sourceDirectory })
  const proof = {
    equivalent: true,
    mode,
    node: provenance.node ?? '24',
    platform: provenance.platform ?? 'Linux',
    entryCount: comparison.entryCountA,
    differingFiles: [],
    manifestDifferences: [],
    run: provenance.run,
    commit: provenance.commit,
    ...(mode === 'source'
      ? { sourceSha: binding.sourceSha, sourceVersion: binding.sourceVersion }
      : {}),
  }
  // Preserve the OTHER mode's record when it still describes these inputs: an
  // npm proof must not be destroyed by a source run, or the reverse. A record
  // whose inputs moved is dropped, because re-authoring one mode may not
  // silently re-certify the other.
  const other = mode === 'npm' ? 'source' : 'npm'
  const otherProof = recorded !== undefined
    && recorded.digest === current.digest
    && proofForMode(recorded, other)?.equivalent === true
    ? proofForMode(recorded, other)
    : undefined
  return {
    digest: current.digest,
    inputs: current.inputs.map(entry => ({
      ...entry,
      why: INPUTS.find(input => input.path === entry.path)?.why ?? null,
    })),
    proofs: {
      ...(otherProof === undefined ? {} : { [other]: otherProof }),
      [mode]: proof,
    },
  }
}

function valueOf(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

/** Read a JSON file, or undefined when it does not exist. */
function readOptionalJson(path) {
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8'))
}

function main() {
  const args = process.argv.slice(2)
  const writeIndex = args.indexOf('--write')
  const checkIndex = args.indexOf('--check')
  const baselineIndex = args.indexOf('--baseline')
  if (writeIndex === -1 && checkIndex === -1 && baselineIndex === -1 && !args.includes('--sensitive')) {
    console.error([
      'usage:',
      '  node scripts/pack-equivalence-input.mjs --write <file>',
      '  node scripts/pack-equivalence-input.mjs --check <file> [--mode <m>] [--node <major>] [--platform <p>]',
      '  node scripts/pack-equivalence-input.mjs --baseline <recorded> --comparison <report> --out <file>',
      '       --run <url> --commit <sha> [--mode <m>] [--node <major>] [--platform <p>]',
      '       [--source-distribution <dir>]   (required for --mode source)',
      '  node scripts/pack-equivalence-input.mjs --sensitive [--base <ref>]',
    ].join('\n'))
    process.exit(2)
  }
  if (baselineIndex !== -1) {
    const recorded = readOptionalJson(args[baselineIndex + 1])
    const comparison = readOptionalJson(valueOf(args, '--comparison') ?? '')
    if (comparison === undefined) {
      console.error('--baseline requires --comparison <report> produced by a real comparison')
      process.exit(2)
    }
    const out = valueOf(args, '--out')
    if (out === undefined) {
      console.error('--baseline requires --out <file>')
      process.exit(2)
    }
    const mode = valueOf(args, '--mode') ?? 'npm'
    const document = baselineFromComparison(comparison, {
      recorded,
      mode,
      node: valueOf(args, '--node') ?? String(process.versions.node.split('.')[0]),
      platform: valueOf(args, '--platform') ?? process.platform,
      sourceDirectory: valueOf(args, '--source-distribution'),
      run: valueOf(args, '--run') ?? '(unrecorded run)',
      commit: valueOf(args, '--commit') ?? '(unrecorded commit)',
    })
    writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`)
    console.log(`baseline candidate written to ${out} (digest ${document.digest})`)
    return
  }
  if (args.includes('--sensitive')) {
    const base = valueOf(args, '--base') ?? 'origin/main'
    const diff = spawnSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: ROOT, encoding: 'utf8' })
    if (diff.status !== 0) {
      console.error(`--sensitive could not diff against ${base}:\n${diff.stderr ?? ''}`)
      process.exit(2)
    }
    const changed = diff.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
    const sensitive = packagingEvidenceSensitivePaths(changed)
    console.log(sensitive.length > 0
      ? `sensitive: this branch changes packaging evidence inputs (${sensitive.join(', ')})`
      : 'sensitive: this branch changes no packaging evidence input')
    return
  }
  const current = packagingInputDigest()
  if (writeIndex !== -1) {
    writeFileSync(args[writeIndex + 1], `${JSON.stringify(describe(), null, 2)}\n`)
    console.log(`packaging inputs digest ${current.digest}`)
    return
  }
  const path = args[checkIndex + 1]
  const verdict = evaluateBaseline(readOptionalJson(path), {
    mode: valueOf(args, '--mode'),
    node: valueOf(args, '--node'),
    platform: valueOf(args, '--platform'),
    sourceDirectory: valueOf(args, '--source-distribution'),
  })
  console.log(`${verdict.valid ? 'unchanged' : 'changed'}: ${verdict.reason}`)
  process.exit(verdict.valid ? 0 : 1)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
