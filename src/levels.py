"""Which storey each room goes on when the owner hasn't said.

The extraction layer records a level only when the owner places a room
("bedrooms upstairs"). A two-storey house described without that detail
arrives with everything on the ground floor, which packs to a bungalow
with an unused floor above. This module supplies the default split an
architect would sketch first -- sleeping upstairs, living downstairs --
and nothing more: it is a starting point the owner is expected to move
rooms away from, in the chat or on the canvas.

Deterministic, so the same program always opens on the same split.
"""

from __future__ import annotations

from src.models import Project, Room

# Room types that go up by default in a multi-storey house. Bathrooms go up
# with the bedrooms they serve -- but see `assign_default_levels`, which
# keeps one downstairs when there is no half bath to cover the ground
# floor.
UPSTAIRS_BY_DEFAULT = {"bedroom_primary", "bedroom", "bathroom", "closet"}


def owner_placed_any_level(project: Project) -> bool:
    return any(room.levels != [0] for room in project.rooms if room.room_type != "stair")


def assign_default_levels(project: Project) -> Project:
    """A copy of the project with upper levels filled in, or the project
    unchanged when it is single-storey or the owner already placed rooms.
    The stair is always set to connect every storey."""
    if project.storeys <= 1:
        return project

    rooms: list[Room] = []
    stair_levels = list(range(project.storeys))
    placed_by_owner = owner_placed_any_level(project)
    has_ground_wc = any(room.room_type == "half_bath" for room in project.rooms)
    bathrooms_seen = 0

    for room in project.rooms:
        if room.room_type == "stair":
            rooms.append(room.model_copy(update={"levels": stair_levels}))
            continue
        if placed_by_owner or room.room_type not in UPSTAIRS_BY_DEFAULT:
            rooms.append(room)
            continue
        if room.room_type == "bathroom" and not has_ground_wc:
            # First bathroom stays down to serve the living floor; the
            # rest go up with the bedrooms.
            bathrooms_seen += 1
            if bathrooms_seen == 1 and room.count == 1:
                rooms.append(room)
                continue
            if bathrooms_seen == 1 and room.count > 1:
                # Split into named singles so the two levels don't both
                # carry a room called, say, "Bathroom".
                for i in range(room.count):
                    rooms.append(room.model_copy(update={
                        "name": f"{room.name} {i + 1}", "count": 1, "levels": [0] if i == 0 else [1],
                    }))
                continue
        rooms.append(room.model_copy(update={"levels": [1]}))

    return project.model_copy(update={"rooms": rooms})
