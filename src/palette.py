"""Color-by-category for the zoning diagram.

These three hex values are taken verbatim from the studio's validated
categorical palette (dataviz skill, references/palette.md) — specifically
the first three slots, which are the subset documented to pass color-vision
and contrast checks even when many shapes sit adjacent to each other at
once (a floor plan, unlike a bar chart, doesn't have a fixed left-to-right
neighbor order, so it needs the stricter "any pair can touch" guarantee).
Colors are never invented per-project; Claude only picks which category a
room belongs to, not what color that category is.
"""

from __future__ import annotations

CATEGORY_KEYS = ("category_a", "category_b", "category_c")

CATEGORY_COLORS: dict[str, str] = {
    "category_a": "#2a78d6",  # blue
    "category_b": "#eb6834",  # orange
    "category_c": "#1baf7a",  # aqua
}

# Circulation (hallways) and the marked entry aren't a 4th color — they get
# a distinct pattern/border instead, so the diagram stays inside the
# validated 3-hue set while still standing out.
CIRCULATION_HATCH = "///"
ENTRY_BORDER_COLOR = "#0b0b0b"
