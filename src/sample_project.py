"""The worked example the app opens on.

Phase 1 used to open on an empty canvas and three "describe your site and
the diagram will appear here" placeholders, which explains what the tool
wants but not what it gives back. This module supplies a complete, valid
project — a plot with spaces already zoned inside it — so the first thing
on screen is a real diagram the owner can drag, rotate and resize before
typing anything.

It is also the only project most people will see before they describe
their own, so it is the tool's argument for itself. That makes what the
sample *contains* a design decision rather than an arbitrary choice: it
carries a stated bearing, room pairings and daylight wishes, because those
are what the planner now reasons with, and an example that exercised none
of them would show a tool that appears to do considerably less than it
does.

Everything here is a plain literal. In particular `SAMPLE_LAYOUT_PLAN`
stands in for `src.layout_plan.plan_layout`'s output *without* calling
Claude, so the sample renders with no API round trip on first paint, and
`src.planner` computes its geometry the same way it does for a real
project. Nothing about the sample is special-cased downstream.

The sample is replaced wholesale by the owner's own project the moment
they send their first chat message — it is never merged with it, and it is
never sent to Claude as context (extraction reads the chat transcript
alone, which starts empty).
"""

from __future__ import annotations

from src.layout_plan import Adjacency, CategoryLabels, LayoutPlan, RoomAspect, RoomAssignment
from src.models import Project, Room, Setbacks, Site, SiteEdge

# A corner plot: roads along the front and the left, neighbours on the
# other two sides. Corners are common, and this one earns its place — it
# is the case where "keep the bedrooms off the street" has two streets to
# be off, and where the wider street setback shows up on two sides at once
# instead of being invisible.
SAMPLE_SITE_WIDTH_M = 24.0
SAMPLE_SITE_DEPTH_M = 32.0

# The front edge faces west, so north points to the right of the drawing
# and the morning sun comes from the *back* of the plot. Deliberately not
# the trivial case: with the front facing north every compass wish would
# land where an untutored guess would put it anyway, and both the rotated
# north arrow and the daylight scoring would look like they were doing
# nothing.
SAMPLE_SITE_BEARING_DEG = 270.0

_SAMPLE_ROOM_ORDER = [
    "Front Entry",
    "Stair",
    "Kitchen",
    "Dining Room",
    "Living Room",
    "Utility",
    "Powder Room",
    "Garage",
    "Primary Bedroom",
    "Bedroom",
    "Bathroom",
    "Study",
]


def sample_project() -> Project:
    """A complete, validating project: full site geometry, an entry, and a
    program that fits inside the buildable envelope."""
    return Project(
        site=Site(
            width_m=SAMPLE_SITE_WIDTH_M,
            depth_m=SAMPLE_SITE_DEPTH_M,
            rotation_deg=SAMPLE_SITE_BEARING_DEG,
            edges=[
                SiteEdge(position="front", adjacency="street"),
                SiteEdge(position="left", adjacency="street"),
                SiteEdge(position="back", adjacency="neighbor"),
                SiteEdge(position="right", adjacency="neighbor"),
            ],
        ),
        setbacks=Setbacks(),
        storeys=2,
        rooms=[
            Room(name="Front Entry", room_type="entry", is_entry=True),
            Room(name="Stair", room_type="stair", levels=[0, 1]),
            Room(name="Kitchen", room_type="kitchen"),
            Room(name="Dining Room", room_type="dining_room"),
            Room(name="Living Room", room_type="living_room"),
            Room(name="Utility", room_type="laundry"),
            Room(name="Powder Room", room_type="half_bath"),
            # Single rather than double: a double garage is wider than one
            # side of a central corridor, which would rule the spine packer
            # out of the example entirely and quietly hide half of what the
            # planner does.
            Room(name="Garage", room_type="garage_single"),
            Room(name="Primary Bedroom", room_type="bedroom_primary", levels=[1]),
            Room(name="Bedroom", room_type="bedroom", count=2, levels=[1]),
            # One family bathroom, not two. Two left the second one with
            # nothing wet beneath it, and the sample opened on a plumbing
            # warning -- which reads as the tool being broken rather than as
            # the example demonstrating something.
            Room(name="Bathroom", room_type="bathroom", levels=[1]),
            Room(name="Study", room_type="office", levels=[1]),
        ],
        # The owner's own words. Every one of these is answered by an entry
        # in the layout plan below, so the example shows the whole path from
        # something a person would say to something the packer scores.
        priorities=[
            "the kitchen and dining room should open into each other",
            "morning light in the kitchen",
            "somewhere to sit with the evening sun",
            "bedrooms away from both roads",
        ],
    )


def sample_layout_plan() -> LayoutPlan:
    """What Claude would return for `sample_project()` — grouping, pairings,
    daylight wishes and rationale — written out so the sample needs no API
    call."""
    categories = {
        "Front Entry": "category_b",
        "Stair": "category_b",
        "Kitchen": "category_b",
        "Dining Room": "category_b",
        "Living Room": "category_b",
        "Utility": "category_c",
        "Powder Room": "category_c",
        "Garage": "category_c",
        "Primary Bedroom": "category_a",
        "Bedroom": "category_a",
        "Bathroom": "category_a",
        "Study": "category_a",
    }
    return LayoutPlan(
        grouping_label="Grouped by privacy level",
        category_labels=CategoryLabels(
            category_a="Private",
            category_b="Shared",
            category_c="Service",
        ),
        assignments=[
            RoomAssignment(room_name=name, category=category)
            for name, category in categories.items()
        ],
        placement_order=list(_SAMPLE_ROOM_ORDER),
        adjacencies=[
            # The one the owner said they cared about, at the strength they
            # said it: this pairing should survive being inconvenient.
            Adjacency(room_a="Kitchen", room_b="Dining Room", relation="near", strength="strong"),
            Adjacency(room_a="Dining Room", room_b="Living Room", relation="near", strength="mild"),
            Adjacency(room_a="Utility", room_b="Kitchen", relation="near", strength="mild"),
            Adjacency(room_a="Bathroom", room_b="Primary Bedroom", relation="near", strength="mild"),
            # Ordinary domestic sense rather than anything stated: nobody
            # wants the car on the other side of the front door.
            Adjacency(room_a="Garage", room_b="Living Room", relation="apart", strength="mild"),
        ],
        orientations=[
            RoomAspect(room_name="Kitchen", wants="morning_sun"),
            RoomAspect(room_name="Living Room", wants="evening_sun"),
            RoomAspect(room_name="Primary Bedroom", wants="off_the_street"),
            RoomAspect(room_name="Bedroom", wants="off_the_street"),
        ],
        rationale=(
            "Kitchen and dining are kept together as asked, with the kitchen "
            "toward the morning sun and the living room facing the evening. "
            "Bedrooms are upstairs and pulled away from both roads. This is a "
            "sample — describe your own project in the chat and it will be "
            "replaced."
        ),
    )
