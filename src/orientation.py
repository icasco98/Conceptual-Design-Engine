"""Which way a room faces, and whether that is what was asked for.

`site.rotation_deg` has been recorded since the beginning and read by
nothing, and `project.priorities` — the owner's own words about what
matters — reached the planner and were used only to pick colour category
names. So "morning light in the kitchen" was captured, stored, shown back
on screen, and had no effect whatever on where the kitchen went.

The split is the same one the rest of the tool keeps. Claude reads the
sentence and says what the room wants in terms a person would recognise —
morning sun, evening sun, off the street. This module turns that into a
direction on the plan, using the site's bearing, and measures how well an
arrangement delivers it. No compass arithmetic is done by the model and no
interpretation of English is done here.

Deliberately hemisphere-neutral: the sun rises in the east and sets in the
west everywhere, so morning and evening light are safe to score. Whether a
living room wants to face north or south depends on which half of the
planet the house is on, which nothing in this project currently knows, so
that is not scored rather than guessed.
"""

from __future__ import annotations

import math

from src.layout import LayoutResult
from src.models import Site

# Compass bearings, clockwise from true north.
EAST = 90.0
WEST = 270.0


def direction_for(rotation_deg: float | None, bearing: float) -> tuple[float, float]:
    """A unit vector in plan coordinates pointing along a compass bearing.

    The site's own frame has +y running from the back boundary toward the
    front edge, and `rotation_deg` is the bearing that front edge faces. So
    +y is `rotation_deg`, and turning clockwise from there increases the
    bearing: at rotation 0 the front faces north, +x points east, and a
    room wanting morning sun wants to be as far along +x as it can get.
    """
    theta = math.radians(bearing - (rotation_deg or 0.0))
    return math.sin(theta), math.cos(theta)


def street_directions(site: Site) -> list[tuple[float, float]]:
    """Outward unit vectors, in plan coordinates, for every street edge."""
    outward = {"front": (0.0, 1.0), "back": (0.0, -1.0), "right": (1.0, 0.0), "left": (-1.0, 0.0)}
    return [outward[e.position] for e in site.edges if e.adjacency == "street" and e.position in outward]


def _spread(result: LayoutResult, direction: tuple[float, float]) -> tuple[float, float]:
    """How far the plan reaches along a direction, from least to most."""
    dx, dy = direction
    positions = [
        (room.x_m + room.width_m / 2) * dx + (room.y_m + room.depth_m / 2) * dy for room in result.rooms
    ]
    if not positions:
        return 0.0, 0.0
    return min(positions), max(positions)


def aspect_penalty(result: LayoutResult, room_name: str, direction: tuple[float, float]) -> float:
    """0 when the room sits as far along `direction` as this plan allows,
    rising to 1 at the opposite end.

    Measured against the plan's own spread rather than the site's, because
    a wish is about this arrangement: asking a room to face east means "as
    east as the rooms you have let it be", not "at a particular coordinate".
    A plan with nothing to compare against scores zero — no information is
    not a fault.
    """
    room = next((r for r in result.rooms if room_name in (r.name, r.base_name)), None)
    if room is None:
        return 0.0
    low, high = _spread(result, direction)
    if high - low <= 1e-9:
        return 0.0
    dx, dy = direction
    position = (room.x_m + room.width_m / 2) * dx + (room.y_m + room.depth_m / 2) * dy
    return 1.0 - (position - low) / (high - low)


def street_penalty(result: LayoutResult, room_name: str, site: Site) -> float:
    """0 when the room is as far from every street edge as the plan allows.

    A corner plot has two street edges, and a room asked to be off the
    street should be off both; the worst of them is what counts, because
    being tucked away from one road while sitting on another is not what
    anybody meant.
    """
    directions = street_directions(site)
    if not directions:
        return 0.0
    # Away from the street is the opposite of the street's outward normal.
    return max(aspect_penalty(result, room_name, (-dx, -dy)) for dx, dy in directions)
