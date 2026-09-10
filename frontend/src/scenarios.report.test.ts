/**
 * The simple report: run every (plot, program) scenario and print what
 * happened. Not a correctness suite for the generator itself (that's
 * geometry/generate.test.ts) -- this is the stress-test surface: read
 * the printed table for where a scenario still ends with hard problems
 * or a heavy soft-recommendation weight after the search has done what
 * it can, and use that to decide what `relationships.ts`'s rule set
 * (`CULTURAL_ROOM_RELATIONSHIPS`, the severity weights) is still missing.
 *
 * Run on its own with `npx vitest run src/scenarios.report.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { runAllScenarios } from "./scenarios.harness";

describe("scenario report", () => {
  it(
    "runs every plot x program scenario and prints the result table",
    () => {
      const results = runAllScenarios(undefined, undefined, 400);

      console.table(
        results.map((r) => ({
          scenario: r.label,
          rooms: r.roomCount,
          "plot m²": r.plotAreaM2,
          "start hard": r.start.hardProblems,
          "start soft": Number(r.start.softRecommendations.toFixed(1)),
          "start cov%": Math.round(r.start.coverage * 100),
          "end hard": r.result.hardProblems,
          "end soft": Number(r.result.softRecommendations.toFixed(1)),
          "end cov%": Math.round(r.result.coverage * 100),
        })),
      );

      const stillHardAfter = results.filter((r) => r.result.hardProblems > 0);
      if (stillHardAfter.length) {
        console.log(`${stillHardAfter.length}/${results.length} scenarios still have hard problems after the search -- worth a closer look.`);
      }
      // Coverage over 100% is a real, legitimate finding, not a bug in
      // the report: it means the program's own room area is larger than
      // the plot can hold at all -- generateLayout can reposition and
      // shrink rooms down to their minimums, but it can never remove a
      // room, so an oversized program for a small plot stays oversized.
      const infeasible = results.filter((r) => r.result.coverage > 1);
      if (infeasible.length) {
        console.log(
          `${infeasible.length}/${results.length} scenarios don't fit their plot at all (>100% coverage) -- the program is too big for the lot, not a generator failure:`,
          infeasible.map((r) => r.label),
        );
      }

      // Sanity, not a pass/fail judgment on the rule set: the search
      // must never leave a scenario worse than its own naive start, and
      // coverage is never negative (it can exceed 1 -- see above).
      for (const r of results) {
        expect(r.improvement).toBeLessThanOrEqual(0);
        expect(r.result.coverage).toBeGreaterThanOrEqual(0);
      }
    },
    30_000,
  );
});
