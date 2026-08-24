#!/usr/bin/env node
/**
 * @xmoon76/dsh-pi-tui/scripts/client-boundary-gate — CI guard for the
 * server/client migration (AGENTS.md "Server/client migration guardrails
 * (hard rules)"): new feature code must not add direct Host coupling outside
 * the approved boundary. The gate is "baseline allowlist + no-new-debt": the
 * current (file, pattern) pairs are frozen in
 * scripts/client-boundary-baseline.json, and any NEW pair fails. Existing
 * coupling may stay on the allowlist until its owning migration phase moves
 * it (docs/client-server-coupling.md); the baseline is updated deliberately
 * by a maintainer when a phase legitimately relocates coupling, never to
 * absorb new debt.
 *
 * Patterns cover the Host services the migration must isolate (the plan's
 * coupling inventory): `ctx.get('service')`, `ctx.<service>` property
 * access, and `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-session` type
 * imports (Agent / AgentHandle / Session). Cordis process services with no
 * Host business state (`loader`, `appExit`) and the TUI's own services
 * (`TUI_STARTUP_SERVICE`, `PI_TUI_EXTENSIONS_SERVICE`) are deliberately NOT
 * patterns — they are not migration coupling.
 *
 * Usage:
 *   node scripts/client-boundary-gate.mjs            # check (CI; exit 1 on new debt)
 *   node scripts/client-boundary-gate.mjs --report   # print the current inventory
 * @module client-boundary-gate
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_PATH = join(ROOT, 'scripts', 'client-boundary-baseline.json')

// Host services the migration must isolate. Keep in sync with
// docs/client-server-coupling.md.
export const HOST_SERVICES = [
  'agents',
  'sessions',
  'subagents',
  'jobs',
  'credentials',
  'userQuestions',
  'agentPresets',
  'sessionQuery',
  'sessionPersistence',
  'sessionTitle',
  'commands',
  'tools',
  'skills',
  'attachments',
  'llm',
  'settings',
  'approval',
  'authorization',
  'permissionPresets',
  'tokenMeter',
  'agentDefaultModel',
  'workspaceRegistry',
  'directoryPicker',
  'goal',
  'planMode',
  'sandboxPolicy',
  'shell',
]

const SERVICE_ALT = HOST_SERVICES.join('|')
const PATTERNS = [
  // ctx.get('service') — the dominant access form in this codebase.
  { key: (m) => m[1], re: new RegExp(`ctx\\.get\\(['"](${SERVICE_ALT})['"]`) },
  // ctx.<service> property access (would throw without inject; still debt).
  { key: (m) => m[1], re: new RegExp(`ctx\\.(${SERVICE_ALT})\\b`) },
  // Concrete Host object types.
  { key: () => 'import:dsh-agent', re: /@deepseek-ai\/dsh-agent/ },
  { key: () => 'import:dsh-session', re: /@deepseek-ai\/dsh-session/ },
]

/** True when the line is (heuristically) inside a comment. */
function isCommentLine(line) {
  const t = line.trim()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*/')
}

/**
 * Scan a directory tree for Host-coupling patterns in non-comment code
 * lines. Returns a map of `src/...`-style relative path -> Set of matched
 * pattern keys (service names or import markers).
 * @param {string} dir directory to scan
 * @param {string} [base] base for relative paths (defaults to dir)
 * @returns {Record<string, string[]>}
 */
export function scanTree(dir, base = dir) {
  const out = {}
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue
        walk(p)
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.mts')) {
        const rel = relative(base, p).split('\\').join('/')
        const hits = new Set()
        const lines = readFileSync(p, 'utf8').split('\n')
        for (const line of lines) {
          if (isCommentLine(line)) continue
          for (const { key, re } of PATTERNS) {
            const m = line.match(re)
            if (m) hits.add(key(m))
          }
        }
        if (hits.size > 0) out[rel] = [...hits].sort()
      }
    }
  }
  walk(dir)
  return out
}

/** Load the checked-in baseline (missing file = empty baseline). */
export function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return {}
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
}

/**
 * Compare a scanned inventory against the baseline. Returns the list of NEW
 * (file, pattern) pairs — the no-new-debt violations.
 * @param {Record<string, string[]>} scanned
 * @param {Record<string, string[]>} baseline
 * @returns {string[]}
 */
export function findNewDebt(scanned, baseline) {
  const debt = []
  for (const [file, patterns] of Object.entries(scanned)) {
    const allowed = new Set(baseline[file] ?? [])
    for (const pattern of patterns) {
      if (!allowed.has(pattern)) debt.push(`${file}: ${pattern}`)
    }
  }
  return debt
}

function main() {
  const scanned = scanTree(join(ROOT, 'src'))
  if (process.argv.includes('--report')) {
    for (const [file, patterns] of Object.entries(scanned).sort()) {
      console.log(`${file}: ${patterns.join(', ')}`)
    }
    console.log(`\n${Object.keys(scanned).length} file(s) with Host coupling.`)
    return
  }
  const baseline = loadBaseline()
  const debt = findNewDebt(scanned, baseline)
  if (debt.length > 0) {
    console.error('client-boundary-gate: NEW Host coupling outside the approved boundary:')
    for (const d of debt) console.error(`  ${d}`)
    console.error('\nSee AGENTS.md "Server/client migration guardrails" and docs/client-server-coupling.md.')
    process.exit(1)
  }
  console.log(`client-boundary-gate: ok (${Object.keys(scanned).length} file(s), no new Host coupling)`)
}

if (process.argv[1] && relative(ROOT, process.argv[1]).replace(/\\/g, '/') === 'scripts/client-boundary-gate.mjs') {
  main()
}
