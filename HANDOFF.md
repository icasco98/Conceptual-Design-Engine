# Handoff

Written for whoever picks this up next, human or Claude. It says what the
tool is, what state it is in, what to be careful of, and what to build
next. The README covers installation and the domain rules; this file
covers *where the work stands*.

Branch: `claude/design-engine-tool-access-92y89p`. Everything below is on
it. `main` still holds the old single-storey Streamlit-only version; do
not develop there.

The owner is not a programmer. Explain changes in plain terms, say when
they need to pull in GitHub Desktop, and never assume a build step is
obvious.

---

## What the tool is

A web tool for the **conceptual design phase** of a house — the sketchy
stage before any detailed floor plan, when you are deciding what goes
roughly where. The owner describes the project in a chat; the tool returns
a zoning diagram they can rearrange by hand, in plan and in 3D.

Three phases were planned. **Phase 1 (zoning) is what exists.** Phase 2
(massing, fenestration, weather/solar) and Phase 3 (optimization: thermal,
daylight, view/privacy) are not started, though the massing view's solid
mode and the orientation scoring are the first pieces of Phase 2.

### The one rule the whole design rests on

**Claude handles language and judgement. Python owns every number.**

Claude turns conversation into structured data (`src/extraction.py`),
groups rooms and proposes pairings and daylight wishes
(`src/layout_plan.py`), names edits the owner asks for in words
(`src/edits.py`), and explains problems Python already found
(`src/claude_client.py`). It never computes a coordinate, an area, a
setback or a compass direction. Plain Python packs the rectangles, checks
reachability, and scores the result.

Do not erode this. If a future feature seems to want the model to do
arithmetic, that is a signal the scoring function needs a new term, not
that the model needs more rope. The pattern to copy is
`src/orientation.py`: Claude says a room wants *morning sun*, Python works
out which way that is on this particular site.

---

## Architecture

Three layers. The domain layer is the valuable part; the other two are
replaceable.

### 1. Domain (`src/`) — pure Python, no framework

| File | Holds |
|---|---|
| `models.py` | `Project`, `Site`, `Room`. `Site.rotation_deg` is the bearing the front edge faces, clockwise from north. |
| `defaults.py` | Room-size table (min and typical, per room type). The only source of room dimensions. |
| `geometry.py` | Buildable envelope from site and setbacks. |
| `validation.py` | Deterministic checks: sizes, per-level area, entry marked, stair present and reaching every storey. |
| `access.py` | Which room types you may walk *through*; walks the plan from the entry and names what it cannot serve. Handles cross-level links via the stair. |
| `layout.py` | The **row packer**. Rooms left to right, wrapping; corridors between rows; a spine down one side when there are several; footprint tracing; per-level packing with a pinned stair. |
| `spine.py` | The **spine packer**. One corridor down the middle, rooms in bays facing each other across it. Returns None rather than a bad plan when the site is too narrow or a room will not fit beside a corridor. |
| `orientation.py` | Turns "morning sun" into a direction on this plan, using the site's bearing. Hemisphere-neutral by design. |
| `stacking.py` | What an upper storey owes the one below: wet rooms over wet rooms, nothing hanging far past the floor below. Uses shapely. |
| `planner.py` | Packs every candidate ordering **both ways**, thins the row plans' corridors, scores them all, returns the best. **The architectural judgement lives here, in code you can read and argue with.** |
| `levels.py` | Default storey split when the owner has not said. |
| `edits.py` | Edits asked for in words. One model so far: a room and the angle it should end up at. |
| `palette.py` | The zoning colours and how strongly a room is washed with one. |
| `sample_project.py` | The worked example the app opens on. |

### 2. API (`api/`) — FastAPI, thin

Every route wraps a domain function. No architecture here.

- `POST /api/layout` — pack and score a project, return the building.
- `POST /api/check` — run access and stacking on a **hand-made** arrangement.
- `POST /api/chat` — one conversational turn; also returns any rotations asked for.
- `GET /api/sample`, `/api/health`, `/api/projects` (SQLite CRUD).
- Serves `frontend/dist` at `/` so one process is the whole app.

`api/serialize.py` is the wire contract, and the **one place the two
coordinate frames meet** (see Gotchas).

### 3. Frontend (`frontend/`) — Vite, React, TypeScript

Layout: a tool rail, the plan, a column carrying the massing over the room
schedule, then the conversation, with the checks along the foot. Plan and
massing are on screen together at all times rather than being a mode you
switch between.

- `src/state/store.ts` — zustand. **The single source of truth for the
  arrangement.**
- `src/geometry/` — the canvas's movement rules as pure functions with
  real unit tests: carve, protect the minimum, push last; SAT overlap on
  rotated shapes; snapping; door arrows; footprint union; `shafts.ts`
  (collapsing a stair to one volume); `rotate.ts` (rotations asked for in
  words).
- `src/components/Canvas2D.tsx` — SVG plan, all gestures, and the camera
  (drag the background to pan, scroll to zoom).
- `src/components/View3D.tsx` — Three.js. Two readings of one arrangement,
  chosen by the "Colour by zone" checkbox: rooms coloured by category and
  translucent, or one grey volume per storey.
- `src/components/StatusBar.tsx` — the checks, one line at rest however
  broken the plan is.

Typography is Manrope for the interface and Barlow for drawing annotation,
both bundled rather than fetched so the app works offline.

---

## Current state

- **Tests:** 122 Python, 25 TypeScript. All passing.
- **CI:** `.github/workflows/ci.yml` runs ruff, pytest, then the
  frontend's typecheck, tests and build on every push.
- **Runs locally** via `start.bat` / `start.sh`: one double-click.
  Dependencies are installed on *every* run, not only the first — skipping
  that meant a version needing a new package never got it and the build
  died on an import that read as correct. A failed build now stops the
  app rather than serving the previous one.
- **Verified end to end** in a browser: drag, resize, rotate, pan, zoom,
  level switch, both massing modes, live re-check.

### What was done in the most recent session

1. Deleted the old Streamlit interface (3,547 lines) the React frontend
   had replaced.
2. Rebuilt the interface around the drawing: the layout above, a real
   type system, pan and zoom, a solid-massing mode beside the zone one.
3. Fixed rooms left drawn on top of each other after a rotation — two
   functions answering "do these overlap?" disagreed by their own
   tolerance, so a pushed pair landed in the band where one said
   "separated" and the other said "overlapping", and could never be pushed
   again.
4. Drew the stair as one shaft through every storey it connects, with the
   floor plates cut around it.
5. Let the owner ask for a rotation in words.
6. Scored the room pairings Claude proposes (`adjacencies`), and the
   owner's stated sun and street preferences (`orientations`), and made
   the intake ask for the site's bearing now that something reads it.
7. Added the spine packer as a second strategy, and made the north arrow
   turn with the site.
8. Replaced the sample project with one that exercises all of it.

---

## Gotchas — read before touching anything

**Two coordinate frames.** Python's *site frame* has y running **up** from
the site's back edge. The canvas's *plan frame* has y running **down**
from the front (street) edge. They are converted in exactly one place,
`frontend/src/api/convert.ts`. Do the conversion anywhere else and you
will produce a plan that looks right and is mirrored.

**The packer's own frame is a third thing.** Inside `layout.py` and
`spine.py`, local y starts at 0 at the *front* and increases toward the
back; `to_site_coords` flips it. A rectangle's origin needs `y + its own
depth` passed in.

**The stair is one rectangle, not one per level.** Packed once, placed
identically on every level it connects. `store.ts` mirrors any edit across
levels, and the 3D collapses them into one shaft.

**Corridors are never eaten and never moved.** Circulation's whole job is
to stay open. This is load bearing for the access guarantee.

**`carvePlanFor` answers two questions at once** — what to draw, and
whether anything must move. Computing them separately is how the old code
came to approve one room's cut and draw another's.

**A room only ever gives space up, never takes any.**

**Rotation only works in 5-degree steps, and that is not cosmetic.** Each
step resolves before the next is tried, so neighbours are pushed clear a
little at a time. Jumping straight to a final angle asks every neighbour
to give way at once and is refused almost always.

**A packing strategy must answer to the placement ordering.** The spine
packer originally chose sides by whichever was shallower; the result was
that a pair of rooms came out the same distance apart *however they were
ordered*, every adjacency scored identically on every candidate, and the
pairings silently stopped mattering. If you add a third strategy, check
that two different orderings give two different plans before trusting any
score computed from it.

**Scoring a preference is worthless if no candidate ever satisfies it.**
`best_layout` can only choose among the arrangements it generates. Adding
a scoring term usually means adding a candidate ordering too.

**The API key check treats a trailing `...` as absent**, so an untouched
`.env.example` does not look configured.

**Never commit build caches.** `*.tsbuildinfo` is ignored for this reason:
tracking it meant every machine that built the app produced a local change
and every subsequent pull was refused.

---

## Next steps

Ordered. Each leaves the app working.

### 1. Re-weigh the scoring function, now that it arbitrates two shapes

The most concrete finding of the last session: on the sample project the
row packer wins at **21% circulation** while the spine plan sits at 19%
and loses on compactness. Both are well above the 8–12% band the scorer
claims to want, and it picks the worse one on that measure. That is the
scorer working as written, not a bug — but the weights were tuned when
rows were the only shape, and they now decide between two very different
plans.

Worth doing first because everything below is easier to judge once the
planner reliably picks the better plan:

- Check whether the compactness term is over-weighted against
  circulation. A spine plan's bays leave a ragged footprint by nature.
- The circulation band may need to scale with program size; one corridor
  through a small house is a bigger share than through a large one.
- `MAX_CANDIDATES` is 12 and only a handful of orderings are generated.
  Seeded random perturbations would widen the search — watch the clock,
  every candidate is now two full packs.

### 2. Stair and structure terms

Reward a stair near the entry, and walls that line up between storeys.
The second is what separates a buildable house from two unrelated floor
plans stacked up, and `stacking.py` already has the machinery.

### 3. The chat revision loop

`/api/chat` accepts the owner's `arrangement` and does nothing with it.
Feed it to `plan_layout` as context so "move the kitchen to the back"
starts from what they dragged rather than from Claude's last suggestion.
Also stop regenerating the layout when the room program has not changed.
The owner will feel this daily.

### 4. Rewrite the overlap rules from scratch

**The owner's explicit decision: rewrite, do not extend.** Three modules —
`carve.ts`, `resolve.ts`, `rect.ts` — each hold part of one question, and
the seams between them are where the bugs live. The two-functions-
disagreeing bug fixed last session was a symptom. The current behaviour is
documented at the top of `carve.ts`; treat that as the specification to
replace.

Also unresolved and part of the same decision: when a room is dragged onto
another, it currently *carves* the one underneath. The owner may want
free overlap flagged by the checks instead — for conceptual design,
"roughly here, sort it out later" is often what is wanted. Ask before
choosing.

### 5. Phase 2, massing

3D solid geometry with fenestration, informed by weather and solar data.
`src/orientation.py` and the 3D view's solid mode are the beginning of it.

### Housekeeping, whenever

- Export the drawing to SVG or PDF. Nothing does this yet, and it is the
  most obvious missing verb in a drawing tool.
- Lot coverage ratio check in `validation.py`.
- Code-split the frontend bundle; it is ~790 kB because of Three.js.

---

## Conventions

- Commit messages: what changed and **why**, in prose. No bullet dumps.
- Comments explain the reasoning that is not visible in the code,
  especially where a simpler approach was tried and failed. Several
  modules carry that history; keep it.
- Run `ruff check .`, `pytest`, and in `frontend/`, `npm run typecheck`
  and `npm test` before committing.
- Verify in the running app, not only in tests. Several bugs last session
  passed every test and were obvious in a browser.
- Never let the model compute geometry.
