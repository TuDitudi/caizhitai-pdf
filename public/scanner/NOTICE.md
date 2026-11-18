# Scanner resources

Photos are processed locally. These files are served from the same website; no external CDN is used at runtime.

## OpenCV 4.13.0

- Upstream build: https://docs.opencv.org/4.13.0/opencv.js
- Upstream source and build instructions: https://github.com/opencv/opencv/tree/4.13.0/platforms/js
- License: Apache-2.0, see LICENSE-opencv.txt (including upstream notices).
- Upstream JavaScript SHA-256: `63366510248adf3a7eddf3e793dd825404efb7df3749f4d6f8557c7fa4ca8aa0`.
- Modified for this distribution on 2026-11-18: generated embind Function constructors replaced with equivalent closures, preserving argument conversion and destruction. This permits the existing strict CSP without enabling unsafe-eval.
- Reproduction: `node scripts/prepare-scanner-assets.mjs /path/opencv.js /path/extracted-heic-to-package`.

## heic-to 1.6.7 CSP decoder

- Package/source: https://github.com/hoppergee/heic-to and https://registry.npmjs.org/heic-to/-/heic-to-1.6.7.tgz
- Package SHA-256: `ed832bff73338b418ea9ea7882787798cd4df15429a649603c4b950e7ba06f11`.
- License: LGPL-3.0-or-later; see LICENSE-heic-to.txt and LICENSE-GPL-3.0.txt.
- Includes libheif 1.23.7 (https://github.com/strukturag/libheif/tree/v1.23.7) and libde265 (https://github.com/strukturag/libde265), which retain their upstream licenses. Upstream build instructions: https://github.com/hoppergee/heic-to#how-to-build-libheifjs-from-libheif-on-mac .
- The CSP decoder worker is extracted from the pinned upstream JavaScript. This distribution adds a 40-megapixel allocation guard and transfers its output buffer rather than copying it. The decoder remains an independently loaded, replaceable worker; it is not included in the application's MIT license.

The application code in scan-worker.js and lib/scanner/ is part of Caizhitai under the repository's MIT license. The third-party files above retain their own licenses.
