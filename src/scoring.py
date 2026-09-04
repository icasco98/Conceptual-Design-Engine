"""Station 06, the judgement half: rank the candidates that passed.

Descends from the quadratic assignment problem: minimise flow times distance
over assignments. QAP is NP-hard, so this is ranking, not solving -- every
candidate the packer produced gets a number, lower is better, and the
smallest wins. The weights are deliberately in one place and deliberately
blunt; they encode what the sheet says a good house plan has:

  adjacency    every "should be near" pair, by the gap between them
  site         each room's outer walls against the site analysis's
               preferences: living toward the sun, bedrooms off the street,
               service on the poor side
  circulation  distance outside the 5-10% band -- not minimised, since
               "no hallway" is the failure mode the whole method exists to
               prevent
  privacy      how far the private rooms sit beyond the public ones
  compactness  unbuilt area inside the building's bounding box, and the
               difference in length between the two rows

Hard constraints never appear here. A plan the validator refused is not
scored lower; it is not scored.
"""

from __future__ import annotations

from typing import Sequence

from src.circulation import rect_gap
from src.site_analysis import SiteAnalysis
from src.validator import CIRCULATION_TARGET_HIGH, CIRCULATION_TARGET_LOW, ValidationReport
from src.zoning import ZoningPlan
from src.zoning_spec import Requirement

W_ADJACENCY = 5.0
W_SITE = 5.0
W_CIRCULATION = 40.0
W_PRIVACY = 1.0
W_COMPACT = 4.0
W_BALANCE = 2.0

# A "should be near" pair further apart than this is simply far; the
# penalty stops growing so one hopeless pair doesn't swamp everything.
FAR_M = 10.0

# How much a room's outer wall matters. The sheet's rule is "living spaces
# and the largest glazing toward the sun": a living room's aspect is the
# plan's biggest decision, a kitchen's a small one, a bathroom's none. The
# garage counts fully because its preference is the street, which it
# genuinely has to meet.
ASPECT_WEIGHT = {
    "living_room": 1.0,
    "family_room": 1.0,
    "dining_room": 0.7,
    "bedroom_primary": 0.8,
    "bedroom": 0.6,
    "office": 0.5,
    "kitchen": 0.3,
    "garage_single": 1.0,
    "garage_double": 1.0,
    "mudroom": 0.3,
    "entry": 0.0,
}
DEFAULT_ASPECT_WEIGHT = 0.2


def score_plan(
    plan: ZoningPlan,
    requirements: Sequence[Requirement],
    site: SiteAnalysis,
    report: ValidationReport,
) -> float:
    result = plan.result
    by_name = {r.name: r for r in result.rooms}
    score = 0.0

    for req in requirements:
        if req.strength != "should" or req.room not in by_name:
            continue
        gaps = [rect_gap(by_name[req.room].rect, by_name[o].rect) for o in req.options if o in by_name]
        if gaps:
            score += W_ADJACENCY * min(min(gaps), FAR_M) / FAR_M

    for room in result.rooms:
        if room.is_entry:
            continue
        prefs = site.preferences.get(room.zone, {})
        weight = ASPECT_WEIGHT.get(room.room_type, DEFAULT_ASPECT_WEIGHT)
        score -= W_SITE * weight * sum(prefs.get(edge, 0.0) for edge in plan.facing.get(room.name, ()))

    ratio = report.circulation_ratio
    if ratio < CIRCULATION_TARGET_LOW:
        score += W_CIRCULATION * (CIRCULATION_TARGET_LOW - ratio)
    elif ratio > CIRCULATION_TARGET_HIGH:
        score += W_CIRCULATION * (ratio - CIRCULATION_TARGET_HIGH)

    if report.public_depth is not None and report.private_depth is not None:
        score -= W_PRIVACY * (report.private_depth - report.public_depth)

    built = result.built_area_m2
    rects = [r.rect for r in result.rooms] + [c.rect for c in result.corridors]
    if built > 0 and rects:
        x0 = min(r[0] for r in rects)
        y0 = min(r[1] for r in rects)
        x1 = max(r[2] for r in rects)
        y1 = max(r[3] for r in rects)
        score += W_COMPACT * ((x1 - x0) * (y1 - y0) - built) / built

    longest = max(plan.column_lengths)
    if longest > 0:
        score += W_BALANCE * abs(plan.column_lengths[0] - plan.column_lengths[1]) / longest

    return score
