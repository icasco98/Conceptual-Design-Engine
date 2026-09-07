# Handoff

Written for whoever picks this up next, human or Claude. The README says
what the tool is and how to run it; this file says *where the work
stands* and what to be careful of.

Branch: `claude/plot-size-constraint-rd7fs2`, forked from `main` at
"Name the tool CDE non Interactive". Before it, `claude/zoning-editor-rebuild-shnp69`. Both were forked from
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
- `Box.levelTo`: a zone spans storeys `level..levelTo`, derived from
  `heightM`. `liveBoxes` returns it on each; the schedule shows one row
  ("G–1"); the 3D draws it once at its true height. The stair is one
  such box; `syncStairs` is gone.
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

**Stage 4 (adjacency and outline).** Done. If arrows between *every*
touching pair are wanted rather than one per zone, drop the `covered`
check in `suggestArrows`.

**Stage 5 (priority).** Done -- see above. Note the one design decision
in it: automatic carving is *derived*, not written into `carvedBy`. Do
not be tempted to "apply" it into the data; that is what makes the
toggle reversible.

**Stage 6 (3D).** `View3D.tsx` extrudes whatever `displayShapes` returns,
so once stages 2–5 produce polygons it should follow with little change.
Circles will need their extrusion drawn from the polygon rather than
`BoxGeometry`.

## The plot: done (owner's request)

The sheet had always been decoration — a faint rectangle with nothing
stopping a room being drawn off it. The owner asked for a checkbox that
turns it into a real site boundary the zones cannot escape, felt as a
hard wall when they are moved and turned.

Three decisions were put to the owner before it was built, and these are
the answers, not guesses:

- **A rotation is never blocked.** The zone turns to any angle and slides
  inward far enough to stay inside. Stopping the turn at the wall was the
  more literal reading of "hard wall" and was rejected: a snug zone would
  barely rotate at all, which reads as the tool being stuck.
- **Switching the boundary on moves nothing.** Zones already over the
  line are outlined and named; they stay put until they are picked up.
  Pulling them all in on one click would have rearranged a drawing the
  person had not asked about.
- **The plot is a rectangle**, width, depth and offset typed in. An
  irregular lot — corner plots, angled streets — is the same machinery
  against sloped edges, and the obvious next step.

Everything lives in `geometry/plot.ts`, whose header states the three
rules the rest of the code depends on. The five gestures that can move a
zone all end by asking it for the correction: move, resize, rotate and
draw in `Canvas2D.tsx`, the 3D drag in `View3D.tsx`, plus `updateBox` in
the store for anything typed into the schedule. `touchSelected` too — the
magnet can close a gap by pushing a zone through the wall.

Verified in a browser (headless Chromium against the built app): with the
boundary on, a zone dragged hard at the bottom-right corner stops at
exactly x=24, y=18 and keeps its size; the Living Room, tightened against
an 18 m plot, rotates to 39° and its swept corner lands on 18.00 rather
than through it; switching the boundary on under a house that does not fit
moves no zone at all and outlines the fifteen that are outside; coverage
reads in the status bar. No console errors. Tests: 6 Python, 55
TypeScript, all passing; ruff and tsc clean.

**Still to do on it, if wanted.** A polygon plot. A "fit the plot to what
is drawn" button. Setbacks — an inner offset the zones respect while the
plot edge stays the legal line — which is the natural next boundary now
that one exists.

---

## Gotchas

**One coordinate frame.** Plan frame, y down, origin top-left of the
sheet. The backend stores boxes as the frontend sends them. If a second
frame ever comes back (a site, an export), convert in one place only.

**The sheet is not a boundary; the plot is, and only when it is on.**
`SHEET` in `sample.ts` is still a faint rectangle and the 3D ground
plane, and nothing ever clamps to it. The one boundary is the plot
(`Plot` in `geometry/types.ts`, `store.plot`), and it binds only while
`plot.on`. With it off the tool behaves exactly as it did before the plot
existed, which is why off is the default and why every function in
`plot.ts` returns its input unchanged when it is off.

**Every clamp works on the turned outline, never on the rectangle.**
`polyOfBox`, not `left/top/width/height`. Rotation here is free, and a
4 x 6 m room at 45 degrees needs 7.1 m of width: a rectangle test would
let a corner through the wall. This is the single easiest thing to get
wrong when adding a gesture.

**A selection is clamped as one rigid body.** `clampGroup` takes the
union of the selection's outlines and returns one shift for all of them.
Clamping zone by zone would let them meet the wall at different moments
and drift apart, silently deforming an arrangement. Any new gesture that
moves several zones must go through `clampGroup`, not through a loop.

**What cannot fit is flagged, never forced.** A zone already outside when
the boundary was switched on, and a zone too big to fit in the plot at
all, are left exactly where they are and outlined. That is the same
promise as the one below about never moving a room on its own: the plot
constrains the gesture in progress and nothing else. `shiftInside`
deliberately leaves an axis alone when the extent exceeds the plot on it
— a tool that kept yanking a zone against a wall it can never satisfy
would just be fighting the person.

**A tall zone is one box, not one per storey.** It is live on every
storey it reaches (`liveBoxes`), drawn on each plan, and drawn once in
the 3D from its own floor to its own ceiling. `shafts.ts` and
`syncStairs` are gone: a stair is just a zone 6 m tall.

**Click-to-select in the 3D** is a raycast on pointerup, skipped when the
pointer moved more than `CLICK_SLOP_PX` -- that was an orbit, not a
click. Pickable meshes carry `userData.boxId`; the ground, the floor
plates and the outlines carry none.

**Corridors are ordinary rooms now.** `kind: "corridor"` only picks the
hatch fill and the 1.2 m minimum; a hallway can be carved like anything
else.

**The tool never moves or resizes a room on its own.** That is the
promise the rewrite makes. Anything that seems to need it should become
a flag instead. Automatic carving does not break it: it changes what is
*drawn*, never a zone's rectangle.

**Undo needs the state from before a gesture, not during it.** Gestures
stream through `setBoxes` and finish with `commitBoxes`, so by commit
time the pre-gesture state is gone. That is why `remember()` is public
and called at pointerdown.

**Rotation is free**, with Shift holding 15-degree steps. With the plot
on it stays free: the turn always happens, and the zone slides in
afterwards. Blocking the rotation was considered and rejected — a snug
zone would barely turn at all, which reads as the tool being broken.

**The schedule obeys the plot too** (`settleInPlot` in `updateBox`).
Without it, typing a width is a back door around the boundary. It caps
the size at what the plot can hold and then slides the zone in, which is
why it uses the `"extent"` growth test and the canvas resize uses
`"inside"`: the resize must leave the corner you are not dragging where
it is, and a typed size has no such corner.

**An arrow is stored in its host's frame, never on the page.** That is
what keeps it perpendicular and attached through a move, a resize and a
rotation. Anything that needs page coordinates calls `arrowSegment`.

**The 3D is not storey-based.** Every volume runs from its zone's own
base to its own top. Anything that starts iterating storeys to draw
zones is reintroducing the stacked-boxes bug; storeys are only for the
floor plates and for which zones read as "on screen".

**`heightM` is the truth; `levelTo` is derived.** Set one without the
other and a zone will be drawn on the wrong storeys. `updateBox` in the
store recomputes it on every edit; do the same anywhere else.

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
