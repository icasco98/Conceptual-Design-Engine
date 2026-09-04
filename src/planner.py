"""Choosing a layout, and saying how well it answered the brief.

`src.place` arranges rooms against the adjacency graph. This module decides
which arrangement to show and scores it against rules written down here,
where they can be read, tested and argued with -- not in a prompt, and not
buried in the geometry.

The scoring order is the architecture, and it is deliberate:

  ACCESS is a hard constraint. A plan where the only way to a bedroom is
  through the garage is not a cheaper plan, it is a wrong one, and no amount
  of compactness or satisfied preference buys it back (see `src.access`).

  REQUIRED ADJACENCY is next. A brief that says the ensuite opens off the
  primary bedroom has not been answered by a plan that puts them on opposite
  sides of the house, however tidy the rectangles are. This is the term the
  old pipeline could not have: with a room ordering as its only input there
  was nothing to check a result against, so "did it do what was asked" was
  unanswerable and every other score was measuring the wrong thing well.

  SEPARATION comes with it -- an `avoid` pair sharing a wall is a stated
  objection ignored, weighted below a missing `must` but above any
  preference.

  CIRCULATION is a cost, not something to eliminate. Driving hallway to zero
  leads straight back to rooms entered through other rooms, the very fault
  access forbids, so it is scored against the band a house normally spends
  rather than minimised.

  PREFERENCE, PRIVACY DEPTH and COMPACTNESS are tie-breakers, in that order.
  They decide between plans that already answer the brief; they never
  outrank it.

Candidates are structures -- which axis the spine runs along, which zone
claims the street end -- not room orderings. A structure is a decision that
can be named in the rationale; an ordering never was.
"""

from __future__ import annotations

from typing import Dict, List, NamedTuple, Optional, Tuple

from src.access import access_problems_for, zone_of
from src.adjacency import AdjacencyGraph, AdjacencySatisfaction, touching_pairs
from src.geometry import BuildableEnvelope
from src.layout import LayoutResult
from src.layout_plan import LayoutPlan
from src.models import Project
from src.place import (
    Structure,
    build_cells,
    candidate_structures,
    instances_by_base,
    place_rooms,
    respects_minimums,
)

# Share of built area a house normally spends on circulation. Below the
# floor, rooms are usually being entered through other rooms; above the
# ceiling, plan is being wasted on corridor.
CIRCULATION_TARGET_LOW = 0.05
CIRCULATION_TARGET_HIGH = 0.12

# Weights. All in one place, all blunt on purpose. The ordering between them
# matters far more than the exact values, and the ordering is the one set out
# in the module docstring.
W_ACCESS = 100.0
W_UNMET_MUST = 25.0
W_BROKEN_AVOID = 10.0
W_CIRCULATION = 30.0
W_UNMET_SHOULD = 3.0
W_PRIVACY = 12.0
W_SPRAWL = 8.0


class ScoredLayout(NamedTuple):
    result: LayoutResult
    score: float
    access_problems: int
    circulation_ratio: float
    adjacency: AdjacencySatisfaction
    structure: Optional[Structure]
    notes: str


def build_graph(project: Project, plan: Optional[LayoutPlan] = None) -> AdjacencyGraph:
    """The adjacency graph for a project, as stated by Claude.

    Room instances, not program names: a rule about "Bedroom" reaches
    "Bedroom 1" and "Bedroom 2" through `instances_by_base`. An absent or
    empty plan gives an empty graph, which is a legitimate brief -- it just
    leaves the engine free to optimise for everything else.
    """
    names = [cell.name for cell in build_cells(project)]
    rules = plan.adjacency if plan is not None else []
    return AdjacencyGraph.from_rules(names, rules, instances_by_base(project))


def _built_area(result: LayoutResult) -> float:
    rooms = sum(r.width_m * r.depth_m for r in result.rooms)
    corridors = sum(c.width_m * c.depth_m for c in result.corridors)
    return rooms + corridors


def circulation_ratio(result: LayoutResult) -> float:
    """Corridor area as a share of everything built."""
    total = _built_area(result)
    if total <= 0:
        return 0.0
    return sum(c.width_m * c.depth_m for c in result.corridors) / total


def _footprint_area(result: LayoutResult) -> float:
    """Shoelace area of the building outline -- includes the gaps between
    wings, so a sprawling plan scores worse than a compact one of the same
    room area."""
    pts = result.footprint
    if len(pts) < 3:
        return 0.0
    total = 0.0
    for i in range(len(pts)):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % len(pts)]
        total += x0 * y1 - x1 * y0
    return abs(total) / 2


def room_rects(result: LayoutResult) -> Dict[str, Tuple[float, float, float, float]]:
    return {
        room.name: (room.x_m, room.y_m, room.x_m + room.width_m, room.y_m + room.depth_m)
        for room in result.rooms
    }


def adjacency_satisfaction(result: LayoutResult, graph: AdjacencyGraph) -> AdjacencySatisfaction:
    """Which of the brief's stated adjacencies the layout actually built."""
    return graph.satisfaction(touching_pairs(room_rects(result)))


def _privacy_penalty(result: LayoutResult) -> float:
    """Private rooms should sit deeper into the plan than public ones,
    measured from the entry. Scaled by the plan's own size so it means the
    same on any plot."""
    entry = next((r for r in result.rooms if r.is_entry), None)
    if entry is None or not result.rooms:
        return 0.0
    ex, ey = entry.x_m + entry.width_m / 2, entry.y_m + entry.depth_m / 2

    spans = [abs(r.x_m - ex) + abs(r.y_m - ey) for r in result.rooms]
    scale = max(spans) if spans else 1.0
    if scale <= 0:
        return 0.0

    public, private = [], []
    for room in result.rooms:
        if room.is_entry:
            continue
        distance = (abs(room.x_m + room.width_m / 2 - ex) + abs(room.y_m + room.depth_m / 2 - ey)) / scale
        zone = zone_of(room.room_type)
        if zone == "public":
            public.append(distance)
        elif zone == "private":
            private.append(distance)

    if not public or not private:
        return 0.0
    return max(0.0, sum(public) / len(public) - sum(private) / len(private))


def score_layout(
    result: LayoutResult, graph: Optional[AdjacencyGraph] = None
) -> Tuple[float, int, float, AdjacencySatisfaction]:
    """Lower is better. Returns (score, access problems, circulation ratio,
    adjacency satisfaction)."""
    graph = graph or AdjacencyGraph([room.name for room in result.rooms])
    satisfaction = adjacency_satisfaction(result, graph)
    problems = len(access_problems_for(result))
    ratio = circulation_ratio(result)

    score = W_ACCESS * problems
    score += W_UNMET_MUST * (satisfaction.must_total - satisfaction.must_met)
    score += W_BROKEN_AVOID * satisfaction.avoid_violated

    if ratio < CIRCULATION_TARGET_LOW:
        score += W_CIRCULATION * (CIRCULATION_TARGET_LOW - ratio)
    elif ratio > CIRCULATION_TARGET_HIGH:
        score += W_CIRCULATION * (ratio - CIRCULATION_TARGET_HIGH)

    score += W_UNMET_SHOULD * (satisfaction.should_total - satisfaction.should_met)
    score += W_PRIVACY * _privacy_penalty(result)

    built = _built_area(result)
    footprint = _footprint_area(result)
    if built > 0 and footprint > built:
        score += W_SPRAWL * ((footprint - built) / built)

    return score, problems, ratio, satisfaction


def best_layout(
    project: Project,
    envelope: BuildableEnvelope,
    plan: Optional[LayoutPlan] = None,
) -> ScoredLayout:
    """Lay the program out every way `src.place` offers and keep the best.

    Deterministic: same project and plan in, same layout out. Structures
    whose rooms had to be shrunk below their own minimums to fit are dropped
    before scoring -- the score has no term for an undersized room, so they
    would otherwise compete as though they were buildable -- and only used
    if nothing fits at all, a case `src.validation` has already reported.
    """
    graph = build_graph(project, plan)

    laid: List[Tuple[Structure, LayoutResult]] = []
    for structure in candidate_structures():
        result = place_rooms(project, envelope, graph, structure)
        if result.rooms:
            laid.append((structure, result))

    if not laid:
        empty = place_rooms(project, envelope, graph)
        score, problems, ratio, satisfaction = score_layout(empty, graph)
        return ScoredLayout(empty, score, problems, ratio, satisfaction, None, "no rooms to arrange")

    buildable = [pair for pair in laid if respects_minimums(pair[1])] or laid

    best: Optional[ScoredLayout] = None
    for structure, result in buildable:
        score, problems, ratio, satisfaction = score_layout(result, graph)
        if best is None or score < best.score:
            best = ScoredLayout(
                result=result,
                score=score,
                access_problems=problems,
                circulation_ratio=ratio,
                adjacency=satisfaction,
                structure=structure,
                notes=_notes_for(problems, ratio, satisfaction, len(buildable), structure),
            )
    assert best is not None
    return best


def _notes_for(
    problems: int,
    ratio: float,
    satisfaction: AdjacencySatisfaction,
    candidates: int,
    structure: Structure,
) -> str:
    parts = [f"best of {candidates} arrangements", structure.label]
    if problems:
        parts.append(f"{problems} room{'s' if problems != 1 else ''} still awkward to reach")
    else:
        parts.append("every room reachable without passing through another")
    if satisfaction.must_total or satisfaction.should_total:
        parts.append(satisfaction.summary())
    parts.append(f"circulation {ratio * 100:.0f}% of built area")
    return "; ".join(parts)
