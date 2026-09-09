import { test, expect } from "@playwright/test";

test.describe("door arrows: two-way, and flagged once a carve takes their wall", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".plan-svg");
  });

  test("a door arrow has an arrowhead on both ends, not just one", async ({ page }) => {
    const line = page.locator(".plan-svg .arrow.exterior-side line[marker-end]").first();
    await expect(line).toHaveAttribute("marker-start", /door-arrow/);
    await expect(line).toHaveAttribute("marker-end", /door-arrow/);
  });

  test("carving directly over a door's wall flags it, drawn dashed rather than left on its old (now hidden) raw position", async ({ page }) => {
    const before = page.locator(".plan-svg .arrow.stale");
    await expect(before).toHaveCount(0);

    // .last(): the diwaniya's own side door -- alone on its own wall,
    // away from the cluster of doors around the entry and clear of the
    // tool rail at the plan's left edge, so a carve centred on it never
    // reaches a neighbour by accident.
    const targetArrow = page.locator(".plan-svg .arrow.exterior-side").last();
    const arrowBox = await targetArrow.boundingBox();
    if (!arrowBox) throw new Error("no arrow bounding box");
    // A door renders at a fixed plan-meter size, so its own screen size
    // is the current zoom level -- scale the carve rectangle from it
    // rather than a fixed pixel count, so this still carves "a bit more
    // than just the one door" regardless of how much of the sample
    // house the view is zoomed out to fit.
    const half = Math.max(arrowBox.width, arrowBox.height) * 1.3;

    // Draw a rectangle straight over that door's own wall.
    await page.click('button[title^="Draw a rectangle zone"]');
    const cx = arrowBox.x + arrowBox.width / 2;
    const cy = arrowBox.y + arrowBox.height / 2;
    await page.mouse.move(cx - half, cy - half);
    await page.mouse.down();
    await page.mouse.move(cx + half, cy + half, { steps: 5 });
    await page.mouse.up();

    // Carve the new (now selected) zone into whatever is under it.
    await page.locator(".plan-svg .box.selected .handle.carve").click({ force: true });

    const stale = page.locator(".plan-svg .arrow.stale");
    await expect(stale).toHaveCount(1);
    // Still two-headed, and still carrying a title explaining why.
    const staleLine = stale.locator("line[marker-end]");
    await expect(staleLine).toHaveAttribute("marker-start", /door-arrow-stale/);
    await expect(staleLine.locator("title")).toHaveText(/last real position/);
  });

  test("the add-door preview hugs the wall under the cursor near a carve, never stretches across the zone's original shape", async ({ page }) => {
    const targetArrow = page.locator(".plan-svg .arrow.exterior-side").last();
    const arrowBox = await targetArrow.boundingBox();
    if (!arrowBox) throw new Error("no arrow bounding box");
    const half = Math.max(arrowBox.width, arrowBox.height) * 1.3;

    await page.click('button[title^="Draw a rectangle zone"]');
    const cx = arrowBox.x + arrowBox.width / 2;
    const cy = arrowBox.y + arrowBox.height / 2;
    await page.mouse.move(cx - half, cy - half);
    await page.mouse.down();
    await page.mouse.move(cx + half, cy + half, { steps: 5 });
    await page.mouse.up();
    await page.locator(".plan-svg .box.selected .handle.carve").click({ force: true });

    // Deselect, then hover the door tool right where the door used to
    // be -- inside the fresh notch, close to where the old, now-hidden
    // raw wall still thinks it runs. A few pixels off dead-centre: the
    // frozen door itself now renders exactly at the centre point and
    // would otherwise be the topmost thing under the cursor there.
    await page.keyboard.press("Escape");
    await page.click('button[title^="Add an interior door arrow"]');
    await page.mouse.move(cx + 10, cy + 10);
    await page.waitForTimeout(80);

    const preview = page.locator(".plan-svg .arrow-preview");
    await expect(preview).toHaveCount(1);
    const seg = await preview.evaluate((el) => ({
      x1: +el.getAttribute("x1")!,
      y1: +el.getAttribute("y1")!,
      x2: +el.getAttribute("x2")!,
      y2: +el.getAttribute("y2")!,
    }));
    const length = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
    // A door graphic is a fixed, short perpendicular tick (twice
    // DOOR_INSET_M) -- nowhere near the span of a whole room -- however
    // far from the wall the raw, uncarved geometry might have placed it
    // before this fix.
    expect(length).toBeLessThan(1);
  });
});
