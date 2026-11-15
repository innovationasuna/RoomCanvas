# heic-to 1.6.7

Unmodified `dist/csp/heic-to.js` from [heic-to 1.6.7](https://www.npmjs.com/package/heic-to/v/1.6.7), loaded only for HEIC/HEIF photos. Its bundled worker decodes photos locally, without a CDN or conversion service. It can be replaced independently with a compatible build.

- [Project and build instructions](https://github.com/hoppergee/heic-to)
- [Published package with wrapper/worker source and build script](https://registry.npmjs.org/heic-to/-/heic-to-1.6.7.tgz)
- [libheif 1.23.7 source](https://github.com/strukturag/libheif/tree/v1.23.7)
- [libde265 1.0.16 source](https://github.com/strukturag/libde265/tree/v1.0.16)
- License: LGPL-3.0-or-later; see [LICENSE](LICENSE) and [COPYING-GPL-3.0](COPYING-GPL-3.0).

SHA-256 of `heic-to.js`: `e0a515585872c319c601c33551925c9d5fee31746caf0311291ed7e6364c592c`.

The adapter is `web/editor/object-photos.mjs`. It detects the image format from bytes, converts HEIC to JPEG, and checks that the resulting preview decodes before adding it to the upload list. JPEG/PNG pixel data is not recompressed.
