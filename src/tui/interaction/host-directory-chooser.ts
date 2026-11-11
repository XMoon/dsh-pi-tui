/**
 * The Session Workspace's inline Host-directory chooser controller.
 *
 * ONE controller owns the private `Input`, the ONE Host home read, the latest
 * prefix query generation and the disposable candidate projection for one
 * inline-editor lifetime. It is a BROWSER only: it never registers a
 * Workspace, never creates a Session and never decides whether a typed path is
 * a real directory — the panel keeps that write transaction and the official
 * Host `resolveWorkspace` remains the final authority.
 *
 * The Host home read and every level query are independent generations with
 * their own `AbortController`: a late result from a replaced connection, a
 * typed-over generation or a disposed editor is inert. The candidate identity
 * is the official `DirectoryEntry.path`; the Client never joins a path itself.
 * @module @xmoon76/dsh-pi-tui/tui/interaction/host-directory-chooser
 */

import { Input, Key, matchesKey } from '@xmoon76/pi-tui'
import type { DirectoryEntry, DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import {
  hostDirectoryCandidateValue,
  hostDirectoryQuery,
  hostDirectorySeparator,
  type HostDirectoryQuery,
  type HostDirectorySeparator,
} from '../../domain/file-completion/host-directory-query.ts'
import type { HostDirectoryBrowsePort } from '../../runtime/host-directory-browse-port.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'

/** The trailing debounce after an editor value change. */
const QUERY_DEBOUNCE_MS = 150

/** The absolute display cap for one suggestion projection. */
export const HOST_DIRECTORY_SUGGESTION_LIMIT = 8

/** ONE official Host child directory, as the editor keeps it. */
export interface HostDirectoryCandidate {
  /** The official `DirectoryEntry.path`: the ONLY candidate identity. */
  readonly path: string
  /** The official `DirectoryEntry.name`: display text only. */
  readonly name: string
  readonly hidden: boolean
}

/** What the panel paints for the editor; a read-only projection, never state. */
export interface HostDirectoryChooserSnapshot {
  readonly raw: string
  readonly status: HostDirectoryChooserStatus
  readonly message?: string
  readonly hostHome?: string
  readonly separator?: HostDirectorySeparator
  /** The current generation's suggestions, capped by the last painted limit. */
  readonly candidates: readonly HostDirectoryCandidate[]
  readonly selectedIndex: number
  /** Every official name matching the typed prefix (before the display cap). */
  readonly totalMatches: number
  /** The official listing's unfiltered child count (0 proves "no children"). */
  readonly listingEntryCount: number
  readonly truncated: boolean
  /** The user hid the suggestions; only a real edit reveals them again. */
  readonly hidden: boolean
}

/**
 * `idle` = blank input (no request); `loading` = the home or the latest level
 * is in flight; `invalid` = the typed value is not absolute for the Host;
 * `failed` = the Host refused the level; `unavailable` = the browse surface
 * itself is unavailable; `error` = an unclassified real read failure.
 */
export type HostDirectoryChooserStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'invalid'
  | 'failed'
  | 'unavailable'
  | 'error'

/** The narrow capabilities one inline editor needs. */
export interface HostDirectoryChooserDeps {
  /** The ONE Host browse read. Absent = this composition has no browse capability. */
  readonly list?: HostDirectoryBrowsePort['list']
  /** Request one current-frame repaint only. */
  readonly onChange: () => void
}

/** The per-open inline Host-directory editor. */
export class HostDirectoryChooser {
  readonly input: Input
  private readonly deps: HostDirectoryChooserDeps
  private readonly hasInitialPath: boolean
  private started = false
  private disposed = false
  private userEdited = false
  private hidden = false
  private hostHome: string | undefined
  private separator: HostDirectorySeparator | undefined
  private status: HostDirectoryChooserStatus = 'idle'
  private message: string | undefined
  private entries: readonly DirectoryEntry[] = []
  private listingEntryCount = 0
  private truncated = false
  private selectedIndex = 0
  private limit = HOST_DIRECTORY_SUGGESTION_LIMIT
  private currentQuery: HostDirectoryQuery | undefined
  private homeGeneration = 0
  private homeAbort: AbortController | undefined
  private queryGeneration = 0
  private queryAbort: AbortController | undefined
  private queryTimer: ReturnType<typeof setTimeout> | undefined

  constructor(deps: HostDirectoryChooserDeps, initialPath?: string) {
    this.deps = deps
    this.input = new Input({ prompt: 'Host directory: ' })
    this.hasInitialPath = initialPath !== undefined && initialPath !== ''
    if (initialPath !== undefined && initialPath !== '') this.input.setValue(initialPath)
  }

  /** Start the ONE home read of this editor lifetime. Exactly once. */
  begin(): void {
    if (this.started) return
    this.started = true
    const list = this.deps.list
    if (list === undefined) {
      this.status = 'unavailable'
      this.message = 'Directory suggestions unavailable: Host directory browsing is unavailable in this session.'
      this.deps.onChange()
      return
    }
    const generation = ++this.homeGeneration
    const controller = new AbortController()
    this.homeAbort = controller
    this.status = 'loading'
    this.message = undefined
    this.deps.onChange()
    void list(undefined, controller.signal).then( // allowlist: generation-fenced Host read; its failure paints an explicit editor state
      (outcome) => {
        if (this.disposed || generation !== this.homeGeneration || controller.signal.aborted) return
        if (outcome.kind === 'ready') {
          this.applyHome(outcome.listing)
          return
        }
        this.status = outcome.kind
        this.message = this.failureMessage(outcome.kind, outcome.reason)
        this.deps.onChange()
      },
      (error: unknown) => {
        if (this.disposed || generation !== this.homeGeneration || controller.signal.aborted) return
        if (this.isSuperseded(error)) return
        this.status = 'error'
        this.message = `Directory suggestions failed: ${safeErrorMessage(error)}`
        this.deps.onChange()
      },
    )
  }

  /** Edit the raw value, move the suggestion selection or move the cursor. */
  handleInput(data: string): void {
    if (this.disposed) return
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const visible = this.project(this.limit)
      if (visible.length === 0) return
      const direction = matchesKey(data, Key.up) ? -1 : 1
      this.selectedIndex = (this.selectedIndex + direction + visible.length) % visible.length
      this.deps.onChange()
      return
    }
    const before = this.input.getValue()
    this.input.handleInput(data)
    if (this.input.getValue() === before) {
      // Cursor-only movement still needs a repaint (the hardware cursor moved).
      this.deps.onChange()
      return
    }
    this.userEdited = true
    this.hidden = false
    this.requestQuery(false)
  }

  /**
   * Accept ONE candidate the current frame really painted. The identity is the
   * official Host path; an accepted value enters the NEXT level through one
   * fresh query and never registers anything.
   */
  acceptPaintedCandidate(path: string): void {
    if (this.disposed || this.status !== 'ready' || this.hidden) return
    const separator = this.separator
    if (separator === undefined) return
    const candidate = this.project(this.limit).find(item => item.path === path)
    if (candidate === undefined) return
    this.input.setValue(hostDirectoryCandidateValue(candidate.path, separator))
    this.requestQuery(true)
  }

  /** Hide the current suggestions; a real edit reveals them again. */
  hideSuggestions(): void {
    if (this.disposed) return
    this.hidden = true
    this.invalidateQuery()
    this.entries = []
    this.listingEntryCount = 0
    this.truncated = false
    this.currentQuery = undefined
    this.selectedIndex = 0
    this.deps.onChange()
  }

  /**
   * The candidates for one painted frame, in official Host order, capped at
   * the rows this frame can really paint. The painted limit is remembered so
   * arrow navigation can never select a row that was not drawn.
   */
  visibleSuggestions(limit: number): readonly HostDirectoryCandidate[] {
    this.limit = Math.max(0, Math.floor(limit))
    const visible = this.project(this.limit)
    if (this.selectedIndex >= visible.length) this.selectedIndex = Math.max(0, visible.length - 1)
    return visible
  }

  /** The read-only projection of the editor's current state. */
  snapshot(): HostDirectoryChooserSnapshot {
    const visible = this.project(this.limit)
    const selectedIndex = visible.length === 0 ? 0 : Math.min(this.selectedIndex, visible.length - 1)
    return {
      raw: this.input.getValue(),
      status: this.status,
      ...(this.message === undefined ? {} : { message: this.message }),
      ...(this.hostHome === undefined ? {} : { hostHome: this.hostHome }),
      ...(this.separator === undefined ? {} : { separator: this.separator }),
      candidates: visible,
      selectedIndex,
      totalMatches: this.project(Number.MAX_SAFE_INTEGER).length,
      listingEntryCount: this.listingEntryCount,
      truncated: this.truncated,
      hidden: this.hidden,
    }
  }

  /** Cancel both generations, the debounce and every late reaction. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.homeGeneration += 1
    this.homeAbort?.abort()
    this.homeAbort = undefined
    this.invalidateQuery()
    this.entries = []
    this.listingEntryCount = 0
    this.truncated = false
    this.currentQuery = undefined
  }

  private applyHome(listing: DirectoryListing): void {
    this.hostHome = listing.home
    this.separator = hostDirectorySeparator(listing.home)
    if (!this.hasInitialPath && !this.userEdited && this.input.getValue().trim() === '') {
      // The Home read IS the first level: prefill the Host home and reuse this
      // official listing instead of issuing a duplicate `list(home)`.
      this.input.setValue(hostDirectoryCandidateValue(listing.home, this.separator))
      this.currentQuery = {
        kind: 'absolute',
        directoryToList: listing.path,
        prefix: '',
        separator: this.separator,
      }
      this.hidden = false
      this.applyListing(listing)
      return
    }
    // A prefilled/recovered path or a user edit always wins over the home
    // initialization: only the Host DIALECT is learned from this answer.
    this.requestQuery(true)
  }

  private applyListing(listing: DirectoryListing): void {
    this.entries = listing.entries
    this.listingEntryCount = listing.entries.length
    this.truncated = listing.truncated
    this.hidden = false
    this.status = 'ready'
    this.message = undefined
    this.selectedIndex = 0
    this.queryAbort = undefined
    this.deps.onChange()
  }

  private requestQuery(immediate: boolean): void {
    const separator = this.separator
    const hostHome = this.hostHome
    const list = this.deps.list
    if (separator === undefined || hostHome === undefined || list === undefined) return
    this.invalidateQuery()
    const generation = ++this.queryGeneration
    this.entries = []
    this.listingEntryCount = 0
    this.truncated = false
    this.selectedIndex = 0
    const query = hostDirectoryQuery(this.input.getValue(), hostHome)
    this.currentQuery = query
    if (query.kind === 'empty') {
      this.status = 'idle'
      this.message = undefined
      this.deps.onChange()
      return
    }
    if (query.kind === 'invalid') {
      this.status = 'invalid'
      this.message = query.reason
      this.deps.onChange()
      return
    }
    const controller = new AbortController()
    this.queryAbort = controller
    this.status = 'loading'
    this.message = undefined
    const fire = (): void => {
      if (this.disposed || generation !== this.queryGeneration) return
      void list(query.directoryToList, controller.signal).then( // allowlist: generation-fenced Host read; its failure paints an explicit editor state
        (outcome) => {
          if (this.disposed || generation !== this.queryGeneration || controller.signal.aborted) return
          if (outcome.kind === 'ready') {
            this.applyListing(outcome.listing)
            return
          }
          this.status = outcome.kind
          this.message = this.failureMessage(outcome.kind, outcome.reason)
          this.deps.onChange()
        },
        (error: unknown) => {
          if (this.disposed || generation !== this.queryGeneration || controller.signal.aborted) return
          if (this.isSuperseded(error)) return
          this.status = 'error'
          this.message = `Directory suggestions failed: ${safeErrorMessage(error)}`
          this.deps.onChange()
        },
      )
    }
    this.deps.onChange()
    if (immediate) {
      fire()
      return
    }
    this.queryTimer = setTimeout(() => {
      this.queryTimer = undefined
      fire()
    }, QUERY_DEBOUNCE_MS)
  }

  private invalidateQuery(): void {
    this.queryGeneration += 1
    this.queryAbort?.abort()
    this.queryAbort = undefined
    if (this.queryTimer !== undefined) {
      clearTimeout(this.queryTimer)
      this.queryTimer = undefined
    }
  }

  private project(limit: number): readonly HostDirectoryCandidate[] {
    const query = this.currentQuery
    if (this.status !== 'ready' || query === undefined || query.kind !== 'absolute' || this.hidden) return []
    const prefix = query.prefix
    const caseInsensitive = query.separator === '\\'
    const matches: HostDirectoryCandidate[] = []
    for (const entry of this.entries) {
      if (prefix !== '' && !matchesPrefix(entry.name, prefix, caseInsensitive)) continue
      matches.push({ path: entry.path, name: entry.name, hidden: entry.hidden })
      if (matches.length >= limit) break
    }
    return matches
  }

  private failureMessage(kind: 'failed' | 'unavailable', reason: string): string {
    return kind === 'unavailable'
      ? `Directory suggestions unavailable: ${reason}`
      : `Directory unreadable: ${reason}`
  }

  /**
   * A replaced Remote generation is the port's own silent supersession, not a
   * user-facing failure. The name is the structural official error identity;
   * this never classifies by message text.
   */
  private isSuperseded(error: unknown): boolean {
    return typeof error === 'object' && error !== null
      && (error as { readonly name?: unknown }).name === 'SupersededReadError'
  }
}

function matchesPrefix(name: string, prefix: string, caseInsensitive: boolean): boolean {
  return caseInsensitive
    ? name.toLowerCase().startsWith(prefix.toLowerCase())
    : name.startsWith(prefix)
}
