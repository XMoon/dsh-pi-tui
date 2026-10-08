/**
 * Media-pipeline error vocabulary (plan §20). Every error carries an
 * ACTIONABLE message; callers surface them to the user verbatim (or as
 * notices), never as bare stack traces.
 *
 * The hierarchy is the historical one: TS8-C normalizes ownership, not the
 * error API. `FileInputError` extends `ImageInputError` unchanged.
 * @module @xmoon76/dsh-pi-tui/domain/media/errors
 */

import { formatBytes } from './format.ts'

/** Base class for every TUI image-pipeline failure. */
export class ImageInputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ImageInputError'
  }
}

/** The bytes do not decode to a supported raster format. */
export class UnsupportedImageTypeError extends ImageInputError {
  constructor(detail = '') {
    super(`Unsupported image format. Supported: PNG, JPEG, WebP, GIF.${detail === '' ? '' : ` ${detail}`}`)
    this.name = 'UnsupportedImageTypeError'
  }
}

/** The source bytes exceed the deployment's per-image attachment limit. */
export class ImageTooLargeError extends ImageInputError {
  constructor(bytes: number, limit: number) {
    super(`Image is ${formatBytes(bytes)}; current attachment limit is ${formatBytes(limit)}.`)
    this.name = 'ImageTooLargeError'
  }
}

/** The image violates the deployment's dimension/pixel limits. */
export class ImageDimensionError extends ImageInputError {
  constructor(message: string) {
    super(message)
    this.name = 'ImageDimensionError'
  }
}

/** The clipboard lookup failed (distinct from "clipboard has no image"). */
export class ClipboardImageError extends ImageInputError {
  constructor(message = 'Failed to read image from clipboard.') {
    super(message)
    this.name = 'ClipboardImageError'
  }
}

/** The harness rejected the staged images at admission time. */
export class ImageAdmissionError extends ImageInputError {
  constructor(message: string) {
    super(message)
    this.name = 'ImageAdmissionError'
  }
}

/** A durable attachment could not be restored from session storage. */
export class ImageLoadError extends ImageInputError {
  constructor(message = 'Image attachment could not be restored from session storage.') {
    super(message)
    this.name = 'ImageLoadError'
  }
}

/** The current provider/model cannot accept image input. */
export class ModelImageUnsupportedError extends ImageInputError {
  constructor(provider: string, model: string) {
    super(`Current model \`${provider}/${model}\` does not support image input.`)
    this.name = 'ModelImageUnsupportedError'
  }
}

/** User-facing error for local generic-file intake and admission failures. */
export class FileInputError extends ImageInputError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FileInputError'
  }
}
