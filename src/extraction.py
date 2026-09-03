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

from pydantic import BaseModel

from src.claude_client import EFFORT, MODEL, cached_system, get_client
from src.defaults import ROOM_DEFAULTS
from src.models import Project

ChatMessage = dict[str, str]


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
- Setbacks default to 2m from street-facing edges and 1.5m from \
neighbor-facing edges automatically — you don't need the owner to provide \
these or approve them. State them as a fact when it's relevant (e.g. \
mentioning the buildable envelope), never as a question. Only change a \
setback value when the owner explicitly gives a different number for it; \
never ask "is that okay?" or otherwise seek approval for a default.
- In `assistant_message`: briefly confirm what you just captured, and — \
only if it's genuinely useful context, not as a request for approval — \
mention a default you're relying on (room size or setback) so nothing is \
a black box. State defaults confidently, as decisions already made, not \
as proposals awaiting the owner's sign-off. Then ask for the single most \
useful missing piece of information (site dimensions and edge adjacency \
first if still unknown, then room program, then priorities). Keep it \
conversational and short — a few sentences, not a form.
- IMPORTANT — a zoning diagram appears automatically below the chat once \
the site is fully described and at least one room exists; you don't draw \
it or trigger it, it just appears. Never mention numeric room dimensions \
in `assistant_message` — the diagram never shows them. Circulation \
(hallways) is generated automatically at the fixed code width between \
room groups; if the owner mentions wanting a hallway, acknowledge it but \
don't ask them to size it or promise a specific hallway box — say \
circulation between the room groups is handled automatically instead. \
The owner can drag, resize and rotate rooms by hand on the diagram below \
the chat — if asked, say so plainly; their manual arrangement is theirs to \
explore, you don't need to describe positions.
- Do not fabricate site dimensions, setbacks, or room counts the owner \
never mentioned. Leave fields null/empty until they're actually stated.
"""


def build_system_prompt() -> str:
    return SYSTEM_PROMPT_TEMPLATE.format(room_catalog=_room_catalog_text())


def extract_project(history: list[ChatMessage]) -> ExtractionResult:
    """Run extraction over the full conversation so far.

    `history` is the chat transcript as a list of {"role": "user"|"assistant",
    "content": str} dicts, ending with the owner's latest message.
    """
    response = get_client().messages.parse(
        model=MODEL,
        max_tokens=4096,
        system=cached_system(build_system_prompt()),
        output_config={"effort": EFFORT},
        messages=history,
        output_format=ExtractionResult,
    )
    return response.parsed_output
