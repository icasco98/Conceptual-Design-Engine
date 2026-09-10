/// <reference types="node" />
/**
 * Writes a visual confirmation for a scenario that is tight for its
 * plot -- a diagram, not just a number, so a claim about what a tight
 * program's starting layout actually looks like can be checked by eye.
 * Output lands in `scenario-renders/` (gitignored -- generated, not
 * tracked) for the current run.
 *
 * Before batch 002 (topology + dimensioning, `geometry/topology.ts`),
 * this rendered a program whose rooms overflowed the plot at their full
 * typical size -- shelf-packing never shrank anything, so "coverage over
 * 100%" was a real, visible overflow past the plot boundary. The
 * dimensioning stage's slice-and-dice area partition structurally cannot
 * produce that anymore: every recursive split exactly tiles its own
 * rectangle, so the starting layout always covers exactly 100% of the
 * plot, however many rooms are asked to share it. What "this is tight"
 * looks like now is every room's own share shrinking below its typical
 * size instead of the plot boundary being violated -- which is what this
 * file actually shows and asserts on. None of the 56 (plot, program)
 * pairs in `EXAMPLE_PROGRAMS` x `PLOT_TEMPLATES` are genuinely infeasible
 * (`scenarios.evaluator.ts`'s own `isFeasible`, the sum of every room's
 * *minimum* footprint against the plot) -- the scenario below is
 * deliberately the tightest one *at typical size*, not an infeasible one.
 *
 * One self-contained `.html` file, not two bare `.svg` ones: the person
 * this diagram is *for* does not run a dev server, and a `.svg` file does
 * not reliably open by double-clicking on a normal machine. Both diagrams
 * now sit in one page that does, with the before and after next to each
 * other where they can actually be compared.
 *
 * The one file in this mode that touches Node's `fs` directly -- the app
 * itself (`tsconfig.app.json`) deliberately restricts its ambient types
 * to `vite/client` only, so a browser file can never accidentally use a
 * Node global; this triple-slash reference opts just this file in.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { suggestArrows } from "./geometry/arrows";
import { generateLayout } from "./geometry/generate";
import { footprintCoverage } from "./geometry/footprint";
import { scoreCandidate } from "./geometry/relationships";
import { ROOM_FACTS, roomTypeInfo } from "./rooms";
import { renderScenarioSVG, scenarioPageHTML } from "./scenarios.render";
import { boundaryOf, buildScenario, EXAMPLE_PROGRAMS, PLOT_TEMPLATES } from "./scenarios";
import { isFeasible } from "./scenarios.evaluator";

const OUT_DIR = new URL("../scenario-renders/", import.meta.url);

function writeOut(name: string, html: string) {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const path = new URL(name, OUT_DIR);
  writeFileSync(path, html);
  return path.pathname;
}

describe("scenario visual confirmation", () => {
  it(
    "renders the topology+dimensioning start and the post-search result for a scenario too tight to fit at typical room sizes",
    () => {
      const plotTemplate = PLOT_TEMPLATES.find((p) => p.id === "plot_250_square")!;
      const program = EXAMPLE_PROGRAMS.find((p) => p.id === "extended_gulf")!;
      const { plot, boxes, arrows } = buildScenario(plotTemplate, program);

      const startArrows = [...arrows, ...suggestArrows(boxes, arrows, 0, false)];
      const startScore = scoreCandidate(boxes, 1, startArrows, false, ROOM_FACTS);
      const startCoverage = footprintCoverage(boxes, 0, false, plot);
      // The naive-typical-size total, for comparison against what the
      // partition actually gave each room -- see the file doc comment for
      // why `footprintCoverage` alone can no longer tell "tight" from
      // "comfortable" the way it could for the old shelf-packed start.
      const typicalAreaTotal = boxes.reduce((sum, b) => sum + roomTypeInfo(b.roomType).typicalWidth * roomTypeInfo(b.roomType).typicalHeight, 0);
      const actualAreaTotal = boxes.reduce((sum, b) => sum + b.width * b.height, 0);
      const squeezeRatio = actualAreaTotal / typicalAreaTotal;

      const startSvg = renderScenarioSVG(plot, boxes, {
        title: `${program.label} on ${plotTemplate.label} -- topology + dimensioning start`,
        lines: [
          `${boxes.length} rooms, ${(plot.width * plot.depth).toFixed(0)} m² plot`,
          `coverage ${(startCoverage * 100).toFixed(0)}% (the partition always tiles the plot exactly) -- hard ${startScore.hardProblems}, soft ${startScore.softRecommendations.toFixed(1)}`,
          `every room's own share is only ${(squeezeRatio * 100).toFixed(0)}% of its typical size, never below its own minimum -- this is what "tight" looks like now.`,
        ],
      });

      const boundary = boundaryOf(plot);
      const result = generateLayout(boxes, 0, 1, startArrows, false, boundary, ROOM_FACTS, undefined, {
        iterations: 800,
        seed: 11,
      });
      const resultArrows = [...arrows, ...suggestArrows(result, arrows, 0, false)];
      const resultScore = scoreCandidate(result, 1, resultArrows, false, ROOM_FACTS);
      const resultCoverage = footprintCoverage(result, 0, false, plot);

      const resultSvg = renderScenarioSVG(plot, result, {
        title: `${program.label} on ${plotTemplate.label} -- after generateLayout`,
        lines: [
          `${result.length} rooms, ${(plot.width * plot.depth).toFixed(0)} m² plot`,
          `coverage ${(resultCoverage * 100).toFixed(0)}% -- hard ${resultScore.hardProblems}, soft ${resultScore.softRecommendations.toFixed(1)}`,
          "The search may reposition, turn and resize rooms (never below each room's own minimum), but it may never delete one.",
        ],
      });

      const path = writeOut(
        "extended_gulf_on_250_square.html",
        scenarioPageHTML(`${program.label} on ${plotTemplate.label}`, [
          {
            heading: "Before: the topology + dimensioning start",
            notes: [
              "A bubble diagram settles roughly who sits near whom, then a slice-and-dice partition turns that into real rectangles that exactly tile the plot -- every room gets a real, non-overlapping, boundary-respecting share, and this program asks for more typical-size area than the plot actually has, so every room's share comes out smaller than typical (never below its own minimum) instead of spilling past the boundary the way a shelf pack would have.",
            ],
            svg: startSvg,
          },
          {
            heading: "After: what the placement search settled on",
            notes: ["The search may move, turn and resize rooms (never below each room's own minimum), but it may never delete one -- so a program this tight for its lot stays tight after the search too."],
            svg: resultSvg,
          },
        ]),
      );

      console.log("Wrote", path);
      // This scenario is deliberately tight, not infeasible: it still
      // fits at every room's own minimum size (the same ground truth
      // `scenarios.evaluator.ts`'s own `isFeasible` is built on) --
      // that's what makes "every room's typical-size share shrinks, but
      // nothing goes below its floor" a real, checkable claim rather than
      // a foregone conclusion. If this ever comes back false, the room
      // program or plot changed enough that a different one should be
      // chosen for this illustration.
      expect(isFeasible(plotTemplate, program)).toBe(true);
      // The whole point: naive typical sizing genuinely doesn't fit...
      expect(typicalAreaTotal).toBeGreaterThan(plot.width * plot.depth);
      // ...so the partition visibly squeezes every room below typical...
      expect(squeezeRatio).toBeLessThan(0.9);
      // ...while never squeezing any single room below its own minimum,
      // which is the one floor this stage promises to respect whenever
      // the plot has enough total area to honour it (it does here).
      for (const b of boxes) expect(b.width * b.height).toBeGreaterThanOrEqual(b.minWidth * b.minHeight - 1e-6);
    },
    30_000,
  );
});
