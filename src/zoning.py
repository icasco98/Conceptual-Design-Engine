"""Station 06, the geometry half: pack a specification into a hall plan.

The arrangement this packer draws is the one a house most often is: a hall
runs straight back from the front door, rooms sit in two rows either side
of it, and the rows are ordered along the hall on the public-to-private
gradient -- shared rooms at the street end beside the entry, service rooms
next as a buffer, bedrooms deepest. Which row a room lands in is the site's
decision (the sunny side takes the living room, the poor side the garage)
and the adjacency matrix's (rooms required to share a wall are placed one
after the other in the same row).

The hall is earned, not assumed. Rooms at the street end open straight off
the entry; a room beside a passable room (a dining room off the living room)
is served through it. Only the rooms nothing else serves need the hall, and
it runs exactly as far as the last of them -- or not at all.

Nothing here judges the result. `generate_candidates` produces every
arrangement the spec allows, and `src/validator.py` and `src/scoring.py`
decide between them. A candidate that cannot be packed at all (rooms wider
than the plot allows even at minimum size) is simply not produced, and the
reason is reported alongside.

Local frame: x runs across the plot, y runs from the entry edge (0) into
the plot. `Frame` maps that onto the site whichever edge the entry is on.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field, replace
from typing import Dict, List, Optional, Sequence, Set, Tuple

from src.access import find_access_problems
from src.circulation import build_circulation_edges, plan_nodes, union_outline
from src.geometry import BuildableEnvelope
from src.plan_types import CorridorSegment, LayoutResult, PlacedRoom, Rect
from src.site_analysis import OPPOSITE
from src.zoning_spec import Requirement, RoomInstance, must_pairs

ZONE_RANK: Dict[str, int] = {"public": 0, "service": 1, "private": 2}

# A hall only has to reach a room's door: it runs this far past the start
# of the last room it serves, not the whole way along it.
DOOR_REACH_M = 1.5

# How many side-assignments to pack and score when the program has more
# units than can be enumerated outright (2^k). Deterministic sample.
MAX_CANDIDATES = 256
_EXHAUSTIVE_UNITS = 8

_EPS = 1e-6


@dataclass(frozen=True)
class Frame:
    """Maps the packer's local frame onto the site for a given entry edge."""

    envelope: BuildableEnvelope
    entry_edge: str

    @property
    def width(self) -> float:
        return self.envelope.width_m if self.entry_edge in ("front", "back") else self.envelope.depth_m

    @property
    def depth(self) -> float:
        return self.envelope.depth_m if self.entry_edge in ("front", "back") else self.envelope.width_m

    @property
    def deep_edge(self) -> str:
        return OPPOSITE[self.entry_edge]

    def side_edge(self, column: int) -> str:
        """The site edge a row's outer walls face: column 0 sits at low
        local x, column 1 at high local x."""
        if self.entry_edge in ("front", "back"):
            return "left" if column == 0 else "right"
        return "back" if column == 0 else "front"

    def to_site_rect(self, x: float, y: float, w: float, d: float) -> Tuple[float, float, float, float]:
        env = self.envelope
        left, back = env.left_setback_m, env.back_setback_m
        if self.entry_edge == "front":
            return (left + x, back + env.depth_m - y - d, w, d)
        if self.entry_edge == "back":
            return (left + x, back + y, w, d)
        if self.entry_edge == "left":
            return (left + y, back + x, d, w)
        return (left + env.width_m - y - d, back + x, d, w)


@dataclass(frozen=True)
class ZoningPlan:
    """One packed candidate, in site metres, plus the facts the validator
    and scorer judge it on."""

    result: LayoutResult
    entry_edge: str
    columns: Tuple[Tuple[str, ...], Tuple[str, ...]]
    column_lengths: Tuple[float, float]
    column_edges: Tuple[str, str]
    corridor_needed: bool
    # room name -> site edges its outer walls face (for the site score)
    facing: Dict[str, Tuple[str, ...]]
    # zone -> bounding rectangle of that zone's rooms, site frame
    zone_regions: Dict[str, Rect]
    notes: Tuple[str, ...] = ()

    @property
    def rooms(self) -> List[PlacedRoom]:
        return self.result.rooms

    def room(self, name: str) -> PlacedRoom:
        return next(r for r in self.result.rooms if r.name == name)


# --- Units: what has to be placed together -----------------------------------


@dataclass
class _Unit:
    rooms: List[RoomInstance]
    # A lead unit has to start its row at the street end: a garage, which
    # meets the street, or a room required to share a wall with the entry.
    lead: bool = False

    @property
    def names(self) -> List[str]:
        return [r.name for r in self.rooms]


def _path_order(component: Set[str], graph: Dict[str, Set[str]]) -> List[str]:
    """Walk a path-shaped component from one end to the other. Falls back
    to sorted order if it is not a path (the gate should have refused it)."""
    ends = sorted(n for n in component if len(graph.get(n, ())) <= 1)
    if not ends:
        return sorted(component)
    order = [ends[0]]
    seen = {ends[0]}
    while True:
        nxt = [n for n in sorted(graph.get(order[-1], ())) if n not in seen]
        if not nxt:
            break
        order.append(nxt[0])
        seen.add(nxt[0])
    for n in sorted(component):
        if n not in seen:
            order.append(n)
    return order


def _build_units(
    instances: Sequence[RoomInstance], anchor: RoomInstance, musts: Sequence[Tuple[str, str]]
) -> Tuple[List[_Unit], List[str]]:
    by_name = {i.name: i for i in instances}
    graph: Dict[str, Set[str]] = {i.name: set() for i in instances}
    for a, b in musts:
        if a in graph and b in graph:
            graph[a].add(b)
            graph[b].add(a)

    units: List[_Unit] = []
    seen: Set[str] = set()
    for name in sorted(graph):
        if name in seen:
            continue
        component: Set[str] = set()
        stack = [name]
        while stack:
            n = stack.pop()
            if n in component:
                continue
            component.add(n)
            stack.extend(graph[n])
        seen |= component
        ordered = _path_order(component, graph)

        if anchor.name in ordered:
            # The entry sits at the head of the hall; the rooms chained to
            # it start the rows either side.
            idx = ordered.index(anchor.name)
            for piece in (ordered[:idx][::-1], ordered[idx + 1:]):
                if piece:
                    units.append(_Unit([by_name[n] for n in piece], lead=True))
            continue

        rooms = [by_name[n] for n in ordered]
        street = [r for r in rooms if r.street_access]
        if street:
            # A garage has to meet the street: orient the chain so it leads.
            if rooms[-1].street_access and not rooms[0].street_access:
                rooms = rooms[::-1]
            units.append(_Unit(rooms, lead=True))
        else:
            units.append(_Unit(rooms))

    problems: List[str] = []
    leads = [u for u in units if u.lead]
    if len(leads) > 2:
        names = ", ".join(u.rooms[0].name for u in leads)
        problems.append(
            f"{names} all need to sit at the street end beside the entry, and only two rooms can "
            "-- one either side of the front door."
        )
    return units, problems


def _affinity(requirements: Sequence[Requirement]) -> Dict[str, Dict[str, int]]:
    affinity: Dict[str, Dict[str, int]] = {}
    for req in requirements:
        if req.strength != "should":
            continue
        for other in req.options:
            affinity.setdefault(req.room, {})[other] = affinity.get(req.room, {}).get(other, 0) + 1
            affinity.setdefault(other, {})[req.room] = affinity.get(other, {}).get(req.room, 0) + 1
    return affinity


def _order_row(
    units: Sequence[_Unit], affinity: Dict[str, Dict[str, int]], anchor_name: str
) -> List[RoomInstance]:
    """Order a row along the hall: its lead first, then units in zone order
    (public, service, private), and within a zone whichever unit has the
    most 'should be near' ties to the room just placed -- or to the entry,
    for the room that starts the row."""
    ordered: List[RoomInstance] = []
    for unit in units:
        if unit.lead:
            ordered.extend(unit.rooms)
    remaining = [u for u in units if not u.lead]

    def rank(unit: _Unit) -> int:
        return min(ZONE_RANK[r.zone] for r in unit.rooms)

    while remaining:
        last = ordered[-1].name if ordered else anchor_name

        def pull(unit: _Unit) -> int:
            return sum(affinity.get(last, {}).get(r.name, 0) for r in unit.rooms)

        unit = min(remaining, key=lambda u: (rank(u), -pull(u), u.rooms[0].name))
        remaining.remove(unit)
        rooms = list(unit.rooms)
        if ZONE_RANK[rooms[0].zone] > ZONE_RANK[rooms[-1].zone]:
            rooms.reverse()
        elif len(rooms) > 1 and ZONE_RANK[rooms[0].zone] == ZONE_RANK[rooms[-1].zone]:
            if affinity.get(last, {}).get(rooms[-1].name, 0) > affinity.get(last, {}).get(rooms[0].name, 0):
                rooms.reverse()
        ordered.extend(rooms)
    return ordered


# --- Packing one candidate ------------------------------------------------------


@dataclass
class _Oriented:
    inst: RoomInstance
    frontage: float  # extent along the hall
    off: float  # extent away from the hall
    min_frontage: float
    y0: float = 0.0
    y1: float = 0.0
    x0: float = 0.0
    x1: float = 0.0
    straddles_entry: bool = False


def _orient(rooms: Sequence[RoomInstance], budget: float) -> Optional[List[_Oriented]]:
    """Turn each room so it fits the row's available depth away from the
    hall, preferring the shorter side along the hall (less hall to build);
    shrink the other side toward its minimum only when the plot forces it."""
    out: List[_Oriented] = []
    for r in rooms:
        options = [
            (r.width_m, r.depth_m, r.min_width_m, r.min_depth_m),
            (r.depth_m, r.width_m, r.min_depth_m, r.min_width_m),
        ]
        valid = []
        for f, o, mf, mo in options:
            if mo <= budget + _EPS:
                valid.append((f, min(o, budget), mf, o - min(o, budget)))
        if not valid:
            return None
        f, o, mf, shrink = min(valid, key=lambda v: (v[0], v[3]))
        out.append(_Oriented(r, f, o, mf))
    return out


def _stack(row: List[_Oriented]) -> float:
    y = 0.0
    for item in row:
        item.y0 = y
        y += item.frontage
        item.y1 = y
    return y


def _shrink_to_depth(row: List[_Oriented], depth: float) -> bool:
    length = _stack(row)
    if length <= depth + _EPS:
        return True
    needed = length - depth
    slack = sum(i.frontage - i.min_frontage for i in row)
    if slack < needed - _EPS:
        return False
    for i in row:
        i.frontage -= needed * (i.frontage - i.min_frontage) / slack
    _stack(row)
    return True


def _anchor_slot(anchor: RoomInstance, corridor_width: float) -> Tuple[float, float]:
    """The entry is the head of the hall. A foyer-sized entry takes the
    hall's width and stretches to keep its area; a room too wide for that
    (the owner named a living room as the entry) keeps its own size and the
    hall runs on from its middle."""
    if anchor.min_width_m <= corridor_width + _EPS:
        return corridor_width, max(anchor.min_depth_m, anchor.area_m2 / corridor_width)
    return anchor.width_m, anchor.depth_m


def pack_candidate(
    anchor: RoomInstance,
    row_a: Sequence[RoomInstance],
    row_b: Sequence[RoomInstance],
    frame: Frame,
    corridor_width: float,
) -> Optional[ZoningPlan]:
    """Place the entry at the head of the hall and the two rows either side
    of it. None if no orientation of the rooms fits the plot."""
    W, D = frame.width, frame.depth
    slot, a_depth = _anchor_slot(anchor, corridor_width)
    pad = (slot - corridor_width) / 2
    if a_depth > D + _EPS or slot > W + _EPS:
        return None

    def floor_of(rooms: Sequence[RoomInstance]) -> float:
        return max((min(r.min_width_m, r.min_depth_m) for r in rooms), default=0.0)

    packed: Optional[Tuple[List[_Oriented], List[_Oriented]]] = None
    for first in (0, 1):
        rows = (list(row_a), list(row_b))
        primary = _orient(rows[first], W - slot - floor_of(rows[1 - first]))
        if primary is None:
            continue
        used = max((o.off for o in primary), default=0.0)
        secondary = _orient(rows[1 - first], W - slot - used)
        if secondary is None:
            continue
        packed = (primary, secondary) if first == 0 else (secondary, primary)
        break
    if packed is None:
        return None
    oriented_a, oriented_b = packed

    if not _shrink_to_depth(oriented_a, D) or not _shrink_to_depth(oriented_b, D):
        return None

    for row in (oriented_a, oriented_b):
        for item in row:
            item.straddles_entry = item.y0 < a_depth - _EPS

    # Row A is right-aligned on the hall, row B left-aligned; a room that
    # overlaps the entry's depth sits against the entry's own edge instead.
    inner_offset = lambda item: 0.0 if item.straddles_entry else pad  # noqa: E731
    sx = max((item.off - inner_offset(item) for item in oriented_a), default=0.0)
    for item in oriented_a:
        item.x1 = sx + inner_offset(item)
        item.x0 = item.x1 - item.off
    for item in oriented_b:
        item.x0 = sx + slot - inner_offset(item)
        item.x1 = item.x0 + item.off
    if any(item.x1 > W + _EPS for item in oriented_b):
        return None
    if any(item.x0 < -_EPS for item in oriented_a):
        return None

    anchor_rect = (sx, 0.0, sx + slot, a_depth)

    # Which rooms nothing serves without a hall: walk the plan without it.
    rooms_local = [(anchor, anchor_rect, -1)] + [
        (item.inst, (item.x0, item.y0, item.x1, item.y1), col)
        for col, row in enumerate((oriented_a, oriented_b))
        for item in row
    ]
    probe = [
        PlacedRoom(
            name=inst.name, base_name=inst.base_name, room_type=inst.room_type, is_entry=inst.is_entry,
            zone=inst.zone, x_m=r[0], y_m=r[1], width_m=r[2] - r[0], depth_m=r[3] - r[1],
            min_width_m=inst.min_width_m, min_depth_m=inst.min_depth_m,
        )
        for inst, r, _ in rooms_local
    ]
    unserved = {p.room_name for p in find_access_problems(plan_nodes(probe, []))}
    corridor_local: Optional[Rect] = None
    if unserved:
        reach = max(
            min(r[3], r[1] + DOOR_REACH_M) for inst, r, _ in rooms_local if inst.name in unserved
        )
        end = max(a_depth + corridor_width, reach)
        end = min(end, D)
        corridor_local = (sx + pad, a_depth, sx + pad + corridor_width, end)

    # --- to site frame ---
    placed: List[PlacedRoom] = []
    for inst, r, _ in rooms_local:
        x, y, w, d = frame.to_site_rect(r[0], r[1], r[2] - r[0], r[3] - r[1])
        placed.append(PlacedRoom(
            name=inst.name, base_name=inst.base_name, room_type=inst.room_type, is_entry=inst.is_entry,
            zone=inst.zone, x_m=x, y_m=y, width_m=w, depth_m=d,
            min_width_m=inst.min_width_m, min_depth_m=inst.min_depth_m,
        ))
    corridors: List[CorridorSegment] = []
    if corridor_local is not None:
        c = corridor_local
        x, y, w, d = frame.to_site_rect(c[0], c[1], c[2] - c[0], c[3] - c[1])
        corridors.append(CorridorSegment(
            x_m=x, y_m=y, width_m=w, depth_m=d, min_width_m=corridor_width, min_depth_m=corridor_width
        ))

    all_rects = [p.rect for p in placed] + [c.rect for c in corridors]
    result = LayoutResult(
        rooms=placed,
        corridors=corridors,
        circulation_edges=build_circulation_edges(placed, corridors),
        footprint=union_outline(all_rects),
    )

    # Facing edges: every row room faces its row's side; rooms at y=0 face
    # the street; the deepest room in each row faces the far edge.
    facing: Dict[str, Tuple[str, ...]] = {anchor.name: (frame.entry_edge,)}
    lengths = (
        oriented_a[-1].y1 if oriented_a else 0.0,
        oriented_b[-1].y1 if oriented_b else 0.0,
    )
    for col, row in enumerate((oriented_a, oriented_b)):
        for item in row:
            edges = [frame.side_edge(col)]
            if item.y0 < _EPS:
                edges.append(frame.entry_edge)
            if abs(item.y1 - max(lengths)) < _EPS:
                edges.append(frame.deep_edge)
            facing[item.inst.name] = tuple(edges)
    if max(lengths) <= a_depth + _EPS:
        facing[anchor.name] = (frame.entry_edge, frame.deep_edge)

    regions: Dict[str, Rect] = {}
    for room in placed:
        r = room.rect
        cur = regions.get(room.zone)
        regions[room.zone] = r if cur is None else (
            min(cur[0], r[0]), min(cur[1], r[1]), max(cur[2], r[2]), max(cur[3], r[3])
        )

    return ZoningPlan(
        result=result,
        entry_edge=frame.entry_edge,
        columns=(tuple(i.inst.name for i in oriented_a), tuple(i.inst.name for i in oriented_b)),
        column_lengths=lengths,
        column_edges=(frame.side_edge(0), frame.side_edge(1)),
        corridor_needed=corridor_local is not None,
        facing=facing,
        zone_regions=regions,
    )


# --- Candidate generation ---------------------------------------------------------


@dataclass(frozen=True)
class GenerationResult:
    plans: List[ZoningPlan]
    problems: List[str] = field(default_factory=list)


def _masks(count: int) -> List[int]:
    if count <= _EXHAUSTIVE_UNITS:
        return list(range(1 << count))
    rng = random.Random(0)
    chosen = {0, (1 << count) - 1}
    # Alternating assignments as a balanced starting point, both ways round.
    alternating = sum(1 << i for i in range(0, count, 2))
    chosen.add(alternating)
    chosen.add(((1 << count) - 1) ^ alternating)
    while len(chosen) < MAX_CANDIDATES:
        chosen.add(rng.getrandbits(count))
    return sorted(chosen)


def generate_candidates(
    instances: Sequence[RoomInstance],
    requirements: Sequence[Requirement],
    frame: Frame,
    corridor_width: float,
) -> GenerationResult:
    """Every hall-plan arrangement the specification allows: each unit of
    rooms (a must-chain, or a single room) on one side of the hall or the
    other, ordered along it by zone and affinity. The validator and scorer
    choose between them."""
    anchor = next((i for i in instances if i.is_entry), None)
    if anchor is None:
        return GenerationResult([], ["The plan has no entry to be rooted at."])
    others = [i for i in instances if i.name != anchor.name]

    units, problems = _build_units(others, anchor, must_pairs(requirements))
    if problems:
        return GenerationResult([], problems)
    affinity = _affinity(requirements)

    plans: List[ZoningPlan] = []
    seen_rows: Set[Tuple[Tuple[str, ...], Tuple[str, ...]]] = set()
    for mask in _masks(len(units)):
        side_a = [u for i, u in enumerate(units) if mask >> i & 1]
        side_b = [u for i, u in enumerate(units) if not mask >> i & 1]
        if sum(u.lead for u in side_a) > 1 or sum(u.lead for u in side_b) > 1:
            continue
        row_a = _order_row(side_a, affinity, anchor.name)
        row_b = _order_row(side_b, affinity, anchor.name)
        key = (tuple(r.name for r in row_a), tuple(r.name for r in row_b))
        if key in seen_rows:
            continue
        seen_rows.add(key)
        plan = pack_candidate(anchor, row_a, row_b, frame, corridor_width)
        if plan is not None:
            plans.append(plan)

    if not plans:
        problems.append(_why_nothing_fits(instances, frame, corridor_width))
    return GenerationResult(plans, problems)


def _why_nothing_fits(instances: Sequence[RoomInstance], frame: Frame, corridor_width: float) -> str:
    widest = max(instances, key=lambda i: min(i.min_width_m, i.min_depth_m))
    narrowest_side = min(widest.min_width_m, widest.min_depth_m)
    if narrowest_side + corridor_width > frame.width + _EPS:
        return (
            f"{widest.name} is {narrowest_side:.1f} m across at its smallest, which with a hall beside it "
            f"is wider than the {frame.width:.1f} m the setbacks leave."
        )
    min_frontage = sum(min(i.min_width_m, i.min_depth_m) for i in instances if not i.is_entry)
    return (
        f"Even at minimum sizes the rooms need about {min_frontage / 2:.1f} m of depth either side of a hall, "
        f"and the setbacks leave {frame.depth:.1f} m. The program is too big for this plot on one level."
    )
