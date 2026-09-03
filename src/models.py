"""Structured data types for a conceptual-design project.

These are the shapes that flow between the conversational extraction layer
(Claude) and the deterministic geometry/validation layer (plain Python).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

EdgePosition = Literal["front", "back", "left", "right"]
Adjacency = Literal["street", "neighbor"]


class SiteEdge(BaseModel):
    position: EdgePosition
    adjacency: Adjacency
    # Only set when the owner states a specific setback for this edge that
    # overrides the project-wide street/neighbor default.
    setback_override_m: float | None = None


class Site(BaseModel):
    width_m: float | None = Field(
        default=None, description="Site dimension along the left/right axis, in meters."
    )
    depth_m: float | None = Field(
        default=None, description="Site dimension along the front/back axis, in meters."
    )
    rotation_deg: float | None = Field(
        default=None,
        description="Rotation of the site's front edge relative to true north, "
        "clockwise in degrees. Not used for Phase 1 geometry; recorded for "
        "Phase 2 solar/orientation analysis.",
    )
    edges: list[SiteEdge] = Field(default_factory=list)

    def edges_by_position(self) -> dict:
        return {edge.position: edge for edge in self.edges}

    def is_complete(self) -> bool:
        has_all_edges = {e.position for e in self.edges} == {"front", "back", "left", "right"}
        return self.width_m is not None and self.depth_m is not None and has_all_edges


class Setbacks(BaseModel):
    street_m: float = 2.0
    neighbor_m: float = 1.5


RoomType = Literal[
    "entry",
    "hallway",
    "living_room",
    "family_room",
    "dining_room",
    "kitchen",
    "bedroom_primary",
    "bedroom",
    "bathroom",
    "half_bath",
    "office",
    "laundry",
    "garage_single",
    "garage_double",
    "closet",
    "storage",
    "mudroom",
    "stair",
    "other",
]


class Room(BaseModel):
    name: str = Field(description="Owner-facing label, e.g. 'Primary Bedroom'.")
    room_type: RoomType
    count: int = Field(default=1, ge=1, description="Number of identical instances of this room.")
    # Explicit sizing the owner stated in conversation. When absent, the
    # geometry layer fills these in from src.defaults (never guessed by the LLM).
    explicit_width_m: float | None = None
    explicit_depth_m: float | None = None
    is_entry: bool = Field(
        default=False, description="True if this room is a building entry point."
    )
    # Which storeys this room is on, 0 = ground. Almost every room is on
    # exactly one. A stair lists every level it connects and is the one
    # room that exists on several at once -- one rectangle, drawn on each.
    levels: list[int] = Field(
        default_factory=lambda: [0],
        description="Storeys this room is on, 0 = ground. A stair lists every level it "
        "connects (e.g. [0, 1]). Only set a level above 0 when the owner says so.",
    )
    priority_notes: str | None = Field(
        default=None,
        description="Short note on what matters for this room, e.g. 'wants privacy from street', "
        "'needs morning light'. Used later for color-coding and layout, not Phase 1 geometry.",
    )


class Project(BaseModel):
    owner: str | None = None
    site: Site = Field(default_factory=Site)
    setbacks: Setbacks = Field(default_factory=Setbacks)
    max_building_height_m: float = 15.0
    hallway_width_m: float = 1.2
    storeys: int = Field(default=1, ge=1, description="Number of storeys, 1 = single level.")
    storey_height_m: float = Field(default=3.0, gt=0, description="Floor-to-floor height in meters.")
    rooms: list[Room] = Field(default_factory=list)
    priorities: list[str] = Field(
        default_factory=list,
        description="Owner-stated priorities in their own words, e.g. 'privacy', "
        "'family togetherness', 'morning light in the kitchen'.",
    )
    notes: str | None = None
