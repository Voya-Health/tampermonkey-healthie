const { test: base, expect } = require("@playwright/test");

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === "http://127.0.0.1:4175") return route.continue();
      if (["https://misha.vorihealth.com", "https://qa.misha.vori.health"].includes(url.origin)) {
        return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Synthetic Add client dialog</title>" });
      }
      errors.push(`Unexpected external request: ${url.origin}`);
      return route.abort();
    });
    await use(page);
    expect(errors).toEqual([]);
    await expect(page.getByTestId("errors")).toHaveText("");
  },
});

async function injectClient(page, query = "layout=modern") {
  await page.goto(`/clients/active?clients=1&${query}`);
  await page.getByRole("button", { name: "Inject Add client", exact: true }).click();
}

for (const layout of ["modern", "legacy", "bare"]) {
  test(`Add client opens Misha from ${layout} markup`, async ({ page }) => {
    await injectClient(page, `layout=${layout}`);
    await page.getByRole("button", { name: "Add IconAdd client", exact: true }).click();
    await expect(page.locator(".overlay-dialog iframe"))
      .toHaveAttribute("src", "https://misha.vorihealth.com/createPatientDialog");
    await expect(page.getByTestId("native-clicks")).toHaveText("0");
    await page.locator(".close-button").click();
    await page.getByRole("button", { name: "Refresh appointments", exact: true }).click();
    await page.getByRole("button", { name: "Restore appointments", exact: true }).click();
    await page.getByRole("button", { name: "Add IconAdd client", exact: true }).click();
    await expect(page.locator(".overlay-dialog iframe"))
      .toHaveAttribute("src", "https://misha.vorihealth.com/createPatientDialog");
    await expect(page.getByTestId("native-clicks")).toHaveText("0");
    await page.locator(".close-button").click();
    await page.getByRole("button", { name: "Unmount Overview", exact: true }).click();
    await expect(page.locator("#overview")).toBeEmpty();
  });
}

test("repeated setup intercepts keyboard activation once and ignores other controls", async ({ page }) => {
  await injectClient(page);
  await page.getByRole("button", { name: "Inject Add client", exact: true }).click();
  await page.getByTestId("unrelated-client-control").click();
  await expect(page.locator(".overlay-dialog")).toHaveCount(0);
  await page.evaluate(() => document.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const button = page.getByRole("button", { name: "Add IconAdd client", exact: true });
  await button.focus();
  await button.press("Enter");
  await expect(page.locator(".overlay-dialog")).toHaveCount(1);
  await expect(page.getByTestId("native-clicks")).toHaveText("0");
});

test("hidden legacy controls do not shadow the visible Add client icon", async ({ page }) => {
  await injectClient(page, "layout=bare&hiddenDecoy=1");
  await page.getByRole("button", { name: "Add IconAdd client", exact: true }).locator("svg").click();
  await expect(page.locator(".overlay-dialog iframe"))
    .toHaveAttribute("src", "https://misha.vorihealth.com/createPatientDialog");
  await expect(page.getByTestId("native-clicks")).toHaveText("0");
});

test("delayed Add client rendering is intercepted when the button appears", async ({ page }) => {
  await injectClient(page, "pendingTabs=1");
  await page.getByRole("button", { name: "Load Overview", exact: true }).click();
  await expect.poll(() => page.evaluate(() => timeoutIds.length)).toBe(0);
  await page.getByRole("button", { name: "Add IconAdd client", exact: true }).click();
  await expect(page.locator(".overlay-dialog iframe"))
    .toHaveAttribute("src", "https://misha.vorihealth.com/createPatientDialog");
  await expect(page.getByTestId("native-clicks")).toHaveText("0");
});

test("Add client uses the staging Misha dialog on staging", async ({ page }) => {
  await injectClient(page, "environment=securestaging");
  await page.getByRole("button", { name: "Add IconAdd client", exact: true }).click();
  await expect(page.locator(".overlay-dialog iframe"))
    .toHaveAttribute("src", "https://qa.misha.vori.health/createPatientDialog");
  await expect(page.getByTestId("native-clicks")).toHaveText("0");
});
