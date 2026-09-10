/// <reference types="node" />
/**
 * The regression guardrail for the rule set.
 *
 * `scenarios.report.test.ts` prints what every scenario scores; nothing
 * before this asserted that those numbers never quietly get *worse*. That
 * matters most exactly when the rule set is being extended: a new check
 * that accidentally fires on arrangements it was never meant to describe,
 * or a change that makes the search stop satisfying a rule it used to,
 * both show up here as a scenario's own hard-problem count creeping up,
 * and nowhere else.
 *
 * The frozen numbers live in `scenarios.baseline.json`, in version
 * control, keyed by scenario id. This test re-runs the same suite with
 * the same per-scenario seeds and the same iteration count, so the
 * comparison is like for like -- `runScenario` is deterministic by
 * construction (`seedFor`), which is the only reason a frozen number is
 * meaningful at all.
 *
 * Only hard problems are asserted, not soft recommendations: a hard
 * problem is a claim that a plan does not work, and a plan that used to
 * work must not silently stop. Soft recommendations are a cost ranking
 * with real continuous magnitudes that legitimately shift a little
 * whenever the search's own tuning changes, so holding them to a frozen
 * number would fail for reasons that are not regressions. They are
 * recorded in the baseline file anyway, for a human reading a diff.
 *
 * Rewriting the baseline is deliberate and manual:
 *
 *     UPDATE_SCENARIO_BASELINE=1 npx vitest run src/scenarios.baseline.test.ts
 *
 * Do that only when an *accepted* new rule legitimately changes what a
 * scenario should score (a real defect the tool could not see before is
 * now counted), and say so in the commit message. Never to make a failing
 * run go green.
 */
import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import baseline from "./scenarios.baseline.json";
import { runAllScenarios } from "./scenarios.harness";

/** Kept in step with the number `scenarios.report.test.ts` prints with,
 * so the two runs describe the same search effort and their numbers can
 * be read side by side. */
export const BASELINE_ITERATIONS = 400;

/** Hard problems are a weighted total, not an integer count
 * (`deadEndHallways` contributes how far past the code limit it runs), so
 * an exact float comparison would fail on arithmetic reordering alone.
 * A thousandth of a problem is not a regression -- and has to be at least
 * that loose: the frozen numbers are themselves stored to 4 decimal
 * places (`toFixed(4)` below), which can round a value up to 0.00005 away
 * from what a fresh run recomputes at full precision. A tighter epsilon
 * than the storage itself can represent would fail on rounding noise
 * alone, on scenarios nothing about actually changed -- caught in batch
 * 002 when adding the `snap` move (which strictly improved 22 of 56
 * scenarios and regressed none) still tripped 3 scenarios purely on this,
 * with the "before" and "after" numbers printed identical to 4 decimals. */
const EPSILON = 1e-3;

interface BaselineRow {
  scenarioId: string;
  label: string;
  startHardProblems: number;
  startSoftRecommendations: number;
  hardProblems: number;
  softRecommendations: number;
  coverage: number;
}

const BASELINE_PATH = new URL("./scenarios.baseline.json", import.meta.url);

describe("scenario regression baseline", () => {
  it(
    "no scenario ends with more hard problems than its frozen baseline",
    () => {
      const results = runAllScenarios(undefined, undefined, BASELINE_ITERATIONS);

      if (process.env.UPDATE_SCENARIO_BASELINE) {
        const rows: BaselineRow[] = results.map((r) => ({
          scenarioId: r.scenarioId,
          label: r.label,
          startHardProblems: Number(r.start.hardProblems.toFixed(4)),
          startSoftRecommendations: Number(r.start.softRecommendations.toFixed(4)),
          hardProblems: Number(r.result.hardProblems.toFixed(4)),
          softRecommendations: Number(r.result.softRecommendations.toFixed(4)),
          coverage: Number(r.result.coverage.toFixed(4)),
        }));
        writeFileSync(BASELINE_PATH, `${JSON.stringify(rows, null, 2)}\n`);
        console.log(`Rewrote the baseline: ${rows.length} scenarios.`);
        return;
      }

      expect(existsSync(BASELINE_PATH)).toBe(true);
      const byId = new Map((baseline as BaselineRow[]).map((row) => [row.scenarioId, row]));

      // A scenario present in one list and not the other is a real
      // mismatch worth failing on, not something to skip past: either a
      // scenario was added without refreshing the baseline (its number
      // was never frozen, so nothing is guarding it) or one was removed
      // (the baseline now claims a scenario that no longer exists).
      expect(results.map((r) => r.scenarioId).sort()).toEqual([...byId.keys()].sort());

      const regressions: string[] = [];
      for (const r of results) {
        const frozen = byId.get(r.scenarioId)!;
        if (r.result.hardProblems > frozen.hardProblems + EPSILON) {
          regressions.push(`${r.label}: ${frozen.hardProblems} -> ${r.result.hardProblems.toFixed(4)} hard problems`);
        }
      }
      expect(regressions).toEqual([]);
    },
    120_000,
  );
});
