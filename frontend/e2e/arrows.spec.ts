import { test, expect } from "@playwright/test";

test.describe("door arrows: two-way, and flagged once a carve takes their wall", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".plan-svg");
  });

  test("a door arrow has an arrowhead on both ends, not just one", async ({ page }) => {
    const line = page.locator(".plan-svg .arrow.interior line[marker-end]").first();
    await expect(line).toHaveAttribute("marker-start", /door-arrow/);
    await expect(line).toHaveAttribute("marker-end", /door-arrow/);
  });

  test("carving directly over a door's wall flags it, drawn dashed rather than left on its old (now hidden) raw position", async ({ page }) => {
    const before = page.locator(".plan-svg .arrow.stale");
    await expect(before).toHaveCount(0);

    const firstArrow = page.locator(".plan-svg .arrow.interior").first();
    const arrowBox = await firstArrow.boundingBox();
    if (!arrowBox) throw new Error("no arrow bounding box");

    // Draw a rectangle straight over that door's own wall.
    await page.click('button[title^="Draw a rectangle zone"]');
    const cx = arrowBox.x + arrowBox.width / 2;
    const cy = arrowBox.y + arrowBox.height / 2;
    await page.mouse.move(cx - 40, cy - 40);
    await page.mouse.down();
    await page.mouse.move(cx + 40, cy + 40, { steps: 5 });
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
});
