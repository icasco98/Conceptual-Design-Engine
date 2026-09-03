# Handoff

Written for whoever picks this up next, human or Claude. It says what the
tool is, what state it is in, what to be careful of, and what to build
next. The README covers installation and the domain rules; this file
covers *where the work stands*.

Branch: `claude/design-engine-tool-access-92y89p`. Everything below is on
it, well ahead of `main`. `main` still holds the old single-storey
Streamlit-only version; do not develop there.

---

## What the tool is

A web tool for the **conceptual design phase** of a house — the sketchy
stage before any detailed floor plan, when you are deciding what goes
roughly where. The owner describes the project in a chat; the tool returns
a zoning diagram they can rearrange by hand, in plan and in 3D.

Three phases were planned. **Phase 1 (zoning) is what exists.** Phase 2
(massing, fenestration, weather/solar) and Phase 3 (optimization: thermal,
daylight, view/privacy) are not started.

### The one rule the whole design rests on

**Claude handles language and judgement. Python owns every number.**

Claude turns conversation into structured data (`src/extraction.py`),
groups rooms into categories and proposes an adjacency ordering
(`src/layout_plan.py`), and explains problems Python already found
(`src/claude_client.py`). It never computes a coordinate, an area, or a
setback. Plain Python packs the rectangles, checks reachability, and
scores the result. This is why the geometry is always trustworthy.

Do not erode this. If a future feature seems to want the model to do
arithmetic, that is a signal the scoring function needs a new term, not
that the model needs more rope.

---

## Architecture as it stands

Three layers. The domain layer is the valuable part; the other two are
replaceable.

### 1. Domain (`src/`) — pure Python, no framework, 100% of the intelligence

| File | Holds |
|---|---|
| `models.py` | `Project`, `Site`, `Room`. A room carries `levels: list[int]`. |
| `defaults.py` | Room-size table (min and typical, per room type). The only source of room dimensions. |
| `geometry.py` | Buildable envelope from site and setbacks. |
| `validation.py` | Deterministic checks: sizes, per-level area, entry marked, stair present and reaching every storey. |
| `access.py` | Which room types you may walk *through*; walks the plan from the entry and names what it cannot serve. Handles cross-level links via the stair. |
| `layout.py` | The packer. Rows left to right, corridors between rows, a spine when there are several, footprint tracing, per-level packing with a pinned stair. |
| `stacking.py` | What an upper storey owes the one below: wet rooms should overlap wet rooms, nothing should hang far past the floor below. Uses shapely. |
| `planner.py` | Packs several candidate orderings, thins corridors to what access needs, scores them, returns the best. **The architectural judgement lives here, in code you can read and argue with.** |
| `levels.py` | Default storey split when the owner has not said (bedrooms up, one bathroom down). |
| `palette.py` | The three validated diagram colours. |

### 2. API (`api/`) — FastAPI, thin

Every route wraps a domain function. No architecture here.

- `POST /api/layout` — pack and score a project, return the building.
- `POST /api/check` — run access and stacking on a **hand-made** arrangement.
- `POST /api/chat` — one conversational turn.
- `GET /api/sample`, `/api/health`, `/api/projects` (SQLite CRUD).
- Serves `frontend/dist` at `/` so one process is the whole app.

`api/serialize.py` is the wire contract, and the **one place the two
coordinate frames meet** (see Gotchas).

### 3. Frontend (`frontend/`) — Vite, React, TypeScript

- `src/state/store.ts` — zustand. **The single source of truth for the
  arrangement.** The plan, the 3D view and the schedule all render from it.
- `src/geometry/` — the canvas's movement rules as pure functions with
  real unit tests: carve, protect the minimum, push last; SAT overlap on
  rotated shapes; gap and grid snapping; door arrows; footprint union.
- `src/components/Canvas2D.tsx` — SVG plan, all gestures.
- `src/components/View3D.tsx` — Three.js, extruded per level.

---

## Current state

- **Tests:** 135 Python, 13 TypeScript. All passing.
- **CI:** `.github/workflows/ci.yml` runs ruff, pytest, then the
  frontend's typecheck, tests and build on every push.
- **Runs locally** via `start.bat` / `start.sh`: one double-click,
  installs on first run, serves on `localhost:8000`.
- **Verified end to end** in a browser: drag, resize, level switch, live
  re-check, 3D updating from the same state.
- The **old Streamlit app is gone** (`app.py`, `src/interactive_canvas.py`,
  its tests and `src/vendor/` — 3,547 lines). The React frontend had
  replaced all of it. It is in git history if it is ever wanted back.

### What was done in this session, in order

1. Gated the chat rather than the whole app on the API key; added
   pyproject, ruff, CI; prompt caching and low effort on Claude calls;
   the explanation call now only fires on error-severity issues.
2. Multi-storey: `Room.levels`, a `stair` room type, per-level packing
   with the stair pinned to identical coordinates on every level it
   connects, cross-level access edges, wet-room stacking scored and
   warned, cantilever warning, shapely.
3. FastAPI backend over the domain layer, with SQLite persistence.
4. React/TypeScript frontend replacing the Streamlit canvas; canvas
   geometry ported out of an inlined Python f-string into tested modules.
5. Three.js 3D view on the same state.
6. One-click start scripts and a README setup section for a non-coder.
7. Claude errors translated into actionable messages; support for
   identity-linked API keys via `ANTHROPIC_WORKSPACE_ID`.

---

## Gotchas — read before touching geometry

**Two coordinate frames.** Python's *site frame* has y running **up** from
the site's back edge. The canvas's *plan frame* has y running **down**
from the front (street) edge. They are converted in exactly one place,
`frontend/src/api/convert.ts`. Do the conversion anywhere else and you
will produce a plan that looks right and is mirrored.

**The stair is one rectangle, not one per level.** It is packed once and
placed identically on every level it connects. `store.ts` mirrors any
edit to it across levels. Anything that treats it as independent per
level will desynchronise the plan.

**Corridors are never eaten and never moved.** Circulation's whole job is
to stay open. A room dragged onto a hallway bends around it. This is load
bearing for the access guarantee.

**`carvePlanFor` answers two questions at once** — what to draw, and
whether anything must move. Computing them separately is how the old code
came to approve one room's cut and draw another's.

**A room only ever gives space up, never takes any.** Display shapes may
be smaller than the rectangle, never larger.

**The API key check treats a trailing `...` as absent**, so an untouched
`.env.example` does not look configured.

---

## Future steps

Ordered. Each leaves the app working.

### Next: smarter layouts (the natural continuation)

The scoring function in `planner.py` is where architectural knowledge
goes. It currently weighs access (a hard constraint), circulation share
against the 8–12% band, privacy depth, compactness, and stacking. Missing:

1. **Explicit adjacency.** Extend `LayoutPlan` with `adjacencies`
   (pairs plus a weight) and `avoid`, ask Claude for them in the prompt,
   and score satisfied and violated pairs. Today adjacency is expressed
   only through a single ordering list, which is a weak channel.
2. **Score the owner's stated priorities.** They are captured
   (`project.priorities`) and then never used by the packer. Map common
   phrasings — "near the entry", "away from the street", "morning light"
   — to scoring terms. `site.rotation_deg` is recorded and unused;
   compute which edge faces east and south and reward accordingly.
3. **Stair and structure terms.** Reward a stair near the entry, and
   walls that line up between storeys.
4. **A second packing strategy.** The row packer makes every plan a
   staircase of rows. Add a spine packer (central corridor first, rooms
   hung either side) feeding the same scorer, so the planner picks
   whichever wins. This is the single biggest lever on plan quality.
5. **Widen the search.** `MAX_CANDIDATES` is 12 and only 6 orderings are
   generated. Add seeded random perturbations. Watch the clock: every
   candidate is a full pack plus a corridor-thinning pass.

### Then: the chat revision loop

`/api/chat` already accepts the owner's `arrangement` and does nothing
with it. Feed it to `plan_layout` as context so "move the kitchen to the
back" starts from what they dragged rather than from Claude's last
suggestion. Also stop regenerating the layout when the room program has
not changed.

### Then: Phase 2, massing

3D solid geometry with fenestration, informed by weather and solar data.
The 3D view is currently a straight extrusion of the plan; massing means
roofs, openings, and orientation actually mattering. `site.rotation_deg`
becomes load bearing here.

### Then: Phase 3, optimization

Thermal performance, daylight, and view/privacy trade-offs. **The
groundwork is already right**: an optimizer is a search over the scoring
function `planner.py` already exposes. Expect to need (a) a faster
`pack_levels` or a cache keyed on the ordering, (b) background jobs in
FastAPI so a long search does not block the request, and (c) progress and
cancellation in the UI.

### Housekeeping, whenever

- Export the diagram to SVG or PDF. Nothing does this yet.
- Code-split the frontend bundle; it is ~780 kB because of Three.js.
- Lot coverage ratio check in `validation.py`.

---

## Conventions

- Commit messages: what changed and **why**, in prose. No bullet dumps.
- Comments explain the reasoning that is not visible in the code,
  especially where a simpler approach was tried and failed. Several
  modules carry that history; keep it.
- Run `ruff check .`, `pytest`, and in `frontend/`, `npm run typecheck`
  and `npm test` before committing.
- Never let the model compute geometry.
