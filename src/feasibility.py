"""Station 05: prove the brief can be built before trying to pack it.

A plan of rectangular rooms is the rectangular dual of its adjacency graph,
so a "must share a wall" graph that cannot be drawn flat has no plan at
all -- at any size, for any amount of packing effort. Five rooms all
required to touch one another is a plausible brief and an impossible one.

Two layers of test, cheapest first, each failing with a sentence naming the
requirement to drop rather than a timeout:

1. Planarity, the necessary condition from Koźmiński & Kinnen: Euler's
   bound, then a search for K5 and K3,3 inside the must-graph (Kuratowski's
   two forbidden shapes; on graphs this small a direct search is enough).
2. Realisability in the hall plan the packer draws (src/zoning.py): rooms
   sit in two rows either side of a hall, so a room shares walls with at
   most the room before it and the room after it, and no three rooms can
   all touch one another. Must-graphs have to be paths.

A must that also appears as apart is a contradiction and is reported too.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import combinations
from typing import Dict, List, Sequence, Set, Tuple


@dataclass(frozen=True)
class FeasibilityReport:
    feasible: bool
    problems: List[str] = field(default_factory=list)
    # The must pairs that would have to be dropped (or relaxed to "should")
    # for the brief to become buildable -- the engine offers exactly that.
    offending: List[Tuple[str, str]] = field(default_factory=list)


def _graph(pairs: Sequence[Tuple[str, str]]) -> Dict[str, Set[str]]:
    graph: Dict[str, Set[str]] = {}
    for a, b in pairs:
        graph.setdefault(a, set()).add(b)
        graph.setdefault(b, set()).add(a)
    return graph


def _has_k5(graph: Dict[str, Set[str]]) -> List[str]:
    nodes = [n for n in graph if len(graph[n]) >= 4]
    for group in combinations(sorted(nodes), 5):
        if all(b in graph[a] for a, b in combinations(group, 2)):
            return list(group)
    return []


def _has_k33(graph: Dict[str, Set[str]]) -> List[str]:
    nodes = sorted(n for n in graph if len(graph[n]) >= 3)
    for left in combinations(nodes, 3):
        rest = [n for n in nodes if n not in left]
        for right in combinations(rest, 3):
            if all(b in graph[a] for a in left for b in right):
                return list(left) + list(right)
    return []


def _find_cycle(graph: Dict[str, Set[str]]) -> List[str]:
    """Some cycle in the must-graph, as the rooms on it, or [] if it's a forest."""
    seen: Set[str] = set()
    for start in sorted(graph):
        if start in seen:
            continue
        parent: Dict[str, str] = {start: ""}
        stack = [start]
        while stack:
            node = stack.pop()
            seen.add(node)
            for nxt in sorted(graph[node]):
                if nxt == parent[node]:
                    continue
                if nxt in parent:
                    # Walk both branches back to the common ancestor.
                    path_a, cur = [node], node
                    while cur:
                        cur = parent[cur]
                        if cur:
                            path_a.append(cur)
                    path_b, cur = [nxt], nxt
                    while cur:
                        cur = parent[cur]
                        if cur:
                            path_b.append(cur)
                    common = next(n for n in path_a if n in path_b)
                    cycle = path_a[: path_a.index(common) + 1] + path_b[: path_b.index(common)][::-1]
                    return cycle
                parent[nxt] = node
                stack.append(nxt)
    return []


def _names(rooms: Sequence[str]) -> str:
    rooms = list(rooms)
    if len(rooms) <= 1:
        return "".join(rooms)
    return ", ".join(rooms[:-1]) + " and " + rooms[-1]


def check_feasibility(
    must: Sequence[Tuple[str, str]],
    apart: Sequence[Tuple[str, str]] = (),
) -> FeasibilityReport:
    problems: List[str] = []
    offending: List[Tuple[str, str]] = []

    apart_keys = {frozenset(p) for p in apart}
    for a, b in must:
        if frozenset((a, b)) in apart_keys:
            problems.append(f"{a} and {b} are required both to share a wall and to be kept apart.")
            offending.append((a, b))

    graph = _graph(must)
    v, e = len(graph), len(must)
    if v >= 3 and e > 3 * v - 6:
        problems.append(
            f"{e} required adjacencies between {v} rooms is more than any flat arrangement can hold; "
            "no rectangular plan exists for this brief."
        )
    k5 = _has_k5(graph)
    if k5:
        problems.append(
            f"{_names(k5)} are all required to touch one another. Five mutually adjacent rooms cannot "
            "be drawn in a plane, so no rectangular plan exists; drop one of those adjacencies."
        )
        offending.append((k5[0], k5[1]))
    k33 = _has_k33(graph)
    if k33:
        problems.append(
            f"Each of {_names(k33[:3])} is required to touch each of {_names(k33[3:])}. That graph cannot be "
            "drawn without crossings, so no rectangular plan exists; drop one of those adjacencies."
        )
        offending.append((k33[0], k33[3]))

    # Hall-plan realisability, only worth stating if the graph is planar.
    if not (k5 or k33):
        for room in sorted(graph):
            neighbours = sorted(graph[room])
            if len(neighbours) > 2:
                problems.append(
                    f"{room} is required to share a wall with {_names(neighbours)}. Rooms along a hall "
                    "touch at most the room before and the room after them; keep two of those and make "
                    "the rest 'should be near'."
                )
                offending.append((room, neighbours[-1]))
        cycle = _find_cycle(graph)
        if cycle:
            problems.append(
                f"{_names(cycle)} are required to touch around in a ring, which rooms along a hall "
                "cannot do; make one of those adjacencies 'should be near'."
            )
            offending.append((cycle[0], cycle[-1]))

    # Dedupe offending pairs, keeping order.
    seen: Set[frozenset] = set()
    unique: List[Tuple[str, str]] = []
    for pair in offending:
        key = frozenset(pair)
        if key not in seen:
            seen.add(key)
            unique.append(pair)

    return FeasibilityReport(feasible=not problems, problems=problems, offending=unique)
