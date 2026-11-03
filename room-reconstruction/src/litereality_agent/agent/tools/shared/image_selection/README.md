# Surface geometry and image selection

This package provides surface geometry, capture-frame analysis, and head-on
comparisons for render and selection tools.

## Surface views

[surface_views.py](surface_views.py) derives wall/floor/ceiling planes, projects
surface coverage, and selects sharp reference frames. Its `analyze` and `select`
functions provide coverage and blur signals; `highlight` draws the selected surface.

Default thresholds are Laplacian-variance blur below 60, wall area below 0.8 m²,
and wall side length below 0.4 m. Small walls are skipped.
Room/wall/object selection for agent requests belongs to
[select_views](../../select_views/), which also uses rendered object visibility.

## Surface comparison

The entry point is
[render/source/surface_compare.py](../../render/source/surface_compare.py),
specifically `build(room_dir, out_dir)`. It invokes
[surface_compare/render_ortho.py](surface_compare/render_ortho.py) in Blender and
[surface_compare/sheet.py](surface_compare/sheet.py) to pair renders with stitches.
The [render engine's ref mode](../../render/source/README.md#cli) exposes these
comparisons through the CLI.

The build returns `renders` and an optional `sheet`. Outputs include
`render/*_ortho.png`, `render/orient.json`, and `surface_compare.jpg`.
The calling configuration supplies scan, assets, Blender, and surface-reference paths.

### Geometry contract

- Planes come from the built Z-up scene.
- Wall groups include matching `Wall<N>` meshes; the thinnest PCA axis supplies
  the wall normal, and projected world-up supplies image-up.
- Floor/ceiling axes are derived from shell walls and disambiguated against the
  stitch dimensions. If this derivation fails, orientation can be ambiguous.
- Furniture is hidden for surface renders.
- `orient.json` records `sflip` for stitch mirroring and `rflip` for render
  mirroring, including the ceiling view.

Set `HARNESS_SURFACE_COMPARE=0` to disable optional surface comparison in callers
that consult its enable flag.
