/**
 * The Host-file domain port (M1.10, realigned to the official contract in
 * M3-3A) — the semantic contract between the TUI and the HOST filesystem
 * for `@`-file references: COMPLETION DISCOVERY. Implemented by
 * `src/runtime/direct/` (Direct) and
 * `src/runtime/remote/host-file-remote.ts` (the Session-scoped wire
 * adapter). The port is the locality boundary the migration guardrails
 * demand: the TUI must never assume the Client filesystem IS the Host
 * filesystem — under remote attach, `@src/foo.ts` means the HOST
 * workspace, and this port is where that resolution lives.
 *
 * OFFICIAL MENTION SEMANTICS (M3-3A realignment): the selected reference
 * goes to the prompt LITERALLY — the official client codec is
 * `serialize: ref => ref`, and the Host's official `FILE_REFERENCE_PROMPT`
 * instructs the model that "relative paths resolve from the workspace
 * root; absolute paths identify files or directories on the host". The
 * TUI therefore performs NO send-time existence probe or absolute-path
 * rewrite; the historical Direct-only canonicalization is retired from
 * the cross-backend contract (it made the two backends send different
 * bytes for the same input, and duplicated a resolution the Host/model
 * already owns).
 *
 * Only identity/data crosses the port: scopes are serializable
 * (`sessionId` / `cwd`), candidates are path-only DTOs, and NO Node fs
 * object, `Dirent`, `Stats` or live Agent ever appears.
 *
 * NOT in this port (deliberate locality split): the `!`/`!!` local shell,
 * `/image` local file reads, `/export` local output writes, the clipboard,
 * the external editor and plain shell/path completion — those keep their
 * own client-local semantics.
 *
 * Wire mapping: the official fileReferences Remote seam
 * (`fileReferences/list(agentId, query, signal)` → path-only candidates,
 * Session scope only). The Direct adapter's in-process discovery remains
 * the interim same-machine implementation behind the same contract; the
 * official `dsh-file-reference-local` provider (mounted by the TUI's
 * composition) is the Host-side authority the wire forwards to.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/host-file-port
 */

/** One `@`-reference completion candidate (detached, path-only — the
 * exact upstream `FileReferenceCandidate` shape: `path` + `kind`). All
 * TUI presentation (fuzzy ranking, quoting, the `@`-insertion value, the
 * basename label, the description row, directory continuation) is CLIENT
 * policy in the editor's mention provider, never Host data: a Remote
 * adapter answers "which Host files exist" and nothing more. */
export interface HostFileCandidate {
  /** The user-facing path relative to the scope workspace (`src/deep.ts`),
   * accepted by normal prompts and filesystem tools; directories carry NO
   * trailing slash here (the client adds `/` for continuation). */
  readonly path: string
  /** Whether the candidate is a directory (completion stays open). */
  readonly kind: 'file' | 'directory'
}

/** The filesystem scope one reference resolves against: a live SESSION
 * (identity-addressed; the Direct adapter resolves the agent internally,
 * a Remote adapter maps the official identity) or an explicit WORKSPACE
 * cwd (the sessionless cold surface). */
export type HostFileScope =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'workspace'; readonly cwd: string }

/** The outcome of one existence probe. `unavailable` is DISTINCT from
 * `missing`: the capability could not answer at all (no official carrier,
 * unresolvable scope, lost connection), while `missing` asserts the Host
 * checked and the path does not exist. */
export type HostFileResolveResult =
  | { readonly kind: 'found'; readonly path: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable'; readonly reason: string }

/** The outcome of one completion discovery: an authoritative empty `ok`
 * (the Host answered: nothing matches) is never conflated with an
 * `unavailable` capability (no official carrier, unresolvable scope, lost
 * connection) that must not be presented as "no files". */
export type HostFileListResult =
  | { readonly kind: 'ok'; readonly items: readonly HostFileCandidate[] }
  | { readonly kind: 'unavailable'; readonly reason: string }

/** The Host-file domain port: `@`-file COMPLETION DISCOVERY under the
 *  official mention semantics (the selected reference stays literal; the
 *  Host/model resolves relative paths from the workspace root). */
export interface HostFilePort {
  /** Complete one `@`-mention query (the editor's at-prefix INCLUDING the
   * leading `@`, e.g. `@src/fo` or `@"my file`). Returns the candidates
   * the current Host filesystem discovery offers (fd whole-tree fuzzy
   * when fd is on the Host PATH, the bounded recursive scan otherwise)
   * as an authoritative `ok` — `[]` when nothing matches — or
   * `unavailable` when the capability cannot answer. Cancellation is its
   * own outcome and outranks every other one: an aborted signal REJECTS
   * (both adapters, entry-time — before any scope/capability decision),
   * never folded into `unavailable`. */
  listReferences(
    scope: HostFileScope,
    query: string,
    options?: { signal?: AbortSignal },
  ): Promise<HostFileListResult>
  /** Probe one raw mention path (`src/foo.ts`, `~/x`, `/abs/x`) for
   * existence in the scope, resolving it to the absolute Host path
   * (`~` expansion; relative against the scope workspace; absolute kept;
   * symlinks absolutized, never realpath'd). DIRECT-ONLY compatibility
   * seam (M3-3A): the official wire has no existence carrier — the
   * Remote adapter answers `unavailable` — and nothing in the submission
   * path consumes it anymore (mentions stay literal on BOTH backends).
   * Retained for Direct-local diagnostics only; it is NOT part of the
   * cross-backend semantic contract. An aborted signal rejects
   * (entry-time, both adapters — cancellation outranks `unavailable`). */
  resolveReference(
    scope: HostFileScope,
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<HostFileResolveResult>
  /** The official mention semantics: the submitted text is returned
   * VERBATIM. The selected `@`-reference is literal prompt text — the
   * Host's `FILE_REFERENCE_PROMPT` owns its resolution — so no backend
   * probes existence or rewrites paths at send time. The seam stays so
   * submission surfaces do not each hardcode identity; a future official
   * carrier (if one ever exists) would land behind it. */
  canonicalizeMentions(scope: HostFileScope, text: string): Promise<string>
}
