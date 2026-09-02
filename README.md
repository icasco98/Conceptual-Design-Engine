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

The app opens on a worked example — a 20 x 28 m lot with a zoned program
already inside it (`src/sample_project.py`) — so the first thing on screen
is a live diagram to drag around rather than an empty canvas. It is a
plain literal, needs no API call, and is replaced wholesale by your own
project the moment you send your first chat message. It is never merged
with yours and never sent to Claude as context.

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
   title, color legend, rationale, and a live room schedule in a panel to
   its left, with every room *and* hallway as a draggable box (nothing
   here is a fixed zone) so you can explore a different arrangement by
   hand.

   **Selection.** A box's handles are hidden until you select it —
   clicking its body (or its row in the schedule) selects it and clears
   any other selection; shift-clicking adds/removes it from a multi-box
   selection instead; clicking empty canvas clears the selection. Once
   selected, each box has:
   - **Corner handles to resize it** — drag any corner and the opposite
     one stays put. Only shown for a single (not multi-) selection, since
     resizing several boxes from one dragged corner is ambiguous.
   - **A rotate handle**, spinning the box in fixed 5° steps. With more
     than one box selected, grabbing *any* selected box's rotate handle
     spins the whole selection together (each box around its own center,
     by the same angle) — see Multi-select below.
   - **A delete handle** (hides the box — not a fixed decision, since
     "Reset to recommended layout" always brings it back). Deletes the
     whole selection at once if more than one box is selected.
   - **A 0.25m grid** you can show or hide with a checkbox in the header;
     independent of that, every drag or resize always snaps position to
     that same grid, whether or not it's visible. Dragging a box within 1m
     of a same-facing neighbor also snaps it the rest of the way to touch
     exactly, so it's easy to close an accidental sliver of empty space
     between zones instead of pixel-hunting for the exact touching spot.

   **Rotating a room reshapes its neighbours instead of moving them.** A
   room's model is always a rectangle plus a rotation — that's what the
   schedule's width and depth edit — but what it *draws* can be a polygon.
   Turn a room and it's allowed to bite into the ones beside it: each
   neighbour gives up just the overlapping sliver and draws itself as an
   L-shape against the slanted wall, while its position and size stay
   exactly as they were. Rooms also reach into the triangular voids a
   rotation opens, so those become floor rather than slots you can't walk
   through.

   A bite only goes ahead if the room keeps its minimum area *and* still
   holds its minimum rectangle — area alone would let an L-shape keep its
   number as a dogleg nothing fits in — and never if the cut would split a
   room in two, which is what stops a hallway ever being severed. Where a
   bite isn't allowed, the rotation is refused rather than the neighbour
   displaced; nothing on the canvas moves because you turned something.
   Un-rotate and every neighbour comes back whole, since the carving is
   recomputed live and never written into the rooms themselves.

   The schedule carries a live **area** column read from the shape actually
   drawn, marked when a room has been reshaped — an L-shaped room has no
   single width, so area is what you check it against.

   Rotated rooms have no invisible box around them: two rooms turned
   toward each other are separated by their real shapes, so their drawn
   edges meet exactly, and they reshape around each other the same way a
   square room does. (Separation used to be measured on each room's
   upright bounding box, which for a turned room is bigger than the room —
   so they were held apart by a gap that wasn't there.)

   The building outline is a true union of those shapes, so it follows a
   rotated room's diagonal walls exactly. All the boolean geometry —
   carving, gap fill, the outline — is done by the vendored
   [polygon-clipping](https://github.com/mfogel/polygon-clipping) library
   (MIT, `src/vendor/`), inlined into the page so the diagram stays
   self-contained and works offline.

   **Room schedule.** In the column left of the canvas, a table lists
   every box's current width, depth, and rotation in meters/degrees. It
   is the only room table in the app — the sidebar carries site, setback,
   envelope and priority context, but no second list of rooms. Width and
   depth are editable in place — typing a new value resizes the box on the canvas
   (growing/shrinking from its center, since a table cell has no natural
   corner to anchor to) exactly as if you'd dragged its corner. It's
   kept live-synced with the canvas in both directions, and clicking a row
   selects the matching box (and vice versa).

   Door arrows — one per shared wall on the current circulation path,
   drawn with an arrowhead, re-walked from whichever boxes are actually
   touching right now — show where each room connects to the one next to
   it, and are always exactly perpendicular to the wall they cross by
   construction.

   Colors are locked, but as you drag, resize, or rotate, three things
   stay continuously true instead of just at the start:
   - **No overlaps, including rotated ones.** Moving, resizing, or
     rotating a box pushes any other box it would *actually* overlap out
     of the way, cascading if needed. Two rotated rooms are checked
     against their true rotated shapes (not an inflated bounding box), so
     you can push them together until their real edges actually touch —
     not stopped early by a margin that isn't really there.
   - **The setback line is a hard wall.** The buildable envelope is drawn
     as a dashed line, and no box — dragged, resized, rotated, or pushed —
     can ever cross it.
   - **Rooms may shrink, never below their minimum.** A pushed box shrinks
     toward its own type minimum first (never below it — `src/defaults.py`
     for rooms, the fixed code hallway width for corridors) before it's
     displaced any further, the same idea as the initial layout's own
     footprint compaction, just live. A manual corner-resize (on the
     canvas or in the schedule) is clamped to that same minimum directly.

   The building footprint outline updates after every move, resize,
   rotate, or delete, too — it's the union of whatever boxes are currently
   on the canvas and not deleted, following each box's true rotated shape
   rather than an inflated bounding box, not a fixed shape from the
   initial layout.

   It's a self-contained HTML/CSS/JS widget (`streamlit.components.v1.html`),
   not a third-party Streamlit component: dragging happens entirely in the
   browser with nothing sent back to Python, so there's no server round
   trip for the two to fall out of sync over. The trade-off is that
   dragging is local to that browser view — sending a new chat message
   (or reloading the page) resets it back to Claude's recommended layout,
   since Python was never told about any of it in the first place. A
   "Reset to recommended layout" button (also pure JS) restores position,
   size, rotation, selection, and any deleted spaces on demand.

   Rotation is a CSS transform for *rendering*, but overlap detection uses
   each box's true rotated shape (oriented-box collision, via the
   separating-axis theorem) rather than treating rotation as purely
   cosmetic — that's what lets two rotated rooms actually touch. The
   collision-response bookkeeping (how far to push, whether a shrink is
   possible) still works off the rotated shape's axis-aligned bounding
   box for simplicity, and a rotated box is only ever translated, never
   resized, when it has to give way, so a CSS rotation is never distorted.
   Full rotated-rectangle geometry throughout (e.g. a footprint outline
   with clean diagonal edges instead of a fine staircase around a rotated
   room) is a bigger feature than this tool needs; this covers the part
   that matters for exploring adjacency.

**Not yet built:** a chat-driven revision loop where the arrangement you
dragged becomes the starting point for Claude's next suggestion. See
Roadmap below.

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
  than destroying it, and a rotated box is only ever translated (never
  resized) when it has to give way to a neighbor — so nothing you do in
  the canvas can put the geometry in a state "Reset to recommended
  layout" can't cleanly undo.

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
| `src/vendor/` | Vendored third-party code — polygon-clipping (MIT) for boolean polygon geometry, inlined into the diagram rather than loaded from a CDN. |
| `src/sample_project.py` | The worked example the app opens on — a complete, validating project plus the layout plan Claude would have returned for it, so the first paint needs no API call. |
| `app.py` | Streamlit UI — chat (fixed-height, scrollable) + interactive zoning diagram below it (schedule panel left of the drawing), sidebar summary of captured site/setback/envelope/priority state. |
| `src/models.py` | The shared data shapes (`Project`, `Site`, `Room`, ...). |
| `src/defaults.py` | Room-sizing defaults table (widths/depths per room type). |
| `src/geometry.py` | Buildable envelope from site + setbacks. |
| `src/validation.py` | Deterministic constraint checks against the envelope. |
| `src/extraction.py` | Conversation → structured `Project` (Claude, structured output). |
| `src/claude_client.py` | Anthropic client + plain-language explanation of issues. |
| `src/layout_plan.py` | Claude picks room categories + adjacency order (structured output). |
| `src/layout.py` | Deterministic rectangle packing, footprint compaction, building footprint outline, and circulation graph — no LLM math, unit-tested. |
| `src/interactive_canvas.py` | Renders the interactive zoning diagram (title, legend, live door arrows, a 0.25m snap grid, selection-gated draggable/resizable/rotatable/deletable rooms and hallways with multi-select group rotate/delete, a live-synced editable room schedule in a column left of the drawing, display-shape morphing around rotated neighbours, a true polygon-union footprint outline, gap-closing snap, true rotated-shape collision, live footprint outline, setback-constrained collision resolution with shrink-toward-minimum) as self-contained HTML/CSS/JS, unit-tested. |
| `src/palette.py` | The 3 validated diagram colors (see dataviz notes in the module docstring). |
| `tests/` | Unit tests for geometry/defaults/validation/layout/interactive canvas. |

## Roadmap

- Feedback loop: owner comments in chat → Claude revises the layout,
  informed by whatever the owner dragged, resized, rotated, or deleted.
- Phase 2 (massing) and Phase 3 (optimization), out of scope for now.

## Constraints baked in

- Setbacks: flat (not height-dependent). Default 2 m from street-facing
  edges, 1.5 m from neighbor-facing edges. A corner lot can tag more than
  one edge as street-facing.
- Max building height: 15 m.
- Hallway width: fixed at 1.2 m (code compliance), enforced in validation.
