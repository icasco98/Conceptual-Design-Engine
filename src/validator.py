"""Station 07: hard constraints. A plan that fails one is not a worse
plan; it is not a plan.

Five things are checked, and each is a test the sheet names rather than a
preference:

  geometry     every space inside the buildable envelope, nothing overlapping
  access       every room reachable from the entry without passing through a
               bedroom, bathroom or garage (src/access.py)
  adjacency    every "must" pair shares a wall; no "apart" pair does
  depth        the justified plan graph, rooted at the entry: private rooms
               sit deeper on average than public ones. Depth is privacy --
               computed, not declared.
  circulation  hall area as a share of everything built, inside the band

On the circulation ceiling: the sheet's target for a house is 5-10% of
gross floor area and the scorer (src/scoring.py) steers toward exactly
that band. The hard ceiling here is a little above it, because a hall at
code width beside rooms at their typical sizes lands at 9-12% for an
ordinary program, and refusing every such plan would leave the owner with
nothing to look at. Past the ceiling the plan is genuinely wasting floor.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence

from src.access import find_access_problems, rects_touch
from src.circulation import justified_depths, plan_nodes, rects_overlap
from src.geometry import BuildableEnvelope
from src.zoning import ZoningPlan
from src.zoning_spec import Requirement, apart_pairs, must_pairs

CIRCULATION_TARGET_LOW = 0.05
CIRCULATION_TARGET_HIGH = 0.10
CIRCULATION_HARD_MAX = 0.13

# IRC R304: a habitable room is at least 70 sq ft and 7 ft in its least
# dimension. Converted to metres and applied to the rooms people live in.
HABITABLE_MIN_AREA_M2 = 6.5
HABITABLE_MIN_DIMENSION_M = 2.13
HABITABLE_TYPES = ("living_room", "family_room", "dining_room", "kitchen", "bedroom_primary", "bedroom", "office")

_EPS = 1e-6


@dataclass(frozen=True)
class ValidationReport:
    failures: List[str] = field(default_factory=list)
    circulation_ratio: float = 0.0
    public_depth: Optional[float] = None
    private_depth: Optional[float] = None
    depths: Dict[str, Optional[int]] = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return not self.failures


def _mean(values: Sequence[float]) -> Optional[float]:
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def validate_plan(
    plan: ZoningPlan, requirements: Sequence[Requirement], envelope: BuildableEnvelope
) -> ValidationReport:
    result = plan.result
    failures: List[str] = []
    by_name = {r.name: r for r in result.rooms}

    # Geometry.
    env = (
        envelope.left_setback_m,
        envelope.back_setback_m,
        envelope.left_setback_m + envelope.width_m,
        envelope.back_setback_m + envelope.depth_m,
    )
    spaces = [(r.name, r.rect) for r in result.rooms] + [
        (f"Hallway {i}", c.rect) for i, c in enumerate(result.corridors, start=1)
    ]
    for name, rect in spaces:
        if rect[0] < env[0] - 1e-3 or rect[1] < env[1] - 1e-3 or rect[2] > env[2] + 1e-3 or rect[3] > env[3] + 1e-3:
            failures.append(f"{name} crosses the setback line.")
    for i in range(len(spaces)):
        for j in range(i + 1, len(spaces)):
            if rects_overlap(spaces[i][1], spaces[j][1]):
                failures.append(f"{spaces[i][0]} and {spaces[j][0]} overlap.")

    for room in result.rooms:
        w, d = room.width_m, room.depth_m
        if (w < room.min_width_m - 1e-3 or d < room.min_depth_m - 1e-3) and (
            d < room.min_width_m - 1e-3 or w < room.min_depth_m - 1e-3
        ):
            failures.append(f"{room.name} has been squeezed below its minimum size.")
        if room.room_type in HABITABLE_TYPES:
            if room.area_m2 < HABITABLE_MIN_AREA_M2 - 1e-3 or min(w, d) < HABITABLE_MIN_DIMENSION_M - 1e-3:
                failures.append(f"{room.name} is smaller than a habitable room is allowed to be.")

    # Access.
    nodes = plan_nodes(result.rooms, result.corridors)
    for problem in find_access_problems(nodes):
        failures.append(problem.message)

    # Adjacency.
    for a, b in must_pairs(requirements):
        if a in by_name and b in by_name and not rects_touch(by_name[a].rect, by_name[b].rect):
            failures.append(f"{a} and {b} were required to share a wall and don't.")
    for a, b in apart_pairs(requirements):
        if a in by_name and b in by_name and rects_touch(by_name[a].rect, by_name[b].rect):
            failures.append(f"{a} and {b} were to be kept apart and share a wall.")

    # Depth.
    depths = justified_depths(nodes)
    public_depth = _mean([depths[r.name] for r in result.rooms if r.zone == "public" and not r.is_entry])
    private_depth = _mean([depths[r.name] for r in result.rooms if r.zone == "private"])
    if public_depth is not None and private_depth is not None and private_depth <= public_depth + _EPS:
        failures.append(
            "The private rooms sit no deeper from the front door than the shared ones, so the plan "
            "has no privacy gradient."
        )

    # Circulation.
    ratio = result.circulation_ratio
    if ratio > CIRCULATION_HARD_MAX + _EPS:
        failures.append(
            f"Hallway takes {ratio:.0%} of the floor area; more than {CIRCULATION_HARD_MAX:.0%} is wasted plan."
        )

    return ValidationReport(
        failures=failures,
        circulation_ratio=ratio,
        public_depth=public_depth,
        private_depth=private_depth,
        depths=depths,
    )
