# CDE non Interactive

*Non-interactive here means nothing generates the design for you. The
drawing is entirely hands-on.*

A web tool for the conceptual design phase of a house: the sketchy stage
before any detailed floor plan, when you are deciding what goes roughly
where. You draw the zones by hand on a sheet; the tool keeps a live room
schedule beside the drawing, holds everything inside the plot when you
ask it to, traces the building outline, draws the door arrows, and shows
the same arrangement as a 3D massing model.

Everything runs on your own computer. Nothing is hosted, nothing leaves
the machine, and no API key is needed.

> **History.** An earlier version generated the zoning diagram for you —
> a Claude conversation read the brief, and Python packed and scored
> candidate plans. Its results were never realistic, so the interactive
> editor was forked out as a clean, manually driven tool. That version is
> still on the branch `claude/design-engine-tool-access-92y89p` and in
> this repository's history; the intent is to reintegrate assisted
> generation once the editor is good on its own. Nothing described below
> depends on it.

## What the editor does

Three columns: the plan, the 3D massing, and the room schedule, all on
screen at once, all three readings of the one arrangement.

- **Tools (the rail).** *Select*: click a zone, shift-click to add, or
  drag empty sheet to rubber-band several. *Pan*: drag the sheet to move
  the view (the middle mouse button pans in any tool). *Rectangle* and
  *Circle*: drag on the sheet to draw a new zone; Shift holds a rectangle
  square. *Arrow*: click a zone's wall to put a door arrow on it. Escape
  cancels a drawing tool. Scroll to zoom in any tool; the Fit button on
  the plan frames the whole building.
- **Plan.** Corner handles resize, the top handle rotates freely (hold
  Shift for 15° steps), the × deletes, so does the Delete key. With
  several zones selected, dragging any one moves them all, the rotate
  handle turns them together about the group's centre, and × or Delete
  removes them all. A 0.25 m grid can be shown from the rail, and
  positions snap to it whether or not it is visible; a single zone
  dragged within 1 m of a facing neighbour snaps to touch it.
- **The magnet.** With zones selected, the magnet button on the rail
  moves each one until it touches its nearest neighbour, closing gaps
  under 1 m. It respects the plot: it will not push a zone through the
  boundary to close a gap.
- **Undo and redo.** Ctrl+Z and Ctrl+Shift+Z (or Ctrl+Y), and the two
  arrows on the rail. Everything that changes the drawing is covered:
  moves, resizes, rotations, drawing, deleting, schedule edits, carving,
  arrows, the magnet, adding and removing storeys, and Reset.
- **Overlap and carving.** Zones overlap freely and nothing is ever
  pushed: a zone goes exactly where you put it and nothing else moves.
  To cut, select a zone and press its carve handle (top-left corner) or
  the Carve button on its schedule row: it cuts every zone it sits over.
  The cut follows the carver, so moving it moves the notch and moving it
  away gives the space back; press again to release. A cut never resizes
  a zone for you — one cut below its type's minimum, or cut in two, keeps
  the cut and is outlined in red, named in the status bar, and marked
  with ! in the schedule, for you to resolve.
- **Automatic carving.** The toggle on the rail, off by default. With it
  on, a zone is carved by anything it overlaps that has a higher priority
  (1 is the highest; circulation and stairs start at 1, everything else
  at 2). Equal priorities never carve each other — the tool does not
  guess. It is computed rather than stored, so turning it off restores
  every zone exactly, and cuts made by hand survive either way.
- **The plot.** A site boundary with a size you type in, under the
  schedule: width, depth and an x/y offset. Off by default, it is a
  dashed rectangle to draw against and nothing more. Tick *Restrict zones
  to the plot* and it becomes a hard wall: a zone slides until its edge
  meets the line and then stops dead on that axis while still sliding
  along the other, a resize stops growing at the boundary with the corner
  you are not dragging left where it is, and a size typed into the
  schedule is capped at what the plot can hold — the schedule obeys the
  same wall as the canvas, or it would be a way around it. A rotation is
  never refused: a turned rectangle reaches further than an upright one
  (a 4 × 6 m zone at 45° needs 7.1 m of width), so the zone turns to
  whatever angle you want and slides in far enough to stay inside. A
  selection is held in as one rigid body, so the arrangement inside it
  never deforms against the wall. Switching the boundary on moves
  nothing: zones already over the line, and any zone too big to fit, are
  outlined in red and named in the status bar. The 3D draws the plot as a
  slab with a low kerb, and a zone dragged in 3D stops against it too.
  The plot is saved with the layout.
- **Schedule.** One row per zone: name, type, floor, width, depth,
  height, area, rotation and priority. Everything but area is edited in
  place and the zone follows; width and depth grow from the centre; area
  is read from the shape actually drawn. Each row also carries a Carve
  button. Clicking a row selects the zone and vice versa.
- **Storeys.** Tabs across the top of the plan, with buttons to add a
  storey or remove the top one — the top storey can only be removed once
  it is empty. From the rail you can outline the storey below and the
  storey above on the floor you are editing. A zone taller than one
  storey reaches into the ones above: the stair is one zone spanning both
  floors, one row in the schedule (floor "G–1"), drawn on each plan, one
  mass in the 3D.
- **Outline and doors.** The building outline is a true polygon union of
  every zone's drawn shape. Place arrows by hand with the arrow tool, or
  press Suggest on the rail to put one on every zone that has none,
  walking the touching graph from the entry (from the stair on an upper
  floor). Circles take no arrows.
- **3D.** Every zone is drawn once, from its own floor to its own
  ceiling, so a 7 m zone is one 7 m volume rather than a stack of
  storeys. Colour by zone shows each zone in its category colour with
  floor plates between the storeys, the floor you are editing solid and
  the rest translucent; unticked, the same volumes are one grey with each
  storey's outline, which is the shape the building makes. A floor plate
  is cut around anything passing through it. Drag to orbit, scroll to
  zoom, and click a zone to select it — the plan and the schedule follow,
  switching floors if the zone you picked lives on another one. Drag a
  zone and it moves in plan, snapping to the same grid and taking the
  whole selection with it — but only while *Move zones* is ticked above
  the view, so the model is safe to turn by default. Dragging anywhere
  else always orbits.
- **Open to below.** On the storeys above its own floor, a tall zone is
  not a room — it is the void it leaves. It is drawn crossed through and
  labelled "Open to below", the schedule shows its area as *void*, and no
  door arrow can be put on it there, since there is no floor to walk on.
  A stair is the exception: it is exactly a hole you do walk through, so
  it keeps its arrows on every storey it connects.
- **Status bar.** Along the foot: how many spaces are on this floor and
  their total area; with the plot on, how much of the site that floor
  covers; and the two things that must never be missed — zones carved
  below their minimum, and zones outside the plot — named, because a red
  outline off-screen is not seen.
- **Saved layouts.** Save the drawing as it stands, load one back, delete
  one, or start a new empty project. "Start over with the sample" returns
  to the sample house; Reset on the rail returns to whatever was last
  loaded.

Room types, their minimum sizes and their zone colour are one table,
`frontend/src/rooms.ts`. Minimums are conceptual-design minimums, not
code — confirm against local code in detailed design.

## Not built yet

- **A polygon plot.** The boundary is a rectangle. An irregular lot —
  corner plots, angled streets — is the same machinery against sloped
  edges, and the obvious next step.
- **Setbacks:** an inner offset the zones respect while the plot edge
  stays the legal line.
- **A "fit the plot to what is drawn" button.**
- **Assisted generation**, reintegrated from the branch named above.

## Run it on your computer

A small local web app: a Python server that serves the page and keeps
saved layouts, and the browser page itself.

**Install once** (all free):

1. **Python 3.10 or newer** — <https://www.python.org/downloads/>. On
   Windows, tick *"Add python.exe to PATH"* in the installer.
2. **Node.js (LTS)** — <https://nodejs.org/>. This builds the browser page.
3. **GitHub Desktop** — <https://desktop.github.com/>. Sign in, choose
   *File → Clone repository*, pick this repository, and choose a folder
   such as `Documents`. Later, *Fetch origin* pulls in updates. Make sure
   the branch shown at the top is the one you were asked to use; if no
   one has told you otherwise, it is `main`.

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

Saved layouts live in `data/projects.db` inside the folder.

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
| `frontend/src/sample.ts` | The hand-placed sample house the editor opens on, the sheet size, and the plot a project starts with. |
| `frontend/src/rooms.ts` | Room types: label, minimum and typical size, zone. The only copy of these numbers. |
| `frontend/src/geometry/` | The canvas's rules as pure functions with unit tests: the plot boundary and the clamps that hold every gesture inside it (`plot.ts`), carving (`carve.ts`), SAT overlap on rotated shapes (`rect.ts`), polygon booleans (`poly.ts`), grid and gap snapping (`snap.ts`), the touching graph (`touch.ts`, `doors.ts`), door arrows (`arrows.ts`), the building outline (`footprint.ts`), and the shared data model (`types.ts`). |
| `frontend/src/components/` | `Canvas2D.tsx` (SVG plan, gestures, camera), `View3D.tsx` and `Massing.tsx` (Three.js), `Schedule.tsx`, `PlotPanel.tsx` (the site boundary), `Sidebar.tsx` (saved layouts), `StatusBar.tsx`. |
| `api/` | FastAPI: `/api/health`, `/api/projects` (saved layouts in SQLite, stored as the frontend's own boxes). Serves `frontend/dist` at `/`. |
| `start.sh` / `start.bat` | One-click local start. |
| `HANDOFF.md` | Where the work stands and what to be careful of. |
