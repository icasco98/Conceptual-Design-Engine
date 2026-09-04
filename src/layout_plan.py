"""Claude's role in Phase 1 step 3: propose color categories and an
adjacency-aware placement order for the room program.

Claude never touches coordinates or sizes — it only decides which of three
fixed categories each room belongs to (src.palette owns the actual colors)
and a room ordering that expresses "these should end up near each other."
src.layout turns that ordering into an actual non-overlapping arrangement.
"""

from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel

from src.claude_client import EFFORT, MODEL, cached_system, get_client
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


class Adjacency(BaseModel):
    """Two rooms that should end up near each other, or well apart.

    `placement_order` could only ever say this by putting two names next to
    each other in a list, which is a weak and lossy channel: it cannot say
    how much a pairing matters, it cannot say two rooms should be kept
    apart at all, and a room can only be adjacent to two others in a list
    however many it actually wants to touch. This says it directly.
    """

    room_a: str
    room_b: str
    relation: Literal["near", "apart"]
    strength: Literal["strong", "mild"] = "mild"


class LayoutPlan(BaseModel):
    grouping_label: str
    category_labels: CategoryLabels
    assignments: list[RoomAssignment]
    placement_order: list[str]
    adjacencies: list[Adjacency] = []
    rationale: str


SYSTEM_PROMPT = """\
You are the layout-planning layer of a conceptual house-design tool. You \
are given a room program and the owner's stated priorities. You do not \
compute any coordinates or sizes — a separate deterministic packer handles \
that. Your job has three parts:

1. Group every room into exactly one of three fixed categories \
(category_a, category_b, category_c), based on whatever the owner's \
priorities suggest matters most — e.g. privacy level (private / shared / \
service), or function (rest / gather / support). Pick ONE grouping \
principle and apply it consistently to every room; name it in \
`grouping_label` (e.g. "Grouped by privacy level") and give each category \
a short plain-language label in `category_labels` (e.g. "Private", \
"Shared", "Service").
2. Propose a `placement_order`: the list of every room's exact `name` (as \
given), ordered so that rooms which should end up spatially near each \
other are adjacent in the list — the packer places rooms left-to-right, \
wrapping row by row, in exactly this order, so this list IS how you \
express adjacency. Typical logic: cluster private/rest rooms together and \
away from the entry; put shared/gather rooms near the entry and near each \
other; put service rooms and hallways where they can connect zones. Do \
not include a room more than once even if its count > 1 — the packer \
expands counted rooms on its own.
3. List the pairings that actually matter in `adjacencies`. Each entry \
names two rooms by their exact `name` and says whether they should end up \
"near" each other or "apart", and whether that is "strong" (the plan is \
wrong without it) or "mild" (better with it). This is where a real \
requirement belongs — `placement_order` can only hint at one by putting \
two names side by side, and cannot express keeping rooms apart at all. \
Draw them from what the owner said and from ordinary domestic sense: \
kitchen near dining, kitchen near the entry when they ask for it, \
bedrooms apart from the garage and from living spaces, a bathroom near \
the bedrooms it serves, laundry near the service zone. Only list pairings \
you would defend — six to ten is plenty for a house, and an empty list is \
better than an invented one. Do not pair a room with itself, and do not \
repeat a pair.
4. Write a 1-3 sentence `rationale` in plain language explaining the \
grouping and adjacency choices, referencing the owner's stated priorities \
where relevant. Do not mention coordinates, exact positions, or numeric \
dimensions.
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
        system=cached_system(SYSTEM_PROMPT),
        output_config={"effort": EFFORT},
        messages=[{"role": "user", "content": user_content}],
        output_format=LayoutPlan,
    )
    return response.parsed_output
