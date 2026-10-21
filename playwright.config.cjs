const { defineConfig, devices } = require("@playwright/test");

const baseURL = `http://127.0.0.1:${process.env.HEALTHIE_TEST_PORT || 4175}`;

module.exports = defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 2,
  globalTimeout: 120_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run test:harness",
    url: baseURL,
    reuseExistingServer: false,
  },
});
