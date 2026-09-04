"""A second storey: the stair is one rectangle on every level, upper rooms
are reached through it, wet rooms are asked to stack, and nothing hangs in
mid-air unnoticed."""

from dataclasses import replace

from src.access import access_problems_for
from src.geometry import compute_buildable_envelope
from src.layout import MultiLevelLayout, pack_levels, pack_rooms
from src.levels import assign_default_levels
from src.models import Project, Room, Setbacks, Site, SiteEdge
from src.planner import OVERHANG_WEIGHT, UNSTACKED_PLUMBING_WEIGHT, best_layout
from src.stacking import CANTILEVER_TOLERANCE, stacking_issues, stacking_report
from src.validation import validate_room_program


def make_project(width=14.0, depth=20.0, rooms=None, storeys=2) -> Project:
    edges = [
        SiteEdge(position="front", adjacency="street"),
        SiteEdge(position="back", adjacency="neighbor"),
        SiteEdge(position="left", adjacency="neighbor"),
        SiteEdge(position="right", adjacency="neighbor"),
    ]
    site = Site(width_m=width, depth_m=depth, edges=edges)
    return Project(site=site, setbacks=Setbacks(), rooms=rooms or [], storeys=storeys)


TWO_STOREY = [
    Room(name="Entry", room_type="entry", is_entry=True),
    Room(name="Stair", room_type="stair", levels=[0, 1]),
    Room(name="Living", room_type="living_room"),
    Room(name="Kitchen", room_type="kitchen"),
    Room(name="Powder", room_type="half_bath"),
    Room(name="Garage", room_type="garage_single"),
    Room(name="Primary", room_type="bedroom_primary", levels=[1]),
    Room(name="Bed", room_type="bedroom", count=2, levels=[1]),
    Room(name="Bath", room_type="bathroom", levels=[1]),
]


def envelope_for(project):
    return compute_buildable_envelope(project.site, project.setbacks)


def _overlaps(a, b, tol=1e-9):
    return not (
        a.x_m + a.width_m <= b.x_m + tol
        or b.x_m + b.width_m <= a.x_m + tol
        or a.y_m + a.depth_m <= b.y_m + tol
        or b.y_m + b.depth_m <= a.y_m + tol
    )


def test_pack_levels_gives_one_plan_per_storey():
    project = make_project(rooms=TWO_STOREY)
    building = pack_levels(project, envelope_for(project))
    assert isinstance(building, MultiLevelLayout)
    assert [level.level for level in building.levels] == [0, 1]
    assert {r.name for r in building.level(0).rooms} == {"Entry", "Stair", "Living", "Kitchen", "Powder", "Garage"}
    assert {r.name for r in building.level(1).rooms} == {"Stair", "Primary", "Bed 1", "Bed 2", "Bath"}


def test_the_stair_is_the_same_rectangle_on_every_level():
    project = make_project(rooms=TWO_STOREY)
    building = pack_levels(project, envelope_for(project))
    stairs = [r for r in building.rooms if r.room_type == "stair"]
    assert len(stairs) == 2
    rects = {(r.x_m, r.y_m, r.width_m, r.depth_m) for r in stairs}
    assert len(rects) == 1
    # It spans its whole row, like the entry, so the corridor below meets it.
    stair = stairs[0]
    ground = building.level(0)
    assert any(abs(c.y_m + c.depth_m - stair.y_m) < 1e-6 or abs(stair.y_m + stair.depth_m - c.y_m) < 1e-6
               for c in ground.corridors)


def test_nothing_overlaps_on_either_level():
    project = make_project(rooms=TWO_STOREY)
    building = pack_levels(project, envelope_for(project))
    for level in building.levels:
        boxes = list(level.rooms) + list(level.corridors)
        for i, a in enumerate(boxes):
            for b in boxes[i + 1:]:
                assert not _overlaps(a, b), (level.level, a, b)


def test_upper_rooms_are_reached_through_the_stair():
    project = make_project(rooms=TWO_STOREY)
    building = pack_levels(project, envelope_for(project))
    assert access_problems_for(building) == []
    # Take the stair away from the upper level and it is cut off entirely:
    # the only way up was the flight.
    upper = building.level(1)
    stairless = replace(upper, rooms=[r for r in upper.rooms if r.room_type != "stair"])
    cut_off = MultiLevelLayout(levels=[building.level(0), stairless])
    names = {p.room_name for p in access_problems_for(cut_off)}
    assert {"Primary", "Bed 1", "Bed 2", "Bath"} <= names


def test_single_storey_packing_is_unchanged_by_the_level_machinery():
    rooms = [r for r in TWO_STOREY if r.room_type != "stair" and r.levels == [0]]
    project = make_project(rooms=rooms, storeys=1)
    building = pack_levels(project, envelope_for(project))
    direct = pack_rooms(project, envelope_for(project))
    assert building.levels == [direct]
    assert building.rooms == direct.rooms
    assert building.footprint == direct.footprint


def test_best_layout_scores_the_whole_building():
    project = make_project(rooms=TWO_STOREY)
    chosen = best_layout(project, envelope_for(project))
    assert isinstance(chosen.result, MultiLevelLayout)
    assert chosen.access_problems == 0
    assert 0.0 < chosen.circulation_ratio < 0.4


def test_wet_rooms_stacked_over_wet_rooms_score_clean():
    project = make_project(rooms=TWO_STOREY)
    building = pack_levels(project, envelope_for(project))
    report = stacking_report(building)
    assert "Bath" in report.wet_overlap
    assert all(name not in report.wet_overlap for name in ("Primary", "Bed 1", "Bed 2"))
    # Every upper room is over the ground floor, no cantilever on this plan.
    assert all(share <= CANTILEVER_TOLERANCE for share in report.overhang.values())


def test_an_unstacked_bathroom_is_named_and_penalised():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Stair", room_type="stair", levels=[0, 1]),
        Room(name="Living", room_type="living_room"),
        Room(name="Bath", room_type="bathroom", levels=[1]),
    ]
    project = make_project(rooms=rooms)
    building = pack_levels(project, envelope_for(project))
    report = stacking_report(building)
    assert report.wet_overlap["Bath"] == 0.0
    assert report.penalty >= 1.0
    messages = [i.message for i in stacking_issues(building)]
    assert any("Bath" in m and "plumbing" in m for m in messages)


def test_a_room_hanging_off_the_floor_below_is_flagged():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Stair", room_type="stair", levels=[0, 1]),
        Room(name="Living", room_type="living_room", levels=[1]),
        Room(name="Kitchen", room_type="kitchen", levels=[1]),
        Room(name="Bed", room_type="bedroom", count=3, levels=[1]),
    ]
    project = make_project(rooms=rooms)
    building = pack_levels(project, envelope_for(project))
    report = stacking_report(building)
    assert any(share > CANTILEVER_TOLERANCE for share in report.overhang.values())
    assert any(i.code == "cantilever" for i in stacking_issues(building))


def test_the_stacking_penalty_does_not_grow_just_because_there_are_more_rooms():
    """Two houses with the same fault -- every upper room unstacked -- one
    with three bedrooms and one with six. The fault is the same, so the
    penalty must be.

    Both components used to be sums, so the six-bedroom house was charged
    twice the six-bedroom house's worth of the identical problem. On a
    large enough plan the term outweighed every stated preference put
    together, and it did so purely because of the room count. Every other
    term the planner weighs is normalised; these are now too.
    """
    def unstacked(bedrooms):
        rooms = [
            Room(name="Entry", room_type="entry", is_entry=True),
            Room(name="Stair", room_type="stair", levels=[0, 1]),
            Room(name="Living", room_type="living_room", levels=[0]),
            Room(name="Bath", room_type="bathroom", count=bedrooms, levels=[1]),
        ]
        project = make_project(rooms=rooms)
        return stacking_report(pack_levels(project, envelope_for(project)))

    few = unstacked(2)
    many = unstacked(5)
    assert few.wet_penalty == many.wet_penalty == 1.0
    assert len(many.wet_overlap) > len(few.wet_overlap)


def test_plumbing_and_overhang_are_priced_apart():
    """They are not the same order of problem. A bathroom without a wet
    room beneath it needs its own plumbing run -- a cost, and one plenty of
    built houses carry. A bedroom hanging off the floor plate needs
    structure this stage of design has not thought about.

    They used to be added together at one weight, so the scorer treated
    'pay the plumber more' and 'this floor lands on nothing' as equally
    wrong.
    """
    assert OVERHANG_WEIGHT > UNSTACKED_PLUMBING_WEIGHT
    # ...and neither, at its worst, buys back a room you cannot reach.
    assert OVERHANG_WEIGHT + UNSTACKED_PLUMBING_WEIGHT < 100.0


def test_validation_demands_a_stair_and_keeps_rooms_within_the_storeys():
    no_stair = make_project(rooms=[r for r in TWO_STOREY if r.room_type != "stair"])
    codes = {i.code for i in validate_room_program(no_stair, envelope_for(no_stair))}
    assert "no_stair" in codes

    short_stair = make_project(rooms=[
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Stair", room_type="stair", levels=[0]),
        Room(name="Attic", room_type="storage", levels=[3]),
    ])
    codes = {i.code for i in validate_room_program(short_stair, envelope_for(short_stair))}
    assert {"stair_misses_level", "room_above_top_storey"} <= codes

    fine = make_project(rooms=TWO_STOREY)
    codes = {i.code for i in validate_room_program(fine, envelope_for(fine))}
    assert not codes & {"no_stair", "stair_misses_level", "room_above_top_storey", "level_area_exceeds_envelope"}


def test_area_is_checked_per_level_on_a_multi_storey_house():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Stair", room_type="stair", levels=[0, 1]),
        Room(name="Hall", room_type="living_room", count=6, levels=[1]),
    ]
    project = make_project(width=8, depth=10, rooms=rooms)
    issues = validate_room_program(project, envelope_for(project))
    by_code = {i.code: i.message for i in issues}
    assert "level_area_exceeds_envelope" in by_code
    assert "Level 1" in by_code["level_area_exceeds_envelope"]


def test_default_levels_send_bedrooms_up_and_keep_a_bathroom_down():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Stair", room_type="stair"),
        Room(name="Living", room_type="living_room"),
        Room(name="Kitchen", room_type="kitchen"),
        Room(name="Bedroom", room_type="bedroom", count=3),
        Room(name="Bathroom", room_type="bathroom", count=2),
    ]
    project = assign_default_levels(make_project(rooms=rooms))
    by_name = {r.name: r for r in project.rooms}
    assert by_name["Stair"].levels == [0, 1]
    assert by_name["Bedroom"].levels == [1]
    assert by_name["Living"].levels == [0]
    assert by_name["Bathroom 1"].levels == [0]
    assert by_name["Bathroom 2"].levels == [1]


def test_default_levels_respect_what_the_owner_already_placed():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Stair", room_type="stair", levels=[0, 1]),
        Room(name="Office", room_type="office", levels=[1]),
        Room(name="Bedroom", room_type="bedroom"),
    ]
    project = assign_default_levels(make_project(rooms=rooms))
    by_name = {r.name: r for r in project.rooms}
    assert by_name["Bedroom"].levels == [0]
    assert by_name["Office"].levels == [1]


def test_single_storey_projects_are_left_alone():
    project = make_project(rooms=[Room(name="Bedroom", room_type="bedroom")], storeys=1)
    assert assign_default_levels(project) is project
