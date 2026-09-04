"""Station 02: read the site before placing a single room.

Zoning is fixed by the site, not by the room list. This module reads the
four edges of the plot -- which face the street, which face neighbours, and
(when the owner has said which way the plot faces) which get sun -- and
turns that into a preference for where each zone belongs. The packer and
scorer consume the preferences; the sidebar shows the notes so the owner
can see what was decided and why.

All of it is plain arithmetic on the edge tags and one compass bearing. It
never guesses: with no bearing given, solar terms are simply zero and the
notes say so, rather than assuming the plot faces any particular way.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from src.models import EdgePosition, Project

EDGES: tuple = ("front", "back", "left", "right")
OPPOSITE: Dict[str, str] = {"front": "back", "back": "front", "left": "right", "right": "left"}
# Bearing offset of each edge's outward normal from the front edge's, going
# clockwise: standing on the front edge looking out, the right-hand edge
# faces 90 degrees clockwise of that.
_BEARING_OFFSET: Dict[str, float] = {"front": 0.0, "right": 90.0, "back": 180.0, "left": 270.0}

ZONES: tuple = ("public", "private", "service")


@dataclass(frozen=True)
class EdgeReading:
    position: str
    street: bool
    # Compass bearing the edge faces, degrees clockwise from north; None
    # when the plot's orientation is unknown.
    bearing_deg: Optional[float]
    # 0..1: how squarely the edge faces the equator (the sunny side).
    sun: float
    # 0..1: how squarely the edge faces east (morning light).
    morning: float


@dataclass(frozen=True)
class SiteAnalysis:
    edges: Dict[str, EdgeReading]
    # The edge the front door meets: the front if it is a street, else the
    # first street-facing edge, else the front regardless.
    entry_edge: str
    sun_edge: Optional[str]
    poor_edge: Optional[str]
    orientation_known: bool
    # preferences[zone][edge] in roughly -1..1: how much that zone wants an
    # outer wall on that edge. Read by src/scoring.py.
    preferences: Dict[str, Dict[str, float]]
    notes: List[str] = field(default_factory=list)

    @property
    def deep_edge(self) -> str:
        return OPPOSITE[self.entry_edge]

    def street_edges(self) -> List[str]:
        return [e for e in EDGES if self.edges[e].street]


def _cos_toward(bearing: float, target: float) -> float:
    return max(0.0, math.cos(math.radians(bearing - target)))


def analyse_site(project: Project) -> SiteAnalysis:
    site = project.site
    tagged = site.edges_by_position()
    rotation = site.rotation_deg
    known = rotation is not None
    equator = 180.0 if site.hemisphere == "north" else 0.0

    readings: Dict[str, EdgeReading] = {}
    for position in EDGES:
        edge = tagged.get(position)
        street = edge is not None and edge.adjacency == "street"
        bearing = (rotation + _BEARING_OFFSET[position]) % 360.0 if known else None
        sun = _cos_toward(bearing, equator) if known else 0.0
        morning = _cos_toward(bearing, 90.0) if known else 0.0
        readings[position] = EdgeReading(position, street, bearing, sun, morning)

    streets = [e for e in EDGES if readings[e].street]
    entry_edge = "front" if ("front" in streets or not streets) else streets[0]

    sun_edge = max(EDGES, key=lambda e: readings[e].sun) if known else None
    poor_edge = min(EDGES, key=lambda e: readings[e].sun) if known else None

    preferences: Dict[str, Dict[str, float]] = {zone: {} for zone in ZONES}
    for position in EDGES:
        r = readings[position]
        street = 1.0 if r.street else 0.0
        deep = 1.0 if position == OPPOSITE[entry_edge] else 0.0
        # Public rooms take the good orientation. Living beside the street
        # is ordinary, so the street is neither sought nor avoided.
        preferences["public"][position] = 1.0 * r.sun
        # Private rooms sit away from street noise and, given a choice,
        # face the morning.
        preferences["private"][position] = -1.0 * street + 0.6 * r.morning + 0.2 * deep
        # Service absorbs the poor aspect and buffers the street; the
        # garage in particular has to meet it.
        preferences["service"][position] = 0.6 * street + (0.5 * (1.0 - r.sun) if known else 0.0)

    notes: List[str] = []
    if len(streets) > 1:
        notes.append(
            "Corner lot: the street runs along the "
            + " and ".join(streets)
            + " edges, so two sides carry traffic noise."
        )
    elif streets:
        notes.append(f"The street is on the {entry_edge} edge; that is where the entry meets it.")
    else:
        notes.append("No edge is tagged street-facing; the entry is assumed on the front edge.")
    if known:
        notes.append(
            f"The plot faces {_compass_name(readings['front'].bearing_deg)}, so the "
            f"{sun_edge} edge gets the sun and the {poor_edge} edge gets the least."
        )
        notes.append(
            f"Living spaces are pulled toward the {sun_edge} edge where the plan allows; "
            f"service rooms absorb the {poor_edge} edge."
        )
    else:
        notes.append(
            "Which way the plot faces hasn't been described, so no edge is favoured for sun yet -- "
            "say which compass direction the street lies in and the zoning will use it."
        )
    notes.append(
        f"Private rooms are kept off the street edge and pushed toward the {OPPOSITE[entry_edge]}."
    )

    return SiteAnalysis(
        edges=readings,
        entry_edge=entry_edge,
        sun_edge=sun_edge,
        poor_edge=poor_edge,
        orientation_known=known,
        preferences=preferences,
        notes=notes,
    )


def _compass_name(bearing: Optional[float]) -> str:
    if bearing is None:
        return "an unknown direction"
    names = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]
    return names[int(((bearing % 360) + 22.5) // 45) % 8]
