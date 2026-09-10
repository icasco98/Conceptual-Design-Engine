/// <reference types="node" />
/**
 * The tuning step, and the record it leaves behind.
 *
 * `scenarios.student.ts` can already hill-climb a `SearchConfig` against
 * the evaluator. What was missing is somewhere for the answer to live:
 * a training run that is thrown away at the end of a terminal session
 * teaches the project nothing, and the next person has no way to tell
 * whether today's `DEFAULT_SEARCH_CONFIG` was ever measured against
 * anything. `scenarios.tuning.json` is that record -- the best config
 * found so far, what it scored, and what the untuned defaults scored on
 * the same run, so the claim "this is better" can be checked rather than
 * taken on trust.
 *
 * Training is expensive (one evaluation is the whole feasible suite), so
 * it does not run as part of `npm test`. The ordinary run of this file
 * only reads the record back and holds it to its own claim: a stored
 * config that is not actually better than the baseline it was measured
 * against has no business being stored. To train:
 *
 *     RUN_TUNING=1 npx vitest run src/scenarios.tuning.test.ts
 *
 * Never-regress works exactly as it does one level down in
 * `generateLayout` and in `train()` itself: a run that fails to beat what
 * is already recorded leaves the record alone. The file only ever moves
 * in one direction.
 *
 * Adopting a trained config as the tool's own default is deliberately a
 * separate, manual decision, not something this file does: changing
 * `DEFAULT_SEARCH_CONFIG` changes what every scenario scores, which the
 * regression baseline (`scenarios.baseline.test.ts`) has to be re-checked
 * against first. The record is the input to that decision, not the
 * decision.
 */
import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DEFAULT_SEARCH_CONFIG, type SearchConfig } from "./geometry/generate";
import { compareEvaluations, evaluateConfig, isFeasible, type EvalScenario, type EvaluationResult } from "./scenarios.evaluator";
import { EXAMPLE_PROGRAMS, PLOT_TEMPLATES } from "./scenarios";
import { train } from "./scenarios.student";
import tuning from "./scenarios.tuning.json";

/** Every (plot, program) pairing whose rooms could fit the lot at their
 * own minimum sizes -- `scenarios.evaluator.ts`'s own reasoning for why
 * an infeasible scenario would score every config equally badly and hide
 * the differences this is trying to measure. */
export function feasibleScenarios(): EvalScenario[] {
  return PLOT_TEMPLATES.flatMap((plot) => EXAMPLE_PROGRAMS.filter((program) => isFeasible(plot, program)).map((program) => ({ plot, program })));
}

interface TuningRecord {
  /** Which batch pass produced this record -- so a reader can line it up
   * with the report and the commit that accepted it. */
  pass: string;
  generations: number;
  iterationsPerEval: number;
  seed: number;
  scenarioCount: number;
  baseline: EvaluationResult;
  best: EvaluationResult;
  config: SearchConfig;
}

const TUNING_PATH = new URL("./scenarios.tuning.json", import.meta.url);

const GENERATIONS = Number(process.env.TUNING_GENERATIONS ?? 30);
const ITERATIONS_PER_EVAL = Number(process.env.TUNING_ITERATIONS ?? 150);
/** Vary this per training run. The seed drives both the hill-climb's own
 * proposals and every evaluation inside it, so re-running a pass with the
 * seed it last used re-derives the identical config and learns nothing --
 * `train` is deterministic by design, starting from the same defaults
 * every time. The incumbent is re-measured under whatever seed the
 * current run uses, so the comparison stays like for like regardless. */
const SEED = Number(process.env.TUNING_SEED ?? 7);

describe("search tuning record", () => {
  it(
    "the recorded config is at least as good as the defaults it was measured against",
    () => {
      if (process.env.RUN_TUNING) {
        const scenarios = feasibleScenarios();
        const result = train(scenarios, GENERATIONS, ITERATIONS_PER_EVAL, SEED);
        const stored = tuning as TuningRecord;
        // `scenarioCount: 0` is the empty record this file ships with
        // before it has ever been trained -- not a config that scored
        // zero hard problems, which is what a naive comparison would
        // read it as, and which nothing could ever beat.
        //
        // The incumbent is re-*measured*, never read off the stored
        // numbers: a record written before a new rule existed was scored
        // by a rule set that could not see that rule, so its stored
        // figures are not comparable with anything measured today.
        // Comparing them directly would reject every honest improvement
        // from the moment the rule set grows, purely because the scale
        // moved. One extra evaluation buys an equal-footing comparison.
        const incumbentEval = stored.scenarioCount > 0 ? evaluateConfig(stored.config, scenarios, ITERATIONS_PER_EVAL, SEED) : null;
        const beatsStored = !incumbentEval || compareEvaluations(result.best.evaluation, incumbentEval) < 0;
        console.log(
          `pass=${process.env.TUNING_PASS ?? "?"} defaults hard=${result.baseline.meanHardProblems.toFixed(3)} clean=${(result.baseline.cleanRate * 100).toFixed(1)}% soft=${result.baseline.meanSoftRecommendations.toFixed(3)}` +
            ` | trained hard=${result.best.evaluation.meanHardProblems.toFixed(3)} clean=${(result.best.evaluation.cleanRate * 100).toFixed(1)}% soft=${result.best.evaluation.meanSoftRecommendations.toFixed(3)}` +
            (incumbentEval
              ? ` | stored config re-measured hard=${incumbentEval.meanHardProblems.toFixed(3)} soft=${incumbentEval.meanSoftRecommendations.toFixed(3)}`
              : " | no stored config yet") +
            ` | accepted generations: ${result.history.filter((h) => h.accepted).length}/${result.history.length}` +
            ` | record updated: ${beatsStored}`,
        );

        if (beatsStored) {
          const record: TuningRecord = {
            pass: process.env.TUNING_PASS ?? stored.pass,
            generations: GENERATIONS,
            iterationsPerEval: ITERATIONS_PER_EVAL,
            seed: SEED,
            scenarioCount: scenarios.length,
            baseline: result.baseline,
            best: result.best.evaluation,
            config: result.best.config,
          };
          writeFileSync(TUNING_PATH, `${JSON.stringify(record, null, 2)}\n`);
        }
        return;
      }

      expect(existsSync(TUNING_PATH)).toBe(true);
      const record = tuning as TuningRecord;
      expect(record.scenarioCount).toBeGreaterThan(0);
      // The whole claim the record makes. A stored config no better than
      // the untuned defaults is not a result, it is noise that would let
      // a later run quietly adopt a worse search.
      expect(compareEvaluations(record.best, record.baseline)).toBeLessThanOrEqual(0);
      // Every field the search loop actually reads has to be present and
      // sane, or adopting this record would silently produce a config
      // `generateLayout` cannot walk with.
      expect(record.config.tEnd).toBeLessThan(record.config.tStart);
      for (const key of ["tStart", "tEnd", "hardProblemWeight", "stepFloorM", "rotFloorDeg", "rotScaleDeg"] as const) {
        expect(record.config[key]).toBeGreaterThan(0);
      }
      expect(record.config.stepScaleM).toBeGreaterThanOrEqual(0);
      for (const key of ["translate", "resize", "rotate", "swap"] as const) {
        expect(record.config.moveWeights[key]).toBeGreaterThan(0);
      }
      // Sanity that the record describes THIS tool's config shape and not
      // a stale one from before a field was added or renamed.
      expect(Object.keys(record.config).sort()).toEqual(Object.keys(DEFAULT_SEARCH_CONFIG).sort());
    },
    1_800_000,
  );
});
