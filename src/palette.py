"""Colour-by-zone for the zoning diagram.

The residential split is public / private / service, and these three hex
values are the validated categorical set (dataviz skill, references/
palette.md, first three slots) documented to stay legible when any pair of
shapes touch -- a plan, unlike a bar chart, has no fixed neighbour order.
The mapping is fixed: public is always blue, private always orange,
service always aqua, so a diagram reads the same from one project to the
next. Circulation and the entry aren't a fourth colour; they get a hatch
and a border instead.
"""

from __future__ import annotations

ZONE_KEYS = ("public", "private", "service")

ZONE_COLORS: dict[str, str] = {
    "public": "#2a78d6",  # blue
    "private": "#eb6834",  # orange
    "service": "#1baf7a",  # aqua
}

ZONE_LABELS: dict[str, str] = {
    "public": "Public",
    "private": "Private",
    "service": "Service",
}

CIRCULATION_HATCH = "///"
ENTRY_BORDER_COLOR = "#0b0b0b"
