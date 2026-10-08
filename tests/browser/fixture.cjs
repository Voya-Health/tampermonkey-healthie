const { test: base, expect } = require("@playwright/test");

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === "http://127.0.0.1:4175") return route.continue();
      if (["https://misha.vorihealth.com", "https://qa.misha.vori.health"].includes(url.origin)) {
        return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Misha fixture</title>Mock Misha response" });
      }
      errors.push(`Unexpected external request: ${url.origin}`);
      return route.abort();
    });
    await use(page);
    expect(errors, "Browser errors and unexpected external requests").toEqual([]);
    await expect(page.getByTestId("errors")).toHaveText("");
  },
});

module.exports = { test, expect };
