/** Opt-in fullscreen scroll-frame profiling for local diagnosis (disabled
 * unless `DSH_TUI_SCROLL_PROFILE=1`). One line per SCROLL frame — a frame
 * whose render request was opened by a fullscreen `ScrollView.scrollBy` —
 * covering the stages the host owns plus the dimensions needed to attribute
 * a slow scroll frame. This is intentionally separate from
 * `DSH_TUI_RENDER_PROFILE` (transcript presentation commits), which answers
 * a different question. */

export interface ScrollProfileFrame {
  /** scroll input -> painted frame latency (ms), including scheduler wait. */
  readonly latency: number
  /** `terminal.write` time accumulated during the frame (ms). */
  readonly write: number
  /** `commitFullscreenPaintSnapshot` total (ms). */
  readonly snapshot: number
  /** `refreshMessageRows` inside the snapshot commit (ms). */
  readonly refresh: number
  /** `remeasureTranscriptBlocks` inside `refreshMessageRows` (ms). */
  readonly remeasure: number
  /** the per-row owner/hit snapshot map after the refresh (ms). */
  readonly hits: number
  /** terminal bytes written during the frame. */
  readonly bytes: number
  /** viewport rows rewritten (erase-in-line count approximation). */
  readonly rowsRewritten: number
  /** mounted transcript blocks. */
  readonly blocks: number
  /** rendered transcript row height sum. */
  readonly rows: number
  /** scroll viewport height in rows. */
  readonly viewport: number
  /** current scroll offset. */
  readonly scrollTop: number
  /** active display preset. */
  readonly preset: string
  /** whether the transcript search overlay is open. */
  readonly searchActive: boolean
}

export interface ScrollRenderProfiler {
  /** Whether profiling is enabled for this process. */
  readonly enabled: boolean
  emit(frame: ScrollProfileFrame): void
}

export function createScrollRenderProfiler(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ScrollRenderProfiler {
  const enabled = environment.DSH_TUI_SCROLL_PROFILE === '1'
  return {
    enabled,
    emit: frame => {
      if (!enabled) return
      const parts = [
        `scroll frame=${frame.latency.toFixed(2)}ms`,
        `write=${frame.write.toFixed(2)}ms`,
        `snapshot=${frame.snapshot.toFixed(2)}ms`,
        `refresh=${frame.refresh.toFixed(2)}ms`,
        `remeasure=${frame.remeasure.toFixed(2)}ms`,
        `hits=${frame.hits.toFixed(2)}ms`,
        `bytes=${frame.bytes}`,
        `rowsRW=${frame.rowsRewritten}`,
        `blocks=${frame.blocks}`,
        `rows=${frame.rows}`,
        `viewport=${frame.viewport}`,
        `scrollTop=${frame.scrollTop}`,
        `preset=${frame.preset}`,
        `search=${frame.searchActive ? 'on' : 'off'}`,
      ]
      console.error(parts.join(' '))
    },
  }
}
