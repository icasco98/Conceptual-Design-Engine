# Vendored third-party code

## polygon-clipping 0.15.7 (MIT)

<https://github.com/mfogel/polygon-clipping> — boolean operations on
polygons (union, difference, intersection).

Vendored rather than loaded from a CDN so the diagram stays a
self-contained HTML document with no external network dependency, which
is what `src/interactive_canvas.py` promises. It is read from disk and
inlined into the page at render time (see `_polygon_clipping_js`).

`src/interactive_canvas.py` uses it for three things: subtracting a
rotated room's footprint from the neighbor it bites into, filling the gap
a rotation opens next to a square room, and unioning every room's shape
into the building footprint outline. All three were previously hand-rolled
computational geometry, which is where this project's outline bugs kept
coming from.

Update with:

    npm pack polygon-clipping@<version>
    tar xzf polygon-clipping-<version>.tgz
    cp package/dist/polygon-clipping.umd.min.js src/vendor/
    cp package/LICENSE.md src/vendor/polygon-clipping.LICENSE.md
