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
touch, and it works on each zone's actual outline, not a box's raw
rectangle.** It takes `Map<string, Poly>` -- the caller supplies each
zone's real outline on the page, ordinarily `displayShapes`'s post-carve
polygon -- and finds shared walls with a general polygon-edge overlap
test (`touchingEdges`), not an axis-aligned shortcut. That one change
does three things at once: a rotated zone's own turned wall is read
correctly instead of being excluded outright, a hand-drawn polygon's
own edges are too, and a zone carved into another now shows up as
touching its carver with no special-case carve logic anywhere -- boolean
subtraction leaves the two outlines sharing exactly the cut's own edge,
and this is just another wall as far as the test is concerned. Both
`suggestArrows` and the circulation graph (`circulation.ts`) build the
same `polyById` map from `displayShapes(live, autoCarve)` and hand it to
this one function, so "does a wall exist here" -- rotated, polygon or
carved-flat -- is decided in exactly one place either way.

**Circulation routes through a real door, and only a real door -- no
door means no edge, full stop.** `circulation.ts`'s `doorOnWall` checks
a candidate door against the wall run's own two endpoints (`Touch.p1`/
`p2`), not merely how close it is to the midpoint, so a door near one
end of a long wall still counts and a door on a *different* wall of the
same host does not. Two zones sharing a wall with no door on it get no
edge in the graph at all -- not a fainter line, not a fallback to the
wall's geometric midpoint. `actorRoute` returns `{segments, broken}`; a
leg Dijkstra cannot reach lands in `broken` and is named on the actor's
card ("No route: X → Y") rather than silently skipped or drawn anyway. A
route the tool shows is the tool asserting that route is walkable; it
must never assert that on a wall nobody has actually put a door in.

**An arrow's stored position can outlive the wall it was placed on.**
`{hostId, side, t}` (arrows.ts) addresses a point on the host's own
*declared* shape, not the plan's current drawing -- carving can shorten
or delete the exact stretch a door sits on, or, easier to miss, leave
the host's own wall untouched while carving away whichever neighbour
used to be on its other side. Either way the door stops being real
without moving at all. Three pieces close this, each answering a
different question, deliberately kept separate:

- *Is this arrow real right now?* `arrowIsLive`/`liveArrowIds`
  (circulation.ts): an interior door needs a real touch in the level's
  current touch graph; an exterior door needs to still sit on the
  host's own current outline. Recomputed fresh every time, like a
  route -- nothing here is stored.
- *Where does a click or drag resolve to?* `liveWallPoint` (arrows.ts),
  used by `addArrow`/`moveArrow` (store.ts) **and** Canvas2D's own
  hover preview (the pointer-move handler on the plan `<svg>`, arming
  `arrowPreview`) -- the same resolver both times, on purpose, after the
  preview alone once shipped still calling the raw `nearestWallPoint`
  directly: correct on commit, but the line you watched drag into place
  first could jump to whichever of the host's four *original* sides was
  nearest by raw distance, carve or no carve. `liveWallPoint` returns
  the nearest point on the box's *current, carved* outline, never a
  point a carve has already taken away -- hosted on whichever raw shape
  that point actually belongs to, the box's own or a direct carver's
  (`ownerOf`, the same rule `suggestArrows`'s walk uses to decide which
  of a touching pair hosts a carve-boundary door, regardless of which
  side the walk reached it from first -- a plain wall belongs to both, a
  cut boundary only to the carver). A carved-away wall position is not
  filtered after the fact; it is simply never offered -- true for the
  preview you see before clicking and the door you get after, because
  it is the one function answering both.
- *Where does a door that has already gone stale draw itself?*
  `Arrow.frozenAt` (types.ts) plus `syncFrozenArrowPoints`
  (circulation.ts): a stale arrow's raw `hostId`/`side`/`t` position can
  by now be anywhere the host's declared shape says, including inside
  some unrelated zone drawn over that spot since -- not safe to draw or
  to keep recomputing. `frozenAt` is a door's last real `[tail, head]`,
  kept in sync automatically for as long as it stays real and left
  completely untouched the instant it stops -- a snapshot, not a rule,
  which is why it needs the one field. `useStore.subscribe` (bottom of
  store.ts) is where this actually runs: once, centrally, after every
  single state change, rather than each of the many actions that could
  move a wall (draw, resize, rotate, carve, release, undo, redo, load a
  layout) having to remember to call it. It is a no-op, the same
  `arrows` array back, once nothing has changed, so this costs one extra
  pass rather than looping.

Canvas2D draws a live door at its current computed position and a dead
one at `frozenAt` instead, dashed and in the error colour, with a title
explaining why -- stay exactly where it broke, get flagged, never
silently move again and never silently vanish, the same treatment
`broken` already gives an unreachable route leg. Door arrows are drawn
two-headed (`markerStart` and `markerEnd` both set, using the same
marker definition each way via `orient="auto-start-reverse"`) since a
door is walked in both directions; this makes the existing per-arrow
Flip control cosmetically inert (both ends now look the same regardless
of `dir`), left in place rather than removed since nothing asked for
that.

The carve loop in `suggestArrows` no longer guesses a carve's door
position as the carver's wall nearest the victim's raw centre, which had
no guarantee of landing on the actual cut; it finds the real boundary
with `touchingEdges` (the victim's carved outline against the carver's
raw one) and places the door there, or places nothing if no such edge
exists rather than guessing one into being.

**One infrastructure idea raised and deliberately not done:** giving the
backend its own per-entity Pydantic schemas was considered and reversed
on rereading `api/main.py`'s own docstring:
"the browser owns that shape, and a copy of it here would only be a
second thing to keep in step" is an explicit decision already recorded
there, not an oversight -- redeclaring every entity's shape in Python
would contradict it, not fix it.

**Never commit build caches.** `*.tsbuildinfo` is ignored. The same goes
for Playwright's own output, `frontend/test-results/` and
`frontend/playwright-report/`.

**The side column (Schedule, Circulation, Plot, Save) is a tab strip,
not a stack.** All four used to sit in one scrolling column; between
them they no longer fit on one screen without it. Which tab is showing
(`App.tsx`'s `SideTabs`) is local UI state, the same category as the
camera or which storey is showing -- not saved, not undoable, opens on
Schedule every time. Each panel component is unchanged; only what wraps
them changed, so anything reading `.schedule`, `.actors-pane`,
`.plot-panel` or `.sidebar` in a test now needs to click that tab
(`page.getByRole("tab", { name: ... })`) before it is on screen.

**The sample house was rebuilt from scratch (September 2026) to actually
exercise rotation- and carve-aware circulation, not just avoid breaking
it.** It is a from-the-ground-up two-storey design, not the old 11 x
9.5 m block with a wing bolted on: a non-convex L-shaped Living Room, a
chamfered hexagonal Diwaniya, and a genuinely rotated bay (Study
downstairs, Bedroom 3 above it, both at 15°) that shares a real wall
with Dining Room / Bedroom 2, not just a bounding box. Five exterior
doors -- the front door plus the garage's, the utility room's, the
diwaniya's and the study's own.

**The rotated-bay technique, if this house is extended with another
one:** a room's `left/top/width/height` and `points` describe its
*unrotated* local shape; `rotation` then turns it in place around its
own centre, exactly as `frameOf` reads it for rendering and for the
touch graph. A straight wall shared between a rotated room and an
axis-aligned neighbour only lines up if the rotated room's own local
edge is pre-tilted by `-rotation` before the rotation is applied --
so that turning it by `+rotation` brings that one edge back to
horizontal (or vertical), landing exactly on the straight wall it
needs to touch, while every other edge of the room stays visibly
rotated. `sample.ts`'s own doc comment spells out the math; verify any
new rotated room numerically (a throwaway `_scratch.test.ts`, deleted
before committing) before trusting it -- a wall that's off by more than
`TOUCH_TOL_M` (4 cm) reads as "no door" even though it looks connected
on screen.

Playwright specs that pick "the last exterior-side arrow" learned to do
that the hard way: doors placed near the entry cluster tightly, and a
carve-rectangle sized in absolute screen pixels can reach more than one
of them once the view is zoomed out to fit the whole house.
`e2e/arrows.spec.ts` sizes its carve from the target arrow's own
current pixel size (so it scales with zoom) and targets the rotated
Study's own side door specifically -- alone on its own wall, away from
both the entry cluster and the tool rail at the plan's left edge.

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

## The rule set after batch 001 (September 2026)

Ten rules were added to the scoring layer in one autonomous batch of five
passes, each pass proposing, implementing, regression-checking, re-tuning
and committing before the next began. `reports/batch-001.html` is the
write-up for the owner; it opens by double-click and needs nothing
installed. What follows is the part a developer needs.

**All ten are read-only diagnostics in the generator/scoring layer.**
Nothing in `Canvas2D.tsx` or `store.ts` changed behaviour. The rules
report; they never move, resize or connect anything. Same promise as
every check that was already there.

**Hard problems added:** a WC opening straight onto a kitchen or dining
room (`sanitaryDoorProblems`); a door drawn across less shared wall than a
door leaf needs (`undersizedDoorways`); two doorways cut into one wall too
close to both exist (`doorClearanceProblems`); a sleeping room with no
exterior wall to escape through (`windowlessSleepingRooms`, habitability.ts);
a diwaniya with no street door of its own (`ownEntranceProblems`).

**Soft recommendations added:** garage-to-kitchen easy access and a guest
WC near a diwaniya or reception (both `RelationRow`s); a habitable room
facing outside on only one side (`singleAspectRooms`); a habitable room
stretched past 1:3 (`awkwardProportions`); an upper-floor wet room not
sitting over a wet room below (`unstackedWetRooms`, efficiency.ts).

**One candidate was reverted, and the reason generalises.** The
escape-window rule was first written against every *habitable* room, on
the light-and-ventilation requirement. It fired on the sample house's own
Dining Room -- correctly, in that the room genuinely has zero exterior
wall, and wrongly, because that code has an explicit exception: an
interior room may borrow light and air from an adjoining room through a
large enough opening, which is how an open-plan dining room is normally
justified. **This tool models solid walls and doors and nothing in
between**, so it cannot tell a wide cased opening from masonry. Any future
rule whose real-world version has a "unless it opens onto the next room"
exception has the same problem and should be narrowed the same way,
rather than approximated.

**Two new files.** `geometry/habitability.ts` is whether a room can be
lived in -- deliberately not in efficiency.ts, which means "is this
wasting money" and already carries one reluctant exception in
`deadEndHallways`; a second would stop that file meaning anything.
`geometry/rules.test.ts` holds this batch's tests, since geometry.test.ts
is long and organized around the original checks.

**`RoomFacts` replaced the four loose predicates.** `collectFindings`,
`scoreCandidate` and `generateLayout` take one object (`ROOM_FACTS`,
built in rooms.ts) instead of `passableOf, tierOf, auxiliaryOf,
circulationOf` positionally. Each individual check still takes only what
it reads and is still unit-tested that way -- the bundle is only for the
aggregating entry points, which were gaining a positional argument (and
therefore an edit to every caller in the tool) for every new room-type
fact. Six facts have been added since: `sanitary`, `food`, `sleeping`,
`habitable`, `wet`, `ownEntrance`.

**Two guardrails now exist and are worth keeping.**
`scenarios.baseline.json` freezes every scenario's post-search hard-problem
count and `scenarios.baseline.test.ts` fails if any of them rises. Only
hard problems are pinned: soft recommendations carry continuous
magnitudes that legitimately drift whenever the search's tuning changes,
so pinning them would fail for reasons that are not regressions.
Rewriting the file is deliberate (`UPDATE_SCENARIO_BASELINE=1`) and is for
when an accepted rule legitimately changes what a scenario *should*
score, never to turn a red run green. It was rewritten exactly once in
this batch, for the diwaniya rule: 28 of 56 scenarios gained exactly 1,
and they are exactly the 28 containing a diwaniya. The tempting wrong
move there was to give `buildScenario` a diwaniya door so the finding
would vanish; that is editing the evidence.

`scenarios.tuning.json` is the search-tuning record -- the best
`SearchConfig` found, what it scored, and a log of every run including
the ones that lost. Train with `RUN_TUNING=1`; it does not run under
`npm test` because one evaluation is the whole feasible suite. **Vary
`TUNING_SEED` per run**: `train` starts from `DEFAULT_SEARCH_CONFIG` and
is deterministic, so reusing a seed re-derives that seed's answer exactly
(this happened in pass 2 and cost a run). The incumbent is re-measured on
the current rule set rather than compared against its stored numbers,
because a config recorded before a rule existed was scored by a rule set
that could not see it.

**`DEFAULT_SEARCH_CONFIG` was deliberately not changed**, five times over.

## The one thing the next batch should fix

**The search never produces a clean plan, and tuning is not why.** Zero of
56 scenarios reached zero hard problems, before this batch and after it,
under every config six training runs found. Mean hard problems moved by
well under a percent each time.

The cause is mechanical. `buildScenario` shelf-packs rooms with a fixed
0.3 m gap between every pair, and `generateLayout` improves a plan by
nudging position, size and rotation by continuous random amounts. Two
rooms only *connect* when their walls meet within `TOUCH_TOL_M` (4 cm),
and a continuous random walk essentially never lands on a 4 cm target. So
rooms almost never touch, `suggestArrows` almost never has a wall to put
a door on, and nearly every room in nearly every scenario ends
`unreachable`. That single fact is most of the hard-problem count in the
whole suite, and it is why nine of the ten new rules -- almost all of them
about doors -- find nothing there at all despite being correct and tested.

No annealing schedule fixes this. What fixes it is a new *move kind* in
`generateLayout`'s own repertoire: slide a room until it is flush against
a chosen neighbour's wall, rather than hoping to land there. `snap.ts`
already has the machinery (`snapToNearbyNeighbors`, `wallSnapAdjust`) that
the canvas uses for exactly this when a person drags a zone. Add it as a
fifth entry in `moveWeights` and the student can tune how often it is
tried. Do that before adding more rules; the rule set is well ahead of the
search's ability to satisfy it.

Second, smaller: six of the ten rules are proven by fixture only, because
`EXAMPLE_PROGRAMS` has no powder room, no second storey and (until the
search can connect anything) no interior doors. A two-storey program and a
guest-WC block would let the suite actually exercise them.

**`scenarios.render.ts` now draws doors** (pass an `arrows` array) and
`scenarioPageHTML` wraps SVGs in a self-contained `.html` file. The bare
`.svg` output was a real usability bug: the owner could not open the one
artifact meant to let them check a claim by eye. Every visual this mode
produces should go through the HTML wrapper.

## Batch 002 (September 2026): rooms that actually touch

Did exactly what the note above asked, in the order asked, and nothing
else -- no rule in `relationships.ts`/`rooms.ts`/`efficiency.ts` was
added, removed or changed this batch. `reports/batch-002.html` is the
write-up; this is the part a developer needs.

**`snap` is a fifth `MoveKind`** (`geometry/generate.ts`): picks one
movable room and replaces it with `snapToNearbyNeighbors(room,
liveBoxes(...))` -- the same function the editor's own magnet button
already uses -- through the exact same cheap-reject and `scoreCandidate`
pipeline every other move already goes through, no special-casing.
Axis-aligned only for now; a rotated room's own turned outline isn't
accounted for by `snap.ts`'s gap-closing math, so that move is a no-op on
a rotated room this batch, called out in `generate.ts`'s own comment
rather than solved. Given a real default weight (1, matching the other
four), and unit-tested directly in `geometry/generate.test.ts`.

**New file, `geometry/topology.ts`: the topology and dimensioning
stages.** `layoutBubbles` is a small, hand-rolled force simulation
(Fruchterman & Reingold, 1991) over the room list and
`relationships.ts`'s own `required`/`desired` rows -- repulsion between
every pair sized by each room's own target-area-derived "personal
space," attraction along adjacency edges, a cooling temperature that
settles the whole thing deterministically with no PRNG at all (a
Fibonacci spiral gives every run the same distinct starting positions).
`dimensionRooms` turns those rough centres into real rectangles via a
slice-and-dice area partition, ordered by a greedy nearest-neighbour walk
through the bubble positions so adjacency-related rooms land in
neighbouring slices rather than opposite corners. Deliberately the
plainer slice-and-dice treemap, not the squarified variant the research
grounding (GPLAN, arxiv 2008.01803; the squarified-treemap floor-plan
literature) also describes: every recursive split exactly tiles its own
rectangle by construction, so non-overlap and boundary containment hold
*unconditionally*, nothing to verify afterward. A room whose own minimum
genuinely doesn't fit the share it's given is left undersized rather than
corrected -- correcting it could only come at a neighbour's expense,
which is exactly the overlap this stage exists to never produce, and
matches the plot boundary's own long-standing "flagged, never forced"
rule. It self-heals almost immediately in practice: `generateLayout`'s
own `resize` move floors at `minWidth`/`minHeight` on its first
successful touch of that room. `topologyLayout(rooms, boundary, rules?)`
runs both stages back to back; `scenarios.ts`'s `buildScenario` calls it
in place of the old `shelfPack`, which is deleted.

**A real bug in `generateLayout` itself, found while wiring this in, not
a `topology.ts` problem.** The search carried the arrangement's
*starting* auto-suggested doors into every later candidate's score
unconditionally, only ever adding new ones on top, never dropping one a
later move had made geometrically untrue. Harmless under the old
shelf-packed start (nothing to go stale -- there were essentially no
doors yet); actively wrong the moment the start has real doors
everywhere, which is exactly what this batch gives it.
`scenarios.report.test.ts`'s own "never worse than the start" check
actually failed on one scenario before this was fixed. The fix: split
`arrows` by whether `Arrow.targetId` is set (unset means genuinely fixed
-- an exterior door, or one placed or moved by hand, per that field's own
doc comment and `store.ts`'s `addArrow`/`moveArrow`) and re-derive
everything `suggestArrows` itself produced completely fresh for every
candidate, which is what the file's doc comment already claimed
happened. `generateLayout` also backs the interactive editor's own
"Generate" button (`state/store.ts`, untouched) -- this fix improves that
path too, since the editor only ever keeps the returned boxes, never the
doors scored internally.

**Numbers, `DEFAULT_SEARCH_CONFIG`, 400 iterations, same per-scenario
seeds as the regression baseline -- directly comparable to batch 001's
own reported figures:**

| | before | after |
|---|---|---|
| scenarios with a real interior door, at the start | 0 of 56 | 56 of 56 |
| scenarios with a real interior door, after the search | 4 of 56 | 56 of 56 |
| clean rate (zero hard problems) | 0 of 56 | 0 of 56 |
| mean hard problems | 21.64 | 16.36 |
| mean soft recommendations | 16.02 | 20.08 |

Soft recommendations rose because there is finally something for them to
examine (single-aspect rooms, proportions, unstacked wet rooms) in a
suite that used to have almost no real adjacency at all -- not a
regression. **The clean rate is still 0%,** at every iteration budget and
every config tried (800 iterations: 14.97 mean hard problems untuned,
14.95 with the freshly retrained config). Say this plainly to the owner:
rooms now genuinely connect, but connected is not the same as clean.

**Regression baseline regenerated** (`UPDATE_SCENARIO_BASELINE=1`): 6 of
56 scenarios went up (a few hard problems each, the search's random walk
taking a different path against completely different starting geometry),
49 improved, several sharply, net hard problems across the suite fell by
247. Same shape as batch 001's diwaniya-rule rewrite -- a deliberate,
explained mechanism change, not tuning until a red run goes green -- at a
much larger scale, because this is the change the whole batch exists to
make.

**`scenarios.baseline.test.ts`'s own `EPSILON` was too tight for its own
storage precision** and got fixed along the way (1e-6 -> 1e-3): the
frozen baseline rounds every value to 4 decimal places
(`toFixed(4)`), which can be up to 0.00005 away from a freshly
recomputed value that changed nothing at all, and three scenarios
tripped exactly that during this batch's own baseline regeneration,
printed as "regressions" from a number to the identical number at 4
decimals. Comment on the constant explains why.

**Retrained `scenarios.student.ts`'s `SearchConfig`** against the new
starting point (`RUN_TUNING=1`, 40 generations, 150 iterations/eval,
labelled `batch-002` in `scenarios.tuning.json`). Worth knowing: batch
001's own tuned config, re-measured on the new start, actually scores
*worse* (16.95) than the untrained defaults (16.85) -- it was tuned for a
shelf-packed start that no longer exists, and doesn't transfer.
`DEFAULT_SEARCH_CONFIG` itself is untouched, same as every prior pass;
the tuning record is an input to a future manual adoption decision, not
the decision.

**The next batch should resume rule-authoring, not chase the search
further.** The mechanism this batch built is sound: rooms touch, doors
exist, all 56 scenarios have real adjacency to examine now, not hand-
built fixtures alone. That was the second honest limit batch 001 named
(six of its ten rules proven only by fixture) and it is now fixable for
real. The alternative -- tuning `topology.ts` further, e.g. the
squarified treemap variant for better room proportions -- is defensible
but this report's own judgment is that rule coverage is the more
valuable next step. The Obsidian-style interactive graph visualization
the owner wants eventually is still explicitly not next: it would be a
viewer for the bubble graph this batch already computes internally and
discards after dimensioning, better built once the placement pipeline
itself is more settled.
