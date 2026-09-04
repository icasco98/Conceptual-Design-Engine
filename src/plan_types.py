"""The shapes a finished zoning plan is made of.

Every stage downstream of the packer -- validation, scoring, the interactive
canvas -- reads these and nothing else. They are plain site-frame rectangles
in metres: `x_m`/`y_m` is the bottom-left corner, x runs left to right across
the site and y runs from the back edge (0) toward the front/street edge
(site depth), which is the orientation the canvas draws front-at-top.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Tuple

Point = Tuple[float, float]
Rect = Tuple[float, float, float, float]  # x0, y0, x1, y1


@dataclass(frozen=True)
class PlacedRoom:
    name: str
    base_name: str
    room_type: str
    is_entry: bool
    # public | private | service -- the zone the room was placed in, which
    # is also its colour on the diagram (src/palette.py).
    zone: str
    x_m: float
    y_m: float
    width_m: float
    depth_m: float
    # The room type's real minimum plan size (src/defaults.py), carried
    # through so the canvas never lets a room be dragged smaller than it.
    min_width_m: float
    min_depth_m: float

    @property
    def rect(self) -> Rect:
        return (self.x_m, self.y_m, self.x_m + self.width_m, self.y_m + self.depth_m)

    @property
    def center(self) -> Point:
        return (self.x_m + self.width_m / 2, self.y_m + self.depth_m / 2)

    @property
    def area_m2(self) -> float:
        return self.width_m * self.depth_m


@dataclass(frozen=True)
class CorridorSegment:
    x_m: float
    y_m: float
    width_m: float
    depth_m: float
    # A corridor's minimum on both axes is the code hallway width itself.
    min_width_m: float
    min_depth_m: float

    @property
    def rect(self) -> Rect:
        return (self.x_m, self.y_m, self.x_m + self.width_m, self.y_m + self.depth_m)

    @property
    def center(self) -> Point:
        return (self.x_m + self.width_m / 2, self.y_m + self.depth_m / 2)

    @property
    def area_m2(self) -> float:
        return self.width_m * self.depth_m


@dataclass(frozen=True)
class LayoutResult:
    rooms: List[PlacedRoom]
    corridors: List[CorridorSegment]
    # (from_point, to_point) pairs, one short arrow per door on the
    # circulation tree walked out from the entry.
    circulation_edges: List[Tuple[Point, Point]]
    # Ordered polygon vertices tracing the building's own exterior wall
    # line -- the union of every room and corridor.
    footprint: List[Point]

    @property
    def built_area_m2(self) -> float:
        return sum(r.area_m2 for r in self.rooms) + sum(c.area_m2 for c in self.corridors)

    @property
    def corridor_area_m2(self) -> float:
        return sum(c.area_m2 for c in self.corridors)

    @property
    def circulation_ratio(self) -> float:
        """Corridor area as a share of everything built."""
        built = self.built_area_m2
        return self.corridor_area_m2 / built if built > 0 else 0.0
