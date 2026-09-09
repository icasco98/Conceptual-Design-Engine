import { test, expect } from "@playwright/test";

test.describe("circulation: recording a route end to end", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".plan-svg");
    await page.click('button[title^="Show circulation"]');
    // The Circulation panel is one of the side column's tabs now.
    await page.getByRole("tab", { name: "Circulation" }).click();
  });

  test("recording a route draws it on the plan and shows a distance", async ({ page }) => {
    await page.fill(".actors-pane input.add-zone-name", "Owner");
    await page.click(".actors-pane >> text=+ Add actor");
    const row = page.locator(".actor-row").first();
    await row.getByText("Record route").click();

    for (const name of ["Front Entry", "Living Room", "Dining Room"]) {
      await page.locator(`.room-label:text-is("${name}")`).first().click({ force: true });
    }
    await row.getByText("Done recording").click();

    await expect(row.locator(".waypoint-chip")).toHaveCount(3);
    await expect(row.locator(".actor-dist")).toContainText("m round trip");
    await expect(page.locator('.plan-svg path[id^="circ-"]')).toHaveCount(1);
  });

  test("a staff route into a private zone is flagged; a household route is not", async ({ page }) => {
    await page.fill(".actors-pane input.add-zone-name", "Caterer");
    await page.selectOption(".actors-pane .add-zone-row select.type-select", "servant");
    await page.click(".actors-pane >> text=+ Add actor");
    const row = page.locator(".actor-row").first();
    await row.getByText("Record route").click();
    // Pantry is roomType "closet" -> category_a (private): a caterer has
    // no business there.
    for (const name of ["Garage", "Pantry"]) {
      await page.locator(`.room-label:text-is("${name}")`).first().click({ force: true });
    }
    await row.getByText("Done recording").click();
    await expect(row.locator(".actor-flag")).toBeVisible();
  });

  test("deleting an actor is not undoable -- actors sit outside the drawing's own history", async ({ page }) => {
    await page.fill(".actors-pane input.add-zone-name", "Guest");
    await page.click(".actors-pane >> text=+ Add actor");
    await expect(page.locator(".actor-row")).toHaveCount(1);
    await page.locator(".actor-row").getByTitle("Delete actor").click();
    await expect(page.locator(".actor-row")).toHaveCount(0);
    await page.keyboard.press("Control+z");
    await expect(page.locator(".actor-row")).toHaveCount(0);
  });
});
