/**
 * The student: an outer search over `geometry/generate.ts`'s own
 * `SearchConfig` (how the placement search walks -- step sizes, the
 * annealing schedule, which move kinds it favors), scored by
 * `scenarios.evaluator.ts` across many scenarios at once. This is the
 * actual training loop -- the part that was missing before: not a
 * report you read, a process that proposes a change, measures it against
 * the evaluator, and keeps it only if it measurably wins.
 *
 * What this does NOT touch, on purpose, same boundary the whole tool has
 * kept since the first plan: `relationships.ts`'s rule set (what counts
 * as a good layout) and every room's program/type/tier. Only *how hard
 * and how cleverly the search looks* is up for tuning here -- the
 * student can make the generator better at satisfying the existing
 * rules, it can never redefine them.
 *
 * Hill-climbing, not anything fancier: `SearchConfig` is a handful of
 * independent numbers, there's no reason to reach for a genetic
 * algorithm or gradient descent over a tiny, mostly-uncorrelated
 * parameter space. Propose one perturbed config, evaluate it, keep it
 * only if `compareEvaluations` says it's strictly better -- the same
 * "never regress, track the best separately from the walk" shape
 * `generateLayout` itself already uses one level down.
 */
import { DEFAULT_SEARCH_CONFIG, type SearchConfig } from "./geometry/generate";
import { compareEvaluations, evaluateConfig, type EvalScenario, type EvaluationResult } from "./scenarios.evaluator";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `v`, scaled by a random factor in `[1/spread, spread]` -- e.g.
 * `spread = 1.3` moves a number by up to +/-30%. Multiplicative, not
 * additive: `SearchConfig`'s fields span very different scales (2
 * degrees to 1000), so one fixed +/- step would be meaningless for most
 * of them. */
function jitter(v: number, rng: () => number, spread = 1.3): number {
  const factor = 1 / spread + rng() * (spread - 1 / spread);
  return v * factor;
}

const MOVE_KEYS = ["translate", "resize", "rotate", "swap"] as const;

/** One field of `config`, nudged -- never producing a nonsensical config
 * (`tEnd` always stays below `tStart`, every size/weight stays
 * positive). Small, deliberately: this is local search around a
 * reasonable starting point (today's hand-picked defaults), not a search
 * from a blank slate. */
function perturbConfig(config: SearchConfig, rng: () => number): SearchConfig {
  const field = Math.floor(rng() * 7);
  const next: SearchConfig = { ...config, moveWeights: { ...config.moveWeights } };
  switch (field) {
    case 0:
      next.tStart = Math.max(0.01, jitter(config.tStart, rng));
      break;
    case 1:
      next.tEnd = Math.max(1e-5, Math.min(next.tStart - 1e-4, jitter(config.tEnd, rng)));
      break;
    case 2:
      next.hardProblemWeight = Math.max(1, jitter(config.hardProblemWeight, rng));
      break;
    case 3:
      next.stepFloorM = Math.max(0.01, jitter(config.stepFloorM, rng));
      break;
    case 4:
      next.stepScaleM = Math.max(0, jitter(config.stepScaleM, rng));
      break;
    case 5:
      next.rotFloorDeg = Math.max(0, jitter(config.rotFloorDeg, rng));
      next.rotScaleDeg = Math.max(0, jitter(config.rotScaleDeg, rng));
      break;
    default: {
      const key = MOVE_KEYS[Math.floor(rng() * MOVE_KEYS.length)];
      next.moveWeights[key] = Math.max(0.05, jitter(config.moveWeights[key], rng));
    }
  }
  // Keep tEnd < tStart even when case 0 alone raised tStart past a
  // tEnd that was already fine.
  if (next.tEnd >= next.tStart) next.tEnd = next.tStart * 0.01;
  return next;
}

export interface TrainingStep {
  generation: number;
  accepted: boolean;
  config: SearchConfig;
  evaluation: EvaluationResult;
}

export interface TrainingResult {
  baseline: EvaluationResult;
  best: { config: SearchConfig; evaluation: EvaluationResult };
  /** Every generation that was tried and accepted -- the training log,
   * for anyone who wants to see how the search actually got there, not
   * just the endpoint. */
  history: TrainingStep[];
}

/**
 * Runs `generations` rounds of propose-evaluate-keep against
 * `scenarios`, starting from `DEFAULT_SEARCH_CONFIG`. Deterministic for
 * a given `seed` -- same seed, same training run, same result, the same
 * property `generateLayout`'s own seed already has and for the same
 * reason (so a claimed improvement can actually be reproduced and
 * checked, not just asserted).
 */
export function train(scenarios: EvalScenario[], generations: number, iterationsPerEval: number, seed: number): TrainingResult {
  const rng = mulberry32(seed);
  const baseline = evaluateConfig(DEFAULT_SEARCH_CONFIG, scenarios, iterationsPerEval, seed);

  let bestConfig = DEFAULT_SEARCH_CONFIG;
  let bestEval = baseline;
  const history: TrainingStep[] = [];

  for (let gen = 0; gen < generations; gen++) {
    const candidateConfig = perturbConfig(bestConfig, rng);
    const candidateEval = evaluateConfig(candidateConfig, scenarios, iterationsPerEval, seed);
    const accepted = compareEvaluations(candidateEval, bestEval) < 0;
    if (accepted) {
      bestConfig = candidateConfig;
      bestEval = candidateEval;
    }
    history.push({ generation: gen, accepted, config: candidateConfig, evaluation: candidateEval });
  }

  return { baseline, best: { config: bestConfig, evaluation: bestEval }, history };
}
