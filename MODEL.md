# Core model

One principle: **the graph is the truth; geometry is a view of it.**
A house at the conceptual stage is a set of rooms and the connections
between them. Where the rooms sit on the sheet is how that graph is
being drawn right now, and it may be wrong, rough or missing. The
checker reads the graph. The canvas edits both. Nothing ever infers a
connection from where two walls happen to land.

## Entities (stored)

| Entity | Fields | Notes |
|---|---|---|
| **Project** | `id`, `name`, `storeys`, `plot`, `rooms[]`, `edges[]`, `actors[]`, `version` | One JSON document. Units are metres and m². |
| **Plot** | `on`, `polygon` | A rectangle today, a polygon later; same field either way. |
| **Room** | `id`, `name`, `type`, `storey`, `storeysSpanned`, `targetArea`, `footprint?` | `type` keys the room-type table. `footprint` is a polygon on the sheet, absent while the room is unplaced. A stair is a room with `storeysSpanned > 1`. |
| **Edge** | `id`, `a`, `b`, `kind`, `storey`, `hint?` | `a`/`b` are room ids, or the singleton `EXTERIOR`. `kind` is `door`, `open` (no wall, one space flows into the next) or `main-door` (exactly one per project, from `EXTERIOR`). `hint` is an optional wall position for drawing; losing it changes nothing. |
| **Actor** | `id`, `name`, `role`, `waypoints[]` | Unchanged from today. Waypoints are room ids. |

Invariants: an edge joins two rooms that share a storey, or a stair with
a room on any storey it spans. One edge per unordered pair per storey.
Deleting a room deletes its edges. `EXTERIOR` is never a room. A room is
either placed (has a footprint) or unplaced, never half.

## Reference tables (code, one copy each)

**Room types:** `label`, `minArea`, `typicalArea`, `aspect` range,
`category` (private, shared, service, reception), `tier` (public,
semi-public, private, or exempt), `passable`, `auxiliary`, `circulation`.
Area-based, not width-by-depth, so a room's shape is the drawer's choice.

**Relationship rules:** `a`, `b`, `relation` (`required`, `desired`,
`undesired`), `source`, `confidence` (`sourced` or `provisional`). A
provisional rule can only ever produce a recommendation, never a
problem, until someone promotes it with a source.

## Derived (computed every time, never stored)

- **Findings.** Reachability from `EXTERIOR`, tier skips, stair landings,
  rule violations, dead ends: all of these are graph queries and touch
  no geometry. Cost findings (gaps, overhangs, corridor ratio) read
  geometry and are always recommendations.
- **Geometry consistency.** An edge whose two footprints do not share a
  wall is a *warning on the drawing* ("door drawn, walls don't meet"),
  not a change to the graph. A shared wall with no edge is nothing at
  all. Snapping and touch tolerance are canvas conveniences; they never
  create or remove an edge.
- Footprint outline, coverage, routes, 3D massing: views of the above.

## Operations

- **Draw / move / resize / carve** change footprints only.
- **Connect** (drag between two rooms, or room to outside) creates an
  edge. **Disconnect** removes one. These are the only ways edges change.
- **Suggest connections** is an explicit action: propose edges from the
  current drawing, show them as a diff, the person accepts or rejects.
  Accepted edges are stored like any other.
- **Undo** covers rooms, edges and plot. Actors and camera are outside it.

## Walls and forces (the ranking mechanism)

Every factor the tool knows about is one of two kinds, never both:

- **A wall** is a hard constraint: a setback, a plot ratio, a height
  limit, a room the client will not cut. Walls carve the feasible
  region. They are never traded against anything.
- **A force** is a soft preference: orientation, compactness, the
  privacy gradient, the diwaniya facing the street, budget pressure.
  A force has a name, a direction, a magnitude, a source, and the
  element it acts on. Its default strength for Kuwait is stated with
  evidence; the person can change it, and the current weights are
  always on screen.

A massing is ranked by how the forces balance inside the walls. Because
an equilibrium is local, the tool starts from several typologies and
shows their equilibria side by side; it never presents one answer.
Every force must be drawable as a vector on a drawable element, so the
animation renders the actual computation rather than a picture of it.

## Persistence

Browser storage on every committed edit. Export and import as a single
JSON file. Versioned with a migration function per bump. No server.

## Non-goals for v1

No generator, no training loop, no polygon plot, no setbacks. When a
generator is wanted, its contract is: input a graph, a plot and room
targets; output footprints; objective is how many edges are realised as
shared walls, with a *continuous* distance penalty for each unrealised
one, so the search has a gradient to follow.
