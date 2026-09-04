"""Claude's one job past intake: state the problem.

Station 03 (zones) and station 04 (the adjacency matrix) are judgement --
four rule families decide which zone a room belongs to and they conflict,
which is why it is not a lookup. Claude is given the room program, the
owner's priorities in their own words, and what the site analysis found,
and writes the `ZoningSpec` that crosses the seam. It never sees a
coordinate and never computes a size; the packer, validator and scorer in
src/zoning.py, src/validator.py and src/scoring.py do the rest.

The rule-based default (src/zoning_spec.default_spec) is shown to Claude as
the starting point so it revises what the owner's words change, rather than
inventing the whole matrix from scratch each time.
"""

from __future__ import annotations

import json
from typing import Optional

from src.claude_client import MODEL, get_client
from src.models import Project
from src.site_analysis import SiteAnalysis
from src.zoning_spec import ZoningSpec, default_spec

SYSTEM_PROMPT = """\
You are the zoning layer of a conceptual house-design tool: the last step \
of programming and the first step of design. You are given a room program, \
the owner's stated priorities, what a site analysis found, and a default \
zoning worked out from room types alone. You do not compute coordinates or \
sizes -- a deterministic packer, validator and scorer handle everything \
after you. Your output is a specification with three parts:

1. `assignments`: every room's zone -- "public" (guests welcome; shallow \
from the entry; takes the good orientation), "private" (family only; deep \
from the entry; never a route to anywhere else), or "service" (supports the \
other two; clusters, absorbs the poor aspect, buffers the street). Start \
from the default and move a room only when the owner's words justify it \
-- a home office that receives clients is public; a family room the owner \
calls a retreat is private. Every room in the program gets exactly one zone.

2. `adjacencies`: pairs of rooms with a strength. "must" means the two \
rooms share a wall and is a hard constraint, so use it sparingly -- for \
what the house is wrong without (kitchen and dining, a primary bedroom and \
its bathroom, a mudroom and the garage). "should" means near each other \
and is scored, not enforced; it is the ordinary planning preference. \
"apart" means the two must not share a wall and is also hard. Rooms along a \
hall can share a wall with at most two others, and no three rooms can all \
touch each other, so keep "must" to chains, never rings or stars. Use the \
exact room names as given. Revise the default list in light of the \
owner's priorities; keep what they don't contradict.

3. `rationale`: two or three plain sentences on the zoning and adjacency \
choices, referencing the owner's priorities and the site where relevant. \
No coordinates, no numeric dimensions.
"""


def propose_zoning(project: Project, site: SiteAnalysis) -> ZoningSpec:
    """Ask Claude for the zoning specification. Raises on API failure; the
    caller falls back to the rule-based default."""
    base = default_spec(project)
    rooms = [
        {
            "name": room.name,
            "room_type": room.room_type,
            "count": room.count,
            "is_entry": room.is_entry,
            "priority_notes": room.priority_notes,
        }
        for room in project.rooms
        if room.room_type != "hallway"
    ]
    user_content = (
        f"Room program:\n{json.dumps(rooms, indent=2)}\n\n"
        f"Owner's stated priorities: {', '.join(project.priorities) or 'none stated'}\n\n"
        f"Site analysis:\n- " + "\n- ".join(site.notes) + "\n\n"
        f"Default zoning from room types alone (revise, don't start over):\n"
        f"{json.dumps(base.model_dump(mode='json'), indent=2)}"
    )
    response = get_client().messages.parse(
        model=MODEL,
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_content}],
        output_format=ZoningSpec,
    )
    return response.parsed_output


def try_propose_zoning(project: Project, site: SiteAnalysis) -> Optional[ZoningSpec]:
    """`propose_zoning`, returning None instead of raising."""
    try:
        return propose_zoning(project, site)
    except Exception:  # noqa: BLE001 - the default spec stands in
        return None
