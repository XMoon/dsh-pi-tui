# Image-6A transcript image fixtures

Real, decodable raster fixtures for the Kitty JPEG/WebP preview tests
(`test/client/kitty-thumbnail.test.ts`, `test/client/image-thumbnail.test.ts`,
`test/client/image-transcript.test.ts`, `test/client/transcript-image-viewer-tui.test.ts`).
They were generated once OUTSIDE the repository with Pillow 11.1.0 and are
committed as bytes; no test synthesizes a header-only or truncated "valid"
image.

Generation recipe (outside repo, one-off):

- `transcript-sample.jpg` / `transcript-sample.webp` / `transcript-sample.png`:
  120×80 with red/green/blue vertical thirds, JPEG quality 85, WebP quality 85.
- `transcript-alpha.webp`: 48×32 RGBA, left half fully transparent, right half
  opaque green, lossless.
- `transcript-animated.webp`: 64×40, two lossless frames (red then blue),
  duration 120 ms, loop forever.
- `transcript-oriented.jpg`: stored 60×30 (left half red, right half blue) with
  EXIF orientation 6 (the displayed orientation is 90° clockwise), quality 90.
- `transcript-over-limit.jpg`: 5001×5000 (25,005,000 pixels, above the
  25,000,000-pixel decode ceiling), solid #202020, quality 40.
- `transcript-corrupt.jpg`: the first 300 bytes of `transcript-sample.jpg`.
- `transcript-corrupt.webp`: the first 40 bytes of `transcript-sample.webp`.
- `transcript-sample.gif`: 64×40 GIF, left half red / right half blue (the GIF
  negative control: it must never enter the JPEG/WebP preview pipeline).

| file | bytes | format | stored size | frames | sha256 |
|---|---:|---|---|---:|---|
| transcript-alpha.webp | 46 | WEBP (RGBA) | 48×32 | 1 | `bb02f1fdcec8e69ee2e3fae61866ae4a69e2a302c0d3ef4b924e6fce3940dcd9` |
| transcript-animated.webp | 140 | WEBP | 64×40 | 2 | `34f1b69f261f31471d9d4443264fc0ea6396f86502b3ef8cd72d5267ce3ccaee` |
| transcript-corrupt.jpg | 300 | truncated JPEG | — | — | `353ae2a508e3e5c8972ee67895b861a1e9b6f54f75e4c234521d9a9f3f525cf2` |
| transcript-corrupt.webp | 40 | truncated WebP | — | — | `8c9a7ad86ae39d9d61abe3dea0795cec305154344950c8e4fb2700ffaae266e9` |
| transcript-oriented.jpg | 824 | JPEG (EXIF 6) | 60×30 | 1 | `ef360f3f50655492a84c3d20968af4400ef0a089578302eb2be7f3eaf7ba68e6` |
| transcript-over-limit.jpg | 147236 | JPEG | 5001×5000 | 1 | `cd70f622d13c9b4684d2a2a403120771b3a1ce873a42f2e2daa503f592a0863c` |
| transcript-sample.gif | 201 | GIF | 64×40 | 1 | `0efe3d5afad796cd09874d3f04704069c55168e20cd9f6c71a1835736761f269` |
| transcript-sample.jpg | 968 | JPEG | 120×80 | 1 | `4214617fbdb52c00bb07a3fefaeeb59df723cede837e5b3badc02c8d0462637a` |
| transcript-sample.png | 258 | PNG | 120×80 | 1 | `8b2bdc3a23c39d4540653d82a03316936786349f1d9d594fc4efdf4040e81871` |
| transcript-sample.webp | 138 | WEBP | 120×80 | 1 | `38af95677a16e355b47251ddbd95b4c447540e4fa77eff181230a91d0ea53b6c` |
