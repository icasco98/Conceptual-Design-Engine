# Conceptual Design Engine

A web-based tool for the conceptual design phase of architecture — the
sketchy, upstream stage before any detailed floor plan exists. Three
sequential stages are planned:

1. **Zoning diagram** — what this repo currently builds.
2. **Massing** — 3D solid geometry + fenestration, informed by weather/solar
   data. Not started.
3. **Optimization** — thermal performance, daylight, and view/privacy
   trade-offs. Not started.

## Phase 1 — Zoning Diagram Generator

Goal: turn a plain-language description of a house project into a
zoning/bubble diagram of its rooms, before any detailed floor plan exists.

**Current scope (this commit):** all four steps of Phase 1 —

1. **Conversational intake.** You describe your project in the chat (site
   size, orientation, which sides face the street vs. neighbors, rooms you
   need, priorities). Claude extracts a structured site + room program from
   the conversation as you go, asking for whatever's still missing.
2. **Geometry & validation.** Plain Python computes the buildable envelope
   (site rectangle minus setbacks) and checks the room program against it —
   minimum sizes, hallway width, total area, whether an entry is marked.
   Claude only explains what Python found, in plain language; it never
   computes the numbers itself.
3. **Layout recommendation.** Once the site and at least one room are
   described, plain Python packs the room program into an actual
   non-overlapping arrangement (`src/layout.py`): rooms grouped into 3
   categories Claude picks based on your stated priorities (e.g. privacy
   level), the entry marked, corridors generated automatically between room
   clusters, and a circulation graph showing how to get from the entry to
   any room one hop at a time. Claude only decides the *grouping and
   adjacency* (which rooms belong together, which should sit near each
   other); the packer does the actual arithmetic, so it's always
   geometrically valid — no overlaps, everything fits inside the buildable
   envelope, every room reachable. The packer also traces the building's
   own footprint — the outline around the actual rooms and corridors it
   placed, not the buildable envelope — so the diagram distinguishes
   "inside the building" from "buildable but unused site."
4. **Interactive canvas — the diagram itself.** The recommendation above
   is shown as a single interactive canvas (`src/interactive_canvas.py`):
   title, color legend, and rationale, with every room *and* hallway as a
   draggable box (nothing here is a fixed zone) so you can explore a
   different arrangement by hand. Each box also has:
   - **Corner handles to resize it** — drag any corner and the opposite
     one stays put.
   - **A rotate handle**, spinning the box in fixed 5° steps.
   - **A delete handle** (hides the box — not a fixed decision, since
     "Reset to recommended layout" always brings it back).
   - **A 0.25m grid** you can show or hide with a checkbox in the header;
     independent of that, every drag or resize always snaps position to
     that same grid, whether or not it's visible.

   Door arrows — one per shared wall on the recommended circulation path,
   drawn with an arrowhead — show where each room connects to the one
   next to it.

   Colors are locked, but as you drag or resize, three things stay
   continuously true instead of just at the start:
   - **No overlaps.** Moving or resizing a box pushes any other box it
     would overlap out of the way, cascading if needed.
   - **The setback line is a hard wall.** The buildable envelope is drawn
     as a dashed line, and no box — dragged, resized, or pushed — can ever
     cross it.
   - **Rooms may shrink, never below their minimum.** A pushed box shrinks
     toward its own type minimum first (never below it — `src/defaults.py`
     for rooms, the fixed code hallway width for corridors) before it's
     displaced any further, the same idea as the initial layout's own
     footprint compaction, just live. A manual corner-resize is clamped to
     that same minimum directly.

   The building footprint outline updates after every move, resize, or
   delete, too — it's the union of whatever boxes are currently on the
   canvas and not deleted, not a fixed shape from the initial layout.

   It's a self-contained HTML/CSS/JS widget (`streamlit.components.v1.html`),
   not a third-party Streamlit component: dragging happens entirely in the
   browser with nothing sent back to Python, so there's no server round
   trip for the two to fall out of sync over. The trade-off is that
   dragging is local to that browser view — sending a new chat message
   (or reloading the page) resets it back to Claude's recommended layout,
   since Python was never told about any of it in the first place. A
   "Reset to recommended layout" button (also pure JS) restores position,
   size, rotation, and any deleted spaces on demand.

   Rotation is deliberately cosmetic — a CSS transform layered on top of
   the same axis-aligned box the collision/footprint/envelope math already
   reasons about, not fed back into any of it. Full rotated-rectangle
   geometry is a much bigger feature than a conceptual zoning tool needs;
   this gives you an orientation cue without it.

**Not yet built:** live door-arrow/circulation feedback as you drag (they
stay fixed to the initial recommendation), and a chat-driven revision loop
where the arrangement you dragged becomes the starting point for Claude's
next suggestion. See Roadmap below.

### Design principles

- **Deterministic code owns the numbers.** Room sizing, setback math, and
  constraint checks live in `src/geometry.py`, `src/defaults.py`, and
  `src/validation.py` — plain Python, unit-tested, no LLM involved. Claude's
  job is narrower: turn conversation into structured data
  (`src/extraction.py`), and turn Python's findings into plain language
  (`src/claude_client.py`).
- **No numeric dimensions on the diagram** (once the diagram exists) —
  proportions reflect real sizes internally, but the point is to reason
  about adjacency and zoning, not read off measurements.
- **Defaults are a starting point, not a black box.** Every room-sizing
  default lives in one readable table (`src/defaults.py`) and Claude tells
  you which ones it's relying on.
- **The footprint is compacted, not just packed.** Each room may be nudged
  up to 0.5m smaller than its nominal size — width to help it share a row
  instead of forcing a wrap, depth to trim a row down to whichever room in
  it actually needs the most depth — but never below that room type's
  real minimum. A room only shrinks when doing so actually makes the
  building smaller (`src/layout.py`, `MAX_SHRINK_M`).
- **One diagram, not two.** Everything the tool knows about the layout —
  grouping, adjacency, footprint — is rendered into the single interactive
  canvas; there's no separate static image to keep in sync with it.
- **Constraints hold live, not just at generation time.** The setback
  line and each room's own minimum size aren't just inputs to the initial
  packer — they're enforced the whole time you're dragging or resizing, in
  the browser, with no server round trip (see step 4 above).
- **Editing tools stay decision-preserving.** Delete hides a box rather
  than destroying it, and rotation is purely cosmetic (never fed into
  collision/footprint/envelope math) — so nothing you do in the canvas can
  put the geometry in a state "Reset to recommended layout" can't cleanly
  undo.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env            # then paste your key into .env
streamlit run app.py
```

Get an API key at <https://console.anthropic.com/settings/keys>.

## Running the tests

The geometry, defaults, and validation logic is unit-tested and doesn't
call the API:

```bash
pip install pytest
pytest
```

## Project layout

| Path | Purpose |
|---|---|
| `app.py` | Streamlit UI — chat (fixed-height, scrollable) + interactive zoning diagram below it, sidebar summary of captured state. |
| `src/models.py` | The shared data shapes (`Project`, `Site`, `Room`, ...). |
| `src/defaults.py` | Room-sizing defaults table (widths/depths per room type). |
| `src/geometry.py` | Buildable envelope from site + setbacks. |
| `src/validation.py` | Deterministic constraint checks against the envelope. |
| `src/extraction.py` | Conversation → structured `Project` (Claude, structured output). |
| `src/claude_client.py` | Anthropic client + plain-language explanation of issues. |
| `src/layout_plan.py` | Claude picks room categories + adjacency order (structured output). |
| `src/layout.py` | Deterministic rectangle packing, footprint compaction, building footprint outline, and circulation graph — no LLM math, unit-tested. |
| `src/interactive_canvas.py` | Renders the interactive zoning diagram (title, legend, door arrows, a 0.25m snap grid, draggable/resizable/rotatable/deletable rooms and hallways, live footprint outline, setback-constrained collision resolution with shrink-toward-minimum) as self-contained HTML/CSS/JS, unit-tested. |
| `src/palette.py` | The 3 validated diagram colors (see dataviz notes in the module docstring). |
| `tests/` | Unit tests for geometry/defaults/validation/layout/interactive canvas. |

## Roadmap

- Live door-arrow/circulation feedback as rooms are dragged in the
  interactive canvas (today the arrows stay fixed to Claude's original
  recommendation, since they come from re-running a touching-graph BFS
  that only runs once in Python; the footprint outline, by contrast,
  already updates live client-side as you drag or resize).
- Feedback loop: owner comments in chat → Claude revises the layout,
  informed by whatever the owner dragged, resized, rotated, or deleted.
- Phase 2 (massing) and Phase 3 (optimization), out of scope for now.

## Constraints baked in

- Setbacks: flat (not height-dependent). Default 2 m from street-facing
  edges, 1.5 m from neighbor-facing edges. A corner lot can tag more than
  one edge as street-facing.
- Max building height: 15 m.
- Hallway width: fixed at 1.2 m (code compliance), enforced in validation.
