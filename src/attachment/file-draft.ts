/**
 * Client-local generic file drafts (Stage C2).
 *
 * A file draft keeps only the source identity and display metadata. The source
 * is reopened and streamed at submit time; durable bytes belong to the DSH
 * attachment service, never this TUI store.
 * @module @xmoon76/dsh-pi-tui/attachment/file-draft
 */

import { formatBytes } from '../image/errors.ts'
import type { FileAttachmentRefLike } from './file-admission.ts'

/** Identity captured when a local file is attached. */
export interface DraftFileFingerprint {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
}

/** Where a generic file draft obtains its bytes at submit time. */
export type DraftFileSource =
  | {
      readonly type: 'path'
      readonly path: string
      readonly fingerprint: DraftFileFingerprint
    }
  | {
      readonly type: 'recalled'
      readonly ref: FileAttachmentRefLike
    }

/** One generic file staged in the Client-local editor draft. */
export interface DraftFile {
  readonly id: number
  readonly kind: 'file'
  readonly name: string
  readonly byteLength: number
  readonly placeholder: string
  readonly source: DraftFileSource
}

/** Input accepted by {@link DraftFileStore.add}. */
export interface DraftFileInput {
  readonly name: string
  readonly byteLength: number
  readonly source: DraftFileSource
}

/** Structural surface needed by combined placeholder expansion. */
export interface DraftFileStoreLike {
  values(): readonly DraftFile[]
}

/** Metadata-only generic file draft registry. */
export class DraftFileStore {
  private nextId = 1
  private readonly files = new Map<number, DraftFile>()
  private readonly pins = new Map<number, number>()

  /** Stage one file without reading or retaining its bytes. */
  add(input: DraftFileInput): DraftFile {
    const id = this.nextId++
    const file: DraftFile = {
      id,
      kind: 'file',
      name: input.name,
      byteLength: input.byteLength,
      source: input.source,
      placeholder: formatFilePlaceholder(id, input.byteLength),
    }
    this.files.set(id, file)
    return file
  }

  /** The staged draft for an id, or undefined when unknown/removed. */
  get(id: number): DraftFile | undefined {
    return this.files.get(id)
  }

  /** Remove one staged draft; returns whether it was staged. */
  remove(id: number): boolean {
    return this.files.delete(id)
  }

  /** Remove all file drafts and their in-flight reservations. */
  clear(): void {
    this.files.clear()
    this.pins.clear()
  }

  /** Remove every unpinned file draft. */
  clearUnpinned(): void {
    for (const id of this.files.keys()) {
      if (!this.isPinned(id)) this.files.delete(id)
    }
  }

  /** All staged file drafts in insertion order. */
  values(): readonly DraftFile[] {
    return [...this.files.values()]
  }

  /** Reserve placeholders for one in-flight submission. */
  pinReferenced(text: string): () => void {
    const ids: number[] = []
    for (const file of this.files.values()) {
      if (!text.includes(file.placeholder)) continue
      this.pins.set(file.id, (this.pins.get(file.id) ?? 0) + 1)
      ids.push(file.id)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      for (const id of ids) {
        const count = this.pins.get(id)
        if (count === undefined || count <= 1) this.pins.delete(id)
        else this.pins.set(id, count - 1)
      }
    }
  }

  /** Whether a file draft is reserved by an in-flight submission. */
  isPinned(id: number): boolean {
    return (this.pins.get(id) ?? 0) > 0
  }
}

/** The canonical generic-file editor placeholder. */
export function formatFilePlaceholder(id: number, byteLength: number): string {
  return `[file #${id} (${formatBytes(byteLength)})]`
}
