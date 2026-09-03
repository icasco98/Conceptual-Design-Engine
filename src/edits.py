"""Edits the owner asks for in words, as structured requests.

The owner can already drag, resize and rotate a room by hand. Asking for
the same thing in the chat did nothing, because nothing Claude returns has
ever carried an instruction about the drawing — only the brief (a Project)
and a grouping (a LayoutPlan). "Turn the office forty-five degrees" had no
channel to travel down.

This is that channel, and it is deliberately narrow. Claude reads the
sentence and names the room and the angle; it computes nothing. Whether
the room can actually hold that angle is decided by the same canvas rules
that decide it when the owner drags the rotate handle: the request is a
request, and the geometry still gets to refuse it.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class RoomRotation(BaseModel):
    """One room, and the angle the owner wants it to end up at.

    The angle is absolute, not a delta. Claude does not know what a room is
    currently turned to, so a delta would compound unpredictably across a
    conversation; "rotate the office 45 degrees" from an upright room and
    "turn the office to 45 degrees" mean the same thing here, which is what
    an owner almost always intends.
    """

    room_name: str = Field(description="The room's name, exactly as it appears in the program.")
    degrees: float = Field(
        description="Absolute angle in degrees, clockwise, 0 = upright. The canvas snaps to 5.",
    )
