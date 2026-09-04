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

The method follows the seven stations of the zoning sheet the project was
rebuilt against: **zoning precedes bubbles** (zones come out of the site
analysis and rooms are arranged *inside* zones that are already fixed),
and there is a hard seam in the middle of the process. Everything before
the seam is judgement -- the brief, the site, the zones, the adjacency
matrix -- and Claude does it. Everything after the seam is arithmetic --
the feasibility gate, packing, validation, scoring -- and plain, tested
Python does it. The specification that crosses the seam is one Pydantic
object (`src/zoning_spec.py`), and nothing else passes between the two.

The app opens on a worked example -- a 20 x 28 m lot facing north with a
ten-room program already zoned inside it (`src/sample_project.py`) -- so
the first thing on screen is a live diagram to drag around rather than an
empty canvas. It runs through the same engine as a real project, from the
rule-based default specification, so it needs no API call. It is replaced
wholesale by your own project the moment you send your first chat message.

1. **Conversational intake (station 01).** You describe your project in
   the chat (site size, which sides face the street vs. neighbors, which
   way the plot faces, rooms you need, priorities). Claude extracts a
   structured site + room program from the conversation as you go
   (`src/extraction.py`), asking for whatever's still missing. Room sizes
   come from one readable defaults table (`src/defaults.py`) unless you
   state them; setbacks default to 2 m street / 1.5 m neighbor.
   Deterministic validation (`src/validation.py`) checks the program
   against the buildable envelope and Claude explains what it found.

2. **Site analysis (station 02).** Before any room is placed,
   `src/site_analysis.py` reads the plot: which edge the front door meets,
   which edges carry street noise, and -- once you've said which way the
   plot faces -- which edge gets the sun and which faces east for morning
   light. That becomes a preference for where each zone belongs: public
   rooms toward the sun, private rooms off the street, service rooms on
   the poor side and buffering the street. The sidebar shows exactly what
   was read. With no bearing given nothing is assumed; the notes say so and
   the intake asks.

3. **Zones and the adjacency matrix (stations 03-04).** Claude's one job
   past intake is to state the problem (`src/zoning_brief.py`): sort every
   room onto the public / private / service gradient, and write the
   adjacency matrix -- *must* share a wall, *should* be near, must be kept
   *apart* -- revising a rule-based default (`src/zoning_spec.py`) in light
   of what you said matters. Only "must" and "apart" survive as hard
   constraints; "should" becomes a scoring term. If Claude can't be
   reached the default specification stands in and the diagram still
   draws.

4. **Feasibility gate (station 05).** A plan of rectangular rooms is the
   rectangular dual of its adjacency graph, so a must-graph that can't be
   drawn flat has no plan at all. `src/feasibility.py` proves the brief
   buildable before packing: Euler's bound, a search for K5 and K3,3, and
   the stricter rule of the hall plan the packer draws (a room along a
   hall touches at most the room before and after it, so must-chains have
   to be paths). A failure names the adjacency to drop. The engine relaxes
   it to "should", draws the plan, and tells you what it did.

5. **Pack and score (station 06).** `src/zoning.py` draws the arrangement
   a house most often is: a hall runs straight back from the front door,
   rooms sit in two rows either side of it, and each row runs public,
   service, private along the hall. Which row a room lands in is enumerated
   -- every unit of rooms (a must-chain, or a single room) on one side or
   the other, up to 256 candidates -- and the garage always leads its row
   at the street. **The hall is earned, not assumed**: rooms at the street
   end open straight off the entry, a room beside a passable room is served
   through it, and the hall runs exactly as far as the last room nothing
   else serves -- or not at all. Rooms turn and shrink toward their
   minimums only when the plot forces it. `src/scoring.py` ranks the
   survivors on "should" adjacencies, the site preferences (weighted by how
   much each room's aspect matters -- the living room most), circulation
   inside the 5-10% band, privacy depth, and compactness.

6. **Validate (station 07).** `src/validator.py` holds every candidate to
   hard constraints, and a plan that fails one is not ranked lower -- it is
   not a plan: inside the envelope with no overlaps; walkable from the
   entry without passing through a bedroom, bathroom or garage
   (`src/access.py`); every must pair sharing a wall and no apart pair
   doing so; **depth as privacy, computed not declared** -- the justified
   plan graph rooted at the entry, private rooms deeper on average than
   public ones; hall area under the ceiling; habitable rooms above the
   code minimum. The outcome is graded rather than binary: `ok`, `relaxed`
   (the brief had to be loosened at the gate), `compromised` (nothing
   passes everything; the closest is shown with its failures listed), or
   `rejected` (nothing packs, with the reason).

   The rationale under the diagram is composed from what was actually
   decided -- which rooms face the sun, how many doors deeper the bedrooms
   sit, whether a hall was needed -- never from a template that could drift
   from the drawing.

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

   **Moving a room: carve first, protect the minimum, push last.** The room
   you pick up goes exactly where you put it — nothing pushes it back. What
   it overlaps gives up that space and draws itself around it, so rooms
   start as plain rectangles and become whatever the layout makes them: an
   L, a wedge, a notched shape. No room is ever carved below its minimum
   area or below the minimum rectangle it has to hold, and that's checked
   against every cut a room is taking at once — three cuts can each look
   harmless alone and gut a room together. Only where a room can't give the
   space up does anything move, and then it's the other room, one step,
   once — never a cascade. A room with nowhere to go is left overlapping
   rather than scattering the plan.

   Hallways work the other way round: drag a room onto one and the *room*
   bends around it. Circulation never gives way and never gets shoved.

   Rooms only ever give space up — they never reach beyond their own
   rectangle to take any. An earlier version had a room next to a rotated
   neighbour grow into the triangular void the rotation opened, to turn the
   gap into floor. It was removed for being unpredictable: you couldn't
   tell which room would grow, how far, or when, and rooms swelled and
   shrank as unrelated boxes moved nearby. A room is its rectangle, minus
   whatever is carved out of it.

   A rotated room moves freely — no grid snapping, no gap snapping, since
   both work on the unrotated rectangle, which isn't where a turned room
   is. Two rotated rooms can be pushed together until their real edges meet.

   Nothing changes a room's size except your own resize handle and the
   schedule's fields. And displacement undoes itself: drag across the plan
   and back and every room comes with you.

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

- **Zoning precedes bubbles.** The site is read first and zones are placed
  on it before any room is; rooms are arranged inside zones already fixed.
- **The seam is real.** Claude states the problem -- zones, adjacency
  matrix, rationale -- as one specification object, and never sees a
  coordinate or computes a size. Everything after that is deterministic,
  unit-tested Python that can be read, tested and argued with.
- **Access is a hard constraint; depth is measured.** A plan you cannot
  walk through is not a cheaper plan, it is a wrong one. Privacy is the
  justified-graph depth from the entry, computed, never a label.
- **Circulation is a cost, not something to eliminate.** Minimising
  hallway on its own drives straight back to rooms entered through other
  rooms; the hall is kept only where a room depends on it, and scored
  against the band a house normally spends.
- **Some briefs cannot be built, and it is proved before packing.** The
  feasibility gate fails with a sentence naming the requirement to drop,
  not a timeout.
- **Defaults are a starting point, not a black box.** Every room-sizing
  default lives in one readable table (`src/defaults.py`), every
  adjacency rule in another (`src/zoning_spec.py`), and the sidebar shows
  what the site analysis decided.
- **No numeric dimensions on the diagram.** Proportions reflect real sizes
  internally, but the point is to reason about adjacency and zoning.
- **One diagram, not two.** Everything the tool knows about the layout is
  rendered into the single interactive canvas.
- **Constraints hold live, not just at generation time.** The setback line
  and each room's own minimum size are enforced the whole time you're
  dragging or resizing, in the browser, with no server round trip.
- **Editing tools stay decision-preserving.** Delete hides a box rather
  than destroying it, so "Reset to recommended layout" can always undo.

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
| `app.py` | Streamlit UI — chat (fixed-height, scrollable) + interactive zoning diagram below it (schedule panel left of the drawing), sidebar summary of captured site/setback/envelope/site-analysis/priority state. Runs `src/engine.design` on every rerun. |
| `src/engine.py` | The pipeline, stations 02-07 end to end: site analysis → instances → feasibility gate → candidates → validate → score → best, with a graded outcome (ok / relaxed / compromised / rejected) and a rationale composed from the plan. |
| `src/site_analysis.py` | Station 02. Reads the plot's edges and bearing into per-edge sun, morning-light and street readings, and a preference for where each zone belongs. |
| `src/zoning_spec.py` | The specification that crosses the seam (`ZoningSpec`: zones + adjacency matrix), the rule-based default, reconciliation of Claude's proposal with it, and expansion of counted rooms into instances and requirements. |
| `src/zoning_brief.py` | Stations 03-04. Claude states the problem: revises the default zones and adjacency matrix in light of the owner's priorities and the site (structured output). |
| `src/feasibility.py` | Station 05. Proves the must-graph buildable before packing: planarity (Euler, K5, K3,3) and hall-plan realisability. Fails with the adjacency to drop. |
| `src/zoning.py` | Station 06, geometry. The hall-plan packer: entry at the head of the hall, two rows either side ordered public → service → private, the hall earned per room, rooms turned/shrunk only when the plot forces it; enumerates every side assignment as a candidate. |
| `src/scoring.py` | Station 06, judgement. Ranks the candidates that pass: "should" adjacencies, site preferences weighted by aspect importance, the 5-10% circulation band, privacy depth, compactness. |
| `src/validator.py` | Station 07. Hard constraints: envelope, overlaps, walkability, must/apart adjacencies, depth ordering, circulation ceiling, habitable minimums. |
| `src/access.py` | How each room type behaves in circulation — its zone, whether you may walk *through* it, whether it meets the street — and the walkability check the validator runs. |
| `src/circulation.py` | Graph geometry over rectangles: shared walls, door arrows, justified-graph depth, the union outline that is the building footprint. |
| `src/plan_types.py` | The shapes a finished plan is made of (`PlacedRoom`, `CorridorSegment`, `LayoutResult`), read by validation, scoring and the canvas. |
| `src/sample_project.py` | The worked example the app opens on: a complete, validating project plus its (default) specification, so the first paint needs no API call. |
| `src/models.py` | The shared data shapes (`Project`, `Site`, `Room`, ...). |
| `src/defaults.py` | Room-sizing defaults table (widths/depths per room type). |
| `src/geometry.py` | Buildable envelope from site + setbacks. |
| `src/validation.py` | Deterministic intake checks against the envelope (sizes, area, entry marked). |
| `src/extraction.py` | Conversation → structured `Project` (Claude, structured output). |
| `src/claude_client.py` | Anthropic client + plain-language explanation of intake issues. |
| `src/interactive_canvas.py` | Renders the interactive zoning diagram (title, zone legend, live door arrows, a 0.25m snap grid, selection-gated draggable/resizable/rotatable/deletable rooms and hallways with multi-select, a live-synced editable room schedule, display-shape carving around moved or rotated neighbours, a true polygon-union footprint outline, setback-constrained collision resolution) as self-contained HTML/CSS/JS, unit-tested. |
| `src/palette.py` | The 3 validated zone colors (public blue, private orange, service aqua). |
| `src/vendor/` | Vendored third-party code — polygon-clipping (MIT) for boolean polygon geometry, inlined into the diagram rather than loaded from a CDN. |
| `tests/` | Unit tests for every module above; the engine tests run the whole pipeline on ordinary, impossible and oversized briefs. |

## Roadmap

- Feedback loop: owner comments in chat → Claude revises the specification,
  informed by whatever the owner dragged, resized, rotated, or deleted.
- A second parti. The packer draws the central-hall plan; a through-hall
  plan (entry hall leading past the bedrooms to a garden-side living room)
  is the natural next candidate family for plots whose sun is on the back
  edge.
- Phase 2 (massing) and Phase 3 (optimization), out of scope for now.

## Constraints baked in

- Setbacks: flat (not height-dependent). Default 2 m from street-facing
  edges, 1.5 m from neighbor-facing edges. A corner lot can tag more than
  one edge as street-facing.
- Max building height: 15 m.
- Hallway width: fixed at 1.2 m (code compliance), enforced in validation.
- Circulation: scored against 5–10% of floor area; a plan over 13% is
  refused by the validator.
- Habitable rooms: at least 6.5 m² and 2.13 m across (IRC R304),
  checked on every placed room.
