"""The worked example the app opens on.

Phase 1 used to open on an empty canvas and three "describe your site and
the diagram will appear here" placeholders, which explains what the tool
wants but not what it gives back. This module supplies a complete, valid
project — a plot with spaces already zoned inside it — so the first thing
on screen is a real diagram the owner can drag, rotate and resize before
typing anything.

Everything here is a plain literal. In particular `SAMPLE_LAYOUT_PLAN`
stands in for `src.layout_plan.plan_layout`'s output *without* calling
Claude, so the sample renders with no API round trip on first paint, and
`src.layout.pack_rooms` computes its geometry the same way it does for a
real project. Nothing about the sample is special-cased downstream.

The sample is replaced wholesale by the owner's own project the moment
they send their first chat message — it is never merged with it, and it is
never sent to Claude as context (extraction reads the chat transcript
alone, which starts empty).
"""

from __future__ import annotations

from src.layout_plan import CategoryLabels, LayoutPlan, RoomAssignment
from src.models import Project, Room, Setbacks, Site, SiteEdge

# A mid-size suburban lot, street at the front, neighbors on the other
# three sides — the most ordinary case there is, so the defaults on show
# (2m street setback, 1.5m neighbor) are the ones most owners will get.
SAMPLE_SITE_WIDTH_M = 20.0
SAMPLE_SITE_DEPTH_M = 28.0

_SAMPLE_ROOM_ORDER = [
    "Front Entry",
    "Great Room",
    "Kitchen",
    "Office",
    "Primary Bedroom",
    "Bedroom",
    "Bathroom",
    "Double Garage",
]


def sample_project() -> Project:
    """A complete, validating project: full site geometry, an entry, and a
    program that fits inside the buildable envelope."""
    return Project(
        site=Site(
            width_m=SAMPLE_SITE_WIDTH_M,
            depth_m=SAMPLE_SITE_DEPTH_M,
            edges=[
                SiteEdge(position="front", adjacency="street"),
                SiteEdge(position="back", adjacency="neighbor"),
                SiteEdge(position="left", adjacency="neighbor"),
                SiteEdge(position="right", adjacency="neighbor"),
            ],
        ),
        setbacks=Setbacks(),
        rooms=[
            Room(name="Front Entry", room_type="entry", is_entry=True),
            Room(name="Great Room", room_type="living_room"),
            Room(name="Kitchen", room_type="kitchen"),
            Room(name="Office", room_type="office"),
            Room(name="Primary Bedroom", room_type="bedroom_primary"),
            Room(name="Bedroom", room_type="bedroom", count=2),
            Room(name="Bathroom", room_type="bathroom", count=2),
            Room(name="Double Garage", room_type="garage_double"),
        ],
        priorities=[
            "privacy for the bedrooms",
            "kitchen close to the entry",
        ],
    )


def sample_layout_plan() -> LayoutPlan:
    """What Claude would return for `sample_project()` — grouping, adjacency
    order and rationale — written out so the sample needs no API call."""
    categories = {
        "Front Entry": "category_b",
        "Great Room": "category_b",
        "Kitchen": "category_b",
        "Office": "category_a",
        "Primary Bedroom": "category_a",
        "Bedroom": "category_a",
        "Bathroom": "category_a",
        "Double Garage": "category_c",
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
        rationale=(
            "Shared rooms sit along the street edge with the kitchen next to the "
            "entry, and the bedrooms are grouped together at the back, away from "
            "the front door. This is a sample — describe your own project in the "
            "chat and it will be replaced."
        ),
    )
