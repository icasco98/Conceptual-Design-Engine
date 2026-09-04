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
  survives, and the score prefers plans landing in a band rather than the
  smallest number. The band is measured against what one corridor crossing
  a plan of this size would cost, not as a fixed percentage, because that
  share falls as a house grows.

A multi-storey plan is scored as one building: every level's circulation
and compactness count, privacy is read across the whole house with a
storey counting as depth, access is walked across the stair, and
`src.stacking` adds what one floor asks of the floor below it.

Every term below access is normalised so that 1.0 means "one whole unit
wrong", and the weights are gathered at the top of this module so they can
be read against each other. That is not decoration. Three of them were
silently inert before it was done -- circulation capped at about three
points against terms worth twenty-five, privacy structurally unable to fire
on any two-storey house, and compactness measuring how finely each packer
traced its outline rather than how compact its building was -- and the
suite passed the whole time. A term that cannot change which plan wins is
worse than no term at all, because it reads as judgement that is not
happening. If you add one, prove it fires: `tests/test_planner.py` pins
each of these to a case where the wrong answer and the right one differ.
"""

from __future__ import annotations

import math
from typing import NamedTuple

from src.access import access_problems_for, zone_of
from src.defaults import resolve_footprint
from src.geometry import BuildableEnvelope
from src.layout import LayoutResult, MultiLevelLayout, pack_levels, row_count
from src.layout_plan import Adjacency, LayoutPlan, RoomAspect
from src.models import Project
from src.orientation import EAST, WEST, aspect_penalty, direction_for, street_penalty
from src.spine import pack_spine_levels
from src.stacking import stacking_report

# What a house spends on circulation, as a multiple of what one corridor
# across a compact plan of the same size would cost. Scored as a band
# rather than minimized, because "no hallway at all" is the failure mode
# this whole module exists to prevent.
#
# This used to be a fixed 8-12% of built area, and that band was
# unreachable. A corridor has to cross the building to serve it, so it
# costs about `hallway_width * sqrt(built_area)` at best -- roughly 11% of
# a 116 m2 floor, 13% of an 84 m2 one, 7% of a 300 m2 one. The share a
# corridor takes falls as a house grows, so a fixed percentage asks a small
# house for something its geometry cannot supply. Every plan on the sample
# project scored 18-21% against a 12% ceiling, every candidate was equally
# guilty, and the term decided nothing.
#
# Measuring against the one-corridor floor instead makes the number mean
# "how much more corridor than this plan strictly needs", which is the
# question worth asking and is comparable between a cottage and a villa.
CIRCULATION_TARGET_LOW = 1.0
CIRCULATION_TARGET_HIGH = 1.6

# Fallback corridor width for scoring a layout handed over without its
# project (the `project=None` path). The real width comes from
# `Project.hallway_width_m`; this only has to keep the floor finite.
DEFAULT_HALLWAY_WIDTH_M = 1.2

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

# What the tool's own preferences are worth, against the owner's stated
# ones above. All three are penalties normalised so that 1.0 means "one
# whole unit wrong" -- a circulation budget missed by 100%, a house whose
# private rooms sit a full plan-length nearer the door than its public
# ones, a floor with double the external wall of the square that would
# hold it -- so the weights can be read against each other directly.
#
# They sit below adjacency (40) and orientation (24) on purpose: what the
# owner asked for outranks what the tool would have preferred. And all of
# them sit far below access (100 each), which nothing buys back.
#
# Circulation leads them because it is the term this module exists for.
# It was previously scored as `30 * (ratio - 0.12)` -- an overshoot of a
# few hundredths of a ratio -- which capped the term at about 3 points
# against terms worth 10 to 25, and it never once changed which plan won.
CIRCULATION_WEIGHT = 20.0
PRIVACY_WEIGHT = 12.0
COMPACTNESS_WEIGHT = 8.0

# What it costs to stack storeys badly. Two faults, priced apart, because
# they are not the same kind of wrong.
#
# Plumbing that does not stack is an ordinary cost: the bathroom needs its
# own run down through the floor below. Worth moving a room for, not worth
# overruling what the owner asked for, so it sits with privacy -- which is
# where this term's original comment always said it belonged.
#
# A floor that does not land on the floor beneath it is a different order
# of problem. It has to be held up by structure this stage of design has
# not thought about, and the spine packer produced a study 73% out over
# nothing on the sample project. That outranks every preference, stated or
# otherwise, and still costs less than half of one room you cannot reach.
#
# Both read against means in 0..1, so neither grows just because a house
# has more bedrooms in it. Together they used to be one sum at weight 10,
# which reached 24 points on the sample and was quietly the largest term
# in the scorer -- larger than every pairing and sun wish combined.
UNSTACKED_PLUMBING_WEIGHT = 12.0
OVERHANG_WEIGHT = 35.0

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
    # Which packing strategy produced it. Worth carrying: the two make
    # visibly different houses, and 'why does this one look like that'
    # deserves a better answer than silence.
    strategy: str = "rows"


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


def circulation_floor(result: LayoutResult | MultiLevelLayout, hallway_width_m: float) -> float:
    """The least circulation this much house can have, as a share of built
    area.

    A corridor has to cross the building to serve it. On a compact floor of
    area A that crossing is about sqrt(A) long, so it costs roughly
    `hallway_width * sqrt(A)` -- and as a *share* of A that falls as the
    house grows. This is why a fixed percentage band was the wrong shape:
    11% is the floor for a 116 m2 storey and 7% for a 300 m2 one, so one
    number cannot describe both.
    """
    levels = result.levels if isinstance(result, MultiLevelLayout) else [result]
    areas = [_built_area(level) for level in levels]
    built = sum(areas)
    if built <= 0:
        return 0.0
    ideal = sum(hallway_width_m * math.sqrt(area) for area in areas if area > 0)
    return ideal / built


def circulation_penalty(result: LayoutResult | MultiLevelLayout, hallway_width_m: float) -> float:
    """How far outside the band this plan sits, in multiples of the floor.

    0.0 anywhere inside the band. Above it the number is "how many extra
    corridors' worth of plan is being spent", which is a thing you can
    picture; below it, how far short of serving the house the corridors
    fall. Unlike the old fixed percentages this is comparable between a
    cottage and a villa, and unlike them it is reachable -- so it can
    actually separate two candidates instead of condemning all of them
    equally.
    """
    floor = circulation_floor(result, hallway_width_m)
    if floor <= 0:
        return 0.0
    multiple = circulation_ratio(result) / floor
    if multiple < CIRCULATION_TARGET_LOW:
        return CIRCULATION_TARGET_LOW - multiple
    if multiple > CIRCULATION_TARGET_HIGH:
        return multiple - CIRCULATION_TARGET_HIGH
    return 0.0


# What one storey is worth as privacy, in units of plan distance. Climbing
# a flight of stairs separates a bedroom from the front door about as well
# as putting it at the far end of the house does, and plan distances here
# are normalised so that the far end is 1.0.
STOREY_DEPTH = 1.0


def _privacy_penalty(multi: MultiLevelLayout) -> float:
    """Private rooms should sit deeper into the house than public ones.

    Measured as distance from the entry: a bedroom nearer the front door
    than the living room is the wrong way round. Scaled by the plan's own
    size so it means the same on any plot.

    Scored across the whole building rather than a level at a time, which
    is what this used to do and the reason it never once fired. A level was
    scored only if it held an entry *and* public rooms *and* private ones.
    The ordinary house -- bedrooms upstairs, front door and living rooms
    down -- satisfies that on no level at all: the ground floor has the
    entry and the public rooms but no private ones, and the upper floor has
    the private rooms but no entry. Both returned zero, so a 12-point term
    contributed nothing to any multi-storey plan the tool has ever scored,
    and a plan that put a bedroom beside the front door was charged
    nothing for it.

    Reading the building as one thing fixes that, and it needs storeys to
    count as depth -- otherwise a bedroom directly above the front door
    looks as exposed as one beside it, when in fact the stair between them
    is most of what privacy upstairs means.
    """
    rooms = [(level_index, room) for level_index, level in enumerate(multi.levels) for room in level.rooms]
    entry = next(((i, r) for i, r in rooms if r.is_entry), None)
    if entry is None or not rooms:
        return 0.0
    entry_level, entry_room = entry
    ex = entry_room.x_m + entry_room.width_m / 2
    ey = entry_room.y_m + entry_room.depth_m / 2

    spans = [abs(r.x_m - ex) + abs(r.y_m - ey) for _, r in rooms]
    scale = max(spans) if spans else 0.0
    if scale <= 0:
        return 0.0

    public: list[float] = []
    private: list[float] = []
    for level_index, room in rooms:
        if room.is_entry or room.room_type == "stair":
            continue
        plan_distance = (
            abs(room.x_m + room.width_m / 2 - ex) + abs(room.y_m + room.depth_m / 2 - ey)
        ) / scale
        distance = plan_distance + STOREY_DEPTH * abs(level_index - entry_level)
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


def _perimeter(pts: list[tuple[float, float]]) -> float:
    if len(pts) < 3:
        return 0.0
    return sum(math.dist(pts[i], pts[(i + 1) % len(pts)]) for i in range(len(pts)))


def _compactness_penalty(result: LayoutResult) -> float:
    """How much external wall this floor buys per unit of floor area.

    Zero for a perfect square; grows as the plan sprawls, wings out, or
    leaves notches between bays. External wall is what a compact plan is
    actually saving -- it is the cost to build and the surface to heat --
    so measuring it directly says what "compact" was always meant to mean.

    This replaces a measure that compared the traced footprint's *area*
    against the built area, which turned out to be measuring the packers
    rather than the buildings. The spine packer traces its outline around
    every jog of every bay -- 25 points on the sample's ground floor -- so
    its footprint area equalled its built area exactly and the penalty came
    out 0.000 however ragged the plan was. The row packer traces a coarse
    7-point outline that swallows its own gaps, so it was charged 0.122 for
    the same sprawl. Finer tracing was rewarded and the two strategies were
    never compared on the same terms.

    Perimeter inverts that by construction: a ragged outline has *more*
    perimeter, not less, so following every jog costs rather than pays. On
    the sample the spine ground floor goes from a free 0.000 to 0.585 --
    the worst of the four floors, which is what its bays deserve.

    Normalised against the square of equal area (perimeter 4*sqrt(A)), the
    most compact shape there is, so the number means the same on any plot.
    """
    built = _built_area(result)
    perimeter = _perimeter(result.footprint)
    if built <= 0 or perimeter <= 0:
        return 0.0
    return max(0.0, perimeter / (4.0 * math.sqrt(built)) - 1.0)


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

    hallway = project.hallway_width_m if project is not None else DEFAULT_HALLWAY_WIDTH_M
    score += CIRCULATION_WEIGHT * circulation_penalty(multi, hallway)

    score += PRIVACY_WEIGHT * _privacy_penalty(multi)
    for level in multi.levels:
        score += COMPACTNESS_WEIGHT * _compactness_penalty(level)

    if adjacencies:
        score += ADJACENCY_WEIGHT * adjacency_penalty(multi, adjacencies)

    if orientations and project is not None:
        score += ORIENTATION_WEIGHT * orientation_penalty(multi, project, orientations)

    if len(multi.levels) > 1:
        stacking = stacking_report(multi)
        score += UNSTACKED_PLUMBING_WEIGHT * stacking.wet_penalty
        score += OVERHANG_WEIGHT * stacking.overhang_penalty

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
    attempts = 0
    for order in orders:
        # Both strategies, same ordering, same scoring rules. Rows vary a
        # plan left to right and spines vary it front to back, so which one
        # wins depends on what was actually asked for -- which is the whole
        # point of having two.
        rows_result, _keep = thin_corridors(project, envelope, order)
        packings: list[tuple[str, MultiLevelLayout]] = [("rows", rows_result)]
        spine_result = pack_spine_levels(project, envelope, order)
        if spine_result is not None:
            packings.append(("spine", spine_result))

        for strategy, result in packings:
            attempts += 1
            score, problems, ratio = score_layout(result, adjacencies, project, orientations)
            if best is None or score < best.score:
                best = ScoredLayout(
                    result=result,
                    placement_order=list(order),
                    score=score,
                    access_problems=problems,
                    circulation_ratio=ratio,
                    notes="",
                    strategy=strategy,
                )
    if best is not None:
        best = best._replace(
            notes=_notes_for(best.access_problems, best.circulation_ratio, attempts, best.strategy)
        )
    assert best is not None
    return best


def _notes_for(problems: int, ratio: float, candidates: int, strategy: str = "rows") -> str:
    shape = "rooms either side of a central corridor" if strategy == "spine" else "rooms in rows"
    parts = [f"best of {candidates} arrangements", shape]
    if problems:
        parts.append(f"{problems} room{'s' if problems != 1 else ''} still awkward to reach")
    else:
        parts.append("every room reachable without passing through another")
    parts.append(f"circulation {ratio * 100:.0f}% of built area")
    return "; ".join(parts)
