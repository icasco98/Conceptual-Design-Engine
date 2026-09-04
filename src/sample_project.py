"""The worked example the app opens on.

Phase 1 used to open on an empty canvas and three "describe your site and
the diagram will appear here" placeholders, which explains what the tool
wants but not what it gives back. This module supplies a complete, valid
project -- a plot with spaces already zoned inside it -- so the first thing
on screen is a real diagram the owner can drag, rotate and resize before
typing anything.

Everything here is a plain literal, and the specification the engine works
from is the rule-based default (`src.zoning_spec.default_spec`) rather than
anything Claude wrote, so the sample renders with no API round trip on
first paint. Nothing about the sample is special-cased downstream: it runs
through `src.engine.design` exactly as a real project does.

The sample is replaced wholesale by the owner's own project the moment
they send their first chat message -- it is never merged with it, and it is
never sent to Claude as context (extraction reads the chat transcript
alone, which starts empty).
"""

from __future__ import annotations

from src.models import Project, Room, Setbacks, Site, SiteEdge
from src.zoning_spec import ZoningSpec, default_spec

# A mid-size suburban lot, street at the front, neighbors on the other
# three sides -- the most ordinary case there is, so the defaults on show
# (2m street setback, 1.5m neighbor) are the ones most owners will get.
# The plot faces north (street to the north), which puts the sun on the
# back garden and makes the site analysis have something to say.
SAMPLE_SITE_WIDTH_M = 20.0
SAMPLE_SITE_DEPTH_M = 28.0
SAMPLE_ROTATION_DEG = 0.0


def sample_project() -> Project:
    """A complete, validating project: full site geometry, an entry, and a
    program that fits inside the buildable envelope."""
    return Project(
        site=Site(
            width_m=SAMPLE_SITE_WIDTH_M,
            depth_m=SAMPLE_SITE_DEPTH_M,
            rotation_deg=SAMPLE_ROTATION_DEG,
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
            Room(name="Dining", room_type="dining_room"),
            Room(name="Kitchen", room_type="kitchen"),
            Room(name="Office", room_type="office"),
            Room(name="Primary Bedroom", room_type="bedroom_primary"),
            Room(name="Bedroom", room_type="bedroom", count=2),
            Room(name="Bathroom", room_type="bathroom", count=2),
            Room(name="Laundry", room_type="laundry"),
            Room(name="Double Garage", room_type="garage_double"),
        ],
        priorities=[
            "privacy for the bedrooms",
            "kitchen close to the entry",
        ],
    )


def sample_spec() -> ZoningSpec:
    """The specification the sample is zoned from: the rule-based default,
    which is what the engine falls back to for any project before (or
    without) Claude's own brief."""
    spec = default_spec(sample_project())
    return spec.model_copy(update={
        "rationale": "This is a sample -- describe your own project in the chat and it will be replaced."
    })
