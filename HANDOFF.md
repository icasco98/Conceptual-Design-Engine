# Handoff

Written for whoever picks this up next, human or Claude. The README says
what the tool is and how to run it; this file says *where the work
stands* and what to be careful of.

Branch: `claude/zoning-editor-rebuild-shnp69`. It was forked from
`claude/design-engine-tool-access-92y89p`, which still holds the full
generating version (Claude intake, packers, planner, access and stacking
checks, site and setbacks). Do not develop there; do not delete it either
— stage 6 and whatever comes after it will want pieces back.

The owner is not a programmer. Explain changes in plain terms, say when
they need to pull in GitHub Desktop, and never assume a build step is
obvious.

---

## Why the fork

The generated diagrams were never realistic: a long central hallway every
time, rigid rectangles only, an unconvincing footprint. The decision was
to isolate the interactive editor as a clean, manually driven tool, make
it good on its own, and reintegrate assisted generation afterwards. The
six stages are listed in the README; this file tracks them.

## Stage 1 — fork and strip: done

Removed, and why:

- `src/` in its entirety. Extraction, the Claude client, the layout plan,
  the row and spine packers, the planner and its scoring, access,
  stacking, orientation, levels, validation, the site envelope, the
  Python models and defaults. None of it was reachable once nothing
  packs or checks a plan.
- `api/serialize.py` — the site-frame ↔ plan-frame contract. There is
  one frame now (the canvas's, y down) and the backend stores boxes in it
  untouched.
- `/api/layout`, `/api/check`, `/api/chat`, `/api/sample`.
- `frontend/src/api/convert.ts` (frame conversion), `ChatPanel.tsx`,
  `geometry/rotate.ts` (rotations asked for in words — a chat feature).
- The envelope clamp (`clampPositionOnly`) and the `Envelope` type. A
  pushed room simply moves; nothing stops it.
- The site rectangle, street edges, setback line and north arrow from
  the plan; the site plane, setback line and street from the 3D.
- `.env`, the API-key handling in the start scripts, `anthropic` and
  `shapely` from the requirements.

Moved into the browser, because it is the only place that reads them:

- Room types, minimum sizes and zone colours: `frontend/src/rooms.ts`.
  A room's zone used to be chosen by Claude per project; it is now fixed
  by type (bedrooms private, living shared, garage service, and so on).
- The sample house: `frontend/src/sample.ts`, hand-placed in plan-frame
  meters. Two storeys, 11 × 9.5 m, rooms directly adjacent with no
  corridor spine on the ground floor; a landing and short hall upstairs.

Kept as they were: the carve / protect-the-minimum / push rules in
`geometry/carve.ts` and `resolve.ts` (minus the clamp), door arrows,
footprint union, stair shafts, the 3D view, the schedule, saved layouts.

Verified in a browser (headless Chromium against the built app): both
storeys draw with the ghost of the floor below, both massing modes
render, dragging a room selects its schedule row, editing a width in the
schedule resizes the box, save lists the layout and renames the title,
Reset restores the sample. No console errors. Tests: 4 Python, 17
TypeScript, all passing; ruff and tsc clean.

## Stages 2–6: not started

The README lists them. Notes for whoever does them:

**Stage 2 (drawing).** The box model is a rectangle plus a rotation. A
circle needs a `shape` field, and everything that turns a box into a
polygon goes through `polyOfBox` in `geometry/poly.ts` — that is the one
place to teach it about circles (a polygon approximation is fine; the
booleans in polygon-clipping only take polygons). Priority and floor
columns belong on the `Box`, and the schedule (`Schedule.tsx`) already
does two-way sync for width and depth: copy that pattern rather than
adding a second path.

**Stage 3 (floors).** `storeys` is a store field, `level` the one being
viewed, and `liveBoxes(boxes, level)` filters. The ghost already draws
the floor below; the floor above is the same code with `level + 1`. A
room's floor is `box.level`; changing it in the schedule is a plain edit.
The stair is mirrored across levels by `syncStairs` in the store.

**Stage 4 (adjacency and outline).** `doors.ts` finds shared walls with
`touchingEdge`; it only walks from the entry because that was the
circulation graph. Arrows between *any* touching pair is the same
function without the breadth-first walk. The outline (`footprint.ts`)
already unions every drawn shape.

**Stage 5 (overlap and priority).** The owner's decision on the forked
branch stands: *rewrite the overlap rules, do not extend them.* The three
modules `carve.ts`, `resolve.ts` and `rect.ts` hold one question between
them and the seams are where the bugs were. The new rule is simpler than
the old one — higher priority carves lower, never below the type minimum,
red outline when it would have to — and has no "push" at all: rooms are
allowed to overlap and the person resolves it. `shapeStillUsable` in
`carve.ts` (minimum area *and* still holds the minimum rectangle) is the
one test worth keeping.

**Stage 6 (3D).** `View3D.tsx` extrudes whatever `displayShapes` returns,
so once stages 2–5 produce polygons it should follow with little change.
Circles will need their extrusion drawn from the polygon rather than
`BoxGeometry`.

---

## Gotchas

**One coordinate frame.** Plan frame, y down, origin top-left of the
sheet. The backend stores boxes as the frontend sends them. If a second
frame ever comes back (a site, an export), convert in one place only.

**The sheet is not a boundary.** `SHEET` in `sample.ts` is a faint
rectangle and the 3D ground plane. Nothing clamps to it; a room may sit
outside it.

**The stair is one rectangle on every level.** `syncStairs` in the store
mirrors any edit across levels, and `shafts.ts` collapses the copies into
one volume for the 3D.

**Corridors are never eaten and never moved** — still true until stage 5
replaces the rules. A hallway in the sample is `kind: "corridor"`.

**`carvePlanFor` answers two questions at once** — what to draw, and
whether anything must move. Computing them separately is how the forked
branch came to approve one room's cut and draw another's. Stage 5 should
keep that property whatever else it changes.

**Rotation works in 5-degree steps, and that is not cosmetic.** Each step
resolves before the next is tried.

**The editor must never depend on the backend.** `boot()` opens the
sample before it asks `/api/health`; a missing backend costs only the
saved-layouts list. Keep it that way so `npm run dev` alone is enough to
work on the canvas.

**Never commit build caches.** `*.tsbuildinfo` is ignored.

## Conventions

- Commit messages: what changed and **why**, in prose. No bullet dumps.
- Comments explain the reasoning that is not visible in the code.
- Run `ruff check .`, `pytest`, and in `frontend/`, `npm run typecheck`
  and `npm test` before committing.
- Verify in the running app, not only in tests.
