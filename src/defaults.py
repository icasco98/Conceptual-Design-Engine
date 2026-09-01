"""Recommended room sizes used as a starting point for negotiation.

These are conceptual-design defaults, not building code minimums, except
where the project brief specifies a code fact directly:
  - bathroom minimum 1.5m x 1.75m
  - hallway width 1.2m (fixed, enforced in src.validation)

Widths/depths are the room's plan dimensions in meters, sized to keep
realistic real-world proportions. "min" is the smallest workable size for
conceptual purposes; "typical" is what a comfortable version looks like and
is what gets used when the owner hasn't stated a size. Always confirm
against local code during detailed design — this tool covers conceptual
design only.
"""

from __future__ import annotations

from typing import NamedTuple


class RoomSizeDefault(NamedTuple):
    label: str
    min_width_m: float
    min_depth_m: float
    typical_width_m: float
    typical_depth_m: float


ROOM_DEFAULTS: dict[str, RoomSizeDefault] = {
    "entry": RoomSizeDefault("Entry / Foyer", 1.2, 1.2, 1.8, 1.8),
    "hallway": RoomSizeDefault("Hallway", 1.2, 2.0, 1.2, 3.0),
    "living_room": RoomSizeDefault("Living Room", 3.5, 4.0, 4.5, 5.5),
    "family_room": RoomSizeDefault("Family Room", 3.3, 3.6, 4.2, 4.8),
    "dining_room": RoomSizeDefault("Dining Room", 3.0, 3.3, 3.6, 4.2),
    "kitchen": RoomSizeDefault("Kitchen", 2.7, 3.0, 3.6, 4.2),
    "bedroom_primary": RoomSizeDefault("Primary Bedroom", 3.3, 3.6, 4.0, 4.5),
    "bedroom": RoomSizeDefault("Bedroom", 2.7, 3.0, 3.3, 3.6),
    "bathroom": RoomSizeDefault("Bathroom", 1.5, 1.75, 1.8, 2.4),
    "half_bath": RoomSizeDefault("Half Bath / Powder Room", 0.9, 1.5, 1.1, 1.6),
    "office": RoomSizeDefault("Office / Study", 2.4, 2.7, 3.0, 3.3),
    "laundry": RoomSizeDefault("Laundry", 1.5, 1.8, 1.8, 2.4),
    "garage_single": RoomSizeDefault("Single Garage", 3.0, 6.0, 3.6, 6.5),
    "garage_double": RoomSizeDefault("Double Garage", 5.5, 6.0, 6.0, 6.5),
    "closet": RoomSizeDefault("Closet", 0.9, 0.6, 1.5, 0.6),
    "storage": RoomSizeDefault("Storage", 1.5, 1.5, 2.0, 2.0),
    "mudroom": RoomSizeDefault("Mudroom", 1.5, 1.8, 1.8, 2.1),
    "other": RoomSizeDefault("Room", 2.0, 2.0, 3.0, 3.0),
}


class RoomFootprint(NamedTuple):
    width_m: float
    depth_m: float
    min_width_m: float
    min_depth_m: float


def resolve_footprint(
    room_type: str,
    explicit_width_m: float | None,
    explicit_depth_m: float | None,
) -> RoomFootprint:
    """Fill in a room's plan dimensions.

    Explicit owner-stated sizes always win. Otherwise fall back to the
    typical default for the room type. This is deterministic — the LLM
    never invents the numbers used for geometry.
    """
    default = ROOM_DEFAULTS.get(room_type, ROOM_DEFAULTS["other"])
    width = explicit_width_m if explicit_width_m is not None else default.typical_width_m
    depth = explicit_depth_m if explicit_depth_m is not None else default.typical_depth_m
    return RoomFootprint(width, depth, default.min_width_m, default.min_depth_m)
