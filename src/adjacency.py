"""What should touch what — the contract between Claude and the geometry.

This is the file the rest of the layout pipeline was missing. Claude used to
express adjacency as `placement_order`, a flat list of room names, and the
packer read that list as a sequence. A list is one-dimensional: it gives
every room exactly two neighbours and no way to say "the ensuite opens off
the primary bedroom" about two rooms four apart in it. Adjacency is a graph
-- any room may need to touch any other, and a rectangle can touch four at
once -- so the brief was being flattened before the geometry ever ran, and
everything downstream was reverse-engineering what the list could not carry.

Here it stays a graph. Claude states unordered pairs with a strength:

    must    the plan is wrong without it. A hard constraint, and the only
            kind `src.place` will distort a layout to satisfy.
    should  a preference worth scoring. Never a reason to reject a plan.
    avoid   these two should NOT share a wall -- a bedroom off the garage,
            a bathroom door onto the dining room.

Claude still decides nothing geometric: no coordinates, no sizes, no
orientation. It says which rooms belong against each other and how strongly,
which is the architectural judgement, and `src.place` does the arithmetic.

Two things this module owns beyond the data itself:

`clusters()` contracts the must-edges. Rooms that must touch are a single
unit as far as placement is concerned, and placing clusters rather than
loose rooms is what stops a slicing decision from separating a pair that was
never allowed to separate.

`feasibility_problems()` rejects a brief no rectangular plan can satisfy.
A floor plan of rectangular rooms is the rectangular dual of its adjacency
graph, and a rectangular dual only exists for a planar graph -- so five
rooms all required to touch one another is a plausible request and an
impossible one, at any size, for any amount of packing effort. Catching it
here turns a mysterious failure into a sentence naming the requirement to
drop.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations
from typing import Dict, FrozenSet, Iterable, List, Literal, Optional, Sequence, Set, Tuple

from pydantic import BaseModel, Field

Strength = Literal["must", "should", "avoid"]

# Relative pull of each strength when a placement decision has to trade one
# relationship against another. `must` outweighs any number of `should`s;
# `avoid` is a push rather than a pull, so it is negative.
STRENGTH_WEIGHT: Dict[str, float] = {
    "must": 10.0,
    "should": 1.0,
    "avoid": -6.0,
}

_STRENGTH_RANK: Dict[str, int] = {"should": 0, "avoid": 1, "must": 2}

Pair = FrozenSet[str]


class AdjacencyRule(BaseModel):
    """One stated relationship between two rooms, by name.

    Unordered: "kitchen next to dining" and "dining next to kitchen" are the
    same rule and are stored once.
    """

    room_a: str = Field(description="Exact room name as given in the program.")
    room_b: str = Field(description="Exact room name as given in the program.")
    strength: Strength = Field(
        description=(
            "'must' when the plan is wrong without the two sharing a wall, "
            "'should' when it is a preference, 'avoid' when they should not "
            "share a wall at all."
        )
    )
    reason: Optional[str] = Field(
        default=None,
        description="Short plain-language why, e.g. 'ensuite opens off the primary bedroom'.",
    )


def expand_rule_names(
    rule: AdjacencyRule, instances_by_base: Dict[str, List[str]]
) -> List[Tuple[str, str]]:
    """Turn a rule written against the program's room names into rules
    against the individual room instances.

    A program says "Bedroom, count 2" and Claude writes one rule about
    "Bedroom"; placement deals in "Bedroom 1" and "Bedroom 2". How a rule
    spreads over those depends on its strength, because the honest reading
    differs:

      must    paired by index where both sides repeat -- "each bedroom has
              its own bathroom" means Bedroom 1 with Bathroom 1, not every
              bedroom touching every bathroom, which no plan could satisfy.
      should  every combination, since a preference that lands on any of
              them is worth something.
      avoid   every combination, because the objection applies to each.
    """
    left = instances_by_base.get(rule.room_a, [])
    right = instances_by_base.get(rule.room_b, [])
    if not left or not right:
        return []

    if rule.strength == "must" and len(left) > 1 and len(right) > 1:
        return [(a, b) for a, b in zip(left, right) if a != b]
    return [(a, b) for a in left for b in right if a != b]


@dataclass(frozen=True)
class AdjacencySatisfaction:
    """How much of the brief a finished layout actually delivered."""

    must_total: int
    must_met: int
    should_total: int
    should_met: int
    avoid_total: int
    avoid_violated: int
    unmet_must: Tuple[Tuple[str, str], ...]
    violated_avoid: Tuple[Tuple[str, str], ...]

    @property
    def must_ratio(self) -> float:
        return 1.0 if self.must_total == 0 else self.must_met / self.must_total

    @property
    def should_ratio(self) -> float:
        return 1.0 if self.should_total == 0 else self.should_met / self.should_total

    def summary(self) -> str:
        parts = []
        if self.must_total:
            parts.append(f"{self.must_met}/{self.must_total} required adjacencies met")
        if self.should_total:
            parts.append(f"{self.should_met}/{self.should_total} preferred met")
        if self.avoid_violated:
            parts.append(f"{self.avoid_violated} separation(s) broken")
        return "; ".join(parts) if parts else "no adjacencies requested"


class AdjacencyGraph:
    """The stated relationships, normalised and queryable.

    Normalisation is the whole reason this is a class rather than a list:
    pairs are unordered, self-pairs are meaningless, a room that isn't in
    the program can't be constrained, and a pair stated twice with different
    strengths has to resolve one way every time (the stronger wins, so a
    `must` is never quietly downgraded by a stray `should`).
    """

    def __init__(self, rooms: Iterable[str], rules: Iterable[Tuple[str, str, str]] = ()):
        self.rooms: Tuple[str, ...] = tuple(rooms)
        known = set(self.rooms)
        strengths: Dict[Pair, str] = {}

        for room_a, room_b, strength in rules:
            if room_a == room_b or room_a not in known or room_b not in known:
                continue
            if strength not in _STRENGTH_RANK:
                continue
            pair = frozenset((room_a, room_b))
            existing = strengths.get(pair)
            if existing is None or _STRENGTH_RANK[strength] > _STRENGTH_RANK[existing]:
                strengths[pair] = strength

        self._strengths: Dict[Pair, str] = strengths

    @classmethod
    def from_rules(
        cls,
        rooms: Iterable[str],
        rules: Iterable[AdjacencyRule],
        instances_by_base: Optional[Dict[str, List[str]]] = None,
    ) -> "AdjacencyGraph":
        rooms = tuple(rooms)
        if instances_by_base is None:
            instances_by_base = {name: [name] for name in rooms}
        expanded: List[Tuple[str, str, str]] = []
        for rule in rules:
            for room_a, room_b in expand_rule_names(rule, instances_by_base):
                expanded.append((room_a, room_b, rule.strength))
        return cls(rooms, expanded)

    # --- reading -----------------------------------------------------

    def __len__(self) -> int:
        return len(self._strengths)

    def strength(self, room_a: str, room_b: str) -> Optional[str]:
        return self._strengths.get(frozenset((room_a, room_b)))

    def pairs(self, strength: str) -> List[Tuple[str, str]]:
        """Sorted so the same graph always reports the same order -- these
        feed candidate search, which has to be deterministic."""
        out = [tuple(sorted(pair)) for pair, value in self._strengths.items() if value == strength]
        return sorted(out)  # type: ignore[return-value]

    def neighbours(self, room: str, strength: str) -> List[str]:
        out = [
            next(iter(pair - {room}))
            for pair, value in self._strengths.items()
            if value == strength and room in pair and len(pair) == 2
        ]
        return sorted(out)

    def weight(self, room_a: str, room_b: str) -> float:
        """What satisfying this pair is worth. Zero when nothing was said,
        negative when the two were asked to stay apart."""
        strength = self.strength(room_a, room_b)
        return STRENGTH_WEIGHT.get(strength, 0.0) if strength else 0.0

    def weight_between(self, group_a: Iterable[str], group_b: Iterable[str]) -> float:
        group_b = list(group_b)
        return sum(self.weight(a, b) for a in group_a for b in group_b)

    # --- structure ---------------------------------------------------

    def clusters(self) -> List[List[str]]:
        """Rooms grouped by the must-edges they share.

        Contracting the hard constraints first is what keeps a placement
        decision from splitting a pair that was never allowed to split: the
        engine places clusters, and a cluster moves as one. Rooms with no
        must-edge are clusters of one. Ordering is deterministic -- by the
        program's own room order -- so the same brief always clusters the
        same way.
        """
        parent: Dict[str, str] = {room: room for room in self.rooms}

        def find(room: str) -> str:
            while parent[room] != room:
                parent[room] = parent[parent[room]]
                room = parent[room]
            return room

        for room_a, room_b in self.pairs("must"):
            root_a, root_b = find(room_a), find(room_b)
            if root_a != root_b:
                parent[root_b] = root_a

        grouped: Dict[str, List[str]] = {}
        for room in self.rooms:
            grouped.setdefault(find(room), []).append(room)
        return [grouped[root] for root in dict.fromkeys(find(room) for room in self.rooms)]

    # --- feasibility -------------------------------------------------

    def feasibility_problems(self) -> List[str]:
        """Requirements no rectangular floor plan can satisfy, in plain
        language, before any geometry is attempted.

        A plan of rectangular rooms is the rectangular dual of its adjacency
        graph, and a rectangular dual exists only for a planar graph. The
        full Koźmiński-Kinnen condition is stronger still -- a planar
        triangulation with no complex triangles -- but the cheap necessary
        half catches the case a brief actually runs into: too many rooms all
        required to touch each other.

        Reported per connected component so the message can name the rooms
        involved rather than the whole program.
        """
        problems: List[str] = []
        must_pairs = self.pairs("must")
        if not must_pairs:
            return problems

        adjacency: Dict[str, Set[str]] = {room: set() for room in self.rooms}
        for room_a, room_b in must_pairs:
            adjacency[room_a].add(room_b)
            adjacency[room_b].add(room_a)

        for component in _components(adjacency):
            vertices = len(component)
            edges = sum(1 for a, b in must_pairs if a in component and b in component)
            # A simple planar graph on v >= 3 vertices has at most 3v - 6
            # edges. More than that and no arrangement of rectangles can
            # give every pair a shared wall.
            if vertices >= 3 and edges > 3 * vertices - 6:
                named = ", ".join(sorted(component))
                problems.append(
                    f"{vertices} rooms ({named}) are all required to touch each other in "
                    f"{edges} pairs. No rectangular plan can do that -- at most "
                    f"{3 * vertices - 6} of those pairs can share a wall. Drop the least "
                    "important of them."
                )
        return problems

    # --- measuring the result ----------------------------------------

    def satisfaction(self, touching: Iterable[Tuple[str, str]]) -> AdjacencySatisfaction:
        """Score a finished layout against the brief.

        `touching` is every pair of rooms that actually shares a wall in the
        layout. This is the number that says whether the engine did what it
        was asked, and it is why the contract is worth having at all: with
        an ordering there was nothing to compare a result against.
        """
        touched = {frozenset(pair) for pair in touching if len(set(pair)) == 2}

        must = self.pairs("must")
        should = self.pairs("should")
        avoid = self.pairs("avoid")

        unmet = tuple(pair for pair in must if frozenset(pair) not in touched)
        violated = tuple(pair for pair in avoid if frozenset(pair) in touched)

        return AdjacencySatisfaction(
            must_total=len(must),
            must_met=len(must) - len(unmet),
            should_total=len(should),
            should_met=sum(1 for pair in should if frozenset(pair) in touched),
            avoid_total=len(avoid),
            avoid_violated=len(violated),
            unmet_must=unmet,
            violated_avoid=violated,
        )


def _components(adjacency: Dict[str, Set[str]]) -> List[Set[str]]:
    """Connected components of an undirected graph, isolated vertices
    dropped (a room with no must-edge constrains nothing)."""
    seen: Set[str] = set()
    out: List[Set[str]] = []
    for start in adjacency:
        if start in seen or not adjacency[start]:
            continue
        component: Set[str] = set()
        queue = [start]
        while queue:
            room = queue.pop()
            if room in component:
                continue
            component.add(room)
            queue.extend(adjacency[room] - component)
        seen |= component
        out.append(component)
    return out


def touching_pairs(rects_by_name: Dict[str, Tuple[float, float, float, float]],
                   tolerance: float = 1e-6) -> List[Tuple[str, str]]:
    """Every pair of named rectangles that shares a length of boundary.

    A corner touch doesn't count -- you cannot put a door on a point. Same
    rule `src.access` walks routes by, kept consistent here so "these two
    are adjacent" means one thing across the codebase.
    """
    out: List[Tuple[str, str]] = []
    for name_a, name_b in combinations(sorted(rects_by_name), 2):
        ax0, ay0, ax1, ay1 = rects_by_name[name_a]
        bx0, by0, bx1, by1 = rects_by_name[name_b]
        if abs(ax1 - bx0) < tolerance or abs(bx1 - ax0) < tolerance:
            if min(ay1, by1) - max(ay0, by0) > tolerance:
                out.append((name_a, name_b))
                continue
        if abs(ay1 - by0) < tolerance or abs(by1 - ay0) < tolerance:
            if min(ax1, bx1) - max(ax0, bx0) > tolerance:
                out.append((name_a, name_b))
    return out
