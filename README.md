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

**Current scope (this commit):** the first two steps of Phase 1 —

1. **Conversational intake.** You describe your project in the chat (site
   size, orientation, which sides face the street vs. neighbors, rooms you
   need, priorities). Claude extracts a structured site + room program from
   the conversation as you go, asking for whatever's still missing.
2. **Geometry & validation.** Plain Python computes the buildable envelope
   (site rectangle minus setbacks) and checks the room program against it —
   minimum sizes, hallway width, total area, whether an entry is marked.
   Claude only explains what Python found, in plain language; it never
   computes the numbers itself.

**Not yet built:** the interactive drag-to-arrange canvas, an initial
adjacency-optimized layout recommendation, and color-coding by priority —
see Roadmap below. Building the intake + validation loop first (and getting
it right) was a deliberate choice before adding the canvas.

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
| `app.py` | Streamlit UI — chat loop, sidebar summary of captured state. |
| `src/models.py` | The shared data shapes (`Project`, `Site`, `Room`, ...). |
| `src/defaults.py` | Room-sizing defaults table (widths/depths per room type). |
| `src/geometry.py` | Buildable envelope from site + setbacks. |
| `src/validation.py` | Deterministic constraint checks against the envelope. |
| `src/extraction.py` | Conversation → structured `Project` (Claude, structured output). |
| `src/claude_client.py` | Anthropic client + plain-language explanation of issues. |
| `tests/` | Unit tests for geometry/defaults/validation. |

## Roadmap

- Claude-recommended initial adjacency-optimized layout, with color-coding
  based on owner-stated priorities (privacy, function, light, etc.).
- Interactive canvas: drag room rectangles to rearrange, live-updating
  adjacencies, entry points and circulation paths highlighted.
- Feedback loop: owner comments in chat → Claude revises the layout.
- Phase 2 (massing) and Phase 3 (optimization), out of scope for now.

## Constraints baked in

- Setbacks: flat (not height-dependent). Default 2 m from street-facing
  edges, 1.5 m from neighbor-facing edges. A corner lot can tag more than
  one edge as street-facing.
- Max building height: 15 m.
- Hallway width: fixed at 1.2 m (code compliance), enforced in validation.
