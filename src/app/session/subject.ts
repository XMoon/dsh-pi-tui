/**
 * Opaque, transport-neutral session ownership subject (plan A2 §9.6).
 *
 * A `SessionSubject` pins the EXACT current session-owner generation. It is
 * deliberately NOT `{ sessionId }`: the same session id re-retained later is a
 * NEW ownership generation, and comparing only the id would wrongly treat the
 * old owner as current (plan §6.2).
 *
 * Identity model:
 * - `OwnerRef` is an opaque object minted by a BACKEND; `app/session` never
 *   inspects it. A backend must keep one owner ref per exact owner it serves,
 *   so the same owner re-wrapped into a new `SessionHandle` resolves to the
 *   SAME `OwnerRef`.
 * - A captured subject compares equal ONLY when both the exact `OwnerRef`
 *   object AND the generation match. The subject TOKEN itself is never an
 *   identity: `current()`/`capture()` mint a fresh token each time, and
 *   `isCurrent()` compares the pinned record against the live record.
 *
 * The authority keeps NO mutable current state of its own: it reads the
 * runtime's single private owner/generation slot through the supplied `peek`,
 * so it can never become a second owner authority.
 * @module @xmoon76/dsh-pi-tui/app/session/subject
 */

declare const sessionSubjectBrand: unique symbol
declare const sessionOwnerRefBrand: unique symbol

/**
 * An OPAQUE handle to one exact session owner. `app/session` never inspects it;
 * a backend mints one per exact owner it serves (so a re-wrapped handle keeps
 * the SAME owner ref). Branding keeps any stray `object` from being accepted at
 * the type level.
 */
export interface SessionOwnerRef {
  readonly [sessionOwnerRefBrand]: true
}

/** An opaque session-ownership subject token (never an identity by itself). */
export interface SessionSubject {
  readonly [sessionSubjectBrand]: true
}

/**
 * The exact ownership record a captured subject pins. `owner` is the opaque
 * `SessionOwnerRef`; `generation` is the runner's session generation at capture.
 */
export interface SessionSubjectRecord {
  readonly owner: SessionOwnerRef
  readonly generation: number
}

/** Capture/currentness authority over the runtime's single ownership slot. */
export interface SessionSubjectAuthority {
  /** The current subject (a fresh token), or `undefined` when sessionless. */
  current(): SessionSubject | undefined
  /** Capture the EXACT current owner generation for later fencing. */
  capture(): SessionSubject | undefined
  /** True only for the same exact owner AND the same generation. */
  isCurrent(subject: SessionSubject): boolean
}

/**
 * Build the authority over a READ-ONLY peek of the runtime's private
 * `{ owner, generation }` slot. `peek` must read live state (never a snapshot).
 */
export function createSessionSubjectAuthority(
  peek: () => SessionSubjectRecord | undefined,
): SessionSubjectAuthority {
  const pinned = new WeakMap<SessionSubject, SessionSubjectRecord>()

  const mint = (record: SessionSubjectRecord): SessionSubject => {
    const subject = {} as SessionSubject
    // COPY the captured values: a provider that reuses and mutates one record
    // object in place must never move an already-captured subject.
    pinned.set(subject, { owner: record.owner, generation: record.generation })
    return subject
  }

  const capture = (): SessionSubject | undefined => {
    const record = peek()
    return record === undefined ? undefined : mint(record)
  }

  return {
    current: capture,
    capture,
    isCurrent: (subject) => {
      const record = pinned.get(subject)
      if (record === undefined) return false
      const live = peek()
      return live !== undefined && live.owner === record.owner && live.generation === record.generation
    },
  }
}
