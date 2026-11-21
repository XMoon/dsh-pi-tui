/**
 * The Host-owned stored-credential RECORD bridge (M6-1 F7B).
 *
 * The installed official `ctx.credentials` store remains the ONLY authority for
 * record storage, presence and deletion: this service is a metadata-only
 * transport bridge that never writes a record, never caches one, never
 * reimplements the store's file lock/YAML/queue and never invents a record
 * event.
 *
 * ```text
 * list()             -> every stored record's { key, kind } (values excluded)
 * delete(exactKey)   -> the official deleteRecord(exactKey) (absent = no-op)
 * ```
 *
 * Both methods are Owner-only and fail closed BEFORE reading or mutating the
 * official store. A Host without the official credentials plugin still becomes
 * Ready (the bridge itself mounts), and its calls are a definite
 * service-unavailable failure — never an empty successful record list.
 *
 * @module @xmoon76/dsh-pi-tui/app/host/features/credential-records
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, type RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { parseCredentialKey, type CredentialKey, type CredentialRecordEntry } from '@deepseek-ai/dsh-credentials'
import {
  PI_TUI_CREDENTIAL_RECORDS_NAMESPACE,
  parsePiTuiCredentialRecordList,
  type CredentialRecordMetadata,
} from '../../../runtime/remote/pi-tui-credential-records-contract.ts'

/**
 * The narrow official credential store face this bridge consumes. Structural,
 * so this Host feature carries no Direct-adapter dependency.
 */
export interface CredentialRecordsStoreLike {
  listRecords(): Promise<readonly CredentialRecordEntry[]>
  deleteRecord(key: CredentialKey): Promise<void>
}

/** The official store, resolved PER CALL: a Host without the plugin is a
 *  truthful service-unavailable failure instead of a hard inject. */
export type PiTuiCredentialRecordsHostDeps = {
  credentials(): CredentialRecordsStoreLike | undefined
}

export class PiTuiCredentialRecordsHostService extends TypertRemoteService {
  static readonly inject = ['typert']

  private readonly deps: PiTuiCredentialRecordsHostDeps

  constructor(ctx: Context, deps: PiTuiCredentialRecordsHostDeps) {
    super(ctx, PI_TUI_CREDENTIAL_RECORDS_NAMESPACE)
    this.deps = deps
  }

  /**
   * Enumerate the official store's metadata. Every row is rebuilt as a detached
   * `{key,kind}` value (never spread/stringified from the official record) and
   * the WHOLE result is validated: an unusable official projection fails the
   * call instead of being filtered out and reported as the complete truth.
   */
  async list(signal: AbortSignal): Promise<readonly CredentialRecordMetadata[]> {
    signal.throwIfAborted()
    this.assertOwner()
    const store = this.store()
    const records = await store.listRecords()
    return parsePiTuiCredentialRecordList(records.map(record => ({
      key: record.key as unknown as string,
      kind: record.kind,
    })))
  }

  /**
   * Delete exactly one official record. The key is re-validated with the
   * official `parseCredentialKey()` before the store is touched, so an invalid
   * argument is a definite refusal. Any legal `<scope>/<id>` is accepted — an
   * unregistered plugin's orphan record included — and an absent key stays the
   * official no-op. The official store's lock/atomic write/event semantics are
   * the sole durable commit path.
   */
  async delete(key: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.assertOwner()
    let exact: CredentialKey
    try {
      exact = parseCredentialKey(key)
    } catch {
      throw new Error('piTuiCredentialRecords: the key is not a valid <scope>/<id> credential key')
    }
    const store = this.store()
    try {
      await store.deleteRecord(exact)
    } catch {
      // The official store's own diagnostics may carry the record or the Host
      // file path: the wire only ever sees this fixed, safe message.
      throw new Error('piTuiCredentialRecords: the Host could not delete the stored credential record')
    }
  }

  private store(): CredentialRecordsStoreLike {
    const store = this.deps.credentials()
    if (store === undefined) {
      throw new Error('piTuiCredentialRecords: the Host credentials service is not installed')
    }
    return store
  }

  /** The exact authenticated-Owner gate, run before any store access. */
  private assertOwner(): void {
    const invocation = this.ctx.invocation
    if (!this.isOwnerInvocation(invocation)) {
      throw new Error('piTuiCredentialRecords: stored credential records are restricted to the authenticated Owner peer')
    }
  }

  private isOwnerInvocation(invocation: RemoteInvocation | undefined): invocation is RemoteInvocation {
    return invocation !== undefined
      && invocation.peer.principal.kind === 'owner'
      && !invocation.signal.aborted
      && !invocation.peer.signal.aborted
  }
}
