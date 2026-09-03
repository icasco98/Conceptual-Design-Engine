"""Choosing a layout, rather than accepting the first one the packer makes.

`src.layout` packs rectangles. It is good at geometry and has no opinion
about architecture: rooms go left-to-right in the order given, wrapping when
the next one doesn't fit, and until now a corridor was dropped into every
gap between rows whether or not anything needed it. Four rows bought you
three hallways; the count was decided by width arithmetic, never by need.

This module puts the judgement somewhere it can be checked. It packs many
candidate arrangements, thins the corridors out of each one, scores them all
against rules written down in `score_layout`, and returns the best. Claude
still decides which rooms belong together (`src.layout_plan`); nothing here
asks it anything. The architectural knowledge lives in a scoring function
that can be read, tested and argued with -- not in a prompt, and not buried
in the packer's arithmetic.

Two rules do most of the work:

  ACCESS is a hard constraint. A plan where the only way to a bedroom is
  through the garage is not a cheaper plan, it is a wrong one, and no amount
  of compactness buys it back (see `src.access`).

  CIRCULATION is a cost, not something to eliminate. Minimizing hallway on
  its own drives straight back to rooms entered through other rooms -- the
  very fault access forbids. So corridors are thinned only as far as access
  survives, and the score prefers plans landing in the band a house normally
  spends on circulation rather than the smallest number.

A multi-storey plan is scored as one building: every level's circulation
and compactness count, access is walked across the stair, and
`src.stacking` adds what one floor asks of the floor below it.
"""

from __future__ import annotations

from typing import NamedTuple

from src.access import access_problems_for, zone_of
from src.defaults import resolve_footprint
from src.geometry import BuildableEnvelope
from src.layout import LayoutResult, MultiLevelLayout, pack_levels, row_count
from src.layout_plan import LayoutPlan
from src.models import Project
from src.stacking import stacking_report

# Share of built area a house normally spends on circulation. Below the
# floor, rooms are usually being entered through other rooms; above the
# ceiling, plan is being wasted on corridor. Scored as a band rather than
# minimized, because "no hallway at all" is the failure mode this whole
# module exists to prevent.
CIRCULATION_TARGET_LOW = 0.08
CIRCULATION_TARGET_HIGH = 0.12

# How many candidate orderings to pack and score. Every candidate is a full
# pack plus a corridor-thinning pass, so this is the knob to turn if the
# recommendation ever feels slow.
MAX_CANDIDATES = 12


class ScoredLayout(NamedTuple):
    result: MultiLevelLayout
    placement_order: list[str]
    score: float
    access_problems: int
    circulation_ratio: float
    notes: str


def _built_area(result: LayoutResult) -> float:
    rooms = sum(r.width_m * r.depth_m for r in result.rooms)
    corridors = sum(c.width_m * c.depth_m for c in result.corridors)
    return rooms + corridors


def circulation_ratio(result: LayoutResult | MultiLevelLayout) -> float:
    """Corridor area as a share of everything built. The number to judge
    'is there too much hallway here' by."""
    levels = result.levels if isinstance(result, MultiLevelLayout) else [result]
    total = sum(_built_area(level) for level in levels)
    if total <= 0:
        return 0.0
    corridor = sum(c.width_m * c.depth_m for level in levels for c in level.corridors)
    return corridor / total


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


def _privacy_penalty(result: LayoutResult) -> float:
    """Private rooms should sit deeper into the plan than public ones.

    Measured as distance from the entry: a bedroom nearer the front door
    than the living room is the wrong way round. Scaled by the plan's own
    size so it means the same on any plot. An upper level has no entry and
    is already private by being upstairs, so it scores zero here.
    """
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
        if room.is_entry or room.room_type == "stair":
            continue
        distance = (abs(room.x_m + room.width_m / 2 - ex) + abs(room.y_m + room.depth_m / 2 - ey)) / scale
        zone = zone_of(room.room_type)
        if zone == "public":
            public.append(distance)
        elif zone == "private":
            private.append(distance)

    if not public or not private:
        return 0.0
    # Zero when the private rooms sit deeper than the public ones on
    # average; grows as that ordering inverts.
    return max(0.0, sum(public) / len(public) - sum(private) / len(private))


def _compactness_penalty(result: LayoutResult) -> float:
    built = _built_area(result)
    footprint = _footprint_area(result)
    if built > 0 and footprint > built:
        return (footprint - built) / built
    return 0.0


def score_layout(result: LayoutResult | MultiLevelLayout) -> tuple[float, int, float]:
    """Lower is better. Returns (score, access problem count, circulation
    ratio).

    The weights are deliberately in one place and deliberately blunt. Access
    dominates everything: no arrangement of rectangles is worth a plan you
    cannot walk through.
    """
    multi = result if isinstance(result, MultiLevelLayout) else MultiLevelLayout(levels=[result])
    problems = len(access_problems_for(multi))
    ratio = circulation_ratio(multi)

    score = 100.0 * problems

    if ratio < CIRCULATION_TARGET_LOW:
        score += 30.0 * (CIRCULATION_TARGET_LOW - ratio)
    elif ratio > CIRCULATION_TARGET_HIGH:
        score += 30.0 * (ratio - CIRCULATION_TARGET_HIGH)

    for level in multi.levels:
        score += 12.0 * _privacy_penalty(level)
        score += 8.0 * _compactness_penalty(level)

    if len(multi.levels) > 1:
        # An unstacked bathroom or a room hanging off the floor below costs
        # about as much as a badly placed private room: worth moving for,
        # never worth an access problem.
        score += 10.0 * stacking_report(multi).penalty

    return score, problems, ratio


def thin_corridors(
    project: Project,
    envelope: BuildableEnvelope,
    order: list[str],
) -> tuple[MultiLevelLayout, list[list[bool]]]:
    """Drop every corridor the plan doesn't actually need.

    Starts from one corridor in every gap on every level -- the most
    circulation, and the best access -- then tries removing them one at a
    time, keeping a removal only when the whole building's access check
    still comes back clean. What's left is the least hallway that still
    serves every room, which is the honest reading of "minimize
    circulation": corridors earn their floor area by being load-bearing for
    access, not by being cheap.
    """
    # One slot per row per level: the gap below it. The last slot sits past
    # the final row, which is what lets a single-row plan have a corridor.
    keep: list[list[bool]] = [
        [True] * row_count(project, envelope, order, level=level) for level in range(project.storeys)
    ]
    best = pack_levels(project, envelope, order, keep)
    baseline_problems = len(access_problems_for(best))

    for level in range(project.storeys):
        for index in range(len(keep[level])):
            trial = [list(gaps) for gaps in keep]
            trial[level][index] = False
            candidate = pack_levels(project, envelope, order, trial)
            if len(access_problems_for(candidate)) <= baseline_problems:
                keep = trial
                best = candidate

    return best, keep


def _candidate_orders(project: Project, plan: LayoutPlan | None) -> list[list[str]]:
    """Orderings worth packing.

    The plan's own ordering is always first, so Claude's grouping is the
    starting point rather than something this module overrides. The rest are
    systematic variations on it -- there is no search over every permutation,
    which for a dozen rooms would be millions of packs for a diagram nobody
    is waiting on.
    """
    names = [room.name for room in project.rooms]
    if not names:
        return []

    def dedupe(order: list[str]) -> list[str]:
        seen, out = set(), []
        for name in order:
            if name in names and name not in seen:
                seen.add(name)
                out.append(name)
        for name in names:
            if name not in seen:
                out.append(name)
        return out

    candidates: list[list[str]] = []
    if plan is not None and plan.placement_order:
        candidates.append(dedupe(plan.placement_order))
    candidates.append(dedupe(names))

    by_name = {room.name: room for room in project.rooms}

    def zone_key(name: str) -> int:
        room = by_name.get(name)
        if room is None:
            return 3
        if room.is_entry:
            return 0
        return {"public": 1, "private": 2, "service": 3}.get(zone_of(room.room_type), 3)

    base = candidates[0]
    # Entry, then public, then private, then service: the plain
    # public-to-private gradient, which is the arrangement most houses take.
    candidates.append(sorted(base, key=zone_key))
    # Same gradient, but service rooms brought to the front so they sit on
    # the street edge where a garage wants to be.
    candidates.append(sorted(base, key=lambda n: (0 if zone_key(n) == 0 else (1 if zone_key(n) == 3 else zone_key(n) + 1))))
    # Largest rooms first, then largest last: row wrapping is driven by
    # width, so size order changes which rooms end up sharing a row -- and
    # therefore what touches what.
    def area_of(name: str) -> float:
        room = by_name.get(name)
        if room is None:
            return 0.0
        # Resolved footprint, not the owner's explicit numbers: most rooms
        # never get an explicit size, so keying on those alone made every
        # room the same notional area and collapsed these two candidates
        # back onto the base ordering.
        footprint = resolve_footprint(room.room_type, room.explicit_width_m, room.explicit_depth_m)
        return footprint.width_m * footprint.depth_m

    candidates.append(sorted(base, key=lambda n: (zone_key(n) != 0, -area_of(n))))
    candidates.append(sorted(base, key=lambda n: (zone_key(n) != 0, area_of(n))))

    unique: list[list[str]] = []
    seen = set()
    for order in candidates:
        key = tuple(order)
        if key not in seen:
            seen.add(key)
            unique.append(order)
    return unique[:MAX_CANDIDATES]


def best_layout(
    project: Project,
    envelope: BuildableEnvelope,
    plan: LayoutPlan | None = None,
) -> ScoredLayout:
    """Pack several candidate arrangements, thin each one's corridors, score
    them all, and return the best.

    Deterministic: same project and plan in, same layout out. Ties break
    toward the earlier candidate, so the plan's own ordering wins whenever
    nothing scores better than it.
    """
    orders = _candidate_orders(project, plan)
    if not orders:
        result = pack_levels(project, envelope, plan.placement_order if plan else None)
        score, problems, ratio = score_layout(result)
        return ScoredLayout(result, [], score, problems, ratio, "no rooms to arrange")

    best: ScoredLayout | None = None
    for order in orders:
        result, _keep = thin_corridors(project, envelope, order)
        score, problems, ratio = score_layout(result)
        if best is None or score < best.score:
            best = ScoredLayout(
                result=result,
                placement_order=list(order),
                score=score,
                access_problems=problems,
                circulation_ratio=ratio,
                notes=_notes_for(problems, ratio, len(orders)),
            )
    assert best is not None
    return best


def _notes_for(problems: int, ratio: float, candidates: int) -> str:
    parts = [f"best of {candidates} arrangements"]
    if problems:
        parts.append(f"{problems} room{'s' if problems != 1 else ''} still awkward to reach")
    else:
        parts.append("every room reachable without passing through another")
    parts.append(f"circulation {ratio * 100:.0f}% of built area")
    return "; ".join(parts)
