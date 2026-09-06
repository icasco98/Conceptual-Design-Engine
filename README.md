# Conceptual Design Engine — Zoning Editor

A web tool for the conceptual design phase of a house: the sketchy stage
before any detailed floor plan, when you are deciding what goes roughly
where. You draw the rooms by hand on a blank sheet; the tool keeps a live
room schedule beside the drawing, traces the building outline, draws the
door arrows, and shows the same arrangement as a 3D massing model.

**This branch is a fork.** The version on
`claude/design-engine-tool-access-92y89p` generated the zoning diagram for
you — a Claude conversation extracted the brief, Python packed and scored
candidate plans inside a site's setbacks — and its results were never
realistic: a long central hallway every time, rigid rectangles only, an
unconvincing footprint. Rather than debug that in place, this branch
isolates the interactive editor as its own clean, manually driven tool.
Nothing has been thrown away: every module removed here is still on that
branch and in this repository's history, and the intent is to reintegrate
assisted generation once the editor is good on its own.

What was kept, exactly as it was: the interface (React, Vite, TypeScript,
zustand), the SVG plan with its drag / resize / rotate / delete gestures,
pan and zoom, the schedule, the 3D view (Three.js) in both its readings,
and the thin FastAPI server that serves the built app and keeps saved
layouts.

What was removed: every Claude call and the chat; the packers, the
planner and its scoring; the access and stacking checks; the site, its
edges, the setbacks and the buildable envelope. The canvas is a blank,
unconstrained sheet.

## The plan, in stages

Each stage leaves the app working and is confirmed in a browser before
the next begins.

1. **Fork and strip.** Done. The editor opens on a hand-placed sample
   house (`frontend/src/sample.ts`) — two storeys, rooms directly against
   each other, no corridor spine — so that trying it never means drawing
   a plan from nothing. Plan, schedule and 3D all work with no backend
   and no API key.
2. **Drawing.** Done, apart from the priority column. Rectangle, square
   and circle tools on the rail; free rotation; the schedule lists name,
   type, floor, size and rotation and edits them in place, live with the
   canvas both ways; several zones can be selected and moved, rotated or
   deleted together.
3. **Floors.** Assign each room to a floor; when viewing one floor, see a
   ghosted outline of the floors above and below, to line up walls.
4. **Adjacency and outline.** Arrows between rooms placed next to each
   other, and the building envelope traced around everything placed.
5. **Priority.** Each room gets a numeric priority in the schedule, so
   that where rooms overlap the tool can tell which one carves which
   without being asked each time. Overlap and manual carving are already
   in (see below); this stage adds the ordering.
6. **3D.** Confirm the finished 2D editor converts into the massing view.

## What the editor does today

Three columns: the plan, the 3D massing, and the room schedule, all on
screen at once, all three readings of the one arrangement.

- **Tools (the rail).** *Select*: click a zone, shift-click to add, or
  drag empty sheet to rubber-band several. *Pan*: drag the sheet to move
  the view (the middle mouse button pans in any tool). *Rectangle* and
  *Circle*: drag on the sheet to draw a new zone; Shift holds a rectangle
  square. A new zone is called "Zone n", of type Room — rename it and
  pick its type in the schedule. Scroll to zoom in any tool.
- **Plan.** Corner handles resize, the top handle rotates freely (hold
  Shift for 15° steps), the × deletes, so does the Delete key. With
  several zones selected, dragging any one moves them all, the rotate
  handle turns them together about the group's centre, and × or Delete
  removes them all. A 0.25 m grid can be shown from the rail, and
  positions snap to it whether or not it is visible; a single zone
  dragged within 1 m of a facing neighbour snaps to touch it.
- **Overlap and carving.** Rooms overlap freely and nothing is ever
  pushed: a room goes exactly where you put it and nothing else moves.
  To cut, select a room and press its carve handle (top-left corner) or
  the Carve button on its schedule row: it cuts every room it sits over.
  The cut follows the carver, so moving it moves the notch and moving it
  away gives the space back; press again to release. A cut never resizes
  a room for you — a room cut below its type's minimum, or cut in two,
  keeps the cut and is outlined in red, named in the status bar, and
  marked with ! in the schedule, for you to resolve.
- **Schedule.** Name, type, floor, width, depth and rotation are edited
  in place and the zone follows; width and depth grow from the centre;
  area is read from the shape actually drawn. Clicking a row selects the
  zone and vice versa.
- **Storeys.** Ground floor and Level 1 tabs; the storey below is ghosted
  on the upper floor (toggle on the rail). The stair is one zone spanning
  both floors: one row in the schedule (floor "G–1"), drawn on each plan,
  one mass in the 3D.
- **Outline and doors.** The building outline is a true polygon union of
  every room's drawn shape. Door arrows walk the touching graph from the
  entry (from the stair on an upper floor). Stage 4 replaces this with
  arrows between any two adjacent rooms.
- **3D.** Colour by zone: every room extruded to storey height, the
  current level solid and the others translucent, the stair drawn once as
  a shaft with the floor plates cut around it. Or one grey volume per
  storey from its own outline. Drag to orbit, scroll to zoom.
- **Saved layouts.** Save the boxes as they are; load one back; "Start
  over with the sample" returns to the sample house. Reset on the rail
  returns to whatever was last loaded.

Room types, their minimum sizes and their zone colour are one table,
`frontend/src/rooms.ts`. Minimums are conceptual-design minimums, not
code — confirm against local code in detailed design.

## Run it on your computer

A small local web app: a Python server that serves the page and keeps
saved layouts, and the browser page itself. Nothing is hosted anywhere and
nothing leaves your machine.

**Install once** (all free):

1. **Python 3.10 or newer** — <https://www.python.org/downloads/>. On
   Windows, tick *"Add python.exe to PATH"* in the installer.
2. **Node.js (LTS)** — <https://nodejs.org/>. This builds the browser page.
3. **GitHub Desktop** — <https://desktop.github.com/>. Sign in, choose
   *File → Clone repository*, pick this repository, and choose a folder
   such as `Documents`. Later, *Fetch origin* pulls in updates. Make sure
   the branch shown at the top is `claude/zoning-editor-rebuild-shnp69`.

**Then, every time:**

- Windows: double-click `start.bat`.
- macOS / Linux: double-click `start.sh` (or run `./start.sh`).

The first run takes a few minutes while it installs what it needs into the
project folder (`.venv/` and `frontend/node_modules/`). Every run after
that re-checks those installs before building — a second or two — so a
version of the app that needs a new package gets it instead of failing on
an import. If the build fails the app does not start, rather than serving
the previous build as though it were the new one. A browser tab opens at
<http://localhost:8000>; closing the terminal window stops the app.

No API key is needed. Saved layouts live in `data/projects.db` inside the
folder.

## Setup (developers)

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
(cd frontend && npm install && npm run build)
uvicorn api.main:app --reload   # http://localhost:8000
```

For frontend work with hot reload, run `npm run dev` in `frontend/`. The
editor itself needs no backend at all; only the saved-layouts panel does,
and the Vite dev server on port 5173 proxies `/api` to it when it is
running.

## Running the tests

```bash
pip install -r requirements-dev.txt
ruff check .
pytest
(cd frontend && npm run typecheck && npm test)
```

The same commands run in GitHub Actions on every push
(`.github/workflows/ci.yml`): Python lint and tests, then the frontend's
typecheck, unit tests and build.

## Project layout

| Path | Purpose |
|---|---|
| `frontend/src/state/store.ts` | The single source of truth for the arrangement. Everything renders from it and every edit goes through it. |
| `frontend/src/sample.ts` | The hand-placed sample house the editor opens on, and the sheet size. |
| `frontend/src/rooms.ts` | Room types: label, minimum and typical size, zone. The only copy of these numbers. |
| `frontend/src/geometry/` | The canvas's movement rules as pure functions with unit tests: carve, protect the minimum, push last (`carve.ts`, `resolve.ts`); SAT overlap on rotated shapes (`rect.ts`); polygon booleans (`poly.ts`); footprint union; door arrows; stair shafts for the 3D. |
| `frontend/src/components/` | `Canvas2D.tsx` (SVG plan, gestures, camera), `View3D.tsx` and `Massing.tsx` (Three.js), `Schedule.tsx`, `Sidebar.tsx` (saved layouts), `StatusBar.tsx`. |
| `api/` | FastAPI: `/api/health`, `/api/projects` (saved layouts in SQLite, stored as the frontend's own boxes). Serves `frontend/dist` at `/`. |
| `start.sh` / `start.bat` | One-click local start. |
| `HANDOFF.md` | Where the work stands and what to be careful of. |
