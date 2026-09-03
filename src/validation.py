"""Deterministic constraint checks over a room program and buildable envelope.

Every issue here is plain, checkable arithmetic — no LLM involved. The
API hands the resulting Issue list to src.claude_client to be turned into
plain-language explanation for the owner.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from src.defaults import resolve_footprint
from src.geometry import BuildableEnvelope
from src.models import Project, Room

Severity = Literal["error", "warning"]


@dataclass(frozen=True)
class Issue:
    severity: Severity
    code: str
    message: str


def _room_footprints(rooms: list[Room]):
    for room in rooms:
        footprint = resolve_footprint(room.room_type, room.explicit_width_m, room.explicit_depth_m)
        yield room, footprint


def validate_room_program(project: Project, envelope: BuildableEnvelope | None) -> list[Issue]:
    issues: list[Issue] = []

    if envelope is None:
        return issues

    if not envelope.is_valid:
        issues.append(
            Issue(
                "error",
                "envelope_invalid",
                f"Setbacks leave no buildable area: {envelope.width_m:.1f}m x "
                f"{envelope.depth_m:.1f}m after insets.",
            )
        )
        return issues

    total_min_area = 0.0
    min_area_by_level: dict[int, float] = {}
    for room, footprint in _room_footprints(project.rooms):
        for level in room.levels:
            min_area_by_level[level] = (
                min_area_by_level.get(level, 0.0)
                + footprint.min_width_m * footprint.min_depth_m * room.count
            )
        if footprint.width_m < footprint.min_width_m or footprint.depth_m < footprint.min_depth_m:
            issues.append(
                Issue(
                    "warning",
                    "room_below_minimum",
                    f"{room.name}: {footprint.width_m:.2f}m x {footprint.depth_m:.2f}m is "
                    f"below the recommended minimum of {footprint.min_width_m:.2f}m x "
                    f"{footprint.min_depth_m:.2f}m.",
                )
            )
        total_min_area += footprint.min_width_m * footprint.min_depth_m * room.count

        if room.room_type == "hallway" and footprint.width_m != project.hallway_width_m:
            issues.append(
                Issue(
                    "warning",
                    "hallway_width_mismatch",
                    f"{room.name} is {footprint.width_m:.2f}m wide; hallways are fixed at "
                    f"{project.hallway_width_m:.2f}m for code compliance.",
                )
            )

    if project.storeys == 1 and total_min_area > envelope.area_m2:
        issues.append(
            Issue(
                "error",
                "area_exceeds_envelope",
                f"The room program needs at least {total_min_area:.1f} m² at minimum sizes, "
                f"but the buildable envelope is only {envelope.area_m2:.1f} m².",
            )
        )
    if project.storeys > 1:
        for level, area in sorted(min_area_by_level.items()):
            if area > envelope.area_m2:
                issues.append(
                    Issue(
                        "error",
                        "level_area_exceeds_envelope",
                        f"Level {level} needs at least {area:.1f} m² at minimum sizes, but the "
                        f"buildable envelope is only {envelope.area_m2:.1f} m² per storey.",
                    )
                )

    stairs = [room for room in project.rooms if room.room_type == "stair"]
    if project.storeys > 1 and not stairs:
        issues.append(
            Issue(
                "error",
                "no_stair",
                f"A {project.storeys}-storey house needs a stair, and none is in the program yet.",
            )
        )
    for stair in stairs:
        connected = set(stair.levels)
        wanted = set(range(project.storeys))
        if project.storeys > 1 and not wanted <= connected:
            missing = ", ".join(str(level) for level in sorted(wanted - connected))
            issues.append(
                Issue(
                    "warning",
                    "stair_misses_level",
                    f"{stair.name} doesn't reach level {missing}; a stair should connect every storey.",
                )
            )
    for room in project.rooms:
        too_high = [level for level in room.levels if level >= project.storeys]
        if too_high:
            issues.append(
                Issue(
                    "warning",
                    "room_above_top_storey",
                    f"{room.name} is placed on level {too_high[0]}, but the house has "
                    f"{project.storeys} storey{'s' if project.storeys != 1 else ''} (levels 0–{project.storeys - 1}).",
                )
            )

    street_edges = [e for e in project.site.edges if e.adjacency == "street"]
    if project.site.is_complete() and not street_edges:
        issues.append(
            Issue(
                "warning",
                "no_street_edge",
                "No site edge is tagged street-facing, so an entry location can't be judged yet.",
            )
        )

    has_entry = any(room.is_entry for room in project.rooms)
    if project.rooms and not has_entry:
        issues.append(
            Issue(
                "warning",
                "no_entry_marked",
                "No room is marked as a building entry point yet.",
            )
        )

    return issues
