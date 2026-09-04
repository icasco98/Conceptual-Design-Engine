"""The pipeline, stations 02 to 07, run end to end.

    site analysis -> instances -> feasibility gate -> candidates
                  -> validate each -> score the survivors -> best

`design` is the only thing the app calls. It takes the project, its
buildable envelope and the specification (Claude's, or the rule-based
default) and returns a `DesignOutcome`: the chosen plan, what was decided
about the site, whether the brief had to be relaxed to be buildable, and
the plain-language account of the result. Nothing in here asks Claude
anything -- everything past the seam is arithmetic.

The outcome is graded rather than binary, because an owner staring at an
empty canvas learns nothing:

  ok           a plan passed every hard constraint
  relaxed      the brief as stated could not be built (the feasibility gate
               named the adjacency); it was relaxed to "should" and a plan
               that passes was found
  compromised  no candidate passes everything; the one failing least is
               shown, with its failures listed
  rejected     nothing could be packed at all
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Tuple

from src.feasibility import FeasibilityReport, check_feasibility
from src.geometry import BuildableEnvelope
from src.models import Project
from src.scoring import score_plan
from src.site_analysis import SiteAnalysis, analyse_site
from src.validator import ValidationReport, validate_plan
from src.zoning import Frame, ZoningPlan, generate_candidates
from src.zoning_spec import (
    AdjacencyRequirement,
    Requirement,
    ZoningSpec,
    apart_pairs,
    expand_program,
    expand_requirements,
    must_pairs,
)


@dataclass(frozen=True)
class DesignOutcome:
    status: str  # ok | relaxed | compromised | rejected
    plan: Optional[ZoningPlan]
    site: SiteAnalysis
    feasibility: FeasibilityReport
    validation: Optional[ValidationReport]
    spec: ZoningSpec
    title: str
    rationale: str
    messages: List[str] = field(default_factory=list)
    candidates: int = 0
    passing: int = 0

    @property
    def has_plan(self) -> bool:
        return self.plan is not None


def _relax(spec: ZoningSpec, offending: List[Tuple[str, str]]) -> ZoningSpec:
    """Turn the must pairs the gate named into 'should', by base name, so
    the brief becomes buildable with the least change."""
    adjacencies: List[AdjacencyRequirement] = []
    for adj in spec.adjacencies:
        adjacencies.append(adj)
    bad: set = set()
    for a, b in offending:
        bad.add(frozenset((_base(a), _base(b))))
    relaxed = [
        adj.model_copy(update={"strength": "should"})
        if adj.strength == "must" and frozenset((adj.room_a, adj.room_b)) in bad
        else adj
        for adj in adjacencies
    ]
    return spec.model_copy(update={"adjacencies": relaxed})


def _base(instance_name: str) -> str:
    """'Bedroom 2' -> 'Bedroom'; names without a trailing count are unchanged."""
    parts = instance_name.rsplit(" ", 1)
    if len(parts) == 2 and parts[1].isdigit():
        return parts[0]
    return instance_name


def design(project: Project, envelope: BuildableEnvelope, spec: ZoningSpec) -> DesignOutcome:
    site = analyse_site(project)
    messages: List[str] = []

    instances, notes = expand_program(project, spec)
    messages.extend(notes)
    if not instances:
        return DesignOutcome(
            status="rejected", plan=None, site=site, feasibility=FeasibilityReport(True), validation=None,
            spec=spec, title="Zoning diagram", rationale="", messages=["No rooms to place yet."],
        )

    requirements = expand_requirements(spec, instances)
    gate = check_feasibility(must_pairs(requirements), apart_pairs(requirements))
    status = "ok"
    if not gate.feasible:
        status = "relaxed"
        spec = _relax(spec, gate.offending)
        requirements = expand_requirements(spec, instances)
        messages.extend(gate.problems)
        messages.append(
            "Those requirements were relaxed to 'should be near' so a plan could be drawn; "
            "say which to drop and the diagram will follow."
        )

    frame = Frame(envelope, site.entry_edge)
    generation = generate_candidates(instances, requirements, frame, project.hallway_width_m)
    if not generation.plans:
        return DesignOutcome(
            status="rejected", plan=None, site=site, feasibility=gate, validation=None, spec=spec,
            title="Zoning diagram", rationale="", messages=messages + generation.problems,
        )

    scored: List[Tuple[float, int, ZoningPlan, ValidationReport]] = []
    for index, plan in enumerate(generation.plans):
        report = validate_plan(plan, requirements, envelope)
        score = score_plan(plan, requirements, site, report)
        scored.append((score, index, plan, report))

    passing = [s for s in scored if s[3].passed]
    if passing:
        best = min(passing, key=lambda s: (s[0], s[1]))
    else:
        status = "compromised"
        best = min(scored, key=lambda s: (len(s[3].failures), s[0], s[1]))
        messages.append("No arrangement satisfies every rule; the closest is shown, and this is what it breaks:")
        messages.extend(best[3].failures)

    _, _, plan, report = best
    return DesignOutcome(
        status=status,
        plan=plan,
        site=site,
        feasibility=gate,
        validation=report,
        spec=spec,
        title=plan_title(plan),
        rationale=explain_plan(plan, report, site, spec, requirements),
        messages=messages,
        candidates=len(generation.plans),
        passing=len(passing),
    )


def plan_title(plan: ZoningPlan) -> str:
    return "Zoned by privacy — public, private, service"


def _verb(rooms: List[str], verb: str) -> str:
    """'meets' for one room, 'meet' for several."""
    if len(rooms) != 1:
        return verb
    return verb + ("es" if verb.endswith(("s", "sh", "ch")) else "s")


def _names(rooms: List[str]) -> str:
    if not rooms:
        return ""
    if len(rooms) == 1:
        return rooms[0]
    return ", ".join(rooms[:-1]) + " and " + rooms[-1]


def explain_plan(
    plan: ZoningPlan,
    report: ValidationReport,
    site: SiteAnalysis,
    spec: ZoningSpec,
    requirements: List[Requirement],
) -> str:
    """The plan in plain language, composed from what was actually decided
    -- never from a template that could drift from the drawing."""
    rooms = plan.result.rooms
    entry = next((r for r in rooms if r.is_entry), None)
    sentences: List[str] = []

    if entry is not None:
        sentences.append(f"The {entry.name.lower()} meets the street on the {plan.entry_edge} edge")
        if plan.corridor_needed:
            sentences[-1] += " and a hall runs back from it with rooms either side."
        else:
            sentences[-1] += "; every room opens off it or off a room beside it, so no hall is needed."

    public = [r.name for r in rooms if r.zone == "public" and not r.is_entry]
    private = [r.name for r in rooms if r.zone == "private"]
    service = [r.name for r in rooms if r.zone == "service"]

    sun_rooms = []
    if site.sun_edge:
        sun_rooms = [
            r.name for r in rooms
            if r.zone == "public" and not r.is_entry and site.sun_edge in plan.facing.get(r.name, ())
        ]
    street_public = [n for n in public if plan.entry_edge in plan.facing.get(n, ())]
    if sun_rooms:
        sentences.append(f"{_names(sun_rooms)} {_verb(sun_rooms, 'face')} the {site.sun_edge} edge for the sun.")
    elif street_public:
        sentences.append(f"{_names(street_public)} {_verb(street_public, 'sit')} at the street end, beside the door.")
    elif public:
        sentences.append(f"{_names(public)} {_verb(public, 'sit')} nearest the door.")

    if private:
        if report.private_depth is not None and report.public_depth is not None:
            sentences.append(
                f"{_names(private)} {_verb(private, 'sit')} deepest -- on average "
                f"{report.private_depth - report.public_depth:.1f} more doors from the entry than the shared rooms."
            )
        else:
            sentences.append(f"{_names(private)} {_verb(private, 'sit')} deepest, away from the street.")

    if service:
        street_service = [n for n in service if plan.entry_edge in plan.facing.get(n, ())]
        if street_service:
            sentences.append(
                f"{_names(street_service)} {_verb(street_service, 'meet')} the street and "
                f"{_verb(street_service, 'buffer')} the rest from it."
            )
        else:
            sentences.append(f"{_names(service)} {_verb(service, 'sit')} between the shared and the private rooms.")

    sentences.append(f"Hallway is {report.circulation_ratio:.0%} of the floor area.")

    if spec.rationale:
        sentences.append(spec.rationale.strip().rstrip("."))
    return " ".join(s if s.endswith(".") else s + "." for s in sentences)
