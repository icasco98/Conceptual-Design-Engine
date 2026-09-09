# Handoff

Written for whoever picks this up next, human or Claude. The README says
what the tool is and how to run it; this file says *where the work
stands* and what to be careful of.

The owner is not a programmer. Explain changes in plain terms, say when
they need to pull in GitHub Desktop, and never assume a build step is
obvious.

## Where this came from

The tool used to generate the zoning diagram: a Claude conversation read
the brief, and Python packed and scored candidate plans inside a site's
setbacks. The diagrams were never realistic — a long central hallway
every time, rigid rectangles only, an unconvincing footprint. Rather than
debug that in place, the interactive editor was forked out as a clean,
manually driven tool, to be made good on its own before assisted
generation is reintegrated.

That whole generating version — Claude intake, the packers, the planner
and its scoring, the access and stacking checks, the site and its
setbacks — still exists on `claude/design-engine-tool-access-92y89p`.
**Do not develop there, and do not delete it**: reintegration will want
pieces of it back. Nothing in the current tool depends on it, and no
module of it survives here; if you find a reference to one, it is a stale
comment and should go.

## What is built

Everything the README describes under "What the editor does" is built and
working: the five tools, the plan gestures, the magnet, undo/redo,
carving by hand and automatically by priority, the plot boundary, the
schedule, storeys with add and remove, door arrows by hand and suggested,
the 3D view with click-to-select and drag-to-move, open-to-below, the
status bar, and saved layouts. The README is the feature list; this file
does not duplicate it.

What is *not* built is listed in the README under "Not built yet": a
polygon plot, setbacks, a "fit the plot to what is drawn" button, and
assisted generation.

## Decisions that were put to the owner

These are answers, not guesses. Do not quietly reverse them.

- **A rotation is never blocked by the plot.** The zone turns to any
  angle and slides inward far enough to stay inside. Stopping the turn at
  the wall was the more literal reading of "hard wall" and was rejected:
  a snug zone would barely rotate at all, which reads as the tool being
  stuck.
- **Switching the boundary on moves nothing.** Zones already over the
  line are outlined and named; they stay put until they are picked up.
  Pulling them all in on one click would have rearranged a drawing the
  person had not asked about.
- **The plot is a rectangle.** An irregular lot is the same machinery
  against sloped edges, and the obvious next step.
- **Automatic carving is derived, not stored.** It changes what is
  *drawn*, never a zone's rectangle. Do not be tempted to "apply" it into
  `carvedBy`; that is exactly what makes the toggle reversible.

## Gotchas

**One coordinate frame.** Plan frame, y down, origin top-left of the
sheet. The backend stores boxes as the frontend sends them. If a second
frame ever comes back (a site, an export), convert in one place only.

**The sheet is not a boundary; the plot is, and only when it is on.**
`SHEET` in `sample.ts` is a faint rectangle and the 3D ground plane, and
nothing ever clamps to it. The one boundary is the plot (`Plot` in
`geometry/types.ts`, `store.plot`), and it binds only while `plot.on`.
With it off the tool behaves exactly as it did before the plot existed,
which is why off is the default and why every function in `plot.ts`
returns its input unchanged when it is off.

**Every clamp works on the turned outline, never on the rectangle.**
`polyOfBox`, not `left/top/width/height`. Rotation here is free, and a
4 × 6 m zone at 45 degrees needs 7.1 m of width: a rectangle test would
let a corner through the wall. This is the single easiest thing to get
wrong when adding a gesture.

**Every gesture that can move a zone must end by asking the plot for its
correction.** There are seven: move, resize, rotate and draw in
`Canvas2D.tsx`, the drag in `View3D.tsx`, `updateBox` in the store for
anything typed into the schedule, and `touchSelected` — the magnet closes
a gap by moving a zone, which can push it through the wall.

**A selection is clamped as one rigid body.** `clampGroup` takes the
union of the selection's outlines and returns one shift for all of them.
Clamping zone by zone would let them meet the wall at different moments
and drift apart, silently deforming an arrangement. Any new gesture that
moves several zones must go through `clampGroup`, not through a loop.

**What cannot fit is flagged, never forced.** A zone already outside when
the boundary was switched on, and a zone too big to fit at all, are left
exactly where they are and outlined. `shiftInside` deliberately leaves an
axis alone when the extent exceeds the plot on it — a tool that kept
yanking a zone against a wall it can never satisfy would just be fighting
the person.

**The schedule obeys the plot too** (`settleInPlot` in `updateBox`).
Without it, typing a width is a back door around the boundary. It caps
the size at what the plot can hold and then slides the zone in, which is
why it uses the `"extent"` growth test while the canvas resize uses
`"inside"`: the resize must leave the corner you are not dragging where
it is, and a typed size has no such corner.

**A tall zone is one box, not one per storey.** It is live on every
storey it reaches (`liveBoxes`), drawn on each plan, and drawn once in
the 3D from its own floor to its own ceiling. A stair is just a zone 6 m
tall — there is no separate stair machinery.

**`heightM` is the truth; `levelTo` is derived.** Set one without the
other and a zone will be drawn on the wrong storeys. `updateBox` in the
store recomputes it on every edit; do the same anywhere else.

**The 3D is not storey-based.** Every volume runs from its zone's own
base to its own top. Anything that starts iterating storeys to draw zones
is reintroducing the stacked-boxes bug; storeys are only for the floor
plates and for which zones read as "on screen".

**Click-to-select in the 3D** is a raycast on pointerup, skipped when the
pointer moved more than `CLICK_SLOP_PX` — that was an orbit, not a click.
Pickable meshes carry `userData.boxId`; the ground, the floor plates and
the outlines carry none.

**The tool never moves or resizes a zone on its own.** That is the
promise the overlap rewrite makes, and the reason nothing is ever pushed.
Anything that seems to need it should become a flag instead.

**A carve is asked for, and reported rather than enforced.**
`store.carve(id)` adds the carver to the `carvedBy` list of every zone it
overlaps on its storey; `displayShapes` subtracts each carver's *current*
polygon, so the cut follows the carver and a carver moved clear leaves
nothing behind. `flagged` means cut below the type minimum
(`shapeStillUsable`, with a 5 mm tolerance because the booleans land
vertices a hair off) or cut in two. The plan outlines it red, the
schedule marks it !, the status bar names it. Nothing is resized for you.

**Undo needs the state from before a gesture, not during it.** Gestures
stream through `setBoxes` and finish with `commitBoxes`, so by commit
time the pre-gesture state is gone. That is why `remember()` is public
and called at pointerdown.

**An arrow is stored in its host's frame, never on the page.** That is
what keeps it perpendicular and attached through a move, a resize and a
rotation. Anything that needs page coordinates calls `arrowSegment`.

**Corridors are ordinary zones now.** `kind: "corridor"` only picks the
hatch fill and the 1.2 m minimum; a hallway can be carved like anything
else.

**The editor must never depend on the backend.** `boot()` opens the
sample before it asks `/api/health`; a missing backend costs only the
saved-layouts list. Keep it that way so `npm run dev` alone is enough to
work on the canvas -- it is also why the Playwright suite (`frontend/e2e/`)
runs against `npm run dev` and never starts `uvicorn`.

**`buildTouchGraph` (doors.ts) is the one place that decides which zones
touch.** Both `suggestArrows` and the circulation graph
(`circulation.ts`) answer "does a wall exist here" the same way, because
they ask the same function. If a third feature needs the same question
answered, it calls this one rather than writing its own pairwise
`touchingEdge` loop.

**Circulation routes through a real door, and only a real door -- no
door means no edge, full stop.** `circulation.ts`'s `doorOnWall` checks
a candidate door against the wall's own run (`Touch.lo`/`Touch.hi`), not
merely how close it is to the midpoint, so a door near one end of a long
wall still counts and a door on a *different* wall of the same host does
not. Two zones sharing a wall with no door on it get no edge in the
graph at all -- not a fainter line, not a fallback to the wall's
geometric midpoint. `actorRoute` returns `{segments, broken}`; a leg
Dijkstra cannot reach lands in `broken` and is named on the actor's card
("No route: X → Y") rather than silently skipped or drawn anyway. A
route the tool shows is the tool asserting that route is walkable; it
must never assert that on a wall nobody has actually put a door in.

**Two infrastructure ideas raised and deliberately not done:** adjacency
that respects a carved shape rather than a box's raw rectangle was
judged too easy to get subtly wrong (polygon-subtraction boundary
checks) for the value it adds right now, and left alone rather than
rushed. Giving the backend its own per-entity Pydantic schemas was
considered and reversed on rereading `api/main.py`'s own docstring:
"the browser owns that shape, and a copy of it here would only be a
second thing to keep in step" is an explicit decision already recorded
there, not an oversight -- redeclaring every entity's shape in Python
would contradict it, not fix it.

**Never commit build caches.** `*.tsbuildinfo` is ignored. The same goes
for Playwright's own output, `frontend/test-results/` and
`frontend/playwright-report/`.

## Open question for the owner

**The magnet's rule.** The button is built and closes gaps under 1 m to
the nearest neighbour. Whether it should also *align* edges rather than
only touch them was asked and never answered. Do not guess it.

## Testing strategy

Four tiers, each answering a question the others cannot:

- **Pure functions** (everything under `geometry/`) — `vitest`,
  `geometry/geometry.test.ts`. No DOM, no store.
- **Store actions** — `vitest`, `state/store.test.ts`, calling
  `useStore.getState()` directly. No rendering: this tier exists because
  a store action can be wrong in ways a geometry test never sees (does
  deleting a zone clean up its arrows *and* every actor's route, does an
  actor stay outside the undo history the way it is supposed to).
- **Real pointer gestures over real SVG geometry** — Playwright,
  `frontend/e2e/`, run with `npm run test:e2e` against the plain Vite dev
  server, never the Python backend. This is the one tier `vitest` cannot
  cover at all: `getScreenCTM()`, pointer capture and real hit-testing
  don't exist in `vitest`'s `node` environment, and jsdom does not
  implement them either. If a change touches `Canvas2D.tsx`'s gestures,
  this is the suite that actually exercises them.
- **Running app, by hand** — for the one-off, unscripted pass described
  below, on a change too large or too visual to fully capture as a test.

Convention going forward: a new store action ships with a test in
`store.test.ts`; a new interactive gesture ships with a spec in `e2e/`.
Neither is optional because "it's simple" — the store's undo scope has
already been gotten wrong once by assumption alone (see `store.test.ts`'s
first describe block).

## Conventions

- Commit messages: what changed and **why**, in prose. No bullet dumps.
- Comments explain the reasoning that is not visible in the code.
- Keep the exported surface small: export what another file actually
  imports, and nothing else. A helper only its own file uses stays
  unexported, so a new feature cannot couple to it by accident.
- Run `ruff check .`, `pytest`, and in `frontend/`, `npm run typecheck`,
  `npm test` and (for anything touching the plan's gestures or the
  Actors panel) `npm run test:e2e` before committing.
- Verify in the running app, not only in tests. The last full pass —
  headless Chromium against the built app — confirmed both storeys
  drawing with the ghost below, both massing modes, drag-to-select,
  schedule edits resizing a zone, save/load/rename, Reset, and with the
  plot on: a zone stopping dead at the boundary corner and keeping its
  size, a tightened zone rotating to 39° with its swept corner landing on
  18.00 rather than through it, and switching the boundary on under a
  house that does not fit moving nothing. No console errors.
