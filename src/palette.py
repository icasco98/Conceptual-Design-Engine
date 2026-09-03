"""Color-by-category for the zoning diagram.

These are zoning-diagram colors, not chart colors. The earlier set was
taken from a categorical data-visualization palette and used at near-full
strength, which made a plan read like a bar chart: three saturated hues
competing with the linework that actually carries the drawing.

These four are muted, and the canvas paints them as a wash (see
CATEGORY_WASH) rather than a flood, so the black footprint line stays the
heaviest thing on the sheet and room names stay legible on top of the fill.
They remain distinguishable from one another under the "any pair can touch"
condition a floor plan imposes — unlike a bar chart, a plan has no fixed
left-to-right neighbor order.

Colors are never invented per-project; Claude only picks which category a
room belongs to, not what color that category is.
"""

from __future__ import annotations

CATEGORY_KEYS = ("category_a", "category_b", "category_c")

CATEGORY_COLORS: dict[str, str] = {
    "category_a": "#4A6E96",  # slate blue
    "category_b": "#C58A3E",  # ochre
    "category_c": "#6E8C74",  # sage
}

# The stair is its own thing rather than a category: it is the one room
# packed once and placed identically on every level it connects, so it
# reads better with its own hue than borrowed from whichever category it
# happens to land in.
STAIR_COLOR = "#7A6A93"  # muted violet

# How strongly a category color fills a room. Low on purpose: the drawing
# is carried by line weight, and color only says which zone a room is in.
CATEGORY_WASH = 0.17

# Circulation (hallways) and the marked entry aren't extra colors — they
# get a hatch and a dashed border instead, so zone color keeps meaning
# "which zone" and nothing else.
CIRCULATION_HATCH = "///"
ENTRY_BORDER_COLOR = "#0b0b0b"
