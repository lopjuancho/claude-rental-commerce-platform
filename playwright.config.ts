import { defineConfig, devices } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  // E2E_START_SERVER=1 builds nothing; it starts the already-built app (`pnpm build` first).
  ...(process.env.E2E_START_SERVER === "1"
    ? {
        webServer: {
          command: "pnpm start",
          url: "http://localhost:3000/api/health",
          reuseExistingServer: false,
          timeout: 60_000,
        },
      }
    : {}),
  projects: [
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
});
