"""Conversational input -> structured Project.

The owner describes their project in plain language; this module turns the
running conversation into a structured Project (site geometry, setbacks,
room program) that src.geometry / src.validation can check deterministically.

Room *sizes* are intentionally left null here unless the owner states an
explicit number — src.defaults.resolve_footprint fills the rest, so the
actual geometry numbers always come from one reviewable Python table, never
from the model's arithmetic.
"""

from __future__ import annotations

from typing import Dict, List

from pydantic import BaseModel

from src.claude_client import MODEL, get_client
from src.defaults import ROOM_DEFAULTS
from src.models import Project

ChatMessage = Dict[str, str]


class ExtractionResult(BaseModel):
    project: Project
    assistant_message: str


def _room_catalog_text() -> str:
    lines = [
        f"- {room_type}: {d.label} (min {d.min_width_m:.2f}m x {d.min_depth_m:.2f}m, "
        f"typical {d.typical_width_m:.2f}m x {d.typical_depth_m:.2f}m)"
        for room_type, d in ROOM_DEFAULTS.items()
    ]
    return "\n".join(lines)


SYSTEM_PROMPT_TEMPLATE = """\
You are the intake layer of a conceptual house-design tool. The owner \
describes their project in plain language across a conversation; your job \
is to extract it into the structured `project` field, and to write a short, \
warm `assistant_message` that moves the conversation forward.

Ground rules:
- Treat the whole conversation as the running brief. Carry forward every \
fact established earlier; only change something if the owner's latest \
message updates or contradicts it — newest statement wins.
- Convert imperial units (feet/inches) to meters (1 ft = 0.3048 m). If no \
unit is given, assume meters.
- Site edges: label the four sides of the rectangular site "front", \
"back", "left", "right" (front is normally the street side, but follow \
what the owner actually describes). Tag each edge's adjacency as "street" \
or "neighbor" — a corner lot can have two street-facing edges. Only fill \
in an edge once the owner has actually described that side; leave the \
`edges` list partial otherwise.
- Room sizing: only set explicit_width_m / explicit_depth_m when the owner \
states an actual number for that room. Otherwise leave them null — a \
typical default will be applied automatically. Match each room the owner \
mentions to the closest room_type from this catalog (use "other" plus a \
descriptive `name` and `priority_notes` if nothing fits):
{room_catalog}
- If the owner describes several of the same room (e.g. "three bedrooms"), \
either emit one Room with count=3, or three separate Room entries if they \
described them differently (sizes, priorities) — whichever preserves what \
they actually said.
- Mark is_entry=true on whichever room(s) the owner describes as a main \
entry, foyer, or front door.
- Record the owner's stated priorities in their own words (e.g. "privacy \
from the street", "morning light in the kitchen") in `priorities`.
- In `assistant_message`: briefly confirm what you just captured, name any \
defaults you're about to rely on for unspecified room sizes so nothing is \
a black box, and ask for the single most useful missing piece of \
information (site dimensions and edge adjacency first if still unknown, \
then room program, then priorities). Keep it conversational and short — \
a few sentences, not a form.
- IMPORTANT — this tool does not draw a room diagram yet. It only captures \
the site and room program in conversation; the sidebar shows a plain site \
outline once the site is fully described, nothing more. Never say a \
"zoning diagram," "layout," or "floor plan" has been created, drawn, or \
updated — it hasn't. Never mention numeric room dimensions either, since \
no diagram exists to show them on. If the owner asks to see the diagram, \
tell them plainly that the visual layout isn't built yet — only the \
site/room intake is — and that this part is still ahead.
- Do not fabricate site dimensions, setbacks, or room counts the owner \
never mentioned. Leave fields null/empty until they're actually stated.
"""


def build_system_prompt() -> str:
    return SYSTEM_PROMPT_TEMPLATE.format(room_catalog=_room_catalog_text())


def extract_project(history: List[ChatMessage]) -> ExtractionResult:
    """Run extraction over the full conversation so far.

    `history` is the chat transcript as a list of {"role": "user"|"assistant",
    "content": str} dicts, ending with the owner's latest message.
    """
    response = get_client().messages.parse(
        model=MODEL,
        max_tokens=4096,
        system=build_system_prompt(),
        messages=history,
        output_format=ExtractionResult,
    )
    return response.parsed_output
