"""Stations 03 and 04: the specification handed across the seam.

Everything before the seam is judgement -- which zone each room belongs to,
which rooms must share a wall, which should be near each other, which must
be kept apart. Everything after it is arithmetic. This module is the shape
of what crosses: a `ZoningSpec`. Claude fills one in (src/zoning_brief.py)
from the conversation; when it can't, or before it has been asked, the
rule-based `default_spec` fills one in from the room types alone, so the
engine always has a specification to work from and never a prompt.

A spec talks about rooms by the names the owner gave them ("Bedroom",
count 3). The engine works on instances ("Bedroom 1", "Bedroom 2", ...), so
`expand_program` and `expand_requirements` translate: a "must" between two
named rooms becomes a concrete pair of instances, a "should" becomes
"near any instance of the other", and "apart" applies to every pair.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Literal, NamedTuple, Optional, Sequence, Tuple

from pydantic import BaseModel, Field

from src.access import access_for, zone_of
from src.defaults import ROOM_DEFAULTS, resolve_footprint
from src.models import Project

Zone = Literal["public", "private", "service"]
Strength = Literal["must", "should", "apart"]

ZONE_LABELS: Dict[str, str] = {"public": "Public", "private": "Private", "service": "Service"}


class ZoneAssignment(BaseModel):
    room_name: str
    zone: Zone
    reason: Optional[str] = None


class AdjacencyRequirement(BaseModel):
    room_a: str
    room_b: str
    strength: Strength = Field(
        description="must = the two rooms share a wall (hard); should = near each "
        "other (scored); apart = never share a wall (hard)."
    )
    reason: Optional[str] = None


class ZoningSpec(BaseModel):
    assignments: List[ZoneAssignment] = Field(default_factory=list)
    adjacencies: List[AdjacencyRequirement] = Field(default_factory=list)
    rationale: str = ""

    def zone_for(self, room_name: str) -> Optional[str]:
        for a in self.assignments:
            if a.room_name == room_name:
                return a.zone
        return None


# --- Rule-based defaults ----------------------------------------------------

# Adjacency rules by room type. Applied only where both types exist in the
# program. "must" is reserved for pairs a house is wrong without; "should"
# is the ordinary planning preference; "apart" is the one real conflict.
_GARAGES = ("garage_single", "garage_double")

DEFAULT_ADJACENCY_RULES: List[Tuple[str, str, str]] = [
    ("kitchen", "dining_room", "must"),
    ("bedroom_primary", "bathroom", "must"),
    ("closet", "bedroom_primary", "must"),
    ("mudroom", "garage_single", "must"),
    ("mudroom", "garage_double", "must"),
    ("entry", "living_room", "should"),
    ("living_room", "dining_room", "should"),
    ("family_room", "kitchen", "should"),
    ("kitchen", "garage_single", "should"),
    ("kitchen", "garage_double", "should"),
    ("kitchen", "mudroom", "should"),
    ("kitchen", "laundry", "should"),
    ("laundry", "bathroom", "should"),
    ("bedroom", "bathroom", "should"),
    ("half_bath", "entry", "should"),
    ("storage", "garage_single", "should"),
    ("storage", "garage_double", "should"),
    ("bedroom", "garage_single", "apart"),
    ("bedroom", "garage_double", "apart"),
    ("bedroom_primary", "garage_single", "apart"),
    ("bedroom_primary", "garage_double", "apart"),
]


def default_spec(project: Project) -> ZoningSpec:
    """The specification the room types alone imply: zones from the access
    table (src/access.py) and adjacencies from the rule table above. What
    Claude produces is this, revised by what the owner actually said."""
    rooms = [r for r in project.rooms if r.room_type != "hallway"]
    assignments = [ZoneAssignment(room_name=r.name, zone=zone_of(r.room_type)) for r in rooms]

    by_type: Dict[str, List[str]] = {}
    for r in rooms:
        by_type.setdefault(r.room_type, []).append(r.name)

    adjacencies: List[AdjacencyRequirement] = []
    seen: set = set()
    for type_a, type_b, strength in DEFAULT_ADJACENCY_RULES:
        for name_a in by_type.get(type_a, []):
            for name_b in by_type.get(type_b, []):
                key = frozenset((name_a, name_b))
                if name_a == name_b or key in seen:
                    continue
                seen.add(key)
                adjacencies.append(AdjacencyRequirement(room_a=name_a, room_b=name_b, strength=strength))

    return ZoningSpec(
        assignments=assignments,
        adjacencies=adjacencies,
        rationale="Zoned by privacy: shared rooms near the entry, bedrooms deepest, "
        "service rooms where they buffer the rest.",
    )


def reconcile_spec(project: Project, proposed: Optional[ZoningSpec]) -> Tuple[ZoningSpec, List[str]]:
    """Merge a proposed (Claude-written) spec with the defaults so every room
    has a zone and every requirement names real rooms. The proposal wins
    wherever it speaks; the defaults fill the silence. Returns the spec and
    a list of anything that had to be dropped, for the owner to see."""
    base = default_spec(project)
    if proposed is None:
        return base, []

    names = {r.name for r in project.rooms if r.room_type != "hallway"}
    notes: List[str] = []

    zones = {a.room_name: a.zone for a in base.assignments}
    for a in proposed.assignments:
        if a.room_name in names:
            zones[a.room_name] = a.zone
        else:
            notes.append(f"Ignored a zone for '{a.room_name}', which isn't a room in the program.")
    assignments = [ZoneAssignment(room_name=n, zone=zones[n]) for n in zones]

    adjacencies: List[AdjacencyRequirement] = []
    seen: set = set()
    for adj in proposed.adjacencies:
        if adj.room_a not in names or adj.room_b not in names or adj.room_a == adj.room_b:
            notes.append(
                f"Ignored the adjacency '{adj.room_a}' / '{adj.room_b}': it doesn't name two rooms in the program."
            )
            continue
        key = frozenset((adj.room_a, adj.room_b))
        if key in seen:
            continue
        seen.add(key)
        adjacencies.append(adj)
    for adj in base.adjacencies:
        key = frozenset((adj.room_a, adj.room_b))
        if key not in seen:
            seen.add(key)
            adjacencies.append(adj)

    rationale = proposed.rationale.strip() or base.rationale
    return ZoningSpec(assignments=assignments, adjacencies=adjacencies, rationale=rationale), notes


# --- Instances ------------------------------------------------------------


@dataclass(frozen=True)
class RoomInstance:
    """One room as it will be placed: a counted room expanded, its zone
    settled, its size resolved from the defaults table."""

    name: str
    base_name: str
    room_type: str
    is_entry: bool
    zone: str
    width_m: float
    depth_m: float
    min_width_m: float
    min_depth_m: float

    @property
    def passable(self) -> bool:
        return access_for(self.room_type).passable

    @property
    def street_access(self) -> bool:
        return access_for(self.room_type).street_access

    @property
    def area_m2(self) -> float:
        return self.width_m * self.depth_m


SYNTHETIC_ENTRY_NAME = "Entry"


def expand_program(project: Project, spec: ZoningSpec) -> Tuple[List[RoomInstance], List[str]]:
    """Every room the plan has to place. Counted rooms become numbered
    instances; owner-described hallways are dropped (circulation is
    generated, not placed); and if no room is marked as the entry, a foyer
    is added and said so -- the method roots everything at the front door,
    so a plan without one cannot be judged."""
    instances: List[RoomInstance] = []
    notes: List[str] = []
    for room in project.rooms:
        if room.room_type == "hallway":
            continue
        footprint = resolve_footprint(room.room_type, room.explicit_width_m, room.explicit_depth_m)
        zone = spec.zone_for(room.name) or zone_of(room.room_type)
        names = [room.name] if room.count <= 1 else [f"{room.name} {i + 1}" for i in range(room.count)]
        for name in names:
            instances.append(RoomInstance(
                name=name,
                base_name=room.name,
                room_type=room.room_type,
                is_entry=room.is_entry,
                zone=zone,
                width_m=footprint.width_m,
                depth_m=footprint.depth_m,
                min_width_m=footprint.min_width_m,
                min_depth_m=footprint.min_depth_m,
            ))

    entries = [i for i in instances if i.is_entry]
    if instances and not entries:
        d = ROOM_DEFAULTS["entry"]
        name = SYNTHETIC_ENTRY_NAME
        while any(i.name == name for i in instances):
            name += " (added)"
        instances.insert(0, RoomInstance(
            name=name, base_name=name, room_type="entry", is_entry=True, zone="public",
            width_m=d.typical_width_m, depth_m=d.typical_depth_m,
            min_width_m=d.min_width_m, min_depth_m=d.min_depth_m,
        ))
        notes.append("No room was marked as the entry, so a foyer was added at the street edge.")
    elif len(entries) > 1:
        # Only one room can be the front door. The first keeps the flag.
        keep = entries[0].name
        instances = [
            i if (i.name == keep or not i.is_entry)
            else RoomInstance(**{**i.__dict__, "is_entry": False})
            for i in instances
        ]
        notes.append(f"Several rooms were marked as the entry; {keep} is treated as the front door.")
    return instances, notes


class Requirement(NamedTuple):
    """One adjacency requirement at instance level. `room` must / should
    be beside ANY of `options` (must requirements always have exactly one
    option, resolved by `expand_requirements`); apart applies to every
    listed option."""

    room: str
    options: Tuple[str, ...]
    strength: str
    base_a: str
    base_b: str

    def describe(self) -> str:
        other = self.options[0] if len(self.options) == 1 else self.base_b
        verb = {"must": "must share a wall with", "should": "should be near", "apart": "must be kept apart from"}[
            self.strength
        ]
        return f"{self.room} {verb} {other}"


def expand_requirements(spec: ZoningSpec, instances: Sequence[RoomInstance]) -> List[Requirement]:
    by_base: Dict[str, List[str]] = {}
    for inst in instances:
        by_base.setdefault(inst.base_name, []).append(inst.name)

    must_degree: Dict[str, int] = {inst.name: 0 for inst in instances}
    requirements: List[Requirement] = []
    for adj in spec.adjacencies:
        a_names = by_base.get(adj.room_a, [])
        b_names = by_base.get(adj.room_b, [])
        if not a_names or not b_names:
            continue
        if adj.strength == "must":
            # Pair each instance of A with the least-committed instance of
            # B, so "Primary Bedroom must touch Bathroom" with two bathrooms
            # claims one and leaves the other free for the bedrooms.
            for a in a_names:
                b = min(b_names, key=lambda n: (must_degree[n], b_names.index(n)))
                if a == b:
                    continue
                requirements.append(Requirement(a, (b,), "must", adj.room_a, adj.room_b))
                must_degree[a] += 1
                must_degree[b] += 1
        elif adj.strength == "should":
            for a in a_names:
                opts = tuple(n for n in b_names if n != a)
                if opts:
                    requirements.append(Requirement(a, opts, "should", adj.room_a, adj.room_b))
            for b in b_names:
                opts = tuple(n for n in a_names if n != b)
                if opts:
                    requirements.append(Requirement(b, opts, "should", adj.room_b, adj.room_a))
        else:
            for a in a_names:
                opts = tuple(n for n in b_names if n != a)
                if opts:
                    requirements.append(Requirement(a, opts, "apart", adj.room_a, adj.room_b))
    return requirements


def must_pairs(requirements: Sequence[Requirement]) -> List[Tuple[str, str]]:
    pairs: List[Tuple[str, str]] = []
    seen: set = set()
    for req in requirements:
        if req.strength != "must":
            continue
        key = frozenset((req.room, req.options[0]))
        if key in seen:
            continue
        seen.add(key)
        pairs.append((req.room, req.options[0]))
    return pairs


def apart_pairs(requirements: Sequence[Requirement]) -> List[Tuple[str, str]]:
    pairs: List[Tuple[str, str]] = []
    seen: set = set()
    for req in requirements:
        if req.strength != "apart":
            continue
        for other in req.options:
            key = frozenset((req.room, other))
            if key in seen:
                continue
            seen.add(key)
            pairs.append((req.room, other))
    return pairs
