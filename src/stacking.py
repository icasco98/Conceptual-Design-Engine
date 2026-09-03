"""What one storey asks of the storey below it.

A single-storey plan is judged on its own. Stack a second level on top and
two more questions appear, both answered here in plain geometry:

  WET ROOMS SHOULD STACK. Bathrooms, kitchens and laundries carry the
  pipework. A bathroom sitting above the kitchen shares its drops; one
  above the living room needs its own run through the ceiling. Exact
  alignment isn't required -- any overlap in plan means the services can
  meet -- so this is measured as the share of an upper wet room's area
  that sits over *some* wet room below, scored rather than enforced.

  UPPER FLOORS NEED SOMETHING UNDER THEM. Each level is packed to its own
  footprint, so an upper room can hang past the outline of the level
  below. A little is a cantilever; a lot is a room in mid-air. Measured as
  the share of the room outside the lower footprint, warned about past a
  tolerance.

Both use shapely for the polygon arithmetic. `src.layout.MultiLevelLayout`
is the input; results are `src.validation.Issue`s for the owner and a
penalty for `src.planner` to weigh against everything else.
"""

from __future__ import annotations

from dataclasses import dataclass

from shapely.geometry import Polygon, box
from shapely.ops import unary_union

from src.access import is_wet
from src.layout import LayoutResult, MultiLevelLayout, PlacedRoom
from src.validation import Issue

# How far past the level below an upper room may hang before it's flagged,
# as a share of that room's own area. A quarter of a bedroom on brackets
# is a design move; more than that is a structural question.
CANTILEVER_TOLERANCE = 0.25


def _rect(room: PlacedRoom) -> Polygon:
    return box(room.x_m, room.y_m, room.x_m + room.width_m, room.y_m + room.depth_m)


def _footprint_polygon(result: LayoutResult) -> Polygon:
    """The level's outline as a polygon. Falls back to the union of its
    boxes when the traced outline is degenerate (fewer than three points)."""
    if len(result.footprint) >= 3:
        polygon = Polygon(result.footprint)
        if polygon.is_valid and polygon.area > 0:
            return polygon
    pieces = [_rect(room) for room in result.rooms]
    pieces += [box(c.x_m, c.y_m, c.x_m + c.width_m, c.y_m + c.depth_m) for c in result.corridors]
    return unary_union(pieces) if pieces else Polygon()


@dataclass(frozen=True)
class StackingReport:
    # Per upper wet room: share of its area over a wet room below (0..1).
    wet_overlap: dict[str, float]
    # Per upper room: share of its area hanging past the level below (0..1).
    overhang: dict[str, float]

    @property
    def penalty(self) -> float:
        """Lower is better. Unstacked wet rooms and overhangs both cost,
        each in proportion to how far off they are."""
        wet = sum(1.0 - share for share in self.wet_overlap.values())
        hang = sum(share for share in self.overhang.values())
        return wet + hang

    def issues(self) -> list[Issue]:
        out: list[Issue] = []
        for name, share in self.wet_overlap.items():
            if share <= 1e-9:
                out.append(Issue(
                    "warning", "wet_room_not_stacked",
                    f"{name} doesn't sit above any bathroom, kitchen or laundry, so its "
                    f"plumbing needs its own run down through the floor below.",
                ))
        for name, share in self.overhang.items():
            if share > CANTILEVER_TOLERANCE:
                out.append(Issue(
                    "warning", "cantilever",
                    f"{int(share * 100)}% of {name} hangs past the floor below it.",
                ))
        return out


def stacking_report(layout: MultiLevelLayout) -> StackingReport:
    wet_overlap: dict[str, float] = {}
    overhang: dict[str, float] = {}
    for upper in layout.levels[1:]:
        below = layout.levels[upper.level - 1]
        below_footprint = _footprint_polygon(below)
        wet_below = unary_union([_rect(r) for r in below.rooms if is_wet(r.room_type)] or [Polygon()])
        for room in upper.rooms:
            if room.room_type == "stair":
                continue  # one rectangle on every level; it stacks by construction
            shape = _rect(room)
            if shape.area <= 0:
                continue
            if is_wet(room.room_type):
                wet_overlap[room.name] = shape.intersection(wet_below).area / shape.area
            overhang[room.name] = 1.0 - shape.intersection(below_footprint).area / shape.area
    return StackingReport(wet_overlap=wet_overlap, overhang=overhang)


def stacking_issues(layout: MultiLevelLayout) -> list[Issue]:
    return stacking_report(layout).issues()
