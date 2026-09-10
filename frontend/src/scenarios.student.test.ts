/**
 * Actually trains the generator's own search configuration and reports
 * whether it beat the hand-picked defaults -- the "did the student learn
 * anything" check. Trains on a small subset of feasible scenarios (fast
 * enough to try many generations), then validates the result on a
 * disjoint, larger held-out set at higher iteration count -- so a
 * result that only looks good because it overfit six specific scenarios
 * gets caught here, not left as an unverified claim.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_SEARCH_CONFIG } from "./geometry/generate";
import { EXAMPLE_PROGRAMS, PLOT_TEMPLATES } from "./scenarios";
import { compareEvaluations, evaluateConfig, isFeasible, type EvalScenario } from "./scenarios.evaluator";
import { train } from "./scenarios.student";

const ALL_SCENARIOS: EvalScenario[] = PLOT_TEMPLATES.flatMap((plot) => EXAMPLE_PROGRAMS.map((program) => ({ plot, program })));
const FEASIBLE = ALL_SCENARIOS.filter((s) => isFeasible(s.plot, s.program));

// A deterministic 1-in-6 split: small enough to train many generations
// quickly, disjoint from validation so a win there isn't just
// overfitting to the exact scenarios trained on.
const TRAIN = FEASIBLE.filter((_, i) => i % 6 === 0);
const VALIDATION = FEASIBLE.filter((_, i) => i % 6 !== 0);

describe("scenarios.student: training the generator's own search config", () => {
  it(
    "trains on a subset, validates on a disjoint held-out set, and reports whether it actually generalizes",
    () => {
      expect(TRAIN.length).toBeGreaterThan(3);
      expect(VALIDATION.length).toBeGreaterThan(TRAIN.length);

      const result = train(TRAIN, /* generations */ 20, /* iterationsPerEval */ 250, /* seed */ 20260910);

      const accepted = result.history.filter((h) => h.accepted);
      console.log(
        `Training: ${result.history.length} generations tried, ${accepted.length} accepted.`,
        `Baseline (train set): hard=${result.baseline.meanHardProblems.toFixed(2)} soft=${result.baseline.meanSoftRecommendations.toFixed(2)} clean=${(result.baseline.cleanRate * 100).toFixed(0)}%`,
        `Best found (train set): hard=${result.best.evaluation.meanHardProblems.toFixed(2)} soft=${result.best.evaluation.meanSoftRecommendations.toFixed(2)} clean=${(result.best.evaluation.cleanRate * 100).toFixed(0)}%`,
      );

      // Validate: the trained config and the baseline, both re-evaluated
      // on scenarios neither ever trained against, at a higher iteration
      // count than training used (a fairer, more accurate final read).
      const validationIterations = 400;
      const baselineOnValidation = evaluateConfig(DEFAULT_SEARCH_CONFIG, VALIDATION, validationIterations, 777);
      const trainedOnValidation = evaluateConfig(result.best.config, VALIDATION, validationIterations, 777);

      console.log(
        `Validation (${VALIDATION.length} held-out scenarios):`,
        `default: hard=${baselineOnValidation.meanHardProblems.toFixed(2)} soft=${baselineOnValidation.meanSoftRecommendations.toFixed(2)} clean=${(baselineOnValidation.cleanRate * 100).toFixed(0)}%`,
        `trained: hard=${trainedOnValidation.meanHardProblems.toFixed(2)} soft=${trainedOnValidation.meanSoftRecommendations.toFixed(2)} clean=${(trainedOnValidation.cleanRate * 100).toFixed(0)}%`,
      );

      const verdict = compareEvaluations(trainedOnValidation, baselineOnValidation);
      if (verdict < 0) console.log("The trained config generalizes: it beats the default on scenarios it never trained on.");
      else if (verdict === 0) console.log("The trained config ties the default on held-out scenarios -- no real improvement found this run.");
      else console.log("The trained config is WORSE on held-out scenarios than the default -- overfit to the training set, do not adopt it.");

      console.log("Trained config:", JSON.stringify(result.best.config));

      // Sanity, not a judgment on whether training succeeded this run:
      // training must never lose track of its own baseline (the
      // reported "best" on the training set is never worse than the
      // default was on that same set -- train() already guarantees
      // this structurally), and every evaluation must be a well-formed
      // fraction/non-negative mean.
      expect(compareEvaluations(result.best.evaluation, result.baseline)).toBeLessThanOrEqual(0);
      for (const evalResult of [baselineOnValidation, trainedOnValidation]) {
        expect(evalResult.meanHardProblems).toBeGreaterThanOrEqual(0);
        expect(evalResult.meanSoftRecommendations).toBeGreaterThanOrEqual(0);
        expect(evalResult.cleanRate).toBeGreaterThanOrEqual(0);
        expect(evalResult.cleanRate).toBeLessThanOrEqual(1);
      }
    },
    120_000,
  );
});
