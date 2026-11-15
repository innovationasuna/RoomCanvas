# Synthetic photo fixtures

`photo.heic` and `photo.png` contain the same 64 × 48 four-quadrant test pattern: red `(235,45,35)`, green `(40,200,60)`, blue `(35,60,225)`, yellow `(235,200,30)`. They contain no user photograph or location data.

Generated from a binary P6 PPM with those RGB values, using macOS `sips -s format heic photo.ppm --out photo.heic` and `sips -s format png photo.ppm --out photo.png`.

`check_object_photos.mjs` intentionally gives the HEIC bytes `.png` / `.jpg` names and incorrect MIME types to cover renamed iPhone photos. The output must be a real JPEG with unchanged dimensions and quadrant placement.
