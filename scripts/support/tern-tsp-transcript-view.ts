/**
 * PR1 feasibility spike: the pure transcript mapper lives in the production
 * renderer module since PR3-A (`src/tui/tsp/transcript-view.ts`); this
 * re-export keeps the spike script and its tests on the SAME implementation
 * (one oracle, no second copy).
 * @module @xmoon76/dsh-pi-tui/scripts/support/tern-tsp-transcript-view
 */

export { TranscriptNodeKeys, transcriptView, type TranscriptViewOptions } from '../../src/tui/tsp/transcript-view.ts'
