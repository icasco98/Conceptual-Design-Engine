import { defineConfig, devices } from "@playwright/test";

/**
 * The interactive layer's own test tier: real pointer events over real
 * SVG geometry (`getScreenCTM`, pointer capture), which jsdom cannot
 * simulate -- this is why it is a separate suite from `vitest`, not a
 * replacement for it. Runs against the plain Vite dev server, never the
 * Python backend: per HANDOFF.md, "the editor must never depend on the
 * backend," and neither should the suite that checks it.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : "html",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Set only in environments that pin their own Chromium build
        // outside Playwright's normal install path; CI and a normal dev
        // machine both leave this unset and get Playwright's own browser.
        ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } } : {}),
      },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
