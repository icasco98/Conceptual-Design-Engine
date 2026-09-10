/**
 * A static SVG render of one scenario's plot boundary and room footprint
 * -- the visual confirmation for a claim this mode makes (most often
 * "this program does not fit this plot"), not a replacement for the
 * app's own Canvas2D. Built directly from `Box`/`Plot` data with plain
 * string templating: this runs in the harness's Node context, not a
 * browser, so there is no DOM to draw into.
 */
import { polyOfBox } from "./geometry/poly";
import { isOutsidePlot } from "./geometry/plot";
import type { Box, Plot } from "./geometry/types";

const PADDING_M = 2;
const PX_PER_M = 14;

function pt(p: readonly [number, number]): string {
  return `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
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
      const label = b.name.length > 16 ? `${b.roomType}` : b.name;
      return [
        `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" ${outside ? 'stroke-dasharray="3 2"' : ""} />`,
        `<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" font-size="9" text-anchor="middle" fill="#20302f" font-family="sans-serif">${label}</text>`,
      ].join("\n    ");
    })
    .join("\n    ");

  const captionLines = [`<text x="12" y="18" font-size="14" font-weight="600" font-family="sans-serif" fill="#1a1a1a">${caption.title}</text>`]
    .concat(caption.lines.map((line, i) => `<text x="12" y="${34 + i * 16}" font-size="12" font-family="sans-serif" fill="#4a4a4a">${line}</text>`))
    .join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h + captionH}" viewBox="0 0 ${w} ${h + captionH}">
  <rect width="100%" height="100%" fill="#ffffff" />
  ${captionLines}
  ${plotRect}
  ${rooms}
</svg>`;
}
