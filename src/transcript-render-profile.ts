/** Opt-in transcript presentation profiling for local diagnosis. */

export type TranscriptProfileKind = 'structural' | 'content' | 'noop'

export interface TranscriptProfileFields {
  readonly reason?: string
  readonly dirty?: number
  readonly visible?: number
  readonly rows?: number
}

export interface TranscriptRenderProfiler {
  begin(): number | undefined
  mark(start: number | undefined): number | undefined
  finish(
    start: number | undefined,
    classifiedAt: number | undefined,
    kind: TranscriptProfileKind,
    fields: TranscriptProfileFields,
  ): void
}

export function createTranscriptRenderProfiler(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TranscriptRenderProfiler {
  const enabled = environment.DSH_TUI_RENDER_PROFILE === '1'
  return {
    begin: () => enabled ? performance.now() : undefined,
    mark: start => start === undefined ? undefined : performance.now(),
    finish: (start, classifiedAt, kind, fields) => {
      if (start === undefined || classifiedAt === undefined) return
      const end = performance.now()
      const parts = [
        `transcript kind=${kind}`,
        `classify=${(classifiedAt - start).toFixed(2)}ms`,
        `update=${(end - classifiedAt).toFixed(2)}ms`,
      ]
      if (fields.reason !== undefined) parts.push(`reason=${fields.reason}`)
      if (fields.dirty !== undefined) parts.push(`dirty=${fields.dirty}`)
      if (fields.visible !== undefined) parts.push(`visible=${fields.visible}`)
      if (fields.rows !== undefined) parts.push(`rows=${fields.rows}`)
      parts.push(`total=${(end - start).toFixed(2)}ms`)
      console.error(parts.join(' '))
    },
  }
}
