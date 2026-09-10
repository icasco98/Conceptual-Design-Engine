/// <reference types="node" />
/**
 * Writes a visual confirmation for scenarios the report flags as
 * infeasible (>100% coverage even after the search) -- a diagram, not
 * just a number, so the claim "this program does not fit this plot" can
 * actually be checked by eye. Output lands in `scenario-renders/`
 * (gitignored -- generated, not tracked) for the current run.
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
import { auxiliaryOf, circulationOf, passableOf, tierOf } from "./rooms";
import { renderScenarioSVG, scenarioPageHTML } from "./scenarios.render";
import { boundaryOf, buildScenario, EXAMPLE_PROGRAMS, PLOT_TEMPLATES } from "./scenarios";

const OUT_DIR = new URL("../scenario-renders/", import.meta.url);

function writeOut(name: string, html: string) {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const path = new URL(name, OUT_DIR);
  writeFileSync(path, html);
  return path.pathname;
}

describe("scenario visual confirmation", () => {
  it(
    "renders the naive start and the post-search result for a scenario that does not fit its plot",
    () => {
      const plotTemplate = PLOT_TEMPLATES.find((p) => p.id === "plot_250_square")!;
      const program = EXAMPLE_PROGRAMS.find((p) => p.id === "extended_gulf")!;
      const { plot, boxes, arrows } = buildScenario(plotTemplate, program);

      const startArrows = [...arrows, ...suggestArrows(boxes, arrows, 0, false)];
      const startScore = scoreCandidate(boxes, 1, startArrows, false, passableOf, tierOf, auxiliaryOf, circulationOf);
      const startCoverage = footprintCoverage(boxes, 0, false, plot);

      const startSvg = renderScenarioSVG(plot, boxes, {
        title: `${program.label} on ${plotTemplate.label} -- naive start`,
        lines: [
          `${boxes.length} rooms, ${(plot.width * plot.depth).toFixed(0)} m² plot`,
          `coverage ${(startCoverage * 100).toFixed(0)}% -- hard ${startScore.hardProblems}, soft ${startScore.softRecommendations.toFixed(1)}`,
          "Rooms with a red dashed outline sit outside the plot boundary.",
        ],
      });

      const boundary = boundaryOf(plot);
      const result = generateLayout(boxes, 0, 1, startArrows, false, boundary, passableOf, tierOf, auxiliaryOf, circulationOf, undefined, {
        iterations: 800,
        seed: 11,
      });
      const resultArrows = [...arrows, ...suggestArrows(result, arrows, 0, false)];
      const resultScore = scoreCandidate(result, 1, resultArrows, false, passableOf, tierOf, auxiliaryOf, circulationOf);
      const resultCoverage = footprintCoverage(result, 0, false, plot);

      const resultSvg = renderScenarioSVG(plot, result, {
        title: `${program.label} on ${plotTemplate.label} -- after generateLayout`,
        lines: [
          `${result.length} rooms, ${(plot.width * plot.depth).toFixed(0)} m² plot`,
          `coverage ${(resultCoverage * 100).toFixed(0)}% -- hard ${resultScore.hardProblems}, soft ${resultScore.softRecommendations.toFixed(1)}`,
          "Still over 100%: the search can reposition and shrink to each room's own minimum, never remove a room.",
        ],
      });

      const path = writeOut(
        "extended_gulf_on_250_square.html",
        scenarioPageHTML(`${program.label} on ${plotTemplate.label}`, [
          {
            heading: "Before: the naive shelf-packed start",
            notes: ["Every room at its typical size, laid out in simple rows with a gap between each. Nothing touches, so nothing is connected yet."],
            svg: startSvg,
          },
          {
            heading: "After: what the placement search settled on",
            notes: ["The search may move, turn and shrink rooms (never below each room's own minimum), but it may never delete one -- so a program bigger than the lot stays bigger than the lot."],
            svg: resultSvg,
          },
        ]),
      );

      console.log("Wrote", path);
      // The whole point of this scenario: it does not fit before or
      // after the search. If either of these ever comes back under 100%,
      // the room program changed -- not a passing/failing generator.
      expect(startCoverage).toBeGreaterThan(1);
      expect(resultCoverage).toBeGreaterThan(1);
    },
    30_000,
  );
});
