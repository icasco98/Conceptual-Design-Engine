"""Deterministic site geometry: buildable envelope from site + setbacks.

The site is a rectangle described by width (left/right axis) and depth
(front/back axis). Each of its four edges is tagged street- or
neighbor-facing (a corner lot can tag more than one edge as street-facing).
The buildable envelope is the site rectangle inset by the resolved setback
on each edge.
"""

from __future__ import annotations

from dataclasses import dataclass

from src.models import Setbacks, Site, SiteEdge


class IncompleteSiteError(ValueError):
    """Raised when the site is missing width, depth, or one of its 4 edges."""


@dataclass(frozen=True)
class BuildableEnvelope:
    width_m: float
    depth_m: float
    front_setback_m: float
    back_setback_m: float
    left_setback_m: float
    right_setback_m: float

    @property
    def area_m2(self) -> float:
        return max(self.width_m, 0.0) * max(self.depth_m, 0.0)

    @property
    def is_valid(self) -> bool:
        return self.width_m > 0 and self.depth_m > 0


def resolve_edge_setback(edge: SiteEdge, setbacks: Setbacks) -> float:
    if edge.setback_override_m is not None:
        return edge.setback_override_m
    return setbacks.street_m if edge.adjacency == "street" else setbacks.neighbor_m


def compute_buildable_envelope(site: Site, setbacks: Setbacks) -> BuildableEnvelope:
    if not site.is_complete():
        raise IncompleteSiteError(
            "Site needs width_m, depth_m, and all four edges (front/back/left/right) tagged."
        )

    edges = site.edges_by_position()
    front = resolve_edge_setback(edges["front"], setbacks)
    back = resolve_edge_setback(edges["back"], setbacks)
    left = resolve_edge_setback(edges["left"], setbacks)
    right = resolve_edge_setback(edges["right"], setbacks)

    return BuildableEnvelope(
        width_m=site.width_m - left - right,
        depth_m=site.depth_m - front - back,
        front_setback_m=front,
        back_setback_m=back,
        left_setback_m=left,
        right_setback_m=right,
    )
