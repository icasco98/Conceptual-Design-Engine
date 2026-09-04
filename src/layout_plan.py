"""Claude's role in Phase 1 step 3: colour categories and the adjacency
graph for the room program.

Claude never touches coordinates or sizes. It decides which of three fixed
categories each room belongs to (src.palette owns the actual colours) and,
more importantly, which rooms should share a wall and how strongly.

That second output used to be `placement_order`, a flat list of room names
that the packer read as a left-to-right sequence. It was the wrong shape for
the job. A list gives every room exactly two neighbours and cannot say "the
ensuite opens off the primary bedroom" about two rooms sitting four apart in
it, so the brief was flattened before any geometry ran and the packer spent
its effort guessing back what the list had dropped. Adjacency is a graph:
any room may need to touch any other, and one rectangle can touch four at
once.

So Claude now returns `adjacency` -- unordered room pairs, each marked
`must`, `should` or `avoid` (see src.adjacency). src.place arranges the
rooms to satisfy as much of that graph as the geometry allows, and can
report afterwards exactly which pairs it delivered. With an ordering there
was never anything to check the result against.
"""

from __future__ import annotations

import json
from typing import List, Literal

from pydantic import BaseModel

from src.adjacency import AdjacencyRule
from src.claude_client import MODEL, get_client
from src.models import Project
from src.palette import CATEGORY_KEYS

CategoryKey = Literal["category_a", "category_b", "category_c"]


class CategoryLabels(BaseModel):
    category_a: str
    category_b: str
    category_c: str


class RoomAssignment(BaseModel):
    room_name: str
    category: CategoryKey


class LayoutPlan(BaseModel):
    grouping_label: str
    category_labels: CategoryLabels
    assignments: List[RoomAssignment]
    adjacency: List[AdjacencyRule] = []
    rationale: str


SYSTEM_PROMPT = """\
You are the layout-planning layer of a conceptual house-design tool. You \
are given a room program and the owner's stated priorities. You do not \
compute any coordinates, sizes or positions — a separate deterministic \
engine handles all geometry. Your job has three parts:

1. Group every room into exactly one of three fixed categories \
(category_a, category_b, category_c), based on whatever the owner's \
priorities suggest matters most — e.g. privacy level (private / shared / \
service), or function (rest / gather / support). Pick ONE grouping \
principle and apply it consistently to every room; name it in \
`grouping_label` (e.g. "Grouped by privacy level") and give each category \
a short plain-language label in `category_labels` (e.g. "Private", \
"Shared", "Service").

2. State the `adjacency` graph: which rooms should share a wall, as \
unordered pairs. This is the important output — it is the whole of what \
the engine knows about how the plan should hang together. Each rule has \
`room_a`, `room_b`, a `strength`, and a short `reason`:

     must    the plan is WRONG without these two sharing a wall. An \
             ensuite off its bedroom; a dining room off its kitchen. Use \
             this sparingly — every `must` constrains the geometry hard, \
             and a brief where everything must touch everything is \
             impossible to build (a rectangular plan cannot give more \
             than 3n-6 pairs a shared wall).
     should  a real preference worth honouring if the geometry allows. \
             Kitchen near the entry for carrying shopping in; living room \
             near the entry for receiving guests.
     avoid   these two should NOT share a wall. A bedroom opening off the \
             garage; a bathroom door onto the dining room.

Use the exact room `name` values from the program. Refer to a counted room \
by its single program name ("Bedroom", not "Bedroom 1") — the engine \
expands counts on its own, pairing `must` rules up by index and spreading \
`should` and `avoid` across every instance. Do not state a rule between a \
room and itself. Omit hallways entirely: circulation is generated to code \
width and every room is connected to it automatically, so you never need \
a rule saying a room touches a hallway.

State only relationships you would actually defend to the owner. An empty \
or near-empty graph is a perfectly good answer for a simple program — it \
leaves the engine free to optimise for compactness and daylight instead. \
Ten weak `should`s are worse than three real ones.

3. Write a 1-3 sentence `rationale` in plain language explaining the \
grouping and the adjacency choices, referencing the owner's stated \
priorities where relevant. Do not mention coordinates, exact positions, or \
numeric dimensions.
"""


def plan_layout(project: Project) -> LayoutPlan:
    room_summary = [
        {
            "name": room.name,
            "room_type": room.room_type,
            "count": room.count,
            "is_entry": room.is_entry,
            "priority_notes": room.priority_notes,
        }
        for room in project.rooms
    ]
    user_content = (
        f"Room program:\n{json.dumps(room_summary, indent=2)}\n\n"
        f"Owner's stated priorities: {', '.join(project.priorities) or 'none stated'}\n\n"
        f"Available category keys: {', '.join(CATEGORY_KEYS)}"
    )

    response = get_client().messages.parse(
        model=MODEL,
        max_tokens=2048,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_content}],
        output_format=LayoutPlan,
    )
    return response.parsed_output
