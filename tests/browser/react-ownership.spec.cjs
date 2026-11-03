const { test, expect } = require("./fixture.cjs");

// Healthie renders these nodes. Detaching one makes its next render fail on that node,
// which is what produced the "removeChild" and "Maximum update depth exceeded" crashes.

test("patient sidebar keeps React's basic information nodes and hides them", async ({ page }) => {
  await page.goto("/users/123/Overview?sidebar=1");
  const section = page.getByTestId("cp-section-basic-information");
  await expect(section.locator(".BasicInfo_basicInfo")).toHaveCount(1);

  await page.getByRole("button", { name: "Inject appointments", exact: true }).click();

  await expect(section.locator(".misha-iframe-container iframe"))
    .toHaveAttribute("src", "https://misha.vorihealth.com/patientStatusStandalone/123");
  // React's own markup must still be attached, just not visible.
  await expect(section.locator(".BasicInfo_basicInfo")).toHaveCount(1);
  await expect(section.locator(".BasicInfo_basicInfo")).toBeHidden();
});

test("patient sidebar survives a React refresh that deletes a child", async ({ page }) => {
  await page.goto("/users/123/Overview?sidebar=1");
  await page.getByRole("button", { name: "Inject appointments", exact: true }).click();
  await expect(page.locator(".misha-iframe-container")).toHaveCount(1);

  // Healthie collapses the section, so React deletes a child it rendered earlier.
  await page.locator("#refresh").click();
  await expect(page.getByTestId("sidebar-details")).toHaveCount(0);
  await page.locator("#restore").click();
  await expect(page.getByTestId("sidebar-details")).toHaveCount(1);
  await expect(page.locator(".misha-iframe-container")).toHaveCount(1);
});

test("repeated sidebar injection keeps one iframe and never empties the section", async ({ page }) => {
  await page.goto("/users/123/Overview?sidebar=1");
  const inject = page.getByRole("button", { name: "Inject appointments", exact: true });
  await inject.click();
  await inject.click();
  await inject.click();

  await expect(page.locator(".misha-iframe-container")).toHaveCount(1);
  await expect(page.getByTestId("cp-section-basic-information").locator(".BasicInfo_basicInfo")).toHaveCount(1);
});

test("goals tab is hidden rather than removed", async ({ page }) => {
  await page.goto("/users/123/Overview?sidebar=1");
  await page.getByRole("button", { name: "Inject appointments", exact: true }).click();

  const goalsTab = page.getByTestId("tab-goals");
  await expect(goalsTab).toHaveCount(1);
  await expect(goalsTab).toBeHidden();
});

test("client list clones Book session once and leaves React's button attached", async ({ page }) => {
  await page.goto("/clients/active?booking=1");
  await page.getByRole("button", { name: "Inject appointments", exact: true }).click();

  const row = page.getByTestId("client-row-11");
  await expect(row.getByTestId("misha-book-session-button")).toHaveCount(1);
  await expect(row.locator("button")).toHaveCount(2);

  // waitClientList re-polls every 500ms; it must not keep rebuilding the control.
  await page.waitForTimeout(1600);
  await expect(row.getByTestId("misha-book-session-button")).toHaveCount(1);
  await expect(row.locator("button")).toHaveCount(2);

  await row.getByTestId("misha-book-session-button").click();
  await expect(page.locator(".overlay-dialog iframe"))
    .toHaveAttribute("src", "https://misha.vorihealth.com/schedule/11");
  // The native button stays in React's tree, hidden and unclicked.
  await expect(page.getByTestId("native-clicks")).toHaveText("0");
});
