/**
 * Image-8 / I8-1C — the inline JavaScript source of the single SIXEL encode
 * worker.
 *
 * It is a string, not a build entry: the worker is created with
 * `new Worker(source, { eval: true, workerData })` so the published package
 * gains no extra module, no extra export and no extra file to resolve. The
 * worker receives ONLY already-bounded RGBA, the palette the parent derived
 * from those exact pixels, and the absolute path of the pinned CJS codec.
 *
 * The parent owns quantization on purpose: `image2sixel()` runs the library's
 * internal quantizer, which collapses ordinary balanced-color images to a
 * single averaged color. `sixelEncode()` with an explicit palette paints
 * exactly the colors it is given, so the worker only has to wrap the codec
 * output in the DCS introducer and terminator.
 *
 * Keep this file dependency-free plain JavaScript: it is evaluated, not
 * compiled, so it may not use TypeScript syntax or import the repository.
 * @module @xmoon76/dsh-pi-tui/client/media/sixel/worker-source
 */

/**
 * Inline worker body.
 *
 * Protocol:
 * - in:  `{ modulePath, rgba, width, height, palette, backgroundSelect }`
 * - out: `{ ok: true, sequence }` or `{ ok: false, message }`
 */
export const SIXEL_WORKER_SOURCE = `
'use strict';
const { parentPort, workerData } = require('node:worker_threads');

function reply(message) {
  parentPort.postMessage(message);
}

try {
  const codec = require(workerData.modulePath);
  if (typeof codec.sixelEncode !== 'function' || typeof codec.introducer !== 'function') {
    throw new TypeError('sixel codec does not expose sixelEncode/introducer');
  }
  const { rgba, width, height, palette, backgroundSelect } = workerData;
  // The codec reads RGBA through \`new Uint32Array(data.buffer)\`, so a view with
  // a non-zero byteOffset would quantize unrelated memory. Fail fast instead.
  if (rgba.byteOffset !== 0 || rgba.buffer.byteLength !== rgba.byteLength) {
    throw new RangeError('RGBA must be a contiguous Uint8Array at byteOffset 0');
  }
  const body = codec.sixelEncode(rgba, width, height, palette);
  if (typeof body !== 'string' || body.length === 0) {
    throw new TypeError('sixel codec returned an empty payload');
  }
  reply({ ok: true, sequence: codec.introducer(backgroundSelect) + body + codec.FINALIZER });
} catch (error) {
  reply({ ok: false, message: error instanceof Error ? error.message : String(error) });
}
`
