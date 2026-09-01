"""Deterministic room packing into the buildable envelope — no LLM math.

Claude's job (src/layout_plan.py) is limited to grouping rooms into color
categories and suggesting a placement order that expresses adjacency
(rooms that should end up near each other are listed near each other).
This module does the actual arithmetic: a simple shelf-packing layout that
places rooms left-to-right, wrapping into a new row when a row is full,
scaling everything down uniformly (so relative proportions stay correct)
if the room program doesn't fit at full size.

Known limitation: a single room wider than the whole envelope isn't
special-cased — it will visually overflow rather than being force-fit.
That's rare for realistic house programs and, more importantly, the
project's own room-vs-envelope area check (src/validation.py) already
warns the owner before it gets to this stage.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

from src.defaults import resolve_footprint
from src.geometry import BuildableEnvelope
from src.models import Project, Room


@dataclass(frozen=True)
class PlacedRoom:
    name: str
    base_name: str
    room_type: str
    is_entry: bool
    x_m: float
    y_m: float
    width_m: float
    depth_m: float


def _expand_rooms(rooms: List[Room], order: List[str]) -> List[tuple[Room, str]]:
    """Expand Room.count>1 into individual instances, each paired with its
    base name (for matching placement_order/category lookups), then sort by
    `order`. Instances of the same base room stay adjacent (Python's sort
    is stable, so their original relative order is preserved)."""
    expanded: List[tuple[Room, str]] = []
    for room in rooms:
        if room.count <= 1:
            expanded.append((room, room.name))
        else:
            for i in range(room.count):
                instance = room.model_copy(update={"name": f"{room.name} {i + 1}"})
                expanded.append((instance, room.name))

    if not order:
        return expanded

    position = {name: i for i, name in enumerate(order)}
    return sorted(expanded, key=lambda pair: position.get(pair[1], len(order)))


def pack_rooms(
    project: Project,
    envelope: BuildableEnvelope,
    placement_order: Optional[List[str]] = None,
) -> List[PlacedRoom]:
    expanded = _expand_rooms(project.rooms, placement_order or [])
    footprints = [
        (room, base_name, resolve_footprint(room.room_type, room.explicit_width_m, room.explicit_depth_m))
        for room, base_name in expanded
    ]

    def shelf_layout(scale: float):
        placed = []
        x = y = row_height = 0.0
        for room, base_name, fp in footprints:
            w, d = fp.width_m * scale, fp.depth_m * scale
            if x > 0 and x + w > envelope.width_m + 1e-9:
                x = 0.0
                y += row_height
                row_height = 0.0
            placed.append((room, base_name, x, y, w, d))
            x += w
            row_height = max(row_height, d)
        return placed, y + row_height

    placed, total_height = shelf_layout(1.0)
    if total_height > envelope.depth_m > 0:
        placed, _ = shelf_layout(envelope.depth_m / total_height)

    return [
        PlacedRoom(
            name=room.name,
            base_name=base_name,
            room_type=room.room_type,
            is_entry=room.is_entry,
            x_m=envelope.left_setback_m + x,
            y_m=envelope.back_setback_m + y,
            width_m=w,
            depth_m=d,
        )
        for room, base_name, x, y, w, d in placed
    ]
