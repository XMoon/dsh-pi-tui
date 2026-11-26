/**
 * The disposable SQLite projection behind `piTuiHistorySearch`.
 *
 * The official DSH Session log remains the ONLY durable authority. This module
 * owns a profile-local SQLite file whose rows can be discarded and rebuilt
 * from the official log at any time:
 *
 * ```text
 * $PROFILE_DIR/.dsh-pi-tui/history-search/v2.sqlite
 * ```
 *
 * Besides the projected rows it stores ONE source-proof row per Session: the
 * exact durable source revision and checkpoint digest a complete cold replay
 * observed. The proof is metadata only — it never substitutes for an official
 * read and is revoked atomically by every mutation that changes a checkpoint.
 *
 * It owns nothing else: path/schema/permission validation, atomic per-Session
 * checkpoint + occurrence commits, source-proof durability, the three keyset
 * search scopes and the exact-text read. The Host service above it owns
 * reconciliation, authorization, qualification and the wire.
 *
 * @module @xmoon76/dsh-pi-tui/app/host/features/history-search-index
 */

import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync, renameSync, statSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { historySearchPreview } from '../../../runtime/remote/pi-tui-history-search-contract.ts'

/** Fixed SQLite `application_id` (`PITH`). */
export const HISTORY_SEARCH_SQLITE_APPLICATION_ID = 0x50495448

/**
 * Fixed schema version of the derived index. v2 adds the durable
 * `history_source_proofs` relation; the pre-release v1 file is never opened,
 * migrated or deleted.
 */
export const HISTORY_SEARCH_SQLITE_USER_VERSION = 2

/**
 * Semantic contract of one durable source proof. Bump only when the projection
 * or the proof semantics change: proofs from an older contract are not reused.
 */
export const HISTORY_SEARCH_SOURCE_PROOF_CONTRACT_VERSION = 2

const DATABASE_FILE = 'v2.sqlite'
const PRIVATE_DIRECTORY = '.dsh-pi-tui'
const HISTORY_DIRECTORY = 'history-search'

const CREATE_SCHEMA_SQL = `
CREATE TABLE history_sessions (
  session_id TEXT PRIMARY KEY,
  header_cwd TEXT,
  inherited_cut INTEGER NOT NULL CHECK(inherited_cut >= 0),
  next_seq INTEGER NOT NULL CHECK(next_seq >= 0),
  effective_cwd TEXT,
  last_event_hash TEXT,
  header_hash TEXT NOT NULL,
  source_state TEXT NOT NULL CHECK(source_state IN ('persisted','live')),
  uncertain_sources INTEGER NOT NULL DEFAULT 0 CHECK(uncertain_sources >= 0),
  dirty INTEGER NOT NULL DEFAULT 0 CHECK(dirty IN (0,1))
);
CREATE TABLE history_occurrences (
  row_id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES history_sessions(session_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  first_seq INTEGER NOT NULL,
  accepted_ms INTEGER NOT NULL,
  effective_cwd TEXT,
  content TEXT NOT NULL,
  normalized_content TEXT NOT NULL,
  preview TEXT NOT NULL,
  content_length INTEGER NOT NULL CHECK(content_length >= 0),
  content_sha256 TEXT NOT NULL,
  has_non_text INTEGER NOT NULL CHECK(has_non_text IN (0,1)),
  UNIQUE(session_id,message_id)
);
CREATE INDEX history_order_all ON history_occurrences(
  accepted_ms DESC, session_id ASC, first_seq DESC, message_id ASC
);
CREATE INDEX history_order_session ON history_occurrences(
  session_id, accepted_ms DESC, first_seq DESC, message_id ASC
);
CREATE INDEX history_order_directory ON history_occurrences(
  effective_cwd, accepted_ms DESC, session_id ASC, first_seq DESC, message_id ASC
);
CREATE TABLE history_source_proofs (
  session_id TEXT PRIMARY KEY REFERENCES history_sessions(session_id) ON DELETE CASCADE,
  contract_version INTEGER NOT NULL CHECK(contract_version > 0),
  scope_key TEXT NOT NULL CHECK(length(scope_key) = 64),
  source_path TEXT NOT NULL CHECK(length(source_path) > 0),
  source_revision TEXT NOT NULL CHECK(length(source_revision) > 0),
  checkpoint_hash TEXT NOT NULL CHECK(length(checkpoint_hash) = 64)
);
`

const EXPECTED_TABLES = ['history_occurrences', 'history_sessions', 'history_source_proofs'] as const
const EXPECTED_INDEXES = ['history_order_all', 'history_order_directory', 'history_order_session'] as const

const SESSION_COLUMNS = [
  'session_id', 'header_cwd', 'inherited_cut', 'next_seq', 'effective_cwd',
  'last_event_hash', 'header_hash', 'source_state', 'uncertain_sources', 'dirty',
] as const
const OCCURRENCE_COLUMNS = [
  'row_id', 'session_id', 'message_id', 'first_seq', 'accepted_ms', 'effective_cwd',
  'content', 'normalized_content', 'preview', 'content_length', 'content_sha256', 'has_non_text',
] as const
const PROOF_COLUMNS = [
  'session_id', 'contract_version', 'scope_key', 'source_path', 'source_revision', 'checkpoint_hash',
] as const

/** The index path cannot be opened or is not safe to use; the Host stays up. */
export class HistorySearchIndexUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HistorySearchIndexUnavailableError'
  }
}

/** One derived Session checkpoint. */
export interface HistorySessionCheckpointRow {
  readonly sessionId: string
  readonly headerCwd: string | null
  readonly inheritedCut: number
  readonly nextSeq: number
  readonly effectiveCwd: string | null
  readonly lastEventHash: string | null
  readonly headerHash: string
  readonly sourceState: 'persisted' | 'live'
  readonly uncertainSources: number
  readonly dirty: boolean
}

/**
 * The durable source facts a complete cold replay observed for one Session.
 * They are opaque strings: the revision is compared for exact equality only.
 */
export interface HistorySourceProofBasis {
  readonly scopeKey: string
  readonly sourcePath: string
  readonly sourceRevision: string
}

/** One stored durable source proof. */
export interface HistorySourceProofRow extends HistorySourceProofBasis {
  readonly sessionId: string
  readonly contractVersion: number
  readonly checkpointHash: string
}

/** One accepted occurrence to commit. */
export interface HistoryOccurrenceInput {
  readonly messageId: string
  readonly firstEventSeq: number
  readonly acceptedAt: number
  readonly effectiveCwd: string | null
  readonly content: string
  readonly hasNonText: boolean
}

/** One transaction's Session checkpoint + first-acceptance rows. */
export interface HistoryIndexCommitInput {
  readonly sessionId: string
  readonly headerHash: string
  readonly inheritedCut: number
  /** The caller's expected persisted next seq (0 for a new Session). */
  readonly baseNextSeq: number
  readonly nextSeq: number
  readonly headerCwd: string | null
  readonly effectiveCwd: string | null
  readonly lastEventHash: string | null
  readonly sourceState: 'persisted' | 'live'
  /**
   * Old-v2 recovery compatibility only: a retained pre-upgrade uncertainty
   * count delta. The current admission fold has no optional-metadata
   * uncertainty and every production caller passes `0`; the physical column
   * and its checkpoint equality stay until a future schema change.
   */
  readonly uncertainSourcesDelta: number
  readonly occurrences: readonly HistoryOccurrenceInput[]
}

/** One stored occurrence row (the derived read model). */
export interface HistoryOccurrenceRow {
  readonly sessionId: string
  readonly messageId: string
  readonly firstEventSeq: number
  readonly acceptedAt: number
  readonly effectiveCwd: string | null
  readonly content: string
  readonly preview: string
  readonly contentLength: number
  readonly contentSha256: string
  readonly hasNonText: boolean
}

/**
 * One bounded search row. It deliberately carries NO full content: the preview
 * is a stored bounded prefix and full bodies are only read by `occurrence()`
 * for the exact-text chunk path.
 */
export interface HistorySearchRow {
  /** Host-internal continuation anchor; never part of the public row DTO. */
  readonly rowId: string
  readonly sessionId: string
  readonly messageId: string
  readonly firstEventSeq: number
  readonly acceptedAt: number
  readonly effectiveCwd: string | null
  readonly preview: string
  readonly contentLength: number
  readonly contentSha256: string
  readonly hasNonText: boolean
}

/** One keyset search page. */
export interface HistoryIndexSearchPage {
  readonly rows: readonly HistorySearchRow[]
  readonly hasMore: boolean
}

/** One keyset position. */
export interface HistorySearchAfter {
  readonly acceptedAt: number
  readonly sessionId: string
  readonly firstEventSeq: number
  readonly messageId: string
}

export interface HistoryIndexSearchRequest {
  readonly scope: 'all' | 'session' | 'directory'
  readonly sessionId?: string
  readonly cwd?: string
  /** Empty string is an unfiltered browse. */
  readonly query: string
  readonly limit: number
  readonly after?: HistorySearchAfter
}

/** SHA-256 of one stored text. */
export function contentSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Stable JSON for header/event hashing: object keys sorted recursively. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

/** Hash one official Session event by its canonical `seq/type/time/data`. */
export function sessionEventHash(event: { readonly seq: number; readonly type: string; readonly time: number; readonly data: unknown }): string {
  return createHash('sha256')
    .update(stableJson({ seq: event.seq, type: event.type, time: event.time, data: event.data }), 'utf8')
    .digest('hex')
}

/** Hash one official Session header's immutable identity facts. */
export function sessionHeaderHash(header: unknown): string {
  return createHash('sha256').update(stableJson(header), 'utf8').digest('hex')
}

/**
 * Hash every projected checkpoint fact a durable source proof covers. The
 * digest is the exact terminal state of one complete replay: a later batch,
 * marker or reset that changes ANY field cannot match it.
 */
export function historyCheckpointHash(row: HistorySessionCheckpointRow): string {
  return createHash('sha256').update(stableJson([
    row.sessionId,
    row.headerCwd,
    row.inheritedCut,
    row.nextSeq,
    row.effectiveCwd,
    row.lastEventHash,
    row.headerHash,
    row.sourceState,
    row.uncertainSources,
    row.dirty,
  ]), 'utf8').digest('hex')
}

/**
 * `lstat` one path, treating only a real ENOENT as absence. `existsSync`
 * follows symlinks, so a DANGLING symlink would look absent and could be
 * followed by a later create; every private-file decision uses this probe.
 */
function lstatIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function assertOwnedDirectory(path: string, label: string): void {
  const stat = statSync(path)
  if (!stat.isDirectory()) throw new HistorySearchIndexUnavailableError(`${label} is not a directory`)
  if (stat.uid !== process.getuid?.()) {
    throw new HistorySearchIndexUnavailableError(`${label} is not owned by the current user`)
  }
}

/** Create/verify one private directory below the real profile directory. */
function ensurePrivateDirectory(path: string, label: string): void {
  const existing = lstatIfExists(path)
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) throw new HistorySearchIndexUnavailableError(`${label} is a symbolic link`)
    assertOwnedDirectory(path, label)
    const mode = existing.mode & 0o777
    if ((mode & 0o077) !== 0) throw new HistorySearchIndexUnavailableError(`${label} is not private`)
    return
  }
  mkdirSync(path, { mode: 0o700 })
  chmodSync(path, 0o700)
}

/** Verify the database file is a regular, owned, private file (never chmod foreign files). */
function assertPrivateDatabaseFile(path: string): void {
  const link = lstatSync(path)
  if (link.isSymbolicLink()) throw new HistorySearchIndexUnavailableError('the derived index file is a symbolic link')
  if (!link.isFile()) throw new HistorySearchIndexUnavailableError('the derived index path is not a regular file')
  if (link.uid !== process.getuid?.()) {
    throw new HistorySearchIndexUnavailableError('the derived index file is not owned by the current user')
  }
  if ((link.mode & 0o077) !== 0) {
    throw new HistorySearchIndexUnavailableError('the derived index file is not private')
  }
}

/**
 * SQLite's WAL sidecars are part of the private file set. An existing sidecar
 * must be a regular, current-UID, 0600 file: SQLite reads and writes it under
 * the same exemption assumptions as the main database, so a symlinked or
 * group-readable sidecar is a refusal, never a chmod repair.
 */
function assertPrivateSidecars(dbPath: string): void {
  for (const suffix of ['-wal', '-shm'] as const) {
    const path = `${dbPath}${suffix}`
    const link = lstatIfExists(path)
    if (link === undefined) continue
    if (link.isSymbolicLink()) {
      throw new HistorySearchIndexUnavailableError(`the derived index ${suffix} file is a symbolic link`)
    }
    if (!link.isFile()) {
      throw new HistorySearchIndexUnavailableError(`the derived index ${suffix} path is not a regular file`)
    }
    if (link.uid !== process.getuid?.()) {
      throw new HistorySearchIndexUnavailableError(`the derived index ${suffix} file is not owned by the current user`)
    }
    if ((link.mode & 0o077) !== 0) {
      throw new HistorySearchIndexUnavailableError(`the derived index ${suffix} file is not private`)
    }
  }
}

interface RawSessionRow {
  readonly session_id: string
  readonly header_cwd: string | null
  readonly inherited_cut: number
  readonly next_seq: number
  readonly effective_cwd: string | null
  readonly last_event_hash: string | null
  readonly header_hash: string
  readonly source_state: 'persisted' | 'live'
  readonly uncertain_sources: number
  readonly dirty: number
}

interface RawSourceProofRow {
  readonly session_id: string
  readonly contract_version: number
  readonly scope_key: string
  readonly source_path: string
  readonly source_revision: string
  readonly checkpoint_hash: string
}

interface RawOccurrenceRow {
  readonly session_id: string
  readonly message_id: string
  readonly first_seq: number
  readonly accepted_ms: number
  readonly effective_cwd: string | null
  readonly content: string
  readonly preview: string
  readonly content_length: number
  readonly content_sha256: string
  readonly has_non_text: number
}

interface RawSearchRow {
  readonly row_id: string
  readonly session_id: string
  readonly message_id: string
  readonly first_seq: number
  readonly accepted_ms: number
  readonly effective_cwd: string | null
  readonly preview: string
  readonly content_length: number
  readonly content_sha256: string
  readonly has_non_text: number
}

function checkpointOfRaw(row: RawSessionRow): HistorySessionCheckpointRow {
  return {
    sessionId: row.session_id,
    headerCwd: row.header_cwd,
    inheritedCut: row.inherited_cut,
    nextSeq: row.next_seq,
    effectiveCwd: row.effective_cwd,
    lastEventHash: row.last_event_hash,
    headerHash: row.header_hash,
    sourceState: row.source_state,
    uncertainSources: row.uncertain_sources,
    dirty: row.dirty === 1,
  }
}

function occurrenceOfRaw(row: RawOccurrenceRow): HistoryOccurrenceRow {
  return {
    sessionId: row.session_id,
    messageId: row.message_id,
    firstEventSeq: row.first_seq,
    acceptedAt: row.accepted_ms,
    effectiveCwd: row.effective_cwd,
    content: row.content,
    preview: row.preview,
    contentLength: row.content_length,
    contentSha256: row.content_sha256,
    hasNonText: row.has_non_text === 1,
  }
}

function searchRowOfRaw(row: RawSearchRow): HistorySearchRow {
  return {
    rowId: row.row_id,
    sessionId: row.session_id,
    messageId: row.message_id,
    firstEventSeq: row.first_seq,
    acceptedAt: row.accepted_ms,
    effectiveCwd: row.effective_cwd,
    preview: row.preview,
    contentLength: row.content_length,
    contentSha256: row.content_sha256,
    hasNonText: row.has_non_text === 1,
  }
}

function schemaNames(db: DatabaseSync): { tables: string[]; indexes: string[] } {
  const rows = db.prepare(
    "SELECT name, type FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string; type: string }>
  return {
    tables: rows.filter(row => row.type === 'table').map(row => row.name),
    indexes: rows.filter(row => row.type === 'index').map(row => row.name),
  }
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.map(row => row.name)
}

type SchemaState = 'fresh' | 'ok' | 'foreign' | 'corrupt'

function inspectSchema(db: DatabaseSync): SchemaState {
  const applicationId = (db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id
  const userVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  const names = schemaNames(db)
  const empty = names.tables.length === 0 && names.indexes.length === 0
  if (empty) {
    if (applicationId === 0 && userVersion === 0) return 'fresh'
    return 'foreign'
  }
  if (applicationId !== HISTORY_SEARCH_SQLITE_APPLICATION_ID || userVersion !== HISTORY_SEARCH_SQLITE_USER_VERSION) {
    return 'foreign'
  }
  if (names.tables.length !== EXPECTED_TABLES.length || names.indexes.length !== EXPECTED_INDEXES.length) return 'corrupt'
  for (const table of EXPECTED_TABLES) {
    if (!names.tables.includes(table)) return 'corrupt'
  }
  for (const index of EXPECTED_INDEXES) {
    if (!names.indexes.includes(index)) return 'corrupt'
  }
  if (tableColumns(db, 'history_sessions').join(',') !== SESSION_COLUMNS.join(',')) return 'corrupt'
  if (tableColumns(db, 'history_occurrences').join(',') !== OCCURRENCE_COLUMNS.join(',')) return 'corrupt'
  if (tableColumns(db, 'history_source_proofs').join(',') !== PROOF_COLUMNS.join(',')) return 'corrupt'
  return 'ok'
}

/** Quarantine one own-v2 file set under private names; never deletes data. */
function quarantineDatabaseFile(dbPath: string): void {
  const stamp = String(Date.now())
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${dbPath}${suffix}`
    if (lstatIfExists(source) === undefined) continue
    renameSync(source, `${dbPath}.quarantine-${stamp}${suffix}`)
  }
}

/** Whether an open/validate failure is a corrupt own database rather than a foreign one. */
function isCorruptionError(error: unknown): boolean {
  // Node's SQLite binding carries the numeric SQLITE error code; 11 is
  // SQLITE_CORRUPT and 26 is SQLITE_NOTADB. The generic `code` is only a
  // binding-level class and is not specific enough on its own.
  const errcode = (error as { errcode?: unknown } | undefined)?.errcode
  if (errcode === 11 || errcode === 26) return true
  const message = error instanceof Error ? error.message : ''
  return /database disk image is malformed|file is not a database/iu.test(message)
}

/**
 * The disposable derived index. ONE instance owns ONE database handle and is
 * only used from the Host service's serial write/read paths.
 */
export class HistorySearchIndex {
  readonly path: string
  private readonly db: DatabaseSync
  private closed = false
  /** Content generation owned by the ONE index mutation boundary. */
  private contentRevision = 0
  /** Revoked durable proofs; diagnostics only, derived from committed writes. */
  private proofRevocationCount = 0

  private constructor(path: string, db: DatabaseSync) {
    this.path = path
    this.db = db
  }

  /**
   * Monotonic content generation. It advances only when committed occurrence
   * content changes (insert/reset/delete), never for checkpoint-only or
   * completeness-marker writes, so keyset cursors invalidate exactly when the
   * result set/order can change.
   */
  get revision(): number {
    return this.contentRevision
  }

  /** Monotonic count of source proofs actually revoked by committed writes. */
  get sourceProofRevocations(): number {
    return this.proofRevocationCount
  }

  /**
   * The files a proof-only transaction depends on: the main database and its
   * materialized WAL/SHM sidecars must all be private, owned regular files.
   */
  private assertProofFileSet(): void {
    assertPrivateDatabaseFile(this.path)
    assertPrivateSidecars(this.path)
    for (const suffix of ['-wal', '-shm'] as const) {
      if (lstatIfExists(`${this.path}${suffix}`) === undefined) {
        throw new Error(`history search index: the ${suffix} sidecar is not materialized`)
      }
    }
  }

  /** Perform one proof-only transaction with a final in-transaction file check. */
  private commitSourceProofRow(sessionId: string, basis: HistorySourceProofBasis, checkpointHash: string): void {
    this.db.prepare(
      `INSERT INTO history_source_proofs (
        session_id, contract_version, scope_key, source_path, source_revision, checkpoint_hash
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        contract_version = excluded.contract_version,
        scope_key = excluded.scope_key,
        source_path = excluded.source_path,
        source_revision = excluded.source_revision,
        checkpoint_hash = excluded.checkpoint_hash`,
    ).run(
      sessionId,
      HISTORY_SEARCH_SOURCE_PROOF_CONTRACT_VERSION,
      basis.scopeKey,
      basis.sourcePath,
      basis.sourceRevision,
      checkpointHash,
    )
    // No fallible validation is allowed after COMMIT: the last one runs here,
    // while a failure still rolls the whole proof insert back.
    this.assertProofFileSet()
  }

  /**
   * Open (or initialize) the profile-local derived index.
   *
   * A foreign database, a non-private path or an unowned directory refuses the
   * index (the Host stays Ready and reports `unavailable`). A known v2 file
   * that fails schema validation or SQLite integrity is quarantined and
   * rebuilt from an empty schema; the original bytes are preserved.
   */
  static open(options: { readonly profileDir: string; readonly signal?: AbortSignal }): HistorySearchIndex {
    options.signal?.throwIfAborted()
    const realProfile = realpathSync(options.profileDir)
    assertOwnedDirectory(realProfile, 'the Host profile directory')
    const privateDir = join(realProfile, PRIVATE_DIRECTORY)
    ensurePrivateDirectory(privateDir, 'the private TUI directory')
    const historyDir = join(privateDir, HISTORY_DIRECTORY)
    ensurePrivateDirectory(historyDir, 'the history search directory')
    const dbPath = join(historyDir, DATABASE_FILE)
    let created = lstatIfExists(dbPath) === undefined
    if (!created) assertPrivateDatabaseFile(dbPath)
    assertPrivateSidecars(dbPath)

    // Inspect an existing file READ-ONLY first: a foreign database must be
    // refused without any write (no journal-mode flag, no schema change).
    if (!created) {
      let probe: DatabaseSync | undefined
      let state: SchemaState | undefined
      try {
        probe = new DatabaseSync(dbPath, { readOnly: true })
        state = inspectSchema(probe)
      } catch (error) {
        // A WAL that needs recovery can refuse a read-only open; that is not a
        // corruption verdict — fall through to the read-write validation below.
        state = isCorruptionError(error) ? 'corrupt' : undefined
      } finally {
        probe?.close()
      }
      if (state === 'foreign') {
        throw new HistorySearchIndexUnavailableError('the derived history index path holds a foreign database')
      }
      // An EXISTING empty database carries no PITH identity. Adopting it would
      // rewrite a pre-existing non-application database in place, so it is
      // refused untouched; only a file THIS open created may be initialized.
      if (state === 'fresh') {
        throw new HistorySearchIndexUnavailableError(
          'the derived history index path holds an existing database without the application identity',
        )
      }
      if (state === 'corrupt') {
        // Our own disposable projection with a corrupt/older schema (including
        // a pre-release file missing the new columns): preserve the bytes under
        // a quarantine name and rebuild from the official log.
        quarantineDatabaseFile(dbPath)
        created = true
      }
    }

    let db: DatabaseSync
    try {
      db = new DatabaseSync(dbPath)
      // Secure the main file BEFORE WAL/schema writes: SQLite copies the main
      // file's mode onto the materialized -wal/-shm sidecars, so a 0644 file
      // here would create 0644 sidecars before any later chmod could help.
      if (created) chmodSync(dbPath, 0o600)
    } catch (error) {
      if (isCorruptionError(error)) {
        quarantineDatabaseFile(dbPath)
        db = new DatabaseSync(dbPath)
        created = true
      } else {
        throw new HistorySearchIndexUnavailableError('the derived history index could not be opened')
      }
    }
    try {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
      db.exec('PRAGMA busy_timeout = 1000')
      db.exec('PRAGMA foreign_keys = ON')
      const schema = inspectSchema(db)
      if (schema === 'foreign') {
        db.close()
        throw new HistorySearchIndexUnavailableError('the derived history index path holds a foreign database')
      }
      if (schema === 'fresh' && !created) {
        db.close()
        throw new HistorySearchIndexUnavailableError(
          'the derived history index path holds an existing database without the application identity',
        )
      }
      if (schema === 'corrupt' || (created && schema !== 'fresh')) {
        db.close()
        quarantineDatabaseFile(dbPath)
        return HistorySearchIndex.open({ profileDir: realProfile, ...(options.signal === undefined ? {} : { signal: options.signal }) })
      }
      if (schema === 'fresh') {
        db.exec('BEGIN IMMEDIATE')
        try {
          db.exec(CREATE_SCHEMA_SQL)
          db.exec(`PRAGMA application_id = ${String(HISTORY_SEARCH_SQLITE_APPLICATION_ID)}`)
          db.exec(`PRAGMA user_version = ${String(HISTORY_SEARCH_SQLITE_USER_VERSION)}`)
          db.exec('COMMIT')
        } catch (error) {
          try {
            db.exec('ROLLBACK')
          } catch {
            // The primary failure below is the only error that matters.
          }
          db.close()
          throw error
        }
      }
    } catch (error) {
      if (error instanceof HistorySearchIndexUnavailableError) throw error
      try {
        db.close()
      } catch {
        // Already closed by a validation branch above.
      }
      if (isCorruptionError(error)) {
        quarantineDatabaseFile(dbPath)
        return HistorySearchIndex.open({ profileDir: realProfile, ...(options.signal === undefined ? {} : { signal: options.signal }) })
      }
      throw new HistorySearchIndexUnavailableError('the derived history index could not be initialized')
    }
    // Enabling WAL/schema creation may have materialized sidecars in this
    // open; they are part of the private file set and must prove it here too.
    assertPrivateSidecars(dbPath)
    options.signal?.throwIfAborted()
    return new HistorySearchIndex(dbPath, db)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('history search index: the database is closed')
  }

  private transaction<T>(work: () => T): T {
    this.assertOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // The primary failure below is the only error that matters.
      }
      throw error
    }
  }

  listSessions(): HistorySessionCheckpointRow[] {
    this.assertOpen()
    const rows = this.db.prepare('SELECT * FROM history_sessions ORDER BY session_id').all() as unknown as RawSessionRow[]
    return rows.map(checkpointOfRaw)
  }

  /**
   * Fixed-size status result for the short-writer completeness check. The
   * EXISTS probes are evaluated by SQLite without materializing checkpoint rows
   * in JavaScript. This replaces the corpus-sized `listSessions().some(...)`
   * scan on the Owner write tail.
   */
  incompleteReason(): 'dirty' | 'uncertain' | undefined {
    this.assertOpen()
    const row = this.db.prepare(`
      SELECT
        EXISTS(SELECT 1 FROM history_sessions WHERE dirty = 1) AS dirty,
        EXISTS(SELECT 1 FROM history_sessions WHERE uncertain_sources > 0) AS uncertain
    `).get() as { readonly dirty: number; readonly uncertain: number } | undefined
    if (row === undefined) return undefined
    if (row.dirty === 1) return 'dirty'
    if (row.uncertain === 1) return 'uncertain'
    return undefined
  }

  checkpointOf(sessionId: string): HistorySessionCheckpointRow | undefined {
    this.assertOpen()
    const row = this.db.prepare('SELECT * FROM history_sessions WHERE session_id = ?').get(sessionId) as unknown as RawSessionRow | undefined
    return row === undefined ? undefined : checkpointOfRaw(row)
  }

  /**
   * ONE point read of the committed durable source proof. It is never
   * materialized as part of a corpus listing and never carries occurrence
   * content.
   */
  sourceProofOf(sessionId: string): HistorySourceProofRow | undefined {
    this.assertOpen()
    const row = this.db.prepare('SELECT * FROM history_source_proofs WHERE session_id = ?')
      .get(sessionId) as unknown as RawSourceProofRow | undefined
    if (row === undefined) return undefined
    return {
      sessionId: row.session_id,
      contractVersion: row.contract_version,
      scopeKey: row.scope_key,
      sourcePath: row.source_path,
      sourceRevision: row.source_revision,
      checkpointHash: row.checkpoint_hash,
    }
  }

  /**
   * Persist the durable source proof of ONE complete cold replay. The stored
   * checkpoint must still hash to exactly the caller's expected terminal
   * checkpoint and must itself be a clean, persisted, fully counted row; the
   * proof-only transaction additionally proves the private file set at its
   * start and immediately before COMMIT.
   *
   * This function is a durability primitive, not a replay authority: the Host
   * service may only call it from the terminal of a verified complete replay.
   */
  commitSourceProof(expected: HistorySessionCheckpointRow, basis: HistorySourceProofBasis): void {
    this.assertOpen()
    this.assertProofFileSet()
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM history_sessions WHERE session_id = ?')
        .get(expected.sessionId) as unknown as RawSessionRow | undefined
      if (row === undefined) {
        throw new Error('history search index: no checkpoint exists for the source proof')
      }
      const actual = checkpointOfRaw(row)
      const checkpointHash = historyCheckpointHash(actual)
      if (checkpointHash !== historyCheckpointHash(expected)) {
        throw new Error('history search index: the checkpoint changed before its source proof was committed')
      }
      if (actual.sourceState !== 'persisted' || actual.dirty || actual.uncertainSources !== 0) {
        throw new Error('history search index: only a clean persisted checkpoint may carry a source proof')
      }
      if (actual.inheritedCut < 0 || actual.nextSeq < actual.inheritedCut) {
        throw new Error('history search index: the source proof checkpoint has an invalid sequence range')
      }
      if (actual.nextSeq === 0 ? actual.lastEventHash !== null : actual.lastEventHash === null) {
        throw new Error('history search index: the source proof checkpoint has an inconsistent tail hash')
      }
      this.commitSourceProofRow(expected.sessionId, basis, checkpointHash)
    })
  }

  deleteSession(sessionId: string): void {
    let removedOccurrences = 0
    let removedProof = false
    this.transaction(() => {
      removedProof = this.db.prepare('SELECT 1 FROM history_source_proofs WHERE session_id = ?').get(sessionId) !== undefined
      removedOccurrences += Number(this.db.prepare('DELETE FROM history_occurrences WHERE session_id = ?').run(sessionId).changes)
      // The foreign-key cascade removes the proof with its Session row.
      this.db.prepare('DELETE FROM history_sessions WHERE session_id = ?').run(sessionId)
    })
    if (removedProof) this.proofRevocationCount += 1
    if (removedOccurrences > 0) this.contentRevision += 1
  }

  /** Drop one Session's derived rows before a full rebuild from its official log. */
  resetSession(sessionId: string): void {
    this.deleteSession(sessionId)
  }

  /**
   * Commit ONE Session batch: first-acceptance occurrences plus the checkpoint.
   * `baseNextSeq` must equal the persisted checkpoint so a stale/replaced
   * writer cannot silently skip or duplicate events.
   */
  commitBatch(input: HistoryIndexCommitInput): void {
    if (!Number.isSafeInteger(input.baseNextSeq) || input.baseNextSeq < 0) {
      throw new Error('history search index: baseNextSeq must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(input.nextSeq) || input.nextSeq < input.baseNextSeq) {
      throw new Error('history search index: nextSeq must be a non-negative safe integer >= baseNextSeq')
    }
    let insertedOccurrences = 0
    let revokedProofs = 0
    // Fail the batch BEFORE it commits when a sidecar is already unsafe. The
    // post-commit re-check below remains a second window; a Host that observes
    // either failure keeps the index closed until a later write proves safety.
    assertPrivateSidecars(this.path)
    this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM history_sessions WHERE session_id = ?')
        .get(input.sessionId) as unknown as RawSessionRow | undefined
      const persistedNext = existing?.next_seq ?? 0
      if (persistedNext !== input.baseNextSeq) {
        throw new Error('history search index: the persisted Session checkpoint moved underneath this batch')
      }
      // ANY batch that rewrites the checkpoint (including zero events and a
      // marker-only terminal row) revokes the proof in the SAME transaction:
      // rollback restores the old proof together with the old rows.
      revokedProofs += Number(this.db.prepare('DELETE FROM history_source_proofs WHERE session_id = ?')
        .run(input.sessionId).changes)
      if (existing === undefined) {
        this.db.prepare(
          `INSERT INTO history_sessions (
            session_id, header_cwd, inherited_cut, next_seq, effective_cwd, last_event_hash,
            header_hash, source_state, uncertain_sources, dirty
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        ).run(
          input.sessionId,
          input.headerCwd,
          input.inheritedCut,
          input.nextSeq,
          input.effectiveCwd,
          input.lastEventHash,
          input.headerHash,
          input.sourceState,
          input.uncertainSourcesDelta,
        )
      } else {
        this.db.prepare(
          `UPDATE history_sessions SET
            header_cwd = ?, inherited_cut = ?, next_seq = ?, effective_cwd = ?, last_event_hash = ?,
            header_hash = ?, source_state = ?, uncertain_sources = uncertain_sources + ?, dirty = 0
          WHERE session_id = ?`,
        ).run(
          input.headerCwd,
          input.inheritedCut,
          input.nextSeq,
          input.effectiveCwd,
          input.lastEventHash,
          input.headerHash,
          input.sourceState,
          input.uncertainSourcesDelta,
          input.sessionId,
        )
      }
      const insertOccurrence = this.db.prepare(
        `INSERT OR IGNORE INTO history_occurrences (
          session_id, message_id, first_seq, accepted_ms, effective_cwd,
          content, normalized_content, preview, content_length, content_sha256, has_non_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const occurrence of input.occurrences) {
        insertedOccurrences += Number(insertOccurrence.run(
          input.sessionId,
          occurrence.messageId,
          occurrence.firstEventSeq,
          occurrence.acceptedAt,
          occurrence.effectiveCwd,
          occurrence.content,
          occurrence.content.toLowerCase(),
          historySearchPreview(occurrence.content),
          occurrence.content.length,
          contentSha256(occurrence.content),
          occurrence.hasNonText ? 1 : 0,
        ).changes)
      }
    })
    if (insertedOccurrences > 0) this.contentRevision += 1
    if (revokedProofs > 0) this.proofRevocationCount += revokedProofs
    // SQLite materializes -wal/-shm on the first write. They inherit the main
    // file's mode, but the policy is proven here, not assumed: an unsafe sidecar
    // fails the batch (and therefore the authoritative answer) closed.
    assertPrivateSidecars(this.path)
  }

  /** Update one Session's completeness markers without touching its rows. */
  markSession(input: {
    readonly sessionId: string
    readonly dirty?: boolean
    readonly sourceState?: 'persisted' | 'live'
    readonly uncertainSources?: number
  }): void {
    const mutates = input.dirty !== undefined || input.sourceState !== undefined || input.uncertainSources !== undefined
    let revokedProofs = 0
    this.transaction(() => {
      if (mutates) {
        // A marker rewrite is a checkpoint change: the old durable proof can
        // no longer describe this row and is revoked in the same transaction.
        revokedProofs += Number(this.db.prepare('DELETE FROM history_source_proofs WHERE session_id = ?')
          .run(input.sessionId).changes)
      }
      if (input.dirty !== undefined) {
        this.db.prepare('UPDATE history_sessions SET dirty = ? WHERE session_id = ?')
          .run(input.dirty ? 1 : 0, input.sessionId)
      }
      if (input.sourceState !== undefined) {
        this.db.prepare('UPDATE history_sessions SET source_state = ? WHERE session_id = ?')
          .run(input.sourceState, input.sessionId)
      }
      if (input.uncertainSources !== undefined) {
        this.db.prepare('UPDATE history_sessions SET uncertain_sources = ? WHERE session_id = ?')
          .run(input.uncertainSources, input.sessionId)
      }
    })
    if (revokedProofs > 0) this.proofRevocationCount += revokedProofs
  }

  /**
   * The exact match set shared by a page read and an anchor re-check: the
   * literal (already lower-cased) needle plus the one scope predicate. A
   * continuation anchor resolves only while it still belongs to this set.
   */
  private searchFilters(request: {
    readonly scope: 'all' | 'session' | 'directory'
    readonly sessionId?: string
    readonly cwd?: string
    readonly query: string
  }): { readonly conditions: string[]; readonly parameters: Array<string | number> } {
    const conditions: string[] = []
    const parameters: Array<string | number> = []
    const needle = request.query.toLowerCase()
    if (needle !== '') {
      conditions.push('instr(normalized_content, ?) > 0')
      parameters.push(needle)
    }
    if (request.scope === 'session') {
      conditions.push('session_id = ?')
      parameters.push(request.sessionId as string)
    } else if (request.scope === 'directory') {
      conditions.push('effective_cwd = ?')
      parameters.push(request.cwd as string)
    }
    return { conditions, parameters }
  }

  /**
   * Resolve one opaque continuation anchor to the original keyset tuple. The
   * row is found by its SQLite primary key only and must still carry the exact
   * scope/needle membership; a deleted, rebuilt or re-scoped row is stale. It
   * never selects the full `content` column.
   */
  resolveSearchAnchor(
    rowId: string,
    request: {
      readonly scope: 'all' | 'session' | 'directory'
      readonly sessionId?: string
      readonly cwd?: string
      readonly query: string
    },
  ): HistorySearchAfter | undefined {
    this.assertOpen()
    const filters = this.searchFilters(request)
    const row = this.db.prepare(
      `SELECT accepted_ms, session_id, first_seq, message_id
       FROM history_occurrences
       WHERE row_id = CAST(? AS INTEGER)${filters.conditions.length === 0 ? '' : ` AND ${filters.conditions.join(' AND ')}`}`,
    ).get(rowId, ...filters.parameters) as unknown as {
      readonly accepted_ms: number
      readonly session_id: string
      readonly first_seq: number
      readonly message_id: string
    } | undefined
    if (row === undefined) return undefined
    return {
      acceptedAt: row.accepted_ms,
      sessionId: row.session_id,
      firstEventSeq: row.first_seq,
      messageId: row.message_id,
    }
  }

  search(request: HistoryIndexSearchRequest): HistoryIndexSearchPage {
    this.assertOpen()
    const filters = this.searchFilters(request)
    const conditions = filters.conditions
    const parameters = filters.parameters
    const after = request.after
    if (after !== undefined) {
      if (request.scope === 'session') {
        conditions.push(`(
          accepted_ms < ? OR (accepted_ms = ? AND (
            first_seq < ? OR (first_seq = ? AND message_id > ?)
          ))
        )`)
        parameters.push(after.acceptedAt, after.acceptedAt, after.firstEventSeq, after.firstEventSeq, after.messageId)
      } else {
        conditions.push(`(
          accepted_ms < ? OR (accepted_ms = ? AND (
            session_id > ? OR (session_id = ? AND (
              first_seq < ? OR (first_seq = ? AND message_id > ?)
            ))
          ))
        )`)
        parameters.push(
          after.acceptedAt, after.acceptedAt,
          after.sessionId, after.sessionId,
          after.firstEventSeq, after.firstEventSeq, after.messageId,
        )
      }
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    // This projection NEVER selects `content`: a page only needs the stored
    // bounded preview, the exact UTF-16 length and the immutable hash. Full
    // bodies stay behind occurrence()/readText.
    const rows = this.db.prepare(
      `SELECT CAST(row_id AS TEXT) AS row_id,
              session_id, message_id, first_seq, accepted_ms, effective_cwd,
              preview, content_length, content_sha256, has_non_text
       FROM history_occurrences
       ${where}
       ORDER BY accepted_ms DESC, session_id ASC, first_seq DESC, message_id ASC
       LIMIT ?`,
    ).all(...parameters, request.limit + 1) as unknown as RawSearchRow[]
    return {
      rows: rows.slice(0, request.limit).map(searchRowOfRaw),
      hasMore: rows.length > request.limit,
    }
  }

  occurrence(sessionId: string, messageId: string): HistoryOccurrenceRow | undefined {
    this.assertOpen()
    const row = this.db.prepare(
      `SELECT session_id, message_id, first_seq, accepted_ms, effective_cwd,
              content, preview, content_length, content_sha256, has_non_text
       FROM history_occurrences WHERE session_id = ? AND message_id = ?`,
    ).get(sessionId, messageId) as unknown as RawOccurrenceRow | undefined
    return row === undefined ? undefined : occurrenceOfRaw(row)
  }

  sessionCount(): number {
    this.assertOpen()
    return (this.db.prepare('SELECT COUNT(*) AS count FROM history_sessions').get() as { count: number }).count
  }

  occurrenceCount(): number {
    this.assertOpen()
    return (this.db.prepare('SELECT COUNT(*) AS count FROM history_occurrences').get() as { count: number }).count
  }
}
