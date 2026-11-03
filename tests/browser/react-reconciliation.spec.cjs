const { test, expect } = require("./fixture.cjs");

// A node the userscript detached from Healthie's tree only throws when React next reconciles
// that subtree, so markup assertions taken right after injection cannot see the fight. Every
// surface the harness models is driven through the renders that do expose it: a second
// injection, a delete, a restore, patient navigation and a full unmount. Adding a row here is
// how a new surface gets that coverage.

async function mockHomeViewer(page) {
  await page.addInitScript(() => localStorage.setItem("blog:token", "synthetic-viewer"));
  await page.route("https://*.gethealthie.com/graphql", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ data: { currentUser: { id: "42", is_patient: false, full_name: "Test Clinician" } } }),
  }));
}

const surfaces = [
  {
    name: "Home provider schedule",
    url: "/",
    setup: mockHomeViewer,
    inject: "Inject appointments",
    owned: "[data-testid='misha-home-appointments']",
    native: "[data-testid='home-native']",
  },
  {
    name: "patient Overview appointments",
    url: "/users/123/Overview",
    inject: "Inject appointments",
    owned: "[data-testid='misha-appointments']",
    native: "[data-testid='cop-appointments-contents']",
    patient: true,
  },
  {
    name: "legacy patient Overview appointments",
    url: "/users/123/Overview?layout=legacy",
    inject: "Inject appointments",
    owned: "[data-testid='misha-appointments']",
    native: "[data-testid='legacy-area']",
    patient: true,
  },
  {
    name: "patient sidebar basic information",
    url: "/users/123/Overview?sidebar=1",
    inject: "Inject appointments",
    owned: ".misha-iframe-container",
    native: ".BasicInfo_basicInfo",
    patient: true,
  },
  {
    name: "client list Book session",
    url: "/clients/active?booking=1",
    inject: "Inject appointments",
    owned: "[data-testid='misha-book-session-button']",
    native: "[data-testid='client-row-11']",
  },
  {
    // waitForAddPatientButton intercepts clicks instead of adding a node, so it has no owned node.
    name: "Add client interception",
    url: "/clients/active?clients=1",
    inject: "Inject Add client",
    native: "[data-testid='unrelated-client-control']",
  },
];

for (const surface of surfaces) {
  test(`${surface.name} survives React reconciliation after injection`, async ({ page }) => {
    await surface.setup?.(page);
    await page.goto(surface.url);
    const nativeCount = await page.locator(surface.native).count();
    expect(nativeCount, "fixture renders the native node this surface replaces").toBeGreaterThan(0);

    const injectButton = page.getByRole("button", { name: surface.inject, exact: true });
    await injectButton.click();
    let ownedCount = 0;
    if (surface.owned) {
      await expect(page.locator(surface.owned)).not.toHaveCount(0);
      ownedCount = await page.locator(surface.owned).count();
    }

    // Healthie's polling re-enters these functions. A second pass must not leave React a
    // duplicate tree to reconcile.
    await injectButton.click();
    if (surface.owned) await expect(page.locator(surface.owned)).toHaveCount(ownedCount);
    await expect(page.getByTestId("errors")).toHaveText("");

    // React deletes children it rendered, then renders them again.
    await page.locator("#refresh").click();
    await expect(page.getByTestId("errors")).toHaveText("");
    await page.locator("#restore").click();
    await expect(page.getByTestId("errors")).toHaveText("");
    await expect(page.locator(surface.native)).toHaveCount(nativeCount);
    if (surface.owned) await expect(page.locator(surface.owned)).toHaveCount(ownedCount);

    if (surface.patient) {
      await page.locator("#patient").click();
      await expect(page.getByTestId("errors")).toHaveText("");
    }

    // React removes everything it owns. A node the userscript detached makes this throw.
    await page.locator("#unmount").click();
    await expect(page.locator("#overview")).toBeEmpty();
  });
}
