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

- **Tests:** 131 Python, 25 TypeScript. All passing.
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

Rebuilt the scoring function so that all of it works. Three of its six
terms could not affect which plan won — see next step 1 for the full
account, which is worth reading before touching `planner.py`.

1. **Circulation** is measured against the one-corridor floor
   (`hallway_width * sqrt(area)`) rather than a fixed 8–12% of built area,
   because that share falls as a house grows and the old band was
   unreachable at any size. It now separates candidates instead of
   condemning all of them equally.
2. **Privacy** is read across the whole building with a storey counting as
   depth, instead of one level at a time — which required a level to hold
   the entry, public rooms and private rooms all at once, something no
   ordinary two-storey house does.
3. **Compactness** is perimeter-based: external wall per unit of floor,
   against the square of equal area. The old area-based measure rewarded
   whichever packer traced its outline more finely, which handed the spine
   packer a free 0.000 however ragged its bays were.
4. **Stacking** is split in two and normalised. Unstacked plumbing (12)
   and a floor that does not land on the one below (35) are no longer
   added at one weight, and neither grows just because a house has more
   bedrooms — both used to be sums, which made the term reach 24 points on
   the sample and quietly outweigh every stated preference combined.
5. Every weight is now gathered at the top of `planner.py` with its
   reasoning, on a common scale where 1.0 means "one whole unit wrong".
6. Nine tests added, each pinning a term to a case where the right and
   wrong answers differ — the old suite passed at full green with three
   terms inert.

Verified in the browser: the sample opens on a sound plan, both levels,
no access or stacking warnings, no console errors.

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

**Every scoring term must be normalised, and you must prove it fires.**
Penalties are scaled so 1.0 means "one whole unit wrong", and the weights
live together at the top of `planner.py` so they can be read against each
other. A term on its own scale is not a term with an unusual weight — it
is a term that either dominates or does nothing, and which of those it
does is an accident. Three terms were inert for a whole session behind a
fully green suite. A test that only checks the plan came out valid cannot
see this; write one where the right and wrong answers differ.

**A sum grows with the size of the house; a mean does not.** Adjacency and
orientation are means for this reason, and stacking was changed to match.
Sum a per-room penalty and you price the same architectural fault
differently depending on how many bedrooms happen to be upstairs.

**The API key check treats a trailing `...` as absent**, so an untouched
`.env.example` does not look configured.

**Never commit build caches.** `*.tsbuildinfo` is ignored for this reason:
tracking it meant every machine that built the app produced a local change
and every subsequent pull was refused.

---

## Next steps

Ordered. Each leaves the app working.

### 1. Widen the search — the scorer can only pick what it is shown

`MAX_CANDIDATES` is 12, and only six orderings are actually generated for
the sample project. Every candidate is now two full packs, so the clock
matters, but seeded random perturbations would widen the search
considerably. This is the remaining half of the "scoring a preference is
worthless if no candidate ever satisfies it" gotcha below: the weights are
now sound, so what limits the recommendation is the shortlist.

The previous session's next-step list opened with "re-weigh the scoring
function" on the strength of a finding that the row packer won at 21%
circulation while the spine plan sat at 19%. **That diagnosis was wrong in
its particulars, and the truth was worse.** It guessed compactness was
over-weighted against circulation. Compactness was in fact scoring the
spine plan at exactly 0.000 — not over-weighting it, not measuring it at
all. Three of the six terms could not affect the outcome:

- **Circulation** was `30 * (ratio - 0.12)`, an overshoot of a few
  hundredths, so the term capped at about 3 points against terms worth 10
  to 25. And the 8–12% band was unreachable at any size — a corridor has
  to cross the building, which costs about `hallway_width * sqrt(area)`,
  or 11% of a 116 m² floor. Every candidate was 18–21%, all equally
  guilty, and the term separated nothing.
- **Privacy** was scored one level at a time, and only counted a level
  holding the entry *and* public rooms *and* private ones. No level of an
  ordinary two-storey house qualifies. It returned zero on every
  multi-storey plan the tool had ever produced.
- **Compactness** compared the traced footprint's *area* to built area,
  which measured how finely each packer traced its outline rather than how
  compact its building was. The spine packer follows every jog of every bay
  — 25 points on the sample's ground floor — so its traced area equalled
  its built area and it scored 0.000 however ragged it was, while the row
  packer's coarse 7-point outline was charged 0.122 for the same sprawl.

All 122 tests passed throughout. That is the lesson worth carrying: **a
scoring term that cannot change the outcome is invisible to a test suite
that only checks the plan is valid.** The tests added for these pin each
term to a case where the right and wrong answers differ — copy that
pattern for any term you add.

The fix, now in place: every term below access is normalised so 1.0 means
"one whole unit wrong", the weights are gathered at the top of `planner.py`
to be read against each other, circulation is measured against the
one-corridor floor rather than a fixed percentage, privacy is read across
the whole building with a storey counting as depth, compactness is
perimeter-based (a ragged outline has *more* wall, so raggedness now costs
instead of paying), and stacking is split — unstacked plumbing at 12,
a floor that does not land on the one below at 35, where before they were
one sum at 10 that grew with the number of bedrooms.

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
