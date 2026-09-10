/**
 * Runs every (plot, program) scenario through the generator and reports
 * what happened -- the actual stress test `scenarios.ts`'s building
 * blocks exist for.
 *
 * `generateLayout` now re-suggests doors against every candidate it
 * considers (see its own doc comment), so the search itself already
 * responds to reachability, not just gaps and overlaps. This harness
 * still calls `suggestArrows` once more itself, before and after: once
 * to score the naive shelf-packed start fairly (it has no doors of its
 * own yet), and once to hand back a real, persistable door set for
 * whatever position the search actually settled on -- `generateLayout`
 * only returns rooms, never the doors it tried along the way.
 */
import { suggestArrows } from "./geometry/arrows";
import { generateLayout } from "./geometry/generate";
import { footprintCoverage } from "./geometry/footprint";
import { compareScores, scoreCandidate, type Score } from "./geometry/relationships";
import type { Arrow, Box } from "./geometry/types";
import { ROOM_FACTS } from "./rooms";
import { boundaryOf, buildScenario, EXAMPLE_PROGRAMS, PLOT_TEMPLATES, type PlotTemplate, type RoomProgram } from "./scenarios";

/** A short, stable seed from a scenario id -- deterministic across runs
 * (same scenario always searches the same way) without every scenario
 * sharing one seed (which would correlate their random walks). */
function seedFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return h >>> 0;
}

export interface ScenarioResult {
  scenarioId: string;
  label: string;
  plotAreaM2: number;
  roomCount: number;
  start: { hardProblems: number; softRecommendations: number; coverage: number };
  result: { hardProblems: number; softRecommendations: number; coverage: number };
  /** Negative: the search made it better. 0: no change found. Never
   * positive -- generateLayout's own guarantee. */
  improvement: number;
}

function score(boxes: Box[], arrows: Arrow[]): Score {
  return scoreCandidate(boxes, 1, arrows, false, ROOM_FACTS);
}

export function runScenario(plotTemplate: PlotTemplate, program: RoomProgram, iterations = 600): ScenarioResult {
  const { id, label, plot, boxes, arrows } = buildScenario(plotTemplate, program);
  const startArrows = [...arrows, ...suggestArrows(boxes, arrows, 0, false)];
  const startScore = score(boxes, startArrows);

  const boundary = boundaryOf(plot);
  const placed = generateLayout(boxes, 0, 1, startArrows, false, boundary, ROOM_FACTS, undefined, {
    iterations,
    seed: seedFor(id),
  });
  const resultArrows = [...arrows, ...suggestArrows(placed, arrows, 0, false)];
  const resultScore = score(placed, resultArrows);

  return {
    scenarioId: id,
    label,
    plotAreaM2: plotTemplate.width * plotTemplate.depth,
    roomCount: boxes.length,
    start: { hardProblems: startScore.hardProblems, softRecommendations: startScore.softRecommendations, coverage: footprintCoverage(boxes, 0, false, plot) },
    result: {
      hardProblems: resultScore.hardProblems,
      softRecommendations: resultScore.softRecommendations,
      coverage: footprintCoverage(placed, 0, false, plot),
    },
    improvement: compareScores(resultScore, startScore),
  };
}

export function runAllScenarios(programs: RoomProgram[] = EXAMPLE_PROGRAMS, plots: PlotTemplate[] = PLOT_TEMPLATES, iterations?: number): ScenarioResult[] {
  return plots.flatMap((plot) => programs.map((program) => runScenario(plot, program, iterations)));
}
