/**
 * Terminal bracketed-paste candidate grammar for an automatically attached
 * image file.
 *
 * Real terminals that keep a pasted file on disk (Tern, Hedr, ...) send the
 * file path as ordinary bracketed-paste TEXT with exactly one trailing ASCII
 * space as the terminal's separator. The paste is indistinguishable from
 * typed text once it reaches the editor, so the ONE place that can recognise
 * the shape is the paste entry itself.
 *
 * This module is the PURE candidate grammar: it only answers "does this paste
 * body look like one absolute image file path?". It never touches the
 * filesystem, never parses shell words and never decides the MIME type — the
 * extension filter is a cheap candidate gate, and `readImageFile()` stays the
 * single content/size/dimension authority. The caller applies it only to a
 * REAL paste receipt, never to typed text or an `indexOf` scan of the draft.
 * @module @xmoon76/dsh-pi-tui/client/media/image/pasted-path
 */

/** The one trailing ASCII space a terminal appends as its paste separator. */
const PASTE_SEPARATOR = ' '

/** Candidate extensions (case-insensitive). Content remains the authority. */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif']

/** The maximum paste body the fork editor stores as text (larger pastes
 *  become a `[paste #N ...]` marker); the grammar refuses anything this large
 *  so a candidate can never be a paste-marker insertion. */
export const PASTE_CANDIDATE_MAX_LENGTH = 1000

/** Whether `text` contains an ASCII control character. */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** Whether the basename's extension is one of the image candidates. */
function hasImageExtension(path: string): boolean {
  const slash = path.lastIndexOf('/')
  const basename = path.slice(slash + 1)
  const dot = basename.lastIndexOf('.')
  // A leading dot is a hidden-file name, not an extension.
  if (dot <= 0) return false
  const extension = basename.slice(dot).toLowerCase()
  return IMAGE_EXTENSIONS.includes(extension)
}

/**
 * The ONE candidate grammar for a pasted image file path.
 *
 * Accepted only when ALL hold:
 * - the body has no control characters (no newline/CR/NUL/ESC/tab) and is at
 *   most {@link PASTE_CANDIDATE_MAX_LENGTH} UTF-16 units;
 * - it ends with EXACTLY one ASCII space (the terminal separator) and the
 *   body before it does not end with another space;
 * - it is an absolute POSIX path: starts with a single `/`, so URLs (`//`),
 *   `~`, `./`, Windows drive/UNC forms and shell fragments never match;
 * - the basename extension is a case-insensitive image candidate.
 *
 * The returned path is the body verbatim — interior spaces, CJK and symbols
 * are accepted, no trimming, URI decoding, shell expansion or word splitting
 * happens here.
 * @param text - the COMPLETE bracketed-paste body (never a draft scan).
 */
export function candidateImagePathFromPaste(text: string): { path: string } | undefined {
  if (text.length === 0 || text.length > PASTE_CANDIDATE_MAX_LENGTH) return undefined
  if (hasControlCharacter(text)) return undefined
  if (!text.endsWith(PASTE_SEPARATOR)) return undefined
  const path = text.slice(0, -1)
  if (path === '' || path.endsWith(PASTE_SEPARATOR)) return undefined
  // Absolute POSIX path only: a protocol-relative `//host/...` is a URL.
  if (!path.startsWith('/') || path.startsWith('//')) return undefined
  // Several space-separated absolute paths are ONE terminal paste body too.
  // A space immediately before a `/` starts a new path component that looks
  // like a second absolute path — the concatenated-path shape — while ordinary
  // interior spaces (CJK, "My Documents") are followed by a name character.
  if (path.includes(' /')) return undefined
  if (!hasImageExtension(path)) return undefined
  return { path }
}
