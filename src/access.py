"""How each room type behaves in a plan's circulation, and the check that
holds a layout to it.

`src/layout.py` packs rectangles: rooms go left-to-right in the order the
layout plan gives, wrapping to a new row when the next one doesn't fit, and
the wrap point is decided purely by width arithmetic. Two rooms meant to sit
together can land in different rows; two unrelated rooms end up adjacent
because they happened to fit. `_build_circulation_edges` then walks whatever
touching graph that produced and draws an arrow to each room from whichever
neighbor reached it first.

Nothing in that pipeline ever asks whether a route makes sense, which is how
a plan comes out where the only way from the street to a bedroom is through
the garage and a bathroom. The packer has no concept of access.

This module is the missing vocabulary:

  zone           where the room belongs in the public-to-private gradient.
  passable       whether you may walk THROUGH it to reach somewhere else.
                 A corridor obviously; a living room reasonably; a bedroom,
                 a bathroom or a garage never -- those are destinations, and
                 a plan that routes through one is wrong however neatly its
                 rectangles pack.
  street_access  the room meets the street directly rather than being served
                 from inside (a garage), so it should sit on the boundary and
                 is not expected to sit on the household's circulation.

The properties are plain data, deterministic, and never guessed by the LLM
-- the same principle as the sizes in src/defaults.py. Claude decides which
rooms group together; these decide whether the result is a plan you could
actually walk through.
"""

from __future__ import annotations

from typing import Dict, List, NamedTuple, Optional, Sequence, Tuple

Zone = str  # "public" | "private" | "service"


class RoomAccess(NamedTuple):
    zone: Zone
    passable: bool
    street_access: bool = False


# Defaults chosen so that the rooms you would never route through -- sleeping,
# bathing, parking, storage -- are impassable, and the rooms a plan naturally
# flows through are not.
ROOM_ACCESS: Dict[str, RoomAccess] = {
    "entry": RoomAccess("public", True),
    "hallway": RoomAccess("public", True),
    "mudroom": RoomAccess("public", True),
    "living_room": RoomAccess("public", True),
    "family_room": RoomAccess("public", True),
    "dining_room": RoomAccess("public", True),
    "kitchen": RoomAccess("public", False),
    "office": RoomAccess("private", False),
    "bedroom_primary": RoomAccess("private", False),
    "bedroom": RoomAccess("private", False),
    "bathroom": RoomAccess("private", False),
    "half_bath": RoomAccess("public", False),
    "closet": RoomAccess("private", False),
    "laundry": RoomAccess("service", False),
    "storage": RoomAccess("service", False),
    "garage_single": RoomAccess("service", False, street_access=True),
    "garage_double": RoomAccess("service", False, street_access=True),
    "other": RoomAccess("public", False),
}

_FALLBACK = RoomAccess("public", False)


def access_for(room_type: str) -> RoomAccess:
    return ROOM_ACCESS.get(room_type, _FALLBACK)


def is_passable(room_type: str) -> bool:
    return access_for(room_type).passable


def zone_of(room_type: str) -> Zone:
    return access_for(room_type).zone


class AccessProblem(NamedTuple):
    """One room the plan fails to serve properly.

    `kind` is "unreachable" when no route from the entry reaches it at all,
    or "through_room" when the only routes pass through somewhere you would
    not walk through -- `via` names those rooms, nearest first.
    """

    room_name: str
    kind: str
    via: Tuple[str, ...] = ()

    @property
    def message(self) -> str:
        if self.kind == "unreachable":
            return f"{self.room_name} can't be reached from the entry at all."
        route = " and ".join(self.via) if self.via else "another room"
        return f"The only way to {self.room_name} is through {route}."


class Node(NamedTuple):
    """One rectangle in the plan's touching graph."""

    name: str
    rect: Tuple[float, float, float, float]  # x0, y0, x1, y1
    passable: bool
    is_entry: bool
    street_access: bool = False


def rects_touch(a: Tuple[float, float, float, float],
                b: Tuple[float, float, float, float],
                tol: float = 1e-6) -> bool:
    """True when two rectangles share a length of boundary -- not merely a
    corner, which you can't put a door on."""
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    if abs(ax1 - bx0) < tol or abs(bx1 - ax0) < tol:
        return min(ay1, by1) - max(ay0, by0) > tol
    if abs(ay1 - by0) < tol or abs(by1 - ay0) < tol:
        return min(ax1, bx1) - max(ax0, bx0) > tol
    return False


def find_access_problems(nodes: Sequence[Node]) -> List[AccessProblem]:
    """Every room the plan fails to serve, walking out from the entry.

    The walk may only pass THROUGH a passable node. A room that is only
    touched by impassable rooms is reported with what stands in the way, so
    the answer names the actual problem ("the only way to Bedroom 2 is
    through the Garage") rather than just declaring the plan invalid.

    A garage is exempt: it meets the street directly, so not being on the
    household circulation is what it is supposed to do, not a fault.
    """
    if not nodes:
        return []
    entry = next((i for i, n in enumerate(nodes) if n.is_entry), None)
    if entry is None:
        return []

    adjacency: List[List[int]] = [[] for _ in nodes]
    for i in range(len(nodes)):
        for j in range(i + 1, len(nodes)):
            if rects_touch(nodes[i].rect, nodes[j].rect):
                adjacency[i].append(j)
                adjacency[j].append(i)

    # Breadth-first from the entry, expanding only through passable rooms.
    # Reaching an impassable room is fine -- it just can't be walked onward
    # from, which is exactly what makes it a destination.
    reached = [False] * len(nodes)
    reached[entry] = True
    queue = [entry]
    while queue:
        current = queue.pop(0)
        if not (nodes[current].passable or current == entry):
            continue
        for other in adjacency[current]:
            if reached[other]:
                continue
            reached[other] = True
            queue.append(other)

    problems: List[AccessProblem] = []
    for i, node in enumerate(nodes):
        if reached[i] or node.is_entry or node.street_access:
            continue
        blockers = tuple(
            nodes[j].name for j in adjacency[i]
            if not nodes[j].passable and not nodes[j].is_entry
        )
        if adjacency[i] and blockers:
            problems.append(AccessProblem(node.name, "through_room", blockers[:2]))
        else:
            problems.append(AccessProblem(node.name, "unreachable"))
    return problems


def nodes_from_layout(placed_rooms, corridors) -> List[Node]:
    """Build the touching graph's nodes from a `src.layout.LayoutResult`'s
    rooms and corridors. Corridors are always passable; a room's passability
    comes from its type."""
    nodes: List[Node] = []
    for room in placed_rooms:
        acc = access_for(room.room_type)
        nodes.append(Node(
            name=room.name,
            rect=(room.x_m, room.y_m, room.x_m + room.width_m, room.y_m + room.depth_m),
            passable=acc.passable,
            is_entry=room.is_entry,
            street_access=acc.street_access,
        ))
    for i, corridor in enumerate(corridors, start=1):
        nodes.append(Node(
            name=f"Hallway {i}" if len(corridors) > 1 else "Hallway",
            rect=(corridor.x_m, corridor.y_m,
                  corridor.x_m + corridor.width_m, corridor.y_m + corridor.depth_m),
            passable=True,
            is_entry=False,
        ))
    return nodes


def access_problems_for(result) -> List[AccessProblem]:
    """Convenience wrapper: the access problems in a packed layout."""
    return find_access_problems(nodes_from_layout(result.rooms, result.corridors))
