"""Domain dataclasses -> JSON-friendly dicts, and back.

`src.layout` builds frozen dataclasses. The frontend wants plain JSON. The
shapes here are the wire contract for the canvas: a box is a name, a
type, a level and a rectangle in site-frame meters, and a building is a
list of levels each holding boxes, corridors, a footprint and door arrows.
The reverse direction (`building_from_arrangement`) is how the owner's
hand-dragged arrangement comes back for checking.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from src.access import AccessProblem
from src.defaults import resolve_footprint
from src.layout import CorridorSegment, LayoutResult, MultiLevelLayout, PlacedRoom
from src.models import Project
from src.validation import Issue


class BoxOut(BaseModel):
    name: str
    base_name: str
    room_type: str
    is_entry: bool
    level: int
    x_m: float
    y_m: float
    width_m: float
    depth_m: float
    min_width_m: float
    min_depth_m: float


class CorridorOut(BaseModel):
    x_m: float
    y_m: float
    width_m: float
    depth_m: float
    min_width_m: float
    min_depth_m: float


class LevelOut(BaseModel):
    level: int
    rooms: list[BoxOut]
    corridors: list[CorridorOut]
    footprint: list[tuple[float, float]]
    circulation_edges: list[tuple[tuple[float, float], tuple[float, float]]]


class BuildingOut(BaseModel):
    levels: list[LevelOut]


class IssueOut(BaseModel):
    severity: str
    code: str
    message: str


class AccessProblemOut(BaseModel):
    room_name: str
    kind: str
    via: list[str]
    message: str


def level_out(result: LayoutResult) -> LevelOut:
    return LevelOut(
        level=result.level,
        rooms=[BoxOut(**vars(room)) for room in result.rooms],
        corridors=[CorridorOut(**vars(c)) for c in result.corridors],
        footprint=[tuple(p) for p in result.footprint],
        circulation_edges=[(tuple(a), tuple(b)) for a, b in result.circulation_edges],
    )


def building_out(building: MultiLevelLayout) -> BuildingOut:
    return BuildingOut(levels=[level_out(level) for level in building.levels])


def issue_out(issue: Issue) -> IssueOut:
    return IssueOut(severity=issue.severity, code=issue.code, message=issue.message)


def access_problem_out(problem: AccessProblem) -> AccessProblemOut:
    return AccessProblemOut(
        room_name=problem.room_name, kind=problem.kind, via=list(problem.via), message=problem.message
    )


# ---- the other direction: the owner's arrangement coming back ----


class BoxIn(BaseModel):
    """A box as the canvas holds it. Rotation is carried for the 3D view
    and the round trip; the checks use the axis-aligned rectangle."""

    name: str
    room_type: str
    level: int = 0
    x_m: float
    y_m: float
    width_m: float
    depth_m: float
    is_entry: bool = False
    rotation_deg: float = 0.0
    deleted: bool = False


class CorridorIn(BaseModel):
    level: int = 0
    x_m: float
    y_m: float
    width_m: float
    depth_m: float
    rotation_deg: float = 0.0
    deleted: bool = False


class ArrangementIn(BaseModel):
    """Everything on the canvas, every level. The stair appears once per
    level it is on, with the same rectangle on each."""

    boxes: list[BoxIn] = Field(default_factory=list)
    corridors: list[CorridorIn] = Field(default_factory=list)


def building_from_arrangement(project: Project, arrangement: ArrangementIn) -> MultiLevelLayout:
    """Rebuild a `MultiLevelLayout` from the canvas so the same access and
    stacking checks run on a hand-made plan as on a packed one. Footprints
    and door arrows are left empty: the checks don't read them, and the
    canvas computes its own."""
    levels: list[LayoutResult] = []
    for level in range(project.storeys):
        rooms: list[PlacedRoom] = []
        for b in arrangement.boxes:
            if b.deleted or b.level != level:
                continue
            fp = resolve_footprint(b.room_type, None, None)
            rooms.append(PlacedRoom(
                name=b.name, base_name=b.name, room_type=b.room_type, is_entry=b.is_entry,
                x_m=b.x_m, y_m=b.y_m, width_m=b.width_m, depth_m=b.depth_m,
                min_width_m=fp.min_width_m, min_depth_m=fp.min_depth_m, level=level,
            ))
        corridors = [
            CorridorSegment(
                x_m=c.x_m, y_m=c.y_m, width_m=c.width_m, depth_m=c.depth_m,
                min_width_m=project.hallway_width_m, min_depth_m=project.hallway_width_m,
            )
            for c in arrangement.corridors
            if not c.deleted and c.level == level
        ]
        levels.append(LayoutResult(rooms=rooms, corridors=corridors, circulation_edges=[], footprint=[], level=level))
    return MultiLevelLayout(levels=levels)
