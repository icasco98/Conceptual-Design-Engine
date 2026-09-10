/**
 * Stress-test scenarios for the generator and the rule set -- two
 * independent, freely-combinable axes, not a fixed list of houses.
 *
 * `PLOT_TEMPLATES` is plot size and shape; `REQUIREMENT_BLOCKS` is
 * reusable room groups a program is assembled from (core living,
 * bedrooms, a diwaniya wing, staff quarters, ...). Any block combines
 * with any other, and any resulting program pairs with any plot -- that
 * is what makes these "interchangeable": trying one more bedroom, adding
 * a driver's room, or moving the same program onto a narrower lot needs
 * no new scenario written by hand, just a different combination of the
 * same pieces.
 *
 * `EXAMPLE_PROGRAMS` are a handful of realistic household compositions
 * built from those blocks, as a starting point -- add, remove or write
 * your own combination of `REQUIREMENT_BLOCKS` freely; nothing here is
 * a fixed catalog you're stuck with.
 *
 * `buildScenario` turns one (plot, program) pairing into a *naive*
 * starting layout -- rooms placed in simple shelf-packed rows, almost
 * certainly not touching each other -- for `generateLayout` to then
 * improve. That gap between the naive start and what the search (plus
 * the rule set) manages to fix is the actual stress test.
 */
import { newArrowId } from "./geometry/arrows";
import { rectPolyOf } from "./geometry/poly";
import { topologyLayout, type TopologyRoom } from "./geometry/topology";
import type { Arrow, Box, Plot } from "./geometry/types";
import { roomTypeInfo } from "./rooms";
import { DEFAULT_PRIORITY } from "./sample";

export interface PlotTemplate {
  id: string;
  label: string;
  width: number;
  depth: number;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** width x depth for a target area at a given width:depth ratio -- a
 * ratio near 1 is near-square, well below 1 is a narrow, deep lot. */
function dimsForArea(area: number, widthToDepth: number): { width: number; depth: number } {
  const depth = round1(Math.sqrt(area / widthToDepth));
  const width = round1(area / depth);
  return { width, depth };
}

/** Every plot size worth testing, each in two shapes: aspect ratio
 * changes what a program can fit at least as much as raw area does, so
 * testing area alone would miss real failure modes (a program that fits
 * a square 400 m² lot can fail on a narrow 400 m² one). */
const PLOT_AREAS_M2 = [250, 300, 400, 450, 500, 600, 750];

export const PLOT_TEMPLATES: PlotTemplate[] = PLOT_AREAS_M2.flatMap((area) => {
  const square = dimsForArea(area, 1.2);
  const narrow = dimsForArea(area, 0.4);
  return [
    { id: `plot_${area}_square`, label: `${area} m² (near-square, ${square.width}x${square.depth})`, ...square },
    { id: `plot_${area}_narrow`, label: `${area} m² (narrow/deep, ${narrow.width}x${narrow.depth})`, ...narrow },
  ];
});

export interface RequirementBlock {
  id: string;
  label: string;
  rooms: { roomType: string; count: number }[];
}

/** Reusable room groups. The bedroom/garage entries are small factory
 * functions rather than fixed blocks, on purpose -- "2 bedrooms" and "4
 * bedrooms" are the same *kind* of requirement at a different count, not
 * two different requirements, so the count is a parameter, not a
 * separate hardcoded block. */
export const REQUIREMENT_BLOCKS = {
  coreLiving: {
    id: "core_living",
    label: "Core living spaces",
    rooms: [
      { roomType: "entry", count: 1 },
      { roomType: "hallway", count: 1 },
      { roomType: "living_room", count: 1 },
      { roomType: "dining_room", count: 1 },
      { roomType: "kitchen", count: 1 },
    ],
  } satisfies RequirementBlock,

  bedrooms: (bedrooms: number, masters = 1): RequirementBlock => ({
    id: `bedrooms_${masters}m_${bedrooms}b`,
    label: `${masters} master + ${bedrooms} bedroom${bedrooms === 1 ? "" : "s"}`,
    rooms: [
      ...(masters ? [{ roomType: "master_bedroom", count: masters }] : []),
      ...(bedrooms ? [{ roomType: "bedroom", count: bedrooms }] : []),
      { roomType: "bathroom", count: masters + bedrooms },
    ],
  }),

  laundryMudroom: {
    id: "laundry_mudroom",
    label: "Laundry + mudroom",
    rooms: [
      { roomType: "laundry", count: 1 },
      { roomType: "mudroom", count: 1 },
    ],
  } satisfies RequirementBlock,

  garage: (kind: "garage_single" | "garage_double" = "garage_single"): RequirementBlock => ({
    id: kind,
    label: kind === "garage_single" ? "Single garage" : "Double garage",
    rooms: [{ roomType: kind, count: 1 }],
  }),

  diwaniya: { id: "diwaniya", label: "Diwaniya wing", rooms: [{ roomType: "diwaniya", count: 1 }] } satisfies RequirementBlock,
  reception: { id: "reception", label: "Reception room", rooms: [{ roomType: "reception", count: 1 }] } satisfies RequirementBlock,

  driverQuarters: {
    id: "driver_quarters",
    label: "Driver's room + bath",
    rooms: [
      { roomType: "driver_room", count: 1 },
      { roomType: "driver_bathroom", count: 1 },
    ],
  } satisfies RequirementBlock,

  nannyQuarters: {
    id: "nanny_quarters",
    label: "Nanny's room + bath",
    rooms: [
      { roomType: "nanny_room", count: 1 },
      { roomType: "nanny_bathroom", count: 1 },
    ],
  } satisfies RequirementBlock,

  office: { id: "office", label: "Office / study", rooms: [{ roomType: "office", count: 1 }] } satisfies RequirementBlock,
  prayerRoom: { id: "prayer_room", label: "Prayer room", rooms: [{ roomType: "prayer_room", count: 1 }] } satisfies RequirementBlock,
};

/** Every block's rooms, merged into one list -- duplicate room types
 * (e.g. two blocks that both bring a `bathroom`) summed, not repeated as
 * separate rows. */
export function flattenProgram(blocks: RequirementBlock[]): { roomType: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const block of blocks) {
    for (const { roomType, count } of block.rooms) {
      counts.set(roomType, (counts.get(roomType) ?? 0) + count);
    }
  }
  return [...counts.entries()].map(([roomType, count]) => ({ roomType, count }));
}

export interface RoomProgram {
  id: string;
  label: string;
  blocks: RequirementBlock[];
}

/** A handful of realistic compositions, built from `REQUIREMENT_BLOCKS`
 * alone -- freely edit, remove, or add your own combination; these are
 * defaults, not a fixed catalog. */
export const EXAMPLE_PROGRAMS: RoomProgram[] = [
  {
    id: "minimal",
    label: "Young couple, minimal",
    blocks: [REQUIREMENT_BLOCKS.coreLiving, REQUIREMENT_BLOCKS.bedrooms(0, 1), REQUIREMENT_BLOCKS.office],
  },
  {
    id: "small_nuclear",
    label: "Small nuclear family",
    blocks: [REQUIREMENT_BLOCKS.coreLiving, REQUIREMENT_BLOCKS.bedrooms(2, 1), REQUIREMENT_BLOCKS.laundryMudroom, REQUIREMENT_BLOCKS.garage("garage_single")],
  },
  {
    id: "extended_gulf",
    label: "Extended Gulf household",
    blocks: [
      REQUIREMENT_BLOCKS.coreLiving,
      REQUIREMENT_BLOCKS.bedrooms(3, 1),
      REQUIREMENT_BLOCKS.laundryMudroom,
      REQUIREMENT_BLOCKS.garage("garage_double"),
      REQUIREMENT_BLOCKS.diwaniya,
      REQUIREMENT_BLOCKS.reception,
      REQUIREMENT_BLOCKS.driverQuarters,
      REQUIREMENT_BLOCKS.nannyQuarters,
    ],
  },
  {
    id: "multigenerational",
    label: "Multigenerational household",
    blocks: [
      REQUIREMENT_BLOCKS.coreLiving,
      REQUIREMENT_BLOCKS.bedrooms(4, 2),
      REQUIREMENT_BLOCKS.laundryMudroom,
      REQUIREMENT_BLOCKS.garage("garage_double"),
      REQUIREMENT_BLOCKS.diwaniya,
      REQUIREMENT_BLOCKS.reception,
      REQUIREMENT_BLOCKS.driverQuarters,
      REQUIREMENT_BLOCKS.nannyQuarters,
      REQUIREMENT_BLOCKS.prayerRoom,
    ],
  },
];

export interface Scenario {
  id: string;
  label: string;
  plot: Plot;
  boxes: Box[];
  /** One exterior-main door on the entry room, and a first pass of
   * interior doors along whatever this naive placement happens to touch
   * (usually little to nothing) -- a real, if mostly empty, starting
   * door set, the same as a freshly placed real project has none of yet. */
  arrows: Arrow[];
}

/** One (plot, program) pairing, turned into a starting layout via the
 * topology and dimensioning stages (`geometry/topology.ts`): a bubble
 * diagram settles roughly who should sit near whom from the room list and
 * `relationships.ts`'s own required/desired rows, then a slice-and-dice
 * area partition turns that into real, non-overlapping rectangles that
 * exactly tile the plot -- adjacency-related rooms landing in
 * neighbouring slices rather than scattered arbitrarily, which is the
 * actual point: two rooms only ever get a door between them once their
 * walls meet within `TOUCH_TOL_M`, and a start where nothing is ever
 * within a meter of anything (the old shelf pack, kept apart by a flat
 * 0.3 m gap) essentially never lets the search find that by chance.
 *
 * A room's own weight in the partition is its typical footprint area,
 * floored at its own minimum -- see `topology.ts`'s `dimensionRooms` for
 * why that floor is only a bias, never a guarantee: a program that
 * doesn't fit the plot even at every room's minimum size (the same test
 * `scenarios.evaluator.ts`'s `isFeasible` runs) still produces a real,
 * non-overlapping placement here, just one where some rooms end up
 * smaller than they should be, which is the honest picture of what
 * "doesn't fit" actually looks like for a floor plan -- not a shelf-
 * packed overflow spilling past the plot boundary, which the old
 * approach allowed and this one structurally cannot.
 *
 * Rooms are `placed: true` from the start, plus one exterior door on the
 * entry -- `generateLayout` only ever moves rooms already live on a
 * storey, never places an unplaced one, so a scenario has to start
 * placed for the search to have anything to improve. */
export function buildScenario(plotTemplate: PlotTemplate, program: RoomProgram): Scenario {
  const plot: Plot = { on: true, left: 0, top: 0, width: plotTemplate.width, depth: plotTemplate.depth };
  const flat = flattenProgram(program.blocks);
  const instances = flat.flatMap(({ roomType, count }) => {
    const info = roomTypeInfo(roomType);
    return Array.from({ length: count }, (_, i) => ({
      id: `${program.id}:${plotTemplate.id}:${roomType}:${i}`,
      roomType,
      minWidth: info.minWidth,
      minHeight: info.minHeight,
      targetAreaM2: info.typicalWidth * info.typicalHeight,
    }));
  });
  const topologyRooms: TopologyRoom[] = instances.map(({ id, roomType, minWidth, minHeight, targetAreaM2 }) => ({
    id,
    roomType,
    minWidth,
    minHeight,
    targetAreaM2,
  }));
  const placed = topologyLayout(topologyRooms, { left: plot.left, top: plot.top, width: plot.width, height: plot.depth });
  const placedById = new Map(placed.map((p) => [p.id, p]));
  const boxes: Box[] = instances.map((inst, i) => {
    const rect = placedById.get(inst.id)!;
    return {
      id: inst.id,
      name: `${roomTypeInfo(inst.roomType).label} ${i + 1}`,
      kind: "room",
      shape: "rect",
      roomType: inst.roomType,
      isEntry: inst.roomType === "entry",
      level: 0,
      levelTo: 0,
      heightM: 3,
      priority: DEFAULT_PRIORITY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      minWidth: inst.minWidth,
      minHeight: inst.minHeight,
      rotation: 0,
      carvedBy: [],
      deleted: false,
      initial: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    };
  });

  const entry = boxes.find((b) => b.isEntry);
  const exteriorArrow: Arrow | null = entry
    ? { id: newArrowId(), level: 0, hostId: entry.id, kind: "exterior-main", side: 3, t: 0.5, dir: 1 }
    : null;

  return {
    id: `${program.id}__${plotTemplate.id}`,
    label: `${program.label} on ${plotTemplate.label}`,
    plot,
    boxes,
    arrows: exteriorArrow ? [exteriorArrow] : [],
  };
}

/** The scenario's own boundary as a polygon -- `geometry/generate.ts`
 * takes a boundary polygon, not a `Plot`, for exactly this reuse. */
export function boundaryOf(plot: Plot): ReturnType<typeof rectPolyOf> {
  return rectPolyOf({ left: plot.left, top: plot.top, width: plot.width, height: plot.depth });
}
