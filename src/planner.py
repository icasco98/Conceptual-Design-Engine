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
from src.layout_plan import Adjacency, LayoutPlan, RoomAspect
from src.models import Project
from src.orientation import EAST, WEST, aspect_penalty, direction_for, street_penalty
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

# What a room pairing is worth. Scored as a mean rather than a sum, so ten
# mild wishes cannot add up to more than one emphatic one.
#
# The size is chosen against the other terms, not in isolation. A strong
# pairing has to be able to overrule compactness and privacy -- those are
# the tool's own preferences, and a pairing is something the owner actually
# asked for -- while never approaching access. At this weight the worst
# possible adjacency score is 80, so a plan can be dragged a long way out of
# its neatest shape to honour a request, and still never far enough to buy a
# room you cannot reach (100 each). Set it lower and the term is decorative:
# at 16 it lost to a 7-point compactness gap on the sample project, which is
# how this number was found.
ADJACENCY_WEIGHT = 40.0
STRENGTH_FACTOR = {"strong": 2.0, "mild": 1.0}

# What a stated preference about sun or street is worth. Below adjacency:
# "put the kitchen next to the dining room" is a harder requirement than
# "some morning light would be nice", and an owner who means the second
# more strongly than the first will say so and get an adjacency instead.
ORIENTATION_WEIGHT = 24.0

# How far apart "apart" means, as a share of the plan's own reach. Beyond
# this the pairing is satisfied and stops pulling; without a ceiling, a
# scorer would happily wreck a plan to push two rooms one metre further
# from each other.
APART_TARGET = 0.5


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


def _room_centres(multi: MultiLevelLayout) -> dict[str, tuple[float, float, int]]:
    """Every placed room's centre, by base name, with the level it sits on.

    Counted rooms ("Bedroom 1", "Bedroom 2") are placed under numbered
    names but asked for under the base one, so a pairing that names
    "Bedroom" should find them. The first placement wins: pairing a
    three-bedroom cluster against the kitchen means the cluster, and any of
    them stands for it well enough to score.
    """
    centres: dict[str, tuple[float, float, int]] = {}
    for level_index, level in enumerate(multi.levels):
        for room in level.rooms:
            centre = (room.x_m + room.width_m / 2, room.y_m + room.depth_m / 2, level_index)
            centres.setdefault(room.name, centre)
            centres.setdefault(room.base_name, centre)
    return centres


def _plan_reach(multi: MultiLevelLayout) -> float:
    """The plan's own diagonal, so a distance means the same on any plot."""
    reach = 0.0
    for level in multi.levels:
        for room in level.rooms:
            reach = max(reach, abs(room.x_m) + room.width_m, abs(room.y_m) + room.depth_m)
    return reach or 1.0


def adjacency_penalty(multi: MultiLevelLayout, adjacencies: list[Adjacency]) -> float:
    """How badly this arrangement ignores the pairings that were asked for.

    Zero when every pairing is honoured. Distance is measured between room
    centres and scaled by the plan's own reach, so the number means the
    same on a small plot as a large one.

    Storeys count. Two rooms asked to be near each other on different
    floors are as far apart as this plan can put them, whatever their plan
    coordinates say; two asked to be apart are satisfied by the stair alone.
    """
    if not adjacencies:
        return 0.0
    centres = _room_centres(multi)
    reach = _plan_reach(multi)

    penalties: list[float] = []
    for pair in adjacencies:
        a = centres.get(pair.room_a)
        b = centres.get(pair.room_b)
        if a is None or b is None or pair.room_a == pair.room_b:
            continue  # A room that was never placed cannot be scored.
        factor = STRENGTH_FACTOR.get(pair.strength, 1.0)
        if a[2] != b[2]:
            penalties.append(factor if pair.relation == "near" else 0.0)
            continue
        distance = min(1.0, (abs(a[0] - b[0]) + abs(a[1] - b[1])) / reach)
        if pair.relation == "near":
            penalties.append(factor * distance)
        else:
            penalties.append(factor * max(0.0, APART_TARGET - distance) / APART_TARGET)

    if not penalties:
        return 0.0
    return sum(penalties) / len(penalties)


def orientation_penalty(
    multi: MultiLevelLayout,
    project: Project,
    orientations: list[RoomAspect],
) -> float:
    """How badly this arrangement ignores what the owner said about sun and
    street. Zero when every wish is as well served as the plan allows.

    Each wish is scored on the level its room sits on: a room is east or
    west of the rooms it shares a floor with, and comparing it to a floor
    it is not on would be meaningless.
    """
    if not orientations:
        return 0.0
    rotation = project.site.rotation_deg
    penalties: list[float] = []
    for wish in orientations:
        for level in multi.levels:
            if not any(wish.room_name in (r.name, r.base_name) for r in level.rooms):
                continue
            if wish.wants == "off_the_street":
                penalties.append(street_penalty(level, wish.room_name, project.site))
            else:
                bearing = EAST if wish.wants == "morning_sun" else WEST
                penalties.append(aspect_penalty(level, wish.room_name, direction_for(rotation, bearing)))
            break
    if not penalties:
        return 0.0
    return sum(penalties) / len(penalties)


def _compactness_penalty(result: LayoutResult) -> float:
    built = _built_area(result)
    footprint = _footprint_area(result)
    if built > 0 and footprint > built:
        return (footprint - built) / built
    return 0.0


def score_layout(
    result: LayoutResult | MultiLevelLayout,
    adjacencies: list[Adjacency] | None = None,
    project: Project | None = None,
    orientations: list[RoomAspect] | None = None,
) -> tuple[float, int, float]:
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

    if adjacencies:
        score += ADJACENCY_WEIGHT * adjacency_penalty(multi, adjacencies)

    if orientations and project is not None:
        score += ORIENTATION_WEIGHT * orientation_penalty(multi, project, orientations)

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

    # Scoring a pairing is worth nothing if no candidate ever puts the pair
    # together: the scorer can only choose between the arrangements it is
    # shown. So build one that does, by walking the "near" pairings as a
    # graph and laying each connected cluster down in one run.
    if plan is not None and plan.adjacencies:
        clustered = _cluster_by_adjacency(base, plan.adjacencies)
        candidates.append(clustered)
        candidates.append(sorted(clustered, key=lambda n: zone_key(n) != 0))

    unique: list[list[str]] = []
    seen = set()
    for order in candidates:
        key = tuple(order)
        if key not in seen:
            seen.add(key)
            unique.append(order)
    return unique[:MAX_CANDIDATES]


def _cluster_by_adjacency(order: list[str], adjacencies: list[Adjacency]) -> list[str]:
    """The same rooms, reordered so rooms asked to be near each other are
    consecutive.

    Union-find over the "near" pairings, strong ones first so that when a
    room is wanted next to two different clusters the stronger claim wins.
    Rooms nobody paired keep their original position relative to the
    clusters, and the entry stays wherever the incoming order had it.
    """
    parent = {name: name for name in order}

    def find(name: str) -> str:
        while parent[name] != name:
            parent[name] = parent[parent[name]]
            name = parent[name]
        return name

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    near = [p for p in adjacencies if p.relation == "near"]
    for pair in sorted(near, key=lambda p: 0 if p.strength == "strong" else 1):
        if pair.room_a in parent and pair.room_b in parent and pair.room_a != pair.room_b:
            union(pair.room_a, pair.room_b)

    # Clusters come out in the order their first member appears, and members
    # keep their original order inside a cluster: this reorders the plan as
    # little as clustering allows.
    clusters: dict[str, list[str]] = {}
    for name in order:
        clusters.setdefault(find(name), []).append(name)
    out: list[str] = []
    for name in order:
        root = find(name)
        if root in clusters:
            out.extend(clusters.pop(root))
    return out


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
        score, problems, ratio = score_layout(
            result, plan.adjacencies if plan else [], project, plan.orientations if plan else []
        )
        return ScoredLayout(result, [], score, problems, ratio, "no rooms to arrange")

    adjacencies = plan.adjacencies if plan else []
    orientations = plan.orientations if plan else []
    best: ScoredLayout | None = None
    for order in orders:
        result, _keep = thin_corridors(project, envelope, order)
        score, problems, ratio = score_layout(result, adjacencies, project, orientations)
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
