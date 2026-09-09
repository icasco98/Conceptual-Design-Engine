import { test, expect } from "@playwright/test";

test.describe("the plan opens on the sample house and the core gestures work", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".plan-svg");
  });

  test("the sample house is on screen with its schedule", async ({ page }) => {
    await expect(page.locator('.room-label:text-is("Kitchen")')).toBeVisible();
    await expect(page.locator(".schedule tbody tr")).not.toHaveCount(0);
  });

  test("clicking a zone selects it, and the schedule row lights up with it", async ({ page }) => {
    await page.locator('.room-label:text-is("Kitchen")').first().click({ force: true });
    await expect(page.locator(".plan-svg .box.selected")).toHaveCount(1);
    await expect(page.locator(".schedule tr.selected")).toHaveCount(1);
  });

  test("drawing a rectangle adds a zone, and undo takes it back off", async ({ page }) => {
    const before = await page.locator(".plan-svg .box").count();
    await page.click('button[title^="Draw a rectangle zone"]');
    const svg = page.locator(".plan-svg");
    const box = await svg.boundingBox();
    if (!box) throw new Error("no plan bounding box");
    // Well clear of the sample house, drawn top-left of the sheet.
    await page.mouse.move(box.x + 60, box.y + 60);
    await page.mouse.down();
    await page.mouse.move(box.x + 160, box.y + 140, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator(".plan-svg .box")).toHaveCount(before + 1);

    await page.keyboard.press("Control+z");
    await expect(page.locator(".plan-svg .box")).toHaveCount(before);
  });

  test("Suggest re-adds an arrow once one is deleted -- the sample already has one everywhere", async ({ page }) => {
    const before = await page.locator(".plan-svg .arrow").count();
    await page.locator(".plan-svg .arrow").first().click({ force: true });
    await page.keyboard.press("Delete");
    await expect(page.locator(".plan-svg .arrow")).toHaveCount(before - 1);

    await page.click('button[title="Suggest door arrows for zones that have none"]');
    await expect(page.locator(".plan-svg .arrow")).toHaveCount(before);
  });
});
