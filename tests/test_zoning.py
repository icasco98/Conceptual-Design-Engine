"""Station 06 geometry: the hall plan the packer draws."""

from src.access import access_problems_for, rects_touch
from src.circulation import rects_overlap
from src.geometry import compute_buildable_envelope
from src.models import Project, Room, Setbacks, Site, SiteEdge
from src.site_analysis import analyse_site
from src.zoning import Frame, generate_candidates, pack_candidate
from src.zoning_spec import default_spec, expand_program, expand_requirements


def make_project(width=20.0, depth=28.0, rooms=None, streets=("front",)):
    edges = [
        SiteEdge(position=p, adjacency="street" if p in streets else "neighbor")
        for p in ("front", "back", "left", "right")
    ]
    return Project(site=Site(width_m=width, depth_m=depth, edges=edges), setbacks=Setbacks(), rooms=rooms or [])


def setup(project):
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    spec = default_spec(project)
    instances, _ = expand_program(project, spec)
    requirements = expand_requirements(spec, instances)
    frame = Frame(envelope, analyse_site(project).entry_edge)
    return envelope, instances, requirements, frame


HOUSE = [
    Room(name="Entry", room_type="entry", is_entry=True),
    Room(name="Living", room_type="living_room"),
    Room(name="Kitchen", room_type="kitchen"),
    Room(name="Primary", room_type="bedroom_primary"),
    Room(name="Bedroom", room_type="bedroom", count=2),
    Room(name="Bathroom", room_type="bathroom"),
    Room(name="Garage", room_type="garage_double"),
]


def _all_rects(plan):
    return [r.rect for r in plan.result.rooms] + [c.rect for c in plan.result.corridors]


def test_every_candidate_is_inside_the_envelope_with_no_overlaps():
    project = make_project(rooms=HOUSE)
    envelope, instances, requirements, frame = setup(project)
    gen = generate_candidates(instances, requirements, frame, project.hallway_width_m)
    assert gen.plans
    env = (envelope.left_setback_m, envelope.back_setback_m,
           envelope.left_setback_m + envelope.width_m, envelope.back_setback_m + envelope.depth_m)
    for plan in gen.plans:
        rects = _all_rects(plan)
        for r in rects:
            assert r[0] >= env[0] - 1e-6 and r[1] >= env[1] - 1e-6
            assert r[2] <= env[2] + 1e-6 and r[3] <= env[3] + 1e-6
        for i in range(len(rects)):
            for j in range(i + 1, len(rects)):
                assert not rects_overlap(rects[i], rects[j])


def test_every_candidate_is_walkable_by_construction():
    project = make_project(rooms=HOUSE)
    _, instances, requirements, frame = setup(project)
    gen = generate_candidates(instances, requirements, frame, project.hallway_width_m)
    for plan in gen.plans:
        assert access_problems_for(plan.result) == []


def test_the_entry_meets_the_street_edge():
    project = make_project(rooms=HOUSE)
    envelope, instances, requirements, frame = setup(project)
    gen = generate_candidates(instances, requirements, frame, project.hallway_width_m)
    front_y = envelope.back_setback_m + envelope.depth_m
    for plan in gen.plans:
        entry = next(r for r in plan.result.rooms if r.is_entry)
        assert abs(entry.y_m + entry.depth_m - front_y) < 1e-6


def test_the_garage_leads_its_row_at_the_street():
    project = make_project(rooms=HOUSE)
    envelope, instances, requirements, frame = setup(project)
    gen = generate_candidates(instances, requirements, frame, project.hallway_width_m)
    front_y = envelope.back_setback_m + envelope.depth_m
    for plan in gen.plans:
        garage = plan.room("Garage")
        assert abs(garage.y_m + garage.depth_m - front_y) < 1e-6


def test_rows_run_public_then_service_then_private_along_the_hall():
    from src.zoning import ZONE_RANK

    project = make_project(rooms=HOUSE)
    _, instances, requirements, frame = setup(project)
    gen = generate_candidates(instances, requirements, frame, project.hallway_width_m)
    for plan in gen.plans:
        for row in plan.columns:
            ranks = [ZONE_RANK[plan.room(name).zone] for name in row]
            # A lead (the garage) may precede public rooms; after that the
            # gradient never runs backwards.
            body = ranks[1:] if row and plan.room(row[0]).room_type.startswith("garage") else ranks
            assert body == sorted(body), row


def test_must_chains_share_a_wall_in_every_candidate():
    project = make_project(rooms=HOUSE)
    _, instances, requirements, frame = setup(project)
    gen = generate_candidates(instances, requirements, frame, project.hallway_width_m)
    for plan in gen.plans:
        assert rects_touch(plan.room("Primary").rect, plan.room("Bathroom").rect)


def test_the_hall_is_only_as_long_as_the_rooms_that_need_it():
    project = make_project(rooms=HOUSE)
    _, instances, requirements, frame = setup(project)
    gen = generate_candidates(instances, requirements, frame, project.hallway_width_m)
    for plan in gen.plans:
        if not plan.corridor_needed:
            continue
        corridor = plan.result.corridors[0]
        # Never past the deepest room.
        deepest = min(r.y_m for r in plan.result.rooms)
        assert corridor.y_m >= deepest - 1e-6


def test_a_program_that_needs_no_hall_gets_none():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Living", room_type="living_room"),
        Room(name="Kitchen", room_type="kitchen"),
    ]
    project = make_project(rooms=rooms)
    _, instances, requirements, frame = setup(project)
    gen = generate_candidates(instances, requirements, frame, project.hallway_width_m)
    assert gen.plans
    assert any(not plan.corridor_needed for plan in gen.plans)
    for plan in gen.plans:
        if not plan.corridor_needed:
            assert plan.result.corridors == []
            assert access_problems_for(plan.result) == []


def test_a_foyer_entry_takes_the_halls_width_and_keeps_its_area():
    project = make_project(rooms=HOUSE)
    _, instances, requirements, frame = setup(project)
    gen = generate_candidates(instances, requirements, frame, project.hallway_width_m)
    entry = next(r for r in gen.plans[0].result.rooms if r.is_entry)
    assert abs(entry.width_m - project.hallway_width_m) < 1e-9
    assert abs(entry.area_m2 - 1.8 * 1.8) < 1e-6


def test_rooms_turn_and_shrink_toward_their_minimum_to_fit_a_narrow_plot():
    project = make_project(width=11.0, depth=40.0, rooms=HOUSE)  # 8 m wide envelope
    _, instances, requirements, frame = setup(project)
    gen = generate_candidates(instances, requirements, frame, project.hallway_width_m)
    assert gen.plans, gen.problems
    for plan in gen.plans:
        for room in plan.result.rooms:
            fits_as_is = room.width_m >= room.min_width_m - 1e-6 and room.depth_m >= room.min_depth_m - 1e-6
            fits_turned = room.depth_m >= room.min_width_m - 1e-6 and room.width_m >= room.min_depth_m - 1e-6
            assert fits_as_is or fits_turned, room


def test_a_plot_too_narrow_for_the_garage_says_which_room_and_why():
    project = make_project(width=8.0, depth=40.0, rooms=HOUSE)  # 5 m wide envelope, garage min 5.5
    _, instances, requirements, frame = setup(project)
    gen = generate_candidates(instances, requirements, frame, project.hallway_width_m)
    assert gen.plans == []
    assert "Garage" in gen.problems[0] and "wider than" in gen.problems[0]


def test_frame_maps_a_side_street_entry_onto_that_edge():
    project = make_project(rooms=HOUSE, streets=("left",))
    envelope, instances, requirements, frame = setup(project)
    assert frame.entry_edge == "left"
    assert frame.width == envelope.depth_m and frame.depth == envelope.width_m
    gen = generate_candidates(instances, requirements, frame, project.hallway_width_m)
    for plan in gen.plans:
        entry = next(r for r in plan.result.rooms if r.is_entry)
        assert abs(entry.x_m - envelope.left_setback_m) < 1e-6


def test_pack_candidate_returns_none_when_nothing_fits():
    project = make_project(width=8.0, depth=10.0, rooms=HOUSE)
    _, instances, requirements, frame = setup(project)
    anchor = next(i for i in instances if i.is_entry)
    others = [i for i in instances if not i.is_entry]
    assert pack_candidate(anchor, others, [], frame, 1.2) is None


def test_facing_edges_are_reported_for_the_site_score():
    project = make_project(rooms=HOUSE)
    _, instances, requirements, frame = setup(project)
    gen = generate_candidates(instances, requirements, frame, project.hallway_width_m)
    plan = gen.plans[0]
    entry = next(r for r in plan.result.rooms if r.is_entry)
    assert "front" in plan.facing[entry.name]
    assert "front" in plan.facing["Garage"]
    for row, edge in zip(plan.columns, plan.column_edges):
        for name in row:
            assert edge in plan.facing[name]
