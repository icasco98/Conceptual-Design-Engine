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

Kept as they were: door arrows, footprint union, stair shafts, the 3D
view, the schedule, saved layouts.

## Overlap rules rewritten: done (owner's request after trying stage 1)

The forked branch's rules -- carve first, protect the minimum, push last
-- moved rooms the person had not touched and made the canvas
unpredictable. They are gone (`resolve.ts` deleted, `carve.ts` rewritten,
`rect.ts` down to the SAT overlap test). The new rules:

- Rooms overlap freely. Nothing is ever pushed or resized by the tool.
- A carve is asked for: `store.carve(id)` adds the carver to the
  `carvedBy` list of every room it overlaps on its storey, and removes
  those rooms from its own list (the carver is on top). `release(id)`
  takes it out of every list.
- `displayShapes` subtracts each carver's *current* polygon, so the cut
  follows the carver; a carver moved clear leaves nothing behind.
- The minimum is reported, never enforced: `flagged` on a display shape
  means cut below the type minimum (`shapeStillUsable`, with a 5 mm
  tolerance because the booleans land vertices a hair off) or cut in
  two (the larger piece is kept). The plan outlines it red, the schedule
  marks it !, the status bar names it.
- The 3D extrudes the drawn polygon, so a carve reads in three
  dimensions too.

Stage 5 is now only the priority column: an ordering that decides who
carves whom without pressing Carve, on top of this machinery.

Verified in a browser (headless Chromium against the built app): both
storeys draw with the ghost of the floor below, both massing modes
render, dragging a room selects its schedule row, editing a width in the
schedule resizes the box, save lists the layout and renames the title,
Reset restores the sample. No console errors. Tests: 4 Python, 23
TypeScript, all passing; ruff and tsc clean.

## Stage 2 — drawing, selection, schedule: done (priority column excepted)

- Three columns (plan, massing, schedule) in `App.tsx`; the plan fits
  the building on load and on the Fit button, the 3D re-frames itself
  on load and when its pane changes shape.
- `Box.shape` is `"rect" | "circle"`. `localPolyOf` / `polyOfBox` in
  `poly.ts` are the one place a box becomes a polygon (a 48-gon for a
  circle); overlap uses convex SAT on those outlines (`rect.ts`), so
  circles carve and are carved like anything else. Circles get no door
  arrows.
- `Box.levelTo`: a zone spans storeys `level..levelTo`. `liveBoxes`
  returns it on each; the schedule shows one row ("G–1"); `shafts.ts`
  makes it one 3D mass. The stair is one such box; `syncStairs` is gone.
- Tools live in the store (`tool`): select (marquee on empty sheet),
  pan, rect, circle. Gestures in `Canvas2D.tsx`: group move (grabbed
  zone leads and snaps), group rotate about the selection's bounding
  centre (free, Shift = 15°), Delete/Backspace, Escape.
- The schedule edits name, type (which resets the minimums and the
  hallway hatch), floor, width, depth, rotation. Every edit goes through
  `store.updateBox` or `commitBoxes`.

**Not built: the "make zones touch" button.** The owner asked for a
button that moves nearby zones until they touch or align, and to ask
before building it because the rule is ambiguous. Questions were put to
the owner; do not guess an answer.

## Stages 3–6

**Stage 3 (floors).** The floor select in the schedule already moves a
room; what is left is the ghost of the floor *above* (the ghost code
with `level + 1`), adding storeys, and moving a span. Room count per
storey is derived; `storeys` is a store field.

**Stage 4 (adjacency and outline).** `doors.ts` finds shared walls with
`touchingEdge`; it only walks from the entry because that was the
circulation graph. Arrows between *any* touching pair is the same
function without the breadth-first walk. The outline (`footprint.ts`)
already unions every drawn shape.

**Stage 5 (priority).** The overlap rewrite is done (above). What is
left is a `priority` field on the box, a schedule column, and a rule
that when two rooms overlap the higher priority is added to the lower's
`carvedBy` automatically -- the same list `carve()` writes, so manual
and automatic carving stay one mechanism. Decide with the owner whether
a manual Carve should override priority or be replaced by it.

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

**Corridors are ordinary rooms now.** `kind: "corridor"` only picks the
hatch fill and the 1.2 m minimum; a hallway can be carved like anything
else.

**The tool never moves or resizes a room on its own.** That is the
promise the rewrite makes. Anything that seems to need it should become
a flag instead.

**Rotation is in 5-degree steps** only because the handle rounds to
them; stage 2's "freely rotated" can drop that without touching anything
else.

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
