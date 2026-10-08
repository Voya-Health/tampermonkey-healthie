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

async function inject(page, path = "/users/123/Overview") {
  await page.goto(path);
  await page.getByRole("button", { name: "Inject appointments", exact: true }).click();
}

async function expectAppointments(page, patientId = "123") {
  await expect(page.getByTestId("misha-appointments")).toHaveCount(1);
  await expect(page.getByTestId("misha-add-appointment-button")).toBeVisible();
  await expect(page.getByTestId("misha-appointments").locator("iframe"))
    .toHaveAttribute("src", `https://misha.vorihealth.com/appointments/patient/${patientId}`);
}

async function expectSchedule(page, patientId = "123") {
  await page.getByTestId("misha-add-appointment-button").click();
  await expect(page.locator(".overlay-dialog iframe"))
    .toHaveAttribute("src", `https://misha.vorihealth.com/schedule/${patientId}`);
  await expect(page.getByTestId("native-clicks")).toHaveText("0");
  await expect(page.getByTestId("bubbled-clicks")).toHaveText("0");
  await page.locator(".close-button").click();
  await expect(page.locator(".overlay-dialog")).toHaveCount(0);
}

for (const path of ["/users/123", "/users/123/Overview"]) {
  test(`modern appointments and schedule on ${path}`, async ({ page }) => {
    await inject(page, path);
    await expectAppointments(page);
    await expect(page.getByTestId("cop-appointments-contents")).toHaveCount(1);
    await expect(page.getByTestId("cop-appointments-contents")).toBeHidden();
    await expect(page.getByTestId("native-button-wrapper").locator("button")).toHaveCount(1);
    await expect(page.getByTestId("native-button-wrapper")).toBeHidden();
    await expectSchedule(page);
  });
}

test("legacy appointments and test ID control remain supported", async ({ page }) => {
  await inject(page, "/users/123/Overview?layout=legacy");
  await expectAppointments(page);
  await expect(page.getByTestId("legacy-area")).toBeHidden();
  await expect(page.getByTestId("add-appointment-button")).toHaveCount(1);
  await expectSchedule(page);
});

test("modern contents take priority over a legacy section", async ({ page }) => {
  await inject(page, "/users/123/Overview?layout=both");
  await expectAppointments(page);
  await expect(page.getByTestId("cop-appointments-contents")).toBeHidden();
  await expect(page.getByTestId("legacy-area")).toBeVisible();
});

test("stable button test ID takes priority when still present", async ({ page }) => {
  await inject(page, "/users/123/Overview?buttonTestId=1");
  await expectAppointments(page);
  await expect(page.getByTestId("add-appointment-button")).toBeHidden();
  await expectSchedule(page);
});

test("button lookup ignores SVG titles and unrelated or partial labels", async ({ page }) => {
  await inject(page);
  await expectAppointments(page);
  await expect(page.getByTestId("misha-add-appointment-button")).toHaveText("Add IconAdd appointment");
  await expect(page.getByTestId("unrelated-section").locator("button")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add appointment reminder", exact: true })).toBeVisible();
  await expectSchedule(page);
});

for (const pending of ["pendingRoot", "pendingTabs"]) {
  test(`polls until ${pending} becomes available`, async ({ page }) => {
    await inject(page, `/users/123/Overview?${pending}=1`);
    await expect(page.getByTestId("misha-appointments")).toHaveCount(0);
    await page.getByRole("button", { name: "Load Overview", exact: true }).click();
    await expectAppointments(page);
  });
}

test("React can refresh, restore, and unmount after injection", async ({ page }) => {
  await inject(page);
  await expect(page.locator("#overview iframe"))
    .toHaveAttribute("src", "https://misha.vorihealth.com/appointments/patient/123");
  await page.getByRole("button", { name: "Refresh appointments", exact: true }).click();
  await expect(page.getByTestId("errors")).toHaveText("");
  await expect(page.getByTestId("cop-appointments-contents")).toHaveText("Appointments refreshed");
  await expectAppointments(page);
  await page.getByRole("button", { name: "Restore appointments", exact: true }).click();
  await expect(page.getByTestId("native-button-wrapper").locator("button")).toHaveCount(1);
  await expect(page.getByTestId("native-button-wrapper")).toBeHidden();
  await expectSchedule(page);
  await page.getByRole("button", { name: "Unmount Overview", exact: true }).click();
  await expect(page.locator("#overview")).toBeEmpty();
});

test("repeated injection keeps one replacement and removes cloned dynamic IDs", async ({ page }) => {
  await inject(page);
  await page.getByRole("button", { name: "Inject appointments", exact: true }).click();
  await expectAppointments(page);
  await expect(page.getByTestId("misha-add-appointment-button")).not.toHaveAttribute("id");
  await expect(page.locator('[id^="react-aria-"]')).toHaveCount(1);
  await expectSchedule(page);
});

test("patient navigation unmounts the old replacement and uses the new patient", async ({ page }) => {
  await inject(page);
  await expectAppointments(page);
  await page.getByRole("button", { name: "Next patient", exact: true }).click();
  await expectAppointments(page, "456");
  await expectSchedule(page, "456");
});

test("staging route skips the production appointments replacement", async ({ page }) => {
  await inject(page, "/users/123/Overview?environment=securestaging");
  await expect(page.getByTestId("misha-appointments")).toHaveCount(0);
  await expect(page.getByTestId("cop-appointments-contents")).toBeVisible();
  await expect(page.getByTestId("native-button-wrapper").locator("button")).toBeVisible();
});
