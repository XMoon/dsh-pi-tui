/**
 * The Job Output retained-preview scroll owner (Phase 3B / B1-B, plan
 * DECISION-02): the ONE client-local follow-intent authority of a Job
 * workspace.
 *
 * The vendored `ScrollView` re-arms its native follow-end on its own terms —
 * reaching the content end, a content shrink, a viewport growth (X055) — which
 * is deliberately NOT the Job product contract: the user leaves the tail by
 * scrolling, paging, dragging the scrollbar or landing a search hit, and ONLY a
 * physical `End` brings it back. This subclass therefore owns the explicit
 * intent and normalizes every public scroll path the fork really calls:
 * `scrollBy` (wheel / page / line), `scrollTo` (scrollbar drag / jump),
 * `scrollToStart`, `scrollToEnd` and `updateLayout` (resize / content shrink).
 *
 * It holds no durable fact and adds no timer of its own — the inherited
 * `dispose()` releases the fork's scrollbar timer and viewport callback.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/job-output-scroll-view
 */

import { ScrollView, type ScrollViewScrollToOptions } from '@xmoon76/pi-tui'

/**
 * The strict-follow retained Output viewport. Construct it exactly like the
 * `ScrollView` it replaces (`follow: 'end'`, `primary: true`,
 * `scrollbar: 'auto'`): the native tail-follow behavior still paints the
 * newest retained lines while the intent holds, and {@link isFollowRequested}
 * is the ONLY follow truth the Action Bar may read.
 */
export class JobOutputScrollView extends ScrollView {
  /** The ONE client-local follow intent. Never re-derived from `scrollTop`. */
  private followRequested = true

  /** The user's current follow intent (NOT `ScrollView.isFollowingEnd`). */
  get isFollowRequested(): boolean {
    return this.followRequested
  }

  /**
   * Suspend follow while keeping the current viewport: the explicit intent goes
   * false FIRST and the native suppression is written even when the viewport
   * already sits exactly at the content end, so "the user is at the bottom"
   * can never be mistaken for "the user wants to follow".
   */
  pauseFollow(): void {
    this.followRequested = false
    super.scrollTo(this.scrollTop, { disableFollow: true })
  }

  /**
   * The explicit re-arm: the ONLY path that turns follow back on. It bypasses
   * this subclass's own `scrollToEnd` override (which is an ordinary manual
   * jump) and restores the inherited tail-follow behavior.
   */
  resumeFollow(): void {
    this.followRequested = true
    super.scrollToEnd()
  }

  /**
   * Re-position the retained preview WITHOUT touching the follow intent. Used
   * by the retention anchor rebase: a new bounded window must keep the same
   * provable visual row visible, whether the intent is currently FOLLOW or
   * PAUSED. The inherited clamp applies.
   */
  rebaseTo(scrollTop: number): void {
    super.scrollTo(scrollTop, { disableFollow: true })
  }

  /** A wheel/page/line scroll is manual browsing: pause, move, then re-write
   *  the native suppression so reaching the last row never re-arms follow.
   *  The fork's remaining-delta return value is preserved. */
  override scrollBy(lines: number): number {
    this.pauseFollow()
    const remaining = super.scrollBy(lines)
    super.scrollTo(this.scrollTop, { disableFollow: true })
    return remaining
  }

  /** A scrollbar drag or a search-target jump is manual browsing. The caller's
   *  options never re-arm follow. */
  override scrollTo(scrollTop: number, _options: ScrollViewScrollToOptions = {}): void {
    this.pauseFollow()
    super.scrollTo(scrollTop, { disableFollow: true })
  }

  /** `Home` / scroll-to-top: pause and suppress, even on short content. */
  override scrollToStart(): void {
    this.pauseFollow()
    super.scrollToStart()
    super.scrollTo(this.scrollTop, { disableFollow: true })
  }

  /** A viewport-requested jump to the end (e.g. a remapped `Ctrl+End`) is a
   *  manual jump, NEVER the follow re-arm: it pauses, jumps and suppresses.
   *  Only {@link resumeFollow} may arm follow again. */
  override scrollToEnd(): void {
    this.pauseFollow()
    super.scrollToEnd()
    super.scrollTo(this.scrollTop, { disableFollow: true })
  }

  /** After a resize or a content shrink the inherited layout pass may clamp the
   *  viewport onto the new end (and X055 re-arm on growth). While the intent is
   *  PAUSED the position is re-suppressed immediately, so a passive relayout
   *  can never steal the user's historical row. While the intent is FOLLOW the
   *  inherited tail-follow behavior is kept untouched. */
  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    super.updateLayout(contentHeight, viewportHeight, requestRender)
    if (!this.followRequested) super.scrollTo(this.scrollTop, { disableFollow: true })
  }
}
