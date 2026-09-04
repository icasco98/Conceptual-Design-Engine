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
from src.edits import RoomRotation
from src.models import Project

ChatMessage = dict[str, str]


class ExtractionResult(BaseModel):
    project: Project
    assistant_message: str
    # Rides along with extraction rather than costing a second round trip:
    # the model is already reading the whole conversation, and a rotation
    # request only ever appears in the owner's latest sentence.
    rotations: list[RoomRotation] = []


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
- Site bearing: set `site.rotation_deg` to the compass bearing the FRONT \
edge faces, clockwise from true north — front facing north is 0, east 90, \
south 180, west 270. Fill it whenever the owner says which way the house, \
the street or the front faces ("the street is on the south side" means \
the front faces south, so 180). Leave it null if they never say; the \
planner treats an unstated bearing as front-facing-north rather than \
guessing. This is what lets "morning light in the kitchen" mean an actual \
side of this particular plot, so it is worth one question if the owner \
has stated a sun or daylight preference and no orientation.
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
- Storeys: `storeys` defaults to 1. Set it to 2 (or more) only when the \
owner says the house has more than one floor ("two-storey", "bedrooms \
upstairs", "a first floor"). When storeys > 1, add one Room of room_type \
"stair" (name it "Stair") with `levels` listing every storey it connects, \
e.g. [0, 1] -- the stair is the one room that exists on several levels. \
Every other room's `levels` is a single level, 0 = ground; put a room on \
an upper level only when the owner places it there ("bedrooms upstairs" \
-> bedrooms and their bathrooms get [1]). Leave everything else on [0]; \
don't invent a level split the owner never described.
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
- ROTATION: when the owner asks for a room to be turned ("rotate the \
office 45 degrees", "put the living room on the diagonal", "straighten \
the kitchen"), add an entry to `rotations` naming the room and the angle \
it should end up at — absolute, clockwise, 0 = upright. A bare "rotate X \
by N degrees" means N unless they have clearly turned that room before. \
"Straighten" or "put it back square" is 0. Leave `rotations` empty for \
every message that does not ask for one; it is not a place to volunteer \
ideas. Say in `assistant_message` that you have turned it, and add that a \
turned room has to fit — the diagram will say so if it cannot. Never \
promise the angle will hold, and never state coordinates.
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
