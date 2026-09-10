/**
 * A static SVG render of one scenario's plot boundary and room footprint
 * -- the visual confirmation for a claim this mode makes (most often
 * "this program does not fit this plot"), not a replacement for the
 * app's own Canvas2D. Built directly from `Box`/`Plot` data with plain
 * string templating: this runs in the harness's Node context, not a
 * browser, so there is no DOM to draw into.
 *
 * `renderScenarioSVG` returns a *fragment* -- an `<svg>` element, not a
 * file. `scenarioPageHTML` is what actually gets written to disk, and it
 * exists because a bare `.svg` file is not something the person who owns
 * this project can open: double-clicking one gets an editor, a download
 * prompt, or nothing at all, depending on the machine. An `.html` file
 * with the same SVG inlined opens in their browser on one double-click,
 * with no dev server, no build step and no network fetch -- and it can
 * carry several diagrams and their captions side by side, which a single
 * `.svg` cannot. Every visual this mode produces goes through it.
 */
import { polyOfBox } from "./geometry/poly";
import { isOutsidePlot } from "./geometry/plot";
import type { Box, Plot } from "./geometry/types";

const PADDING_M = 2;
const PX_PER_M = 14;

function pt(p: readonly [number, number]): string {
  return `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
}

/** Room names and captions are ordinary text that ends up inside markup.
 * Nothing here comes from a stranger, but a room a person names `Kids &
 * Play` would otherwise silently produce a broken document, which is a
 * confusing way to find out about it. */
function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface RenderCaption {
  title: string;
  lines: string[];
}

/** `boxes` drawn over `plot`'s own boundary -- any room `isOutsidePlot`
 * flags (even partly) is drawn in the warning color, exactly the same
 * fact the status bar's own "Outside the plot" line reports, so this
 * never disagrees with what the app itself would say about the same
 * arrangement. */
export function renderScenarioSVG(plot: Plot, boxes: Box[], caption: RenderCaption): string {
  const minX = -PADDING_M;
  const minY = -PADDING_M;
  const maxX = plot.width + PADDING_M;
  const maxY = plot.depth + PADDING_M;
  const w = (maxX - minX) * PX_PER_M;
  const h = (maxY - minY) * PX_PER_M;
  const captionH = 24 + caption.lines.length * 16;

  const toPx = (p: readonly [number, number]): [number, number] => [(p[0] - minX) * PX_PER_M, (p[1] - minY) * PX_PER_M + captionH];

  const plotRect = `<rect x="${(-minX) * PX_PER_M}" y="${(-minY) * PX_PER_M + captionH}" width="${plot.width * PX_PER_M}" height="${plot.depth * PX_PER_M}" fill="#f4f6f5" stroke="#8a8f8c" stroke-width="1.5" stroke-dasharray="6 4" />`;

  const rooms = boxes
    .map((b) => {
      const outside = isOutsidePlot(b, plot);
      const poly = polyOfBox(b).map((p) => toPx(p));
      const points = poly.map(pt).join(" ");
      const fill = outside ? "#f8d3ce" : "#cfe0e8";
      const stroke = outside ? "#c0392b" : "#3d5a66";
      const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
      const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
      const label = esc(b.name.length > 16 ? `${b.roomType}` : b.name);
      return [
        `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" ${outside ? 'stroke-dasharray="3 2"' : ""} />`,
        `<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" font-size="9" text-anchor="middle" fill="#20302f" font-family="sans-serif">${label}</text>`,
      ].join("\n    ");
    })
    .join("\n    ");

  const captionLines = [`<text x="12" y="18" font-size="14" font-weight="600" font-family="sans-serif" fill="#1a1a1a">${esc(caption.title)}</text>`]
    .concat(caption.lines.map((line, i) => `<text x="12" y="${34 + i * 16}" font-size="12" font-family="sans-serif" fill="#4a4a4a">${esc(line)}</text>`))
    .join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h + captionH}" viewBox="0 0 ${w} ${h + captionH}">
  <rect width="100%" height="100%" fill="#ffffff" />
  ${captionLines}
  ${plotRect}
  ${rooms}
</svg>`;
}

export interface ScenarioPanel {
  /** A short heading above this diagram -- "before", "after", the name of
   * the rule being shown. */
  heading: string;
  /** Plain-language sentences under the heading, above the diagram. */
  notes?: string[];
  /** Whatever `renderScenarioSVG` returned for this panel. */
  svg: string;
}

/**
 * One self-contained `.html` file carrying `panels` in order -- the thing
 * this mode actually writes to disk. Everything is inline: no stylesheet
 * to fetch, no script, no web font, no image URL. That is the whole point
 * -- the file has to open correctly on a machine with no dev server
 * running, no network, and nothing installed, by double-clicking it.
 *
 * Deliberately not a template with slots for scores or findings: this
 * knows how to lay out headings, notes and diagrams, and nothing about
 * what a scenario means. Whatever wants to say something about a plan
 * writes the sentence and hands it over, exactly as `renderScenarioSVG`
 * already takes its caption rather than composing one.
 */
export function scenarioPageHTML(title: string, panels: ScenarioPanel[]): string {
  const body = panels
    .map((panel) => {
      const notes = (panel.notes ?? []).map((line) => `      <p>${esc(line)}</p>`).join("\n");
      return [`    <section>`, `      <h2>${esc(panel.heading)}</h2>`, notes, `      <figure>${panel.svg}</figure>`, `    </section>`]
        .filter((line) => line.length)
        .join("\n");
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>
  body { margin: 0; padding: 24px; background: #f7f7f5; color: #1a1a1a;
         font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.5; }
  h1 { font-size: 20px; margin: 0 0 20px; }
  section { background: #fff; border: 1px solid #ddd; border-radius: 6px;
            padding: 16px; margin: 0 0 20px; }
  h2 { font-size: 15px; margin: 0 0 8px; }
  p { margin: 0 0 8px; font-size: 13px; color: #444; max-width: 70ch; }
  figure { margin: 12px 0 0; overflow-x: auto; }
  svg { max-width: 100%; height: auto; display: block; }
</style>
</head>
<body>
  <h1>${esc(title)}</h1>
${body}
</body>
</html>
`;
}
