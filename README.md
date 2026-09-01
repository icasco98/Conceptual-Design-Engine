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
   different arrangement by hand. Sizes and colors are locked — only
   position moves — and dragging one box pushes any other box it would
   overlap out of the way, cascading if needed, so two spaces can never
   end up overlapping. It's a self-contained HTML/CSS/JS widget
   (`streamlit.components.v1.html`), not a third-party Streamlit
   component: dragging happens entirely in the browser with nothing sent
   back to Python, so there's no server round trip for the two to fall out
   of sync over. The trade-off is that dragging is local to that browser
   view — sending a new chat message (or reloading the page) resets it
   back to Claude's recommended positions, since Python was never told
   about the drag in the first place. A "Reset to recommended positions"
   button (also pure JS) does the same thing on demand.

**Not yet built:** live adjacency/circulation feedback as you drag, and a
chat-driven revision loop where the arrangement you dragged becomes the
starting point for Claude's next suggestion. See Roadmap below.

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
| `src/interactive_canvas.py` | Renders the interactive zoning diagram (title, legend, draggable rooms/hallways, footprint outline, collision resolution) as self-contained HTML/CSS/JS, unit-tested. |
| `src/palette.py` | The 3 validated diagram colors (see dataviz notes in the module docstring). |
| `tests/` | Unit tests for geometry/defaults/validation/layout/interactive canvas. |

## Roadmap

- Live adjacency/circulation feedback as rooms are dragged in the
  interactive canvas (today the faint circulation lines and footprint
  outline stay fixed to Claude's original recommendation; only room and
  hallway position updates as you drag).
- Feedback loop: owner comments in chat → Claude revises the layout,
  informed by whatever the owner dragged.
- Phase 2 (massing) and Phase 3 (optimization), out of scope for now.

## Constraints baked in

- Setbacks: flat (not height-dependent). Default 2 m from street-facing
  edges, 1.5 m from neighbor-facing edges. A corner lot can tag more than
  one edge as street-facing.
- Max building height: 15 m.
- Hallway width: fixed at 1.2 m (code compliance), enforced in validation.
