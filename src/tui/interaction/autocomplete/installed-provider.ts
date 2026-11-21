/**
 * The ONE installed autocomplete provider composition (TSP I-C): the exact
 * wiring the PiTui surface used to build inside `TuiApp.setCommandCompletions`
 * — the base `MentionProvider`, its inline-attachment sink, and the
 * host-first / plugin-fallback delegating wrap with its request-generation and
 * request-scope fences. It moved here VERBATIM so both renderers compose the
 * SAME completion authority from the SAME catalog install; a renderer supplies
 * only the editor-bound inputs it actually has (the live input mode and the
 * inline-attachment acceptance sink).
 *
 * This module owns NO command catalog, NO selection state and NO presentation:
 * it returns an `AutocompleteProvider` plus the base `MentionProvider` the
 * host editor's own inline seat needs. The command registry, the Host claims
 * and the collision health stay in `src/commands.ts`.
 * @module @xmoon76/dsh-pi-tui/tui/interaction/autocomplete/installed-provider
 */

import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
  SlashCommand,
} from '@xmoon76/pi-tui'
import { MentionProvider } from './provider.ts'
import type { InlineAttachmentAcceptance } from './inline-attachment.ts'
import { shellPrefixForMode, type EditorInputMode } from '../editor-input-mode.ts'
import type { HostFilePort, HostFileScope } from '../../../runtime/host-file-port.ts'
import type { HostShellCompletionPort } from '../../../runtime/host-shell-completion-port.ts'
import type { HumanSkillSummary } from '../../../domain/catalog/skill.ts'

/** The plugin autocomplete chain's query shape (the M5 `AutocompleteRegistry`
 *  seam `src/commands.ts` wraps with its own health callbacks). */
export type ExtensionSuggest = (query: {
  lines: readonly string[]
  cursorLine: number
  cursorCol: number
  signal: AbortSignal
  force?: boolean
}) => Promise<{ items: AutocompleteItem[]; prefix: string } | null>

/** The fixed render-time input of the installed provider composition. */
export interface InstalledAutocompleteOptions {
  /** The effective display catalog (Host rows + Client registrations +
   *  merged extension contributions), exactly as the ONE catalog install
   *  computed it. Never a second catalog. */
  readonly commands: readonly SlashCommand[]
  /** The Host-side working directory the fork's path provider is addressed to. */
  readonly cwd: string
  /** The Host-file port that owns `@`-mention discovery; `null` is the
   *  fail-closed no-file-completion seam. */
  readonly fileReferences: HostFilePort | null
  /** The plugin autocomplete chain, consulted only when the host provider has
   *  nothing. */
  readonly extensionSuggest?: ExtensionSuggest
  /** The completion scope, resolved at SUGGESTION time (a session switch never
   *  needs a provider reinstall). */
  readonly scope: HostFileScope | (() => HostFileScope)
  /** The Client-local base for `/image` completion — deliberately separate from
   *  the Host session cwd. */
  readonly localCwd: string | (() => string)
  /** The detached human skill catalog for INLINE skill reference completion —
   *  a read-only presentation cache, never a command claim. */
  readonly skillReferences: readonly HumanSkillSummary[]
  /** The selected backend's Host/Direct shell completion authority. */
  readonly hostShellCompletion: HostShellCompletionPort | undefined
  /** The LIVE editor input mode — the authoritative completion mode. */
  readonly inputMode: () => EditorInputMode
  /** The `fd` finder pin for the Client-local path discovery: `undefined`
   *  probes the Client PATH, `null` forces the bounded local fallback, a
   *  string pins one finder. */
  readonly localFdPath?: string | null
  /** The inline-attachment acceptance sink of the mounted editor. Absent = no
   *  attachment plane on this assembly: an inline acceptance then only inserts
   *  text, exactly like a skill reference. */
  readonly inlineAttachmentAccept?: (acceptance: InlineAttachmentAcceptance) => void
}

/** The composed provider plus the base provider the host editor's own inline
 *  seat reads (`TuiApp` keeps the base for its inline attachment plane). */
export interface InstalledAutocomplete {
  readonly provider: AutocompleteProvider
  readonly base: MentionProvider
}

/** What the ONE catalog install publishes to a renderer that has no PiTui
 *  editor: the same inputs `setCommandCompletions` receives, so the mounted
 *  renderer composes the SAME provider over the SAME catalog. `commands` is
 *  already the renderer's own displayable set (a non-PiTui renderer never
 *  sees a row it could not execute). */
export interface TspCommandCompletionInstallation {
  readonly commands: readonly SlashCommand[]
  readonly cwd: string
  readonly fileReferences: HostFilePort | null
  readonly extensionSuggest?: ExtensionSuggest
  readonly scope: () => HostFileScope
  readonly localCwd: () => string
  readonly skillReferences: readonly HumanSkillSummary[]
  readonly hostShellCompletion: HostShellCompletionPort | undefined
}

/** Compose the installed provider exactly as the PiTui surface composed it:
 *  base provider first, plugin chain only on a `null` host answer, and the
 *  extension's answer bound to the base provider's own stale fence. */
export function createInstalledAutocompleteProvider(
  options: InstalledAutocompleteOptions,
): InstalledAutocomplete {
  const base = new MentionProvider(
    [...options.commands],
    options.cwd,
    options.fileReferences,
    options.inputMode,
    options.scope,
    options.localFdPath,
    options.localCwd,
    options.skillReferences,
    options.hostShellCompletion,
  )
  // The inline attachment acceptance rides THIS provider (the
  // base one owns the strict snapshot; the delegating wrap only forwards
  // applyCompletion, so either installation must install the same sink).
  base.setInlineAttachmentAcceptSink(options.inlineAttachmentAccept)
  const extensionSuggest = options.extensionSuggest
  if (extensionSuggest === undefined) {
    return { provider: base, base }
  }
  // A delegating provider: the host's own completions run FIRST; the
  // plugin chain (M5 AutocompleteRegistry) is consulted only when the
  // host provider has nothing. applyCompletion always delegates to the
  // host provider (the fork's completion semantics own the editor).
  // HOST EXECUTION MODE (review round 23): the provider is attached to
  // the HOST editor, and every forwarded key into it (the declined-key
  // fallback) re-DECODES the visible plugin wire document into the host
  // editor's mode first — so the host editor's mode is the
  // authoritative completion mode. Reading the VISIBLE seat mode here
  // would see a mode-less plugin and drop the shell semantics of a
  // declined `!gi` Tab (no shell completion, no `!` wire prefix in the
  // extension query).
  const getMode = options.inputMode
  const delegated: AutocompleteProvider = {
    async getSuggestions(lines, cursorLine, cursorCol, queryOptions) {
      // THIS delegated request's generation AND scope: minted/captured
      // synchronously at entry (before ANY await), so both the host
      // result and the extension's answer bind to THIS request — never to
      // a newer one that started while the extension was in flight, and
      // never to a session/workspace that switched mid-request.
      const requestGeneration = base.mintRequestGeneration()
      const requestScope = base.scopeAtRequestTime()
      const requestMode = getMode()
      const requestLocalCwd = base.localCwdAtRequestTime()
      const host = await base.getSuggestionsForGeneration(requestGeneration, lines, cursorLine, cursorCol, queryOptions, requestMode, requestLocalCwd)
      if (host !== null) return host
      // Preserve the shell-mode natural-trigger suppression: a leading
      // `/` on ANY line of a shell-mode document is a PATH, and the
      // host provider deliberately stays quiet until Tab — the plugin
      // chain must not flash its suggestions over it (that would
      // reopen the dropdown mid-typing and double-apply on the next
      // Tab). The wire query below still carries the prefix on line 0
      // only.
      const mode = requestMode
      if (mode !== 'prompt' && queryOptions.force !== true
        && (lines[cursorLine] ?? '').startsWith('/')) {
        return null
      }
      // M5 Stable-compatibility adapter: the plugin chain's query is
      // the WIRE document — the same lines the host exposed BEFORE the
      // shell-editor-mode feature. A shell-mode body is re-prefixed
      // (`git che` → `!git che`, cursor shifted), so a third-party
      // plugin keeps parsing shell lines exactly as before and can
      // still tell a shell line from plain prose; the query shape is
      // unchanged (no new fields, no semantic drift).
      const prefix = shellPrefixForMode(mode)
      // The wire document carries the shell prefix on LINE 0 only: a
      // body continuation line is ordinary text in the wire form too,
      // and only the first-line cursor shifts by the prefix.
      const wireLines = mode === 'prompt'
        ? lines
        : lines.map((line, index) => index === 0 ? prefix + line : line)
      const result = await extensionSuggest({
        lines: wireLines,
        cursorLine,
        cursorCol: cursorCol + (mode === 'prompt' || cursorLine > 0 ? 0 : prefix.length),
        signal: queryOptions.signal,
        force: queryOptions.force,
      })
      // The EXTENSION's suggestions bind the host's stale fence too:
      // the base provider owns the apply-time document/cursor snapshot,
      // and a list the extension produced must be computed against the
      // SAME editor state + scope (plan §9.2 — a stale ext accept must
      // never modify a later edit, and an old session's candidate must
      // never be accepted under a switched session).
      return base.captureRequestSnapshot(requestGeneration, requestScope, lines, cursorLine, cursorCol, result, requestMode, requestLocalCwd)
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
      // A Stable plugin computes its prefix on the WIRE document it
      // received (line 0 carries the synthetic `!` / `!!`), so its
      // prefix may include it (`!ch` for the wire line `!ch`).
      // Normalize back to BARE coordinates before the host apply — the
      // base adapter adds its own virtual prefix and strips it exactly
      // once; a doubled prefix would corrupt the result. The strip
      // applies ONLY when the prefix starts at the WIRE line start
      // (cursorCol + synthetic length − prefix length === 0): a
      // mid-body `!` token (e.g. `echo !ch`) is a literal document
      // character and must never be stripped.
      const mode = getMode()
      const synthetic = mode === 'prompt' ? 0 : shellPrefixForMode(mode).length
      const stripWirePrefix = mode !== 'prompt' && cursorLine === 0 && synthetic > 0
        && (prefix.startsWith('!!') || prefix.startsWith('!'))
        && cursorCol + synthetic - prefix.length === 0
      const barePrefix = stripWirePrefix
        ? prefix.slice(prefix.startsWith('!!') ? 2 : 1)
        : prefix
      return base.applyCompletion(lines, cursorLine, cursorCol, item, barePrefix)
    },
    shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
      base.shouldTriggerFileCompletion(lines, cursorLine, cursorCol),
  }
  return { provider: delegated, base }
}
