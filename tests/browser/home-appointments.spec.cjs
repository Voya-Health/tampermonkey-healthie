const { test, expect } = require("./fixture.cjs");

const viewer = (id = "42") => ({ data: { currentUser: { id, is_patient: false, full_name: "Test Clinician" } } });

async function homeFixture(page, { body = viewer(), session = true, environment = "", delayed = false } = {}) {
  const requests = [];
  const pending = [];
  const consoleErrors = [];
  const failedRequests = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("requestfailed", (request) => failedRequests.push(request.url()));
  await page.addInitScript(({ session }) => {
    if (session) localStorage.setItem("blog:token", "synthetic-viewer");
  }, { session });
  await page.route("https://*.gethealthie.com/graphql", async (route) => {
    requests.push({ url: route.request().url(), headers: route.request().headers(), body: route.request().postDataJSON() });
    const responseBody = body;
    const reply = () => route.fulfill({ contentType: "application/json", body: JSON.stringify(responseBody) });
    if (delayed) pending.push(reply);
    else await reply();
  });
  await page.goto(`/?environment=${environment}`);
  return {
    requests, consoleErrors, failedRequests,
    setBody: (next) => { body = next; },
    release: async () => { for (const reply of pending.splice(0).reverse()) await reply(); },
    assertClean: () => { expect(consoleErrors).toEqual([]); expect(failedRequests).toEqual([]); },
  };
}

async function injectHome(page) {
  await page.getByRole("button", { name: "Inject appointments", exact: true }).click();
}

async function expectHome(page, host = "misha.vorihealth.com", id = "42") {
  await expect(page.getByTestId("misha-home-appointments").locator("iframe"))
    .toHaveAttribute("src", `https://${host}/provider-schedule/${id}`);
  await expect(page.getByRole("heading", { name: "Your appointments" })).toBeVisible();
  await expect(page.getByTestId("home-native")).toBeHidden();
}

test("Home GraphQL rejection preserves the native schedule without a TypeError", async ({ page }) => {
  const fixture = await homeFixture(page, { body: { errors: [{ message: "Synthetic authentication rejection" }] } });
  await injectHome(page);
  await page.waitForTimeout(100);
  await expect(page.getByTestId("home-native")).toBeVisible();
  await page.getByTestId("home-native").click();
  await expect(page.getByTestId("native-clicks")).toHaveText("1");
  await expect(page.locator("#overview iframe")).toHaveCount(0);
  fixture.assertClean();
});

for (const environment of ["", "securestaging"]) {
  test(`Home uses the browser clinician without an API key (${environment || "production"})`, async ({ page }) => {
    const fixture = await homeFixture(page, { environment });
    await injectHome(page);
    await expectHome(page, environment ? "qa.misha.vori.health" : "misha.vorihealth.com");
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0].headers.authorization).toBe("Bearer synthetic-viewer");
    expect(fixture.requests[0].url).toBe(`https://${environment ? "staging-api" : "api"}.gethealthie.com/graphql`);
    fixture.assertClean();
  });
}

test("Home React refresh, restore and unmount preserve native node ownership", async ({ page }) => {
  // Include the legacy response shape so this test reaches the old destructive DOM code.
  const fixture = await homeFixture(page, { body: { data: { ...viewer().data, user: { id: "42" } } } });
  await injectHome(page);
  await expect(page.locator("#overview iframe")).toHaveCount(1);
  await page.locator("#refresh").click();
  await expect(page.getByTestId("home-refreshed")).toHaveCount(1);
  await page.locator("#restore").click();
  await expectHome(page);
  await page.locator("#unmount").click();
  await expect(page.locator("#overview")).toBeEmpty();
  fixture.assertClean();
});

test("Home pending lookup keeps native controls and repeated injection shares one request", async ({ page }) => {
  const fixture = await homeFixture(page, { delayed: true });
  await injectHome(page);
  await injectHome(page);
  await expect(page.getByTestId("home-native")).toBeVisible();
  expect(fixture.requests).toHaveLength(1);
  await fixture.release();
  await expectHome(page);
  await injectHome(page);
  await expect(page.getByTestId("misha-home-appointments")).toHaveCount(1);
  expect(fixture.requests).toHaveLength(1);
  fixture.assertClean();
});

test("Home ignores a lookup completed after navigation", async ({ page }) => {
  const fixture = await homeFixture(page, { delayed: true });
  await injectHome(page);
  await page.evaluate(() => history.pushState({}, "", "/clients/active"));
  await fixture.release();
  await page.waitForTimeout(100);
  await expect(page.locator("#overview iframe")).toHaveCount(0);
  await expect(page.getByTestId("home-native")).toBeVisible();
  fixture.assertClean();
});

for (const [label, options] of [
  ["missing browser session", { session: false }],
  ["missing data", { body: {} }],
  ["patient session", { body: { data: { currentUser: { id: "42", is_patient: true } } } }],
  ["malformed provider ID", { body: viewer("../another-provider") }],
  ["oversized provider ID", { body: viewer("1".repeat(81)) }],
  ["partial GraphQL response", { body: { ...viewer(), errors: [{ message: "Incomplete viewer" }] } }],
]) {
  test(`Home preserves native appointments for ${label}`, async ({ page }) => {
    const fixture = await homeFixture(page, options);
    await injectHome(page);
    await page.waitForTimeout(100);
    await expect(page.getByTestId("home-native")).toBeVisible();
    await expect(page.locator("#overview iframe")).toHaveCount(0);
    fixture.assertClean();
  });
}

test("Home recovers after a rejected lookup and bounds retries when rejection persists", async ({ page }) => {
  await page.clock.install();
  const fixture = await homeFixture(page, { body: { errors: [{ message: "Temporary failure" }] } });
  await injectHome(page);
  await expect.poll(() => page.evaluate(() => homeAppointmentsState.pending)).toBe(false);
  await expect(page.getByTestId("home-native")).toBeVisible();
  fixture.setBody(viewer());
  await page.clock.runFor(30001);
  await expectHome(page);
  expect(fixture.requests).toHaveLength(2);

  fixture.setBody({ errors: [{ message: "Persistent failure" }] });
  await page.evaluate(() => { localStorage.setItem("blog:token", "rejected-session"); waitAppointmentsHome(); });
  await expect.poll(() => page.evaluate(() => homeAppointmentsState.pending)).toBe(false);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.clock.runFor(30001);
    await expect.poll(() => page.evaluate(() => homeAppointmentsState.pending)).toBe(false);
  }
  expect(fixture.requests).toHaveLength(5);
  await expect(page.getByTestId("home-native")).toBeVisible();
  await expect(page.locator("#overview iframe")).toHaveCount(0);
  fixture.assertClean();
});

test("Home switches providers and restores native appointments on logout", async ({ page }) => {
  const fixture = await homeFixture(page);
  await injectHome(page);
  await expectHome(page);
  fixture.setBody(viewer("43"));
  await page.evaluate(() => { localStorage.setItem("blog:token", "second-viewer"); window.dispatchEvent(new Event("storage")); });
  await expectHome(page, "misha.vorihealth.com", "43");
  await expect(page.getByTestId("misha-home-appointments")).toHaveCount(1);
  expect(fixture.requests).toHaveLength(2);
  await page.evaluate(() => { localStorage.removeItem("blog:token"); window.dispatchEvent(new Event("focus")); });
  await expect(page.getByTestId("home-native")).toBeVisible();
  await expect(page.locator("#overview iframe")).toHaveCount(0);
  fixture.assertClean();
});

test("Home ignores a pending response after React unmount and can inject on return", async ({ page }) => {
  const fixture = await homeFixture(page, { delayed: true });
  await injectHome(page);
  await page.locator("#unmount").click();
  await fixture.release();
  await page.waitForTimeout(100);
  await expect(page.locator("#overview")).toBeEmpty();
  await page.locator("#load").click();
  await injectHome(page);
  await expectHome(page);
  fixture.assertClean();
});

test("Home ignores the old provider when sessions change during lookup", async ({ page }) => {
  const fixture = await homeFixture(page, { delayed: true });
  await injectHome(page);
  fixture.setBody(viewer("43"));
  await page.evaluate(() => { localStorage.setItem("blog:token", "second-viewer"); waitAppointmentsHome(); });
  await expect.poll(() => fixture.requests.length).toBe(2);
  await fixture.release();
  await expectHome(page, "misha.vorihealth.com", "43");
  await expect(page.getByTestId("misha-home-appointments")).toHaveCount(1);
  fixture.assertClean();
});
