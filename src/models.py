"""Structured data types for a conceptual-design project.

These are the shapes that flow between the conversational extraction layer
(Claude) and the deterministic geometry/validation layer (plain Python).
"""

from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field

EdgePosition = Literal["front", "back", "left", "right"]
Adjacency = Literal["street", "neighbor"]


class SiteEdge(BaseModel):
    position: EdgePosition
    adjacency: Adjacency
    # Only set when the owner states a specific setback for this edge that
    # overrides the project-wide street/neighbor default.
    setback_override_m: Optional[float] = None


class Site(BaseModel):
    width_m: Optional[float] = Field(
        default=None, description="Site dimension along the left/right axis, in meters."
    )
    depth_m: Optional[float] = Field(
        default=None, description="Site dimension along the front/back axis, in meters."
    )
    rotation_deg: Optional[float] = Field(
        default=None,
        description="Rotation of the site's front edge relative to true north, "
        "clockwise in degrees. Not used for Phase 1 geometry; recorded for "
        "Phase 2 solar/orientation analysis.",
    )
    edges: List[SiteEdge] = Field(default_factory=list)

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
    "other",
]


class Room(BaseModel):
    name: str = Field(description="Owner-facing label, e.g. 'Primary Bedroom'.")
    room_type: RoomType
    count: int = Field(default=1, ge=1, description="Number of identical instances of this room.")
    # Explicit sizing the owner stated in conversation. When absent, the
    # geometry layer fills these in from src.defaults (never guessed by the LLM).
    explicit_width_m: Optional[float] = None
    explicit_depth_m: Optional[float] = None
    is_entry: bool = Field(
        default=False, description="True if this room is a building entry point."
    )
    priority_notes: Optional[str] = Field(
        default=None,
        description="Short note on what matters for this room, e.g. 'wants privacy from street', "
        "'needs morning light'. Used later for color-coding and layout, not Phase 1 geometry.",
    )


class Project(BaseModel):
    owner: Optional[str] = None
    site: Site = Field(default_factory=Site)
    setbacks: Setbacks = Field(default_factory=Setbacks)
    max_building_height_m: float = 15.0
    hallway_width_m: float = 1.2
    rooms: List[Room] = Field(default_factory=list)
    priorities: List[str] = Field(
        default_factory=list,
        description="Owner-stated priorities in their own words, e.g. 'privacy', "
        "'family togetherness', 'morning light in the kitchen'.",
    )
    notes: Optional[str] = None
