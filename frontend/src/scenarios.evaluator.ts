/**
 * The evaluator: one aggregate number (well, two -- see below) for how
 * good a `SearchConfig` is, judged across many scenarios at once rather
 * than one. This is what `scenarios.student.ts` optimizes against --
 * the actual test any proposed change to the generator's own tuning has
 * to pass before it's kept.
 *
 * Only *feasible* scenarios count toward the aggregate: a program whose
 * rooms can't fit the plot even at their own minimum sizes
 * (`sum(minWidth * minHeight) > plot area`, a generous lower bound --
 * real feasibility also needs circulation space on top) can never reach
 * zero hard problems no matter how good the search is, so judging a
 * config's quality on those scenarios would be scoring the room program,
 * not the config. `scenarios.render.ts`'s job is showing an infeasible
 * scenario is infeasible; this file's job is not letting one drag down
 * every config equally and hide real differences between them.
 */
import { suggestArrows } from "./geometry/arrows";
import { DEFAULT_SEARCH_CONFIG, generateLayout, type SearchConfig } from "./geometry/generate";
import { scoreCandidate } from "./geometry/relationships";
import { auxiliaryOf, circulationOf, passableOf, roomTypeInfo, tierOf } from "./rooms";
import { boundaryOf, buildScenario, flattenProgram, type PlotTemplate, type RoomProgram } from "./scenarios";

/** A generous lower bound: could this program ever fit this plot at
 * every room's own minimum size? Not a real packing feasibility check
 * (real houses also need circulation space between rooms, which this
 * doesn't account for), but enough to separate "genuinely too big" from
 * "the search just needs to work harder." */
export function isFeasible(plotTemplate: PlotTemplate, program: RoomProgram): boolean {
  const flat = flattenProgram(program.blocks);
  const minArea = flat.reduce((sum, { roomType, count }) => {
    const info = roomTypeInfo(roomType);
    return sum + info.minWidth * info.minHeight * count;
  }, 0);
  return minArea <= plotTemplate.width * plotTemplate.depth;
}

export interface EvalScenario {
  plot: PlotTemplate;
  program: RoomProgram;
}

export interface EvaluationResult {
  scenarioCount: number;
  meanHardProblems: number;
  meanSoftRecommendations: number;
  /** Fraction of scenarios that reached zero hard problems -- the
   * single clearest "did this configuration actually work" number. */
  cleanRate: number;
}

/** Negative: `a` is the better configuration. Same "hard problems decide
 * first" shape as `relationships.ts`'s own `compareScores`, one level up
 * -- mean hard problems across the suite, then mean soft
 * recommendations. */
export function compareEvaluations(a: EvaluationResult, b: EvaluationResult): number {
  return a.meanHardProblems - b.meanHardProblems || a.meanSoftRecommendations - b.meanSoftRecommendations;
}

/** One config, judged against `scenarios` (already filtered to feasible
 * ones by the caller -- see `isFeasible`). `iterations` is per-scenario;
 * kept deliberately lower than the report's own default so a training
 * run (which evaluates many configs) stays fast -- see
 * `scenarios.student.ts` for why that tradeoff is fine during search. */
export function evaluateConfig(config: SearchConfig, scenarios: EvalScenario[], iterations: number, seed: number): EvaluationResult {
  let hardTotal = 0;
  let softTotal = 0;
  let clean = 0;
  for (const { plot: plotTemplate, program } of scenarios) {
    const { plot, boxes, arrows } = buildScenario(plotTemplate, program);
    const startArrows = [...arrows, ...suggestArrows(boxes, arrows, 0, false)];
    const boundary = boundaryOf(plot);
    const result = generateLayout(boxes, 0, 1, startArrows, false, boundary, passableOf, tierOf, auxiliaryOf, circulationOf, undefined, {
      iterations,
      seed,
      config,
    });
    const resultArrows = [...arrows, ...suggestArrows(result, arrows, 0, false)];
    const resultScore = scoreCandidate(result, 1, resultArrows, false, passableOf, tierOf, auxiliaryOf, circulationOf);
    hardTotal += resultScore.hardProblems;
    softTotal += resultScore.softRecommendations;
    if (resultScore.hardProblems === 0) clean++;
  }
  const n = scenarios.length || 1;
  return { scenarioCount: scenarios.length, meanHardProblems: hardTotal / n, meanSoftRecommendations: softTotal / n, cleanRate: clean / n };
}

/** Today's hand-picked defaults, evaluated the same way a trained config
 * would be -- the baseline `scenarios.student.ts` has to beat for a
 * proposed config to be worth anything. */
export function evaluateDefault(scenarios: EvalScenario[], iterations: number, seed: number): EvaluationResult {
  return evaluateConfig(DEFAULT_SEARCH_CONFIG, scenarios, iterations, seed);
}
