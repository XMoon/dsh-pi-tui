/**
 * The TUI mode's command-line provider: parses the `dsh --profile pi-tui` flag
 * family and provides the parsed values as {@link TUI_STARTUP_SERVICE}.
 * Mirrors the web bundle's startup shape: an ordinary plugin injecting
 * `cmdlineArgs`, providing a service that flag-configured rows inject.
 * @module @xmoon76/dsh-pi-tui/startup
 */

import { Command } from 'commander'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

// ── Inline version helpers (startup must stay a ZERO-DEPENDENCY island) ────
//
// The startup row is the loader's FIRST line and the ONLY place that runs
// before the authorization row is imported. If this module shared any code
// with the rest of the bundle (src/dsh-version.ts is used by builtins and
// the runner), the bundler would fold it into the shared chunk that ALSO
// carries src/authorization.ts — whose `@deepseek-ai/dsh-authorization`
// import cannot resolve on a pre-rc.1 harness, so the startup row would
// fail at IMPORT time and the friendly gate below would never run. Keep
// the gate's own dsh-version parsing and the semver comparison INLINE here
// (same logic as src/dsh-version.ts; guarded by the same tests).

/** The installed dsh version, resolved from the launcher's real path. */
function installedDshVersion(): string | undefined {
  const bin = process.argv[1]
  if (bin === undefined) return undefined
  try {
    let dir = dirname(realpathSync(bin))
    for (let depth = 0; depth < 8; depth += 1) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string }
        if (pkg.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string') return pkg.version
      } catch {
        // Not a manifest directory; keep walking up.
      }
      const parent = dirname(dir)
      if (parent === dir) return undefined
      dir = parent
    }
  } catch {
    // Unreadable launcher path: the gate cannot prove incompatibility.
  }
  return undefined
}

/** Prerelease-aware `a >= b` (semver ordering; mirrors src/dsh-version.ts). */
function versionAtLeast(version: string, minimum: string): boolean {
  const parse = (value: string): { nums: number[]; pre: string[] } => {
    const [core, prerelease = ''] = value.split('-')
    return { nums: core.split('.').map(Number), pre: prerelease === '' ? [] : prerelease.split('.') }
  }
  const a = parse(version)
  const b = parse(minimum)
  for (let i = 0; i < 3; i += 1) {
    const pa = a.nums[i] ?? 0
    const pb = b.nums[i] ?? 0
    if (pa !== pb) return pa > pb
  }
  if (a.pre.length === 0) return true
  if (b.pre.length === 0) return false
  const length = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < length; i += 1) {
    const pa = a.pre[i]
    const pb = b.pre[i]
    if (pa === undefined) return false
    if (pb === undefined) return true
    if (pa === pb) continue
    const na = Number(pa)
    const nb = Number(pb)
    const naNumeric = !Number.isNaN(na)
    const nbNumeric = !Number.isNaN(nb)
    if (naNumeric && nbNumeric) return na > nb
    if (naNumeric !== nbNumeric) return !naNumeric
    return pa > pb
  }
  return true
}

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** One incompatible dsh harness range and the guidance it deserves. Add a
 * new entry here whenever a future bundle release stops supporting an
 * older (or newer) harness line; entries are checked in ORDER and the
 * first whose range covers the installed dsh version wins.
 *
 * Range semantics: `min` is inclusive, `max` is EXCLUSIVE. An entry with
 * only `max` covers everything below it (the common "too old" case); an
 * entry with only `min` covers everything at or above it ("too new" —
 * e.g. a harness that removed a seam we still use).
 *
 * `since` names the bundle release line that FIRST imposed the constraint:
 * it is shown as the fallback version label (`>= <since>`) when the
 * bundle's own version cannot be read, so the message stays truthful.
 */
export interface HarnessCompatEntry {
  /** Inclusive lower bound of the incompatible range; absent = unbounded below. */
  min?: string
  /** Exclusive upper bound of the incompatible range; absent = unbounded above. */
  max?: string
  /** The bundle release line that first required this constraint. */
  since: string
  /** Human-readable requirement, e.g. `DeepSeek Harness 0.1.2-alpha.4 or later`. */
  requires: string
  /** The target DSH version to install when the current runtime is too old. */
  upgradeDsh?: string
  /** The compatible TUI line to install when keeping an old DSH runtime. */
  fallbackTui?: string
  /** Special guidance for a range that is not covered by the normal recovery
   * commands, such as an unvalidated future DSH line. */
  guidance?: string
}

/** The compatibility table. */
export const HARNESS_COMPAT: readonly HarnessCompatEntry[] = [
  // 0.4 is a new runtime line. Do not retain the historical 0.3 floor here:
  // the first matching entry is the user-facing source of truth for this
  // artifact, and older guidance would recommend an unusable 0.1.1 runtime.
  //
  // The rc.1 floor splits the too-old range in three: runtimes on the
  // alpha.4/alpha.5 baseline fall back to the last 0.4 prerelease that
  // still accepts them, the alpha.2/alpha.3 baseline falls back to
  // 0.4.0-alpha.1, and everything older belongs on the 0.3 line.
  {
    min: '0.1.2-alpha.4',
    max: '0.1.2-rc.1',
    since: '0.4.0',
    requires: 'DeepSeek Harness 0.1.2-rc.1 or later',
    upgradeDsh: '0.1.2-rc.1',
    fallbackTui: '0.4.0-alpha.2',
  },
  {
    min: '0.1.2-alpha.2',
    max: '0.1.2-alpha.4',
    since: '0.4.0-alpha.2',
    requires: 'DeepSeek Harness 0.1.2-alpha.4 or later',
    upgradeDsh: '0.1.2-rc.1',
    fallbackTui: '0.4.0-alpha.1',
  },
  {
    max: '0.1.2-alpha.2',
    since: '0.4.0-alpha.1',
    requires: 'DeepSeek Harness 0.1.2-alpha.2 or later',
    upgradeDsh: '0.1.2-rc.1',
    fallbackTui: '0.3',
  },
]

/** The compat entry covering the installed dsh version, or undefined when
 * the harness is supported. */
export function harnessCompatEntryFor(installed: string): HarnessCompatEntry | undefined {
  return HARNESS_COMPAT.find(entry =>
    (entry.min === undefined || versionAtLeast(installed, entry.min))
    && (entry.max === undefined || !versionAtLeast(installed, entry.max)))
}

/** The bundle's own version label for the gate message, read from
 * package.json at runtime (never hardcoded). Falls back to the release
 * line that first imposed the requirement when unreadable. */
export function bundleVersionLabel(since: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version?: string }
    return pkg.version === undefined || pkg.version === '' ? `>= ${since}` : `v${pkg.version}`
  } catch {
    return `>= ${since}`
  }
}

/** The actionable compatibility notice printed when the installed harness
 * falls in an incompatible range. `entry` MUST be the entry
 * {@link harnessCompatEntryFor} matched for `installed`. The notice is
 * advisory: DSH Loader mounts profile entries concurrently, so this row cannot
 * guarantee that its output precedes another row's import failure. */
export function incompatibleHarnessMessage(installed: string, entry: HarnessCompatEntry): string {
  const recovery: string[] = []
  if (entry.upgradeDsh !== undefined) {
    recovery.push(
      'Upgrade DeepSeek Harness:',
      `  npm install -g @deepseek-ai/dsh@${entry.upgradeDsh}`,
    )
  }
  if (entry.fallbackTui !== undefined) {
    recovery.push(
      'Or keep your current Harness and use the compatible TUI line:',
      `  dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@${entry.fallbackTui}`,
    )
  }
  if (entry.guidance !== undefined) recovery.push(entry.guidance)
  return [
    `dsh-pi-tui ${bundleVersionLabel(entry.since)} requires ${entry.requires},`,
    `but this installation is running dsh ${installed}.`,
    '',
    ...(recovery.length === 0 ? [] : ['Choose one:', '', ...recovery]),
    'Then re-run: dsh --profile pi-tui',
  ].join('\n')
}

/** Service provided by this plugin and injected by the TUI runner row. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** What the runner row reads from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
  /** `--session`, absent when the invocation did not name one. */
  sessionId?: string
  /** `--preset`, the agent preset a fresh session starts on. */
  presetId?: string
}

/** This app's command: its flags, its description, and its help text. */
function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile pi-tui')
    .description('Run the DeepSeek Harness terminal UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--session <id>', 'resume an existing session instead of creating one')
    .option('--preset <id>', 'agent preset for a fresh session (falls back to $DSH_PI_TUI_PRESET, then the saved default)')
    .addHelpText('after', `
Examples:
  dsh --profile pi-tui                       start the terminal UI
  dsh --profile pi-tui --session <id>        resume an existing session
  dsh --profile pi-tui --preset minimal      fresh session on the minimal preset
`)
}

/**
 * Parse and provide the TUI invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named; on `--help`
 * nothing is provided, so no TUI row mounts.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    // Startup compatibility notice: an incompatible harness (see
    // HARNESS_COMPAT) is outside this bundle's peer window, but this row must
    // not make the loader's concurrent mount ordering part of the contract.
    // Print the actionable upgrade/rollback guidance when we can prove the
    // installed version, then let the normal incompatible import boundary (or
    // the package peer contract) determine the actual nonzero outcome.
    // `--help` never reaches the action; an unresolvable launcher version is
    // let through because the notice cannot prove incompatibility.
    const installed = installedDshVersion()
    if (installed !== undefined) {
      const entry = harnessCompatEntryFor(installed)
      if (entry !== undefined) {
        const message = incompatibleHarnessMessage(installed, entry)
        process.stderr.write(`\n${message}\n\n`)
      }
    }
    const options = program.opts<{ session?: string; preset?: string }>()
    ctx.provide(TUI_STARTUP_SERVICE, {
      ...(options.session !== undefined ? { sessionId: options.session } : {}),
      ...(options.preset !== undefined ? { presetId: options.preset } : {}),
    } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}
