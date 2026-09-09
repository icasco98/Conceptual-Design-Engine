import { test, expect } from "@playwright/test";

test.describe("the side column is tabbed: Schedule, Circulation, Plot, Save", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".plan-svg");
  });

  test("opens on Schedule, and only one tab's panel is on screen at a time", async ({ page }) => {
    await expect(page.locator(".schedule")).toBeVisible();
    await expect(page.locator(".actors-pane")).toHaveCount(0);
    await expect(page.locator(".plot-panel")).toHaveCount(0);
    await expect(page.locator(".sidebar")).toHaveCount(0);

    await page.getByRole("tab", { name: "Circulation" }).click();
    await expect(page.locator(".actors-pane")).toBeVisible();
    await expect(page.locator(".schedule")).toHaveCount(0);

    await page.getByRole("tab", { name: "Plot" }).click();
    await expect(page.locator(".plot-panel")).toBeVisible();
    await expect(page.locator(".actors-pane")).toHaveCount(0);

    await page.getByRole("tab", { name: "Save" }).click();
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.locator(".plot-panel")).toHaveCount(0);
  });

  test("switching tabs does not touch the drawing -- undo history is unaffected", async ({ page }) => {
    const before = await page.locator(".plan-svg .box").count();
    await page.getByRole("tab", { name: "Plot" }).click();
    await page.getByRole("tab", { name: "Save" }).click();
    await page.getByRole("tab", { name: "Schedule" }).click();
    await expect(page.locator(".plan-svg .box")).toHaveCount(before);
    await page.keyboard.press("Control+z");
    await expect(page.locator(".plan-svg .box")).toHaveCount(before);
  });
});
