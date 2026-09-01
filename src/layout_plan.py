"""Claude's role in Phase 1 step 3: propose color categories and an
adjacency-aware placement order for the room program.

Claude never touches coordinates or sizes — it only decides which of three
fixed categories each room belongs to (src.palette owns the actual colors)
and a room ordering that expresses "these should end up near each other."
src.layout turns that ordering into an actual non-overlapping arrangement.
"""

from __future__ import annotations

import json
from typing import List, Literal

from pydantic import BaseModel

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
    placement_order: List[str]
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
3. Write a 1-3 sentence `rationale` in plain language explaining the \
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
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_content}],
        output_format=LayoutPlan,
    )
    return response.parsed_output
