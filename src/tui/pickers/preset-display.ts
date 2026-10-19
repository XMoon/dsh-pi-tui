/** The shipped-preset display copy, shared by every preset picker surface.
 *
 * Fixed in English — the web surface's `BUILT_IN_PRESET_KEYS` mapping
 * (`dsh-agent-preset-registry` display helpers), TUI-side. The shipped
 * declarations publish no `name` (the official built-in classification), and
 * their metadata language is not ours to control: mapping the known ids keeps
 * the pickers English regardless of what the declarations say; everything else
 * renders the declaration's own metadata. Names follow the upstream English
 * locale.
 * @module tui/pickers/preset-display
 */

const BUILT_IN_PRESET_COPY: Readonly<Record<string, { name: string; description: string }>> = {
  standard: {
    name: 'Standard mode',
    description: 'Full coding agent with file editing, shell, file and web search, skills, planning, goals, subagents, and workflows.',
  },
  ptc: {
    name: 'PTC mode',
    description: 'All Standard mode capabilities, with tools exposed through the PTC mode SDK so the model can combine multi-step operations in one TypeScript program.',
  },
  minimal: {
    name: 'Minimal mode',
    description: 'Minimal coding agent with a persistent shell.',
  },
  cordis: {
    name: 'Creator mode',
    description: 'Built for creating custom agent presets, with all Standard mode capabilities plus runtime inspection, plugin experiments, and preset-authoring guidance.',
  },
}

/** Whether one roster row is a SHIPPED preset under the official 0.1.7
 * classification: a known shipped id that publishes no `name` of its own.
 * A declaration that names itself — even with a shipped id — owns its
 * copy (the same rule as `isBuiltInPreset` upstream; kept local so the
 * display layer carries no runtime import). */
export function isBuiltInPresetRow(preset: {
  id: string
  name?: string
  description?: string
}): boolean {
  return preset.name === undefined && BUILT_IN_PRESET_COPY[preset.id] !== undefined
}

/** Resolve one roster row's display copy: the TUI's fixed English copy for
 * a shipped preset (official classification above), otherwise the preset's
 * own published metadata — a user-authored copy is never translated. */
export function presetDisplayText(preset: {
  id: string
  name?: string
  description?: string
}): { name: string; description?: string } {
  const builtIn = isBuiltInPresetRow(preset) ? BUILT_IN_PRESET_COPY[preset.id] : undefined
  if (builtIn !== undefined) return { name: builtIn.name, description: builtIn.description }
  return {
    name: preset.name ?? preset.id,
    ...preset.description === undefined ? {} : { description: preset.description },
  }
}
